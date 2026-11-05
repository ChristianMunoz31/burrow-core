// Shared setup for the backup tests: a file-backed database in the per-file temp data dir, helpers to
// inspect backup files on disk, and the seams (statfs, ENOSPC, crash hook, upload stream) the
// backup code exposes. Importing this file registers the real audit sink (../../audit.js) so
// audit rows are written to the database.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import '../../audit.js';
import { closeDb, getDb, resolveDbPath, setDbMaintenance } from '../../db/index.js';
import { __resetLockForTests } from '../../backup/lock.js';
import { backupsDir } from '../../backup/paths.js';
import { __resetUploadsForTests } from '../../backup/restore.js';
import { stopBackupScheduler } from '../../backup/service.js';
import { resetAuditState } from '../../audit.js';

export const dataDir = () => path.dirname(resolveDbPath());

export function wipeDataDir() {
  closeDb();
  const dir = dataDir();
  for (const name of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, name), { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
}

/** Fresh state for one test: no lock, no pending upload, empty data dir, a migrated live database. */
export function resetBackupEnv() {
  stopBackupScheduler();
  __resetLockForTests();
  __resetUploadsForTests();
  setDbMaintenance(false);
  resetAuditState();
  wipeDataDir();
  return getDb();
}

export function cleanupBackupEnv() {
  stopBackupScheduler();
  __resetLockForTests();
  __resetUploadsForTests();
  setDbMaintenance(false);
  wipeDataDir();
}

/** Noon UTC on day `n` of June 2026 (n may exceed 30: dates roll over). */
export const day = (n, hour = 12) => new Date(Date.UTC(2026, 5, n, hour, 0, 0));

/** Local noon of a calendar date: retention buckets by local calendar days. */
export const localNoon = (y, m, d, h = 12) => new Date(y, m - 1, d, h, 0, 0);

export const names = (dir = backupsDir()) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
export const backupFile = (id, ext, dir = backupsDir()) => path.join(dir, `burrow-${id}${ext}`);
export const sha256Of = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** Opens a database file read-only, runs fn, closes. */
export function withReadOnly(file, fn) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export const noteBodies = (file) =>
  withReadOnly(file, (db) => db.prepare('SELECT body FROM notes ORDER BY body').all().map((r) => r.body));
export const integrityOf = (file) =>
  withReadOnly(file, (db) => db.prepare('PRAGMA integrity_check').all().map((r) => r.integrity_check));

/**
 * Edits a backup's .db in place (rollback-journal file) and keeps its meta consistent, so the
 * file still passes the hash check and only the new content is judged.
 * @param {string} id
 * @param {(db: DatabaseSync) => void} edit
 */
export function rewriteBackupDb(id, edit, dir = backupsDir()) {
  const file = backupFile(id, '.db', dir);
  const db = new DatabaseSync(file);
  try {
    edit(db);
  } finally {
    db.close();
  }
  fs.rmSync(`${file}-wal`, { force: true });
  fs.rmSync(`${file}-shm`, { force: true });
  const metaFile = backupFile(id, '.meta.json', dir);
  const meta = readJson(metaFile);
  meta.db.sha256 = sha256Of(file);
  meta.db.bytes = fs.statSync(file).size;
  fs.writeFileSync(metaFile, JSON.stringify(meta));
}

/** Writes a file that is a database but with the given raw bytes (not a copy of a backup). */
export function writeSqliteFile(file, setup) {
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode = DELETE');
    setup(db);
  } finally {
    db.close();
  }
  return fs.readFileSync(file);
}

/** A request-like async iterable with headers, as inspectUpload expects. */
export function fakeUploadReq(body, headers = {}) {
  const chunks = Buffer.isBuffer(body) ? [body] : body;
  const req = Readable.from(chunks, { objectMode: false });
  req.headers = { 'content-length': String(chunks.reduce((n, c) => n + c.length, 0)), ...headers };
  return req;
}

/** statfs stub reporting exactly `bytes` free. */
export const statfsFree = (bytes) => async () => ({ bavail: Math.floor(bytes / 4096), bsize: 4096 });

export const enospc = () => Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
export const ebusy = () => Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
export const noSleep = async () => {};

/** hooks for restoreBackup that simulate a process kill right after `step`. */
export function crashAfter(step, onReach) {
  return {
    sleep: noSleep,
    afterStep: async (name) => {
      if (name !== step) return;
      if (onReach) await onReach();
      throw Object.assign(new Error('simulated crash'), { code: 'simulated_crash' });
    },
  };
}

/** Bytes the free-space check wants for the live database (mirrors the documented formula). */
export function diskNeed(db = getDb()) {
  const count = Number(db.prepare('PRAGMA page_count').get().page_count);
  const size = Number(db.prepare('PRAGMA page_size').get().page_size);
  return count * size * 2 + 8 * 1024 * 1024;
}
