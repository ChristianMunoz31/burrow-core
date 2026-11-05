// Cheap provider reachability check for a stored/env key. Returns only ok/fail and a
// generic reason; the upstream response body is never read, returned or logged.
import { getSecretDef } from './registry.js';

/**
 * @param {string} name allowlisted, testable secret name
 * @param {string} value the key to try
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<{ ok: true } | { ok: false, reason: 'not_configured' | 'unauthorized' | 'rate_limited' | 'unreachable' | 'upstream_error' }>}
 */
export async function testSecret(name, value, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const def = getSecretDef(name);
  if (!def?.test) return { ok: false, reason: 'upstream_error' };
  if (!value) return { ok: false, reason: 'not_configured' };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(def.test.url, {
      method: 'GET',
      headers: def.test.headers(value),
      signal: ac.signal,
      // The Authorization header must never follow a redirect to another host.
      redirect: 'error',
    });
    // The body is never needed; release the connection instead of leaving it unread.
    try {
      await res?.body?.cancel?.();
    } catch {
      /* best effort: the status below is what matters */
    }
    const status = Number(res?.status);
    if (status >= 200 && status < 300) return { ok: true };
    if (status === 401 || status === 403) return { ok: false, reason: 'unauthorized' };
    if (status === 429) return { ok: false, reason: 'rate_limited' };
    return { ok: false, reason: 'upstream_error' };
  } catch {
    return { ok: false, reason: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}
