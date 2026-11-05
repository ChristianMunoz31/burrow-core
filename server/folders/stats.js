// Every number the Folders feature shows or hands to a model is computed here, in plain code. The model only
// receives the formatted facts and turns them into words.
import crypto from 'node:crypto';
import { FILE_KINDS, FILE_STATUSES } from './constants.js';

const nf = new Intl.NumberFormat('en-US');
const fmt = (n) => nf.format(Number.isFinite(n) ? n : 0);
const day = (iso) => (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null);
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * One line of text for Markdown and model Facts: every run of whitespace, line break (CR, LF, NEL, U+2028/9) and other
 * control character becomes a single space. JSON and CSV keep the real value.
 * @param {unknown} s
 * @returns {string}
 */
export function singleLine(s) {
  return String(s ?? '')
    .replace(/[\s\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    .trim();
}

/**
 * "812 B", "12.4 KB", "3.0 MB".
 * @param {number} n bytes
 * @returns {string}
 */
export function formatBytes(n) {
  const v = Number.isFinite(n) && n > 0 ? n : 0;
  if (v < 1024) return `${Math.round(v)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = v / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

const isReadable = (row) => row.status === 'ok';
const isReal = (row) => row.status !== 'link' && row.status !== 'outside_root';

/**
 * Groups of readable files with identical content (same SHA-256). Each group is sorted by path, groups by first path.
 * @param {Array<{ rel_path: string, sha256?: string | null, size_bytes?: number, status: string }>} rows
 * @returns {string[][]}
 */
export function duplicateGroups(rows) {
  const bySha = new Map();
  for (const row of rows) {
    if (!isReadable(row) || !row.sha256 || !(row.size_bytes > 0)) continue;
    const list = bySha.get(row.sha256) ?? [];
    list.push(row.rel_path);
    bySha.set(row.sha256, list);
  }
  return [...bySha.values()]
    .filter((paths) => paths.length >= 2)
    .map((paths) => [...paths].sort(byText))
    .sort((a, b) => byText(a[0], b[0]));
}

/**
 * @typedef {object} FolderStats
 * @property {number} filesTotal
 * @property {number} filesRead
 * @property {number} bytesTotal
 * @property {number} bytesRead
 * @property {number} linesTotal
 * @property {number} wordsTotal
 * @property {Record<string, number>} byStatus
 * @property {Record<string, { files: number, bytes: number }>} byKind
 * @property {Array<{ ext: string, files: number, bytes: number }>} byExt
 * @property {string | null} oldestModifiedAt
 * @property {string | null} newestModifiedAt
 * @property {Array<{ path: string, bytes: number }>} largestFiles
 * @property {number} duplicateGroups
 * @property {number} dirsScanned
 * @property {number} dirsSkipped
 * @property {string[]} limitsHit
 * @property {{ status: 'none'|'partial'|'ready', files: number, chunks: number, skipped: null|'not_pro'|'no_embed_model'|'ollama_unavailable'|'limit' }} index
 */

/**
 * Totals for a folder from its file rows.
 * @param {Array<object>} rows folder_files rows
 * @param {{ dirsScanned?: number, dirsSkipped?: number, limitsHit?: Iterable<string>, indexSkipped?: string | null }} [meta]
 * @returns {FolderStats}
 */
export function computeFolderStats(rows, meta = {}) {
  const byStatus = Object.fromEntries(FILE_STATUSES.map((s) => [s, 0]));
  const byKind = Object.fromEntries(FILE_KINDS.map((k) => [k, { files: 0, bytes: 0 }]));
  const exts = new Map();
  let bytesTotal = 0;
  let bytesRead = 0;
  let filesRead = 0;
  let linesTotal = 0;
  let wordsTotal = 0;
  let oldest = null;
  let newest = null;
  let indexedFiles = 0;
  let indexChunks = 0;
  let indexable = 0;
  for (const row of rows) {
    const size = Number(row.size_bytes) || 0;
    if (Object.hasOwn(byStatus, row.status)) byStatus[row.status] += 1;
    if (!isReal(row)) continue;
    bytesTotal += size;
    const kind = Object.hasOwn(byKind, row.kind) ? row.kind : 'other';
    byKind[kind].files += 1;
    byKind[kind].bytes += size;
    const ext = row.ext ? `.${row.ext}` : '(none)';
    const e = exts.get(ext) ?? { ext, files: 0, bytes: 0 };
    e.files += 1;
    e.bytes += size;
    exts.set(ext, e);
    const stamp = typeof row.mtime === 'string' ? row.mtime : null;
    if (stamp) {
      if (oldest === null || stamp < oldest) oldest = stamp;
      if (newest === null || stamp > newest) newest = stamp;
    }
    if (isReadable(row)) {
      filesRead += 1;
      bytesRead += size;
      linesTotal += Number(row.line_count) || 0;
      wordsTotal += Number(row.word_count) || 0;
      indexable += 1;
      if (Number(row.chunk_count) > 0 && row.index_hash && row.index_hash === row.sha256) {
        indexedFiles += 1;
        indexChunks += Number(row.chunk_count);
      }
    }
  }
  const largest = rows
    .filter(isReal)
    .map((r) => ({ path: r.rel_path, bytes: Number(r.size_bytes) || 0 }))
    .sort((a, b) => b.bytes - a.bytes || byText(a.path, b.path))
    .slice(0, 5);
  const limitsHit = [...new Set(meta.limitsHit ?? [])].sort(byText);
  let indexStatus = 'none';
  if (indexChunks > 0) indexStatus = indexedFiles >= indexable ? 'ready' : 'partial';
  return {
    filesTotal: rows.length,
    filesRead,
    bytesTotal,
    bytesRead,
    linesTotal,
    wordsTotal,
    byStatus,
    byKind,
    byExt: [...exts.values()].sort((a, b) => b.files - a.files || byText(a.ext, b.ext)).slice(0, 15),
    oldestModifiedAt: oldest,
    newestModifiedAt: newest,
    largestFiles: largest,
    duplicateGroups: duplicateGroups(rows).length,
    dirsScanned: meta.dirsScanned ?? 0,
    dirsSkipped: meta.dirsSkipped ?? 0,
    limitsHit,
    index: { status: indexStatus, files: indexedFiles, chunks: indexChunks, skipped: meta.indexSkipped ?? null },
  };
}

/**
 * Already formatted facts for the model. Every value is a string; the model never sees raw per-file sizes.
 * @param {FolderStats} stats
 * @returns {Record<string, string>}
 */
export function buildFolderFacts(stats) {
  const kinds = FILE_KINDS.filter((k) => stats.byKind[k]?.files > 0).map((k) => `${fmt(stats.byKind[k].files)} ${k}`);
  const exts = stats.byExt.slice(0, 8).map((e) => `${e.ext} ${fmt(e.files)}`);
  const notRead = FILE_STATUSES.filter((s) => s !== 'ok' && s !== 'link' && s !== 'outside_root' && stats.byStatus[s] > 0).map(
    (s) => `${fmt(stats.byStatus[s])} ${s.replace(/_/g, ' ')}`,
  );
  const facts = {
    Files: fmt(stats.filesTotal),
    'Files read': fmt(stats.filesRead),
    'Total size': formatBytes(stats.bytesTotal),
    'Text size': formatBytes(stats.bytesRead),
    Lines: fmt(stats.linesTotal),
    Words: fmt(stats.wordsTotal),
    Kinds: kinds.length ? kinds.join(', ') : 'none',
    'File types': exts.length ? exts.join(', ') : 'none',
    'Not read': notRead.length ? notRead.join(', ') : 'none',
    'Duplicate groups': fmt(stats.duplicateGroups),
  };
  const oldest = day(stats.oldestModifiedAt);
  const newest = day(stats.newestModifiedAt);
  if (oldest && newest) facts['Changed between'] = oldest === newest ? oldest : `${oldest} and ${newest}`;
  const names = stats.largestFiles.slice(0, 3).map((f) => singleLine(f.path));
  if (names.length) facts['Largest files'] = names.join(', ');
  return facts;
}

/**
 * Facts about one file, already formatted.
 * @param {{ rel_path: string, ext?: string, size_bytes?: number, line_count?: number | null, word_count?: number | null, mtime?: string | null }} row
 * @returns {Record<string, string>}
 */
export function buildFileFacts(row) {
  const facts = {
    File: singleLine(row.rel_path),
    Type: row.ext ? `.${row.ext}` : 'none',
    Size: formatBytes(Number(row.size_bytes) || 0),
  };
  if (Number.isFinite(row.line_count)) facts.Lines = fmt(row.line_count);
  if (Number.isFinite(row.word_count)) facts.Words = fmt(row.word_count);
  const modified = day(row.mtime);
  if (modified) facts.Modified = modified;
  return facts;
}

/**
 * A fingerprint of everything the folder summary is written from: the facts and each file's summary hash.
 * @param {Array<object>} rows
 * @param {FolderStats} stats
 * @returns {string}
 */
export function summaryInputHash(rows, stats) {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(buildFolderFacts(stats)));
  const readable = rows.filter(isReadable).sort((a, b) => byText(a.rel_path, b.rel_path));
  for (const row of readable) hash.update(`\n${row.rel_path}|${row.summary_hash ?? ''}|${row.summary_status}`);
  return hash.digest('hex');
}
