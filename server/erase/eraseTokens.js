// Single-use erase tokens for the two-step "Erase all my data" flow. Memory only (a restart forgets them,
// which just means asking again). Only a SHA-256 hash of a token is kept, keyed to the caller's session:
// the desktop cookie, the web sign-in cookie, or (no sign-in, loopback only) the client address plus the
// request Origin, so a token is also bound to the page that asked for it.
// Expiry runs on a monotonic clock (performance.now), so moving the wall clock back cannot extend a token.
import crypto from 'node:crypto';

export const ERASE_TOKEN_TTL_MS = 2 * 60 * 1000;
const MAX_SESSIONS = 50;
// A spent or expired entry is kept a while so a replay or a late use gets its own answer.
const KEEP_AFTER_EXPIRY_MS = 15 * 60 * 1000;

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest();

/**
 * Key for the caller's session; the cookie value itself is never stored, only its hash.
 * @param {{ headers: { cookie?: string }, ip?: string }} req
 * @returns {string}
 */
export function sessionKeyOf(req) {
  const cookies = new Map();
  for (const part of String(req.headers?.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) cookies.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  const desktop = cookies.get('burrow_desktop');
  if (desktop) return `d:${sha256(desktop).toString('hex')}`;
  const session = cookies.get('burrow_session');
  if (session) return `s:${sha256(session).toString('hex')}`;
  return `o:${req.ip ?? 'unknown'}:${String(req.headers?.origin ?? '')}`;
}

/**
 * @param {{ now?: () => number, mono?: () => number, ttlMs?: number }} [opts] `mono` is the monotonic clock
 *   (ms) that decides expiry; `now` is the wall clock (epoch ms) used only for the expiresAt shown to the user.
 *   Both are injectable for tests.
 */
export function createEraseTokenStore({ now = () => Date.now(), mono = () => globalThis.performance.now(), ttlMs = ERASE_TOKEN_TTL_MS } = {}) {
  /** @type {Map<string, { hash: Buffer, expiresMono: number, used: boolean }>} */
  const entries = new Map();

  const prune = () => {
    const t = mono();
    for (const [key, entry] of entries) if (t >= entry.expiresMono + KEEP_AFTER_EXPIRY_MS) entries.delete(key);
    while (entries.size > MAX_SESSIONS) entries.delete(entries.keys().next().value);
  };

  return {
    /**
     * Issues a token for a session; any earlier token of that session stops working.
     * @param {string} sessionKey
     * @returns {{ token: string, expiresAt: number }}
     */
    issue(sessionKey) {
      prune();
      const token = crypto.randomBytes(32).toString('base64url');
      entries.set(sessionKey, { hash: sha256(token), expiresMono: mono() + ttlMs, used: false });
      return { token, expiresAt: now() + ttlMs };
    },

    /**
     * Checks a token without using it up.
     * @param {string} sessionKey
     * @param {unknown} token
     * @returns {'ok' | 'missing' | 'invalid' | 'used' | 'expired'}
     */
    check(sessionKey, token) {
      if (typeof token !== 'string' || token.length === 0) return 'missing';
      const entry = entries.get(sessionKey);
      const given = sha256(token.slice(0, 256));
      if (!entry || !crypto.timingSafeEqual(given, entry.hash)) return 'invalid';
      if (entry.used) return 'used';
      if (mono() >= entry.expiresMono) return 'expired';
      return 'ok';
    },

    /**
     * Uses the token up. The spent entry stays until it would have expired, so a replay answers "used".
     * @param {string} sessionKey
     * @param {unknown} token
     * @returns {boolean} true when this call used it up
     */
    consume(sessionKey, token) {
      if (this.check(sessionKey, token) !== 'ok') return false;
      entries.get(sessionKey).used = true;
      return true;
    },

    /**
     * Gives a consumed token back (the erase was refused before it started, so nothing was spent).
     * @param {string} sessionKey
     * @param {unknown} token
     * @returns {boolean} true when the token was put back
     */
    release(sessionKey, token) {
      const entry = entries.get(sessionKey);
      if (!entry || typeof token !== 'string' || !crypto.timingSafeEqual(sha256(token.slice(0, 256)), entry.hash)) return false;
      if (mono() >= entry.expiresMono) return false;
      entry.used = false;
      return true;
    },

    clear() {
      entries.clear();
    },
  };
}
