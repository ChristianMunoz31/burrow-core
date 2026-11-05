// Redaction, meta filtering, size cap, dropped-table tolerance and prune behavior of
// server/audit.js, tested through its public API against a real SQLite DB.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDbForTests } from '../db/index.js';
import { closeTestDb, createTestDb, resetDb, rowsOf, seedDb } from './helpers/testDb.js';

vi.mock('../../loadEnv.js', () => ({}));

import {
  AUDIT_CONTEXT_MAX_CHARS,
  logAudit,
  normalizeAuditEvent,
  pruneAudit,
  redactAuditContext,
  resetAuditState,
} from '../audit.js';

let db;
const rows = () => rowsOf(db, 'audit_log');

beforeAll(() => {
  db = createTestDb();
});
beforeEach(() => {
  resetDb(db);
  resetAuditState();
});
afterAll(() => closeTestDb(db));

const GOOD = { kind: 'llm', feature: 'insights', provider: 'groq', model: 'openai/gpt-oss-120b' };

describe('redactAuditContext: secret shapes', () => {
  const LEAKS = {
    groq: 'gsk_FAKEtestKEYnotREAL0000000000',
    openai: 'sk-proj-abcdefghijklmnopqrstuvwx1234',
    aws: 'AKIAIOSFODNN7EXAMPLE',
    bearer: 'Bearer abc123.def456.ghi789',
    jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJlLXZhbHVl',
    serviceJwt:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJ0ZXN0LWlzc3VlciIsInJlZiI6ImFiY2RlZiIsInJvbGUiOiJzZXJ2aWNlX3JvbGUifQ.abcDEF123_-xyz',
    generic: 'q8W3e7R1t5Y9u2I6o0P4a8S3d7F1g5H9j2K6l0Z4',
    email: 'someone.private@example.com',
    urlCreds: 'https://admin:s3cretPass@db.internal.example.com/path',
  };

  it.each(Object.entries(LEAKS))('removes the %s shape from free text', (_name, secret) => {
    const out = redactAuditContext(`prefix text ${secret} suffix`);
    expect(out).not.toContain(secret);
    expect(out).not.toContain(secret.slice(0, 20));
  });

  it.each(Object.entries(LEAKS))('removes the %s shape nested under harmless keys', (_name, secret) => {
    const out = redactAuditContext({ note: secret, list: [{ line: `x ${secret}` }], deep: { a: { b: secret } } });
    expect(out).not.toContain(secret);
    expect(out).not.toContain(secret.slice(0, 20));
  });

  it.each(Object.entries(LEAKS))('removes the %s shape inside a JSON string', (_name, secret) => {
    const out = redactAuditContext(JSON.stringify({ message: secret }));
    expect(out).not.toContain(secret);
  });

  it('replaces emails with [email] and keeps surrounding text', () => {
    const out = redactAuditContext('mail a.b+tag@sub.example.co.uk and c@d.io please');
    expect(out).toBe('mail [email] and [email] please');
  });

  it('keeps ordinary prose intact', () => {
    expect(redactAuditContext('How much did I spend on groceries in May?')).toBe(
      'How much did I spend on groceries in May?',
    );
  });

  it.each([
    'password',
    'Password',
    'passwd',
    'pwd',
    'apiKey',
    'api_key',
    'x-api-key',
    'accessKeyId',
    'authorization',
    'Authorization',
    'cookie',
    'Set-Cookie',
    'sessionId',
    'access_token',
    'clientSecret',
    'privateKey',
  ])('redacts the value under sensitive key %s', (key) => {
    const out = redactAuditContext({ [key]: 'plain-value-zzz', safe: 'visible' });
    expect(out).not.toContain('plain-value-zzz');
    expect(out).toContain('visible');
  });

  it('redacts auth headers and cookies inside a request-shaped object', () => {
    const out = redactAuditContext({
      headers: { Authorization: 'Basic dXNlcjpwYXNz', Cookie: 'burrow_session=abc123; other=1', Accept: 'json' },
    });
    expect(out).not.toContain('dXNlcjpwYXNz');
    expect(out).not.toContain('abc123');
    expect(out).toContain('json');
  });

  it('redacts name/value pairs labelled with a sensitive name', () => {
    const out = redactAuditContext({ name: 'OPENAI_API_KEY', value: 'whatever-plain' });
    expect(out).not.toContain('whatever-plain');
  });

  it('serializes non-string primitives and arrays without throwing', () => {
    expect(redactAuditContext(42)).toBe('42');
    expect(redactAuditContext(true)).toBe('true');
    expect(redactAuditContext([1, 'two'])).toBe('[1,"two"]');
  });

  it('returns null for whitespace-only input', () => {
    expect(redactAuditContext('   \n ')).toBeNull();
  });

  it('never throws on exotic input', () => {
    expect(() => redactAuditContext({ toJSON: () => { throw new Error('x'); } })).not.toThrow();
    expect(() => redactAuditContext(Symbol('s'))).not.toThrow();
    expect(() => redactAuditContext(10n)).not.toThrow();
    expect(() => redactAuditContext('{bad json')).not.toThrow();
  });
});

