// "Import from your existing Burrow": a user-clicked, one-way copy of the direct (installer) Burrow's data into the
// Microsoft Store build whose data folder is %USERPROFILE%\Burrow Data (data location "userprofile"; docs/MICROSOFT_STORE.md).
// Why it exists: that build cannot read the direct data in place (it is a different folder), and a new folder means no
// history.
//
// Rules, in order of importance:
// 1. The source (the direct Burrow's folder) is only ever READ, with plain read-only file handles (the same method as the
//    Dev channel's copy, server/backup/stableCopy.js: SQLite never opens a source file, because even a read-only SQLite
//    connection creates -wal and -shm files there). Nothing in the source is moved, modified, locked or deleted.
// 2. Nothing is imported over data. The target must be empty: no burrow.db, or a database this Burrow created itself and
//    nobody has used (`isPristineDb`: every table empty except the default to-do columns, `app_state` holding only keys the
//    app writes by itself, no saved keys). A used database refuses with 409 import_target_not_empty.
// 3. The work happens in a private staging folder inside the target (<data dir>/.import-<16 hex>/) and is verified there
//    (integrity_check, schema version, per-table row counts against the source copy, sha-256 of every file). Only a stage
//    with a manifest is complete. A failure removes that folder and nothing else.
// 4. The live files are NOT swapped while the app runs (an open SQLite file cannot be replaced on Windows, and the server
//    caches). The user closes and reopens Burrow; `reconcileDirectImport()` runs at startup before the database opens, moves
//    the target's own empty files into <data dir>/import-aside/<stamp>/ (never deletes them) and renames the staged files in.
//    A marker file makes the swap restartable after a crash. Once the marker exists the stage is never wiped on a doubt: an
//    unreadable manifest with staged files still in the stage refuses the start, and the stage is removed only after every
//    manifest entry is in place. A swap that was already finished (no staged data file left in the stage) is only closed
//    again at the next start (existence check, no size check: the database may have been used since), and a failed rename
//    of the finished stage leaves it for that next start instead of wiping it. The target's own backups (provably unused
//    or failed automatic ones) go to import-aside/<stamp>/backups, whole ids together, and the staged backups land in backups/
//    id by id (data first, metadata last), so the newer empty ones never take the retention slots of the imported ones.
//    Every existence check during the swap is strict (only ENOENT / ENOTDIR means "not there"; anything else refuses the
//    start with import_swap_transient and is retried at the next start).
//    The startup check must stay fast (the shell waits 60 s for the ready line): it hashes only burrow.db and secrets.key and
//    checks the backups by size, because the backups were hashed at stage time and the database was
//    integrity checked at stage time (the manifest records it; the hash proves it is the same file).
//
// What is copied (the whole data-folder layout the app needs): burrow.db (a consistent VACUUM INTO snapshot, saved API keys
// kept), secrets.key (REQUIRED: the encryption key of saved API keys) and the backups (burrow-<id>.db, .export.zip,
// .meta.json). Not copied: pre-migration .bak files, restore-aside, state.json (run state), logs, partial files, and the
// license files older versions kept (nothing reads them any more). No network call is made.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { recordAudit } from '../auditHook.js';
import { RESTORE_JOURNAL_FILENAME, DB_FILENAME, getDb } from '../db/index.js';
import { loadMigrations, migrate } from '../db/migrate.js';
import { upsert } from '../db/query.js';
import { TABLES } from '../db/tables.js';
import { DEFAULT_TODO_COLUMNS } from '../normalize.js';
import { appDataFolderDir, usesUserProfileDir } from '../paths.js';
import { hasOwnershipMarker } from '../dataFolderOwnership.js';
import { KEY_FILE_NAME } from '../secrets/keyFile.js';
import { ACTIVATION_FILE_NAME, CLOCK_FILE_NAME, CLOCK_STATE_KEY, TRIAL_FILE_NAME, TRIAL_NOTICES_STATE_KEY, TRIAL_STATE_KEY } from '../license/constants.js';
import { BackupError, isBackupError, isNoSpaceError } from './errors.js';
import { createFsOps, isMissing, renameWithRetry, rmWithRetry, writeFileSynced } from './fsops.js';
import {
  IMPORT_ASIDE_DIR,
  IMPORT_MANIFEST_NAME,
  IMPORT_SWAPPING_NAME,
  STAGED_IMPORT_DIR_PREFIX,
  STAGED_IMPORT_DIR_RE,
  STAGED_IMPORT_DONE_RE,
} from './importConstants.js';
import { busyError, tryAcquire } from './lock.js';
import { BACKUP_EXTS, ID_RE, dataDirOf } from './paths.js';
import { detectDirectBurrowRunning } from './directRunning.js';
import { DISK_FLOOR_BYTES } from './service.js';
import { countRows, inspectDbFile, latestSchemaVersion, normalizeSnapshot, sha256File, takeSnapshot } from './snapshot.js';
import { copyAttempt, copyOne, foldersOverlap, settleCopy, statOrNull, wipeDir } from './stableCopy.js';
import { canFallBackToMainThread, runBackupOp } from './worker/client.js';

export { IMPORT_ASIDE_DIR, IMPORT_MANIFEST_NAME, STAGED_IMPORT_DIR_PREFIX };
export const IMPORT_ATTEMPTS = 5;
export const IMPORT_RETRY_MS = 250;
const MANIFEST_FORMAT = 'burrow-direct-import';
const SRC_COPY_DIR = 'src-copy';
const DISK_FACTOR = 3;

/** Files of the data folder copied next to the database. The key is required. */
export const IMPORT_DATA_FILES = Object.freeze([
  { name: KEY_FILE_NAME, required: true },
]);
/**
 * Files a stage written by an older version may still list (the license files). The manifest of such a stage stays valid, but
 * they are never verified, swapped in or kept: they are deleted from the stage before the stage-empty check.
 */
