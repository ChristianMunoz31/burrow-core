// Data routes against a real (in-memory) SQLite database: normalized shapes, stable
// ordering and paging, 404/400 mapping, and type round-trips.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { vi } from 'vitest';
import { PROTECTED_APP_STATE_KEYS } from '../import/importExport.js';
import { closeTestDb, createTestDb, resetDb, rowsOf, seedDb } from './helpers/testDb.js';
import { upsert } from '../db/index.js';

vi.mock('../../loadEnv.js', () => ({}));

let app;
let db;
// The shell may export SECRETS_ENCRYPTION_KEY; keep these tests independent of it.
const savedEncKey = process.env.SECRETS_ENCRYPTION_KEY;

beforeAll(async () => {
  delete process.env.SECRETS_ENCRYPTION_KEY;
  delete process.env.APP_PASSWORD;
  delete process.env.AUTH_SECRET;
  db = createTestDb();
  app = (await import('../../server.js')).default;
});
afterAll(() => {
  closeTestDb(db);
  if (savedEncKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
  else process.env.SECRETS_ENCRYPTION_KEY = savedEncKey;
});
beforeEach(() => resetDb(db));

const txn = (id, date, extra = {}) => ({
  id,
  date,
  merchant: `M-${id}`,
  amount: -5,
  category: 'food',
  type: 'Debit',
  ...extra,
});

describe('GET /api/transactions', () => {
  it('returns normalized rows, ascending (type lowercased, created_at to createdTime)', async () => {
    seedDb(db, {
      transactions: [
        txn('r1', '2026-01-01'),
        txn('r2', '2026-01-02', { type: 'credit', amount: 10, created_at: '2026-01-02T00:00:00.000Z' }),
      ],
    });
    const res = await request(app).get('/api/transactions');
    expect(res.status).toBe(200);
    expect(res.body.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(res.body[0]).toMatchObject({ merchant: 'M-r1', type: 'debit' });
    expect(res.body[1]).toMatchObject({ type: 'credit', createdTime: '2026-01-02T00:00:00.000Z' });
  });

  it('breaks same-date ties by id', async () => {
    seedDb(db, { transactions: [txn('b', '2026-01-01'), txn('a', '2026-01-01'), txn('c', '2026-01-01')] });
    const res = await request(app).get('/api/transactions');
    expect(res.body.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('?limit takes the newest rows and ?offset counts from the newest', async () => {
    seedDb(db, {
      transactions: ['01', '02', '03', '04', '05'].map((d) => txn(`t${d}`, `2026-01-${d}`)),
    });
    const newest = await request(app).get('/api/transactions?limit=2');
    expect(newest.body.map((r) => r.id)).toEqual(['t04', 't05']);
    const paged = await request(app).get('/api/transactions?limit=2&offset=2');
    expect(paged.body.map((r) => r.id)).toEqual(['t02', 't03']);
  });

  it('ignores a non-numeric limit and falls back to the ceiling', async () => {
    seedDb(db, { transactions: [txn('r1', '2026-01-01'), txn('r2', '2026-01-02')] });
    const res = await request(app).get('/api/transactions?limit=abc');
    expect(res.body).toHaveLength(2);
  });

  it('clamps an over-ceiling limit to 5000 rows', async () => {
    const rows = Array.from({ length: 5003 }, (_, i) => txn(`id${String(i).padStart(5, '0')}`, '2026-01-01'));
    seedDb(db, { transactions: rows });
    const res = await request(app).get('/api/transactions?limit=999999');
    expect(res.body).toHaveLength(5000);
    const dflt = await request(app).get('/api/transactions');
    expect(dflt.body).toHaveLength(5000);
  });
});

describe('POST/DELETE /api/transactions', () => {
  it('signs amounts by type and returns rows in input order', async () => {
    const res = await request(app)
      .post('/api/transactions')
      .send({
        records: [
          { date: '2026-02-01', merchant: 'A', amount: 12.5, type: 'debit' },
          { date: '2026-02-02', merchant: 'B', amount: -7, type: 'credit' },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.map((r) => [r.merchant, r.amount, r.type])).toEqual([
      ['A', -12.5, 'debit'],
      ['B', 7, 'credit'],
    ]);
    expect(rowsOf(db, 'transactions')).toHaveLength(2);
  });

  it('400s on an invalid date without inserting anything', async () => {
    const res = await request(app)
      .post('/api/transactions')
      .send({ records: [{ date: '2026-02-01', merchant: 'ok' }, { date: 'not-a-date', merchant: 'bad' }] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid input' });
    expect(rowsOf(db, 'transactions')).toHaveLength(0);
  });

  it('deletes by id and treats a non-array recordIds as empty', async () => {
    seedDb(db, { transactions: [txn('x1', '2026-01-01'), txn('x2', '2026-01-02')] });
    expect((await request(app).delete('/api/transactions').send({ recordIds: 'x1' })).body).toEqual({ success: true });
    expect(rowsOf(db, 'transactions')).toHaveLength(2);
    await request(app).delete('/api/transactions').send({ recordIds: ['x1'] });
    expect(rowsOf(db, 'transactions').map((r) => r.id)).toEqual(['x2']);
  });
});

describe('path variants and delete cap', () => {
  // The export route enforces its own 10kb JSON limit; the global 2mb parser must not pre-empt it.
  it.each(['/api/export', '/api/export/', '/API/export'])('applies the export route body limit for %s', async (path) => {
    const res = await request(app).post(path).send({ pad: 'x'.repeat(50 * 1024) });
    expect(res.status).toBe(413);
  });

  it('400s a delete with more than 1000 recordIds instead of 500ing', async () => {
    const ids = Array.from({ length: 1001 }, (_, i) => `id${i}`);
    const res = await request(app).delete('/api/transactions').send({ recordIds: ids });
    expect(res.status).toBe(400);
  });
});

describe('todo columns', () => {
  it('seeds the defaults once, as editable local rows', async () => {
    const first = await request(app).get('/api/todo-columns');
    expect(first.body).toMatchObject({ source: 'local', writable: true });
    expect(first.body.columns.map((c) => c.name)).toEqual(['Backlog', 'In Progress', 'Done']);
    const second = await request(app).get('/api/todo-columns');
    expect(second.body.columns.map((c) => c.id)).toEqual(first.body.columns.map((c) => c.id));
    expect(rowsOf(db, 'todo_columns')).toHaveLength(3);
  });

  it('creates, patches, 404s an unknown id, and deletes', async () => {
    const made = await request(app).post('/api/todo-columns').send({ name: 'Review' });
    expect(made.body).toMatchObject({ name: 'Review', order: 99, color: 'gray' });
    const patched = await request(app).patch(`/api/todo-columns/${made.body.id}`).send({ color: 'red' });
    expect(patched.body.color).toBe('red');
    const missing = await request(app).patch('/api/todo-columns/nope').send({ color: 'red' });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'Not found' });
    // No body at all (Express 5 leaves req.body undefined): same as an empty patch, never a 500.
    const before = rowsOf(db, 'todo_columns').find((r) => r.id === made.body.id);
    const bodyless = await request(app).patch(`/api/todo-columns/${made.body.id}`);
    expect(bodyless.status).toBe(200);
    expect(rowsOf(db, 'todo_columns').find((r) => r.id === made.body.id)).toEqual(before);
    const plain = await request(app)
      .patch(`/api/todo-columns/${made.body.id}`)
      .set('Content-Type', 'text/plain')
      .send('color=blue');
    expect(plain.status).toBe(200);
    expect(rowsOf(db, 'todo_columns').find((r) => r.id === made.body.id)).toEqual(before);
    await request(app).delete(`/api/todo-columns/${made.body.id}`);
    expect(rowsOf(db, 'todo_columns')).toHaveLength(0);
  });
});

describe('todo column rename', () => {
  const seedColumns = () =>
    seedDb(db, {
      todo_columns: [
        { id: 'cb', name: 'Backlog', order: 0, color: 'gray' },
        { id: 'cp', name: 'In Progress', order: 1, color: 'blue' },
        { id: 'cd', name: 'Done', order: 2, color: 'green' },
      ],
    });
  const statusById = () => Object.fromEntries(rowsOf(db, 'todos').map((r) => [r.id, r.status]));
  const rename = (id, name) => request(app).patch(`/api/todo-columns/${id}`).send({ name });

  it('moves the todos with the old status and leaves the others untouched', async () => {
    seedColumns();
    seedDb(db, {
      todos: [
        { id: 'a', title: 'A', status: 'In Progress' },
        { id: 'b', title: 'B', status: 'In Progress' },
        { id: 'c', title: 'C', status: 'Backlog' },
        { id: 'd', title: 'D', status: 'Mystery' },
      ],
    });
    const res = await rename('cp', '  Doing  ');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'cp', name: 'Doing', color: 'blue' });
    expect(statusById()).toEqual({ a: 'Doing', b: 'Doing', c: 'Backlog', d: 'Mystery' });
  });

  it('moves NULL-status not-done todos with Backlog and NULL-status done todos with Done', async () => {
    seedColumns();
    seedDb(db, {
      todos: [
        { id: 'n1', title: 'open', done: false },
        { id: 'n2', title: 'finished', done: true },
        { id: 'n3', title: 'explicit', status: 'Backlog' },
      ],
    });
    await rename('cb', 'Inbox');
    expect(statusById()).toEqual({ n1: 'Inbox', n2: null, n3: 'Inbox' });
    await rename('cd', 'Shipped');
    expect(statusById()).toEqual({ n1: 'Inbox', n2: 'Shipped', n3: 'Inbox' });
    const done = Object.fromEntries(rowsOf(db, 'todos').map((r) => [r.id, r.done]));
    expect(done).toEqual({ n1: false, n2: true, n3: false });
  });

  it('treats an empty-string status like NULL for Backlog and Done', async () => {
    seedColumns();
    seedDb(db, {
      todos: [
        { id: 'e1', title: 'open', status: '', done: false },
        { id: 'e2', title: 'finished', status: '', done: true },
      ],
    });
    await rename('cb', 'Inbox');
    expect(statusById()).toEqual({ e1: 'Inbox', e2: '' });
    await rename('cd', 'Shipped');
    expect(statusById()).toEqual({ e1: 'Inbox', e2: 'Shipped' });
  });

  it('200s a trimmed same-name rename and leaves every todo status untouched', async () => {
    seedColumns();
    seedDb(db, {
      todos: [
        { id: 'a', title: 'A', done: false },
        { id: 'b', title: 'B', status: 'In Progress' },
        { id: 'c', title: 'C', status: 'Mystery' },
      ],
    });
    const res = await rename('cb', ' Backlog ');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Backlog');
    expect(statusById()).toEqual({ a: null, b: 'In Progress', c: 'Mystery' });
  });

  it('409s a taken name, including a case variant, and changes nothing', async () => {
    seedColumns();
    seedDb(db, { todos: [{ id: 'a', title: 'A', status: 'In Progress' }] });
    const columnsBefore = rowsOf(db, 'todo_columns');
    const todosBefore = rowsOf(db, 'todos');
    for (const name of ['Done', 'done', ' DONE ']) {
      const res = await rename('cp', name);
      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error: 'column_name_taken',
        code: 'column_name_taken',
        message: 'A column with that name already exists.',
      });
    }
    expect(rowsOf(db, 'todo_columns')).toEqual(columnsBefore);
    expect(rowsOf(db, 'todos')).toEqual(todosBefore);
  });

  it('allows a case-only rename of the column itself and moves its todos', async () => {
    seedColumns();
    seedDb(db, { todos: [{ id: 'a', title: 'A', status: 'Backlog' }, { id: 'b', title: 'B', done: false }] });
    const res = await rename('cb', 'backlog');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('backlog');
    expect(statusById()).toEqual({ a: 'backlog', b: 'backlog' });
  });

  it('400s an empty, whitespace or non-string name', async () => {
    seedColumns();
    for (const name of ['', '   ', 5, null]) {
      const res = await rename('cp', name);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'name is required' });
    }
    expect(rowsOf(db, 'todo_columns').find((r) => r.id === 'cp').name).toBe('In Progress');
  });

  it('404s an unknown column id', async () => {
    const res = await rename('ghost', 'Whatever');
    expect(res.status).toBe(404);
  });

  it('does not touch todos for a color patch or an order patch that keeps the first column', async () => {
    seedColumns();
    seedDb(db, { todos: [{ id: 'a', title: 'A', status: 'In Progress' }, { id: 'b', title: 'B', done: false }] });
    const todosBefore = rowsOf(db, 'todos');
    const res = await request(app).patch('/api/todo-columns/cp').send({ color: 'red', order: 5 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ color: 'red', order: 5, name: 'In Progress' });
    expect(rowsOf(db, 'todos')).toEqual(todosBefore);
  });
});

describe('todos', () => {
  it('round-trips booleans and derives done from status', async () => {
    const made = await request(app).post('/api/todos').send({ title: 'Ship', status: 'Done' });
    expect(made.body).toMatchObject({ title: 'Ship', done: true, status: 'Done', priority: 'medium' });
    expect(typeof made.body.done).toBe('boolean');
    const patched = await request(app).patch(`/api/todos/${made.body.id}`).send({ status: 'Backlog' });
    expect(patched.body).toMatchObject({ done: false, status: 'Backlog' });
    const list = await request(app).get('/api/todos');
    expect(list.body).toHaveLength(1);
  });

  it('400s without a title; 404s an unknown id; 400s an invalid due date', async () => {
    expect((await request(app).post('/api/todos').send({})).status).toBe(400);
    expect((await request(app).patch('/api/todos/nope').send({ title: 'x' })).status).toBe(404);
    const bad = await request(app).post('/api/todos').send({ title: 'x', due: 'tomorrow-ish' });
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: 'Invalid input' });
  });

  it('reorders in one pass and skips unknown ids', async () => {
    const a = (await request(app).post('/api/todos').send({ title: 'A' })).body;
    const b = (await request(app).post('/api/todos').send({ title: 'B' })).body;
    const res = await request(app)
      .patch('/api/todos/reorder')
      .send({
        items: [
          { id: a.id, status: 'Done', order: 1 },
          { id: b.id, order: 0 },
          { id: 'ghost', order: 2 },
          {},
        ],
      });
    expect(res.body).toEqual({ success: true });
    const byId = Object.fromEntries(rowsOf(db, 'todos').map((r) => [r.id, r]));
    expect(byId[a.id]).toMatchObject({ order: 1, status: 'Done', done: true });
    expect(byId[b.id]).toMatchObject({ order: 0 });
  });

  it('lists in creation order', async () => {
    seedDb(db, {
      todos: [
        { id: 't2', title: 'second', created_at: '2026-01-02T00:00:00.000Z' },
        { id: 't1', title: 'first', created_at: '2026-01-01T00:00:00.000Z' },
      ],
    });
    const res = await request(app).get('/api/todos');
    expect(res.body.map((t) => t.title)).toEqual(['first', 'second']);
  });
});

