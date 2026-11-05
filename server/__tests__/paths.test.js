// getDataDir: per-OS defaults and the BURROW_DATA_DIR override, with platform/env injected.
import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { dataFolderName, getDataDir, resolveDataDir, resolveStableDataDir } from '../paths.js';

describe('resolveDataDir', () => {
  it('uses %APPDATA%\\Burrow on win32', () => {
    expect(
      resolveDataDir({ platform: 'win32', env: { APPDATA: 'C:\\Users\\sam\\AppData\\Roaming' }, home: 'C:\\Users\\sam' }),
    ).toBe('C:\\Users\\sam\\AppData\\Roaming\\Burrow');
  });

  it('falls back to ~\\AppData\\Roaming on win32 without APPDATA', () => {
    expect(resolveDataDir({ platform: 'win32', env: {}, home: 'C:\\Users\\sam' })).toBe(
      'C:\\Users\\sam\\AppData\\Roaming\\Burrow',
    );
  });

  it('uses $XDG_DATA_HOME/burrow on linux when set', () => {
    expect(resolveDataDir({ platform: 'linux', env: { XDG_DATA_HOME: '/data/xdg' }, home: '/home/sam' })).toBe(
      '/data/xdg/burrow',
    );
  });

  it('uses ~/.local/share/burrow on linux otherwise', () => {
    expect(resolveDataDir({ platform: 'linux', env: {}, home: '/home/sam' })).toBe('/home/sam/.local/share/burrow');
  });

  it('uses ~/Library/Application Support/Burrow on darwin', () => {
    expect(resolveDataDir({ platform: 'darwin', env: {}, home: '/Users/sam' })).toBe(
      '/Users/sam/Library/Application Support/Burrow',
    );
  });

  it('lets BURROW_DATA_DIR win on every platform', () => {
    for (const platform of ['win32', 'linux', 'darwin']) {
      expect(resolveDataDir({ platform, env: { BURROW_DATA_DIR: 'custom-dir', APPDATA: 'x' }, home: '/h' })).toBe(
        path.resolve('custom-dir'),
      );
    }
  });
});

describe('getDataDir', () => {
  it('creates the directory recursively and returns it', () => {
    const mkdir = vi.fn();
    const dir = getDataDir({ platform: 'linux', env: {}, home: '/home/sam', mkdir });
    expect(dir).toBe('/home/sam/.local/share/burrow');
    expect(mkdir).toHaveBeenCalledWith('/home/sam/.local/share/burrow', { recursive: true, mode: 0o700 });
  });
});

describe('dev channel data dir', () => {
  it('uses Burrow Dev on win32 and darwin, burrow-dev on linux', () => {
    expect(resolveDataDir({ platform: 'win32', env: { APPDATA: 'C:\\A' }, home: 'C:\\h', channel: 'dev' })).toBe(
      'C:\\A\\Burrow Dev',
    );
    expect(resolveDataDir({ platform: 'darwin', env: {}, home: '/Users/sam', channel: 'dev' })).toBe(
      '/Users/sam/Library/Application Support/Burrow Dev',
    );
    expect(resolveDataDir({ platform: 'linux', env: { XDG_DATA_HOME: '/x' }, home: '/h', channel: 'dev' })).toBe(
      '/x/burrow-dev',
    );
    expect(resolveDataDir({ platform: 'linux', env: {}, home: '/h', channel: 'dev' })).toBe(
      '/h/.local/share/burrow-dev',
    );
  });

  it('takes the channel from BURROW_CHANNEL when not passed, and stable otherwise', () => {
    expect(resolveDataDir({ platform: 'linux', env: { BURROW_CHANNEL: 'dev' }, home: '/h' })).toBe(
      '/h/.local/share/burrow-dev',
    );
    expect(resolveDataDir({ platform: 'linux', env: { BURROW_CHANNEL: 'nope' }, home: '/h' })).toBe(
      '/h/.local/share/burrow',
    );
  });

  it('still lets BURROW_DATA_DIR win in the dev channel', () => {
    expect(
      resolveDataDir({ platform: 'win32', env: { BURROW_DATA_DIR: 'custom-dir' }, home: '/h', channel: 'dev' }),
    ).toBe(path.resolve('custom-dir'));
  });

  it('dataFolderName per platform', () => {
    expect(dataFolderName('stable', 'win32')).toBe('Burrow');
    expect(dataFolderName('dev', 'darwin')).toBe('Burrow Dev');
    expect(dataFolderName('stable', 'linux')).toBe('burrow');
    expect(dataFolderName('dev', 'linux')).toBe('burrow-dev');
  });
});

describe('resolveStableDataDir', () => {
  it('ignores BURROW_DATA_DIR and the channel: it is always the stable default', () => {
    expect(
      resolveStableDataDir({
        platform: 'win32',
        env: { APPDATA: 'C:\\A', BURROW_DATA_DIR: 'elsewhere', BURROW_CHANNEL: 'dev' },
        home: 'C:\\h',
      }),
    ).toEqual({ dir: 'C:\\A\\Burrow', overridden: false });
    expect(resolveStableDataDir({ platform: 'linux', env: {}, home: '/h' })).toEqual({
      dir: '/h/.local/share/burrow',
      overridden: false,
    });
  });

  it('honours BURROW_STABLE_DATA_DIR (trimmed, resolved) and flags it', () => {
    expect(
      resolveStableDataDir({ platform: 'linux', env: { BURROW_STABLE_DATA_DIR: '  fake-stable  ' }, home: '/h' }),
    ).toEqual({ dir: path.resolve('fake-stable'), overridden: true });
    expect(
      resolveStableDataDir({ platform: 'linux', env: { BURROW_STABLE_DATA_DIR: '   ' }, home: '/h' }).overridden,
    ).toBe(false);
  });
});
