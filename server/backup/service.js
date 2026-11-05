// Backup service: create a verified snapshot (.db plus a JSON export ZIP), skip unchanged days,
// apply retention, clean up leftovers, report status and run the daily scheduler.
// Everything stays on this computer. Disk access goes through the FsOps seam.
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isSchedulerEnabled } from '../config.js';
import { RESTORE_JOURNAL_FILENAME, getDb, resolveDbPath, yieldToLoop } from '../db/index.js';
import { buildExportZip } from '../exportRoutes.js';
import { recordAudit } from '../auditHook.js';
import { getAppVersion } from '../runtime.js';
import { BackupError, isBackupError, isNoSpaceError } from './errors.js';
import { createFsOps, exists, isMissing, renameWithRetry, rmWithRetry, writeFileSynced } from './fsops.js';
import { busyError, currentOp, isGateClosed, tryAcquire } from './lock.js';
import {
  computeStatus,
  listMetas,
  readState,
  toSummary,
  writeMeta,
  writeState,
} from './manifest.js';
import {
  BACKUP_KINDS,
  ID_RE,
  backupBase,
  backupsDir,
  dataDirOf,
  ensureBackupsDir,
  newBackupId,
  resolveBackupFile,
} from './paths.js';
import { planRetention } from './retention.js';
import { getAutoBackup, getBackupSettings, shouldShowAutoOffReminder } from './settings.js';
import {
  databaseBytes,
  inspectDbFile,
  latestSchemaVersion,
  normalizeSnapshot,
  sha256File,
  takeSnapshot,
} from './snapshot.js';
import { isTerminalWorkerFailure, runBackupOp } from './worker/client.js';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
export const DISK_FLOOR_BYTES = 256 * MIB;
export const DISK_WARN_BYTES = 1 * GIB;
export const DISK_NEED_EXTRA_BYTES = 8 * MIB;
export const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;
/** Private working folder of the copy from the stable Burrow: <backups>/.stable-copy-<16 hex>/. */
export const STABLE_COPY_DIR_PREFIX = '.stable-copy-';
const STABLE_COPY_DIR_RE = /^\.stable-copy-[0-9a-f]{16}$/;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const RETRY_AFTER_FAILURE_MS = 6 * 60 * 60 * 1000;
export const FUTURE_SKEW_MS = 5 * 60 * 1000;
export const STARTUP_DELAY_MS = 60_000;
export const TICK_MS = 60 * 60 * 1000;

/** @param {Date | (() => Date) | undefined} now */
export const resolveNow = (now) => (typeof now === 'function' ? now() : now instanceof Date ? now : new Date());

/** @returns {Promise<{ free: number | null, warn: boolean }>} */
async function freeSpace(dir, fsOps) {
  try {
    const s = await fsOps.statfs(dir);
    const free = Number(s.bavail) * Number(s.bsize);
    return Number.isFinite(free) ? { free, warn: free < DISK_WARN_BYTES } : { free: null, warn: false };
  } catch {
    return { free: null, warn: false };
  }
}

/** The files one partial copy can leave: the file itself and its rollback journal, WAL and shared memory. */
const PARTIAL_SUFFIXES = Object.freeze(['', '-journal', '-wal', '-shm']);
const partialFiles = (file) => PARTIAL_SUFFIXES.map((suffix) => `${file}${suffix}`);

const failedMeta = ({ id, kind, createdAt, error }) => ({
  format: 'burrow-backup',
  formatVersion: 1,
  id,
  kind,
  createdAt,
  appVersion: getAppVersion(),
  schemaVersion: null,
  status: 'failed',
  error,
  db: null,
  export: { file: null, bytes: 0, sha256: null, status: 'failed' },
  rowCounts: {},
  totalRows: 0,
  fingerprint: null,
  verifiedAt: null,
});

function classifyFailure(e) {
  if (isBackupError(e) && (e.code === 'disk_low' || e.code === 'disk_full')) return e.code;
  if (isNoSpaceError(e)) return 'disk_full';
  if (e?.backupReason) return e.backupReason;
  return 'snapshot_failed';
}

