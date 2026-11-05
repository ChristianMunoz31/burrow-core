// The session gate must treat /api paths case-insensitively, because Express routing is
// case-insensitive: /API/data/tables and PUT /Api/secrets/X reach the same handlers as
// their lowercase forms and must not bypass the login gate.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));

let app;
// The shell may export SECRETS_ENCRYPTION_KEY; keep these tests independent of it.
const savedEncKey = process.env.SECRETS_ENCRYPTION_KEY;
afterAll(() => {
  if (savedEncKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
  else process.env.SECRETS_ENCRYPTION_KEY = savedEncKey;
});

beforeAll(async () => {
  delete process.env.SECRETS_ENCRYPTION_KEY;
  process.env.APP_PASSWORD = 'sekret-pass';
  process.env.AUTH_SECRET = 'unit-test-secret';
  app = (await import('../../server.js')).default;
});

describe('auth gate is case-insensitive', () => {
  it.each(['/API/data/tables', '/Api/data/tables/journal', '/api/DATA/tables', '/API/secrets', '/API/transactions'])(
    'GET %s without a cookie is 401',
    async (path) => {
      const res = await request(app).get(path);
      expect(res.status).toBe(401);
    },
  );

  it('PUT /Api/secrets/X without a cookie is 401', async () => {
    const res = await request(app).put('/Api/secrets/GROQ_API_KEY').send({ value: `gsk_${'a'.repeat(30)}` });
    expect(res.status).toBe(401);
  });

  it('keeps public auth paths reachable in any case', async () => {
    const res = await request(app).get('/API/auth/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, authenticated: false });
  });

  it('does not spend the secrets-write budget on unauthenticated PUTs', async () => {
    for (let i = 0; i < 25; i += 1) {
      const res = await request(app)
        .put('/api/secrets/GROQ_API_KEY')
        .set('X-Forwarded-For', '203.0.113.99')
        .send({ value: `gsk_${'a'.repeat(30)}` });
      expect(res.status).toBe(401);
      expect(res.headers['cache-control']).toBe('no-store');
    }
    const agent = request.agent(app);
    await agent.post('/api/login').set('X-Forwarded-For', '203.0.113.99').send({ password: 'sekret-pass' });
    const authed = await agent
      .put('/api/secrets/GROQ_API_KEY')
      .set('X-Forwarded-For', '203.0.113.99')
      .send({ value: `gsk_${'a'.repeat(30)}` });
    expect(authed.status).not.toBe(429);
    expect(authed.status).not.toBe(401);
  });

  it('lets an authenticated session through on a mixed-case path', async () => {
    const agent = request.agent(app);
    await agent.post('/api/login').send({ password: 'sekret-pass' });
    const res = await agent.get('/API/data/tables');
    expect(res.status).not.toBe(401);
  });
});
