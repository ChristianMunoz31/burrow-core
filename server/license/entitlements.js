// Pure evaluation of the stored activation against build info and a clock observation (docs/LICENSING.md section 9).
import { DAY_MS, ROLLBACK_TOLERANCE_MS, TRIAL_REMIND_DAYS_LEFT, formatLicenseDate } from './constants.js';
import { splitProFeatures } from './proFeatureDates.js';
import { getStore } from './stores/index.js';

export const STATE_MESSAGES = Object.freeze({
  free: "You're using Burrow Free. Everything you need to track your money and journal is included. If you bought Burrow Pro, paste your license key below and click Activate.",
  pro: 'Burrow Pro is active. Thank you for supporting Burrow.',
  trial: 'Your Pro trial is active: {n} days left.',
  update_window_passed:
    'This version of Burrow was released after your updates ended, so Pro is off in this version. Your data is untouched, and every version released on or before your update date keeps Pro forever.',
  expired:
    'Your license has ended, so Pro features are off. Your data is safe and everything in Burrow Free keeps working. If you have a new license key, paste it below and click Activate.',
  clock_issue:
    "Your computer's clock seems to be set earlier than the last time Burrow ran, so Burrow can't confirm your license yet. Check that the date and time are correct. This clears on its own once the clock is right, and your data is safe.",
  invalid:
    "Burrow couldn't confirm the license saved on this computer, so Pro features are off. Your data is safe. Paste your license key below and click Activate to set it up again.",
});

/** Status copy for a Store build's perpetual license past its update window (not a state of its own). */
export const FEATURES_UNTIL_MESSAGE =
  "Your license's updates have ended. Every Pro feature released during your update period stays on for good. Pro features released later need a newer Burrow Pro license. Your data is untouched.";

/**
 * Pure evaluation of the stored activation against build info and a clock observation (docs/LICENSING.md 9.1).
 * @param {{
 *   activation: { kind: 'none' } | { kind: 'active', record: object } | { kind: 'invalid', reason: 'tampered' | 'no_key' },
 *   buildInfo: { buildDate: number | null },
 *   clock: { now: number, effective: number, rollback: boolean },
 *   rejectTestRecords?: boolean,
 *   distribution?: 'direct' | 'store',
 * }} input (`rejectTestRecords`: a `test: true` record never gives Pro, see channelSeam.rejectsTestRecords;
 *   `distribution`: only a 'store' build keeps per-feature Pro after the update window, docs/LICENSING.md 6.1)
 * @returns {{
 *   state: 'free' | 'pro' | 'update_window_passed' | 'expired' | 'clock_issue' | 'invalid',
 *   pro: boolean, edition: string | null, reasons: string[], invalidReason: string | null,
 *   license: object | null, trialDaysLeft: number | null, rollback: boolean,
 *   proScope: 'features_until' | null, proFeatures: { included: string[], locked: string[] } | null,
 * }}
 */
