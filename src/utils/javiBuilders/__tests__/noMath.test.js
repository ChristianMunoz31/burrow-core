// Product rule: AI summarizes, code calculates. Page builders hand the model final derived numbers
// (over = spent - budgeted, totals, counts, days left) as ready values, with money as "$" strings,
// and never phrase anything as a request to calculate.
import { describe, it, expect } from 'vitest';
import { buildBudgetDashboardContext, buildBudgetPlannerContext } from '../budget';
import { buildSubscriptionsContext } from '../subscriptions';
import { buildHabitsContext } from '../habits';
import { buildJournalContext } from '../journal';
import { buildFocusContext } from '../focus';
import { buildCountdownsContext } from '../countdowns';

const MATH_INSTRUCTION = /\b(calculate|compute|add (?:up|together)|sum (?:up|of)|subtract|multiply|divide|tally|work out the|average (?:of|the))\b/i;
const MONEY = /^-?\$\d{1,3}(?:,\d{3})*\.\d{2}$/;
const NOW = new Date(2026, 9, 2, 12, 0);

/** Every string key and value in the structure. */
function allStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => allStrings(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      allStrings(v, out);
    }
  }
  return out;
}
const expectNoInstructions = (ctx) => {
  const strings = allStrings(ctx);
  expect(strings.length).toBeGreaterThan(0);
  for (const s of strings) expect(s, s).not.toMatch(MATH_INSTRUCTION);
};

const plan = {
  groups: [
    {
      name: 'Income',
      isIncome: true,
      budgeted: 5000,
      spent: 5000,
      remaining: 0,
      categories: [{ id: 'i1', name: 'Pay', budgeted: 5000, spent: 5000, remaining: 0 }],
    },
    {
      name: 'Needs',
      isIncome: false,
      budgeted: 1000,
      spent: 1300,
      remaining: -300,
      categories: [
        { id: 'c1', name: 'Rent', budgeted: 800, spent: 800, remaining: 0 },
        { id: 'c2', name: 'Food', budgeted: 200, spent: 400.5, remaining: -200.5 },
        { id: 'c3', name: 'Misc', budgeted: 0, spent: 99.5, remaining: -99.5 },
      ],
    },
  ],
  totals: { incomeBudgeted: 5000, incomeSpent: 5000, expenseBudgeted: 1000, expenseSpent: 1300, netBudgeted: 4000, netActual: 3700 },
};

describe('budget dashboard', () => {
  const ctx = buildBudgetDashboardContext({
    month: '2026-10',
    plan,
    rows: [
      { name: 'Food', budgeted: 200, spent: 400.5 },
      { name: 'Rent', budgeted: 800, spent: 800 },
      { name: 'Fun', budgeted: 50, spent: 20 },
      { name: 'Unplanned', budgeted: 0, spent: 75 },
    ],
  });

  it('carries the over-budget amount as a final value (spent - budgeted)', () => {
    expect(ctx['over budget']).toEqual([{ category: 'Food', budgeted: '$200.00', spent: '$400.50', over: '$200.50' }]);
  });

  it('carries plan totals as ready $ strings and percents, planned and actual named apart', () => {
    expect(ctx.totals).toEqual({
      'income planned': '$5,000.00',
      'income received': '$5,000.00',
      'expenses planned': '$1,000.00',
      'expenses spent': '$1,300.00',
      'net planned': '$4,000.00',
      'net actual': '$3,700.00',
      'expenses remaining': '-$300.00',
      'savings rate planned': '80%',
      'savings rate actual': '74%',
    });
  });

  it('ranks top spending for the model; every money field is a $ string', () => {
    expect(ctx['top spending'].map((r) => r.category)).toEqual(['Rent', 'Food', 'Unplanned', 'Fun']);
    for (const s of allStrings([ctx.totals, ctx.groups, ctx['over budget'], ctx['top spending']])) {
      if (/\d/.test(s) && !/%$/.test(s) && !/^\d{4}-\d{2}/.test(s)) expect(s).toMatch(MONEY);
    }
  });

  it('has no calculate-style instruction text', () => expectNoInstructions(ctx));
});

describe('budget planner', () => {
  const ctx = buildBudgetPlannerContext({ month: '2026-10', plan });

  it('lists overspent categories with the remaining amount already negative-signed', () => {
    expect(ctx.overspent.map((c) => [c.name, c.remaining])).toEqual([
      ['Food', '-$200.50'],
      ['Misc', '-$99.50'],
    ]);
    expect(ctx.overspent[0]).toMatchObject({ budgeted: '$200.00', spent: '$400.50' });
  });

  it('flags spend without a budget and carries group totals', () => {
    expect(ctx['spent without a budget']).toEqual([{ name: 'Misc', group: 'Needs', spent: '$99.50' }]);
    expect(ctx.totals['net actual']).toBe('$3,700.00');
    expect(ctx.groups[1]).toMatchObject({ name: 'Needs', budgeted: '$1,000.00', spent: '$1,300.00', remaining: '-$300.00' });
  });

  it('has no calculate-style instruction text', () => expectNoInstructions(ctx));
});

