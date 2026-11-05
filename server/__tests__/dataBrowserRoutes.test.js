// /api/data/* routes against a real, migrated in-memory SQLite database.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { setDbForTests } from '../db/index.js';
import { DATA_TABLES } from '../dataBrowser/tables.js';
import { __resetOverviewCacheForTests, clearOverviewCache, registerDataBrowserRoutes } from '../dataBrowserRoutes.js';
import { closeTestDb, createTestDb, resetDb, seedDb } from './helpers/testDb.js';

let db;
let app;

beforeAll(() => {
  db = createTestDb();
});

afterAll(() => {
  closeTestDb(db);
});

beforeEach(() => {
  vi.restoreAllMocks();
  __resetOverviewCacheForTests();
  setDbForTests(db);
  resetDb(db);
  app = express();
  registerDataBrowserRoutes(app);
});

const tx = (merchant, over = {}) => ({ merchant, date: '2026-01-15', amount: -2, category: 'food', type: 'debit', ...over });

/** Runs fn with the singleton cleared and no test data dir, so getDb() fails. */
async function withoutDatabase(fn) {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const saved = process.env.BURROW_TEST_DATA_DIR;
  setDbForTests(null);
  delete process.env.BURROW_TEST_DATA_DIR;
  try {
    return await fn();
  } finally {
    process.env.BURROW_TEST_DATA_DIR = saved;
    setDbForTests(db);
  }
}

