// Gated routes that proxy third-party data must not be cacheable by shared caches: a CDN
// holding `public, s-maxage` could serve them to unauthenticated clients and would keep
// serving data fetched with a since-replaced key.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('../integrations.js', () => ({
  ymd: () => '2026-01-01',
  fetchWeather: async () => ({ temp: 1 }),
  fetchOura: async () => ({ ok: true, source: 'oura' }),
}));
vi.mock('node-fetch', () => ({
  default: vi.fn(async () => ({ ok: true, status: 200, json: async () => [] })),
}));

let app;
const saved = {
  SECRETS_ENCRYPTION_KEY: process.env.SECRETS_ENCRYPTION_KEY,
  APP_PASSWORD: process.env.APP_PASSWORD,
  AUTH_SECRET: process.env.AUTH_SECRET,
};
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeAll(async () => {
  delete process.env.SECRETS_ENCRYPTION_KEY;
  delete process.env.APP_PASSWORD;
  delete process.env.AUTH_SECRET;
  app = (await import('../../server.js')).default;
});

describe('cache headers on gated third-party routes', () => {
  it.each([['/api/oura', 1800]])('%s is private, never shared-cacheable', async (path, seconds) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe(`private, max-age=${seconds}`);
    expect(res.headers['cache-control']).not.toMatch(/public|s-maxage/);
  });

  // The forecast URL carries no coordinates: a browser cache could answer for a location that was since changed,
  // cleared, erased or restored, so the forecast is never stored by the browser (React Query keeps it 30 minutes).
  it('/api/weather is no-store', async () => {
    const res = await request(app).get('/api/weather?lat=1&lon=2');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
