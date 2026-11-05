// Isolation guards of the Dev channel: a Dev server must never run on the stable data folder (H1), and the
// shell and the sidecar must agree on the channel (H2). Both are checked before anything touches the data
// folder, so the spawned-server cases assert the folder is byte-identical afterwards.
import { describe, it, expect, vi } from 'vitest';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnv } from './helpers/childEnv.js';
import { canonical, foldPath, isSameOrInside, pathsOverlap } from '../pathGuard.js';
import { checkDevDataDir, checkShellChannel, stableDataDirs } from '../channelGuards.js';
import { resolveDataDir, userProfileDataDir } from '../paths.js';

vi.mock('../../loadEnv.js', () => ({}));

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SERVER = path.join(ROOT, 'server.js');
const READY_RE = /^BURROW_READY (\{.*\})$/m;

function fakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-guard-home-'));
  const env = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
  };
  for (const dir of Object.values(env)) fs.mkdirSync(dir, { recursive: true });
  return { home, env };
}

function listing(dir) {
  const out = {};
  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const rel = path.join(prefix, entry.name);
      if (entry.isDirectory()) {
        out[`${rel}/`] = 'dir';
        walk(path.join(current, entry.name), rel);
      } else {
        out[rel] = crypto.createHash('sha256').update(fs.readFileSync(path.join(current, entry.name))).digest('hex');
      }
    }
  };
  walk(dir, '');
  return out;
}

function run({ env, stdinLine }) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: childEnv({ BURROW_HOST: '127.0.0.1', BURROW_PORT: '0', BURROW_NO_DOTENV: '1', BURROW_SCHEDULER: '0', ...env }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  if (stdinLine !== undefined) child.stdin.write(stdinLine);
  return { child, exited, stdout: () => out, stderr: () => err };
}

async function exitCodeOf(proc, timeoutMs = 15000) {
  const timer = setTimeout(() => proc.child.kill(), timeoutMs);
  try {
    return await proc.exited;
  } finally {
    clearTimeout(timer);
  }
}

