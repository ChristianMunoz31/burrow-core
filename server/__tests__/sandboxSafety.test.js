import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PREVIEW_ROOT,
  RESERVED_PORTS,
  SANDBOX_ROOT,
  SandboxSafetyError,
  assertSafeDataDir,
  assertSafePort,
  assertUnderTmp,
  buildChildEnv,
  freePort,
  realDefaultDataDir,
  realDefaultDataDirs,
  resolveNpmCli,
  samePath,
  sandboxHomeFor,
} from '../../scripts/lib/sandboxSafety.js';

const CASES = [
  {
    platform: 'win32',
    home: 'C:\\Users\\tester',
    env: { APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' },
    real: 'C:\\Users\\tester\\AppData\\Roaming\\Burrow',
    tmpdir: 'C:\\Users\\tester\\AppData\\Local\\Temp',
  },
  {
    platform: 'darwin',
    home: '/Users/tester',
    env: {},
    real: '/Users/tester/Library/Application Support/Burrow',
    tmpdir: '/var/folders/zz/T',
  },
  {
    platform: 'linux',
    home: '/home/tester',
    env: {},
    real: '/home/tester/.local/share/burrow',
    tmpdir: '/tmp',
  },
];

describe('realDefaultDataDir', () => {
  it.each(CASES)('ignores BURROW_DATA_DIR on $platform', ({ platform, home, env, real }) => {
    expect(realDefaultDataDir({ platform, home, env: { ...env, BURROW_DATA_DIR: '/somewhere/else' } })).toBe(real);
  });
});

describe('assertSafeDataDir', () => {
  describe.each(CASES)('$platform', ({ platform, home, env, real, tmpdir }) => {
    const opts = { platform, home, env, tmpdir };
    const mod = platform === 'win32' ? path.win32 : path.posix;

    it('rejects the real default dir', () => {
      expect(() => assertSafeDataDir(real, opts)).toThrow(SandboxSafetyError);
    });

    it('rejects a dir nested inside the real default', () => {
      expect(() => assertSafeDataDir(mod.join(real, 'sandbox'), opts)).toThrow(/real Burrow data/);
    });

    it('rejects a parent of the real default', () => {
      expect(() => assertSafeDataDir(mod.dirname(real), opts)).toThrow(SandboxSafetyError);
      expect(() => assertSafeDataDir(home, opts)).toThrow(SandboxSafetyError);
    });

    it('rejects a dir outside the temp dir', () => {
      expect(() => assertSafeDataDir(mod.join(home, 'Desktop', 'demo'), opts)).toThrow(/temp/);
    });

    it('rejects the temp dir itself and traversal out of it', () => {
      expect(() => assertSafeDataDir(tmpdir, opts)).toThrow(SandboxSafetyError);
      expect(() => assertSafeDataDir(mod.join(tmpdir, 'x', '..', '..', 'elsewhere'), opts)).toThrow(SandboxSafetyError);
    });

    it('accepts a dir inside the temp dir', () => {
      const dir = mod.join(tmpdir, 'burrow-sandbox', 'demo');
      expect(assertSafeDataDir(dir, opts)).toBe(mod.resolve(dir));
    });
  });

  it('rejects the real dir case-insensitively on win32', () => {
    const c = CASES[0];
    expect(() =>
      assertSafeDataDir(c.real.toUpperCase(), { platform: 'win32', home: c.home, env: c.env, tmpdir: c.real }),
    ).toThrow(SandboxSafetyError);
  });

  it('rejects an empty value', () => {
    expect(() => assertSafeDataDir('')).toThrow(SandboxSafetyError);
  });

  it('accepts sandbox children on this machine and rejects the real dir here', () => {
    expect(() => assertSafeDataDir(path.join(SANDBOX_ROOT, 'default'))).not.toThrow();
    expect(() => assertSafeDataDir(realDefaultDataDir())).toThrow(SandboxSafetyError);
  });
});

describe('assertSafePort', () => {
  it.each(RESERVED_PORTS)('rejects live dev port %i', (port) => {
    expect(() => assertSafePort(port)).toThrow(/live dev servers/);
    expect(() => assertSafePort(String(port))).toThrow(SandboxSafetyError);
  });

  it.each([80, 1023, 65536, 3.5, 'abc', '', null, undefined, -1])('rejects %s', (port) => {
    expect(() => assertSafePort(port)).toThrow(SandboxSafetyError);
  });

  it('accepts a normal port and numeric strings', () => {
    expect(assertSafePort(47123)).toBe(47123);
    expect(assertSafePort('47123')).toBe(47123);
  });
});

describe('freePort and roots', () => {
  it('returns a usable, non-reserved port', async () => {
    const port = await freePort();
    expect(() => assertSafePort(port)).not.toThrow();
  });

  it('keeps the sandbox and preview roots under the temp dir', () => {
    expect(() => assertUnderTmp(SANDBOX_ROOT)).not.toThrow();
    expect(() => assertUnderTmp(PREVIEW_ROOT)).not.toThrow();
    expect(() => assertUnderTmp(os.homedir())).toThrow(SandboxSafetyError);
  });
});

describe('buildChildEnv', () => {
  const source = {
    Path: 'C:\\bin',
    SystemRoot: 'C:\\Windows',
    TEMP: 'C:\\t',
    GITHUB_TOKEN: 'ghp_x',
    OLLAMA_HOST: 'http://lan:11434',
    OPENAI_API_KEY: 'sk-x',
    NODE_OPTIONS: '--require evil.js',
    BURROW_DATA_DIR: 'C:\\real',
    APPDATA: 'C:\\real\\Roaming',
  };

  it('keeps only allowlisted system vars (case-insensitive on win32) plus explicit extras', () => {
    const env = buildChildEnv({ source, platform: 'win32', extra: { BURROW_PORT: '47001' } });
    expect(env).toEqual({ Path: 'C:\\bin', SystemRoot: 'C:\\Windows', TEMP: 'C:\\t', BURROW_PORT: '47001' });
  });

  it('is case-sensitive on posix', () => {
    expect(buildChildEnv({ source: { PATH: '/bin', path: '/evil', TOKEN: 'x' }, platform: 'linux' })).toEqual({ PATH: '/bin' });
  });

  it('redirects every per-user location into the fake home', () => {
    const home = sandboxHomeFor(path.join(SANDBOX_ROOT, 'envtest'));
    const env = buildChildEnv({ source, homeDir: home });
    for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_DATA_HOME']) {
      expect(env[key].startsWith(home), key).toBe(true);
    }
    expect(env).not.toHaveProperty('GITHUB_TOKEN');
    expect(env).not.toHaveProperty('NODE_OPTIONS');
    expect(env).not.toHaveProperty('OLLAMA_HOST');
  });
});

