// End-to-end through server.js: the real auth gate, a real login cookie, and a seeded in-memory
// SQLite database. Env is set before each import because server.js reads it at
// module-evaluation time; modules are reset per app, so the database module is re-imported too.
import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import { unzipSync, strFromU8 } from 'fflate';

vi.mock('../../loadEnv.js', () => ({}));

const ENV_KEYS = ['APP_PASSWORD', 'AUTH_SECRET', 'GROQ_API_KEY', 'SECRETS_ENCRYPTION_KEY'];
const original = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
let openHandle = null;

async function loadApp({ auth = true, data = {} } = {}) {
  vi.resetModules();
  if (auth) {
    process.env.APP_PASSWORD = 'sekret-pass';
    process.env.AUTH_SECRET = 'unit-test-secret';
  } else {
    delete process.env.APP_PASSWORD;
    delete process.env.AUTH_SECRET;
  }
  delete process.env.GROQ_API_KEY;
  delete process.env.SECRETS_ENCRYPTION_KEY;
  const dbm = await import('../db/index.js');
  openHandle = dbm.openDb({ filename: ':memory:' });
  dbm.setDbForTests(openHandle);
  for (const [table, rows] of Object.entries(data)) dbm.insertMany(table, rows, { db: openHandle });
  return (await import('../../server.js')).default;
}

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
  if (openHandle) {
    (await import('../db/index.js')).setDbForTests(null);
    openHandle.close();
    openHandle = null;
  }
  vi.restoreAllMocks();
});

const binary = (r, cb) => {
  const chunks = [];
  r.on('data', (c) => chunks.push(c));
  r.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('POST /api/export with auth enabled', () => {
  it('401 without a session, 200 ZIP with a valid session cookie', async () => {
    const app = await loadApp({ data: { todos: [{ id: 't1', title: 'hello' }] } });

    const denied = await request(app).post('/api/export').set('X-Forwarded-For', '198.51.100.1');
    expect(denied.status).toBe(401);
    expect(denied.headers['cache-control']).toBe('no-store');
    expect(denied.body).toEqual({ error: 'Unauthorized' });

    const agent = request.agent(app);
    const login = await agent
      .post('/api/login')
      .set('X-Forwarded-For', '198.51.100.2')
      .send({ password: 'sekret-pass' });
    expect(login.status).toBe(200);
    const ok = await agent.post('/api/export').set('X-Forwarded-For', '198.51.100.2').buffer(true).parse(binary);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toMatch(/application\/zip/);
    expect(ok.headers['cache-control']).toBe('no-store');
    const files = unzipSync(new Uint8Array(ok.body));
    expect(JSON.parse(strFromU8(files['json/todos.json']))).toMatchObject([{ id: 't1', title: 'hello' }]);
  });

  it('rejects a tampered or garbage session cookie', async () => {
    const app = await loadApp();
    for (const cookie of ['burrow_session=garbage', 'burrow_session=123.deadbeef', 'burrow_session=']) {
      const res = await request(app).post('/api/export').set('Cookie', cookie).set('X-Forwarded-For', '198.51.100.3');
      expect(res.status).toBe(401);
    }
  });

  it('does not leak planted env or app_secrets values through the full stack', async () => {
    const app = await loadApp({
      data: {
        app_secrets: [
          { name: 'SENTINEL_E2E_SECRET_NAME', ciphertext: 'SENTINEL_E2E_SECRET_VALUE', iv: 'i', auth_tag: 't', last4: '1234' },
        ],
        app_state: [{ key: 'api_key', value: 'SENTINEL_E2E_STATE', updated_at: '2026-01-01T00:00:00.000Z' }],
      },
    });
    process.env.GROQ_API_KEY = 'SENTINEL_E2E_GROQ';
    const agent = request.agent(app);
    await agent.post('/api/login').set('X-Forwarded-For', '198.51.100.4').send({ password: 'sekret-pass' });
    const res = await agent.post('/api/export').set('X-Forwarded-For', '198.51.100.4').buffer(true).parse(binary);
    expect(res.status).toBe(200);
    for (const bytes of Object.values(unzipSync(new Uint8Array(res.body)))) {
      expect(strFromU8(bytes)).not.toMatch(/SENTINEL_E2E|sekret-pass|unit-test-secret/);
    }
  });
});

describe('POST /api/export without sign-in', () => {
  it('fails closed for a non-loopback client when the gate is off', async () => {
    const app = await loadApp({ auth: false, data: { todos: [{ id: 't1', title: 'x' }] } });
    const res = await request(app).post('/api/export').set('X-Forwarded-For', '198.51.100.7');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Export requires sign-in to be enabled.', code: 'auth_required' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('still exports from loopback when the gate is off', async () => {
    const app = await loadApp({ auth: false, data: { todos: [{ id: 't1', title: 'x' }] } });
    const res = await request(app).post('/api/export');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/zip/);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="burrow-export-/);
  });

  it('401s like other gated routes when sign-in is enabled and there is no session', async () => {
    const app = await loadApp();
    const gated = await request(app).get('/api/transactions').set('X-Forwarded-For', '198.51.100.6');
    const res = await request(app).post('/api/export').set('X-Forwarded-For', '198.51.100.6');
    expect(gated.status).toBe(401);
    expect(res.status).toBe(401);
  });
});
