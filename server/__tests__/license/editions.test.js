// Editions, update window, yearly expiry and the clock guard, plus the service lifecycle, end to end through
// activateLicense (docs/LICENSING.md 1, 6, 7, 9): injected clock, fetch and build info.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('node-fetch', () => ({
  default: vi.fn(async () => {
    throw new Error('real fetch must not be used');
  }),
}));

import { gatherEvidence } from '../../license/clockGuard.js';
import { ACTIVATION_FILE_NAME, RETIRED_LICENSE_BACKUP, RETIRED_LICENSE_FILE } from '../../license/constants.js';
import {
  activateLicense,
  getEntitlements,
  getLicenseStatus,
  removeLicense,
  resetLicenseForTests,
} from '../../license/index.js';
import { GUMROAD_KEY, GUMROAD_KEY_2, LS_KEY, gumroadVerify, GUMROAD_FREE_PRODUCT_ID, queueGumroad, lsActivate, reply } from './fixtures/storeResponses.js';
import { createHarness, DAY, T0, iso } from './helpers.js';

let h;
beforeEach(() => {
  h = createHarness();
});
afterEach(() => h.cleanup());

const build = (ms) => ({ buildDate: ms, buildDateIso: iso(ms), source: 'git', version: '0.1.0' });
const PURCHASE = Date.parse('2026-09-30T14:02:11Z');
const sale = (ms) => ({ sale_timestamp: iso(ms), created_at: iso(ms) });
const gumroadOnce = (purchase = {}, uses = 1) => queueGumroad(h.fetch, { uses, purchase });
const activateGumroad = (purchase, key = GUMROAD_KEY) => {
  gumroadOnce(purchase);
  return activateLicense({ licenseKey: key });
};

describe('update window against the build date, per edition (inclusive boundary)', () => {
  const cases = [
    ['standard', { variants: '(Standard)' }, 365],
    ['family', { variants: '(Family)' }, 365],
    ['founding', { variants: '(Founding)' }, 730],
  ];

  it.each(cases)('%s: a build at updatesUntil is Pro, one second later is update_window_passed', async (edition, purchase, days) => {
    const until = PURCHASE + days * DAY;
    // a real run happens after the build, so the clock sits just past the build date
    h.clock.t = until + 5000;
    h.init({ buildInfo: build(until) });
    const status = await activateGumroad(purchase);
    expect(status).toMatchObject({ state: 'pro', pro: true, edition });
    expect(status.license.updatesUntil).toBe(iso(until));

    // the same stored record read by a build one second newer
    resetLicenseForTests();
    h.init({ buildInfo: build(until + 1000) });
    expect(getLicenseStatus()).toMatchObject({ state: 'update_window_passed', pro: false, edition });
    expect(getEntitlements()).toEqual({ pro: false, edition, reasons: ['update_window_passed'] });
  });

  it.each([
    ['student', { product_id: GUMROAD_FREE_PRODUCT_ID, variants: '(Student)' }],
    ['nonprofit', { product_id: GUMROAD_FREE_PRODUCT_ID, variants: '(Nonprofit)' }],
  ])('%s: updatesUntil equals expiresAt, so the end of the term is expired, not update_window_passed', async (edition, purchase) => {
    h.init({ buildInfo: build(T0) });
    const status = await activateGumroad(purchase);
    expect(status.license.updatesUntil).toBe(status.license.expiresAt);
    const end = PURCHASE + 365 * DAY;
    h.clock.t = end;
    h.clock.m += end - T0;
    expect(getLicenseStatus()).toMatchObject({ state: 'expired', edition });
  });

  it('founding: a build 729 days after purchase is Pro, 731 days is update_window_passed, with the founder perk kept', async () => {
    h.clock.t = PURCHASE + 732 * DAY;
    h.init({ buildInfo: build(PURCHASE + 729 * DAY) });
    expect(await activateGumroad({ variants: '(Founding)' })).toMatchObject({ state: 'pro', perks: { founderBackground: true } });
    h.init({ buildInfo: build(PURCHASE + 731 * DAY) });
    expect(getLicenseStatus()).toMatchObject({ state: 'update_window_passed', pro: false, perks: { founderBackground: true } });
  });

  it('moving the clock never changes a perpetual edition', async () => {
    h.init();
    await activateGumroad({});
    for (const t of [T0 - 20 * DAY, T0 + 400 * DAY, T0 + 4000 * DAY, T0]) {
      h.clock.t = t;
      expect(getLicenseStatus().state).toBe('pro');
    }
  });

  it('an older build keeps Pro after the window; a newer build does not', async () => {
    h.init({ buildInfo: build(PURCHASE + 100 * DAY) });
    await activateGumroad({});
    h.clock.t = T0 + 900 * DAY;
    h.clock.m += 900 * DAY;
    expect(getLicenseStatus()).toMatchObject({ state: 'pro', pro: true });
    h.init({ buildInfo: build(PURCHASE + 366 * DAY) });
    expect(getLicenseStatus().state).toBe('update_window_passed');
  });
});

