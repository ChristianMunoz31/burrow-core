// Data location marker: 'appdata' (default) or 'userprofile' (the Microsoft Store build without unvirtualizedResources). Where the data
// folder goes in each case, the Dev channel and direct builds staying put, the stable-folder list the Dev guards protect, and the real
// server refusing a marker that does not belong to its build before it creates anything.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { checkDevDataDir, stableDataDirs } from '../channelGuards.js';
import {
  DATA_LOCATIONS,
  assertBuildDataLocation,
  checkDataLocation,
  getDataLocation,
  parseDataLocation,
  resolveBuildDataLocation,
} from '../dataLocation.js';
import { appDataFolderDir, resolveDataDir, resolveStableDataDir, stableDefaultDataDirs, usesUserProfileDir, userProfileDataDir } from '../paths.js';
import { childEnv } from './helpers/childEnv.js';

vi.mock('../../loadEnv.js', () => ({}));

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WIN = { platform: 'win32', home: 'C:\\Users\\example', env: { APPDATA: 'C:\\Users\\example\\AppData\\Roaming', USERPROFILE: 'C:\\Users\\example' } };
const STORE_PROFILE = { distribution: 'store', dataLocation: 'userprofile' };

describe('marker parsing', () => {
  it('knows exactly two values and reads them exactly', () => {
    expect(DATA_LOCATIONS).toEqual(['appdata', 'userprofile']);
    expect(parseDataLocation('userprofile')).toBe('userprofile');
    expect(parseDataLocation('appdata')).toBe('appdata');
    expect(parseDataLocation('UserProfile')).toBeNull();
    expect(parseDataLocation('')).toBeNull();
    expect(parseDataLocation(undefined)).toBeNull();
  });

  it('a bundled value wins; the environment is read only when unbundled; anything unknown is appdata', () => {
    expect(getDataLocation({}, undefined)).toBe('appdata');
    expect(getDataLocation({ BURROW_DATA_LOCATION: 'userprofile' }, undefined)).toBe('userprofile');
    expect(getDataLocation({ BURROW_DATA_LOCATION: 'userprofile' }, 'appdata')).toBe('appdata');
    expect(getDataLocation({ BURROW_DATA_LOCATION: 'appdata' }, 'userprofile')).toBe('userprofile');
    expect(getDataLocation({ BURROW_DATA_LOCATION: 'USERPROFILE' }, undefined)).toBe('appdata');
    expect(getDataLocation({}, 'weird')).toBe('appdata');
  });

  it('a build refuses a typo instead of shipping appdata', () => {
    expect(resolveBuildDataLocation({})).toBe('appdata');
    expect(resolveBuildDataLocation({ BURROW_DATA_LOCATION: ' userprofile ' })).toBe('userprofile');
    expect(() => resolveBuildDataLocation({ BURROW_DATA_LOCATION: 'home' }, '--data-location')).toThrow(/--data-location must be one of appdata, userprofile/);
  });

  it('userprofile is valid only for the stable Store build', () => {
    expect(checkDataLocation({ dataLocation: 'appdata', distribution: 'direct' }).ok).toBe(true);
    expect(checkDataLocation({ dataLocation: 'userprofile', distribution: 'store' }).ok).toBe(true);
    const direct = checkDataLocation({ dataLocation: 'userprofile', distribution: 'direct' });
    expect(direct.ok).toBe(false);
    expect(direct.message).toMatch(/only the Microsoft Store build/);
    expect(direct.message).not.toMatch(/\u2014/);
    expect(checkDataLocation({ dataLocation: 'userprofile', distribution: 'store', channel: 'dev' }).ok).toBe(false);
    expect(() => assertBuildDataLocation({ dataLocation: 'userprofile', distribution: 'direct' })).toThrow(/only valid for a stable Microsoft Store build/);
    expect(() => assertBuildDataLocation({ dataLocation: 'userprofile', distribution: 'store' })).not.toThrow();
  });
});

