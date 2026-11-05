// Classify AI errors (local Ollama or an OpenAI-compatible endpoint) into something the
// UI can act on. Every probe is defensive: read structured fields first, then scan the
// stringified error, and default to a safe 'unknown' rather than throwing while handling
// a throw. Classified messages are fixed strings; provider bodies are never surfaced.

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function extract(err) {
  if (!err) return { text: '', body: null };
  const text =
    typeof err === 'string'
      ? err
      : `${err.message || ''} ${err.statusText || ''} ${typeof err.body === 'string' ? err.body : ''} ${(() => {
          try {
            return JSON.stringify(err.response?.data ?? err.error ?? '');
          } catch {
            return '';
          }
        })()}`;
  let body = err?.response?.data?.error || (typeof err?.error === 'object' ? err.error : null);
  if (!body && typeof text === 'string') {
    const brace = text.indexOf('{');
    if (brace !== -1) {
      try {
        const parsed = JSON.parse(text.slice(brace));
        body = parsed.error || parsed;
      } catch {
        /* not JSON */
      }
    }
  }
  return { text, body };
}

function parseRetryMs(text, body, err) {
  if (Number.isFinite(err?.retryAfterMs)) return err.retryAfterMs;
  const details = body?.details;
  if (Array.isArray(details)) {
    for (const d of details) {
      if (d?.retryDelay) {
        const m = String(d.retryDelay).match(/([\d.]+)\s*(ms|s)?/);
        if (m) return m[2] === 'ms' ? Number(m[1]) : Number(m[1]) * 1000;
      }
    }
  }
  const ms = text.match(/retry in\s+([\d.]+)\s*ms/i);
  if (ms) return Number(ms[1]);
  const s = text.match(/retry in\s+([\d.]+)\s*s/i);
  if (s) return Number(s[1]) * 1000;
  return null;
}

export const FRIENDLY = Object.freeze({
  day: 'The cloud AI provider reports its daily limit is used up. Switch to local AI in Settings > AI, or try again later.',
  minute: 'The AI provider is rate limiting requests. Wait a moment and try again.',
  unavailable: "Javi can't reach Ollama right now. Check that Ollama is running, then try again.",
  unavailable_cloud:
    "Javi can't reach the cloud AI endpoint right now. Check the endpoint in Settings > AI, or switch back to local AI.",
  timeout: 'The model took too long to answer. Try again, or pick a smaller model in Settings > AI.',
  first_token_timeout:
    'Javi is still warming up and did not start answering in time. Wait a minute, then try again. If this keeps happening, pick a smaller model in Settings > AI.',
  model_missing: 'The selected model is not installed. Pick another one in Settings > AI.',
  unknown: 'The AI model ran into a problem. Please try again.',
});

/**
 * True for a network-level failure to reach the endpoint (refused, DNS, reset).
 * @param {unknown} err
 * @returns {boolean}
 */
export function isConnectionError(err) {
  if (!err || typeof err !== 'object') return false;
  const code = err.code || err.errno || err.cause?.code;
  if (typeof code === 'string' && CONNECTION_CODES.has(code)) return true;
  if (err.name === 'FetchError' && err.type === 'system') return true;
  return /\b(ECONNREFUSED|ENOTFOUND|ECONNRESET|EHOSTUNREACH)\b|fetch failed/i.test(String(err.message || ''));
}

/** True when the failed call went to the OpenAI-compatible cloud endpoint. */
const isCloudError = (err) => err?.provider === 'openai_compat' || err?.cause?.provider === 'openai_compat';

/**
 * @param {unknown} err
 * A first-token timeout on a local model is its own scope (`first_token_timeout`): the model was
 * most likely still loading, which is not the same as Ollama being unreachable.
 * @returns {{ scope: 'minute'|'day'|'unavailable'|'timeout'|'first_token_timeout'|'model_missing'|'unknown', isRateLimit: boolean, httpStatus: number|null, retryMs: number|null, friendly: string }}
 */
export function classifyLLMError(err) {
  const { text, body } = extract(err);
  const httpStatus =
    Number(err?.httpStatus) ||
    Number(body?.code) ||
    Number(err?.status) ||
    (/\b429\b/.test(text) ? 429 : null);
  const base = { isRateLimit: false, httpStatus, retryMs: null };

  if (err?.timeoutKind === 'first_token' && !isCloudError(err)) {
    return { ...base, scope: 'first_token_timeout', httpStatus: httpStatus || 504, friendly: FRIENDLY.first_token_timeout };
  }
  if (err?.isTimeout || err?.code === 'timeout' || err?.name === 'TimeoutError') {
    return { ...base, scope: 'timeout', httpStatus: httpStatus || 504, friendly: FRIENDLY.timeout };
  }
  if (err?.code === 'model_missing' || /model\s+["'][^"']*["']\s+not found|model .{0,80}not found/i.test(text)) {
    return { ...base, scope: 'model_missing', friendly: FRIENDLY.model_missing };
  }
  if (err?.code === 'unavailable' || isConnectionError(err)) {
    // Same scope for both providers; the copy names what could not be reached.
    return { ...base, scope: 'unavailable', friendly: isCloudError(err) ? FRIENDLY.unavailable_cloud : FRIENDLY.unavailable };
  }

  const isRateLimit = httpStatus === 429 || /RESOURCE_EXHAUSTED/i.test(text) || /quota/i.test(text);
  if (!isRateLimit) return { ...base, scope: 'unknown', friendly: FRIENDLY.unknown };

  const perDay = /PerDay|per day|requests per day/i.test(text);
  const perMinute = /PerMinute|per minute|requests per minute/i.test(text);
  const scope = perDay && !perMinute ? 'day' : 'minute';
  return {
    scope,
    isRateLimit: true,
    httpStatus: httpStatus || 429,
    retryMs: parseRetryMs(text, body, err),
    friendly: FRIENDLY[scope],
  };
}
