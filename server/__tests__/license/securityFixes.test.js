// Security fixes on store licensing: bounded activation timestamps and tombstones (seat recycler via a
// forward clock), the store test hooks only in a source checkout, test records not unlocking a stable
// desktop or release build, the exclusive lock on remove, and a failed local clear after a store deactivation.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { select, upsert } from '../../db/query.js';
import { createActivationStore } from '../../license/activationStore.js';
import { allowStoreTestPurchases, isSourceCheckout, rejectsTestRecords, storeBaseUrl } from '../../license/channelSeam.js';
import { ACTIVATION_FILE_NAME, ACTIVATION_STATE_KEY } from '../../license/constants.js';
import { evaluateLicense } from '../../license/entitlements.js';
import {
  activateLicense,
  deactivateLicense,
  getEntitlements,
  getLicenseStatus,
  removeLicense,
} from '../../license/index.js';
import { GUMROAD_KEY, LS_KEY, gumroadVerify, lsActivate, queueGumroad, reply } from './fixtures/storeResponses.js';
import { createHarness, DAY, T0, activeOf } from './helpers.js';

let h;
beforeEach(() => {
  h = createHarness();
});
afterEach(() => h.cleanup());

const reloaded = () =>
  createActivationStore({ dataDir: h.dir, getDb: () => h.db, loadKey: () => ({ ok: true, key: h.ikm }), now: () => h.clock.t, log: () => {} }).load();
const filePath = () => path.join(h.dir, ACTIVATION_FILE_NAME);
const putDbCopy = (value) => upsert('app_state', { key: ACTIVATION_STATE_KEY, value, updated_at: new Date(T0).toISOString() }, { conflict: ['key'], db: h.db });
const readDbCopy = () => select('app_state', { columns: ['value'], where: { key: ACTIVATION_STATE_KEY }, db: h.db })[0].value;

describe('M1: a forward wall clock cannot mint a seat recycler', () => {
  async function activateWithFutureClock() {
    h.clock.t = T0 + 365 * DAY;
    h.init();
    queueGumroad(h.fetch);
    await activateLicense({ licenseKey: GUMROAD_KEY });
    const oldFile = fs.readFileSync(filePath(), 'utf8');
    const oldDb = readDbCopy();
    const stored = JSON.parse(oldFile);
    // bounded to the guard high-water mark plus the rollback tolerance, not the +365 d wall clock
    expect(Date.parse(stored.activatedAt)).toBeLessThan(T0 + 7 * DAY);
    h.clock.t = T0 + 1000;
    return { oldFile, oldDb };
  }

  it('remove, then the saved old file copy put back, stays none (both copy orders)', async () => {
    const { oldFile, oldDb } = await activateWithFutureClock();
    await removeLicense();
    const tombstone = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    expect(tombstone.state).toBe('cleared');

    // order 1: old file back, DB keeps the tombstone
    fs.writeFileSync(filePath(), oldFile);
    h.init();
    expect(reloaded()).toEqual({ kind: 'none' });

    // order 2: old DB row back, file keeps the tombstone
    await removeLicense();
    putDbCopy(oldDb);
    h.init();
    expect(reloaded()).toEqual({ kind: 'none' });
    expect(readDbCopy().state).toBe('cleared');
  });

  it('deactivate (Lemon Squeezy) writes a tombstone later than the activation', async () => {
    h.clock.t = T0 + 365 * DAY;
    h.init();
    h.fetch.mockResolvedValueOnce(reply(200, lsActivate()));
    await activateLicense({ licenseKey: LS_KEY });
    const oldFile = fs.readFileSync(filePath(), 'utf8');
    h.clock.t = T0 + 1000;
    h.fetch.mockResolvedValueOnce(reply(200, { deactivated: true }));
    await deactivateLicense();
    fs.writeFileSync(filePath(), oldFile);
    h.init();
    expect(reloaded()).toEqual({ kind: 'none' });
  });
});

