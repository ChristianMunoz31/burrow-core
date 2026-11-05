// Hardening regressions for server/audit.js on a real SQLite DB: sign-in coalescing, extra
// redaction passes, model scan, and the strict composite cursor.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestDb, createTestDb, resetDb, rowsOf, seedDb } from './helpers/testDb.js';

vi.mock('../../loadEnv.js', () => ({}));

import {
  AUDIT_CONTEXT_MAX_CHARS,
  listAudit,
  logAudit,
  normalizeAuditEvent,
  parseAuditCursor,
  pruneAudit,
  redactAuditContext,
  resetAuditState,
} from '../audit.js';

const GOOD = { kind: 'llm', feature: 'insights', provider: 'groq', model: 'openai/gpt-oss-120b' };
const SIGN_IN_FAIL = { kind: 'auth', feature: 'sign_in', status: 'error' };
const MIN = 60 * 1000;

let db;
let errSpy;
const rows = () => rowsOf(db, 'audit_log');

beforeAll(() => {
  db = createTestDb();
});
beforeEach(() => {
  resetDb(db);
  resetAuditState();
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
});
afterAll(() => closeTestDb(db));

describe('failed sign-in coalescing', () => {
  it('writes one row per 60s with meta.attempts counting the swallowed ones', async () => {
    let t = 10 * MIN;
    const opts = { db, nowMs: () => t };
    await expect(logAudit(SIGN_IN_FAIL, opts)).resolves.toBe(true);
    t += 1000;
    await expect(logAudit(SIGN_IN_FAIL, opts)).resolves.toBe(false);
    t += 1000;
    await expect(logAudit(SIGN_IN_FAIL, opts)).resolves.toBe(false);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].meta).toEqual({ attempts: 1 });
    t += 60 * 1000;
    await expect(logAudit(SIGN_IN_FAIL, opts)).resolves.toBe(true);
    expect(rows()).toHaveLength(2);
    expect(rows()[1].meta).toEqual({ attempts: 3 });
  });

  it('keeps the attempt count and the window after a failed write', async () => {
    const nowMs = () => 10 * MIN;
    db.exec('ALTER TABLE audit_log RENAME TO audit_log_off');
    await expect(logAudit(SIGN_IN_FAIL, { db, nowMs })).resolves.toBe(false);
    db.exec('ALTER TABLE audit_log_off RENAME TO audit_log');
    await expect(logAudit(SIGN_IN_FAIL, { db, nowMs })).resolves.toBe(true);
    expect(rows()[0].meta).toEqual({ attempts: 2 });
  });

  it('adds failed_attempts_before to the next successful sign-in and resets', async () => {
    const opts = { db, nowMs: () => 10 * MIN };
    await logAudit(SIGN_IN_FAIL, opts);
    await logAudit(SIGN_IN_FAIL, opts);
    await logAudit(SIGN_IN_FAIL, opts);
    const ok = { kind: 'auth', feature: 'sign_in', status: 'ok' };
    await expect(logAudit(ok, opts)).resolves.toBe(true);
    expect(rows()[1].meta).toEqual({ failed_attempts_before: 2 });
    await logAudit(ok, opts);
    expect(rows()[2].meta).toEqual({});
  });

  it('never coalesces successful sign-ins or other events', async () => {
    await logAudit({ kind: 'auth', feature: 'sign_in', status: 'ok' }, { db });
    await logAudit({ kind: 'auth', feature: 'sign_in', status: 'ok' }, { db });
    await logAudit(GOOD, { db });
    await logAudit(GOOD, { db });
    expect(rows()).toHaveLength(4);
    expect(rows()[0].meta).toEqual({});
  });

  it('writes one row for two concurrent failed sign-ins and keeps the count of the other', async () => {
    const opts = { db, nowMs: () => 10 * MIN };
    const results = await Promise.all([logAudit(SIGN_IN_FAIL, opts), logAudit(SIGN_IN_FAIL, opts)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].meta).toEqual({ attempts: 1 });
  });

  it('resetAuditState reopens the window', async () => {
    const opts = { db, nowMs: () => 10 * MIN };
    await expect(logAudit(SIGN_IN_FAIL, opts)).resolves.toBe(true);
    await expect(logAudit(SIGN_IN_FAIL, opts)).resolves.toBe(false);
    resetAuditState();
    await expect(logAudit(SIGN_IN_FAIL, opts)).resolves.toBe(true);
  });
});

