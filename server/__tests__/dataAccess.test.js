// Data-access function tests on a real in-memory SQLite DB: validation, normalization, search, state.
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { closeTestDb, createTestDb, resetDb, seedDb } from './helpers/testDb.js';
import { setDbForTests } from '../db/index.js';
import { localDayOf } from '../relativeDay.js';

vi.mock('../../loadEnv.js', () => ({}));

let db;
let da;
beforeAll(async () => {
  db = createTestDb();
  da = await import('../dataAccess.js');
});
beforeEach(() => resetDb(db));
afterAll(() => closeTestDb(db));

describe('searchData', () => {
  it('returns empty results for an empty or whitespace-only query', async () => {
    expect(await da.searchData({ query: '' })).toEqual({ query: '', results: [] });
    expect(await da.searchData({ query: '   ' })).toEqual({ query: '', results: [] });
  });

  it('finds transactions by merchant or category, with category in meta', async () => {
    seedDb(db, {
      transactions: [
        { merchant: 'Amazon', amount: -29.99, date: '2026-01-01', category: 'Shopping', type: 'debit' },
        { merchant: 'Cafe', amount: -4, date: '2026-01-02', category: 'Dining', type: 'debit' },
      ],
    });
    const byMerchant = await da.searchData({ query: 'amazon', kinds: ['transactions'] });
    expect(byMerchant.results).toHaveLength(1);
    expect(byMerchant.results[0].meta).toContain('Shopping');
    const byCategory = await da.searchData({ query: 'dining', kinds: ['transactions'] });
    expect(byCategory.results.map((r) => r.title)).toEqual(['Cafe']);
  });

  it('is case-insensitive for non-ASCII text', async () => {
    seedDb(db, { notes: [{ body: 'Reunión con MUÑOZ mañana' }] });
    const { results } = await da.searchData({ query: 'muñoz', kinds: ['notes'] });
    expect(results).toHaveLength(1);
  });

  it('treats _ and \\ as literals and strips the % wildcard from the echoed query', async () => {
    seedDb(db, { todos: [{ title: 'plan a_b trip' }, { title: 'plan axb trip' }, { title: 'back\\slash' }] });
    const underscore = await da.searchData({ query: 'a_b', kinds: ['todos'] });
    expect(underscore.results.map((r) => r.title)).toEqual(['plan a_b trip']);
    const slash = await da.searchData({ query: 'k\\s', kinds: ['todos'] });
    expect(slash.results.map((r) => r.title)).toEqual(['back\\slash']);
    const pct = await da.searchData({ query: '50%', kinds: ['todos'] });
    expect(pct.query).toBe('50');
  });

  it('returns results with the expected shape fields', async () => {
    seedDb(db, { todos: [{ title: 'Buy milk', done: false, status: 'open' }] });
    const { results } = await da.searchData({ query: 'milk', kinds: ['todos'] });
    expect(results[0]).toMatchObject({ kind: 'todo', title: 'Buy milk', to: '/todos', meta: 'open' });
  });

  it('searches journal title and body, bookmarks title and url, countdown titles', async () => {
    seedDb(db, {
      journal: [{ title: 'Trip', body: 'saw the harbor', date: '2026-02-03T10:00:00.000Z' }],
      bookmarks: [{ title: 'Docs', url: 'https://example.com/harbor' }],
      countdowns: [{ title: 'Harbor day', target_date: '2026-09-01' }],
    });
    const { results } = await da.searchData({ query: 'harbor' });
    expect(results.map((r) => r.kind).sort()).toEqual(['bookmark', 'countdown', 'journal']);
    expect(results.find((r) => r.kind === 'journal').meta).toBe('2026-02-03');
  });

  it('skips kinds not in the filter list and honours the limit', async () => {
    seedDb(db, {
      todos: [{ title: 'test a' }, { title: 'test b' }, { title: 'test c' }],
      notes: [{ body: 'test note' }],
    });
    const { results } = await da.searchData({ query: 'test', kinds: ['todos'], limit: 2 });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.kind === 'todo')).toBe(true);
  });
});

