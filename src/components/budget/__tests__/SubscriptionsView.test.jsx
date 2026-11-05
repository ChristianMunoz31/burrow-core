import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import SubscriptionsView from '../SubscriptionsView';

const state = vi.hoisted(() => ({ value: null }));

vi.mock('../../../hooks/useRecords', () => ({
  useRecords: () => state.value,
}));

const tx = (date, merchant, amount, extra = {}) => ({
  id: `${merchant}-${date}`,
  date,
  merchant,
  amount,
  category: 'Entertainment',
  type: 'debit',
  ...extra,
});

const RECORDS = [
  // yearly: $14,814.72 / 12 = $1,234.56 per month
  tx('2025-09-10', 'BIG ANNUAL CO', 14814.72, { category: 'Software' }),
  tx('2026-09-10', 'BIG ANNUAL CO', 14814.72, { category: 'Software' }),
  // monthly with a price increase
  tx('2026-07-15', 'NETFLIX.COM', 15.49),
  tx('2026-08-15', 'NETFLIX.COM', 15.49),
  tx('2026-09-15', 'NETFLIX.COM', 17.49),
  // stale
  tx('2025-10-15', 'OLD APP', 20),
  tx('2025-11-15', 'OLD APP', 20),
  tx('2025-12-15', 'OLD APP', 20),
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 3, 12, 0));
  state.value = { records: RECORDS, loading: false, fetchFailed: false };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('SubscriptionsView', () => {
  it('renders summary totals with $1,234.56 formatting', () => {
    render(<SubscriptionsView />);
    // 1234.56 + 17.49 (price-increase typical is the last charge) monthly, x12 yearly
    expect(screen.getByText('$1,252.05')).toBeInTheDocument();
    expect(screen.getByText('$15,024.60')).toBeInTheDocument();
    expect(screen.getByText('Monthly total').nextElementSibling).toHaveTextContent('$1,252.05');
    expect(screen.getByText('Yearly total').nextElementSibling).toHaveTextContent('$15,024.60');
    // the caption reuses the stat label text, so pick the <p> stat label
    const stat = screen.getAllByText('Active subscriptions').find((el) => el.tagName === 'P');
    expect(stat.nextElementSibling).toHaveTextContent('2');
  });

  it('renders each active subscription row with formatted amounts', () => {
    render(<SubscriptionsView />);
    const annual = screen.getByText('BIG ANNUAL CO').closest('tr');
    expect(within(annual).getByText('Yearly')).toBeInTheDocument();
    expect(within(annual).getByText('Software')).toBeInTheDocument();
    expect(within(annual).getByText('$14,814.72')).toBeInTheDocument();
    expect(within(annual).getByText('$1,234.56')).toBeInTheDocument();
    expect(within(annual).getByText('Sep 10, 2026')).toBeInTheDocument();
    expect(within(annual).getByText('Sep 10, 2027')).toBeInTheDocument();

    const netflix = screen.getByText('NETFLIX.COM').closest('tr');
    expect(within(netflix).getByText('Monthly')).toBeInTheDocument();
    expect(within(netflix).getByText('Sep 15, 2026')).toBeInTheDocument();
    expect(within(netflix).getByText('Oct 15, 2026')).toBeInTheDocument();
  });

  it('shows the price increase badge', () => {
    render(<SubscriptionsView />);
    expect(screen.getByText('Up 13% ($15.49 to $17.49)')).toBeInTheDocument();
  });

  it('lists possibly cancelled subscriptions in a collapsed group showing Stopped as next', () => {
    render(<SubscriptionsView />);
    const summary = screen.getByText('Possibly cancelled (1)');
    const details = summary.closest('details');
    expect(details).not.toHaveAttribute('open');
    const row = within(details).getByText('OLD APP').closest('tr');
    expect(within(row).getAllByText('$20.00')).toHaveLength(2); // typical + monthly
    // every table keeps the Next expected column so the columns match; cancelled says Stopped
    expect(within(details).getByText('Next expected', { selector: 'th' })).toBeInTheDocument();
    expect(within(row).getByText('Stopped')).toBeInTheDocument();
    expect(screen.getAllByText('Next expected')).toHaveLength(2);
  });

  it('omits the cancelled group when everything is active', () => {
    state.value = {
      records: RECORDS.slice(0, 5),
      loading: false,
      fetchFailed: false,
    };
    render(<SubscriptionsView />);
    expect(screen.queryByText(/Possibly cancelled/)).not.toBeInTheDocument();
  });

  it('shows only the cancelled group (no table of active items) when nothing is active', () => {
    // a fresh unrelated charge keeps the data horizon at today
    state.value = {
      records: [...RECORDS.slice(5), tx('2026-10-01', 'COFFEE', 4)],
      loading: false,
      fetchFailed: false,
    };
    render(<SubscriptionsView />);
    expect(screen.getByText('No active subscriptions')).toBeInTheDocument();
    expect(screen.getByText('Possibly cancelled (1)')).toBeInTheDocument();
    expect(screen.getAllByRole('table', { hidden: true })).toHaveLength(1);
  });

  it('shows the empty state when no recurring charges exist', () => {
    state.value = { records: [], loading: false, fetchFailed: false };
    render(<SubscriptionsView />);
    expect(screen.getByText(/No recurring charges found yet/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText('Monthly')).not.toBeInTheDocument();
    expect(screen.queryByText('Yearly')).not.toBeInTheDocument();
  });

  it('shows the empty state for transactions without any recurring pattern', () => {
    state.value = {
      records: [tx('2026-09-01', 'COFFEE', 4), tx('2026-09-09', 'BOOKS', 20)],
      loading: false,
      fetchFailed: false,
    };
    render(<SubscriptionsView />);
    expect(screen.getByText(/No recurring charges found yet/)).toBeInTheDocument();
  });

  it('shows an alert when transactions failed to load', () => {
    state.value = { records: [], loading: false, fetchFailed: true };
    render(<SubscriptionsView />);
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load transactions.");
    expect(screen.queryByText(/No recurring charges found yet/)).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows neither content nor empty/error copy while loading', () => {
    state.value = { records: [], loading: true, fetchFailed: false };
    render(<SubscriptionsView />);
    expect(screen.queryByText(/No recurring charges found yet/)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Subscriptions')).not.toBeInTheDocument();
    const status = screen.getByRole('status', {
      name: 'Loading subscriptions',
    });
    expect(status).toHaveAttribute('aria-busy', 'true');
  });

  it('labels each table region and gives rows a header cell', () => {
    render(<SubscriptionsView />);
    const region = screen.getByRole('region', { name: 'Active subscriptions' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region.className).toMatch(/focus-visible:outline/);
    expect(within(region).getByRole('table', { name: 'Active subscriptions' })).toBeInTheDocument();
    expect(within(region).getByRole('rowheader', { name: /NETFLIX.COM/ })).toBeInTheDocument();
    const cancelled = screen.getByRole('region', {
      name: 'Possibly cancelled recurring charges',
      hidden: true,
    });
    expect(cancelled).toHaveAttribute('tabindex', '0');
  });

  it('shows the full empty-state guidance', () => {
    state.value = { records: [], loading: false, fetchFailed: false };
    render(<SubscriptionsView />);
    expect(
      screen.getByText(/after 4 weekly, 3 monthly, or 2 yearly charges from the same merchant/),
    ).toBeInTheDocument();
  });

  it('renders the card title and a matching Subscriptions section heading', () => {
    render(<SubscriptionsView />);
    expect(screen.getAllByText('Subscriptions')).toHaveLength(2);
    const section = screen.getByRole('region', { name: 'Subscriptions' });
    const heading = within(section).getByRole('heading', { name: 'Subscriptions' });
    expect(heading.className).toBe('text-sm font-semibold text-slate-slate200'); // same as Recurring bills
    expect(section).toContainElement(screen.getByRole('region', { name: 'Active subscriptions' }));
  });

  it('uses the same top-aligned cell style for the cadence pill', () => {
    render(<SubscriptionsView />);
    const pill = screen.getAllByText('Monthly')[0];
    expect(pill.closest('td').className).toMatch(/align-top/);
    expect(pill.closest('td').className).toMatch(/text-sm/);
  });

  describe('bills, alignment and overdue', () => {
    const MONTHLY = ['2026-07-15', '2026-08-15', '2026-09-15'];
    const rent = MONTHLY.map((d) => tx(d, 'LANDLORD LLC', 1725, { category: 'Rent' }));
    const netflix = MONTHLY.map((d) => tx(d, 'NETFLIX.COM', 15.49));
    const oldApp = ['2025-10-15', '2025-11-15', '2025-12-15'].map((d) => tx(d, 'OLD APP', 20));
    const load = (records) => {
      state.value = { records, loading: false, fetchFailed: false };
    };

    it('keeps bills out of the subscription stats and lists them in their own section', () => {
      load([...netflix, ...rent]);
      render(<SubscriptionsView />);
      expect(screen.getByText('Monthly total').nextElementSibling).toHaveTextContent('$15.49');
      const stat = screen.getAllByText('Active subscriptions').find((el) => el.tagName === 'P');
      expect(stat.nextElementSibling).toHaveTextContent('1');
      const bills = screen.getByRole('region', { name: 'Recurring bills' });
      expect(within(bills).getByText('LANDLORD LLC')).toBeInTheDocument();
      expect(within(bills).getByText('Bills: $1,725.00/mo')).toBeInTheDocument();
      const subs = screen.getByRole('region', { name: 'Active subscriptions' });
      expect(within(subs).queryByText('LANDLORD LLC')).not.toBeInTheDocument();
      expect(screen.getAllByRole('table')).toHaveLength(2);
    });

    it('orders the sections subscriptions, bills, then possibly cancelled', () => {
      load([...netflix, ...rent, ...oldApp]);
      const { container } = render(<SubscriptionsView />);
      const text = container.textContent;
      expect(text.indexOf('Active subscriptions')).toBeLessThan(text.indexOf('Recurring bills'));
      expect(text.indexOf('Recurring bills')).toBeLessThan(text.indexOf('Possibly cancelled'));
    });

    it('uses bills-only copy and omits the stats when only bills exist', () => {
      load(rent);
      render(<SubscriptionsView />);
      expect(screen.getByText(/Only recurring bills were detected/)).toBeInTheDocument();
      expect(screen.queryByText('Monthly total')).not.toBeInTheDocument();
      expect(screen.queryByText(/No recurring charges found yet/)).not.toBeInTheDocument();
      expect(screen.getByText('Bills: $1,725.00/mo')).toBeInTheDocument();
    });

    it('uses the same fixed column widths and top alignment in every table', () => {
      load([...netflix, ...rent, ...oldApp]);
      render(<SubscriptionsView />);
      const tables = screen.getAllByRole('table', { hidden: true });
      expect(tables).toHaveLength(3);
      const widths = tables.map((t) =>
        [...t.querySelectorAll('col')].map((c) => c.className).join(' '),
      );
      expect(new Set(widths).size).toBe(1);
      for (const t of tables) {
        expect(t.className).toMatch(/table-fixed/);
        expect(t.querySelectorAll('tbody td').length).toBeGreaterThan(0);
        for (const td of t.querySelectorAll('tbody td')) expect(td.className).toMatch(/align-top/);
      }
    });

    it('shows Overdue instead of the date when the next charge is in the past', () => {
      vi.setSystemTime(new Date(2026, 9, 25, 12, 0)); // next expected 2026-10-15, past its tolerance
      load([...netflix, tx('2026-10-24', 'COFFEE', 4)]);
      render(<SubscriptionsView />);
      const row = screen.getByText('NETFLIX.COM').closest('tr');
      const overdue = within(row).getByText('Overdue');
      expect(overdue.className).toMatch(/accent-amber/);
      expect(within(row).queryByText('Oct 15, 2026')).not.toBeInTheDocument();
    });

    it('does not flag Overdue inside the cadence tolerance (driven by item.overdue)', () => {
      vi.setSystemTime(new Date(2026, 9, 18, 12, 0));
      load([...netflix, tx('2026-10-17', 'COFFEE', 4)]);
      render(<SubscriptionsView />);
      const row = screen.getByText('NETFLIX.COM').closest('tr');
      expect(within(row).queryByText('Overdue')).not.toBeInTheDocument();
      expect(within(row).getByText('Oct 15, 2026')).toBeInTheDocument();
    });

    it('appends the typical amount when two rows share a merchant name', () => {
      load([
        ...MONTHLY.map((d) => tx(d, 'APPLE.COM/BILL', 2.99, { category: 'Subscriptions' })),
        ...MONTHLY.map((d) => tx(d, 'APPLE.COM/BILL', 10.99, { category: 'Subscriptions' })),
      ]);
      render(<SubscriptionsView />);
      expect(screen.getByText('Subscriptions · $2.99')).toBeInTheDocument();
      expect(screen.getByText('Subscriptions · $10.99')).toBeInTheDocument();
      cleanup();
      load(netflix);
      render(<SubscriptionsView />);
      expect(screen.queryByText(/Entertainment ·/)).not.toBeInTheDocument();
    });

    describe('below the sm breakpoint', () => {
      const original = window.matchMedia;
      beforeEach(() => {
        window.matchMedia = (query) => ({
          matches: query === '(max-width: 639px)',
          addEventListener: () => {},
          removeEventListener: () => {},
        });
      });
      afterEach(() => {
        window.matchMedia = original;
      });

      it('renders a labelled stacked list with a middle dot instead of the table', () => {
        load([...netflix, ...rent]);
        render(<SubscriptionsView />);
        expect(screen.queryByRole('table')).not.toBeInTheDocument();
        const list = screen.getByRole('list', { name: 'Active subscriptions' });
        const item = within(list).getByText('NETFLIX.COM').closest('li');
        expect(item).not.toHaveAttribute('aria-labelledby');
        expect(item.querySelector('[id]')).toBeNull();
        expect(item).toHaveTextContent('Monthly · $15.49 · next Oct 15');
        expect(item.textContent).not.toMatch(/[–—]/);
        expect(screen.getByRole('list', { name: 'Active recurring bills' })).toBeInTheDocument();
      });

      it('falls back to addListener/removeListener when addEventListener is missing', () => {
        const added = [];
        const removed = [];
        window.matchMedia = (query) => ({
          matches: query === '(max-width: 639px)',
          addListener: (fn) => added.push(fn),
          removeListener: (fn) => removed.push(fn),
        });
        load(netflix);
        const { unmount } = render(<SubscriptionsView />);
        expect(screen.getByRole('list', { name: 'Active subscriptions' })).toBeInTheDocument();
        expect(added).toHaveLength(1);
        unmount();
        expect(removed).toEqual(added);
      });

      it('shows Overdue and Stopped in the stacked rows', () => {
        vi.setSystemTime(new Date(2026, 9, 25, 12, 0));
        load([...netflix, ...oldApp, tx('2026-10-24', 'COFFEE', 4)]);
        render(<SubscriptionsView />);
        expect(screen.getByText('NETFLIX.COM').closest('li')).toHaveTextContent(
          'Monthly · $15.49 · Overdue',
        );
        const cancelled = screen.getByRole('list', {
          name: 'Possibly cancelled recurring charges',
          hidden: true,
        });
        expect(within(cancelled).getByText('Stopped')).toBeInTheDocument();
      });
    });
  });
});