async function removeQuiet(files, fsOps) {
  for (const f of files) {
    try {
      await rmWithRetry(f, { fsOps });
    } catch {
      // leftovers are removed by cleanupOrphans later
    }
  }
}

/**
 * Deletes verified-or-failed backups the retention plan no longer wants (meta first, then .db,
 * then the export ZIP). `protectIds` are never removed (the backup that was just made).
 * @param {{ dir?: string, settings?: object, now?: Date | (() => Date), fsOps?: import('./fsops.js').FsOps,
 *   protectIds?: string[] }} [opts]
 * @returns {Promise<{ removed: string[] }>}
 */
export async function applyRetention({ dir = backupsDir(), settings, now, fsOps = createFsOps(), protectIds = [] } = {}) {
  ensureBackupsDir(dir);
  const effective = settings ?? (await getBackupSettings());
  const metas = await listMetas(dir, fsOps);
  const { remove } = planRetention(metas, effective, resolveNow(now), { protectIds });
  const removed = [];
  for (const meta of remove) {
    const base = backupBase(meta.id, dir);
    await removeQuiet([`${base}.meta.json`, `${base}.db`, `${base}.export.zip`], fsOps);
    removed.push(meta.id);
  }
  return { removed };
}

/**
 * Retention that runs only when no backup or restore is active (used when settings change).
 * @returns {Promise<{ removed: string[], skipped: boolean }>}
 */
export async function applyRetentionIfIdle(opts = {}) {
  const release = tryAcquire('backup');
  if (!release) return { removed: [], skipped: true };
  try {
    const { removed } = await applyRetention(opts);
    return { removed, skipped: false };
  } finally {
    release();
  }
}

/**
 * Removes *.partial, *.tmp, .incoming-* and data files without a meta, and .stable-copy-* folders, when older
 * than one hour.
 * Never touches a file that belongs to a backup with a meta.
 * `minAgeMs` (default one hour) is 0 when the caller needs everything gone now.
 * @param {{ dir?: string, now?: Date | (() => Date), fsOps?: import('./fsops.js').FsOps, minAgeMs?: number }} [opts]
 * @returns {Promise<{ removed: string[] }>}
 */
export async function cleanupOrphans({ dir = backupsDir(), now, fsOps = createFsOps(), minAgeMs = ORPHAN_MIN_AGE_MS } = {}) {
  ensureBackupsDir(dir);
  let names;
  try {
    names = await fsOps.readdir(dir);
  } catch (e) {
    if (isMissing(e)) return { removed: [] };
    throw e;
  }
  const withMeta = new Set();
  for (const name of names) {
    const m = /^burrow-(.+)\.meta\.json$/.exec(name);
    if (m && ID_RE.test(m[1])) withMeta.add(m[1]);
  }
  const nowMs = resolveNow(now).getTime();
  const removed = [];
  for (const name of names) {
    let orphan =
      PARTIAL_SUFFIXES.some((suffix) => name.endsWith(`.partial${suffix}`)) ||
      name.endsWith('.tmp') ||
      name.startsWith('.incoming-');
    // Only the exact private-copy name (prefix plus 16 hex characters); it must also be a real directory.
    const isCopyDir = STABLE_COPY_DIR_RE.test(name);
    if (isCopyDir) orphan = true;
    if (!orphan) {
      const m = /^burrow-(.+?)(\.db|\.export\.zip)$/.exec(name);
      orphan = Boolean(m && ID_RE.test(m[1]) && !withMeta.has(m[1]));
    }
    if (!orphan) continue;
    const file = path.join(dir, name);
    try {
      const st = await fsOps.lstat(file);
      if (minAgeMs > 0 && nowMs - st.mtimeMs < minAgeMs) continue;
      // A link or a plain file with a private-copy name is not ours to delete recursively.
      if (isCopyDir && (!st.isDirectory() || st.isSymbolicLink())) continue;
      await rmWithRetry(file, { fsOps, recursive: isCopyDir });
      removed.push(name);
    } catch {
      // gone already or locked: next run
    }
  }
  return { removed };
}