describe('habits', () => {
  it('lists completions in the window, sorted; completions cascade on delete', async () => {
    const habit = (await request(app).post('/api/habits').send({ title: 'Run' })).body;
    expect(habit).toMatchObject({ title: 'Run', frequency: 'daily', completions: [] });
    const today = new Date().toISOString().slice(0, 10);
    await request(app).post(`/api/habits/${habit.id}/completions`).send({ date: today });
    await request(app).post(`/api/habits/${habit.id}/completions`).send({ date: '2001-01-01' });
    const list = await request(app).get('/api/habits');
    expect(list.body[0].completions).toEqual([today]);
    await request(app).delete(`/api/habits/${habit.id}/completions?date=${today}`);
    expect((await request(app).get('/api/habits')).body[0].completions).toEqual([]);
    await request(app).delete(`/api/habits/${habit.id}`);
    expect(rowsOf(db, 'habit_completions')).toHaveLength(0);
  });

  it('400s a completion for an unknown habit and a delete without a date; 404s an unknown patch', async () => {
    expect((await request(app).post('/api/habits/nope/completions').send({})).status).toBe(400);
    expect((await request(app).delete('/api/habits/nope/completions')).status).toBe(400);
    expect((await request(app).patch('/api/habits/nope').send({ title: 'x' })).status).toBe(404);
  });
});

