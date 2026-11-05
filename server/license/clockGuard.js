// Clock guard for time-limited licenses (docs/LICENSING.md section 7): a ratcheting high-water mark kept
// in two MAC'd copies (a file and an app_state row), corroborated by build date, the activation's purchase date and
// data write timestamps. All arithmetic is UTC epoch ms. Every time source is injected.
import fs from 'node:fs';
import path from 'node:path';
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { select, upsert } from '../db/query.js';
import { getDb as defaultGetDb } from '../db/index.js';
import { loadOrCreateKeyFile } from '../secrets/keyFile.js';
import { atomicWriteFile } from './store.js';
import {
  ACTIVATION_FILE_NAME,
  CLOCK_FILE_NAME,
  CLOCK_HKDF_INFO,
  CLOCK_MAC_PREFIX,
  CLOCK_STATE_KEY,
  CLOCK_WRITE_THROTTLE_MS,
  ROLLBACK_TOLERANCE_MS,
  STARTUP_STEP_MS,
  inDateRange,
} from './constants.js';

const MAC_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_CLOCK_FILE_BYTES = 1024;
const MAX_BACKUP_ENTRIES = 1000;
const LOG_INVALID = 'license: clock record ignored (invalid)';

// Fixed allowlist of write timestamps (never user-chosen dates such as date, start_at, target_date).
export const EVIDENCE_COLUMNS = Object.freeze(
  [
    ['transactions', 'created_at'],
    ['todo_columns', 'created_at'],
    ['todos', 'created_at'],
    ['habits', 'created_at'],
    ['habit_completions', 'created_at'],
    ['journal', 'created_at'],
    ['calendar_events', 'created_at'],
    ['notes', 'created_at'],
    ['bookmarks', 'created_at'],
    ['focus_sessions', 'created_at'],
    ['countdowns', 'created_at'],
    ['jarvis_conversations', 'updated_at'],
    ['jarvis_messages', 'created_at'],
    ['jarvis_memory', 'updated_at'],
    ['audit_log', 'created_at'],
  ].map((pair) => Object.freeze(pair)),
);

const maxN = (...values) => {
  const present = values.filter((v) => v !== null && v !== undefined);
  return present.length ? Math.max(...present) : null;
};

/**
 * @param {Uint8Array} ikm secrets.key bytes
 * @returns {Buffer} 32-byte MAC key
 */
export function deriveClockKey(ikm) {
  return Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), CLOCK_HKDF_INFO, 32));
}

/** @returns {string} base64url HMAC-SHA256 of the prefixed high-water mark */
function clockMac(key, hwm) {
  return createHmac('sha256', key).update(`${CLOCK_MAC_PREFIX}${String(hwm)}`, 'utf8').digest('base64url');
}

/** @returns {{ v: 1, hwm: number, mac: string }} */
export function makeClockRecord(key, hwm) {
  return { v: 1, hwm, mac: clockMac(key, hwm) };
}

/**
 * Validates one stored copy.
 * @param {unknown} raw parsed record
 * @param {Buffer} key
 * @returns {number | null} the hwm when shape and MAC are valid, else null
 */
export function checkClockRecord(raw, key) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length !== 3 || !['v', 'hwm', 'mac'].every((k) => Object.hasOwn(raw, k))) return null;
  if (raw.v !== 1 || !Number.isSafeInteger(raw.hwm) || !inDateRange(raw.hwm)) return null;
  if (typeof raw.mac !== 'string' || !MAC_RE.test(raw.mac)) return null;
  const given = Buffer.from(raw.mac, 'base64url');
  const expected = Buffer.from(clockMac(key, raw.hwm), 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return raw.hwm;
}

const toMs = (value) => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Math.floor(value);
  if (typeof value === 'string') return Date.parse(value);
  return NaN;
};

/**
 * Best-effort evidence: the latest write timestamp found in the user's data. Never throws.
 * @param {{ dataDir: string, getDb?: () => import('node:sqlite').DatabaseSync | null }} opts
 * @returns {number | null}
 */
export function gatherEvidence({ dataDir, getDb = defaultGetDb }) {
  let best = null;
  const take = (value) => {
    const ms = toMs(value);
    if (inDateRange(ms)) best = best === null ? ms : Math.max(best, ms);
  };

  const db = openDb(getDb);
  if (db) {
    for (const [table, column] of EVIDENCE_COLUMNS) {
      try {
        const rows = select(table, { columns: [column], orderBy: [{ column, dir: 'desc' }], limit: 1, db });
        take(rows[0]?.[column]);
      } catch {
        // table missing or unreadable: skip this source
      }
    }
  }

  for (const name of ['burrow.db', 'burrow.db-wal', 'secrets.key', ACTIVATION_FILE_NAME]) {
    try {
      take(fs.statSync(path.join(dataDir, name)).mtimeMs);
    } catch {
      // absent
    }
  }

  try {
    const dir = path.join(dataDir, 'backups');
    for (const name of fs.readdirSync(dir).slice(0, MAX_BACKUP_ENTRIES)) {
      try {
        take(fs.statSync(path.join(dir, name)).mtimeMs);
      } catch {
        // vanished entry
      }
      const m = /(\d{4}-\d{2}-\d{2})/.exec(name);
      if (m) take(`${m[1]}T00:00:00Z`);
    }
  } catch {
    // no backups folder
  }
  return best;
}

function openDb(getDb) {
  try {
    return getDb?.() ?? null;
  } catch {
    return null;
  }
}

function safeEvidence(gather) {
  try {
    const evidence = gather();
    return Number.isFinite(evidence) && inDateRange(evidence) ? evidence : null;
  } catch {
    return null;
  }
}

