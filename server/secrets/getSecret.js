// Secret resolution: valid decrypted Settings row > process env > none.
//
// Many call sites are synchronous (provider.isConfigured(), agentProvider()), so
// reads go through a small in-memory cache that the `secretsPrimer` middleware
// warms once per request (one DB read per instance per TTL). Inside a request use
// peekSecret(); outside a request (timers, scripts) use `await getSecret()` — a
// cold cache simply resolves to the env value.
//
// Nothing here logs values, ciphertext, or error objects.
import { decryptSecret } from './crypto.js';
import { resolveEncryptionKey } from './keyFile.js';
import { SECRET_DEFS, getSecretDef } from './registry.js';
import { createSqliteSecretsStore } from './store.js';

const DEFAULT_TTL_MS = 60_000;
const LOAD_TIMEOUT_MS = 2000;
// After a failed load, retry soon instead of waiting a full TTL.
const NEGATIVE_TTL_MS = 10_000;

const defaults = () => ({
  store: undefined,
  now: () => Date.now(),
  ttlMs: DEFAULT_TTL_MS,
  negativeTtlMs: NEGATIVE_TTL_MS,
  env: null,
});

let cfg = defaults();
let cache = new Map();
let freshUntil = 0;
let hasLoaded = false;
let storageState = 'unknown';
let inflight = null;
let generation = 0;

const currentEnv = () => cfg.env ?? process.env;
// The local key file is only a fallback for the real process env; injected envs (tests) stay explicit.
const loadKey = () => resolveEncryptionKey(currentEnv(), { useKeyFile: cfg.env == null });

// cfg.store: undefined = the real SQLite store, null = no store (tests), object = injected store.
let defaultStore = null;
const resolveStore = () => (cfg.store !== undefined ? cfg.store : (defaultStore ??= createSqliteSecretsStore()));

const isFresh = () => hasLoaded && cfg.now() < freshUntil;

// next === null keeps the previous cache (stale-while-error) and only updates the state
// and retry window; otherwise the cache is replaced.
function commit(gen, next, state, ttlMs = cfg.ttlMs) {
  if (gen !== generation) return; // invalidated while loading: discard, caller reloads
  if (next) cache = next;
  storageState = state;
  freshUntil = cfg.now() + ttlMs;
  hasLoaded = true;
}

async function loadOnce(gen) {
  const keyRes = loadKey();
  if (!keyRes.ok) {
    commit(gen, new Map(), 'encryption_disabled');
    return;
  }
  const store = resolveStore();
  if (!store) {
    commit(gen, new Map(), 'not_configured');
    return;
  }
  let next = new Map();
  let state = 'ok';
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'unavailable' })), LOAD_TIMEOUT_MS);
      timer.unref?.();
    });
    const rows = await Promise.race([store.list(), timeout]);
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!getSecretDef(row?.name)) continue;
      try {
        const value = decryptSecret(
          { ciphertext: row.ciphertext, iv: row.iv, authTag: row.auth_tag },
          row.name,
          keyRes.key,
        );
        next.set(row.name, { value, last4: row.last4, updatedAt: row.updated_at });
      } catch {
        console.warn('Secret decrypt failed:', row.name);
        next.set(row.name, { undecryptable: true, last4: row.last4, updatedAt: row.updated_at });
      }
    }
  } catch (err) {
    state = err?.code === 'schema_missing' ? 'schema_missing' : 'unavailable';
    console.warn('Secrets load failed:', state);
    if (state === 'unavailable') {
      // Transient failure (timeout, network, 5xx): keep serving the last good values
      // instead of silently dropping every Settings key, and retry after a short window.
      commit(gen, null, state, Math.min(cfg.negativeTtlMs, cfg.ttlMs));
      return;
    }
    // schema_missing: nothing is stored, so an empty map is the truth.
    next = new Map();
  } finally {
    clearTimeout(timer);
  }
  commit(gen, next, state);
}

