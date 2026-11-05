// Import rules for the Folders tables of an export archive (`folders`, `folder_files`; never `folder_chunks`).
// An archive can never grant Burrow read access to a folder, so these rules are insert-only and paused:
//  - Only the exported columns are read from a row. Everything else (`confirm_state`, `path_key`, `last_job_*`, the index
//    fields) is ignored, whatever the archive says.
//  - A new folder arrives with `confirm_state = 'needs_confirm'`, the placeholder key `imported:<id>`, the daily re-scan off,
//    no job state and an empty question index. Nothing reads it until the user picks it again (desktop) or confirms the
//    path (`confirmFolderPath`, which runs `validateFolderRoot`).
//  - A folder or file that already exists locally is never touched (`protected`), so importing the same archive twice
//    changes nothing and a confirmed folder is never altered.
import path from 'node:path';
import {
  DbError,
  encodeValue,
  insert,
  op,
  select,
} from '../db/index.js';
import { foldPath } from '../pathGuard.js';
import { FOLDER_EXPORT_DEFS } from './archiveTables.js';
import { FILE_KINDS, FILE_STATUSES, FILE_SUMMARY_STATUSES, FOLDER_SUMMARY_STATUSES, LIMITS } from './constants.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXISTS_CHUNK = 500;
const EMPTY_INDEX = Object.freeze({ status: 'none', files: 0, chunks: 0, skipped: null });

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isBlank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const hasControl = (s) => [...s].some((c) => c.charCodeAt(0) <= 0x1f || (c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) <= 0x9f));

const defById = Object.freeze(Object.fromEntries(FOLDER_EXPORT_DEFS.map((d) => [d.id, d])));

/** @param {string} id @returns {boolean} true for a table these rules handle */
export const isFolderArchiveTable = (id) => Object.hasOwn(defById, id);

/** Shared state of one import run. @returns {{ insertedFolderIds: Set<string>, filesPerFolder: Map<string, number>, importedPaths: Set<string> }} */
export const newFolderImportContext = () => ({
  insertedFolderIds: new Set(),
  filesPerFolder: new Map(),
  importedPaths: new Set(),
});

function existingIds(table, ids, db) {
  const found = new Set();
  for (let i = 0; i < ids.length; i += EXISTS_CHUNK) {
    for (const r of select(table, { columns: ['id'], where: { id: op.in(ids.slice(i, i + EXISTS_CHUNK)) }, db })) found.add(r.id);
  }
  return found;
}

/** Keep only the exported columns, each checked against its type; an unreadable value is dropped and counted. */
function pickColumns(def, raw, result) {
  const row = {};
  for (const { name, type } of def.columns) {
    if (!Object.hasOwn(raw, name) || raw[name] === undefined) continue;
    try {
      encodeValue(type, raw[name], name);
      row[name] = raw[name];
    } catch (e) {
      if (!(e instanceof DbError) || e.code !== 'invalid_value') throw e;
      result.invalidValues += 1;
    }
  }
  return row;
}

/** A relative path inside a folder: 1 to 1024 characters, no leading slash, no backslash or NUL, no empty, "." or ".." segment. */
export function isSafeRelPath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024) return false;
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0')) return false;
  return value.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** The extension the scan would store for a safe `rel_path` (lower case, no dot). The preview trusts the path, so `ext` must agree with it. */
const extOfRelPath = (relPath) => path.posix.extname(relPath).slice(1).toLowerCase();

function validName(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 120 && value.trim() !== '' && !hasControl(value);
}

function validPath(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= LIMITS.maxPathChars && !value.includes('\0');
}

/** Stats as stored for a paused folder: the question index is reset, because no chunk was imported. */
function pausedStats(stats) {
  if (!isObject(stats)) return {};
  const copy = { ...stats };
  if (Object.keys(copy).length > 0) copy.index = { ...EMPTY_INDEX };
  return copy;
}

function newResult(id, rows) {
  return {
    id,
    received: rows.length,
    inserted: 0,
    updated: 0,
    skipped: 0,
    skippedReasons: { invalid: 0, orphan: 0, redacted: 0, missing_id: 0, protected: 0 },
    invalidValues: 0,
  };
}

