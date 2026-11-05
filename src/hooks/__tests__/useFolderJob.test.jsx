import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../../services/foldersService', () => ({ foldersService: { job: vi.fn() } }));

import { foldersService } from '../../services/foldersService';
import { useFolderJob } from '../useFolderJob';
import { JOB_POLL_MS } from '../../constants/folders';

const job = (status, extra = {}) => ({ id: 'j1', folderId: 'f1', status, phase: 'inventory', notices: [], ...extra });

function setup(active = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const hook = renderHook(() => useFolderJob('f1', { active }), { wrapper });
  return { ...hook, invalidate };
}

const tick = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useFolderJob', () => {
  it('polls every 2000 ms while the job runs and stops when it ends', async () => {
    expect(JOB_POLL_MS).toBe(2000);
    foldersService.job
      .mockResolvedValueOnce({ job: job('queued') })
      .mockResolvedValueOnce({ job: job('running') })
      .mockResolvedValue({ job: job('done') });
    const { result, invalidate } = setup();

    await tick(0);
    expect(foldersService.job).toHaveBeenCalledTimes(1);
    expect(result.current.job.status).toBe('queued');

    await tick(1999);
    expect(foldersService.job).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(foldersService.job).toHaveBeenCalledTimes(2);
    await tick(50);
    expect(result.current.job.status).toBe('running');

    await tick(2000);
    await tick(0);
    expect(foldersService.job).toHaveBeenCalledTimes(3);
    expect(result.current.job.status).toBe('done');
    expect(result.current.polling).toBe(false);

    await tick(10_000);
    expect(foldersService.job).toHaveBeenCalledTimes(3);

    const keys = invalidate.mock.calls.map(([arg]) => arg.queryKey);
    expect(keys).toContainEqual(['folders']);
    expect(keys).toContainEqual(['folder-files', 'f1']);
  });

  it('stops polling when the job read fails and refreshes the list once', async () => {
    foldersService.job.mockRejectedValue(new Error('offline'));
    const { result, invalidate } = setup();
    await tick(0);
    await tick(10_000);
    expect(foldersService.job).toHaveBeenCalledTimes(1);
    expect(result.current.polling).toBe(false);
    expect(invalidate.mock.calls.filter(([arg]) => arg.queryKey[0] === 'folders')).toHaveLength(1);
  });

  it('does not poll while the folder has no job in progress', async () => {
    foldersService.job.mockResolvedValue({ job: null });
    setup(false);
    await tick(10_000);
    expect(foldersService.job).not.toHaveBeenCalled();
  });

  it('refreshes the list once when the server has no job left to follow', async () => {
    foldersService.job.mockResolvedValue({ job: null });
    const { invalidate } = setup();
    await tick(0);
    await tick(6000);
    expect(foldersService.job).toHaveBeenCalledTimes(1);
    expect(invalidate.mock.calls.filter(([arg]) => arg.queryKey[0] === 'folders')).toHaveLength(1);
  });
});