describe('M2: store test hooks only in a source checkout', () => {
  const stable = { release: false, devChannel: false };
  const env = { BURROW_LICENSE_STORE_TEST: '1' };

  it('allowStoreTestPurchases truth table with and without a checkout', () => {
    expect(allowStoreTestPurchases(env, { ...stable, checkout: true })).toBe(true);
    expect(allowStoreTestPurchases(env, { ...stable, checkout: false })).toBe(false);
    expect(allowStoreTestPurchases({}, { ...stable, checkout: true })).toBe(false);
    expect(allowStoreTestPurchases({ ...env, BURROW_DESKTOP: '1' }, { ...stable, checkout: true })).toBe(false);
    expect(allowStoreTestPurchases(env, { release: true, devChannel: false, checkout: true })).toBe(false);
    // the Dev channel keeps its own path for test purchases, checkout or not
    expect(allowStoreTestPurchases({}, { release: true, devChannel: true, checkout: false })).toBe(true);
  });

  it('isSourceCheckout counts only a real .git entry (file or folder), never VITEST or another env var', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-checkout-'));
    try {
      expect(process.env.VITEST).toBeTruthy(); // the old shortcut would have said true
      expect(isSourceCheckout(root)).toBe(false);
      fs.writeFileSync(path.join(root, '.git'), 'gitdir: ../elsewhere\n'); // a git worktree has a .git FILE
      expect(isSourceCheckout(root)).toBe(true);
      fs.rmSync(path.join(root, '.git'));
      fs.mkdirSync(path.join(root, '.git'));
      expect(isSourceCheckout(root)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('storeBaseUrl override needs a checkout; a release zip without .git ignores it', () => {
    const logs = [];
    const e = { BURROW_LICENSE_STORE_BASE_URL: 'http://127.0.0.1:4999' };
    expect(storeBaseUrl('gumroad', e, { release: false, checkout: true, log: (m) => logs.push(m) })).toBe('http://127.0.0.1:4999');
    expect(storeBaseUrl('gumroad', e, { release: false, checkout: false, log: (m) => logs.push(m) })).toBe('https://api.gumroad.com');
    expect(logs).toEqual(['license: store base URL override ignored']);
    // a dev channel bundle never gets the base URL override
    expect(storeBaseUrl('gumroad', { ...e, BURROW_DESKTOP: '1', BURROW_CHANNEL: 'dev' }, { release: true, checkout: true, log: () => {} })).toBe('https://api.gumroad.com');
  });

  it('rejectsTestRecords: only desktop or release builds outside the dev channel', () => {
    expect(rejectsTestRecords({}, { release: false, devChannel: false })).toBe(false);
    expect(rejectsTestRecords({ BURROW_DESKTOP: '1' }, { release: false, devChannel: false })).toBe(true);
    expect(rejectsTestRecords({}, { release: true, devChannel: false })).toBe(true);
    expect(rejectsTestRecords({ BURROW_DESKTOP: '1' }, { release: true, devChannel: true })).toBe(false);
  });

  it('evaluateLicense: a test record is free with reason test_purchase when rejected', () => {
    const clock = { now: T0, effective: T0, rollback: false };
    const buildInfo = { buildDate: T0 };
    const activation = activeOf({ test: true });
    expect(evaluateLicense({ activation, buildInfo, clock }).pro).toBe(true);
    const rejected = evaluateLicense({ activation, buildInfo, clock, rejectTestRecords: true });
    expect(rejected).toMatchObject({ pro: false, state: 'free' });
    expect(rejected.reasons).toContain('test_purchase');
    expect(evaluateLicense({ activation: activeOf({ test: false }), buildInfo, clock, rejectTestRecords: true }).pro).toBe(true);
  });

  it('a record minted through the base URL override is stored test:true and does not unlock a stable desktop build', async () => {
    h.init({ env: { BURROW_LICENSE_STORE_BASE_URL: 'http://127.0.0.1:4999' } });
    queueGumroad(h.fetch);
    await activateLicense({ licenseKey: GUMROAD_KEY });
    expect(JSON.parse(fs.readFileSync(filePath(), 'utf8')).test).toBe(true);
    expect(getEntitlements().pro).toBe(true); // the checkout that minted it

    h.init({ env: { BURROW_DESKTOP: '1' } }); // stable desktop app, same data
    expect(getEntitlements()).toMatchObject({ pro: false });
    expect(getEntitlements().reasons).toContain('test_purchase');
    expect(getLicenseStatus().pro).toBe(false);

    h.init({ env: { BURROW_DESKTOP: '1', BURROW_CHANNEL: 'dev' } }); // Burrow Dev keeps its own test purchases
    expect(getEntitlements().pro).toBe(true);
  });

  it('without the override a normal purchase is test:false', async () => {
    h.init();
    h.fetch.mockResolvedValueOnce(reply(200, gumroadVerify()));
    await activateLicense({ licenseKey: GUMROAD_KEY });
    expect(JSON.parse(fs.readFileSync(filePath(), 'utf8')).test).toBe(false);
  });
});

describe('L2: removeLicense shares the exclusive lock', () => {
  it('409 activation_in_progress while an activation runs, then works', async () => {
    h.init();
    let release;
    h.fetch.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve(reply(200, gumroadVerify())))));
    const first = activateLicense({ licenseKey: GUMROAD_KEY });
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1));
    await expect(removeLicense()).rejects.toMatchObject({ code: 'activation_in_progress', httpStatus: 409 });
    release();
    await first;
    expect((await removeLicense()).pro).toBe(false);
  });
});

describe('L3: a failed local clear after a store deactivation turns Pro off', () => {
  it('sets the in-memory activation to none and logs the fixed line', async () => {
    let keyLoads = Infinity;
    h.init({ loadKey: () => (keyLoads-- > 0 ? { ok: true, key: h.ikm } : { ok: false }) });
    h.fetch.mockResolvedValueOnce(reply(200, lsActivate()));
    await activateLicense({ licenseKey: LS_KEY });
    expect(getEntitlements().pro).toBe(true);
    keyLoads = 1; // the saved-key check passes, then the MAC key is gone: the tombstone cannot be written
    h.fetch.mockResolvedValueOnce(reply(200, { deactivated: true }));
    await expect(deactivateLicense()).rejects.toMatchObject({ code: 'activation_write_failed' });
    expect(h.logs).toContain('license: deactivated at the store but the local record could not be cleared');
    expect(getEntitlements().pro).toBe(false);
    expect(getLicenseStatus().license).toBeNull();
  });
});