export const LEGACY_STAGED_FILES = Object.freeze([ACTIVATION_FILE_NAME, TRIAL_FILE_NAME, CLOCK_FILE_NAME]);
const isLegacyStaged = (rel) => LEGACY_STAGED_FILES.includes(rel);
const DB_SIDE_NAMES = Object.freeze([DB_FILENAME, `${DB_FILENAME}-wal`, `${DB_FILENAME}-shm`, `${DB_FILENAME}-journal`]);
const SWAP_ORDER = Object.freeze([KEY_FILE_NAME, 'backups', DB_FILENAME]);
/** Tables that may hold rows without the user having used the app (each has its own rule in isPristineDb). */
const SPECIAL_TABLES = new Set(['app_state', 'app_secrets', 'audit_log', 'todo_columns']);
/** The staged files that are re-hashed at startup; every other staged file (the backups) is checked by size. */
const HASHED_FILES = new Set([DB_FILENAME, ...IMPORT_DATA_FILES.map((f) => f.name)]);
/** Stage file that records that the target's own backups are already in import-aside (a resumed swap must not repeat that step). */
const BACKUPS_ASIDE_MARKER = 'import-backups-aside';
const SHA256_RE = /^[0-9a-f]{64}$/;
const BACKUP_FILE_RE = /^burrow-(.+?)(\.db|\.export\.zip|\.meta\.json)$/;
const BACKUP_META_RE = /^burrow-(.+).meta.json$/;
const CANCELLED_KEY = 'directImport:cancelled';
/** Server exit code for "the import could not be finished at startup" (the shell shows a dialog for it, like code 3). */
export const EXIT_IMPORT_RECOVERY = 4;

/** The reasons a prepared import is cancelled at startup that the user is told about (once; see server.js and Home). */
export const CANCELLED_REASONS = Object.freeze(['target_has_data', 'unverified']);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isBackupFileName = (name) => {
  const m = BACKUP_FILE_RE.exec(name);
  return m !== null && ID_RE.test(m[1]) && BACKUP_EXTS.includes(m[2]);
};

/**
 * The app_state keys this Burrow writes by itself, without the user adding anything (checked against every writer):
 * - license.trial, license.clock, license.trialNotices: legacy records that older versions wrote on the first start; nothing
 *   writes them now, they stay listed so a database that still has them counts as unused.
 * - profile: only without a display name. Onboarding's Skip writes { onboardedAt } alone; a typed name is the user's data.
 * - directImport:notice, directImport:cancelledSeen, dataFolderWarning:seen: dismissal flags of notices on Home and Settings.
 * - directImport:cancelled: written at startup when a prepared import was cancelled (server.js).
 * - jarvis.briefing.latest: the automatic daily briefing (local Ollama, server/scheduler.js) caches its result here
 *   without any user action; it writes nothing else in the user tables (its audit row is ignored). A briefing the user asked for
 *   with Refresh writes the same key, which is harmless here: it only moves aside with the empty database.
 * - workspace: legacy view state written by 1.2 pre-release and Dev builds (`budget` or `journal`); nothing writes it now.
 *   Anything else counts as used.
 * - javi.inbox: Javi's read markers (page keys and timestamps, no user data), written by the first page report and by
 *   the write observer (server/javi/inbox.js), the same class as the dismissal flags.
 * Everything else is the user's: budget:targets / payees / spent / structure / defaults, pos:focus, pos:homeLayout, theme,
 * mode, network.optIn, backup.*, ai.*, Javi memory and a legacy license.activation. A key not listed here counts as used.
 * @type {ReadonlyMap<string, (value: unknown) => boolean>}
 */
export const AUTO_STATE_KEYS = new Map([
  [TRIAL_STATE_KEY, () => true],
  [CLOCK_STATE_KEY, () => true],
  [TRIAL_NOTICES_STATE_KEY, () => true],
  ['directImport:notice', () => true],
  [CANCELLED_KEY, () => true],
  ['directImport:cancelledSeen', () => true],
  ['dataFolderWarning:seen', () => true],
  ['jarvis.briefing.latest', () => true],
  ['workspace', (value) => value === 'budget' || value === 'journal'],
  ['javi.inbox', () => true],
  [
    'profile',
    (value) => {
      if (!isPlainObject(value)) return false;
      if (Object.keys(value).some((k) => k !== 'displayName' && k !== 'onboardedAt')) return false;
      return value.displayName === undefined || value.displayName === null || value.displayName === '';
    },
  ],
]);

/** The stored JSON value of an app_state row; undefined when it does not parse (then the row counts as the user's). */
function parseStateValue(raw) {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * True when a backup in <dataDir>/backups was made from a database that held the user's data: a manual backup (the user asked
 * for it), a backup whose metadata cannot be read, or one whose row counts are above a fresh database's (saved keys, or more
 * app_state rows than the app writes by itself). The automatic backups of a database nobody used (every count the same as a
 * fresh one) do not count. This is what an Erase that kept the backups leaves behind: the database is empty again, the backups
 * are not, so such a target is not "empty". Synchronous, like the rest of the pristine check.
 * @param {string} dataDir
 * @returns {boolean}
 */
export function backupsShowUserData(dataDir) {
  const dir = path.join(dataDir, 'backups');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return !isMissing(e);
  }
  const fresh = freshCounts();
  for (const name of names) {
    const m = BACKUP_META_RE.exec(name);
    if (!m || !ID_RE.test(m[1])) continue;
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      return true;
    }
    if (!isPlainObject(meta)) return true;
    if (meta.status === 'failed') continue;
    if (meta.kind === 'manual' || !isPlainObject(meta.rowCounts)) return true;
    const counts = meta.rowCounts;
    for (const table of Object.keys(TABLES)) {
      if (SPECIAL_TABLES.has(table)) continue;
      if ((counts[table] ?? 0) > (fresh[table] ?? 0)) return true;
    }
    if ((counts.app_secrets ?? 0) > 0) return true;
    // Any doubt is data: a count that is not a number, a to-do column count that is not 0 or the default columns, or more
    // app_state rows than the app can write by itself (its own keys, plus the rows a fresh database already holds).
    const columns = counts.todo_columns ?? 0;
    if (!Number.isFinite(columns) || (columns !== 0 && columns !== DEFAULT_TODO_COLUMNS.length)) return true;
    const state = counts.app_state ?? 0;
    if (!Number.isFinite(state) || state > AUTO_STATE_KEYS.size + (fresh.app_state ?? 0)) return true;
  }
  return false;
}

/** GET /api/todo-columns seeds the default columns as rows on first use; those rows alone are not the user's data. */
const columnKey = (name, order, color) => JSON.stringify([name, order, color]);
function todoColumnsAreDefault(db) {
  const rows = db.prepare('SELECT name, "order" AS position, color FROM todo_columns').all();
  if (rows.length === 0) return true;
  const want = new Set(DEFAULT_TODO_COLUMNS.map((c) => columnKey(c.name, c.order, c.color)));
  const have = new Set(rows.map((r) => columnKey(r.name, r.position, r.color)));
  return rows.length === want.size && have.size === want.size && [...have].every((k) => want.has(k));
}

