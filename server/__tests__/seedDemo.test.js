import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../../scripts/seedDemo.js';
import { IMPORT_ORDER, insert, select } from '../db/index.js';
import { closeTestDb, createTestDb } from './helpers/testDb.js';

const NOW = new Date(2026, 5, 15, 10, 0, 0);
const TODAY = '2026-06-15';
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const SKIP = new Set(['jarvis_conversations', 'jarvis_messages', 'jarvis_memory']);
const SEEDED_TABLES = IMPORT_ORDER.filter((t) => !SKIP.has(t));

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function streakOf(dates) {
  let n = 0;
  const cur = new Date(NOW);
  if (!dates.has(iso(cur))) cur.setDate(cur.getDate() - 1);
  while (dates.has(iso(cur))) {
    n += 1;
    cur.setDate(cur.getDate() - 1);
  }
  return n;
}

describe('seedDemo', () => {
  let db;
  let result;

  beforeEach(async () => {
    db = createTestDb();
    result = await seedDemo({ insert, now: NOW });
  });
  afterEach(() => closeTestDb(db));

  it('fills every user-facing table', () => {
    for (const table of SEEDED_TABLES) {
      expect(result.counts[table], table).toBeGreaterThan(0);
      expect(select(table).length, table).toBe(result.counts[table]);
    }
  });

  it('seeds the budget plan keys and profile', () => {
    const state = Object.fromEntries(select('app_state').map((r) => [r.key, r.value]));
    for (const key of ['budget:targets', 'budget:structure', 'budget:defaults', 'budget:payees', 'profile']) {
      expect(state, key).toHaveProperty(key);
    }
    expect(state.profile.displayName).toBe('Demo');
    expect(state['budget:payees'][0]).toMatchObject({ every: 2, unit: 'week' });
    expect(Object.keys(state['budget:targets'])[0]).toMatch(/^\d{4}-\d{2}\|cat-/);
  });

  it('seeds recurring subscriptions with equal amounts in at least 3 months', () => {
    const txs = select('transactions');
    for (const merchant of ['Streamflix', 'Tunebox', 'CloudLocker', 'Fit Club']) {
      const rows = txs.filter((t) => t.merchant === merchant);
      const months = new Set(rows.map((t) => t.date.slice(0, 7)));
      expect(months.size, merchant).toBeGreaterThanOrEqual(3);
      expect(new Set(rows.map((t) => t.amount)).size, merchant).toBe(1);
    }
    expect(txs.filter((t) => t.merchant === 'Pixelvault Pro')).toHaveLength(2);
  });

  it('keeps debits negative, credits positive and no future dates', () => {
    for (const t of select('transactions')) {
      expect(t.type === 'credit' ? t.amount > 0 : t.amount < 0).toBe(true);
      expect(t.date <= TODAY).toBe(true);
    }
  });

  it('gives habits streaks of 0, 3, 12 and 30', () => {
    const streaks = select('habits').map((h) =>
      streakOf(new Set(select('habit_completions', { where: { habit_id: h.id } }).map((c) => c.date))),
    );
    expect(streaks.sort((a, b) => a - b)).toEqual([0, 3, 12, 30]);
  });

  it('covers overdue, today, future and done todos, a pinned note and every mood', () => {
    const todos = select('todos');
    const open = todos.filter((t) => !t.done && t.due);
    expect(open.some((t) => t.due < TODAY)).toBe(true);
    expect(open.some((t) => t.due === TODAY)).toBe(true);
    expect(open.some((t) => t.due > TODAY)).toBe(true);
    expect(todos.some((t) => t.done)).toBe(true);
    expect(select('notes').filter((n) => n.pinned)).toHaveLength(1);
    expect([...new Set(select('journal').map((j) => j.mood))].sort()).toEqual(['down', 'good', 'great', 'okay', 'rough']);
  });

  it('is deterministic for a fixed now', async () => {
    const snapshot = () => select('transactions').map((t) => [t.date, t.merchant, t.amount]);
    const first = snapshot();
    closeTestDb(db);
    db = createTestDb();
    await seedDemo({ insert, now: NOW });
    expect(snapshot()).toEqual(first);
  });

  it('contains no emails or em dashes and only example.org links', () => {
    const text = JSON.stringify(SEEDED_TABLES.map((t) => select(t)));
    expect(text).not.toMatch(EMAIL_RE);
    expect(text).not.toContain(String.fromCharCode(0x2014));
    for (const b of select('bookmarks')) expect(new URL(b.url).hostname.endsWith('example.org')).toBe(true);
  });
});
