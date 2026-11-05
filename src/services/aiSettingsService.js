import { buildApiError } from '../utils/apiError';
import { readSse } from '../utils/sse';

const PROXY_URL = '/api/settings/ai';

async function req(path, options = {}) {
  const response = await fetch(`${PROXY_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = buildApiError(response, body);
    // Settings routes send { error: <code>, code?, message? }; keep the code for inline copy.
    if (!err.code && typeof body?.error === 'string') err.code = body.error;
    if (typeof body?.code === 'string') err.code = body.code;
    throw err;
  }
  return body.data;
}

const put = (path, payload) => req(path, { method: 'PUT', body: JSON.stringify(payload) });
const post = (path, payload) => req(path, { method: 'POST', body: JSON.stringify(payload) });

/**
 * @typedef {{ name: string, sizeBytes: number, parameterSize: string|null,
 *   parameterCount: number|null, family: string|null, quantization: string|null,
 *   capabilities: string[], contextLength: number|null, modifiedAt: string|null }} InstalledModel
 * @typedef {{ enabled: boolean, provider: 'ollama'|'openai_compat',
 *   ollama: { host: string, hostSource: string, loopback: boolean, running: boolean,
 *     version: string|null, numCtx: number,
 *     error: null|{ code: string, hint?: string } },
 *   models: { chat: { selected: string|null, effective: string|null, source: string },
 *             tools: { selected: string|null, effective: string|null, source: string } },
 *   cloud: { optIn: boolean, keySaved: boolean, baseUrl: string|null, host: string|null,
 *     model: string|null, tokenParam: string, ready: boolean,
 *     consent: { current: boolean, acceptedAt: string|null, host: string|null, version: number|null },
 *     consentVersion: number, categories: Record<string, boolean>, active: boolean } }} AiSettings
 */

/**
 * @typedef {{ name: string, downloadGb: number, purpose: 'chat'|'tools'|'both',
 *   reason: string }} ModelRecommendation
 * @typedef {{ ollama: 'running'|'stopped'|'missing'|'unreachable'|'remote'|'disabled',
 *   host: string, version: string|null, models: { name: string, sizeBytes?: number }[],
 *   ready: boolean, ramGb: number,
 *   recommended: { tier: string, ramGb: number, primary: ModelRecommendation[],
 *     optional: ModelRecommendation[] },
 *   canPull: boolean }} OllamaSetupState
 * @typedef {{ phase: 'manifest'|'downloading'|'verifying'|'finalizing', completed: number,
 *   total: number }} PullProgress
 */

const fail = (message, extra) => Object.assign(new Error(message), extra);

/** Streams POST /api/settings/ai/pull; resolves on `done`, rejects with a coded error. */
async function pull(model, { signal, onProgress } = {}) {
  let response;
  try {
    response = await fetch(`${PROXY_URL}/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      cache: 'no-store',
      body: JSON.stringify({ model }),
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw fail("Couldn't reach Burrow.", { code: 'network', status: 0 });
  }
  const contentType = response.headers?.get?.('content-type') ?? '';
  if (!response.ok || !response.body || !contentType.includes('text/event-stream')) {
    const body = await response.json().catch(() => ({}));
    const err = buildApiError(response, body);
    // The rate limiter answers { error: <sentence>, code: 'rate_limited' }; the others send the
    // code in `error`. Prefer an explicit `code` so the sentence never becomes the code.
    if (typeof body?.code === 'string') err.code = body.code;
    else if (!err.code && typeof body?.error === 'string') err.code = body.error;
    if (!err.code) err.code = 'http_error';
    throw err;
  }
  let finished = false;
  let failure = null;
  try {
    await readSse(response, (event, payload) => {
      if (event === 'progress') onProgress?.(payload);
      else if (event === 'done') finished = true;
      else if (event === 'error') {
        failure = fail(typeof payload?.message === 'string' ? payload.message : 'Download failed.', {
          code: typeof payload?.code === 'string' ? payload.code : 'pull_failed',
        });
      }
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw fail('The download was interrupted.', { code: 'stream_error' });
  }
  if (failure) throw failure;
  if (!finished) throw fail('The download was interrupted.', { code: 'stream_error' });
}

export const aiSettingsService = {
  /** @returns {Promise<OllamaSetupState>} */
  setup: () => req('/setup'),
  /**
   * Download a model through Ollama. Abort the signal to cancel (Ollama keeps partial data).
   * @param {string} model
   * @param {{ signal?: AbortSignal, onProgress?: (p: PullProgress) => void }} [options]
   * @returns {Promise<void>}
   */
  pull,
  /** @returns {Promise<AiSettings>} */
  get: () => req(''),
  /** @returns {Promise<{ models: InstalledModel[] }>} Rejects with code ollama_unavailable. */
  models: () => req('/models'),
  /** null means automatic. @returns {Promise<AiSettings>} */
  setModels: ({ chatModel, toolModel }) => put('/models', { chatModel, toolModel }),
  /** null resets to the default host. @returns {Promise<AiSettings>} */
  setHost: (host) => put('/host', { host }),
  /** @returns {Promise<AiSettings>} */
  setProvider: (provider) => put('/provider', { provider }),
  /** @returns {Promise<AiSettings>} */
  setCloud: ({ baseUrl, model, tokenParam }) => put('/cloud', { baseUrl, model, tokenParam }),
  /**
   * Records consent and turns cloud AI on. Only ever called from the consent dialog, after the
   * user ticks both statements. @returns {Promise<AiSettings>}
   */
  enableCloud: ({ version, host, baseUrl, acknowledgements }) =>
    post('/cloud/enable', { version, host, baseUrl, acknowledgements }),
  /** Back to this computer; the key, address and model stay saved. @returns {Promise<AiSettings>} */
  disableCloud: () => post('/cloud/disable', {}),
  /** Partial map of category id to boolean. @returns {Promise<AiSettings>} */
  setCloudCategories: (categories) => put('/cloud-categories', { categories }),
  /** Records that the "try cloud" hint was shown or dismissed. @param {'shown'|'dismissed'} event */
  cloudHint: (event) => post('/cloud-hint', { event }),
};
