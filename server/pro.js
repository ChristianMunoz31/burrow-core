// The one seam for Burrow Pro gating (docs/LICENSING.md section 15).
// Gate by CAPABILITY, never by quota or provider. Free forever: every data module, export,
// import, backups, privacy controls, Network and AI settings, model pull, BYO cloud AI and
// one read-only Javi insight per page. Pro: Javi follow-ups and conversations, Javi characters other
// than Butler (Butler stays free), Javi tools and actions, briefings, Explain, and the reserved features below. This file reads the license
// through getEntitlements() only.
// Store builds add a per-feature rule for lapsed perpetual licenses (docs/LICENSING.md 6.1): every id here
// also needs an introducedAt entry in server/license/proFeatureDates.js.
import { getEntitlements } from './license/index.js';

/**
 * Registry of Pro capabilities. `used: false` ids are reserved for future features: nothing
 * checks them yet, and `requirePro`/`assertPro` throw on one. When a feature is actually gated,
 * flip its id to `used: true` in the same change.
 * Model availability for a future "Pro model pack" would check
 * `isProEnabled()` next to the model list in server/ai/registry.js (see PRO_FEATURES.model_pack);
 * nothing is built for it today.
 */
export const PRO_FEATURES = Object.freeze({
  javi_tools: Object.freeze({ used: true, label: 'Javi tools and actions' }),
  javi_conversation: Object.freeze({ used: true, label: 'Javi follow-ups and conversations' }),
  javi_characters: Object.freeze({ used: true, label: 'Javi characters' }),
  briefings: Object.freeze({ used: true, label: 'Daily briefings' }),
  explain: Object.freeze({ used: true, label: 'Explain patterns' }),
  folder_qa: Object.freeze({ used: true, label: 'Ask your folders' }),
  folder_report: Object.freeze({ used: true, label: 'Folder cross-file reports' }),
  folder_auto_rescan: Object.freeze({ used: true, label: 'Scheduled folder re-scan' }),
  insights: Object.freeze({ used: false, label: 'Cross-domain insights (findings are computed locally and stay free)' }),
  semantic_search: Object.freeze({ used: false, label: 'Ask your archive' }),
  automations: Object.freeze({ used: false, label: 'Automations' }),
  smart_importers: Object.freeze({ used: false, label: 'Smart importers' }),
  scheduled_external_backups: Object.freeze({ used: false, label: 'Scheduled external backups' }),
  weekly_reviews: Object.freeze({ used: false, label: 'Weekly reviews' }),
  model_pack: Object.freeze({ used: false, label: 'Pro model pack' }),
});

/** Store build, license past its update window, feature released after it. Fixed copy. */
export const MSG_NEWER_LICENSE =
  "This feature came out after your license's updates ended. It is included in a newer Burrow Pro license.";

export const NEWER_LICENSE_REASON = 'newer_license_required';

export const MSG_PRO_REQUIRED =
  'This is a Burrow Pro feature. Activate a license in Settings > License. Your data and everything in Burrow Free keep working.';

/** @param {string} feature @returns {void} */
function assertKnownFeature(feature) {
  if (!Object.hasOwn(PRO_FEATURES, feature)) throw new Error(`Unknown Pro feature: ${String(feature)}`);
  if (PRO_FEATURES[feature].used !== true) throw new Error(`Reserved Pro feature is not gated yet: ${String(feature)}`);
}

/** A Pro capability was used without Pro. Always a 403. */
export class ProRequiredError extends Error {
  /**
   * @param {string} feature A PRO_FEATURES id.
   * @param {string | null} [reason] 'newer_license_required' for the Store per-feature rule, else null.
   */
  constructor(feature, reason = null) {
    const message = reason === NEWER_LICENSE_REASON ? MSG_NEWER_LICENSE : MSG_PRO_REQUIRED;
    super(message);
    this.name = 'ProRequiredError';
    this.code = 'pro_required';
    this.httpStatus = 403;
    this.feature = feature;
    this.publicMessage = message;
    this.reason = reason === NEWER_LICENSE_REASON ? reason : null;
  }
}

/**
 * Whether Pro is on (a license or an active local trial). Never throws: any failure reads as free.
 * @returns {boolean}
 */
