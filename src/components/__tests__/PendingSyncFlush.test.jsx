import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PendingSyncFlush from '../PendingSyncFlush';
import { ToastProvider } from '../../contexts/ToastContext';
import { StrictMode } from 'react';
import { markDirty } from '../../utils/syncMode';

vi.mock('../../services/stateService', () => ({
  stateService: { get: vi.fn(), put: vi.fn() },
}));

import { stateService } from '../../services/stateService';
import { lsKey } from '../../utils/storageKeys';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  stateService.put.mockReset();
  stateService.put.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function mount() {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const utils = render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <PendingSyncFlush />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { ...utils, invalidate };
}

describe('PendingSyncFlush erase note', () => {
  const NOTE = 'Your data was erased, but the final cleanup did not finish. Choose Erase all my data again to finish.';

  it('shows the note an incomplete erase left, once, even under StrictMode', async () => {
    sessionStorage.setItem(lsKey('erase:note'), NOTE);
    render(
      <StrictMode>
        <QueryClientProvider client={new QueryClient()}>
          <ToastProvider>
            <PendingSyncFlush />
          </ToastProvider>
        </QueryClientProvider>
      </StrictMode>,
    );
    expect(await screen.findAllByText(NOTE)).toHaveLength(1);
    expect(sessionStorage.getItem(lsKey('erase:note'))).toBeNull();
  });

  it('shows nothing when no erase left a note', () => {
    mount();
    expect(screen.queryByText(/final cleanup/)).not.toBeInTheDocument();
  });
});

describe('PendingSyncFlush', () => {
  it('renders nothing visible and pushes pending keys in account mode', async () => {
    localStorage.setItem(lsKey('theme'), JSON.stringify('dark'));
    markDirty('theme');
    mount();
    await waitFor(() => expect(stateService.put).toHaveBeenCalledWith('theme', 'dark'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('invalidates the [state] queries after flushing', async () => {
    localStorage.setItem(lsKey('theme'), JSON.stringify('dark'));
    markDirty('theme');
    const { invalidate } = mount();
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['state'] }));
  });

  it('toasts once when some keys could not be pushed', async () => {
    localStorage.setItem(lsKey('theme'), JSON.stringify('dark'));
    localStorage.setItem(lsKey('mode'), JSON.stringify('work'));
    markDirty('theme');
    markDirty('mode');
    stateService.put.mockRejectedValue(new Error('offline'));
    mount();
    expect(await screen.findByText("Some settings haven't been saved yet. Burrow will retry.")).toBeInTheDocument();
  });

  it('toasts only once under StrictMode double effects', async () => {
    localStorage.setItem(lsKey('theme'), JSON.stringify('dark'));
    markDirty('theme');
    stateService.put.mockRejectedValue(new Error('offline'));
    render(
      <StrictMode>
        <QueryClientProvider client={new QueryClient()}>
          <ToastProvider>
            <PendingSyncFlush />
          </ToastProvider>
        </QueryClientProvider>
      </StrictMode>,
    );
    await screen.findByText("Some settings haven't been saved yet. Burrow will retry.");
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getAllByText("Some settings haven't been saved yet. Burrow will retry.")).toHaveLength(1);
  });

  it('does nothing with no pending keys', async () => {
    mount();
    await new Promise((r) => setTimeout(r, 20));
    expect(stateService.put).not.toHaveBeenCalled();
  });
});
