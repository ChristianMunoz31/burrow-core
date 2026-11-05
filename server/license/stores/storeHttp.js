// The one HTTP helper for store license calls (docs/LICENSING.md 4.6). Never logs the key, the request
// body, the response body or any store message.
import fetch from 'node-fetch';
import { STORE_MAX_BODY_BYTES, STORE_TIMEOUT_MS } from '../constants.js';
import { recordNetworkCall, statusFromHttp } from '../../networkCall.js';

export class StoreError extends Error {
  /** @param {string} code a store error code from messages.js */
  constructor(code) {
    super(code);
    this.name = 'StoreError';
    this.code = code;
  }
}

const isAbortError = (err) => err?.name === 'TimeoutError' || err?.name === 'AbortError';

async function readCappedJson(response) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > STORE_MAX_BODY_BYTES) return null;
  let text;
  try {
    text = await response.text();
  } catch (err) {
    if (isAbortError(err)) throw new StoreError('store_unreachable');
    return null;
  }
  if (typeof text !== 'string' || text.length > STORE_MAX_BODY_BYTES) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * POSTs a form and returns the status and the parsed JSON object (or null when the body is not one).
 * @param {{ url: string, form: Record<string, string>, fetchImpl?: typeof fetch, timeoutMs?: number }} opts
 * @returns {Promise<{ status: number, body: object | null }>}
 * @throws {StoreError} store_unreachable on a timeout or network failure
 */
export async function postForm({ url, form, fetchImpl = fetch, timeoutMs = STORE_TIMEOUT_MS }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Burrow',
      },
      body: new URLSearchParams(form),
      redirect: 'manual',
      size: STORE_MAX_BODY_BYTES,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    await recordNetworkCall('license', url, 'error');
    throw new StoreError('store_unreachable');
  }
  await recordNetworkCall('license', url, statusFromHttp(response?.status));
  const status = Number(response?.status);
  if (!Number.isInteger(status)) throw new StoreError('store_error');
  if (status >= 300 && status < 400) return { status, body: null };
  return { status, body: await readCappedJson(response) };
}
