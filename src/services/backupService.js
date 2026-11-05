// Client for /api/backups. Responses use the { data } / { error, message } envelope.
import { buildApiError, userError } from '../utils/apiError';

export const BACKUP_UPLOAD_MAX_BYTES = 1024 * 1024 * 1024;
export const BACKUP_TOO_LARGE_MESSAGE = 'This backup file is too large to restore here.';

const MESSAGES = {
  rate_limited: 'Too many tries. Try again in a few minutes.',
  session: 'Your session expired. Sign in again and retry.',
  auth_required: 'Backups need sign-in to be enabled.',
  too_large: BACKUP_TOO_LARGE_MESSAGE,
  upload_expired: 'That file check expired. Choose the file again.',
  restoring: 'Burrow is restoring a backup. Try again in a few seconds.',
  network: "Couldn't reach the server. Check your connection and try again.",
  generic: 'Something went wrong. Try again.',
};

function failure(status, statusText, body) {
  const err = buildApiError({ status, statusText }, body);
  if (typeof body?.error === 'string') err.code = body.error;
  if (!err.userFacing) {
    err.userFacing = true;
    if (status === 429) err.message = MESSAGES.rate_limited;
    else if (status === 401) err.message = MESSAGES.session;
    else if (status === 403) err.message = MESSAGES.auth_required;
    else if (status === 413) err.message = MESSAGES.too_large;
    else if (status === 410) err.message = MESSAGES.upload_expired;
    else if (status === 503) err.message = MESSAGES.restoring;
    else err.message = MESSAGES.generic;
  }
  return err;
}

const abortError = () => Object.assign(new Error('Cancelled'), { name: 'AbortError' });

async function request(path, { method = 'GET', body, signal } = {}) {
  const init = { method, cache: 'no-store', signal };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(path, init);
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw Object.assign(userError(e instanceof TypeError ? MESSAGES.network : MESSAGES.generic), { cause: e });
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw failure(response.status, response.statusText, payload);
  if (!payload || payload.data === undefined) throw userError(MESSAGES.generic);
  return payload.data;
}

/** @returns {Promise<{ backups: object[], status: object, settings: object, location: string, desktop: boolean }>}
 *  status includes autoSwitch (the user's switch), autoEnabled (switch and scheduler) and autoOffReminder. */
export const listBackups = (opts) => request('/api/backups', opts);

export const getBackupStatus = (opts) => request('/api/backups/status', opts);

/** Makes a backup now. Resolves to the new backup summary. */
export const createBackup = async () => (await request('/api/backups', { method: 'POST', body: {} })).backup;

/** @param {{ keepDaily: number, keepWeekly: number, keepMonthly: number }} settings */
export const updateBackupSettings = (settings) => request('/api/backups/settings', { method: 'PUT', body: settings });

/** Turns automatic backups on or off. Resolves to { enabled, changedAt, reminderDismissedAt }. */
export const setAutoBackup = (enabled) => request('/api/backups/auto', { method: 'PUT', body: { enabled } });

/** "Not now" on the Home reminder: the server remembers it for a week. */
export const dismissAutoReminder = () => request('/api/backups/auto/dismiss-reminder', { method: 'POST', body: {} });

/** Restores from `{ id }` (a listed backup) or `{ uploadToken }` (a checked upload). */
export function restoreBackup(source) {
  const ref = source?.uploadToken ? { uploadToken: source.uploadToken } : { id: source?.id };
  return request('/api/backups/restore', { method: 'POST', body: { ...ref, confirm: true } });
}

/**
 * Burrow Dev only (the stable server answers 404). What the copy-from-Burrow control needs to know.
 * @returns {Promise<{ found: boolean, dataDir: string, overridden: boolean, lastChangedAt: string|null,
 *   busy: boolean, sameFolder: boolean }>}
 */
export const getStableCopyStatus = (opts) => request('/api/backups/stable-copy', opts);

/** Burrow Dev only. Replaces the Dev data with a copy of the Burrow data (one-way; Burrow is not changed). */
export const copyFromStable = () => request('/api/backups/stable-copy', { method: 'POST', body: { confirm: true } });

/**
 * Uploads a backup file (raw bytes) for checking. Nothing is restored yet.
 * @param {File | Blob} file
 * @param {{ signal?: AbortSignal, onProgress?: (fraction: number) => void }} [opts]
 * @returns {Promise<{ uploadToken: string, expiresAt: string, now?: string, bytes: number, schemaVersion: number,
 *   appSchemaVersion: number, migrationNeeded: boolean, rowCounts: object, totalRows: number }>}
 */
export function uploadBackupFile(file, { signal, onProgress } = {}) {
  if (file.size > BACKUP_UPLOAD_MAX_BYTES) return Promise.reject(userError(MESSAGES.too_large));
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const done = () => signal?.removeEventListener('abort', abort);
    xhr.open('POST', '/api/backups/upload');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      done();
      let payload;
      try {
        payload = JSON.parse(xhr.responseText);
      } catch {
        payload = {};
      }
      if (xhr.status >= 200 && xhr.status < 300 && payload?.data?.uploadToken) resolve(payload.data);
      else reject(failure(xhr.status, xhr.statusText, payload));
    };
    xhr.onerror = () => {
      done();
      reject(userError(MESSAGES.network));
    };
    xhr.onabort = () => {
      done();
      reject(abortError());
    };
    signal?.addEventListener('abort', abort, { once: true });
    xhr.send(file);
  });
}

/**
 * Microsoft Store build only (data folder in the user folder; every other build answers available: false). What the import
 * control needs to know about the Burrow installed from the website.
 * @returns {Promise<{ available: boolean, canOffer: boolean, reason: string|null, found: boolean, sourceDir: string|null,
 *   lastChangedAt: string|null, pending: boolean }>}
 */
export const getDirectImportStatus = (opts) => request('/api/backups/direct-import', opts);

/**
 * Copies and checks the other Burrow's data into this Burrow. Nothing in the other Burrow changes. The data is put in place
 * the next time Burrow starts, so the answer says `needsRestart`.
 * @returns {Promise<{ status: 'staged', needsRestart: boolean, copiedFrom: string, schemaVersion: number, totalRows: number,
 *   backups: number, files: number }>}
 */
export const importFromDirect = () => request('/api/backups/direct-import', { method: 'POST', body: { confirm: true } });
