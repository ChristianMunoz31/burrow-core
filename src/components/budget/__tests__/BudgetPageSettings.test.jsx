import { useEffect } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import BudgetPage from '../BudgetPage';

// Stored settings per key; missing keys fall back to the caller's default.
const stored = vi.hoisted(() => ({ map: {}, meta: {}, dashboardRenders: 0 }));

// Counts Dashboard renders (a render that commits or not is still a signal that the
// Dashboard was selected instead of the redirect) while keeping real behavior.
vi.mock('../BudgetDashboard', async () => {
  const actual = await vi.importActual('../BudgetDashboard');
  const Actual = actual.default;
  return {
    ...actual,
    default: function CountedDashboard(props) {
      stored.dashboardRenders += 1;
      return <Actual {...props} />;
    },
  };
});

vi.mock('../../../hooks/useBudgetData', async () => {
  const actual = await vi.importActual('../../../hooks/useBudgetData');
  return { ...actual, useBudgetData: vi.fn() };
});

vi.mock('../../../hooks/useSyncedSetting', () => ({
  useSyncedSetting: (key, fallback) => [
    key in stored.map ? stored.map[key] : fallback,
    vi.fn(),
    stored.meta[key],
  ],
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

vi.mock('../../../services/transactionsService', () => ({
  transactionsService: {
    fetchTransactions: vi.fn(),
    addTransactions: vi.fn(),
    clearTransactions: vi.fn(),
  },
}));

import { useBudgetData } from '../../../hooks/useBudgetData';

// Latest month with data is 2026-03; "now" is 2026-10-15.
const DATA = {
  summary: [
    { month: '2026-01', income: 1000, expenses: 500, net: 500, savingsRate: 50 },
    { month: '2026-03', income: 1200, expenses: 600, net: 600, savingsRate: 50 },
  ],
  categories: [{ month: '2026-03', category: 'Groceries', budgeted: 300, spent: 250 }],
  trend: [],
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
  stored.map = {};
  stored.meta = {};
  stored.dashboardRenders = 0;
  vi.mocked(useBudgetData).mockReturnValue(DATA);
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
const link = (name) => screen.getByRole('link', { name });
const loc = () => screen.getByTestId('loc').textContent;

describe('budget:defaultView', () => {
  it('planner: /budget redirects to /budget/planner once on entry', () => {
    stored.map['budget:defaultView'] = 'planner';
    setup('/budget');
    expect(loc()).toBe('/budget/planner');
    expect(screen.getByText('Budget planner')).toBeInTheDocument();
    expect(link('Planner')).toHaveAttribute('aria-current', 'page');
  });

  it('planner: the redirect preserves the ?month param', () => {
    stored.map['budget:defaultView'] = 'planner';
    setup('/budget?month=2026-04');
    expect(loc()).toBe('/budget/planner?month=2026-04');
    expect(monthSelect()).toHaveValue('2026-04');
  });

  it('planner: clicking Dashboard afterwards stays on the dashboard', async () => {
    stored.map['budget:defaultView'] = 'planner';
    const user = setup('/budget');
    expect(loc()).toBe('/budget/planner');
    await user.click(link('Dashboard'));
    expect(loc()).toBe('/budget');
    expect(screen.getByText('Budget vs. actual')).toBeInTheDocument();
    expect(screen.queryByText('Budget planner')).not.toBeInTheDocument();
    await user.click(link('Planner'));
    await user.click(link('Dashboard'));
    expect(loc()).toBe('/budget');
  });

  it('planner: a direct deep link to the planner is not redirected elsewhere', () => {
    stored.map['budget:defaultView'] = 'planner';
    setup('/budget/planner?month=2026-03');
    expect(loc()).toBe('/budget/planner?month=2026-03');
  });

  it('dashboard: stays at /budget', () => {
    stored.map['budget:defaultView'] = 'dashboard';
    setup('/budget');
    expect(loc()).toBe('/budget');
    expect(screen.getByText('Budget vs. actual')).toBeInTheDocument();
  });

  it('unset: behaves as dashboard', () => {
    setup('/budget');
    expect(loc()).toBe('/budget');
  });

  it('an unknown stored view behaves as dashboard', () => {
    stored.map['budget:defaultView'] = 'bogus';
    setup('/budget');
    expect(loc()).toBe('/budget');
  });
});

// Richer harness: exposes rerender (to flip mocked meta without navigating) and
// navigate (to drive history), with a sibling route so BudgetPage can unmount.
function setupNav(route = '/budget') {
  const user = userEvent.setup();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const navigateRef = { current: null };
  function NavProbe() {
    const navigate = useNavigate();
    useEffect(() => {
      navigateRef.current = navigate;
    }, [navigate]);
    return null;
  }
  const tree = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path="/budget/*" element={<BudgetPage />} />
          <Route path="/other" element={<div>Other page</div>} />
        </Routes>
        <NavProbe />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const utils = render(tree());
  return {
    user,
    go: (to) => act(() => navigateRef.current(to)),
    rerender: () => utils.rerender(tree()),
  };
}

describe('budget:defaultView with a not-yet-fetched synced value', () => {
  it('shows the Dashboard while unfetched, then redirects to the planner (keeping search)', () => {
    stored.map['budget:defaultView'] = 'planner';
    stored.meta['budget:defaultView'] = { isFetched: false };
    const { rerender } = setupNav('/budget?month=2026-04');
    expect(loc()).toBe('/budget?month=2026-04');
    expect(screen.getByText('Budget vs. actual')).toBeInTheDocument();

    stored.meta['budget:defaultView'] = { isFetched: true };
    rerender();
    expect(loc()).toBe('/budget/planner?month=2026-04');
    expect(screen.getByText('Budget planner')).toBeInTheDocument();
  });

  it('does not redirect when the fetched value is the dashboard', () => {
    stored.map['budget:defaultView'] = 'dashboard';
    stored.meta['budget:defaultView'] = { isFetched: false };
    const { rerender } = setupNav('/budget');
    stored.meta['budget:defaultView'] = { isFetched: true };
    rerender();
    expect(loc()).toBe('/budget');
  });

  it('no redirect if the user clicked view tabs before the fetch completed', async () => {
    stored.map['budget:defaultView'] = 'planner';
    stored.meta['budget:defaultView'] = { isFetched: false };
    const { user, rerender } = setupNav('/budget');
    await user.click(link('Planner'));
    await user.click(link('Dashboard'));
    expect(loc()).toBe('/budget');

    stored.meta['budget:defaultView'] = { isFetched: true };
    rerender();
    expect(loc()).toBe('/budget');
    expect(screen.getByText('Budget vs. actual')).toBeInTheDocument();
  });

  it('no redirect if the user navigated within the module before the fetch completed', () => {
    stored.map['budget:defaultView'] = 'planner';
    stored.meta['budget:defaultView'] = { isFetched: false };
    const { go, rerender } = setupNav('/budget');
    go('/budget/planner');
    go('/budget');
    stored.meta['budget:defaultView'] = { isFetched: true };
    rerender();
    expect(loc()).toBe('/budget');
  });

  it('a missing meta counts as already fetched', () => {
    stored.map['budget:defaultView'] = 'planner';
    setupNav('/budget');
    expect(loc()).toBe('/budget/planner');
  });
});

describe('budget:defaultView and browser history', () => {
  it('initial load at /budget (POP, key default) still redirects to the planner', () => {
    stored.map['budget:defaultView'] = 'planner';
    stored.meta['budget:defaultView'] = { isFetched: true };
    setupNav('/budget');
    expect(loc()).toBe('/budget/planner');
  });

  it('Back into /budget from another route does not redirect (POP, non-default key)', async () => {
    stored.map['budget:defaultView'] = 'planner';
    stored.meta['budget:defaultView'] = { isFetched: true };
    const { user, go } = setupNav('/budget/planner');
    expect(loc()).toBe('/budget/planner');

    await user.click(link('Dashboard'));
    expect(loc()).toBe('/budget');

    go('/other');
    expect(screen.getByText('Other page')).toBeInTheDocument();
    expect(screen.queryByLabelText('Budget month')).not.toBeInTheDocument();

    go(-1);
    expect(screen.getByLabelText('Budget month')).toBeInTheDocument();
    expect(loc()).toBe('/budget');
    expect(screen.getByText('Budget vs. actual')).toBeInTheDocument();
  });

  it('a fresh PUSH into /budget from another route still honors the default view', () => {
    stored.map['budget:defaultView'] = 'planner';
    stored.meta['budget:defaultView'] = { isFetched: true };
    const { go } = setupNav('/other');
    expect(screen.getByText('Other page')).toBeInTheDocument();
    go('/budget');
    expect(loc()).toBe('/budget/planner');
  });
});

describe('budget:defaultView redirect never flashes the Dashboard', () => {
  it('does not render the Dashboard when the planner decision is known at first render', () => {
    stored.map['budget:defaultView'] = 'planner';
    stored.meta['budget:defaultView'] = { isFetched: true };
    setupNav('/budget');
    expect(loc()).toBe('/budget/planner');
    expect(stored.dashboardRenders).toBe(0);
  });

  it('control: the Dashboard does render when the default is the dashboard', () => {
    stored.map['budget:defaultView'] = 'dashboard';
    stored.meta['budget:defaultView'] = { isFetched: true };
    setupNav('/budget');
    expect(stored.dashboardRenders).toBeGreaterThan(0);
  });
});

describe('budget:defaultMonth', () => {
  it('current (default): shows the current month', () => {
    setup('/budget');
    expect(monthSelect()).toHaveValue('2026-10');
  });

  it('latest: shows the latest month with data when ?month is absent', () => {
    stored.map['budget:defaultMonth'] = 'latest';
    setup('/budget');
    expect(monthSelect()).toHaveValue('2026-03');
  });

  it('latest: applies on the planner route too', () => {
    stored.map['budget:defaultMonth'] = 'latest';
    setup('/budget/planner');
    expect(monthSelect()).toHaveValue('2026-03');
  });

  it('latest: an explicit ?month still wins', () => {
    stored.map['budget:defaultMonth'] = 'latest';
    setup('/budget?month=2026-05');
    expect(monthSelect()).toHaveValue('2026-05');
  });

  it('latest: a user pick overrides it and lands in the URL', async () => {
    stored.map['budget:defaultMonth'] = 'latest';
    const user = setup('/budget');
    await user.selectOptions(monthSelect(), '2026-01');
    expect(monthSelect()).toHaveValue('2026-01');
    expect(loc()).toContain('month=2026-01');
  });

  it('latest with no data falls back to the current month', () => {
    stored.map['budget:defaultMonth'] = 'latest';
    vi.mocked(useBudgetData).mockReturnValue({ ...DATA, summary: [], categories: [], trend: [] });
    setup('/budget');
    expect(monthSelect()).toHaveValue('2026-10');
  });

  it('latest + planner view combine', () => {
    stored.map['budget:defaultMonth'] = 'latest';
    stored.map['budget:defaultView'] = 'planner';
    setup('/budget');
    expect(loc()).toBe('/budget/planner');
    expect(monthSelect()).toHaveValue('2026-03');
  });
});
