// The stored activation (docs/LICENSING.md section 5): two MAC'd copies (a file and an app_state row)
// of one record, same pattern as trialStore.js. Deterrence, not DRM. Never logs values.
import fs from 'node:fs';
import path from 'node:path';
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { select, upsert } from '../db/query.js';
import { getDb as defaultGetDb } from '../db/index.js';
import { loadOrCreateKeyFile } from '../secrets/keyFile.js';
import { atomicWriteFile } from './store.js';
import {
  ACTIVATION_FILE_NAME,
  ACTIVATION_HKDF_INFO,
  ACTIVATION_MAC_PREFIX,
  ACTIVATION_STATE_KEY,
  KEYHASH_HKDF_INFO,
  KEYHASH_PREFIX,
  MAX_ACTIVATION_FILE_BYTES,
  YEARLY_EDITIONS,
  formatLicenseDate,
  parseLicenseDate,
} from './constants.js';

const B64_RE = /^[A-Za-z0-9_-]{43}$/;
const LAST4_RE = /^[0-9A-Za-z]{4}$/;
const INSTANCE_RE = /^[A-Za-z0-9-]{1,64}$/;
const STORE_IDS = ['gumroad', 'lemonsqueezy'];
const PAID_EDITIONS = ['standard', 'founding', 'family'];
const ALL_EDITIONS = [...PAID_EDITIONS, ...YEARLY_EDITIONS];
const LOG_INVALID = 'license: activation record ignored (invalid)';

// Fixed field order for the MAC (section 5.2).
const ACTIVE_FIELDS = Object.freeze([
  'v', 'state', 'store', 'productId', 'variantId', 'edition', 'purchaseDate', 'updatesUntil', 'expiresAt',
  'activatedAt', 'keyHash', 'keyLast4', 'email', 'instanceId', 'test',
]);
const CLEARED_FIELDS = Object.freeze(['v', 'state', 'clearedAt']);

/** @param {Uint8Array} ikm secrets.key bytes @returns {Buffer} */
export const deriveActivationKey = (ikm) => Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), ACTIVATION_HKDF_INFO, 32));

/** @param {Uint8Array} ikm secrets.key bytes @returns {Buffer} */
export const deriveKeyHashKey = (ikm) => Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), KEYHASH_HKDF_INFO, 32));

/**
 * MAC over every member except `mac`, in the fixed order of the field list.
 * @param {Buffer} key
 * @param {Record<string, unknown>} record
 * @returns {string} base64url
 */
function activationMac(key, record) {
  const names = record.state === 'cleared' ? CLEARED_FIELDS : ACTIVE_FIELDS;
  const fields = names.map((n) => record[n]);
  return createHmac('sha256', key).update(`${ACTIVATION_MAC_PREFIX}${JSON.stringify(fields)}`, 'utf8').digest('base64url');
}

/**
 * Keyed hash of a normalized license key (never a plain hash).
 * @param {Buffer} key keyHashKey
 * @param {string} store
 * @param {string} normalizedKey
 * @returns {string} base64url
 */
export const keyHashOf = (key, store, normalizedKey) =>
  createHmac('sha256', key).update(`${KEYHASH_PREFIX}${store}\n${normalizedKey}`, 'utf8').digest('base64url');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasExactKeys = (raw, names) => Object.keys(raw).length === names.length && names.every((k) => Object.hasOwn(raw, k));
const isId = (v) => typeof v === 'string' && v.length >= 1 && v.length <= 64;
// eslint-disable-next-line no-control-regex
const isEmail = (v) => typeof v === 'string' && v.length >= 3 && v.length <= 254 && !/[\u0000-\u001f\u007f]/.test(v);

function shapeOk(raw) {
  if (raw.state === 'cleared') {
    return hasExactKeys(raw, [...CLEARED_FIELDS, 'mac']) && raw.v === 1 && parseLicenseDate(raw.clearedAt) !== null;
  }
  if (!hasExactKeys(raw, [...ACTIVE_FIELDS, 'mac']) || raw.v !== 1 || raw.state !== 'active') return false;
  if (!STORE_IDS.includes(raw.store) || !isId(raw.productId) || !ALL_EDITIONS.includes(raw.edition)) return false;
  if (raw.variantId !== null && !isId(raw.variantId)) return false;
  const purchase = parseLicenseDate(raw.purchaseDate);
  const until = parseLicenseDate(raw.updatesUntil);
  if (purchase === null || until === null || until < purchase || parseLicenseDate(raw.activatedAt) === null) return false;
  if (YEARLY_EDITIONS.includes(raw.edition)) {
    const ends = parseLicenseDate(raw.expiresAt);
    if (ends === null || ends <= purchase) return false;
  } else if (raw.expiresAt !== null) {
    return false;
  }
  if (typeof raw.keyHash !== 'string' || !B64_RE.test(raw.keyHash)) return false;
  if (typeof raw.keyLast4 !== 'string' || !LAST4_RE.test(raw.keyLast4)) return false;
  if (raw.email !== null && !isEmail(raw.email)) return false;
  if (raw.instanceId !== null && !(typeof raw.instanceId === 'string' && INSTANCE_RE.test(raw.instanceId))) return false;
  if (typeof raw.test !== 'boolean') return false;
  return typeof raw.mac === 'string' && B64_RE.test(raw.mac);
}

