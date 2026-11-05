import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useBudgetPlan } from '../useBudgetPlan';
import { buildBudgetDashboard } from '../../utils/budgetFromTransactions';
import {
  applySpentOverrides,
  buildPlan,
  payeeIncomeForMonth,
  resolveStructure,
  withDerivedIncome,
} from '../../utils/budgetPlan';

const TX = [{ id: 't1', date: '2026-10-03', merchant: 'Market', amount: 40, type: 'debit', category: 'Groceries' }];
const h = vi.hoisted(() => ({ state: {}, pending: false }));

beforeEach(() => {
  localStorage.clear();
  h.state = {};
  h.pending = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if (h.pending) return new Promise(() => {});
      return { ok: true, status: 200, json: async () => h.state };
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function render(month, categories) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(() => useBudgetPlan(month, categories), { wrapper });
}

describe('useBudgetPlan', () => {
  it('returns the same plan as buildPlan for the same synced values', async () => {
    const { categories } = buildBudgetDashboard(TX);
    h.state = {
      'budget:defaults': { 'cat-groceries': 250 },
      'budget:targets': { '2026-10|cat-transport': 80 },
      'budget:spent': { '2026-10|cat-transport': 15 },
    };
    const { result } = render('2026-10', categories);
    await waitFor(() => expect(result.current.ready).toBe(true));
    const resolved = resolveStructure({});
    const augCats = applySpentOverrides(categories, '2026-10', h.state['budget:spent'], resolved.categories);
    const expected = buildPlan(
      '2026-10',
      withDerivedIncome(h.state['budget:targets'], '2026-10', payeeIncomeForMonth([], '2026-10')),
      augCats,
      resolved,
      h.state['budget:defaults'],
    );
    expect(result.current.plan).toEqual(expected);
    expect(result.current.plan.totals.expenseSpent).toBe(55);
    expect(result.current.plan.totals.expenseBudgeted).toBe(330);
  });

  it('is not ready until all five settings have been fetched', () => {
    h.pending = true;
    const { result } = render('2026-10', []);
    expect(result.current.ready).toBe(false);
    expect(result.current.plan.totals.expenseSpent).toBe(0);
  });
});
