import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  assertIsolated,
  assertNoneRunning,
  backupDataDir,
  backupName,
  ensureClosed,
  findDevInstaller,
  installerArch,
  integrityCheckFile,
  parseCliArgs,
  parseSums,
  pruneBackups,
  resolveIdentity,
  runInstall,
} from '../../scripts/desktop/installLocal.mjs';

const REAL_ROOT = path.resolve(__dirname, '..', '..');
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const MZ = Buffer.concat([Buffer.from('MZ'), Buffer.from('installer-bytes')]);
const VERSIONS = {
  display: '0.2.0-dev.20261005.abc1234',
  bundle: '0.2.0-dev.20261005+1008',
  buildNumber: 1008,
  shortSha: 'abc1234',
};
const DEV_NAME = `Burrow-Dev_${VERSIONS.display}_arm64-setup.exe`;

let tmp;
let root;
let env;

function seedConfigs() {
  fs.mkdirSync(path.join(root, 'src-tauri'), { recursive: true });
  for (const f of ['tauri.conf.json', 'tauri.dev.conf.json']) {
    fs.copyFileSync(path.join(REAL_ROOT, 'src-tauri', f), path.join(root, 'src-tauri', f));
  }
}

function writeDevBuild({ name = DEV_NAME, bytes = MZ, sums = true, sumsHash } = {}) {
  const dir = path.join(root, '.dev-build');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), bytes);
  if (sums) fs.writeFileSync(path.join(dir, 'SHA256SUMS-dev-windows.txt'), `${sumsHash ?? sha(bytes)}  ${name}\n`);
  return path.join(dir, name);
}

