import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAppInfo } from '../useAppInfo';
import DevBuildBadge from '../../components/shell/DevBuildBadge';
import { getAppInfo } from '../../services/appInfoService';

vi.mock('../../services/appInfoService', () => ({ getAppInfo: vi.fn() }));

// The hook sets retry: 1 itself; a tiny retryDelay keeps the error cases fast.
const newClient = () => new QueryClient({ defaultOptions: { queries: { retryDelay: 1 } } });

function wrapperFor(client) {
  return function Wrapper({ children }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

beforeEach(() => {
  getAppInfo.mockReset();
});
afterEach(cleanup);

describe('useAppInfo', () => {
  it('is null while loading, then the loaded info', async () => {
    const data = { version: '0.1.0', channel: 'stable', desktop: true };
    getAppInfo.mockResolvedValue(data);
    const { result } = renderHook(() => useAppInfo(), { wrapper: wrapperFor(newClient()) });
    expect(result.current.info).toBeNull();
    await waitFor(() => expect(result.current.info).toEqual(data));
  });

  it('stays null when the request rejects', async () => {
    getAppInfo.mockRejectedValue(new Error('down'));
    const { result } = renderHook(() => useAppInfo(), { wrapper: wrapperFor(newClient()) });
    await waitFor(() => expect(getAppInfo).toHaveBeenCalledTimes(2));
    await settle();
    expect(result.current.info).toBeNull();
  });
});

describe('DevBuildBadge with the real hook', () => {
  it('stays empty while loading', () => {
    getAppInfo.mockReturnValue(new Promise(() => {}));
    const { container } = render(<DevBuildBadge />, { wrapper: wrapperFor(newClient()) });
    expect(container).toBeEmptyDOMElement();
  });

  it('stays empty on error', async () => {
    getAppInfo.mockRejectedValue(new Error('down'));
    const { container } = render(<DevBuildBadge />, { wrapper: wrapperFor(newClient()) });
    await waitFor(() => expect(getAppInfo).toHaveBeenCalledTimes(2));
    await settle();
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the pill once the dev info loads', async () => {
    getAppInfo.mockResolvedValue({ version: '0.2.0-dev.1', channel: 'dev', desktop: true });
    render(<DevBuildBadge />, { wrapper: wrapperFor(newClient()) });
    expect(await screen.findByText('Dev build')).toBeInTheDocument();
  });
});
