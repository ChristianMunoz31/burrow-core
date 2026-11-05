// The read-only file preview behind GET /api/folders/:id/files/:fileId/preview. A file is addressed by its inventory row,
// never by a path from the client. The row's status decides first (a file the scan could not read is never opened here);
// then the root is validated again, the file is compared with the inventory (size and mtime before reading, sha256 after)
// and only text that matches what the scan saw is returned. Nothing is written, no audit row is made, and no file text or
// path is logged.
import fs from 'node:fs';
import path from 'node:path';
import { captureDataGeneration } from '../dataGeneration.js';
import { FolderError, PREVIEW_MAX_CHARS, isDocumentExt } from './constants.js';
import { docParsingEnabled } from './docGate.js';
import { readTextFile } from './extract.js';
import { validateFolderRoot } from './pathSafety.js';
import { getPreviewDoc, previewKey, setPreviewDoc } from './previewCache.js';
import { absInRoot } from './relPath.js';
import { getFolder } from './store.js';
import { toFileView } from './views.js';

const CSV_EXTS = new Set(['csv', 'tsv']);

/** @param {string} ext @returns {'text'|'csv'|'document'} */
export const previewKind = (ext) => (isDocumentExt(ext) ? 'document' : CSV_EXTS.has(ext) ? 'csv' : 'text');

/** The first `max` UTF-16 units of `text`, never ending in the first half of a surrogate pair. */
export function cutText(text, max = PREVIEW_MAX_CHARS) {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/**
 * Offsets in the text where pages 2..n start, from the per-page lengths (pages are joined with one newline).
 * Only offsets inside the shown text count.
 * @param {number[] | null | undefined} pageLengths
 * @param {number} shownChars
 * @returns {number[] | null}
 */
export function pageBreakOffsets(pageLengths, shownChars) {
  if (!Array.isArray(pageLengths)) return null;
  const out = [];
  let at = 0;
  for (let i = 0; i < pageLengths.length - 1; i += 1) {
    at += pageLengths[i] + 1;
    if (at >= shownChars) break;
    out.push(at);
  }
  return out;
}

const none = (file, reason) => ({
  file: toFileView(file),
  preview: { kind: 'none', reason, text: null, truncated: false, shownChars: 0, totalChars: null, pageBreaks: null },
});

const changed = () => new FolderError('folder_file_changed');

/**
 * Build the preview of one inventory file.
 * @param {object} folder folders row
 * @param {object} file folder_files row of that folder
 * @param {{ signal?: AbortSignal }} [opts] an aborted signal stops a running document parse (AbortError, `aborted: true`)
 * @returns {Promise<{ file: object, preview: object }>}
 * @throws {FolderError} folder_needs_confirm, a path code of validateFolderRoot, folder_moved, folder_file_changed
 *   (also when the extension no longer matches the path), folder_preview_busy (another parse holds the slot) or
 *   folder_not_found (the folder was removed, or the data was reset, while the file was being read)
 */
export async function previewFile(folder, file, { signal } = {}) {
  if (folder.confirm_state !== 'ok') throw new FolderError('folder_needs_confirm');
  // The inventory decides first: a row the scan could not read is never opened.
  if (file.status !== 'ok') return none(file, file.status);
  // Whatever happens while the file is read, nothing is cached or answered for a folder that is gone or for old data.
  const generation = captureDataGeneration();
  const gone = () => generation.isStale() || !getFolder(folder.id);

  const root = await validateFolderRoot(folder.path, { existing: [] });
  if (!root.ok) throw new FolderError(root.code);
  if (root.pathKey !== folder.path_key) throw new FolderError('folder_moved');

  // The kind comes from the path that is opened, never from the stored ext column; the two must agree.
  const abs = absInRoot(root.realPath, file.rel_path);
  const ext = typeof file.rel_path === 'string' ? path.extname(file.rel_path).slice(1).toLowerCase() : '';
  if (!abs || ext !== (file.ext ?? '') || typeof file.sha256 !== 'string' || file.sha256 === '') throw changed();

  // Document parsing is off (docGate.js): a PDF or DOCX is "not supported yet", with no parse and no read.
  if (isDocumentExt(ext) && !docParsingEnabled()) return none(file, 'unsupported');

  // Cheap check before reading: the file must still have the size and modification time the scan saw.
  let st;
  try {
    st = await fs.promises.lstat(abs);
  } catch {
    throw changed();
  }
  if (!st.isFile() || st.size !== Number(file.size_bytes) || new Date(st.mtimeMs).toISOString() !== file.mtime) throw changed();

  const doc = isDocumentExt(ext);
  // readTextFile still resolves, opens and identity-checks the file itself. Its document cache hook is the preview LRU
  // (keyed by file id and the sha256 of the bytes it just read), so a cached document is not parsed again. A parse takes the
  // process-wide parse slot only while it runs, so a cache hit never answers busy.
  const shaOf = (key) => key.slice(key.lastIndexOf('\n') + 1);
  const docCache = doc
    ? {
        get: (key) => getPreviewDoc(previewKey(file.id, shaOf(key))),
        set: (key, value) => {
          if (!gone()) setPreviewDoc(previewKey(file.id, shaOf(key)), folder.id, value);
        },
      }
    : undefined;
  const res = await readTextFile(abs, { rootKey: root.pathKey, signal, docCache, expectedSha256: file.sha256, expectedIdentity: { dev: st.dev, ino: st.ino }, parseSlot: 'try' });
  if (res.status === 'busy') throw new FolderError('folder_preview_busy');
  if (gone()) throw new FolderError('folder_not_found');
  if (res.status === 'unreadable' && res.sha256 === file.sha256) return none(file, 'unreadable');
  if (res.status !== 'ok' || res.sha256 !== file.sha256 || typeof res.text !== 'string') throw changed();

  const text = cutText(res.text);
  return {
    file: toFileView(file),
    preview: {
      kind: previewKind(ext),
      reason: null,
      text,
      truncated: text.length < res.text.length || (doc && res.truncated === true),
      shownChars: text.length,
      totalChars: res.text.length,
      pageBreaks: doc ? pageBreakOffsets(res.pageLengths, text.length) : null,
    },
  };
}
