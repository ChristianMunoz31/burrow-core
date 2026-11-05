// Javi inbox (server/javi/inbox.js): normalized read markers, derived items, the unseen pages and the write
// observer (every write counts, also one made on the page on screen; owner decision 2026-10-10). Real in-memory SQLite; the license module is real except getEntitlements (helpers/pro.js).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../license/index.js', async (importOriginal) => (await import('./helpers/pro.js')).mockLicenseModule(importOriginal));

import { createTestDb, closeTestDb } from './helpers/testDb.js';
import { FREE, resetPro, setEntitlements } from './helpers/pro.js';
import { TABLES, insert, remove, selectOne, update, upsert } from '../db/index.js';
import { bumpDataGeneration, runDataResetHooks } from '../dataGeneration.js';
import { importParsed } from '../import/importExport.js';
import * as ai from '../ai/index.js';
import {
  INBOX_PAGES,
  INBOX_STATE_KEY,
  STATE_KEY_PAGES,
  TABLE_PAGES,
  installInboxWriteObserver,
  listInboxItems,
  markPageSeen,
  markRead,
  normalizeInbox,
  readInbox,
  readInboxView,
} from '../javi/inbox.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tick = () => new Promise((r) => setImmediate(r));
const rawRow = () => selectOne('app_state', { where: { key: INBOX_STATE_KEY } });
const putRaw = (value) => upsert('app_state', { key: INBOX_STATE_KEY, value }, { conflict: ['key'] });
const todo = (title = 't') => ({ title, status: 'todo' });
const ids = () => listInboxItems().map((i) => i.id);
const unseen = () => readInboxView().unseen;

let db;
let uninstall;

beforeEach(() => {
  db = createTestDb();
  uninstall = installInboxWriteObserver();
});
afterEach(() => {
  uninstall();
  resetPro();
  closeTestDb(db);
  vi.restoreAllMocks();
});
afterAll(() => vi.useRealTimers());

describe('normalize and baseline', () => {
  const now = new Date('2026-10-09T08:00:00.000Z');

  it('a missing value is a baseline with createdAt = now', () => {
    expect(normalizeInbox(undefined, now)).toEqual({
      v: 1,
      createdAt: now.toISOString(),
      pages: {},
      briefingSeenAt: null,
      foldersSeenAt: null,
    });
  });

  it('a wrong version, a non-object or an oversized value is a baseline', () => {
    for (const raw of [{ v: 2, createdAt: '2020-01-01T00:00:00Z' }, 'x', [1], { v: 1, createdAt: '2020-01-01T00:00:00Z', pad: 'x'.repeat(5000) }]) {
      expect(normalizeInbox(raw, now).createdAt).toBe(now.toISOString());
    }
  });

  it('pages are rebuilt over the allowlist; __proto__ and unknown keys are dropped', () => {
    const raw = JSON.parse(
      '{"v":1,"createdAt":"2026-10-01T00:00:00Z","pages":{"__proto__":{"seenAt":"2026-10-01T00:00:00Z","changedAt":null},"home":{"seenAt":"2026-10-01T00:00:00Z","changedAt":null},"todos":{"seenAt":"2026-10-02T00:00:00Z","changedAt":null},"notes":{"seenAt":"bad","changedAt":null},"bookmarks":{"seenAt":"2026-10-02T00:00:00Z","changedAt":null,"x":1}},"extra":1}',
    );
    const s = normalizeInbox(raw, now);
    expect(Object.keys(s.pages)).toEqual(['todos']);
    expect(Object.getPrototypeOf(s.pages)).toBe(null);
    expect(s.pages.todos).toEqual({ seenAt: '2026-10-02T00:00:00.000Z', changedAt: null });
    expect(s).not.toHaveProperty('extra');
  });

  it('a marker stored under the old weather page key (weather has no page any more) is dropped, the rest kept', () => {
    const raw = {
      v: 1,
      createdAt: '2026-10-01T00:00:00.000Z',
      pages: {
        weather: { seenAt: '2026-10-02T00:00:00.000Z', changedAt: '2026-10-03T00:00:00.000Z' },
        calendar: { seenAt: '2026-10-02T00:00:00.000Z', changedAt: null },
      },
      briefingSeenAt: null,
      foldersSeenAt: null,
    };
    const s = normalizeInbox(raw, now);
    expect(Object.keys(s.pages)).toEqual(['calendar']);
    putRaw(raw);
    expect(listInboxItems()).toEqual([]);
    markRead([]);
    expect(rawRow().value.pages).not.toHaveProperty('weather');
    expect(rawRow().value.pages.calendar).toEqual({ seenAt: '2026-10-02T00:00:00.000Z', changedAt: null });
  });

  it('GET-side reads never write; an oversized row is rewritten canonical only by the next read POST', () => {
    putRaw({ v: 1, createdAt: '2026-10-01T00:00:00.000Z', pad: 'x'.repeat(5000) });
    readInbox();
    listInboxItems();
    expect(rawRow().value.pad).toHaveLength(5000);
    markRead([]);
    expect(rawRow().value).not.toHaveProperty('pad');
    expect(rawRow().value.v).toBe(1);
  });

  it('markRead with no ids writes the baseline when the row is missing', () => {
    expect(rawRow()).toBe(null);
    markRead([]);
    expect(rawRow().value).toMatchObject({ v: 1, pages: {}, briefingSeenAt: null, foldersSeenAt: null });
  });

  it('allowlists and tables line up', () => {
    expect(INBOX_PAGES).toHaveLength(12);
    expect(INBOX_PAGES).toContain('health');
    for (const t of Object.keys(TABLE_PAGES)) expect(Object.hasOwn(TABLES, t)).toBe(true);
    expect(Object.keys(STATE_KEY_PAGES).sort()).toEqual(['budget:defaults', 'budget:payees', 'budget:spent', 'budget:structure', 'budget:targets']);
    expect(INBOX_PAGES).not.toContain('weather');
  });
});

