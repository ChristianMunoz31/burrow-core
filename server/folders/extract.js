// Reads one text file, read-only. The file is opened with the read flag only (and O_NOFOLLOW where the OS has
// it), its real location is checked against the root first, and the handle is checked to be a regular file.
// Nothing is ever written, touched or renamed. PDF and DOCX bytes are read the same way and then handed to the
// parser worker (parseDocs.js) only while document parsing is on (docGate.js, off by default, issue #67); every other file
// is decoded as text here.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LIMITS, isDocumentExt } from './constants.js';
import { DOC_PARSING_OFF, docParsingEnabled } from './docGate.js';
import { acquireParseSlot, parseDocument, tryAcquireParseSlot } from './parseDocs.js';
import { isInsideRoot } from './pathSafety.js';
import { nativeRealpath } from './walk.js';

const SNIFF_BYTES = 8192;
const DOC_CACHE_BUDGET_BYTES = 64 * 1024 * 1024;

/**
 * Per-job cache of parsed document text, so a PDF or DOCX that needs the inventory, a summary and the index is parsed once
 * per job. The key holds the path and the sha256 of the bytes just read, so only an identical file can hit it; the file is
 * still opened, identity-checked and fully read each time. Stops caching once the byte budget (2 bytes per character) is used.
 * @param {number} [budgetBytes]
 * @returns {{ get: (key: string) => { text: string, pages?: number, truncated?: boolean, pageLengths?: number[] | null } | undefined, set: (key: string, value: { text: string, pages?: number, truncated?: boolean, pageLengths?: number[] | null }) => void, clear: () => void }}
 */
export function createDocTextCache(budgetBytes = DOC_CACHE_BUDGET_BYTES) {
  const entries = new Map();
  let used = 0;
  return {
    get: (key) => entries.get(key),
    set(key, value) {
      if (entries.has(key)) return;
      const cost = value.text.length * 2;
      if (used + cost > budgetBytes) return;
      entries.set(key, value);
      used += cost;
    },
    clear() {
      entries.clear();
      used = 0;
    },
  };
}

/** True for a Unicode BOM that makes NUL bytes legitimate (UTF-16). */
const hasUtf16Bom = (buf) => buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff));

/**
 * A NUL byte in the first 8 KB, with no UTF-16 BOM, means the file is not text.
 * @param {Buffer} buf
 * @returns {boolean}
 */
export function sniffBinary(buf) {
  if (hasUtf16Bom(buf)) return false;
  const end = Math.min(buf.length, SNIFF_BYTES);
  for (let i = 0; i < end; i += 1) if (buf[i] === 0) return true;
  return false;
}

/**
 * Decode bytes to text: a UTF-8 BOM is stripped, UTF-16 (with BOM) is decoded, invalid UTF-8 falls back to Latin-1.
 * @param {Buffer} buf
 * @returns {string}
 */
export function decodeText(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const body = Buffer.from(buf.subarray(2));
    if (body.length % 2 === 1) return body.subarray(0, body.length - 1).swap16().toString('utf16le');
    return body.swap16().toString('utf16le');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return buf.toString('latin1');
  }
}

/**
 * Lines, words and characters of a text (all computed here, never by a model).
 * @param {string} text
 * @returns {{ lines: number, words: number, chars: number }}
 */
export function textStats(text) {
  if (text === '') return { lines: 0, words: 0, chars: 0 };
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c === 10) lines += 1;
    else if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) i += 1;
      lines += 1;
    }
  }
  // A final line break does not start another line.
  const last = text.charCodeAt(text.length - 1);
  if (last === 10 || last === 13) lines -= 1;
  let words = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    // Same whitespace set as /\s/: ASCII spaces, NBSP, the Unicode space separators, line and paragraph separators, BOM.
    const space =
      (c >= 9 && c <= 13) || c === 32 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (space) inWord = false;
    else if (!inWord) {
      inWord = true;
      words += 1;
    }
  }
  return { lines, words, chars: text.length };
}

/**
 * Whether a caller's {dev, ino} (bigint, or number as a walk's lstat gives it) names the file in `actual` (bigint stats).
 * Node fills bigint stats from a signed BigInt64Array, so an NTFS file id with the top bit set is negative there while the
 * number form (a walk's lstat) is a positive double: both sides are compared as unsigned 64-bit values. A number is compared
 * after the same rounding to a double that produced it.
 */
