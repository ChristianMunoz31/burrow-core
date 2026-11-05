// Client-side redaction applied to page context before it leaves the device.
// Mirrors server/dataBrowser/redact.js (same key heuristic, same normalization) and adds
// token-in-string scrubbing, emails, and coordinates. Defense in depth: the server
// re-validates and re-redacts tokens.

export const REDACTED = '[redacted]';

export const SENSITIVE_KEY_RE =
  /pass|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|accesskeyid|(^|_)pw($|_)|passcode|credential|private[_-]?key|session|cookie|bearer|signature|dsn|webhook|jwt|auth(?!or)|authoriz|last4|lat(itude)?$|lon(gitude)?$/;

export const SECRET_TOKEN_RE =
  /\b(?:sk-|sk_(?:live|test)_|gsk_|gh[pousr]_|github_pat_|xox[abpr]-|ya29\.|ABSK|bedrock-api-key-)[A-Za-z0-9_\-.]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?|Bearer\s+\S+|[A-Za-z0-9_-]{40,}/g;

export const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
export const URL_USERINFO_RE = /(:\/\/)[^/\s:@]+:[^@\s/]+@/g;

const MAX_DEPTH = 8;

const normalizeKey = (key) =>
  String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();

const isSensitiveKey = (key) => SENSITIVE_KEY_RE.test(normalizeKey(key));

/**
 * @param {string} s
 * @returns {string}
 */
export function redactText(s) {
  return String(s)
    .replace(URL_USERINFO_RE, '$1')
    .replace(SECRET_TOKEN_RE, REDACTED)
    .replace(EMAIL_RE, '[email]');
}

/**
 * Deep, non-mutating redaction. Sensitive keys become '[redacted]', strings are scrubbed,
 * functions/undefined are dropped, Dates become ISO strings, depth > 8 fails closed.
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export function redactForJavi(value, depth = 0) {
  if (depth > MAX_DEPTH) return REDACTED;
  if (value === null) return null;
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Array.isArray(value)) {
    return value
      .filter((v) => v !== undefined && typeof v !== 'function')
      .map((v) => redactForJavi(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined || typeof v === 'function') continue;
      // Keys can carry user text (e.g. bookmark categories), so scrub them too.
      out[redactText(k)] = isSensitiveKey(k) ? REDACTED : redactForJavi(v, depth + 1);
    }
    return out;
  }
  return undefined;
}
