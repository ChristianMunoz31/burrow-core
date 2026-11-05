// Backup settings in app_state: retention (backup.settings) and the automatic backups switch
// (backup.auto, below). Both are carried across a restore.
import { getState, setState } from '../dataAccess.js';
import { BackupError } from './errors.js';

export const BACKUP_SETTINGS_KEY = 'backup.settings';
export const DEFAULT_BACKUP_SETTINGS = Object.freeze({ keepDaily: 7, keepWeekly: 4, keepMonthly: 6 });

const LIMITS = Object.freeze({ keepDaily: [1, 60], keepWeekly: [0, 52], keepMonthly: [0, 60] });

/**
 * Returns a clean copy or throws invalid_settings. Integers only, in range, no extra keys.
 * @param {unknown} input
 * @returns {{ keepDaily: number, keepWeekly: number, keepMonthly: number }}
 */
export function validateBackupSettings(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new BackupError('invalid_settings');
  const keys = Object.keys(input);
  if (keys.length !== 3 || keys.some((k) => !Object.hasOwn(LIMITS, k))) throw new BackupError('invalid_settings');
  const out = {};
  for (const [key, [min, max]] of Object.entries(LIMITS)) {
    const v = /** @type {Record<string, unknown>} */ (input)[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new BackupError('invalid_settings');
    out[key] = v;
  }
  return /** @type {{ keepDaily: number, keepWeekly: number, keepMonthly: number }} */ (out);
}

/** Saved settings, or the defaults when none are saved or the saved value is not valid. */
export async function getBackupSettings() {
  const stored = await getState(BACKUP_SETTINGS_KEY, null);
  if (stored === null) return { ...DEFAULT_BACKUP_SETTINGS };
  try {
    return validateBackupSettings(stored);
  } catch {
    return { ...DEFAULT_BACKUP_SETTINGS };
  }
}

/**
 * Validates and saves.
 * @param {unknown} input
 * @returns {Promise<{ keepDaily: number, keepWeekly: number, keepMonthly: number }>}
 */
export async function saveBackupSettings(input) {
  const clean = validateBackupSettings(input);
  await setState(BACKUP_SETTINGS_KEY, clean);
  return clean;
}

// ---------------------------------------------------------------------------------------------
// Automatic backups switch, stored in app_state under backup.auto. The key is protected: a restore
// carries the live value across and an import never writes it, so an old backup or export can
// never flip the switch. It only controls the automatic daily backup; Back up now and Restore
// always work. No row means on.
// ---------------------------------------------------------------------------------------------
export const BACKUP_AUTO_KEY = 'backup.auto';
export const REMINDER_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

const isIso = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));
const isoOrNull = (v) => (isIso(v) ? v : null);

/** @typedef {{ enabled: boolean, changedAt: string | null, reminderDismissedAt: string | null }} AutoBackup */

/** @returns {AutoBackup} */
const defaultAuto = () => ({ enabled: true, changedAt: null, reminderDismissedAt: null });

/**
 * Request body for the switch: exactly `{ enabled: boolean }`, or throws invalid_settings.
 * @param {unknown} input
 * @returns {{ enabled: boolean }}
 */
export function validateAutoBackupInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new BackupError('invalid_settings');
  const keys = Object.keys(input);
  if (keys.length !== 1 || keys[0] !== 'enabled') throw new BackupError('invalid_settings');
  const enabled = /** @type {Record<string, unknown>} */ (input).enabled;
  if (typeof enabled !== 'boolean') throw new BackupError('invalid_settings');
  return { enabled };
}

/** Saved switch state; a missing or damaged value means automatic backups are on. @returns {Promise<AutoBackup>} */
export async function getAutoBackup() {
  const stored = await getState(BACKUP_AUTO_KEY, null);
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored) || typeof stored.enabled !== 'boolean') {
    return defaultAuto();
  }
  return {
    enabled: stored.enabled,
    changedAt: isoOrNull(stored.changedAt),
    reminderDismissedAt: isoOrNull(stored.reminderDismissedAt),
  };
}

/**
 * Validates and saves the switch. Turning it on clears the reminder dismissal so a later "off"
 * starts a fresh weekly cadence.
 * @param {unknown} input
 * @param {{ now?: Date }} [opts]
 * @returns {Promise<AutoBackup>}
 */
export async function saveAutoBackup(input, { now = new Date() } = {}) {
  const { enabled } = validateAutoBackupInput(input);
  const current = await getAutoBackup();
  const next = {
    enabled,
    changedAt: current.enabled === enabled && current.changedAt ? current.changedAt : now.toISOString(),
    // Any change of state starts a fresh cadence; only off -> off keeps the dismissal.
    reminderDismissedAt: !enabled && !current.enabled ? current.reminderDismissedAt : null,
  };
  await setState(BACKUP_AUTO_KEY, next);
  return next;
}

/**
 * Records that the user dismissed the "automatic backups are off" reminder. While the switch is on
 * there is no reminder, so nothing is stored and the current state is returned.
 * @param {{ now?: Date }} [opts]
 * @returns {Promise<AutoBackup>}
 */
export async function dismissAutoOffReminder({ now = new Date() } = {}) {
  const current = await getAutoBackup();
  if (current.enabled) return current;
  const next = { ...current, reminderDismissedAt: now.toISOString() };
  await setState(BACKUP_AUTO_KEY, next);
  return next;
}

/**
 * Whether Home may remind the user that automatic backups are off: only when the switch is off, the
 * newest good backup is 7 days old or older (or there is none), and the reminder was not dismissed
 * in the last 7 days. A dismissal dated in the future (clock change) does not count.
 * @param {{ auto: { enabled: boolean, reminderDismissedAt?: string | null }, newestGoodAt?: string | null,
 *   dismissedAt?: string | null, now?: Date }} input dismissedAt defaults to auto.reminderDismissedAt
 */
export function shouldShowAutoOffReminder({ auto, newestGoodAt = null, dismissedAt, now = new Date() }) {
  if (auto?.enabled !== false) return false;
  const nowMs = now.getTime();
  if (isIso(newestGoodAt)) {
    const backupAge = nowMs - Date.parse(newestGoodAt);
    if (backupAge >= 0 && backupAge < REMINDER_INTERVAL_MS) return false;
  }
  const dismissed = dismissedAt === undefined ? auto.reminderDismissedAt : dismissedAt;
  if (isIso(dismissed)) {
    const age = nowMs - Date.parse(dismissed);
    if (age >= 0 && age < REMINDER_INTERVAL_MS) return false;
  }
  return true;
}
