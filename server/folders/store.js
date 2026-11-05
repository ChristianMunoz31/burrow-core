// All database access of the Folders module, through server/db (allowlisted tables and columns, bound values).
// Everything here is synchronous. Rule: no transaction is ever held across an await; a caller does its slow work
// first and then makes one short call.
import { count, insert, insertMany, op, remove, select, selectOne, update, updateById, upsert, withTransaction } from '../db/index.js';

const BATCH = 100;
const nowIso = () => new Date().toISOString();

/** @returns {object[]} */
export const listFolders = () => select('folders', { orderBy: [{ column: 'created_at', dir: 'asc' }, { column: 'id', dir: 'asc' }] });

/** @param {string} id @returns {object | null} */
export const getFolder = (id) => selectOne('folders', { where: { id } });

/**
 * @param {{ name: string, path: string, pathKey: string }} f
 * @returns {object}
 */
export function insertFolder({ name, path, pathKey }) {
  return insert('folders', { name, path, path_key: pathKey, stats: {}, summary_status: 'none' });
}

/**
 * Point a folder that arrived from an import at the real folder the user confirmed, and release it for reading.
 * @param {string} id
 * @param {{ path: string, pathKey: string }} location
 * @returns {object | null}
 */
export const relinkFolder = (id, { path, pathKey }) =>
  updateFolder(id, { path, path_key: pathKey, confirm_state: 'ok' });

/**
 * Patch a folder row (updated_at is set here).
 * @param {string} id
 * @param {Record<string, unknown>} patch
 * @returns {object | null}
 */
export const updateFolder = (id, patch) => updateById('folders', id, { ...patch, updated_at: nowIso() });

/**
 * Confirmed folders whose summary was written after `sinceIso` (the Javi inbox). A summary_at in the future is
 * dropped in code, so a forged or imported timestamp never pins an item. latestId is the folder UUID.
 * @param {string} sinceIso
 * @param {{ now?: () => Date }} [opts]
 * @returns {{ count: number, latestAt: string | null, latestId: string | null }}
 */
export function countSummariesSince(sinceIso, { now = () => new Date() } = {}) {
  const since = Date.parse(sinceIso);
  const limit = now().getTime();
  const rows = select('folders', {
    columns: ['id', 'summary_at'],
    where: { confirm_state: 'ok', summary_status: 'ok', summary_at: op.gt(sinceIso) },
  }).filter((r) => {
    const t = Date.parse(r.summary_at);
    return t > since && t <= limit;
  });
  let latest = null;
  for (const r of rows) if (!latest || Date.parse(r.summary_at) > Date.parse(latest.summary_at)) latest = r;
  return { count: rows.length, latestAt: latest ? new Date(latest.summary_at).toISOString() : null, latestId: latest?.id ?? null };
}

/** Delete a folder; its files and chunks go with it (cascade). @returns {number} */
export const removeFolder = (id) => remove('folders', { where: { id } });

/**
 * Insert or update inventory rows by (folder, path), one transaction per batch of 100. Columns left undefined keep
 * their stored value on update. Returns the stored rows in input order.
 * @param {string} folderId
 * @param {Array<Record<string, unknown>>} rows
 * @returns {object[]}
 */
export function upsertFileRows(folderId, rows) {
  const out = [];
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    withTransaction(() => {
      for (const row of slice) {
        out.push(upsert('folder_files', { ...row, folder_id: folderId }, { conflict: ['folder_id', 'rel_path'], preserve: ['id', 'created_at'] }));
      }
    });
  }
  return out;
}

/**
 * Remove files not seen by the scan that started at `seenAt` (their chunks go with them).
 * @param {string} folderId
 * @param {string} seenAt
 * @returns {number}
 */
export const deleteUnseenFiles = (folderId, seenAt) =>
  remove('folder_files', { where: { folder_id: folderId, $or: [{ seen_at: op.lt(seenAt) }, { seen_at: null }] } });

/** @param {string} folderId @returns {object[]} every file row, by path */
export const allFileRows = (folderId) =>
  select('folder_files', { where: { folder_id: folderId }, orderBy: [{ column: 'rel_path', dir: 'asc' }] });

/** @param {string} fileId @returns {object | null} */
export const getFile = (fileId) => selectOne('folder_files', { where: { id: fileId } });

/** @param {string} fileId @param {Record<string, unknown>} patch */
export const updateFile = (fileId, patch) => updateById('folder_files', fileId, patch);

const SORT_COLUMNS = Object.freeze({ path: 'rel_path', size: 'size_bytes', modified: 'mtime', status: 'status' });

/**
 * One page of files.
 * @param {string} folderId
 * @param {{ offset?: number, limit?: number, sort?: 'path'|'size'|'modified'|'status', dir?: 'asc'|'desc' }} [opts]
 * @returns {{ rows: object[], total: number }}
 */
export function listFiles(folderId, { offset = 0, limit = 100, sort = 'path', dir = 'asc' } = {}) {
  const column = SORT_COLUMNS[sort] ?? 'rel_path';
  const orderBy = [{ column, dir, ...(column === 'rel_path' ? { nocase: true } : {}) }];
  if (column !== 'rel_path') orderBy.push({ column: 'rel_path', dir: 'asc', nocase: true });
  return {
    rows: select('folder_files', { where: { folder_id: folderId }, orderBy, limit, offset }),
    total: count('folder_files', { where: { folder_id: folderId } }),
  };
}

/** @param {string} fileId @returns {number} */
export const deleteFileChunks = (fileId) => remove('folder_chunks', { where: { file_id: fileId } });

/**
 * Replace a file's chunks and its index fields in one transaction.
 * @param {string} fileId
 * @param {string} folderId
 * @param {Array<{ seq: number, startLine: number, endLine: number, text: string, embedding: string, dims: number }>} chunks
 * @param {Record<string, unknown>} filePatch index_hash, index_model, chunk_count
 */
export function replaceFileChunks(fileId, folderId, chunks, filePatch) {
  withTransaction(() => {
    remove('folder_chunks', { where: { file_id: fileId } });
    insertMany(
      'folder_chunks',
      chunks.map((c) => ({
        folder_id: folderId,
        file_id: fileId,
        seq: c.seq,
        start_line: c.startLine,
        end_line: c.endLine,
        text: c.text,
        embedding: c.embedding,
        dims: c.dims,
      })),
    );
    update('folder_files', filePatch, { where: { id: fileId } });
  });
}

/** Vectors of a folder without the text, for the similarity search. @param {string} folderId */
export const listChunkVectors = (folderId) =>
  select('folder_chunks', { columns: ['id', 'file_id', 'seq', 'start_line', 'end_line', 'embedding', 'dims'], where: { folder_id: folderId }, orderBy: [{ column: 'id', dir: 'asc' }] });

/** The text of some chunks, by id. @param {string[]} ids @returns {Map<string, string>} */
export function getChunkTexts(ids) {
  if (ids.length === 0) return new Map();
  const rows = select('folder_chunks', { columns: ['id', 'text'], where: { id: op.in(ids) } });
  return new Map(rows.map((r) => [r.id, r.text]));
}

/** Chunks stored across every folder (the global index cap). @returns {number} */
export const countAllChunks = () => count('folder_chunks');

/** @param {string} folderId @returns {{ chunks: number }} */
export const countIndex = (folderId) => ({ chunks: count('folder_chunks', { where: { folder_id: folderId } }) });
