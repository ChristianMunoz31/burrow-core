import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  count,
  insert,
  insertMany,
  op,
  remove,
  select,
  selectOne,
  update,
  updateById,
  upsert,
} from '../db/index.js';
import { closeTestDb, createTestDb, resetDb, rowsOf, seedDb } from './helpers/testDb.js';

let db;
beforeAll(() => {
  db = createTestDb();
});
beforeEach(() => resetDb(db));
afterAll(() => closeTestDb(db));

const codeOf = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.code;
  }
  return null;
};

const seedTxns = () =>
  seedDb(db, {
    transactions: [
      { id: 't1', date: '2026-01-01', merchant: 'Alpha', amount: 10, category: 'food', type: 'Debit' },
      { id: 't2', date: '2026-01-02', merchant: 'Beta', amount: 20.5, category: null, type: 'Credit' },
      { id: 't3', date: '2026-01-03', merchant: 'Gamma', amount: 30, category: 'fun', type: 'Debit' },
      { id: 't4', date: '2026-01-03', merchant: 'Delta', amount: 40, category: 'food', type: 'Debit' },
    ],
  });

describe('where', () => {
  beforeEach(seedTxns);
  const ids = (where) => select('transactions', { columns: ['id'], where, orderBy: [{ column: 'id' }] }).map((r) => r.id);

  it('scalar equality and null', () => {
    expect(ids({ category: 'food' })).toEqual(['t1', 't4']);
    expect(ids({ category: null })).toEqual(['t2']);
  });
  it('operators', () => {
    expect(ids({ amount: op.gt(20.5) })).toEqual(['t3', 't4']);
    expect(ids({ amount: op.gte(20.5) })).toEqual(['t2', 't3', 't4']);
    expect(ids({ amount: op.lt(20.5) })).toEqual(['t1']);
    expect(ids({ amount: op.lte(20.5) })).toEqual(['t1', 't2']);
    expect(ids({ amount: op.and(op.gt(10), op.lt(40)) })).toEqual(['t2', 't3']);
    expect(ids({ type: op.eq('Credit') })).toEqual(['t2']);
    expect(ids({ type: op.ne('Debit') })).toEqual(['t2']);
    expect(ids({ category: op.ne(null) })).toEqual(['t1', 't3', 't4']);
    expect(ids({ category: op.eq(null) })).toEqual(['t2']);
  });
  it('in, including empty', () => {
    expect(ids({ id: op.in(['t1', 't3', 'zz']) })).toEqual(['t1', 't3']);
    expect(ids({ id: op.in([]) })).toEqual([]);
  });
  it('$or combines with sibling keys', () => {
    expect(ids({ $or: [{ id: 't1' }, { id: 't3' }], category: 'food' })).toEqual(['t1']);
    expect(ids({ $or: [{ id: 't1' }, { amount: op.gt(35) }] })).toEqual(['t1', 't4']);
    expect(ids({ $or: [] })).toEqual([]);
  });
  it('normalizes cursor timestamps to canonical form', () => {
    seedDb(db, { notes: [{ id: 'n1', body: 'x', created_at: '2026-02-01T00:00:00.000Z' }] });
    const rows = select('notes', { where: { created_at: op.gte('2026-02-01T00:00:00.000000+00:00') } });
    expect(rows).toHaveLength(1);
  });
  it('throws on undefined condition values', () => {
    expect(codeOf(() => select('transactions', { where: { id: undefined } }))).toBe('invalid_query');
  });
  it('count honors where', () => {
    expect(count('transactions')).toBe(4);
    expect(count('transactions', { where: { category: 'food' } })).toBe(2);
  });
});

