// Pure evaluation of the stored activation, the status shape, the local trial combination and build info
// (docs/LICENSING.md 6, 8, 9). No network, no database.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadBuildInfo } from '../../license/buildInfo.js';
import { BUILD_INFO_FILE } from '../../license/constants.js';
import { STATE_MESSAGES, combineEntitlements, evaluateLicense, evaluateTrial, toStatus, trialNoticeFor } from '../../license/entitlements.js';
import { DAY, activeOf, iso } from './helpers.js';

const ms = (value) => Date.parse(value);
const clockAt = (now, extra = {}) => ({ now, effective: now, hwm: now, rollback: false, persisted: false, ...extra });
const build = (value) => ({ buildDate: value === null ? null : ms(value), buildDateIso: value, source: value ? 'git' : 'missing', version: '0.1.0' });
const NOW = ms('2026-10-06T00:00:00Z');
const NONE = { kind: 'none' };
const evalOf = (activation, buildIso, clock) => evaluateLicense({ activation, buildInfo: build(buildIso), clock });

describe('evaluateLicense precedence (9.1)', () => {
  it('free when there is no activation', () => {
    const e = evalOf(NONE, '2026-10-05T00:00:00Z', clockAt(NOW));
    expect(e).toMatchObject({ state: 'free', pro: false, edition: null, reasons: ['no_license'], license: null });
  });

  it.each(['tampered', 'no_key'])('invalid with the reason %s', (reason) => {
    const e = evalOf({ kind: 'invalid', reason }, '2026-10-05T00:00:00Z', clockAt(NOW));
    expect(e).toMatchObject({ state: 'invalid', pro: false, edition: null, invalidReason: reason, reasons: [reason], license: null });
  });

  it('pro for a valid perpetual activation in its window, with the license view', () => {
    const e = evalOf(activeOf(), '2026-10-05T12:00:00Z', clockAt(NOW));
    expect(e).toMatchObject({ state: 'pro', pro: true, edition: 'standard', reasons: [], trialDaysLeft: null });
    expect(e.license).toEqual({
      store: 'gumroad',
      storeLabel: 'Gumroad',
      edition: 'standard',
      purchaseDate: '2026-10-05T12:00:00Z',
      updatesUntil: '2027-10-05T12:00:00Z',
      expiresAt: null,
      activatedAt: '2026-10-05T12:00:00Z',
      email: 'buyer@example.com',
      keyLast4: '3333',
      test: false,
      canDeactivate: false,
    });
  });

  it('canDeactivate and the label follow the store', () => {
    const e = evalOf(activeOf({ store: 'lemonsqueezy', variantId: '1001', instanceId: 'abc' }), '2026-10-05T12:00:00Z', clockAt(NOW));
    expect(e.license).toMatchObject({ store: 'lemonsqueezy', storeLabel: 'Lemon Squeezy', canDeactivate: true });
  });

  it('buildDate == updatesUntil is pro; one second later is update_window_passed', () => {
    const a = activeOf({ updatesUntil: '2026-12-01T00:00:00Z' });
    expect(evalOf(a, '2026-12-01T00:00:00Z', clockAt(NOW)).state).toBe('pro');
    const late = evalOf(a, '2026-12-01T00:00:01Z', clockAt(NOW));
    expect(late).toMatchObject({ state: 'update_window_passed', pro: false, edition: 'standard', reasons: ['update_window_passed'] });
  });

  it('an older build stays pro forever, whatever the clock says', () => {
    const a = activeOf({ updatesUntil: '2026-12-01T00:00:00Z' });
    for (const now of [NOW, NOW + 400 * DAY, NOW + 3000 * DAY, ms('2999-01-01T00:00:00Z')]) {
      expect(evalOf(a, '2026-11-30T00:00:00Z', clockAt(now)).state).toBe('pro');
    }
    // and moving the clock backwards (even with a rollback flag) never changes a perpetual edition
    for (const rollback of [false, true]) {
      const e = evalOf(a, '2026-11-30T00:00:00Z', clockAt(ms('2024-02-01T00:00:00Z'), { effective: NOW, rollback }));
      expect(e.state).toBe('pro');
      expect(e.reasons).toEqual(rollback ? ['clock_rollback'] : []);
    }
  });

  it('a newer build never unlocks by moving the clock', () => {
    const a = activeOf({ updatesUntil: '2026-12-01T00:00:00Z' });
    for (const now of [ms('2024-02-01T00:00:00Z'), NOW, ms('2999-01-01T00:00:00Z')]) {
      expect(evalOf(a, '2027-01-01T00:00:00Z', clockAt(now)).state).toBe('update_window_passed');
    }
  });

  it('missing build info uses effective now and adds no_build_info', () => {
    const a = activeOf({ updatesUntil: '2026-12-01T00:00:00Z' });
    expect(evalOf(a, null, clockAt(ms('2026-11-30T00:00:00Z')))).toMatchObject({ state: 'pro', reasons: ['no_build_info'] });
    expect(evalOf(a, null, clockAt(ms('2026-12-02T00:00:00Z')))).toMatchObject({
      state: 'update_window_passed',
      reasons: ['update_window_passed', 'no_build_info'],
    });
    // a rolled-back clock cannot help: effective is the guard's time
    const rolled = evalOf(a, null, clockAt(ms('2026-11-01T00:00:00Z'), { effective: ms('2026-12-02T00:00:00Z'), rollback: true }));
    expect(rolled.state).toBe('update_window_passed');
  });

  describe('per edition: the update window against the build date, inclusive', () => {
    it.each([
      ['standard', 365],
      ['family', 365],
      ['founding', 730],
      ['student', 365],
      ['nonprofit', 365],
    ])('%s: build at updatesUntil is Pro, +1 s is update_window_passed', (edition, days) => {
      const purchase = ms('2026-09-30T14:02:11Z');
      const until = iso(purchase + days * DAY);
      const yearly = edition === 'student' || edition === 'nonprofit';
      const a = activeOf({ edition, purchaseDate: iso(purchase), updatesUntil: until, expiresAt: yearly ? until : null });
      // the clock sits inside the term so yearly editions have not expired
      const clock = clockAt(purchase + DAY);
      expect(evalOf(a, until, clock)).toMatchObject({ state: 'pro', pro: true, edition });
      expect(evalOf(a, iso(purchase + days * DAY + 1000), clock)).toMatchObject({ state: 'update_window_passed', pro: false, edition });
    });

    it('founding: a build 729 days after purchase is Pro, 731 days is update_window_passed, and the perk is kept', () => {
      const purchase = ms('2026-09-30T14:02:11Z');
      const a = activeOf({ edition: 'founding', purchaseDate: iso(purchase), updatesUntil: iso(purchase + 730 * DAY) });
      const at = (days) => {
        const clock = clockAt(NOW);
        const evaluation = combineEntitlements(evalOf(a, iso(purchase + days * DAY), clock), evaluateTrial({ record: NONE, clock }));
        return toStatus(evaluation, { buildInfo: build('2026-10-05T12:00:00Z'), version: '0.1.0' });
      };
      expect(at(729)).toMatchObject({ state: 'pro', pro: true, perks: { founderBackground: true } });
      expect(at(731)).toMatchObject({ state: 'update_window_passed', pro: false, edition: 'founding', perks: { founderBackground: true } });
    });
  });

  it('a yearly edition is pro just before expiry and expired exactly at it', () => {
    const exp = ms('2027-09-30T14:02:11Z');
    const a = activeOf({ edition: 'student', purchaseDate: '2026-09-30T14:02:11Z', updatesUntil: iso(exp), expiresAt: iso(exp) });
    expect(evalOf(a, '2026-10-05T12:00:00Z', clockAt(exp - 1000)).state).toBe('pro');
    expect(evalOf(a, '2026-10-05T12:00:00Z', clockAt(exp))).toMatchObject({ state: 'expired', pro: false, edition: 'student', reasons: ['expired'] });
  });

  it('expired plus update window passed gives expired', () => {
    const a = activeOf({ edition: 'nonprofit', updatesUntil: '2026-10-10T00:00:00Z', expiresAt: '2026-10-10T00:00:00Z' });
    expect(evalOf(a, '2026-12-01T00:00:00Z', clockAt(ms('2026-11-01T00:00:00Z'))).state).toBe('expired');
  });

  it('a rollback on a yearly edition is clock_issue even before expiry, and plain expiry stays expired', () => {
    const exp = ms('2027-09-30T14:02:11Z');
    const a = activeOf({ edition: 'student', updatesUntil: iso(exp), expiresAt: iso(exp) });
    const b = '2026-10-05T12:00:00Z';
    const issue = evalOf(a, b, clockAt(exp - DAY, { effective: exp + 5 * DAY, rollback: true }));
    expect(issue).toMatchObject({ state: 'clock_issue', pro: false, edition: 'student', reasons: ['clock_issue', 'clock_rollback'] });
    const expired = evalOf(a, b, clockAt(exp + DAY, { effective: exp + 5 * DAY, rollback: true }));
    expect(expired).toMatchObject({ state: 'expired', reasons: ['expired', 'clock_rollback'] });
    const still = evalOf(a, b, clockAt(exp - 200 * DAY, { effective: exp - 100 * DAY, rollback: true }));
    expect(still).toMatchObject({ state: 'clock_issue', pro: false, reasons: ['clock_issue', 'clock_rollback'] });
    // and clears once the clock is right
    expect(evalOf(a, b, clockAt(exp - 100 * DAY)).state).toBe('pro');
  });

  it('a perpetual standard activation under a rollback stays pro with the advisory only', () => {
    const e = evalOf(activeOf(), '2026-10-05T12:00:00Z', clockAt(NOW - 30 * DAY, { effective: NOW, rollback: true }));
    expect(e).toMatchObject({ state: 'pro', pro: true, reasons: ['clock_rollback'] });
  });

  it('advisory order: clock_rollback, no_build_info, test_purchase', () => {
    const e = evalOf(activeOf({ test: true }), null, clockAt(NOW, { rollback: true }));
    expect(e.reasons).toEqual(['clock_rollback', 'no_build_info', 'test_purchase']);
    expect(e.license.test).toBe(true);
    expect(e.state).toBe('pro');
  });

  it('the test_purchase advisory follows its state code', () => {
    const e = evalOf(activeOf({ test: true, updatesUntil: '2026-10-01T00:00:00Z' }), '2026-10-05T12:00:00Z', clockAt(NOW));
    expect(e.reasons).toEqual(['update_window_passed', 'test_purchase']);
  });

  it('there is no dev_key advisory and no signed trial edition any more', () => {
    const e = evalOf(activeOf(), null, clockAt(NOW, { rollback: true }));
    expect(e.reasons).not.toContain('dev_key');
    expect(e.reasons).not.toContain('trial');
  });
});

