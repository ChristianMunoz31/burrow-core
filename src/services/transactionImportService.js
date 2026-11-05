const PROXY_URL = '/api';

// Plain-language text for the server's import error codes. The server's own `error`
// string is never shown.
const MESSAGES = {
  invalid_request: 'Burrow could not use that request. Go back, check your choices and try again.',
  invalid_rows: 'Some rows were not accepted. Go back, check the columns you picked and try again.',
  too_many_rows: 'That is more than 5,000 transactions. Split the file into smaller files and import them one at a time.',
  too_large: 'That file is too big to import in one go. Split it into smaller files and try again.',
  rate_limited: 'You are importing a lot at once. Wait a minute and try again.',
  auth_required: 'Sign in to Burrow to import transactions.',
  not_configured: 'Importing is not set up on this computer yet.',
  server_error: 'Something went wrong on our side and nothing was imported. Try again in a moment.',
};
const FALLBACK = 'Something went wrong and nothing was imported. Try again in a moment.';
const SIGN_IN_AGAIN = 'Please sign in again, then try importing once more. Nothing was imported.';
const OFFLINE = 'Burrow could not be reached, so nothing was imported. Check that it is running and try again.';

/** Error with `status`, `code` (server code) and `details` ([{ index, field }]) when present. */
function importError(status, body) {
  const code = typeof body?.code === 'string' ? body.code : undefined;
  const known = code && Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : undefined;
  const err = new Error(known || (status === 401 ? SIGN_IN_AGAIN : FALLBACK));
  err.status = status;
  if (code) err.code = code;
  if (Array.isArray(body?.details)) err.details = body.details;
  return err;
}

/**
 * @typedef {{ received: number, inserted: number, duplicates: number,
 *   duplicateIndexes: number[], dryRun: boolean }} ImportResult
 */

export const transactionImportService = {
  /**
   * Import (or preview with dryRun) signed rows. Duplicates are found by the server against
   * everything already saved.
   * @param {{ rows: { date: string, merchant: string, amount: number, category: string }[],
   *   source: 'file'|'sheet', fileName?: string, dryRun?: boolean }} args
   * @returns {Promise<ImportResult>}
   */
  async importRows({ rows, source, fileName, dryRun = false }) {
    const body = { rows, source };
    if (fileName) body.fileName = fileName;
    let response;
    try {
      response = await fetch(`${PROXY_URL}/transactions/import${dryRun ? '?dryRun=1' : ''}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw new Error(OFFLINE, { cause });
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw importError(response.status, data);
    if (!data?.data) throw importError(response.status, {});
    return data.data;
  },
};