describe('search', () => {
  it('is case-insensitive, unicode-aware, and treats wildcards literally', () => {
    seedDb(db, {
      transactions: [
        { id: 's1', merchant: 'Café MUÑOZ', amount: 1 },
        { id: 's2', merchant: '50% off', amount: 1 },
        { id: 's3', merchant: 'a_b', amount: 1 },
        { id: 's4', merchant: 'back\\slash', amount: 1 },
        { id: 's5', merchant: 'plain', category: 'MuÑoz store', amount: 1 },
      ],
    });
    const found = (term, columns = ['merchant']) =>
      select('transactions', { columns: ['id'], search: { columns, term }, orderBy: [{ column: 'id' }] }).map((r) => r.id);
    expect(found('muñoz')).toEqual(['s1']);
    expect(found('MUÑOZ', ['merchant', 'category'])).toEqual(['s1', 's5']);
    expect(found('%')).toEqual(['s2']);
    expect(found('_')).toEqual(['s3']);
    expect(found('\\')).toEqual(['s4']);
    expect(found('a_b')).toEqual(['s3']);
    expect(found('   ')).toHaveLength(5);
    expect(select('transactions', { search: { columns: [], term: 'x' } })).toHaveLength(5);
    expect(count('transactions', { search: { columns: ['merchant'], term: 'plain' } })).toBe(1);
  });
  it('binds the term (injection text is just text)', () => {
    seedDb(db, { transactions: [{ id: 'i1', merchant: 'x', amount: 1 }] });
    expect(select('transactions', { search: { columns: ['merchant'], term: "'; DROP TABLE transactions; --" } })).toEqual([]);
    expect(count('transactions')).toBe(1);
  });
});

describe('query validation', () => {
  it('rejects a non-array orderBy and duplicate op.and operators', () => {
    seedTxns();
    expect(codeOf(() => select('transactions', { orderBy: { column: 'id' } }))).toBe('invalid_query');
    expect(codeOf(() => select('transactions', { orderBy: 'id' }))).toBe('invalid_query');
    expect(codeOf(() => op.and(op.gt(1), op.gt(2)))).toBe('invalid_query');
  });
});

describe('orderBy / limit / offset', () => {
  beforeEach(() => {
    seedTxns();
  });
  const ids = (opts) => select('transactions', { columns: ['id'], ...opts }).map((r) => r.id);

  it('mirrors PG null placement: asc nulls last, desc nulls first', () => {
    expect(ids({ orderBy: [{ column: 'category' }, { column: 'id' }] })).toEqual(['t1', 't4', 't3', 't2']);
    expect(ids({ orderBy: [{ column: 'category', dir: 'desc' }, { column: 'id' }] })).toEqual(['t2', 't3', 't1', 't4']);
    expect(ids({ orderBy: [{ column: 'category', nulls: 'first' }, { column: 'id' }] })[0]).toBe('t2');
  });
  it('desc then id desc as keyset tiebreak', () => {
    expect(ids({ orderBy: [{ column: 'date', dir: 'desc' }, { column: 'id', dir: 'desc' }] })).toEqual(['t4', 't3', 't2', 't1']);
  });
  it('nocase sorts case-insensitively', () => {
    resetDb(db);
    seedDb(db, {
      bookmarks: [
        { id: 'b1', title: 'x', url: 'u', category: 'banana' },
        { id: 'b2', title: 'x', url: 'u', category: 'Apple' },
        { id: 'b3', title: 'x', url: 'u', category: 'cherry' },
      ],
    });
    const cats = (nocase) =>
      select('bookmarks', { orderBy: [{ column: 'category', nocase }] }).map((r) => r.category);
    expect(cats(true)).toEqual(['Apple', 'banana', 'cherry']);
    expect(cats(false)).toEqual(['Apple', 'banana', 'cherry']);
    seedDb(db, { bookmarks: [{ id: 'b4', title: 'x', url: 'u', category: 'Zed' }, { id: 'b5', title: 'x', url: 'u', category: 'apricot' }] });
    expect(cats(true)).toEqual(['Apple', 'apricot', 'banana', 'cherry', 'Zed']);
    expect(cats(false)).toEqual(['Apple', 'Zed', 'apricot', 'banana', 'cherry']);
  });
  it('rowid tiebreak gives insertion order', () => {
    expect(ids({ where: { date: '2026-01-03' }, orderBy: [{ column: 'date' }, { column: 'rowid' }] })).toEqual(['t3', 't4']);
    expect(ids({ where: { date: '2026-01-03' }, orderBy: [{ column: 'rowid', dir: 'desc' }] })).toEqual(['t4', 't3']);
  });
  it('limit, offset, and offset without limit', () => {
    const order = [{ column: 'id' }];
    expect(ids({ orderBy: order, limit: 2 })).toEqual(['t1', 't2']);
    expect(ids({ orderBy: order, limit: 2, offset: 1 })).toEqual(['t2', 't3']);
    expect(ids({ orderBy: order, offset: 3 })).toEqual(['t4']);
    expect(ids({ orderBy: order, limit: 0 })).toEqual([]);
    expect(ids({ orderBy: order, limit: 2, offset: 10 })).toEqual([]);
  });
  it('rejects bad limit/offset values', () => {
    expect(codeOf(() => select('transactions', { limit: -1 }))).toBe('invalid_query');
    expect(codeOf(() => select('transactions', { limit: 1.5 }))).toBe('invalid_query');
    expect(codeOf(() => select('transactions', { offset: -2 }))).toBe('invalid_query');
    expect(codeOf(() => select('transactions', { limit: '1; DROP' }))).toBe('invalid_query');
  });
  it('selectOne returns a row or null', () => {
    expect(selectOne('transactions', { where: { id: 't2' } }).merchant).toBe('Beta');
    expect(selectOne('transactions', { where: { id: 'none' } })).toBeNull();
  });
});