describe('toStatus', () => {
  const B = build('2026-10-05T12:00:00Z');
  it('has the documented shape and fixed copy, with no store identifiers', () => {
    const evaluation = evalOf(activeOf(), '2026-10-05T12:00:00Z', clockAt(NOW));
    const status = toStatus(evaluation, { buildInfo: B, version: '0.1.0' });
    expect(Object.keys(status).sort()).toEqual(
      ['build', 'clock', 'edition', 'invalidReason', 'license', 'licenseState', 'message', 'perks', 'pro', 'proSource', 'reasons', 'state', 'trial', 'trialDaysLeft'].sort(),
    );
    expect(status.message).toBe(STATE_MESSAGES.pro);
    expect(status.build).toEqual({ date: '2026-10-05T12:00:00Z', source: 'git', version: '0.1.0' });
    expect(status.clock).toEqual({ rollbackDetected: false });
    expect(JSON.stringify(status)).not.toMatch(/keyHash|instanceId|"mac"|productId|variantId/);
  });

  it('every state has the spec copy with no em dash', () => {
    expect(Object.keys(STATE_MESSAGES).sort()).toEqual(['clock_issue', 'expired', 'free', 'invalid', 'pro', 'trial', 'update_window_passed']);
    for (const message of Object.values(STATE_MESSAGES)) expect(message).not.toContain('—');
    expect(STATE_MESSAGES.trial).toContain('{n}');
    expect(STATE_MESSAGES.free).toBe(
      "You're using Burrow Free. Everything you need to track your money and journal is included. If you bought Burrow Pro, paste your license key below and click Activate.",
    );
    expect(STATE_MESSAGES.expired).toContain('If you have a new license key, paste it below and click Activate.');
    expect(STATE_MESSAGES.invalid).toContain('Paste your license key below and click Activate to set it up again.');
    for (const message of Object.values(STATE_MESSAGES)) expect(message).not.toMatch(/license file/);
  });
});