describe('write observer', () => {
  it('a page never seen never flags', async () => {
    insert('todos', todo());
    await tick();
    expect(ids()).toEqual([]);
  });

  it('a write after seen flags once; a second write makes no extra state write', async () => {
    markPageSeen('todos');
    insert('todos', todo('a'));
    await tick();
    expect(ids()).toEqual(['page:todos']);
    const first = rawRow().value;
    const item = listInboxItems()[0];
    expect(item).toMatchObject({ kind: 'page', page: 'todos', to: '/todos', label: 'Todos changed since your last insight' });
    insert('todos', todo('b'));
    await tick();
    expect(rawRow().value).toEqual(first);
  });

  it('read clears the page, and a later write elsewhere flags it again', async () => {
    markPageSeen('notes');
    insert('notes', { body: 'x' });
    await tick();
    markRead(['page:notes']);
    expect(ids()).toEqual([]);
    expect(rawRow().value.pages.notes.changedAt).toBe(null);
    insert('notes', { body: 'y' });
    await tick();
    expect(ids()).toEqual(['page:notes']);
  });

  it('coalesces many writes into one flush', async () => {
    markPageSeen('bookmarks');
    const spy = vi.fn();
    const { onTableWrite } = await import('../db/writeEvents.js');
    const off = onTableWrite((t, k) => t === 'app_state' && k === INBOX_STATE_KEY && spy());
    const rows = Array.from({ length: 50 }, (_, i) => ({ title: `b${i}`, url: `https://example.com/${i}` }));
    const { insertMany } = await import('../db/index.js');
    insertMany('bookmarks', rows);
    await tick();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(ids()).toEqual(['page:bookmarks']);
    off();
  });

  it('the five budget data keys flag budget and planner; preferences and other keys do not', async () => {
    markPageSeen('budget');
    markPageSeen('budget-planner');
    upsert('app_state', { key: 'budget:defaultView', value: 'month' }, { conflict: ['key'] });
    upsert('app_state', { key: 'budget:defaultMonth', value: '2026-10' }, { conflict: ['key'] });
    upsert('app_state', { key: 'theme', value: 'dark' }, { conflict: ['key'] });
    await tick();
    expect(ids()).toEqual([]);
    upsert('app_state', { key: 'budget:targets', value: { food: 1 } }, { conflict: ['key'] });
    await tick();
    expect(ids().sort()).toEqual(['page:budget', 'page:budget-planner']);
  });

  it('todo_columns writes flag nothing', async () => {
    markPageSeen('todos');
    insert('todo_columns', { name: 'Later', order: 9 });
    await tick();
    expect(ids()).toEqual([]);
  });

  it('a javi.inbox write does not recurse', async () => {
    markPageSeen('todos');
    insert('todos', todo());
    await tick();
    await tick();
    const v = rawRow().value;
    await tick();
    expect(rawRow().value).toEqual(v);
  });

  it('a stale generation drops the flush (captured when the first page entered the pending set)', async () => {
    markPageSeen('todos');
    insert('todos', todo());
    bumpDataGeneration();
    await tick();
    expect(ids()).toEqual([]);
  });

  it('a data reset clears the pending set', async () => {
    markPageSeen('todos');
    insert('todos', todo());
    runDataResetHooks();
    await tick();
    expect(ids()).toEqual([]);
  });

  it('a dry-run import emits nothing and flags nothing', async () => {
    markPageSeen('todos');
    const { onTableWrite } = await import('../db/writeEvents.js');
    const seen = [];
    const off = onTableWrite((t) => seen.push(t));
    const parsed = {
      format: 'burrow-export',
      formatVersion: 2,
      manifest: {},
      tables: new Map([['todos', [{ id: '11111111-1111-4111-8111-111111111111', title: 'imported', status: 'todo' }]]]),
    };
    const result = importParsed(parsed, { dryRun: true });
    expect(result.dryRun).toBe(true);
    await tick();
    expect(seen).toEqual([]);
    expect(ids()).toEqual([]);
    off();
  });

  it('a flush and a markRead in the same tick both keep their changes', async () => {
    markPageSeen('todos');
    markPageSeen('notes');
    insert('notes', { body: 'x' });
    await tick();
    insert('todos', todo());
    markRead(['page:notes']);
    await tick();
    expect(ids()).toEqual(['page:todos']);
    expect(rawRow().value.pages.notes.changedAt).toBe(null);
  });
});

