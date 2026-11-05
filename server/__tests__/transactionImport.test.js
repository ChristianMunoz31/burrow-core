// Transaction import library: pure helpers plus importTransactions against a real temp SQLite DB.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, createTestDb, resetDb, rowsOf, seedDb } from './helpers/testDb.js';
import { insert } from '../db/query.js';
import {
  IMPORT_SOURCES,
  MAX_IMPORT_ROWS,
  TransactionImportError,
  cleanFileName,
  dedupeKey,
  findDuplicateIndexes,
  importTransactions,
  isRealDate,
  normalizeMerchant,
  toCents,
  validateImportBody,
} from '../import/transactionImport.js';

let db;
beforeAll(() => {
  db = createTestDb();
});
beforeEach(() => resetDb(db));
afterAll(() => closeTestDb(db));

const row = (over = {}) => ({ date: '2024-03-05', merchant: 'Corner Grocery', amount: -12.34, category: 'Groceries', ...over });
const body = (rows, extra = {}) => ({ rows, source: 'file', ...extra });
const run = (rows, opts = {}) =>
  importTransactions({ body: body(rows, opts.body), dryRun: opts.dryRun, db, ...(opts.deps ? { deps: opts.deps } : {}) });
const txns = () => rowsOf(db, 'transactions');
const catchErr = (fn) => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected a throw');
};

describe('pure helpers', () => {
  it('exposes the limits and sources', () => {
    expect(MAX_IMPORT_ROWS).toBe(5000);
    expect([...IMPORT_SOURCES]).toEqual(['file', 'sheet']);
  });

  it('normalizeMerchant folds case, punctuation, whitespace and NFKC', () => {
    expect(normalizeMerchant('  CORNER   Grocery!! ')).toBe('corner grocery');
    expect(normalizeMerchant('Corner-Grocery #12')).toBe('corner grocery 12');
    expect(normalizeMerchant('\uFF23offee Shop')).toBe('coffee shop'); // fullwidth C
    expect(normalizeMerchant('Caf\u00E9')).toBe('caf\u00E9');
    expect(normalizeMerchant('***')).toBe('');
  });

  it('toCents rounds to integer cents without float drift', () => {
    expect(toCents(12.34)).toBe(1234);
    expect(toCents(-0.1 - 0.2)).toBe(-30);
    expect(toCents(19.99)).toBe(1999);
    expect(Number.isInteger(toCents(0.07))).toBe(true);
  });

  it('dedupeKey ignores merchant formatting but not date, sign or a cent', () => {
    const base = dedupeKey(row());
    expect(dedupeKey(row({ merchant: 'corner grocery.' }))).toBe(base);
    expect(dedupeKey(row({ amount: '-12.34' }))).toBe(base);
    expect(dedupeKey(row({ amount: 12.34 }))).not.toBe(base);
    expect(dedupeKey(row({ amount: -12.35 }))).not.toBe(base);
    expect(dedupeKey(row({ date: '2024-03-06' }))).not.toBe(base);
    expect(dedupeKey(row({ merchant: 'Coffee Shop' }))).not.toBe(base);
  });

  it.each([
    ['2024-02-29', true],
    ['2023-02-29', false],
    ['2024-02-30', false],
    ['2024-13-01', false],
    ['2024-00-10', false],
    ['2024-04-31', false],
    ['1899-12-31', false],
    ['1900-01-01', true],
    ['2100-12-31', true],
    ['2101-01-01', false],
    ['2024-3-5', false],
    ['03/05/2024', false],
    ['2024-03-05T00:00:00Z', false],
    [20240305, false],
    [null, false],
  ])('isRealDate(%j) is %s', (value, expected) => {
    expect(isRealDate(value)).toBe(expected);
  });

  it('cleanFileName keeps only the basename and strips control characters', () => {
    expect(cleanFileName('statement.csv')).toBe('statement.csv');
    expect(cleanFileName('..\\..\\evil.csv')).toBe('evil.csv');
    expect(cleanFileName('C:/x/y.csv')).toBe('y.csv');
    expect(cleanFileName('/etc/passwd')).toBe('passwd');
    expect(cleanFileName('a\u0000b\nc.csv')).toBe('abc.csv');
    expect(cleanFileName('dir/')).toBe('');
    expect(cleanFileName(undefined)).toBe('');
    expect(cleanFileName(42)).toBe('');
  });
});