describe('insert / insertMany', () => {
  it('autofills id and timestamps and decodes the result', () => {
    const row = insert('notes', { body: 'hi', pinned: true });
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(row.pinned).toBe(true);
    expect(row.color).toBe('yellow');
  });
  it('round-trips arrays, json, numbers and booleans', () => {
    const j = insert('journal', { body: 'b', tags: ['a', 'b'] });
    expect(j.tags).toEqual(['a', 'b']);
    expect(j.date).toBe(j.created_at.length ? j.date : null);
    const s = insert('app_state', { key: 'k', value: { a: [1, 2] } });
    expect(s.value).toEqual({ a: [1, 2] });
    const t = insert('todos', { title: 't', done: false, order: 3 });
    expect(t.done).toBe(false);
    expect(t.order).toBe(3);
  });
  it('insertMany is atomic and returns rows in order', () => {
    const rows = insertMany('notes', [{ body: 'a' }, { body: 'b' }]);
    expect(rows.map((r) => r.body)).toEqual(['a', 'b']);
    expect(insertMany('notes', [])).toEqual([]);
    expect(() => insertMany('notes', [{ body: 'c' }, { body: null }])).toThrow();
    expect(rowsOf(db, 'notes')).toHaveLength(2);
  });
  it('surfaces constraint and invalid-value errors', () => {
    expect(codeOf(() => insert('notes', { body: null }))).toBe('constraint');
    expect(codeOf(() => insert('todos', { title: 't', order: 1.5 }))).toBe('invalid_value');
    expect(codeOf(() => insert('transactions', { id: 'x', date: 'garbage' }))).toBe('invalid_value');
  });
});

describe('update / updateById', () => {
  it('updates matching rows and returns them decoded', () => {
    const n = insert('notes', { body: 'a' });
    const out = update('notes', { pinned: true }, { where: { id: n.id } });
    expect(out).toHaveLength(1);
    expect(out[0].pinned).toBe(true);
    expect(updateById('notes', n.id, { body: 'b' }).body).toBe('b');
    expect(updateById('notes', 'missing', { body: 'b' })).toBeNull();
  });
  it('quotes reserved column names', () => {
    const c = insert('todo_columns', { name: 'x', order: 1 });
    expect(updateById('todo_columns', c.id, { order: 5 }).order).toBe(5);
    expect(select('todo_columns', { orderBy: [{ column: 'order' }] })).toHaveLength(1);
    expect(select('todos', { where: { order: null } })).toEqual([]);
  });
  it('an empty patch is a no-op that returns the rows', () => {
    const n = insert('notes', { body: 'a' });
    expect(update('notes', {}, { where: { id: n.id } })[0].body).toBe('a');
    expect(update('notes', { body: undefined }, { where: { id: n.id } })[0].body).toBe('a');
  });
  it('requires a where clause', () => {
    expect(codeOf(() => update('notes', { body: 'x' }))).toBe('invalid_query');
    expect(codeOf(() => update('notes', { body: 'x' }, { where: {} }))).toBe('invalid_query');
  });
});