describe('writes and retention', () => {
  it('logAudit never deletes rows; the scheduler owns retention', async () => {
    seedDb(db, { audit_log: [{ kind: 'llm', feature: 'old', created_at: '2000-01-01T00:00:00.000Z' }] });
    await logAudit(GOOD, { db });
    await new Promise((r) => setTimeout(r, 10));
    expect(rows()).toHaveLength(2);
  });

  it('a failed write logs only the error code', async () => {
    db.exec('DROP TABLE audit_log');
    await expect(logAudit({ ...GOOD, context: 'secret prompt text' }, { db })).resolves.toBe(false);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errSpy.mock.calls)).not.toContain('secret prompt text');
    db.exec(`CREATE TABLE audit_log (
      id TEXT PRIMARY KEY NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      kind TEXT NOT NULL, feature TEXT NOT NULL, page TEXT, provider TEXT, model TEXT,
      status TEXT NOT NULL DEFAULT 'ok', context TEXT,
      meta TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta))
    ) STRICT`);
  });
});

describe('redaction passes', () => {
  it.each([
    ['AWS secret key', 'aws wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI'],
    ['Oura PAT', 'pat ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ2'],
    ['sb_publishable key', 'sb_publishable_AbCdEfGhIjKlMnOpQrSt', 'AbCdEfGhIj'],
    ['api key assignment', 'api key: abc-def', 'abc-def'],
    ['access_key assignment', 'access_key=hunter22', 'hunter22'],
    ['secret assignment', 'secret = topvalue', 'topvalue'],
    ['Authorization Bearer line', 'Authorization: Bearer abcdef.ghijkl', 'ghijkl'],
    ['cookie line keeps nothing after', 'Cookie: a=1; b=2\nnext line', 'b=2'],
  ])('redacts %s', (_n, input, leaked) => {
    const out = redactAuditContext(input);
    expect(out).not.toContain(leaked);
    expect(out).toContain('redacted');
  });

  it('keeps the rest of a cookie header text on the following line', () => {
    expect(redactAuditContext('Cookie: a=1; b=2\nnext line')).toContain('next line');
  });

  it('masks 13-19 digit runs as [number] and leaves short numbers alone', () => {
    const out = redactAuditContext('card 4111111111111111 and 4111 1111 1111 1111, balance 12345.67 on 2026-05-01');
    expect(out).not.toContain('4111');
    expect(out.match(/\[number\]/g)).toHaveLength(2);
    expect(out).toContain('12345.67');
    expect(out).toContain('2026-05-01');
  });

  it('leaves ordinary words, dates and model-like ids alone (no digit+letter run of 24)', () => {
    const text = 'Compare internationalization-related spend with 2026-05-01T10:00:00Z totals';
    expect(redactAuditContext(text)).toBe(text);
  });

  it('keeps sibling values in compact JSON when a keyword key is redacted', () => {
    const out = redactAuditContext('{"password":"x1","safe":"visible"}');
    expect(out).not.toContain('x1');
    expect(out).toContain('visible');
  });

  it('does not run the heavy passes on more than 4x the cap (secret past the clip is dropped)', () => {
    const out = redactAuditContext(`${'a '.repeat(AUDIT_CONTEXT_MAX_CHARS * 3)}password=tailsecret`);
    expect(out.length).toBeLessThanOrEqual(AUDIT_CONTEXT_MAX_CHARS);
    expect(out).not.toContain('tailsecret');
  });

  it('is fast on a 5MB pathological string', () => {
    const start = Date.now();
    const out = redactAuditContext(`{${'x'.repeat(5_000_000)}`);
    expect(Date.now() - start).toBeLessThan(5000);
    expect(out.length).toBeLessThanOrEqual(AUDIT_CONTEXT_MAX_CHARS);
  });

  it('still redacts sensitive keys of a JSON string up to 64KB (redactValue pre-parse)', () => {
    const json = JSON.stringify({ apiKey: 'plain-zzz', note: 'ok', pad: 'p'.repeat(20_000) });
    const out = redactAuditContext(json);
    expect(out).not.toContain('plain-zzz');
    expect(out).toContain('ok');
  });
});

