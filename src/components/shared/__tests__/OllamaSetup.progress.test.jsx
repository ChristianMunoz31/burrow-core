// Progress bar values and unit formatting for the guided download.
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import OllamaSetup from '../OllamaSetup';
import { aiSettingsService } from '../../../services/aiSettingsService';
import { __resetPullStoreForTests } from '../../../hooks/ollamaPullStore';

vi.mock('../../../services/aiSettingsService', () => ({
  aiSettingsService: { setup: vi.fn(), pull: vi.fn() },
}));

const SETUP = {
  ollama: 'running',
  host: 'http://127.0.0.1:11434',
  version: '0.32.14',
  models: [],
  ready: false,
  ramGb: 8,
  recommended: {
    tier: 'small',
    ramGb: 8,
    primary: [{ name: 'llama3.2:3b', downloadGb: 2, purpose: 'both', reason: 'A good balance.' }],
    optional: [],
  },
  canPull: true,
  provider: 'ollama',
};

let onProgress;
beforeEach(() => {
  vi.clearAllMocks();
  __resetPullStoreForTests();
  aiSettingsService.setup.mockResolvedValue(SETUP);
  aiSettingsService.pull.mockImplementation(
    (_m, opts) =>
      new Promise((_res, rej) => {
        onProgress = opts.onProgress;
        opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' })));
      }),
  );
});
afterEach(() => {
  cleanup();
  __resetPullStoreForTests();
});

async function startDownload() {
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <OllamaSetup />
    </QueryClientProvider>,
  );
  await user.click(await screen.findByRole('button', { name: 'Download model llama3.2:3b' }));
  return screen.findByRole('progressbar');
}

describe('OllamaSetup progress bar values', () => {
  it('is indeterminate (no aria-valuenow, no percent text) until a total is known', async () => {
    const bar = await startDownload();
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(bar).toHaveAttribute('aria-valuetext', 'Preparing');
    expect(screen.queryByText(/%/)).toBeNull();
    act(() => onProgress({ phase: 'manifest', completed: 0, total: 0 }));
    expect(bar).not.toHaveAttribute('aria-valuenow');
  });

  it('starts at 0 percent and floors partial percents instead of rounding up', async () => {
    const bar = await startDownload();
    act(() => onProgress({ phase: 'downloading', completed: 0, total: 2e9 }));
    await waitFor(() => expect(bar).toHaveAttribute('aria-valuenow', '0'));
    act(() => onProgress({ phase: 'downloading', completed: 1.999e9, total: 2e9 }));
    await waitFor(() => expect(bar).toHaveAttribute('aria-valuenow', '99'));
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
  });

  it('never exceeds 100 even when completed overshoots total', async () => {
    const bar = await startDownload();
    act(() => onProgress({ phase: 'downloading', completed: 2.2e9, total: 2e9 }));
    await waitFor(() => expect(bar).toHaveAttribute('aria-valuenow', '100'));
    expect(bar.firstChild).toHaveStyle({ width: '100%' });
  });

  it('shows megabytes with no decimals for a small total', async () => {
    const bar = await startDownload();
    act(() => onProgress({ phase: 'downloading', completed: 250e6, total: 500e6 }));
    await waitFor(() => expect(bar).toHaveAttribute('aria-valuenow', '50'));
    expect(screen.getByText(/50% · 250 of 500 MB/)).toBeInTheDocument();
  });
});
