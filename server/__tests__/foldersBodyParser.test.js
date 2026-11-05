// Body-parser errors on /api/folders answer the Folders error body with no-store; other routes keep the global
// invalid_body answer. Also: the dialog poll is exempt from the global rate limiter, like the job poll.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));

import { COPY, errorBody } from './helpers/foldersEnv.js';
import { closeTestDb, createTestDb } from './helpers/testDb.js';

const SAME_ORIGIN = Object.freeze({ Host: '127.0.0.1:4321', Origin: 'http://127.0.0.1:4321' });
const NO_FOLDER = '00000000-0000-4000-8000-000000000000';
const saved = Object.fromEntries(['APP_PASSWORD', 'AUTH_SECRET'].map((k) => [k, process.env[k]]));

let app;
let db;

const malformed = (method, url) => request(app)[method](url).set(SAME_ORIGIN).set('Content-Type', 'application/json').send('{"path":');

beforeAll(async () => {
  for (const k of Object.keys(saved)) delete process.env[k];
  db = createTestDb();
  app = (await import('../../server.js')).default;
});
afterAll(() => {
  closeTestDb(db);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('body-parser errors on /api/folders', () => {
  it.each([
    ['post', '/api/folders'],
    ['post', '/api/folders/pick'],
    ['post', `/api/folders/${NO_FOLDER}/confirm`],
    ['post', `/api/folders/${NO_FOLDER}/export`],
    ['patch', `/api/folders/${NO_FOLDER}`],
  ])('malformed JSON to %s %s answers 400 invalid_request with no-store', async (method, url) => {
    const res = await malformed(method, url);
    expect(res.status).toBe(400);
    expect(res.body).toEqual(errorBody('invalid_request'));
    expect(res.body).toEqual({ error: 'invalid_request', code: 'invalid_request', message: COPY.invalid_request[1] });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('an unsupported content encoding answers 415 unsupported_media_type', async () => {
    const res = await request(app)
      .post('/api/folders')
      .set(SAME_ORIGIN)
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'unheard-of')
      .send('{}');
    expect(res.status).toBe(415);
    expect(res.body).toEqual(errorBody('unsupported_media_type'));
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('never echoes the body that failed to parse', async () => {
    const res = await request(app)
      .post('/api/folders')
      .set(SAME_ORIGIN)
      .set('Content-Type', 'application/json')
      .send('{"path":"C:\\\\Users\\\\Example\\\\secret-place", oops');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('secret-place');
  });

  it('other routes keep the global invalid_body answer', async () => {
    const res = await request(app).put('/api/profile').set('Content-Type', 'application/json').send('{"displayName":');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid request body', code: 'invalid_body' });
  });
});

describe('rate limiting', () => {
  it('does not count the dialog poll against the global limiter (300 per 15 minutes)', async () => {
    let limited = 0;
    for (let i = 0; i < 320; i += 1) {
      const res = await request(app).get(`/api/folders/dialogs/${'a'.repeat(32)}`).set('X-Forwarded-For', '203.0.113.77');
      if (res.status === 429) limited += 1;
      else expect(res.status).toBe(404);
    }
    expect(limited).toBe(0);
  }, 60_000);
});