describe('model scan', () => {
  it.each(['gsk_FAKEtestKEYnotREAL0000000000', 'sk-proj-abcdefghijklmnopqrstuvwx1234', 'AKIAIOSFODNN7EXAMPLE'])(
    'nulls a model that looks like a secret: %s',
    (model) => {
      expect(normalizeAuditEvent({ ...GOOD, model }).model).toBeNull();
    },
  );

  it.each(['openai/gpt-oss-120b', 'amazon.nova-pro-v1:0', 'us.anthropic.claude-3-5-sonnet-20241022-v2:0'])(
    'keeps a real model id: %s',
    (model) => {
      expect(normalizeAuditEvent({ ...GOOD, model }).model).toBe(model);
    },
  );
});

describe('keyword assignment redaction (prefixed keys)', () => {
  it.each([
    ['APP_PASSWORD=hunter2', 'hunter2'],
    ['DB_PASSWORD=hunter2', 'hunter2'],
    ['{"db_password":"x y"}', 'x y'],
    ['client_secret: abc123zz', 'abc123zz'],
    ['aws_secret_access_key = abc123zz', 'abc123zz'],
    ['apiKey: abc123zz', 'abc123zz'],
    ['X_API_KEY=abc123zz', 'abc123zz'],
    ['msg: "login password=abc123zz"', 'abc123zz'],
  ])('redacts %j', (input, secret) => {
    const out = redactAuditContext(input);
    expect(out).not.toContain(secret);
    expect(out).toContain('[redacted]');
  });

  it.each(['author: Bob', 'see https://x.y/path now', 'time: 10:30'])('keeps %j', (input) => {
    expect(redactAuditContext(input)).toBe(input);
  });

  it('keeps compact JSON siblings of a redacted key', () => {
    expect(redactAuditContext('{"safe":"visible","password":"x"}')).toContain('"safe":"visible"');
  });
});

describe('final-round redaction fixes', () => {
  it.each([
    ['--password=hunter2', 'hunter2'],
    ['--db-password=hunter2', 'hunter2'],
    ['_PASSWORD=hunter2', 'hunter2'],
    [`${'a.'.repeat(35)}password=hunter2`, 'hunter2'],
    ['APP_PASSWORD=hunter2', 'hunter2'],
  ])('redacts flag/underscore-led key %j', (input, secret) => {
    const out = redactAuditContext(input);
    expect(out).not.toContain(secret);
    expect(out).toContain('[redacted]');
  });

  it('redacts a multi-word unquoted sensitive value but keeps non-sensitive text', () => {
    const out = redactAuditContext('password: correct horse battery staple');
    expect(out).not.toContain('horse');
    expect(out).not.toContain('battery');
    expect(redactAuditContext('author: Bob Smith')).toBe('author: Bob Smith');
  });

  it('keeps scanning lines after a redacted line', () => {
    const out = redactAuditContext('password: a b c\nauthor: Bob');
    expect(out).toContain('author: Bob');
    expect(out).not.toContain('a b c');
  });

  it('drops the partial token left by the scan clip', () => {
    const out = redactAuditContext(`${'y '.repeat(3990)}${'z'.repeat(40)}`);
    expect(out).not.toMatch(/z{5}/);
    expect(redactAuditContext('q'.repeat(20000))).not.toBeNull();
  });

  it('finishes quickly on alternating quote/colon input', () => {
    const start = performance.now();
    redactAuditContext('a: "b: \'c: "'.repeat(8000 / 11 + 1).slice(0, 8000));
    expect(performance.now() - start).toBeLessThan(100);
  });
});

describe('redaction ReDoS bounds', () => {
  it.each([
    ['ellipsis', '…'.repeat(8000)],
    ['dotted', 'a.'.repeat(4000)],
    ['at-signs', 'a@'.repeat(4000)],
  ])('finishes quickly on %s input', (_n, input) => {
    const start = performance.now();
    redactAuditContext(input);
    expect(performance.now() - start).toBeLessThan(100);
  });
});

