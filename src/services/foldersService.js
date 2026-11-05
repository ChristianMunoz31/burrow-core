import { buildApiError } from '../utils/apiError';
import { filenameFrom, saveBlob } from './exportService';

const BASE = '/api/folders';

/** The error for a failed response: user-facing server text, `status`, and the folder `code` and `reason`. */
async function failure(response) {
  const body = await response.json().catch(() => ({}));
  const err = buildApiError(response, body);
  if (!err.code && typeof body?.code === 'string') err.code = body.code;
  else if (!err.code && typeof body?.error === 'string') err.code = body.error;
  return err;
}

async function req(path = '', { method = 'GET', body, signal } = {}) {
  const init = { method, cache: 'no-store', signal };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${BASE}${path}`, init);
  if (!response.ok) throw await failure(response);
  const payload = await response.json().catch(() => ({}));
  return payload.data;
}

/**
 * API client for /api/folders (spec section 4). Every call resolves to the `data` of the envelope
 * and rejects with an Error carrying `status` and `code` (and `reason`, `feature` for AI and Pro errors).
 */
export const foldersService = {
  /** @returns {Promise<{ folders: object[], limits: object, canPickFolder: boolean, canSaveFile: boolean }>} */
  list: () => req(''),
  /** Opens the native folder window; `folderId` re-picks an imported folder. @returns {Promise<{ dialog: object }>} */
  pick: (folderId) => req('/pick', { method: 'POST', body: folderId ? { folderId } : {} }),
  /** @returns {Promise<{ dialog: object }>} The dialog with its `folder` and `job` once added. */
  dialog: (id) => req(`/dialogs/${id}`),
  /** @returns {Promise<{ dialog: object }>} */
  cancelDialog: (id) => req(`/dialogs/${id}/cancel`, { method: 'POST' }),
  /** Confirms an imported folder by a pasted path. @returns {Promise<{ folder: object, job: object }>} */
  confirm: (id, path) => req(`/${id}/confirm`, { method: 'POST', body: { path } }),
  /** Opens the native save window for an export. @param {'md'|'json'|'csv'} format @returns {Promise<{ dialog: object }>} */
  exportToChosen: (id, format) => req(`/${id}/export`, { method: 'POST', body: { format, target: 'choose' } }),
  /** @returns {Promise<{ folder: object, job: object }>} */
  add: ({ path, name }) => req('', { method: 'POST', body: name ? { path, name } : { path } }),
  /** @param {{ name?: string, autoRescan?: boolean }} patch @returns {Promise<{ folder: object }>} */
  update: (id, patch) => req(`/${id}`, { method: 'PATCH', body: patch }),
  /** @returns {Promise<{ removed: true }>} */
  remove: (id) => req(`/${id}`, { method: 'DELETE' }),
  /** @returns {Promise<{ job: object }>} */
  scan: (id) => req(`/${id}/scan`, { method: 'POST' }),
  /** @returns {Promise<{ job: object }>} */
  cancel: (id) => req(`/${id}/cancel`, { method: 'POST' }),
  /** @returns {Promise<{ job: object|null }>} */
  job: (id) => req(`/${id}/job`),
  /** @returns {Promise<{ files: object[], total: number, offset: number, limit: number }>} */
  files: (id, { offset = 0, limit = 100, sort = 'path', dir = 'asc' } = {}) =>
    req(`/${id}/files?${new URLSearchParams({ offset: String(offset), limit: String(limit), sort, dir })}`),
  /** Read-only preview of one inventory file (Free). Pass `signal` to abort. @returns {Promise<{ file: object, preview: object }>} */
  preview: (id, fileId, { signal } = {}) => req(`/${id}/files/${encodeURIComponent(fileId)}/preview`, { signal }),
  /** Downloads the export through the shared blob saver. @param {'md'|'json'|'csv'} format */
  async exportFile(id, format) {
    const response = await fetch(`${BASE}/${id}/export`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format }),
    });
    if (!response.ok) throw await failure(response);
    const filename = filenameFrom(response.headers.get('Content-Disposition'));
    saveBlob(await response.blob(), filename);
    return { filename };
  },
};