/** @returns {{ reason: string, at: string } | null} the note a cancelled import left in app_state (server.js writes it) */
function readCancelled(getDbImpl) {
  try {
    const row = getDbImpl().prepare('SELECT value FROM app_state WHERE key = ?').get(CANCELLED_KEY);
    const value = row ? parseStateValue(row.value) : null;
    if (isPlainObject(value) && CANCELLED_REASONS.includes(value.reason) && typeof value.at === 'string') {
      return { reason: value.reason, at: value.at };
    }
  } catch {
    // no database yet, or not readable: nothing to show
  }
  return null;
}

/** @returns {{ dir: string, overridden: boolean }} the direct Burrow's data folder (%APPDATA%\Burrow) */
export const directSource = ({ env = process.env, platform = process.platform, home } = {}) => ({
  dir: appDataFolderDir({ env, platform, ...(home === undefined ? {} : { home }), channel: 'stable' }),
  overridden: false,
});

/** True when this running Burrow is the Store build in the userprofile data location, the only one that offers the import. */
export const importOffered = () => usesUserProfileDir();

let freshCountsCache = null;
/** Row counts of a database that was just created and migrated, never used (default rows included). */
function freshCounts() {
  if (freshCountsCache === null) {
    const db = new DatabaseSync(':memory:');
    try {
      migrate(db, { migrations: loadMigrations() });
      freshCountsCache = countRows(db).rowCounts;
    } finally {
      db.close();
    }
  }
  return freshCountsCache;
}

/**
 * True when nobody has put anything in this Burrow yet. Contents, not only counts: every table other than the four below has
 * exactly the rows of a fresh database; `todo_columns` holds nothing or exactly the default columns (same names, orders and
 * colors, so deleting a default and adding another one is a change); `app_state` holds only keys in AUTO_STATE_KEYS (the
 * app's own first-start records; budgets, focus and home layout, and every other setting are the
 * user's); `app_secrets` is empty; `audit_log` may hold the app's own rows. A backup that holds user data
 * (backupsShowUserData) means data was here.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ dataDir?: string }} [opts]
 * @returns {boolean}
 */
export function isPristineDb(db, { dataDir = dataDirOf() } = {}) {
  if (backupsShowUserData(dataDir)) return false;
  const now = countRows(db).rowCounts;
  const fresh = freshCounts();
  const othersEmpty = Object.keys(TABLES).every((table) => SPECIAL_TABLES.has(table) || (now[table] ?? 0) === (fresh[table] ?? 0));
  if (!othersEmpty || (now.app_secrets ?? 0) !== 0) return false;
  if (!todoColumnsAreDefault(db)) return false;
  return db
    .prepare('SELECT key, value FROM app_state')
    .all()
    .every((row) => {
      const rule = AUTO_STATE_KEYS.get(row.key);
      return rule !== undefined && rule(parseStateValue(row.value));
    });
}

/** isPristineDb that never throws: an unreadable database counts as in use. */
function safePristine(getDbImpl, closeAfter = false, dataDir = dataDirOf()) {
  let db = null;
  try {
    db = getDbImpl();
    return isPristineDb(db, { dataDir });
  } catch {
    return false;
  } finally {
    if (closeAfter) {
      try {
        db?.close();
      } catch {
        // already closed
      }
    }
  }
}

/**
 * True when this Burrow has nothing of its own yet: no burrow.db at all, or a database nobody has
 * used (isPristineDb).
 * @param {{ dataDir: string, fsOps: import('./fsops.js').FsOps, getDbImpl: () => import('node:sqlite').DatabaseSync }} opts
 */
async function targetIsEmpty({ dataDir, fsOps, getDbImpl }) {
  const existing = await statOrNull(path.join(dataDir, DB_FILENAME), fsOps).catch(() => null);
  if (existing === null) {
    return !backupsShowUserData(dataDir);
  }
  return safePristine(getDbImpl, false, dataDir);
}

async function listStages(dataDir, fsOps) {
  let names;
  try {
    names = await fsOps.readdir(dataDir);
  } catch {
    return [];
  }
  const stages = [];
  for (const name of names.filter((n) => STAGED_IMPORT_DIR_RE.test(n))) {
    const dir = path.join(dataDir, name);
    const complete = (await statOrNull(path.join(dir, IMPORT_MANIFEST_NAME), fsOps).catch(() => null)) !== null;
    stages.push({ name, dir, complete });
  }
  return stages;
}

/** Removes the folders of finished swaps (a stage is renamed to <name>.done before it is deleted, so a crash while deleting never leaves a half stage). */
async function sweepFinished(dataDir, fsOps) {
  let names;
  try {
    names = await fsOps.readdir(dataDir);
  } catch {
    return;
  }
  for (const name of names.filter((n) => STAGED_IMPORT_DONE_RE.test(n))) {
    await rmWithRetry(path.join(dataDir, name), { fsOps, recursive: true }).catch(() => {});
  }
}

/**
 * What the screen shows before the user decides. Stat only on the source; reads the open database of this Burrow for the
 * "still empty" check and for the note a cancelled import left.
 * @param {{ source?: { dir: string }, dataDir?: string, fsOps?: import('./fsops.js').FsOps, offered?: boolean,
 *   getDbImpl?: () => import('node:sqlite').DatabaseSync }} [opts]
 * @returns {Promise<{ available: boolean, canOffer: boolean, reason: string | null, found: boolean, sourceDir: string | null,
 *   lastChangedAt: string | null, pending: boolean, cancelled: { reason: string, at: string } | null }>}
 */