/**
 * Validates one stored copy (shape, ranges and MAC).
 * @param {unknown} raw parsed record
 * @param {Buffer} key activation MAC key
 * @returns {{ record: object, cleared: boolean, ts: number } | null}
 */
export function checkActivationRecord(raw, key) {
  if (!isObj(raw) || !shapeOk(raw)) return null;
  const given = Buffer.from(raw.mac, 'base64url');
  const expected = Buffer.from(activationMac(key, raw), 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const cleared = raw.state === 'cleared';
  return { record: { ...raw }, cleared, ts: parseLicenseDate(cleared ? raw.clearedAt : raw.activatedAt) };
}

function readFileCopy(dataDir) {
  const file = path.join(dataDir, ACTIVATION_FILE_NAME);
  try {
    if (fs.statSync(file).size > MAX_ACTIVATION_FILE_BYTES) return { present: true, raw: null };
    return { present: true, raw: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    return err?.code === 'ENOENT' ? { present: false } : { present: true, raw: null };
  }
}

function readDbCopy(getDb) {
  try {
    const db = getDb?.();
    if (!db) return { present: false };
    const rows = select('app_state', { columns: ['value'], where: { key: ACTIVATION_STATE_KEY }, limit: 1, db });
    return rows.length ? { present: true, raw: rows[0].value } : { present: false };
  } catch {
    return { present: false };
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
export function createActivationStore({
  dataDir,
  getDb = defaultGetDb,
  loadKey = () => loadOrCreateKeyFile({ dir: dataDir }),
  now = Date.now,
  log = (message) => console.warn(message),
} = {}) {
  function keys() {
    try {
      const loaded = loadKey();
      if (!loaded?.ok) return null;
      return { mac: deriveActivationKey(loaded.key), hash: deriveKeyHashKey(loaded.key) };
    } catch {
      return null;
    }
  }

  /** Writes one record to both copies. @returns {boolean} true when at least one copy was written */
  function writeBoth(record) {
    let wrote = false;
    try {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      atomicWriteFile(dataDir, ACTIVATION_FILE_NAME, `${JSON.stringify(record)}\n`);
      wrote = true;
    } catch {
      // read-only data dir: the DB copy still protects
    }
    try {
      const db = getDb?.();
      if (db) {
        upsert('app_state', { key: ACTIVATION_STATE_KEY, value: record, updated_at: new Date(now()).toISOString() }, { conflict: ['key'], db });
        wrote = true;
      }
    } catch {
      // DB unavailable
    }
    return wrote;
  }

  /** @returns {boolean} whether the MAC key can be loaded */
  const hasKey = () => keys() !== null;

  /**
   * Never throws.
   * @returns {{ kind: 'none' } | { kind: 'active', record: object } | { kind: 'invalid', reason: 'tampered' | 'no_key' }}
   */
  function load() {
    try {
      const copies = [readFileCopy(dataDir), readDbCopy(getDb)];
      if (!copies.some((c) => c.present)) return { kind: 'none' };
      const k = keys();
      if (!k) return { kind: 'invalid', reason: 'no_key' };
      const checked = copies.map((c) => (c.present ? checkActivationRecord(c.raw, k.mac) : null));
      const anyInvalid = copies.some((c, i) => c.present && checked[i] === null);
      const valid = checked.filter((v) => v !== null);
      if (!valid.length) {
        log(LOG_INVALID);
        return { kind: 'invalid', reason: 'tampered' };
      }
      // The copy with the later timestamp wins; on a tie the DB copy (index 1) wins.
      const winner = checked[0] && checked[1] ? (checked[0].ts > checked[1].ts ? checked[0] : checked[1]) : (checked[0] ?? checked[1]);
      const equal = checked[0] && checked[1] && JSON.stringify(checked[0].record) === JSON.stringify(checked[1].record);
      if (!equal) {
        if (anyInvalid) log(LOG_INVALID);
        writeBoth(winner.record);
      }
      return winner.cleared ? { kind: 'none' } : { kind: 'active', record: winner.record };
    } catch {
      return { kind: 'invalid', reason: 'tampered' };
    }
  }

  /**
   * Writes an active record to both copies.
   * @param {{ store: string, productId: string, variantId: string | null, edition: string, purchaseDate: string,
   *   updatesUntil: string, expiresAt: string | null, activatedAt: string, keyHash: string, keyLast4: string,
   *   email: string | null, instanceId: string | null, test: boolean }} fields
   * @returns {object | null} the stored record, or null when no copy could be written
   */
  function save(fields) {
    const k = keys();
    if (!k) return null;
    const record = { v: 1, state: 'active', ...fields };
    record.mac = activationMac(k.mac, record);
    return writeBoth(record) ? record : null;
  }

  /**
   * Writes the tombstone to both copies.
   * @param {number} clearedAtMs
   * @returns {object | null} the tombstone, or null when no copy could be written
   */
  function clear(clearedAtMs) {
    const k = keys();
    if (!k) return null;
    const record = { v: 1, state: 'cleared', clearedAt: formatLicenseDate(clearedAtMs) };
    record.mac = activationMac(k.mac, record);
    return writeBoth(record) ? record : null;
  }

  /** @returns {string | null} the keyed hash of a normalized key, or null without a MAC key */
  function keyHash(store, normalizedKey) {
    const k = keys();
    return k ? keyHashOf(k.hash, store, normalizedKey) : null;
  }

  return { load, save, clear, keyHash, hasKey };
}
