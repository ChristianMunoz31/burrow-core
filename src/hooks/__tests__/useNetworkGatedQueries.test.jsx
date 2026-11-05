import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useOura } from '../useOura';
import { useOuraHistory } from '../useCrossInsights';

vi.mock('../../services/networkService', () => ({ networkService: { get: vi.fn(), set: vi.fn() } }));
vi.mock('../../services/ouraService', () => ({
  ouraService: { summary: vi.fn(), history: vi.fn() },
}));
import { networkService } from '../../services/networkService';
import { ouraService } from '../../services/ouraService';

const settings = (oura) => ({
  features: [{ id: 'oura', enabled: oura }],
});

function run(hook) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(hook, { wrapper });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('network-gated queries', () => {
  it('useOura / useOuraHistory make no request while Oura is off', async () => {
    networkService.get.mockResolvedValue(settings(false));
    const { result } = run(() => ({ oura: useOura(), history: useOuraHistory() }));
    await waitFor(() => expect(result.current.oura.error?.code).toBe('network_opt_in_required'));
    expect(result.current.oura.loading).toBe(false);
    expect(ouraService.summary).not.toHaveBeenCalled();
    expect(ouraService.history).not.toHaveBeenCalled();
  });

  it('useOura / useOuraHistory request once Oura is on', async () => {
    networkService.get.mockResolvedValue(settings(true));
    ouraService.summary.mockResolvedValue({ days: [] });
    ouraService.history.mockResolvedValue({ days: [], source: 'oura' });
    const { result } = run(() => ({ oura: useOura(), history: useOuraHistory() }));
    await waitFor(() => expect(ouraService.summary).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(ouraService.history).toHaveBeenCalledTimes(1));
    expect(result.current.oura.error).toBeNull();
  });

  it('still requests (server 403 stays the fallback) when settings fail to load', async () => {
    networkService.get.mockRejectedValue(new Error('boom'));
    ouraService.summary.mockResolvedValue({ days: [] });
    run(() => useOura());
    await waitFor(() => expect(ouraService.summary).toHaveBeenCalledTimes(1));
  });
});
