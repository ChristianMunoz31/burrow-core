import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import BudgetPage from '../BudgetPage';
import { SAMPLE_CATEGORIES, SAMPLE_SUMMARY, SAMPLE_TREND } from '../../../data/budgetSample';

const DEFAULT_ORDER = ['budgetVsActual', 'incomeVsExpenses', 'categoryPies'];
const TITLES = ['Budget vs. actual', 'Income vs. expenses', 'Spending by category group'];

const h = vi.hoisted(() => ({ stored: null, fetched: true, writes: [], otherKeys: [] }));

vi.mock('../../../hooks/useBudgetData', async () => {
  const actual = await vi.importActual('../../../hooks/useBudgetData');
  return { ...actual, useBudgetData: vi.fn(() => null) };
});

// Stateful per hook instance so a re-render sees the written layout. Only the budget layout key is backed by
// the per-test store; every other key returns its fallback. Updater functions are applied to the current value.
vi.mock('../../../hooks/useSyncedSetting', async () => {
  const { useCallback, useState } = await import('react');
  return {
    useSyncedSetting: (key, fallback) => {
      const isLayout = key === 'pos:budgetLayout';
      const [value, setValue] = useState(isLayout ? h.stored : fallback);
      const set = useCallback(
        (next) => {
          if (!isLayout) return;
          h.writes.push(next);
          setValue((prev) => (typeof next === 'function' ? next(prev) : next));
        },
        [isLayout],
      );
      h.otherKeys.push(key);
      return [value, set, { isFetched: isLayout ? h.fetched : true }];
    },
  };
});

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
  h.stored = null;
  h.fetched = true;
  h.writes = [];
  h.otherKeys = [];
  vi.mocked(useBudgetData).mockImplementation(() => FIXED);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-15T12:00:00'));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function setup() {
  const user = userEvent.setup();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/budget']}>
        <Routes>
          <Route path="/budget/*" element={<BudgetPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return user;
}

const customize = () => screen.getByRole('button', { name: 'Customize' });
const handles = () => screen.queryAllByRole('button', { name: /^Move / });
// The tile wrapper (WidgetTile's outer div) is the grid child that holds the card title.
const tileOf = (title) => screen.getByText(title).closest('.lg\\:grid-cols-3 > div');
const maximize = (title) => screen.getByRole('button', { name: `Maximize ${title}` });

// The three chart card titles in DOM order (the Maximize labels are aria-labels, not text).
function headingOrder() {
  return screen
    .getAllByText((text, el) => TITLES.includes(text) && el.tagName !== 'OPTION')
    .map((n) => n.textContent);
}

// Resolve a setter argument (value or updater) to the layout it produces from a previous value.
const resolveWrite = (write, prev = null) => (typeof write === 'function' ? write(prev) : write);

