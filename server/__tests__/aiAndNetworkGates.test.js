// Through the real server.js: with AI turned off (BURROW_AI=0) every AI route answers the shared
// ai_not_configured contract before streaming and without any outbound call; with Ollama down
// it answers 503 ollama_unavailable as JSON (never an event stream). Every third-party feature
// route answers network_opt_in_required. Also: no cron route, gate order.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// Pro is on for this file (the Pro gate itself is covered in proGating.test.js).
vi.mock('../license/index.js', async (importOriginal) => (await import('./helpers/pro.js')).mockLicenseModule(importOriginal));
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })) }));

import fetch from 'node-fetch';

const AI_BODY = { error: 'ai_not_configured', reason: 'ai_disabled', message: 'AI is turned off.' };
const KEYS = [
  'BURROW_AI',
  'OLLAMA_HOST',
  'AI_CLOUD_API_KEY',
  'APP_PASSWORD',
  'AUTH_SECRET',
  'SECRETS_ENCRYPTION_KEY',
  'BURROW_NETWORK_OPTIN',
];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

let app;
let n = 0;
const ip = () => `198.51.100.${(n += 1)}`;
const post = (path, body) => request(app).post(path).set('X-Forwarded-For', ip()).send(body);
const get = (path) => request(app).get(path).set('X-Forwarded-For', ip());

beforeAll(async () => {
  for (const k of KEYS) delete process.env[k];
  app = (await import('../../server.js')).default;
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
beforeEach(async () => {
  fetch.mockClear();
  vi.stubGlobal('fetch', vi.fn());
  (await import('../ai/index.js')).__resetAiForTests();
});

const messages = [{ role: 'user', content: 'hi' }];
const AI_ROUTES = [
  ['/api/jarvis/advice', { page: 'todos', context: '{}', messages }],
];
describe('AI routes with AI turned off (BURROW_AI=0)', () => {
  beforeEach(() => {
    process.env.BURROW_AI = '0';
  });
  afterEach(() => {
    delete process.env.BURROW_AI;
  });

  it.each(AI_ROUTES)('POST %s answers 503 ai_not_configured as JSON and calls nothing', async (path, body) => {
    const res = await post(path, body);
    expect(res.status).toBe(503);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual(AI_BODY);
    expect(fetch).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('keeps the status endpoints honest about availability', async () => {
    for (const path of ['/api/jarvis/status']) {
      expect((await get(path)).body).toMatchObject({
        available: false,
        provider: 'ollama',
        model: null,
        code: 'ai_not_configured',
        reason: 'ai_disabled',
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('AI routes with Ollama not running', () => {
  beforeEach(() => {
    fetch.mockImplementation(async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' });
    });
  });
  afterEach(() => {
    fetch.mockReset();
    fetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  });

  it.each(AI_ROUTES)('POST %s answers 503 ollama_unavailable as JSON, not a stream', async (path, body) => {
    const res = await post(path, body);
    expect(res.status).toBe(503);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['content-type']).not.toMatch(/event-stream/);
    expect(res.body.error).toBe('ollama_unavailable');
    expect(res.body.reason).toBe('ollama_unavailable');
    expect(res.body.message).toMatch(/can't reach Ollama at http:\/\/127\.0\.0\.1:11434/);
    for (const [url] of fetch.mock.calls) expect(String(url)).toMatch(/^http:\/\/127\.0\.0\.1:11434\/api\//);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('reports reason ollama_unavailable on the status endpoints', async () => {
    const res = await get('/api/jarvis/status');
    expect(res.body).toMatchObject({ available: false, code: 'ollama_unavailable', reason: 'ollama_unavailable' });
  });
});

describe('third-party feature routes while opted out', () => {
  it.each([
    ['/api/weather?lat=1&lon=2', 'weather', 'Weather'],
    ['/api/oura', 'oura', 'Oura Ring'],
  ])('GET %s is 403 network_opt_in_required and makes no request', async (path, feature, label) => {
    const res = await get(path);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: 'network_opt_in_required',
      feature,
      message: `${label} is turned off. Enable it in Settings → Network (this calls the internet).`,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('pre-enabling through BURROW_NETWORK_OPTIN opens the route', async () => {
    process.env.BURROW_NETWORK_OPTIN = 'weather';
    try {
      const res = await get('/api/weather?lat=1&lon=2');
      expect(res.status).toBe(200);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.BURROW_NETWORK_OPTIN;
    }
  });
});

describe('removed hosting routes', () => {
  it('has no cron briefing endpoint', async () => {
    expect((await get('/api/cron/briefing')).status).toBe(404);
  });

  it('answers unmatched API paths with a JSON 404, not the app shell', async () => {
    const res = await get('/api/not-a-route');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: 'not_found' });
    expect((await get('/api/github/repos')).body).toEqual({ error: 'not_found' });
    expect((await get('/api/ui-builder/status')).body).toEqual({ error: 'not_found' });
  });
});