describe('allowlist', () => {
  it.each(['app_secrets', 'audit_log', 'users', '__proto__', 'constructor'])('404s unknown table %s', async (t) => {
    const res = await request(app).get(`/api/data/tables/${t}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Unknown table', code: 'unknown_table' });
    expect((await request(app).get(`/api/data/tables/${t}/overview`)).status).toBe(404);
  });

  it('never lists app_secrets or audit_log', async () => {
    const res = await request(app).get('/api/data/tables');
    const ids = res.body.tables.map((t) => t.id);
    expect(ids).not.toContain('app_secrets');
    expect(ids).not.toContain('audit_log');
  });
});

describe('GET /api/data/tables', () => {
  it('returns real counts for all 15 tables with no-store', async () => {
    seedDb(db, { transactions: [tx('a'), tx('b'), tx('c')] });
    const res = await request(app).get('/api/data/tables');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.tables).toHaveLength(DATA_TABLES.length);
    const byId = Object.fromEntries(res.body.tables.map((t) => [t.id, t]));
    expect(byId.transactions).toMatchObject({
      count: 3,
      status: 'ok',
      group: 'Money',
      hasDateChart: true,
      hasAmountChart: true,
    });
    expect(byId.notes).toMatchObject({ count: 0, status: 'ok' });
    expect(byId.habits.hasAmountChart).toBe(false);
  });

  it('reports a per-table failure as unavailable while the others stay ok', async () => {
    const broken = createTestDb();
    broken.exec('DROP TABLE notes');
    const res = await request(app).get('/api/data/tables');
    closeTestDb(broken);
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.tables.map((t) => [t.id, t]));
    expect(byId.notes).toMatchObject({ count: null, status: 'unavailable' });
    expect(byId.todos).toMatchObject({ count: 0, status: 'ok' });
  });

  it('503s with code not_configured when the database cannot be opened', async () => {
    const res = await withoutDatabase(() => request(app).get('/api/data/tables'));
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'Local database is unavailable.', code: 'not_configured' });
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('GET /api/data/tables/:table', () => {
  it('returns the configured columns, metadata and a PK tiebreak', async () => {
    seedDb(db, {
      transactions: [
        { id: 'b', ...tx('Same', { date: '2026-02-01' }) },
        { id: 'a', ...tx('Same', { date: '2026-02-01' }) },
        { id: 'c', ...tx('Other', { date: '2026-03-01' }) },
      ],
    });
    const res = await request(app).get('/api/data/tables/transactions');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({
      table: 'transactions',
      primaryKey: 'id',
      amountColumn: 'amount',
      page: 1,
      pageSize: 25,
      total: 3,
      sort: 'date',
      order: 'desc',
      q: '',
    });
    expect(res.body.rows.map((r) => r.id)).toEqual(['c', 'a', 'b']);
    expect(Object.keys(res.body.rows[0]).sort()).toEqual(
      ['amount', 'category', 'created_at', 'date', 'id', 'merchant', 'source_file', 'type'],
    );
    expect(res.body.columns.find((c) => c.name === 'amount')).toEqual({ name: 'amount', type: 'numeric', sortable: true });
    expect(res.body.columns.find((c) => c.name === 'id').sortable).toBe(false);
  });

  it('pages with page and pageSize and reports the full total', async () => {
    seedDb(db, {
      notes: Array.from({ length: 7 }, (_, i) => ({ body: `n${i}`, created_at: `2026-01-0${i + 1}T00:00:00.000Z` })),
    });
    const res = await request(app).get('/api/data/tables/notes?pageSize=3&page=2');
    expect(res.body.rows.map((r) => r.body)).toEqual(['n3', 'n2', 'n1']);
    expect(res.body.total).toBe(7);
  });

  it.each([
    ['page=0', 'invalid_page'],
    ['pageSize=101', 'invalid_page_size'],
    ['sort=amount;drop', 'invalid_sort'],
    ['order=up', 'invalid_order'],
    [`q=${'a'.repeat(101)}`, 'invalid_query'],
    ['page=1001&pageSize=100', 'invalid_page'],
  ])('400s on %s', async (qs, code) => {
    const res = await request(app).get(`/api/data/tables/transactions?${qs}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(code);
  });

  it('returns an empty page with the true filtered total when the page is past the end', async () => {
    seedDb(db, { transactions: [tx('Acme'), tx('Acme Two'), tx('Other')] });
    const res = await request(app).get('/api/data/tables/transactions?page=50&q=acme');
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([]);
    expect(res.body.total).toBe(2);
    expect(res.body.q).toBe('acme');
  });

  it('searches case-insensitively with Unicode folding across the search columns', async () => {
    seedDb(db, { transactions: [tx('MUÑOZ Cafe'), tx('Shop', { category: 'Muñoz gifts' }), tx('Other')] });
    const res = await request(app).get('/api/data/tables/transactions').query({ q: 'muñoz' });
    expect(res.body.total).toBe(2);
    expect(res.body.rows.map((r) => r.merchant).sort()).toEqual(['MUÑOZ Cafe', 'Shop']);
  });

  it('treats _ as a literal character and strips % from the term', async () => {
    seedDb(db, { transactions: [tx('a_b'), tx('axb'), tx('50% off'), tx('500 club')] });
    const underscore = await request(app).get('/api/data/tables/transactions').query({ q: 'a_b' });
    expect(underscore.body.rows.map((r) => r.merchant)).toEqual(['a_b']);
    const percent = await request(app).get('/api/data/tables/transactions').query({ q: '50%' });
    expect(percent.body.q).toBe('50');
    expect(percent.body.total).toBe(2);
  });

  it('keeps hostile search text inert', async () => {
    seedDb(db, { transactions: [tx('Acme')] });
    const res = await request(app).get('/api/data/tables/transactions').query({ q: "x'; DROP TABLE transactions; --" });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect((await request(app).get('/api/data/tables/transactions')).body.total).toBe(1);
  });

  it('puts nulls last in both sort directions', async () => {
    seedDb(db, { transactions: [tx('a', { amount: 5 }), tx('b', { amount: null }), tx('c', { amount: 1 })] });
    const asc = await request(app).get('/api/data/tables/transactions?sort=amount&order=asc');
    expect(asc.body.rows.map((r) => r.merchant)).toEqual(['c', 'a', 'b']);
    const desc = await request(app).get('/api/data/tables/transactions?sort=amount&order=desc');
    expect(desc.body.rows.map((r) => r.merchant)).toEqual(['a', 'c', 'b']);
  });

  it('sorts text columns case-insensitively', async () => {
    seedDb(db, { transactions: [tx('banana'), tx('Apple'), tx('cherry')] });
    const res = await request(app).get('/api/data/tables/transactions?sort=merchant&order=asc');
    expect(res.body.rows.map((r) => r.merchant)).toEqual(['Apple', 'banana', 'cherry']);
  });

  it('decodes booleans and arrays for display', async () => {
    seedDb(db, {
      todos: [{ title: 'T', done: true }],
      journal: [{ body: 'B', tags: ['x', 'y'] }],
    });
    expect((await request(app).get('/api/data/tables/todos')).body.rows[0].done).toBe(true);
    expect((await request(app).get('/api/data/tables/journal')).body.rows[0].tags).toEqual(['x', 'y']);
  });

  it('hides database errors behind a generic 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = createTestDb();
    broken.exec('DROP TABLE notes');
    const res = await request(app).get('/api/data/tables/notes');
    closeTestDb(broken);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Server error', code: 'server_error' });
    expect(res.text).not.toMatch(/sqlite|no such table/i);
  });

  it('redacts app_state rows', async () => {
    seedDb(db, {
      app_state: [
        { key: 'openai.apiKey', value: 'sk-live-should-not-show-0000' },
        { key: 'budget:targets', value: { food: 5, token: 'abc' } },
        { key: 'jarvis.note', value: 'sk-abcdef0123456789abcd' },
      ],
    });
    const res = await request(app).get('/api/data/tables/app_state?sort=key&order=asc');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('sk-live-should-not-show');
    expect(res.text).not.toContain('abc"');
    const byKey = Object.fromEntries(res.body.rows.map((r) => [r.key, r.value]));
    expect(byKey['openai.apiKey']).toBe('[redacted]');
    expect(byKey['budget:targets']).toEqual({ food: 5, token: '[redacted]' });
    expect(byKey['jarvis.note']).toBe('[redacted]');
  });
});

