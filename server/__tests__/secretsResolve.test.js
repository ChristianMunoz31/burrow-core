// Secret resolution: settings > env > none, TTL cache, invalidation, degradation.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

vi.mock('../../loadEnv.js', () => ({}));

import { encryptSecret } from '../secrets/crypto.js';
import {
  __configureSecretsForTests,
  __resetSecretsForTests,
  getSecret,
  getSecretStatus,
  getSecretsState,
  invalidateSecrets,
  peekSecret,
  primeSecrets,
} from '../secrets/getSecret.js';

const KEY = randomBytes(32);
const ENC_ENV = { SECRETS_ENCRYPTION_KEY: KEY.toString('base64') };
const STORED = `gsk_SENTINELsettings${'0'.repeat(12)}`;
const ENV_VALUE = `gsk_SENTINELenvvalue${'1'.repeat(12)}`;

const rowFor = (name, value, key = KEY) => {
  const enc = encryptSecret(value, name, key);
  return {
    name,
    ciphertext: enc.ciphertext,
    iv: enc.iv,
    auth_tag: enc.authTag,
    last4: value.slice(-4),
    updated_at: '2026-01-01T00:00:00.000Z',
  };
};

const makeStore = (rows = []) => ({
  list: vi.fn(async () => rows),
  upsert: vi.fn(),
  remove: vi.fn(),
});

