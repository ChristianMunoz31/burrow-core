// Filesystem seam for the backup code. Every disk operation goes through one of these so tests can
// inject disk-full errors, Windows EBUSY locks and a kill in the middle of a restore.
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * @typedef {object} FsOps
 * @property {typeof fsp.rename} rename
 * @property {typeof fsp.copyFile} copyFile
 * @property {typeof fsp.rm} rm
 * @property {typeof fsp.statfs} statfs
 * @property {typeof fsp.open} open
 * @property {typeof fsp.writeFile} writeFile
 * @property {typeof fsp.readFile} readFile
 * @property {typeof fsp.readdir} readdir
 * @property {typeof fsp.lstat} lstat
 * @property {typeof fsp.realpath} realpath
 * @property {typeof fsp.mkdir} mkdir
 * @property {(ms: number) => Promise<void>} sleep
 */

/**
 * @param {Partial<FsOps>} [overrides]
 * @returns {FsOps}
 */
export function createFsOps(overrides = {}) {
  return {
    rename: fsp.rename,
    copyFile: fsp.copyFile,
    rm: fsp.rm,
    statfs: fsp.statfs,
    open: fsp.open,
    writeFile: fsp.writeFile,
    readFile: fsp.readFile,
    readdir: fsp.readdir,
    lstat: fsp.lstat,
    realpath: fsp.realpath,
    mkdir: fsp.mkdir,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ...overrides,
  };
}

/** @param {unknown} e */
export const isMissing = (e) => /** @type {{ code?: unknown }} */ (e)?.code === 'ENOENT';

/**
 * Rename that retries only EPERM, EBUSY and EACCES (antivirus and indexers hold files briefly on
 * Windows), waiting 50 ms, 100 ms ... up to 1600 ms between attempts.
 * @param {string} from
 * @param {string} to
 * @param {{ fsOps?: FsOps, attempts?: number, baseMs?: number }} [opts]
 */
export async function renameWithRetry(from, to, { fsOps = createFsOps(), attempts = 7, baseMs = 50 } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      await fsOps.rename(from, to);
      return;
    } catch (e) {
      lastError = e;
      const code = /** @type {{ code?: string }} */ (e)?.code;
      if (!code || !RETRY_CODES.has(code) || i === attempts - 1) throw e;
      await fsOps.sleep(Math.min(baseMs * 2 ** i, 1600));
    }
  }
  throw lastError;
}

/**
 * Removes a path, retrying the Windows lock errors. A missing path is not an error.
 * @param {string} target
 * @param {{ fsOps?: FsOps, recursive?: boolean, attempts?: number }} [opts]
 */
export async function rmWithRetry(target, { fsOps = createFsOps(), recursive = false, attempts = 5 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await fsOps.rm(target, { force: true, recursive });
      return;
    } catch (e) {
      const code = /** @type {{ code?: string }} */ (e)?.code;
      if (!code || !RETRY_CODES.has(code) || i === attempts - 1) throw e;
      await fsOps.sleep(Math.min(50 * 2 ** i, 1600));
    }
  }
}

/**
 * Writes bytes to a new file (mode 0600, never overwrites) and fsyncs it.
 * @param {string} file
 * @param {Uint8Array | string} data
 * @param {FsOps} fsOps
 */
export async function writeFileSynced(file, data, fsOps) {
  const handle = await fsOps.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Atomic JSON write: temp file (wx, 0600), fsync, rename over the target.
 * @param {string} file
 * @param {unknown} obj
 * @param {FsOps} [fsOps]
 */
export async function writeJsonAtomic(file, obj, fsOps = createFsOps()) {
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFileSynced(tmp, `${JSON.stringify(obj, null, 2)}\n`, fsOps);
    await renameWithRetry(tmp, file, { fsOps });
  } catch (e) {
    await fsOps.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/**
 * Reads and parses a JSON file; null when missing or not valid JSON.
 * @param {string} file
 * @param {FsOps} [fsOps]
 * @returns {Promise<unknown | null>}
 */
export async function readJsonOrNull(file, fsOps = createFsOps()) {
  try {
    return JSON.parse(await fsOps.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {string} file
 * @param {FsOps} [fsOps]
 */
export async function exists(file, fsOps = createFsOps()) {
  try {
    await fsOps.lstat(file);
    return true;
  } catch (e) {
    if (isMissing(e)) return false;
    throw e;
  }
}
