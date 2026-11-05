import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearDirty,
  flushPendingSync,
  getPendingKeys,
  isDirty,
  markDirty,
  writeLocal,
} from '../syncMode';
import { lsKey } from '../storageKeys';

vi.mock('../../services/stateService', () => ({
  stateService: { get: vi.fn(), put: vi.fn() },
}));

function makeClient() {
  return { invalidateQueries: vi.fn() };
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe('pending keys', () => {
  it('dedupes, clears and reports dirtiness; invalid JSON is empty', () => {
    markDirty('a');
    markDirty('a');
    markDirty('b');
    expect(getPendingKeys()).toEqual(['a', 'b']);
    expect(isDirty('a')).toBe(true);
    clearDirty('a');
    expect(isDirty('a')).toBe(false);
    localStorage.setItem(lsKey('storage:pendingSync'), '{nope');
    expect(getPendingKeys()).toEqual([]);
  });
});

describe('flushPendingSync', () => {
  it('pushes the latest local value (local wins) and clears dirty keys', async () => {
    localStorage.setItem(lsKey('a'), JSON.stringify('A'));
    localStorage.setItem(lsKey('b'), 'rawlegacy');
    markDirty('a');
    markDirty('b');
    const put = vi.fn().mockResolvedValue({});
    const client = makeClient();
    const result = await flushPendingSync(client, { put });
    expect(result).toEqual({ pushed: 2, failed: 0 });
    expect(put).toHaveBeenCalledWith('a', 'A');
    expect(put).toHaveBeenCalledWith('b', 'rawlegacy');
    expect(getPendingKeys()).toEqual([]);
    expect(client.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['state'] });
  });

  it('a dirty key with no local value is cleared without any PUT (never PUT null)', async () => {
    markDirty('gone');
    const put = vi.fn().mockResolvedValue({});
    const result = await flushPendingSync(makeClient(), { put });
    expect(put).not.toHaveBeenCalled();
    expect(result).toEqual({ pushed: 0, failed: 0 });
    expect(isDirty('gone')).toBe(false);
  });

  it('survives localStorage.getItem throwing for a key (counts failed, stays dirty)', async () => {
    markDirty('a');
    const original = Storage.prototype.getItem;
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (k) {
      if (k === lsKey('a')) throw new Error('denied');
      return original.call(this, k);
    });
    try {
      const put = vi.fn().mockResolvedValue({});
      const result = await flushPendingSync(makeClient(), { put });
      expect(result).toEqual({ pushed: 0, failed: 1 });
      expect(put).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(isDirty('a')).toBe(true);
  });

  it('partial failure keeps the failed key dirty and still invalidates', async () => {
    localStorage.setItem(lsKey('a'), JSON.stringify(1));
    localStorage.setItem(lsKey('b'), JSON.stringify(2));
    markDirty('a');
    markDirty('b');
    const put = vi.fn(async (key) => {
      if (key === 'b') throw new Error('offline');
      return {};
    });
    const client = makeClient();
    const result = await flushPendingSync(client, { put });
    expect(result).toEqual({ pushed: 1, failed: 1 });
    expect(getPendingKeys()).toEqual(['b']);
    expect(client.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['state'] });
  });

  it('concurrent calls share one run (one PUT per key)', async () => {
    localStorage.setItem(lsKey('a'), JSON.stringify(1));
    markDirty('a');
    const d = deferred();
    const put = vi.fn(() => d.promise);
    const client = makeClient();
    const p1 = flushPendingSync(client, { put });
    const p2 = flushPendingSync(client, { put });
    expect(p1).toBe(p2);
    d.resolve({});
    expect(await p1).toEqual({ pushed: 1, failed: 0 });
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('re-PUTs when the local value changes during the PUT', async () => {
    localStorage.setItem(lsKey('a'), JSON.stringify('v1'));
    markDirty('a');
    const put = vi.fn(async (key, value) => {
      if (value === 'v1') localStorage.setItem(lsKey('a'), JSON.stringify('v2'));
      return {};
    });
    const result = await flushPendingSync(makeClient(), { put });
    expect(put.mock.calls.map((c) => c[1])).toEqual(['v1', 'v2']);
    expect(result).toEqual({ pushed: 1, failed: 0 });
    expect(isDirty('a')).toBe(false);
  });

  it('gives up as failed after 3 changing attempts', async () => {
    localStorage.setItem(lsKey('a'), JSON.stringify(0));
    markDirty('a');
    let n = 0;
    const put = vi.fn(async () => {
      n += 1;
      localStorage.setItem(lsKey('a'), JSON.stringify(n));
      return {};
    });
    const result = await flushPendingSync(makeClient(), { put });
    expect(put).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ pushed: 0, failed: 1 });
    expect(isDirty('a')).toBe(true);
  });

});

describe('flush edge cases', () => {
  it('a coalesced flush picks up keys dirtied after the snapshot and shares final totals', async () => {
    localStorage.setItem(lsKey('a'), JSON.stringify(1));
    localStorage.setItem(lsKey('b'), JSON.stringify(2));
    markDirty('a');
    const d = deferred();
    const put = vi.fn(async (key) => {
      if (key === 'a') await d.promise;
      return {};
    });
    const client = makeClient();
    const p1 = flushPendingSync(client, { put });
    markDirty('b'); // dirtied after the first snapshot
    const p2 = flushPendingSync(client, { put });
    d.resolve();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual({ pushed: 2, failed: 0 });
    expect(r2).toEqual(r1);
    expect(put.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
    expect(getPendingKeys()).toEqual([]);
  });

  it('extra passes are bounded and never retry an already attempted failed key', async () => {
    localStorage.setItem(lsKey('a'), JSON.stringify(1));
    markDirty('a');
    const put = vi.fn(async () => {
      throw new Error('offline');
    });
    const result = await flushPendingSync(makeClient(), { put });
    expect(put).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ pushed: 0, failed: 1 });
  });
});

describe('writeLocal', () => {
  it('writeLocal reports success and failure', () => {
    expect(writeLocal('a', 1)).toBe(true);
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    try {
      expect(writeLocal('a', 2)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