describe('local trial combination (8, 9.1)', () => {
  const B = build('2026-10-05T12:00:00Z');
  const START = ms('2026-10-05T12:00:00Z');
  const record = { kind: 'valid', startedAt: START, endsAt: START + 7 * DAY };
  const combined = (activation, now = START + DAY, rec = record) => {
    const clock = clockAt(now);
    return combineEntitlements(evaluateLicense({ activation, buildInfo: B, clock }), evaluateTrial({ record: rec, clock }));
  };
  const status = (e) => toStatus(e, { buildInfo: B, version: '0.1.0' });

  it('an activation that gives Pro wins over an active trial', () => {
    const s = status(combined(activeOf()));
    expect(s).toMatchObject({ state: 'pro', pro: true, edition: 'standard', proSource: 'license', licenseState: 'pro' });
    expect(s.trial).toMatchObject({ state: 'active', remindToday: false });
    expect(s.reasons).toEqual([]);
  });

  it('no activation: the local trial gives Pro, edition trial, without the no_license reason', () => {
    const s = status(combined(NONE));
    expect(s).toMatchObject({ state: 'trial', pro: true, edition: 'trial', proSource: 'local_trial', licenseState: 'free', trialDaysLeft: 6, license: null });
    expect(s.reasons).toEqual(['local_trial']);
    expect(s.message).toBe(STATE_MESSAGES.trial);
  });

  it.each([
    ['expired', activeOf({ edition: 'student', expiresAt: '2026-10-06T00:00:00Z', updatesUntil: '2026-10-06T00:00:00Z' }), 'expired'],
    ['update_window_passed', activeOf({ updatesUntil: '2026-10-01T00:00:00Z' }), 'update_window_passed'],
  ])('%s activation plus an active trial: trial state, license state and reason kept', (_name, activation, code) => {
    const s = status(combined(activation, START + 2 * DAY));
    expect(s).toMatchObject({ state: 'trial', pro: true, proSource: 'local_trial', licenseState: code });
    expect(s.reasons).toEqual([code, 'local_trial']);
    expect(s.license).toMatchObject({ store: 'gumroad' });
  });

  it('an invalid activation plus an active trial: trial state, the invalid reason is kept', () => {
    const s = status(combined({ kind: 'invalid', reason: 'tampered' }));
    expect(s).toMatchObject({ state: 'trial', licenseState: 'invalid', invalidReason: 'tampered', license: null });
    expect(s.reasons).toEqual(['tampered', 'local_trial']);
  });

  it('an ended trial leaves the license state; none leaves free', () => {
    const late = START + 8 * DAY;
    expect(status(combined(NONE, late))).toMatchObject({ state: 'free', pro: false, proSource: null, trial: { state: 'ended', daysLeft: 0 } });
    expect(status(combined(NONE, late, { kind: 'none' })).trial).toMatchObject({ state: 'available', daysLeft: null });
    expect(status(combined(NONE, late, { kind: 'used' })).trial).toEqual({ state: 'ended', startedAt: null, endsAt: null, daysLeft: 0, remindToday: false, notice: null });
  });

  it('evaluateTrial: days left, boundaries and the guard-only end', () => {
    const at = (t, extra = {}) => evaluateTrial({ record, clock: clockAt(t, extra) });
    expect(at(START)).toMatchObject({ state: 'active', daysLeft: 7 });
    expect(at(START + 1)).toMatchObject({ daysLeft: 7 });
    expect(at(START + 5 * DAY)).toMatchObject({ daysLeft: 2 });
    expect(at(START + 7 * DAY - 60_000)).toMatchObject({ daysLeft: 1 });
    expect(at(START + 7 * DAY)).toMatchObject({ state: 'ended', daysLeft: 0, clockIssue: false });
    const clock = clockAt(START + DAY, { effective: START + 8 * DAY, rollback: true });
    expect(evaluateTrial({ record, clock })).toMatchObject({ state: 'ended', clockIssue: true });
    const e = combineEntitlements(evaluateLicense({ activation: NONE, buildInfo: B, clock }), evaluateTrial({ record, clock }));
    expect(status(e)).toMatchObject({ state: 'clock_issue', pro: false, trial: { state: 'ended' } });
    expect(status(e).message).toBe(STATE_MESSAGES.clock_issue);
  });

  it('remindToday is true on trial days 6 and 7 only, and never when a license gives Pro', () => {
    const remind = (t, activation = NONE) => status(combined(activation, t)).trial.remindToday;
    expect(remind(START + 4 * DAY + 23 * 3_600_000)).toBe(false);
    expect(remind(START + 5 * DAY)).toBe(true);
    expect(remind(START + 6 * DAY + 1000)).toBe(true);
    expect(remind(START + 7 * DAY)).toBe(false);
    expect(remind(START + 5 * DAY, activeOf())).toBe(false);
  });

  it('perks.founderBackground follows the stored edition founding, whatever the update window says', () => {
    const perk = (activation) => status(combined(activation, START + DAY, { kind: 'none' })).perks.founderBackground;
    expect(perk(activeOf({ edition: 'founding' }))).toBe(true);
    expect(perk(activeOf({ edition: 'founding', updatesUntil: '2026-10-01T00:00:00Z' }))).toBe(true);
    expect(perk(activeOf())).toBe(false);
    expect(perk(activeOf({ edition: 'family' }))).toBe(false);
    expect(perk({ kind: 'invalid', reason: 'tampered' })).toBe(false);
    expect(perk(NONE)).toBe(false);
  });
});