describe('journal', () => {
  it('round-trips tags as an array and orders newest first', async () => {
    await request(app).post('/api/journal').send({ body: 'older', date: '2026-01-01T00:00:00Z', tags: ['a', 'b'] });
    await request(app).post('/api/journal').send({ body: 'newer', date: '2026-01-02T00:00:00Z' });
    const res = await request(app).get('/api/journal');
    expect(res.body.map((j) => j.body)).toEqual(['newer', 'older']);
    expect(res.body[1].tags).toEqual(['a', 'b']);
    expect(res.body[0].tags).toEqual([]);
    expect(res.body[1].date).toBe('2026-01-01T00:00:00.000Z');
  });

  it('patches, 404s an unknown id, 400s an invalid date, and deletes', async () => {
    const j = (await request(app).post('/api/journal').send({ body: 'x' })).body;
    const patched = await request(app).patch(`/api/journal/${j.id}`).send({ tags: ['t'], mood: 'ok' });
    expect(patched.body).toMatchObject({ tags: ['t'], mood: 'ok' });
    expect((await request(app).patch('/api/journal/nope').send({ body: 'y' })).status).toBe(404);
    expect((await request(app).patch(`/api/journal/${j.id}`).send({ date: 'garbage' })).status).toBe(400);
    await request(app).delete(`/api/journal/${j.id}`);
    expect(rowsOf(db, 'journal')).toHaveLength(0);
  });
});

