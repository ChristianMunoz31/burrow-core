import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  LICENSE_QUERY_KEY,
  TRIAL_POLL_MAX_MS,
  TRIAL_POLL_MIN_MS,
  trialRefetchInterval,
  useLicense,
  useLicenseFlags,
  useRefreshEntitlements,
} from '../useLicense';

vi.mock('../../services/licenseService', () => ({ licenseService: { get: vi.fn() } }));
import { licenseService } from '../../services/licenseService';

const NOW = Date.parse('2026-10-08T12:00:00Z');
const at = (ms) => new Date(NOW + ms).toISOString();
const q = (data) => ({ state: { data } });
const trialStatus = (endsInMs) => ({ proSource: 'local_trial', pro: true, trial: { state: 'active', endsAt: at(endsInMs) } });

beforeEach(() => {
  licenseService.get.mockReset();
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('trialRefetchInterval', () => {
  it('does not poll outside a local trial', () => {
    expect(trialRefetchInterval(q(undefined))).toBe(false);
    expect(trialRefetchInterval(q({ proSource: 'license', trial: { endsAt: at(1000) } }))).toBe(false);
    expect(trialRefetchInterval(q({ proSource: null, pro: false }))).toBe(false);
  });

  it('aims just past the trial end, clamped between 30 s and 1 h', () => {
    expect(trialRefetchInterval(q(trialStatus(10 * 60 * 1000)))).toBe(10 * 60 * 1000 + 1000);
    expect(trialRefetchInterval(q(trialStatus(5_000)))).toBe(TRIAL_POLL_MIN_MS);
    expect(trialRefetchInterval(q(trialStatus(-5_000)))).toBe(TRIAL_POLL_MIN_MS);
    expect(trialRefetchInterval(q(trialStatus(3 * 24 * 3600 * 1000)))).toBe(TRIAL_POLL_MAX_MS);
  });

  it('falls back to the slow poll when the end date is missing', () => {
    expect(trialRefetchInterval(q({ proSource: 'local_trial', trial: { endsAt: null } }))).toBe(TRIAL_POLL_MAX_MS);
  });
});

// waitFor does not advance fake timers here, so settle by running the timers and microtasks directly.
const settle = (ms = 0) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

function wrapper(client) {
  return ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('the license query', () => {
  it('re-reads on its own while a trial runs, so the ended flip arrives without a focus change', async () => {
    licenseService.get
      .mockResolvedValueOnce(trialStatus(40_000))
      .mockResolvedValue({ proSource: null, pro: false, trial: { state: 'ended', endsAt: at(-1000), notice: 'ended' } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useLicense({ pollTrial: true }), { wrapper: wrapper(client) });
    await settle();
    expect(result.current.status?.pro).toBe(true);
    expect(licenseService.get).toHaveBeenCalledTimes(1);
    await settle(45_000);
    expect(result.current.status?.pro).toBe(false);
    expect(result.current.status.trial.notice).toBe('ended');
    const calls = licenseService.get.mock.calls.length;
    await settle(10 * 60 * 1000);
    expect(licenseService.get).toHaveBeenCalledTimes(calls);
  });

  it('a reader that does not own the timer never polls', async () => {
    licenseService.get.mockResolvedValue(trialStatus(40_000));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => ({ a: useLicense(), b: useLicenseFlags() }), { wrapper: wrapper(client) });
    await settle();
    await settle(2 * 60 * 60 * 1000);
    expect(licenseService.get).toHaveBeenCalledTimes(1);
  });

  it('extra readers add no timer of their own next to the one poller', async () => {
    licenseService.get.mockResolvedValue(trialStatus(10 * 60 * 1000));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(
      () => ({ owner: useLicense({ pollTrial: true }), a: useLicense(), b: useLicense(), flags: useLicenseFlags() }),
      { wrapper: wrapper(client) },
    );
    await settle();
    expect(licenseService.get).toHaveBeenCalledTimes(1);
    // One poll lands just past the 10 min mark; readers with their own timers would add more.
    await settle(10 * 60 * 1000 + 1500);
    expect(licenseService.get).toHaveBeenCalledTimes(2);
  });

  it('useRefreshEntitlements marks the cache stale and reads it again', async () => {
    licenseService.get.mockResolvedValueOnce({ pro: true, proSource: 'license' }).mockResolvedValue({ pro: false, proSource: null });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => ({ license: useLicense(), refresh: useRefreshEntitlements() }), { wrapper: wrapper(client) });
    await settle();
    expect(result.current.license.status?.pro).toBe(true);
    await act(async () => {
      await result.current.refresh();
    });
    await settle();
    expect(result.current.license.status?.pro).toBe(false);
    expect(client.getQueryState(LICENSE_QUERY_KEY).dataUpdateCount).toBe(2);
  });
});
