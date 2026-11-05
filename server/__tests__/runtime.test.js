// Packaging seams: envDir, isDesktopMode, getAppVersion.
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { envDir, getAppVersion, isDesktopMode } from '../runtime.js';

describe('envDir', () => {
  it('returns undefined when unset or blank', () => {
    expect(envDir('BURROW_DIST_DIR', {})).toBeUndefined();
    expect(envDir('BURROW_DIST_DIR', { BURROW_DIST_DIR: '   ' })).toBeUndefined();
  });

  it('resolves a set value to an absolute path', () => {
    const rel = envDir('BURROW_DIST_DIR', { BURROW_DIST_DIR: ' some/dist ' });
    expect(path.isAbsolute(rel)).toBe(true);
    expect(rel).toBe(path.resolve('some/dist'));
  });
});

describe('isDesktopMode', () => {
  it('is on only for BURROW_DESKTOP=1', () => {
    expect(isDesktopMode({ BURROW_DESKTOP: '1' })).toBe(true);
    for (const v of [undefined, '', '0', 'true', ' 1']) expect(isDesktopMode({ BURROW_DESKTOP: v })).toBe(false);
    expect(isDesktopMode({})).toBe(false);
  });
});

describe('getAppVersion', () => {
  it('falls back to the package.json version when no version was bundled', () => {
    expect(getAppVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
