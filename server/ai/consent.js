// Cloud AI consent, category choices and the "try cloud" hint state, all in app_state.
//   ai.cloudConsent    { version, host, baseUrl, acceptedAt, acknowledgements } or absent
//   ai.cloudCategories partial map of category id -> boolean (missing keys use the defaults)
//   ai.cloudHint       { lastShownAt, dismissedAt }
// Consent is only valid for the version it was given at, the host it names and the exact
// normalized base URL, so a changed base URL (even a new path on the same host) or a
// new consent text needs a fresh, explicit yes. These keys are written only by the consent
// routes: the generic state route and the importer refuse every `ai.cloud*` key.
import { getState, setState } from '../dataAccess.js';
import { remove } from '../db/index.js';
import { resolveCloudCategories, sanitizeCloudCategories } from './privacy.js';

export const CLOUD_CONSENT_KEY = 'ai.cloudConsent';
export const CLOUD_CATEGORIES_KEY = 'ai.cloudCategories';
export const CLOUD_HINT_KEY = 'ai.cloudHint';
export const CLOUD_CONSENT_VERSION = 1;
export const CLOUD_CONSENT_ACKS = Object.freeze(['sends_data', 'pay_provider']);

const isIso = (v) => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));

/**
 * The saved consent record, or null when absent or malformed. Throws when storage fails.
 * @returns {Promise<{ version: number, host: string, baseUrl: string | null, acceptedAt: string, acknowledgements: string[] } | null>}
 */
export async function getCloudConsent() {
  const raw = await getState(CLOUD_CONSENT_KEY, null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.version) || typeof raw.host !== 'string' || !raw.host) return null;
  return {
    version: raw.version,
    host: raw.host,
    baseUrl: typeof raw.baseUrl === 'string' && raw.baseUrl ? raw.baseUrl : null,
    acceptedAt: isIso(raw.acceptedAt) ? raw.acceptedAt : '',
    acknowledgements: Array.isArray(raw.acknowledgements) ? raw.acknowledgements.filter((a) => CLOUD_CONSENT_ACKS.includes(a)) : [],
  };
}

/**
 * Whether a consent record covers the current version, `host` and the exact `baseUrl`. A record
 * must also carry both acknowledgements and a valid acceptedAt, so a hand-written row that
 * skipped the consent flow never counts. A record without a baseUrl is never current.
 * @param {{ version?: number, host?: string, baseUrl?: string | null, acceptedAt?: string, acknowledgements?: string[] } | null | undefined} consent
 * @param {string | null | undefined} host Hostname of the saved base URL.
 * @param {string | null | undefined} [baseUrl] Normalized saved base URL (origin plus path).
 * @returns {boolean}
 */
export function isConsentCurrent(consent, host, baseUrl) {
  if (!consent || consent.version !== CLOUD_CONSENT_VERSION) return false;
  if (typeof host !== 'string' || host === '' || consent.host !== host) return false;
  if (!Array.isArray(consent.acknowledgements) || !CLOUD_CONSENT_ACKS.every((a) => consent.acknowledgements.includes(a))) return false;
  if (!isIso(consent.acceptedAt)) return false;
  if (typeof consent.baseUrl !== 'string' || consent.baseUrl === '' || consent.baseUrl !== baseUrl) return false;
  return true;
}

/**
 * Store consent for `host` (and the normalized `baseUrl`) at the current version, with both acknowledgements.
 * @param {{ host: string, baseUrl?: string | null }} opts
 */
export async function recordCloudConsent({ host, baseUrl = null }) {
  const record = {
    version: CLOUD_CONSENT_VERSION,
    host,
    baseUrl: typeof baseUrl === 'string' && baseUrl ? baseUrl : null,
    acceptedAt: new Date().toISOString(),
    acknowledgements: [...CLOUD_CONSENT_ACKS],
  };
  await setState(CLOUD_CONSENT_KEY, record);
  return record;
}

/** Remove the consent record (cloud AI stays off until it is given again). */
export async function clearCloudConsent() {
  remove('app_state', { where: { key: CLOUD_CONSENT_KEY } });
}

/**
 * Every category with its effective boolean. Throws when storage fails.
 * @returns {Promise<Record<string, boolean>>}
 */
export async function getCloudCategories() {
  return resolveCloudCategories(await getState(CLOUD_CATEGORIES_KEY, null));
}

/**
 * Merge a validated patch into the saved choices.
 * @param {Record<string, boolean>} patch
 * @returns {Promise<Record<string, boolean>>} The effective map.
 */
export async function updateCloudCategories(patch) {
  const current = sanitizeCloudCategories(await getState(CLOUD_CATEGORIES_KEY, null));
  const next = { ...current, ...sanitizeCloudCategories(patch) };
  await setState(CLOUD_CATEGORIES_KEY, next);
  return resolveCloudCategories(next);
}

/** @returns {Promise<{ lastShownAt: string | null, dismissedAt: string | null }>} */
export async function getCloudHintState() {
  const raw = await getState(CLOUD_HINT_KEY, null);
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return { lastShownAt: isIso(obj.lastShownAt) ? obj.lastShownAt : null, dismissedAt: isIso(obj.dismissedAt) ? obj.dismissedAt : null };
}

/**
 * Record that the hint was shown or dismissed (both set lastShownAt).
 * @param {'shown' | 'dismissed'} event
 */
export async function recordCloudHint(event) {
  const current = await getCloudHintState();
  const now = new Date().toISOString();
  const next = { ...current, lastShownAt: now, ...(event === 'dismissed' ? { dismissedAt: now } : {}) };
  await setState(CLOUD_HINT_KEY, next);
  return next;
}