/** Loads the cache if stale. Never rejects. */
export async function primeSecrets() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (isFresh()) return;
    if (!inflight) {
      const gen = generation;
      inflight = loadOnce(gen)
        .catch(() => {
          console.warn('Secrets load failed:', 'unavailable');
        })
        .finally(() => {
          inflight = null;
        });
    }
    await inflight;
  }
}

/** Express middleware: warm the cache, then continue. */
export function secretsPrimer(req, res, next) {
  primeSecrets().then(
    () => next(),
    () => next(),
  );
}

/**
 * Marks the cache stale; the next primeSecrets() reloads. With `name`, that entry is
 * also dropped immediately, so a failed reload (stale-while-error) can't keep serving
 * the value that was just replaced or removed.
 * @param {string} [name]
 */
export function invalidateSecrets(name) {
  if (name) cache.delete(name);
  generation += 1;
  hasLoaded = false;
  freshUntil = 0;
}

/**
 * Sync read. Settings value (if cached and decryptable) > env > ''.
 * @param {string} name allowlisted secret name (throws otherwise)
 * @returns {string}
 */
export function peekSecret(name) {
  if (!getSecretDef(name)) throw new Error('Unknown secret name');
  const entry = cache.get(name);
  if (entry && entry.value) return entry.value;
  return currentEnv()[name] || '';
}

/** @param {string} name @returns {Promise<string>} */
export async function getSecret(name) {
  await primeSecrets();
  return peekSecret(name);
}

/**
 * Status for one secret. Never includes the value.
 * @param {string} name
 */
export function getSecretStatus(name) {
  const def = getSecretDef(name);
  if (!def) throw new Error('Unknown secret name');
  const entry = cache.get(name);
  const envValue = currentEnv()[name] || '';
  const fromSettings = !!(entry && entry.value);
  const source = fromSettings ? 'settings' : envValue ? 'env' : 'none';
  let last4 = null;
  if (source === 'settings') last4 = entry.last4 || null;
  // A short env value would reveal most of itself; stored values already meet per-provider minimums.
  else if (source === 'env' && envValue.length >= 12) last4 = envValue.slice(-4);
  return {
    name: def.name,
    label: def.label,
    provider: def.provider,
    description: def.description,
    configured: source !== 'none',
    source,
    last4,
    updatedAt: source === 'settings' ? entry.updatedAt || null : null,
    envFallback: !!envValue,
    stale: !!(entry && entry.undecryptable),
    testable: !!def.test,
  };
}

export const listSecretStatuses = () => SECRET_DEFS.map((d) => getSecretStatus(d.name));

/** @returns {ReturnType<typeof resolveEncryptionKey>} */
export const getEncryptionKey = () => loadKey();

/** The store used for writes, or null when no store is configured (tests only). */
export const getSecretsStore = () => resolveStore();

/**
 * Encryption + storage state for the status endpoint.
 * @returns {{ encryption: { enabled: boolean, reason?: string }, storage: { available: boolean, reason?: string } }}
 */
export function getSecretsState() {
  const keyRes = loadKey();
  const encryption = keyRes.ok ? { enabled: true } : { enabled: false, reason: keyRes.reason };
  let storage;
  if (!keyRes.ok) storage = { available: false, reason: 'encryption_disabled' };
  else if (!resolveStore()) storage = { available: false, reason: 'not_configured' };
  else if (storageState === 'schema_missing' || storageState === 'unavailable') {
    storage = { available: false, reason: storageState };
  } else storage = { available: true };
  return { encryption, storage };
}

/**
 * Test hook: swap store, clock, TTL or env source.
 * @param {{ store?: object, now?: () => number, ttlMs?: number, negativeTtlMs?: number, env?: Record<string, string | undefined> }} opts
 */
export function __configureSecretsForTests(opts = {}) {
  cfg = { ...cfg, ...opts };
  invalidateSecrets();
}

/** Test hook: clear the cache and restore defaults. */
export function __resetSecretsForTests() {
  cfg = defaults();
  defaultStore = null;
  cache = new Map();
  freshUntil = 0;
  hasLoaded = false;
  storageState = 'unknown';
  inflight = null;
  generation += 1;
}
