// CORS allowlist + standard rate-limit headers — cross-cutting middleware.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));

let app;
// The shell may export SECRETS_ENCRYPTION_KEY; keep these tests independent of it.
const savedEncKey = process.env.SECRETS_ENCRYPTION_KEY;
const savedHosts = process.env.BURROW_ALLOWED_HOSTS;
afterAll(() => {
  if (savedHosts === undefined) delete process.env.BURROW_ALLOWED_HOSTS;
  else process.env.BURROW_ALLOWED_HOSTS = savedHosts;
  if (savedEncKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
  else process.env.SECRETS_ENCRYPTION_KEY = savedEncKey;
});

beforeAll(async () => {
  delete process.env.SECRETS_ENCRYPTION_KEY;
  delete process.env.APP_PASSWORD;
  delete process.env.AUTH_SECRET;
  delete process.env.ALLOWED_ORIGINS; // fall back to the loopback defaults
  process.env.BURROW_ALLOWED_HOSTS = '192.168.1.20';
  app = (await import('../../server.js')).default;
});

describe('CORS allowlist', () => {
  it('rejects a disallowed Origin with 403', async () => {
    const res = await request(app).get('/api/auth/status').set('Origin', 'https://evil.example.com');
    expect(res.status).toBe(403);
  });

  it.each([
    'http://localhost:5174',
    'http://127.0.0.1:5174',
    'http://localhost:4321',
    'http://127.0.0.1:4321',
  ])('allows the default loopback Origin %s', async (origin) => {
    const res = await request(app).get('/api/auth/status').set('Origin', origin);
    expect(res.status).toBe(200);
  });

  it('does not allow any hosted origin by default (no hosted app domains)', async () => {
    for (const origin of ['https://burrow.example.com', 'https://app.example.net', 'http://localhost:3001']) {
      const res = await request(app).get('/api/auth/status').set('Origin', origin);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Origin not allowed' });
    }
  });

  it('421s a Host that is not allowlisted, even with a matching Origin', async () => {
    const host = '192.168.1.99:4321';
    const res = await request(app).get('/api/auth/status').set('Host', host).set('Origin', `http://${host}`);
    expect(res.status).toBe(421);
  });

  it('allows a same-origin request from a host added via BURROW_ALLOWED_HOSTS (e.g. a LAN address)', async () => {
    const host = '192.168.1.20:4321';
    const res = await request(app)
      .get('/api/auth/status')
      .set('Host', host)
      .set('Origin', `http://${host}`);
    expect(res.status).toBe(200);
  });

  it('rejects an Origin whose host differs from the request host', async () => {
    const res = await request(app)
      .get('/api/auth/status')
      .set('Host', '127.0.0.1:4321')
      .set('Origin', 'http://127.0.0.1:4321.evil.example.com');
    expect(res.status).toBe(403);
  });
});

describe('rate-limit headers', () => {
  it('emits standard RateLimit headers on /api routes', async () => {
    const res = await request(app).get('/api/auth/status');
    const h = res.headers;
    const present = 'ratelimit' in h || 'ratelimit-limit' in h || 'ratelimit-policy' in h;
    expect(present).toBe(true);
  });
});