function seedData(channel, files = { 'burrow.db': 'db-bytes', 'backups/a.txt': 'x' }) {
  const dir = path.join(env.APPDATA, channel === 'dev' ? 'Burrow Dev' : 'Burrow');
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

/** A fake Windows: tasklist, taskkill and the installer, all recorded. */
function makeDeps(overrides = {}) {
  const state = { running: new Set(), calls: [], logs: [], stubborn: false, installedVersion: null, installerFails: false };
  const exec = vi.fn(async (file, args = []) => {
    state.calls.push([file, ...args]);
    if (file === 'tasklist') {
      const exe = args[1].replace('IMAGENAME eq ', '');
      return { stdout: state.running.has(exe) ? `"${exe}","1","Console","1","10 K"\r\n` : 'INFO: No tasks are running which match the specified criteria.\r\n' };
    }
    if (file === 'taskkill') {
      if (!state.stubborn) state.running.delete(args[1]);
      return { stdout: '' };
    }
    if (file.toLowerCase().endsWith('.exe')) {
      if (state.installerFails) throw new Error('installer exit 1');
      if (state.installerHangs) return new Promise(() => {});
      const dir = path.join(env.LOCALAPPDATA, /Burrow-Dev/.test(path.basename(file)) ? 'Burrow Dev' : 'Burrow');
      const exe = path.join(dir, /Burrow-Dev/.test(path.basename(file)) ? 'BurrowDev.exe' : 'Burrow.exe');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(exe, MZ);
      if (state.exeMtime) fs.utimesSync(exe, state.exeMtime, state.exeMtime);
      return { stdout: '' };
    }
    throw new Error(`unexpected exec ${file}`);
  });
  const deps = {
    env,
    root,
    platform: 'win32',
    arch: 'arm64',
    exec,
    log: (line) => state.logs.push(line),
    sleep: vi.fn(async () => {}),
    integrity: () => ['ok'],
    now: () => new Date(2026, 9, 7, 8, 5, 3),
    confirm: vi.fn(async () => true),
    devVersions: () => VERSIONS,
    runBuild: vi.fn(() => {
      writeDevBuild();
    }),
    peVersion: vi.fn(async (file) => {
      if (/BurrowDev\.exe$|[\\/]Burrow\.exe$/.test(file)) return state.installedVersion;
      return state.installerVersion ?? '0.1.0';
    }),
    ...overrides,
  };
  return { deps, state };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-install-test-'));
  root = path.join(tmp, 'repo');
  env = { LOCALAPPDATA: path.join(tmp, 'Local'), APPDATA: path.join(tmp, 'Roaming') };
  fs.mkdirSync(env.LOCALAPPDATA, { recursive: true });
  fs.mkdirSync(env.APPDATA, { recursive: true });
  seedConfigs();
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('parseCliArgs', () => {
  it('defaults to the dev channel and a dry run', () => {
    expect(parseCliArgs([])).toMatchObject({ channel: 'dev', install: false, yes: false, close: false, skipBuild: false, from: null });
  });

  it('--install and --yes both turn the dry run off; only --yes skips the prompt', () => {
    expect(parseCliArgs(['--install'])).toMatchObject({ install: true, yes: false });
    expect(parseCliArgs(['--yes'])).toMatchObject({ install: true, yes: true });
  });

  it('stable needs --from; --from and --skip-build are channel specific', () => {
    expect(parseCliArgs(['--channel', 'stable', '--from', 'latest']).from).toBe('latest');
    expect(() => parseCliArgs(['--channel', 'stable'])).toThrow(/needs --from/);
    expect(() => parseCliArgs(['--from', 'latest'])).toThrow(/stable only/);
    expect(() => parseCliArgs(['--channel', 'stable', '--from', 'latest', '--skip-build'])).toThrow(/dev only/);
    expect(() => parseCliArgs(['--channel', 'stable', '--from', ' '])).toThrow(/--from needs/);
  });

  it('rejects an unknown channel, unknown flags and positionals', () => {
    expect(() => parseCliArgs(['--channel', 'beta'])).toThrow(/dev or stable/);
    expect(() => parseCliArgs(['--nope'])).toThrow();
    expect(() => parseCliArgs(['extra'])).toThrow();
  });
});

describe('platform and arch refusals', () => {
  it('refuses other operating systems with a clear message', async () => {
    const { deps } = makeDeps({ platform: 'linux' });
    await expect(runInstall(parseCliArgs([]), deps)).rejects.toThrow(/Windows only/);
  });

  it('maps the host arch and refuses unknown ones', () => {
    expect(installerArch('arm64')).toBe('arm64');
    expect(installerArch('x64')).toBe('x64');
    expect(() => installerArch('ia32')).toThrow(/Unsupported/);
  });
});

describe('identity from the Tauri configs', () => {
  it('stable is Burrow, dev is Burrow Dev, side by side', () => {
    const stable = resolveIdentity('stable', { root: REAL_ROOT, env });
    const dev = resolveIdentity('dev', { root: REAL_ROOT, env });
    expect(stable).toMatchObject({ identifier: 'com.burrow.desktop', mainExe: 'Burrow.exe', sidecarExe: 'burrow-server.exe' });
    expect(stable.installDir).toBe(path.join(env.LOCALAPPDATA, 'Burrow'));
    expect(stable.dataDir).toBe(path.join(env.APPDATA, 'Burrow'));
    expect(dev).toMatchObject({ identifier: 'com.burrow.desktop.dev', mainExe: 'BurrowDev.exe', sidecarExe: 'burrow-dev-server.exe' });
    expect(dev.installDir).toBe(path.join(env.LOCALAPPDATA, 'Burrow Dev'));
    expect(dev.dataDir).toBe(path.join(env.APPDATA, 'Burrow Dev'));
    expect(() => assertIsolated(stable, dev)).not.toThrow();
  });

  it('needs LOCALAPPDATA and APPDATA', () => {
    expect(() => resolveIdentity('dev', { root: REAL_ROOT, env: {} })).toThrow(/LOCALAPPDATA/);
  });

  it('assertIsolated refuses overlapping folders, shared exes and a shared identifier', () => {
    const a = resolveIdentity('stable', { root: REAL_ROOT, env });
    const b = resolveIdentity('dev', { root: REAL_ROOT, env });
    expect(() => assertIsolated(a, { ...b, dataDir: a.dataDir })).toThrow(/overlaps/);
    expect(() => assertIsolated(a, { ...b, installDir: path.join(a.dataDir, 'sub') })).toThrow(/overlaps/);
    expect(() => assertIsolated(a, { ...b, mainExe: 'burrow.EXE' })).toThrow(/refusing/);
    expect(() => assertIsolated(a, { ...b, identifier: a.identifier })).toThrow(/same app identifier/);
  });
});

describe('dev plan and dry run', () => {
  it('prints the plan for a build and writes nothing', async () => {
    seedData('dev');
    const before = fs.readdirSync(tmp, { recursive: true }).sort();
    const { deps, state } = makeDeps();
    const spies = ['writeFileSync', 'mkdirSync', 'cpSync', 'rmSync'].map((m) => vi.spyOn(fs, m));
    const result = await runInstall(parseCliArgs([]), deps);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    expect(result.installed).toBe(false);
    expect(deps.runBuild).not.toHaveBeenCalled();
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(state.calls.every(([file]) => file === 'tasklist')).toBe(true);
    expect(fs.readdirSync(tmp, { recursive: true }).sort()).toEqual(before);
    const text = state.logs.join('\n');
    expect(text).toContain('DRY RUN');
    expect(text).toContain('npm run desktop:build:dev -- --bundles nsis');
    expect(text).toContain(path.join(env.LOCALAPPDATA, 'Burrow Dev'));
    expect(text).toContain(path.join(env.LOCALAPPDATA, 'burrow-release', 'data-backups', 'dev-20261007-080503'));
    expect(text).toContain('BurrowDev.exe');
    expect(text).toContain('/S');
    expect(text).toContain('0.2.0-dev.20261005+1008 (or 0.2.0.1008;');
  });

  it('--skip-build reuses the HEAD installer and shows its sha256', async () => {
    writeDevBuild();
    const { deps, state } = makeDeps();
    await runInstall(parseCliArgs(['--skip-build']), deps);
    expect(state.logs.join('\n')).toContain(sha(MZ));
    expect(deps.runBuild).not.toHaveBeenCalled();
  });

  it('--skip-build refuses a missing, stale, tampered or non-exe installer', async () => {
    const { deps } = makeDeps();
    await expect(runInstall(parseCliArgs(['--skip-build']), deps)).rejects.toThrow(/No Burrow-Dev_0\.2\.0-dev\.20261005\.abc1234_arm64-setup\.exe/);
    writeDevBuild({ name: 'Burrow-Dev_0.2.0-dev.20261001.deadbee_arm64-setup.exe' });
    await expect(runInstall(parseCliArgs(['--skip-build']), deps)).rejects.toThrow(/built from HEAD/);
    writeDevBuild({ sumsHash: 'f'.repeat(64) });
    await expect(runInstall(parseCliArgs(['--skip-build']), deps)).rejects.toThrow(/does not match SHA256SUMS-dev-windows\.txt/);
    writeDevBuild({ bytes: Buffer.from('not an exe') });
    await expect(runInstall(parseCliArgs(['--skip-build']), deps)).rejects.toThrow(/MZ/);
    writeDevBuild({ sums: false });
    fs.rmSync(path.join(root, '.dev-build', 'SHA256SUMS-dev-windows.txt'), { force: true });
    expect(() => findDevInstaller({ dir: path.join(root, '.dev-build'), versions: VERSIONS, arch: 'arm64' })).toThrow(/is missing/);
  });
});

describe('dev install', () => {
  it('builds, backs up, installs and checks the version', async () => {
    const dataDir = seedData('dev');
    const other = seedData('stable', { 'burrow.db': 'stable-data' });
    const { deps, state } = makeDeps();
    state.installedVersion = '0.2.0.1008';
    const result = await runInstall(parseCliArgs(['--install']), deps);
    expect(deps.confirm).toHaveBeenCalledTimes(1);
    expect(deps.runBuild).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ installed: true, version: '0.2.0.1008' });
    const backup = path.join(env.LOCALAPPDATA, 'burrow-release', 'data-backups', 'dev-20261007-080503');
    expect(result.backupDir).toBe(backup);
    expect(fs.readFileSync(path.join(backup, 'burrow.db'), 'utf8')).toBe('db-bytes');
    expect(fs.existsSync(path.join(dataDir, 'burrow.db'))).toBe(true);
    const installerCall = state.calls.find(([file]) => file.endsWith('.exe'));
    expect(installerCall).toEqual([path.join(root, '.dev-build', DEV_NAME), '/S']);
    expect(fs.readFileSync(path.join(other, 'burrow.db'), 'utf8')).toBe('stable-data');
  });

  it('a declined prompt changes nothing; --yes skips the prompt', async () => {
    seedData('dev');
    const declined = makeDeps({ confirm: vi.fn(async () => false) });
    const r = await runInstall(parseCliArgs(['--install']), declined.deps);
    expect(r.installed).toBe(false);
    expect(declined.deps.runBuild).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(env.LOCALAPPDATA, 'burrow-release'))).toBe(false);

    const ok = makeDeps();
    ok.state.installedVersion = '0.2.0.1008';
    await runInstall(parseCliArgs(['--yes']), ok.deps);
    expect(ok.deps.confirm).not.toHaveBeenCalled();
  });

  it('refuses when the installed version is not the expected one', async () => {
    seedData('dev');
    const { deps, state } = makeDeps();
    state.installedVersion = '0.1.0';
    await expect(runInstall(parseCliArgs(['--yes']), deps)).rejects.toThrow(/reports version 0\.1\.0, expected 0\.2\.0-dev\.20261005\+1008 or 0\.2\.0\.1008/);
  });

  it('accepts the real installed format 0.2.0-dev.20261005+1008', async () => {
    seedData('dev');
    const { deps, state } = makeDeps();
    state.installedVersion = '0.2.0-dev.20261005+1008';
    await expect(runInstall(parseCliArgs(['--yes']), deps)).resolves.toMatchObject({ installed: true, version: '0.2.0-dev.20261005+1008' });
  });

  it('refuses a matching version whose exe is older than this run (build run only)', async () => {
    seedData('dev');
    const old = makeDeps();
    old.state.installedVersion = '0.2.0-dev.20261005+1008';
    old.state.exeMtime = new Date(2020, 0, 1);
    await expect(runInstall(parseCliArgs(['--yes']), old.deps)).rejects.toThrow(/not written by this install/);
    // --skip-build reuses an installer built earlier, so the exe time says nothing there.
    writeDevBuild();
    const reuse = makeDeps({ now: () => new Date(2026, 9, 7, 9, 30, 0) });
    reuse.state.installedVersion = '0.2.0-dev.20261005+1008';
    reuse.state.exeMtime = new Date(2020, 0, 1);
    await expect(runInstall(parseCliArgs(['--yes', '--skip-build']), reuse.deps)).resolves.toMatchObject({ installed: true });
  });

  it('refuses when the installed version cannot be read, and when the installer fails', async () => {
    seedData('dev');
    const unreadable = makeDeps();
    unreadable.state.installedVersion = null;
    await expect(runInstall(parseCliArgs(['--yes']), unreadable.deps)).rejects.toThrow(/could not read the version/);
    const failing = makeDeps({ now: () => new Date(2026, 9, 7, 9, 0, 0) });
    failing.state.installerFails = true;
    await expect(runInstall(parseCliArgs(['--yes']), failing.deps)).rejects.toThrow(/installer exit 1/);
  });

  it('skips the backup when there is no data folder yet', async () => {
    const { deps, state } = makeDeps();
    state.installedVersion = '0.2.0.1008';
    const result = await runInstall(parseCliArgs(['--yes']), deps);
    expect(result.backupDir).toBeNull();
    expect(fs.existsSync(path.join(env.LOCALAPPDATA, 'burrow-release', 'data-backups'))).toBe(false);
  });
});

