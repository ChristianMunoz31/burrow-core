// /api/secrets through the real server.js: strict limiter on writes only, no-store on
// limiter errors, and the final error handler never logging request bodies.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { randomBytes } from 'node:crypto';

vi.mock('../../loadEnv.js', () => ({}));

import { __configureSecretsForTests, __resetSecretsForTests } from '../secrets/getSecret.js';

const SENTINEL = `gsk_SENTINELbody${'9'.repeat(20)}`;
const VALID = `gsk_${'a'.repeat(30)}`;

let app;
let logs;
// The shell may export SECRETS_ENCRYPTION_KEY; keep these tests independent of it.
const savedEncKey = process.env.SECRETS_ENCRYPTION_KEY;
afterAll(() => {
  if (savedEncKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
  else process.env.SECRETS_ENCRYPTION_KEY = savedEncKey;
});

beforeAll(async () => {
  delete process.env.SECRETS_ENCRYPTION_KEY;
  delete process.env.APP_PASSWORD;
  delete process.env.AUTH_SECRET;
  app = (await import('../../server.js')).default;
});

beforeEach(() => {
  __resetSecretsForTests();
  const rows = new Map();
  __configureSecretsForTests({
    env: { SECRETS_ENCRYPTION_KEY: randomBytes(32).toString('base64') },
    store: {
      list: async () => [...rows.values()],
      upsert: async (row) => {
        rows.set(row.name, row);
      },
      remove: async (name) => {
        rows.delete(name);
      },
    },
  });
  logs = [
    vi.spyOn(console, 'error').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  vi.restoreAllMocks();
});

const logged = () => JSON.stringify(logs.map((l) => l.mock.calls));

describe('final error handler', () => {
  it('answers malformed JSON with 400 invalid_body and never logs the raw body', async () => {
    const res = await request(app)
      .put('/api/secrets/OURA_TOKEN')
      .set('Content-Type', 'application/json')
      .send(`{"value": "${SENTINEL}`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid request body', code: 'invalid_body' });
    expect(res.text).not.toContain(SENTINEL);
    expect(logged()).not.toContain(SENTINEL);
  });

  it('answers an oversized body with 413 invalid_body and never logs it', async () => {
    const res = await request(app)
      .put('/api/secrets/OURA_TOKEN')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ value: SENTINEL + 'x'.repeat(3 * 1024 * 1024) }));
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'Invalid request body', code: 'invalid_body' });
    expect(res.text).not.toContain(SENTINEL);
    expect(logged()).not.toContain(SENTINEL);
  });

  it('answers an unsupported charset with 415 invalid_body', async () => {
    const res = await request(app)
      .put('/api/secrets/OURA_TOKEN')
      .set('Content-Type', 'application/json; charset=iso-8859-1')
      .send('{"value":"x"}');
    expect(res.status).toBe(415);
    expect(res.body).toEqual({ error: 'Invalid request body', code: 'invalid_body' });
  });
});

describe('limiters', () => {
  it('caps secrets writes at 20 per window with no-store and rate_limited on the 429, while GET stays open', async () => {
    for (let i = 0; i < 20; i += 1) {
      const ok = await request(app).put('/api/secrets/OURA_TOKEN').send({ value: VALID });
      expect(ok.status).toBe(200);
    }
    const limited = await request(app).put('/api/secrets/OURA_TOKEN').send({ value: VALID });
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: 'Too many requests, please try again later.', code: 'rate_limited' });
    expect(limited.headers['cache-control']).toBe('no-store');
    const get = await request(app).get('/api/secrets');
    expect(get.status).toBe(200);
    expect(get.headers['cache-control']).toBe('no-store');
    expect(get.body.secrets).toHaveLength(2);
    // The secrets budget is separate: AI endpoints (strictLimiter) from the same client still work.
    const explain = await request(app).post('/api/jarvis/advice').send({});
    expect(explain.status).not.toBe(429);
  });

  it('exhausting strictLimiter on an AI endpoint does not 429 secrets writes', async () => {
    const ip = '203.0.113.7';
    let last;
    for (let i = 0; i < 21; i += 1) {
      last = await request(app).post('/api/jarvis/advice').set('X-Forwarded-For', ip).send({});
    }
    expect(last.status).toBe(429);
    expect(last.body.code).toBe('rate_limited');
    const put = await request(app)
      .put('/api/secrets/OURA_TOKEN')
      .set('X-Forwarded-For', ip)
      .send({ value: VALID });
    expect(put.status).toBe(200);
  });
});
