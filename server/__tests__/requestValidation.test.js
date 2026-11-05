// Through the real server.js: /api/search accepts only a string q (400 invalid_query otherwise),
// and a malformed percent-escape in a route param answers 400 invalid_request, not 500.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));

let app;
let n = 0;
const get = (path) => request(app).get(path).set('X-Forwarded-For', `198.51.100.${(n += 1)}`);
const saved = { APP_PASSWORD: process.env.APP_PASSWORD, AUTH_SECRET: process.env.AUTH_SECRET };

beforeAll(async () => {
  delete process.env.APP_PASSWORD;
  delete process.env.AUTH_SECRET;
  app = (await import('../../server.js')).default;
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('GET /api/search q validation', () => {
  it.each([
    ['q[toString]=x', '/api/search?q[toString]=x'],
    ['q[a]=b', '/api/search?q[a]=b'],
    ['q=a&q=b', '/api/search?q=a&q=b'],
    ['q[]=a', '/api/search?q[]=a'],
  ])('answers 400 invalid_query for %s', async (_label, url) => {
    const res = await get(url);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_query');
    expect(typeof res.body.message).toBe('string');
  });

  it('still answers 200 for a string q and for a missing q', async () => {
    expect((await get('/api/search?q=milk')).status).toBe(200);
    const none = await get('/api/search');
    expect(none.status).toBe(200);
    expect(none.body).toEqual({ query: '', results: [] });
  });
});

describe('malformed percent-escapes in route params', () => {
  it('answers 400 invalid_request, not 500', async () => {
    const res = await request(app).delete('/api/todos/%E0%A4%A').set('X-Forwarded-For', `198.51.100.${(n += 1)}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(JSON.stringify(res.body)).not.toMatch(/URIError|decode/i);
  });
});