describe('upsert', () => {
  it('inserts then updates and returns the row', () => {
    const a = upsert('app_state', { key: 'theme', value: 'dark' });
    expect(a.value).toBe('dark');
    const first = a.updated_at;
    const b = upsert('app_state', { key: 'theme', value: 'light', updated_at: '2030-01-01T00:00:00.000Z' }, { conflict: ['key'] });
    expect(b.value).toBe('light');
    expect(b.updated_at).toBe('2030-01-01T00:00:00.000Z');
    expect(first).not.toBe(b.updated_at);
    expect(count('app_state')).toBe(1);
  });
  it('does not overwrite autofilled timestamps when not passed', () => {
    const a = upsert('app_state', { key: 'k', value: 1 });
    const b = upsert('app_state', { key: 'k', value: 2 });
    expect(b.value).toBe(2);
    expect(b.updated_at).toBe(a.updated_at);
  });
  it('with no updatable columns still returns the row', () => {
    const a = upsert('jarvis_conversations', { id: 'c1' });
    const b = upsert('jarvis_conversations', { id: 'c1' });
    expect(b.id).toBe('c1');
    expect(b.created_at).toBe(a.created_at);
    expect(count('jarvis_conversations')).toBe(1);
  });
  it('supports a custom conflict target', () => {
    const n = upsert('app_secrets', { name: 'GROQ_API_KEY', ciphertext: 'a', iv: 'b', auth_tag: 'c', last4: '1234' });
    const m = upsert('app_secrets', { name: 'GROQ_API_KEY', ciphertext: 'z', iv: 'b', auth_tag: 'c', last4: '9999' }, { conflict: ['name'] });
    expect(n.name).toBe(m.name);
    expect(m.last4).toBe('9999');
  });
});

describe('remove', () => {
  it('returns the number of deleted rows', () => {
    seedTxns();
    expect(remove('transactions', { where: { id: op.in(['t1', 't2', 'none']) } })).toBe(2);
    expect(remove('transactions', { where: { id: 'none' } })).toBe(0);
    expect(count('transactions')).toBe(2);
  });
  it('requires a where clause', () => {
    expect(codeOf(() => remove('transactions'))).toBe('invalid_query');
    expect(codeOf(() => remove('transactions', { where: {} }))).toBe('invalid_query');
  });
  it('cascades through foreign keys', () => {
    const h = insert('habits', { title: 'h' });
    insert('habit_completions', { habit_id: h.id, date: '2026-01-01' });
    remove('habits', { where: { id: h.id } });
    expect(count('habit_completions')).toBe(0);
  });
});

describe('identifier allowlist', () => {
  it('rejects unknown tables before any SQL runs', () => {
    for (const t of ['__proto__', 'constructor', 'toString', 'nope', 'notes; DROP TABLE notes', 'schema_version', '']) {
      expect(codeOf(() => select(t))).toBe('unknown_table');
    }
    expect(codeOf(() => count(undefined))).toBe('unknown_table');
    expect(codeOf(() => insert('nope', {}))).toBe('unknown_table');
  });
  it('rejects unknown columns in every position', () => {
    const bad = ['__proto__', 'constructor', '"x"; DROP TABLE notes', 'nope', 'rowid'];
    for (const c of bad) {
      expect(codeOf(() => select('notes', { where: { [c]: 'x' } }))).toBe('unknown_column');
      expect(codeOf(() => select('notes', { columns: [c] }))).toBe('unknown_column');
      expect(codeOf(() => select('notes', { search: { columns: [c], term: 'x' } }))).toBe('unknown_column');
      expect(codeOf(() => insert('notes', { body: 'x', [c]: 1 }))).toBe('unknown_column');
      expect(codeOf(() => upsert('notes', { body: 'x' }, { conflict: [c] }))).toBe('unknown_column');
    }
    for (const c of ['__proto__', 'constructor', 'nope', '"x"; DROP']) {
      expect(codeOf(() => select('notes', { orderBy: [{ column: c }] }))).toBe('unknown_column');
    }
    expect(count('notes')).toBe(0);
  });
  it('rejects invalid operators, directions and null placement', () => {
    expect(codeOf(() => select('notes', { where: { body: { like: 'x' } } }))).toBe('invalid_query');
    expect(codeOf(() => select('notes', { orderBy: [{ column: 'body', dir: 'asc; DROP' }] }))).toBe('invalid_query');
    expect(codeOf(() => select('notes', { orderBy: [{ column: 'body', nulls: 'sometimes' }] }))).toBe('invalid_query');
    expect(codeOf(() => select('notes', { columns: [] }))).toBe('invalid_query');
  });
});