/** Writes the audit row for a restore that was recovered at startup, once the database is open. */
export async function flushRecoveryAudit({ dir = backupsDir(), fsOps = createFsOps() } = {}) {
  if (currentOp() === 'restore') return;
  const state = await readState(dir, fsOps);
  if (!state.pendingRecoveryAudit) return;
  try {
    getDb();
  } catch {
    return;
  }
  await recordAudit({
    kind: 'export',
    feature: 'backup_restore',
    // A recovery that finished the restore is a success; one that undid it is an error.
    status: state.pendingRecoveryAudit === 'rolled_forward' ? 'ok' : 'error',
    meta: { recovered: String(state.pendingRecoveryAudit) },
  });
  await writeState({ pendingRecoveryAudit: null }, { dir, fsOps });
}

/**
 * @param {{ now?: Date | (() => Date), dir?: string, fsOps?: import('./fsops.js').FsOps }} [opts]
 */
export async function getBackupStatus({ now, dir = backupsDir(), fsOps = createFsOps() } = {}) {
  ensureBackupsDir(dir);
  await flushRecoveryAudit({ dir, fsOps }).catch(() => {});
  const [state, metas] = await Promise.all([readState(dir, fsOps), listMetas(dir, fsOps)]);
  // A journal with no restore running means a failed rollback is waiting for the startup recovery.
  let recoveryRequired = false;
  if (currentOp() !== 'restore') {
    try {
      recoveryRequired = await exists(path.join(dataDirOf(), RESTORE_JOURNAL_FILENAME), fsOps);
    } catch {
      recoveryRequired = false;
    }
  }
  // The status route stays up while a restore swaps the file: no switch value is readable then, so
  // report it as unknown (autoSwitch null, no reminder) instead of guessing.
  let auto = null;
  try {
    auto = await getAutoBackup();
  } catch {
    // unreadable during a restore
  }
  const at = resolveNow(now);
  const status = computeStatus(state, metas, at, {
    restoring: currentOp() === 'restore' || isGateClosed(),
    // Effective: the user's switch and the global BURROW_SCHEDULER kill switch.
    autoEnabled: isSchedulerEnabled() && (auto?.enabled ?? true),
    recoveryRequired,
  });
  return {
    ...status,
    autoSwitch: auto ? auto.enabled : null,
    autoChangedAt: auto?.changedAt ?? null,
    autoOffReminder: auto ? shouldShowAutoOffReminder({ auto, newestGoodAt: status.lastSuccessAt, now: at }) : false,
  };
}

/** Summaries of every backup, newest first. */
export async function listBackupSummaries({ dir = backupsDir(), fsOps = createFsOps() } = {}) {
  ensureBackupsDir(dir);
  return (await listMetas(dir, fsOps)).map(toSummary);
}

async function recordFailure({ id, kind, createdAt, code, free, warn, dir, fsOps }) {
  try {
    await writeMeta(failedMeta({ id, kind, createdAt, error: code }), dir, fsOps);
  } catch {
    // nothing more we can do; the state file below still records the failure
  }
  // A restore's safety copy is not a scheduled run: it must not move the scheduler's failure clock.
  if (kind !== 'safety') {
    try {
      await writeState(
        {
          lastRunAt: createdAt,
          lastResult: 'failed',
          lastError: code,
          lastFailureAt: createdAt,
          diskWarning: warn,
          freeBytes: free,
        },
        { dir, fsOps },
      );
    } catch {
      // ignore
    }
  }
  await recordAudit({
    kind: 'export',
    feature: 'backup_create',
    status: 'error',
    meta: { backup_kind: kind, error: code },
  });
}

let unresolvedLogged = false;

/**
 * Absolute path of the file behind a live handle, or null when there is none (an in-memory database, or
 * a path that cannot be resolved: then the backup runs on the main thread). DatabaseSync#location() does
 * not exist on every supported Node (it is missing on 22.13), so without it the path comes from
 * resolveDbPath(), the one getDb() opened. A failure to resolve is logged once, code only.
 */
function liveDbPath(db) {
  if (typeof db.location === 'function') {
    try {
      const loc = db.location();
      return typeof loc === 'string' && path.isAbsolute(loc) ? loc : null;
    } catch {
      // fall through to the resolver
    }
  }
  try {
    return resolveDbPath();
  } catch (e) {
    if (!unresolvedLogged) {
      unresolvedLogged = true;
      console.error('Backup worker path unresolved, using the main thread:', e?.code ?? 'unknown');
    }
    return null;
  }
}