describe('cursor', () => {
  const TS = '2026-05-04T10:00:00.400000+00:00';
  const ID = '00000000-0000-4000-8000-000000000002';

  it('accepts ISO-8601 with and without an id and returns the original strings', () => {
    expect(parseAuditCursor(TS)).toEqual({ ts: TS, id: null });
    expect(parseAuditCursor(`${TS}|${ID}`)).toEqual({ ts: TS, id: ID });
    expect(parseAuditCursor('2026-05-04T10:00:00Z')).toEqual({ ts: '2026-05-04T10:00:00Z', id: null });
    expect(parseAuditCursor('2026-05-04T10:00:00-05:00')).not.toBeNull();
  });

  it.each([
    undefined,
    null,
    42,
    '',
    '1',
    '2026-05-04',
    '2026-05-04 10:00:00Z',
    '2026-13-04T10:00:00Z',
    '2026-02-30T10:00:00Z',
    '2026-05-04T25:00:00Z',
    `${TS}|nope`,
    `${TS}|${ID}|x`,
    `${TS}|${ID}`.padEnd(100, 'x'),
  ])('rejects %j', (value) => {
    expect(parseAuditCursor(value)).toBeNull();
  });

  it('listAudit pages newest first, breaking created_at ties by id', async () => {
    const same = '2026-05-04T10:00:00.400Z';
    seedDb(db, {
      audit_log: [
        { id: '00000000-0000-4000-8000-000000000001', created_at: same, kind: 'llm', feature: 'a' },
        { id: ID, created_at: same, kind: 'llm', feature: 'b' },
        { id: '00000000-0000-4000-8000-000000000003', created_at: '2026-05-04T09:00:00.000Z', kind: 'llm', feature: 'c' },
      ],
    });
    const first = await listAudit({ db, limit: 2 });
    expect(first.entries.map((e) => e.feature)).toEqual(['b', 'a']);
    expect(first.nextBefore).toBe(`${same}|00000000-0000-4000-8000-000000000001`);
    const second = await listAudit({ db, limit: 2, before: first.nextBefore });
    expect(second.entries.map((e) => e.feature)).toEqual(['c']);
    expect(second.nextBefore).toBeNull();
  });

  it('listAudit accepts a +00:00 microsecond cursor and an uppercase id', async () => {
    const same = '2026-05-04T10:00:00.400Z';
    seedDb(db, {
      audit_log: [
        { id: '00000000-0000-4000-8000-0000000000aa', created_at: same, kind: 'llm', feature: 'a' },
        { id: '00000000-0000-4000-8000-0000000000bb', created_at: same, kind: 'llm', feature: 'b' },
      ],
    });
    const out = await listAudit({ db, before: `${TS}|00000000-0000-4000-8000-0000000000BB` });
    expect(out.entries.map((e) => e.feature)).toEqual(['a']);
  });

  it('listAudit answers unavailable for a malformed cursor', async () => {
    await expect(listAudit({ db, before: 'junk' })).resolves.toMatchObject({ available: false, reason: 'error' });
  });
});

describe('prune caps', () => {
  it('trims failed sign-ins to 500 rows before the global cap, keeping the newest', async () => {
    const stamp = (i) => new Date(Date.UTC(2026, 4, 1) + i * 1000).toISOString();
    const authErrors = Array.from({ length: 503 }, (_, i) => ({
      kind: 'auth',
      feature: 'sign_in',
      status: 'error',
      created_at: stamp(i),
    }));
    const llm = Array.from({ length: 4 }, (_, i) => ({ kind: 'llm', feature: 'x', created_at: stamp(1000 + i) }));
    seedDb(db, { audit_log: [...authErrors, ...llm] });
    const out = await pruneAudit({ db, now: new Date('2026-05-02T00:00:00Z') });
    expect(out).toEqual({ ok: true, deletedOld: 0, deletedAuthErrors: 3, deletedOverCap: 0 });
    expect(rows().filter((r) => r.kind === 'auth')).toHaveLength(500);
    expect(rows().filter((r) => r.kind === 'llm')).toHaveLength(4);
  });

  it('trims the table to the newest maxRows', async () => {
    const stamp = (i) => new Date(Date.UTC(2026, 4, 1) + i * 1000).toISOString();
    seedDb(db, { audit_log: Array.from({ length: 10 }, (_, i) => ({ kind: 'llm', feature: 'x', created_at: stamp(i) })) });
    const out = await pruneAudit({ db, now: new Date('2026-05-02T00:00:00Z'), maxRows: 4 });
    expect(out).toMatchObject({ ok: true, deletedOverCap: 6 });
    expect(rows().map((r) => r.created_at)).toEqual([6, 7, 8, 9].map(stamp));
  });
});