export function evaluateLicense({ activation, buildInfo, clock, rejectTestRecords = false, distribution = 'direct' }) {
  const record = activation?.kind === 'active' ? activation.record : null;
  const advisories = [];
  if (clock.rollback) advisories.push('clock_rollback');
  if (buildInfo.buildDate === null || buildInfo.buildDate === undefined) advisories.push('no_build_info');
  if (record?.test === true) advisories.push('test_purchase');

  const done = (state, own, extra = {}) => ({
    state,
    pro: state === 'pro',
    edition: null,
    reasons: [...new Set([...(own ? [own] : []), ...advisories])],
    invalidReason: null,
    license: null,
    trialDaysLeft: null,
    rollback: clock.rollback,
    proScope: null,
    proFeatures: null,
    ...extra,
  });

  if (!activation || activation.kind === 'none') return done('free', 'no_license');
  if (activation.kind === 'invalid') return done('invalid', activation.reason, { invalidReason: activation.reason });

  if (rejectTestRecords && record.test === true) return done('free', 'test_purchase');

  const store = getStore(record.store);
  const license = {
    store: record.store,
    storeLabel: store?.label ?? record.store,
    edition: record.edition,
    purchaseDate: record.purchaseDate,
    updatesUntil: record.updatesUntil,
    expiresAt: record.expiresAt,
    activatedAt: record.activatedAt,
    email: record.email,
    keyLast4: record.keyLast4,
    test: record.test,
    canDeactivate: store?.canDeactivate === true,
  };
  const extra = { edition: record.edition, license };
  const expiresAt = record.expiresAt === null ? null : Date.parse(record.expiresAt);

  // Fail closed: a yearly license cannot be confirmed while the clock reads earlier than the guard allows.
  if (expiresAt !== null && clock.rollback && clock.now < expiresAt) return done('clock_issue', 'clock_issue', extra);
  if (expiresAt !== null && expiresAt <= clock.effective) return done('expired', 'expired', extra);
  const buildDate = buildInfo.buildDate ?? clock.effective;
  const updatesUntil = Date.parse(record.updatesUntil);
  if (buildDate > updatesUntil) {
    // Store builds auto-update and cannot be downgraded: a perpetual license (no expiresAt: Standard, Founding,
    // Family) keeps the Pro features released on or before updatesUntil. `pro` stays false so anything that asks
    // for plain Pro fails closed. Only dates are compared (no wall clock), so a rolled-back clock unlocks nothing.
    if (distribution === 'store' && expiresAt === null) {
      return done('update_window_passed', 'update_window_passed', {
        ...extra,
        proScope: 'features_until',
        proFeatures: splitProFeatures(updatesUntil),
      });
    }
    return done('update_window_passed', 'update_window_passed', extra);
  }
  return done('pro', null, extra);
}

const NO_TRIAL = Object.freeze({ state: 'available', startedAt: null, endsAt: null, daysLeft: null, clockIssue: false });

/**
 * Pure evaluation of the local trial record against the guarded clock (docs/LICENSING.md section 8).
 * @param {{
 *   record: { kind: 'none' } | { kind: 'valid', startedAt: number, endsAt: number } | { kind: 'used' },
 *   clock: { now: number, effective: number, rollback: boolean },
 * }} input
 * @returns {{ state: 'available' | 'active' | 'ended', startedAt: number | null, endsAt: number | null,
 *   daysLeft: number | null, clockIssue: boolean }}
 */
export function evaluateTrial({ record, clock }) {
  if (!record || record.kind === 'none') return NO_TRIAL;
  if (record.kind !== 'valid') return { state: 'ended', startedAt: null, endsAt: null, daysLeft: 0, clockIssue: false };
  const { startedAt, endsAt } = record;
  // The trial keeps its own floor (its start), kept out of the shared guard so a bad clock at the start
  // cannot push the guard's high-water mark.
  const effective = Math.max(clock.effective, startedAt);
  const rollback = clock.rollback || clock.now < startedAt - ROLLBACK_TOLERANCE_MS;
  if (endsAt > effective) {
    if (rollback) return { state: 'ended', startedAt, endsAt, daysLeft: 0, clockIssue: true };
    return { state: 'active', startedAt, endsAt, daysLeft: Math.max(0, Math.ceil((endsAt - effective) / DAY_MS)), clockIssue: false };
  }
  return { state: 'ended', startedAt, endsAt, daysLeft: 0, clockIssue: clock.rollback && clock.now < endsAt };
}

/**
 * Combines the license evaluation with the local trial (docs/LICENSING.md 8, 9.1). A license that
 * gives Pro always wins; otherwise an active local trial gives Pro.
 * @param {ReturnType<typeof evaluateLicense>} evaluation
 * @param {ReturnType<typeof evaluateTrial>} trialEval
 */
