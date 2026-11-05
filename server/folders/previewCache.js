// A small in-memory LRU of extracted PDF and DOCX text for the Folders preview, so stepping back to a document does not
// parse it again. Key = file id + sha256 of the bytes just read, so only an identical file can hit it. At most
// PREVIEW_CACHE.maxEntries entries and PREVIEW_CACHE.maxBytes bytes (2 bytes per character). Nothing is written to disk.
// Cleared on a data reset (erase or restore), and per folder when the folder is removed or scanned again.
import { onDataReset } from '../dataGeneration.js';
import { PREVIEW_CACHE } from './constants.js';

/** @typedef {{ text: string, pages?: number, truncated?: boolean, pageLengths?: number[] | null }} PreviewDoc */

/** @type {Map<string, { folderId: string, value: PreviewDoc, cost: number }>} */
const entries = new Map();
let used = 0;

const drop = (key) => {
  const entry = entries.get(key);
  if (!entry) return;
  used -= entry.cost;
  entries.delete(key);
};

/** @param {string} fileId @param {string} sha256 @returns {string} */
export const previewKey = (fileId, sha256) => `${fileId}\n${sha256}`;

/** @param {string} key @returns {PreviewDoc | undefined} */
export function getPreviewDoc(key) {
  const entry = entries.get(key);
  if (!entry) return undefined;
  // Most recently used goes last.
  entries.delete(key);
  entries.set(key, entry);
  return entry.value;
}

/**
 * @param {string} key
 * @param {string} folderId
 * @param {PreviewDoc} value
 */
export function setPreviewDoc(key, folderId, value) {
  drop(key);
  const cost = value.text.length * 2;
  if (cost > PREVIEW_CACHE.maxBytes) return;
  while (entries.size >= PREVIEW_CACHE.maxEntries || used + cost > PREVIEW_CACHE.maxBytes) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    drop(oldest.value);
  }
  entries.set(key, { folderId, value, cost });
  used += cost;
}

/** Forget everything cached for one folder. @param {string} folderId */
export function clearPreviewFolder(folderId) {
  for (const [key, entry] of [...entries]) if (entry.folderId === folderId) drop(key);
}

export function clearPreviewCache() {
  entries.clear();
  used = 0;
}

/** @returns {{ entries: number, bytes: number }} */
export const previewCacheStats = () => ({ entries: entries.size, bytes: used });

onDataReset(clearPreviewCache);
