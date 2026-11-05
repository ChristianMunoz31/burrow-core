// Table-write events (server/db/writeEvents.js): query.js emits after a successful write, withTransaction holds the
// events of its handle until COMMIT, and a rolled-back transaction or savepoint emits nothing of its own.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, closeTestDb } from './helpers/testDb.js';
import { insert, insertMany, remove, removeAll, update, upsert, withTransaction } from '../db/index.js';
import { onTableWrite } from '../db/writeEvents.js';

let db;
let events;
let off;

beforeEach(() => {
  db = createTestDb();
  events = [];
  off = onTableWrite((table, key) => events.push([table, key]));
});
afterEach(() => {
  off();
  closeTestDb(db);
});

const todo = (title) => ({ title, status: 'todo' });

describe('emits', () => {
  it('each write function emits once after a successful write', () => {
    const row = insert('todos', todo('a'));
    expect(events).toEqual([['todos', null]]);
    update('todos', { title: 'b' }, { where: { id: row.id } });
    upsert('app_state', { key: 'budget:targets', value: { a: 1 } }, { conflict: ['key'] });
    expect(remove('todos', { where: { id: row.id } })).toBe(1);
    expect(events).toEqual([
      ['todos', null],
      ['todos', null],
      ['app_state', 'budget:targets'],
      ['todos', null],
    ]);
  });

  it('insert on app_state carries the key', () => {
    insert('app_state', { key: 'budget:payees', value: [] });
    expect(events).toEqual([['app_state', 'budget:payees']]);
  });

  it('zero-row and failed writes do not emit', () => {
    update('todos', { title: 'x' }, { where: { id: '00000000-0000-4000-8000-000000000000' } });
    expect(remove('todos', { where: { id: '00000000-0000-4000-8000-000000000000' } })).toBe(0);
    expect(() => insert('todos', { title: null })).toThrow();
    expect(events).toEqual([]);
  });

  it('an empty-patch update runs a SELECT and does not emit', () => {
    const row = insert('todos', todo('a'));
    events.length = 0;
    update('todos', {}, { where: { id: row.id } });
    expect(events).toEqual([]);
  });

  it('removeAll is silent', () => {
    insert('todos', todo('a'));
    events.length = 0;
    removeAll('todos');
    expect(events).toEqual([]);
  });

  it('a listener that throws is ignored and the others still run', () => {
    const offBad = onTableWrite(() => {
      throw new Error('boom');
    });
    expect(() => insert('todos', todo('a'))).not.toThrow();
    expect(events).toEqual([['todos', null]]);
    offBad();
  });
});

describe('commit-only delivery', () => {
  it('delivers nothing before COMMIT and everything after it, in order', () => {
    withTransaction(() => {
      insert('todos', todo('a'));
      insert('notes', { body: 'n' });
      expect(events).toEqual([]);
    });
    expect(events).toEqual([
      ['todos', null],
      ['notes', null],
    ]);
  });

  it('insertMany delivers after its own transaction', () => {
    insertMany('todos', [todo('a'), todo('b')]);
    expect(events).toEqual([
      ['todos', null],
      ['todos', null],
    ]);
  });

  it('a rolled-back transaction delivers nothing', () => {
    expect(() =>
      withTransaction(() => {
        insert('todos', todo('a'));
        throw new Error('roll back');
      }),
    ).toThrow('roll back');
    expect(events).toEqual([]);
    insert('todos', todo('after'));
    expect(events).toEqual([['todos', null]]);
  });

  it('a rolled-back savepoint drops only its own events', () => {
    withTransaction(() => {
      insert('todos', todo('outer'));
      try {
        withTransaction(() => {
          insert('notes', { body: 'inner' });
          throw new Error('inner');
        });
      } catch {
        // inner rolled back
      }
      withTransaction(() => insert('bookmarks', { title: 'b', url: 'https://example.com' }));
    });
    expect(events).toEqual([
      ['todos', null],
      ['bookmarks', null],
    ]);
  });
});
