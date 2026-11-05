// Burrow Dev isolation guarantees that cut across modules: Dev and stable data folders never coincide,
// trial and clock records stay per data folder (and the copy does not import stable's), store test purchases
// tell a stable bundle from a dev one, and the real server in each channel behaves as documented.
// Temp folders only.
import crypto, { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildBackupWorkerSource, bundleDefine, channelBanner, BUNDLE_BANNER } from '../../scripts/desktop/workerBundle.js';
import { copyFromStable } from '../backup/stableCopy.js';
import { dataFolderName, resolveDataDir, resolveStableDataDir } from '../paths.js';
import { getDb, insertMany, openDb, select, upsert } from '../db/index.js';
import { CLOCK_STATE_KEY, TRIAL_FILE_NAME, TRIAL_STATE_KEY } from '../license/constants.js';
import { createTrialStore } from '../license/trialStore.js';
import { RESTORE_CARRY_KEYS } from '../backup/restore.js';
import { cleanupBackupEnv, dataDir, resetBackupEnv } from './helpers/backupEnv.js';
import { childEnv } from './helpers/childEnv.js';
import { hasPrivateFile } from './helpers/privateFiles.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// A dev bundle needs devtools/, which is private-only (not in the public core export): the dev case is skipped without it.
const CHANNELS_WITH_BUNDLE = ['stable', ...(hasPrivateFile('devtools/server/static.js') ? ['dev'] : [])];
const DISPLAY = '0.2.0-dev.20261005.abc1234';
const tmpDirs = [];
const mk = (label) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `burrow-iso-${label}-`));
  tmpDirs.push(dir);
  return dir;
};
const rm = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
afterAll(() => {
  cleanupBackupEnv();
  for (const dir of tmpDirs.splice(0)) rm(dir);
});