describe('own edits count (R1 reversed 2026-10-10)', () => {
  it('a todo insert flags todos even when it was made on the Todos page', async () => {
    markPageSeen('todos');
    insert('todos', todo());
    await tick();
    expect(ids()).toEqual(['page:todos']);
    expect(unseen()).toContain('todos');
  });

  it('a transaction flags budget, planner and subscriptions', async () => {
    for (const p of ['budget', 'budget-planner', 'subscriptions']) markPageSeen(p);
    insert('transactions', { date: '2026-10-01', merchant: 'Shop', amount: -5, category: 'Food', type: 'expense' });
    await tick();
    expect(ids().sort()).toEqual(['page:budget', 'page:budget-planner', 'page:subscriptions']);
  });

  it('a delete and an update flag too', async () => {
    const row = insert('todos', todo());
    markPageSeen('todos');
    update('todos', { title: 'z' }, { where: { id: row.id } });
    await tick();
    expect(ids()).toEqual(['page:todos']);
    markRead(['page:todos']);
    remove('todos', { where: { id: row.id } });
    await tick();
    expect(ids()).toEqual(['page:todos']);
  });
});

describe('unseen pages', () => {
  it('a fresh store lists every inbox page as unseen, in allowlist order', () => {
    expect(unseen()).toEqual([...INBOX_PAGES]);
    expect(rawRow()).toBe(null);
  });

  it('an old store without markers means never seen; a seen page leaves the list', () => {
    putRaw({ v: 1, createdAt: '2026-10-01T00:00:00.000Z', pages: { notes: { seenAt: '2026-10-02T00:00:00.000Z', changedAt: null } } });
    expect(unseen()).not.toContain('notes');
    expect(unseen()).toContain('todos');
    expect(readInboxView().items).toEqual([]);
  });

  it('reading a page id marks a never-seen page seen (opening Javi there)', () => {
    markRead(['page:health']);
    expect(rawRow().value.pages.health).toEqual({ seenAt: expect.any(String), changedAt: null });
    expect(unseen()).not.toContain('health');
    expect(ids()).toEqual([]);
  });

  it('a change after seen puts the page back, a read takes it out again', async () => {
    markRead(['page:todos']);
    expect(unseen()).not.toContain('todos');
    insert('todos', todo());
    await tick();
    expect(unseen()).toContain('todos');
    markRead(['page:todos']);
    expect(unseen()).not.toContain('todos');
  });

  it('advice success marks the page seen too', () => {
    markPageSeen('budget');
    expect(unseen()).not.toContain('budget');
  });
});