export function sameIdentity(expected, actual) {
  const u64 = (v) => BigInt.asUintN(64, v);
  const eq = (want, got) => (typeof want === 'bigint' ? u64(want) === u64(got) : typeof want === 'number' && want === Number(u64(got)));
  return eq(expected.dev, actual.dev) && eq(expected.ino, actual.ino);
}

const base = (size, mtimeMs) => ({
  sizeBytes: size,
  mtime: Number.isFinite(mtimeMs) ? new Date(mtimeMs).toISOString() : null,
  lines: null,
  words: null,
  chars: null,
});

/**
 * @typedef {object} ReadResult
 * @property {'ok'|'binary'|'too_large'|'unreadable'|'empty'|'outside_root'|'changed'|'busy'} status `changed` only with `expectedSha256`, `busy` only with `parseSlot: 'try'`
 * @property {string} [text] Only for status `ok`.
 * @property {string} [sha256] Of the raw bytes (status `ok`, `empty`).
 * @property {number} sizeBytes
 * @property {string | null} mtime
 * @property {number | null} lines
 * @property {number | null} words
 * @property {number | null} chars
 * @property {number | null} [pages] Pages read (PDF only, status `ok`).
 * @property {boolean} [truncated] True when a page cap or the text cap cut a document's text (status `ok`).
 * @property {number[] | null} [pageLengths] PDF only, status `ok`: the text length of each page (see docParsers.js), null when unknown.
 * @property {string} [docFailure] The parser's failure code (`doc_*`) for an unreadable PDF or DOCX.
 */

/**
 * Read a file for summarizing and indexing. A .pdf or .docx goes through the parser worker (a file the parser cannot
 * read, for example an encrypted or corrupt one, or one that times out, is `unreadable`); anything else is text.
 * @param {string} absPath
 * @param {{ rootKey: string, maxBytes?: number, platform?: NodeJS.Platform, signal?: AbortSignal, docCache?: ReturnType<typeof createDocTextCache>, expectedSha256?: string, expectedIdentity?: { dev: bigint | number, ino: bigint | number }, parseSlot?: 'wait' | 'try' }} opts
 *   `maxBytes` defaults to the document cap for a .pdf or .docx and to the plain text cap otherwise; an aborted `signal` rejects
 *   with an AbortError; `docCache` only skips the parse of a document whose bytes hash to a cached entry; `expectedSha256`
 *   answers `changed` (before any parse or cache write) when the bytes hash to something else; `parseSlot` is how a document
 *   takes the process-wide parse slot: `wait` (default, abortable by `signal`) or `try` (status `busy` at once when it is held)
 *   `expectedIdentity` is the dev and ino the caller saw (a walk's number lstat or a bigint one); a file that now has another
 *   identity answers `outside_root` before it is opened
 * @returns {Promise<ReadResult>}
 * @throws {Error} AbortError when `signal` aborts while a document is being parsed or waiting for the parse slot
 */
