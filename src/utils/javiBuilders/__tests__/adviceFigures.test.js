// Product rule: AI summarizes, code calculates. A 7B model got budget figures wrong because the page
// context mixed planned and actual figures under bare names ("income", "expenses") and left it to
// subtract what was left and add up a capped list. These tests pin the fix: every figure the model
// may quote is precomputed and says whether it is planned or actual, what is left is given, the
// over-budget list comes with its full count and total, and no raw row dump is sent.
import { describe, it, expect } from 'vitest';
import { buildBudgetDashboardContext, buildBudgetPlannerContext } from '../budget';
import { buildTodosContext } from '../todos';
import { buildHabitsContext } from '../habits';
import { buildSubscriptionsContext } from '../subscriptions';
import { buildCountdownsContext } from '../countdowns';
import { serializeJaviContext } from '../../javiContext';
import { advisorSystemPrompt, buildAdvisorMessages } from '../../../../server/javi/advisorPrompt.js';

const MONEY = /^-?\$\d{1,3}(?:,\d{3})*\.\d{2}$/;
const NOW = new Date(2026, 9, 2, 12, 0);

/** Money as the builder prints it, for comparing against an independent calculation. */
const fmt = (n) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const cents = (n) => Math.round(n * 100) / 100;

/** Every array in the structure, with the path it was found at. */
function arraysIn(value, path = '', out = []) {
  if (Array.isArray(value)) {
    out.push([path, value]);
    value.forEach((v, i) => arraysIn(v, `${path}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) arraysIn(v, path ? `${path}.${k}` : k, out);
  }
  return out;
}

// 40 categories, 25 of them over budget by a different amount each: far more rows than any cap.
const rows = Array.from({ length: 40 }, (_v, i) => ({
  name: `Category ${i}`,
  budgeted: i < 25 ? 100 : 0,
  spent: i < 25 ? 100 + (i + 1) * 3.37 : 12.5 + i,
}));
const groups = Array.from({ length: 6 }, (_v, g) => ({
  name: `Group ${g}`,
  isIncome: g === 0,
  budgeted: 1000 * (g + 1),
  spent: 900 * (g + 1),
  remaining: 100 * (g + 1),
  categories: rows.slice(g * 5, g * 5 + 5).map((r, i) => ({ id: `c${g}${i}`, ...r, remaining: r.budgeted - r.spent })),
}));
const totals = { incomeBudgeted: 6000, incomeSpent: 5400, expenseBudgeted: 2500, expenseSpent: 3100.75, netBudgeted: 3500, netActual: 2299.25 };
const plan = { groups, totals };

describe('budget dashboard context', () => {
  const ctx = buildBudgetDashboardContext({ month: '2026-10', plan, rows });

  it('does not send the card summary, whose figures mix planned and actual under bare names', () => {
    expect(ctx).not.toHaveProperty('summary');
    const keys = Object.keys(ctx.totals);
    for (const bare of ['income', 'expenses', 'net']) expect(keys).not.toContain(bare);
  });

  it('names the basis of every total: planned apart from received, spent or actual', () => {
    expect(ctx.totals).toMatchObject({
      'income planned': '$6,000.00',
      'income received': '$5,400.00',
      'expenses planned': '$2,500.00',
      'expenses spent': '$3,100.75',
      'net planned': '$3,500.00',
      'net actual': '$2,299.25',
    });
  });

  it('carries what is left as a ready figure, negative when over, so the model never subtracts', () => {
    expect(ctx.totals['expenses remaining']).toBe(fmt(cents(totals.expenseBudgeted - totals.expenseSpent)));
    expect(ctx.totals['expenses remaining']).toBe('-$600.75');
  });

  it('carries both savings rates as ready percents, planned apart from actual', () => {
    expect(ctx.totals['savings rate planned']).toBe(`${Math.round((3500 / 6000) * 100)}%`);
    expect(ctx.totals['savings rate actual']).toBe(`${Math.round((2299.25 / 5400) * 100)}%`);
    const none = buildBudgetDashboardContext({ plan: { groups: [], totals: { incomeBudgeted: 0, incomeSpent: 0 } } });
    expect(none.totals['savings rate planned']).toBeNull(); // no income, no rate, no divide by zero
  });

  it('gives the full count and total of the capped over-budget list, matching an independent sum', () => {
    const over = rows.filter((r) => r.budgeted > 0 && r.spent > r.budgeted).map((r) => cents(r.spent - r.budgeted));
    expect(over).toHaveLength(25);
    expect(ctx['over budget']).toHaveLength(8); // capped, so the model must not count or add the rows
    expect(ctx['categories over budget']).toBe(25);
    expect(ctx['total over budget']).toBe(fmt(cents(over.reduce((a, b) => a + b, 0))));
  });

  it('sends no raw row lists: every list is capped and nothing is a transaction or category dump', () => {
    for (const [path, list] of arraysIn(ctx)) expect(list.length, path).toBeLessThanOrEqual(12);
    expect(Object.keys(ctx)).not.toEqual(expect.arrayContaining(['rows', 'transactions', 'items', 'categories']));
    expect(JSON.stringify(ctx)).not.toMatch(/Category (?:3[0-9]|2[5-9])/); // rows beyond the caps never appear
  });

  it('prints every money value as a $ string', () => {
    for (const [k, v] of Object.entries(ctx.totals)) {
      expect(v, k).toMatch(k.startsWith('savings rate') ? /^-?\d+%$/ : MONEY);
    }
    expect(ctx['total over budget']).toMatch(MONEY);
  });
});

describe('budget planner context', () => {
  const ctx = buildBudgetPlannerContext({ month: '2026-10', plan });

  it('carries the same labelled totals and what is left, with capped lists', () => {
    expect(ctx.totals['expenses remaining']).toBe('-$600.75');
    expect(ctx.totals['income planned']).toBe('$6,000.00');
    for (const [path, list] of arraysIn(ctx)) expect(list.length, path).toBeLessThanOrEqual(12);
  });
});

describe('budget groups and rates', () => {
  const ctx = buildBudgetDashboardContext({ month: '2026-10', plan, rows });

  it('income groups say received and still to come, never spent and remaining', () => {
    const income = ctx.groups.find((g) => g.type === 'income');
    expect(income).toEqual({ name: 'Group 0', type: 'income', budgeted: '$1,000.00', received: '$900.00', 'still to come': '$100.00' });
    const expense = ctx.groups.find((g) => g.type === 'expense');
    expect(expense).toHaveProperty('spent');
    expect(expense).toHaveProperty('remaining');
    expect(expense).not.toHaveProperty('received');
  });

  it('a savings rate needs both figures to be real numbers', () => {
    const rate = (t) => buildBudgetDashboardContext({ plan: { groups: [], totals: t } }).totals;
    expect(rate({ incomeBudgeted: 1000, incomeSpent: 1000, netBudgeted: undefined, netActual: undefined })).toMatchObject({
      'savings rate planned': null,
      'savings rate actual': null,
    });
    expect(rate({ incomeBudgeted: NaN, incomeSpent: 1000, netBudgeted: 5, netActual: 500 })).toMatchObject({
      'savings rate planned': null,
      'savings rate actual': '50%',
    });
    expect(rate({ incomeBudgeted: 1000, incomeSpent: 1000, netBudgeted: Infinity, netActual: 100 })['savings rate planned']).toBeNull();
  });
});

describe('every capped list carries its full count', () => {
  const day = (n) => {
    const d = new Date(2026, 9, 2 + n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  it('todos: overdue, due this week and high priority counts match the full lists, not the caps', () => {
    const todos = [
      ...Array.from({ length: 14 }, (_v, i) => ({ title: `Late ${i}`, due: day(-1 - i), priority: 'high' })),
      ...Array.from({ length: 12 }, (_v, i) => ({ title: `Soon ${i}`, due: day(i % 7), priority: 'low' })),
      { title: 'Finished', done: true, due: day(-3), priority: 'high' },
    ];
    const ctx = buildTodosContext({ todos, now: NOW });
    expect(ctx.overdue).toHaveLength(10);
    expect(ctx['due this week']).toHaveLength(10);
    expect(ctx['high priority']).toHaveLength(10);
    expect(ctx.counts).toMatchObject({ 'overdue count': 14, 'due this week count': 12, 'high priority count': 14 });
  });

  it('habits: totals and the best streak cover every habit, not the 20 listed', () => {
    const today = day(0);
    const habits = Array.from({ length: 25 }, (_v, i) => ({
      title: `Habit ${i}`,
      frequency: 'daily',
      completions: i === 23 ? [today, day(-1), day(-2)] : i % 2 ? [today] : [],
    }));
    const ctx = buildHabitsContext({ habits, now: NOW });
    expect(ctx.habits).toHaveLength(20);
    expect(ctx['habits total']).toBe(25);
    expect(ctx['habits done today']).toBe(habits.filter((h) => h.completions.includes(today)).length);
    expect(ctx['best streak']).toBe('3 days'); // the habit at index 23 is beyond the 20 listed
  });

  it('subscriptions: counts come with the capped lists, and each date is in plain words', () => {
    const items = Array.from({ length: 20 }, (_v, i) => ({
      merchant: `Service ${i}`,
      merchantKey: `service ${i}`,
      cadence: 'monthly',
      typicalAmount: 10,
      monthlyEquivalent: 10,
      nextExpected: i === 0 ? day(3) : day(0),
      active: true,
      kind: i >= 16 ? 'bill' : 'subscription',
    }));
    const ctx = buildSubscriptionsContext({ result: { items, monthlyTotal: 200, yearlyTotal: 2400 }, now: NOW });
    expect(ctx.items).toHaveLength(15);
    expect(ctx.bills).toHaveLength(4);
    expect(ctx.activeCount).toBe(16);
    expect(ctx.billsActiveCount).toBe(4);
    expect(ctx.items[0].when).toBe('in 3 days');
    expect(ctx.items[1].when).toBe('today');
  });

  it('planner: overspent and unbudgeted counts and totals match an independent calculation', () => {
    const cats = Array.from({ length: 14 }, (_v, i) => ({ id: `o${i}`, name: `Over ${i}`, budgeted: 100, spent: 110 + i, remaining: -(10 + i) }));
    const free = Array.from({ length: 9 }, (_v, i) => ({ id: `f${i}`, name: `Free ${i}`, budgeted: 0, spent: 5 + i, remaining: -(5 + i) }));
    const ctx = buildBudgetPlannerContext({
      plan: { groups: [{ name: 'Needs', isIncome: false, budgeted: 1, spent: 1, remaining: 0, categories: [...cats, ...free] }], totals },
    });
    expect(ctx.overspent).toHaveLength(8);
    expect(ctx['spent without a budget']).toHaveLength(5);
    // every negative remaining counts as overspent, the unbudgeted ones included
    expect(ctx['categories overspent']).toBe(23);
    const overTotal = cats.reduce((n, c) => n + (c.spent - c.budgeted), 0) + free.reduce((n, c) => n + c.spent, 0);
    expect(ctx['total overspent']).toBe(fmt(cents(overTotal)));
    expect(ctx['categories without a budget']).toBe(9);
    expect(ctx['total spent without a budget']).toBe(fmt(cents(free.reduce((n, c) => n + c.spent, 0))));
  });

  it('countdowns: the upcoming count covers the whole list', () => {
    const countdowns = Array.from({ length: 13 }, (_v, i) => ({ title: `Trip ${i}`, targetDate: day(i + 1) }));
    const ctx = buildCountdownsContext({ countdowns, now: NOW });
    expect(ctx.upcoming).toHaveLength(10);
    expect(ctx['upcoming count']).toBe(13);
  });

  it('generic guard: every capped list in these builders has a count of the full list next to it', () => {
    const n = 40;
    const seq = Array.from({ length: n }, (_v, i) => i);
    const todos = buildTodosContext({ todos: seq.map((i) => ({ title: `t${i}`, due: day(-1), priority: 'high' })), now: NOW });
    const habits = buildHabitsContext({ habits: seq.map((i) => ({ title: `h${i}`, completions: [] })), now: NOW });
    const countdowns = buildCountdownsContext({ countdowns: seq.map((i) => ({ title: `c${i}`, targetDate: day(i + 1) })), now: NOW });
    // [capped list, the key that must hold its full length]
    const pairs = [
      [todos.overdue, todos.counts['overdue count']],
      [todos['high priority'], todos.counts['high priority count']],
      [habits.habits, habits['habits total']],
      [countdowns.upcoming, countdowns['upcoming count']],
    ];
    for (const [list, count] of pairs) {
      expect(list.length).toBeLessThan(n);
      expect(count).toBe(n);
    }
  });
});

describe('the prompt the model finally sees', () => {
  const { context } = serializeJaviContext({
    pageKey: 'budget',
    data: buildBudgetDashboardContext({ month: '2026-10', plan, rows }),
    now: NOW,
  });
  const messages = buildAdvisorMessages({ pageLabel: 'Budget', context, fenceTag: 'page_context_0123456789ab' });
  const system = messages[0].content;
  const user = messages[1].content;

  it('tells the model to quote figures exactly and never do arithmetic, comparison or counting', () => {
    expect(system).toMatch(/already computed/);
    expect(system).toMatch(/Copy every number exactly as written/);
    expect(system).toMatch(/Never do math: no adding, subtracting, dividing, averaging, projecting or comparing numbers, and no counting items/);
    expect(system).toMatch(/figure marked planned is a plan, not money already spent/);
    expect(advisorSystemPrompt({ pageLabel: 'Budget', fenceTag: 'page_context_0123456789ab' })).toBe(system);
  });

  it('puts the labelled, precomputed figures in the page context', () => {
    expect(user).toContain('"income planned":"$6,000.00"');
    expect(user).toContain('"income received":"$5,400.00"');
    expect(user).toContain('"expenses remaining":"-$600.75"');
    expect(user).toContain('"categories over budget":25');
    expect(user).toContain('"total over budget"');
    expect(user).not.toContain('"expenses":'); // no bare, basis-less figure
  });
});