describe('calendar', () => {
  it('creates events with boolean allDay and lists by start', async () => {
    await request(app).post('/api/calendar/events').send({ summary: 'B', start: '2026-03-02T10:00:00Z', allDay: true });
    await request(app).post('/api/calendar/events').send({ summary: 'A', start: '2026-03-01T10:00:00+00:00' });
    const res = await request(app).get('/api/calendar');
    expect(res.body.events.map((e) => e.summary)).toEqual(['A', 'B']);
    expect(res.body.events[0]).toMatchObject({ start: '2026-03-01T10:00:00.000Z', allDay: false });
    expect(res.body.events[1].allDay).toBe(true);
  });

  it('400s missing fields, 404s unknown patch, deletes', async () => {
    expect((await request(app).post('/api/calendar/events').send({ start: '2026-03-01' })).status).toBe(400);
    expect((await request(app).post('/api/calendar/events').send({ summary: 'x' })).status).toBe(400);
    expect((await request(app).patch('/api/calendar/events/nope').send({ summary: 'y' })).status).toBe(404);
    const ev = (await request(app).post('/api/calendar/events').send({ summary: 'x', start: '2026-03-01' })).body;
    await request(app).delete(`/api/calendar/events/${ev.id}`);
    expect(rowsOf(db, 'calendar_events')).toHaveLength(0);
  });

  it('imports an .ics file once; a re-import skips known UIDs', async () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//test//EN',
      'BEGIN:VEVENT',
      'UID:evt-1@test',
      'DTSTAMP:20260101T000000Z',
      'DTSTART:20260301T100000Z',
      'DTEND:20260301T110000Z',
      'SUMMARY:Standup',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const first = await request(app).post('/api/calendar/import').send({ ics });
    expect(first.body).toEqual({ imported: 1, skipped: 0 });
    const second = await request(app).post('/api/calendar/import').send({ ics });
    expect(second.body).toEqual({ imported: 0, skipped: 1 });
    expect(rowsOf(db, 'calendar_events')).toHaveLength(1);
    expect((await request(app).post('/api/calendar/import').send({})).status).toBe(400);
  });
});

