// Store builds: a perpetual license past its update window keeps the Pro features released on or before
// updatesUntil (docs/LICENSING.md 6.1). Direct builds keep the plain update_window_passed rule. Pure
// evaluation first, then end to end through activateLicense with an injected clock, fetch and build info.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node-fetch', () => ({
  default: vi.fn(async () => {
    throw new Error('real fetch must not be used');
  }),
}));

import { FEATURES_UNTIL_MESSAGE, STATE_MESSAGES, combineEntitlements, evaluateLicense, evaluateTrial, toStatus } from '../../license/entitlements.js';
import { PRO_FEATURE_INTRODUCED_AT, proFeatureIntroducedMs, splitProFeatures } from '../../license/proFeatureDates.js';
import { activateLicense, getEntitlements, getLicenseStatus, resetLicenseForTests } from '../../license/index.js';
import { queueGumroad, GUMROAD_FREE_PRODUCT_ID } from './fixtures/storeResponses.js';
import { DAY, activeOf, createHarness, iso } from './helpers.js';

const ms = (value) => Date.parse(value);
const clockAt = (now, extra = {}) => ({ now, effective: now, hwm: now, rollback: false, persisted: false, ...extra });
const build = (value) => ({ buildDate: ms(value), buildDateIso: value, source: 'git', version: '0.1.0' });
const NOW = ms('2027-12-01T00:00:00Z');
const SHIPPED = Object.keys(PRO_FEATURE_INTRODUCED_AT).filter((id) => PRO_FEATURE_INTRODUCED_AT[id] !== null);
const RESERVED = Object.keys(PRO_FEATURE_INTRODUCED_AT).filter((id) => PRO_FEATURE_INTRODUCED_AT[id] === null);
const FIRST = PRO_FEATURE_INTRODUCED_AT.javi_tools;
// Shipped since v0.2.0; javi_conversation is newer (first ships in 1.0.0, dated at the merge of the Free-one-insight change).
const AT_FIRST = SHIPPED.filter((id) => PRO_FEATURE_INTRODUCED_AT[id] === FIRST);
// The Folders module (2026-10-08) sits between the first release and javi_conversation.
const FOLDER_IDS = ['folder_qa', 'folder_report', 'folder_auto_rescan'];
const FOLDERS = PRO_FEATURE_INTRODUCED_AT.folder_qa;
const CONVERSATION = PRO_FEATURE_INTRODUCED_AT.javi_conversation;
const CHARACTERS = PRO_FEATURE_INTRODUCED_AT.javi_characters;
const lapsedOf = (overrides, distribution = 'store', buildIso = '2028-01-01T00:00:00Z', clock = clockAt(NOW)) =>
  evaluateLicense({ activation: activeOf({ updatesUntil: '2027-09-30T14:02:11Z', ...overrides }), buildInfo: build(buildIso), clock, distribution });

