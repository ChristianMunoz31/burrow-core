// Audit instrumentation through the real server.js: every LLM route, login, and
// GET /api/audit. Local AI runs on a fake Ollama behind a mocked node-fetch (the
// Javi and advisor internals are mocked); the audit sink is either a spy (to
// assert the event) or the real logAudit over a real SQLite database (to assert the stored row).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// Pro is on for this file (the Pro gate itself is covered in proGating.test.js).
vi.mock('../license/index.js', async (importOriginal) => (await import('./helpers/pro.js')).mockLicenseModule(importOriginal));
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));
vi.mock('../javi/advisorService.js', () => ({ generateAdvice: vi.fn(), streamAdvice: vi.fn() }));

import fetch from 'node-fetch';
import { installFakeOllama } from './helpers/fakeOllama.js';
import { __resetAiForTests } from '../ai/index.js';
import { generateAdvice } from '../javi/advisorService.js';
import { logAudit, resetAuditState } from '../audit.js';
import { setAuditSink } from '../auditHook.js';
import { closeTestDb, createTestDb, resetDb, rowsOf, seedDb } from './helpers/testDb.js';

const LOGIN_PW = 'login-pw-SENTINEL-4471';
const CHAT = 'qwen2.5:3b';
const ENV_KEYS = ['BURROW_AI'];
const meta = (calls) => ({ calls, ms: expect.any(Number), ai_kind: 'local' });
const savedEnv = {
  ...Object.fromEntries(
    ['SECRETS_ENCRYPTION_KEY', 'APP_PASSWORD', 'AUTH_SECRET', ...ENV_KEYS].map((k) => [k, process.env[k]]),
  ),
};

let app;
let cookie;
let ipCounter = 0;
const nextIp = () => `203.0.113.${(ipCounter += 1)}`;
const restoreEnv = () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};

let db;
let sink;
const inserted = () => rowsOf(db, 'audit_log');
// Makes every audit write fail the way a missing table would, then restores it.
const withAuditTableOff = async (fn) => {
  db.exec('ALTER TABLE audit_log RENAME TO audit_log_off');
  try {
    return await fn();
  } finally {
    db.exec('ALTER TABLE audit_log_off RENAME TO audit_log');
  }
};

const parseText = (res, cb) => {
  let d = '';
  res.on('data', (c) => (d += c));
  res.on('end', () => {
    if (/json/.test(res.headers['content-type'] || '')) {
      try {
        return cb(null, JSON.parse(d));
      } catch (err) {
        return cb(err);
      }
    }
    return cb(null, d);
  });
};
const send = (method, path, body, ip = nextIp()) => {
  const r = request(app)[method](path).set('X-Forwarded-For', ip).set('Cookie', cookie).buffer(true).parse(parseText);
  return body === undefined ? r : r.send(body);
};
const post = (path, body, ip) => send('post', path, body, ip);
const get = (path, ip) => send('get', path, undefined, ip);

beforeAll(async () => {
  delete process.env.SECRETS_ENCRYPTION_KEY;
  process.env.APP_PASSWORD = LOGIN_PW;
  process.env.AUTH_SECRET = 'audit-integration-secret';
  db = createTestDb();
  app = (await import('../../server.js')).default;
  const login = await request(app).post('/api/login').set('X-Forwarded-For', '198.51.100.250').send({ password: LOGIN_PW });
  expect(login.status).toBe(200);
  cookie = login.headers['set-cookie'][0].split(';')[0];
});
afterAll(() => {
  restoreEnv();
  closeTestDb(db);
});

beforeEach(() => {
  resetAuditState();
  resetDb(db);
  sink = vi.fn();
  setAuditSink(sink);
  generateAdvice.mockReset();
  for (const k of ENV_KEYS) delete process.env[k];
  __resetAiForTests();
  fetch.mockReset();
  installFakeOllama(fetch);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  setAuditSink(logAudit);
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) delete process.env[k];
});

// ---- route table ------------------------------------------------------------
// Each entry: arrange() primes mocks; request() fires it; check(res) asserts the NORMAL
// response; event is the single audit event expected on success.
const ADVICE_BODY = {
  page: 'todos',
  context: '{"open":3}',
  messages: [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'an answer' },
    { role: 'user', content: 'last question' },
  ],
};
const ROUTES = {
  javi_advice: {
    arrange: () => {
      generateAdvice.mockResolvedValue({ content: '- Do it', model: CHAT, provider: 'ollama' });
    },
    request: (ip) => post('/api/jarvis/advice', ADVICE_BODY, ip),
    check: (res) => {
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: { content: '- Do it', model: CHAT, provider: 'ollama' } });
    },
    event: {
      kind: 'llm',
      feature: 'javi_advice',
      page: 'todos',
      provider: 'ollama',
      model: CHAT,
      status: 'ok',
      context: { context: '{"open":3}', question: 'last question' },
      meta: meta(0),
    },
  },
};

