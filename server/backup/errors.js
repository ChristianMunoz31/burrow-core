// Backup and restore error type. Messages are fixed, plain copy: never row data, paths or upstream text.

const STATUS = Object.freeze({
  backup_busy: 409,
  db_restoring: 503,
  disk_low: 507,
  disk_full: 507,
  backup_not_found: 404,
  backup_invalid: 422,
  backup_too_new: 409,
  upload_expired: 410,
  too_large: 413,
  unsupported_media_type: 415,
  invalid_request: 400,
  invalid_settings: 400,
  backup_failed: 500,
  restore_failed: 500,
  restore_recovery_failed: 500,
  stable_not_found: 404,
  stable_busy: 409,
  stable_too_new: 409,
  stable_same_folder: 409,
  stable_invalid: 422,
  import_unavailable: 404,
  import_source_not_found: 404,
  import_target_not_empty: 409,
  import_target_not_ours: 409,
  import_pending: 409,
  import_direct_running: 409,
  import_running_unknown: 409,
  import_source_busy: 409,
  import_source_too_new: 409,
  import_source_invalid: 422,
  import_failed: 500,
  import_origin_blocked: 403,
});

export const BACKUP_MESSAGES = Object.freeze({
  backup_busy: 'A backup or restore is already running. Try again in a moment.',
  db_restoring: 'Burrow is restoring a backup. This takes a few seconds.',
  disk_low: 'There is not enough free disk space to make a backup. Free up some space and try again.',
  disk_full: 'The disk filled up while making the backup. Free up some space and try again.',
  backup_not_found: 'That backup could not be found.',
  backup_invalid: 'That file is not a usable Burrow backup.',
  backup_too_new: 'This backup was made by a newer version of Burrow. Update Burrow, then try again.',
  upload_expired: 'That upload expired. Choose the file again.',
  too_large: 'That file is too large to restore here.',
  unsupported_media_type: 'Send the backup file as raw bytes.',
  invalid_request: 'That request was not valid.',
  invalid_settings: 'Those backup settings are not valid.',
  backup_failed: 'The backup could not be made.',
  restore_failed: 'The restore did not finish. Your current data was kept.',
  restore_recovery_failed: 'Burrow could not finish recovering an interrupted backup restore.',
  stable_not_found: 'No Burrow data was found on this computer to copy.',
  stable_busy: 'Burrow is busy with its data right now. Try again in a moment, or close Burrow first.',
  stable_too_new:
    'Your Burrow data comes from a newer version than this Burrow Dev build. Update Burrow Dev, then try again.',
  stable_same_folder: 'Burrow Dev is using the same data folder as Burrow, so there is nothing to copy.',
  stable_invalid: 'Your Burrow data could not be read, so nothing was copied. Burrow was not changed.',
  import_unavailable: 'This Burrow does not offer an import from another Burrow.',
  import_source_not_found: 'No data from your other Burrow was found on this computer, so there is nothing to import.',
  import_target_not_empty:
    'This Burrow already has data of its own, so nothing was imported. Your data was not changed. To bring the other data in, export it from the other Burrow and import the file here.',
  import_target_not_ours:
    'The folder where this Burrow keeps its data is not marked as a Burrow data folder, so nothing was imported. Nothing was changed.',
  import_pending: 'An import is already waiting for Burrow to restart. Close Burrow, then open it again to finish.',
  import_direct_running: 'Your other Burrow is open. Close it (File, Quit), then try again. Nothing was changed.',
  import_running_unknown:
    'Burrow could not tell whether your other Burrow is open. Close it (File, Quit) and try again. Nothing was changed.',
  import_source_busy: 'Your other Burrow is changing its data right now. Close it (File, Quit), then try again. Nothing was changed.',
  import_source_too_new: 'Your other Burrow data comes from a newer version than this Burrow. Update Burrow, then try again. Nothing was changed.',
  import_source_invalid: 'The data in your other Burrow could not be read, so nothing was imported. Nothing was changed.',
  import_failed: 'The import did not work. Nothing was imported, and the data in your other Burrow was not touched.',
  import_origin_blocked: 'Burrow only imports from its own window. Open Burrow, go to Settings, then Data & storage.',
});

export class BackupError extends Error {
  /**
   * @param {string} code one of the keys of BACKUP_MESSAGES
   * @param {{ message?: string, cause?: unknown }} [opts]
   */
  constructor(code, opts = {}) {
    super(opts.message ?? BACKUP_MESSAGES[code] ?? 'Backup error');
    this.name = 'BackupError';
    this.code = code;
    this.status = STATUS[code] ?? 500;
    this.cause = opts.cause;
  }
}

export const isBackupError = (e) => e instanceof BackupError;

/** True for an out-of-space failure from the filesystem or SQLite. */
export function isNoSpaceError(e) {
  if (!e || typeof e !== 'object') return false;
  const { code, message } = /** @type {{ code?: unknown, message?: unknown }} */ (e);
  if (code === 'ENOSPC' || code === 'SQLITE_FULL') return true;
  return typeof message === 'string' && /ENOSPC|database or disk is full|no space left/i.test(message);
}
