import { describe, it, expect } from 'vitest';
import { buildBudgetDashboard } from '../budgetFromTransactions';
import { CATEGORIES, getCategoryBudget } from '../budgetConfig';

const tx = (date, type, amount, merchant = 'Somewhere', category = 'Other') => ({
  date,
  type,
  amount,
  merchant,
  category,
});

const expenseCats = CATEGORIES.filter((c) => !c.isIncome);
const budgetTotal = (month) =>
  Math.round(expenseCats.reduce((s, c) => s + getCategoryBudget(c.id, month), 0) * 100) / 100;

const SAMPLE = [
  tx('2026-03-01', 'credit', 3000, 'Employer', 'Income'),
  tx('2026-03-10', 'debit', 100, 'Trader Joes', 'Groceries'),
  tx('2026-03-12', 'debit', 50, 'Discover E-Payment', 'Transfer'),
  tx('2026-04-02', 'credit', 1000, 'Employer', 'Income'),
  tx('2026-04-15', 'debit', 40, 'Trader Joes', 'Groceries'),
];

describe('buildBudgetDashboard', () => {
  it('returns empty aggregates for empty or non-array input', () => {
    const empty = { summary: [], categories: [], trend: [] };
    expect(buildBudgetDashboard([])).toEqual(empty);
    expect(buildBudgetDashboard(undefined)).toEqual(empty);
  });

  it('totals income (credits) and expenses (debits) per month', () => {
    const { summary, trend } = buildBudgetDashboard(SAMPLE);
    expect(summary.map((r) => r.month)).toEqual(['2026-03', '2026-04']);
    expect(summary[0]).toMatchObject({
      income: 3000,
      expenses: 150,
      net: 2850,
      spent: 150,
      savingsRate: 95,
    });
    expect(summary[1]).toMatchObject({ income: 1000, expenses: 40, net: 960, spent: 40 });
    expect(trend).toEqual([
      { month: '2026-03', income: 3000, expense: 150 },
      { month: '2026-04', income: 1000, expense: 40 },
    ]);
  });

  it('attributes spend per expense subcategory', () => {
    const { categories } = buildBudgetDashboard(SAMPLE);
    const march = categories.filter((r) => r.month === '2026-03');
    const groceries = march.find((r) => r.category === 'Groceries');
    const transfer = march.find((r) => r.category === 'Savings');
    expect(groceries.spent).toBe(100);
    expect(transfer.spent).toBe(50);
    // Income is never emitted as an expense subcategory.
    expect(march.some((r) => r.category === 'Income')).toBe(false);
  });

  it('uses the configured fallback as the budget baseline (0 in the starter taxonomy)', () => {
    const { summary, categories } = buildBudgetDashboard(SAMPLE);
    const groceriesCat = expenseCats.find((c) => c.name === 'Groceries');
    const row = categories.find(
      (r) => r.month === '2026-04' && r.category === 'Groceries',
    );
    expect(row.budgeted).toBe(getCategoryBudget(groceriesCat.id, '2026-04'));
    expect(summary[0].budgeted).toBe(budgetTotal('2026-03'));
  });

  it('emits a row for every expense subcategory with a budget or spend, none otherwise', () => {
    const { categories } = buildBudgetDashboard(SAMPLE);
    const april = categories.filter((r) => r.month === '2026-04');
    const expected = expenseCats.filter(
      (c) => getCategoryBudget(c.id, '2026-04') !== 0 || c.name === 'Groceries',
    );
    expect(april).toHaveLength(expected.length);
    expect(april.every((r) => r.budgeted !== 0 || r.spent !== 0)).toBe(true);
  });

  it('keeps only the trailing N months that have transactions', () => {
    const { summary, categories, trend } = buildBudgetDashboard(SAMPLE, { months: 1 });
    expect(summary.map((r) => r.month)).toEqual(['2026-04']);
    expect(trend.map((r) => r.month)).toEqual(['2026-04']);
    expect(categories.every((r) => r.month === '2026-04')).toBe(true);
  });

  it('skips gap months (only months with transactions appear)', () => {
    const { summary } = buildBudgetDashboard([
      tx('2026-01-05', 'credit', 10),
      tx('2026-05-05', 'credit', 20),
    ]);
    expect(summary.map((r) => r.month)).toEqual(['2026-01', '2026-05']);
  });

  it('rounds to cents and reports 0 savings rate when there is no income', () => {
    const { summary } = buildBudgetDashboard([
      tx('2026-03-01', 'debit', 0.1),
      tx('2026-03-02', 'debit', 0.2),
    ]);
    expect(summary[0].expenses).toBe(0.3);
    expect(summary[0].net).toBe(-0.3);
    expect(summary[0].savingsRate).toBe(0);
  });

  it('ignores rows with unparseable or missing dates', () => {
    const { summary } = buildBudgetDashboard([
      tx('not-a-date', 'credit', 500),
      tx('', 'debit', 20),
      tx(undefined, 'debit', 20),
      tx('2026-13-01', 'debit', 20),
      tx('2026-03-01', 'credit', 100),
    ]);
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({ month: '2026-03', income: 100, expenses: 0 });
  });

  it('keeps sum(categories.spent) === summary.expenses for debits that fall through to Buffer', () => {
    const { summary, categories } = buildBudgetDashboard([
      tx('2026-03-01', 'credit', 3000, 'Employer', 'Income'),
      tx('2026-03-05', 'debit', 100, 'Trader Joes', 'Groceries'),
      tx('2026-03-06', 'debit', 25.5, 'PAYROLL SVC FEE', 'Other'),
      tx('2026-03-07', 'debit', 10, 'ACME PAYROLL', 'Zzz Unmapped'),
    ]);
    const march = categories.filter((r) => r.month === '2026-03');
    const spent = march.reduce((s, r) => s + r.spent, 0);
    expect(Math.round(spent * 100) / 100).toBe(summary[0].expenses);
    expect(summary[0].expenses).toBe(135.5);
    expect(march.find((r) => r.category === 'Buffer').spent).toBe(35.5);
    expect(march.some((r) => r.category === 'Income')).toBe(false);
  });

  it('defaults to the trailing 12 months, dropping the oldest', () => {
    const rows = [];
    for (let i = 0; i < 13; i += 1) {
      const y = 2025 + Math.floor(i / 12);
      const m = String((i % 12) + 1).padStart(2, '0');
      rows.push(tx(`${y}-${m}-10`, 'credit', 100));
    }
    const { summary, trend } = buildBudgetDashboard(rows);
    expect(summary).toHaveLength(12);
    expect(summary[0].month).toBe('2025-02');
    expect(summary[11].month).toBe('2026-01');
    expect(trend).toHaveLength(12);
  });
});

describe('buildBudgetDashboard month order', () => {
  it('emits summary, categories and trend oldest to newest whatever the input order', () => {
    const tx = ['2026-03-05', '2025-12-20', '2026-01-02', '2026-02-11'].map((date, i) => ({
      id: `t${i}`,
      date,
      amount: 10 + i,
      type: 'debit',
      description: 'Sample',
    }));
    const { summary, categories, trend } = buildBudgetDashboard(tx);
    const expected = ['2025-12', '2026-01', '2026-02', '2026-03'];
    expect(trend.map((r) => r.month)).toEqual(expected);
    expect(summary.map((r) => r.month)).toEqual(expected);
    const catMonths = [...new Set(categories.map((r) => r.month))];
    expect(catMonths).toEqual(expected);
  });
});