describe('the registry dates', () => {
  it('every shipped feature has a readable date and the reserved ones are null', () => {
    expect([...SHIPPED].sort()).toEqual(['briefings', 'explain', 'folder_auto_rescan', 'folder_qa', 'folder_report', 'javi_characters', 'javi_conversation', 'javi_tools']);
    for (const id of FOLDER_IDS) expect(proFeatureIntroducedMs(id)).toBe(ms('2026-10-08T00:00:00Z'));
    for (const id of AT_FIRST) expect(proFeatureIntroducedMs(id)).toBe(ms('2026-10-05T22:10:21Z'));
    expect([...AT_FIRST].sort()).toEqual(['briefings', 'explain', 'javi_tools']);
    expect(proFeatureIntroducedMs('javi_conversation')).toBe(ms('2026-10-08T15:44:40Z'));
    expect(proFeatureIntroducedMs('javi_characters')).toBe(ms('2026-10-15T00:00:00Z'));
    for (const id of RESERVED) expect(proFeatureIntroducedMs(id)).toBeNull();
    expect(proFeatureIntroducedMs('not_a_feature')).toBeNull();
  });

  it('includes a feature introduced exactly at updatesUntil, locks one a second later, and locks null', () => {
    const dates = { a: '2027-01-01T00:00:00Z', b: '2027-01-01T00:00:01Z', c: null, d: '2026-12-31T23:59:59Z' };
    expect(splitProFeatures(ms('2027-01-01T00:00:00Z'), dates)).toEqual({ included: ['a', 'd'], locked: ['b', 'c'] });
    expect(splitProFeatures(ms('2027-01-01T00:00:01Z'), dates)).toEqual({ included: ['a', 'b', 'd'], locked: ['c'] });
  });

  it('a date that is not a strict license date reads as newer (locked), so offsets and junk never unlock', () => {
    const dates = { a: '2026-10-05T22:10:21+00:00', b: '2026-10-05', c: 'soon', d: 12345 };
    expect(splitProFeatures(ms('2999-01-01T00:00:00Z'), dates)).toEqual({ included: [], locked: ['a', 'b', 'c', 'd'] });
  });

  it('the boundary follows the same ISO handling as updatesUntil: the second, in UTC', () => {
    const until = ms(FIRST);
    expect(splitProFeatures(until).included).toEqual(AT_FIRST);
    expect(splitProFeatures(ms(CHARACTERS)).included).toEqual(SHIPPED);
    expect(splitProFeatures(ms(CHARACTERS) - 1000).included).toEqual(SHIPPED.filter((id) => id !== 'javi_characters'));
    expect(splitProFeatures(ms(CONVERSATION)).included).toEqual(SHIPPED.filter((id) => id !== 'javi_characters'));
    expect(splitProFeatures(ms(CONVERSATION) - 1000).included).toEqual([...AT_FIRST, ...FOLDER_IDS]);
    expect(splitProFeatures(ms(FOLDERS)).included).toEqual([...AT_FIRST, ...FOLDER_IDS]);
    expect(splitProFeatures(ms(FOLDERS) - 1000).included).toEqual(AT_FIRST);
    expect(splitProFeatures(until - 1000).included).toEqual([]);
    expect(splitProFeatures(until - 1).included).toEqual([]);
    expect(splitProFeatures(ms(CONVERSATION)).locked).toEqual(['javi_characters', ...RESERVED]);
  });
});

describe('evaluateLicense in a Store build', () => {
  it.each([
    ['standard', {}],
    ['founding', { edition: 'founding' }],
    ['family', { edition: 'family' }],
    ['a legacy Lemon Squeezy record', { store: 'lemonsqueezy', variantId: '1001', instanceId: 'abc', edition: 'standard' }],
  ])('%s past its window: pro stays false, scope features_until, shipped features included, reserved locked', (_label, overrides) => {
    const e = lapsedOf(overrides);
    expect(e).toMatchObject({ state: 'update_window_passed', pro: false, reasons: ['update_window_passed'], proScope: 'features_until' });
    expect(e.proFeatures.included).toEqual(SHIPPED);
    expect(e.proFeatures.locked).toEqual(RESERVED);
  });

  it('locks every feature introduced after updatesUntil, including the shipped ones', () => {
    const e = lapsedOf({ updatesUntil: '2026-10-05T22:10:20Z' });
    expect(e.proFeatures.included).toEqual([]);
    expect(e.proFeatures.locked).toEqual(Object.keys(PRO_FEATURE_INTRODUCED_AT));
    // introducedAt == updatesUntil is included
    expect(lapsedOf({ updatesUntil: FIRST }).proFeatures.included).toEqual(AT_FIRST);
    expect(lapsedOf({ updatesUntil: FIRST }).proFeatures.locked).toContain('javi_conversation');
  });

  it('inside the window nothing changes: full Pro, no scope', () => {
    const e = lapsedOf({ updatesUntil: '2028-06-01T00:00:00Z' });
    expect(e).toMatchObject({ state: 'pro', pro: true, proScope: null, proFeatures: null });
    // the boundary: build == updatesUntil is Pro, one second later is the lapsed state
    expect(lapsedOf({}, 'store', '2027-09-30T14:02:11Z').state).toBe('pro');
    expect(lapsedOf({}, 'store', '2027-09-30T14:02:12Z').proScope).toBe('features_until');
  });

  it.each(['student', 'nonprofit'])('%s (yearly, expiresAt set) never gets the per-feature rule', (edition) => {
    const yearly = { edition, expiresAt: '2027-09-30T14:02:11Z', updatesUntil: '2027-09-30T14:02:11Z' };
    // active and inside the term: Pro
    expect(lapsedOf(yearly, 'store', '2027-06-01T00:00:00Z', clockAt(ms('2027-06-01T00:00:00Z')))).toMatchObject({ state: 'pro', pro: true, proScope: null });
    // expired: expires (an expiry is not an update window)
    expect(lapsedOf(yearly)).toMatchObject({ state: 'expired', pro: false, proScope: null, proFeatures: null });
    // build newer than the term with a clock still inside it: the current update_window_passed, no scope
    const early = clockAt(ms('2027-09-01T00:00:00Z'));
    expect(lapsedOf(yearly, 'store', '2028-01-01T00:00:00Z', early)).toMatchObject({ state: 'update_window_passed', pro: false, proScope: null, proFeatures: null });
  });

  it('a yearly edition under a rolled-back clock still reads clock_issue in a Store build', () => {
    const yearly = { edition: 'student', expiresAt: '2027-09-30T14:02:11Z', updatesUntil: '2027-09-30T14:02:11Z' };
    const rolled = clockAt(ms('2027-06-01T00:00:00Z'), { effective: ms('2027-09-01T00:00:00Z'), rollback: true });
    expect(lapsedOf(yearly, 'store', '2027-01-01T00:00:00Z', rolled)).toMatchObject({ state: 'clock_issue', pro: false, proScope: null });
  });

  it('a test record in a release build is free, an invalid or absent activation is unchanged', () => {
    const t = evaluateLicense({ activation: activeOf({ test: true }), buildInfo: build('2028-01-01T00:00:00Z'), clock: clockAt(NOW), rejectTestRecords: true, distribution: 'store' });
    expect(t).toMatchObject({ state: 'free', proScope: null });
    for (const activation of [{ kind: 'none' }, { kind: 'invalid', reason: 'tampered' }]) {
      expect(evaluateLicense({ activation, buildInfo: build('2028-01-01T00:00:00Z'), clock: clockAt(NOW), distribution: 'store' }).proScope).toBeNull();
    }
  });
});

