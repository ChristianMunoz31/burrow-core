import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FOUNDER_PERK_KEY, readFounderPerkCache, writeFounderPerkCache } from '../founderPerkCache';
import { lsKey } from '../storageKeys';

const KEY = 'burrow.license:founderPerk';

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('founderPerkCache', () => {
  it('uses the physical key index.html reads', () => {
    expect(lsKey(FOUNDER_PERK_KEY)).toBe(KEY);
  });

  it('reads false when nothing is stored', () => {
    expect(readFounderPerkCache()).toBe(false);
  });

  it('reads true only for the exact string "1"', () => {
    localStorage.setItem(KEY, '1');
    expect(readFounderPerkCache()).toBe(true);
    for (const v of ['0', 'true', '', '"1"', ' 1']) {
      localStorage.setItem(KEY, v);
      expect(readFounderPerkCache()).toBe(false);
    }
  });

  it('writes "1" for true and removes the key for false', () => {
    writeFounderPerkCache(true);
    expect(localStorage.getItem(KEY)).toBe('1');
    expect(readFounderPerkCache()).toBe(true);
    writeFounderPerkCache(false);
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(readFounderPerkCache()).toBe(false);
  });

  it('writing false when absent is a no-op', () => {
    expect(() => writeFounderPerkCache(false)).not.toThrow();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('does not touch other keys', () => {
    localStorage.setItem(lsKey('theme'), '"dark"');
    writeFounderPerkCache(true);
    writeFounderPerkCache(false);
    expect(localStorage.getItem(lsKey('theme'))).toBe('"dark"');
  });

  it('swallows storage errors on read and write', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(readFounderPerkCache()).toBe(false);
    expect(() => writeFounderPerkCache(true)).not.toThrow();
    expect(() => writeFounderPerkCache(false)).not.toThrow();
  });
});