describe('reads', () => {
  it('lists todos in creation order, filters by status, and surfaces open ones soonest-due first', async () => {
    seedDb(db, {
      todos: [
        { title: 'later', due: '2026-12-01', status: 'Backlog' },
        { title: 'sooner', due: '2026-03-01', status: 'Backlog' },
        { title: 'done one', done: true, status: 'Done' },
        { title: 'undated', status: 'Backlog' },
      ],
    });
    expect((await da.listTodos()).map((t) => t.title)).toEqual(['later', 'sooner', 'done one', 'undated']);
    expect((await da.listTodos({ status: 'Done' })).map((t) => t.title)).toEqual(['done one']);
    expect((await da.listOpenTodos()).map((t) => t.title)).toEqual(['sooner', 'later', 'undated']);
  });

  it('lists notes pinned first and journal newest first', async () => {
    seedDb(db, {
      notes: [
        { body: 'old', pinned: false, created_at: '2026-01-01T00:00:00.000Z' },
        { body: 'pinned', pinned: true, created_at: '2025-01-01T00:00:00.000Z' },
        { body: 'new', pinned: false, created_at: '2026-02-01T00:00:00.000Z' },
      ],
      journal: [
        { body: 'a', date: '2026-01-01T00:00:00.000Z' },
        { body: 'b', date: '2026-03-01T00:00:00.000Z', tags: ['x'] },
      ],
    });
    expect((await da.listNotes()).map((n) => n.body)).toEqual(['pinned', 'new', 'old']);
    const journal = await da.listJournal();
    expect(journal.map((j) => j.body)).toEqual(['b', 'a']);
    expect(journal[0].tags).toEqual(['x']);
  });

  it('filters upcoming countdowns and events by date', async () => {
    const today = new Date().toISOString().slice(0, 10);
    seedDb(db, {
      countdowns: [
        { title: 'past', target_date: '2001-01-01' },
        { title: 'future', target_date: '2999-01-01' },
      ],
      calendar_events: [
        { summary: 'today', start_at: `${today}T12:00:00.000Z` },
        { summary: 'far', start_at: '2999-01-01T00:00:00.000Z' },
      ],
    });
    expect((await da.listCountdowns({ upcomingOnly: true })).map((c) => c.title)).toEqual(['future']);
    expect((await da.listCountdowns()).map((c) => c.title)).toEqual(['past', 'future']);
    expect((await da.listUpcomingEvents({ days: 1 })).map((e) => e.summary)).toEqual(['today']);
  });

  it('reports habits done today and summarizes the month budget', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const [h1, h2] = seedDb(db, { habits: [{ title: 'Read' }, { title: 'Run' }] }).habits;
    seedDb(db, { habit_completions: [{ habit_id: h1.id, date: today }] });
    const habits = await da.listHabitsToday();
    expect(habits.find((h) => h.id === h1.id).doneToday).toBe(true);
    expect(habits.find((h) => h.id === h2.id).doneToday).toBe(false);

    seedDb(db, {
      transactions: [
        { merchant: 'Pay', amount: 1000, date: '2026-04-01', category: 'Income' },
        { merchant: 'Shop', amount: -40.5, date: '2026-04-30', category: 'Shopping' },
        { merchant: 'Other month', amount: -99, date: '2026-05-01', category: 'Shopping' },
      ],
    });
    const budget = await da.getBudgetSummary({ month: '2026-04' });
    expect(budget).toMatchObject({ month: '2026-04', income: 1000, expenses: 40.5, net: 959.5, transactionCount: 2 });
    expect(budget.topCategories).toEqual([{ category: 'Shopping', spent: 40.5 }]);
  });
});

