// Heuristic redaction for app_state rows shown in the data browser. Defense in
// depth, not a guarantee: real secrets no longer live in app_state.

import { ACTIVATION_STATE_KEY } from '../license/constants.js';

export const REDACTED = '[redacted]';

// app_state rows no API ever returns (state, data browser, export): the license activation holds the buyer's
// email and is useless on another computer.
// 'dev.licenseOverride' is reserved by devtools/ (a defensive literal, no override code lives here).
// app_state rows that never leave this computer: no export, no import, hidden from the state API and the data browser;
// kept in backups and restore. javi.inbox is behavioural metadata (when you looked at which page).
export const LOCAL_ONLY_APP_STATE_KEYS = new Set(['javi.inbox']);
export const HIDDEN_APP_STATE_KEYS = new Set([ACTIVATION_STATE_KEY, 'dev.licenseOverride', ...LOCAL_ONLY_APP_STATE_KEYS]);

// Substring match on a key normalized as: camelCase -> snake (insert '_' at lower->Upper),
// lowercase. Deliberately broad (fail closed): `author`/`authorName` are spared by the
// `auth(?!or)` lookahead, while `authorization` is re-added explicitly.
export const SENSITIVE_KEY_RE =
  /pass|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|accesskeyid|(^|_)pw($|_)|passcode|credential|private[_-]?key|session|cookie|bearer|signature|dsn|webhook|jwt|auth(?!or)|authoriz/;

// Applied to string values regardless of key. Prefix-style tokens must start the string
// or follow a non-alphanumeric character (so "task-1" does not match "sk-").
export const SENSITIVE_VALUE_RE = new RegExp(
  [
    '(?:^|[^A-Za-z0-9])(?:sk-|sk_(?:live|test)_|gsk_|gh[pousr]_|github_pat_|xox[abpr]-|ya29\\.|ABSK|bedrock-api-key-)',
    '(?:^|[^A-Za-z0-9])AKIA[0-9A-Z]{16}',
    '(?:^|[^A-Za-z0-9])AIza[0-9A-Za-z_-]{20,}',
    '(?:^|[^A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}',
    '\\bBearer\\s+\\S+',
    '://[^/\\s:]+:[^@\\s]+@',
  ].join('|'),
  'i',
);

// `{ name|key: 'OPENAI_API_KEY', value: ... }` pair objects: the value is sensitive
// because of its sibling label, whatever its own shape.
const LABEL_PROPS = ['name', 'key'];

const MAX_DEPTH = 20;

// Value regexes only scan the head of a string (bounds regex cost on huge values). A longer
// string that looks like a URL with userinfo may hide credentials past the head, so it is
// redacted conservatively.
const VALUE_SCAN_LIMIT = 4096;
// Strings that look like serialized JSON are parsed (up to this size) and redacted structurally.
const JSON_PARSE_LIMIT = 64 * 1024;

const isSensitiveString = (s) => {
  if (SENSITIVE_VALUE_RE.test(s.slice(0, VALUE_SCAN_LIMIT))) return true;
  return s.length > VALUE_SCAN_LIMIT && s.includes('://') && s.includes('@');
};

const normalizeKey = (key) =>
  String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();

const isSensitiveKey = (key) => SENSITIVE_KEY_RE.test(normalizeKey(key));

/**
 * Returns a redacted copy of `value`; never mutates the input. Fails closed past depth 20.
 * @param {unknown} value
 * @param {number} depth
 * @returns {unknown}
 */
export function redactValue(value, depth = 0) {
  if (depth > MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) {
    // `['API_KEY', 'abc']` entries-style pair: the second element is sensitive via its label.
    if (value.length === 2 && typeof value[0] === 'string' && isSensitiveKey(value[0])) {
      return [value[0], REDACTED];
    }
    return value.map((v) => redactValue(v, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    const labelled = LABEL_PROPS.some(
      (p) => typeof value[p] === 'string' && isSensitiveKey(value[p]),
    );
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSensitiveKey(k) || (labelled && k === 'value') ? REDACTED : redactValue(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') {
    const head = value.trimStart()[0];
    if ((head === '{' || head === '[') && value.length <= JSON_PARSE_LIMIT) {
      let parsed;
      try {
        parsed = JSON.parse(value);
      } catch {
        parsed = undefined;
      }
      if (parsed !== undefined && parsed !== null && typeof parsed === 'object') {
        return JSON.stringify(redactValue(parsed, depth + 1));
      }
    }
    if (isSensitiveString(value)) return REDACTED;
  }
  return value;
}

/**
 * @param {{ key?: string, value?: unknown }} row
 * @returns {{ key?: string, value?: unknown }}
 */
export function redactAppStateRow(row) {
  if (!row || typeof row !== 'object') return row;
  if (isSensitiveKey(row.key ?? '')) return { ...row, value: REDACTED };
  return { ...row, value: redactValue(row.value, 0) };
}
