// SQLite handle management (node:sqlite). Everything app code needs is re-exported from here.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chmodBestEffort, getDataDir } from '../paths.js';
import { DbError, toDbError } from './errors.js';
import { migrate as runMigrations } from './migrate.js';
import { clearStmtCache, prepareCached } from './stmtCache.js';
import {
  dropWriteBuffer,
  openWriteBuffer,
  releaseWriteBuffer,
  truncateWriteBuffer,
  writeBufferMark,
} from './writeEvents.js';

export const DB_FILENAME = 'burrow.db';
export const BUSY_TIMEOUT_MS = 5000;
// Written by the backup restore while it swaps the database file; see server/backup/restore.js.
export const RESTORE_JOURNAL_FILENAME = 'restore-journal.json';

const MIN_SQLITE = [3, 38, 0];

/**
 * Absolute path of burrow.db. Under Vitest it always uses BURROW_TEST_DATA_DIR so tests can
 * never touch the real data directory.
 * @returns {string}
 */
export function resolveDbPath() {
  if (process.env.VITEST) {
    const dir = (process.env.BURROW_TEST_DATA_DIR || '').trim();
    if (!dir) throw new DbError('db_unavailable', 'BURROW_TEST_DATA_DIR is required under test');
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (cause) {
      throw new DbError('db_unavailable', 'Cannot create test data directory', { cause });
    }
    return path.join(dir, DB_FILENAME);
  }
  try {
    return path.join(getDataDir(), DB_FILENAME);
  } catch (cause) {
    throw new DbError('db_unavailable', 'Cannot create data directory', { cause });
  }
}

function sqliteVersionOk(db) {
  const row = db.prepare('SELECT sqlite_version() AS v').get();
  const parts = String(row?.v ?? '0').split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < MIN_SQLITE.length; i += 1) {
    const have = parts[i] ?? 0;
    if (have > MIN_SQLITE[i]) return true;
    if (have < MIN_SQLITE[i]) return false;
  }
  return true;
}

/**
 * Opens a NEW handle (does not touch the singleton).
 * @param {{ filename?: string, migrate?: boolean }} [opts]
 * @returns {DatabaseSync}
 */
export function openDb({ filename, migrate = true } = {}) {
  let db = null;
  try {
    const file = filename ?? resolveDbPath();
    // An interrupted restore leaves a journal. Never create a fresh, empty burrow.db next to it: the
    // recovery step would mistake it for a healthy restored file. (Only the default path is checked.)
    if (
      filename === undefined &&
      !fs.existsSync(file) &&
      fs.existsSync(path.join(path.dirname(file), RESTORE_JOURNAL_FILENAME))
    ) {
      throw new DbError('db_restoring', 'A backup restore needs to finish first');
    }
    db = new DatabaseSync(file, {
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
    });
    if (!sqliteVersionOk(db)) throw new DbError('sqlite_too_old', 'SQLite 3.38 or newer is required');
    db.exec(
      `PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`,
    );
    db.function('burrow_icontains', { deterministic: true }, (hay, needle) =>
      hay == null || needle == null ? 0 : String(hay).toLowerCase().includes(String(needle).toLowerCase()) ? 1 : 0,
    );
    if (migrate) runMigrations(db, { filename: file });
    if (file !== ':memory:' && file !== '') {
      for (const f of [file, `${file}-wal`, `${file}-shm`]) chmodBestEffort(f, 0o600);
    }
    return db;
  } catch (e) {
    if (db) {
      clearStmtCache(db);
      try {
        db.close();
      } catch {
        // ignore
      }
    }
    if (e instanceof DbError) throw e;
    throw new DbError('db_unavailable', 'Cannot open the local database', { cause: e });
  }
}

/** @type {DatabaseSync | null} */
let singleton = null;
let failureLogged = false;
// Set only by shutdownDb(): once the process is exiting, a straggling handler must not reopen the file.
let shutDown = false;
// Set only while a backup restore swaps the database file: getDb() refuses to (re)open.
let maintenance = false;

