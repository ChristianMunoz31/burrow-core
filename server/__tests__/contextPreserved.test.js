// The Work/Home tag now matters on the Todos page only, so the other forms no longer send
// `context`. An edit that omits it must never drop or rewrite a stored tag, and a create that
// omits it stores 'both'. Real temp SQLite database through the shared helper.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { closeTestDb, createTestDb, resetDb, rowsOf } from './helpers/testDb.js';

vi.mock('../../loadEnv.js', () => ({}));

let app;
let db;
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

// table: the SQLite table; create: minimal valid body; edit: a body change with no context key.
const CASES = [
  { name: 'habits', table: 'habits', path: '/api/habits', create: { title: 'Run' }, edit: { title: 'Jog' } },
  { name: 'journal', table: 'journal', path: '/api/journal', create: { body: 'Day one' }, edit: { body: 'Day two' } },
  {
    name: 'calendar events',
    table: 'calendar_events',
    path: '/api/calendar/events',
    create: { summary: 'Standup', start: '2026-03-01T10:00:00Z' },
    edit: { summary: 'Sync' },
  },
  { name: 'todos', table: 'todos', path: '/api/todos', create: { title: 'Pay rent' }, edit: { title: 'Pay rent today' } },
  { name: 'notes', table: 'notes', path: '/api/notes', create: { body: 'Milk' }, edit: { body: 'Oat milk' } },
  {
    name: 'bookmarks',
    table: 'bookmarks',
    path: '/api/bookmarks',
    create: { title: 'Docs', url: 'https://example.com' },
    edit: { title: 'Docs 2' },
  },
  {
    name: 'countdowns',
    table: 'countdowns',
    path: '/api/countdowns',
    create: { title: 'Trip', targetDate: '2099-01-01' },
    edit: { title: 'Holiday' },
  },
];

describe.each(CASES)('$name keep their tag when edited without a context', ({ table, path, create, edit }) => {
  it('PATCH with no context key leaves a stored home tag as it was', async () => {
    const made = await request(app).post(path).send({ ...create, context: 'home' });
    expect(made.status).toBeLessThan(300);
    const { id } = made.body;
    const patched = await request(app).patch(`${path}/${id}`).send(edit);
    expect(patched.status).toBe(200);
    expect(rowsOf(db, table).find((r) => r.id === id).context).toBe('home');
  });

  it('a create with no context stores both', async () => {
    const made = await request(app).post(path).send(create);
    expect(made.status).toBeLessThan(300);
    expect(rowsOf(db, table).find((r) => r.id === made.body.id).context).toBe('both');
  });
});
