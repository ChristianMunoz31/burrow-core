// When each Pro capability first shipped (docs/LICENSING.md section 6.1). Pure data and helpers, no I/O.
//
// Store rule: a Standard, Founding or Family buyer always keeps Pro, but only the Pro features whose
// introducedAt is on or before the license's updatesUntil. The Microsoft Store auto-updates and cannot be
// downgraded, so the build-date rule alone would switch every Pro feature off after the update window.
//
// introducedAt is the BUILD DATE of the first released version that shipped the feature, in the same unit and
// precision the license compares against updatesUntil (a `YYYY-MM-DDTHH:MM:SSZ` license date; the build date is
// the commit time baked into the artifact, see buildInfo.js). It is compared like buildDate <= updatesUntil:
// inclusive, in epoch ms, never with the wall clock.
//
// null means "not shipped yet" (reserved ids) and is treated as newer than any update window, so a lapsed
// license never gets it. Every id in PRO_FEATURES (server/pro.js) MUST have an entry here (proFeatureDates.test.js
// fails otherwise), and a feature that starts shipping MUST get its first release build date here.
//
// Sources (git history and tag commit times; a release build records `git log -1 --format=%ct` of the tag commit):
//   javi_tools, briefings, explain: gated by commit a81c8d7 "feat(pro): gate Javi tools, briefings and insights
//     behind Pro by capability" (2026-10-05T20:58:14Z). First tag containing it: v0.2.0, tag commit a438b53,
//     committed 2026-10-05T18:10:21-04:00 = 2026-10-05T22:10:21Z. CHANGELOG.md 0.2.0 is dated 2026-10-05.
//   javi_conversation: genuinely new since v0.4.1. Before main commit 7fc0bed "feat(javi): Free gets one read-only
//     insight per page; conversational Javi is Pro (#53)" (2026-10-08T11:44:40-04:00 = 2026-10-08T15:44:40Z) follow-ups
//     and conversations were Free. It first ships in 1.0.0, whose build date is not known yet, so introducedAt is the
//     merge date of that main commit. This is a conservative approximation of the 1.0.0 build date: a date slightly
//     earlier than the real one can only help a buyer (a license with updatesUntil on or after it keeps the feature),
//     and every real license has updatesUntil >= 2027-10-05, so nobody is affected. After the 1.0.0 release it may be
//     replaced with the 1.0.0 tag commit time (docs/RELEASING.md).
//   folder_qa, folder_report, folder_auto_rescan: new with the Folders module (2026-10-08). Same precedent as
//     javi_conversation: the first release containing them has no build date yet, so introducedAt is the date the
//     feature was written. An early date can only help a buyer, and every real license has updatesUntil on or
//     after 2027-10-05, so nobody is affected. Replace it with the release tag commit time once it ships.
//   javi_characters: Valet, Concierge and Majordomo are Pro (owner decision 2026-10-15; Butler stays free). Same precedent
//     as folder_*: the first release containing the gate has no build date yet, so introducedAt is the date the
//     feature was written. An early date can only help a buyer, and every real license has updatesUntil on or
//     after 2027-10-05, so nobody is affected. Replace it with the release tag commit time once it ships.
//   insights: reserved ("findings are computed locally and stay free"); nothing is gated yet.
//   semantic_search, automations, smart_importers, scheduled_external_backups, weekly_reviews, model_pack:
//     reserved, not shipped.
import { parseLicenseDate } from './constants.js';

export const PRO_FEATURE_INTRODUCED_AT = Object.freeze({
  javi_tools: '2026-10-05T22:10:21Z',
  javi_conversation: '2026-10-08T15:44:40Z',
  javi_characters: '2026-10-15T00:00:00Z',
  briefings: '2026-10-05T22:10:21Z',
  explain: '2026-10-05T22:10:21Z',
  folder_qa: '2026-10-08T00:00:00Z',
  folder_report: '2026-10-08T00:00:00Z',
  folder_auto_rescan: '2026-10-08T00:00:00Z',
  insights: null,
  semantic_search: null,
  automations: null,
  smart_importers: null,
  scheduled_external_backups: null,
  weekly_reviews: null,
  model_pack: null,
});

/**
 * @param {string} feature A PRO_FEATURES id.
 * @param {Readonly<Record<string, string | null>>} [dates]
 * @returns {number | null} epoch ms, or null (not shipped, unknown id or an unreadable date: all read as "newer")
 */
export function proFeatureIntroducedMs(feature, dates = PRO_FEATURE_INTRODUCED_AT) {
  if (!Object.hasOwn(dates, feature)) return null;
  return parseLicenseDate(dates[feature]);
}

/**
 * Splits every registered Pro feature by whether a license whose updates ended at `updatesUntilMs` still includes it.
 * A feature is included when introducedAt <= updatesUntil (inclusive). Pure: no clock.
 * @param {number} updatesUntilMs
 * @param {Readonly<Record<string, string | null>>} [dates]
 * @returns {{ included: string[], locked: string[] }}
 */
export function splitProFeatures(updatesUntilMs, dates = PRO_FEATURE_INTRODUCED_AT) {
  const included = [];
  const locked = [];
  for (const id of Object.keys(dates)) {
    const introduced = proFeatureIntroducedMs(id, dates);
    (introduced !== null && introduced <= updatesUntilMs ? included : locked).push(id);
  }
  return { included, locked };
}
