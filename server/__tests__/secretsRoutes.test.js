// /api/secrets routes on a minimal Express app (so the strict limiter on server.js
// doesn't consume the budget; limiter/error-handler coverage is in secretsServer.test.js).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { randomBytes } from 'node:crypto';

vi.mock('../../loadEnv.js', () => ({}));

import { registerSecretsRoutes } from '../secretsRoutes.js';
import { encryptSecret } from '../secrets/crypto.js';
import { SECRET_DEFS } from '../secrets/registry.js';
import { testSecret } from '../secrets/testSecret.js';
import { __resetNetPolicyForTests } from '../netPolicy.js';
import {
  __configureSecretsForTests,
  __resetSecretsForTests,
  invalidateSecrets,
  peekSecret,
} from '../secrets/getSecret.js';

const KEY = randomBytes(32).toString('base64');
const STORED = `gsk_SENTINELsettings${'0'.repeat(12)}`;
const ENV_SENTINEL = `sk-SENTINELenv${'1'.repeat(16)}`;

const VALID = {
  AI_CLOUD_API_KEY: `sk-${'a'.repeat(30)}`,
  OURA_TOKEN: 'a'.repeat(30),
};

function makeStore() {
  const rows = new Map();
  return {
    rows,
    list: vi.fn(async () => [...rows.values()]),
    upsert: vi.fn(async (row) => {
      rows.set(row.name, row);
    }),
    remove: vi.fn(async (name) => {
      rows.delete(name);
    }),
  };
}

const buildApp = () => {
  const app = express();
  app.use(express.json());
  registerSecretsRoutes(app);
  return app;
};

let store;
let env;
let logs;
beforeEach(() => {
  __resetSecretsForTests();
  store = makeStore();
  env = { SECRETS_ENCRYPTION_KEY: KEY, AI_CLOUD_API_KEY: ENV_SENTINEL };
  __configureSecretsForTests({ store, env });
  logs = [
    vi.spyOn(console, 'error').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'log').mockImplementation(() => {}),
  ];
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const allLogged = () => JSON.stringify(logs.map((l) => l.mock.calls));

describe('GET /api/secrets', () => {
  it('lists exactly the registry, never values or ciphertext, with no-store', async () => {
    const app = buildApp();
    const put = await request(app).put('/api/secrets/OURA_TOKEN').send({ value: STORED });
    expect(put.status).toBe(200);
    const stored = store.rows.get('OURA_TOKEN');

    const res = await request(app).get('/api/secrets');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.encryption).toEqual({ enabled: true });
    expect(res.body.writable).toBe(true);
    expect(res.body.writesAllowed).toBe(true);
    expect(res.body.secrets.map((s) => s.name)).toEqual(SECRET_DEFS.map((d) => d.name));

    for (const raw of [res.text, put.text]) {
      expect(raw).not.toContain(STORED);
      expect(raw).not.toContain(ENV_SENTINEL);
      expect(raw).not.toContain(stored.ciphertext);
      expect(raw).not.toContain(stored.iv);
      expect(raw).not.toContain(stored.auth_tag);
      expect(raw).not.toMatch(/ciphertext|auth_tag|"iv"/);
    }
    const oura = res.body.secrets.find((s) => s.name === 'OURA_TOKEN');
    expect(oura).toMatchObject({ source: 'settings', last4: STORED.slice(-4), configured: true });
    const cloud = res.body.secrets.find((s) => s.name === 'AI_CLOUD_API_KEY');
    expect(cloud).toMatchObject({ source: 'env', last4: ENV_SENTINEL.slice(-4) });
    for (const s of res.body.secrets) {
      expect(Object.keys(s).sort()).toEqual(
        ['configured', 'description', 'envFallback', 'label', 'last4', 'name', 'provider', 'source', 'stale', 'testable', 'updatedAt'].sort(),
      );
    }
  });

  it('reports encryption disabled when SECRETS_ENCRYPTION_KEY is missing, env statuses intact', async () => {
    delete env.SECRETS_ENCRYPTION_KEY;
    const res = await request(buildApp()).get('/api/secrets');
    expect(res.status).toBe(200);
    expect(res.body.encryption).toEqual({ enabled: false, reason: 'missing' });
    expect(res.body.writable).toBe(false);
    // The write guard is independent of encryption: writesAllowed stays true locally.
    expect(res.body.writesAllowed).toBe(true);
    expect(res.body.storage.reason).toBe('encryption_disabled');
    expect(res.body.secrets.find((s) => s.name === 'AI_CLOUD_API_KEY').source).toBe('env');
    expect(store.list).not.toHaveBeenCalled();
  });

  it('reports an invalid key as disabled', async () => {
    env.SECRETS_ENCRYPTION_KEY = 'tooshort';
    const res = await request(buildApp()).get('/api/secrets');
    expect(res.body.encryption).toEqual({ enabled: false, reason: 'invalid' });
  });

  it('always reports writesAllowed and shows last4 for env-sourced keys', async () => {
    const res = await request(buildApp()).get('/api/secrets');
    expect(res.status).toBe(200);
    expect(res.body.writesAllowed).toBe(true);
    expect(res.body.secrets.find((x) => x.name === 'AI_CLOUD_API_KEY').last4).toBe(ENV_SENTINEL.slice(-4));
  });

  it('answers an unexpected failure with a generic 500 that leaks no internals', async () => {
    const boom = new Error('db exploded https://x.example.test token=SENTINEL-INTERNAL');
    boom.code = 'XX000';
    boom.stack = 'STACK-SENTINEL at secrets.js';
    store.list.mockRejectedValue(boom);
    // A throwing store is handled by the primer, so make the status listing itself throw.
    const getters = await import('../secrets/getSecret.js');
    const spy = vi.spyOn(getters, 'listSecretStatuses').mockImplementation(() => {
      throw boom;
    });
    const res = await request(buildApp()).get('/api/secrets');
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Server error', code: 'server_error' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).not.toMatch(/SENTINEL|STACK|exploded/);
    expect(allLogged()).not.toMatch(/example.test|SENTINEL|STACK|exploded/);
    expect(console.error).toHaveBeenCalledWith('Secrets route error:', 'XX000');
  });
});

