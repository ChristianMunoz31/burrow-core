import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import BudgetPage from '../BudgetPage';
import { useBudgetData } from '../../../hooks/useBudgetData';
import { SAMPLE_CATEGORIES, SAMPLE_SUMMARY, SAMPLE_TREND } from '../../../data/budgetSample';

const hookState = vi.hoisted(() => ({ records: [], fetchFailed: false }));

vi.mock('../../../hooks/useBudgetData', async () => {
  const actual = await vi.importActual('../../../hooks/useBudgetData');
  return {
    ...actual,
    useBudgetData: vi.fn(() => ({
      summary: SAMPLE_SUMMARY,
      categories: SAMPLE_CATEGORIES,
      trend: SAMPLE_TREND,
      source: 'transactions',
      loading: false,
    })),
  };
});

// SubscriptionsView reads transactions directly.
vi.mock('../../../hooks/useRecords', () => ({
  useRecords: () => ({
    records: hookState.records,
    loading: false,
    fetchFailed: hookState.fetchFailed,
  }),
}));

vi.mock('../../../hooks/useSyncedSetting', () => ({
  useSyncedSetting: (_key, fallback) => [fallback, vi.fn()],
}));

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

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const BUDGET_DATA = () => ({
  summary: SAMPLE_SUMMARY,
  categories: SAMPLE_CATEGORIES,
  trend: SAMPLE_TREND,
  source: 'transactions',
  loading: false,
});