export async function getDirectImportStatus({
  source = directSource(),
  dataDir = dataDirOf(),
  fsOps = createFsOps(),
  offered = importOffered(),
  getDbImpl = getDb,
} = {}) {
  const none = { available: false, canOffer: false, reason: null, found: false, sourceDir: null, lastChangedAt: null, pending: false, cancelled: null };
  if (!offered) return none;
  const db = await statOrNull(path.join(source.dir, DB_FILENAME), fsOps).catch(() => null);
  const found = db !== null && db.isFile();
  let lastChangedAt = null;
  if (found) {
    const wal = await statOrNull(path.join(source.dir, `${DB_FILENAME}-wal`), fsOps).catch(() => null);
    const latest = Math.max(db.mtimeMs, wal ? wal.mtimeMs : 0);
    lastChangedAt = Number.isFinite(latest) ? new Date(latest).toISOString() : null;
  }
  const pending = (await listStages(dataDir, fsOps)).some((s) => s.complete);
  const base = { available: true, found, sourceDir: source.dir, lastChangedAt, pending, cancelled: readCancelled(getDbImpl) };
  if (pending) return { ...base, canOffer: false, reason: 'pending' };
  if (!found) return { ...base, canOffer: false, reason: 'source_missing' };
  if (await foldersOverlap(source.dir, dataDir, fsOps).catch(() => false)) return { ...base, canOffer: false, reason: 'same_folder' };
  const pristine = await targetIsEmpty({ dataDir, fsOps, getDbImpl });
  if (pristine) return { ...base, canOffer: true, reason: null };
  // An earlier import left its mark (the files it moved aside): the data here came from it, so there is nothing to offer or explain.
  const imported = (await statOrNull(path.join(dataDir, IMPORT_ASIDE_DIR), fsOps).catch(() => null)) !== null;
  return { ...base, canOffer: false, reason: imported ? 'imported' : 'target_has_data' };
}

async function sha256Of(file, fsOps) {
  return sha256File(file, fsOps);
}

/** Copies one regular file with a read-only source handle, then proves source and copy have the same bytes. */
async function copyVerified({ from, to, fsOps }) {
  const st = await fsOps.lstat(from);
  if (st.isSymbolicLink() || !st.isFile()) throw new BackupError('import_source_invalid');
  const before = await sha256Of(from, fsOps);
  await copyOne(from, to, fsOps);
  const [copied, after] = await Promise.all([sha256Of(to, fsOps), sha256Of(from, fsOps)]);
  if (before !== after) throw new BackupError('import_source_busy');
  if (copied !== before) throw new BackupError('import_failed');
  return { size: st.size, sha256: before };
}

async function snapshotKeepingSecrets({ dbPath, partialPath }) {
  const latestVersion = latestSchemaVersion();
  try {
    return await runBackupOp('snapshotInspect', { dbPath, partialPath, latestVersion, keepSecrets: true });
  } catch (e) {
    if (!canFallBackToMainThread(e)) throw e;
    const source = new DatabaseSync(dbPath, { readOnly: true });
    try {
      source.exec('PRAGMA trusted_schema = OFF');
      takeSnapshot(source, partialPath);
    } finally {
      source.close();
    }
    normalizeSnapshot(partialPath, { keepSecrets: true });
    return inspectDbFile(partialPath, { latestVersion });
  }
}

function mapStableError(e) {
  if (!isBackupError(e)) return e;
  const map = { stable_busy: 'import_source_busy', stable_invalid: 'import_source_invalid', stable_not_found: 'import_source_not_found', stable_too_new: 'import_source_too_new' };
  return map[e.code] ? new BackupError(map[e.code], { cause: e }) : e;
}

/**
 * Lets SQLite recover the private copy's WAL / hot journal (settle) and inspects it. Both run in the backup worker, so a big WAL
 * never blocks the main thread during the POST; the main thread does it only when no worker can be started.
 */
async function settleAndInspectCopy(file) {
  const latestVersion = latestSchemaVersion();
  try {
    return await runBackupOp('inspectFile', { file, latestVersion, settle: true });
  } catch (e) {
    if (e?.workerOpFailed === true && e.stage === 'settle') {
      throw new BackupError(isNoSpaceError(e) ? 'disk_full' : 'import_source_invalid', { cause: e });
    }
    if (!canFallBackToMainThread(e)) throw e;
    try {
      settleCopy(file);
    } catch (err) {
      throw mapStableError(err);
    }
    return inspectDbFile(file, { latestVersion });
  }
}

function sameRows(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => (a[key] ?? 0) === (b[key] ?? 0));
}

async function backupFilesOf(sourceDir, fsOps) {
  let names;
  try {
    names = await fsOps.readdir(path.join(sourceDir, 'backups'));
  } catch (e) {
    if (isMissing(e)) return [];
    throw e;
  }
  return names.filter(isBackupFileName);
}

async function diskCheck({ sourceDir, dataDir, fsOps }) {
  try {
    const names = [DB_FILENAME, `${DB_FILENAME}-wal`, ...IMPORT_DATA_FILES.map((f) => f.name)];
    let bytes = 0;
    for (const name of names) bytes += (await statOrNull(path.join(sourceDir, name), fsOps))?.size ?? 0;
    for (const name of await backupFilesOf(sourceDir, fsOps)) bytes += (await statOrNull(path.join(sourceDir, 'backups', name), fsOps))?.size ?? 0;
    const s = await fsOps.statfs(dataDir);
    const free = Number(s.bavail) * Number(s.bsize);
    if (Number.isFinite(free) && free - bytes * DISK_FACTOR < DISK_FLOOR_BYTES) throw new BackupError('disk_low');
  } catch (e) {
    if (isBackupError(e)) throw e;
  }
}

/** The running check as a refusal: anything but a clear 'no' stops the import. */
function assertNotRunning(running) {
  if (running === 'yes') throw new BackupError('import_direct_running');
  if (running !== 'no') throw new BackupError('import_running_unknown');
}

/**
 * Copies and verifies the direct Burrow's data into a staging folder inside `dataDir`. Does NOT replace anything: the
 * app swaps the staged files in at the next start (`reconcileDirectImport`).
 * @param {{ source?: { dir: string }, dataDir?: string, fsOps?: import('./fsops.js').FsOps, now?: Date,
 *   offered?: boolean, getDbImpl?: () => import('node:sqlite').DatabaseSync,
 *   detectRunning?: () => Promise<'no' | 'yes' | 'unknown'>, attempts?: number, retryDelayMs?: number,
 *   hooks?: { afterCopy?: (attempt: number) => void | Promise<void> } }} [opts] `hooks.afterCopy` is a test seam.
 * @returns {Promise<{ status: 'staged', needsRestart: true, copiedFrom: string, schemaVersion: number, totalRows: number,
 *   backups: number, files: number }>}
 */
