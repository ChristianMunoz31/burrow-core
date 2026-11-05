// POST /api/transactions/import: envelope, validation, limits, rollback, audit, access.
// Standalone apps cover the route; one block goes through server.js for the sign-in gate and 413 JSON.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { closeTestDb, createTestDb, resetDb, rowsOf } from './helpers/testDb.js';
import { setDbForTests } from '../db/index.js';
import { insert } from '../db/query.js';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('../auditHook.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, recordAudit: vi.fn(mod.recordAudit) };
});
const h = vi.hoisted(() => ({ fail: false }));
// Wraps the real importer; when h.fail is set it injects the documented insertMany seam that
// writes one row and then throws, to prove the whole batch rolls back.
vi.mock('../import/transactionImport.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    importTransactions: (args) =>
      h.fail
        ? mod.importTransactions({
            ...args,
            deps: {
              insertMany: (table, rows, { db: tx }) => {
                insert(table, rows[0], { db: tx });
                throw new Error('SECRET_INTERNAL_DETAIL');
              },
            },
          })
        : mod.importTransactions(args),
  };
});

import { recordAudit, setAuditSink } from '../auditHook.js';
import { registerTransactionImportRoutes } from '../transactionImportRoutes.js';

let db;
beforeAll(() => {
  db = createTestDb();
});
beforeEach(() => {
  resetDb(db);
  recordAudit.mockClear();
  setAuditSink(null);
  h.fail = false;
});
afterAll(() => closeTestDb(db));

const URL = '/api/transactions/import';
const newApp = (opts) => {
  const app = express();
  registerTransactionImportRoutes(app, opts);
  return app;
};
const asNonLoopback = (opts) => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'ip', { value: '203.0.113.7' });
    next();
  });
  registerTransactionImportRoutes(app, opts);
  return app;
};
const row = (over = {}) => ({ date: '2024-03-05', merchant: 'Corner Grocery', amount: -12.34, category: 'Groceries', ...over });
const post = (app, body, query = '') => request(app).post(`${URL}${query}`).send(body);
const good = (extra = {}) => ({
  rows: [row(), row({ merchant: 'Employer Payroll', amount: 2500, category: 'Income' })],
  source: 'file',
  ...extra,
});

describe('POST /api/transactions/import', () => {
  it('imports, answers with the { data } envelope and no-store', async () => {
    const res = await post(newApp(), good({ fileName: 'march.csv' }));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ data: { received: 2, inserted: 2, duplicates: 0, duplicateIndexes: [], dryRun: false } });
    const stored = rowsOf(db, 'transactions');
    expect(stored.map((t) => [t.type, t.source_file])).toEqual([
      ['debit', 'march.csv'],
      ['credit', 'march.csv'],
    ]);
  });

  it('re-import reports all duplicates and inserts nothing', async () => {
    const app = newApp();
    await post(app, good());
    const res = await post(app, good());
    expect(res.body.data).toMatchObject({ inserted: 0, duplicates: 2, duplicateIndexes: [0, 1] });
    expect(rowsOf(db, 'transactions')).toHaveLength(2);
  });

  it('?dryRun=1 and ?dryRun=true write nothing and match the real counts', async () => {
    const app = newApp();
    await post(app, { rows: [row()], source: 'sheet' });
    const batch = good();
    const dry = await post(app, batch, '?dryRun=1');
    const dry2 = await post(app, batch, '?dryRun=true');
    expect(dry.body.data.dryRun).toBe(true);
    expect(dry2.body.data.dryRun).toBe(true);
    expect(rowsOf(db, 'transactions')).toHaveLength(1);
    const real = await post(app, batch);
    expect({ ...real.body.data, dryRun: true }).toEqual(dry.body.data);
    expect(rowsOf(db, 'transactions')).toHaveLength(2);
  });

  it('uses Google Sheet as source_file for sheet imports', async () => {
    await post(newApp(), { rows: [row()], source: 'sheet' });
    expect(rowsOf(db, 'transactions')[0].source_file).toBe('Google Sheet');
  });

  it('strips path components from fileName', async () => {
    await post(newApp(), { rows: [row()], source: 'file', fileName: '..\\..\\evil.csv' });
    await post(newApp(), { rows: [row({ amount: -2 })], source: 'file', fileName: 'C:/x/y.csv' });
    expect(rowsOf(db, 'transactions').map((t) => t.source_file)).toEqual(['evil.csv', 'y.csv']);
  });

  it('ignores extra keys (id, created_at, source_file)', async () => {
    await post(newApp(), {
      rows: [{ ...row(), id: 'mine', created_at: '1999-01-01', source_file: 'evil' }],
      source: 'file',
    });
    const [t] = rowsOf(db, 'transactions');
    expect(t.id).not.toBe('mine');
    expect(t.created_at).not.toBe('1999-01-01');
    expect(t.source_file).toBe('CSV import');
  });

  it('stores injection-looking merchants as data', async () => {
    const evil = '"); DROP TABLE transactions;--';
    const link = '=HYPERLINK("http://example.invalid")';
    const res = await post(newApp(), {
      rows: [row({ merchant: evil }), row({ merchant: link, amount: -3 })],
      source: 'file',
    });
    expect(res.status).toBe(200);
    expect(rowsOf(db, 'transactions').map((t) => t.merchant)).toEqual([evil, link]);
  });

  it('only exposes POST', async () => {
    expect((await request(newApp()).get(URL)).status).toBe(404);
  });
});

