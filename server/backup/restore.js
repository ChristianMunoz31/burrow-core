// Restore: validate a backup (or an uploaded file), migrate it in a staging folder, take a safety
// copy of the current data, then swap the database file with a journal so a crash at any point is
// recovered on the next start (reconcileRestoreJournal). Nothing leaves this computer.
import crypto from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { __resetNetPolicyForTests } from '../netPolicy.js';
import { __resetProfileCacheForTests } from '../profile.js';
import { invalidateSecrets } from '../secrets/index.js';
import { recordAudit } from '../auditHook.js';
import { CLOUD_APP_STATE_KEYS, PROTECTED_APP_STATE_KEYS } from '../import/importExport.js';
import {
  DB_FILENAME,
  RESTORE_JOURNAL_FILENAME,
  closeDb,
  getDb,
  openDb,
  setDbMaintenance,
  withTransaction,
  yieldToLoop,
} from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { TABLES } from '../db/tables.js';
import { BackupError, isBackupError, isNoSpaceError } from './errors.js';
import {
  createFsOps,
  exists,
  isMissing,
  renameWithRetry,
  rmWithRetry,
  writeJsonAtomic,
} from './fsops.js';
import { busyError, closeGate, openGate, tryAcquire, waitForDrain } from './lock.js';
import { readMeta, writeState } from './manifest.js';
import { ID_RE, UPLOAD_TOKEN_RE, backupsDir, dataDirOf, ensureBackupsDir, resolveBackupFile } from './paths.js';
import { DISK_FLOOR_BYTES, createBackup, resolveNow } from './service.js';
import {
  checkSqliteHeader,
  inspectDbFile,
  latestSchemaVersion,
  sha256File,
} from './snapshot.js';
import { canFallBackToMainThread, runBackupOp } from './worker/client.js';

export const BACKUP_UPLOAD_MAX_BYTES = 1024 * 1024 * 1024;
export const UPLOAD_TTL_MS = 15 * 60 * 1000;
const SUFFIXES = Object.freeze(['', '-wal', '-shm']);
/** Process exit code when startup recovery of an interrupted restore fails (the desktop shell can show a dialog for it). */
export const EXIT_RESTORE_RECOVERY = 3;

/** @param {string} dataDir */
function layout(dataDir) {
  return {
    dataDir,
    live: path.join(dataDir, DB_FILENAME),
    stagingDir: path.join(dataDir, 'restore-staging'),
    staging: path.join(dataDir, 'restore-staging', DB_FILENAME),
    asideDir: path.join(dataDir, 'restore-aside'),
    journal: path.join(dataDir, RESTORE_JOURNAL_FILENAME),
  };
}

const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

async function rmDbFiles(file, fsOps) {
  for (const suffix of [...SUFFIXES, '-journal']) await rmWithRetry(`${file}${suffix}`, { fsOps });
}

// ---------------------------------------------------------------------------------------------
// Upload of a backup file chosen by the user (one pending upload at a time)
// ---------------------------------------------------------------------------------------------

/** @type {{ token: string, file: string, expiresAt: number, timer: ReturnType<typeof setTimeout> | null, inspection: object } | null} */
let pending = null;

async function discardPending(fsOps = createFsOps(), token) {
  const current = pending;
  if (!current || (token !== undefined && current.token !== token)) return;
  pending = null;
  if (current.timer) clearTimeout(current.timer);
  await rmDbFiles(current.file, fsOps).catch(() => {});
}

/** Drops the pending upload with this token (and its file), if it is still the pending one. */
export const discardPendingUpload = (token, fsOps = createFsOps()) => discardPending(fsOps, token);

/** Test hook: forget the pending upload without touching files. */
export function __resetUploadsForTests() {
  if (pending?.timer) clearTimeout(pending.timer);
  pending = null;
}

export const hasPendingUpload = () => pending !== null;

/** Upload inspections in progress (streaming or checking): a restore that starts cancels them all. */
const inspections = new Set();

function cancelUploadInspections() {
  for (const controller of inspections) controller.abort('restore');
}

const workerCancelled = () => Object.assign(new Error('worker_cancelled'), { code: 'worker_cancelled' });

/**
 * inspectDbFile in a worker thread so a large file does not freeze the server. Only "no worker could
 * start" falls back to the main thread; a file that crashes, times out or runs out of memory in the
 * worker is not retried here (the caller maps the failure). `signal` cancels a queued or running check.
 */
async function inspectOffThread(file, { signal, maxBytes = null } = {}) {
  const latestVersion = latestSchemaVersion();
  try {
    return await runBackupOp('inspectFile', { file: path.resolve(file), latestVersion, maxBytes }, { signal });
  } catch (e) {
    if (!canFallBackToMainThread(e)) throw e;
    return inspectDbFile(file, { latestVersion, maxBytes });
  }
}

/**
 * True for a worker that died, timed out or ran out of memory. On a file whose hash matched its meta
 * (our own backup) that is a failed restore, not an invalid file.
 */