export async function importFromDirect({
  source = directSource(),
  dataDir = dataDirOf(),
  fsOps = createFsOps(),
  now = new Date(),
  offered = importOffered(),
  getDbImpl = getDb,
  detectRunning = detectDirectBurrowRunning,
  attempts = IMPORT_ATTEMPTS,
  retryDelayMs = IMPORT_RETRY_MS,
  hooks,
} = {}) {
  if (!offered) throw new BackupError('import_unavailable');
  // Import only into a folder that carries our ownership marker (server/dataFolderOwnership.js); never into any other folder.
  if (!hasOwnershipMarker(dataDir)) throw new BackupError('import_target_not_ours');
  const sourceDir = source.dir;
  if (await foldersOverlap(sourceDir, dataDir, fsOps)) throw new BackupError('import_source_not_found');

  // The refusals that depend on state other things can change. Asked once before the lock (cheap answer) and again inside it.
  const preflight = async () => {
    const sourceDb = await statOrNull(path.join(sourceDir, DB_FILENAME), fsOps).catch(() => null);
    if (!sourceDb || !sourceDb.isFile()) throw new BackupError('import_source_not_found');
    if ((await listStages(dataDir, fsOps)).some((s) => s.complete)) throw new BackupError('import_pending');
    if (!(await targetIsEmpty({ dataDir, fsOps, getDbImpl }))) throw new BackupError('import_target_not_empty');
    if (await statOrNull(path.join(sourceDir, RESTORE_JOURNAL_FILENAME), fsOps).catch(() => null)) throw new BackupError('import_source_busy');
    assertNotRunning(await detectRunning());
  };
  await preflight();

  const release = tryAcquire('backup');
  if (!release) throw busyError();
  const stage = path.join(dataDir, `${STAGED_IMPORT_DIR_PREFIX}${crypto.randomBytes(8).toString('hex')}`);
  try {
    await preflight();
    await diskCheck({ sourceDir, dataDir, fsOps });
    await fsOps.mkdir(stage, { recursive: true, mode: 0o700 });
    const files = [];
    const record = (rel, info) => files.push({ rel, size: info.size, sha256: info.sha256 });

    // 1. The database: private plain-file copy (proved unchanged by file signatures and a second hash of the source),
    //    settled by SQLite there (in the worker), then a consistent VACUUM INTO snapshot with the saved keys kept.
    const copyDir = path.join(stage, SRC_COPY_DIR);
    let copied = false;
    for (let attempt = 1; attempt <= attempts && !copied; attempt += 1) {
      try {
        copied = await copyAttempt({ stableDir: sourceDir, copyDir, attempt, fsOps, hooks });
      } catch (e) {
        throw mapStableError(e);
      }
      if (!copied) {
        await wipeDir(copyDir, fsOps);
        if (!(await statOrNull(path.join(sourceDir, DB_FILENAME), fsOps).catch(() => null))) throw new BackupError('import_source_not_found');
        if (attempt < attempts) await fsOps.sleep(retryDelayMs);
      }
    }
    if (!copied) throw new BackupError('import_source_busy');
    // The direct Burrow could have been started while the raw copy ran: a running writer makes the copy untrustworthy.
    assertNotRunning(await detectRunning());
    const copyDb = path.join(copyDir, DB_FILENAME);
    const settled = await settleAndInspectCopy(copyDb);
    if (!settled.integrityOk || settled.schemaVersion === null) throw new BackupError('import_source_invalid');
    if (settled.schemaVersion > latestSchemaVersion()) throw new BackupError('import_source_too_new');
    const stagedDb = path.join(stage, DB_FILENAME);
    const snapshot = await snapshotKeepingSecrets({ dbPath: copyDb, partialPath: stagedDb });
    if (!snapshot.integrityOk || snapshot.schemaVersion === null || snapshot.shapeOk !== true) throw new BackupError('import_source_invalid');
    if (snapshot.schemaVersion !== settled.schemaVersion || !sameRows(snapshot.rowCounts, settled.rowCounts) || snapshot.fingerprint !== settled.fingerprint) {
      throw new BackupError('import_failed');
    }
    await wipeDir(copyDir, fsOps);
    record(DB_FILENAME, { size: (await fsOps.lstat(stagedDb)).size, sha256: await sha256Of(stagedDb, fsOps) });

    // 2. The data-folder files next to it. The key is required.
    for (const { name, required } of IMPORT_DATA_FILES) {
      const from = path.join(sourceDir, name);
      if (!(await statOrNull(from, fsOps).catch(() => null))) {
        if (required) throw new BackupError('import_source_invalid');
        continue;
      }
      record(name, await copyVerified({ from, to: path.join(stage, name), fsOps }));
    }

    // 3. The backups, file by file, size and hash checked (the startup check relies on this: it compares sizes only).
    const backupNames = await backupFilesOf(sourceDir, fsOps);
    if (backupNames.length > 0) {
      await fsOps.mkdir(path.join(stage, 'backups'), { recursive: true, mode: 0o700 });
      for (const name of backupNames) {
        record(`backups/${name}`, await copyVerified({ from: path.join(sourceDir, 'backups', name), to: path.join(stage, 'backups', name), fsOps }));
      }
    }

    // 4. The manifest, last: its presence makes the stage complete. Written with a temp name first. `integrity: 'ok'` records
    //    the integrity_check of the staged database made above; the sha-256 of burrow.db proves it is still that file.
    const manifest = {
      format: MANIFEST_FORMAT,
      formatVersion: 1,
      createdAt: now.toISOString(),
      schemaVersion: snapshot.schemaVersion,
      integrity: 'ok',
      totalRows: snapshot.totalRows,
      rowCounts: snapshot.rowCounts,
      files,
    };
    const tmp = path.join(stage, `${IMPORT_MANIFEST_NAME}.tmp`);
    await writeFileSynced(tmp, `${JSON.stringify(manifest, null, 2)}\n`, fsOps);
    await renameWithRetry(tmp, path.join(stage, IMPORT_MANIFEST_NAME), { fsOps });

    await recordAudit({
      kind: 'auth',
      feature: 'data_import_direct',
      status: 'ok',
      meta: { rows: snapshot.totalRows, backups: backupNames.length, schema: snapshot.schemaVersion },
    });
    return {
      status: 'staged',
      needsRestart: true,
      copiedFrom: sourceDir,
      schemaVersion: snapshot.schemaVersion,
      totalRows: snapshot.totalRows,
      backups: backupNames.length,
      files: files.length,
    };
  } catch (e) {
    // Only our own staging folder goes. The source and the live files are untouched.
    await wipeDir(stage, fsOps).catch(() => {});
    await recordAudit({ kind: 'auth', feature: 'data_import_direct', status: 'error', meta: { reason: isBackupError(e) ? e.code : 'unknown' } });
    if (isBackupError(e)) throw e;
    if (isNoSpaceError(e)) throw new BackupError('disk_full', { cause: e });
    throw new BackupError('import_failed', { cause: e });
  } finally {
    release();
  }
}