describe('allowlist', () => {
  it.each(['DATABASE_URL', 'APP_PASSWORD', 'groq_api_key', '__proto__', 'constructor'])(
    'rejects %s on PUT/DELETE/test with 404 and untouched store',
    async (name) => {
      const app = buildApp();
      const responses = [
        await request(app).put(`/api/secrets/${name}`).send({ value: VALID.OURA_TOKEN }),
        await request(app).delete(`/api/secrets/${name}`),
        await request(app).post(`/api/secrets/${name}/test`),
      ];
      for (const res of responses) {
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('unknown_secret');
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.text).not.toContain(name);
      }
      expect(store.upsert).not.toHaveBeenCalled();
      expect(store.remove).not.toHaveBeenCalled();
    },
  );
});

describe('PUT /api/secrets/:name validation', () => {
  it.each(Object.keys(VALID))('accepts a valid %s and encrypts it', async (name) => {
    const res = await request(buildApp()).put(`/api/secrets/${name}`).send({ value: ` ${VALID[name]} ` });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ name, source: 'settings', last4: VALID[name].slice(-4) });
    const row = store.rows.get(name);
    expect(Object.keys(row).sort()).toEqual(['auth_tag', 'ciphertext', 'iv', 'last4', 'name', 'updated_at']);
    expect(JSON.stringify(row)).not.toContain(VALID[name]);
    expect(peekSecret(name)).toBe(VALID[name]);
  });

  it.each(Object.keys(VALID))('rejects bad %s values without echoing them', async (name) => {
    const bad = [
      // OURA_TOKEN and AI_CLOUD_API_KEY have no required prefix, so a wrong-prefix value is only invalid elsewhere.
      ...(name === 'OURA_TOKEN' || name === 'AI_CLOUD_API_KEY' ? [] : ['zzz_wrongprefix_' + 'x'.repeat(30)]),
      'tooShrt',
      `${VALID[name]} extra`,
      `${VALID[name]}\nline`,
      VALID[name] + 'a'.repeat(5000),
    ];
    for (const value of bad) {
      const res = await request(buildApp()).put(`/api/secrets/${name}`).send({ value });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_value');
      expect(res.text).not.toContain(value);
      expect(allLogged()).not.toContain(value);
    }
    const nonString = await request(buildApp()).put(`/api/secrets/${name}`).send({ value: 12345 });
    expect(nonString.status).toBe(400);
    expect(nonString.body.code).toBe('invalid_body');
    const missing = await request(buildApp()).put(`/api/secrets/${name}`).send({});
    expect(missing.body.code).toBe('invalid_body');
    expect(store.upsert).not.toHaveBeenCalled();
  });

  it('takes effect immediately without waiting for the TTL', async () => {
    const app = buildApp();
    expect(peekSecret('OURA_TOKEN')).toBe('');
    await request(app).put('/api/secrets/OURA_TOKEN').send({ value: VALID.OURA_TOKEN });
    expect(peekSecret('OURA_TOKEN')).toBe(VALID.OURA_TOKEN);
  });

  it('maps a missing table to 503 schema_missing and other failures to a generic 500', async () => {
    store.upsert.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'schema_missing' }));
    const missing = await request(buildApp()).put('/api/secrets/OURA_TOKEN').send({ value: VALID.OURA_TOKEN });
    expect(missing.status).toBe(503);
    expect(missing.body.code).toBe('schema_missing');

    store.upsert.mockRejectedValueOnce(new Error(`leak ${VALID.OURA_TOKEN}`));
    const other = await request(buildApp()).put('/api/secrets/OURA_TOKEN').send({ value: VALID.OURA_TOKEN });
    expect(other.status).toBe(500);
    expect(other.body).toEqual({ error: 'Server error', code: 'server_error' });
    expect(allLogged()).not.toContain(VALID.OURA_TOKEN);
  });

  it('refuses with 503 storage_not_configured when there is no store', async () => {
    __configureSecretsForTests({ store: null, env });
    const res = await request(buildApp()).put('/api/secrets/OURA_TOKEN').send({ value: VALID.OURA_TOKEN });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('storage_not_configured');
  });
});