const isWorkerFailure = (e) => e?.code === 'worker_crashed' || e?.code === 'worker_timeout' || e?.code === 'worker_oom';

/**
 * Header, hash (when known), integrity, schema version and shape checks of a database file. A file
 * whose header claims more than `maxBytes` is too_large before any integrity scan. When `expectedSha256`
 * is set the file is one of our own backups (hash verified): a worker failure is then restore_failed;
 * for any other file it is backup_invalid. A cancelled check (`signal`) throws worker_cancelled.
 * @param {string} file
 * @param {{ expectedSha256?: string | null, fsOps?: import('./fsops.js').FsOps, signal?: AbortSignal,
 *   maxBytes?: number | null }} [opts]
 */
export async function validateCandidate(
  file,
  { expectedSha256 = null, fsOps = createFsOps(), signal, maxBytes = null } = {},
) {
  if (!(await checkSqliteHeader(file, fsOps))) throw new BackupError('backup_invalid');
  if (expectedSha256 && (await sha256File(file, fsOps)) !== expectedSha256) throw new BackupError('backup_invalid');
  await yieldToLoop();
  let inspected;
  try {
    inspected = await inspectOffThread(file, { signal, maxBytes });
  } catch (e) {
    if (e?.code === 'worker_cancelled') throw e;
    if (e?.code === 'too_large') throw new BackupError('too_large', { cause: e });
    throw new BackupError(expectedSha256 && isWorkerFailure(e) ? 'restore_failed' : 'backup_invalid', { cause: e });
  }
  if (!inspected.integrityOk || inspected.schemaVersion === null) throw new BackupError('backup_invalid');
  if (inspected.schemaVersion > latestSchemaVersion()) throw new BackupError('backup_too_new');
  if (inspected.shapeOk !== true) throw new BackupError('backup_invalid');
  return inspected;
}

/**
 * Streams the request body into backups/.incoming-<token>.db and validates it. The file is only
 * kept (for 15 minutes) when it is a usable backup.
 * @param {import('node:stream').Readable & { headers?: Record<string, string | string[] | undefined> }} req
 * @param {{ fsOps?: import('./fsops.js').FsOps, now?: Date | (() => Date), dir?: string, signal?: AbortSignal }} [opts]
 *   `signal` is the client going away: it cancels the inspection (and removes the file). A restore that
 *   starts cancels it too (backup_busy).
 * @returns {Promise<{ uploadToken: string, expiresAt: string, bytes: number, schemaVersion: number,
 *   appSchemaVersion: number, migrationNeeded: boolean, rowCounts: Record<string, number>, totalRows: number }>}
 */
export async function inspectUpload(req, { fsOps = createFsOps(), now, dir = backupsDir(), signal } = {}) {
  if (signal?.aborted) throw new BackupError('invalid_request');
  const inspection = new AbortController();
  const onClientGone = () => inspection.abort('client_gone');
  signal?.addEventListener('abort', onClientGone, { once: true });
  inspections.add(inspection);
  try {
    return await inspectUploadBody(req, { fsOps, now, dir, inspection });
  } finally {
    inspections.delete(inspection);
    signal?.removeEventListener('abort', onClientGone);
  }
}

/** Upload preview counts: the saved-keys table is never listed (a backup never carries keys). */
function previewCounts(inspected) {
  const { app_secrets: secrets = 0, ...rowCounts } = inspected.rowCounts;
  return { rowCounts, totalRows: inspected.totalRows - secrets };
}

async function inspectUploadBody(req, { fsOps, now, dir, inspection }) {
  const declared = Number(req.headers?.['content-length']);
  const hasLength = Number.isFinite(declared) && declared >= 0;
  if (hasLength && declared > BACKUP_UPLOAD_MAX_BYTES) throw new BackupError('too_large');
  ensureBackupsDir(dir);
  try {
    const s = await fsOps.statfs(dir);
    const free = Number(s.bavail) * Number(s.bsize);
    if (Number.isFinite(free) && free - (hasLength ? declared : 0) < DISK_FLOOR_BYTES) throw new BackupError('disk_low');
  } catch (e) {
    if (isBackupError(e)) throw e;
  }

  await discardPending(fsOps);
  const token = crypto.randomBytes(16).toString('hex');
  const file = path.join(dir, `.incoming-${token}.db`);
  const handle = await fsOps.open(file, 'wx', 0o600);
  let bytes = 0;
  let streamed = false;
  try {
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buf.length;
      if (bytes > BACKUP_UPLOAD_MAX_BYTES) throw new BackupError('too_large');
      let offset = 0;
      while (offset < buf.length) {
        const { bytesWritten } = await handle.write(buf, offset, buf.length - offset, null);
        offset += bytesWritten;
      }
    }
    await handle.sync();
    streamed = true;
  } catch (e) {
    if (isBackupError(e)) throw e;
    if (isNoSpaceError(e)) throw new BackupError('disk_full', { cause: e });
    throw new BackupError('invalid_request', { cause: e });
  } finally {
    await handle.close().catch(() => {});
    if (!streamed) await rmDbFiles(file, fsOps).catch(() => {});
  }

  return registerIncoming(file, token, bytes, { fsOps, now, inspection });
}

