// Javi inbox routes through the real server.js: GET has no side effect, the read POST is the only source of
// the page on screen, strict validation with fixed copy, no-store everywhere, an own limiter outside the AI and
// global limits, and the briefing refresh route as the one owner of the manual-write read mark.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));
vi.mock('../javi/advisorService.js', () => ({ generateAdvice: vi.fn(), streamAdvice: vi.fn() }));
vi.mock('../auditHook.js', () => ({ recordAudit: vi.fn(async () => {}), setAuditSink: vi.fn() }));

import fetch from 'node-fetch';
import { generateAdvice } from '../javi/advisorService.js';
import { installFakeOllama } from './helpers/fakeOllama.js';
import { __resetAiForTests } from '../ai/index.js';
import { createTestDb, closeTestDb } from './helpers/testDb.js';
import { openDb, selectOne, setDbForTests } from '../db/index.js';
import { __resetDataGenerationForTests } from '../dataGeneration.js';
import { INBOX_PAGES, INBOX_STATE_KEY } from '../javi/inbox.js';

const FIXED = { message: 'Something went wrong. Try again.' };
let app;
let db;
let logs;

const saved = Object.fromEntries(['APP_PASSWORD', 'AUTH_SECRET', 'SECRETS_ENCRYPTION_KEY', 'BURROW_AI'].map((k) => [k, process.env[k]]));
beforeAll(async () => {
  for (const k of Object.keys(saved)) delete process.env[k];
  app = (await import('../../server.js')).default;
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
beforeEach(() => {
  db = createTestDb();
  __resetDataGenerationForTests();
  __resetAiForTests();
  fetch.mockReset();
  installFakeOllama(fetch);
  logs = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  if (db) closeTestDb(db);
  db = null;
});

const row = () => selectOne('app_state', { where: { key: INBOX_STATE_KEY } });
const read = (body) => request(app).post('/api/jarvis/inbox/read').set('Content-Type', 'application/json').send(JSON.stringify(body));

describe('GET /api/jarvis/inbox', () => {
  it('lists items and the unseen pages, no-store, and has no side effect even with ?active=', async () => {
    const res = await request(app).get('/api/jarvis/inbox?active=budget');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { items: [], unseen: [...INBOX_PAGES] } });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(row()).toBe(null);
  });
});

describe('POST /api/jarvis/inbox/read', () => {
  it('empty ids with the old active key is valid (ignored) and writes the baseline', async () => {
    const res = await read({ ids: [], active: 'budget' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { items: [], unseen: [...INBOX_PAGES] } });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(row().value).toMatchObject({ v: 1, pages: {} });
  });

  it('active null, an empty string or absent are all valid', async () => {
    for (const body of [{ ids: [] }, { active: null }, { active: '' }, {}]) expect((await read(body)).status).toBe(200);
  });

  it('reading page:<key> marks a never-seen page seen and the answer drops it from unseen', async () => {
    const res = await read({ ids: ['page:budget'] });
    expect(res.status).toBe(200);
    expect(res.body.data.unseen).not.toContain('budget');
    expect(res.body.data.unseen).toContain('todos');
    expect(row().value.pages.budget).toEqual({ seenAt: expect.any(String), changedAt: null });
  });

  it('an own edit on the page puts it back in unseen and lists it as an item', async () => {
    await read({ ids: ['page:todos'], active: 'todos' });
    const add = await request(app).post('/api/todos').send({ title: 'x' });
    expect(add.status).toBeLessThan(300);
    await new Promise((r) => setImmediate(r));
    const res = await request(app).get('/api/jarvis/inbox');
    expect(res.body.data.unseen).toContain('todos');
    expect(res.body.data.items.map((i) => i.id)).toEqual(['page:todos']);
  });

  it.each([
    ['an unknown active key', { active: 'nope' }],
    ['an array active', { active: ['budget'] }],
    ['ids not an array', { ids: 'page:todos' }],
    ['a non-string id', { ids: [1] }],
    ['more than 20 ids', { ids: Array.from({ length: 21 }, () => 'folders') }],
    ['an unknown body key', { ids: [], other: 1 }],
    ['page:__proto__', { ids: ['page:__proto__'] }],
    ['a page outside the inbox pages', { ids: ['page:home'] }],
    ['an array body', []],
  ])('%s gives 400 with the fixed body', async (_name, body) => {
    const res = await read(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_request', code: 'invalid_request', ...FIXED });
    expect(row()).toBe(null);
  });

  it('a duplicate id is accepted once', async () => {
    const res = await read({ ids: ['folders', 'folders'] });
    expect(res.status).toBe(200);
  });

  it('a text/plain body gives 415 with the fixed body', async () => {
    const res = await request(app).post('/api/jarvis/inbox/read').set('Content-Type', 'text/plain').send('{"active":"budget"}');
    expect(res.status).toBe(415);
    expect(res.body).toEqual({ error: 'unsupported_media_type', code: 'unsupported_media_type', ...FIXED });
    expect(row()).toBe(null);
  });

  it('a database error gives 500 inbox_failed and a log line without the body', async () => {
    closeTestDb(db);
    db = null;
    const broken = openDb({ filename: ':memory:' });
    setDbForTests(broken);
    broken.close();
    const res = await read({ ids: ['page:todos'], active: 'journal' });
    setDbForTests(null);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'inbox_failed', code: 'inbox_failed', ...FIXED });
    const logged = JSON.stringify(logs.mock.calls);
    expect(logged).not.toContain('journal');
    expect(logged).not.toContain('page:todos');
  });
});

describe('limits', () => {
  it('25 read POSTs, then advice is not 429', async () => {
    for (let i = 0; i < 25; i += 1) expect((await read({ ids: [], active: 'todos' })).status).toBe(200);
    generateAdvice.mockResolvedValue({ content: 'ok', model: 'm', provider: 'ollama', ai: null, withheld: [], notice: null, blocked: false });
    const res = await request(app).post('/api/jarvis/advice').send({ page: 'todos', context: 'Todos: none.' });
    expect(res.status).not.toBe(429);
  });

  it('inbox calls skip the global limiter; the inbox limiter answers 429 after 300, still no-store', async () => {
    // Earlier tests in this file already spent part of the inbox budget (one limiter per file).
    let over = null;
    for (let i = 0; i < 320 && !over; i += 1) {
      const r = i % 2 ? await request(app).get('/api/jarvis/inbox') : await read({ ids: [] });
      if (r.status === 429) over = r;
      else expect(r.status).toBe(200);
    }
    expect(over?.status).toBe(429);
    expect(over.headers['cache-control']).toBe('no-store');
    // 300 inbox calls in this window: had they counted against the global 300, this would be 429 too.
    expect((await request(app).get('/api/bookmarks')).status).toBe(200);
  }, 30_000);
});