describe('BudgetDashboard layout: customize mode', () => {
  it('Customize enters edit mode with a handle per chart, Reset and Done, and no Maximize buttons', async () => {
    const user = setup();
    expect(handles()).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Reset' })).not.toBeInTheDocument();
    expect(screen.queryByText('Drag a chart by its handle to reorder it.')).not.toBeInTheDocument();
    for (const t of TITLES) expect(maximize(t)).toBeInTheDocument();

    await user.click(customize());

    expect(handles()).toHaveLength(3);
    for (const t of TITLES) expect(screen.getByRole('button', { name: `Move ${t}` })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Customize' })).not.toBeInTheDocument();
    expect(screen.getByText('Drag a chart by its handle to reorder it.')).toBeInTheDocument();
    expect(screen.queryAllByRole('button', { name: /^Maximize / })).toHaveLength(0);
    for (const t of TITLES) expect(screen.getByText(t)).toBeInTheDocument();
  });

  it('Done leaves edit mode: handles and Reset disappear, Maximize returns', async () => {
    const user = setup();
    await user.click(customize());
    await user.click(screen.getByRole('button', { name: 'Done' }));

    expect(handles()).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Reset' })).not.toBeInTheDocument();
    expect(screen.queryByText('Drag a chart by its handle to reorder it.')).not.toBeInTheDocument();
    expect(customize()).toBeEnabled();
    for (const t of TITLES) expect(maximize(t)).toBeInTheDocument();
  });

  it('Customize is disabled until the stored layout has been fetched', () => {
    h.fetched = false;
    setup();
    expect(customize()).toBeDisabled();
    expect(handles()).toHaveLength(0);
  });

  it('entering and leaving edit mode writes nothing', async () => {
    const user = setup();
    await user.click(customize());
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(h.writes).toEqual([]);
  });
});

describe('BudgetDashboard layout: order', () => {
  it('renders the default order when nothing is stored', () => {
    setup();
    expect(headingOrder()).toEqual(TITLES);
  });

  it('renders a stored order in that DOM order', () => {
    h.stored = { order: ['categoryPies', 'incomeVsExpenses', 'budgetVsActual'], cards: {} };
    setup();
    expect(headingOrder()).toEqual([TITLES[2], TITLES[1], TITLES[0]]);
  });

  it('keeps a stored order in edit mode too', async () => {
    h.stored = { order: ['incomeVsExpenses', 'categoryPies', 'budgetVsActual'], cards: {} };
    const user = setup();
    await user.click(customize());
    expect(headingOrder()).toEqual([TITLES[1], TITLES[2], TITLES[0]]);
  });

  it('a stored layout that omits charts still shows all three, appending the missing ones', () => {
    h.stored = { order: ['categoryPies'], cards: {} };
    setup();
    expect(headingOrder()).toHaveLength(3);
    expect(headingOrder()[0]).toBe(TITLES[2]);
  });

  it('never reads the Home layout key', () => {
    setup();
    expect(h.otherKeys).toContain('pos:budgetLayout');
    expect(h.otherKeys).not.toContain('pos:homeLayout');
  });

  it('Reset writes the default order and the DOM shows it', async () => {
    h.stored = { order: ['categoryPies', 'incomeVsExpenses', 'budgetVsActual'], cards: {} };
    const user = setup();
    expect(headingOrder()).toEqual([TITLES[2], TITLES[1], TITLES[0]]);
    await user.click(customize());
    await user.click(screen.getByRole('button', { name: 'Reset' }));

    expect(h.writes).toHaveLength(1);
    const written = resolveWrite(h.writes[0], h.stored);
    expect(written.order).toEqual(DEFAULT_ORDER);
    expect(written.cards).toEqual({});
    expect(headingOrder()).toEqual(TITLES);
  });

  it('writes nothing while the layout is not fetched', () => {
    h.fetched = false;
    setup();
    expect(screen.queryByRole('button', { name: 'Reset' })).not.toBeInTheDocument();
    expect(h.writes).toEqual([]);
  });
});

describe('BudgetDashboard layout: spans', () => {
  it('pairs Budget vs. actual (2 cols) with the trend (1 col) and gives the pies a full row by default', () => {
    setup();
    expect(tileOf(TITLES[0])).toHaveClass('lg:col-span-2');
    expect(tileOf(TITLES[1]).className).not.toMatch(/lg:col-span-/);
    expect(tileOf(TITLES[2])).toHaveClass('lg:col-span-3');
  });

  it('gives every chart a full row when the pair is not adjacent', () => {
    h.stored = { order: ['budgetVsActual', 'categoryPies', 'incomeVsExpenses'], cards: {} };
    setup();
    for (const t of TITLES) expect(tileOf(t)).toHaveClass('lg:col-span-3');
  });
});

describe('BudgetDashboard layout: keyboard reorder', () => {
  // jsdom has no layout, so every rect is zero and dnd-kit finds no neighbour. Give each sortable card a
  // distinct vertical slot. A card is the smallest ancestor of a handle that holds exactly one handle.
  function stubRects() {
    const cards = handles().map((hd) => {
      let el = hd.parentElement;
      while (el.parentElement && el.parentElement.querySelectorAll('[aria-label^="Move "]').length <= 1) {
        el = el.parentElement;
      }
      return el;
    });
    const zero = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} };
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function rect() {
      const i = cards.findIndex((c) => c === this || c.contains(this));
      if (i < 0) return zero;
      const top = i * 400;
      return { x: 0, y: top, top, left: 0, right: 300, bottom: top + 300, width: 300, height: 300, toJSON() {} };
    });
  }

  it('moving the first chart down with the keyboard writes a new order to pos:budgetLayout', async () => {
    const user = setup();
    await user.click(customize());
    stubRects();
    act(() => handles()[0].focus());
    await user.keyboard(' ');
    await user.keyboard('{ArrowDown}');
    await user.keyboard(' ');

    await waitFor(() => expect(h.writes.length).toBeGreaterThan(0));
    const written = resolveWrite(h.writes.at(-1), null);
    expect(written.order.indexOf('budgetVsActual')).toBeGreaterThan(0);
    expect(new Set(written.order)).toEqual(new Set(DEFAULT_ORDER));
    expect(headingOrder()[0]).not.toBe(TITLES[0]);
  });
});

describe('BudgetDashboard maximize', () => {
  it('opens a dialog named after the chart, with the chart inside', async () => {
    const user = setup();
    await user.click(maximize('Income vs. expenses'));
    const dialog = screen.getByRole('dialog', { name: 'Income vs. expenses' });
    expect(dialog.querySelector('.recharts-responsive-container')).not.toBeNull();
  });

  it('opens a dialog for Spending by category group', async () => {
    const user = setup();
    await user.click(maximize('Spending by category group'));
    const dialog = screen.getByRole('dialog', { name: 'Spending by category group' });
    expect(within(dialog).queryByRole('button', { name: /^Maximize / })).not.toBeInTheDocument();
  });

  it('opens a dialog for Budget vs. actual', async () => {
    const user = setup();
    await user.click(maximize('Budget vs. actual'));
    expect(screen.getByRole('dialog', { name: 'Budget vs. actual' })).toBeInTheDocument();
  });

  it('Close button closes the dialog and returns focus to the Maximize button', async () => {
    const user = setup();
    await user.click(maximize('Income vs. expenses'));
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(maximize('Income vs. expenses'));
  });

  it('Escape closes the dialog and returns focus to the Maximize button', async () => {
    const user = setup();
    await user.click(maximize('Budget vs. actual'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(maximize('Budget vs. actual'));
  });

  it('opens one dialog and does not write the layout', async () => {
    const user = setup();
    await user.click(maximize('Income vs. expenses'));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(h.writes).toEqual([]);
  });

  it('shows the chart empty state inside the dialog when there is no data', async () => {
    vi.mocked(useBudgetData).mockImplementation(() => ({ ...FIXED, summary: [], categories: [], trend: [] }));
    const user = setup();
    await user.click(maximize('Income vs. expenses'));
    const dialog = screen.getByRole('dialog', { name: 'Income vs. expenses' });
    expect(dialog.querySelector('.recharts-responsive-container')).toBeNull();
    expect(within(dialog).getByText('No trend data available')).toBeInTheDocument();
  });
});