/** True for a staged file name the importer could have written: the database, a data file, a backup file or a legacy license file. */
function isStagedName(rel) {
  if (rel === DB_FILENAME || isLegacyStaged(rel) || IMPORT_DATA_FILES.some((f) => f.name === rel)) return true;
  return rel.startsWith('backups/') && isBackupFileName(rel.slice('backups/'.length));
}

/** Shape of a manifest (what verifyStage and a resumed swap rely on). Says nothing about the files themselves. */
function manifestShapeOk(manifest) {
  if (!isPlainObject(manifest) || manifest.format !== MANIFEST_FORMAT || manifest.formatVersion !== 1) return false;
  if (typeof manifest.createdAt !== 'string') return false;
  const created = Date.parse(manifest.createdAt);
  // The stamp of the import-aside folder comes from createdAt, so only a real ISO timestamp is accepted.
  if (!Number.isFinite(created) || new Date(created).toISOString() !== manifest.createdAt) return false;
  if (!Number.isInteger(manifest.schemaVersion) || manifest.schemaVersion < 1 || manifest.schemaVersion > latestSchemaVersion()) return false;
  if (manifest.integrity !== 'ok' || !Array.isArray(manifest.files)) return false;
  const names = new Set();
  for (const f of manifest.files) {
    if (!isPlainObject(f) || typeof f.rel !== 'string' || !isStagedName(f.rel) || names.has(f.rel)) return false;
    if (typeof f.sha256 !== 'string' || !SHA256_RE.test(f.sha256) || !Number.isInteger(f.size) || f.size < 0) return false;
    names.add(f.rel);
  }
  return names.has(DB_FILENAME) && names.has(KEY_FILE_NAME);
}

/**
 * Checks a complete stage before the first file moves. Fast on purpose: burrow.db and secrets.key are
 * re-hashed; every other file (the backups) is checked by size, because it was hashed when it was staged. The database
 * integrity_check ran at stage time (the manifest says so), and the hash proves the file is the one that was checked.
 */
async function verifyStage({ dir, manifest, fsOps, hashFile }) {
  if (!manifestShapeOk(manifest)) return false;
  for (const f of manifest.files) {
    const file = path.join(dir, ...f.rel.split('/'));
    // A file that is really gone (ENOENT) or has the wrong bytes is a stage that does not verify. Any other read error (a
    // locked file, an antivirus scan, a flaky disk) says nothing about the stage: the caller keeps it for the next start.
    let st;
    try {
      st = await statOrNull(file, fsOps);
    } catch (e) {
      throw transientError(e);
    }
    if (!st || !st.isFile() || st.size !== f.size) return false;
    if (HASHED_FILES.has(f.rel)) {
      let sum;
      try {
        sum = await hashFile(file, fsOps);
      } catch (e) {
        if (isMissing(e)) return false;
        throw transientError(e);
      }
      if (sum !== f.sha256) return false;
    }
  }
  return true;
}

/**
 * Deletes the legacy license files an older version staged and returns the manifest without them, so nothing verifies, swaps
 * or waits for them. A file that cannot be removed right now refuses the start (import_swap_transient); the next start retries.
 */
async function dropLegacyStaged({ stageDir, manifest, fsOps }) {
  for (const f of manifest.files) {
    if (!isLegacyStaged(f.rel)) continue;
    try {
      await rmWithRetry(path.join(stageDir, f.rel), { fsOps });
    } catch (e) {
      throw swapError('import_swap_transient', e);
    }
  }
  return { ...manifest, files: manifest.files.filter((f) => !isLegacyStaged(f.rel)) };
}

const transientError = (cause) => Object.assign(new Error('Import stage could not be read right now'), { code: 'verify_transient', cause });

/** An error that stops the start with a clear reason (server.js turns it into the "could not finish your import" message). */
const swapError = (code, cause) => Object.assign(new Error(`Import swap stopped: ${code}`), { code, ...(cause === undefined ? {} : { cause }) });

/**
 * Strict existence check for everything that decides what a swap does. False only for ENOENT / ENOTDIR (the path is really
 * not there); any other error (EBUSY, EPERM, EACCES from an antivirus scan or a sync tool) says nothing about the file, so it
 * throws import_swap_transient: startup refuses (exit 4) and the next start retries. Windows fs.rename replaces an existing
 * file, so "could not look" must never be read as "not there".
 */
async function exists(file, fsOps) {
  try {
    await fsOps.lstat(file);
    return true;
  } catch (e) {
    if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') return false;
    throw swapError('import_swap_transient', e);
  }
}

/** Moves a live file or folder into the aside folder under a name that is not taken; nothing is ever overwritten or skipped. */
async function moveAside({ dataDir, name, asideDir, fsOps }) {
  const from = path.join(dataDir, name);
  if (!(await exists(from, fsOps))) return;
  await fsOps.mkdir(asideDir, { recursive: true, mode: 0o700 });
  let to = path.join(asideDir, name);
  for (let n = 1; await exists(to, fsOps); n += 1) to = path.join(asideDir, `${name}-${n}`);
  await renameWithRetry(from, to, { fsOps });
}

/** Renames a staged file into the data folder; fails closed when something already lives there (or cannot be ruled out). */
async function renameIn({ from, to, fsOps }) {
  if (await exists(to, fsOps)) throw swapError('import_swap_conflict');
  await renameWithRetry(from, to, { fsOps });
}

/** True while the stage still holds a staged data file (the database, a data file or backup files) that has not been swapped in. */
async function stagedFilesLeft(dir, fsOps) {
  for (const name of [DB_FILENAME, ...IMPORT_DATA_FILES.map((f) => f.name)]) {
    if (await exists(path.join(dir, name), fsOps)) return true;
  }
  try {
    return (await fsOps.readdir(path.join(dir, 'backups'))).length > 0;
  } catch (e) {
    if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') return false;
    throw swapError('import_swap_transient', e);
  }
}

/** Throws unless every manifest entry is strictly gone from the stage (a file that cannot be looked at counts as still there). */
async function assertStageEmpty({ stageDir, manifest, fsOps }) {
  for (const f of manifest.files) {
    if (await exists(path.join(stageDir, ...f.rel.split('/')), fsOps)) throw swapError('import_swap_incomplete');
  }
}