/**
 * Validates a file already sitting at backups/.incoming-<token>.db and keeps it (for 15 minutes) as the
 * pending upload, replacing any other one. Shared by the upload route and adoptIncomingFile. The file is
 * removed again when it is not a usable backup.
 */
async function registerIncoming(file, token, bytes, { fsOps, now, inspection }) {
  try {
    await yieldToLoop();
    if (bytes === 0) throw new BackupError('backup_invalid');
    if (inspection.signal.aborted) throw workerCancelled();
    const inspected = await validateCandidate(file, {
      fsOps,
      signal: inspection.signal,
      maxBytes: BACKUP_UPLOAD_MAX_BYTES,
    });
    if (inspection.signal.aborted) throw workerCancelled();
    const expires = resolveNow(now).getTime() + UPLOAD_TTL_MS;
    const timer = setTimeout(() => {
      discardPending(fsOps, token).catch(() => {});
    }, UPLOAD_TTL_MS);
    timer.unref?.();
    // Close any side files the read-only inspection left behind.
    await rmWithRetry(`${file}-wal`, { fsOps }).catch(() => {});
    await rmWithRetry(`${file}-shm`, { fsOps }).catch(() => {});
    // Two uploads can finish in any order: the newer one replaces a different pending one, whose file
    // and timer go with it (assigning first, so no other step can slip in between).
    const previous = pending;
    pending = { token, file, expiresAt: expires, timer, inspection: inspected };
    if (previous && previous.token !== token) {
      if (previous.timer) clearTimeout(previous.timer);
      await rmDbFiles(previous.file, fsOps).catch(() => {});
    }
    return {
      uploadToken: token,
      expiresAt: new Date(expires).toISOString(),
      bytes,
      schemaVersion: inspected.schemaVersion,
      appSchemaVersion: latestSchemaVersion(),
      migrationNeeded: inspected.schemaVersion < latestSchemaVersion(),
      ...previewCounts(inspected),
    };
  } catch (e) {
    await rmDbFiles(file, fsOps).catch(() => {});
    if (isBackupError(e)) throw e;
    if (e?.code === 'worker_cancelled' || inspection.signal.aborted) {
      // A restore took over (the user sees "busy"), or the client left (nobody reads the answer).
      throw new BackupError(inspection.signal.reason === 'restore' ? 'backup_busy' : 'invalid_request', { cause: e });
    }
    throw new BackupError('backup_invalid', { cause: e });
  }
}

/**
 * Validates a db file already at `<dir>/.incoming-<token>.db` (token matches UPLOAD_TOKEN_RE) exactly like an
 * upload (validateCandidate, side-file cleanup) and registers it as the pending upload, replacing any other.
 * Used by the one-way copy from the stable Burrow, which builds the file itself.
 * @param {string} file
 * @param {{ token: string, fsOps?: import('./fsops.js').FsOps, now?: Date | (() => Date) }} opts
 * @returns {Promise<{ uploadToken: string, expiresAt: string, bytes: number, schemaVersion: number,
 *   appSchemaVersion: number, migrationNeeded: boolean, rowCounts: Record<string, number>, totalRows: number }>}
 */
export async function adoptIncomingFile(file, { token, fsOps = createFsOps(), now } = {}) {
  if (typeof token !== 'string' || !UPLOAD_TOKEN_RE.test(token)) throw new BackupError('invalid_request');
  if (path.basename(file) !== `.incoming-${token}.db`) throw new BackupError('invalid_request');
  const inspection = new AbortController();
  inspections.add(inspection);
  try {
    let bytes;
    try {
      bytes = (await fsOps.lstat(file)).size;
    } catch (e) {
      throw new BackupError('invalid_request', { cause: e });
    }
    await discardPending(fsOps);
    return await registerIncoming(file, token, bytes, { fsOps, now, inspection });
  } finally {
    inspections.delete(inspection);
  }
}

// ---------------------------------------------------------------------------------------------
// Staging: migrate the candidate forward and make it a self-contained file
// ---------------------------------------------------------------------------------------------

/**
 * integrity_check of a file in a worker thread (main thread only when no worker can start). A worker
 * that dies, times out or runs out of memory is restore_failed for our own backups (`trusted`) and
 * backup_invalid for an uploaded file, the same split validateCandidate makes.
 */
async function integrityOk(file, { trusted }) {
  try {
    return (await runBackupOp('integrityCheck', { file: path.resolve(file) })).ok === true;
  } catch (e) {
    if (canFallBackToMainThread(e)) {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        db.exec('PRAGMA trusted_schema = OFF');
        const rows = db.prepare('PRAGMA integrity_check').all();
        return rows.length === 1 && Object.values(rows[0])[0] === 'ok';
      } finally {
        db.close();
      }
    }
    if (trusted && isWorkerFailure(e)) throw new BackupError('restore_failed', { cause: e });
    throw new BackupError('backup_invalid', { cause: e });
  }
}

