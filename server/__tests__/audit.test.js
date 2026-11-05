import { afterAll, beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { setDbForTests } from '../db/index.js';
import { closeTestDb, createTestDb, resetDb, rowsOf, seedDb } from './helpers/testDb.js';

vi.mock('../../loadEnv.js', () => ({}));

import {
  AUDIT_CONTEXT_MAX_CHARS,
  listAudit,
  logAudit,
  normalizeAuditEvent,
  pruneAudit,
  redactAuditContext,
  resetAuditState,
} from '../audit.js';

import { recordAudit, setAuditSink } from '../auditHook.js';

let db;
const rows = () => rowsOf(db, 'audit_log');
// A throwaway DB for broken-table cases; hands the singleton back to the shared one.
const releaseOwn = (own) => {
  closeTestDb(own);
  setDbForTests(db);
};

beforeAll(() => {
  db = createTestDb();
});
beforeEach(() => {
  resetDb(db);
  resetAuditState();
});
afterAll(() => closeTestDb(db));

const GOOD = { kind: 'llm', feature: 'javi_advice', page: 'budget', provider: 'groq', model: 'openai/gpt-oss-120b' };

describe('redactAuditContext', () => {
  it('passes null, undefined and empty through as null', () => {
    expect(redactAuditContext(null)).toBeNull();
    expect(redactAuditContext(undefined)).toBeNull();
    expect(redactAuditContext('')).toBeNull();
  });

  it('scrubs key-shaped, bearer, JWT and AWS tokens and emails', () => {
    const text = [
      'a sk-abcdefghijklmnopqrstuvwxyz123456',
      'b gsk_abcdefghijklmnopqrstuvwxyz1234',
      'c AKIAABCDEFGHIJKLMNOP',
      'd Bearer abc.def.ghi',
      'e eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sig',
      'f me@example.com',
    ].join('\n');
    const out = redactAuditContext({ note: text });
    expect(out).not.toMatch(/sk-abcdef|gsk_abcdef|AKIAABCDEF|abc\.def\.ghi|eyJhbGci|me@example\.com/);
  });

  it('redacts values under sensitive keys in objects and JSON strings', () => {
    const out = redactAuditContext({ apiKey: 'plain-secret-1', nested: { password: 'hunter2', ok: 'fine' } });
    expect(out).not.toContain('plain-secret-1');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('fine');
    const fromString = redactAuditContext(JSON.stringify({ token: 'tok-value-1', keep: 'yes' }));
    expect(fromString).not.toContain('tok-value-1');
    expect(fromString).toContain('yes');
  });

  it('caps long input at 2000 chars with a truncation suffix', () => {
    const out = redactAuditContext('word '.repeat(5000));
    expect(out.length).toBeLessThanOrEqual(AUDIT_CONTEXT_MAX_CHARS);
    expect(out.endsWith('…[truncated]')).toBe(true);
  });

  it('strips control chars and normalizes NFKC', () => {
    const out = redactAuditContext('ＡＢＣ\u0000\u0007 done​');
    expect(out).toBe('ABC done');
  });

  it('never throws on circular input', () => {
    const a = {};
    a.self = a;
    expect(() => redactAuditContext(a)).not.toThrow();
  });
});

describe('normalizeAuditEvent', () => {
  it('drops bad kind or feature', () => {
    expect(normalizeAuditEvent({ ...GOOD, kind: 'nope' })).toBeNull();
    expect(normalizeAuditEvent({ ...GOOD, feature: 'Bad Feature' })).toBeNull();
    expect(normalizeAuditEvent(null)).toBeNull();
  });

  it('nulls invalid page/provider/model and defaults status to ok', () => {
    const row = normalizeAuditEvent({ ...GOOD, page: 'BAD PAGE', provider: 'x'.repeat(30), model: '$$$' });
    expect(row).toMatchObject({ page: null, provider: null, model: null, status: 'ok' });
  });

  it('keeps only safe meta entries', () => {
    const row = normalizeAuditEvent({
      ...GOOD,
      meta: { rows: 4, ok: true, trigger: 'cron', apiToken: 'x', nested: { a: 1 }, bad: Number.NaN, 'bad key': 1 },
    });
    expect(row.meta).toEqual({ rows: 4, ok: true, trigger: 'cron' });
  });
});

describe('logAudit', () => {
  it('inserts a normalized, redacted row and resolves true', async () => {
    await expect(logAudit({ ...GOOD, context: { apiKey: 'zzz' } }, { db })).resolves.toBe(true);
    const [row] = rows();
    expect(row.feature).toBe('javi_advice');
    expect(row.kind).toBe('llm');
    expect(row.context).not.toContain('zzz');
    expect(row.meta).toEqual({});
    expect(row.created_at).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
  });

  it('resolves false for an event that fails validation', async () => {
    await expect(logAudit({ ...GOOD, kind: 'nope' }, { db })).resolves.toBe(false);
    expect(rows()).toHaveLength(0);
  });

  it('uses the singleton database when no handle is passed', async () => {
    await expect(logAudit(GOOD)).resolves.toBe(true);
    expect(rows()).toHaveLength(1);
  });

  it('resolves false quietly when the audit_log table is gone', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const own = createTestDb();
    own.exec('DROP TABLE audit_log');
    await expect(logAudit(GOOD, { db: own })).resolves.toBe(false);
    expect(spy).toHaveBeenCalledWith('Audit write failed:', expect.any(String));
    releaseOwn(own);
    spy.mockRestore();
  });

  it('never prunes inline: retention runs from the scheduler', async () => {
    seedDb(db, { audit_log: [{ kind: 'llm', feature: 'old', created_at: '2000-01-01T00:00:00.000Z' }] });
    await expect(logAudit(GOOD, { db })).resolves.toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(rows()).toHaveLength(2);
  });
});

