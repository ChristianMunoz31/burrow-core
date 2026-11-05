// Backup file layout. Everything lives in <data dir>/backups; ids are validated against a strict
// pattern before they ever touch a path.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveDbPath } from '../db/index.js';
import { BackupError } from './errors.js';

export const ID_RE = /^\d{8}T\d{6}Z-(auto|manual|safety)-[0-9a-f]{6}$/;
export const UPLOAD_TOKEN_RE = /^[0-9a-f]{32}$/;
export const BACKUP_KINDS = Object.freeze(['auto', 'manual', 'safety']);
export const BACKUP_EXTS = Object.freeze(['.db', '.export.zip', '.meta.json']);

/** Data directory: the folder that holds burrow.db. */
export const dataDirOf = () => path.dirname(resolveDbPath());

/** @param {string} [dataDir] */
export const backupsDir = (dataDir = dataDirOf()) => path.join(dataDir, 'backups');

/**
 * Creates the backups directory (0700) and refuses a symlink or junction in its place.
 * @param {string} [dir]
 * @returns {string}
 */
export function ensureBackupsDir(dir = backupsDir()) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new BackupError('backup_failed');
  // A link anywhere in the path (junction, symlinked folder) would make realpath differ from the
  // real parent folder plus the folder name.
  const real = fs.realpathSync(dir);
  const expected = path.join(fs.realpathSync(path.dirname(dir)), path.basename(dir));
  const same = process.platform === 'win32' ? real.toLowerCase() === expected.toLowerCase() : real === expected;
  if (!same) throw new BackupError('backup_failed');
  return dir;
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * `<YYYYMMDDTHHmmssZ>-<kind>-<6 hex>` (UTC).
 * @param {'auto'|'manual'|'safety'} kind
 * @param {Date} [now]
 * @param {() => string} [rand] returns 6 lowercase hex characters
 * @returns {string}
 */
export function newBackupId(kind, now = new Date(), rand = () => crypto.randomBytes(3).toString('hex')) {
  if (!BACKUP_KINDS.includes(kind)) throw new BackupError('invalid_request');
  const stamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  return `${stamp}-${kind}-${rand()}`;
}

/** Base path (no extension) for a backup id inside dir. The caller must have validated the id. */
export const backupBase = (id, dir = backupsDir()) => path.join(dir, `burrow-${id}`);

/**
 * Resolves a backup file by id and extension. Throws backup_not_found when the id is malformed,
 * the resolved path escapes the directory, or the target is not a regular (non-symlink) file.
 * @param {string} id
 * @param {'.db'|'.export.zip'|'.meta.json'} ext
 * @param {string} [dir]
 * @returns {string}
 */
export function resolveBackupFile(id, ext, dir = backupsDir()) {
  if (typeof id !== 'string' || !ID_RE.test(id) || !BACKUP_EXTS.includes(ext)) throw new BackupError('backup_not_found');
  const root = path.resolve(dir);
  const file = path.join(root, `burrow-${id}${ext}`);
  if (path.dirname(file) !== root) throw new BackupError('backup_not_found');
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    throw new BackupError('backup_not_found');
  }
  if (st.isSymbolicLink() || !st.isFile()) throw new BackupError('backup_not_found');
  return file;
}