async function prepareStaging(paths, fsOps, { trusted }) {
  // Check the untrusted file (read-only, off the main thread) before it is opened for writing, and
  // open without migrating so nothing changes the schema first; trusted_schema stays off so nothing
  // stored in it can run during the checks or the migration.
  if (!(await integrityOk(paths.staging, { trusted }))) throw new BackupError('backup_invalid');
  const db = openDb({ filename: paths.staging, migrate: false });
  try {
    db.exec('PRAGMA trusted_schema = OFF');
    await yieldToLoop();
    migrate(db, { filename: paths.staging });
    await yieldToLoop();
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.exec('PRAGMA journal_mode = DELETE');
  } finally {
    db.close();
  }
  for (const name of await fsOps.readdir(paths.stagingDir)) {
    if (name !== DB_FILENAME) await rmWithRetry(path.join(paths.stagingDir, name), { fsOps });
  }
  const check = new DatabaseSync(paths.staging, { readOnly: true });
  try {
    check.exec('PRAGMA trusted_schema = OFF');
    const have = new Set(
      check
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((r) => r.name),
    );
    for (const table of Object.keys(TABLES)) {
      if (!have.has(table)) throw new BackupError('backup_invalid');
    }
  } finally {
    check.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Settings that belong to this install, not to the backup
// ---------------------------------------------------------------------------------------------

// Privacy and network opt-ins, AI endpoint settings, cloud AI consent and categories, backup settings
// and every key that import also protects (for example the license clock record) stay as they are now.
export const RESTORE_CARRY_KEYS = Object.freeze([
  ...new Set(['network.optIn', 'ai.settings', 'backup.settings', ...PROTECTED_APP_STATE_KEYS, ...CLOUD_APP_STATE_KEYS]),
]);

/**
 * Reads, from the live database, what must survive a restore: the carried app_state rows and every
 * saved key (the backup's own keys may be stale or encrypted with another install's key).
 * @param {import('node:sqlite').DatabaseSync} db
 */
function readCarryOver(db) {
  const marks = RESTORE_CARRY_KEYS.map(() => '?').join(', ');
  const state = db
    .prepare(`SELECT key, value, updated_at FROM app_state WHERE key IN (${marks})`)
    .all(...RESTORE_CARRY_KEYS)
    .map((r) => ({ key: r.key, value: r.value, updated_at: r.updated_at }));
  const secrets = db
    .prepare('SELECT name, ciphertext, iv, auth_tag, last4, updated_at FROM app_secrets')
    .all()
    .map((r) => ({ ...r }));
  return { state, secrets };
}

/**
 * Writes the carried rows into the restored database in one transaction. A carried key the live
 * database did not have is removed from the restored data, so a backup can never switch one on.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ state: object[], secrets: object[] }} carry
 */
function applyCarryOver(db, carry) {
  withTransaction((tx) => {
    const marks = RESTORE_CARRY_KEYS.map(() => '?').join(', ');
    tx.prepare(`DELETE FROM app_state WHERE key IN (${marks})`).run(...RESTORE_CARRY_KEYS);
    const putState = tx.prepare('INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)');
    for (const r of carry.state) putState.run(r.key, r.value, r.updated_at);
    tx.exec('DELETE FROM app_secrets');
    const putSecret = tx.prepare(
      'INSERT INTO app_secrets (name, ciphertext, iv, auth_tag, last4, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const r of carry.secrets) putSecret.run(r.name, r.ciphertext, r.iv, r.auth_tag, r.last4, r.updated_at);
  }, db);
}

/**
 * Makes the carried rows part of the staged file, so every later step (the swap, a crash recovery
 * that rolls forward) sees a file that already holds this install's settings and keys.
 */
async function applyCarryToStaging(paths, carry, fsOps) {
  const db = openDb({ filename: paths.staging, migrate: false });
  try {
    db.exec('PRAGMA trusted_schema = OFF');
    applyCarryOver(db, carry);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.exec('PRAGMA journal_mode = DELETE');
  } finally {
    db.close();
  }
  await rmWithRetry(`${paths.staging}-wal`, { fsOps });
  await rmWithRetry(`${paths.staging}-shm`, { fsOps });
}

// ---------------------------------------------------------------------------------------------
// Moving database files (shared by the rollback and the startup recovery)
// ---------------------------------------------------------------------------------------------

/** -wal and -shm first, burrow.db last: the aside burrow.db is the marker for "not yet restored". */
const MOVE_ORDER = Object.freeze(['-wal', '-shm', '']);

async function moveAsideBack(paths, fsOps) {
  for (const suffix of MOVE_ORDER) {
    const from = path.join(paths.asideDir, `${DB_FILENAME}${suffix}`);
    if (await exists(from, fsOps)) await renameWithRetry(from, `${paths.live}${suffix}`, { fsOps });
  }
}

/** Keeps the unusable live file (never deletes it) as restore-failed-<ts>[-n].db, with its side files. */
async function moveLiveToFailed(paths, when, fsOps) {
  let target = path.join(paths.dataDir, `restore-failed-${stamp(when)}.db`);
  for (let n = 2; await exists(target, fsOps); n += 1) {
    target = path.join(paths.dataDir, `restore-failed-${stamp(when)}-${n}.db`);
  }
  for (const suffix of MOVE_ORDER) {
    const from = `${paths.live}${suffix}`;
    if (await exists(from, fsOps)) await renameWithRetry(from, `${target}${suffix}`, { fsOps });
  }
}

const hook = (hooks, name) => hooks?.afterStep?.(name);

function asRestoreError(e) {
  if (isBackupError(e)) return e;
  if (isNoSpaceError(e) || isNoSpaceError(e?.cause)) return new BackupError('disk_full', { cause: e });
  if (e?.name === 'DbError' && typeof e.code === 'string' && e.code.startsWith('migration')) {
    return new BackupError('backup_invalid', { cause: e });
  }
  return new BackupError('restore_failed', { cause: e });
}

/**
 * Restores a backup from the list (id) or from an uploaded file (uploadToken). Exactly one.
 * @param {{
 *   id?: string,
 *   uploadToken?: string,
 *   now?: Date | (() => Date),
 *   fsOps?: import('./fsops.js').FsOps,
 *   hooks?: { afterStep?: (name: string) => void | Promise<void>, sleep?: (ms: number) => Promise<void> },
 *   dir?: string,
 *   dataDir?: string,
 *   origin?: 'upload' | 'stable_copy',
 * }} [opts] origin only labels the audit row and lastRestore (stable_copy needs uploadToken).
 *   hooks.afterStep fires after 'journal_written', 'aside_moved', 'staging_swapped' and
 *   'journal_swapped'; throwing an error with code 'simulated_crash' stops the restore dead with no
 *   cleanup at all (gate, maintenance switch and lock stay as a killed process would leave them;
 *   tests reset them with __resetLockForTests and setDbMaintenance(false))
 * @returns {Promise<{ restoredFrom: string, safetyBackupId: string, schemaFrom: number, schemaTo: number, totalRows: number }>}
 */
export async function restoreBackup({ id, uploadToken, now, fsOps = createFsOps(), hooks, dir, dataDir, origin = 'upload' } = {}) {
  const hasId = id !== undefined && id !== null;
  const hasToken = uploadToken !== undefined && uploadToken !== null;
  if (hasId === hasToken) throw new BackupError('invalid_request');
  if (origin !== 'upload' && origin !== 'stable_copy') throw new BackupError('invalid_request');
  if (origin === 'stable_copy' && !hasToken) throw new BackupError('invalid_request');
  if (hasId && typeof id !== 'string') throw new BackupError('invalid_request');
  if (hasId && !ID_RE.test(id)) throw new BackupError('backup_not_found');
  if (hasToken && (typeof uploadToken !== 'string' || !UPLOAD_TOKEN_RE.test(uploadToken))) {
    throw new BackupError('invalid_request');
  }

  const release = tryAcquire('restore');
  if (!release) throw busyError();
  // An upload check still running would hold the worker slot (and the backups folder) up to its timeout.
  cancelUploadInspections();

  const paths = layout(dataDir ?? dataDirOf());
  const backups = dir ?? backupsDir(paths.dataDir);
  const source = hasId ? 'list' : origin === 'stable_copy' ? 'stable_copy' : 'file';
  const sourceId = hasId ? id : origin === 'stable_copy' ? 'stable-copy' : 'upload';
  const started = resolveNow(now);
  let phase = 'prep'; // prep -> swap -> post
  let gateClosed = false;
  let maintenanceOn = false;
  let crashed = false;
  let rollbackFailed = false;
  /** @type {'rolled_back' | 'rolled_forward' | null} */
  let recoveredAction = null;
  /** @type {object | null} */
  let journalBase = null;
  let safetyBackupId;
  let candidate = null;

  // A journal here means an earlier restore never finished (or its rollback failed): recovery at the
  // next start owns the files, so nothing may be removed, started or recorded now.
  try {
    if (await exists(paths.journal, fsOps)) throw new BackupError('db_restoring');
  } catch (e) {
    release();
    throw e;
  }

  const rollbackSwap = async () => {
    closeDb();
    setDbMaintenance(true);
    maintenanceOn = true;
    // Say "rolling back" before the first move: from here the aside copy always wins at startup.
    await writeJsonAtomic(paths.journal, { ...journalBase, phase: 'rolling_back' }, fsOps);
    const asideHasDb = await exists(path.join(paths.asideDir, DB_FILENAME), fsOps);
    if (asideHasDb && (await exists(paths.live, fsOps))) {
      // The new file is in place but unusable: keep it for inspection, never delete it.
      await moveLiveToFailed(paths, started, fsOps);
    }
    await moveAsideBack(paths, fsOps);
    await rmWithRetry(paths.journal, { fsOps }).catch(() => {});
    await rmWithRetry(paths.stagingDir, { fsOps, recursive: true }).catch(() => {});
    await rmWithRetry(paths.asideDir, { fsOps, recursive: true }).catch(() => {});
    setDbMaintenance(false);
    maintenanceOn = false;
    try {
      getDb();
    } catch {
      // the caller still gets restore_failed; the next request retries the open
    }
  };

  try {
    ensureBackupsDir(backups);
    // 1. Other leftovers of an earlier attempt are stale: we hold the lock and no restore is running.
    await rmWithRetry(paths.stagingDir, { fsOps, recursive: true });
    await rmWithRetry(paths.asideDir, { fsOps, recursive: true });

    // 2. Copy the source into staging and validate it there.
    await fsOps.mkdir(paths.stagingDir, { recursive: true, mode: 0o700 });
    let expectedSha = null;
    if (hasId) {
      const meta = await readMeta(id, backups, fsOps);
      if (!meta || meta.status !== 'verified' || !meta.db?.sha256) throw new BackupError('backup_not_found');
      expectedSha = meta.db.sha256;
      await fsOps.copyFile(resolveBackupFile(id, '.db', backups), paths.staging);
    } else {
      const upload = pending;
      // Another token does not touch the pending upload; only its own token or its expiry discards it.
      if (!upload || upload.token !== uploadToken) throw new BackupError('upload_expired');
      if (resolveNow(now).getTime() > upload.expiresAt) {
        await discardPending(fsOps, upload.token);
        throw new BackupError('upload_expired');
      }
      try {
        await renameWithRetry(upload.file, paths.staging, { fsOps });
      } catch (e) {
        if (isMissing(e)) throw new BackupError('upload_expired', { cause: e });
        throw e;
      }
      if (pending === upload) pending = null;
      if (upload.timer) clearTimeout(upload.timer);
    }
    candidate = await validateCandidate(paths.staging, { expectedSha256: expectedSha, fsOps });
    await rmWithRetry(`${paths.staging}-wal`, { fsOps });
    await rmWithRetry(`${paths.staging}-shm`, { fsOps });

    // 3. Migrate forward inside staging and make it a clean single file.
    await prepareStaging(paths, fsOps, { trusted: expectedSha !== null });
    await yieldToLoop();

    // 4. Hold back API traffic and let running requests finish, so writes made while we were
    // validating are part of the safety copy. Requests that do not finish in time: give up (prep
    // phase, nothing has moved yet).
    closeGate();
    gateClosed = true;
    if (!(await waitForDrain({ sleep: hooks?.sleep }))) throw new BackupError('backup_busy');

    // 5. Safety copy of the current data, under the lock we already hold (the database is still
    // open for reading: the maintenance switch is off).
    try {
      const safety = await createBackup({ kind: 'safety', skipIfUnchanged: false, lockHeld: true, now, fsOps, dir: backups });
      safetyBackupId = safety.meta.id;
    } catch (e) {
      throw isBackupError(e) && (e.code === 'disk_low' || e.code === 'disk_full') ? e : new BackupError('backup_failed', { cause: e });
    }

    // 6. Remember what belongs to this install (privacy, AI and backup settings, saved keys), block
    // new database opens, and write those rows into the staged file. Its hash is journaled below, so
    // a recovery that rolls forward can only ever land on a file that already carries them.
    const carry = readCarryOver(getDb());
    setDbMaintenance(true);
    maintenanceOn = true;
    await applyCarryToStaging(paths, carry, fsOps);
    await yieldToLoop();
    const stagingSha256 = await sha256File(paths.staging, fsOps);
    await yieldToLoop();

    // 7. Journal first, so a crash from here on can be recovered at the next start.
    journalBase = { v: 1, startedAt: started.toISOString(), sourceId, safetyId: safetyBackupId, stagingSha256 };
    await writeJsonAtomic(paths.journal, { ...journalBase, phase: 'swapping' }, fsOps);
    phase = 'swap';
    await hook(hooks, 'journal_written');

    // 8. Close the live handle (checkpoints the WAL), then 9. move the live files aside.
    closeDb();
    await fsOps.mkdir(paths.asideDir, { recursive: true, mode: 0o700 });
    for (const suffix of MOVE_ORDER) {
      const from = `${paths.live}${suffix}`;
      if (await exists(from, fsOps)) {
        await renameWithRetry(from, path.join(paths.asideDir, `${DB_FILENAME}${suffix}`), { fsOps });
      }
    }
    await hook(hooks, 'aside_moved');

    // 10. Nothing of the old database may remain in place; then move staging in.
    if ((await exists(`${paths.live}-wal`, fsOps)) || (await exists(`${paths.live}-shm`, fsOps))) {
      throw new BackupError('restore_failed');
    }
    await renameWithRetry(paths.staging, paths.live, { fsOps });
    await hook(hooks, 'staging_swapped');

    // 11. Journal phase: swapped.
    await writeJsonAtomic(paths.journal, { ...journalBase, phase: 'swapped' }, fsOps);
    await hook(hooks, 'journal_swapped');

    // 12-13. Open the restored database (it already carries this install's settings and keys) and
    // check it.
    setDbMaintenance(false);
    maintenanceOn = false;
    const fresh = getDb();
    const quick = fresh.prepare('PRAGMA quick_check').all();
    if (quick.length !== 1 || Object.values(quick[0])[0] !== 'ok') throw new BackupError('restore_failed');
    phase = 'post';

    // 14-15. The data is restored. Follow-up work must not turn a finished restore into an error.
    const schemaTo = latestSchemaVersion();
    try {
      invalidateSecrets();
      __resetNetPolicyForTests();
      __resetProfileCacheForTests();
      await recordAudit({
        kind: 'export',
        feature: 'backup_restore',
        status: 'ok',
        meta: {
          source,
          tables: Object.keys(candidate.rowCounts).length,
          rows: candidate.totalRows,
          from_version: candidate.schemaVersion,
          migrated: candidate.schemaVersion < schemaTo,
        },
      });
      // Clearing the success markers makes the next scheduler tick back up the restored data.
      await writeState(
        {
          lastRestore: { at: resolveNow(now).toISOString(), outcome: 'restored', sourceId },
          lastSuccessAt: null,
          confirmedId: null,
          lastFailureAt: null,
          lastError: null,
        },
        { dir: backups, fsOps },
      );
    } catch (e) {
      console.error('Restore follow-up failed:', e?.code ?? e?.name ?? 'unknown');
    }

    // 16. Clean up: journal first. Leftovers are removed on the next start.
    let journalRemoved = true;
    await rmWithRetry(paths.journal, { fsOps }).catch((e) => {
      journalRemoved = false;
      console.error('Restore journal cleanup failed:', e?.code ?? 'unknown');
    });
    await rmWithRetry(paths.stagingDir, { fsOps, recursive: true }).catch(() => {});
    // The old data stays in the aside folder for as long as the journal exists.
    if (journalRemoved) await rmWithRetry(paths.asideDir, { fsOps, recursive: true }).catch(() => {});

    return {
      restoredFrom: sourceId,
      safetyBackupId,
      schemaFrom: candidate.schemaVersion,
      schemaTo,
      totalRows: candidate.totalRows,
    };
  } catch (e) {
    if (e?.code === 'simulated_crash') {
      crashed = true;
      throw e;
    }
    let failure = asRestoreError(e);
    if (phase === 'swap') {
      try {
        await rollbackSwap();
      } catch (rollbackError) {
        // The files may be half moved: keep the maintenance switch on and the journal in place so
        // nothing opens or creates a database until the startup recovery has run.
        rollbackFailed = true;
        failure = new BackupError('restore_failed', { cause: rollbackError });
        // Try the startup recovery once now, still holding the lock: it finishes what the rollback
        // could not, and lets this process use the database again.
        try {
          const recovery = await reconcileRestoreJournal({ dataDir: paths.dataDir, fsOps, now });
          recoveredAction = recovery.action;
          rollbackFailed = false;
          invalidateSecrets();
          __resetNetPolicyForTests();
          __resetProfileCacheForTests();
          if (recoveredAction === 'rolled_forward') {
            // The restored file is in place and healthy: the restore succeeded. Recovery already wrote
            // lastRestore and the pending 'ok' audit row, so no error audit and no state write here.
            return {
              restoredFrom: sourceId,
              safetyBackupId,
              schemaFrom: candidate.schemaVersion,
              schemaTo: latestSchemaVersion(),
              totalRows: candidate.totalRows,
              recovered: true,
            };
          }
        } catch {
          // journal and maintenance switch stay: status reports recoveryRequired until a restart
        }
      }
    } else {
      await rmWithRetry(paths.stagingDir, { fsOps, recursive: true }).catch(() => {});
    }
    await writeState(
      {
        lastRestore: {
          at: resolveNow(now).toISOString(),
          outcome: phase === 'swap' && !rollbackFailed ? (recoveredAction ?? 'rolled_back') : 'failed',
          sourceId,
        },
      },
      { dir: backups, fsOps },
    ).catch(() => {});
    await recordAudit({
      kind: 'export',
      feature: 'backup_restore',
      status: 'error',
      meta: { source, error: failure.code },
    });
    throw failure;
  } finally {
    if (!crashed) {
      if (maintenanceOn && !rollbackFailed) setDbMaintenance(false);
      if (gateClosed) openGate();
      release();
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Startup recovery
// ---------------------------------------------------------------------------------------------

function liveLooksHealthy(live) {
  let db;
  try {
    db = new DatabaseSync(live, { readOnly: true });
    db.exec('PRAGMA trusted_schema = OFF');
    const rows = db.prepare('PRAGMA integrity_check').all();
    if (rows.length !== 1 || Object.values(rows[0])[0] !== 'ok') return false;
    const v = db.prepare('SELECT MAX(version) AS v FROM schema_version').get();
    return typeof v?.v === 'number';
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

/**
 * Reads the journal, retrying transient read errors (antivirus and indexers on Windows). Null only
 * when the file is gone or is not valid JSON; any other failure throws so startup is refused and can
 * be retried, instead of being treated as "no usable journal".
 */
async function readJournal(file, fsOps) {
  const attempts = 5;
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return JSON.parse(await fsOps.readFile(file, 'utf8'));
    } catch (e) {
      if (isMissing(e) || e instanceof SyntaxError) return null;
      last = e;
      if (i < attempts - 1) await fsOps.sleep(Math.min(50 * 2 ** i, 1600));
    }
  }
  throw last;
}

/**
 * Runs at startup before the database opens. Without a journal it only removes leftover staging
 * and aside folders. With one, it finishes or undoes an interrupted restore so the live file is
 * always either the old database or the exact, healthy new one. It rolls forward only when the
 * journal says 'swapped', or says 'swapping' and the live file is byte for byte the staged file
 * whose hash was journaled; in every other case the old database in restore-aside comes back and
 * whatever sat at the live path is kept as restore-failed-<ts>.db (nothing is deleted).
 * @param {{ dataDir?: string, fsOps?: import('./fsops.js').FsOps, now?: Date | (() => Date) }} [opts]
 * @returns {Promise<{ action: 'none' | 'rolled_back' | 'rolled_forward', recovered: boolean }>}
 */
export async function reconcileRestoreJournal({ dataDir, fsOps = createFsOps(), now } = {}) {
  const paths = layout(dataDir ?? dataDirOf());
  const hasJournal = await exists(paths.journal, fsOps);
  if (!hasJournal) {
    await rmWithRetry(paths.stagingDir, { fsOps, recursive: true }).catch(() => {});
    await rmWithRetry(paths.asideDir, { fsOps, recursive: true }).catch(() => {});
    return { action: 'none', recovered: false };
  }
  const raw = await readJournal(paths.journal, fsOps);
  const journal = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const asideHasDb = await exists(path.join(paths.asideDir, DB_FILENAME), fsOps);
  const liveExists = await exists(paths.live, fsOps);

  /** @type {'rolled_back' | 'rolled_forward'} */
  let action = 'rolled_back';
  if (asideHasDb) {
    let forward = false;
    if (liveExists && journal.phase === 'swapped') {
      forward = true;
    } else if (liveExists && journal.phase === 'swapping' && typeof journal.stagingSha256 === 'string') {
      try {
        forward = (await sha256File(paths.live, fsOps)) === journal.stagingSha256;
      } catch {
        forward = false;
      }
    }
    if (forward && liveLooksHealthy(paths.live)) {
      action = 'rolled_forward';
    } else {
      if (liveExists) await moveLiveToFailed(paths, resolveNow(now), fsOps);
      await moveAsideBack(paths, fsOps);
    }
  } else if (!liveExists) {
    // Neither the old nor the new database is in place: nothing safe to start with. Name what is
    // left so the message can point to it.
    let failedCopies = [];
    try {
      failedCopies = (await fsOps.readdir(paths.dataDir)).filter((n) => /^restore-failed-.*\.db$/.test(n));
    } catch {
      // the list is only a hint
    }
    throw Object.assign(new BackupError('restore_recovery_failed'), {
      details: {
        restoreFailed: failedCopies,
        safetyId: typeof journal.safetyId === 'string' ? journal.safetyId : null,
      },
    });
  } else if (journal.phase === 'swapped' && liveLooksHealthy(paths.live)) {
    // The old copy is already gone: the swap finished and only the cleanup was cut short.
    action = 'rolled_forward';
  } else {
    // The swap never started (or stopped while moving side files): put -wal/-shm that were moved
    // aside back next to the live file when it has none.
    for (const suffix of ['-wal', '-shm']) {
      const from = path.join(paths.asideDir, `${DB_FILENAME}${suffix}`);
      const to = `${paths.live}${suffix}`;
      if ((await exists(from, fsOps)) && !(await exists(to, fsOps))) await renameWithRetry(from, to, { fsOps });
    }
  }
  // Journal first: the aside folder holds the old data for as long as the journal exists.
  await rmWithRetry(paths.stagingDir, { fsOps, recursive: true }).catch(() => {});
  await rmWithRetry(paths.journal, { fsOps });
  await rmWithRetry(paths.asideDir, { fsOps, recursive: true }).catch(() => {});

  const backups = backupsDir(paths.dataDir);
  try {
    await fsOps.mkdir(backups, { recursive: true, mode: 0o700 });
    await writeState(
      {
        lastRestore: {
          at: resolveNow(now).toISOString(),
          outcome: action,
          sourceId: typeof journal.sourceId === 'string' ? journal.sourceId : 'upload',
        },
        pendingRecoveryAudit: action,
        // A rolled-forward restore holds the restored data: the next scheduled run must back it up.
        ...(action === 'rolled_forward' ? { lastSuccessAt: null, confirmedId: null } : {}),
      },
      { dir: backups, fsOps },
    );
  } catch {
    // the files are already consistent; only the note for the UI is lost
  }
  return { action, recovered: true };
}