describe('pruneAudit', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');

  it('deletes rows older than 90 days and keeps newer ones', async () => {
    seedDb(db, {
      audit_log: [
        { kind: 'llm', feature: 'old', created_at: '2026-03-02T23:59:59.000Z' },
        { kind: 'llm', feature: 'edge', created_at: '2026-03-03T00:00:00.000Z' },
        { kind: 'llm', feature: 'new', created_at: '2026-05-31T00:00:00.000Z' },
      ],
    });
    const out = await pruneAudit({ db, now });
    expect(out).toEqual({ ok: true, deletedOld: 1, deletedAuthErrors: 0, deletedOverCap: 0 });
    expect(rows().map((r) => r.feature)).toEqual(['edge', 'new']);
  });

  it('keeps the newest maxRows when the cap is exceeded', async () => {
    const stamp = (i) => new Date(Date.UTC(2026, 4, 1) + i * 1000).toISOString();
    seedDb(db, { audit_log: Array.from({ length: 6 }, (_, i) => ({ kind: 'llm', feature: `f${i}`, created_at: stamp(i) })) });
    const out = await pruneAudit({ db, now, maxRows: 3 });
    expect(out).toMatchObject({ ok: true, deletedOverCap: 3 });
    expect(rows().map((r) => r.feature)).toEqual(['f3', 'f4', 'f5']);
  });

  it('does nothing when under the caps and works with no arguments', async () => {
    await logAudit(GOOD, { db });
    await expect(pruneAudit({ db, now: new Date() })).resolves.toMatchObject({ ok: true, deletedOld: 0, deletedOverCap: 0 });
    await expect(pruneAudit()).resolves.toMatchObject({ ok: true });
    expect(rows()).toHaveLength(1);
  });

  it('returns ok:false instead of throwing when the table is missing', async () => {
    const own = createTestDb();
    own.exec('DROP TABLE audit_log');
    await expect(pruneAudit({ db: own, now })).resolves.toEqual({
      ok: false,
      deletedOld: null,
      deletedAuthErrors: null,
      deletedOverCap: null,
    });
    releaseOwn(own);
  });
});

describe('listAudit', () => {
  it('reports error when the table is missing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const own = createTestDb();
    own.exec('DROP TABLE audit_log');
    await expect(listAudit({ db: own })).resolves.toMatchObject({ available: false, reason: 'error', entries: [] });
    releaseOwn(own);
    spy.mockRestore();
  });

  it('maps rows and sets nextBefore only on a full page', async () => {
    seedDb(db, {
      audit_log: [
        { id: 'a', created_at: '2026-01-02T00:00:00.123Z', kind: 'llm', feature: 'jarvis', status: 'ok', context: 'hi' },
        { id: 'b', created_at: '2026-01-01T00:00:00.000Z', kind: 'auth', feature: 'sign_in', status: 'error' },
      ],
    });
    const full = await listAudit({ db, limit: 2 });
    expect(full.entries[0]).toMatchObject({ id: 'a', createdAt: '2026-01-02T00:00:00.123Z', context: 'hi', meta: {} });
    expect(full.entries[1]).toMatchObject({ id: 'b', page: null, context: null, status: 'error' });
    expect(full.nextBefore).toBe('2026-01-01T00:00:00.000Z|b');
    const partial = await listAudit({ db, limit: 5 });
    expect(partial.nextBefore).toBeNull();
  });
});

describe('auditHook', () => {
  it('recordAudit is a no-op with no sink and never rejects when the sink throws', async () => {
    setAuditSink(null);
    await expect(recordAudit(GOOD)).resolves.toBeUndefined();
    setAuditSink(() => {
      throw new Error('boom');
    });
    await expect(recordAudit(GOOD)).resolves.toBeUndefined();
    setAuditSink(logAudit);
  });
});
