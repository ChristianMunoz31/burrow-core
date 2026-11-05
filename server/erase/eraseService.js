// Erase all my data: the owner-requested wipe of everything the user stored, back to first-run.
// ONLY server/eraseRoutes.js may import this file (server/__tests__/eraseBoundary.test.js enforces it,
// and that no AI code can reach it). Order, so a failure never leaves a half-erased database:
//   1. take the backup op lock and close the request gate (no backup, restore or other request runs)
//   2. one transaction with secure_delete ON: delete every user table, then write the audit marker
//   3. right after the commit: wal_checkpoint(TRUNCATE), VACUUM, wal_checkpoint(TRUNCATE) (a checkpoint
//      that reports busy counts as incomplete), so freed pages and the WAL hold no old text
//   4. then each file step on its own, so one failure never skips the others: leftover data files, backups
//      (opt-in), the license (opt-in, followed by one more compaction); any failure ends as erase_incomplete
// secrets.key stays: it is the MAC key behind the trial, clock and activation records (a new key would
// reset the trial), and no saved key remains for it to protect.
import fs from 'node:fs';
import path from 'node:path';
import { AUDIT_TABLE, normalizeAuditEvent } from '../audit.js';
import { closeGate, currentOp, isGateClosed, openGate, tryAcquire, waitForDrain } from '../backup/lock.js';
import { createFsOps, isMissing, rmWithRetry } from '../backup/fsops.js';
import { backupsDir, dataDirOf, ensureBackupsDir } from '../backup/paths.js';
import { IMPORT_ASIDE_DIR, STAGED_IMPORT_DIR_RE, STAGED_IMPORT_DONE_RE } from '../backup/importConstants.js';
import { cleanupOrphans } from '../backup/service.js';
import { drainBackupWorker, resumeBackupWorker } from '../backup/worker/client.js';
import { bumpDataGeneration, runDataResetHooks } from '../dataGeneration.js';
import {
  IMPORT_ORDER,
  RESTORE_JOURNAL_FILENAME,
  TABLES,
  getDb,
  insert,
  removeAll,
  resolveDbPath,
  withTransaction,
} from '../db/index.js';
import { LICENSE_KEY_SECRET_NAME } from '../license/constants.js';
import { removeLicense } from '../license/index.js';
import { invalidateNetPolicyCache } from '../netPolicy.js';
import { invalidateProfileCache } from '../profile.js';
import { drainScheduledJobs, pauseScheduledJobs, resumeScheduledJobs } from '../scheduledJobGate.js';
import { invalidateSecrets } from '../secrets/index.js';

export const DRAIN_TIMEOUT_MS = 5000;

/** app_state keys the wipe never touches: the trial and clock records and the license activation. */
export const KEPT_STATE_KEYS = Object.freeze(['license.trial', 'license.trialNotices', 'license.clock', 'license.activation']);

/**
 * How the wipe treats each table. Every table in db/tables.js must be listed (eraseClassification.test.js
 * fails otherwise). A table missing here is still emptied at runtime: the safe default is to erase.
 * @type {Readonly<Record<string, 'erased' | 'erased_except_kept_rows'>>}
 */
export const TABLE_CLASS = Object.freeze({
  transactions: 'erased',
  todo_columns: 'erased',
  todos: 'erased',
  habits: 'erased',
  habit_completions: 'erased',
  journal: 'erased',
  calendar_events: 'erased',
  notes: 'erased',
  bookmarks: 'erased',
  focus_sessions: 'erased',
  countdowns: 'erased',
  jarvis_conversations: 'erased',
  jarvis_messages: 'erased',
  jarvis_memory: 'erased',
  audit_log: 'erased',
  folders: 'erased',
  folder_files: 'erased',
  folder_chunks: 'erased',
  // Settings, profile, consent, onboarding and categories go; the trial, clock and activation rows stay.
  app_state: 'erased_except_kept_rows',
  // Saved API keys go; the stored license key (Lemon Squeezy "move to another computer") stays with the license.
  app_secrets: 'erased_except_kept_rows',
});