/**
 * Snapshot, normalize and inspect the copy. By default this runs in a worker thread so the event loop
 * stays free; the main-thread path is used when a seam is injected (own db handle or snapshotFn), when
 * no worker can start, and as a single retry when our own worker crashed (not after a timeout, a cancel or
 * the worker's heap limit). The copy was written: if it
 * cannot be opened or read back, it is damaged (integrity_failed), whether SQLite reports the damage
 * as rows or raises it as an exception.
 */
async function snapshotAndInspect({ db, partialDb, snapshotFn, fsOps, useWorker }) {
  const dbPath = useWorker ? liveDbPath(db) : null;
  if (dbPath) {
    try {
      return await runBackupOp('snapshotInspect', {
        dbPath,
        partialPath: partialDb,
        latestVersion: latestSchemaVersion(),
      });
    } catch (e) {
      if (e?.workerOpFailed) {
        // A full disk while stripping the copy is the disk's problem, not damage to the copy.
        if (e.stage === 'inspect' && !isNoSpaceError(e)) {
          throw Object.assign(new BackupError('backup_failed'), { backupReason: 'integrity_failed', cause: e });
        }
        throw e;
      }
      // A timeout, a cancel or the heap limit would only repeat on the main thread (and block it).
      if (isTerminalWorkerFailure(e)) throw e;
      // No worker, or it died: clear what it left and run the same steps here.
      await removeQuiet(partialFiles(partialDb), fsOps);
    }
  }
  await yieldToLoop();
  snapshotFn(db, partialDb);
  await yieldToLoop();
  try {
    normalizeSnapshot(partialDb);
    await yieldToLoop();
    return inspectDbFile(partialDb, { latestVersion: latestSchemaVersion() });
  } catch (cause) {
    if (isNoSpaceError(cause)) throw cause;
    throw Object.assign(new BackupError('backup_failed'), { backupReason: 'integrity_failed', cause });
  }
}

/**
 * Writes the export ZIP of the verified snapshot to `partialZip`. By default the whole build (reading
 * tables, JSON/CSV/Markdown, compression) runs in the backup worker so the event loop stays free; the
 * main-thread path is used when exportFn is a test seam, when no worker can start, and as a single
 * retry when our own worker crashed. A timeout is a failed export (the backup itself still succeeds).
 * @returns {Promise<{ bytes: number, complete: boolean }>}
 */
async function buildExportFile({ partialDb, partialZip, now, exportFn, fsOps, useWorker }) {
  if (useWorker) {
    try {
      return await runBackupOp('buildExport', { dbPath: partialDb, outPath: partialZip, nowIso: now.toISOString() });
    } catch (e) {
      if (e?.workerOpFailed || isTerminalWorkerFailure(e)) throw e;
      // No worker, or it died: clear what it left and build here.
      await removeQuiet([partialZip], fsOps);
    }
  }
  const reader = new DatabaseSync(partialDb, { readOnly: true });
  try {
    const { zip, manifest } = await exportFn({ db: reader, now });
    const buf = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
    await writeFileSynced(partialZip, buf, fsOps);
    return { bytes: buf.length, complete: manifest?.complete !== false };
  } finally {
    reader.close();
  }
}

/**
 * Makes one backup.
 * @param {{
 *   kind?: 'auto' | 'manual' | 'safety',
 *   now?: Date | (() => Date),
 *   fsOps?: import('./fsops.js').FsOps,
 *   db?: import('node:sqlite').DatabaseSync,
 *   dir?: string,
 *   skipIfUnchanged?: boolean,
 *   lockHeld?: boolean,
 *   snapshotFn?: typeof takeSnapshot,
 *   exportFn?: typeof buildExportZip,
 * }} [opts] lockHeld is internal (restore takes its safety copy while holding the lock); snapshotFn
 *   and exportFn are test seams
 * @returns {Promise<{ created: boolean, meta: object, reason?: 'unchanged' }>}
 */
