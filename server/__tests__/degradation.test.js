// Graceful degradation. With Ollama not running (or AI turned off) the AI routes 503; a fresh local
// database answers data routes normally; a database that cannot be used 503s with a
// fixed message instead of crashing. loadEnv is mocked so .env can't supply keys.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
// Pro is on for this file (the Pro gate itself is covered in proGating.test.js).
vi.mock('../license/index.js', async (importOriginal) => (await import('./helpers/pro.js')).mockLicenseModule(importOriginal));
import request from 'supertest';
import { closeTestDb, createTestDb } from './helpers/testDb.js';

vi.mock('../../loadEnv.js', () => ({}));
// No Ollama: every local AI request is refused at the socket.
vi.mock('node-fetch', () => ({
  default: vi.fn(async () => {
    throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' });
  }),
}));

let app;
let db;
// The shell may export SECRETS_ENCRYPTION_KEY; keep these tests independent of it.
const savedEncKey = process.env.SECRETS_ENCRYPTION_KEY;
afterAll(() => {
  if (db) closeTestDb(db);
  if (savedEncKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
  else process.env.SECRETS_ENCRYPTION_KEY = savedEncKey;
});

beforeAll(async () => {
  delete process.env.SECRETS_ENCRYPTION_KEY;
  delete process.env.APP_PASSWORD;
  delete process.env.AUTH_SECRET;
  db = createTestDb();
  app = (await import('../../server.js')).default;
});

describe('graceful degradation', () => {
  it('answers a data route with 200 [] on a fresh database', async () => {
    const res = await request(app).get('/api/transactions');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('503s data routes with a fixed message when the database handle is closed', async () => {
    const broken = createTestDb();
    broken.close();
    try {
      const res = await request(app).get('/api/todos');
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'Local database is unavailable.' });
    } finally {
      closeTestDb(db);
      db = createTestDb();
    }
  });
});