describe('yearly expiry and the clock guard', () => {
  const student = { product_id: GUMROAD_FREE_PRODUCT_ID, variants: '(Student)' };
  const END = PURCHASE + 365 * DAY;

  /** Real time passes: wall and monotonic move together, and the guard sees the app running. */
  const advanceTo = (t) => {
    h.clock.m += t - h.clock.t;
    h.clock.t = t;
  };

  it('Pro at +364 days, expired at exactly +365 days, and only Pro turns off', async () => {
    h.init();
    await activateGumroad(student);
    advanceTo(PURCHASE + 364 * DAY);
    expect(getLicenseStatus()).toMatchObject({ state: 'pro', pro: true, edition: 'student' });
    advanceTo(END - 1000);
    expect(getEntitlements().pro).toBe(true);
    advanceTo(END);
    expect(getLicenseStatus()).toMatchObject({ state: 'expired', pro: false, edition: 'student', reasons: ['expired'] });
    expect(getEntitlements().pro).toBe(false);
  });

  it('a clock set back after expiry is clock_issue, not Pro, and clears when the clock is right', async () => {
    h.init();
    await activateGumroad(student);
    advanceTo(END + DAY);
    expect(getLicenseStatus().state).toBe('expired');
    h.clock.t = END - 10 * DAY; // clock set back, monotonic time unchanged
    expect(getLicenseStatus()).toMatchObject({ state: 'clock_issue', pro: false });
    advanceTo(END + 2 * DAY);
    expect(getLicenseStatus()).toMatchObject({ state: 'expired', pro: false });
  });

  it('a rollback before expiry gives clock_issue and clears once the clock is right', async () => {
    h.init();
    await activateGumroad(student);
    advanceTo(T0 + 100 * DAY);
    expect(getLicenseStatus().state).toBe('pro');
    h.clock.t = T0 + 10 * DAY; // beyond the 48 h tolerance
    expect(getLicenseStatus()).toMatchObject({ state: 'clock_issue', pro: false, licenseState: 'clock_issue' });
    expect(getLicenseStatus().clock.rollbackDetected).toBe(true);
    advanceTo(T0 + 101 * DAY);
    expect(getLicenseStatus()).toMatchObject({ state: 'pro', pro: true });
  });

  it('a perpetual edition only gets the clock_rollback advisory', async () => {
    h.init();
    await activateGumroad({});
    advanceTo(T0 + 100 * DAY);
    expect(getLicenseStatus().state).toBe('pro');
    h.clock.t = T0 + 10 * DAY;
    expect(getLicenseStatus()).toMatchObject({ state: 'pro', pro: true });
    expect(getLicenseStatus().reasons).toContain('clock_rollback');
  });

  it('renewal is a new key: it replaces the expired activation and shows the new term', async () => {
    h.init();
    await activateGumroad(student);
    advanceTo(END + 5 * DAY);
    expect(getLicenseStatus().state).toBe('expired');
    const renewedSale = END + 2 * DAY;
    const status = await activateGumroad({ ...student, ...sale(renewedSale) }, GUMROAD_KEY_2);
    expect(status).toMatchObject({ state: 'pro', pro: true, edition: 'student' });
    expect(status.license.expiresAt).toBe(iso(renewedSale + 365 * DAY));
    expect(status.license.keyLast4).toBe('DDDD');
  });

  it('L is the purchase date: a purchase dated ahead of the clock raises the guard floor, now and after a restart', async () => {
    h.init();
    const future = T0 + 30 * DAY;
    const status = await activateGumroad(sale(future));
    expect(status.clock.rollbackDetected).toBe(true);
    expect(status.reasons).toContain('clock_rollback');
    expect(status.state).toBe('pro');
    h.init();
    expect(getLicenseStatus().clock.rollbackDetected).toBe(true);
  });

  it('with no activation the guard has no L, so the same clock reads clean', () => {
    h.init();
    expect(getLicenseStatus().clock.rollbackDetected).toBe(false);
  });

  it('clock evidence lists license-activation.json and no longer the retired license file', () => {
    h.init();
    const stamp = (name, t) => {
      fs.writeFileSync(path.join(h.dir, name), 'x');
      fs.utimesSync(path.join(h.dir, name), t / 1000, t / 1000);
    };
    stamp(RETIRED_LICENSE_FILE, T0 + 50 * DAY);
    expect(gatherEvidence({ dataDir: h.dir, getDb: () => null })).toBeNull();
    stamp(ACTIVATION_FILE_NAME, T0 + 20 * DAY);
    expect(gatherEvidence({ dataDir: h.dir, getDb: () => null })).toBe(T0 + 20 * DAY);
  });
});