export function combineEntitlements(evaluation, trialEval) {
  const base = { ...evaluation, licenseState: evaluation.state, trialEval };
  if (evaluation.pro) return { ...base, proSource: 'license' };
  if (trialEval.state === 'active') {
    return {
      ...base,
      state: 'trial',
      pro: true,
      edition: 'trial',
      proScope: null,
      proFeatures: null,
      trialDaysLeft: trialEval.daysLeft,
      reasons: [...evaluation.reasons.filter((r) => r !== 'no_license'), 'local_trial'],
      proSource: 'local_trial',
    };
  }
  if (trialEval.clockIssue) {
    return { ...base, state: 'clock_issue', reasons: [...new Set([...evaluation.reasons, 'clock_issue'])], proSource: null };
  }
  return { ...base, proSource: null };
}

/**
 * Which one-time trial notice is due (reverse trial). Pure and cosmetic: it never affects entitlement.
 * Null for anyone with a stored license (even one whose Pro lapsed: update window passed, expired or a clock
 * problem on it), a clock problem, missing flags or a trial with no valid record.
 * @param {{
 *   trialEval: ReturnType<typeof evaluateTrial>, proSource: string | null, state: string,
 *   flags: { welcome: boolean, endingSoon: boolean, ended: boolean } | null | undefined,
 *   license?: object | null,
 * }} input
 * @returns {'welcome' | 'ending_soon' | 'ended' | null}
 */
export function trialNoticeFor({ trialEval, proSource, state, flags, license = null }) {
  if (!flags || !trialEval || trialEval.startedAt === null) return null;
  if (license || proSource === 'license' || state === 'clock_issue') return null;
  if (trialEval.state === 'active') {
    if (trialEval.daysLeft <= TRIAL_REMIND_DAYS_LEFT) return flags.endingSoon ? null : 'ending_soon';
    return flags.welcome ? null : 'welcome';
  }
  if (trialEval.state === 'ended' && !trialEval.clockIssue && !flags.ended) return 'ended';
  return null;
}

/**
 * Shapes an evaluation (combined or license-only) into the license status body (docs/LICENSING.md 10.1).
 * @param {ReturnType<typeof combineEntitlements>} evaluation
 * @param {{
 *   buildInfo: { buildDateIso: string | null, source: string }, version: string,
 *   noticeFlags?: { welcome: boolean, endingSoon: boolean, ended: boolean } | null,
 * }} ctx
 */
export function toStatus(evaluation, { buildInfo, version, noticeFlags = null }) {
  const t = evaluation.trialEval ?? NO_TRIAL;
  const proSource = evaluation.proSource === undefined ? (evaluation.pro ? 'license' : null) : evaluation.proSource;
  return {
    state: evaluation.state,
    pro: evaluation.pro,
    edition: evaluation.edition,
    reasons: evaluation.reasons,
    // A clock problem is the more urgent thing to tell the user, so it wins over the features-until note.
    message:
      evaluation.proScope === 'features_until' && evaluation.state !== 'clock_issue'
        ? FEATURES_UNTIL_MESSAGE
        : STATE_MESSAGES[evaluation.state],
    invalidReason: evaluation.invalidReason,
    license: evaluation.license,
    trialDaysLeft: evaluation.trialDaysLeft,
    build: { date: buildInfo.buildDateIso, source: buildInfo.source, version },
    clock: { rollbackDetected: evaluation.rollback },
    licenseState: evaluation.licenseState ?? evaluation.state,
    proSource,
    // Present only for a Store build's perpetual license past its update window (docs/LICENSING.md 6.1).
    ...(evaluation.proScope === 'features_until'
      ? { proScope: evaluation.proScope, proFeatures: evaluation.proFeatures }
      : {}),
    trial: {
      state: t.state,
      startedAt: t.startedAt === null ? null : formatLicenseDate(t.startedAt),
      endsAt: t.endsAt === null ? null : formatLicenseDate(t.endsAt),
      daysLeft: t.daysLeft,
      remindToday: t.state === 'active' && t.daysLeft <= TRIAL_REMIND_DAYS_LEFT && proSource !== 'license',
      notice: trialNoticeFor({ trialEval: t, proSource, state: evaluation.state, flags: noticeFlags, license: evaluation.license }),
    },
    perks: { founderBackground: evaluation.license?.edition === 'founding' },
  };
}