describe('missing encryption key', () => {
  it('refuses PUT and DELETE with a stable code and never writes', async () => {
    delete env.SECRETS_ENCRYPTION_KEY;
    const app = buildApp();
    const put = await request(app).put('/api/secrets/OURA_TOKEN').send({ value: VALID.OURA_TOKEN });
    const del = await request(app).delete('/api/secrets/OURA_TOKEN');
    for (const res of [put, del]) {
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('encryption_disabled');
    }
    expect(store.upsert).not.toHaveBeenCalled();
    expect(store.remove).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/secrets/:name', () => {
  it('removes the stored key, falls back to env, and is idempotent', async () => {
    const app = buildApp();
    await request(app).put('/api/secrets/AI_CLOUD_API_KEY').send({ value: VALID.AI_CLOUD_API_KEY });
    expect(peekSecret('AI_CLOUD_API_KEY')).toBe(VALID.AI_CLOUD_API_KEY);
    const res = await request(app).delete('/api/secrets/AI_CLOUD_API_KEY');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: 'env', envFallback: true });
    expect(peekSecret('AI_CLOUD_API_KEY')).toBe(ENV_SENTINEL);
    const again = await request(app).delete('/api/secrets/AI_CLOUD_API_KEY');
    expect(again.status).toBe(200);
    const none = await request(app).delete('/api/secrets/OURA_TOKEN');
    expect(none.body.source).toBe('none');
  });
});

describe('DELETE with an undecryptable row (rotated encryption key)', () => {
  it('still removes the row and reports the post-delete state', async () => {
    const old = encryptSecret(VALID.OURA_TOKEN, 'OURA_TOKEN', randomBytes(32));
    store.rows.set('OURA_TOKEN', {
      name: 'OURA_TOKEN',
      ciphertext: old.ciphertext,
      iv: old.iv,
      auth_tag: old.authTag,
      last4: 'aaaa',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    const app = buildApp();
    const before = await request(app).get('/api/secrets');
    expect(before.body.secrets.find((x) => x.name === 'OURA_TOKEN')).toMatchObject({ stale: true, source: 'none' });

    const res = await request(app).delete('/api/secrets/OURA_TOKEN');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'OURA_TOKEN', stale: false, source: 'none' });
    expect(store.remove).toHaveBeenCalledWith('OURA_TOKEN');
    expect(store.rows.has('OURA_TOKEN')).toBe(false);
  });
});

describe('writes', () => {
  it('allow PUT without any hosting-platform guard', async () => {
    const res = await request(buildApp()).put('/api/secrets/OURA_TOKEN').send({ value: VALID.OURA_TOKEN });
    expect(res.status).toBe(200);
  });
});