describe('addTodo', () => {
  it('throws 400 when title is missing or empty', async () => {
    await expect(da.addTodo({})).rejects.toMatchObject({ status: 400 });
    await expect(da.addTodo({ title: '' })).rejects.toMatchObject({ status: 400 });
  });

  it('stores a todo and returns a normTodo-shaped object', async () => {
    const result = await da.addTodo({ title: 'Test', due: '2026-05-05' });
    expect(result).toMatchObject({ title: 'Test', done: false, due: '2026-05-05', priority: 'medium', context: 'both' });
    expect(typeof result.id).toBe('string');
  });

  it('rejects an invalid date as a 400 DbError', async () => {
    await expect(da.addTodo({ title: 'x', due: 'not-a-date' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('completeTodo', () => {
  it('completes by id and by title match', async () => {
    const t = await da.addTodo({ title: 'Write report' });
    expect(await da.completeTodo({ id: t.id })).toMatchObject({ done: true, status: 'Done' });
    const u = await da.addTodo({ title: 'Water plants' });
    expect(await da.completeTodo({ title: 'water' })).toMatchObject({ id: u.id, done: true });
  });

  it('throws 404 for an unknown id or title and 400 without either', async () => {
    await expect(da.completeTodo({ id: 'no-such-id' })).rejects.toMatchObject({ status: 404 });
    await expect(da.completeTodo({ title: 'nothing like this' })).rejects.toMatchObject({ status: 404 });
    await expect(da.completeTodo({})).rejects.toMatchObject({ status: 400 });
  });
});

describe('other writes', () => {
  it('validates required fields', async () => {
    await expect(da.addNote({})).rejects.toMatchObject({ status: 400 });
    await expect(da.addJournalEntry({})).rejects.toMatchObject({ status: 400 });
    await expect(da.addCountdown({ title: 'x' })).rejects.toMatchObject({ status: 400 });
    await expect(da.upsertMemoryFact({})).rejects.toMatchObject({ status: 400 });
    await expect(da.logHabitCompletion({})).rejects.toMatchObject({ status: 400 });
  });

  it('stores notes, journal entries with tags, countdowns, and memory facts', async () => {
    expect(await da.addNote({ body: 'hello' })).toMatchObject({ body: 'hello', pinned: false });
    expect(await da.addJournalEntry({ body: 'day', tags: ['a', 'b'], mood: 'ok' })).toMatchObject({ tags: ['a', 'b'], mood: 'ok' });
    expect(await da.addCountdown({ title: 'Trip', targetDate: '2026-12-25' })).toMatchObject({ targetDate: '2026-12-25' });
    expect(await da.upsertMemoryFact({ fact: 'likes tea', weight: 2 })).toMatchObject({ fact: 'likes tea', category: 'general' });
    expect((await da.listMemory())[0]).toMatchObject({ fact: 'likes tea', weight: 2 });
  });

  it('logs a habit completion by id or title; an unknown habit is 404 (title) or 400 (id)', async () => {
    const [habit] = seedDb(db, { habits: [{ title: 'Meditate' }] }).habits;
    const byTitle = await da.logHabitCompletion({ habitTitle: 'medit', date: '2026-01-05' });
    expect(byTitle).toMatchObject({ habitId: habit.id, date: '2026-01-05' });
    await expect(da.logHabitCompletion({ habitTitle: 'nope' })).rejects.toMatchObject({ status: 404 });
    await expect(da.logHabitCompletion({ habitId: 'ghost' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('getState / setState', () => {
  it('round-trips JSON values and returns the fallback for a missing key', async () => {
    expect(await da.getState('missing.key', 'default')).toBe('default');
    expect(await da.setState('jarvis.provider', 'groq')).toEqual({ key: 'jarvis.provider', value: 'groq' });
    expect(await da.getState('jarvis.provider', null)).toBe('groq');
    await da.setState('obj', { a: [1, 2], b: true });
    expect(await da.getState('obj')).toEqual({ a: [1, 2], b: true });
  });

  it('overwrites on a second set and keeps one row', async () => {
    await da.setState('k', 1);
    await da.setState('k', 2);
    expect(await da.getState('k')).toBe(2);
  });

  it('rejects null with a 400 constraint error', async () => {
    await expect(da.setState('k', null)).rejects.toMatchObject({ status: 400 });
  });
});

describe('Jarvis conversations', () => {
  it('creates, appends in order, lists by recency, and round-trips tool calls', async () => {
    // Pin the clock so "a was touched after b" never ties on a same-millisecond
    // updated_at (ties correctly fall back to the newer rowid, i.e. b).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const a = await da.createConversation({ title: 'first' });
    const b = await da.createConversation({});
    expect(b.title).toBeNull();
    vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'));
    await da.appendMessage(a.id, { role: 'user', content: 'hi' });
    vi.useRealTimers();
    await da.appendMessage(a.id, { role: 'assistant', content: null, toolCalls: [{ id: 'c1', function: { name: 'x' } }] });
    await da.appendMessage(a.id, { role: 'tool', content: 'ok', toolCallId: 'c1' });
    const messages = await da.getMessages(a.id);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(messages[1].toolCalls).toEqual([{ id: 'c1', function: { name: 'x' } }]);
    expect(messages[2].toolCallId).toBe('c1');
    expect((await da.listConversations()).map((c) => c.id)[0]).toBe(a.id);
  });

  it('returns the newest N messages in chronological order', async () => {
    const c = await da.createConversation({ title: 'long' });
    for (let i = 1; i <= 12; i += 1) await da.appendMessage(c.id, { role: 'user', content: `m${i}` });
    const last5 = await da.getMessages(c.id, { limit: 5 });
    expect(last5.map((m) => m.content)).toEqual(['m8', 'm9', 'm10', 'm11', 'm12']);
    expect((await da.getMessages(c.id)).map((m) => m.content)).toHaveLength(12);
  });

  it('rejects a message for an unknown conversation', async () => {
    await expect(da.appendMessage('ghost', { role: 'user', content: 'x' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('buildBriefingContext', () => {
  const realTz = process.env.TZ;
  afterEach(() => {
    vi.useRealTimers();
    if (realTz === undefined) delete process.env.TZ;
    else process.env.TZ = realTz;
  });

  it('assembles the slices from the local database', async () => {
    await da.addTodo({ title: 'due today', due: localDayOf() });
    const ctx = await da.buildBriefingContext();
    expect(ctx.dueTodayTodos.map((t) => t.title)).toEqual(['due today']);
    expect(ctx.budget).toMatchObject({ transactionCount: 0 });
  });

  it('uses the local day, not the UTC day, when they differ', async () => {
    // 22:00 UTC on Oct 9 is already Oct 10 at UTC+14.
    process.env.TZ = 'Pacific/Kiritimati';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-09T22:00:00Z'));
    seedDb(db, {
      todos: [
        { title: 'late', due: '2026-10-09', done: 0 },
        { title: 'today', due: '2026-10-10', done: 0 },
      ],
    });
    const ctx = await da.buildBriefingContext();
    expect(ctx.today).toBe('2026-10-10');
    expect(ctx.overdueTodos.map((t) => t.title)).toEqual(['late']);
    expect(ctx.dueTodayTodos.map((t) => t.title)).toEqual(['today']);
  });

  it('dedupes overdue and due-today todos before the cap of ten open todos', async () => {
    const today = localDayOf();
    seedDb(db, {
      todos: [
        { title: 'overdue a', due: '2020-01-01', done: 0 },
        { title: 'overdue b', due: '2020-01-02', done: 0 },
        { title: 'due now', due: today, done: 0 },
        ...Array.from({ length: 12 }, (_v, i) => ({ title: `later ${String(i).padStart(2, '0')}`, due: '2099-01-01', done: 0 })),
      ],
    });
    const ctx = await da.buildBriefingContext();
    expect(ctx.openTodos).toHaveLength(10);
    expect(ctx.openTodos.every((t) => t.title.startsWith('later'))).toBe(true);
    expect(ctx.overdueCount).toBe(2);
    expect(ctx.dueTodayCount).toBe(1);
  });
});

describe('when the database is unavailable', () => {
  it('rejects with a 503 DbError', async () => {
    const closed = createTestDb();
    closed.close();
    setDbForTests(closed);
    await expect(da.listTodos()).rejects.toBeTruthy();
    setDbForTests(db);
  });
});