/**
 * Maintenance switch used by the backup restore. While on, getDb() throws db_restoring.
 * @param {boolean} on
 */
export function setDbMaintenance(on) {
  maintenance = Boolean(on);
}

/**
 * Lazy process singleton. A failed open is not cached.
 * @returns {DatabaseSync}
 */
export function getDb() {
  if (maintenance) throw new DbError('db_restoring', 'A backup is being restored');
  if (shutDown) throw new DbError('db_unavailable', 'The database is shut down');
  if (singleton) return singleton;
  try {
    singleton = openDb();
    failureLogged = false;
    return singleton;
  } catch (e) {
    if (!failureLogged) {
      failureLogged = true;
      console.error('Database open failed:', e?.code);
    }
    throw e;
  }
}

/** Checkpoints the WAL into the main file, then closes the singleton if open; idempotent. */
export function closeDb() {
  const db = singleton;
  singleton = null;
  if (!db) return;
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    // best effort: close still checkpoints on the last connection
  }
  clearStmtCache(db);
  try {
    db.close();
  } catch {
    // already closed
  }
}

/** Final close on the shutdown path: closeDb(), then getDb() throws db_unavailable instead of reopening. */
export function shutdownDb() {
  shutDown = true;
  closeDb();
}

/** Allow getDb() to open again (a new server boot in the same process, and tests). */
export function clearDbShutdown() {
  shutDown = false;
}

/**
 * Test seam: replace the singleton (null clears it; the caller owns closing).
 * @param {DatabaseSync | null} db
 */
export function setDbForTests(db) {
  singleton = db;
}

const depths = new WeakMap();

/**
 * Runs a synchronous fn(db) in a transaction (BEGIN IMMEDIATE) or a savepoint when nested.
 * @template T
 * @param {(db: DatabaseSync) => T} fn
 * @param {DatabaseSync} [db]
 * @returns {T}
 */
export function withTransaction(fn, db = getDb()) {
  const depth = depths.get(db) ?? 0;
  const savepoint = `sp_${depth}`;
  const mark = depth === 0 ? 0 : writeBufferMark(db);
  try {
    db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
  } catch (e) {
    throw toDbError(e);
  }
  // Write events are held until COMMIT (writeEvents.js), so a rolled-back write never emits.
  if (depth === 0) openWriteBuffer(db);
  depths.set(db, depth + 1);
  let finished = false;
  const rollback = () => {
    if (finished) return;
    finished = true;
    try {
      if (depth === 0) db.exec('ROLLBACK');
      else db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
    } catch {
      // transaction already ended
    }
    if (depth === 0) dropWriteBuffer(db);
    else truncateWriteBuffer(db, mark);
  };
  try {
    const result = fn(db);
    if (result && typeof result.then === 'function') {
      result.then(undefined, () => {});
      throw new TypeError('withTransaction callback must be synchronous');
    }
    try {
      db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
      finished = true;
    } catch (e) {
      throw toDbError(e);
    }
    if (depth === 0) {
      depths.set(db, 0);
      releaseWriteBuffer(db);
    }
    return result;
  } catch (e) {
    rollback();
    throw e;
  } finally {
    depths.set(db, depth);
  }
}

/**
 * @param {DatabaseSync} [db]
 * @returns {boolean}
 */
export function pingDb(db) {
  try {
    prepareCached(db ?? getDb(), 'SELECT 1').get();
    return true;
  } catch {
    return false;
  }
}

export const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

export * from './query.js';
export { DbError, isDbError, toDbError, httpErrorFor } from './errors.js';
export { TABLES, IMPORT_ORDER, FOLDER_ARCHIVE_TABLES, FOREIGN_KEYS, getTable, hasColumn } from './tables.js';
export {
  encodeValue,
  decodeValue,
  encodeRow,
  decodeRow,
  canonicalTimestamp,
  canonicalDate,
  nowIso,
} from './codec.js';
