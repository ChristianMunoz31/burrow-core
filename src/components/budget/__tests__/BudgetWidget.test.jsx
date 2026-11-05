import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import BudgetWidget from '../BudgetWidget';
import { renderWithProviders } from '../../../test-utils/renderWithProviders';
import { buildBudgetDashboard } from '../../../utils/budgetFromTransactions';
import { buildPlan, resolveStructure } from '../../../utils/budgetPlan';
import { formatCurrency } from '../../../utils/budgetAggregate';

const MONTH = '2026-10';
const TX = [
  { id: 't1', date: '2026-10-03', merchant: 'Market', amount: 40, type: 'debit', category: 'Groceries' },
  { id: 't2', date: '2026-10-05', merchant: 'Market', amount: 60, type: 'debit', category: 'Groceries' },
  { id: 't3', date: '2026-09-10', merchant: 'Market', amount: 500, type: 'debit', category: 'Groceries' },
];

const h = vi.hoisted(() => ({ state: {}, transactions: [], txStatus: 200, txPending: false, calls: [] }));

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      h.calls.push(String(url));
      if (String(url).endsWith('/transactions')) {
        if (h.txPending) return new Promise(() => {});
        return { ok: h.txStatus === 200, status: h.txStatus, json: async () => h.transactions };
      }
      if (String(url).endsWith('/state')) return { ok: true, status: 200, json: async () => h.state };
      throw new Error(`unexpected request ${url}`);
    }),
  );
}

function renderCard() {
  return renderWithProviders(
    <MemoryRouter initialEntries={['/?month=2026-08']}>
      <BudgetWidget />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 15, 12, 0, 0));
  h.state = {};
  h.transactions = [];
  h.txStatus = 200;
  h.txPending = false;
  h.calls = [];
  stubFetch();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('BudgetWidget', () => {
  it('shows figures equal to buildPlan for the same inputs and calls no AI endpoint', async () => {
    h.transactions = TX;
    h.state = { 'budget:defaults': { 'cat-groceries': 250 } };
    renderCard();
    expect(await screen.findByText('spent this month')).toBeInTheDocument();
    const { categories } = buildBudgetDashboard(TX);
    const expected = buildPlan(MONTH, {}, categories, resolveStructure({}), { 'cat-groceries': 250 }).totals;
    expect(expected.expenseSpent).toBe(100);
    expect(expected.expenseBudgeted).toBe(250);
    expect(screen.getByText(formatCurrency(expected.expenseSpent))).toBeInTheDocument();
    expect(screen.getByText(`Budgeted ${formatCurrency(expected.expenseBudgeted)}`)).toBeInTheDocument();
    expect(
      screen.getByText(`Remaining ${formatCurrency(expected.expenseBudgeted - expected.expenseSpent)}`),
    ).toBeInTheDocument();
    expect(screen.getByText('$100.00')).toBeInTheDocument();
    expect(screen.getByText('Budgeted $250.00')).toBeInTheDocument();
    expect(screen.getByText('Remaining $150.00')).toBeInTheDocument();
    for (const url of h.calls) expect(url).toMatch(/\/api\/(transactions|state)$/);
  });

  it('shows a negative Remaining in red when over budget', async () => {
    h.transactions = TX;
    h.state = { 'budget:defaults': { 'cat-groceries': 70 } };
    renderCard();
    const remaining = await screen.findByText(/^Remaining/);
    expect(remaining).toHaveTextContent('Remaining -$30.00');
    expect(remaining).toHaveClass('text-accent-red');
  });

  it('says so when there is spending and no budget', async () => {
    h.transactions = TX;
    renderCard();
    expect(await screen.findByText('No budget set for this month.')).toBeInTheDocument();
    expect(screen.getByText('$100.00')).toBeInTheDocument();
    expect(screen.queryByText(/^Budgeted/)).not.toBeInTheDocument();
  });

  it('shows the empty state, never a sample figure, with no transactions and no budget', async () => {
    renderCard();
    expect(await screen.findByText('No budget or spending this month yet.')).toBeInTheDocument();
    expect(screen.getByText('Import transactions or set a budget →')).toBeInTheDocument();
    expect(screen.queryByText('spent this month')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\$\d/);
  });

  it('with transactions but none this month, says no spending was recorded instead of asking for an import', async () => {
    h.transactions = [TX[2]];
    renderCard();
    expect(await screen.findByText('No spending recorded this month yet.')).toBeInTheDocument();
    expect(screen.queryByText(/Import transactions/)).not.toBeInTheDocument();
    expect(screen.queryByText('No budget or spending this month yet.')).not.toBeInTheDocument();
  });

  it('shows Remaining $0.00, never -$0.00, when spending equals the budget', async () => {
    h.transactions = TX;
    h.state = { 'budget:defaults': { 'cat-groceries': 100 } };
    renderCard();
    const remaining = await screen.findByText(/^Remaining/);
    expect(remaining).toHaveTextContent(/^Remaining \$0\.00$/);
    expect(remaining).toHaveClass('text-slate-slate400');
  });

  it('shows the error line when the transactions cannot load', async () => {
    h.txStatus = 500;
    renderCard();
    expect(await screen.findByText("Couldn't load your transactions. Open Budget to try again.")).toBeInTheDocument();
  });

  it('shows a skeleton while transactions load', () => {
    h.txPending = true;
    const { container } = renderCard();
    expect(container.querySelector('.animate-pulse')).not.toBeNull();
    expect(screen.queryByText('No budget or spending this month yet.')).not.toBeInTheDocument();
  });

  it('is one link to /budget and ignores a month picked elsewhere', async () => {
    h.transactions = [
      ...TX,
      { id: 't4', date: '2026-08-02', merchant: 'Market', amount: 999, type: 'debit', category: 'Groceries' },
    ];
    renderCard();
    await waitFor(() => expect(screen.getByText('spent this month')).toBeInTheDocument());
    expect(screen.getByRole('link')).toHaveAttribute('href', '/budget');
    expect(screen.getByText('$100.00')).toBeInTheDocument();
    expect(screen.queryByText('$999.00')).not.toBeInTheDocument();
  });
});
