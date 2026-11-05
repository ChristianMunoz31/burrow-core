// Input validation returns 400 before any backend work. The database is a real
// in-memory one so the data preflight passes and the handler's own validation runs;
// validation runs before any model call (a missing prompt 400s before the AI gate).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
// Pro is on for this file (the Pro gate itself is covered in proGating.test.js).
import request from 'supertest';
import { closeTestDb, createTestDb } from './helpers/testDb.js';

vi.mock('../../loadEnv.js', () => ({}));

let app;
let db;
// The shell may export SECRETS_ENCRYPTION_KEY; keep these tests independent of it.
const savedEncKey = process.env.SECRETS_ENCRYPTION_KEY;
afterAll(() => {
  closeTestDb(db);
  if (savedEncKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
  else process.env.SECRETS_ENCRYPTION_KEY = savedEncKey;
});

beforeAll(async () => {
  delete process.env.SECRETS_ENCRYPTION_KEY;
  delete process.env.APP_PASSWORD;
  delete process.env.AUTH_SECRET;
  process.env.GROQ_API_KEY = 'test-key-never-called';
  db = createTestDb();
  app = (await import('../../server.js')).default;
});

describe('input validation (400s)', () => {
  it('400 on POST /api/transactions with non-array records', async () => {
    const res = await request(app).post('/api/transactions').send({ records: 'nope' });
    expect(res.status).toBe(400);
  });

  it('400 on POST /api/todos without a title', async () => {
    const res = await request(app).post('/api/todos').send({ priority: 'high' });
    expect(res.status).toBe(400);
  });

  it('400 on GET /api/weather with invalid lat/lon', async () => {
    const res = await request(app).get('/api/weather?lat=abc&lon=xyz');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'invalid_location',
      code: 'invalid_location',
      message: 'Enter a latitude from -90 to 90 and a longitude from -180 to 180, with up to 4 decimals.',
    });
  });

  it('400 on POST /api/jarvis/conversations with a non-string title; a string title is accepted', async () => {
    for (const title of [42, {}, ['x'], true]) {
      const res = await request(app).post('/api/jarvis/conversations').send({ title });
      expect(res.status, JSON.stringify(title)).toBe(400);
    }
    const ok = await request(app).post('/api/jarvis/conversations').send({ title: 'Plans' });
    expect(ok.status).toBe(200);
    expect(ok.body.title).toBe('Plans');
  });
});
