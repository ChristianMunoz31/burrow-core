import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import BudgetPage from '../BudgetPage';
import { routeKey } from '../../shell/routeKey';
import { SAMPLE_CATEGORIES, SAMPLE_SUMMARY, SAMPLE_TREND } from '../../../data/budgetSample';
import { transactionsService } from '../../../services/transactionsService';

const hookState = vi.hoisted(() => ({ impl: null }));

vi.mock('../../../hooks/useBudgetData', async () => {
  const actual = await vi.importActual('../../../hooks/useBudgetData');
  return {
    ...actual,
    useBudgetData: vi.fn((...args) => (hookState.impl ? hookState.impl(...args) : null)),
  };
});

// Settings are database-backed; always return the fallback.
vi.mock('../../../hooks/useSyncedSetting', () => ({
  useSyncedSetting: (_key, fallback) => [fallback, vi.fn()],
}));

// Chart theming needs a ThemeProvider; stub with static colors.
vi.mock('../../../hooks/useChartColors', () => {
  const colors = {
    axisTick: '#888',
    tickStrong: '#444',
    legend: '#444',
    tooltipLabel: '#444',
    grid: '#ddd',
    cursor: '#eee',
  };
  return { useChartColors: () => colors, default: () => colors };
});

vi.mock('../../../services/transactionsService', () => ({
  transactionsService: {
    fetchTransactions: vi.fn(),
    addTransactions: vi.fn(),
    clearTransactions: vi.fn(),
  },
}));

import { useBudgetData } from '../../../hooks/useBudgetData';

const FIXED = {
  summary: SAMPLE_SUMMARY,
  categories: SAMPLE_CATEGORIES,
  trend: SAMPLE_TREND,
  source: 'transactions',
  loading: false,
};

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  hookState.impl = () => FIXED;
  vi.mocked(useBudgetData).mockClear();
  transactionsService.fetchTransactions.mockReset();
});

// Freeze only Date so the default month (the current month) is deterministic
// without disturbing RTL/async timers.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-15T12:00:00'));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function LocationProbe() {
  const { pathname, search } = useLocation();
  return <div data-testid="loc">{pathname + search}</div>;
}

function setup(route = '/budget') {
  const user = userEvent.setup();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path="/budget/*" element={<BudgetPage />} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return user;
}

const monthSelect = () => screen.getByLabelText('Budget month');
const nav = () => screen.getByRole('navigation', { name: 'Budget views' });
const link = (name) => screen.getByRole('link', { name });

