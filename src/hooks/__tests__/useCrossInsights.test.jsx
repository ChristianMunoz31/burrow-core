import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCrossInsights } from '../useCrossInsights';
import { WINDOW_DAYS } from '../../utils/crossInsights';
import { busynessSpendFixture } from '../../test-utils/crossInsightsFixtures';

const h = vi.hoisted(() => ({
  records: { records: [], loading: false, fetchFailed: false },
  habits: { habits: [], loading: false, error: null },
  journal: { entries: [], loading: false, error: null },
  calendar: { events: [], loading: false, error: null },
  history: vi.fn(),
  gate: { enabled: true },
}));

vi.mock('../useNetworkFeature', () => ({ useNetworkFeature: () => h.gate }));
vi.mock('../useRecords', () => ({ useRecords: () => h.records }));
vi.mock('../useHabits', () => ({ useHabits: () => h.habits }));
vi.mock('../useJournal', () => ({ useJournal: () => h.journal }));
vi.mock('../useCalendar', () => ({ useCalendar: () => h.calendar }));
vi.mock('../../services/ouraService', () => ({ ouraService: { history: h.history } }));

function setup() {
  // Defaults retry to true on purpose: the hook itself must opt out for Oura.
  const client = new QueryClient({ defaultOptions: { queries: { retry: true, retryDelay: 1 } } });
  const wrapper = ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const view = renderHook(() => useCrossInsights(), { wrapper });
  return Object.assign(view, { client });
}

const settle = () => new Promise((r) => setTimeout(r, 30));

beforeEach(() => {
  h.records = { records: [], loading: false, fetchFailed: false };
  h.habits = { habits: [], loading: false, error: null };
  h.journal = { entries: [], loading: false, error: null };
  h.calendar = { events: [], loading: false, error: null };
  h.history.mockReset();
  h.gate = { enabled: true };
});

describe('useCrossInsights', () => {
  it('makes no Oura request while the Oura feature is off', async () => {
    h.gate = { enabled: false };
    setup();
    await settle();
    expect(h.history).not.toHaveBeenCalled();
  });

  it('requests WINDOW_DAYS + 2 Oura days', async () => {
    h.history.mockResolvedValue({ days: [], source: 'oura' });
    setup();
    await waitFor(() => expect(h.history).toHaveBeenCalled());
    expect(h.history).toHaveBeenCalledWith(WINDOW_DAYS + 2);
  });

  it('returns only { result, loading }', () => {
    h.history.mockReturnValue(new Promise(() => {}));
    const { result } = setup();
    expect(Object.keys(result.current).sort()).toEqual(['loading', 'result']);
  });

  it('does not block on a pending Oura request', () => {
    h.history.mockReturnValue(new Promise(() => {}));
    const { result } = setup();
    expect(result.current.loading).toBe(false);
    expect(result.current.result.insights).toEqual([]);
  });

  it.each([['records'], ['habits'], ['journal'], ['calendar']])('blocks while %s is loading', (key) => {
    h.history.mockReturnValue(new Promise(() => {}));
    h[key] = { ...h[key], loading: true };
    expect(setup().result.current.loading).toBe(true);
  });

  it('does not retry a failed Oura request and never blocks', async () => {
    h.history.mockRejectedValue(new Error('down'));
    const { result } = setup();
    await waitFor(() => expect(h.history).toHaveBeenCalledTimes(1));
    await settle();
    expect(h.history).toHaveBeenCalledTimes(1);
    expect(result.current.loading).toBe(false);
    expect(result.current.result.insights).toEqual([]);
  });

  it('treats failed sources as empty: no findings and no failure flags', () => {
    h.history.mockReturnValue(new Promise(() => {}));
    h.records = { records: [], loading: false, fetchFailed: true };
    h.habits = { habits: undefined, loading: false, error: new Error('x') };
    h.journal = { entries: undefined, loading: false, error: new Error('x') };
    h.calendar = { events: undefined, loading: false, error: new Error('x') };
    const { result } = setup();
    expect(result.current.loading).toBe(false);
    expect(result.current.result.status).toBe('insufficient');
    expect(result.current.result.insights).toEqual([]);
    expect(Object.keys(result.current).sort()).toEqual(['loading', 'result']);
  });

  describe('busyness_spend without Oura', () => {
    const fx = busynessSpendFixture();
    const load = () => {
      h.records = { records: fx.transactions, loading: false, fetchFailed: false };
      h.calendar = { events: fx.events, loading: false, error: null };
    };
    const ids = (result) => result.current.result.insights.map((i) => i.id);

    it('computes while the Oura request is still pending', () => {
      load();
      h.history.mockReturnValue(new Promise(() => {}));
      const { result } = setup();
      expect(result.current.loading).toBe(false);
      expect(ids(result)).toEqual(['busyness_spend']);
    });

    it('computes when Oura returns no data', async () => {
      load();
      h.history.mockResolvedValue({ days: [], source: null });
      const { result } = setup();
      await waitFor(() => expect(h.history).toHaveBeenCalled());
      expect(ids(result)).toEqual(['busyness_spend']);
    });

    it('still computes after the Oura request fails (500)', async () => {
      load();
      h.history.mockRejectedValue(Object.assign(new Error('Oura 500'), { status: 500 }));
      const { result } = setup();
      await waitFor(() => expect(h.history).toHaveBeenCalledTimes(1));
      await settle();
      expect(ids(result)).toEqual(['busyness_spend']);
      expect(result.current.loading).toBe(false);
    });

    it('ignores Oura data that is not from Oura', async () => {
      load();
      h.history.mockResolvedValue({ days: [{ day: fx.days[5], sleepHours: 5, readiness: 50 }], source: 'other' });
      const { result } = setup();
      await waitFor(() => expect(h.history).toHaveBeenCalled());
      await settle();
      expect(result.current.result.coverage.health).toBe(0);
    });
  });

  describe('Oura cache across a failed refetch (M1)', () => {
    const fx = busynessSpendFixture();
    const goodDays = () => fx.days.map((day, i) => ({ day, sleepHours: i % 2 ? 6 : 8, readiness: 80 }));

    it('keeps health series after a background refetch fails', async () => {
      h.history.mockResolvedValueOnce({ days: goodDays(), source: 'oura' });
      const view = setup();
      await waitFor(() => expect(view.result.current.result.coverage.health).toBe(fx.days.length));

      h.history.mockRejectedValueOnce(new Error('Oura 500'));
      await view.client.refetchQueries({ queryKey: ['oura', 'history'] });
      await waitFor(() => expect(view.client.getQueryState(['oura', 'history', WINDOW_DAYS + 2]).fetchStatus).toBe('idle'));
      expect(view.client.getQueryState(['oura', 'history', WINDOW_DAYS + 2]).status).toBe('error');
      expect(h.history).toHaveBeenCalledTimes(2);

      expect(view.result.current.result.coverage.health).toBe(fx.days.length);
      expect(view.result.current.result.missing).not.toContain('health_not_connected');
    });

    it('produces no health pairs when Oura never loaded', async () => {
      h.history.mockRejectedValue(new Error('Oura 500'));
      const view = setup();
      await waitFor(() => expect(h.history).toHaveBeenCalledTimes(1));
      await settle();
      const { result } = view.result.current;
      expect(result.coverage.health).toBe(0);
      expect(result.missing).toContain('health_not_connected');
      expect(result.insights.map((i) => i.id)).toEqual([]);
    });
  });
});
