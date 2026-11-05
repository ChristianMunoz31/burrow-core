// One-time trial notices (reverse trial): which of the welcome, ending-soon and ended notices were already
// shown and dismissed for the trial that started at `startedAt`. Cosmetic only: not MAC'd and never read by
// entitlement code, so editing it can at most re-show or hide a banner. Best effort, never throws.
import { select, upsert } from '../db/query.js';
import { getDb as defaultGetDb } from '../db/index.js';
import { TRIAL_NOTICES_STATE_KEY } from './constants.js';

export const TRIAL_NOTICE_NAMES = Object.freeze(['welcome', 'ending_soon', 'ended']);

/** @typedef {{ welcome: boolean, endingSoon: boolean, ended: boolean }} NoticeFlags */

const isBool = (v) => typeof v === 'boolean';

/**
 * @param {unknown} raw stored value
 * @returns {{ startedAt: number, flags: NoticeFlags } | null} null unless the shape is exactly the v1 record
 */
function parseNoticeRecord(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.v !== 1 || !Number.isSafeInteger(raw.startedAt)) return null;
  if (!isBool(raw.welcome) || !isBool(raw.endingSoon) || !isBool(raw.ended)) return null;
  return { startedAt: raw.startedAt, flags: { welcome: raw.welcome, endingSoon: raw.endingSoon, ended: raw.ended } };
}

/**
 * @param {{ getDb?: () => import('node:sqlite').DatabaseSync | null, now?: () => number }} [opts]
 */
export function createTrialNoticeStore({ getDb = defaultGetDb, now = Date.now } = {}) {
  /** @returns {{ startedAt: number, flags: NoticeFlags } | null} null when missing, unreadable or malformed */
  function load() {
    try {
      const db = getDb?.();
      if (!db) return null;
      const rows = select('app_state', { columns: ['value'], where: { key: TRIAL_NOTICES_STATE_KEY }, limit: 1, db });
      return rows.length ? parseNoticeRecord(rows[0].value) : null;
    } catch {
      return null;
    }
  }

  /** @returns {boolean} whether the row was written */
  function save(startedAt, flags) {
    try {
      const db = getDb?.();
      if (!db) return false;
      const value = { v: 1, startedAt, welcome: flags.welcome, endingSoon: flags.endingSoon, ended: flags.ended };
      upsert('app_state', { key: TRIAL_NOTICES_STATE_KEY, value, updated_at: new Date(now()).toISOString() }, { conflict: ['key'], db });
      return true;
    } catch {
      return false;
    }
  }

  return { load, save };
}
