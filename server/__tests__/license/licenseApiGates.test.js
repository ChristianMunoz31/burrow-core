// /api/license sits behind the auth gate (APP_PASSWORD) and the desktop gate.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../../loadEnv.js', () => ({}));

const ENV_KEYS = ['BURROW_DESKTOP', 'APP_PASSWORD', 'AUTH_SECRET', 'SECRETS_ENCRYPTION_KEY', 'BURROW_DIST_DIR'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const calls = [
  ['get', null],
  ['post', { licenseKey: 'x' }, '/activate'],
  ['post', { licenseKey: 'x' }, '/deactivate'],
  ['delete', null],
  ['post', null, '/trial'],
];

describe('auth gate (APP_PASSWORD + AUTH_SECRET)', () => {
  let app;
  beforeAll(async () => {
    vi.resetModules();
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.APP_PASSWORD = 'sekret-pass';
    process.env.AUTH_SECRET = 'unit-test-secret-unit-test-secret-1234';
    app = (await import('../../../server.js')).default;
  });

  it.each(calls)('401s %s without a session, with no-store', async (method, body, sub = '') => {
    const req = request(app)[method](`/api/license${sub}`);
    const res = await (body ? req.send(body) : req);
    expect(res.status).toBe(401);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.state).toBeUndefined();
  });

  it('answers once signed in', async () => {
    const agent = request.agent(app);
    await agent.post('/api/login').send({ password: 'sekret-pass' });
    const res = await agent.get('/api/license');
    expect(res.status).toBe(200);
    expect(res.body.state).toBeTypeOf('string');
    expect(res.headers['cache-control']).toBe('no-store');
    expect((await agent.post('/api/license/activate').send({ licenseKey: 5 })).status).toBe(400);
  });
});

describe('desktop gate', () => {
  const SECRET = Buffer.alloc(32, 9);
  let app;
  let cookie;
  beforeAll(async () => {
    vi.resetModules();
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.BURROW_DESKTOP = '1';
    app = (await import('../../../server.js')).default;
    const auth = await import('../../desktop/auth.js');
    auth.initDesktopAuth(SECRET);
    cookie = `burrow_desktop=${auth.cookieValue()}`;
  });

  it.each(calls)('401s %s without the desktop cookie', async (method, body, sub = '') => {
    const req = request(app)[method](`/api/license${sub}`);
    const res = await (body ? req.send(body) : req);
    expect(res.status).toBe(401);
    expect(res.body.state).toBeUndefined();
  });

  it('answers with the cookie', async () => {
    const res = await request(app).get('/api/license').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.state).toBeTypeOf('string');
  });
});