export async function createBackup(opts = {}) {
  const {
    kind = 'manual',
    fsOps = createFsOps(),
    lockHeld = false,
    snapshotFn = takeSnapshot,
    exportFn = buildExportZip,
  } = opts;
  if (!BACKUP_KINDS.includes(kind)) throw new BackupError('invalid_request');
  const skipIfUnchanged = opts.skipIfUnchanged ?? kind === 'auto';
  let release = null;
  if (!lockHeld) {
    release = tryAcquire('backup');
    if (!release) throw busyError();
  }
  const dir = opts.dir ?? backupsDir();
  const now = resolveNow(opts.now);
  const createdAt = now.toISOString();
  const id = newBackupId(kind, now);
  const base = backupBase(id, dir);
  const partialDb = `${base}.db.partial`;
  const partialZip = `${base}.export.zip.partial`;
  const finalDb = `${base}.db`;
  const finalZip = `${base}.export.zip`;
  let metaWritten = false;
  let dirChecked = false;
  let space = { free: null, warn: false };
  try {
    ensureBackupsDir(dir);
    dirChecked = true;
    const db = opts.db ?? getDb();

    // Disk check: room for a copy of the data plus its export, and a safety floor.
    space = await freeSpace(dir, fsOps);
    if (space.free !== null) {
      const need = databaseBytes(db) * 2 + DISK_NEED_EXTRA_BYTES;
      if (space.free - need < DISK_FLOOR_BYTES) throw new BackupError('disk_low');
    }

    const inspected = await snapshotAndInspect({
      db,
      partialDb,
      snapshotFn,
      fsOps,
      useWorker: !opts.db && snapshotFn === takeSnapshot,
    });
    await yieldToLoop();
    if (!inspected.integrityOk) {
      throw Object.assign(new BackupError('backup_failed'), { backupReason: 'integrity_failed' });
    }

    if (skipIfUnchanged) {
      const previous = (await listMetas(dir, fsOps)).find((m) => m.status === 'verified');
      if (previous && previous.fingerprint === inspected.fingerprint) {
        // null: the old copy could not be read, which proves nothing about it. Only a digest that was
        // computed and differs (or a file that is gone) marks the old backup as damaged.
        // A file that is not there at all is definitive, so it counts as damaged.
        let digest = null;
        let damaged = false;
        try {
          digest = await sha256File(resolveBackupFile(previous.id, '.db', dir), fsOps);
        } catch (e) {
          digest = null;
          damaged = (isBackupError(e) && e.code === 'backup_not_found') || isMissing(e);
        }
        if (digest !== null && Boolean(previous.db) && digest === previous.db.sha256) {
          await removeQuiet([partialDb], fsOps);
          await writeState(
            {
              lastRunAt: createdAt,
              lastResult: 'unchanged',
              lastError: null,
              lastSuccessAt: createdAt,
              confirmedId: previous.id,
              diskWarning: space.warn,
              freeBytes: space.free,
            },
            { dir, fsOps },
          );
          return { created: false, meta: previous, reason: 'unchanged' };
        }
        if (digest !== null || damaged) {
          await writeMeta({ ...previous, status: 'failed', error: 'hash_mismatch' }, dir, fsOps);
        }
      }
    }

    const dbBytes = (await fsOps.lstat(partialDb)).size;
    const dbSha = await sha256File(partialDb, fsOps);
    await yieldToLoop();

    let exportInfo = { file: null, bytes: 0, sha256: null, status: 'failed' };
    try {
      const built = await buildExportFile({
        partialDb,
        partialZip,
        now,
        exportFn,
        fsOps,
        useWorker: !opts.db && exportFn === buildExportZip,
      });
      // Hash the file that was written (streamed), not the in-memory buffer.
      const zipSha = await sha256File(partialZip, fsOps);
      exportInfo = {
        file: `burrow-${id}.export.zip`,
        bytes: built.bytes,
        sha256: zipSha,
        status: built.complete ? 'ok' : 'partial',
      };
    } catch (e) {
      await removeQuiet([partialZip], fsOps);
      if (isNoSpaceError(e)) throw e;
      exportInfo = { ...exportInfo, status: e?.code === 'export_too_large' ? 'too_large' : 'failed' };
    }
    await yieldToLoop();

    await renameWithRetry(partialDb, finalDb, { fsOps });
    if (exportInfo.file) await renameWithRetry(partialZip, finalZip, { fsOps });
    const meta = {
      format: 'burrow-backup',
      formatVersion: 1,
      id,
      kind,
      createdAt,
      appVersion: getAppVersion(),
      schemaVersion: inspected.schemaVersion,
      status: 'verified',
      error: null,
      db: { file: `burrow-${id}.db`, bytes: dbBytes, sha256: dbSha },
      export: exportInfo,
      rowCounts: inspected.rowCounts,
      totalRows: inspected.totalRows,
      fingerprint: inspected.fingerprint,
      verifiedAt: createdAt,
    };
    await writeMeta(meta, dir, fsOps);
    metaWritten = true;

    // A restore's safety copy is not a success of the schedule: it must not mark the day as backed up.
    if (kind !== 'safety') {
      await writeState(
        {
          lastRunAt: createdAt,
          lastResult: 'created',
          lastError: null,
          lastSuccessAt: createdAt,
          confirmedId: id,
          diskWarning: space.warn,
          freeBytes: space.free,
        },
        { dir, fsOps },
      );
    }
    try {
      await yieldToLoop();
      await applyRetention({ dir, now, fsOps, protectIds: [id] });
      await cleanupOrphans({ dir, now, fsOps });
    } catch {
      // housekeeping must never fail a finished backup
    }
    await recordAudit({
      kind: 'export',
      feature: 'backup_create',
      status: 'ok',
      meta: {
        backup_kind: kind,
        tables: Object.keys(inspected.rowCounts).length,
        rows: inspected.totalRows,
        bytes: dbBytes + exportInfo.bytes,
      },
    });
    return { created: true, meta };
  } catch (e) {
    await removeQuiet(
      metaWritten
        ? [...partialFiles(partialDb), partialZip]
        : [...partialFiles(partialDb), partialZip, finalDb, finalZip],
      fsOps,
    );
    if (isBackupError(e) && (e.code === 'backup_busy' || e.code === 'db_restoring')) throw e;
    const code = classifyFailure(e);
    if (!metaWritten && dirChecked) {
      await recordFailure({ id, kind, createdAt, code, free: space.free, warn: space.warn, dir, fsOps });
    }
    if (dirChecked) {
      try {
        await applyRetention({ dir, now, fsOps, protectIds: metaWritten ? [id] : [] });
      } catch {
        // housekeeping must never change the error the caller sees
      }
    }
    if (code === 'disk_low' || code === 'disk_full') throw new BackupError(code, { cause: e });
    throw new BackupError('backup_failed', { cause: e });
  } finally {
    release?.();
  }
}

