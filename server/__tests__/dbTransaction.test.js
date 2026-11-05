import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { count, insert, withTransaction } from '../db/index.js';
import { closeTestDb, createTestDb, resetDb } from './helpers/testDb.js';

let db;
beforeAll(() => {
  db = createTestDb();
});
beforeEach(() => resetDb(db));
afterAll(() => closeTestDb(db));

describe('withTransaction', () => {
  it('commits and returns the callback result', () => {
    const out = withTransaction(() => {
      insert('notes', { body: 'a' });
      return 42;
    });
    expect(out).toBe(42);
    expect(count('notes')).toBe(1);
  });

  it('rolls back and rethrows on error', () => {
    expect(() =>
      withTransaction(() => {
        insert('notes', { body: 'a' });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(count('notes')).toBe(0);
  });

  it('nested savepoint rollback keeps the outer transaction', () => {
    withTransaction(() => {
      insert('notes', { body: 'outer' });
      expect(() =>
        withTransaction(() => {
          insert('notes', { body: 'inner' });
          throw new Error('inner fail');
        }),
      ).toThrow('inner fail');
      insert('notes', { body: 'outer2' });
    });
    expect(count('notes')).toBe(2);
    expect(count('notes', { where: { body: 'inner' } })).toBe(0);
  });

  it('nested success is committed with the outer transaction', () => {
    expect(() =>
      withTransaction(() => {
        withTransaction(() => insert('notes', { body: 'inner' }));
        throw new Error('outer fail');
      }),
    ).toThrow('outer fail');
    expect(count('notes')).toBe(0);
  });

  it('rejects an async callback with TypeError and rolls back', () => {
    expect(() =>
      withTransaction(async () => {
        insert('notes', { body: 'a' });
      }),
    ).toThrow(TypeError);
    expect(count('notes')).toBe(0);
    // the handle is usable afterwards (no dangling transaction)
    expect(withTransaction(() => insert('notes', { body: 'b' }).body)).toBe('b');
  });

  it('maps constraint failures to a constraint DbError', () => {
    try {
      insert('habit_completions', { habit_id: 'missing', date: '2026-01-01' });
      expect.unreachable();
    } catch (e) {
      expect(e.code).toBe('constraint');
      expect(e.status).toBe(400);
    }
  });
});