describe('POST /api/transactions/import validation', () => {
  it.each([
    ['not an object', [1, 2]],
    ['rows missing', { source: 'file' }],
    ['rows not an array', { rows: 'x', source: 'file' }],
    ['rows empty', { rows: [], source: 'file' }],
    ['bad source', { rows: [row()], source: 'api' }],
    ['missing source', { rows: [row()] }],
    ['fileName too long', { rows: [row()], source: 'file', fileName: 'a'.repeat(121) }],
  ])('400 invalid_request: %s', async (_n, body) => {
    const res = await post(newApp(), body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_request');
    expect(typeof res.body.error).toBe('string');
    expect(rowsOf(db, 'transactions')).toHaveLength(0);
  });

  it('400 invalid_rows with details and rejects the whole batch', async () => {
    const res = await post(newApp(), { rows: [row(), row({ date: '2024-02-30' }), row({ amount: 0 })], source: 'file' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_rows');
    expect(res.body.details).toEqual([
      { index: 1, field: 'date' },
      { index: 2, field: 'amount' },
    ]);
    expect(rowsOf(db, 'transactions')).toHaveLength(0);
  });

  it('caps details at 20', async () => {
    const res = await post(newApp(), { rows: Array.from({ length: 100 }, () => row({ merchant: '' })), source: 'file' });
    expect(res.status).toBe(400);
    expect(res.body.details).toHaveLength(20);
  });

  it('accepts 5000 rows and rejects 5001 with 413 too_many_rows', async () => {
    const mk = (n) => ({
      rows: Array.from({ length: n }, (_, i) => row({ merchant: `M${i}`, amount: -(i + 1) })),
      source: 'file',
    });
    const ok = await post(newApp(), mk(5000));
    expect(ok.status).toBe(200);
    expect(ok.body.data.inserted).toBe(5000);
    const big = await post(newApp(), mk(5001));
    expect(big.status).toBe(413);
    expect(big.body.code).toBe('too_many_rows');
    expect(rowsOf(db, 'transactions')).toHaveLength(5000);
  });
});

describe('POST /api/transactions/import failures', () => {
  it('500 server_error without leaking the message, rolls back, audits error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    db.exec(
      "INSERT INTO transactions (id, date, merchant, amount, category, type) VALUES ('pre','2024-01-01','Coffee Shop',-1,'Dining','debit')",
    );
    h.fail = true;
    try {
      const res = await post(newApp(), good());
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Import failed', code: 'server_error' });
      expect(JSON.stringify(res.body)).not.toContain('SECRET_INTERNAL_DETAIL');
      expect(JSON.stringify(spy.mock.calls)).not.toContain('SECRET_INTERNAL_DETAIL');
      expect(rowsOf(db, 'transactions').map((t) => t.id)).toEqual(['pre']);
      expect(recordAudit).toHaveBeenCalledTimes(1);
      expect(recordAudit.mock.calls[0][0]).toMatchObject({
        kind: 'export',
        feature: 'transactions_import',
        status: 'error',
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('503 not_configured when the database cannot be opened', async () => {
    const saved = process.env.BURROW_TEST_DATA_DIR;
    delete process.env.BURROW_TEST_DATA_DIR;
    setDbForTests(null);
    try {
      const res = await post(newApp(), good());
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('not_configured');
      expect(recordAudit.mock.calls[0][0]).toMatchObject({ status: 'error' });
    } finally {
      process.env.BURROW_TEST_DATA_DIR = saved;
      setDbForTests(db);
    }
  });

  it('429 rate_limited after 60 requests, with no-store', async () => {
    const app = newApp();
    const one = { rows: [row()], source: 'file' };
    for (let i = 0; i < 60; i += 1) expect((await post(app, one, '?dryRun=1')).status).toBe(200);
    const res = await post(app, one, '?dryRun=1');
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('rate_limited');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('POST /api/transactions/import audit', () => {
  const batch = () => ({
    rows: [row({ merchant: 'SENTINEL_MERCHANT', amount: -98765.43 })],
    source: 'file',
    fileName: 'sentinel-file.csv',
  });

  it('records ok with counts only', async () => {
    await post(newApp(), batch());
    expect(recordAudit).toHaveBeenCalledTimes(1);
    const event = recordAudit.mock.calls[0][0];
    expect(event).toEqual({
      kind: 'export',
      feature: 'transactions_import',
      status: 'ok',
      meta: { rows: 1, inserted: 1, duplicates: 0, dry_run: false, source: 'file' },
    });
    for (const s of ['SENTINEL_MERCHANT', 'sentinel-file', '98765']) expect(JSON.stringify(event)).not.toContain(s);
  });

  it('records dry runs and duplicates', async () => {
    const app = newApp();
    await post(app, batch());
    recordAudit.mockClear();
    await post(app, batch(), '?dryRun=1');
    expect(recordAudit.mock.calls[0][0].meta).toEqual({
      rows: 1,
      inserted: 0,
      duplicates: 1,
      dry_run: true,
      source: 'file',
    });
  });

  it('records errors without row content', async () => {
    await post(newApp(), {
      rows: [row({ merchant: 'SENTINEL_MERCHANT', amount: 0 })],
      source: 'sheet',
      fileName: 'sentinel-file.csv',
    });
    expect(recordAudit).toHaveBeenCalledTimes(1);
    const event = recordAudit.mock.calls[0][0];
    expect(event).toEqual({
      kind: 'export',
      feature: 'transactions_import',
      status: 'error',
      meta: { rows: 1, inserted: 0, duplicates: 0, dry_run: false, source: 'sheet' },
    });
    expect(JSON.stringify(event)).not.toContain('SENTINEL');
    expect(JSON.stringify(event)).not.toContain('sentinel-file');
  });

  it('still answers when the audit sink throws', async () => {
    setAuditSink(() => {
      throw new Error('sink down');
    });
    expect((await post(newApp(), good())).status).toBe(200);
  });
});

describe('POST /api/transactions/import access', () => {
  it('allows loopback with sign-in off', async () => {
    expect((await post(newApp(), good())).status).toBe(200);
  });

  it('fails closed with 403 auth_required for a non-loopback client when sign-in is off', async () => {
    const res = await post(asNonLoopback(), good());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('auth_required');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(rowsOf(db, 'transactions')).toHaveLength(0);
  });

  it('allows a non-loopback client when sign-in is enabled', async () => {
    expect((await post(asNonLoopback({ authEnabled: true }), good())).status).toBe(200);
  });
});

describe('POST /api/transactions/import through server.js', () => {
  const saved = Object.fromEntries(
    ['SECRETS_ENCRYPTION_KEY', 'APP_PASSWORD', 'AUTH_SECRET'].map((k) => [k, process.env[k]]),
  );
  let app;
  let cookie;
  let ipCounter = 0;
  const nextIp = () => `198.51.100.${(ipCounter += 1)}`;

  beforeAll(async () => {
    delete process.env.SECRETS_ENCRYPTION_KEY;
    process.env.APP_PASSWORD = 'txn-import-pass';
    process.env.AUTH_SECRET = 'txn-import-secret';
    app = (await import('../../server.js')).default;
    const login = await request(app)
      .post('/api/login')
      .set('X-Forwarded-For', nextIp())
      .send({ password: 'txn-import-pass' });
    expect(login.status).toBe(200);
    cookie = login.headers['set-cookie'][0].split(';')[0];
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  afterEach(() => vi.restoreAllMocks());

  const send = (body, { withCookie = true, path = URL, query = '' } = {}) => {
    const r = request(app).post(`${path}${query}`).set('X-Forwarded-For', nextIp());
    return (withCookie ? r.set('Cookie', cookie) : r).send(body);
  };
  const oversized = () => ({ rows: [row({ merchant: 'x'.repeat(4 * 1024 * 1024 + 1024) })], source: 'file' });

  it('401s without a session cookie and imports with one', async () => {
    expect((await send(good(), { withCookie: false })).status).toBe(401);
    expect(rowsOf(db, 'transactions')).toHaveLength(0);
    const ok = await send(good());
    expect(ok.status).toBe(200);
    expect(ok.body.data.inserted).toBe(2);
  });

  it.each(['/API/TRANSACTIONS/IMPORT', '/api/transactions/import/'])('401s for the path variant %s', async (path) => {
    expect((await send(good(), { withCookie: false, path })).status).toBe(401);
  });

  it('rejects a body over 4 MB with JSON 413 too_large (not HTML)', async () => {
    const res = await send(oversized());
    expect(res.status).toBe(413);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.code).toBe('too_large');
    expect(typeof res.body.error).toBe('string');
    expect(rowsOf(db, 'transactions')).toHaveLength(0);
  });

  it('keeps the 413 contract on a case/trailing-slash path variant', async () => {
    const res = await send(oversized(), { path: '/API/transactions/import/' });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('too_large');
  });

  it('accepts ?dryRun=1 behind the gate', async () => {
    const res = await send(good(), { query: '?dryRun=1' });
    expect(res.status).toBe(200);
    expect(res.body.data.dryRun).toBe(true);
    expect(rowsOf(db, 'transactions')).toHaveLength(0);
  });
});