describe('loadBuildInfo', () => {
  let dist;
  beforeEach(() => {
    dist = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-dist-'));
  });
  afterEach(() => fs.rmSync(dist, { recursive: true, force: true }));
  const write = (text) => fs.writeFileSync(path.join(dist, BUILD_INFO_FILE), text);
  const MISSING = { buildDate: null, buildDateIso: null, source: 'missing', version: null };

  it('reads a valid file', () => {
    write('{"formatVersion":1,"buildDate":"2026-10-05T12:00:00Z","source":"git","version":"0.1.0"}\n');
    expect(loadBuildInfo({ distDir: dist, bundled: undefined })).toEqual({
      buildDate: ms('2026-10-05T12:00:00Z'),
      buildDateIso: '2026-10-05T12:00:00Z',
      source: 'git',
      version: '0.1.0',
    });
  });

  it.each([
    ['not json', 'nope'],
    ['wrong version', '{"formatVersion":2,"buildDate":"2026-10-05T12:00:00Z","source":"git","version":"1"}'],
    ['bad date', '{"formatVersion":1,"buildDate":"2026-10-05","source":"git","version":"1"}'],
    ['bad source', '{"formatVersion":1,"buildDate":"2026-10-05T12:00:00Z","source":"web","version":"1"}'],
    ['no version', '{"formatVersion":1,"buildDate":"2026-10-05T12:00:00Z","source":"git"}'],
    ['array', '[]'],
    ['oversized', `{"formatVersion":1,"buildDate":"2026-10-05T12:00:00Z","source":"git","version":"${'x'.repeat(1100)}"}`],
  ])('treats a malformed file (%s) as missing', (_name, text) => {
    write(text);
    expect(loadBuildInfo({ distDir: dist, bundled: undefined })).toEqual(MISSING);
  });

  it('treats an absent file as missing and prefers a bundled date', () => {
    expect(loadBuildInfo({ distDir: dist, bundled: undefined })).toEqual(MISSING);
    write('{"formatVersion":1,"buildDate":"2026-10-05T12:00:00Z","source":"git","version":"0.1.0"}');
    const bundled = loadBuildInfo({ distDir: dist, bundled: '2026-09-01T00:00:00Z' });
    expect(bundled).toMatchObject({ source: 'bundled', buildDateIso: '2026-09-01T00:00:00Z' });
    expect(loadBuildInfo({ distDir: dist, bundled: 'garbage' }).source).toBe('git');
  });

  it('uses an injected reader', () => {
    const info = loadBuildInfo({
      distDir: '/nowhere',
      bundled: undefined,
      readFile: () => '{"formatVersion":1,"buildDate":"2026-10-05T12:00:00Z","source":"env","version":"9.9.9"}',
    });
    expect(info).toMatchObject({ source: 'env', version: '9.9.9' });
  });
});