export async function readTextFile(absPath, { rootKey, maxBytes, platform = process.platform, signal, docCache, expectedSha256, expectedIdentity, parseSlot = 'wait' } = {}) {
  const ext = path.extname(absPath).slice(1).toLowerCase();
  const isDoc = isDocumentExt(ext);
  // Document parsing is off (docGate.js): answer before the file is opened, so no parse slot and no worker is ever used.
  if (isDoc && !docParsingEnabled()) return { status: 'unreadable', ...base(0, NaN), docFailure: DOC_PARSING_OFF };
  const cap = maxBytes ?? (isDoc ? LIMITS.maxDocBytes : LIMITS.maxFileBytes);
  let handle = null;
  try {
    // The file must still resolve to somewhere inside the root (a link swapped in since the walk is refused).
    const real = await nativeRealpath(absPath);
    if (!isInsideRoot(rootKey, real, platform)) return { status: 'outside_root', ...base(0, NaN) };
    // Identity snapshot taken BEFORE the open, from the path that was just checked. It must be a plain file (lstat never follows a
    // link). Comparing the handle against a stat taken after the open would re-resolve a junction swapped in between, and Windows
    // has no O_NOFOLLOW, so the handle is compared with this snapshot instead.
    // bigint stats: NTFS file ids exceed 2^53, so number inodes can compare equal for different files.
    const checked = await fs.promises.lstat(real, { bigint: true });
    if (checked.isSymbolicLink()) return { status: 'outside_root', ...base(0, NaN) };
    if (!checked.isFile()) return { status: 'unreadable', ...base(0, NaN) };
    // The caller's own snapshot (the walk's lstat) must name the same file: a swap since the walk is refused.
    if (expectedIdentity && !sameIdentity(expectedIdentity, checked)) return { status: 'outside_root', ...base(0, NaN) };
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
    handle = await fs.promises.open(absPath, flags);
    const st = await handle.stat();
    if (!st.isFile()) return { status: 'unreadable', ...base(0, NaN) };
    // The opened file must be the one that was checked: a swap between the check and the open is refused before any byte is read.
    const opened = await handle.stat({ bigint: true });
    if (checked.dev !== opened.dev || checked.ino !== opened.ino) return { status: 'outside_root', ...base(0, NaN) };
    const head = base(st.size, st.mtimeMs);
    if (st.size > cap) return { status: 'too_large', ...head };
    // Read one byte more than allowed, so a file that grew since the stat is still refused.
    const buf = Buffer.alloc(Math.min(st.size, cap) + 1);
    let filled = 0;
    while (filled < buf.length) {
      const { bytesRead } = await handle.read(buf, filled, buf.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled > cap) return { status: 'too_large', ...base(filled, st.mtimeMs) };
    const bytes = buf.subarray(0, filled);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const sized = base(filled, st.mtimeMs);
    // The caller knows which bytes it expects: anything else is reported before it is parsed or cached.
    if (expectedSha256 !== undefined && sha256 !== expectedSha256) return { status: 'changed', sha256, ...sized };
    if (filled === 0) return { status: 'empty', sha256, ...sized, lines: 0, words: 0, chars: 0 };
    if (isDoc) {
      const cacheKey = `${absPath}
${sha256}`;
      let parsed = docCache?.get(cacheKey);
      try {
        if (!parsed) {
          // One parse at a time, process wide (see parseDocs.js). Only the parse holds the slot, so a cache hit never waits.
          const release = parseSlot === 'try' ? tryAcquireParseSlot() : await acquireParseSlot({ signal });
          if (!release) return { status: 'busy', ...sized };
          try {
            parsed = await parseDocument(ext, bytes, { signal });
          } finally {
            release();
          }
          docCache?.set(cacheKey, { text: parsed.text, pages: parsed.pages, truncated: parsed.truncated, pageLengths: parsed.pageLengths ?? null });
        }
      } catch (err) {
        if (err?.aborted) throw err;
        return { status: 'unreadable', sha256, ...sized, docFailure: typeof err?.code === 'string' ? err.code : 'doc_crashed' };
      }
      const docStats = textStats(parsed.text);
      if (parsed.text.trim() === '') return { status: 'empty', sha256, ...sized, lines: docStats.lines, words: 0, chars: docStats.chars, pages: parsed.pages };
      return { status: 'ok', text: parsed.text, sha256, ...sized, lines: docStats.lines, words: docStats.words, chars: docStats.chars, pages: parsed.pages, truncated: parsed.truncated, pageLengths: parsed.pageLengths ?? null };
    }
    if (sniffBinary(bytes)) return { status: 'binary', ...sized };
    const text = decodeText(bytes);
    const stats = textStats(text);
    if (text.trim() === '') return { status: 'empty', sha256, ...sized, lines: stats.lines, words: 0, chars: stats.chars };
    return { status: 'ok', text, sha256, ...sized, lines: stats.lines, words: stats.words, chars: stats.chars };
  } catch (err) {
    if (err?.aborted) throw err;
    // An open or read error (a sharing or antivirus lock, for example) may pass: for a document it counts as a transient
    // failure, so the next scan tries it again instead of treating it as final until the file changes.
    return { status: 'unreadable', ...base(0, NaN), ...(isDoc ? { docFailure: 'doc_unavailable' } : {}) };
  } finally {
    await handle?.close().catch(() => {});
  }
}