describe('op.nin', () => {
  const ids = (where) => select('transactions', { columns: ['id'], where, orderBy: [{ column: 'id' }] }).map((r) => r.id);
  const capture = (where) => {
    const seen = { sql: '', params: [] };
    const fake = {
      prepare(sql) {
        seen.sql = sql;
        return {
          all(...params) {
            seen.params = params;
            return [];
          },
        };
      },
    };
    select('transactions', { columns: ['id'], where, db: fake });
    return seen;
  };

  it('builds NOT IN with one bound placeholder per value and no interpolation', () => {
    const evil = `x'); DROP TABLE transactions; --`;
    const { sql, params } = capture({ id: op.nin(['t1', evil]) });
    expect(sql).toContain('WHERE "id" NOT IN (?, ?)');
    expect(params).toEqual(['t1', evil]);
    expect(sql).not.toContain('DROP');
    expect(sql).not.toContain('t1');
  });

  it('excludes the listed values in a real query', () => {
    seedTxns();
    expect(ids({ id: op.nin(['t1', 't3', 'zz']) })).toEqual(['t2', 't4']);
    expect(ids({ id: op.nin(['t1', 't2', 't3', 't4']) })).toEqual([]);
    expect(count('transactions', { where: { id: op.nin(['t1']) } })).toBe(3);
  });

  it('with an empty array adds a constant-true predicate and excludes nothing (no NOT IN () syntax error)', () => {
    seedTxns();
    expect(ids({ id: op.nin([]) })).toEqual(['t1', 't2', 't3', 't4']);
    const { sql, params } = capture({ id: op.nin([]) });
    expect(sql).toContain('WHERE 1');
    expect(sql).not.toContain('NOT IN');
    expect(params).toEqual([]);
  });

  it('keeps the standard SQL NULL rule: rows whose column is NULL are not returned', () => {
    seedTxns();
    // t2 has category NULL; NOT IN yields NULL for it, so it is excluded even though null is not listed.
    expect(ids({ category: op.nin(['fun']) })).toEqual(['t1', 't4']);
  });

  it('combines with other operators in op.and and with sibling keys', () => {
    seedTxns();
    expect(ids({ id: op.and(op.gte('t2'), op.nin(['t3'])) })).toEqual(['t2', 't4']);
    expect(ids({ id: op.nin(['t1']), category: 'food' })).toEqual(['t4']);
    const { sql, params } = capture({ id: op.and(op.gte('t2'), op.nin(['t3', 't4'])) });
    expect(sql).toContain('("id" >= ? AND "id" NOT IN (?, ?))');
    expect(params).toEqual(['t2', 't3', 't4']);
  });

  it('rejects op.and with a duplicate nin', () => {
    expect(codeOf(() => op.and(op.nin(['a']), op.nin(['b'])))).toBe('invalid_query');
  });

  it('rejects non-array and non-scalar values', () => {
    expect(codeOf(() => select('transactions', { where: { id: op.nin('t1') } }))).toBe('invalid_query');
    expect(codeOf(() => select('transactions', { where: { id: op.nin([{}]) } }))).toBe('invalid_query');
    expect(codeOf(() => select('transactions', { where: { nope: op.nin(['a']) } }))).toBe('unknown_column');
  });
});

describe('parameter binding', () => {
  it('stores hostile strings as data', () => {
    const evil = `x'); DROP TABLE notes; --`;
    const n = insert('notes', { body: evil });
    expect(selectOne('notes', { where: { body: evil } }).id).toBe(n.id);
    expect(count('notes', { where: { body: op.in([evil, "' OR '1'='1"]) } })).toBe(1);
    expect(count('notes', { where: { body: "' OR '1'='1" } })).toBe(0);
  });
});
