import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import SubscriptionsWidget from '../SubscriptionsWidget';
import { renderWithProviders } from '../../../test-utils/renderWithProviders';
import { formatCurrency } from '../../../utils/budgetAggregate';

// Three monthly charges on one day of the month make a detected subscription whose next charge
// is the same day of the following month. Today is 2026-10-15.
const monthly = (merchant, amount, days) =>
  days.map((date, i) => ({ id: `${merchant}-${i}`, date, merchant, amount, type: 'debit', category: 'Entertainment' }));
const nextOn = (merchant, amount, day, months = ['07', '08', '09']) =>
  monthly(merchant, amount, months.map((m) => `2026-${m}-${day}`));

const TODAY = nextOn('Streamly', 15.99, '15'); // next 2026-10-15, today
const TOMORROW = nextOn('Cloudbox', 2.99, '16'); // next 2026-10-16
const IN_3 = nextOn('Newsday', 1234.5, '18'); // next 2026-10-18
const DAY_30 = nextOn('Gymco', 40, '14', ['08', '09', '10']); // next 2026-11-14, day 30
const DAY_31 = nextOn('Podly', 7, '15', ['08', '09', '10']); // next 2026-11-15, day 31

const h = vi.hoisted(() => ({ transactions: [], txStatus: 200, txPending: false, calls: [] }));

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      h.calls.push(String(url));
      if (String(url).endsWith('/transactions')) {
        if (h.txPending) return new Promise(() => {});
        return { ok: h.txStatus === 200, status: h.txStatus, json: async () => h.transactions };
      }
      if (String(url).endsWith('/state')) return { ok: true, status: 200, json: async () => ({}) };
      throw new Error(`unexpected request ${url}`);
    }),
  );
}

function renderCard() {
  return renderWithProviders(
    <MemoryRouter>
      <SubscriptionsWidget />
    </MemoryRouter>,
  );
}

const rows = () => screen.queryAllByRole('listitem').map((li) => li.textContent);

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 15, 12, 0, 0));
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

describe('SubscriptionsWidget', () => {
  it('lists the next three charges with relative dates and totals every charge in 30 days', async () => {
    h.transactions = [...DAY_30, ...IN_3, ...TOMORROW, ...TODAY];
    renderCard();
    expect(await screen.findByText(/^Due in the next 30 days:/)).toHaveTextContent(
      `Due in the next 30 days: ${formatCurrency(15.99 + 2.99 + 1234.5 + 40)}`,
    );
    expect(screen.getByText('Due in the next 30 days: $1,293.48')).toBeInTheDocument();
    expect(rows()).toEqual(['Streamlytoday$15.99', 'Cloudboxtomorrow$2.99', 'Newsdayin 3 days$1,234.50']);
    expect(screen.queryByText('Gymco')).not.toBeInTheDocument();
    for (const url of h.calls) expect(url).toMatch(/\/api\/(transactions|state)$/);
  });

  it('includes a charge on day 30 and leaves out day 31', async () => {
    h.transactions = [...DAY_31, ...DAY_30];
    renderCard();
    await screen.findByText(/^Due in the next 30 days:/);
    expect(rows()).toEqual(['Gymcoin 30 days$40.00']);
    expect(screen.getByText('Due in the next 30 days: $40.00')).toBeInTheDocument();
  });

  it('leaves recurring bills out', async () => {
    h.transactions = [
      ...TODAY,
      ...monthly('City Power Company', 80, ['2026-07-20', '2026-08-20', '2026-09-20']).map((t) => ({ ...t, category: 'Utilities' })),
    ];
    renderCard();
    await screen.findByText(/^Due in the next 30 days:/);
    expect(rows()).toEqual(['Streamlytoday$15.99']);
  });

  it('says no subscriptions were found, with the way to the Subscriptions page, when none are detected', async () => {
    h.transactions = [{ id: 'x', date: '2026-10-01', merchant: 'Market', amount: 20, type: 'debit', category: 'Groceries' }];
    renderCard();
    expect(await screen.findByText('No subscriptions found in your transactions yet.')).toBeInTheDocument();
    expect(screen.getByText('Open Subscriptions →')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\$\d/);
  });

  it('says nothing is due when the subscriptions charge later than 30 days out', async () => {
    h.transactions = DAY_31;
    renderCard();
    expect(await screen.findByText('Nothing due in the next 30 days.')).toBeInTheDocument();
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Due in the next/)).not.toBeInTheDocument();
  });

  it('shows the error line when the transactions cannot load', async () => {
    h.txStatus = 500;
    renderCard();
    expect(await screen.findByText("Couldn't load your transactions. Open Subscriptions to try again.")).toBeInTheDocument();
  });

  it('shows a skeleton while transactions load', () => {
    h.txPending = true;
    const { container } = renderCard();
    expect(container.querySelector('.animate-pulse')).not.toBeNull();
  });

  it('is one link to /budget/subscriptions titled Subscriptions', async () => {
    h.transactions = TODAY;
    renderCard();
    await screen.findByText(/^Due in the next 30 days:/);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/budget/subscriptions');
    expect(within(link).getByRole('heading', { name: 'Subscriptions' })).toBeInTheDocument();
  });

  it('moves to the new day when the window comes back after midnight', async () => {
    h.transactions = [...TOMORROW];
    renderCard();
    expect(await screen.findByText('tomorrow')).toBeInTheDocument();
    vi.setSystemTime(new Date(2026, 9, 16, 0, 10, 0));
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(await screen.findByText('today')).toBeInTheDocument();
    expect(screen.queryByText('tomorrow')).not.toBeInTheDocument();
  });
});