describe('BudgetPage layout', () => {
  it('shows the dashboard by default with the Dashboard link active', () => {
    setup('/budget');
    expect(screen.getByText('Budget vs. actual')).toBeInTheDocument();
    expect(screen.getByText('Income vs. expenses')).toBeInTheDocument();
    expect(screen.getByText('Spending by category group')).toBeInTheDocument();
    expect(screen.queryByText('Budget planner')).not.toBeInTheDocument();
    expect(nav()).toBeInTheDocument();
    expect(link('Dashboard')).toHaveAttribute('aria-current', 'page');
    expect(link('Planner')).not.toHaveAttribute('aria-current');
  });

  it('announces the current view in a polite live region', async () => {
    const user = setup('/budget');
    const status = () => document.querySelector('p.sr-only[aria-live="polite"]');
    expect(status()).toHaveTextContent('Dashboard view');
    await user.click(link('Planner'));
    expect(status()).toHaveTextContent('Planner view');
    await user.click(link('Dashboard'));
    expect(status()).toHaveTextContent('Dashboard view');
  });

  it('renders the month selector with previous/next buttons', () => {
    setup('/budget');
    expect(monthSelect()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous month' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next month' })).toBeInTheDocument();
  });

  it('switches to the planner and back via the nav links', async () => {
    const user = setup('/budget');
    await user.click(link('Planner'));
    expect(screen.getByText('Budget planner')).toBeInTheDocument();
    expect(screen.queryByText('Budget vs. actual')).not.toBeInTheDocument();
    expect(link('Planner')).toHaveAttribute('aria-current', 'page');
    expect(link('Dashboard')).not.toHaveAttribute('aria-current');
    expect(screen.getByTestId('loc').textContent).toContain('/budget/planner');

    await user.click(link('Dashboard'));
    expect(screen.getByText('Budget vs. actual')).toBeInTheDocument();
    expect(screen.queryByText('Budget planner')).not.toBeInTheDocument();
    expect(link('Dashboard')).toHaveAttribute('aria-current', 'page');
  });

  it('defaults to the current month on the dashboard and the planner', async () => {
    const user = setup('/budget');
    expect(monthSelect()).toHaveValue('2026-10');
    await user.click(link('Planner'));
    expect(screen.getByText('Budget planner')).toBeInTheDocument();
    expect(monthSelect()).toHaveValue('2026-10');
  });

  it('carries a picked month from Dashboard to Planner and back', async () => {
    const user = setup('/budget');
    await user.selectOptions(monthSelect(), '2026-04');
    expect(monthSelect()).toHaveValue('2026-04');
    expect(screen.getByTestId('loc').textContent).toContain('month=2026-04');

    await user.click(link('Planner'));
    expect(screen.getByText('Budget planner')).toBeInTheDocument();
    expect(monthSelect()).toHaveValue('2026-04');
    expect(screen.getByTestId('loc').textContent).toContain('month=2026-04');

    await user.selectOptions(monthSelect(), '2026-03');
    await user.click(link('Dashboard'));
    expect(screen.getByText('Budget vs. actual')).toBeInTheDocument();
    expect(monthSelect()).toHaveValue('2026-03');
  });

  it('previous/next buttons change the month', async () => {
    const user = setup('/budget?month=2026-04');
    await user.click(screen.getByRole('button', { name: 'Next month' }));
    expect(monthSelect()).toHaveValue('2026-05');
    await user.click(screen.getByRole('button', { name: 'Previous month' }));
    await user.click(screen.getByRole('button', { name: 'Previous month' }));
    expect(monthSelect()).toHaveValue('2026-03');
  });

  it('deep-links to the planner with the month from the URL', () => {
    setup('/budget/planner?month=2026-03');
    expect(screen.getByText('Budget planner')).toBeInTheDocument();
    expect(screen.queryByText('Budget vs. actual')).not.toBeInTheDocument();
    expect(monthSelect()).toHaveValue('2026-03');
    expect(link('Planner')).toHaveAttribute('aria-current', 'page');
  });

  it('deep-links to the dashboard with the month from the URL', () => {
    setup('/budget?month=2026-04');
    expect(screen.getByText('Budget vs. actual')).toBeInTheDocument();
    expect(monthSelect()).toHaveValue('2026-04');
  });

  it('falls back to the default month when the URL month is invalid', () => {
    setup('/budget?month=garbage');
    expect(monthSelect()).toHaveValue('2026-10');
  });

  it('redirects unknown sub-routes to /budget preserving the month', () => {
    setup('/budget/nope?month=2026-04');
    expect(screen.getByText('Budget vs. actual')).toBeInTheDocument();
    expect(screen.getByTestId('loc').textContent).toBe('/budget?month=2026-04');
    expect(monthSelect()).toHaveValue('2026-04');
  });

  it('shows no dashboard or planner content while loading', () => {
    hookState.impl = () => ({ ...FIXED, summary: [], categories: [], trend: [], loading: true });
    setup('/budget');
    expect(screen.queryByText('Budget vs. actual')).not.toBeInTheDocument();
  });

  it('shows a sample-data notice for source "sample" and an alert for "error"', () => {
    hookState.impl = () => ({ ...FIXED, source: 'sample' });
    setup('/budget');
    expect(screen.getByText(/sample data/i)).toBeInTheDocument();
    cleanup();
    hookState.impl = () => ({ ...FIXED, summary: [], categories: [], trend: [], source: 'error' });
    setup('/budget');
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});

describe('BudgetPage single data source', () => {
  it('fetches transactions once and not again when switching views', async () => {
    const actual = await vi.importActual('../../../hooks/useBudgetData');
    hookState.impl = () => actual.useBudgetData();
    transactionsService.fetchTransactions.mockResolvedValue([
      { id: '1', date: '2026-03-01', merchant: 'Employer', amount: 1000, type: 'credit', category: 'Income' },
      { id: '2', date: '2026-03-02', merchant: 'Trader Joes', amount: 40, type: 'debit', category: 'Groceries' },
    ]);
    const user = setup('/budget');
    await waitFor(() => expect(screen.getByText('Budget vs. actual')).toBeInTheDocument());
    expect(transactionsService.fetchTransactions).toHaveBeenCalledTimes(1);

    await user.click(link('Planner'));
    expect(screen.getByText('Budget planner')).toBeInTheDocument();
    await user.click(link('Dashboard'));
    await user.click(link('Planner'));
    expect(screen.getByText('Budget planner')).toBeInTheDocument();

    expect(transactionsService.fetchTransactions).toHaveBeenCalledTimes(1);
  });

  it('does not remount the page or drop link focus under the AppShell route key', async () => {
    const actual = await vi.importActual('../../../hooks/useBudgetData');
    hookState.impl = () => actual.useBudgetData();
    transactionsService.fetchTransactions.mockResolvedValue([
      { id: '1', date: '2026-03-01', merchant: 'Employer', amount: 1000, type: 'credit', category: 'Income' },
    ]);
    // Mirrors AppShell's content wrapper (without rendering AppShell itself).
    function KeyedShell({ children }) {
      const { pathname } = useLocation();
      return <div key={routeKey(pathname)}>{children}</div>;
    }
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/budget']}>
          <KeyedShell>
            <Routes>
              <Route path="/budget/*" element={<BudgetPage />} />
            </Routes>
          </KeyedShell>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText('Budget vs. actual')).toBeInTheDocument());

    await user.click(link('Planner'));
    expect(screen.getByText('Budget planner')).toBeInTheDocument();
    expect(link('Planner')).toHaveFocus();
    expect(transactionsService.fetchTransactions).toHaveBeenCalledTimes(1);
  });
});
