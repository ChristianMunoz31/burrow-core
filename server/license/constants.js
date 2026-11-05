// Shared constants and the one date parser for the licensing module (docs/LICENSING.md section 2).
export const RETIRED_LICENSE_FILE = 'license.burrowlicense';
export const RETIRED_LICENSE_BACKUP = 'license.burrowlicense.retired.bak';
export const ACTIVATION_FILE_NAME = 'license-activation.json';
export const ACTIVATION_STATE_KEY = 'license.activation';
export const ACTIVATION_HKDF_INFO = 'burrow-license-activation-v1';
export const ACTIVATION_MAC_PREFIX = 'burrow-license-activation-v1\n';
export const KEYHASH_HKDF_INFO = 'burrow-license-keyhash-v1';
export const KEYHASH_PREFIX = 'burrow-license-keyhash-v1\n';
export const LICENSE_KEY_SECRET_NAME = 'LICENSE_STORE_KEY';
export const MAX_ACTIVATION_FILE_BYTES = 2048;
export const MAX_KEY_INPUT_CHARS = 128;
export const STORE_TIMEOUT_MS = 10_000;
export const STORE_MAX_BODY_BYTES = 65_536;
export const CLOCK_FILE_NAME = 'license-clock.json';
export const CLOCK_STATE_KEY = 'license.clock';
export const CLOCK_HKDF_INFO = 'burrow-license-clock-v1';
export const CLOCK_MAC_PREFIX = 'burrow-license-clock-v1\n';
export const ROLLBACK_TOLERANCE_MS = 172_800_000;
export const STARTUP_STEP_MS = 259_200_000;
export const CLOCK_WRITE_THROTTLE_MS = 600_000;
export const DAY_MS = 86_400_000;
export const TRIAL_FILE_NAME = 'license-trial.json';
export const TRIAL_STATE_KEY = 'license.trial';
export const TRIAL_HKDF_INFO = 'burrow-license-trial-v1';
export const TRIAL_MAC_PREFIX = 'burrow-license-trial-v1\n';
export const TRIAL_NOTICES_STATE_KEY = 'license.trialNotices';
export const TRIAL_DAYS = 14;
export const TRIAL_MS = TRIAL_DAYS * DAY_MS;
// Trials written before the 14-day change carry a 7-day endsAt; they stay valid and keep it.
export const LEGACY_TRIAL_DAYS = 7;
export const LEGACY_TRIAL_MS = LEGACY_TRIAL_DAYS * DAY_MS;
export const TRIAL_REMIND_DAYS_LEFT = 2;
export const BUILD_INFO_FILE = 'burrow-build-info.json';
export const MIN_DATE_MS = Date.parse('2024-01-01T00:00:00Z');
export const MAX_DATE_MS = Date.parse('2999-12-31T23:59:59Z');

export const EDITIONS = Object.freeze(['standard', 'founding', 'family', 'student', 'nonprofit', 'trial']);
export const UPDATE_DAYS = Object.freeze({ standard: 365, founding: 730, family: 365, student: 365, nonprofit: 365 });
export const YEARLY_EDITIONS = Object.freeze(['student', 'nonprofit']);

const DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * Strict license date: exactly YYYY-MM-DDTHH:MM:SSZ, a real instant, within MIN_DATE..MAX_DATE.
 * @param {unknown} value
 * @returns {number | null} epoch ms, or null when the value is not a valid license date
 */
export function parseLicenseDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  if (new Date(ms).toISOString() !== `${value.slice(0, 19)}.000Z`) return null;
  if (ms < MIN_DATE_MS || ms > MAX_DATE_MS) return null;
  return ms;
}

/**
 * Epoch ms floored to the second, formatted YYYY-MM-DDTHH:MM:SSZ.
 * @param {number} ms
 * @returns {string}
 */
export function formatLicenseDate(ms) {
  return `${new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19)}Z`;
}

/** @param {number} ms */
export const inDateRange = (ms) => Number.isFinite(ms) && ms >= MIN_DATE_MS && ms <= MAX_DATE_MS;