/**
 * The scheduled run: an automatic backup that never throws. Does nothing when the user has turned
 * automatic backups off (the backup.auto switch).
 * @param {{ now?: Date | (() => Date), fsOps?: import('./fsops.js').FsOps, dir?: string }} [opts]
 * @returns {Promise<{ ok: boolean, created?: boolean, code?: string, skipped?: 'auto_off' }>}
 */
export async function runScheduledBackup(opts = {}) {
  try {
    if (!(await getAutoBackup()).enabled) return { ok: true, created: false, skipped: 'auto_off' };
    const result = await createBackup({ ...opts, kind: 'auto' });
    return { ok: true, created: result.created };
  } catch (e) {
    console.error('Scheduled backup failed:', e?.code || 'unknown');
    return { ok: false, code: e?.code || 'backup_failed' };
  }
}

/**
 * Due when there is no success yet or the last one is at least 24 hours old, and the last failure
 * is more than 6 hours old.
 * @param {{ state: object, metas: object[], now: Date }} input
 */
export function isBackupDue({ state, metas, now }) {
  // Scheduling ignores safety copies. After a restore (lastSuccessAt cleared, lastRestore set) older
  // backups hold the previous data, so only a new success counts and the next tick makes a backup.
  const newestScheduled = metas.find((m) => m.status === 'verified' && m.kind !== 'safety');
  const fromMetas = state.lastRestore ? null : (newestScheduled?.verifiedAt ?? newestScheduled?.createdAt ?? null);
  const lastSuccessAt = state.lastSuccessAt ?? fromMetas;
  const nowMs = now.getTime();
  const lastFailure = Date.parse(state.lastFailureAt ?? '');
  // A failure dated in the future (clock moved back) must not hold backups off.
  if (Number.isFinite(lastFailure) && nowMs - lastFailure >= 0 && nowMs - lastFailure <= RETRY_AFTER_FAILURE_MS) return false;
  const lastSuccess = Date.parse(lastSuccessAt ?? '');
  // A success dated well past now (clock moved back) counts as missing; a few minutes of skew is fine.
  if (Number.isFinite(lastSuccess) && lastSuccess - nowMs > FUTURE_SKEW_MS) return true;
  return !Number.isFinite(lastSuccess) || nowMs - lastSuccess >= DAY_MS;
}