describe('where the data folder is', () => {
  it('direct and appdata builds keep %APPDATA%\\Burrow, as before', () => {
    expect(resolveDataDir({ ...WIN, channel: 'stable', distribution: 'direct', dataLocation: 'appdata' })).toBe('C:\\Users\\example\\AppData\\Roaming\\Burrow');
    expect(resolveDataDir({ ...WIN, channel: 'stable', distribution: 'store', dataLocation: 'appdata' })).toBe('C:\\Users\\example\\AppData\\Roaming\\Burrow');
  });

  it('the Store build with the userprofile marker uses %USERPROFILE%\\Burrow Data on Windows', () => {
    expect(resolveDataDir({ ...WIN, channel: 'stable', ...STORE_PROFILE })).toBe('C:\\Users\\example\\Burrow Data');
    expect(usesUserProfileDir({ ...WIN, channel: 'stable', ...STORE_PROFILE })).toBe(true);
    // USERPROFILE wins over the home argument; without it the home is used.
    expect(userProfileDataDir({ env: {}, home: 'C:\\Users\\example' })).toBe('C:\\Users\\example\\Burrow Data');
  });

  it('only that exact combination moves: Dev, a direct build, other systems and BURROW_DATA_DIR do not', () => {
    expect(resolveDataDir({ ...WIN, channel: 'dev', ...STORE_PROFILE })).toBe('C:\\Users\\example\\AppData\\Roaming\\Burrow Dev');
    expect(resolveDataDir({ ...WIN, channel: 'stable', distribution: 'direct', dataLocation: 'userprofile' })).toBe('C:\\Users\\example\\AppData\\Roaming\\Burrow');
    expect(resolveDataDir({ platform: 'linux', env: {}, home: '/home/example', channel: 'stable', ...STORE_PROFILE })).toBe('/home/example/.local/share/burrow');
    expect(resolveDataDir({ platform: 'darwin', env: {}, home: '/Users/example', channel: 'stable', ...STORE_PROFILE })).toBe('/Users/example/Library/Application Support/Burrow');
    expect(resolveDataDir({ ...WIN, env: { ...WIN.env, BURROW_DATA_DIR: 'C:\\Temp\\x' }, channel: 'stable', ...STORE_PROFILE })).toBe(path.resolve('C:\\Temp\\x'));
  });

  it('reads the marker from the environment when no arguments say otherwise (a source checkout)', () => {
    const env = { ...WIN.env, BURROW_DISTRIBUTION: 'store', BURROW_DATA_LOCATION: 'userprofile' };
    expect(resolveDataDir({ platform: 'win32', env, home: WIN.home, channel: 'stable' })).toBe('C:\\Users\\example\\Burrow Data');
    expect(resolveDataDir({ platform: 'win32', env: { ...env, BURROW_DISTRIBUTION: undefined }, home: WIN.home, channel: 'stable' })).toBe(
      'C:\\Users\\example\\AppData\\Roaming\\Burrow',
    );
  });

  it('the stable defaults the Dev channel must protect list both folders on Windows', () => {
    expect(stableDefaultDataDirs(WIN)).toEqual(['C:\\Users\\example\\AppData\\Roaming\\Burrow', 'C:\\Users\\example\\Burrow Data']);
    expect(stableDefaultDataDirs({ platform: 'linux', env: {}, home: '/home/example' })).toEqual(['/home/example/.local/share/burrow']);
    expect(appDataFolderDir({ ...WIN, channel: 'dev' })).toBe('C:\\Users\\example\\AppData\\Roaming\\Burrow Dev');
    expect(stableDataDirs({ ...WIN })).toEqual(['C:\\Users\\example\\AppData\\Roaming\\Burrow', 'C:\\Users\\example\\Burrow Data']);
    expect(stableDataDirs({ ...WIN, env: { ...WIN.env, BURROW_STABLE_DATA_DIR: 'C:\\x' } })).toEqual([
      'C:\\Users\\example\\AppData\\Roaming\\Burrow',
      'C:\\Users\\example\\Burrow Data',
      'C:\\x',
    ]);
    // "Copy my data from Burrow" copies from the direct Burrow, whatever the marker.
    expect(resolveStableDataDir(WIN).dir).toBe('C:\\Users\\example\\AppData\\Roaming\\Burrow');
  });

  it.runIf(process.platform === 'win32')('a Dev server refuses %USERPROFILE%\\Burrow Data, its contents and its parent', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-dl-home-'));
    try {
      const env = { USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming') };
      const profileDir = path.join(home, 'Burrow Data');
      for (const dir of [profileDir, path.join(profileDir, 'backups'), home]) {
        const res = checkDevDataDir({ env: { ...env, BURROW_DATA_DIR: dir }, platform: 'win32', home, channel: 'dev' });
        expect(res.ok, dir).toBe(false);
      }
      expect(checkDevDataDir({ env: { ...env, BURROW_DATA_DIR: path.join(home, 'Elsewhere') }, platform: 'win32', home, channel: 'dev' }).ok).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

function fakeProfile() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-dl-'));
  const env = {
    USERPROFILE: home,
    HOME: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
  };
  for (const dir of [env.APPDATA, env.LOCALAPPDATA, env.XDG_DATA_HOME]) fs.mkdirSync(dir, { recursive: true });
  return { home, env };
}

function runServer({ env, stdinLine, distDir }) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: childEnv({ BURROW_HOST: '127.0.0.1', BURROW_PORT: '0', BURROW_NO_DOTENV: '1', BURROW_SCHEDULER: '0', ...(distDir ? { BURROW_DIST_DIR: distDir } : {}), ...env }),
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

async function waitFor(fn, ms = 30000) {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('the real server and its marker', () => {
  it('refuses a userprofile marker on a direct build before it creates anything', async () => {
    const { home, env } = fakeProfile();
    try {
      const proc = runServer({ env: { ...env, BURROW_DATA_LOCATION: 'userprofile' } });
      const code = await Promise.race([proc.exited, new Promise((r) => setTimeout(() => r('timeout'), 20000))]);
      if (code === 'timeout') proc.child.kill();
      expect(code, proc.stderr()).toBe(1);
      expect(proc.stderr()).toMatch(/only the Microsoft Store build/);
      expect(proc.stdout()).not.toMatch(/Burrow running|BURROW_READY/);
      expect(fs.existsSync(path.join(home, 'Burrow Data'))).toBe(false);
      expect(fs.existsSync(path.join(env.APPDATA, 'Burrow'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 60000);

  it('refuses a userprofile marker on the dev channel too', async () => {
    const { home, env } = fakeProfile();
    try {
      const proc = runServer({ env: { ...env, BURROW_CHANNEL: 'dev', BURROW_DISTRIBUTION: 'store', BURROW_DATA_LOCATION: 'userprofile' } });
      const code = await Promise.race([proc.exited, new Promise((r) => setTimeout(() => r('timeout'), 20000))]);
      if (code === 'timeout') proc.child.kill();
      expect(code, proc.stderr()).toBe(1);
      expect(fs.existsSync(path.join(env.APPDATA, 'Burrow Dev'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 60000);

  it.runIf(process.platform === 'win32')('the Store build with the userprofile marker keeps ALL its data in %USERPROFILE%\\Burrow Data and reports it', async () => {
    const { home, env } = fakeProfile();
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-dl-dist-'));
    fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><html><body>ok</body></html>');
    const proc = runServer({
      distDir,
      env: { ...env, BURROW_DESKTOP: '1', BURROW_SHELL_CHANNEL: 'stable', BURROW_DISTRIBUTION: 'store', BURROW_DATA_LOCATION: 'userprofile' },
      stdinLine: `${crypto.randomBytes(32).toString('hex')}\n`,
    });
    try {
      const line = await waitFor(() => /^BURROW_READY (\{.*\})$/m.exec(proc.stdout()));
      const ready = JSON.parse(line[1]);
      expect(ready).toMatchObject({ channel: 'stable', distribution: 'store', dataLocation: 'userprofile' });
      expect(ready.dataDir.toLowerCase()).toBe(path.join(home, 'Burrow Data').toLowerCase());
      for (const name of ['burrow.db', 'secrets.key']) expect(fs.existsSync(path.join(home, 'Burrow Data', name)), name).toBe(true);
      // Nothing was written under AppData: the data stays out of the virtualized area.
      expect(fs.existsSync(path.join(env.APPDATA, 'Burrow'))).toBe(false);
      expect(fs.readdirSync(env.APPDATA)).toEqual([]);
      proc.child.stdin.end();
      expect(await proc.exited).toBe(0);
    } finally {
      proc.child.kill();
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  }, 60000);

  it.runIf(process.platform === 'win32')('creates the folder with the ownership marker when it is missing, and uses a marked folder again', async () => {
    const { home, env } = fakeProfile();
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-dl-dist-'));
    fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><html><body>ok</body></html>');
    const dataDir = path.join(home, 'Burrow Data');
    const storeEnv = { ...env, BURROW_DESKTOP: '1', BURROW_SHELL_CHANNEL: 'stable', BURROW_DISTRIBUTION: 'store', BURROW_DATA_LOCATION: 'userprofile' };
    try {
      for (const round of [1, 2]) {
        const proc = runServer({ distDir, env: storeEnv, stdinLine: `${crypto.randomBytes(32).toString('hex')}\n` });
        try {
          await waitFor(() => /^BURROW_READY (\{.*\})$/m.exec(proc.stdout()));
          const marker = JSON.parse(fs.readFileSync(path.join(dataDir, '.burrow-data.json'), 'utf8'));
          expect(marker, `round ${round}`).toMatchObject({ app: 'Burrow', edition: 'store', dataLocation: 'userprofile', formatVersion: 1 });
          expect(Number.isNaN(Date.parse(marker.createdAt))).toBe(false);
          proc.child.stdin.end();
          expect(await proc.exited).toBe(0);
        } finally {
          proc.child.kill();
        }
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  }, 90000);

  it.runIf(process.platform === 'win32')('refuses an unmarked, non-empty folder with exit code 5 without writing a byte into it', async () => {
    const { home, env } = fakeProfile();
    const dataDir = path.join(home, 'Burrow Data');
    const storeEnv = { ...env, BURROW_DESKTOP: '1', BURROW_SHELL_CHANNEL: 'stable', BURROW_DISTRIBUTION: 'store', BURROW_DATA_LOCATION: 'userprofile' };
    const snapshot = (dir) =>
      fs
        .readdirSync(dir, { recursive: true, withFileTypes: true })
        .map((e) => `${path.relative(dir, path.join(e.parentPath, e.name))}|${e.isDirectory() ? 'dir' : fs.readFileSync(path.join(e.parentPath, e.name), 'hex')}`)
        .sort();
    try {
      fs.mkdirSync(dataDir);
      fs.writeFileSync(path.join(dataDir, '.hidden-note'), 'not burrow');
      fs.mkdirSync(path.join(dataDir, '.git'));
      const before = snapshot(dataDir);
      const proc = runServer({ env: storeEnv, stdinLine: `${crypto.randomBytes(32).toString('hex')}\n` });
      const code = await Promise.race([proc.exited, new Promise((r) => setTimeout(() => r('timeout'), 30000))]);
      if (code === 'timeout') proc.child.kill();
      expect(code, proc.stderr()).toBe(5);
      expect(proc.stderr()).toContain(dataDir);
      expect(proc.stderr()).toMatch(/did not change anything/);
      expect(proc.stdout()).not.toMatch(/BURROW_READY/);
      expect(snapshot(dataDir)).toEqual(before);
      expect(fs.existsSync(path.join(dataDir, '.burrow-data.json'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 60000);

  it('the same server with the default marker keeps %APPDATA%\\Burrow and reports appdata', async () => {
    const { home, env } = fakeProfile();
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-dl-dist-'));
    fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><html><body>ok</body></html>');
    const proc = runServer({
      distDir,
      env: { ...env, BURROW_DESKTOP: '1', BURROW_SHELL_CHANNEL: 'stable' },
      stdinLine: `${crypto.randomBytes(32).toString('hex')}\n`,
    });
    try {
      const line = await waitFor(() => /^BURROW_READY (\{.*\})$/m.exec(proc.stdout()));
      const ready = JSON.parse(line[1]);
      expect(ready.dataLocation).toBe('appdata');
      if (process.platform === 'win32') expect(ready.dataDir.toLowerCase()).toBe(path.join(env.APPDATA, 'Burrow').toLowerCase());
      expect(fs.existsSync(path.join(home, 'Burrow Data'))).toBe(false);
      proc.child.stdin.end();
      expect(await proc.exited).toBe(0);
    } finally {
      proc.child.kill();
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  }, 60000);
});
