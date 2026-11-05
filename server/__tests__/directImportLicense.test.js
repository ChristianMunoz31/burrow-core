// Trial and license across the two editions (docs/LICENSING.md, "Moving from the direct Burrow to the Microsoft Store build"):
// a new data folder starts a new trial, the userprofile data location never reads or clears the AppData records, and the
// import carries the records over unchanged (no new trial, no activation call).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { openDb } from '../db/index.js';
import { resolveDataDir } from '../paths.js';
import { createActivationStore } from '../license/activationStore.js';
import { createTrialStore } from '../license/trialStore.js';
import { loadOrCreateKeyFile } from '../secrets/keyFile.js';

const tmpDirs = [];
const DAY = 24 * 60 * 60 * 1000;
const T0 = Math.floor(Date.parse('2026-09-01T12:00:00Z') / 1000) * 1000;
const T1 = T0 + 20 * DAY;
const ACTIVATION = {
  store: 'gumroad',
  productId: 'prod_synthetic',
  variantId: null,
  edition: 'standard',
  purchaseDate: '2026-01-02T00:00:00Z',
  updatesUntil: '2027-01-02T00:00:00Z',
  expiresAt: null,
  activatedAt: '2026-01-03T00:00:00Z',
  keyHash: 'h'.repeat(43),
  keyLast4: 'ABCD',
  email: null,
  instanceId: null,
  test: false,
};

afterAll(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function fakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-lic-'));
  tmpDirs.push(home);
  const env = { USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming') };
  return { home, env };
}

const stores = (dir, db = null, now = T1) => {
  const loadKey = () => loadOrCreateKeyFile({ dir });
  return {
    trial: createTrialStore({ dataDir: dir, getDb: () => db, loadKey, now: () => now, log: () => {} }),
    activation: createActivationStore({ dataDir: dir, getDb: () => db, loadKey, now: () => now, log: () => {} }),
  };
};

const files = (dir) => Object.fromEntries(fs.readdirSync(dir).map((n) => [n, fs.readFileSync(path.join(dir, n), 'utf8')]));

describe.runIf(process.platform === 'win32')('switching from the direct Burrow to the Store build without importing', () => {
  it('starts a NEW trial in the new folder and leaves the AppData records alone (same as wiping the data folder)', () => {
    const { home, env } = fakeHome();
    const storeEnv = { ...env, BURROW_DISTRIBUTION: 'store', BURROW_DATA_LOCATION: 'userprofile' };
    const direct = resolveDataDir({ platform: 'win32', env, home, channel: 'stable' });
    const store = resolveDataDir({ platform: 'win32', env: storeEnv, home, channel: 'stable' });
    expect(direct).not.toBe(store);
    fs.mkdirSync(direct, { recursive: true });
    fs.mkdirSync(store, { recursive: true });

    // The direct Burrow: a trial started 20 days ago (so it is over) and an activation.
    const old = stores(direct, null, T0);
    expect(old.trial.start(T0)).toBe(true);
    expect(old.activation.save(ACTIVATION)).not.toBeNull();
    const directBefore = files(direct);

    // The Store build in its own folder: nothing there, so a trial starts now.
    const fresh = stores(store, null, T1);
    expect(fresh.trial.load()).toEqual({ kind: 'none' });
    expect(fresh.activation.load()).toEqual({ kind: 'none' });
    expect(fresh.trial.start(T1)).toBe(true);
    expect(fresh.trial.load()).toMatchObject({ kind: 'valid', startedAt: T1 });
    expect(fresh.trial.load().startedAt).not.toBe(T0);

    // It never read or cleared the AppData records: byte for byte the same, still valid there.
    expect(files(direct)).toEqual(directBefore);
    expect(old.trial.load()).toMatchObject({ kind: 'valid', startedAt: T0 });
    expect(old.activation.load().kind).toBe('active');
    // And the new folder has its own key: the two editions do not share a MAC key.
    expect(fs.readFileSync(path.join(store, 'secrets.key'), 'utf8')).not.toBe(fs.readFileSync(path.join(direct, 'secrets.key'), 'utf8'));
  });
});

describe('the records inside a folder travel with the folder (what the import relies on)', () => {
  it('a copied folder (files and database rows, with secrets.key) keeps the same trial start and the same activation', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network'));
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-lic-src-'));
    const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-lic-dst-'));
    tmpDirs.push(src, dst);
    const srcDb = openDb({ filename: path.join(src, 'burrow.db') });
    const s = stores(src, srcDb, T0);
    s.trial.start(T0);
    s.activation.save(ACTIVATION);
    srcDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    srcDb.close();
    // What the import copies: the files, the key and the database (here a plain copy of the closed file).
    for (const name of ['secrets.key', 'license-trial.json', 'license-activation.json', 'burrow.db']) fs.copyFileSync(path.join(src, name), path.join(dst, name));
    const dstDb = openDb({ filename: path.join(dst, 'burrow.db') });
    const d = stores(dst, dstDb, T1);
    expect(d.trial.load()).toMatchObject({ kind: 'valid', startedAt: T0 });
    expect(d.trial.start(T1)).toBe(false); // an existing record is never replaced
    const activation = d.activation.load();
    expect(activation.kind).toBe('active');
    expect(activation.record).toMatchObject({ productId: ACTIVATION.productId, instanceId: null });
    dstDb.close();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('without the copied secrets.key the same records do NOT verify (why the key is required)', () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-lic-src-'));
    const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-lic-dst-'));
    tmpDirs.push(src, dst);
    const s = stores(src, null, T0);
    s.trial.start(T0);
    s.activation.save(ACTIVATION);
    fs.copyFileSync(path.join(src, 'license-trial.json'), path.join(dst, 'license-trial.json'));
    fs.copyFileSync(path.join(src, 'license-activation.json'), path.join(dst, 'license-activation.json'));
    const d = stores(dst, null, T1); // creates its own, different key
    expect(d.trial.load()).toEqual({ kind: 'used' });
    expect(d.activation.load()).toMatchObject({ kind: 'invalid' });
  });
});
