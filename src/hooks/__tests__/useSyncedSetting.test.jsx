import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSyncedSetting } from '../useSyncedSetting';
import { isDirty, markDirty } from '../../utils/syncMode';

vi.mock('../../services/stateService', () => ({
  stateService: { get: vi.fn(), put: vi.fn() },
}));

import { stateService } from '../../services/stateService';
import { lsKey } from '../../utils/storageKeys';

const KEY = 'test:setting';

beforeEach(() => {
  localStorage.clear();
  stateService.get.mockReset();
  stateService.put.mockReset();
  stateService.put.mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function setup(fallback = 'fb') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useSyncedSetting(KEY, fallback), { wrapper });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useSyncedSetting fetch', () => {
  it('writes the remote value to localStorage', async () => {
    stateService.get.mockResolvedValue('remote');
    const { result } = setup();
    await waitFor(() => expect(result.current[0]).toBe('remote'));
    expect(JSON.parse(localStorage.getItem(lsKey(KEY)))).toBe('remote');
    expect(stateService.put).not.toHaveBeenCalled();
  });

  it('returns the fallback when neither server nor local has a value', async () => {
    stateService.get.mockResolvedValue(undefined);
    const { result } = setup('fb');
    await waitFor(() => expect(result.current[2].isFetched).toBe(true));
    expect(result.current[0]).toBe('fb');
    expect(stateService.put).not.toHaveBeenCalled();
  });

  it('migrates a local-only value up when the server has no row', async () => {
    localStorage.setItem(lsKey(KEY), JSON.stringify('local'));
    stateService.get.mockResolvedValue(undefined);
    const { result } = setup();
    await waitFor(() => expect(stateService.put).toHaveBeenCalledWith(KEY, 'local'));
    await waitFor(() => expect(result.current[2].isFetched).toBe(true));
    expect(result.current[0]).toBe('local');
  });

  it('also treats a null server value as no row and migrates the local value', async () => {
    localStorage.setItem(lsKey(KEY), JSON.stringify('local'));
    stateService.get.mockResolvedValue(null);
    setup();
    await waitFor(() => expect(stateService.put).toHaveBeenCalledWith(KEY, 'local'));
  });

  it('a failing migration put does not surface as an error', async () => {
    localStorage.setItem(lsKey(KEY), JSON.stringify('local'));
    stateService.get.mockResolvedValue(undefined);
    stateService.put.mockRejectedValue(new Error('offline'));
    const { result } = setup();
    await waitFor(() => expect(result.current[2].isFetched).toBe(true));
    expect(result.current[0]).toBe('local');
  });

  it('server value wins over a differing local cache', async () => {
    localStorage.setItem(lsKey(KEY), JSON.stringify('stale'));
    stateService.get.mockResolvedValue('fresh');
    const { result } = setup();
    expect(result.current[0]).toBe('stale');
    await waitFor(() => expect(result.current[0]).toBe('fresh'));
    expect(JSON.parse(localStorage.getItem(lsKey(KEY)))).toBe('fresh');
  });
});