let clock;
beforeEach(() => {
  clock = 1_000_000;
  __resetSecretsForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

const configure = (store, env) =>
  __configureSecretsForTests({ store, env, now: () => clock, ttlMs: 60_000 });

describe('peekSecret precedence', () => {
  it('returns env when nothing is stored, and empty string when neither', async () => {
    configure(makeStore([]), { ...ENC_ENV, AI_CLOUD_API_KEY: ENV_VALUE });
    await primeSecrets();
    expect(peekSecret('AI_CLOUD_API_KEY')).toBe(ENV_VALUE);
    expect(peekSecret('OURA_TOKEN')).toBe('');
  });

  it('a stored value overrides env', async () => {
    configure(makeStore([rowFor('AI_CLOUD_API_KEY', STORED)]), { ...ENC_ENV, AI_CLOUD_API_KEY: ENV_VALUE });
    await primeSecrets();
    expect(peekSecret('AI_CLOUD_API_KEY')).toBe(STORED);
    expect(await getSecret('AI_CLOUD_API_KEY')).toBe(STORED);
    const status = getSecretStatus('AI_CLOUD_API_KEY');
    expect(status).toMatchObject({ source: 'settings', configured: true, envFallback: true, stale: false });
    expect(status.last4).toBe(STORED.slice(-4));
  });

  it('is identical to plain env reads before any prime (cold cache)', () => {
    configure(makeStore([rowFor('AI_CLOUD_API_KEY', STORED)]), { ...ENC_ENV, AI_CLOUD_API_KEY: ENV_VALUE });
    expect(peekSecret('AI_CLOUD_API_KEY')).toBe(ENV_VALUE);
  });

  it('throws for names outside the allowlist', () => {
    configure(makeStore([]), ENC_ENV);
    expect(() => peekSecret('NOPE')).toThrow();
    expect(() => peekSecret('DATABASE_URL')).toThrow();
  });

  it('reports env source with last4, and none when unset', async () => {
    configure(makeStore([]), { ...ENC_ENV, AI_CLOUD_API_KEY: ENV_VALUE });
    await primeSecrets();
    expect(getSecretStatus('AI_CLOUD_API_KEY')).toMatchObject({
      source: 'env',
      last4: ENV_VALUE.slice(-4),
      updatedAt: null,
    });
    expect(getSecretStatus('OURA_TOKEN')).toMatchObject({ source: 'none', configured: false, last4: null });
  });

  it('withholds last4 for env values shorter than 12 characters', async () => {
    configure(makeStore([]), { ...ENC_ENV, AI_CLOUD_API_KEY: 'a'.repeat(11), OURA_TOKEN: 'b'.repeat(12) });
    await primeSecrets();
    expect(getSecretStatus('AI_CLOUD_API_KEY')).toMatchObject({ source: 'env', configured: true, last4: null });
    expect(getSecretStatus('OURA_TOKEN')).toMatchObject({ source: 'env', last4: 'bbbb' });
  });
});

describe('cache', () => {
  it('does not reload within the TTL, but does after it', async () => {
    const store = makeStore([]);
    configure(store, ENC_ENV);
    await primeSecrets();
    await primeSecrets();
    expect(store.list).toHaveBeenCalledTimes(1);
    clock += 59_000;
    await primeSecrets();
    expect(store.list).toHaveBeenCalledTimes(1);
    clock += 2_000;
    await primeSecrets();
    expect(store.list).toHaveBeenCalledTimes(2);
  });

  it('invalidateSecrets forces a reload that picks up new values', async () => {
    const rows = [];
    const store = makeStore(rows);
    configure(store, { ...ENC_ENV, AI_CLOUD_API_KEY: ENV_VALUE });
    await primeSecrets();
    expect(peekSecret('AI_CLOUD_API_KEY')).toBe(ENV_VALUE);
    rows.push(rowFor('AI_CLOUD_API_KEY', STORED));
    invalidateSecrets();
    await primeSecrets();
    expect(store.list).toHaveBeenCalledTimes(2);
    expect(peekSecret('AI_CLOUD_API_KEY')).toBe(STORED);
  });

  it('concurrent primes share a single list call', async () => {
    const store = makeStore([]);
    configure(store, ENC_ENV);
    await Promise.all([primeSecrets(), primeSecrets(), primeSecrets()]);
    expect(store.list).toHaveBeenCalledTimes(1);
  });

  it('discards a load that was invalidated mid-flight and reloads', async () => {
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const store = makeStore([]);
    store.list.mockImplementationOnce(async () => {
      await gate;
      return [];
    });
    configure(store, ENC_ENV);
    const pending = primeSecrets();
    invalidateSecrets();
    release();
    await pending;
    expect(store.list).toHaveBeenCalledTimes(2);
  });
});

describe('degradation', () => {
  it('falls back to env, does not throw, and warns once with the code only', async () => {
    const store = makeStore([]);
    store.list.mockRejectedValue(Object.assign(new Error('boom https://x.example.test key=sentinel'), { code: 'unavailable' }));
    configure(store, { ...ENC_ENV, AI_CLOUD_API_KEY: ENV_VALUE });
    await expect(primeSecrets()).resolves.toBeUndefined();
    await primeSecrets(); // negative cache: no second attempt within TTL
    expect(store.list).toHaveBeenCalledTimes(1);
    expect(peekSecret('AI_CLOUD_API_KEY')).toBe(ENV_VALUE);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith('Secrets load failed:', 'unavailable');
    expect(getSecretsState().storage).toEqual({ available: false, reason: 'unavailable' });
  });

  it('maps a missing table to schema_missing', async () => {
    const store = makeStore([]);
    store.list.mockRejectedValue(Object.assign(new Error('x'), { code: 'schema_missing' }));
    configure(store, ENC_ENV);
    await primeSecrets();
    expect(getSecretsState().storage).toEqual({ available: false, reason: 'schema_missing' });
  });

  it('never calls the store when the encryption key is missing', async () => {
    const store = makeStore([rowFor('AI_CLOUD_API_KEY', STORED)]);
    configure(store, { AI_CLOUD_API_KEY: ENV_VALUE });
    await primeSecrets();
    expect(store.list).not.toHaveBeenCalled();
    expect(peekSecret('AI_CLOUD_API_KEY')).toBe(ENV_VALUE);
    expect(getSecretsState()).toEqual({
      encryption: { enabled: false, reason: 'missing' },
      storage: { available: false, reason: 'encryption_disabled' },
    });
  });

  it('reports an invalid encryption key and ignores stored rows', async () => {
    const store = makeStore([rowFor('AI_CLOUD_API_KEY', STORED)]);
    configure(store, { SECRETS_ENCRYPTION_KEY: 'short', AI_CLOUD_API_KEY: ENV_VALUE });
    await primeSecrets();
    expect(store.list).not.toHaveBeenCalled();
    expect(getSecretsState().encryption).toEqual({ enabled: false, reason: 'invalid' });
  });

  it('treats an undecryptable row as stale and falls through to env', async () => {
    const wrongKeyRow = rowFor('AI_CLOUD_API_KEY', STORED, randomBytes(32));
    configure(makeStore([wrongKeyRow]), { ...ENC_ENV, AI_CLOUD_API_KEY: ENV_VALUE });
    await primeSecrets();
    expect(peekSecret('AI_CLOUD_API_KEY')).toBe(ENV_VALUE);
    expect(getSecretStatus('AI_CLOUD_API_KEY')).toMatchObject({ source: 'env', stale: true });
    expect(console.warn).toHaveBeenCalledWith('Secret decrypt failed:', 'AI_CLOUD_API_KEY');
  });

  it('ignores stored rows whose name is not allowlisted', async () => {
    configure(makeStore([rowFor('DATABASE_URL', 'x'.repeat(30))]), ENC_ENV);
    await primeSecrets();
    expect(() => peekSecret('DATABASE_URL')).toThrow();
  });

  it('reports not_configured when there is no store', async () => {
    configure(null, ENC_ENV);
    await primeSecrets();
    expect(getSecretsState().storage).toEqual({ available: false, reason: 'not_configured' });
  });
});

describe('stale-while-error', () => {
  const unavailable = () => Object.assign(new Error('boom'), { code: 'unavailable' });

  it('keeps serving the last good values when a reload fails, then retries after a short window', async () => {
    const rows = [rowFor('AI_CLOUD_API_KEY', STORED)];
    const store = makeStore(rows);
    configure(store, { ...ENC_ENV, AI_CLOUD_API_KEY: ENV_VALUE });
    await primeSecrets();
    expect(peekSecret('AI_CLOUD_API_KEY')).toBe(STORED);

    store.list.mockRejectedValue(unavailable());
    clock += 61_000; // TTL elapsed
    await primeSecrets();
    expect(store.list).toHaveBeenCalledTimes(2);
    expect(peekSecret('AI_CLOUD_API_KEY')).toBe(STORED);
    expect(getSecretStatus('AI_CLOUD_API_KEY')).toMatchObject({ source: 'settings', stale: false });
    expect(getSecretsState().storage).toEqual({ available: false, reason: 'unavailable' });

    clock += 9_000; // inside the negative TTL: no new attempt
    await primeSecrets();
    expect(store.list).toHaveBeenCalledTimes(2);

    clock += 2_000; // past ~10s: retries, still failing, still serving stored value
    await primeSecrets();
    expect(store.list).toHaveBeenCalledTimes(3);
    expect(peekSecret('AI_CLOUD_API_KEY')).toBe(STORED);

    store.list.mockResolvedValue([rowFor('AI_CLOUD_API_KEY', `${STORED}new`)]);
    clock += 11_000;
    await primeSecrets();
    expect(peekSecret('AI_CLOUD_API_KEY')).toBe(`${STORED}new`);
    expect(getSecretsState().storage).toEqual({ available: true });
  });

  it('a first-ever failure still yields an empty cache and env fallback, retried after the short window', async () => {
    const store = makeStore([]);
    store.list.mockRejectedValue(unavailable());
    configure(store, { ...ENC_ENV, AI_CLOUD_API_KEY: ENV_VALUE });
    await primeSecrets();
    expect(peekSecret('AI_CLOUD_API_KEY')).toBe(ENV_VALUE);
    clock += 11_000;
    await primeSecrets();
    expect(store.list).toHaveBeenCalledTimes(2);
  });

  it('a timeout counts as unavailable and keeps the previous cache', async () => {
    vi.useFakeTimers();
    try {
      const store = makeStore([rowFor('AI_CLOUD_API_KEY', STORED)]);
      configure(store, ENC_ENV);
      await primeSecrets();
      store.list.mockImplementation(() => new Promise(() => {}));
      clock += 61_000;
      const pending = primeSecrets();
      await vi.advanceTimersByTimeAsync(2500);
      await pending;
      expect(peekSecret('AI_CLOUD_API_KEY')).toBe(STORED);
      expect(console.warn).toHaveBeenCalledWith('Secrets load failed:', 'unavailable');
    } finally {
      vi.useRealTimers();
    }
  });

  it('still empties the cache for schema_missing and encryption_disabled', async () => {
    const store = makeStore([rowFor('AI_CLOUD_API_KEY', STORED)]);
    const env = { ...ENC_ENV };
    configure(store, env);
    await primeSecrets();
    expect(peekSecret('AI_CLOUD_API_KEY')).toBe(STORED);

    store.list.mockRejectedValue(Object.assign(new Error('x'), { code: 'schema_missing' }));
    clock += 61_000;
    await primeSecrets();
    expect(peekSecret('AI_CLOUD_API_KEY')).toBe('');
    expect(getSecretsState().storage.reason).toBe('schema_missing');

    store.list.mockResolvedValue([rowFor('AI_CLOUD_API_KEY', STORED)]);
    clock += 61_000;
    await primeSecrets();
    expect(peekSecret('AI_CLOUD_API_KEY')).toBe(STORED);

    delete env.SECRETS_ENCRYPTION_KEY;
    clock += 61_000;
    await primeSecrets();
    expect(peekSecret('AI_CLOUD_API_KEY')).toBe('');
    expect(getSecretsState().storage.reason).toBe('encryption_disabled');
  });

  it('empties the cache for not_configured', async () => {
    const store = makeStore([rowFor('AI_CLOUD_API_KEY', STORED)]);
    configure(store, ENC_ENV);
    await primeSecrets();
    configure(null, ENC_ENV); // drops the store; invalidates
    await primeSecrets();
    expect(peekSecret('AI_CLOUD_API_KEY')).toBe('');
    expect(getSecretsState().storage.reason).toBe('not_configured');
  });
});

describe('invalidateSecrets(name)', () => {
  it('drops that entry immediately so a failed reload cannot serve the replaced value', async () => {
    const store = makeStore([rowFor('AI_CLOUD_API_KEY', STORED), rowFor('OURA_TOKEN', `sk-${'z'.repeat(30)}`)]);
    configure(store, { ...ENC_ENV, AI_CLOUD_API_KEY: ENV_VALUE });
    await primeSecrets();
    expect(peekSecret('AI_CLOUD_API_KEY')).toBe(STORED);

    invalidateSecrets('AI_CLOUD_API_KEY');
    expect(peekSecret('AI_CLOUD_API_KEY')).toBe(ENV_VALUE); // gone before any reload
    expect(peekSecret('OURA_TOKEN')).toBe(`sk-${'z'.repeat(30)}`); // others untouched

    store.list.mockRejectedValue(Object.assign(new Error('x'), { code: 'unavailable' }));
    await primeSecrets();
    expect(peekSecret('AI_CLOUD_API_KEY')).toBe(ENV_VALUE);
    expect(peekSecret('OURA_TOKEN')).toBe(`sk-${'z'.repeat(30)}`); // stale-while-error
  });
});
