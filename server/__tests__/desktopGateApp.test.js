// Desktop gate through the REAL server.js app: method/path edge cases, host guard order, web-mode regression.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));

const SECRET = Buffer.alloc(32, 9);
const ENV_KEYS = ['BURROW_DESKTOP', 'APP_PASSWORD', 'AUTH_SECRET', 'SECRETS_ENCRYPTION_KEY', 'BURROW_DIST_DIR'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('desktop gate on the real app', () => {
  let app;
  let auth;
  let cookie;
  beforeAll(async () => {
    vi.resetModules();
    delete process.env.SECRETS_ENCRYPTION_KEY;
    delete process.env.BURROW_DIST_DIR;
    process.env.BURROW_DESKTOP = '1';
    process.env.APP_PASSWORD = 'sekret-pass';
    process.env.AUTH_SECRET = 'unit-test-secret-unit-test-secret-1234';
    app = (await import('../../server.js')).default;
    auth = await import('../desktop/auth.js');
    auth.initDesktopAuth(SECRET);
    cookie = `burrow_desktop=${auth.cookieValue()}`;
  });

  it('401s HEAD and OPTIONS without the cookie, and an OPTIONS preflight gets no CORS grant', async () => {
    expect((await request(app).head('/api/transactions')).status).toBe(401);
    expect((await request(app).head('/')).status).toBe(401);
    const pre = await request(app)
      .options('/api/transactions')
      .set('Origin', 'http://127.0.0.1:5000')
      .set('Access-Control-Request-Method', 'GET');
    expect([401, 403]).toContain(pre.status);
    expect(pre.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('401s percent-encoded and re-cased API paths without the cookie', async () => {
    for (const p of ['/%61pi/transactions', '/API/transactions', '/api%2Ftransactions', '/api/../api/transactions', '//api/transactions']) {
      const res = await request(app).get(p);
      expect(res.status, p).toBe(401);
      expect(res.body?.data, p).toBeUndefined();
    }
  });

  it('does not treat look-alike bootstrap paths as the bootstrap, so the token is not burned', async () => {
    const token = auth.bootstrapToken();
    for (const p of ['/desktop/%62ootstrap', '/Desktop/bootstrap', '/desktop/bootstrap/']) {
      const res = await request(app).get(p).query({ token });
      expect(res.status, p).toBe(401);
      expect(res.headers['set-cookie'], p).toBeUndefined();
    }
    const post = await request(app).post('/desktop/bootstrap').query({ token });
    expect(post.status).toBe(401);
    expect(post.headers['set-cookie']).toBeUndefined();
    const real = await request(app).get('/desktop/bootstrap').query({ token });
    expect(real.status).toBe(302);
  });

  it('with the cookie, HEAD works and /api/login does not demand APP_PASSWORD', async () => {
    expect((await request(app).head('/api/auth/status').set('Cookie', cookie)).status).toBe(200);
    const login = await request(app).post('/api/login').set('Cookie', cookie).send({ password: 'sekret-pass' });
    expect(login.status).not.toBe(401);
  });

  it('a valid cookie never bypasses the host guard (421 first, even for the bootstrap path)', async () => {
    for (const p of ['/api/transactions', '/', '/desktop/bootstrap']) {
      const res = await request(app).get(p).set('Cookie', cookie).set('Host', 'evil.example.com');
      expect(res.status, p).toBe(421);
    }
  });

  it('rejects a cookie with a wrong length, wrong name or empty value', async () => {
    for (const c of [`${cookie}x`, `burrow_desktop=${auth.cookieValue().slice(1)}`, `x_${cookie}`, 'burrow_desktop=']) {
      expect((await request(app).get('/api/transactions').set('Cookie', c)).status, c).toBe(401);
    }
  });

  it('accepts the cookie among others', async () => {
    const res = await request(app).get('/api/transactions').set('Cookie', `a=1; ${cookie}; b=2`);
    expect(res.status).toBe(200);
  });
});

describe('web mode regression (BURROW_DESKTOP unset)', () => {
  let app;
  beforeAll(async () => {
    vi.resetModules();
    delete process.env.BURROW_DESKTOP;
    delete process.env.APP_PASSWORD;
    delete process.env.SECRETS_ENCRYPTION_KEY;
    delete process.env.BURROW_DIST_DIR;
    app = (await import('../../server.js')).default;
  });

  it('sends no CSP or hardening headers on API or bootstrap path', async () => {
    for (const p of ['/api/auth/status', '/desktop/bootstrap']) {
      const res = await request(app).get(p);
      expect(res.headers['content-security-policy'] ?? '', p).not.toContain('frame-ancestors');
      expect(res.headers['x-frame-options'], p).toBeUndefined();
    }
  });

  it('/desktop/bootstrap is not a cookie setter or redirect, even with a plausible token', async () => {
    const res = await request(app).get('/desktop/bootstrap').query({ token: 'a'.repeat(64) });
    expect([200, 404]).toContain(res.status);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers.location).toBeUndefined();
  });

  it('without APP_PASSWORD the API is open and auth status says disabled', async () => {
    const res = await request(app).get('/api/auth/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false, authenticated: true });
    expect((await request(app).get('/api/transactions')).status).toBe(200);
  });
});
