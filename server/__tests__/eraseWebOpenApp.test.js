// Erase through the REAL server.js app in web mode WITHOUT a sign-in password: loopback clients only,
// and the same origin protection. Env is set before the app imports.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { cleanupBackupEnv } from './helpers/backupEnv.js';
import { SAME_ORIGIN, freshDb, rowCounts, seedEverything } from './helpers/eraseEnv.js';

vi.mock('../../loadEnv.js', () => ({}));

const ENV_KEYS = ['BURROW_DESKTOP', 'APP_PASSWORD', 'AUTH_SECRET', 'SECRETS_ENCRYPTION_KEY', 'BURROW_DIST_DIR'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

let app;
beforeAll(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  app = (await import('../../server.js')).default;
});

beforeEach(() => {
  freshDb();
});
afterEach(() => {
  cleanupBackupEnv();
});

describe('web mode without a password (open, loopback only)', () => {
  it('erases from a loopback client with token and phrase, no password asked', async () => {
    const { db } = seedEverything();
    const requested = await request(app).post('/api/data/erase/request').set(SAME_ORIGIN).send({});
    expect(requested.status).toBe(200);
    const res = await request(app).post('/api/data/erase').set(SAME_ORIGIN).send({ token: requested.body.data.token, phrase: 'ERASE' });
    expect(res.status).toBe(200);
    expect(rowCounts(db).notes).toBe(0);
  });

  it('refuses a client that is not on loopback (403 auth_required) and a foreign Origin', async () => {
    const { db } = seedEverything();
    const remote = await request(app).post('/api/data/erase/request').set(SAME_ORIGIN).set('X-Forwarded-For', '203.0.113.50').send({});
    expect(remote.status).toBe(403);
    expect(remote.body.code).toBe('auth_required');
    const foreign = await request(app).post('/api/data/erase/request').set('Origin', 'https://evil.example.com').send({});
    expect(foreign.status).toBe(403);
    expect(rowCounts(db).notes).toBe(1);
  });

  it('answers 405 to GET', async () => {
    const res = await request(app).get('/api/data/erase');
    expect(res.status).toBe(405);
  });
});