describe('instrumentation: each route records exactly one event', () => {
  it.each(Object.keys(ROUTES))('%s', async (name) => {
    const r = ROUTES[name];
    r.arrange();
    const res = await r.request();
    r.check(res);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0]).toEqual(r.event);
  });

  it('javi advice failure records status error with the client provider/model and the page', async () => {
    generateAdvice.mockRejectedValue(Object.assign(new Error('x'), { httpStatus: 429, code: 'provider_rate_limited', publicMessage: 'Slow down' }));
    const res = await post('/api/jarvis/advice', ADVICE_BODY);
    expect(res.status).toBe(429);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0]).toMatchObject({ feature: 'javi_advice', page: 'todos', provider: 'ollama', model: CHAT, status: 'error' });
  });

});

describe('graceful: normal responses survive any sink failure', () => {
  const MODES = {
    'rejecting sink': () => setAuditSink(() => Promise.reject(new Error('sink rejected'))),
    'synchronously throwing sink': () =>
      setAuditSink(() => {
        throw new Error('sink threw');
      }),
  };

  describe.each(Object.entries(MODES))('%s', (_label, install) => {
    it.each(Object.keys(ROUTES))('%s still answers normally', async (name) => {
      const r = ROUTES[name];
      r.arrange();
      install();
      r.check(await r.request());
    });

    it('login still answers normally (401 and 200)', async () => {
      install();
      const bad = await request(app).post('/api/login').set('X-Forwarded-For', nextIp()).send({ password: 'nope' });
      expect(bad.status).toBe(401);
      expect(bad.body).toEqual({ error: 'Invalid password' });
      const good = await request(app).post('/api/login').set('X-Forwarded-For', nextIp()).send({ password: LOGIN_PW });
      expect(good.status).toBe(200);
      expect(good.body).toEqual({ ok: true });
      expect(good.headers['set-cookie'][0]).toMatch(/^burrow_session=|HttpOnly/);
    });
  });

  it('with the audit table missing every route answers normally', async () => {
    setAuditSink(logAudit);
    await withAuditTableOff(async () => {
      for (const n of Object.keys(ROUTES)) {
        ROUTES[n].arrange();
        ROUTES[n].check(await ROUTES[n].request());
      }
    });
  });

  it('a sink that stores nothing never affects the response', async () => {
    setAuditSink(() => false);
    const r = ROUTES.javi_advice;
    r.arrange();
    r.check(await r.request());
  });
});

describe('end to end: stored rows are redacted', () => {
  const SENT_GROQ = 'gsk_E2ESENTINEL0123456789abcdefghij';
  const SENT_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiZTJlIn0.E2ESENTINELsig0123456789';

  beforeEach(() => setAuditSink(logAudit));

  it('javi advice: a key pasted into the question or context never reaches the row', async () => {
    generateAdvice.mockResolvedValue({ content: 'ok', model: CHAT, provider: 'ollama' });
    await post('/api/jarvis/advice', {
      page: 'todos',
      context: JSON.stringify({ note: `token ${SENT_JWT}`, apiKey: 'plain-api-key-zzz' }),
      messages: [{ role: 'user', content: `my key is ${SENT_GROQ} email me@example.com` }],
    });
    expect(inserted()).toHaveLength(1);
    const row = JSON.stringify(inserted()[0]);
    expect(row).not.toContain(SENT_GROQ);
    expect(row).not.toContain('E2ESENTINEL');
    expect(row).not.toContain('plain-api-key-zzz');
    expect(row).not.toContain('me@example.com');
    expect(inserted()[0]).toMatchObject({ kind: 'llm', feature: 'javi_advice', page: 'todos', provider: 'ollama', model: CHAT, status: 'ok' });
  });

  it('login failure row has no password, cookie, header or ip', async () => {
    const attempt = 'wrong-pw-SENTINEL-9983';
    await request(app).post('/api/login').set('X-Forwarded-For', '203.0.113.201').set('Cookie', 'burrow_session=cookie-sentinel-1').set('User-Agent', 'UA-SENTINEL').send({ password: attempt });
    await request(app).post('/api/login').set('X-Forwarded-For', '203.0.113.202').send({ password: LOGIN_PW });
    expect(inserted()).toHaveLength(2);
    const stored = JSON.stringify(inserted());
    for (const leak of [attempt, LOGIN_PW, 'cookie-sentinel-1', 'UA-SENTINEL', '203.0.113.201', '203.0.113.202']) {
      expect(stored).not.toContain(leak);
    }
    expect(inserted().map((r) => [r.kind, r.feature, r.status, r.context])).toEqual([
      ['auth', 'sign_in', 'error', null],
      ['auth', 'sign_in', 'ok', null],
    ]);
  });

  it('the stored row for each route only carries allow-listed columns', async () => {
    ROUTES.javi_advice.arrange();
    await ROUTES.javi_advice.request();
    expect(Object.keys(inserted()[0]).sort()).toEqual(
      ['context', 'created_at', 'feature', 'id', 'kind', 'meta', 'model', 'page', 'provider', 'status'],
    );
  });
});