describe('findDuplicateIndexes', () => {
  it('returns [] with no existing rows', () => {
    expect(findDuplicateIndexes([row(), row()], [])).toEqual([]);
  });

  it('matches across merchant variants and numeric-string amounts', () => {
    const existing = [{ date: '2024-03-05', merchant: 'CORNER GROCERY', amount: '-12.34' }];
    expect(findDuplicateIndexes([row({ merchant: 'corner  grocery.' })], existing)).toEqual([0]);
  });

  it('uses multiset semantics: first occurrences in the batch are the duplicates', () => {
    const existing = [{ date: '2024-03-05', merchant: 'Corner Grocery', amount: -12.34 }];
    expect(findDuplicateIndexes([row(), row(), row()], existing)).toEqual([0]);
    const two = [existing[0], existing[0]];
    expect(findDuplicateIndexes([row(), row({ merchant: 'Coffee Shop' }), row(), row()], two)).toEqual([0, 2]);
  });

  it('does not match on different sign, cent, date or merchant', () => {
    const existing = [{ date: '2024-03-05', merchant: 'Corner Grocery', amount: -12.34 }];
    const rows = [row({ amount: 12.34 }), row({ amount: -12.35 }), row({ date: '2024-03-06' }), row({ merchant: 'Coffee Shop' })];
    expect(findDuplicateIndexes(rows, existing)).toEqual([]);
  });
});

describe('validateImportBody', () => {
  const code = (b) => catchErr(() => validateImportBody(b));

  it('cleans category like merchant and rejects when empty or too long after cleaning', () => {
    const out = validateImportBody(body([row({ category: '  Eating\u0007  \n Out  ' })]));
    expect(out.rows[0].category).toBe('Eating Out');
    expect(code(body([row({ category: '\u0007 \u0001' })]))).toBeDefined();
    expect(validateImportBody(body([row({ category: ' ' + 'c'.repeat(60) + ' ' })])).rows[0].category).toHaveLength(60);
    expect(code(body([row({ category: 'c'.repeat(61) })]))).toBeDefined();
  });

  it('returns cleaned rows, source and fileName', () => {
    const out = validateImportBody(
      body([row({ merchant: '  Coffee\u0007 Shop ', category: ' Dining ' })], { fileName: 'C:/x/y.csv' }),
    );
    expect(out).toEqual({
      rows: [{ date: '2024-03-05', merchant: 'Coffee Shop', amount: -12.34, category: 'Dining' }],
      source: 'file',
      fileName: 'y.csv',
    });
  });

  it.each([null, undefined, 'x', 5, [], [row()], {}, { source: 'file' }, { rows: 'nope', source: 'file' }, { rows: {}, source: 'file' }])(
    'rejects body %j as 400 invalid_request',
    (b) => {
      const e = code(b);
      expect(e).toBeInstanceOf(TransactionImportError);
      expect([e.status, e.code]).toEqual([400, 'invalid_request']);
    },
  );

  it.each([undefined, null, 'csv', 'FILE', 'Sheet', '', 1, {}])('rejects source %j', (source) => {
    const e = code({ rows: [row()], source });
    expect([e.status, e.code]).toEqual([400, 'invalid_request']);
  });

  it('rejects an empty rows array', () => {
    const e = code(body([]));
    expect([e.status, e.code]).toEqual([400, 'invalid_request']);
  });

  it('rejects a non-string or 121-char fileName; accepts 120 and null', () => {
    expect(code(body([row()], { fileName: 5 })).code).toBe('invalid_request');
    expect(code(body([row()], { fileName: 'a'.repeat(121) })).code).toBe('invalid_request');
    expect(validateImportBody(body([row()], { fileName: `${'a'.repeat(116)}.csv` })).fileName).toHaveLength(120);
    expect(validateImportBody(body([row()], { fileName: null })).fileName).toBe('');
  });

  it('accepts exactly 5000 rows and rejects 5001 with 413 too_many_rows', () => {
    expect(validateImportBody(body(Array.from({ length: 5000 }, () => row()))).rows).toHaveLength(5000);
    const e = code(body(Array.from({ length: 5001 }, () => row())));
    expect([e.status, e.code]).toEqual([413, 'too_many_rows']);
  });

  const fieldOf = (r) => {
    const e = code(body([r]));
    expect([e.status, e.code]).toEqual([400, 'invalid_rows']);
    return e.details;
  };

  it.each([
    ['date', { date: '2024/03/05' }],
    ['date', { date: '2024-02-30' }],
    ['date', { date: '2023-02-29' }],
    ['date', { date: '1899-01-01' }],
    ['date', { date: '2101-01-01' }],
    ['date', { date: undefined }],
    ['merchant', { merchant: '' }],
    ['merchant', { merchant: '   ' }],
    ['merchant', { merchant: '\u0001\u0002' }],
    ['merchant', { merchant: 'x'.repeat(201) }],
    ['merchant', { merchant: 42 }],
    ['merchant', { merchant: undefined }],
    ['amount', { amount: 0 }],
    ['amount', { amount: -0 }],
    ['amount', { amount: NaN }],
    ['amount', { amount: Infinity }],
    ['amount', { amount: -Infinity }],
    ['amount', { amount: '12.34' }],
    ['amount', { amount: null }],
    ['amount', { amount: 1e9 + 1 }],
    ['amount', { amount: -1e9 - 1 }],
    ['amount', { amount: 0.004 }],
    ['amount', { amount: -0.004 }],
    ['amount', { amount: undefined }],
    ['category', { category: '' }],
    ['category', { category: '  ' }],
    ['category', { category: 'c'.repeat(61) }],
    ['category', { category: 7 }],
    ['category', { category: undefined }],
  ])('flags field %s for %j', (field, over) => {
    expect(fieldOf(row(over))).toEqual([{ index: 0, field }]);
  });

  it('accepts boundary values', () => {
    const out = validateImportBody(
      body([
        row({ merchant: 'x'.repeat(200), category: 'c'.repeat(60), amount: 1e9 }),
        row({ amount: -1e9, date: '2024-02-29' }),
        row({ amount: 0.005 }),
        row({ merchant: 'a', date: '1900-01-01' }),
        row({ date: '2100-12-31' }),
      ]),
    );
    expect(out.rows).toHaveLength(5);
  });

  it('flags a non-object row as "row" and reports every bad row index', () => {
    const e = code(body([row(), null, 'x', [], row({ date: 'bad' })]));
    expect(e.details).toEqual([
      { index: 1, field: 'row' },
      { index: 2, field: 'row' },
      { index: 3, field: 'row' },
      { index: 4, field: 'date' },
    ]);
  });

  it('reports each failing field of one row', () => {
    const e = code(body([row({ date: 'x', amount: 0, category: '' })]));
    expect(e.details).toEqual([
      { index: 0, field: 'date' },
      { index: 0, field: 'amount' },
      { index: 0, field: 'category' },
    ]);
  });

  it('caps details at 20', () => {
    const e = code(body(Array.from({ length: 50 }, () => row({ date: 'bad' }))));
    expect(e.details).toHaveLength(20);
    expect(e.details[19]).toEqual({ index: 19, field: 'date' });
  });

  it('drops unknown keys from rows', () => {
    const out = validateImportBody(
      body([{ ...row(), id: 'x', created_at: '2000-01-01', source_file: 'evil', type: 'credit' }]),
    );
    expect(Object.keys(out.rows[0]).sort()).toEqual(['amount', 'category', 'date', 'merchant']);
  });
});

