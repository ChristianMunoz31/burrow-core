// resolveGitCommit / getCommit: graceful failure, normalization, caching.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCommit, resetCommitForTests, resolveGitCommit } from '../runtime.js';

const SHA40 = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

afterEach(() => {
  resetCommitForTests();
  vi.doUnmock('node:child_process');
  vi.resetModules();
});

describe('resolveGitCommit', () => {
  it('returns a 7 char sha for a short sha with trailing newline', () => {
    expect(resolveGitCommit({ exec: () => 'abc1234\n' })).toBe('abc1234');
  });

  it('truncates a valid long sha to 7 chars', () => {
    expect(resolveGitCommit({ exec: () => `${SHA40}\n` })).toBe('a1b2c3d');
  });

  it('asks git for the head sha in the given cwd', () => {
    const exec = vi.fn(() => 'abc1234');
    resolveGitCommit({ exec, cwd: 'C:\\somewhere' });
    expect(exec).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = exec.mock.calls[0];
    expect(cmd).toBe('git');
    expect(args).toEqual(expect.arrayContaining(['rev-parse', 'HEAD']));
    expect(opts.cwd).toBe('C:\\somewhere');
  });

  it('returns null when git is not installed (ENOENT)', () => {
    const exec = () => {
      throw Object.assign(new Error('spawnSync git ENOENT'), { code: 'ENOENT' });
    };
    expect(resolveGitCommit({ exec })).toBeNull();
  });

  it('returns null on a timeout', () => {
    const exec = () => {
      throw Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' });
    };
    expect(resolveGitCommit({ exec })).toBeNull();
  });

  it('returns null when git exits non-zero (not a repo)', () => {
    const exec = () => {
      throw Object.assign(new Error('Command failed'), { status: 128 });
    };
    expect(resolveGitCommit({ exec })).toBeNull();
  });

  it.each([
    ['empty', ''],
    ['whitespace', '  \n'],
    ['garbage text', 'fatal: not a git repository'],
    ['too short', 'abc12'],
    ['uppercase hex', 'ABCDEF1'],
    ['non-hex', 'zzzzzzz'],
    ['multi-line', 'abc1234\ndef5678'],
    ['undefined', undefined],
    ['null', null],
    ['an object', {}],
  ])('returns null for %s output', (_name, out) => {
    expect(resolveGitCommit({ exec: () => out })).toBeNull();
  });

  it('never throws, even when exec throws a non-Error', () => {
    const exec = () => {
      throw 'boom';
    };
    expect(() => resolveGitCommit({ exec })).not.toThrow();
  });

  it('resolves against the real repo without throwing (7 hex chars or null)', () => {
    const sha = resolveGitCommit();
    expect(sha === null || /^[0-9a-f]{7}$/.test(sha)).toBe(true);
  });
});

describe('getCommit', () => {
  it('is null or exactly 7 hex chars and stable across calls', () => {
    const first = getCommit();
    expect(first === null || /^[0-9a-f]{7}$/.test(first)).toBe(true);
    expect(getCommit()).toBe(first);
  });

  it('caches the resolved value until reset', async () => {
    vi.resetModules();
    const exec = vi.fn(() => `${SHA40}\n`);
    vi.doMock('node:child_process', () => ({ execFileSync: exec }));
    const rt = await import('../runtime.js');
    expect(rt.getCommit()).toBe('a1b2c3d');
    expect(rt.getCommit()).toBe('a1b2c3d');
    expect(exec).toHaveBeenCalledTimes(1);
    rt.resetCommitForTests();
    rt.getCommit();
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('caches a null result too (a git failure is not retried)', async () => {
    vi.resetModules();
    const exec = vi.fn(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    vi.doMock('node:child_process', () => ({ execFileSync: exec }));
    const rt = await import('../runtime.js');
    expect(rt.getCommit()).toBeNull();
    expect(rt.getCommit()).toBeNull();
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
