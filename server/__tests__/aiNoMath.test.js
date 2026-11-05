// Product rule: AI summarizes, code calculates. Every number a model sees is computed natively
// (SQL/JS) and handed over as a result; no prompt asks the model to do arithmetic, and tool
// results are aggregates rather than lists the model would have to add up.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestDb, createTestDb, resetDb, seedDb } from './helpers/testDb.js';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));
vi.mock('../license/index.js', async (importOriginal) => (await import('./helpers/pro.js')).mockLicenseModule(importOriginal));

import { advisorSystemPrompt, AUTO_ADVICE_REQUEST, AUTO_ADVICE_REQUEST_SMALL } from '../javi/advisorPrompt.js';
import { buildBriefingContext } from '../dataAccess.js';
import { localDayOf } from '../relativeDay.js';
import fetch from 'node-fetch';
import { configureCloud, resetCloud } from './helpers/fakeCloud.js';
import { withheldMessage, withheldToolResult } from '../ai/index.js';

// Words that ask a model to do arithmetic.
const MATH_INSTRUCTION = /\b(calculate|compute|add (?:up|together)|sum (?:up|of)|subtract|multiply|divide|tally|work out the|average (?:of|the))\b/i;

// A prompt may forbid the model from computing (e.g. "don't compute dates yourself"); only
// affirmative instructions count, so drop negated clauses before matching.
const withoutProhibitions = (text) => text.replace(/(?:don't|do not|never|not)\s+(?:\w+\s+){0,2}?(?:calculate|compute|add|sum|subtract|multiply|divide|tally|work|average)/gi, '');

const DAY_MS = 24 * 60 * 60 * 1000;
// UTC day: the habit history and the budget month in dataAccess.js count in UTC days.
const isoDay = (offsetDays = 0) => new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);
// Server-local day: the briefing (`buildBriefingContext`, `buildBriefingSnapshot`) decides
// overdue and due-today with `localDayOf`, so its expectations must use the same clock, or the
// test fails between local midnight and UTC midnight (issue #88). Noon avoids DST edges.
const localDay = (offsetDays = 0, from = new Date()) =>
  localDayOf(new Date(from.getFullYear(), from.getMonth(), from.getDate() + offsetDays, 12));

describe('prompts never ask the model to do math', () => {
  const prompts = {
    'advisor system prompt': advisorSystemPrompt({ pageLabel: 'Budget', fenceTag: 'page_context_0123456789ab' }),
    'auto advice request': AUTO_ADVICE_REQUEST,
    'small advisor system prompt': advisorSystemPrompt({ variant: 'small' }),
    'small auto advice request': AUTO_ADVICE_REQUEST_SMALL,
  };

  it.each(Object.entries(prompts))('%s has no arithmetic instruction', (_label, text) => {
    expect(text.length).toBeGreaterThan(10);
    expect(withoutProhibitions(text)).not.toMatch(MATH_INSTRUCTION);
  });

  it('the guard regex does catch an instruction (not vacuous)', () => {
    expect(withoutProhibitions('Please add up the amounts and calculate the total.')).toMatch(MATH_INSTRUCTION);
    expect(withoutProhibitions("Use the given text; don't compute dates yourself.")).not.toMatch(MATH_INSTRUCTION);
  });

  it('the advisor prompt restricts the model to numbers present in the snapshot', () => {
    expect(prompts['advisor system prompt']).toContain('Use only numbers, names and dates present in the snapshot');
  });

  it('the advisor prompt tells the model not to compute dates', () => {
    expect(prompts['advisor system prompt']).toMatch(/don't compute dates yourself/);
  });
});

describe('tool results are aggregates, not lists the model must add', () => {
  let db;
  beforeAll(() => {
    db = createTestDb();
  });
  beforeEach(() => resetDb(db));
  afterAll(() => closeTestDb(db));

  const month = isoDay(0).slice(0, 7);
  const TXNS = [
    { merchant: 'Payroll', amount: 2500, date: `${month}-01`, category: 'Income', type: 'credit' },
    { merchant: 'Market', amount: -40.25, date: `${month}-01`, category: 'Groceries', type: 'debit' },
    { merchant: 'Market', amount: -60.5, date: `${month}-01`, category: 'Groceries', type: 'debit' },
    { merchant: 'Cafe', amount: -12.1, date: `${month}-01`, category: 'Dining', type: 'debit' },
    { merchant: 'Cafe', amount: -7.9, date: `${month}-01`, category: 'Dining', type: 'debit' },
    { merchant: 'Elsewhere', amount: -500, date: '2020-01-15', category: 'Groceries', type: 'debit' },
  ];
  const round = (n) => Math.round(n * 100) / 100;
  const inMonth = TXNS.filter((t) => t.date.startsWith(month));
  const income = round(inMonth.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0));
  const expenses = round(inMonth.filter((t) => t.amount < 0).reduce((s, t) => s - t.amount, 0));
  const byCat = (c) => round(inMonth.filter((t) => t.category === c && t.amount < 0).reduce((s, t) => s - t.amount, 0));

  function expectBudgetAggregate(summary) {
    expect(summary).toMatchObject({ month, income, expenses, net: round(income - expenses), transactionCount: inMonth.length });
    expect(summary.topCategories).toEqual([
      { category: 'Groceries', spent: byCat('Groceries') },
      { category: 'Dining', spent: byCat('Dining') },
    ]);
    // The model never receives raw transactions.
    expect(JSON.stringify(summary)).not.toMatch(/merchant|Market|Cafe|Payroll/);
  }

  it('the briefing context carries the same precomputed budget aggregate', async () => {
    seedDb(db, { transactions: TXNS });
    const ctx = await buildBriefingContext();
    expectBudgetAggregate(ctx.budget);
  });

  it('the briefing context pre-filters todos and habits so the model only reads, never counts', async () => {
    const today = localDay(0);
    seedDb(db, {
      todos: [
        { title: 'Past due', due: localDay(-2), done: false },
        { title: 'Due today', due: today, done: false },
        { title: 'Later', due: localDay(5), done: false },
      ],
      habits: [{ title: 'Read' }, { title: 'Run' }],
    });
    const ctx = await buildBriefingContext();
    expect(ctx.today).toBe(today);
    expect(ctx.overdueTodos.map((t) => t.title)).toEqual(['Past due']);
    expect(ctx.dueTodayTodos.map((t) => t.title)).toEqual(['Due today']);
    expect(ctx.habitsRemaining.map((h) => h.title).sort()).toEqual(['Read', 'Run']);
    expect(ctx.overdueCount).toBe(ctx.overdueTodos.length);
    expect(ctx.overdueCount).toBe(1);
    expect(ctx.dueTodayCount).toBe(1);
    expect(ctx.habitsRemainingCount).toBe(2);
  });

  // Regression for #88: pin the clock just before and just after local midnight. In any zone
  // that is not UTC one of the two instants falls on a different UTC day (23:30 local is the
  // next UTC day west of Greenwich, 00:30 local the previous UTC day east of it), so the
  // briefing must still count by the server-local day.
  describe('around local midnight', () => {
    afterEach(() => vi.useRealTimers());

    it.each([
      ['23:30', 23, 30],
      ['00:30', 0, 30],
    ])('at %s local the briefing counts overdue and due-today by the local day', async (_label, h, m) => {
      const now = new Date();
      const pinned = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(pinned);
      const today = localDay(0, pinned);
      if (pinned.getTimezoneOffset() !== 0 && Math.abs(pinned.getTimezoneOffset()) >= 60) {
        // Not vacuous outside UTC: the instant at the edge of the day the offset points to is
        // on another UTC day.
        const edge = (h === 23) === (pinned.getTimezoneOffset() > 0);
        if (edge) expect(pinned.toISOString().slice(0, 10)).not.toBe(today);
      }
      seedDb(db, {
        todos: [
          { title: 'Yesterday', due: localDay(-1, pinned), done: false },
          { title: 'Today', due: today, done: false },
          { title: 'Tomorrow', due: localDay(1, pinned), done: false },
        ],
      });
      const ctx = await buildBriefingContext();
      expect(ctx.today).toBe(today);
      expect(ctx.overdueTodos.map((t) => t.title)).toEqual(['Yesterday']);
      expect(ctx.dueTodayTodos.map((t) => t.title)).toEqual(['Today']);
      expect(ctx.openTodos.map((t) => t.title)).toEqual(['Tomorrow']);
      expect(ctx.overdueCount).toBe(1);
      expect(ctx.dueTodayCount).toBe(1);
    });
  });
});

describe('the cloud path keeps the same rule', () => {
  let db;
  beforeAll(() => {
    db = createTestDb();
  });
  beforeEach(async () => {
    resetDb(db);
    fetch.mockReset();
    await configureCloud({ categories: { health: true } });
  });
  afterAll(async () => {
    await resetCloud();
    closeTestDb(db);
  });


  it('the withheld copy asks for no arithmetic and tells the model not to guess', () => {
    const texts = [withheldMessage(['journal']), withheldMessage(['journal', 'health', 'notes']), withheldToolResult('journal').message, withheldToolResult(null).message];
    for (const t of texts) expect(withoutProhibitions(t)).not.toMatch(MATH_INSTRUCTION);
    expect(withheldToolResult('journal').message).toMatch(/Do not guess/);
  });
});