describe('importTransactions', () => {
  const existingGrocery = {
    date: '2024-03-05',
    merchant: 'Corner Grocery',
    amount: -12.34,
    category: 'Groceries',
    type: 'debit',
  };

  it('inserts rows with signed amounts, derived type and source_file', () => {
    const res = run(
      [row(), row({ merchant: 'Employer Payroll', amount: 2500, category: 'Income', date: '2024-03-07' })],
      { body: { fileName: 'C:\\docs\\march.csv' } },
    );
    expect(res).toMatchObject({ received: 2, inserted: 2, duplicates: 0, duplicateIndexes: [], dryRun: false, source: 'file' });
    const stored = txns();
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({
      date: '2024-03-05',
      merchant: 'Corner Grocery',
      category: 'Groceries',
      type: 'debit',
      source_file: 'march.csv',
    });
    expect(toCents(Number(stored[0].amount))).toBe(-1234);
    expect(stored[1]).toMatchObject({ merchant: 'Employer Payroll', type: 'credit', source_file: 'march.csv' });
    expect(toCents(Number(stored[1].amount))).toBe(250000);
  });

  it.each([
    ['sheet', undefined, 'Google Sheet'],
    ['file', undefined, 'CSV import'],
    ['file', '../', 'CSV import'],
    ['sheet', 'my.csv', 'my.csv'],
  ])('source %s with fileName %j stores source_file %j', (source, fileName, expected) => {
    importTransactions({ body: { rows: [row()], source, fileName }, db });
    expect(txns()[0].source_file).toBe(expected);
  });

  it('never writes extra row keys', () => {
    run([{ ...row(), id: 'fixed-id', created_at: '1999-01-01T00:00:00.000Z', source_file: 'evil.csv', type: 'credit' }]);
    const [t] = txns();
    expect(t.id).not.toBe('fixed-id');
    expect(t.created_at).not.toBe('1999-01-01T00:00:00.000Z');
    expect(t.source_file).toBe('CSV import');
    expect(t.type).toBe('debit');
  });

  it('stores injection-looking merchants verbatim as data', () => {
    const evil = [
      '"); DROP TABLE transactions;--',
      '=HYPERLINK("http://example.invalid","x")',
      "Robert'); DELETE FROM transactions;--",
    ];
    run(evil.map((merchant, i) => row({ merchant, amount: -(i + 1) })));
    expect(txns().map((t) => t.merchant)).toEqual(evil);
    expect(db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n).toBe(3);
  });

  it('strips control characters from merchants before storing', () => {
    run([row({ merchant: 'Coffee\u0000\u0007 \tShop' })]);
    expect(txns()[0].merchant).toBe('Coffee Shop');
  });

  it('re-importing the same file is all duplicates and inserts nothing', () => {
    const rows = [
      row(),
      row({ merchant: 'Coffee Shop', amount: -4.5, category: 'Dining' }),
      row({ merchant: 'Employer Payroll', amount: 2500, category: 'Income' }),
    ];
    run(rows);
    const again = run(rows);
    expect(again).toMatchObject({ received: 3, inserted: 0, duplicates: 3, duplicateIndexes: [0, 1, 2] });
    expect(txns()).toHaveLength(3);
  });

  it('dedupes across merchant formatting variants', () => {
    run([row()]);
    const res = run([row({ merchant: 'CORNER  GROCERY!' })]);
    expect(res).toMatchObject({ inserted: 0, duplicates: 1, duplicateIndexes: [0] });
  });

  it('does not dedupe a different sign or a different cent', () => {
    run([row()]);
    const res = run([row({ amount: 12.34 }), row({ amount: -12.35 })]);
    expect(res).toMatchObject({ inserted: 2, duplicates: 0, duplicateIndexes: [] });
  });

  it('multiset: DB has 1, batch has 2 identical -> 1 duplicate (first), 1 new', () => {
    seedDb(db, { transactions: [existingGrocery] });
    const res = run([row(), row()]);
    expect(res).toMatchObject({ received: 2, inserted: 1, duplicates: 1, duplicateIndexes: [0] });
    expect(txns()).toHaveLength(2);
  });

  it('multiset: DB has 0, batch has 2 identical -> both new', () => {
    const res = run([row(), row()]);
    expect(res).toMatchObject({ inserted: 2, duplicates: 0, duplicateIndexes: [] });
    expect(txns()).toHaveLength(2);
  });

  it('duplicateIndexes point at the right batch positions', () => {
    seedDb(db, {
      transactions: [
        { date: '2024-03-05', merchant: 'Coffee Shop', amount: -4.5, category: 'Dining', type: 'debit' },
        { date: '2024-03-09', merchant: 'Employer Payroll', amount: 2500, category: 'Income', type: 'credit' },
      ],
    });
    const res = run([
      row(),
      row({ merchant: 'coffee shop', amount: -4.5 }),
      row({ merchant: 'Corner Grocery', date: '2024-03-08' }),
      row({ merchant: 'Employer Payroll', amount: 2500, date: '2024-03-09' }),
    ]);
    expect(res.duplicateIndexes).toEqual([1, 3]);
    expect(res).toMatchObject({ inserted: 2, duplicates: 2 });
  });

  it('existing rows outside the batch date range do not matter', () => {
    seedDb(db, { transactions: [{ ...existingGrocery, date: '2023-01-01' }] });
    const res = run([row()]);
    expect(res).toMatchObject({ inserted: 1, duplicates: 0 });
  });

  it('dry run writes nothing but returns the same counts as the real run', () => {
    seedDb(db, { transactions: [existingGrocery] });
    const rows = [row(), row(), row({ merchant: 'Coffee Shop', amount: -4.5 })];
    const dry = run(rows, { dryRun: true });
    expect(txns()).toHaveLength(1);
    const real = run(rows);
    expect(dry.dryRun).toBe(true);
    expect(real.dryRun).toBe(false);
    expect({ ...dry, dryRun: null }).toEqual({ ...real, dryRun: null });
    expect(txns()).toHaveLength(1 + real.inserted);
  });

  it('propagates validation errors and writes nothing', () => {
    const e = catchErr(() => run([row(), row({ amount: 0 })]));
    expect(e).toBeInstanceOf(TransactionImportError);
    expect(e.code).toBe('invalid_rows');
    expect(txns()).toHaveLength(0);
  });

  it('imports 5000 rows in one go', () => {
    const rows = Array.from({ length: 5000 }, (_, i) => row({ merchant: `Merchant ${i}`, amount: -(i + 1) }));
    expect(run(rows)).toMatchObject({ received: 5000, inserted: 5000 });
    expect(txns()).toHaveLength(5000);
  });

  it('rolls back every row when an insert fails part-way, leaving existing rows untouched', () => {
    seedDb(db, {
      transactions: [{ date: '2024-01-01', merchant: 'Employer Payroll', amount: 100, category: 'Income', type: 'credit' }],
    });
    const before = txns();
    const insertMany = (table, rows, { db: tx }) => {
      insert(table, rows[0], { db: tx });
      throw new Error('boom');
    };
    expect(() => run([row(), row({ merchant: 'Coffee Shop', amount: -4.5 })], { deps: { insertMany } })).toThrow('boom');
    expect(txns()).toEqual(before);
  });
});