describe('clock rollback cannot unlock anything for a perpetual edition', () => {
  it('the decision ignores the wall clock: rolled back, far in the past, or far in the future', () => {
    const base = lapsedOf({}).proFeatures;
    const clocks = [
      clockAt(ms('2024-02-01T00:00:00Z'), { effective: NOW, rollback: true }),
      clockAt(ms('2024-02-01T00:00:00Z')),
      clockAt(ms('2900-01-01T00:00:00Z')),
    ];
    for (const clock of clocks) {
      const e = lapsedOf({}, 'store', '2028-01-01T00:00:00Z', clock);
      expect(e.proFeatures).toEqual(base);
      expect(e.pro).toBe(false);
    }
  });

  it('an older updatesUntil never gains features from a later clock either', () => {
    const e = lapsedOf({ updatesUntil: '2026-10-05T22:10:20Z' }, 'store', '2028-01-01T00:00:00Z', clockAt(ms('2900-01-01T00:00:00Z')));
    expect(e.proFeatures.included).toEqual([]);
  });
});

describe('direct builds are unchanged', () => {
  const inputs = [
    ['inside the window', {}, '2027-06-01T00:00:00Z'],
    ['at the boundary', {}, '2027-09-30T14:02:11Z'],
    ['one second past', {}, '2027-09-30T14:02:12Z'],
    ['long past', {}, '2030-01-01T00:00:00Z'],
    ['founding past', { edition: 'founding' }, '2030-01-01T00:00:00Z'],
    ['student past, clock early', { edition: 'student', expiresAt: '2027-09-30T14:02:11Z' }, '2030-01-01T00:00:00Z'],
  ];

  it.each(inputs)('%s: the default and an explicit "direct" give the same plain result as before', (_label, overrides, buildIso) => {
    const clock = overrides.edition === 'student' ? clockAt(ms('2027-09-01T00:00:00Z')) : clockAt(NOW);
    const activation = activeOf({ updatesUntil: '2027-09-30T14:02:11Z', ...overrides });
    const base = { activation, buildInfo: build(buildIso), clock };
    const implicit = evaluateLicense(base);
    const direct = evaluateLicense({ ...base, distribution: 'direct' });
    expect(direct).toEqual(implicit);
    expect(direct.proScope).toBeNull();
    expect(direct.proFeatures).toBeNull();
    expect(direct.pro).toBe(direct.state === 'pro');
  });

  it('a lapsed direct license is update_window_passed with Pro off, the old copy and no scope in the status', () => {
    const e = combineEntitlements(lapsedOf({}, 'direct'), evaluateTrial({ record: { kind: 'none' }, clock: clockAt(NOW) }));
    expect(e).toMatchObject({ state: 'update_window_passed', pro: false, edition: 'standard', reasons: ['update_window_passed'] });
    const status = toStatus(e, { buildInfo: { buildDateIso: null, source: 'git' }, version: '1.0.0' });
    expect(status.message).toBe(STATE_MESSAGES.update_window_passed);
    expect(status).not.toHaveProperty('proScope');
    expect(status).not.toHaveProperty('proFeatures');
  });

  it('the store and direct results differ only in proScope and proFeatures (state, pro, edition, reasons are identical)', () => {
    const s = lapsedOf({}, 'store');
    const d = lapsedOf({}, 'direct');
    const strip = (e) => Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'proScope' && k !== 'proFeatures'));
    expect(strip(s)).toEqual(strip(d));
  });
});

