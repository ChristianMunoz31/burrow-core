// Session cookie + auth gate hardening for a local install: no hosted-preview auth skip,
// the cookie is Secure only when the request is HTTPS, and proxy headers are ignored
// unless BURROW_TRUST_PROXY=1. server.js reads env at import time, so each scenario
// resets the module registry, sets env, then imports the app. loadEnv is mocked so a
// developer's real .env can't leak in.
import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));

const ENV_KEYS = ['APP_PASSWORD', 'AUTH_SECRET', 'VERCEL_ENV', 'VERCEL', 'BURROW_TRUST_PROXY', 'SECRETS_ENCRYPTION_KEY'];
const original = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

async function loadApp({ trustProxy, extra = {} } = {}) {
  vi.resetModules();
  process.env.APP_PASSWORD = 'sekret-pass';
  process.env.AUTH_SECRET = 'unit-test-secret';
  delete process.env.SECRETS_ENCRYPTION_KEY;
  delete process.env.VERCEL_ENV;
  delete process.env.VERCEL;
  if (trustProxy === undefined) delete process.env.BURROW_TRUST_PROXY;
  else process.env.BURROW_TRUST_PROXY = trustProxy;
  Object.assign(process.env, extra);
  return (await import('../../server.js')).default;
}

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
});

const login = (app, headers = {}) => {
  const r = request(app).post('/api/login').send({ password: 'sekret-pass' });
  for (const [k, v] of Object.entries(headers)) r.set(k, v);
  return r;
};

describe('no hosted-preview auth skip', () => {
  it.each([['preview'], ['production'], [undefined]])('still requires login when VERCEL_ENV is %s', async (value) => {
    const app = await loadApp({ trustProxy: '1', extra: value ? { VERCEL_ENV: value } : {} });
    const status = await request(app).get('/api/auth/status');
    expect(status.body).toMatchObject({ enabled: true, authenticated: false });
    expect((await request(app).get('/api/transactions')).status).toBe(401);
  });

  it('has no cron endpoint exempt from the gate', async () => {
    const app = await loadApp({ trustProxy: '1' });
    const res = await request(app).get('/api/cron/briefing');
    expect(res.status).toBe(401);
  });
});

describe('session cookie', () => {
  it('is named burrow_session and is not Secure over plain HTTP', async () => {
    const app = await loadApp({ trustProxy: '1' });
    const res = await login(app);
    expect(res.status).toBe(200);
    const cookie = res.headers['set-cookie'][0];
    expect(cookie).toMatch(/^burrow_session=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).not.toMatch(/Secure/);
  });

  it('is Secure when the request is HTTPS (trusted X-Forwarded-Proto)', async () => {
    const app = await loadApp({ trustProxy: '1' });
    const res = await login(app, { 'X-Forwarded-Proto': 'https' });
    expect(res.headers['set-cookie'][0]).toMatch(/; Secure/);
    const out = await request(app).post('/api/logout').set('X-Forwarded-Proto', 'https');
    expect(out.headers['set-cookie'][0]).toMatch(/; Secure/);
  });

  it('ignores X-Forwarded-Proto unless BURROW_TRUST_PROXY=1', async () => {
    const app = await loadApp({});
    const res = await login(app, { 'X-Forwarded-Proto': 'https' });
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie'][0]).not.toMatch(/Secure/);
  });
});
