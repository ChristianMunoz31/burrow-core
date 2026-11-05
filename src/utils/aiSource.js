const KINDS = ['local', 'lan', 'cloud'];

/**
 * Normalizes the `ai` field the server sends (`{ kind, host }`) or returns null for anything
 * else, so older servers and malformed payloads never reach the UI.
 * @param {unknown} value
 * @returns {{ kind: 'local'|'lan'|'cloud', host: string|null } | null}
 */
export function asAiSource(value) {
  if (!value || typeof value !== 'object' || !KINDS.includes(value.kind)) return null;
  return { kind: value.kind, host: typeof value.host === 'string' && value.host ? value.host : null };
}