function readFileCopy(dataDir) {
  const file = path.join(dataDir, CLOCK_FILE_NAME);
  try {
    if (fs.statSync(file).size > MAX_CLOCK_FILE_BYTES) return { present: true, raw: null };
    return { present: true, raw: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    return err?.code === 'ENOENT' ? { present: false } : { present: true, raw: null };
  }
}

function readDbCopy(getDb) {
  try {
    const db = getDb?.();
    if (!db) return { present: false };
    const rows = select('app_state', { columns: ['value'], where: { key: CLOCK_STATE_KEY }, limit: 1, db });
    return rows.length ? { present: true, raw: rows[0].value } : { present: false };
  } catch {
    return { present: false };
  }
}

/**
 * @param {{
 *   dataDir: string,
 *   now?: () => number,
 *   mono?: () => number,
 *   getDb?: () => import('node:sqlite').DatabaseSync | null,
 *   loadKey?: () => { ok: boolean, key?: Uint8Array },
 *   gatherEvidence?: () => number | null,
 *   throttleMs?: number,
 *   log?: (message: string) => void,
 * }} opts
 */
export function createClockGuard({
  dataDir,
  now = Date.now,
  mono = () => performance.now(),
  getDb = defaultGetDb,
  loadKey = () => loadOrCreateKeyFile({ dir: dataDir }),
  gatherEvidence: gather = () => gatherEvidence({ dataDir, getDb }),
  throttleMs = CLOCK_WRITE_THROTTLE_MS,
  log = (message) => console.warn(message),
} = {}) {
  let started = false;
  let macKey = null;
  let hwm = 0; // H
  let sessionFloor = 0;
  let anchor = { h: 0, mono: 0 };
  let lastPersisted = -Infinity;
  let lastWriteMono = 0;
  let fileHealthy = false;
  let dbHealthy = false;

  function persist(h) {
    if (!macKey || !inDateRange(h)) return false;
    const record = makeClockRecord(macKey, h);
    let wrote = false;
    try {
      atomicWriteFile(dataDir, CLOCK_FILE_NAME, `${JSON.stringify(record)}\n`);
      fileHealthy = true;
      wrote = true;
    } catch {
      // read-only data dir: the DB copy and evidence still protect
    }
    try {
      const db = getDb?.();
      if (db) {
        upsert('app_state', { key: CLOCK_STATE_KEY, value: record, updated_at: new Date(now()).toISOString() }, { conflict: ['key'], db });
        dbHealthy = true;
        wrote = true;
      }
    } catch {
      // DB unavailable
    }
    lastWriteMono = mono();
    if (wrote) lastPersisted = Math.max(lastPersisted, h);
    return wrote;
  }

  function start({ buildDate = null, issuedAt = null } = {}) {
    const wall = now();
    let S = null;
    fileHealthy = false;
    dbHealthy = false;
    try {
      const loaded = loadKey();
      macKey = loaded?.ok ? deriveClockKey(loaded.key) : null;
    } catch {
      macKey = null;
    }
    if (macKey) {
      const copies = [readFileCopy(dataDir), readDbCopy(getDb)];
      const values = copies.map((c) => {
        if (!c.present) return null;
        const v = checkClockRecord(c.raw, macKey);
        if (v === null) log(LOG_INVALID);
        return v;
      });
      fileHealthy = values[0] !== null;
      dbHealthy = values[1] !== null;
      S = maxN(...values);
    }

    const E = safeEvidence(gather);

    const floor = maxN(S, buildDate, issuedAt);
    const cap = (floor ?? wall) + STARTUP_STEP_MS;
    // Evidence only seeds H when no valid stored copy exists: a valid MAC'd copy already summarises
    // everything observed, and re-reading evidence every launch produced false rollback flags.
    const Ec = S === null && E !== null ? Math.min(E, cap) : null;
    const prior = maxN(floor, Ec);
    let rollback = false;
    let effective = wall;
    let newH = wall;
    if (prior !== null) {
      rollback = wall < prior - ROLLBACK_TOLERANCE_MS;
      effective = Math.max(wall, prior);
      const base = S !== null ? maxN(S, buildDate, issuedAt) : prior;
      newH = rollback ? base : Math.max(base, Math.min(wall, base + STARTUP_STEP_MS));
    }
    sessionFloor = prior ?? wall;
    hwm = newH;
    anchor = { h: newH, mono: mono() };
    lastWriteMono = anchor.mono;
    lastPersisted = S ?? -Infinity;
    started = true;

    let persisted = false;
    if (macKey && (newH > (S ?? -Infinity) || !fileHealthy || !dbHealthy)) persisted = persist(newH);
    return { now: wall, effective, hwm, rollback, persisted };
  }

  function observe({ issuedAt = null } = {}) {
    if (!started) return start({ issuedAt });
    const wall = now();
    if (issuedAt !== null && issuedAt !== undefined) sessionFloor = Math.max(sessionFloor, issuedAt);
    const priorS = Math.max(hwm, sessionFloor);
    const rollback = wall < priorS - ROLLBACK_TOLERANCE_MS;
    const effective = Math.max(wall, priorS);
    if (!rollback) hwm = Math.max(hwm, Math.min(wall, anchor.h + (mono() - anchor.mono)));
    let persisted = false;
    const needsWrite = hwm > lastPersisted || !fileHealthy || !dbHealthy;
    if (macKey && needsWrite && mono() - lastWriteMono >= throttleMs) persisted = persist(hwm);
    return { now: wall, effective, hwm, rollback, persisted };
  }

  return { start, observe };
}