describe('trialNoticeFor (reverse trial notices, pure)', () => {
  const FRESH = { welcome: false, endingSoon: false, ended: false };
  const active = (daysLeft) => ({ state: 'active', startedAt: 1, endsAt: 2, daysLeft, clockIssue: false });
  const ended = { state: 'ended', startedAt: 1, endsAt: 2, daysLeft: 0, clockIssue: false };
  const notice = (over) => trialNoticeFor({ trialEval: active(7), proSource: 'local_trial', state: 'trial', flags: FRESH, ...over });

  it('welcome while more than 2 days are left, ending_soon at 2 or fewer, ended after the end', () => {
    expect(notice()).toBe('welcome');
    expect(notice({ trialEval: active(3) })).toBe('welcome');
    expect(notice({ trialEval: active(2) })).toBe('ending_soon');
    expect(notice({ trialEval: active(1) })).toBe('ending_soon');
    expect(notice({ trialEval: ended, proSource: null, state: 'free' })).toBe('ended');
  });

  it('a shown flag silences only its own notice', () => {
    expect(notice({ flags: { ...FRESH, welcome: true } })).toBeNull();
    expect(notice({ trialEval: active(2), flags: { ...FRESH, welcome: true } })).toBe('ending_soon');
    expect(notice({ trialEval: active(2), flags: { welcome: true, endingSoon: true, ended: false } })).toBeNull();
    expect(notice({ trialEval: ended, proSource: null, state: 'free', flags: { ...FRESH, ended: true } })).toBeNull();
  });

  it('is null for a license, a clock issue, a clock-flagged end, missing flags and a record with no start', () => {
    expect(notice({ proSource: 'license', state: 'pro' })).toBeNull();
    expect(notice({ trialEval: ended, proSource: null, state: 'clock_issue' })).toBeNull();
    expect(notice({ trialEval: { ...ended, clockIssue: true }, proSource: null, state: 'free' })).toBeNull();
    expect(notice({ flags: null })).toBeNull();
    expect(notice({ flags: undefined })).toBeNull();
    expect(notice({ trialEval: { state: 'ended', startedAt: null, endsAt: null, daysLeft: 0, clockIssue: false }, proSource: null, state: 'free' })).toBeNull();
    expect(notice({ trialEval: { state: 'available', startedAt: null, endsAt: null, daysLeft: null, clockIssue: false } })).toBeNull();
  });

  it.each([
    ['update_window_passed', activeOf({ updatesUntil: '2026-10-01T00:00:00Z' })],
    ['expired', activeOf({ edition: 'student', expiresAt: '2026-10-06T00:00:00Z', updatesUntil: '2026-10-06T00:00:00Z' })],
  ])('a stored license that lapsed (%s) never gets the trial ended notice', (code, activation) => {
    const B = build('2026-10-05T12:00:00Z');
    const START = ms('2026-10-05T12:00:00Z');
    const trial = { kind: 'valid', startedAt: START, endsAt: START + 7 * DAY };
    const clock = clockAt(START + 20 * DAY);
    const evaluation = combineEntitlements(evaluateLicense({ activation, buildInfo: B, clock }), evaluateTrial({ record: trial, clock }));
    expect(evaluation).toMatchObject({ licenseState: code, pro: false });
    expect(evaluation.trialEval.state).toBe('ended');
    const status = toStatus(evaluation, { buildInfo: B, version: '0.1.0', noticeFlags: FRESH });
    expect(status.license).not.toBeNull();
    expect(status.trial).toMatchObject({ state: 'ended', notice: null });
    // the same trial without a license record still gets it
    const unlicensed = combineEntitlements(evaluateLicense({ activation: NONE, buildInfo: B, clock }), evaluateTrial({ record: trial, clock }));
    expect(toStatus(unlicensed, { buildInfo: B, version: '0.1.0', noticeFlags: FRESH }).trial.notice).toBe('ended');
  });
});
