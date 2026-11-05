// One-way "Copy my data from Burrow" for the Dev channel. The stable Burrow's data folder is only ever
// READ, and only with plain read-only file handles that share everything: nothing is written, created,
// renamed or locked there, whether stable is running or not, and SQLite never opens a stable file (even a
// read-only SQLite connection creates -wal and -shm files, or writes read marks into them).
//
// Flow: copy burrow.db (+ -wal, -journal when present, never -shm) into a private folder inside the Dev
// backups folder, check by stat that stable did not change meanwhile (retry otherwise), let SQLite settle
// the copy there (WAL recovery / hot journal), take a normalized VACUUM INTO snapshot of it (saved keys
// emptied), hand that to the existing restore flow (safety backup, carried settings,
// journaled swap). Everything fails closed: Dev data is replaced only by a fully verified copy.
import crypto from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RESTORE_JOURNAL_FILENAME, DB_FILENAME } from '../db/index.js';
import { resolveStableDataDir } from '../paths.js';
import { foldPath, isSameOrInside } from '../pathGuard.js';
import { BackupError, isBackupError, isNoSpaceError } from './errors.js';
import { createFsOps, isMissing, rmWithRetry } from './fsops.js';
import { busyError, tryAcquire } from './lock.js';
import { backupsDir, dataDirOf, ensureBackupsDir } from './paths.js';
import { adoptIncomingFile, discardPendingUpload, restoreBackup } from './restore.js';
import { DISK_FLOOR_BYTES, STABLE_COPY_DIR_PREFIX } from './service.js';
import { inspectDbFile, latestSchemaVersion, normalizeSnapshot, sha256File, takeSnapshot } from './snapshot.js';
import { canFallBackToMainThread, runBackupOp } from './worker/client.js';

export { STABLE_COPY_DIR_PREFIX };
export const STABLE_COPY_ATTEMPTS = 5;
export const STABLE_COPY_RETRY_MS = 250;

const COPY_NAMES = Object.freeze([DB_FILENAME, `${DB_FILENAME}-wal`, `${DB_FILENAME}-journal`]);
const SIDE_FILE_SUFFIXES = Object.freeze(['', '-journal', '-wal', '-shm']);
const CHUNK_BYTES = 1024 * 1024;
const DISK_FACTOR = 3;

// SQLite's own sizes: the WAL header is 32 bytes; the wal-index (-shm) header is two 48-byte copies plus the
// 40-byte checkpoint info (nBackfill, read marks, lock bytes, nBackfillAttempted).
const WAL_HEADER_BYTES = 32;
const SHM_HEADER_BYTES = 136;
const UNREADABLE = 'unreadable';

/**
 * Real location of `dir`: the deepest existing ancestor goes through realpath (symlinks, junctions, 8.3
 * names) and the missing tail is appended.
 */