describe('subscriptions', () => {
  const items = [
    { merchant: 'Streamflix', merchantKey: 'streamflix', kind: 'subscription', active: true, cadence: 'monthly', typicalAmount: 15.49, monthlyEquivalent: 15.49, nextExpected: '2026-10-20' },
    { merchant: 'Tunebox', merchantKey: 'tunebox', kind: 'subscription', active: true, cadence: 'yearly', typicalAmount: 120, monthlyEquivalent: 10, nextExpected: '2027-01-05', priceIncrease: { from: 100, to: 120, pct: 20 } },
    { merchant: 'Old Gym', merchantKey: 'old gym', kind: 'subscription', active: false, cadence: 'monthly', typicalAmount: 30, monthlyEquivalent: 30, nextExpected: null },
    { merchant: 'Power Co', merchantKey: 'power co', kind: 'bill', active: true, cadence: 'monthly', typicalAmount: 80, monthlyEquivalent: 80, nextExpected: '2026-10-25' },
  ];
  const ctx = buildSubscriptionsContext({ result: { items, monthlyTotal: 25.49, yearlyTotal: 305.88, activeCount: 2, billsMonthlyTotal: 80, billsActiveCount: 1 } });

  it('passes the detector totals and counts through as final values', () => {
    expect(ctx).toMatchObject({
      monthlyTotal: '$25.49',
      yearlyTotal: '$305.88',
      activeCount: 2,
      billsMonthlyTotal: '$80.00',
      billsActiveCount: 1,
      inactiveCount: 1,
    });
  });

  it('carries each item monthly equivalent and the price increase already derived', () => {
    expect(ctx.items.map((i) => [i.merchant, i.typical, i.monthly])).toEqual([
      ['Streamflix', '$15.49', '$15.49'],
      ['Tunebox', '$120.00', '$10.00'],
    ]);
    expect(ctx.items[1].priceIncrease).toBe('+$20.00 (20%)');
    expect(ctx.bills[0]).toMatchObject({ merchant: 'Power Co', monthly: '$80.00' });
  });

  it('falls back to counting the lists when the detector gives no count', () => {
    const noCounts = buildSubscriptionsContext({ result: { items } });
    expect(noCounts.activeCount).toBe(2);
    expect(noCounts.billsActiveCount).toBe(1);
    expect(noCounts.monthlyTotal).toBe('$0.00');
  });

  it('has no calculate-style instruction text', () => expectNoInstructions(ctx));
});

describe('habits', () => {
  const ctx = buildHabitsContext({
    now: NOW,
    habits: [{ title: 'Stretch', frequency: 'daily', completions: ['2026-10-02', '2026-10-01', '2026-09-30'] }],
  });

  it('carries streak, done-today and the completion percent as final values', () => {
    expect(ctx.habits[0]).toMatchObject({ title: 'Stretch', 'done today': true, 'streak in days': 3, 'done in the last 30 days': '10%' });
  });

  it('has no calculate-style instruction text', () => expectNoInstructions(ctx));
});

describe('journal', () => {
  const entries = [
    { date: '2026-10-01T08:00:00.000Z', mood: 'good', title: 'SECRET TITLE', body: 'SECRET BODY' },
    { date: '2026-09-28T08:00:00.000Z', mood: 'good' },
    { date: '2026-09-20T08:00:00.000Z', mood: 'low' },
    { date: '2026-06-01T08:00:00.000Z', mood: 'good' },
  ];
  const ctx = buildJournalContext({ entries, now: NOW });

  it('carries the total, the 30-day count and mood counts as final numbers', () => {
    expect(ctx.total).toBe(4);
    expect(ctx['entries in the last 30 days']).toBe(3);
    expect(ctx['mood counts']).toEqual({ good: 3, low: 1 });
  });

  it('never includes entry text', () => {
    expect(JSON.stringify(ctx)).not.toMatch(/SECRET/);
  });

  it('has no calculate-style instruction text', () => expectNoInstructions(ctx));
});

describe('focus', () => {
  const at = (d, h) => new Date(2026, 9, d, h).toISOString();
  const ctx = buildFocusContext({
    now: NOW,
    today: { count: 2, minutes: 75 },
    sessions: [
      { kind: 'focus', startedAt: at(2, 9), durationMin: 25 },
      { kind: 'focus', startedAt: at(1, 9), durationMin: 50 },
      { kind: 'focus', startedAt: at(1, 15), durationMin: 30 },
      { kind: 'break', startedAt: at(1, 16), durationMin: 5 },
      { kind: 'focus', startedAt: at(-10, 9), durationMin: 60 }, // too old
    ],
  });

  it('carries today and the 7-day count and total minutes as final values', () => {
    expect(ctx.today).toEqual({ count: 2, minutes: 75 });
    expect(ctx['last 7 days']).toEqual({ count: 3, minutes: 105 });
  });

  it('has no calculate-style instruction text', () => expectNoInstructions(ctx));
});

describe('countdowns', () => {
  const ctx = buildCountdownsContext({
    now: NOW,
    countdowns: [
      { title: 'Trip', targetDate: '2026-10-14' },
      { title: 'Tomorrow thing', targetDate: '2026-10-03' },
      { title: 'Gone', targetDate: '2026-09-01' },
    ],
  });

  it('carries days left as plain words, soonest first, and the past count', () => {
    expect(ctx.upcoming.map((r) => [r.title, r.when])).toEqual([
      ['Tomorrow thing', 'tomorrow'],
      ['Trip', 'in 12 days'],
    ]);
    expect(ctx.past).toBe(1);
  });

  it('has no calculate-style instruction text', () => expectNoInstructions(ctx));
});