function importFolders(rows, db, ctx, platform) {
  const result = newResult('folders', rows);
  const skip = (reason) => {
    result.skipped += 1;
    result.skippedReasons[reason] += 1;
  };
  const def = defById.folders;
  const local = select('folders', { columns: ['id', 'path'], db });
  const localIds = new Set(local.map((f) => f.id));
  const localPaths = new Set(local.map((f) => foldPath(f.path, platform)));
  let total = local.length;
  for (const raw of rows) {
    if (!isObject(raw)) {
      skip('invalid');
      continue;
    }
    if (isBlank(raw.id)) {
      skip('missing_id');
      continue;
    }
    if (typeof raw.id !== 'string' || !UUID_RE.test(raw.id)) {
      skip('invalid');
      continue;
    }
    const id = raw.id.toLowerCase();
    const picked = pickColumns(def, raw, result);
    if (!validName(picked.name) || !validPath(picked.path)) {
      skip('invalid');
      continue;
    }
    const pathKey = foldPath(picked.path, platform);
    if (localIds.has(id) || localPaths.has(pathKey) || ctx.importedPaths.has(pathKey)) {
      skip('protected');
      continue;
    }
    if (total >= LIMITS.maxFolders) {
      skip('invalid');
      continue;
    }
    const row = {
      ...picked,
      id,
      summary_status: FOLDER_SUMMARY_STATUSES.includes(picked.summary_status) ? picked.summary_status : 'none',
      stats: pausedStats(picked.stats),
      confirm_state: 'needs_confirm',
      path_key: `imported:${id}`,
      auto_rescan: false,
      last_job_status: null,
      last_job_error: null,
      last_job_at: null,
    };
    try {
      insert('folders', row, { db });
    } catch (e) {
      if (e instanceof DbError && (e.code === 'constraint' || e.code === 'invalid_value')) {
        skip('invalid');
        continue;
      }
      throw e;
    }
    result.inserted += 1;
    total += 1;
    localIds.add(id);
    ctx.importedPaths.add(pathKey);
    ctx.insertedFolderIds.add(id);
  }
  return result;
}

function importFolderFiles(rows, db, ctx) {
  const result = newResult('folder_files', rows);
  const skip = (reason) => {
    result.skipped += 1;
    result.skippedReasons[reason] += 1;
  };
  const def = defById.folder_files;
  const parentIds = [...new Set(rows.filter((r) => isObject(r) && typeof r.folder_id === 'string').map((r) => r.folder_id.toLowerCase()))];
  const localParents = existingIds('folders', parentIds, db);
  const fileIds = [...new Set(rows.filter((r) => isObject(r) && typeof r.id === 'string').map((r) => r.id.toLowerCase()))];
  const localFiles = existingIds('folder_files', fileIds, db);
  for (const raw of rows) {
    if (!isObject(raw)) {
      skip('invalid');
      continue;
    }
    if (isBlank(raw.id)) {
      skip('missing_id');
      continue;
    }
    if (typeof raw.id !== 'string' || !UUID_RE.test(raw.id) || typeof raw.folder_id !== 'string' || !UUID_RE.test(raw.folder_id)) {
      skip('invalid');
      continue;
    }
    const id = raw.id.toLowerCase();
    const folderId = raw.folder_id.toLowerCase();
    if (!ctx.insertedFolderIds.has(folderId)) {
      skip(localParents.has(folderId) ? 'protected' : 'orphan');
      continue;
    }
    if (localFiles.has(id)) {
      skip('protected');
      continue;
    }
    const picked = pickColumns(def, raw, result);
    if (
      !isSafeRelPath(picked.rel_path) ||
      extOfRelPath(picked.rel_path) !== (picked.ext ?? '') ||
      !FILE_STATUSES.includes(picked.status) ||
      !FILE_KINDS.includes(picked.kind) ||
      (picked.summary_status !== undefined && picked.summary_status !== null && !FILE_SUMMARY_STATUSES.includes(picked.summary_status))
    ) {
      skip('invalid');
      continue;
    }
    const count = ctx.filesPerFolder.get(folderId) ?? 0;
    if (count >= LIMITS.maxFiles) {
      skip('invalid');
      continue;
    }
    const row = {
      ...picked,
      id,
      folder_id: folderId,
      summary_status: picked.summary_status ?? 'none',
      index_hash: null,
      index_model: null,
      chunk_count: 0,
      seen_at: null,
    };
    try {
      insert('folder_files', row, { db });
    } catch (e) {
      if (e instanceof DbError && (e.code === 'constraint' || e.code === 'invalid_value')) {
        skip('invalid');
        continue;
      }
      throw e;
    }
    ctx.filesPerFolder.set(folderId, count + 1);
    localFiles.add(id);
    result.inserted += 1;
  }
  return result;
}

/**
 * Apply the rows of one Folders table from an archive (insert-only, paused). Must run inside the import transaction.
 * @param {'folders' | 'folder_files'} id
 * @param {unknown[]} rows
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {ReturnType<typeof newFolderImportContext>} ctx
 * @param {{ platform?: NodeJS.Platform }} [opts]
 */
export function importFolderTable(id, rows, db, ctx, { platform = process.platform } = {}) {
  return id === 'folders' ? importFolders(rows, db, ctx, platform) : importFolderFiles(rows, db, ctx);
}