describe('GET /api/data/tables/:table/overview', () => {
  it('aggregates by month and reads only the date and amount columns', async () => {
    seedDb(db, {
      transactions: [tx('a', { date: '2026-01-15', amount: 10 }), tx('b', { date: '2026-03-01', amount: -4 })],
    });
    const res = await request(app).get('/api/data/tables/transactions/overview');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({
      table: 'transactions',
      dateColumn: 'date',
      granularity: 'month',
      sampled: 2,
      undated: 0,
      truncated: false,
    });
    expect(res.body.rowsOverTime.map((r) => r.period)).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(res.body.amountByMonth[0]).toEqual({ period: '2026-01', income: 10, expenses: 0, net: 10 });
  });

  it('flags truncated only when more than the 20,000-row cap exist', async () => {
    seedDb(db, { transactions: Array.from({ length: 20000 }, () => tx('x')) });
    const exact = await request(app).get('/api/data/tables/transactions/overview');
    expect(exact.body.sampled).toBe(20000);
    expect(exact.body.truncated).toBe(false);

    __resetOverviewCacheForTests();
    seedDb(db, { transactions: [tx('one more')] });
    const over = await request(app).get('/api/data/tables/transactions/overview');
    expect(over.body.sampled).toBe(20000);
    expect(over.body.truncated).toBe(true);
  }, 30000);

  it('caches an overview per table for 120s, then rescans', async () => {
    seedDb(db, { transactions: [tx('a')] });
    const first = await request(app).get('/api/data/tables/transactions/overview');
    seedDb(db, { transactions: [tx('b')] });
    const second = await request(app).get('/api/data/tables/transactions/overview');
    expect(second.body).toEqual(first.body);
    expect(second.body.sampled).toBe(1);
    expect(second.headers['cache-control']).toBe('no-store');

    const real = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(real + 121_000);
    const third = await request(app).get('/api/data/tables/transactions/overview');
    expect(third.body.sampled).toBe(2);
  });

  it('clearOverviewCache empties the cache at once, so old totals are not served after a data reset', async () => {
    seedDb(db, { transactions: [tx('a'), tx('b')] });
    const first = await request(app).get('/api/data/tables/transactions/overview');
    expect(first.body.sampled).toBe(2);
    db.exec('DELETE FROM transactions');
    // Control: still the cached body.
    expect((await request(app).get('/api/data/tables/transactions/overview')).body.sampled).toBe(2);
    clearOverviewCache();
    const after = await request(app).get('/api/data/tables/transactions/overview');
    expect(after.body.sampled).toBe(0);
    expect(after.body.rowsOverTime).toEqual([]);
  });

  it('shares one scan between concurrent requests for the same table', async () => {
    seedDb(db, { transactions: [tx('a')] });
    const [ra, rb] = await Promise.all([
      request(app).get('/api/data/tables/transactions/overview'),
      request(app).get('/api/data/tables/transactions/overview'),
    ]);
    expect(ra.status).toBe(200);
    expect(rb.body).toEqual(ra.body);
  });

  it('does not cache failures', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = createTestDb();
    broken.exec('DROP TABLE transactions');
    expect((await request(app).get('/api/data/tables/transactions/overview')).status).toBe(500);
    closeTestDb(broken);
    setDbForTests(db);
    seedDb(db, { transactions: [tx('a')] });
    expect((await request(app).get('/api/data/tables/transactions/overview')).status).toBe(200);
  });

  it('has its own limiter: 30 per 15 minutes, then 429 rate_limited with no-store', async () => {
    for (let i = 0; i < 30; i += 1) {
      expect((await request(app).get('/api/data/tables/notes/overview')).status).toBe(200);
    }
    const limited = await request(app).get('/api/data/tables/notes/overview');
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: 'Too many requests, please try again later.', code: 'rate_limited' });
    expect(limited.headers['cache-control']).toBe('no-store');
    // The limiter is scoped to the overview route only.
    expect((await request(app).get('/api/data/tables/notes')).status).toBe(200);
  });

  it('omits amountByMonth for tables without an amount column', async () => {
    seedDb(db, { notes: [{ body: 'x', created_at: '2026-02-03T00:00:00.000Z' }] });
    const res = await request(app).get('/api/data/tables/notes/overview');
    expect(res.body.amountByMonth).toBeUndefined();
    expect(res.body.rowsOverTime).toEqual([{ period: '2026-02', count: 1 }]);
  });

  it('503s when the database cannot be opened', async () => {
    const res = await withoutDatabase(() => request(app).get('/api/data/tables/notes/overview'));
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('not_configured');
  });
});