export const POKE_DELAY_MS = 5_000;

/** @type {{ timer: ReturnType<typeof setTimeout> | null, running: boolean, again: boolean, arm: (ms: number) => void } | null} */
let scheduler = null;

/**
 * Brings the next scheduler check forward (used when automatic backups are switched back on, so a
 * due backup does not wait up to an hour). No-op when the scheduler is not running. A check that is
 * already in progress is followed by a quick second check instead of being interrupted.
 * @param {number} [delayMs]
 */
export function pokeBackupScheduler(delayMs = POKE_DELAY_MS) {
  if (!scheduler) return;
  if (scheduler.running) {
    scheduler.again = true;
    return;
  }
  if (scheduler.timer) clearTimeout(scheduler.timer);
  scheduler.arm(delayMs);
}

/**
 * Starts the daily backup scheduler: first check after startupDelayMs (catch-up after a closed
 * app), then every tickMs. Timers are unref'd. A second call while running is a no-op.
 * @param {{
 *   now?: Date | (() => Date),
 *   run?: (opts: { now?: Date | (() => Date), fsOps?: import('./fsops.js').FsOps }) => Promise<unknown>,
 *   startupDelayMs?: number,
 *   tickMs?: number,
 *   dir?: string,
 *   fsOps?: import('./fsops.js').FsOps,
 * }} [opts]
 * @returns {boolean} true when this call started it
 */
export function startBackupScheduler({
  now,
  run = runScheduledBackup,
  startupDelayMs = STARTUP_DELAY_MS,
  tickMs = TICK_MS,
  dir,
  fsOps,
} = {}) {
  if (scheduler) return false;
  const self = { timer: null, running: false, again: false, arm: () => {} };
  scheduler = self;
  const arm = (ms) => {
    self.timer = setTimeout(tick, Math.max(ms, 0));
    self.timer.unref?.();
  };
  self.arm = arm;
  async function tick() {
    self.running = true;
    try {
      const where = dir ?? backupsDir();
      const ops = fsOps ?? createFsOps();
      ensureBackupsDir(where);
      await flushRecoveryAudit({ dir: where, fsOps: ops });
      // The user's switch: when off, no automatic backup (the check itself still runs, so it takes
      // effect on the next tick after the switch is turned back on).
      if (!(await getAutoBackup()).enabled) return;
      const [state, metas] = await Promise.all([readState(where, ops), listMetas(where, ops)]);
      if (isBackupDue({ state, metas, now: resolveNow(now) })) await run({ now, fsOps, ...(dir ? { dir } : {}) });
    } catch (e) {
      console.error('Backup check failed:', e?.code || 'unknown');
    } finally {
      self.running = false;
      const quick = self.again;
      self.again = false;
      if (scheduler === self) arm(quick ? POKE_DELAY_MS : tickMs);
    }
  }
  arm(startupDelayMs);
  (async () => {
    try {
      await flushRecoveryAudit({ dir: dir ?? backupsDir(), fsOps: fsOps ?? createFsOps() });
    } catch {
      // retried on the first tick
    }
  })();
  return true;
}

export function stopBackupScheduler() {
  if (!scheduler) return;
  if (scheduler.timer) clearTimeout(scheduler.timer);
  scheduler = null;
}

export const isBackupSchedulerRunning = () => scheduler !== null;
