// Auth-gate behavior. Env is set BEFORE importing the app because server.js
// reads APP_PASSWORD/AUTH_SECRET at module-evaluation time. loadEnv is mocked so
// a developer's real .env can't leak in and flip the gate mid-test.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));

let app;
// The shell may export SECRETS_ENCRYPTION_KEY; keep these tests independent of it.
const savedEncKey = process.env.SECRETS_ENCRYPTION_KEY;
afterAll(() => {
  if (savedEncKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
  else process.env.SECRETS_ENCRYPTION_KEY = savedEncKey;
});

beforeAll(async () => {
  delete process.env.SECRETS_ENCRYPTION_KEY;
  process.env.APP_PASSWORD = 'sekret-pass';
  process.env.AUTH_SECRET = 'unit-test-secret';
  delete process.env.GROQ_API_KEY;
  app = (await import('../../server.js')).default;
});

describe('auth gate', () => {
  it('reports enabled + unauthenticated via /api/auth/status without a cookie', async () => {
    const res = await request(app).get('/api/auth/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, authenticated: false });
  });

  it('rejects a wrong password with 401', async () => {
    const res = await request(app).post('/api/login').send({ password: 'nope' });
    expect(res.status).toBe(401);
  });

  it('issues an HttpOnly session cookie on the correct password', async () => {
    const res = await request(app).post('/api/login').send({ password: 'sekret-pass' });
    expect(res.status).toBe(200);
    const cookie = res.headers['set-cookie']?.[0] || '';
    expect(cookie).toMatch(/burrow_session=/);
    expect(cookie).toMatch(/HttpOnly/);
  });

  it('blocks a gated route without a valid cookie (401)', async () => {
    const res = await request(app).get('/api/transactions');
    expect(res.status).toBe(401);
  });

  it('blocks an unmatched /api path without a valid cookie (401), not a 404', async () => {
    const res = await request(app).get('/api/not-a-route');
    expect(res.status).toBe(401);
  });

  it('clears the auth gate once authenticated', async () => {
    const agent = request.agent(app);
    await agent.post('/api/login').send({ password: 'sekret-pass' });
    const res = await agent.get('/api/transactions');
    // The cookie cleared the gate: the route answers from the local database, not 401.
    expect(res.status).toBe(200);
  });

  it('clears the cookie on logout', async () => {
    const res = await request(app).post('/api/logout');
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']?.[0] || '').toMatch(/Max-Age=0/);
  });
});
