// Client for POST /api/import. The export ZIP is sent as the raw request body
// (Content-Type: application/zip); ?dryRun=1 validates and counts without writing.
// Responses use the { data } / { error, code } envelope.

export const IMPORT_MAX_BYTES = 16 * 1024 * 1024;

const MESSAGES = {
  rate_limited: 'Too many imports. Try again in a few minutes.',
  session: 'Your session expired. Sign in again and retry.',
  auth_required: 'Import requires sign-in to be enabled.',
  not_configured: "Burrow can't open your data file. Try restarting Burrow.",
  too_large: 'This file is too large to restore here.',
  network: "Couldn't reach the server. Check your connection and try again.",
  generic: 'Import failed. Try again.',
};

// The server's own message is user-safe for these 4xx codes.
const SERVER_MESSAGE_CODES = new Set(['invalid_archive', 'unsupported_format', 'invalid_table_file', 'invalid_request']);

function messageFor({ code, status, error }) {
  if (code === 'rate_limited' || status === 429) return MESSAGES.rate_limited;
  if (status === 401) return MESSAGES.session;
  if (code === 'auth_required' || status === 403) return MESSAGES.auth_required;
  if (code === 'not_configured') return MESSAGES.not_configured;
  if (code === 'import_too_large' || status === 413) return MESSAGES.too_large;
  if (SERVER_MESSAGE_CODES.has(code) && typeof error === 'string' && error) return error;
  return MESSAGES.generic;
}

/**
 * Uploads an export ZIP. Throws an Error with a user-safe message on failure.
 * @param {File | Blob} file
 * @param {{ dryRun?: boolean, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ dryRun: boolean,
 *   tables: Array<{ id: string, received: number, inserted: number, updated: number, skipped: number }>,
 *   totals: { received: number, inserted: number, updated: number, skipped: number } }>}
 */
export async function importExportZip(file, { dryRun = false, signal } = {}) {
  if (file.size > IMPORT_MAX_BYTES) throw new Error(MESSAGES.too_large);
  let response;
  try {
    response = await fetch(`/api/import${dryRun ? '?dryRun=1' : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: file,
      signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw new Error(e instanceof TypeError ? MESSAGES.network : MESSAGES.generic, { cause: e });
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(messageFor({ code: body?.code, status: response.status, error: body?.error })), {
      code: body?.code,
      status: response.status,
    });
  }
  if (!body?.data || !Array.isArray(body.data.tables) || !body.data.totals) throw new Error(MESSAGES.generic);
  return body.data;
}
