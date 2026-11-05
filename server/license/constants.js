// Build-date bits for the release scripts and the legacy file and key names that older versions left in a data
// folder. Nothing reads those legacy names: they stay listed so Erase still removes them and backup import still
// skips them (docs/adr/0002-free-for-everyone.md decision 7).
export const BUILD_INFO_FILE = 'burrow-build-info.json';
export const MIN_DATE_MS = Date.parse('2024-01-01T00:00:00Z');
export const MAX_DATE_MS = Date.parse('2999-12-31T23:59:59Z');

export const RETIRED_LICENSE_FILE = 'license.burrowlicense';
export const RETIRED_LICENSE_BACKUP = 'license.burrowlicense.retired.bak';
export const ACTIVATION_FILE_NAME = 'license-activation.json';
export const CLOCK_FILE_NAME = 'license-clock.json';
export const TRIAL_FILE_NAME = 'license-trial.json';
export const ACTIVATION_STATE_KEY = 'license.activation';
export const CLOCK_STATE_KEY = 'license.clock';
export const TRIAL_STATE_KEY = 'license.trial';
export const TRIAL_NOTICES_STATE_KEY = 'license.trialNotices';
export const LICENSE_KEY_SECRET_NAME = 'LICENSE_STORE_KEY';

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