describe('trials with a lapsed Store license', () => {
  const clock = clockAt(NOW);
  const lapsed = lapsedOf({});

  it('an ended trial gives no Pro, the license scope stays', () => {
    const ended = evaluateTrial({ record: { kind: 'valid', startedAt: NOW - 30 * DAY, endsAt: NOW - 16 * DAY }, clock });
    expect(ended.state).toBe('ended');
    const e = combineEntitlements(lapsed, ended);
    expect(e).toMatchObject({ state: 'update_window_passed', pro: false, proScope: 'features_until' });
  });

  it('an active trial gives full Pro and drops the scope (the trial is not feature scoped)', () => {
    const active = evaluateTrial({ record: { kind: 'valid', startedAt: NOW - DAY, endsAt: NOW + 13 * DAY }, clock });
    const e = combineEntitlements(lapsed, active);
    expect(e).toMatchObject({ state: 'trial', pro: true, proSource: 'local_trial', proScope: null, proFeatures: null });
  });

  it('an ended trial and no license is plain free with no scope', () => {
    const ended = evaluateTrial({ record: { kind: 'used' }, clock });
    const none = evaluateLicense({ activation: { kind: 'none' }, buildInfo: build('2028-01-01T00:00:00Z'), clock, distribution: 'store' });
    expect(combineEntitlements(none, ended)).toMatchObject({ state: 'free', pro: false, proScope: null });
  });
});

describe('the status body', () => {
  it('exposes proScope, the included and locked ids, the license dates and the fixed message', () => {
    const e = combineEntitlements(lapsedOf({}), evaluateTrial({ record: { kind: 'none' }, clock: clockAt(NOW) }));
    const status = toStatus(e, { buildInfo: { buildDateIso: '2028-01-01T00:00:00Z', source: 'git' }, version: '1.0.0' });
    expect(status).toMatchObject({
      state: 'update_window_passed',
      pro: false,
      proScope: 'features_until',
      proFeatures: { included: SHIPPED, locked: RESERVED },
      license: { updatesUntil: '2027-09-30T14:02:11Z' },
      message: FEATURES_UNTIL_MESSAGE,
    });
    expect(FEATURES_UNTIL_MESSAGE).not.toContain('—');
  });

  it('shows the clock-issue message, not the features-until note, when the clock is the problem', () => {
    const trialEval = { state: 'ended', startedAt: NOW - 30 * DAY, endsAt: NOW - 16 * DAY, daysLeft: 0, clockIssue: true };
    const e = combineEntitlements(lapsedOf({}), trialEval);
    expect(e).toMatchObject({ state: 'clock_issue', proScope: 'features_until' });
    const status = toStatus(e, { buildInfo: { buildDateIso: '2028-01-01T00:00:00Z', source: 'git' }, version: '1.0.0' });
    expect(status.state).toBe('clock_issue');
    expect(status.message).toBe(STATE_MESSAGES.clock_issue);
    expect(status.message).not.toBe(FEATURES_UNTIL_MESSAGE);
  });
});

