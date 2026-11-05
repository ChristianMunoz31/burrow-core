import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeLegacyStorage } from '../legacyCleanup';
import { lsKey } from '../storageKeys';

const VERSION = lsKey('legacyCleanup.version');
const V1 = ['agents.runs', 'builder.theme', 'builder.custombase', 'survey-builder', 'storage:syncMode', 'settings', 'focus'];
const V2 = ['gpts', 'conv-index', 'pos:gpts', 'conv:a1', 'conv:b2', 'conv:c3'];

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('removeLegacyStorage', () => {
  it('removes retired v1 and v2 keys and keeps everything else', () => {
    for (const k of [...V1, ...V2]) localStorage.setItem(lsKey(k), 'x');
    localStorage.setItem(lsKey('theme'), '"dark"');
    localStorage.setItem(lsKey('storage:pendingSync'), '["theme"]');
    localStorage.setItem(lsKey('javi.showButton'), 'true');
    localStorage.setItem(lsKey('convert:x'), 'keep');
    localStorage.setItem('other.conv:zz', 'keep');
    removeLegacyStorage();
    expect(Object.keys(localStorage).sort()).toEqual(
      [lsKey('theme'), lsKey('storage:pendingSync'), lsKey('javi.showButton'), lsKey('convert:x'), 'other.conv:zz', VERSION].sort(),
    );
    expect(localStorage.getItem(lsKey('theme'))).toBe('"dark"');
  });

  it('stores the completed version and does nothing on a second call', () => {
    removeLegacyStorage();
    expect(localStorage.getItem(VERSION)).toBe('2');
    localStorage.setItem(lsKey('gpts'), 'back');
    localStorage.setItem(lsKey('conv:zz'), 'back');
    removeLegacyStorage();
    expect(localStorage.getItem(lsKey('gpts'))).toBe('back');
    expect(localStorage.getItem(lsKey('conv:zz'))).toBe('back');
  });

  it('runs again when only an older version was recorded', () => {
    localStorage.setItem(VERSION, '1');
    localStorage.setItem(lsKey('conv:a'), 'x');
    removeLegacyStorage();
    expect(localStorage.getItem(lsKey('conv:a'))).toBeNull();
    expect(localStorage.getItem(VERSION)).toBe('2');
  });

  it('does not throw when removal fails', () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('denied');
    });
    localStorage.setItem(lsKey('conv:a'), 'x');
    expect(() => removeLegacyStorage()).not.toThrow();
  });

  it('does not throw when storage is unavailable entirely', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'key').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(() => removeLegacyStorage()).not.toThrow();
  });
});
