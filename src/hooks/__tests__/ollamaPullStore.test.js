import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/aiSettingsService', () => ({
  aiSettingsService: { pull: vi.fn() },
}));

import { aiSettingsService } from '../../services/aiSettingsService';
import {
  RESTART_RETRY_DELAY_MS,
  __resetPullStoreForTests,
  cancelPull,
  getSnapshot,
  resetPull,
  startPull,
} from '../ollamaPullStore';

const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

/** Every call to pull() gets its own handle; a call rejects with AbortError when aborted. */
function pullCalls() {
  const calls = [];
  aiSettingsService.pull.mockImplementation(
    (model, { signal, onProgress }) =>
      new Promise((resolve, reject) => {
        const call = { model, signal, onProgress, resolve, reject };
        calls.push(call);
        signal.addEventListener('abort', () => reject(abortError()));
      }),
  );
  return calls;
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetPullStoreForTests();
});
afterEach(() => {
  vi.useRealTimers();
  __resetPullStoreForTests();
});

describe('ollamaPullStore', () => {
  it('ignores a second start while one runs', () => {
    const calls = pullCalls();
    startPull('m');
    startPull('m');
    expect(calls).toHaveLength(1);
    expect(getSnapshot()).toMatchObject({ status: 'pulling', model: 'm', phase: 'manifest' });
  });

  it('ignores callbacks from a cancelled download after an instant restart', async () => {
    const calls = pullCalls();
    startPull('m');
    cancelPull();
    expect(getSnapshot().status).toBe('cancelled');
    startPull('m');
    expect(calls).toHaveLength(2);
    // The first request's late progress and its abort rejection must not touch the new run.
    calls[0].onProgress({ phase: 'downloading', completed: 9, total: 10 });
    await Promise.resolve();
    await Promise.resolve();
    expect(getSnapshot()).toMatchObject({ status: 'pulling', phase: 'manifest', completed: 0 });
    calls[1].onProgress({ phase: 'downloading', completed: 1, total: 10 });
    expect(getSnapshot()).toMatchObject({ completed: 1, total: 10 });
  });

  it('retries once after a short delay when the server still holds the lock after a cancel', async () => {
    vi.useFakeTimers();
    const calls = pullCalls();
    startPull('m');
    cancelPull();
    startPull('m');
    calls[1].reject(Object.assign(new Error('busy'), { code: 'pull_in_progress', status: 409 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(getSnapshot().status).toBe('pulling');
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(RESTART_RETRY_DELAY_MS);
    expect(calls).toHaveLength(3);
    expect(getSnapshot().status).toBe('pulling');
    // A second 409 is final.
    calls[2].reject(Object.assign(new Error('busy'), { code: 'pull_in_progress', status: 409 }));
    await vi.advanceTimersByTimeAsync(RESTART_RETRY_DELAY_MS * 2);
    expect(calls).toHaveLength(3);
    expect(getSnapshot()).toMatchObject({ status: 'error', error: { code: 'pull_in_progress' } });
  });

  it('does not retry a 409 that is not right after a cancel', async () => {
    const calls = pullCalls();
    startPull('m');
    calls[0].reject(Object.assign(new Error('busy'), { code: 'pull_in_progress', status: 409 }));
    await Promise.resolve();
    await Promise.resolve();
    expect(getSnapshot().status).toBe('error');
    expect(calls).toHaveLength(1);
  });

  it('a cancel during the retry wait stops the retry', async () => {
    vi.useFakeTimers();
    const calls = pullCalls();
    startPull('m');
    cancelPull();
    startPull('m');
    calls[1].reject(Object.assign(new Error('busy'), { code: 'pull_in_progress', status: 409 }));
    await vi.advanceTimersByTimeAsync(0);
    cancelPull();
    await vi.advanceTimersByTimeAsync(RESTART_RETRY_DELAY_MS * 2);
    expect(calls).toHaveLength(2);
    expect(getSnapshot().status).toBe('cancelled');
  });

  it('keeps completed and total from going backwards while downloading', () => {
    const calls = pullCalls();
    startPull('m');
    calls[0].onProgress({ phase: 'downloading', completed: 60, total: 100 });
    calls[0].onProgress({ phase: 'downloading', completed: 60, total: 200 });
    expect(getSnapshot()).toMatchObject({ completed: 60, total: 100 });
    calls[0].onProgress({ phase: 'downloading', completed: 150, total: 200 });
    expect(getSnapshot()).toMatchObject({ completed: 150, total: 200 });
  });

  it('marks the download as syncing until onFinished settles, and flags a failed sync', async () => {
    const calls = pullCalls();
    let fail;
    startPull('m', { onFinished: () => new Promise((_resolve, reject) => (fail = reject)) });
    calls[0].resolve();
    await vi.waitFor(() => expect(getSnapshot()).toMatchObject({ status: 'done', syncing: true }));
    resetPull();
    expect(getSnapshot().status).toBe('done');
    startPull('m');
    expect(calls).toHaveLength(1);
    fail(new Error('refetch failed'));
    await vi.waitFor(() =>
      expect(getSnapshot()).toMatchObject({ status: 'done', syncing: false, syncFailed: true }),
    );
    resetPull();
    expect(getSnapshot().status).toBe('idle');
  });

  it('Cancel aborts the request', () => {
    const calls = pullCalls();
    startPull('m');
    cancelPull();
    expect(calls[0].signal.aborted).toBe(true);
  });
});