/** Recursive name + size + sha256 listing. */
function listing(dir) {
  const out = {};
  const walk = (cur) => {
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, e.name);
      const rel = path.relative(dir, full);
      if (e.isDirectory()) {
        out[`${rel}/`] = 'dir';
        walk(full);
      } else {
        const bytes = fs.readFileSync(full);
        out[rel] = `${bytes.length}:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
      }
    }
  };
  walk(dir);
  return out;
}

describe('the Dev data folder is never the stable one', () => {
  const HOMES = {
    win32: { home: 'C:\\Users\\tester', envs: [{ APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' }, {}, { APPDATA: 'D:\\Roam' }] },
    darwin: { home: '/Users/tester', envs: [{}, { XDG_DATA_HOME: '/x' }] },
    linux: { home: '/home/tester', envs: [{}, { XDG_DATA_HOME: '/x' }, { XDG_DATA_HOME: '/x/' }, { XDG_DATA_HOME: '' }] },
  };

  for (const [platform, { home, envs }] of Object.entries(HOMES)) {
    it(`${platform}: dev and stable differ for every env, and the folder names follow the channel`, () => {
      for (const env of envs) {
        const dev = resolveDataDir({ platform, env, home, channel: 'dev' });
        const stable = resolveDataDir({ platform, env, home, channel: 'stable' });
        expect(dev).not.toBe(stable);
        expect(dev.toLowerCase()).not.toBe(stable.toLowerCase());
        // Neither folder sits inside the other.
        expect(dev.startsWith(stable + path.sep) || dev.startsWith(`${stable}/`)).toBe(false);
        expect(stable.startsWith(dev + path.sep) || stable.startsWith(`${dev}/`)).toBe(false);
        expect(dev.endsWith(dataFolderName('dev', platform))).toBe(true);
      }
    });
  }

  it('BURROW_DATA_DIR still wins in both channels and the stable lookup ignores it', () => {
    const env = { BURROW_DATA_DIR: 'some-temp-dir', APPDATA: 'C:\\A' };
    expect(resolveDataDir({ platform: 'win32', env, home: 'C:\\h', channel: 'dev' })).toBe(path.resolve('some-temp-dir'));
    expect(resolveDataDir({ platform: 'win32', env, home: 'C:\\h', channel: 'stable' })).toBe(path.resolve('some-temp-dir'));
    const stable = resolveStableDataDir({ platform: 'win32', env, home: 'C:\\h' });
    expect(stable).toEqual({ dir: 'C:\\A\\Burrow', overridden: false });
  });

  it('the stable lookup honours BURROW_STABLE_DATA_DIR only, and never resolves to the Dev folder', () => {
    const env = { APPDATA: 'C:\\A', BURROW_CHANNEL: 'dev' };
    const stable = resolveStableDataDir({ platform: 'win32', env, home: 'C:\\h' });
    const dev = resolveDataDir({ platform: 'win32', env, home: 'C:\\h' });
    expect(stable.dir).not.toBe(dev);
    expect(resolveStableDataDir({ platform: 'win32', env: { ...env, BURROW_STABLE_DATA_DIR: '  ' }, home: 'C:\\h' }).overridden).toBe(false);
  });
});

describe('trial and clock records stay per data folder', () => {
  const T0 = Math.floor(Date.UTC(2026, 9, 5) / 1000) * 1000;
  const storeFor = (dir, db, ikm) =>
    createTrialStore({ dataDir: dir, getDb: () => db, loadKey: () => ({ ok: true, key: ikm }), now: () => T0, log: () => {} });

  it('a trial started in the Dev folder is invisible to a fresh stable folder', () => {
    const devDir = mk('trial-dev');
    const stableDir = mk('trial-stable');
    const devDb = openDb({ filename: path.join(devDir, 'burrow.db') });
    const stableDb = openDb({ filename: path.join(stableDir, 'burrow.db') });
    try {
      expect(storeFor(devDir, devDb, randomBytes(32)).start(T0)).toBe(true);
      expect(fs.existsSync(path.join(devDir, TRIAL_FILE_NAME))).toBe(true);
      // Fresh stable folder: no file, no row, so the trial is available there.
      expect(fs.existsSync(path.join(stableDir, TRIAL_FILE_NAME))).toBe(false);
      expect(select('app_state', { where: { key: TRIAL_STATE_KEY }, db: stableDb })).toEqual([]);
      expect(storeFor(stableDir, stableDb, randomBytes(32)).load()).toEqual({ kind: 'none' });
    } finally {
      devDb.close();
      stableDb.close();
    }
  });

  describe('through the copy', () => {
    beforeEach(() => {
      resetBackupEnv();
    });
    const state = (db, key) => select('app_state', { where: { key }, db })[0]?.value;
    const stableWith = (rows) => {
      const dir = mk('copy-stable');
      const db = openDb({ filename: path.join(dir, 'burrow.db') });
      insertMany('notes', [{ body: 'from-stable' }], { db });
      for (const [key, value] of rows) upsert('app_state', { key, value, updated_at: '2026-01-01T00:00:00.000Z' }, { conflict: ['key'], db });
      return { dir, db };
    };

    it('the carried keys include the license clock and trial rows', () => {
      expect(RESTORE_CARRY_KEYS).toContain(TRIAL_STATE_KEY);
      expect(RESTORE_CARRY_KEYS).toContain(CLOCK_STATE_KEY);
    });

    it('stable trial and clock never arrive; Dev with none stays with none', async () => {
      const { dir, db } = stableWith([
        [TRIAL_STATE_KEY, { v: 1, startedAt: T0, endsAt: T0 + 1, mac: 'x'.repeat(43) }],
        [CLOCK_STATE_KEY, { v: 1, hwm: T0 + 5000, mac: 'y'.repeat(43) }],
      ]);
      fs.writeFileSync(path.join(dir, TRIAL_FILE_NAME), '{"stable":true}\n');
      fs.writeFileSync(path.join(dir, 'license-clock.json'), '{"stable":true}\n');
      fs.writeFileSync(path.join(dir, 'secrets.key'), 'stable-key-material');
      db.close();
      const before = listing(dir);

      await copyFromStable({ stable: { dir, overridden: true }, retryDelayMs: 1 });

      expect(listing(dir)).toEqual(before);
      expect(select('notes').map((n) => n.body)).toEqual(['from-stable']);
      const live = getDb();
      expect(state(live, TRIAL_STATE_KEY)).toBeUndefined();
      expect(state(live, CLOCK_STATE_KEY)).toBeUndefined();
      // The copy is database-only: no stable file crossed over.
      const names = fs.readdirSync(dataDir());
      for (const n of [TRIAL_FILE_NAME, 'license-clock.json', 'secrets.key', 'license.burrowlicense']) {
        expect(names).not.toContain(n);
      }
    });

    it("Dev's own trial and clock rows survive, and its own trial file stays untouched", async () => {
      const live = getDb();
      const ownTrial = { v: 1, startedAt: T0, endsAt: T0 + 7 * 86400000, mac: 'd'.repeat(43) };
      const ownClock = { v: 1, hwm: T0 + 9000, mac: 'c'.repeat(43) };
      upsert('app_state', { key: TRIAL_STATE_KEY, value: ownTrial, updated_at: '2026-01-01T00:00:00.000Z' }, { conflict: ['key'], db: live });
      upsert('app_state', { key: CLOCK_STATE_KEY, value: ownClock, updated_at: '2026-01-01T00:00:00.000Z' }, { conflict: ['key'], db: live });
      const devFile = path.join(dataDir(), TRIAL_FILE_NAME);
      fs.writeFileSync(devFile, '{"dev":true}\n');

      const { dir, db } = stableWith([
        [TRIAL_STATE_KEY, { v: 1, startedAt: T0 - 1000, endsAt: T0, mac: 's'.repeat(43) }],
        [CLOCK_STATE_KEY, { v: 1, hwm: 1, mac: 't'.repeat(43) }],
      ]);
      db.close();

      await copyFromStable({ stable: { dir, overridden: true }, retryDelayMs: 1 });

      const after = getDb();
      expect(state(after, TRIAL_STATE_KEY)).toEqual(ownTrial);
      expect(state(after, CLOCK_STATE_KEY)).toEqual(ownClock);
      expect(fs.readFileSync(devFile, 'utf8')).toBe('{"dev":true}\n');
      expect(select('notes').map((n) => n.body)).toEqual(['from-stable']);
    });
  });
});

describe('store test purchases tell stable from dev bundles', () => {
  async function bundle(dir, name, define) {
    const file = path.join(dir, name);
    await build({
      entryPoints: [path.join(ROOT, 'server', 'license', 'channelSeam.js')],
      outfile: file,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      logLevel: 'silent',
      define,
      banner: { js: channelBanner(define.__BURROW_CHANNEL__ === '"dev"' ? 'dev' : 'stable') + BUNDLE_BANNER },
    });
    return file;
  }

  it('a stable sidecar-like bundle refuses store test purchases, even with the env switch and a dev channel variable', async () => {
    const file = await bundle(mk('seam-stable'), 'server.cjs', bundleDefine('0.1.0'));
    const seam = createRequire(import.meta.url)(file);
    expect(seam.allowStoreTestPurchases({ BURROW_LICENSE_STORE_TEST: '1', BURROW_CHANNEL: 'dev' })).toBe(false);
    expect(seam.allowStoreTestPurchases({ BURROW_CHANNEL: 'dev', BURROW_DESKTOP: '1' })).toBe(false);
  }, 60_000);

  it('a dev sidecar-like bundle accepts store test purchases', async () => {
    const file = await bundle(mk('seam-dev'), 'server.cjs', bundleDefine(DISPLAY, { channel: 'dev' }));
    const seam = createRequire(import.meta.url)(file);
    expect(seam.allowStoreTestPurchases({ BURROW_DESKTOP: '1' })).toBe(true);
  }, 60_000);

  it.each(CHANNELS_WITH_BUNDLE)('the %s backup worker bundle embeds no developer keys', async (channel) => {
    const src = await buildBackupWorkerSource({ channel, version: channel === 'dev' ? DISPLAY : '0.1.0' });
    expect(src).not.toContain('__BURROW_EMBEDDED_DEV_KEYS__');
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// The real server process, in each channel (desktop mode, like the shipped sidecar).
// ---------------------------------------------------------------------------------------------
describe('real server: Dev and stable channels over HTTP', () => {
  const SERVER = path.join(ROOT, 'server.js');
  const READY_RE = /^BURROW_READY (\{.*\})$/m;

  async function launch({ channel, dataDirPath, stableDir }) {
    const distDir = mk('e2e-dist');
    fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><html><body>ok</body></html>');
    const secret = randomBytes(32);
    const env = {
      BURROW_DESKTOP: '1',
      BURROW_HOST: '127.0.0.1',
      BURROW_PORT: '0',
      BURROW_NO_DOTENV: '1',
      BURROW_DATA_DIR: dataDirPath,
      BURROW_STABLE_DATA_DIR: stableDir,
      BURROW_DIST_DIR: distDir,
      BURROW_SCHEDULER: '0',
    };
    if (channel) env.BURROW_CHANNEL = channel;
    const child = spawn(process.execPath, [SERVER], { cwd: ROOT, env: childEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.stdin.write(`${secret.toString('hex')}\n`);
    let ready;
    const start = Date.now();
    while (!ready && Date.now() - start < 20_000) {
      const m = READY_RE.exec(out);
      if (m) ready = JSON.parse(m[1]);
      else await new Promise((r) => setTimeout(r, 50));
    }
    if (!ready) {
      child.kill();
      throw new Error(`server did not start: ${out.slice(0, 500)}`);
    }
    const base = `http://127.0.0.1:${ready.port}`;
    const token = crypto.createHmac('sha256', secret).update('burrow-bootstrap-v1').digest('hex');
    const boot = await fetch(`${base}/desktop/bootstrap?token=${token}`, { redirect: 'manual' });
    const cookie = boot.headers.get('set-cookie').split(';')[0];
    const call = (method, p, body) =>
      fetch(`${base}${p}`, {
        method,
        headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const stop = async () => {
      if (child.exitCode !== null) return;
      const exited = new Promise((r) => child.once('exit', r));
      child.stdin.end();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
      if (child.exitCode === null) child.kill();
    };
    return { call, stop, out: () => out };
  }

  function seedStable() {
    const dir = mk('e2e-stable');
    const db = openDb({ filename: path.join(dir, 'burrow.db') });
    insertMany('notes', [{ body: 'synthetic-one' }, { body: 'synthetic-two' }, { body: 'synthetic-three' }], { db });
    db.close();
    return dir;
  }
  const bodies = async (res) => {
    const json = await res.json();
    const rows = Array.isArray(json) ? json : (json.data ?? json.notes ?? []);
    return rows.map((n) => n.body).sort();
  };

  it('dev: GET then POST copies the rows into Dev and leaves the stable folder byte-identical', async () => {
    const stableDir = seedStable();
    const devDir = mk('e2e-dev');
    const before = listing(stableDir);
    const proc = await launch({ channel: 'dev', dataDirPath: devDir, stableDir });
    try {
      const info = await (await proc.call('GET', '/api/app/info')).json();
      expect(info.data.channel).toBe('dev');
      expect(info.data.desktop).toBe(true);
      expect(info.data.version).toBeTruthy();
      expect(proc.out()).toContain('copy source overridden by BURROW_STABLE_DATA_DIR');

      expect(await bodies(await proc.call('GET', '/api/notes'))).toEqual([]);

      const status = await proc.call('GET', '/api/backups/stable-copy');
      expect(status.status).toBe(200);
      expect((await status.json()).data).toMatchObject({ found: true, dataDir: stableDir, overridden: true, busy: false, sameFolder: false });

      const done = await proc.call('POST', '/api/backups/stable-copy', { confirm: true });
      expect(done.status).toBe(200);
      const result = (await done.json()).data;
      expect(result).toMatchObject({ copiedFrom: stableDir });
      expect(result.totalRows).toBeGreaterThanOrEqual(3);

      expect(await bodies(await proc.call('GET', '/api/notes'))).toEqual(['synthetic-one', 'synthetic-three', 'synthetic-two']);
      expect(listing(stableDir)).toEqual(before);
    } finally {
      await proc.stop();
    }
    expect(listing(stableDir)).toEqual(before);
    expect(fs.existsSync(path.join(devDir, 'burrow.db'))).toBe(true);
  }, 60_000);

  it('stable: both stable-copy routes answer 404, app/info says stable, and the folder is untouched', async () => {
    const stableDir = seedStable();
    const dir = mk('e2e-stable-data');
    const before = listing(stableDir);
    const proc = await launch({ channel: undefined, dataDirPath: dir, stableDir });
    try {
      const info = await (await proc.call('GET', '/api/app/info')).json();
      expect(info.data.channel).toBe('stable');
      const get = await proc.call('GET', '/api/backups/stable-copy');
      expect(get.status).toBe(404);
      expect(await get.json()).toEqual({ error: 'not_found' });
      const post = await proc.call('POST', '/api/backups/stable-copy', { confirm: true });
      expect(post.status).toBe(404);
      expect(await bodies(await proc.call('GET', '/api/notes'))).toEqual([]);
      expect(proc.out()).not.toContain('copy source overridden');
    } finally {
      await proc.stop();
    }
    expect(listing(stableDir)).toEqual(before);
  }, 60_000);

  it('an unrecognised BURROW_CHANNEL value (not exactly dev) is stable', async () => {
    // An invalid or empty channel value is stable.
    const stableDir = seedStable();
    const dir = mk('e2e-bogus');
    const proc = await launch({ channel: 'DEV', dataDirPath: dir, stableDir });
    try {
      expect((await proc.call('GET', '/api/backups/stable-copy')).status).toBe(404);
    } finally {
      await proc.stop();
    }
  }, 60_000);
});