export function isProEnabled() {
  try {
    return getEntitlements().pro === true;
  } catch {
    return false;
  }
}

/**
 * Whether one capability may be used now. Never throws: any failure reads as denied.
 * @param {string} feature A PRO_FEATURES id.
 * @returns {{ allowed: boolean, reason: 'newer_license_required' | null }}
 */
export function proAccess(feature) {
  assertKnownFeature(feature);
  try {
    const e = getEntitlements();
    if (e.pro === true) return { allowed: true, reason: null };
    if (e.proScope === 'features_until') {
      return e.proFeatures?.included?.includes(feature) === true
        ? { allowed: true, reason: null }
        : { allowed: false, reason: NEWER_LICENSE_REASON };
    }
    return { allowed: false, reason: null };
  } catch {
    return { allowed: false, reason: null };
  }
}

/**
 * For library code (the scheduler): throws ProRequiredError when Pro is off.
 * @param {string} feature A PRO_FEATURES id.
 * @throws {ProRequiredError}
 */
export function assertPro(feature) {
  assertKnownFeature(feature);
  const access = proAccess(feature);
  if (!access.allowed) throw new ProRequiredError(feature, access.reason);
}

/**
 * Express middleware: answers 403 { error: 'pro_required', feature, message } (no-store) when
 * Pro is off. Mount it first on a Pro route, before body validation and before requireAi, so a
 * free user never reaches an Ollama probe, a queue slot or any SSE header.
 * @param {string} feature A PRO_FEATURES id.
 * @returns {import('express').RequestHandler}
 */
export function requirePro(feature) {
  assertKnownFeature(feature);
  return (_req, res, next) => gate(res, next, feature);
}

/**
 * Answers 403 pro_required (or the Store newer-license variant) unless the capability is allowed now.
 * @param {import('express').Response} res
 * @param {Function} next
 * @param {string} feature
 */
function gate(res, next, feature) {
  const access = proAccess(feature);
  if (access.allowed) return next();
  return sendProRequired(res, feature, access.reason);
}

/**
 * @param {import('express').Response} res
 * @param {string} feature
 * @param {string | null} reason
 */
function sendProRequired(res, feature, reason) {
  res.set('Cache-Control', 'no-store');
  if (reason === NEWER_LICENSE_REASON) {
    return res.status(403).json({ error: 'pro_required', feature, reason: NEWER_LICENSE_REASON, message: MSG_NEWER_LICENSE });
  }
  return res.status(403).json({ error: 'pro_required', feature, message: MSG_PRO_REQUIRED });
}

/**
 * Like requirePro, but only when `predicate(req)` says this request uses the Pro capability.
 * A predicate that throws gates the request (fail closed). the entitlements are read only for a
 * gated request, so an ungated one never touches the entitlements.
 * @param {string} feature A PRO_FEATURES id.
 * @param {(req: import('express').Request) => boolean} predicate
 * @returns {import('express').RequestHandler}
 */
export function requireProWhen(feature, predicate) {
  assertKnownFeature(feature);
  return (req, res, next) => {
    let gated;
    try {
      gated = predicate(req) !== false;
    } catch {
      gated = true;
    }
    if (!gated) return next();
    return gate(res, next, feature);
  };
}

/** The build has no Pro module (a Free build of the public core). Fixed copy, mirrored by PRO_NOT_INCLUDED_COPY in src/constants/proFeatures.js. */
export const MSG_PRO_NOT_INCLUDED =
  'This build of Burrow does not include Burrow Pro features. Your data and everything in Burrow Free keep working.';

/**
 * Express middleware for a Pro route whose handler is not in this build: 501
 * { error: 'pro_not_included', code: 'pro_not_included', feature, message } (no-store). Mounted by
 * server/proExtensions.js after requirePro(feature), so Free entitlements always get the 403 first.
 * @param {string} feature A PRO_FEATURES id.
 * @returns {import('express').RequestHandler}
 */
export function sendProNotIncluded(feature) {
  assertKnownFeature(feature);
  return (_req, res) => {
    res.set('Cache-Control', 'no-store');
    return res.status(501).json({ error: 'pro_not_included', code: 'pro_not_included', feature, message: MSG_PRO_NOT_INCLUDED });
  };
}