describe('service lifecycle', () => {
  it('free with nothing stored; getEntitlements shape', () => {
    h.init();
    expect(getEntitlements()).toEqual({ pro: false, edition: null, reasons: ['no_license'] });
    expect(getLicenseStatus()).toMatchObject({ state: 'free', license: null, invalidReason: null });
  });

  it('an activation survives a restart (read from the stored copies, no store call)', async () => {
    h.init();
    await activateGumroad({});
    h.fetch.mockClear();
    resetLicenseForTests();
    h.init();
    expect(getLicenseStatus()).toMatchObject({ state: 'pro', edition: 'standard', license: { keyLast4: '3333' } });
    expect(getEntitlements()).toEqual({ pro: true, edition: 'standard', reasons: [] });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('lazily initialises with defaults when nothing initialised it', () => {
    resetLicenseForTests();
    const e = getEntitlements();
    // a fresh data folder starts its 14-day trial on first use
    expect(e.pro).toBe(true);
    // no_build_info may also appear (no dist/ build in CI); only the trial reason matters here
    expect(e.reasons).toContain('local_trial');
    expect(e.reasons).not.toContain('no_license');
  });

  it('removeLicense is idempotent, writes the tombstone, and keeps the trial and clock records', async () => {
    h.init();
    await activateGumroad({});
    expect((await removeLicense()).state).toBe('free');
    expect(JSON.parse(fs.readFileSync(path.join(h.dir, ACTIVATION_FILE_NAME), 'utf8'))).toMatchObject({ v: 1, state: 'cleared' });
    expect((await removeLicense()).state).toBe('free');
    resetLicenseForTests();
    h.init();
    expect(getLicenseStatus().state).toBe('free');
  });

  it('removing keeps the activation file free of the full key and never calls a store', async () => {
    h.init();
    await activateGumroad({});
    h.fetch.mockClear();
    await removeLicense();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(h.dir, ACTIVATION_FILE_NAME), 'utf8')).not.toContain(GUMROAD_KEY);
  });

  it('a Lemon Squeezy activation exposes canDeactivate and never the instance id', async () => {
    h.init();
    h.fetch.mockResolvedValueOnce(reply(200, lsActivate()));
    const status = await activateLicense({ licenseKey: LS_KEY });
    expect(status.license.canDeactivate).toBe(true);
    expect(JSON.stringify(status)).not.toMatch(/instance|keyHash|"mac"/i);
  });

  it('no MAC key: activate refuses with activation_write_failed before any request', async () => {
    h.keyOk = false;
    h.init();
    await expect(activateLicense({ licenseKey: GUMROAD_KEY })).rejects.toMatchObject({ httpStatus: 500, code: 'activation_write_failed' });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('an unconfigured store is store_not_configured before any request', async () => {
    h.init({ storeConfig: { ...(await import('./fixtures/storeResponses.js')).TEST_STORE_CONFIG, GUMROAD: (await import('../../license/storeConfig.js')).buildStoreConfig({}).GUMROAD } });
    await expect(activateLicense({ licenseKey: GUMROAD_KEY })).rejects.toMatchObject({ httpStatus: 503, code: 'store_not_configured' });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(getLicenseStatus().stores).toEqual([
      { id: 'gumroad', label: 'Gumroad', configured: false },
      { id: 'lemonsqueezy', label: 'Lemon Squeezy', configured: true },
    ]);
  });

  it('an empty owner file leaves both stores unconfigured, with no support contact', async () => {
    const empty = (await import('../../license/storeConfig.js')).buildStoreConfig({});
    h.init({ storeConfig: empty });
    const status = getLicenseStatus();
    expect(status.stores).toEqual([
      { id: 'gumroad', label: 'Gumroad', configured: false },
      { id: 'lemonsqueezy', label: 'Lemon Squeezy', configured: false },
    ]);
    expect(status.supportContact).toBeNull();
    await expect(activateLicense({ licenseKey: LS_KEY })).rejects.toMatchObject({ code: 'store_not_configured' });
  });

  it('bad input is rejected before the network: invalid_request and invalid_key_format', async () => {
    h.init();
    const reject = (input, httpStatus, code) => expect(activateLicense(input)).rejects.toMatchObject({ httpStatus, code });
    await reject({ licenseKey: 42 }, 400, 'invalid_request');
    await reject({ licenseKey: GUMROAD_KEY, store: 'paypal' }, 400, 'invalid_request');
    await reject({ licenseKey: 'nope' }, 400, 'invalid_key_format');
    await reject({ licenseKey: GUMROAD_KEY, store: 'lemonsqueezy' }, 400, 'invalid_key_format');
    await reject({ licenseKey: LS_KEY, store: 'gumroad' }, 400, 'invalid_key_format');
    await reject({ licenseKey: 'a'.repeat(129) }, 400, 'invalid_key_format');
    const err = await activateLicense({ licenseKey: LS_KEY, store: 'gumroad' }).catch((e) => e);
    expect(err.publicMessage).toBe(
      "That doesn't look like a Gumroad license key. Check that you picked the store you bought from, then paste the key from your receipt.",
    );
    const generic = await activateLicense({ licenseKey: 'nope' }).catch((e) => e);
    expect(generic.publicMessage).toBe("That doesn't look like a license key. Copy the key from your purchase email or receipt and paste it here.");
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('an explicit store wins over detection: a Lemon Squeezy key with store lemonsqueezy goes to Lemon Squeezy', async () => {
    h.init();
    h.fetch.mockResolvedValueOnce(reply(200, lsActivate()));
    await activateLicense({ licenseKey: LS_KEY, store: 'lemonsqueezy' });
    expect(h.fetch.mock.calls[0][0]).toContain('api.lemonsqueezy.com');
  });

  it('a second activation while one runs gets activation_in_progress, then the lock is released', async () => {
    h.init();
    let release;
    h.fetch.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve(reply(200, gumroadVerify())))));
    const first = activateLicense({ licenseKey: GUMROAD_KEY });
    await expect(activateLicense({ licenseKey: GUMROAD_KEY_2 })).rejects.toMatchObject({ httpStatus: 409, code: 'activation_in_progress' });
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1));
    release();
    expect((await first).state).toBe('pro');
    gumroadOnce({});
    expect((await activateLicense({ licenseKey: GUMROAD_KEY_2 })).state).toBe('pro');
  });

  it('the lock is also released after a failure', async () => {
    h.init();
    h.fetch.mockRejectedValueOnce(new Error('down'));
    await expect(activateLicense({ licenseKey: GUMROAD_KEY })).rejects.toMatchObject({ code: 'store_unreachable' });
    gumroadOnce({});
    expect((await activateLicense({ licenseKey: GUMROAD_KEY })).state).toBe('pro');
  });

  it('a failure with a previous activation keeps the previous activation', async () => {
    h.init();
    await activateGumroad({});
    h.fetch.mockResolvedValueOnce(reply(200, gumroadVerify({ purchase: { refunded: true } })));
    await expect(activateLicense({ licenseKey: GUMROAD_KEY_2 })).rejects.toMatchObject({ code: 'purchase_refunded' });
    expect(getLicenseStatus()).toMatchObject({ state: 'pro', license: { keyLast4: '3333' } });
  });

  it('a save that cannot write either copy is activation_write_failed and keeps the previous state', async () => {
    h.init({
      getDb: () => {
        throw new Error('db gone');
      },
      dataDir: path.join(h.dir, 'missing', 'deeper'),
    });
    // netPolicy still uses the test DB, so the request is made; only the record write fails
    gumroadOnce({});
    fs.writeFileSync(path.join(h.dir, 'missing'), 'a file where the data dir should be');
    await expect(activateLicense({ licenseKey: GUMROAD_KEY })).rejects.toMatchObject({ httpStatus: 500, code: 'activation_write_failed' });
    expect(getLicenseStatus().state).toBe('free');
  });
});