export const ERASE_MESSAGES = Object.freeze({
  erase_failed: 'Nothing was erased. Close and reopen Burrow, then try again.',
  erase_incomplete:
    'Your data was erased, but the final cleanup did not finish. Close and reopen Burrow, then open Settings, Data & storage and choose Erase all my data again to finish.',
  backup_busy: 'A backup is running. Wait for it to finish, then try again. Nothing was erased.',
  db_restoring: 'Burrow is restoring a backup. Wait a few seconds, then try again. Nothing was erased.',
  erase_busy: 'Burrow is still finishing other work. Wait a few seconds, then try again. Nothing was erased.',
  restore_pending:
    'Burrow needs to finish an interrupted backup restore first. Close and reopen Burrow, then try again. Nothing was erased.',
});

const STATUS = Object.freeze({
  erase_failed: 500,
  erase_incomplete: 500,
  backup_busy: 409,
  db_restoring: 503,
  erase_busy: 409,
  restore_pending: 409,
});

export class EraseError extends Error {
  /**
   * @param {keyof typeof STATUS} code
   * @param {{ cause?: unknown }} [options]
   */
  constructor(code, options) {
    super(ERASE_MESSAGES[code], options);
    this.name = 'EraseError';
    this.code = code;
    this.status = STATUS[code];
  }
}

export const isEraseError = (e) => e instanceof EraseError;

/** The busy answer for whatever holds the op lock right now (an erase, a restore or a backup). */
function busyEraseError() {
  const op = currentOp();
  if (op === 'restore') return new EraseError('db_restoring');
  if (op === 'erase') return new EraseError('erase_busy');
  return new EraseError('backup_busy');
}

/** Codes answered before anything is deleted: the caller keeps its token and its rate-limit slot. */
export const PRE_COMMIT_BUSY_CODES = Object.freeze(['backup_busy', 'db_restoring', 'erase_busy', 'restore_pending']);

/**
 * Cheap check the route makes before it spends a token or a rate-limit slot.
 * @returns {EraseError | null} the busy answer, or null when an erase could start now
 */
export function eraseUnavailable() {
  if (currentOp() !== null) return busyEraseError();
  if (isGateClosed()) return new EraseError('erase_busy');
  if (fs.existsSync(path.join(dataDirOf(), RESTORE_JOURNAL_FILENAME))) return new EraseError('restore_pending');
  return null;
}

