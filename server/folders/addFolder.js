// Adding a folder and confirming an imported one, shared by the pasted-path routes and the native folder picker.
// The path always goes through validateFolderRoot (the only authority on links, protected folders, caps and overlap),
// and the duplicate/overlap/limit check is repeated with no await before the write, so two overlapping requests (or the
// 20-folder cap) cannot both pass.
import { FolderError } from './constants.js';
import { enqueueFolderJob } from './jobs.js';
import { folderConflict, validateFolderRoot } from './pathSafety.js';
import { getFolder, insertFolder, listFolders, relinkFolder, removeFolder } from './store.js';

/** Keys of the folders Burrow reads (confirmed ones). A folder waiting for confirmation has no real path yet. */
const confirmedKeys = (exceptId = null) =>
  listFolders()
    .filter((f) => f.confirm_state === 'ok' && f.id !== exceptId)
    .map((f) => ({ pathKey: f.path_key }));

/**
 * What a native-dialog request lets the add/confirm flow ask just before it writes: `dataGen` (from
 * `captureDataGeneration()` when the request was opened; stale after an erase or restore) and `stillChecking()` (true
 * while the request is still being checked and has not expired or ended). Both are optional (a pasted path has neither).
 * @typedef {{ dataGen?: { isStale: () => boolean } | null, stillChecking?: (() => boolean) | null }} WriteGuard
 */

/**
 * Throws if the request that asked for this write is over: nothing may be written into a database that was erased or
 * restored while the path was being validated, or after the dialog expired. Synchronous, so it can sit right before the write.
 * @param {WriteGuard} guard
 * @throws {FolderError} data_reset, dialog_expired
 */
function assertStillWanted({ dataGen = null, stillChecking = null }) {
  if (dataGen?.isStale()) throw new FolderError('data_reset');
  if (stillChecking && !stillChecking()) throw new FolderError('dialog_expired');
}

/**
 * Validate a folder path, store the folder and queue its first scan.
 * @param {unknown} rawPath
 * @param {WriteGuard & { name?: string | null }} [opts]
 * @returns {Promise<{ folderId: string, job: object }>}
 * @throws {FolderError} a path code, folder_exists, folder_overlaps, folder_limit, folder_queue_full, data_reset, dialog_expired
 */
export async function addFolderFromPath(rawPath, { name = null, dataGen = null, stillChecking = null } = {}) {
  const checked = await validateFolderRoot(rawPath, { existing: confirmedKeys(), total: listFolders().length });
  if (!checked.ok) throw new FolderError(checked.code);
  // Another add may have finished while this one was being checked: look again at the stored folders, with no await
  // before the insert.
  const conflict = folderConflict(checked.pathKey, confirmedKeys(), { total: listFolders().length });
  if (conflict) throw new FolderError(conflict);
  // The insert, and the enqueue after it, follow in the same tick: nothing can reset the data in between.
  assertStillWanted({ dataGen, stillChecking });
  const row = insertFolder({ name: name ?? checked.name, path: checked.path, pathKey: checked.pathKey });
  try {
    const job = enqueueFolderJob({ folderId: row.id, kind: 'scan', trigger: 'user' });
    return { folderId: row.id, job };
  } catch (err) {
    removeFolder(row.id);
    throw err;
  }
}

/**
 * Point a folder that came from an import at a real folder on this computer and start its first scan.
 * @param {string} folderId
 * @param {unknown} rawPath
 * @param {WriteGuard} [guard]
 * @returns {Promise<{ folderId: string, job: object }>}
 * @throws {FolderError} folder_not_found, folder_already_confirmed, a path code, folder_exists, folder_overlaps, data_reset, dialog_expired
 */
export async function confirmFolderPath(folderId, rawPath, { dataGen = null, stillChecking = null } = {}) {
  const row = getFolder(folderId);
  if (!row) throw new FolderError('folder_not_found');
  if (row.confirm_state !== 'needs_confirm') throw new FolderError('folder_already_confirmed');
  const checked = await validateFolderRoot(rawPath, { existing: confirmedKeys(folderId), maxFolders: Infinity });
  if (!checked.ok) throw new FolderError(checked.code);
  // Look again with no await before the write: the folder may have been confirmed, removed or another one added meanwhile.
  const current = getFolder(folderId);
  if (!current) throw new FolderError('folder_not_found');
  if (current.confirm_state !== 'needs_confirm') throw new FolderError('folder_already_confirmed');
  const conflict = folderConflict(checked.pathKey, confirmedKeys(folderId), { maxFolders: Infinity });
  if (conflict) throw new FolderError(conflict);
  // The relink, and the enqueue after it, follow in the same tick: nothing can reset the data in between.
  assertStillWanted({ dataGen, stillChecking });
  relinkFolder(folderId, { path: checked.path, pathKey: checked.pathKey });
  const job = enqueueFolderJob({ folderId, kind: 'scan', trigger: 'user' });
  return { folderId, job };
}
