// User profile (display name + onboarding timestamp), stored in app_state under `profile`.
// Prompts read the display name from here; storage being down never breaks them.
import { getState, setState } from './dataAccess.js';

export const PROFILE_KEY = 'profile';
export const DISPLAY_NAME_MAX_CHARS = 60;
const CACHE_TTL_MS = 60_000;
const DISPLAY_NAME_TIMEOUT_MS = 1500;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/g;

let cache = null; // { value, until }

/**
 * Trim, strip control characters, cap at 60 chars; empty becomes null.
 * @param {unknown} raw
 * @returns {string | null}
 */
export function sanitizeDisplayName(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(CONTROL_CHARS_RE, '').trim().slice(0, DISPLAY_NAME_MAX_CHARS).trim();
  return cleaned || null;
}

const normalize = (raw) => {
  const obj = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    displayName: sanitizeDisplayName(obj.displayName),
    onboardedAt: typeof obj.onboardedAt === 'string' && obj.onboardedAt ? obj.onboardedAt : null,
  };
};

/**
 * Read the profile (cached). Throws when storage is unavailable.
 * @returns {Promise<{ displayName: string | null, onboardedAt: string | null }>}
 */
export async function getProfile() {
  if (cache && Date.now() < cache.until) return { ...cache.value };
  const value = normalize(await getState(PROFILE_KEY, null));
  cache = { value, until: Date.now() + CACHE_TTL_MS };
  return { ...value };
}

/**
 * Apply a validated patch and persist it. Throws when storage is unavailable.
 * @param {{ displayName?: string | null, onboarded?: true }} patch
 * @returns {Promise<{ displayName: string | null, onboardedAt: string | null }>}
 */
export async function setProfile(patch = {}) {
  cache = null;
  const current = normalize(await getState(PROFILE_KEY, null));
  const next = { ...current };
  if (patch.displayName !== undefined) next.displayName = sanitizeDisplayName(patch.displayName);
  if (patch.onboarded === true && !next.onboardedAt) next.onboardedAt = new Date().toISOString();
  await setState(PROFILE_KEY, next);
  cache = { value: next, until: Date.now() + CACHE_TTL_MS };
  return { ...next };
}

/**
 * The display name for prompts, or null. Never throws and never waits long.
 * @returns {Promise<string | null>}
 */
export async function getDisplayName() {
  let timer;
  try {
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), DISPLAY_NAME_TIMEOUT_MS);
      timer.unref?.();
    });
    const name = await Promise.race([getProfile().then((p) => p.displayName), timeout]);
    return name ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Drops the cached profile (after the erase-all-data service emptied app_state). */
export function invalidateProfileCache() {
  cache = null;
}

/** Test hook: drop the cached profile. */
export function __resetProfileCacheForTests() {
  cache = null;
}