/** Backup files grouped by id, each group data first and metadata last, so a backup becomes visible only when it is complete. */
function groupBackupFiles(names) {
  const groups = new Map();
  for (const name of names) {
    const m = BACKUP_FILE_RE.exec(name);
    if (!m || !ID_RE.test(m[1]) || !BACKUP_EXTS.includes(m[2])) continue;
    if (!groups.has(m[1])) groups.set(m[1], []);
    groups.get(m[1]).push(name);
  }
  const metaLast = (a, b) => Number(a.endsWith('.meta.json')) - Number(b.endsWith('.meta.json')) || (a < b ? -1 : a > b ? 1 : 0);
  return [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id, files]) => ({ id, files: files.sort(metaLast) }));
}

/**
 * Moves the staged backups into the target's backups folder. When the target has none the folder is renamed in as it is.
 * Otherwise (1) every backup of the target's own moves to import-aside/<stamp>/backups, whole ids together, metadata first so
 * a backup disappears before its data does (the target's database was provably unused, and merged in they would be newer than
 * the imported ones and take their retention slots); a marker file in the stage records that this step is done, so a resumed
 * swap never moves an imported file aside; then (2) the staged files move in id by id, data first and metadata last. The
 * target's backups folder must be a real directory (no symbolic link, no junction). Restartable: a file that has moved is no
 * longer in the stage.
 */