async function realOrResolved(dir, fsOps) {
  const tail = [];
  let current = path.resolve(dir);
  for (;;) {
    try {
      const real = await fsOps.realpath(current);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(dir);
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

function isInside(parent, child) {
  return isSameOrInside(foldPath(parent), foldPath(child), path);
}

/** True when both folders are the same, or one contains the other (case-folded on Windows and macOS). */
export async function foldersOverlap(a, b, fsOps) {
  const [ra, rb] = await Promise.all([realOrResolved(a, fsOps), realOrResolved(b, fsOps)]);
  return isInside(ra, rb) || isInside(rb, ra);
}

/** The stable folder against the Dev data folder and the Dev backups folder (which may be a link elsewhere). */
async function overlapsDevFolders(stableDir, dataDir, fsOps) {
  return (await foldersOverlap(stableDir, dataDir, fsOps)) || (await foldersOverlap(stableDir, backupsDir(dataDir), fsOps));
}

export async function statOrNull(file, fsOps) {
  try {
    return await fsOps.lstat(file);
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
}

/**
 * The first `length` bytes of a file as hex, read through a plain read-only handle (never SQLite, never a
 * write). null when the file is absent; 'unreadable' when it cannot be read right now (for example a byte
 * range stable holds locked on Windows), which compares equal to itself and so never blocks a copy alone.
 */
async function readHeader(file, length, fsOps) {
  let handle;
  try {
    handle = await fsOps.open(file, 'r');
  } catch (e) {
    return isMissing(e) ? null : UNREADABLE;
  }
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, 0);
    return buf.subarray(0, bytesRead).toString('hex');
  } catch {
    return UNREADABLE;
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * {exists,size,mtimeMs,ino} of the three copied names, the WAL header and the -shm wal-index header, plus
 * whether a restore journal is present. A WAL reset or a checkpoint that rewrites the headers without
 * changing a size shows up here even when the stat values look the same.
 */
async function signature(stableDir, fsOps) {
  const files = {};
  for (const name of COPY_NAMES) {
    const st = await statOrNull(path.join(stableDir, name), fsOps);
    files[name] = st ? { exists: true, size: st.size, mtimeMs: st.mtimeMs, ino: String(st.ino) } : { exists: false };
  }
  const headers = {
    wal: await readHeader(path.join(stableDir, `${DB_FILENAME}-wal`), WAL_HEADER_BYTES, fsOps),
    shm: await readHeader(path.join(stableDir, `${DB_FILENAME}-shm`), SHM_HEADER_BYTES, fsOps),
  };
  const journal = await statOrNull(path.join(stableDir, RESTORE_JOURNAL_FILENAME), fsOps);
  return { files, headers, journal: journal !== null };
}

const sameSignature = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * What the Settings screen shows before the user decides. Stat only: never opens a database.
 * @param {{ stable?: { dir: string, overridden: boolean }, dataDir?: string, fsOps?: import('./fsops.js').FsOps }} [opts]
 * @returns {Promise<{ found: boolean, dataDir: string, overridden: boolean, lastChangedAt: string | null,
 *   busy: boolean, sameFolder: boolean }>}
 */
export async function getStableCopyStatus({
  stable = resolveStableDataDir(),
  dataDir = dataDirOf(),
  fsOps = createFsOps(),
} = {}) {
  const sameFolder = await overlapsDevFolders(stable.dir, dataDir, fsOps).catch(() => false);
  const db = await statOrNull(path.join(stable.dir, DB_FILENAME), fsOps).catch(() => null);
  const found = db !== null && db.isFile();
  let lastChangedAt = null;
  if (found) {
    const wal = await statOrNull(path.join(stable.dir, `${DB_FILENAME}-wal`), fsOps).catch(() => null);
    const latest = Math.max(db.mtimeMs, wal ? wal.mtimeMs : 0);
    lastChangedAt = Number.isFinite(latest) ? new Date(latest).toISOString() : null;
  }
  const journal = await statOrNull(path.join(stable.dir, RESTORE_JOURNAL_FILENAME), fsOps).catch(() => null);
  return {
    found,
    dataDir: stable.dir,
    overridden: stable.overridden,
    lastChangedAt,
    busy: journal !== null,
    sameFolder,
  };
}

/**
 * Streams one file with a read-only handle (never fs.copyFile: it must not block stable's writers).
 * @returns {Promise<string>} the sha-256 (hex) of the bytes that were read from the source
 */
export async function copyOne(from, to, fsOps) {
  const hash = crypto.createHash('sha256');
  const src = await fsOps.open(from, 'r');
  try {
    const dst = await fsOps.open(to, 'wx', 0o600);
    try {
      const buf = Buffer.alloc(CHUNK_BYTES);
      for (;;) {
        const { bytesRead } = await src.read(buf, 0, buf.length, null);
        if (bytesRead === 0) break;
        hash.update(buf.subarray(0, bytesRead));
        let offset = 0;
        while (offset < bytesRead) {
          const { bytesWritten } = await dst.write(buf, offset, bytesRead - offset, null);
          offset += bytesWritten;
        }
      }
      await dst.sync();
    } finally {
      await dst.close();
    }
  } finally {
    await src.close();
  }
  return hash.digest('hex');
}

export async function wipeDir(dir, fsOps) {
  await rmWithRetry(dir, { fsOps, recursive: true });
}

/** Only plain files are copied: a link in place of burrow.db, -wal or -journal could point anywhere. */
async function assertPlainFiles(stableDir, fsOps) {
  for (const name of COPY_NAMES) {
    const st = await statOrNull(path.join(stableDir, name), fsOps);
    if (st && (st.isSymbolicLink() || !st.isFile())) throw new BackupError('stable_invalid');
  }
}

/**
 * Copies the stable database files into `copyDir` and proves stable did not change while doing so: the file signatures
 * (sizes, times, WAL and wal-index headers) are the same before and after, and the sha-256 of every copied file, taken
 * while streaming it, equals a second read of the source after the "after" signature (one extra read, so a change that
 * keeps size and time still forces a retry).
 * @returns {Promise<boolean>} false when stable changed or a file vanished mid-copy (retry)
 */
export async function copyAttempt({ stableDir, copyDir, attempt, fsOps, hooks }) {
  const before = await signature(stableDir, fsOps);
  if (before.journal) throw new BackupError('stable_busy');
  if (!before.files[DB_FILENAME].exists) return false;
  await assertPlainFiles(stableDir, fsOps);
  await wipeDir(copyDir, fsOps);
  await fsOps.mkdir(copyDir, { recursive: true, mode: 0o700 });
  const copiedHashes = {};
  try {
    for (const name of COPY_NAMES) {
      if (before.files[name].exists) copiedHashes[name] = await copyOne(path.join(stableDir, name), path.join(copyDir, name), fsOps);
    }
  } catch (e) {
    if (isNoSpaceError(e)) throw new BackupError('disk_full', { cause: e });
    // A locked byte range or a file that vanished: stable is busy; the caller retries.
    return false;
  }
  await hooks?.afterCopy?.(attempt);
  const after = await signature(stableDir, fsOps);
  if (after.journal || !sameSignature(before, after)) return false;
  try {
    for (const [name, copied] of Object.entries(copiedHashes)) {
      if ((await sha256File(path.join(stableDir, name), fsOps)) !== copied) return false;
    }
  } catch {
    return false;
  }
  return true;
}

/** Opens the private copy read-write once so SQLite recovers its WAL or hot journal inside the Dev folder. */
export function settleCopy(file) {
  let db;
  try {
    db = new DatabaseSync(file);
    db.exec('PRAGMA trusted_schema = OFF');
    db.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get();
  } catch (e) {
    if (isNoSpaceError(e)) throw new BackupError('disk_full', { cause: e });
    throw new BackupError('stable_invalid', { cause: e });
  } finally {
    try {
      db?.close();
    } catch {
      // already closed
    }
  }
}

function snapshotOnMainThread(dbPath, partialPath, latestVersion) {
  const source = new DatabaseSync(dbPath, { readOnly: true });
  try {
    source.exec('PRAGMA trusted_schema = OFF');
    takeSnapshot(source, partialPath);
  } finally {
    source.close();
  }
  normalizeSnapshot(partialPath);
  return inspectDbFile(partialPath, { latestVersion });
}

/** takeSnapshot + normalizeSnapshot (saved keys emptied) + inspectDbFile on the settled copy. */
async function snapshotCopy(dbPath, partialPath) {
  const latestVersion = latestSchemaVersion();
  try {
    try {
      return await runBackupOp('snapshotInspect', { dbPath, partialPath, latestVersion });
    } catch (e) {
      if (!canFallBackToMainThread(e)) throw e;
      return snapshotOnMainThread(dbPath, partialPath, latestVersion);
    }
  } catch (e) {
    if (isBackupError(e)) throw e;
    if (isNoSpaceError(e)) throw new BackupError('disk_full', { cause: e });
    throw new BackupError('stable_invalid', { cause: e });
  }
}

async function removeIncoming(file, fsOps) {
  for (const suffix of SIDE_FILE_SUFFIXES) await rmWithRetry(`${file}${suffix}`, { fsOps }).catch(() => {});
}

function mapRestoreError(e) {
  if (isBackupError(e) && e.code === 'backup_too_new') return new BackupError('stable_too_new', { cause: e });
  if (isBackupError(e) && e.code === 'backup_invalid') return new BackupError('stable_invalid', { cause: e });
  return e;
}

/**
 * Replaces the Dev data with a verified copy of the stable Burrow data. The stable folder is never written.
 * @param {{ stable?: { dir: string, overridden: boolean }, dataDir?: string, fsOps?: import('./fsops.js').FsOps,
 *   now?: Date | (() => Date), attempts?: number, retryDelayMs?: number,
 *   hooks?: { afterCopy?: (attempt: number) => void | Promise<void> } }} [opts] hooks.afterCopy is a test seam
 * @returns {Promise<{ copiedFrom: string, safetyBackupId: string, schemaFrom: number, schemaTo: number, totalRows: number }>}
 */
export async function copyFromStable({
  stable = resolveStableDataDir(),
  dataDir = dataDirOf(),
  fsOps = createFsOps(),
  now,
  attempts = STABLE_COPY_ATTEMPTS,
  retryDelayMs = STABLE_COPY_RETRY_MS,
  hooks,
} = {}) {
  const stableDir = stable.dir;
  if (await overlapsDevFolders(stableDir, dataDir, fsOps)) throw new BackupError('stable_same_folder');
  const stableDb = await statOrNull(path.join(stableDir, DB_FILENAME), fsOps).catch(() => null);
  if (!stableDb || !stableDb.isFile()) throw new BackupError('stable_not_found');
  if (await statOrNull(path.join(stableDir, RESTORE_JOURNAL_FILENAME), fsOps).catch(() => null)) {
    throw new BackupError('stable_busy');
  }

  const release = tryAcquire('backup');
  if (!release) throw busyError();

  const backups = backupsDir(dataDir);
  const token = crypto.randomBytes(16).toString('hex');
  const copyDir = path.join(backups, `${STABLE_COPY_DIR_PREFIX}${crypto.randomBytes(8).toString('hex')}`);
  const incoming = path.join(backups, `.incoming-${token}.db`);
  let adopted = false;
  let lockHeld = true;
  const unlock = () => {
    if (lockHeld) release();
    lockHeld = false;
  };
  try {
    ensureBackupsDir(backups);

    // Disk check: the copy, its settled form and the snapshot, plus the usual floor.
    try {
      const sizes = await Promise.all(
        [DB_FILENAME, `${DB_FILENAME}-wal`].map(async (n) => (await statOrNull(path.join(stableDir, n), fsOps))?.size ?? 0),
      );
      const s = await fsOps.statfs(backups);
      const free = Number(s.bavail) * Number(s.bsize);
      if (Number.isFinite(free) && free - (sizes[0] + sizes[1]) * DISK_FACTOR < DISK_FLOOR_BYTES) {
        throw new BackupError('disk_low');
      }
    } catch (e) {
      if (isBackupError(e)) throw e;
    }

    let copied = false;
    for (let attempt = 1; attempt <= attempts && !copied; attempt += 1) {
      copied = await copyAttempt({ stableDir, copyDir, attempt, fsOps, hooks });
      if (!copied) {
        await wipeDir(copyDir, fsOps);
        // The database went away while we tried (stable removed or moved it): that is not "busy".
        if (!(await statOrNull(path.join(stableDir, DB_FILENAME), fsOps).catch(() => null))) {
          throw new BackupError('stable_not_found');
        }
        if (attempt < attempts) await fsOps.sleep(retryDelayMs);
      }
    }
    if (!copied) throw new BackupError('stable_busy');

    const copyDb = path.join(copyDir, DB_FILENAME);
    settleCopy(copyDb);
    const inspected = await snapshotCopy(copyDb, incoming);
    if (!inspected.integrityOk || inspected.schemaVersion === null) throw new BackupError('stable_invalid');
    if (inspected.schemaVersion > latestSchemaVersion()) throw new BackupError('stable_too_new');
    if (inspected.shapeOk !== true) throw new BackupError('stable_invalid');

    await wipeDir(copyDir, fsOps);
    try {
      await adoptIncomingFile(incoming, { token, fsOps, now });
      adopted = true;
    } catch (e) {
      throw mapRestoreError(e);
    }
    unlock();

    try {
      const restored = await restoreBackup({ uploadToken: token, origin: 'stable_copy', now, fsOps, dataDir, dir: backups });
      return {
        copiedFrom: stableDir,
        safetyBackupId: restored.safetyBackupId,
        schemaFrom: restored.schemaFrom,
        schemaTo: restored.schemaTo,
        totalRows: restored.totalRows,
      };
    } catch (e) {
      throw mapRestoreError(e);
    }
  } catch (e) {
    if (adopted) await discardPendingUpload(token, fsOps).catch(() => {});
    await removeIncoming(incoming, fsOps);
    throw e;
  } finally {
    unlock();
    await wipeDir(copyDir, fsOps).catch(() => {});
  }
}
