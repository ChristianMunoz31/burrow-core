// A todo created without a status joins the FIRST board column by its current name, so renaming
// Backlog never strands later todos in "No column". Legacy NULL-status rows follow the first column too.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { strToU8, zipSync } from 'fflate';
import { closeTestDb, createTestDb, resetDb, rowsOf, seedDb } from './helpers/testDb.js';

vi.mock('../../loadEnv.js', () => ({}));

let app;
let db;
let da;
let importZipBuffer;
const savedEncKey = process.env.SECRETS_ENCRYPTION_KEY;

beforeAll(async () => {
  delete process.env.SECRETS_ENCRYPTION_KEY;
  delete process.env.APP_PASSWORD;
  delete process.env.AUTH_SECRET;
  db = createTestDb();
  app = (await import('../../server.js')).default;
  da = await import('../dataAccess.js');
  ({ importZipBuffer } = await import('../import/importExport.js'));
});
afterAll(() => {
  closeTestDb(db);
  if (savedEncKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
  else process.env.SECRETS_ENCRYPTION_KEY = savedEncKey;
});
beforeEach(() => resetDb(db));

const seedColumns = () =>
  seedDb(db, {
    todo_columns: [
      { id: 'cb', name: 'Backlog', order: 0, color: 'gray' },
      { id: 'cp', name: 'In Progress', order: 1, color: 'blue' },
      { id: 'cd', name: 'Done', order: 2, color: 'green' },
    ],
  });
const renameBacklog = (name = 'Inbox') => request(app).patch('/api/todo-columns/cb').send({ name });
const statusOf = (id) => rowsOf(db, 'todos').find((r) => r.id === id)?.status;

const todosZip = (rows) =>
  new Uint8Array(
    zipSync({
      'manifest.json': strToU8(JSON.stringify({ format: 'burrow-export', formatVersion: 2, tables: [{ id: 'todos' }] })),
      'json/todos.json': strToU8(JSON.stringify(rows)),
    }),
  );

describe('REST POST /api/todos without a status', () => {
  it('lands in the renamed first column and stores that name', async () => {
    seedColumns();
    expect((await renameBacklog()).status).toBe(200);
    const res = await request(app).post('/api/todos').send({ title: 'After rename' });
    expect(res.body).toMatchObject({ status: 'Inbox', done: false });
    expect(rowsOf(db, 'todos')[0].status).toBe('Inbox');
    const list = await request(app).get('/api/todos');
    expect(list.body.map((t) => t.status)).toEqual(['Inbox']);
  });

  it('uses the first column by order, not by name', async () => {
    seedColumns();
    await request(app).patch('/api/todo-columns/cp').send({ order: -1 });
    const res = await request(app).post('/api/todos').send({ title: 'x', status: '   ' });
    expect(res.body.status).toBe('In Progress');
  });

  it('falls back to Backlog when no columns exist and keeps an explicit status', async () => {
    const a = await request(app).post('/api/todos').send({ title: 'a' });
    expect(a.body.status).toBe('Backlog');
    seedColumns();
    const b = await request(app).post('/api/todos').send({ title: 'b', status: 'In Progress' });
    expect(b.body.status).toBe('In Progress');
  });

  it('keeps Done semantics: status Done is done, nothing else changes', async () => {
    seedColumns();
    await renameBacklog();
    const res = await request(app).post('/api/todos').send({ title: 'finished', status: 'Done' });
    expect(res.body).toMatchObject({ status: 'Done', done: true });
  });
});

describe('legacy NULL-status todos', () => {
  it('show in the first column after it is renamed twice, never "Backlog"', async () => {
    seedColumns();
    seedDb(db, {
      todos: [
        { id: 'open', title: 'open', done: false },
        { id: 'fin', title: 'finished', done: true },
      ],
    });
    await renameBacklog('Inbox');
    await request(app).patch('/api/todo-columns/cb').send({ name: 'Ideas' });
    const byId = Object.fromEntries((await request(app).get('/api/todos')).body.map((t) => [t.id, t]));
    expect(byId.open.status).toBe('Ideas');
    expect(byId.fin).toMatchObject({ status: 'Done', done: true });
  });

  it('a NULL-status row stays in the first column when another column is first', async () => {
    seedColumns();
    seedDb(db, { todos: [{ id: 'open', title: 'open', done: false }] });
    await request(app).patch('/api/todo-columns/cp').send({ order: -1 });
    const list = (await request(app).get('/api/todos')).body;
    expect(list[0].status).toBe('Backlog');
    // Reordering pinned the legacy row to the old first column, so renaming it still moves it.
    expect(statusOf('open')).toBe('Backlog');
    await renameBacklog('Later');
    expect(statusOf('open')).toBe('Later');
    expect((await request(app).get('/api/todos')).body[0].status).toBe('Later');
  });

  it('reorder-only: the legacy row stays in the old first column', async () => {
    seedColumns();
    seedDb(db, { todos: [{ id: 'open', title: 'open', done: false }, { id: 'e', title: 'e', status: '', done: false }] });
    await request(app).patch('/api/todo-columns/cp').send({ order: -5 });
    expect(statusOf('open')).toBe('Backlog');
    expect(statusOf('e')).toBe('Backlog');
    expect((await request(app).get('/api/todos')).body.map((t) => t.status)).toEqual(['Backlog', 'Backlog']);
  });

  it('rename and order in one PATCH: pinned to the final name of the old first column', async () => {
    seedColumns();
    seedDb(db, { todos: [{ id: 'open', title: 'open', done: false }, { id: 'fin', title: 'fin', done: true }] });
    const res = await request(app).patch('/api/todo-columns/cb').send({ name: 'Inbox', order: 9 });
    expect(res.status).toBe(200);
    expect(statusOf('open')).toBe('Inbox');
    expect(statusOf('fin')).toBeNull();
  });

  it('a new column placed before the first one does not pull the legacy row into it', async () => {
    seedColumns();
    seedDb(db, { todos: [{ id: 'open', title: 'open', done: false }] });
    expect((await request(app).post('/api/todo-columns').send({ name: 'Ideas', order: -1 })).status).toBe(200);
    expect(statusOf('open')).toBe('Backlog');
    await request(app).post('/api/todo-columns').send({ name: 'Later' });
    expect(statusOf('open')).toBe('Backlog');
  });

  it('multi-PATCH reorder (one PATCH per column) keeps the legacy row in the original first column', async () => {
    seedColumns();
    seedDb(db, { todos: [{ id: 'open', title: 'open', done: false }] });
    await request(app).patch('/api/todo-columns/cb').send({ order: 1 });
    await request(app).patch('/api/todo-columns/cp').send({ order: 0 });
    await request(app).patch('/api/todo-columns/cd').send({ order: 2 });
    expect(statusOf('open')).toBe('Backlog');
  });

  it('deleting the first column pins the legacy row to its name; other deletes leave it alone', async () => {
    seedColumns();
    seedDb(db, { todos: [{ id: 'open', title: 'open', done: false }] });
    expect((await request(app).delete('/api/todo-columns/cp')).status).toBe(200);
    expect(statusOf('open')).toBeNull();
    expect((await request(app).delete('/api/todo-columns/cb')).status).toBe(200);
    expect(statusOf('open')).toBe('Backlog');
  });
});

describe('a column named Done that becomes first', () => {
  it('is skipped as the default so open todos stay open', async () => {
    seedColumns();
    await request(app).patch('/api/todo-columns/cd').send({ order: -1 });
    const res = await request(app).post('/api/todos').send({ title: 'x' });
    expect(res.body).toMatchObject({ status: 'Backlog', done: false });
    const added = await da.addTodo({ title: 'y' });
    expect(added).toMatchObject({ status: 'Backlog', done: false });
    seedDb(db, { todos: [{ id: 'leg', title: 'leg', done: false }] });
    const leg = (await request(app).get('/api/todos')).body.find((t) => t.id === 'leg');
    expect(leg).toMatchObject({ status: 'Backlog', done: false });
  });
});

describe('Javi listTodos status filter', () => {
  it('includes legacy NULL/blank open rows when filtering by the default column', async () => {
    seedColumns();
    await renameBacklog();
    seedDb(db, {
      todos: [
        { id: 'n', title: 'null', done: false },
        { id: 'e', title: 'blank', status: '', done: false },
        { id: 'x', title: 'explicit', status: 'Inbox', done: false },
        { id: 'p', title: 'other', status: 'In Progress', done: false },
        { id: 'f', title: 'fin', done: true },
      ],
    });
    const ids = (await da.listTodos({ status: 'Inbox' })).map((t) => t.id).sort();
    expect(ids).toEqual(['e', 'n', 'x']);
    expect((await da.listTodos({ status: 'In Progress' })).map((t) => t.id)).toEqual(['p']);
  });
});

describe('Javi addTodo without a status', () => {
  it('lands in the renamed first column', async () => {
    seedColumns();
    await renameBacklog();
    const added = await da.addTodo({ title: 'from Javi' });
    expect(added.status).toBe('Inbox');
    expect(rowsOf(db, 'todos')[0].status).toBe('Inbox');
    expect((await da.listTodos()).map((t) => t.status)).toEqual(['Inbox']);
  });

  it('keeps Done semantics and explicit statuses', async () => {
    seedColumns();
    await renameBacklog();
    expect(await da.addTodo({ title: 'd', status: 'Done' })).toMatchObject({ status: 'Done', done: true });
    expect((await da.addTodo({ title: 'p', status: 'In Progress' })).status).toBe('In Progress');
  });

  it('completing a todo still sets Done', async () => {
    seedColumns();
    const t = await da.addTodo({ title: 'finish me' });
    expect(await da.completeTodo({ id: t.id })).toMatchObject({ status: 'Done', done: true });
  });
});

describe('import rows without a status', () => {
  it('new open todos join the renamed first column; done, explicit and existing rows are unchanged', async () => {
    seedColumns();
    await renameBacklog();
    seedDb(db, { todos: [{ id: 'old', title: 'already here', done: false }] });
    importZipBuffer(
      todosZip([
        { id: 'n1', title: 'no status' },
        { id: 'n2', title: 'blank status', status: '  ', done: false },
        { id: 'n3', title: 'finished', done: true },
        { id: 'n4', title: 'explicit', status: 'In Progress' },
        { id: 'old', title: 'already here, re-imported' },
      ]),
    );
    expect(statusOf('n1')).toBe('Inbox');
    expect(statusOf('n2')).toBe('Inbox');
    expect(statusOf('n3')).toBeNull();
    expect(statusOf('n4')).toBe('In Progress');
    expect(statusOf('old')).toBeNull();
    const list = (await request(app).get('/api/todos')).body;
    expect(list.find((t) => t.id === 'n3')).toMatchObject({ status: 'Done', done: true });
  });
});