describe('useSyncedSetting set()', () => {
  it('applies locally, persists to localStorage and puts to the server', async () => {
    stateService.get.mockResolvedValue('remote');
    const { result } = setup();
    await waitFor(() => expect(result.current[2].isFetched).toBe(true));
    let returned;
    act(() => {
      returned = result.current[1]('next');
    });
    expect(returned).toBe('next');
    await waitFor(() => expect(result.current[0]).toBe('next'));
    expect(JSON.parse(localStorage.getItem(lsKey(KEY)))).toBe('next');
    expect(stateService.put).toHaveBeenCalledWith(KEY, 'next');
  });

  it('accepts an updater function receiving the current value', async () => {
    stateService.get.mockResolvedValue('a');
    const { result } = setup();
    await waitFor(() => expect(result.current[0]).toBe('a'));
    act(() => {
      result.current[1]((prev) => prev + 'b');
    });
    await waitFor(() => expect(result.current[0]).toBe('ab'));
  });

  it('an in-flight fetch resolving later does not overwrite a newer set()', async () => {
    const d = deferred();
    stateService.get.mockReturnValue(d.promise);
    const { result } = setup('fb');

    act(() => {
      result.current[1]('light');
    });
    await waitFor(() => expect(result.current[0]).toBe('light'));

    await act(async () => {
      d.resolve('dark');
      await d.promise;
    });
    // Give react-query a few ticks to (wrongly) apply the stale result.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(result.current[0]).toBe('light');
  });

  // Cancelling does not abort the running queryFn; its late result must not
  // clobber the localStorage cache either.
  it('stale fetch must not overwrite the localStorage cache after set()', async () => {
    const d = deferred();
    stateService.get.mockReturnValue(d.promise);
    const { result } = setup('fb');
    act(() => {
      result.current[1]('light');
    });
    await waitFor(() => expect(result.current[0]).toBe('light'));
    await act(async () => {
      d.resolve('dark');
      await d.promise;
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(JSON.parse(localStorage.getItem(lsKey(KEY)))).toBe('light');
  });

  it('calls onError when the server put rejects, and keeps the local value', async () => {
    stateService.get.mockResolvedValue('remote');
    const err = new Error('boom');
    stateService.put.mockRejectedValue(err);
    const onError = vi.fn();
    const { result } = setup();
    await waitFor(() => expect(result.current[2].isFetched).toBe(true));
    await act(async () => {
      result.current[1]('next', { onError });
    });
    await waitFor(() => expect(onError).toHaveBeenCalledWith(err));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(result.current[0]).toBe('next');
    expect(JSON.parse(localStorage.getItem(lsKey(KEY)))).toBe('next');
  });

  it('does not call onError when the put succeeds', async () => {
    stateService.get.mockResolvedValue('remote');
    const onError = vi.fn();
    const { result } = setup();
    await waitFor(() => expect(result.current[2].isFetched).toBe(true));
    await act(async () => {
      result.current[1]('next', { onError });
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it('tolerates a rejecting put with no onError supplied', async () => {
    stateService.get.mockResolvedValue('remote');
    stateService.put.mockRejectedValue(new Error('x'));
    const { result } = setup();
    await waitFor(() => expect(result.current[2].isFetched).toBe(true));
    await act(async () => {
      expect(() => result.current[1]('next')).not.toThrow();
    });
    await waitFor(() => expect(result.current[0]).toBe('next'));
  });
});

describe('useSyncedSetting local-dirty handling', () => {
  it('no dirty keys: GET on mount, PUT on set, migration as before', async () => {
    stateService.get.mockResolvedValue(undefined);
    localStorage.setItem(lsKey(KEY), JSON.stringify('local'));
    const { result } = setup();
    await waitFor(() => expect(stateService.put).toHaveBeenCalledWith(KEY, 'local'));
    expect(stateService.get).toHaveBeenCalledWith(KEY);
    await act(async () => {
      result.current[1]('next');
    });
    expect(stateService.put).toHaveBeenCalledWith(KEY, 'next');
    expect(isDirty(KEY)).toBe(false);
  });

  it('a PUT failure does not mark the key dirty', async () => {
    stateService.get.mockResolvedValue('remote');
    stateService.put.mockRejectedValue(new Error('offline'));
    const onError = vi.fn();
    const { result } = setup();
    await waitFor(() => expect(result.current[2].isFetched).toBe(true));
    await act(async () => {
      result.current[1]('next', { onError });
    });
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(isDirty(KEY)).toBe(false);
  });

  it('a dirty key returns local and ignores the remote value', async () => {
    markDirty(KEY);
    localStorage.setItem(lsKey(KEY), JSON.stringify('local'));
    stateService.get.mockResolvedValue('remote');
    const { result } = setup();
    await waitFor(() => expect(result.current[2].isFetched).toBe(true));
    expect(result.current[0]).toBe('local');
    expect(JSON.parse(localStorage.getItem(lsKey(KEY)))).toBe('local');
    expect(stateService.get).not.toHaveBeenCalled();
  });
});

describe('useSyncedSetting hardening', () => {
  it('queryFn re-checks after the GET: markDirty while deferred -> remote not written', async () => {
    const d = deferred();
    stateService.get.mockReturnValue(d.promise);
    localStorage.setItem(lsKey(KEY), JSON.stringify('local'));
    const { result } = setup();
    await waitFor(() => expect(stateService.get).toHaveBeenCalled());
    markDirty(KEY);
    await act(async () => {
      d.resolve('remote');
      await d.promise;
    });
    await waitFor(() => expect(result.current[2].isFetched).toBe(true));
    expect(JSON.parse(localStorage.getItem(lsKey(KEY)))).toBe('local');
    expect(result.current[0]).toBe('local');
    expect(stateService.put).not.toHaveBeenCalled();
  });

  it('set on a dirty key clears the flag once the PUT lands', async () => {
    markDirty(KEY);
    localStorage.setItem(lsKey(KEY), JSON.stringify('old'));
    const { result } = setup();
    await waitFor(() => expect(result.current[2].isFetched).toBe(true));
    await act(async () => {
      result.current[1]('next');
    });
    await waitFor(() => expect(isDirty(KEY)).toBe(false));
    expect(stateService.put).toHaveBeenCalledWith(KEY, 'next');
  });

  it('keeps the dirty flag when the value changed again before the PUT resolved', async () => {
    markDirty(KEY);
    const d = deferred();
    stateService.put.mockReturnValue(d.promise);
    const { result } = setup();
    await waitFor(() => expect(result.current[2].isFetched).toBe(true));
    await act(async () => {
      result.current[1]('first');
    });
    localStorage.setItem(lsKey(KEY), JSON.stringify('second'));
    await act(async () => {
      d.resolve({});
      await d.promise;
    });
    expect(isDirty(KEY)).toBe(true);
  });

});