describe('running app', () => {
  it('refuses when the app or its sidecar runs, and backs up and installs nothing', async () => {
    seedData('dev');
    for (const exe of ['BurrowDev.exe', 'burrow-dev-server.exe']) {
      const { deps, state } = makeDeps();
      state.running.add(exe);
      await expect(runInstall(parseCliArgs(['--yes']), deps)).rejects.toThrow(/is running/);
      expect(state.calls.some(([f]) => f === 'taskkill')).toBe(false);
      expect(state.calls.some(([f]) => f.endsWith('.exe'))).toBe(false);
      expect(fs.existsSync(path.join(env.LOCALAPPDATA, 'burrow-release'))).toBe(false);
    }
  });

  it('only looks at the target channel processes', async () => {
    seedData('dev');
    const { deps, state } = makeDeps();
    state.running.add('Burrow.exe');
    state.running.add('burrow-server.exe');
    state.installedVersion = '0.2.0.1008';
    await runInstall(parseCliArgs(['--yes']), deps);
    const names = state.calls.filter(([f]) => f === 'tasklist').map((c) => c[2]);
    expect(names).toEqual(expect.arrayContaining(['IMAGENAME eq BurrowDev.exe', 'IMAGENAME eq burrow-dev-server.exe']));
    expect(names.some((n) => n === 'IMAGENAME eq Burrow.exe')).toBe(false);
  });

  it('--close asks gracefully (no /F) and goes on once it is gone', async () => {
    seedData('dev');
    const { deps, state } = makeDeps();
    state.running.add('BurrowDev.exe');
    state.installedVersion = '0.2.0.1008';
    await runInstall(parseCliArgs(['--yes', '--close']), deps);
    const kills = state.calls.filter(([f]) => f === 'taskkill');
    expect(kills).toEqual([['taskkill', '/IM', 'BurrowDev.exe']]);
    expect(kills.flat().some((a) => /^\/f$/i.test(a))).toBe(false);
  });

  it('--close refuses after 20 s when the app stays open, never force killing', async () => {
    seedData('dev');
    const { deps, state } = makeDeps();
    state.running.add('BurrowDev.exe');
    state.stubborn = true;
    await expect(runInstall(parseCliArgs(['--yes', '--close']), deps)).rejects.toThrow(/still running after 20 s/);
    expect(deps.sleep).toHaveBeenCalledTimes(20);
    expect(state.calls.flat().some((a) => /^\/f$/i.test(String(a)))).toBe(false);
    expect(state.calls.some(([f]) => f.endsWith('.exe'))).toBe(false);
    expect(fs.existsSync(path.join(env.LOCALAPPDATA, 'burrow-release'))).toBe(false);
  });

  it('re-checks right before the installer and refuses if the app started in the meantime', async () => {
    seedData('dev');
    const { deps, state } = makeDeps();
    deps.integrity = () => {
      state.running.add('BurrowDev.exe');
      return ['ok'];
    };
    await expect(runInstall(parseCliArgs(['--yes']), deps)).rejects.toThrow(/installer was not started/);
    expect(state.calls.some(([f]) => f.endsWith('.exe'))).toBe(false);
    expect(state.calls.some(([f]) => f === 'taskkill')).toBe(false);
  });

  it('assertNoneRunning checks both exes', async () => {
    const exec = vi.fn(async (_f, args) => ({ stdout: args[1].endsWith('B.exe') ? '"B.exe","1"\r\n' : '' }));
    await expect(assertNoneRunning(exec, ['A.exe', 'B.exe'])).rejects.toThrow(/B\.exe is running/);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('gives up on a hanging installer after the timeout without killing anything', async () => {
    seedData('dev');
    const { deps, state } = makeDeps({ installerTimeoutMs: 20 });
    state.installerHangs = true;
    await expect(runInstall(parseCliArgs(['--yes']), deps)).rejects.toThrow(/did not finish within .* NOT stopped/);
    expect(state.calls.some(([f]) => f === 'taskkill')).toBe(false);
  });

  it('ensureClosed returns at once when nothing runs', async () => {
    const exec = vi.fn(async () => ({ stdout: 'INFO: No tasks are running\r\n' }));
    await ensureClosed({ exec, exes: ['A.exe'], close: false, sleep: async () => {}, log: () => {} });
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

describe('backups', () => {
  it('names backups <channel>-YYYYMMDD-HHMMSS in local time', () => {
    expect(backupName('dev', new Date(2026, 0, 2, 3, 4, 5))).toBe('dev-20260102-030405');
    expect(backupName('stable', new Date(2026, 11, 31, 23, 59, 59))).toBe('stable-20261231-235959');
  });

  it('copies the whole folder and verifies files and sizes', () => {
    const dataDir = seedData('dev', { 'burrow.db': 'abc', 'sub/deep/x.txt': 'hello' });
    const backupDir = path.join(tmp, 'b', 'dev-1');
    expect(backupDataDir({ dataDir, backupDir, integrity: () => ['ok'] })).toEqual({ files: 2, bytes: 8 });
    expect(fs.existsSync(`${backupDir}.partial`)).toBe(false);
    expect(fs.readFileSync(path.join(backupDir, 'sub', 'deep', 'x.txt'), 'utf8')).toBe('hello');
  });

  it('fails the check when the copy differs, and never merges into an existing folder', () => {
    const dataDir = seedData('dev', { 'burrow.db': 'abc' });
    const backupDir = path.join(tmp, 'b', 'dev-2');
    const fake = {
      ...fs,
      cpSync: (src, dest, opts) => {
        fs.cpSync(src, dest, opts);
        fs.writeFileSync(path.join(dest, 'burrow.db'), 'truncated-different');
      },
    };
    expect(() => backupDataDir({ dataDir, backupDir, fs: fake, integrity: () => ['ok'] })).toThrow(/Backup check failed/);
    expect(fs.existsSync(backupDir)).toBe(false);
    fs.mkdirSync(backupDir);
    expect(() => backupDataDir({ dataDir, backupDir, integrity: () => ['ok'] })).toThrow(/already exists/);
  });

  it('catches a same-size corruption by sha256 and stops before the installer', async () => {
    const dataDir = seedData('dev', { 'burrow.db': 'abc', 'other.txt': 'zzz' });
    const fake = {
      ...fs,
      cpSync: (src, dest, opts) => {
        fs.cpSync(src, dest, opts);
        fs.writeFileSync(path.join(dest, 'other.txt'), 'zzy');
      },
    };
    expect(() => backupDataDir({ dataDir, backupDir: path.join(tmp, 'b', 'dev-3'), fs: fake, integrity: () => ['ok'] })).toThrow(/other\.txt differs in sha256/);
    const run = makeDeps({ fs: fake });
    seedData('dev');
    await expect(runInstall(parseCliArgs(['--yes']), run.deps)).rejects.toThrow(/Backup check failed/);
    expect(run.state.calls.some(([f]) => f.endsWith('.exe'))).toBe(false);
  });

  it('refuses a non-ok integrity_check and never renames the partial copy', () => {
    const dataDir = seedData('dev', { 'burrow.db': 'abc' });
    const backupDir = path.join(tmp, 'b', 'dev-4');
    expect(() => backupDataDir({ dataDir, backupDir, integrity: () => ['row 1 missing from index'] })).toThrow(/integrity_check/);
    expect(fs.existsSync(backupDir)).toBe(false);
    expect(fs.existsSync(`${backupDir}.partial`)).toBe(true);
  });

  it('runs a real PRAGMA integrity_check on a copied database and refuses a damaged one', () => {
    const dataDir = path.join(tmp, 'data-real');
    fs.mkdirSync(dataDir, { recursive: true });
    const live = new DatabaseSync(path.join(dataDir, 'burrow.db'));
    live.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES (\'a\');');
    live.close();
    const good = path.join(tmp, 'b', 'dev-5');
    expect(backupDataDir({ dataDir, backupDir: good }).files).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(good, 'burrow.db-shm'))).toBe(false);
    expect(integrityCheckFile(path.join(good, 'burrow.db'))).toEqual(['ok']);
    fs.writeFileSync(path.join(dataDir, 'burrow.db'), Buffer.alloc(8192, 7));
    expect(() => backupDataDir({ dataDir, backupDir: path.join(tmp, 'b', 'dev-6') })).toThrow(/integrity_check/);
  });

  it('keeps the newest 10 per channel and leaves everything else alone', () => {
    const rootDir = path.join(tmp, 'backups');
    const mk = (name) => fs.mkdirSync(path.join(rootDir, name), { recursive: true });
    for (let i = 1; i <= 12; i += 1) mk(`dev-202610${String(i).padStart(2, '0')}-010101`);
    for (let i = 1; i <= 3; i += 1) mk(`stable-202610${String(i).padStart(2, '0')}-010101`);
    mk('dev-notes');
    fs.writeFileSync(path.join(rootDir, 'dev-20260101-000000'), 'a file, not a folder');
    mk('dev-20261105-010101.partial');
    const removed = pruneBackups({ root: rootDir, channel: 'dev' });
    expect(removed).toEqual(['dev-20261002-010101', 'dev-20261001-010101']);
    expect(fs.existsSync(path.join(rootDir, 'dev-20261105-010101.partial'))).toBe(true);
    const left = fs.readdirSync(rootDir);
    expect(left.filter((n) => /^dev-\d{8}-\d{6}$/.test(n) && fs.statSync(path.join(rootDir, n)).isDirectory())).toHaveLength(10);
    expect(left.filter((n) => n.startsWith('stable-'))).toHaveLength(3);
    expect(left).toContain('dev-notes');
    expect(left).toContain('dev-20260101-000000');
    expect(pruneBackups({ root: rootDir, channel: 'dev', keep: 0, protect: 'dev-20261012-010101' })).not.toContain('dev-20261012-010101');
  });

  it('prunes after a real install', async () => {
    seedData('dev');
    const rootDir = path.join(env.LOCALAPPDATA, 'burrow-release', 'data-backups');
    for (let i = 1; i <= 10; i += 1) fs.mkdirSync(path.join(rootDir, `dev-202601${String(i).padStart(2, '0')}-000000`), { recursive: true });
    const { deps, state } = makeDeps();
    state.installedVersion = '0.2.0.1008';
    await runInstall(parseCliArgs(['--yes']), deps);
    const dirs = fs.readdirSync(rootDir).filter((n) => n.startsWith('dev-'));
    expect(dirs).toHaveLength(10);
    expect(dirs).toContain('dev-20261007-080503');
    expect(dirs).not.toContain('dev-20260101-000000');
  });
});

describe('stable from latest', () => {
  const name = 'Burrow-Setup-arm64.exe';
  const sums = (hash, other = 'b'.repeat(64)) => `${hash}  ${name}\n${other}  Burrow-Setup-x64.exe\n`;
  const makeFetch = (installerBytes, sumsText) =>
    vi.fn(async (url) => {
      const body = url.endsWith('SHA256SUMS.txt') ? Buffer.from(sumsText) : installerBytes;
      return { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
    });

  it('dry run plans from the checksums file only and downloads no installer', async () => {
    seedData('stable');
    const fetchFn = makeFetch(MZ, sums(sha(MZ)));
    const { deps, state } = makeDeps({ fetchFn });
    await runInstall(parseCliArgs(['--channel', 'stable', '--from', 'latest']), deps);
    expect(fetchFn.mock.calls.map((c) => c[0])).toEqual(['https://github.com/ChristianMunoz31/burrow-releases/releases/latest/download/SHA256SUMS.txt']);
    const text = state.logs.join('\n');
    expect(text).toContain(`https://github.com/ChristianMunoz31/burrow-releases/releases/latest/download/${name}`);
    expect(text).toContain(sha(MZ));
    expect(text).toContain(path.join(env.LOCALAPPDATA, 'Burrow'));
    expect(text).toContain('Burrow.exe');
    expect(text).toContain('stable-20261007-080503');
    expect(text).not.toContain('Burrow Dev');
    expect(fs.existsSync(path.join(env.LOCALAPPDATA, 'burrow-release'))).toBe(false);
  });

  it('installs a verified download, expects the installer PE version, and cleans up', async () => {
    seedData('stable');
    seedData('dev', { 'burrow.db': 'dev-data' });
    const { deps, state } = makeDeps({ fetchFn: makeFetch(MZ, sums(sha(MZ))) });
    state.installedVersion = '0.1.0';
    state.installerVersion = '0.1.0';
    const result = await runInstall(parseCliArgs(['--channel', 'stable', '--from', 'latest', '--yes']), deps);
    expect(result).toMatchObject({ installed: true, version: '0.1.0' });
    expect(result.backupDir).toContain('stable-20261007-080503');
    expect(fs.existsSync(path.join(env.LOCALAPPDATA, 'burrow-release', 'downloads', 'stable-20261007-080503'))).toBe(false);
    expect(fs.readFileSync(path.join(env.APPDATA, 'Burrow Dev', 'burrow.db'), 'utf8')).toBe('dev-data');
  });

  it('refuses a sha256 mismatch before closing, backing up or installing', async () => {
    seedData('stable');
    const { deps, state } = makeDeps({ fetchFn: makeFetch(MZ, sums('e'.repeat(64))) });
    await expect(runInstall(parseCliArgs(['--channel', 'stable', '--from', 'latest', '--yes']), deps)).rejects.toThrow(/sha256 mismatch/);
    expect(state.calls.some(([f]) => f === 'taskkill' || f.endsWith('.exe'))).toBe(false);
    expect(fs.existsSync(path.join(env.LOCALAPPDATA, 'burrow-release', 'data-backups'))).toBe(false);
  });

  it('refuses when the sums file has no line for this arch, or a failed download', async () => {
    const noLine = makeDeps({ fetchFn: makeFetch(MZ, `${'a'.repeat(64)}  Burrow-Setup-x64.exe\n`) });
    await expect(runInstall(parseCliArgs(['--channel', 'stable', '--from', 'latest']), noLine.deps)).rejects.toThrow(/no entry for Burrow-Setup-arm64\.exe/);
    const down = makeDeps({ fetchFn: vi.fn(async () => ({ ok: false, status: 404 })) });
    await expect(runInstall(parseCliArgs(['--channel', 'stable', '--from', 'latest']), down.deps)).rejects.toThrow(/Download failed \(404\)/);
  });

  it('refuses a downloaded file that is not an executable even when the hash matches', async () => {
    seedData('stable');
    const bad = Buffer.from('<html>not found</html>');
    const { deps } = makeDeps({ fetchFn: makeFetch(bad, sums(sha(bad))) });
    await expect(runInstall(parseCliArgs(['--channel', 'stable', '--from', 'latest', '--yes']), deps)).rejects.toThrow(/MZ/);
  });

  it('uses the x64 name on an x64 host', async () => {
    const fetchFn = makeFetch(MZ, sums(sha(MZ), sha(MZ)));
    const { deps, state } = makeDeps({ fetchFn, arch: 'x64' });
    await runInstall(parseCliArgs(['--channel', 'stable', '--from', 'latest']), deps);
    expect(state.logs.join('\n')).toContain('Burrow-Setup-x64.exe');
  });
});

describe('stable from a local installer', () => {
  it('checks MZ, prints the sha256 and expects its PE version', async () => {
    const file = path.join(tmp, 'Burrow-Setup-arm64.exe');
    fs.writeFileSync(file, MZ);
    const { deps, state } = makeDeps();
    state.installerVersion = '0.3.0';
    await runInstall(parseCliArgs(['--channel', 'stable', '--from', file]), deps);
    const text = state.logs.join('\n');
    expect(text).toContain(sha(MZ));
    expect(text).toContain('0.3.0');
  });

  it('refuses a missing file, a non-exe, an unreadable PE version and a dev installer name', async () => {
    const { deps, state } = makeDeps();
    const missing = path.join(tmp, 'missing.exe');
    await expect(runInstall(parseCliArgs(['--channel', 'stable', '--from', missing]), deps)).rejects.toThrow(/not found/);
    const text = path.join(tmp, 'notes.exe');
    fs.writeFileSync(text, 'hello');
    await expect(runInstall(parseCliArgs(['--channel', 'stable', '--from', text]), deps)).rejects.toThrow(/MZ/);
    const good = path.join(tmp, 'Burrow-Setup-arm64.exe');
    fs.writeFileSync(good, MZ);
    state.installerVersion = '';
    deps.peVersion = vi.fn(async () => null);
    await expect(runInstall(parseCliArgs(['--channel', 'stable', '--from', good]), deps)).rejects.toThrow(/PE version/);
    const dev = path.join(tmp, DEV_NAME);
    fs.writeFileSync(dev, MZ);
    await expect(runInstall(parseCliArgs(['--channel', 'stable', '--from', dev]), makeDeps().deps)).rejects.toThrow(/Dev installer/);
  });

  it('refuses a stable --from installer whose PE version is a dev build', async () => {
    const file = path.join(tmp, 'Burrow-Setup-arm64.exe');
    fs.writeFileSync(file, MZ);
    const { deps, state } = makeDeps();
    state.installerVersion = '0.2.0-dev.20261005+1008';
    await expect(runInstall(parseCliArgs(['--channel', 'stable', '--from', file]), deps)).rejects.toThrow(/Dev build/);
  });

  it('resolves a relative --from against INIT_CWD', async () => {
    fs.writeFileSync(path.join(tmp, 'Burrow-Setup-arm64.exe'), MZ);
    const { deps, state } = makeDeps();
    state.installerVersion = '0.3.0';
    deps.env = { ...env, INIT_CWD: tmp };
    await runInstall(parseCliArgs(['--channel', 'stable', '--from', 'Burrow-Setup-arm64.exe']), deps);
    expect(state.logs.join('\n')).toContain(path.join(tmp, 'Burrow-Setup-arm64.exe'));
  });

  it('refuses when the installed version differs from the installer version', async () => {
    seedData('stable');
    const file = path.join(tmp, 'Burrow-Setup-arm64.exe');
    fs.writeFileSync(file, MZ);
    const { deps, state } = makeDeps();
    state.installerVersion = '0.3.0';
    state.installedVersion = '0.2.0';
    await expect(runInstall(parseCliArgs(['--channel', 'stable', '--from', file, '--yes']), deps)).rejects.toThrow(/reports version 0\.2\.0, expected 0\.3\.0/);
  });
});

describe('the other channel is never touched', () => {
  const touched = (state, names) => state.calls.flat().some((a) => names.some((n) => String(a).includes(n)));

  it('a dev install leaves stable data, backups and processes alone', async () => {
    const stableData = seedData('stable', { 'burrow.db': 'stable-data', 'x/y.txt': 'y' });
    seedData('dev');
    const snapshot = () => JSON.stringify([...fs.readdirSync(stableData, { recursive: true })].sort());
    const before = snapshot();
    const { deps, state } = makeDeps();
    state.running.add('Burrow.exe');
    state.installedVersion = '0.2.0.1008';
    await runInstall(parseCliArgs(['--yes']), deps);
    expect(snapshot()).toBe(before);
    expect(fs.readFileSync(path.join(stableData, 'burrow.db'), 'utf8')).toBe('stable-data');
    expect(state.running.has('Burrow.exe')).toBe(true);
    expect(touched(state, ['Burrow.exe', 'burrow-server.exe', 'taskkill'])).toBe(false);
    expect(fs.readdirSync(path.join(env.LOCALAPPDATA, 'burrow-release', 'data-backups')).every((n) => n.startsWith('dev-'))).toBe(true);
  });

  it('a stable install leaves dev data, dev backups and dev processes alone', async () => {
    seedData('stable');
    const devData = seedData('dev', { 'burrow.db': 'dev-data' });
    const rootDir = path.join(env.LOCALAPPDATA, 'burrow-release', 'data-backups');
    for (let i = 1; i <= 12; i += 1) fs.mkdirSync(path.join(rootDir, `dev-202601${String(i).padStart(2, '0')}-000000`), { recursive: true });
    const file = path.join(tmp, 'Burrow-Setup-arm64.exe');
    fs.writeFileSync(file, MZ);
    const { deps, state } = makeDeps();
    state.running.add('BurrowDev.exe');
    state.installerVersion = '0.3.0';
    state.installedVersion = '0.3.0';
    await runInstall(parseCliArgs(['--channel', 'stable', '--from', file, '--yes']), deps);
    expect(fs.readFileSync(path.join(devData, 'burrow.db'), 'utf8')).toBe('dev-data');
    expect(fs.readdirSync(rootDir).filter((n) => n.startsWith('dev-'))).toHaveLength(12);
    expect(state.running.has('BurrowDev.exe')).toBe(true);
    expect(touched(state, ['BurrowDev.exe', 'burrow-dev-server.exe', 'Burrow Dev'])).toBe(false);
  });

  it('refuses before doing anything if the identities were ever to overlap', async () => {
    fs.writeFileSync(
      path.join(root, 'src-tauri', 'tauri.dev.conf.json'),
      JSON.stringify({ productName: 'Burrow', mainBinaryName: 'Burrow', identifier: 'com.burrow.desktop.dev', bundle: { externalBin: ['binaries/burrow-dev-server'] } }),
    );
    const { deps, state } = makeDeps();
    await expect(runInstall(parseCliArgs(['--yes']), deps)).rejects.toThrow(/overlaps|refusing/);
    expect(state.calls).toHaveLength(0);
  });
});

describe('parseSums', () => {
  it('reads sha256sum lines (with or without the binary star) and rejects junk', () => {
    const map = parseSums(`${'a'.repeat(64)}  one.exe\n${'B'.repeat(64)} *two.exe\n`);
    expect(map.get('one.exe')).toBe('a'.repeat(64));
    expect(map.get('two.exe')).toBe('b'.repeat(64));
    expect(() => parseSums('nonsense')).toThrow(/Malformed/);
  });
});