async function mergeBackups({ from, to, asideDir, stageDir, fsOps }) {
  if (!(await exists(to, fsOps))) {
    await renameWithRetry(from, to, { fsOps });
    return;
  }
  let st;
  try {
    st = await fsOps.lstat(to);
  } catch (e) {
    throw swapError('import_swap_transient', e);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw swapError('import_swap_conflict');
  const marker = path.join(stageDir, BACKUPS_ASIDE_MARKER);
  if (!(await exists(marker, fsOps))) {
    let own;
    try {
      own = await fsOps.readdir(to);
    } catch (e) {
      throw swapError('import_swap_transient', e);
    }
    for (const { files } of groupBackupFiles(own)) {
      for (const name of [...files].reverse()) {
        await fsOps.mkdir(path.join(asideDir, 'backups'), { recursive: true, mode: 0o700 });
        let aside = path.join(asideDir, 'backups', name);
        for (let n = 1; await exists(aside, fsOps); n += 1) aside = path.join(asideDir, 'backups', `${name}-${n}`);
        await renameWithRetry(path.join(to, name), aside, { fsOps });
      }
    }
    await writeFileSynced(marker, `${new Date().toISOString()}\n`, fsOps);
  }
  for (const { files } of groupBackupFiles(await fsOps.readdir(from))) {
    for (const name of files) await renameIn({ from: path.join(from, name), to: path.join(to, name), fsOps });
  }
  await rmWithRetry(from, { fsOps, recursive: true });
}

/**
 * Closes a stage whose files are all in place: rename first (atomic), then delete, so a crash while deleting never leaves a
 * stage with a marker and no manifest. When the rename fails the stage is left as it is, whole: the next start finds the marker
 * with nothing staged and closes it again. Nothing is ever wiped in arbitrary order.
 */
async function closeStage({ stage, fsOps, log }) {
  const finished = `${stage.dir}.done`;
  try {
    await renameWithRetry(stage.dir, finished, { fsOps });
  } catch (e) {
    log(`import: the finished staging folder could not be renamed (${e?.code ?? 'unknown'}); it is left for the next start`);
    return;
  }
  await wipeDir(finished, fsOps).catch(() => {});
}

/**
 * Startup step, before the database opens: finishes a staged import. No stage, nothing to do. An incomplete stage (no
 * manifest) is our own partial output and is removed. A complete stage is verified again; if this Burrow got data of
 * its own in the meantime, or the stage no longer verifies, the stage is removed and nothing is swapped. Otherwise the
 * target's own empty files move to import-aside/ and the staged files are renamed in. After the first file moved the
 * swap only goes forward (marker file), so a crash in the middle resumes on the next start. From then on the stage is
 * never removed on a doubt: an unreadable manifest while staged files remain, or a restore journal next to the marker, throws
 * (the server refuses to start with a message), and the stage goes only after every manifest entry is confirmed in the data
 * folder. A started swap with no staged file left is finished: it is closed after an existence check of burrow.db and secrets.key.
 * A stage that cannot be read right now (not ENOENT) is kept and answers `none` / `verify_unavailable`.
 * @param {{ dataDir?: string, fsOps?: import('./fsops.js').FsOps, now?: Date, log?: (m: string) => void,
 *   hashFile?: (file: string, fsOps: import('./fsops.js').FsOps) => Promise<string>,
 *   hooks?: { afterMove?: (rel: string) => void | Promise<void> } }} [opts] `hashFile` is a test seam.
 * @returns {Promise<{ result: 'none' | 'swapped' | 'discarded', reason?: string }>}
 */
export async function reconcileDirectImport({ dataDir = dataDirOf(), fsOps = createFsOps(), now = new Date(), log = () => {}, hooks, hashFile = sha256File } = {}) {
  // A folder without our marker is not ours: touch nothing in it (not even leftovers of a finished swap).
  if (!hasOwnershipMarker(dataDir)) return { result: 'none' };
  await sweepFinished(dataDir, fsOps);
  const stages = await listStages(dataDir, fsOps);
  if (stages.length === 0) return { result: 'none' };
  const swapping = [];
  for (const stage of stages) {
    if (await exists(path.join(stage.dir, IMPORT_SWAPPING_NAME), fsOps)) swapping.push(stage);
  }
  // An interrupted backup restore is finished first; a stage that has not started waits. A swap that has started cannot
  // wait behind it (both move the same files): refuse to start and say so.
  if (await exists(path.join(dataDir, RESTORE_JOURNAL_FILENAME), fsOps)) {
    if (swapping.length > 0) throw swapError('import_restore_conflict');
    return { result: 'none' };
  }
  const resumable = swapping.length > 0 ? swapping : stages.filter((s) => s.complete).slice(-1);
  // Everything that is not the stage we continue is our own leftover.
  for (const stage of stages) {
    if (!resumable.includes(stage)) await wipeDir(stage.dir, fsOps).catch(() => {});
  }
  if (resumable.length === 0) return { result: 'discarded', reason: 'incomplete' };
  const stage = resumable[0];
  const started = swapping.includes(stage);
  let manifest = null;
  let manifestError;
  try {
    manifest = JSON.parse(await fsOps.readFile(path.join(stage.dir, IMPORT_MANIFEST_NAME), 'utf8'));
  } catch (e) {
    manifestError = e;
  }
  const manifestOk = manifestShapeOk(manifest);
  if (manifestOk) manifest = await dropLegacyStaged({ stageDir: stage.dir, manifest, fsOps });
  if (started) {
    // Files may already have moved. With staged files still in the stage and no readable manifest nothing says what belongs
    // where: keep everything and refuse. With no staged data file left every rename happened: the swap is finished and only
    // the closing of the stage is missing.
    const left = await stagedFilesLeft(stage.dir, fsOps);
    if (!manifestOk && left) throw swapError('import_manifest_unreadable', manifestError);
    if (!left) {
      // The database may have been used since, so no size check: the two files every start needs just have to exist.
      if (manifestOk) {
        for (const rel of [DB_FILENAME, KEY_FILE_NAME]) {
          if (!(await exists(path.join(dataDir, rel), fsOps))) throw swapError('import_swap_incomplete');
        }
      }
      if (manifestOk) await assertStageEmpty({ stageDir: stage.dir, manifest, fsOps });
      await closeStage({ stage, fsOps, log });
      log('import: your data from the other Burrow was put in place');
      return { result: 'swapped' };
    }
  } else {
    let verified;
    try {
      verified = await verifyStage({ dir: stage.dir, manifest, fsOps, hashFile });
    } catch (e) {
      if (e?.code !== 'verify_transient') throw e;
      // Not a verdict on the stage: keep it, start without it, and look again at the next start.
      log('import: the staged data could not be read just now; it was kept and will be checked again at the next start');
      return { result: 'none', reason: 'verify_unavailable' };
    }
    if (!verified) {
      await wipeDir(stage.dir, fsOps).catch(() => {});
      log('import: the staged data did not verify; it was removed and nothing was swapped');
      return { result: 'discarded', reason: 'unverified' };
    }
    const liveDb = path.join(dataDir, DB_FILENAME);
    const used = (await exists(liveDb, fsOps))
      ? !safePristine(() => new DatabaseSync(liveDb), true, dataDir)
      : backupsShowUserData(dataDir);
    if (used) {
      await wipeDir(stage.dir, fsOps).catch(() => {});
      log('import: this Burrow got data of its own after the import was prepared; the import was cancelled');
      return { result: 'discarded', reason: 'target_has_data' };
    }
    await writeFileSynced(path.join(stage.dir, IMPORT_SWAPPING_NAME), `${now.toISOString()}\n`, fsOps);
  }

  const stamp = manifest.createdAt.replace(/[-:.]/g, '').slice(0, 15);
  const asideDir = path.join(dataDir, IMPORT_ASIDE_DIR, stamp);
  const staged = new Set(manifest.files.map((f) => f.rel));
  // Before the imported key goes in, the target's own copy of every data file moves aside, staged or not: data of
  // this Burrow's own must never be checked against (or outlive) the key it was made with. This runs only
  // while the staged key is still in the stage: the key is first in SWAP_ORDER, so once it is in, the target's own files are
  // already aside and what is in the data folder now belongs to the imported Burrow.
  if (await exists(path.join(stage.dir, KEY_FILE_NAME), fsOps)) {
    for (const { name } of IMPORT_DATA_FILES) {
      const pending = staged.has(name) ? await exists(path.join(stage.dir, name), fsOps) : true;
      if (pending) await moveAside({ dataDir, name, asideDir, fsOps });
    }
  }
  const hasStaged = (name) => (name === 'backups' ? [...staged].some((r) => r.startsWith('backups/')) : staged.has(name));
  for (const name of SWAP_ORDER) {
    const from = path.join(stage.dir, name);
    if (!hasStaged(name) || !(await exists(from, fsOps))) continue;
    if (name === 'backups') {
      await mergeBackups({ from, to: path.join(dataDir, 'backups'), asideDir, stageDir: stage.dir, fsOps });
      await hooks?.afterMove?.(name);
      continue;
    }
    if (name === DB_FILENAME) {
      for (const side of DB_SIDE_NAMES) await moveAside({ dataDir, name: side, asideDir, fsOps });
    } else {
      await moveAside({ dataDir, name, asideDir, fsOps });
    }
    await renameIn({ from, to: path.join(dataDir, name), fsOps });
    await hooks?.afterMove?.(name);
  }
  // Only now is the stage given up, and only when everything the manifest lists is in the data folder.
  for (const f of manifest.files) {
    const live = path.join(dataDir, ...f.rel.split('/'));
    let st;
    try {
      st = await statOrNull(live, fsOps);
    } catch (e) {
      throw swapError('import_swap_transient', e);
    }
    if (!st || !st.isFile() || st.size !== f.size) throw swapError('import_swap_incomplete');
    // The key is tiny and decides whether the imported secrets decrypt: size alone is not enough.
    if (HASHED_FILES.has(f.rel) && f.rel !== DB_FILENAME) {
      let sum;
      try {
        sum = await sha256File(live, fsOps);
      } catch (e) {
        throw swapError('import_swap_transient', e);
      }
      if (sum !== f.sha256) throw swapError('import_swap_incomplete');
    }
  }
  await assertStageEmpty({ stageDir: stage.dir, manifest, fsOps });
  await closeStage({ stage, fsOps, log });
  log('import: your data from the other Burrow was put in place');
  return { result: 'swapped' };
}

/**
 * After the database is open: leaves an audit row and the one-time note (app_state `directImport:cancelled`, shown by Home and
 * Settings) for an import that was prepared and then cancelled at startup, so the user is not left wondering why nothing came in.
 * @param {string} reason one of CANCELLED_REASONS
 * @param {{ now?: Date }} [opts]
 */
export async function recordCancelledImport(reason, { now = new Date() } = {}) {
  if (!CANCELLED_REASONS.includes(reason)) return;
  await recordAudit({ kind: 'auth', feature: 'data_import_cancelled', status: 'error', meta: { reason } });
  upsert('app_state', { key: CANCELLED_KEY, value: { reason, at: now.toISOString() }, updated_at: now.toISOString() }, { conflict: ['key'] });
}

/**
 * Removes every staging folder of an import that was prepared but not finished (used by Erase and tests).
 * @param {{ dataDir?: string, fsOps?: import('./fsops.js').FsOps }} [opts]
 */
export async function discardStagedImports({ dataDir = dataDirOf(), fsOps = createFsOps() } = {}) {
  for (const stage of await listStages(dataDir, fsOps)) await rmWithRetry(stage.dir, { fsOps, recursive: true });
  await sweepFinished(dataDir, fsOps);
}