describe('token test network opt-in (oura)', () => {
  const OPT_IN = process.env.BURROW_NETWORK_OPTIN;
  afterEach(() => {
    if (OPT_IN === undefined) delete process.env.BURROW_NETWORK_OPTIN;
    else process.env.BURROW_NETWORK_OPTIN = OPT_IN;
    __resetNetPolicyForTests();
  });

  it('returns 403 network_opt_in_required and makes no request while oura is off', async () => {
    delete process.env.BURROW_NETWORK_OPTIN;
    __resetNetPolicyForTests();
    const fetchMock = vi.fn(async () => ({ status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(buildApp()).post('/api/secrets/OURA_TOKEN/test');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: 'network_opt_in_required',
      feature: 'oura',
      message: 'Oura Ring is turned off. Enable it in Settings → Network (this calls the internet).',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('token test gate comes from the registry def', () => {
  it('names the oura opt-in on the OURA_TOKEN def and refuses a testable def with no feature', () => {
    expect(SECRET_DEFS.find((d) => d.name === 'OURA_TOKEN').networkFeature).toBe('oura');
    for (const def of SECRET_DEFS.filter((d) => d.test)) expect(def.networkFeature).toBeTruthy();
  });
});

describe('POST /api/secrets/:name/test', () => {
  const stubFetch = (impl) => {
    const fn = vi.fn(impl);
    vi.stubGlobal('fetch', fn);
    return fn;
  };

  beforeEach(async () => {
    await request(buildApp()).put('/api/secrets/OURA_TOKEN').send({ value: VALID.OURA_TOKEN });
  });

  it('maps upstream statuses to ok/unauthorized/rate_limited/upstream_error', async () => {
    const app = buildApp();
    const cases = [
      [200, { ok: true }],
      [401, { ok: false, reason: 'unauthorized' }],
      [403, { ok: false, reason: 'unauthorized' }],
      [429, { ok: false, reason: 'rate_limited' }],
      [500, { ok: false, reason: 'upstream_error' }],
    ];
    for (const [status, expected] of cases) {
      const fetchMock = stubFetch(async () => ({ status, text: async () => 'UPSTREAM-BODY-SECRET' }));
      const res = await request(app).post('/api/secrets/OURA_TOKEN/test');
      expect(res.status).toBe(200);
      expect(res.body).toEqual(expected);
      expect(res.text).not.toContain('UPSTREAM-BODY-SECRET');
      expect(res.headers['cache-control']).toBe('no-store');
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.ouraring.com/v2/usercollection/personal_info');
      expect(init.headers.Authorization).toBe(`Bearer ${VALID.OURA_TOKEN}`);
    }
  });

  it('reports unreachable on network errors', async () => {
    stubFetch(async () => {
      throw new Error('AbortError');
    });
    const res = await request(buildApp()).post('/api/secrets/OURA_TOKEN/test');
    expect(res.body).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('reports not_configured when nothing resolves', async () => {
    const fetchMock = stubFetch(async () => ({ status: 200 }));
    await request(buildApp()).delete('/api/secrets/OURA_TOKEN');
    const res = await request(buildApp()).post('/api/secrets/OURA_TOKEN/test');
    expect(res.body).toEqual({ ok: false, reason: 'not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tests an env-sourced key with encryption disabled', async () => {
    delete env.SECRETS_ENCRYPTION_KEY;
    invalidateSecrets(); // drop the key saved by the beforeEach; encryption is now off
    const sentinel = `gsk_${'e'.repeat(30)}`;
    env.OURA_TOKEN = sentinel;
    const fetchMock = stubFetch(async () => ({ status: 200 }));
    const listing = await request(buildApp()).get('/api/secrets');
    expect(listing.body.writable).toBe(false);
    expect(listing.body.writesAllowed).toBe(true);
    const res = await request(buildApp()).post('/api/secrets/OURA_TOKEN/test');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${sentinel}`);
  });

  it('never follows redirects and releases the unread upstream body', async () => {
    const cancel = vi.fn(async () => {});
    const fetchMock = stubFetch(async () => ({ status: 200, body: { cancel } }));
    const res = await request(buildApp()).post('/api/secrets/OURA_TOKEN/test');
    expect(res.body).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0][1].redirect).toBe('error');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('reports a redirect (fetch error) as unreachable and survives a throwing cancel()', async () => {
    stubFetch(async () => {
      throw new TypeError('redirect mode is set to error');
    });
    expect((await request(buildApp()).post('/api/secrets/OURA_TOKEN/test')).body).toEqual({
      ok: false,
      reason: 'unreachable',
    });
    stubFetch(async () => ({
      status: 401,
      body: {
        cancel: async () => {
          throw new Error('locked');
        },
      },
    }));
    expect((await request(buildApp()).post('/api/secrets/OURA_TOKEN/test')).body).toEqual({
      ok: false,
      reason: 'unauthorized',
    });
  });

  it('rejects AI_CLOUD_API_KEY as not testable', async () => {
    const res = await request(buildApp()).post('/api/secrets/AI_CLOUD_API_KEY/test');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('not_testable');
  });

  it('testSecret aborts after the timeout and reports unreachable', async () => {
    const fetchImpl = (url, { signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const out = await testSecret('OURA_TOKEN', VALID.OURA_TOKEN, { fetchImpl, timeoutMs: 10 });
    expect(out).toEqual({ ok: false, reason: 'unreachable' });
  });
});