beforeEach(() => {
  useBudgetData.mockImplementation(BUDGET_DATA);
  hookState.records = [];
  hookState.fetchFailed = false;
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

const link = (name) => screen.getByRole('link', { name });
const monthSelect = () => screen.queryByLabelText('Budget month');
const loc = () => screen.getByTestId('loc').textContent;
const EMPTY_COPY = /No recurring charges found yet/;

describe('BudgetPage Subscriptions tab', () => {
  it('skips the budget loading skeleton and shows the view on the Subscriptions tab', () => {
    useBudgetData.mockImplementation(() => ({ ...BUDGET_DATA(), loading: true }));
    setup('/budget/subscriptions');
    expect(screen.getByRole('navigation', { name: 'Budget views' })).toBeInTheDocument();
    expect(screen.getByText(EMPTY_COPY)).toBeInTheDocument();
  });

  it('still shows the budget skeleton (no nav) while loading on the Dashboard', () => {
    useBudgetData.mockImplementation(() => ({ ...BUDGET_DATA(), loading: true }));
    setup('/budget');
    expect(screen.queryByRole('navigation', { name: 'Budget views' })).not.toBeInTheDocument();
  });

  it('hides the sample-data banner on the Subscriptions tab only', () => {
    useBudgetData.mockImplementation(() => ({ ...BUDGET_DATA(), source: 'sample' }));
    setup('/budget');
    expect(screen.getByText(/Showing sample data/)).toBeInTheDocument();
    cleanup();
    setup('/budget/subscriptions');
    expect(screen.queryByText(/Showing sample data/)).not.toBeInTheDocument();
  });

  it('shows a single alert when both the budget source and the records fail', () => {
    useBudgetData.mockImplementation(() => ({ ...BUDGET_DATA(), source: 'error' }));
    hookState.fetchFailed = true;
    setup('/budget/subscriptions');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('adds a Subscriptions link to the view switcher', () => {
    setup('/budget');
    const nav = screen.getByRole('navigation', { name: 'Budget views' });
    expect(nav).toContainElement(link('Subscriptions'));
    expect(link('Subscriptions')).not.toHaveAttribute('aria-current');
  });

  it('renders the Subscriptions view when the tab is clicked', async () => {
    const user = setup('/budget');
    await user.click(link('Subscriptions'));
    expect(loc()).toContain('/budget/subscriptions');
    expect(screen.getByText(EMPTY_COPY)).toBeInTheDocument();
    expect(screen.queryByText('Budget vs. actual')).not.toBeInTheDocument();
    expect(link('Subscriptions')).toHaveAttribute('aria-current', 'page');
    expect(link('Dashboard')).not.toHaveAttribute('aria-current');
    expect(link('Planner')).not.toHaveAttribute('aria-current');
  });

  it('deep-links to /budget/subscriptions', () => {
    setup('/budget/subscriptions');
    expect(screen.getByText(EMPTY_COPY)).toBeInTheDocument();
    expect(link('Subscriptions')).toHaveAttribute('aria-current', 'page');
  });

  it('renders detected subscriptions from the transaction records', () => {
    hookState.records = [
      { id: '1', date: '2026-07-15', merchant: 'NETFLIX.COM', amount: 15.49, category: 'Fun', type: 'debit' },
      { id: '2', date: '2026-08-15', merchant: 'NETFLIX.COM', amount: 15.49, category: 'Fun', type: 'debit' },
      { id: '3', date: '2026-09-15', merchant: 'NETFLIX.COM', amount: 15.49, category: 'Fun', type: 'debit' },
    ];
    setup('/budget/subscriptions');
    expect(screen.getByText('NETFLIX.COM')).toBeInTheDocument();
    expect(screen.queryByText(EMPTY_COPY)).not.toBeInTheDocument();
  });

  it('surfaces the fetch error inside the tab', () => {
    hookState.fetchFailed = true;
    setup('/budget/subscriptions');
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load transactions.");
  });

  it('hides the month selector on the Subscriptions tab and restores it elsewhere', async () => {
    const user = setup('/budget');
    expect(monthSelect()).toBeInTheDocument();

    await user.click(link('Subscriptions'));
    expect(monthSelect()).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Previous month' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next month' })).not.toBeInTheDocument();

    await user.click(link('Planner'));
    expect(monthSelect()).toBeInTheDocument();

    await user.click(link('Subscriptions'));
    expect(monthSelect()).not.toBeInTheDocument();

    await user.click(link('Dashboard'));
    expect(monthSelect()).toBeInTheDocument();
  });

  it('hides the month selector on a direct deep link', () => {
    setup('/budget/subscriptions?month=2026-04');
    expect(monthSelect()).not.toBeInTheDocument();
  });

  it('keeps ?month on the tab links and in the URL when switching to Subscriptions', async () => {
    const user = setup('/budget?month=2026-04');
    expect(link('Subscriptions')).toHaveAttribute('href', '/budget/subscriptions?month=2026-04');
    await user.click(link('Subscriptions'));
    expect(loc()).toBe('/budget/subscriptions?month=2026-04');
    expect(link('Dashboard')).toHaveAttribute('href', '/budget?month=2026-04');
    expect(link('Planner')).toHaveAttribute('href', '/budget/planner?month=2026-04');
  });

  it('restores the picked month after a round trip through Subscriptions', async () => {
    const user = setup('/budget');
    await user.selectOptions(monthSelect(), '2026-03');
    await user.click(link('Subscriptions'));
    expect(loc()).toContain('month=2026-03');
    await user.click(link('Planner'));
    expect(monthSelect()).toHaveValue('2026-03');
    await user.click(link('Subscriptions'));
    await user.click(link('Dashboard'));
    expect(monthSelect()).toHaveValue('2026-03');
  });

  it('announces the Subscriptions view in the live region', async () => {
    const user = setup('/budget');
    const status = () => document.querySelector('p.sr-only[aria-live="polite"]');
    expect(status()).toHaveTextContent('Dashboard view');
    await user.click(link('Subscriptions'));
    expect(status()).toHaveTextContent('Subscriptions view');
    await user.click(link('Planner'));
    expect(status()).toHaveTextContent('Planner view');
  });

  it('does not redirect /budget/subscriptions to the dashboard', () => {
    setup('/budget/subscriptions?month=2026-04');
    expect(loc()).toBe('/budget/subscriptions?month=2026-04');
  });
});