/** Table names to empty, children first. Derived from TABLES, so a new table is erased with no change here. */
export function tablesToErase() {
  const names = Object.keys(TABLES);
  return [...IMPORT_ORDER, ...names.filter((n) => !IMPORT_ORDER.includes(n))].filter((n) => names.includes(n)).reverse();
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Pre-migration copies are named `<db file name>.pre-v<N>.bak` (server/db/migrate.js). */
const preMigrationBackupRe = () => new RegExp(`^${escapeRegExp(path.basename(resolveDbPath()))}\\.pre-v\\d+\\.bak$`);

// The activation row stays in the wipe even when the license is being removed: removeLicense() then writes
// its cleared record over it, the same tamper-evident path as the normal Remove button.
function wipeTables(db, { removeLicenseToo, now, hooks }) {
  const counts = { tables: 0, rows: 0, secrets: 0 };
  for (const table of tablesToErase()) {
    if (table === 'app_state') {
      counts.rows += removeAll(table, { keep: [...KEPT_STATE_KEYS], db });
    } else if (table === 'app_secrets') {
      // The license key row is not a user API key; without it a Lemon Squeezy license could not be moved later.
      counts.secrets = removeAll(table, { keep: removeLicenseToo ? [] : [LICENSE_KEY_SECRET_NAME], db });
    } else {
      counts.rows += removeAll(table, { db });
    }
    counts.tables += 1;
  }
  hooks.afterWipe?.();
  const marker = normalizeAuditEvent({
    kind: 'auth',
    feature: 'data_erased',
    status: 'ok',
    context: `data erased at ${now.toISOString()}`,
    meta: {
      tables: counts.tables,
      rows: counts.rows,
      keys_removed: counts.secrets,
      remove_license: removeLicenseToo,
    },
  });
  if (!marker) throw new Error('audit marker rejected');
  insert(AUDIT_TABLE, marker, { db });
  return counts;
}

async function removeLeftovers({ dir, fsOps, deleteBackups }) {
  // Pre-migration copies of the database and a restore's safety copy hold the old data too.
  let names;
  try {
    names = await fsOps.readdir(dir);
  } catch {
    names = [];
  }
  const re = preMigrationBackupRe();
  for (const name of names) {
    if (re.test(name)) await rmWithRetry(path.join(dir, name), { fsOps });
    // A staged import from the direct Burrow (Store build, userprofile data location) holds a full copy of the old data and
    // would be swapped in at the next start: it goes too, with the pristine files an earlier import moved aside.
    if (STAGED_IMPORT_DIR_RE.test(name) || STAGED_IMPORT_DONE_RE.test(name)) await rmWithRetry(path.join(dir, name), { fsOps, recursive: true });
  }
  await rmWithRetry(path.join(dir, 'restore-aside'), { fsOps, recursive: true });
  await removeImportAside({ dir, fsOps, deleteBackups });
}

/**
 * The files an import moved aside hold the old data and go. Except the backups among them (a taken backup name sends the
 * target's own file to import-aside/<stamp>/backups): they are backups the user may have chosen to keep, so they stay unless
 * "delete backups" was asked, just like the ones in backups/.
 */
async function removeImportAside({ dir, fsOps, deleteBackups }) {
  const aside = path.join(dir, IMPORT_ASIDE_DIR);
  if (deleteBackups) {
    await rmWithRetry(aside, { fsOps, recursive: true });
    return;
  }
  let stamps;
  try {
    stamps = await fsOps.readdir(aside);
  } catch (e) {
    if (isMissing(e)) return;
    throw e;
  }
  for (const stamp of stamps) {
    const stampDir = path.join(aside, stamp);
    let entries;
    try {
      entries = await fsOps.readdir(stampDir);
    } catch (e) {
      // Something that is not a folder cannot hold kept backups and goes; a folder that cannot be read right now may, so
      // the error is passed on (the erase ends as erase_incomplete and a second Erase finishes it).
      if (e?.code === 'ENOTDIR') await rmWithRetry(stampDir, { fsOps, recursive: true });
      else if (!isMissing(e)) throw e;
      continue;
    }
    for (const entry of entries) {
      if (entry !== 'backups') await rmWithRetry(path.join(stampDir, entry), { fsOps, recursive: true });
    }
    if (!entries.includes('backups')) await rmWithRetry(stampDir, { fsOps, recursive: true });
  }
  try {
    if ((await fsOps.readdir(aside)).length === 0) await rmWithRetry(aside, { fsOps, recursive: true });
  } catch {
    // already gone
  }
}

// Partial and temporary files in backups/ (.incoming-*, *.partial, *.tmp, .stable-copy-*, and data files
// without a meta) are not backups the user can see and may hold old data: always swept, at any age.
async function sweepBackupLeftovers({ fsOps }) {
  await cleanupOrphans({ dir: backupsDir(), fsOps, minAgeMs: 0 });
}

async function removeBackupFiles({ fsOps }) {
  const dir = ensureBackupsDir(backupsDir());
  const names = await fsOps.readdir(dir);
  for (const name of names) await rmWithRetry(path.join(dir, name), { fsOps, recursive: true });
  return names.length;
}

const walCheckpointTruncate = (db) => db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();

/**
 * Checkpoint, VACUUM, checkpoint. A checkpoint that reports `busy` could not truncate the WAL (a reader
 * held it), so the old frames may remain: that is incomplete, not success.
 * @returns {boolean} true when neither checkpoint was busy
 */
function compact(db, checkpoint = walCheckpointTruncate) {
  const first = checkpoint(db);
  db.exec('VACUUM');
  const second = checkpoint(db);
  return Number(first?.busy ?? 0) === 0 && Number(second?.busy ?? 0) === 0;
}

function dropCaches() {
  invalidateProfileCache();
  invalidateNetPolicyCache();
  invalidateSecrets();
  // Parked Javi writes (any conversation, including none) and cached data-browser totals describe old data.
  runDataResetHooks();
}

/**
 * Erases everything the user stored. Throws EraseError: backup_busy or db_restoring (a backup or restore
 * holds the lock: we answer at once instead of waiting, because an erase must never queue behind or
 * overlap a copy of the data, and a wait could outlast the request), restore_pending, erase_busy (requests
 * did not drain), erase_failed (rolled back, nothing erased) or erase_incomplete (committed, cleanup unfinished).
 * @param {{ removeLicense?: boolean, deleteBackups?: boolean, now?: () => Date, fsOps?: import('../backup/fsops.js').FsOps,
 *   hooks?: { afterWipe?: () => void, afterCommit?: () => void | Promise<void> }, drainTimeoutMs?: number,
 *   checkpoint?: (db: import('node:sqlite').DatabaseSync) => { busy?: number } | undefined }} [opts]
 *   hooks and checkpoint are test seams: they simulate a failure inside the transaction, a failure after the
 *   commit and a WAL checkpoint that reports busy
 * @returns {Promise<{ counts: { tables: number, rows: number, secrets: number, backups: number },
 *   licenseRemoved: boolean, backupsDeleted: boolean }>}
 */
export async function eraseAllData({
  removeLicense: removeLicenseToo = false,
  deleteBackups = false,
  now = () => new Date(),
  fsOps = createFsOps(),
  hooks = {},
  drainTimeoutMs = DRAIN_TIMEOUT_MS,
  checkpoint = walCheckpointTruncate,
} = {}) {
  const release = tryAcquire('erase');
  if (!release) throw busyEraseError();
  let gateClosed = false;
  let jobsPaused = false;
  let db = null;
  let previousSecureDelete = null;
  let committed = false;
  try {
    const dir = dataDirOf();
    if (fs.existsSync(path.join(dir, RESTORE_JOURNAL_FILENAME))) throw new EraseError('restore_pending');
    closeGate('erase');
    gateClosed = true;
    // Scheduled jobs (the daily briefing) stop starting and the one in flight is aborted: a job must not
    // write text derived from the old data after the wipe. The generation bump below is the second guard.
    pauseScheduledJobs();
    jobsPaused = true;
    if (!(await waitForDrain({ timeoutMs: drainTimeoutMs }))) throw new EraseError('erase_busy');
    await drainScheduledJobs({ timeoutMs: drainTimeoutMs });
    bumpDataGeneration();
    // No backup worker may be running while the data goes; the op lock keeps new ones (and the scheduler) out.
    await drainBackupWorker({ timeoutMs: 2000 });
    resumeBackupWorker();

    let counts;
    try {
      db = getDb();
      previousSecureDelete = Number(db.prepare('PRAGMA secure_delete').get()?.secure_delete ?? 0);
      db.exec('PRAGMA secure_delete = ON');
      counts = withTransaction((handle) => wipeTables(handle, { removeLicenseToo, now: now(), hooks }), db);
      committed = true;
      // Anything that started before the wipe and finishes later drops its result.
      bumpDataGeneration();
    } catch (cause) {
      console.error('Erase failed before commit:', cause?.code ?? 'unknown');
      throw new EraseError('erase_failed', { cause });
    }

    // From here the data is gone: a failure means "incomplete", never "nothing was erased". Compaction
    // comes first, then every file step runs on its own and the failures are collected.
    let backups = 0;
    const failures = [];
    const step = async (name, fn) => {
      try {
        await fn();
      } catch (cause) {
        console.error('Erase cleanup step failed:', name, cause?.code ?? 'unknown');
        failures.push({ name, cause });
      }
    };
    await step('after_commit', async () => {
      await hooks.afterCommit?.();
    });
    await step('compact', () => {
      if (!compact(db, checkpoint)) throw new Error('wal_checkpoint reported busy');
    });
    await step('leftovers', () => removeLeftovers({ dir, fsOps, deleteBackups }));
    await step('backup_leftovers', () => sweepBackupLeftovers({ fsOps }));
    if (deleteBackups) {
      await step('backups', async () => {
        backups = await removeBackupFiles({ fsOps });
      });
    }
    if (removeLicenseToo) {
      let removed = false;
      await step('license', async () => {
        await removeLicense();
        removed = true;
      });
      // Removing the license rewrites its row: compact once more so the old row is not left in the WAL.
      if (removed) {
        await step('compact_after_license', () => {
          if (!compact(db, checkpoint)) throw new Error('wal_checkpoint reported busy');
        });
      }
    }
    if (failures.length > 0) throw new EraseError('erase_incomplete', { cause: failures[0].cause });
    return { counts: { ...counts, backups }, licenseRemoved: removeLicenseToo, backupsDeleted: deleteBackups };
  } finally {
    if (committed) dropCaches();
    if (db && previousSecureDelete !== null) {
      try {
        db.exec(`PRAGMA secure_delete = ${previousSecureDelete}`);
      } catch {
        // handle closed
      }
    }
    if (jobsPaused) resumeScheduledJobs();
    if (gateClosed) openGate();
    release();
  }
}
