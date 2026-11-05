// Client for the two-step erase routes. Each call answers { data } or { error, code, message }.
import { buildApiError } from '../utils/apiError';

export const ERASE_FAILED_MESSAGE = 'Nothing was erased. Close and reopen Burrow, then try again.';
export const ERASE_UNSURE_MESSAGE = 'Burrow did not answer. Reload Burrow to check whether your data was erased.';
export const ERASE_EXPORT_FAILED_MESSAGE = "Couldn't download the final export. Try again, or untick Download a final export first.";
/** The data is gone but the final cleanup did not finish (server code `erase_incomplete`). */
export const ERASE_INCOMPLETE_CODE = 'erase_incomplete';

async function post(path, body) {
  let response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw Object.assign(new Error(ERASE_UNSURE_MESSAGE, { cause }), { unsure: true });
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = buildApiError(response, payload);
    err.code ??= payload?.code;
    err.message = payload?.message || ERASE_FAILED_MESSAGE;
    throw err;
  }
  return payload.data;
}

/** Step 1: a single-use token that lives 2 minutes. */
export const requestEraseToken = () => post('/api/data/erase/request', {});

/**
 * Step 2: erase with the token and the typed phrase.
 * @param {{ token: string, phrase: string, removeLicense: boolean, deleteBackups: boolean, password?: string }} input
 */
export const eraseAllData = (input) => post('/api/data/erase', input);