describe('notes, bookmarks, focus, countdowns', () => {
  it('orders pinned notes first, then newest', async () => {
    seedDb(db, {
      notes: [
        { id: 'n1', body: 'old', created_at: '2026-01-01T00:00:00.000Z' },
        { id: 'n2', body: 'new', created_at: '2026-01-02T00:00:00.000Z' },
        { id: 'n3', body: 'pinned-old', pinned: true, created_at: '2025-12-01T00:00:00.000Z' },
      ],
    });
    const res = await request(app).get('/api/notes');
    expect(res.body.map((n) => n.body)).toEqual(['pinned-old', 'new', 'old']);
    expect(res.body[0].pinned).toBe(true);
    expect(res.body[1].pinned).toBe(false);
  });

  it('notes: 400 without body, 404 unknown patch, toggles pinned', async () => {
    expect((await request(app).post('/api/notes').send({})).status).toBe(400);
    const n = (await request(app).post('/api/notes').send({ body: 'hi' })).body;
    expect((await request(app).patch(`/api/notes/${n.id}`).send({ pinned: true })).body.pinned).toBe(true);
    expect((await request(app).patch('/api/notes/nope').send({ body: 'x' })).status).toBe(404);
    await request(app).delete(`/api/notes/${n.id}`);
    expect(rowsOf(db, 'notes')).toHaveLength(0);
  });

  it('sorts bookmarks by category case-insensitively', async () => {
    seedDb(db, {
      bookmarks: [
        { id: 'b1', title: 'one', url: 'https://one.test', category: 'beta' },
        { id: 'b2', title: 'two', url: 'https://two.test', category: 'Alpha' },
        { id: 'b3', title: 'three', url: 'https://three.test', category: 'alpha' },
      ],
    });
    const res = await request(app).get('/api/bookmarks');
    expect(res.body.map((b) => b.category.toLowerCase())).toEqual(['alpha', 'alpha', 'beta']);
  });

  it('bookmarks: 400 without title or url; 404 unknown patch', async () => {
    expect((await request(app).post('/api/bookmarks').send({ url: 'https://x.test' })).status).toBe(400);
    expect((await request(app).post('/api/bookmarks').send({ title: 'x' })).status).toBe(400);
    expect((await request(app).patch('/api/bookmarks/nope').send({ title: 'x' })).status).toBe(404);
  });

  it('focus: validates duration, rounds minutes, lists only the last 7 days', async () => {
    expect((await request(app).post('/api/focus').send({ durationMin: 0 })).status).toBe(400);
    const made = await request(app).post('/api/focus').send({ durationMin: 24.6, kind: 'break' });
    expect(made.body).toMatchObject({ kind: 'break', durationMin: 25 });
    seedDb(db, { focus_sessions: [{ id: 'old', duration_min: 10, started_at: '2001-01-01T00:00:00.000Z' }] });
    const list = await request(app).get('/api/focus');
    expect(list.body.map((f) => f.id)).toEqual([made.body.id]);
  });

  it('countdowns: ordered by target date; 400 on a bad date; 404 unknown patch', async () => {
    await request(app).post('/api/countdowns').send({ title: 'Later', targetDate: '2030-01-01' });
    await request(app).post('/api/countdowns').send({ title: 'Sooner', targetDate: '2029-01-01' });
    const res = await request(app).get('/api/countdowns');
    expect(res.body.map((c) => c.title)).toEqual(['Sooner', 'Later']);
    expect((await request(app).post('/api/countdowns').send({ title: 'x', targetDate: 'soon' })).status).toBe(400);
    expect((await request(app).patch('/api/countdowns/nope').send({ title: 'x' })).status).toBe(404);
  });
});