// End to end through activateLicense: injected clock, fetch and build info, a real store build env.
describe('through the license module with BURROW_DISTRIBUTION=store', () => {
  let h;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(() => h.cleanup());

  const PURCHASE = ms('2026-09-30T14:02:11Z');
  const buildAt = (t) => ({ buildDate: t, buildDateIso: iso(t), source: 'git', version: '0.1.0' });
  const STORE = { BURROW_DISTRIBUTION: 'store' };
  const sale = (t) => ({ sale_timestamp: iso(t), created_at: iso(t) });

  it.each([
    ['standard', '(Standard)', 365],
    ['family', '(Family)', 365],
    ['founding', '(Founding)', 730],
  ])('%s: past the window the status keeps the shipped features and getEntitlements carries the scope', async (edition, variants, days) => {
    const until = PURCHASE + days * DAY;
    h.clock.t = until - DAY;
    h.init({ env: STORE, buildInfo: buildAt(until - DAY) });
    queueGumroad(h.fetch, { uses: 1, purchase: { variants, ...sale(PURCHASE) } });
    const active = await activateLicense({ licenseKey: '00000000-11111111-22222222-33333333' });
    expect(active).toMatchObject({ state: 'pro', pro: true });
    expect(active).not.toHaveProperty('proScope');

    resetLicenseForTests();
    h.clock.t = until + 10 * DAY;
    h.init({ env: STORE, buildInfo: buildAt(until + DAY) });
    const status = getLicenseStatus();
    expect(status).toMatchObject({
      state: 'update_window_passed',
      pro: false,
      edition,
      proScope: 'features_until',
      proFeatures: { included: SHIPPED, locked: RESERVED },
      message: FEATURES_UNTIL_MESSAGE,
    });
    expect(status.license.updatesUntil).toBe(iso(until));
    expect(getEntitlements()).toEqual({
      pro: false,
      edition,
      reasons: ['update_window_passed'],
      proScope: 'features_until',
      proFeatures: { included: SHIPPED, locked: RESERVED },
    });

    // the same record read by a DIRECT build: the old rule, no scope
    resetLicenseForTests();
    h.init({ env: {}, buildInfo: buildAt(until + DAY) });
    expect(getEntitlements()).toEqual({ pro: false, edition, reasons: ['update_window_passed'] });
    expect(getLicenseStatus()).not.toHaveProperty('proScope');
    expect(getLicenseStatus().message).toBe(STATE_MESSAGES.update_window_passed);
  });

  it('rolling the clock back after activation changes nothing for a perpetual edition', async () => {
    const until = PURCHASE + 365 * DAY;
    h.clock.t = until - DAY;
    h.init({ env: STORE, buildInfo: buildAt(until - DAY) });
    queueGumroad(h.fetch, { uses: 1, purchase: { variants: '(Standard)', ...sale(PURCHASE) } });
    await activateLicense({ licenseKey: '00000000-11111111-22222222-33333333' });

    resetLicenseForTests();
    h.clock.t = until + 10 * DAY;
    h.init({ env: STORE, buildInfo: buildAt(until + DAY) });
    const before = getLicenseStatus();

    resetLicenseForTests();
    h.clock.t = PURCHASE - 400 * DAY;
    h.init({ env: STORE, buildInfo: buildAt(until + DAY) });
    const after = getLicenseStatus();
    expect(after.clock.rollbackDetected).toBe(true);
    expect(after).toMatchObject({ state: 'update_window_passed', pro: false, proScope: 'features_until' });
    expect(after.proFeatures).toEqual(before.proFeatures);
  });

  it('a yearly student license that expired keeps today\'s behavior in a Store build', async () => {
    h.clock.t = PURCHASE + DAY;
    h.init({ env: STORE, buildInfo: buildAt(PURCHASE + DAY) });
    queueGumroad(h.fetch, { uses: 1, purchase: { product_id: GUMROAD_FREE_PRODUCT_ID, variants: '(Student)', ...sale(PURCHASE) } });
    const active = await activateLicense({ licenseKey: '00000000-11111111-22222222-33333333' });
    expect(active).toMatchObject({ state: 'pro', pro: true, edition: 'student' });

    resetLicenseForTests();
    h.clock.t = PURCHASE + 400 * DAY;
    h.init({ env: STORE, buildInfo: buildAt(PURCHASE + 399 * DAY) });
    const status = getLicenseStatus();
    expect(status).toMatchObject({ state: 'expired', pro: false });
    expect(status).not.toHaveProperty('proScope');
  });

  it('startup and status reads make no network call', async () => {
    h.clock.t = PURCHASE + 400 * DAY;
    h.init({ env: STORE, buildInfo: buildAt(PURCHASE + 400 * DAY) });
    getLicenseStatus();
    getEntitlements();
    expect(h.fetch).not.toHaveBeenCalled();
  });
});
