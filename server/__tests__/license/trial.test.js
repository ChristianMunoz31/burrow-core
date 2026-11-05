// The reverse trial end to end through initLicense (docs/LICENSING.md section 8): every data folder starts its one
// 14-day Pro trial on its first launch, with injected clock, runtime keys, a temp data dir and the in-memory test DB.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
import { select } from '../../db/query.js';
import { importZipBuffer } from '../../import/importExport.js';
import { CLOCK_FILE_NAME, CLOCK_STATE_KEY, LEGACY_TRIAL_MS, TRIAL_FILE_NAME, TRIAL_NOTICES_STATE_KEY, TRIAL_STATE_KEY } from '../../license/constants.js';
import {
  activateLicense,
  dismissTrialNotice,
  getEntitlements,
  getLicenseStatus,
  initLicense,
  removeLicense,
  resetLicenseForTests,
} from '../../license/index.js';
import { __resetNetPolicyForTests } from '../../netPolicy.js';
import { deriveTrialKey, makeTrialRecord, trialMac } from '../../license/trialStore.js';
import { closeTestDb, createTestDb } from '../helpers/testDb.js';
import { GUMROAD_FREE_PRODUCT_ID, GUMROAD_KEY, TEST_STORE_CONFIG, queueGumroad } from './fixtures/storeResponses.js';
import { DAY, HOUR, T0 } from './helpers.js';

vi.mock('node-fetch', () => ({ default: vi.fn(async () => { throw new Error('real fetch must not be used'); }) }));

const storeFetch = vi.fn();
const ikm = randomBytes(32);
let dir;
let db;
let clock;
let logs;
let keyOk;

function init(extra = {}) {
  initLicense({
    dataDir: dir,
    env: {},
    fetchImpl: storeFetch,
    storeConfig: TEST_STORE_CONFIG,
    allowTest: false,
    buildInfo: { buildDate: Date.parse('2026-10-05T12:00:00Z'), buildDateIso: '2026-10-05T12:00:00Z', source: 'git', version: '0.1.0' },
    now: () => clock.t,
    mono: () => clock.m,
    getDb: () => db,
    loadKey: () => (keyOk ? { ok: true, key: ikm } : { ok: false }),
    gatherEvidence: () => null,
    log: (m) => logs.push(m),
    ...extra,
  });
}

/** (Re)starts the module and reads the status: the first launch of a fresh data folder starts the trial. */
const launch = (extra = {}) => {
  init(extra);
  return getLicenseStatus();
};

/** Moves wall and monotonic time together, as a running app sees real time pass. */
const advance = (ms) => {
  clock.t += ms;
  clock.m += ms;
};
const deleteBothTrialCopies = () => {
  fs.rmSync(path.join(dir, TRIAL_FILE_NAME), { force: true });
  db.prepare('DELETE FROM app_state WHERE key = ?').run(TRIAL_STATE_KEY);
};
const deleteBothClockCopies = () => {
  fs.rmSync(path.join(dir, CLOCK_FILE_NAME), { force: true });
  db.prepare('DELETE FROM app_state WHERE key = ?').run(CLOCK_STATE_KEY);
};
const noticesRow = () => select('app_state', { where: { key: TRIAL_NOTICES_STATE_KEY }, db })[0]?.value;
const trialRows = () => select('app_state', { where: { key: TRIAL_STATE_KEY }, db });
/** Writes a record in the 7-day era shape (endsAt = startedAt + 7 days), both copies, MAC'd. Not an auto-start. */
const writeLegacyTrial = (startedAt) => {
  const endsAt = startedAt + LEGACY_TRIAL_MS;
  const record = { v: 1, startedAt, endsAt, mac: trialMac(deriveTrialKey(ikm), startedAt, endsAt) };
  fs.writeFileSync(path.join(dir, TRIAL_FILE_NAME), `${JSON.stringify(record)}
`);
  db.prepare('INSERT OR REPLACE INTO app_state (key, value, updated_at) VALUES (?, ?, ?)').run(
    TRIAL_STATE_KEY,
    JSON.stringify(record),
    new Date(clock.t).toISOString(),
  );
  return true;
};

