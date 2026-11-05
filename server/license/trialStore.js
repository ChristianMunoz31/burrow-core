// Local trial record (docs/LICENSING.md section 8): two MAC'd copies (a file and an app_state row)
// of one start time. Mirrors the clock guard storage. Deterrence, not DRM: deleting both copies resets it.
import fs from 'node:fs';
import path from 'node:path';
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { select, upsert } from '../db/query.js';
import { getDb as defaultGetDb } from '../db/index.js';
import { loadOrCreateKeyFile } from '../secrets/keyFile.js';
import { atomicWriteFile } from './store.js';
import { TRIAL_FILE_NAME, TRIAL_HKDF_INFO, TRIAL_MAC_PREFIX, LEGACY_TRIAL_MS, TRIAL_MS, TRIAL_STATE_KEY, inDateRange } from './constants.js';

const MAC_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_TRIAL_FILE_BYTES = 1024;
const LOG_INVALID = 'license: trial record ignored (invalid)';

/**
 * @param {Uint8Array} ikm secrets.key bytes
 * @returns {Buffer} 32-byte MAC key
 */
export function deriveTrialKey(ikm) {
  return Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), TRIAL_HKDF_INFO, 32));
}

/** @returns {string} base64url HMAC-SHA256 of the prefixed start and end times */
export function trialMac(key, startedAt, endsAt) {
  return createHmac('sha256', key).update(`${TRIAL_MAC_PREFIX}${startedAt}:${endsAt}`, 'utf8').digest('base64url');
}

/** @returns {{ v: 1, startedAt: number, endsAt: number, mac: string }} */
export function makeTrialRecord(key, startedAt, endsAt = startedAt + TRIAL_MS) {
  return { v: 1, startedAt, endsAt, mac: trialMac(key, startedAt, endsAt) };
}

/**
 * Validates one stored copy.
 * @param {unknown} raw parsed record
 * @param {Buffer} key
 * @returns {{ startedAt: number, endsAt: number } | null} null unless shape and MAC are valid
 */
export function checkTrialRecord(raw, key) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length !== 4 || !['v', 'startedAt', 'endsAt', 'mac'].every((k) => Object.hasOwn(raw, k))) return null;
  if (raw.v !== 1 || !Number.isSafeInteger(raw.startedAt) || !Number.isSafeInteger(raw.endsAt)) return null;
  if (!inDateRange(raw.startedAt) || !inDateRange(raw.endsAt)) return null;
  if (raw.startedAt % 1000 !== 0) return null;
  // Current records last TRIAL_MS; records from the 7-day era keep their own shorter end. The MAC covers endsAt.
  const length = raw.endsAt - raw.startedAt;
  if (length !== TRIAL_MS && length !== LEGACY_TRIAL_MS) return null;
  if (typeof raw.mac !== 'string' || !MAC_RE.test(raw.mac)) return null;
  const given = Buffer.from(raw.mac, 'base64url');
  const expected = Buffer.from(trialMac(key, raw.startedAt, raw.endsAt), 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return { startedAt: raw.startedAt, endsAt: raw.endsAt };
}

function readFileCopy(dataDir) {
  const file = path.join(dataDir, TRIAL_FILE_NAME);
  try {
    if (fs.statSync(file).size > MAX_TRIAL_FILE_BYTES) return { present: true, raw: null };
    return { present: true, raw: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    return err?.code === 'ENOENT' ? { present: false } : { present: true, raw: null };
  }
}

function readDbCopy(getDb) {
  let db;
  try {
    db = getDb?.();
  } catch {
    return { present: false }; // no database at all: only the file copy exists
  }
  if (!db) return { present: false };
  try {
    const rows = select('app_state', { columns: ['value'], where: { key: TRIAL_STATE_KEY }, limit: 1, db });
    return rows.length ? { present: true, raw: rows[0].value } : { present: false };
  } catch {
    // A read error on a live database is a present but unreadable copy: the trial counts as used.
    return { present: true, raw: null };
  }
}

/**
 * @param {{
 *   dataDir: string,
 *   getDb?: () => import('node:sqlite').DatabaseSync | null,
 *   loadKey?: () => { ok: boolean, key?: Uint8Array },
 *   now?: () => number,
 *   log?: (message: string) => void,
 * }} opts
 */
export function createTrialStore({
  dataDir,
  getDb = defaultGetDb,
  loadKey = () => loadOrCreateKeyFile({ dir: dataDir }),
  now = Date.now,
  log = (message) => console.warn(message),
} = {}) {
  function macKey() {
    try {
      const loaded = loadKey();
      return loaded?.ok ? deriveTrialKey(loaded.key) : null;
    } catch {
      return null;
    }
  }

  function write(key, startedAt, endsAt) {
    const record = makeTrialRecord(key, startedAt, endsAt);
    let wrote = false;
    try {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      atomicWriteFile(dataDir, TRIAL_FILE_NAME, `${JSON.stringify(record)}\n`);
      wrote = true;
    } catch {
      // read-only data dir: the DB copy still protects
    }
    try {
      const db = getDb?.();
      if (db) {
        upsert('app_state', { key: TRIAL_STATE_KEY, value: record, updated_at: new Date(now()).toISOString() }, { conflict: ['key'], db });
        wrote = true;
      }
    } catch {
      // DB unavailable
    }
    return wrote;
  }

  /** @returns {{ kind: 'none' } | { kind: 'valid', startedAt: number, endsAt: number } | { kind: 'used' }} */
  function load() {
    try {
      const copies = [readFileCopy(dataDir), readDbCopy(getDb)];
      const present = copies.filter((c) => c.present);
      if (!present.length) return { kind: 'none' };
      const key = macKey();
      if (!key) return { kind: 'used' };
      const checked = copies.map((c) => (c.present ? checkTrialRecord(c.raw, key) : null));
      const valid = checked.filter((v) => v !== null);
      if (!valid.length) {
        log(LOG_INVALID);
        return { kind: 'used' };
      }
      // Earliest start wins; at the same start the earlier end wins, so a repair never lengthens a legacy record.
      const best = valid.reduce((a, b) => (b.startedAt < a.startedAt || (b.startedAt === a.startedAt && b.endsAt < a.endsAt) ? b : a));
      const consistent = copies.every((c, i) => c.present && checked[i]?.startedAt === best.startedAt && checked[i]?.endsAt === best.endsAt);
      if (!consistent) {
        if (copies.some((c, i) => c.present && checked[i] === null)) log(LOG_INVALID);
        write(key, best.startedAt, best.endsAt);
      }
      return { kind: 'valid', startedAt: best.startedAt, endsAt: best.endsAt };
    } catch {
      return { kind: 'used' };
    }
  }

  /**
   * @param {number} startedAt epoch ms, a whole second
   * @returns {boolean} true when at least one copy was written; false when a stored copy exists
   *   (it is never overwritten, valid or not) or nothing could be written
   */
  function start(startedAt) {
    const key = macKey();
    if (!key) return false;
    if ([readFileCopy(dataDir), readDbCopy(getDb)].some((c) => c.present)) return false;
    return write(key, startedAt);
  }

  return { load, start };
}