describe('migration from the Ed25519 license file (5.6)', () => {
  const legacy = () => path.join(h.dir, RETIRED_LICENSE_FILE);
  const backup = () => path.join(h.dir, RETIRED_LICENSE_BACKUP);

  it('moves the retired file aside, logs once, and starts free; the file is never read', () => {
    fs.writeFileSync(legacy(), '{"payload":{"edition":"standard"},"sig":"AAAA"}', { mode: 0o640 });
    const read = vi.spyOn(fs, 'readFileSync');
    h.init();
    expect(read.mock.calls.some(([file]) => String(file).endsWith(RETIRED_LICENSE_FILE))).toBe(false);
    read.mockRestore();
    expect(fs.existsSync(legacy())).toBe(false);
    expect(fs.readFileSync(backup(), 'utf8')).toContain('"edition":"standard"');
    expect(h.logs.filter((m) => m === 'license: retired license file moved aside')).toHaveLength(1);
    expect(getLicenseStatus()).toMatchObject({ state: 'free', pro: false });
  });

  it('replaces an existing backup', () => {
    fs.writeFileSync(backup(), 'old backup');
    fs.writeFileSync(legacy(), 'newer file');
    h.init();
    expect(fs.readFileSync(backup(), 'utf8')).toBe('newer file');
    expect(fs.existsSync(legacy())).toBe(false);
  });

  it('does nothing and logs nothing when there is no retired file, and a second start is quiet', () => {
    h.init();
    h.init();
    expect(h.logs).not.toContain('license: retired license file moved aside');
    expect(fs.existsSync(backup())).toBe(false);
  });

  it('a failed rename never throws and the file is left alone', () => {
    fs.writeFileSync(legacy(), 'file');
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    });
    expect(() => h.init()).not.toThrow();
    rename.mockRestore();
    expect(fs.existsSync(legacy())).toBe(true);
    expect(getLicenseStatus().state).toBe('free');
  });

  it('a retired file does not stop a new activation', async () => {
    fs.writeFileSync(legacy(), 'file');
    h.init();
    expect((await activateGumroad({})).state).toBe('pro');
  });
});