describe('resolveNpmCli', () => {
  it('prefers npm_execpath when it is npm-cli.js', () => {
    const cli = '/x/npm/bin/npm-cli.js';
    expect(resolveNpmCli({ env: { npm_execpath: cli }, platform: 'linux', exists: () => true })).toBe(cli);
  });

  it('ignores npm_execpath that is not npm-cli.js and uses the copy next to node', () => {
    const win = resolveNpmCli({
      env: { npm_execpath: 'C:\\evil\\npm.cmd' },
      execPath: 'C:\\node\\node.exe',
      platform: 'win32',
      exists: () => true,
    });
    expect(win).toBe(path.win32.join('C:\\node', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    const posix = resolveNpmCli({ env: {}, execPath: '/opt/node/bin/node', platform: 'linux', exists: () => true });
    expect(posix).toBe(path.posix.join('/opt/node/bin', '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  });

  it('fails clearly when npm-cli.js is not found', () => {
    expect(() => resolveNpmCli({ env: {}, execPath: '/opt/node/bin/node', platform: 'linux', exists: () => false })).toThrow(
      /Could not find npm-cli\.js/,
    );
  });

  it('finds npm on this machine', () => {
    expect(() => resolveNpmCli()).not.toThrow();
  });
});

describe('samePath', () => {
  it('folds case on win32 only', () => {
    expect(samePath('C:\\A\\b', 'c:\\a\\B', 'win32')).toBe(true);
    expect(samePath('/a/b', '/a/B', 'linux')).toBe(false);
  });
});

describe('both channels are real data', () => {
  it.each(CASES)('realDefaultDataDirs lists stable and dev on $platform', ({ platform, home, env, real }) => {
    const dirs = realDefaultDataDirs({ platform, home, env: { ...env, BURROW_DATA_DIR: '/x' } });
    // Windows also lists %USERPROFILE%\Burrow Data, where the Microsoft Store build may keep its data.
    expect(dirs).toHaveLength(platform === 'win32' ? 3 : 2);
    expect(dirs[0]).toBe(real);
    const dev = dirs[dirs.length - 1];
    expect(dev).not.toBe(real);
    expect(dev.toLowerCase()).toMatch(/burrow[ -]dev$/);
    if (platform === 'win32') expect(dirs[1]).toBe(`${home}\\Burrow Data`);
  });

  it.each(CASES)('realDefaultDataDir stays stable with BURROW_CHANNEL=dev on $platform', ({ platform, home, env, real }) => {
    expect(realDefaultDataDir({ platform, home, env: { ...env, BURROW_CHANNEL: 'dev' } })).toBe(real);
  });

  it.each(CASES)('refuses the dev data dir, its children and its parents on $platform', ({ platform, home, env, tmpdir }) => {
    const mod = platform === 'win32' ? path.win32 : path.posix;
    const [, dev] = realDefaultDataDirs({ platform, home, env });
    const opts = { platform, home, env, tmpdir };
    expect(() => assertSafeDataDir(dev, opts)).toThrow(/real Burrow data/);
    expect(() => assertSafeDataDir(mod.join(dev, 'sandbox'), opts)).toThrow(/real Burrow data/);
    expect(() => assertSafeDataDir(mod.dirname(dev), opts)).toThrow(SandboxSafetyError);
  });
});