describe('briefing item', () => {
  const putBriefing = (generatedAt) =>
    upsert('app_state', { key: 'jarvis.briefing.latest', value: { generatedAt, digest: 'd', alerts: [] } }, { conflict: ['key'] });

  it('is Pro only and newer than the marker', () => {
    putBriefing(new Date(Date.now() - 60_000).toISOString());
    markRead([]);
    // A briefing written before the baseline never surfaces.
    expect(ids()).toEqual([]);
    const created = Date.parse(rawRow().value.createdAt);
    putBriefing(new Date(created + 1).toISOString());
    const later = { now: () => new Date(created + 60_000) };
    expect(listInboxItems(later).map((i) => i.id)).toEqual(['briefing']);
    expect(listInboxItems(later)[0]).toMatchObject({ kind: 'briefing', page: 'home', to: '/', label: "Today's briefing is ready" });
    setEntitlements(FREE);
    expect(listInboxItems(later)).toEqual([]);
  });

  it('a future or invalid generatedAt gives no item', () => {
    putRaw({ v: 1, createdAt: '2026-01-01T00:00:00.000Z', pages: {}, briefingSeenAt: null, foldersSeenAt: null });
    putBriefing(new Date(Date.now() + 86_400_000).toISOString());
    expect(ids()).toEqual([]);
    upsert('app_state', { key: 'jarvis.briefing.latest', value: { generatedAt: 'not a date' } }, { conflict: ['key'] });
    expect(ids()).toEqual([]);
  });

  it('marking it read sets the marker to max(now, at)', () => {
    putRaw({ v: 1, createdAt: '2026-01-01T00:00:00.000Z', pages: {}, briefingSeenAt: null, foldersSeenAt: null });
    const at = new Date(Date.now() - 5000).toISOString();
    putBriefing(at);
    expect(ids()).toEqual(['briefing']);
    const now = new Date();
    markRead(['briefing'], { now: () => now });
    expect(rawRow().value.briefingSeenAt).toBe(now.toISOString());
    expect(ids()).toEqual([]);
  });

  it('a Free user marking briefing read is a no-op', () => {
    putRaw({ v: 1, createdAt: '2026-01-01T00:00:00.000Z', pages: {}, briefingSeenAt: null, foldersSeenAt: null });
    putBriefing(new Date(Date.now() - 5000).toISOString());
    setEntitlements(FREE);
    markRead(['briefing']);
    expect(rawRow().value.briefingSeenAt).toBe(null);
  });
});

describe('folders item', () => {
  const folder = (name, patch) => {
    const f = insert('folders', { name, path: `/tmp/${name}`, path_key: `/tmp/${name}`, stats: {}, summary_status: 'none' });
    update('folders', patch, { where: { id: f.id } });
    return f.id;
  };
  const base = { v: 1, createdAt: '2026-01-01T00:00:00.000Z', pages: {}, briefingSeenAt: null, foldersSeenAt: null };

  it('counts only confirmed folders with a summary, never a future summary_at', () => {
    putRaw(base);
    const recent = new Date(Date.now() - 60_000).toISOString();
    const id = folder('a', { confirm_state: 'ok', summary_status: 'ok', summary_at: recent });
    folder('b', { confirm_state: 'needs_confirm', summary_status: 'ok', summary_at: recent });
    folder('c', { confirm_state: 'ok', summary_status: 'ok', summary_at: new Date(Date.now() + 86_400_000).toISOString() });
    folder('d', { confirm_state: 'ok', summary_status: 'error', summary_at: recent });
    const items = listInboxItems();
    expect(items).toHaveLength(1);
    // Folders is a Journal page, so its item counts in Journal only.
    expect(items[0]).toMatchObject({ id: 'folders', kind: 'folders', page: null, label: 'A folder summary is ready', count: 1 });
    expect(items[0].to).toBe(`/folders?folder=${encodeURIComponent(id)}`);
  });

  it('two summaries list the count and the folders route', () => {
    putRaw(base);
    const recent = new Date(Date.now() - 60_000).toISOString();
    folder('a', { confirm_state: 'ok', summary_status: 'ok', summary_at: recent });
    folder('b', { confirm_state: 'ok', summary_status: 'ok', summary_at: recent });
    expect(listInboxItems()[0]).toMatchObject({ label: '2 folder summaries are ready', to: '/folders', count: 2 });
  });

  it('a baseline on upgrade hides older summaries', () => {
    folder('a', { confirm_state: 'ok', summary_status: 'ok', summary_at: new Date(Date.now() - 60_000).toISOString() });
    expect(ids()).toEqual([]);
    markRead([]);
    expect(ids()).toEqual([]);
  });

  it('marking folders read clears it', () => {
    putRaw(base);
    folder('a', { confirm_state: 'ok', summary_status: 'ok', summary_at: new Date(Date.now() - 60_000).toISOString() });
    markRead(['folders']);
    expect(ids()).toEqual([]);
  });
});

describe('boundaries', () => {
  it('labels are fixed copy with no user text', async () => {
    markPageSeen('notes');
    insert('notes', { body: 'SECRET-NOTE-TEXT' });
    await tick();
    expect(JSON.stringify(listInboxItems())).not.toContain('SECRET');
  });

  it('the module imports nothing from the AI layer and not dataAccess.js', () => {
    const src = fs.readFileSync(path.join(here, '..', 'javi', 'inbox.js'), 'utf8');
    const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    expect(imports.some((p) => p.includes('/ai/') || p.startsWith('../ai'))).toBe(false);
    expect(imports.some((p) => p.includes('dataAccess'))).toBe(false);
  });

  it('never asks for an AI client', async () => {
    const spy = vi.spyOn(ai, 'getAiClient');
    markPageSeen('todos');
    insert('todos', todo());
    await tick();
    listInboxItems();
    markRead(['page:todos', 'briefing', 'folders']);
    expect(spy).not.toHaveBeenCalled();
  });
});
