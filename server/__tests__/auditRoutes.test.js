// GET /api/audit sits behind the login gate. Env is set before importing the app
// because server.js reads APP_PASSWORD/AUTH_SECRET at module-evaluation time.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { closeTestDb, createTestDb } from './helpers/testDb.js';

vi.mock('../../loadEnv.js', () => ({}));

let app;
let db;
const savedEnv = {
  SECRETS_ENCRYPTION_KEY: process.env.SECRETS_ENCRYPTION_KEY,
  APP_PASSWORD: process.env.APP_PASSWORD,
  AUTH_SECRET: process.env.AUTH_SECRET,
};

afterAll(() => {
  closeTestDb(db);
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeAll(async () => {
  db = createTestDb();
  delete process.env.SECRETS_ENCRYPTION_KEY;
  process.env.APP_PASSWORD = 'sekret-pass';
  process.env.AUTH_SECRET = 'unit-test-secret';
  app = (await import('../../server.js')).default;
});

async function loginCookie(ip) {
  const res = await request(app).post('/api/login').set('X-Forwarded-For', ip).send({ password: 'sekret-pass' });
  expect(res.status).toBe(200);
  return res.headers['set-cookie'][0].split(';')[0];
}

describe('GET /api/audit', () => {
  it('returns 401 without a session cookie', async () => {
    const res = await request(app).get('/api/audit').set('X-Forwarded-For', '198.51.100.1');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it.each(['/API/AUDIT', '/api/audit/', '/Api/Audit'])('returns 401 for path variant %s', async (path) => {
    const res = await request(app).get(path).set('X-Forwarded-For', '198.51.100.2');
    expect(res.status).toBe(401);
  });

  it('returns available:true (200, no-store) with the sign_in rows written by login', async () => {
    const cookie = await loginCookie('198.51.100.3');
    const res = await request(app).get('/api/audit').set('Cookie', cookie).set('X-Forwarded-For', '198.51.100.3');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data.available).toBe(true);
    expect(res.body.data.nextBefore).toBeNull();
    expect(res.body.data.entries.length).toBeGreaterThan(0);
    expect(res.body.data.entries[0]).toMatchObject({ kind: 'auth', feature: 'sign_in', status: 'ok' });
  });

  it.each(['limit=0', 'limit=101', 'limit=abc', 'limit=1.5', 'before=not-a-date', 'limit=1&limit=2'])(
    'returns 400 invalid_query for %s',
    async (qs) => {
      const cookie = await loginCookie('198.51.100.4');
      const res = await request(app).get(`/api/audit?${qs}`).set('Cookie', cookie).set('X-Forwarded-For', '198.51.100.4');
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid query', code: 'invalid_query' });
    },
  );

  it('accepts a valid limit and ISO before cursor', async () => {
    const cookie = await loginCookie('198.51.100.5');
    const before = encodeURIComponent('2026-01-01T00:00:00.123456+00:00');
    const res = await request(app)
      .get(`/api/audit?limit=100&before=${before}`)
      .set('Cookie', cookie)
      .set('X-Forwarded-For', '198.51.100.5');
    expect(res.status).toBe(200);
  });
});
