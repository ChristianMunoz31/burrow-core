// POST /api/export sits behind the login gate. Env is set before importing the app
// because server.js reads APP_PASSWORD/AUTH_SECRET at module-evaluation time.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));

let app;
const savedEnv = {
  SECRETS_ENCRYPTION_KEY: process.env.SECRETS_ENCRYPTION_KEY,
  APP_PASSWORD: process.env.APP_PASSWORD,
  AUTH_SECRET: process.env.AUTH_SECRET,
};

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeAll(async () => {
  delete process.env.SECRETS_ENCRYPTION_KEY;
  process.env.APP_PASSWORD = 'sekret-pass';
  process.env.AUTH_SECRET = 'unit-test-secret';
  app = (await import('../../server.js')).default;
});

describe('POST /api/export auth gate', () => {
  it('returns 401 without a session cookie', async () => {
    const res = await request(app).post('/api/export').set('X-Forwarded-For', '192.0.2.50');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it.each(['/API/EXPORT', '/api/export/', '/Api/Export'])('returns 401 for path variant %s', async (path) => {
    const res = await request(app).post(path).set('X-Forwarded-For', '192.0.2.51');
    expect(res.status).toBe(401);
  });
});