/** Activates a Gumroad purchase through the real flow with a stubbed store reply. */
const install = (purchase = {}) => {
  queueGumroad(storeFetch, { purchase });
  return activateLicense({ licenseKey: GUMROAD_KEY });
};
const STUDENT = { product_id: GUMROAD_FREE_PRODUCT_ID, variants: '(Student)' };

beforeEach(() => {
  storeFetch.mockReset();
  __resetNetPolicyForTests();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-trial-e2e-'));
  db = createTestDb();
  clock = { t: T0, m: 1000 };
  logs = [];
  keyOk = true;
});
afterEach(() => {
  resetLicenseForTests();
  closeTestDb(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the trial starts on its own', () => {
  it('the first launch gives 14 days of Pro with startedAt floored to the second, and the welcome notice', () => {
    clock.t = T0 + 789;
    const status = launch();
    expect(status).toMatchObject({ state: 'trial', pro: true, edition: 'trial', proSource: 'local_trial', trialDaysLeft: 14 });
    expect(status.trial).toEqual({
      state: 'active',
      startedAt: '2026-10-05T12:00:00Z',
      endsAt: '2026-10-19T12:00:00Z',
      daysLeft: 14,
      remindToday: false,
      notice: 'welcome',
    });
    expect(getEntitlements()).toEqual({ pro: true, edition: 'trial', reasons: ['local_trial'] });
  });

  it('a fresh trial ends exactly at 14 days: welcome before day 12, ending_soon from day 12, ended at day 14', () => {
    const first = launch();
    expect(Date.parse(first.trial.endsAt) - Date.parse(first.trial.startedAt)).toBe(14 * DAY);
    advance(11 * DAY + 23 * HOUR);
    expect(getLicenseStatus().trial).toMatchObject({ daysLeft: 3, notice: 'welcome' });
    advance(HOUR);
    expect(getLicenseStatus().trial).toMatchObject({ daysLeft: 2, notice: 'ending_soon' });
    advance(2 * DAY - 1);
    expect(getLicenseStatus()).toMatchObject({ state: 'trial', pro: true });
    advance(1);
    expect(getLicenseStatus()).toMatchObject({ state: 'free', pro: false, trial: { state: 'ended', notice: 'ended' } });
  });

  it('autoStartTrial false keeps the pre-trial free state, also through getLicenseStatus', () => {
    const status = launch({ autoStartTrial: false });
    expect(status).toMatchObject({ state: 'free', pro: false, proSource: null });
    expect(status.trial).toEqual({ state: 'available', startedAt: null, endsAt: null, daysLeft: null, remindToday: false, notice: null });
    expect(getLicenseStatus().trial.state).toBe('available');
    expect(trialRows()).toHaveLength(0);
  });

  it('counts days left: 14 at +1 ms, 2 at +12 days, 1 at +13d23h59m, ended exactly at the end', () => {
    launch();
    const left = () => getLicenseStatus().trial.daysLeft;
    advance(1);
    expect(left()).toBe(14);
    advance(12 * DAY - 1);
    expect(left()).toBe(2);
    advance(DAY + 23 * HOUR + 59 * 60_000);
    expect(left()).toBe(1);
    clock.t = T0 + 14 * DAY;
    clock.m = 1000 + 14 * DAY;
    const ended = getLicenseStatus();
    expect(ended.trial).toMatchObject({ state: 'ended', daysLeft: 0 });
    expect(ended).toMatchObject({ state: 'free', pro: false, proSource: null });
    expect(getEntitlements()).toMatchObject({ pro: false, edition: null });
  });

  it('remindToday is false until day 12, true on days 13 and 14, false when ended', () => {
    launch();
    const remind = () => getLicenseStatus().trial.remindToday;
    for (const day of [0, 1, 5, 10, 11]) {
      clock.t = T0 + day * DAY + 12 * HOUR;
      clock.m = 1000 + day * DAY + 12 * HOUR;
      expect(remind()).toBe(false);
    }
    clock.t = T0 + 12 * DAY + 12 * HOUR;
    clock.m = 1000 + 12 * DAY + 12 * HOUR;
    expect(remind()).toBe(true);
    clock.t = T0 + 13 * DAY + 12 * HOUR;
    clock.m = 1000 + 13 * DAY + 12 * HOUR;
    expect(remind()).toBe(true);
    clock.t = T0 + 14 * DAY + HOUR;
    clock.m = 1000 + 14 * DAY + HOUR;
    expect(remind()).toBe(false);
  });

  it('a relaunch while active never restarts or extends it: one trial per data folder', () => {
    const a = launch();
    advance(2 * DAY);
    const b = launch();
    expect(b).toMatchObject({ state: 'trial', proSource: 'local_trial' });
    expect(b.trial.startedAt).toBe(a.trial.startedAt);
    expect(b.trial.daysLeft).toBe(12);
    expect(trialRows()).toHaveLength(1);
  });

  it('after the end a relaunch stays free and starts no new trial', () => {
    const a = launch();
    advance(15 * DAY);
    expect(getLicenseStatus().trial.state).toBe('ended');
    const b = launch();
    expect(b.trial).toMatchObject({ state: 'ended', startedAt: a.trial.startedAt });
    expect(b).toMatchObject({ state: 'free', pro: false });
    expect(trialRows()).toHaveLength(1);
  });

  it('an existing ended trial record (a legacy manual trial) is kept: no fresh trial', () => {
    writeLegacyTrial(Math.floor((T0 - 10 * DAY) / 1000) * 1000);
    const status = launch();
    expect(status.trial).toMatchObject({ state: 'ended', startedAt: '2026-09-25T12:00:00Z' });
    expect(status).toMatchObject({ state: 'free', pro: false, proSource: null });
  });

  it('a tampered record counts as used: no new trial, no notice, no values in the log', () => {
    launch();
    advance(15 * DAY);
    const file = path.join(dir, TRIAL_FILE_NAME);
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    const forged = { ...rec, startedAt: rec.startedAt + 6 * DAY, endsAt: rec.endsAt + 6 * DAY };
    fs.writeFileSync(file, JSON.stringify(forged));
    db.prepare('UPDATE app_state SET value = ? WHERE key = ?').run(JSON.stringify(forged), TRIAL_STATE_KEY);
    const status = launch();
    expect(status.trial).toMatchObject({ state: 'ended', notice: null });
    expect(status).toMatchObject({ state: 'free', pro: false });
    expect(logs.filter((m) => m.startsWith('license: trial'))).toEqual(['license: trial record ignored (invalid)']);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(forged);
  });

  it('a failed start at launch (no MAC key) is retried by getLicenseStatus, not by getEntitlements', () => {
    keyOk = false;
    init();
    expect(getEntitlements().pro).toBe(false);
    keyOk = true;
    expect(getEntitlements().pro).toBe(false);
    const status = getLicenseStatus();
    expect(status).toMatchObject({ state: 'trial', pro: true });
    expect(status.trial).toMatchObject({ state: 'active', notice: 'welcome' });
    expect(getEntitlements().pro).toBe(true);
  });

  it('with no key the trial stays available and nothing throws', () => {
    keyOk = false;
    const status = launch();
    expect(status.trial.state).toBe('available');
    expect(status).toMatchObject({ state: 'free', pro: false });
  });

  it('makes no store request', () => {
    launch();
    expect(storeFetch).not.toHaveBeenCalled();
  });
});

describe('legacy 7-day trial records', () => {
  it('loads as valid, keeps its 7-day end, is active on day 5 and ended on day 8, and auto-start does not replace it', () => {
    writeLegacyTrial(T0);
    const first = launch();
    expect(first).toMatchObject({ state: 'trial', pro: true, proSource: 'local_trial' });
    expect(first.trial).toMatchObject({ state: 'active', endsAt: '2026-10-12T12:00:00Z', daysLeft: 7 });
    advance(5 * DAY);
    expect(getLicenseStatus()).toMatchObject({ state: 'trial', pro: true, trialDaysLeft: 2 });
    advance(3 * DAY);
    const ended = getLicenseStatus();
    expect(ended).toMatchObject({ state: 'free', pro: false });
    expect(ended.trial).toMatchObject({ state: 'ended', endsAt: '2026-10-12T12:00:00Z' });
    expect(launch().trial).toMatchObject({ state: 'ended', startedAt: first.trial.startedAt, endsAt: '2026-10-12T12:00:00Z' });
    expect(trialRows()).toHaveLength(1);
    expect(trialRows()[0].value.endsAt).toBe(T0 + 7 * DAY);
  });

  it.each([10, 30])('a MAC-valid record whose endsAt is %i days after startedAt is rejected as used: no trial, no new start', (days) => {
    const endsAt = T0 + days * DAY;
    const rec = { v: 1, startedAt: T0, endsAt, mac: trialMac(deriveTrialKey(ikm), T0, endsAt) };
    fs.writeFileSync(path.join(dir, TRIAL_FILE_NAME), JSON.stringify(rec));
    db.prepare('INSERT OR REPLACE INTO app_state (key, value, updated_at) VALUES (?, ?, ?)').run(TRIAL_STATE_KEY, JSON.stringify(rec), new Date(T0).toISOString());
    const status = launch();
    expect(status).toMatchObject({ state: 'free', pro: false, proSource: null });
    expect(status.trial).toMatchObject({ state: 'ended', notice: null });
    expect(JSON.parse(fs.readFileSync(path.join(dir, TRIAL_FILE_NAME), 'utf8'))).toEqual(rec);
  });
});

describe('legacy trial repair and relaunch', () => {
  it.each([
    ['file', () => fs.rmSync(path.join(dir, TRIAL_FILE_NAME), { force: true })],
    ['database row', () => db.prepare('DELETE FROM app_state WHERE key = ?').run(TRIAL_STATE_KEY)],
  ])('an ended legacy trial stays ended across two relaunches after the %s copy is deleted', (_name, del) => {
    writeLegacyTrial(Math.floor((T0 - 10 * DAY) / 1000) * 1000);
    expect(launch()).toMatchObject({ state: 'free', pro: false });
    del();
    for (let i = 0; i < 2; i += 1) {
      const status = launch();
      expect(status).toMatchObject({ state: 'free', pro: false, proSource: null });
      expect(status.trial).toMatchObject({ state: 'ended', endsAt: '2026-10-02T12:00:00Z' });
      expect(getEntitlements().pro).toBe(false);
    }
    expect(trialRows()[0].value.endsAt).toBe(Date.parse('2026-10-02T12:00:00Z'));
  });
});

describe('licenses and the trial', () => {
  it('a license activated during the trial wins: pro via the license, no notice, the trial record kept', async () => {
    init();
    expect(getLicenseStatus().trial.notice).toBe('welcome');
    const status = await install();
    expect(status).toMatchObject({ state: 'pro', pro: true, proSource: 'license', licenseState: 'pro' });
    expect(status.trial).toMatchObject({ state: 'active', notice: null });
    expect(trialRows()).toHaveLength(1);
  });

  it('removing the license after the trial ended gives Free and never a fresh trial', async () => {
    init();
    await install();
    advance(15 * DAY);
    expect(getLicenseStatus()).toMatchObject({ proSource: 'license' });
    const removed = await removeLicense();
    expect(removed).toMatchObject({ state: 'free', pro: false, proSource: null });
    expect(removed.trial).toMatchObject({ state: 'ended', notice: 'ended' });
    expect(launch().trial.state).toBe('ended');
  });

  it('a license that is not Pro does not hide the trial, and the license state stays visible', async () => {
    init({ autoStartTrial: false });
    await install(STUDENT);
    // the yearly license ends 2027-09-30; a relaunch after that reads it as expired
    clock = { t: Date.parse('2027-10-10T00:00:00Z'), m: 9000 };
    const status = launch();
    expect(status).toMatchObject({ state: 'trial', pro: true, licenseState: 'expired', proSource: 'local_trial' });
    expect(status.reasons).toEqual(['expired', 'local_trial']);
  });
});

describe('trial notices', () => {
  it('welcome shows once: dismissing it persists across a relaunch', () => {
    expect(launch().trial.notice).toBe('welcome');
    expect(dismissTrialNotice('welcome').trial.notice).toBeNull();
    expect(launch().trial.notice).toBeNull();
    expect(noticesRow()).toEqual({ v: 1, startedAt: T0, welcome: true, endingSoon: false, ended: false });
  });

  it('the flags also live in memory, so a failed write still stops the notice for this process', () => {
    launch();
    db.prepare('DELETE FROM app_state WHERE key = ?').run(TRIAL_NOTICES_STATE_KEY);
    db.exec(
      "CREATE TRIGGER block_notices BEFORE INSERT ON app_state WHEN NEW.key = 'license.trialNotices' BEGIN SELECT RAISE(ABORT, 'blocked'); END",
    );
    expect(dismissTrialNotice('welcome').trial.notice).toBeNull();
    expect(getLicenseStatus().trial.notice).toBeNull();
    expect(noticesRow()).toBeUndefined();
  });

  it('ending_soon at 2 days left, once; dismissing it also marks welcome', () => {
    launch();
    advance(11 * DAY);
    expect(getLicenseStatus().trial).toMatchObject({ daysLeft: 3, notice: 'welcome' });
    advance(DAY);
    expect(getLicenseStatus().trial).toMatchObject({ daysLeft: 2, notice: 'ending_soon', remindToday: true });
    expect(dismissTrialNotice('ending_soon').trial.notice).toBeNull();
    expect(noticesRow()).toMatchObject({ welcome: true, endingSoon: true, ended: false });
    expect(launch().trial.notice).toBeNull();
  });

  it('ended shows once at day 14, as Free, and the dismissal persists across a relaunch', () => {
    launch();
    advance(14 * DAY);
    const status = getLicenseStatus();
    expect(status).toMatchObject({ state: 'free', pro: false });
    expect(status.trial).toMatchObject({ state: 'ended', notice: 'ended' });
    expect(launch().trial.notice).toBe('ended');
    expect(dismissTrialNotice('ended').trial.notice).toBeNull();
    expect(noticesRow()).toMatchObject({ welcome: true, endingSoon: true, ended: true });
    expect(launch().trial.notice).toBeNull();
  });

  it('a legacy active trial gets no welcome, then ending_soon later', () => {
    writeLegacyTrial(T0);
    expect(launch().trial).toMatchObject({ state: 'active', notice: null });
    advance(5 * DAY);
    expect(getLicenseStatus().trial.notice).toBe('ending_soon');
    expect(noticesRow()).toMatchObject({ welcome: true, endingSoon: false, ended: false });
  });

  it('a legacy trial that already ended gets no ended notice', () => {
    writeLegacyTrial(Math.floor((T0 - 9 * DAY) / 1000) * 1000);
    expect(launch().trial).toMatchObject({ state: 'ended', notice: null });
    expect(noticesRow()).toMatchObject({ welcome: true, endingSoon: false, ended: true });
  });

  it('a legacy trial that ends while Burrow runs does show the ended notice', () => {
    writeLegacyTrial(T0);
    launch();
    advance(15 * DAY);
    expect(getLicenseStatus().trial.notice).toBe('ended');
  });

  it('a legacy active trial reconciled during a rollback still shows ended once it really ends', () => {
    clock = { t: T0 + 3 * DAY, m: 4000 };
    init({ autoStartTrial: false }); // persists the high-water mark at +3d
    writeLegacyTrial(T0);
    clock = { t: T0, m: 5000 }; // 3 days back: beyond the 48 h tolerance
    const during = launch({ autoStartTrial: false });
    expect(during).toMatchObject({ state: 'clock_issue', pro: false });
    expect(noticesRow()).toMatchObject({ ended: false });
    clock = { t: T0 + 8 * DAY, m: 6000 + 8 * DAY };
    expect(getLicenseStatus().trial).toMatchObject({ state: 'ended', notice: 'ended' });
  });

  it('dismissing with no valid trial is a no-op that returns the status; a bad name is a 400', () => {
    init({ autoStartTrial: false });
    expect(dismissTrialNotice('welcome').trial.state).toBe('available');
    expect(noticesRow()).toBeUndefined();
    for (const bad of [undefined, null, 1, 'nope', ['welcome'], {}]) {
      expect(() => dismissTrialNotice(bad)).toThrowError(expect.objectContaining({ name: 'LicenseError', httpStatus: 400, code: 'invalid_request' }));
    }
  });

  it('a notice record of an older trial is replaced when a new trial starts (both copies deleted)', () => {
    launch();
    dismissTrialNotice('ended');
    advance(15 * DAY);
    deleteBothTrialCopies();
    const status = launch();
    expect(status.trial).toMatchObject({ state: 'active', notice: 'welcome' });
    expect(noticesRow().startedAt).toBe(Date.parse(status.trial.startedAt));
  });

  it('a malformed notices row is treated as missing and rewritten', () => {
    launch();
    db.prepare('UPDATE app_state SET value = ? WHERE key = ?').run(JSON.stringify({ v: 1, startedAt: 'x' }), TRIAL_NOTICES_STATE_KEY);
    // the trial is not new, so it is reconciled like a legacy one: no welcome
    const status = launch();
    expect(status.trial.notice).toBeNull();
    expect(noticesRow()).toEqual({ v: 1, startedAt: T0, welcome: true, endingSoon: false, ended: false });
  });

  it('notices never touch entitlement: wiping the row changes no Pro decision', () => {
    launch();
    const before = getEntitlements();
    db.prepare('DELETE FROM app_state WHERE key = ?').run(TRIAL_NOTICES_STATE_KEY);
    expect(getEntitlements()).toEqual(before);
  });
});

describe('protection', () => {
  it('both copies deleted starts a fresh trial (documented: same as wiping the data folder)', () => {
    launch();
    advance(15 * DAY);
    expect(getLicenseStatus().trial.state).toBe('ended');
    deleteBothTrialCopies();
    expect(launch().trial.state).toBe('active');
  });

  it('one copy deleted changes nothing', () => {
    const a = launch();
    fs.rmSync(path.join(dir, TRIAL_FILE_NAME));
    expect(launch().trial.startedAt).toBe(a.trial.startedAt);
  });

  it('rollback guard: the clock set back after the trial ended is clock_issue, never pro, no notice, and clears when right', () => {
    launch();
    advance(15 * DAY);
    expect(getLicenseStatus().state).toBe('free'); // hwm persisted at +8d
    clock = { t: T0 + 2 * DAY, m: 5000 };
    const status = launch();
    expect(status).toMatchObject({ state: 'clock_issue', pro: false, proSource: null });
    expect(status.trial).toMatchObject({ state: 'ended', notice: null });
    expect(status.clock.rollbackDetected).toBe(true);
    expect(getEntitlements().pro).toBe(false);
    clock.t = T0 + 15 * DAY;
    clock.m += 15 * DAY;
    expect(getLicenseStatus()).toMatchObject({ state: 'free', trial: { state: 'ended', notice: 'ended' }, clock: { rollbackDetected: false } });
  });

  it('the trial keeps its own floor: a clock set before its start is clock_issue, then active again once corrected', () => {
    const build = { buildDate: Date.parse('2026-09-01T00:00:00Z'), buildDateIso: '2026-09-01T00:00:00Z', source: 'git', version: '0.1.0' };
    launch({ buildInfo: build });
    deleteBothClockCopies();
    clock = { t: T0 - 3 * DAY, m: 9000 };
    const status = launch({ buildInfo: build });
    expect(status).toMatchObject({ state: 'clock_issue', pro: false, proSource: null });
    expect(status.clock.rollbackDetected).toBe(false); // the shared guard is not told about the trial
    expect(status.trial).toMatchObject({ state: 'ended', notice: null });
    expect(getEntitlements().pro).toBe(false);
    // still short of startedAt - 48h
    advance(12 * HOUR);
    expect(getLicenseStatus()).toMatchObject({ state: 'clock_issue', pro: false });
    // within 48h of startedAt: active with its full remaining days
    advance(2 * DAY);
    expect(getLicenseStatus()).toMatchObject({ state: 'trial', pro: true, proSource: 'local_trial' });
  });

  it('a clock set back more than 48 h during the trial: clock_issue, no notice, no Pro, and it clears', () => {
    launch();
    advance(12 * DAY);
    expect(getLicenseStatus()).toMatchObject({ state: 'trial', trialDaysLeft: 2 });
    clock = { t: T0 + 2 * DAY, m: 7000 };
    const status = launch();
    expect(status).toMatchObject({ state: 'clock_issue', pro: false, proSource: null });
    expect(status.trial.notice).toBeNull();
    expect(status.reasons).toEqual(expect.arrayContaining(['clock_issue', 'clock_rollback']));
    expect(getEntitlements().pro).toBe(false);
    // corrected clock: the unexpired trial is active again, and its notice comes back
    clock.t = T0 + 12 * DAY;
    clock.m += 10 * DAY;
    expect(getLicenseStatus()).toMatchObject({
      state: 'trial',
      pro: true,
      trialDaysLeft: 2,
      clock: { rollbackDetected: false },
      trial: { notice: 'ending_soon' },
    });
  });

  it('a clock moved forward past the end ends the trial', () => {
    launch();
    advance(30 * DAY);
    expect(getLicenseStatus()).toMatchObject({ state: 'free', pro: false, trial: { state: 'ended', notice: 'ended' } });
  });

  it('clock +1y at first launch, then back: clock_issue, and H is not pushed to +1y (a yearly license stays judged right)', async () => {
    const YEAR = 365 * DAY;
    clock = { t: T0 + YEAR, m: 1000 };
    expect(launch().trial.startedAt).toBe('2027-10-05T12:00:00Z');
    // the guard's H stayed near real time
    const hwmRow = JSON.parse(fs.readFileSync(path.join(dir, CLOCK_FILE_NAME), 'utf8')).hwm;
    expect(hwmRow).toBeLessThan(T0 + YEAR);
    expect(hwmRow).toBeLessThanOrEqual(T0 + 3 * DAY);
    clock = { t: T0 + 2 * DAY, m: 5000 }; // within the guard's 48h of H (T0 + 72h): only the trial notices
    const status = launch();
    expect(status).toMatchObject({ state: 'clock_issue', pro: false });
    expect(status.clock.rollbackDetected).toBe(false);
    // a yearly student license activated now stays Pro: the trial did not push H
    await install(STUDENT);
    expect(getLicenseStatus()).toMatchObject({ state: 'pro', pro: true, proSource: 'license' });
  });

  it('a yearly student license: a rollback beyond 48h gives clock_issue even before expiry, and clears when corrected', async () => {
    init({ autoStartTrial: false });
    await install(STUDENT);
    advance(10 * DAY);
    expect(getLicenseStatus()).toMatchObject({ state: 'pro', pro: true });
    clock = { t: T0 + 5 * DAY, m: 4000 };
    init({ autoStartTrial: false });
    expect(getLicenseStatus()).toMatchObject({ state: 'clock_issue', pro: false, licenseState: 'clock_issue' });
    clock.t = T0 + 10 * DAY;
    clock.m += 5 * DAY;
    expect(getLicenseStatus()).toMatchObject({ state: 'pro', pro: true });
  });

  it('a perpetual standard license stays Pro under a rollback, with the advisory', async () => {
    init({ autoStartTrial: false });
    await install();
    advance(10 * DAY);
    expect(getLicenseStatus().state).toBe('pro');
    clock = { t: T0 + 2 * DAY, m: 4000 };
    init({ autoStartTrial: false });
    const status = getLicenseStatus();
    expect(status).toMatchObject({ state: 'pro', pro: true });
    expect(status.reasons).toContain('clock_rollback');
  });

  it('an archive with a license.trial or license.trialNotices row never overwrites or creates the stored record', () => {
    const a = launch();
    const stored = trialRows()[0].value;
    const storedNotices = noticesRow();
    const forged = { v: 1, startedAt: T0 + 6 * DAY, endsAt: T0 + 13 * DAY, mac: 'A'.repeat(43) };
    const forgedNotices = { v: 1, startedAt: T0, welcome: true, endingSoon: true, ended: true };
    const zip = zipSync({
      'manifest.json': strToU8(
        JSON.stringify({ format: 'burrow-export', formatVersion: 2, exportedAt: '2026-05-01T00:00:00.000Z', tables: [{ id: 'app_state' }] }),
      ),
      'json/app_state.json': strToU8(
        JSON.stringify([
          { key: TRIAL_STATE_KEY, value: forged },
          { key: TRIAL_NOTICES_STATE_KEY, value: forgedNotices },
        ]),
      ),
    });
    const result = importZipBuffer(zip, { db });
    expect(result.tables.find((t) => t.id === 'app_state').skippedReasons.protected).toBe(2);
    expect(trialRows()[0].value).toEqual(stored);
    expect(noticesRow()).toEqual(storedNotices);
    expect(launch().trial.startedAt).toBe(a.trial.startedAt);
    deleteBothTrialCopies();
    db.prepare('DELETE FROM app_state WHERE key = ?').run(TRIAL_NOTICES_STATE_KEY);
    importZipBuffer(zip, { db });
    expect(trialRows()).toHaveLength(0);
    expect(noticesRow()).toBeUndefined();
  });
});

describe('adversarial', () => {
  const writeBoth = (rec) => {
    fs.writeFileSync(path.join(dir, TRIAL_FILE_NAME), JSON.stringify(rec));
    db.prepare('UPDATE app_state SET value = ? WHERE key = ?').run(JSON.stringify(rec), TRIAL_STATE_KEY);
  };
  const record = (startedAt) => makeTrialRecord(deriveTrialKey(ikm), startedAt);

  it('replacing both copies with an older valid record (copied before the start) cannot restart the trial', () => {
    launch();
    advance(15 * DAY);
    writeBoth(record(Math.floor((T0 - 2 * DAY) / 1000) * 1000));
    const status = launch();
    expect(status.trial.state).toBe('ended');
    expect(status.trial.startedAt).toBe('2026-10-03T12:00:00Z');
    expect(status.pro).toBe(false);
  });

  it('replacing one copy with an older valid record gives no extension: the earliest start wins', () => {
    const a = launch();
    advance(15 * DAY);
    fs.writeFileSync(path.join(dir, TRIAL_FILE_NAME), JSON.stringify(record(Math.floor((T0 - 1 * DAY) / 1000) * 1000)));
    expect(launch().trial.state).toBe('ended');
    expect(Date.parse(a.trial.startedAt)).toBe(T0);
  });

  it('replacing one copy with a newer valid record cannot extend the trial', () => {
    const a = launch();
    advance(15 * DAY);
    fs.writeFileSync(path.join(dir, TRIAL_FILE_NAME), JSON.stringify(record(Math.floor(clock.t / 1000) * 1000)));
    const status = launch();
    expect(status.trial.state).toBe('ended');
    expect(status.pro).toBe(false);
    expect(a.trial.state).toBe('active');
  });

  it('two launches a few seconds apart give one startedAt and one stored record', () => {
    const x = launch();
    advance(3000);
    const y = launch();
    expect(y.trial.startedAt).toBe(x.trial.startedAt);
    expect(trialRows()).toHaveLength(1);
  });
});