describe('login instrumentation', () => {
  it('records one sign_in event per attempt, with status and nothing else sensitive', async () => {
    const bad = await request(app).post('/api/login').set('X-Forwarded-For', nextIp()).send({ password: 'definitely-wrong-8812' });
    expect(bad.status).toBe(401);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0]).toEqual({ kind: 'auth', feature: 'sign_in', status: 'error' });
    expect(JSON.stringify(sink.mock.calls)).not.toContain('definitely-wrong-8812');

    sink.mockClear();
    const good = await request(app).post('/api/login').set('X-Forwarded-For', nextIp()).send({ password: LOGIN_PW });
    expect(good.status).toBe(200);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0]).toEqual({ kind: 'auth', feature: 'sign_in', status: 'ok' });
    expect(JSON.stringify(sink.mock.calls)).not.toContain(LOGIN_PW);
  });

  it.each([undefined, 123, null, ['x'], {}])('a non-string password (%j) is a failed attempt, not a crash', async (pw) => {
    const res = await request(app).post('/api/login').set('X-Forwarded-For', nextIp()).send({ password: pw });
    expect(res.status).toBe(401);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0].status).toBe('error');
  });
});

const uid = (n) => `00000000-0000-4000-8000-00000000000${n}`;

describe('GET /api/audit with a backing table', () => {
  const row = (n, ts) => ({
    id: uid(n),
    created_at: ts,
    kind: 'llm',
    feature: 'jarvis',
    page: null,
    provider: 'ollama',
    model: 'm',
    status: 'ok',
    context: `ctx ${n}`,
    meta: {},
  });
  const TS = [
    '2026-05-05T10:00:00.500Z',
    '2026-05-04T10:00:00.400Z',
    '2026-05-03T10:00:00.300Z',
    '2026-05-02T10:00:00.200Z',
    '2026-05-01T10:00:00.100Z',
  ];

  beforeEach(() => {
    seedDb(db, { audit_log: TS.map((t, i) => row(i + 1, t)) });
  });

  it('requires auth: no cookie is a 401', async () => {
    const res = await request(app).get('/api/audit').set('X-Forwarded-For', nextIp());
    expect(res.status).toBe(401);
  });

  it('rejects a forged or expired session cookie', async () => {
    const res = await request(app).get('/api/audit').set('X-Forwarded-For', nextIp()).set('Cookie', 'burrow_session=123.bogus');
    expect(res.status).toBe(401);
  });

  it('returns the { data } envelope, newest first, no-store, default limit 50', async () => {
    const res = await get('/api/audit');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data.available).toBe(true);
    expect(res.body.data.entries.map((e) => e.id)).toEqual([1, 2, 3, 4, 5].map(uid));
    expect(res.body.data.nextBefore).toBeNull();
    expect(res.body.data.entries[0]).toEqual({
      id: uid(1),
      createdAt: TS[0],
      kind: 'llm',
      feature: 'jarvis',
      page: null,
      provider: 'ollama',
      model: 'm',
      status: 'ok',
      context: 'ctx 1',
      meta: {},
    });
  });

  it.each([
    ['1', 1],
    ['3', 3],
    ['100', 5],
    ['07', 5],
  ])('limit=%s returns %i entries', async (qs, expected) => {
    const res = await get(`/api/audit?limit=${qs}`);
    expect(res.status).toBe(200);
    expect(res.body.data.entries).toHaveLength(expected);
  });

  it.each(['0', '101', '-1', '1000', 'abc', '1.5', '', ' 5', '1e2'])('limit=%j is rejected 400 invalid_query (never clamped silently)', async (value) => {
    const res = await get(`/api/audit?limit=${encodeURIComponent(value)}`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid query', code: 'invalid_query' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('rejects array-valued and bracket params', async () => {
    expect((await get('/api/audit?limit=1&limit=2')).status).toBe(400);
    expect((await get('/api/audit?before=2026-01-01&before=2026-01-02')).status).toBe(400);
    expect((await get('/api/audit?limit[]=5')).status).toBe(400);
  });

  it.each(['garbage', '2026-13-45', 'x'.repeat(65)])('before=%j is rejected', async (value) => {
    const res = await get(`/api/audit?before=${encodeURIComponent(value)}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_query');
  });

  // `before` must be strict ISO-8601 (a Date.parse check alone lets "1" or "foo 1" through).
  it.each([
    '%00',
    'foo 1',
    '1',
    'Jan 1 2026',
    '2026-01-01',
    '2026-02-30T00:00:00Z',
    '2026-05-04T10:00:00Z|not-a-uuid',
    '2026-05-04T10:00:00Z|00000000-0000-4000-8000-000000000001|x',
    '2026-05-04T10:00:00.1234567Z',
  ])('before=%j (not ISO 8601) should be rejected 400', async (value) => {
    const res = await get(`/api/audit?before=${encodeURIComponent(value)}`);
    expect(res.status).toBe(400);
  });

  it('paginates with the before cursor, with no gaps or duplicates', async () => {
    const seen = [];
    let before;
    for (let page = 0; page < 5; page += 1) {
      const qs = new URLSearchParams({ limit: '2' });
      if (before) qs.set('before', before);
      const res = await get(`/api/audit?${qs}`);
      expect(res.status).toBe(200);
      seen.push(...res.body.data.entries.map((e) => e.id));
      before = res.body.data.nextBefore;
      if (!before) break;
      const last = res.body.data.entries.at(-1);
      expect(before).toBe(`${last.createdAt}|${last.id}`);
    }
    expect(seen).toEqual([1, 2, 3, 4, 5].map(uid));
    expect(before).toBeNull();
  });

  it('accepts a "+00:00" microsecond timestamp cursor and normalizes it', async () => {
    const res = await get(`/api/audit?limit=2&before=${encodeURIComponent('2026-05-04T10:00:00.400000+00:00')}`);
    expect(res.status).toBe(200);
    expect(res.body.data.entries.map((e) => e.id)).toEqual([3, 4].map(uid));
  });

  it('accepts a composite cursor with "+00:00" and excludes the cursor row itself', async () => {
    const res = await get(`/api/audit?before=${encodeURIComponent(`2026-05-04T10:00:00.400000+00:00|${uid(2)}`)}`);
    expect(res.status).toBe(200);
    expect(res.body.data.entries.map((e) => e.id)).toEqual([3, 4, 5].map(uid));
  });

  it('paginates rows that share one created_at without gaps or duplicates', async () => {
    resetDb(db);
    const same = '2026-05-06T10:00:00.000Z';
    seedDb(db, { audit_log: [row(1, same), row(2, same), row(3, same), row(4, same), row(5, same)] });
    const seen = [];
    let before;
    for (let page = 0; page < 6; page += 1) {
      const qs = new URLSearchParams({ limit: '2' });
      if (before) qs.set('before', before);
      const res = await get(`/api/audit?${qs}`);
      expect(res.status).toBe(200);
      seen.push(...res.body.data.entries.map((e) => e.id));
      before = res.body.data.nextBefore;
      if (!before) break;
    }
    expect(seen).toEqual([5, 4, 3, 2, 1].map(uid));
  });

  it('a full page sets nextBefore; a short page does not', async () => {
    const full = await get('/api/audit?limit=5');
    expect(full.body.data.nextBefore).toBe(`${TS[4]}|${uid(5)}`);
    const short = await get('/api/audit?limit=6');
    expect(short.body.data.nextBefore).toBeNull();
  });

  it('answers 500 server_error on a database error and logs only the code', async () => {
    await withAuditTableOff(async () => {
      const res = await get('/api/audit');
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Server error', code: 'server_error' });
      expect(res.headers['cache-control']).toBe('no-store');
      expect(JSON.stringify(console.error.mock.calls)).not.toContain('audit_log');
    });
  });

  it('only exposes GET', async () => {
    const res = await post('/api/audit', {});
    expect(res.status).toBe(404);
  });
});
