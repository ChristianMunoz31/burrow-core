import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import CrossInsightsCard from '../CrossInsightsCard';
import { renderWithProviders } from '../../../test-utils/renderWithProviders';
import { busynessSpendFixture, expectCardAbsent } from '../../../test-utils/crossInsightsFixtures';
import { computeCrossInsights } from '../../../utils/crossInsights';

// Real card + real useCrossInsights; only the data sources and Oura service are mocked.
const h = vi.hoisted(() => ({
  records: { records: [], loading: false, fetchFailed: false },
  habits: { habits: [], loading: false, error: null },
  journal: { entries: [], loading: false, error: null },
  calendar: { events: [], loading: false, error: null },
  history: vi.fn(),
}));

vi.mock('../../../hooks/useRecords', () => ({ useRecords: () => h.records }));
vi.mock('../../../hooks/useHabits', () => ({ useHabits: () => h.habits }));
vi.mock('../../../hooks/useJournal', () => ({ useJournal: () => h.journal }));
vi.mock('../../../hooks/useCalendar', () => ({ useCalendar: () => h.calendar }));
vi.mock('../../../services/ouraService', () => ({ ouraService: { history: h.history } }));

const fx = busynessSpendFixture();
const DIAGNOSTIC = /Not enough overlapping|isn't connected|imported yet|so spending is skipped|couldn't load|Loading patterns|Loading health|Oura/i;
const settle = () => new Promise((r) => setTimeout(r, 30));

beforeEach(() => {
  h.records = { records: fx.transactions, loading: false, fetchFailed: false };
  h.habits = { habits: [], loading: false, error: null };
  h.journal = { entries: [], loading: false, error: null };
  h.calendar = { events: fx.events, loading: false, error: null };
  h.history.mockReset();
});
afterEach(cleanup);

describe('computeCrossInsights busyness_spend without Oura', () => {
  const now = new Date();

  it('finds busyness_spend from calendar + spend alone', () => {
    const r = computeCrossInsights({ transactions: fx.transactions, events: fx.events, now });
    expect(r.status).toBe('ok');
    expect(r.insights.map((i) => i.id)).toEqual(['busyness_spend']);
    const [i] = r.insights;
    expect(i.n).toBe(60);
    expect(i.rho).toBeGreaterThan(0.3);
    expect(i.effectAbs).toBeGreaterThan(0);
    expect(i.groupA.days).toBeGreaterThanOrEqual(5);
    expect(i.groupB.days).toBeGreaterThanOrEqual(5);
    expect(i.text).toMatch(/calendar events/);
    expect(r.missing).toContain('health_not_connected');
  });

  it('gives the same finding when Oura is explicitly absent, null or not from Oura', () => {
    const base = computeCrossInsights({ transactions: fx.transactions, events: fx.events, now });
    for (const extra of [{ ouraDays: [], ouraSource: null }, { ouraDays: undefined, ouraSource: 'other' }]) {
      const r = computeCrossInsights({ transactions: fx.transactions, events: fx.events, now, ...extra });
      expect(r.insights).toEqual(base.insights);
    }
  });

  it('finds nothing when spend does not vary with events (flat spend)', () => {
    const flat = fx.transactions.map((t) => (t.type === 'debit' ? { ...t, amount: 40 } : t));
    expect(computeCrossInsights({ transactions: flat, events: fx.events, now }).insights).toEqual([]);
  });

  it('finds nothing with fewer than 14 overlapping days', () => {
    const recent = new Set(fx.days.slice(-10));
    const txs = fx.transactions.filter((t) => t.type === 'debit' && recent.has(t.date));
    expect(computeCrossInsights({ transactions: txs, events: fx.events, now }).insights).toEqual([]);
  });
});

describe('CrossInsightsCard with real hook and no Oura', () => {
  it('shows busyness_spend when Oura returns nothing', async () => {
    h.history.mockResolvedValue({ days: [], source: null });
    renderWithProviders(<CrossInsightsCard />);
    expect(await screen.findByRole('heading', { name: 'Patterns across your data' })).toBeInTheDocument();
    expect(screen.getByText(/On days with \d\+ calendar events you spent/)).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
  });

  it('shows busyness_spend immediately while the Oura request is pending', () => {
    h.history.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<CrossInsightsCard />);
    expect(screen.getByText(/calendar events you spent/)).toBeInTheDocument();
  });

  it('shows busyness_spend and no error text when the Oura request fails with 500', async () => {
    h.history.mockRejectedValue(Object.assign(new Error('Request failed with status 500'), { status: 500 }));
    renderWithProviders(<CrossInsightsCard />);
    await waitFor(() => expect(h.history).toHaveBeenCalledTimes(1));
    await settle();
    expect(screen.getByText(/calendar events you spent/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
    expect(h.history).toHaveBeenCalledTimes(1);
  });

  it('still shows the finding when habits and journal fail but spend and calendar are fine', async () => {
    h.history.mockRejectedValue(new Error('down'));
    h.habits = { habits: undefined, loading: false, error: new Error('habits down') };
    h.journal = { entries: undefined, loading: false, error: new Error('journal down') };
    renderWithProviders(<CrossInsightsCard />);
    expect(await screen.findByText(/calendar events you spent/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
  });
});

describe('CrossInsightsCard renders nothing on failures and while loading', () => {
  it('renders nothing and no error text when every source fails', async () => {
    h.history.mockRejectedValue(new Error('down'));
    h.records = { records: [], loading: false, fetchFailed: true };
    h.habits = { habits: undefined, loading: false, error: new Error('x') };
    h.journal = { entries: undefined, loading: false, error: new Error('x') };
    h.calendar = { events: undefined, loading: false, error: new Error('x') };
    const { container } = renderWithProviders(<CrossInsightsCard />);
    await waitFor(() => expect(h.history).toHaveBeenCalled());
    await settle();
    expectCardAbsent(container);
  });

  it('renders nothing when transactions fail and no other pair qualifies', async () => {
    h.history.mockResolvedValue({ days: [], source: null });
    h.records = { records: [], loading: false, fetchFailed: true };
    const { container } = renderWithProviders(<CrossInsightsCard />);
    await waitFor(() => expect(h.history).toHaveBeenCalled());
    expectCardAbsent(container);
    expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
  });

  it('renders nothing when there is no calendar data (no finding possible)', async () => {
    h.history.mockResolvedValue({ days: [], source: null });
    h.calendar = { events: [], loading: false, error: null };
    const { container } = renderWithProviders(<CrossInsightsCard />);
    await waitFor(() => expect(h.history).toHaveBeenCalled());
    expectCardAbsent(container);
  });

  it('renders nothing while a blocking source is loading, then appears when ready', async () => {
    h.history.mockResolvedValue({ days: [], source: null });
    h.records = { records: fx.transactions, loading: true, fetchFailed: false };
    const view = renderWithProviders(<CrossInsightsCard />);
    expectCardAbsent(view.container);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    cleanup();
    h.records = { records: fx.transactions, loading: false, fetchFailed: false };
    renderWithProviders(<CrossInsightsCard />);
    expect(await screen.findByText(/calendar events you spent/)).toBeInTheDocument();
  });
});