// Free-text shapes that the shared redactors miss; audit.js adds its own passes for them.
describe('redactAuditContext: free-text shapes', () => {
  it('redacts a 32-char generic token (brief says 32+, regex needs 40+)', () => {
    expect(redactAuditContext('tok a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6 end')).not.toContain('a1b2c3d4e5f6');
  });
  it('redacts a prefixed sb_secret_ key', () => {
    expect(redactAuditContext('key sb_secret_AbCdEfGhIjKlMnOpQrStUv')).not.toContain('AbCdEfGh');
  });
  it('redacts an inline "Authorization: Basic ..." header line', () => {
    expect(redactAuditContext('Authorization: Basic dXNlcjpwYXNz')).not.toContain('dXNlcjpwYXNz');
  });
  it('redacts an inline "Cookie: ..." header line', () => {
    expect(redactAuditContext('Cookie: burrow_session=abc123; x=1')).not.toContain('abc123');
  });
  it('redacts an inline password=value pair', () => {
    expect(redactAuditContext('login with password=hunter2 now')).not.toContain('hunter2');
  });
});

describe('redactAuditContext: 2000 character cap', () => {
  it('leaves exactly 2000 characters untouched', () => {
    const text = 'a '.repeat(1000).trimEnd().padEnd(2000, 'b');
    expect(text).toHaveLength(2000);
    expect(redactAuditContext(text)).toBe(text);
  });

  it('truncates 2001 characters to at most 2000, with the suffix', () => {
    const out = redactAuditContext('word '.repeat(401));
    expect(out.length).toBeLessThanOrEqual(AUDIT_CONTEXT_MAX_CHARS);
    expect(out.endsWith('…[truncated]')).toBe(true);
  });

  it('caps a large serialized object', () => {
    const out = redactAuditContext({ rows: Array.from({ length: 2000 }, (_, i) => ({ id: i, label: 'row' })) });
    expect(out.length).toBeLessThanOrEqual(AUDIT_CONTEXT_MAX_CHARS);
    expect(out.endsWith('…[truncated]')).toBe(true);
  });

  it('does not split a surrogate pair at the cut', () => {
    const out = redactAuditContext('😀'.repeat(1500));
    expect(out.length).toBeLessThanOrEqual(AUDIT_CONTEXT_MAX_CHARS);
    const body = out.slice(0, -'…[truncated]'.length);
    expect(body.length % 2).toBe(0);
    expect(() => encodeURIComponent(out)).not.toThrow();
  });

  it('redacts before truncating: a secret straddling the cut is not left as a prefix', () => {
    const secret = 'gsk_FAKEtestKEYnotREAL0000000000';
    const out = redactAuditContext('y'.repeat(1980) + ' ' + secret + ' tail');
    expect(out).not.toContain('gsk_');
  });
});

describe('normalizeAuditEvent: meta', () => {
  const meta = (m) => normalizeAuditEvent({ ...GOOD, meta: m }).meta;

  it.each(['token', 'apiKey', 'password', 'authorization', 'cookie', 'session_id', 'client_secret', 'jwt'])(
    'drops sensitive meta key %s',
    (key) => {
      expect(meta({ [key]: 'x', rows: 3 })).toEqual({ rows: 3 });
    },
  );

  it('drops objects, null, undefined, NaN and Infinity values (and empty-after-filter arrays stay empty)', () => {
    expect(meta({ a: {}, c: null, d: undefined, e: Number.NaN, f: Infinity, g: -Infinity, ok: 1 })).toEqual({ ok: 1 });
    expect(meta({ b: [] })).toEqual({ b: [] });
  });

  it('keeps arrays of short lowercase names only (category ids), at most 12', () => {
    expect(meta({ shared: ['budget', 'todos', 'Bad Name', 'journal entry text', 7, null, 'x'.repeat(21), 'ok_1'] })).toEqual({ shared: ['budget', 'todos', 'ok_1'] });
    const many = Array.from({ length: 20 }, (_, i) => `name${i}`);
    expect(meta({ shared: many }).shared).toHaveLength(12);
  });

  it('keeps at most 10 keys', () => {
    const many = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`k${i}`, i]));
    expect(Object.keys(meta(many))).toHaveLength(10);
  });

  it('clips string values to 40 chars and redacts secret-looking values', () => {
    expect(meta({ note: 'word '.repeat(20) }).note).toHaveLength(40);
    const leaked = meta({ note: 'gsk_FAKEtestKEYnotREAL0000000000' }).note;
    expect(leaked).not.toContain('gsk_FAKEtest');
  });

  it('rejects malformed keys', () => {
    expect(meta({ 'has space': 1, ['k'.repeat(31)]: 1, 'ok_key': 1 })).toEqual({ ok_key: 1 });
  });

  it('returns {} for non-object meta', () => {
    expect(meta(undefined)).toEqual({});
    expect(meta('str')).toEqual({});
    expect(meta([1, 2])).toEqual({});
  });
});

