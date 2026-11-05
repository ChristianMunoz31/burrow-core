import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useWeather } from '../useWeather';

vi.mock('../../services/networkService', () => ({ networkService: { get: vi.fn(), set: vi.fn() } }));
vi.mock('../../services/weatherService', () => ({ weatherService: { fetch: vi.fn() } }));
import { networkService } from '../../services/networkService';
import { weatherService } from '../../services/weatherService';

const settings = (weather) => ({ features: [{ id: 'weather', enabled: weather }] });
const getCurrentPosition = vi.fn();

function run(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  const wrapper = ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(() => useWeather(), { wrapper });
}

beforeEach(() => {
  Object.defineProperty(globalThis.navigator, 'geolocation', {
    value: { getCurrentPosition },
    configurable: true,
  });
  weatherService.fetch.mockResolvedValue({ current: {} });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('useWeather location', () => {
  it('makes no request and never prompts for location while the Weather feature is off', async () => {
    networkService.get.mockResolvedValue(settings(false));
    const { result } = run();
    await waitFor(() => expect(result.current.error?.code).toBe('network_opt_in_required'));
    expect(result.current.loading).toBe(false);
    expect(weatherService.fetch).not.toHaveBeenCalled();
    expect(getCurrentPosition).not.toHaveBeenCalled();
    expect(result.current.locationSource).toBe('default');
  });

  it('never asks the browser for the device location on mount, even with Weather on', async () => {
    networkService.get.mockResolvedValue(settings(true));
    weatherService.fetch.mockResolvedValue({ current: {}, locationSource: 'saved' });
    const { result } = run();
    await waitFor(() => expect(result.current.data).not.toBeNull());
    await new Promise((r) => setTimeout(r, 30));
    expect(getCurrentPosition).not.toHaveBeenCalled();
    // The server picks the saved location: the client sends no coordinates.
    expect(weatherService.fetch).toHaveBeenCalledWith();
    expect(result.current.locationSource).toBe('saved');
  });

  it('does not retry a missing location: the card points to Settings', async () => {
    networkService.get.mockResolvedValue(settings(true));
    weatherService.fetch.mockRejectedValue(Object.assign(new Error('missing'), { status: 503, locationMissing: true }));
    const client = new QueryClient(); // default retry options: the hook's own retry rule applies
    const { result } = run(client);
    await waitFor(() => expect(result.current.error?.locationMissing).toBe(true));
    expect(weatherService.fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the forecast fresh for 30 minutes, so a second mount makes no new request', async () => {
    networkService.get.mockResolvedValue(settings(true));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const first = run(client);
    await waitFor(() => expect(first.result.current.data).not.toBeNull());
    first.unmount();
    const second = run(client);
    await waitFor(() => expect(second.result.current.data).not.toBeNull());
    await new Promise((r) => setTimeout(r, 30));
    expect(weatherService.fetch).toHaveBeenCalledTimes(1);
    const q = client.getQueryCache().find({ queryKey: ['weather'] });
    expect(q.options.staleTime).toBe(30 * 60_000);
  });
});