describe('app state', () => {
  it('upserts and reads back JSON values of any type', async () => {
    const put = await request(app).put('/api/state/theme').send({ value: 'dark' });
    expect(put.body).toEqual({ key: 'theme', value: 'dark' });
    await request(app).put('/api/state/theme').send({ value: { mode: 'light', n: [1, 2] } });
    await request(app).put('/api/state/flag').send({ value: false });
    const all = await request(app).get('/api/state');
    expect(all.body).toEqual({ theme: { mode: 'light', n: [1, 2] }, flag: false });
    expect(rowsOf(db, 'app_state').filter((r) => r.key === 'theme')).toHaveLength(1);
  });

  it.each([...PROTECTED_APP_STATE_KEYS])('403s writes to the protected key %s', async (key) => {
    const res = await request(app).put(`/api/state/${key}`).send({ value: { weather: true } });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'protected_key' });
    expect(rowsOf(db, 'app_state').filter((r) => r.key === key)).toHaveLength(0);
  });

  it.each(['javi.inbox', 'jarvis.briefing.latest'])('403s writes to the route-owned key %s', async (key) => {
    const res = await request(app).put(`/api/state/${key}`).send({ value: { generatedAt: '2099-01-01T00:00:00.000Z' } });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'protected_key' });
    expect(rowsOf(db, 'app_state').filter((r) => r.key === key)).toHaveLength(0);
  });

  it('GET /api/state does not list javi.inbox', async () => {
    upsert('app_state', { key: 'javi.inbox', value: { v: 1 } }, { conflict: ['key'] });
    const all = await request(app).get('/api/state');
    expect(all.body).not.toHaveProperty(['javi.inbox']);
  });

  it('400s a missing or null value', async () => {
    expect((await request(app).put('/api/state/k').send({})).status).toBe(400);
    const nul = await request(app).put('/api/state/k').send({ value: null });
    expect(nul.status).toBe(400);
    expect(nul.body).toEqual({ error: 'Invalid input' });
  });
});