describe('logAudit: sentinel secrets never reach the stored row', () => {
  const SENTINELS = {
    GROQ_API_KEY: 'gsk_SENTINEL0123456789abcdefghijkl',
    OPENAI_API_KEY: 'sk-SENTINEL0123456789abcdefghijklmn',
    AWS_ACCESS_KEY_ID: 'AKIASENTINEL01234567',
    BEDROCK_API_KEY: 'ABSKSENTINEL0123456789abcdefghijklmn',
    SERVICE_ROLE_KEY:
      'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VudGluZWwifQ.SENTINELsig0123456789',
  };
  const saved = {};
  beforeEach(() => {
    for (const [k, v] of Object.entries(SENTINELS)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });
  afterEach(() => {
    for (const k of Object.keys(SENTINELS)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('scrubs every env-planted sentinel from context, meta, and the whole payload', async () => {
    const every = Object.values(SENTINELS);
    const context = {
      prompt: `Use ${every[0]} and ${every[1]}`,
      env: { GROQ_API_KEY: every[0], note: 'plain' },
      list: every,
      nested: { deeper: [{ text: `x ${every[2]} y`, more: every[4] }] },
      asJson: JSON.stringify({ k: every[3] }),
    };
    const ok = await logAudit(
      { ...GOOD, context, meta: { a: every[0], b: every[1], c: every[2], d: every[3], e: every[4] } },
      { db },
    );
    expect(ok).toBe(true);
    const payload = JSON.stringify(rows());
    for (const s of every) {
      expect(payload).not.toContain(s);
      expect(payload).not.toContain(s.slice(0, 18));
    }
  });

  it('never stores raw environment values for sensitive-named variables in a dumped env', async () => {
    process.env.CRON_SECRET = 'cron-plain-sentinel-value';
    process.env.APP_PASSWORD = 'password-plain-sentinel-value';
    process.env.AUTH_SECRET = 'auth-plain-sentinel-value';
    try {
      await logAudit({ ...GOOD, context: { dump: { CRON_SECRET: process.env.CRON_SECRET, APP_PASSWORD: process.env.APP_PASSWORD, AUTH_SECRET: process.env.AUTH_SECRET } } }, { db });
      const payload = JSON.stringify(rows());
      expect(payload).not.toContain('cron-plain-sentinel-value');
      expect(payload).not.toContain('password-plain-sentinel-value');
      expect(payload).not.toContain('auth-plain-sentinel-value');
    } finally {
      delete process.env.CRON_SECRET;
      delete process.env.APP_PASSWORD;
      delete process.env.AUTH_SECRET;
    }
  });

  it('writes only the allow-listed columns', async () => {
    await logAudit({ ...GOOD, ip: '203.0.113.9', headers: { cookie: 'a=b' }, password: 'pw', context: 'hi' }, { db });
    const [row] = rows();
    expect(Object.keys(row).sort()).toEqual(
      ['context', 'created_at', 'feature', 'id', 'kind', 'meta', 'model', 'page', 'provider', 'status'],
    );
    expect(JSON.stringify(row)).not.toMatch(/203\.0\.113\.9|a=b|"pw"/);
  });
});

describe('logAudit: tolerates a dropped audit_log table', () => {
  let errSpy;
  let own;
  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    own = createTestDb();
    own.exec('DROP TABLE audit_log');
  });
  afterEach(() => {
    errSpy.mockRestore();
    closeTestDb(own);
    setDbForTests(db);
  });

  it('returns false and never throws', async () => {
    await expect(logAudit(GOOD, { db: own })).resolves.toBe(false);
  });

  it('only ever logs the error code, never the message or payload', async () => {
    await logAudit({ ...GOOD, context: 'secret-context-zzz gsk_FAKEtestKEYnotREAL0000000000' }, { db: own });
    const logged = JSON.stringify(errSpy.mock.calls);
    expect(logged).toContain('Audit write failed');
    expect(logged).not.toContain('gsk_');
    expect(logged).not.toContain('secret-context-zzz');
    expect(logged).not.toContain('audit_log');
  });

  it('pruneAudit returns ok:false without throwing', async () => {
    await expect(pruneAudit({ db: own })).resolves.toEqual({
      ok: false,
      deletedOld: null,
      deletedAuthErrors: null,
      deletedOverCap: null,
    });
  });
});

describe('logAudit: invalid events and retention', () => {
  it('drops invalid events without writing', async () => {
    await expect(logAudit({ kind: 'bogus', feature: 'x' }, { db })).resolves.toBe(false);
    await expect(logAudit(undefined, { db })).resolves.toBe(false);
    expect(rows()).toHaveLength(0);
  });

  it('never deletes, whatever Math.random returns', async () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      seedDb(db, { audit_log: [{ kind: 'llm', feature: 'old', created_at: '2000-01-01T00:00:00.000Z' }] });
      await expect(logAudit(GOOD, { db })).resolves.toBe(true);
      await new Promise((r) => setTimeout(r, 15));
      expect(rows()).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('pruneAudit', () => {
  const now = new Date('2026-06-01T12:34:56.789Z');
  const DAY = 24 * 60 * 60 * 1000;
  const row = (feature, created_at, extra = {}) => ({ kind: 'llm', feature, created_at, ...extra });

  it('cuts at 90 days from `now` in UTC (millisecond exact, strictly older only)', async () => {
    const cutoff = new Date(now.getTime() - 90 * DAY).toISOString();
    expect(cutoff).toBe('2026-03-03T12:34:56.789Z');
    seedDb(db, {
      audit_log: [row('before', '2026-03-03T12:34:56.788Z'), row('at', cutoff), row('after', '2026-03-03T12:34:56.790Z')],
    });
    const out = await pruneAudit({ db, now });
    expect(out).toEqual({ ok: true, deletedOld: 1, deletedAuthErrors: 0, deletedOverCap: 0 });
    expect(rows().map((r) => r.feature)).toEqual(['at', 'after']);
  });

  it('is not skewed by a DST boundary (cutoff is plain 90*24h)', async () => {
    seedDb(db, { audit_log: [row('old', '2025-12-14T23:59:59.000Z'), row('kept', '2025-12-15T00:00:00.000Z')] });
    await pruneAudit({ db, now: new Date('2026-03-15T00:00:00.000Z') });
    expect(rows().map((r) => r.feature)).toEqual(['kept']);
  });

  it('honors custom maxAgeDays and defaults `now` to the current time', async () => {
    seedDb(db, { audit_log: [row('old', '2026-05-25T12:34:56.788Z'), row('kept', '2026-05-25T12:34:56.789Z')] });
    await pruneAudit({ db, now, maxAgeDays: 7 });
    expect(rows().map((r) => r.feature)).toEqual(['kept']);

    resetDb(db);
    seedDb(db, { audit_log: [row('ancient', new Date(Date.now() - 91 * DAY).toISOString()), row('recent', new Date().toISOString())] });
    await pruneAudit({ db });
    expect(rows().map((r) => r.feature)).toEqual(['recent']);
  });

  it('keeps the newest maxRows overall and reports counts', async () => {
    const stamp = (i) => new Date(Date.UTC(2026, 4, 1, 0, 0, i)).toISOString();
    seedDb(db, { audit_log: Array.from({ length: 12 }, (_, i) => row(`f${i}`, stamp(i))) });
    const out = await pruneAudit({ db, now, maxRows: 10 });
    expect(out).toEqual({ ok: true, deletedOld: 0, deletedAuthErrors: 0, deletedOverCap: 2 });
    expect(rows().map((r) => r.feature)).toEqual(Array.from({ length: 10 }, (_, i) => `f${i + 2}`));
  });

  it('trims failed sign-ins first, scoped to kind=auth and status=error', async () => {
    const stamp = (i) => new Date(Date.UTC(2026, 4, 1, 0, 0, i)).toISOString();
    const authErr = Array.from({ length: 502 }, (_, i) => row('sign_in', stamp(i), { kind: 'auth', status: 'error' }));
    seedDb(db, { audit_log: [...authErr, row('llm_row', stamp(0))] });
    const out = await pruneAudit({ db, now });
    expect(out).toEqual({ ok: true, deletedOld: 0, deletedAuthErrors: 2, deletedOverCap: 0 });
    expect(rows().filter((r) => r.kind === 'auth')).toHaveLength(500);
    expect(rows().some((r) => r.feature === 'llm_row')).toBe(true);
  });

  it('does nothing when under the caps', async () => {
    seedDb(db, { audit_log: [row('a', '2026-05-01T00:00:00.000Z')] });
    await expect(pruneAudit({ db, now })).resolves.toEqual({ ok: true, deletedOld: 0, deletedAuthErrors: 0, deletedOverCap: 0 });
  });

  it('writes nothing to the console on failure', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const own = createTestDb();
    own.exec('DROP TABLE audit_log');
    await pruneAudit({ db: own, now });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    closeTestDb(own);
    setDbForTests(db);
  });
});
