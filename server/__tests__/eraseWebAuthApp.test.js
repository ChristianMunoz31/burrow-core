// Erase through the REAL server.js app in web mode with a sign-in password: the auth gate, password
// re-entry, the CORS and origin protections, the rate limit and token expiry. Env is set before the app imports.
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
  delete process.env.BURROW_DESKTOP;
  delete process.env.SECRETS_ENCRYPTION_KEY;
  delete process.env.BURROW_DIST_DIR;
  process.env.APP_PASSWORD = 'sekret-pass';
  process.env.AUTH_SECRET = 'unit-test-secret-unit-test-secret-1234';
  app = (await import('../../server.js')).default;
});

let n = 0;
const nextIp = () => `198.51.100.${(n += 1)}`;
const body = (token, extra = {}) => ({ token, phrase: 'ERASE', ...extra });

beforeEach(() => {
  freshDb();
});
afterEach(() => {
  cleanupBackupEnv();
});

async function signedIn() {
  const agent = request.agent(app);
  const login = await agent.post('/api/login').set('X-Forwarded-For', nextIp()).send({ password: 'sekret-pass' });
  expect(login.status).toBe(200);
  return agent;
}

describe('web mode with a sign-in password', () => {
  it('rejects both routes without a session (the auth gate answers 401 before anything else)', async () => {
    seedEverything();
    const before = rowCounts();
    for (const path of ['/api/data/erase/request', '/api/data/erase']) {
      const res = await request(app).post(path).set(SAME_ORIGIN).set('X-Forwarded-For', nextIp()).send(body('x'));
      expect(res.status, path).toBe(401);
    }
    expect((await request(app).get('/api/data/erase').set('X-Forwarded-For', nextIp())).status).toBe(401);
    expect(rowCounts()).toEqual(before);
  });

  it('erases only with a token, the phrase and the password re-entered', async () => {
    const agent = await signedIn();
    const { db } = seedEverything();
    const ip = nextIp();
    const requested = await agent.post('/api/data/erase/request').set(SAME_ORIGIN).set('X-Forwarded-For', ip).send({});
    expect(requested.status).toBe(200);
    const { token } = requested.body.data;

    const wrong = await agent.post('/api/data/erase').set(SAME_ORIGIN).set('X-Forwarded-For', ip).send(body(token, { password: 'wrong' }));
    expect(wrong.body.error).toBe('erase_password_invalid');
    expect(rowCounts(db).notes).toBe(1);

    const done = await agent.post('/api/data/erase').set(SAME_ORIGIN).set('X-Forwarded-For', ip).send(body(token, { password: 'sekret-pass' }));
    expect(done.status).toBe(200);
    expect(done.headers['cache-control']).toBe('no-store');
    expect(done.body.data.erased).toBe(true);
    expect(rowCounts(db).notes).toBe(0);
    expect(rowCounts(db).journal).toBe(0);

    const replay = await agent.post('/api/data/erase').set(SAME_ORIGIN).set('X-Forwarded-For', ip).send(body(token, { password: 'sekret-pass' }));
    expect(replay.status).toBe(409);
    expect(replay.body.error).toBe('erase_token_used');
  });

  it('a foreign Origin is refused by the erase guard: no token issued, nothing erased', async () => {
    const agent = await signedIn();
    const { db } = seedEverything();
    for (const path of ['/api/data/erase/request', '/api/data/erase']) {
      const res = await agent
        .post(path)
        .set('X-Forwarded-For', nextIp())
        .set('Origin', 'https://evil.example.com')
        .send(body('x', { password: 'sekret-pass' }));
      expect(res.status, path).toBe(403);
      expect(res.body.error).toBe('erase_origin_blocked');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    }
    expect(rowCounts(db).notes).toBe(1);
  });

  it('a cross-site form post (not JSON) cannot start an erase', async () => {
    const agent = await signedIn();
    const res = await agent.post('/api/data/erase/request').set(SAME_ORIGIN).set('X-Forwarded-For', nextIp()).type('form').send('a=1');
    expect(res.status).toBe(415);
  });

  it('answers 405, never 404 or data, to GET on both paths', async () => {
    const agent = await signedIn();
    for (const path of ['/api/data/erase', '/api/data/erase/request']) {
      const res = await agent.get(path).set('X-Forwarded-For', nextIp());
      expect(res.status, path).toBe(405);
      expect(res.headers.allow).toBe('POST');
    }
  });

  it('allows 3 erase attempts per 15 minutes, then 429 with what to do', async () => {
    const agent = await signedIn();
    seedEverything();
    const ip = nextIp();
    const { token } = (await agent.post('/api/data/erase/request').set(SAME_ORIGIN).set('X-Forwarded-For', ip).send({})).body.data;
    for (let i = 0; i < 3; i += 1) {
      const res = await agent.post('/api/data/erase').set(SAME_ORIGIN).set('X-Forwarded-For', ip).send(body(token, { password: 'wrong' }));
      expect(res.status).toBe(401);
    }
    const limited = await agent.post('/api/data/erase').set(SAME_ORIGIN).set('X-Forwarded-For', ip).send(body(token, { password: 'sekret-pass' }));
    expect(limited.status).toBe(429);
    expect(limited.body.message).toMatch(/Wait 15 minutes/);
    expect(limited.headers['cache-control']).toBe('no-store');
  });

  it('expires a token after 2 minutes on the real clock', async () => {
    const agent = await signedIn();
    seedEverything();
    const ip = nextIp();
    const { token } = (await agent.post('/api/data/erase/request').set(SAME_ORIGIN).set('X-Forwarded-For', ip).send({})).body.data;
    const realNow = performance.now();
    vi.spyOn(globalThis.performance, 'now').mockReturnValue(realNow + 121_000);
    try {
      const res = await agent.post('/api/data/erase').set(SAME_ORIGIN).set('X-Forwarded-For', ip).send(body(token, { password: 'sekret-pass' }));
      expect(res.status).toBe(410);
      expect(res.body.error).toBe('erase_token_expired');
    } finally {
      vi.restoreAllMocks();
    }
  });
});