describe('pathGuard', () => {
  it('detects equal, nested and containing folders, and not siblings', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-pg-'));
    try {
      const a = path.join(base, 'Burrow');
      fs.mkdirSync(a);
      expect(pathsOverlap(a, a)).toBe(true);
      expect(pathsOverlap(a, path.join(a, 'backups', 'x'))).toBe(true);
      expect(pathsOverlap(path.join(a, 'backups'), a)).toBe(true);
      expect(pathsOverlap(base, a)).toBe(true);
      expect(pathsOverlap(a, path.join(base, 'Burrow Dev'))).toBe(false);
      expect(pathsOverlap(a, path.join(base, 'Burrow2'))).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('isSameOrInside treats a child named "..x" as inside, and ".." as outside', () => {
    expect(isSameOrInside('/a/b', '/a/b/..x', path.posix)).toBe(true);
    expect(isSameOrInside('/a/b', '/a/b/..x/y', path.posix)).toBe(true);
    expect(isSameOrInside('/a/b', '/a', path.posix)).toBe(false);
    expect(isSameOrInside('/a/b', '/a/c', path.posix)).toBe(false);
    expect(isSameOrInside('C:\\a\\b', 'C:\\a\\b\\..x', path.win32)).toBe(true);
    expect(isSameOrInside('C:\\a\\b', 'C:\\a', path.win32)).toBe(false);
    expect(isSameOrInside('C:\\a\\b', 'D:\\a\\b', path.win32)).toBe(false);
  });

  it('folds case on win32 and darwin only', () => {
    expect(foldPath('C:\\A', 'win32')).toBe('c:\\a');
    expect(foldPath('/Users/Tester', 'darwin')).toBe('/users/tester');
    expect(foldPath('/Home/A', 'linux')).toBe('/Home/A');
    expect(pathsOverlap('/Users/Me/Burrow', '/users/me/burrow', { platform: 'darwin' })).toBe(true);
    expect(pathsOverlap('/home/me/Burrow', '/home/me/burrow', { platform: 'linux' })).toBe(false);
    expect(pathsOverlap('C:\\Users\\Me\\Burrow', 'c:\\users\\me\\BURROW\\backups', { platform: 'win32' })).toBe(true);
  });

  it('resolves the deepest existing ancestor and keeps the missing tail', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-pg-'));
    try {
      const real = fs.realpathSync.native(base);
      expect(canonical(path.join(base, 'a', 'b'))).toBe(path.join(real, 'a', 'b'));
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('sees through a symlink or junction to the stable folder', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-pg-'));
    try {
      const target = path.join(base, 'Burrow');
      fs.mkdirSync(target);
      const link = path.join(base, 'alias');
      try {
        fs.symlinkSync(target, link, 'junction');
      } catch {
        return; // links are not allowed on this machine
      }
      expect(pathsOverlap(link, target)).toBe(true);
      expect(pathsOverlap(path.join(link, 'inner'), target)).toBe(true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('checkDevDataDir (H1)', () => {
  const { home, env } = fakeHome();
  const stable = resolveDataDir({ env: { ...env, BURROW_DATA_DIR: '' }, home, channel: 'stable' });

  it('lists the stable default and the override', () => {
    // On Windows the stable Burrow may also keep its data in %USERPROFILE%\Burrow Data (the Microsoft Store build).
    const profile = process.platform === 'win32' ? [userProfileDataDir({ env, home })] : [];
    expect(stableDataDirs({ env, home })).toEqual([stable, ...profile]);
    expect(stableDataDirs({ env: { ...env, BURROW_STABLE_DATA_DIR: ' /x/y ' }, home })).toEqual([stable, ...profile, '/x/y']);
  });

  it('passes the Dev default and unrelated overrides', () => {
    expect(checkDevDataDir({ env, home, channel: 'dev' }).ok).toBe(true);
    expect(checkDevDataDir({ env: { ...env, BURROW_DATA_DIR: path.join(home, 'elsewhere') }, home, channel: 'dev' }).ok).toBe(true);
  });

  it('refuses equal, inside and containing the stable default', () => {
    for (const dir of [stable, path.join(stable, 'backups'), path.dirname(stable)]) {
      const res = checkDevDataDir({ env: { ...env, BURROW_DATA_DIR: dir }, home, channel: 'dev' });
      expect(res.ok, dir).toBe(false);
      expect(res.message).toMatch(/Burrow Dev cannot use this data folder/);
      expect(res.message).not.toMatch(/\u2014/);
    }
  });

  it('refuses the BURROW_STABLE_DATA_DIR copy source too', () => {
    const source = path.join(home, 'fake-stable');
    const res = checkDevDataDir({ env: { ...env, BURROW_STABLE_DATA_DIR: source, BURROW_DATA_DIR: source }, home, channel: 'dev' });
    expect(res.ok).toBe(false);
  });

  it('does nothing for the stable channel', () => {
    expect(checkDevDataDir({ env: { ...env, BURROW_DATA_DIR: stable }, home, channel: 'stable' }).ok).toBe(true);
  });

  it.runIf(process.platform === 'win32')('is case-insensitive on Windows', () => {
    const res = checkDevDataDir({ env: { ...env, BURROW_DATA_DIR: stable.toUpperCase() }, home, channel: 'dev' });
    expect(res.ok).toBe(false);
  });
});

describe('checkShellChannel (H2)', () => {
  it('accepts a matching channel', () => {
    expect(checkShellChannel({ env: { BURROW_SHELL_CHANNEL: 'dev' }, bundled: 'dev', channel: 'dev' }).ok).toBe(true);
    expect(checkShellChannel({ env: { BURROW_SHELL_CHANNEL: 'stable' }, bundled: 'stable', channel: 'stable' }).ok).toBe(true);
  });

  it('refuses a mismatch in either direction', () => {
    expect(checkShellChannel({ env: { BURROW_SHELL_CHANNEL: 'dev' }, bundled: 'stable', channel: 'stable' }).ok).toBe(false);
    expect(checkShellChannel({ env: { BURROW_SHELL_CHANNEL: 'stable' }, bundled: 'dev', channel: 'dev' }).ok).toBe(false);
    expect(checkShellChannel({ env: { BURROW_SHELL_CHANNEL: 'other' }, bundled: 'dev', channel: 'dev' }).ok).toBe(false);
  });

  it('treats a missing variable as a mismatch only for a bundled server', () => {
    expect(checkShellChannel({ env: {}, bundled: 'stable', channel: 'stable' }).ok).toBe(false);
    expect(checkShellChannel({ env: { BURROW_SHELL_CHANNEL: '' }, bundled: 'dev', channel: 'dev' }).ok).toBe(false);
    expect(checkShellChannel({ env: {}, bundled: undefined, channel: 'stable' }).ok).toBe(true);
  });
});

describe('the real server refuses before touching the data folder', () => {
  it('dev channel on the stable default folder exits 1 and leaves it byte-identical', async () => {
    const { home, env } = fakeHome();
    try {
      const stable = resolveDataDir({ env: { ...env, BURROW_DATA_DIR: '' }, home, channel: 'stable' });
      fs.mkdirSync(path.join(stable, 'backups'), { recursive: true });
      fs.writeFileSync(path.join(stable, 'burrow.db'), crypto.randomBytes(2048));
      fs.writeFileSync(path.join(stable, 'burrow.db-wal'), crypto.randomBytes(512));
      fs.writeFileSync(path.join(stable, 'backups', 'note.txt'), 'x');
      const before = listing(stable);
      const targets = [stable, path.join(stable, 'backups'), path.dirname(stable)];
      for (const dir of targets) {
        const proc = run({ env: { ...env, BURROW_CHANNEL: 'dev', BURROW_DATA_DIR: dir } });
        const code = await exitCodeOf(proc);
        expect(code, `exit for ${dir}: ${proc.stderr()}`).toBe(1);
        expect(proc.stderr()).toMatch(/Burrow Dev cannot use this data folder/);
        expect(proc.stdout()).not.toMatch(/BURROW_READY|Burrow running/);
      }
      expect(listing(stable)).toEqual(before);
      expect(fs.existsSync(path.join(stable, 'secrets.key'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 60000);

  it('desktop mode with a shell of the other channel exits 1 and creates nothing', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-guard-data-'));
    try {
      for (const [serverChannel, shell] of [
        ['dev', 'stable'],
        ['stable', 'dev'],
      ]) {
        const proc = run({
          env: { BURROW_DESKTOP: '1', BURROW_CHANNEL: serverChannel, BURROW_SHELL_CHANNEL: shell, BURROW_DATA_DIR: dataDir },
          stdinLine: `${'a'.repeat(64)}\n`,
        });
        const code = await exitCodeOf(proc);
        expect(code, proc.stderr()).toBe(1);
        expect(proc.stderr()).toMatch(/not the same channel/);
        expect(fs.readdirSync(dataDir)).toEqual([]);
      }
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 60000);

  it('desktop mode with a matching shell starts and prints the channel in the ready line', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-guard-data-'));
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-guard-dist-'));
    fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><html><body>ok</body></html>');
    const proc = run({
      env: {
        BURROW_DESKTOP: '1',
        BURROW_CHANNEL: 'dev',
        BURROW_SHELL_CHANNEL: 'dev',
        BURROW_DATA_DIR: dataDir,
        BURROW_DIST_DIR: distDir,
      },
      stdinLine: `${crypto.randomBytes(32).toString('hex')}\n`,
    });
    try {
      const start = Date.now();
      let ready = null;
      while (!ready && Date.now() - start < 15000) {
        const m = READY_RE.exec(proc.stdout());
        if (m) ready = JSON.parse(m[1]);
        else await new Promise((r) => setTimeout(r, 50));
      }
      expect(ready, proc.stderr()).not.toBeNull();
      expect(ready.channel).toBe('dev');
      proc.child.stdin.end();
      expect(await exitCodeOf(proc)).toBe(0);
    } finally {
      if (proc.child.exitCode === null) proc.child.kill();
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      fs.rmSync(distDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 60000);
});
