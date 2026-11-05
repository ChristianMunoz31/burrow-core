// Decides whether a folder the user typed may be added: an absolute path to a real folder on this computer that
// is not a link, not a drive root, not the user's home (or above it), not a system or app folder and not one of
// Burrow's own data folders. Reads metadata only (lstat, realpath, opendir); never writes anything.
import fs from 'node:fs';
import os from 'node:os';
import { canonical, foldPath, isSameOrInside, pathModuleFor, pathsOverlap } from '../pathGuard.js';
import { appDataFolderDir, resolveDataDir, stableDefaultDataDirs } from '../paths.js';
import { LIMITS } from './constants.js';

let testOverride = null;

/**
 * Test seam: options merged under the explicit ones of every validateFolderRoot call (for example a fake `env`
 * and `home`, so temp-dir fixtures are not "inside AppData"). Pass null to clear. Refuses to run outside Vitest.
 * @param {object | null} opts
 */
export function __setPathOptionsForTests(opts) {
  if (!process.env.VITEST) throw new Error('__setPathOptionsForTests is a test seam');
  testOverride = opts;
}

/** realpath with the native resolver (async). */
export const nativeRealpath = (p) =>
  new Promise((resolve, reject) => {
    fs.realpath.native(p, (err, real) => (err ? reject(err) : resolve(real)));
  });

/** @param {string} p @param {typeof path.posix} mod */
function stripTrailingSep(p, mod) {
  const root = mod.parse(p).root;
  let out = p;
  while (out.length > root.length && /[\\/]$/.test(out)) out = out.slice(0, -1);
  return out;
}

const keyOf = (p, platform, mod) => foldPath(stripTrailingSep(canonical(p, mod, platform), mod), platform);

/** The system drive letter ("C:") from SystemDrive, else SystemRoot, else C:. */
function systemDrive(env) {
  for (const key of ['SystemDrive', 'SystemRoot', 'windir']) {
    const m = /^([A-Za-z]):/.exec(typeof env[key] === 'string' ? env[key].trim() : '');
    if (m) return `${m[1].toUpperCase()}:`;
  }
  return 'C:';
}

/**
 * Folders Burrow never reads (system and app folders), for the platform.
 * @param {{ env?: Record<string, string | undefined>, platform?: NodeJS.Platform, home?: string, execDir?: string }} [opts]
 * @returns {string[]}
 */
export function protectedRoots({ env = process.env, platform = process.platform, home = os.homedir(), execDir } = {}) {
  const mod = pathModuleFor(platform);
  const list = [];
  if (platform === 'win32') {
    // The desktop sidecar passes only SystemRoot, APPDATA, LOCALAPPDATA and USERPROFILE, so the well-known system
    // folders of the system drive are always listed, and the environment values are added when present.
    const drive = systemDrive(env);
    for (const sub of ['Windows', 'Program Files', 'Program Files (x86)', 'ProgramData', 'Windows.old']) list.push(`${drive}\\${sub}`);
    for (const key of ['SystemRoot', 'windir', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'APPDATA', 'LOCALAPPDATA']) {
      const v = env[key];
      if (typeof v === 'string' && v.trim()) list.push(v.trim());
    }
    if (home) list.push(mod.join(home, 'AppData'));
  } else if (platform === 'darwin') {
    list.push('/System', '/Library', '/Applications', '/usr', '/bin', '/sbin', '/etc', '/var', '/private', '/opt');
    if (home) list.push(mod.join(home, 'Library'));
  } else {
    list.push('/usr', '/bin', '/sbin', '/etc', '/var', '/proc', '/sys', '/dev', '/boot', '/run', '/opt');
    if (home) list.push(mod.join(home, '.config'), mod.join(home, '.local'));
  }
  const exec = execDir ?? (typeof process.execPath === 'string' ? mod.dirname(process.execPath) : '');
  if (exec) list.push(exec);
  return list;
}

/**
 * True when `absReal` (a real path) is the root or lies inside it.
 * @param {string} rootKey Folded, canonical root (the `pathKey`).
 * @param {string} absReal
 * @param {NodeJS.Platform} [platform]
 * @returns {boolean}
 */
export function isInsideRoot(rootKey, absReal, platform = process.platform) {
  const mod = pathModuleFor(platform);
  return isSameOrInside(rootKey, foldPath(stripTrailingSep(absReal, mod), platform), mod);
}

/**
 * Whether a real path lies inside a OneDrive sync root named by the environment.
 * @param {string} real
 * @param {Record<string, string | undefined>} [env]
 * @param {NodeJS.Platform} [platform]
 * @returns {boolean}
 */
export function isOneDrivePath(real, env = process.env, platform = process.platform) {
  const mod = pathModuleFor(platform);
  const target = keyOf(real, platform, mod);
  for (const key of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
    const v = env[key];
    if (typeof v !== 'string' || !v.trim()) continue;
    if (isSameOrInside(keyOf(v.trim(), platform, mod), target, mod)) return true;
  }
  return false;
}

let oneDriveCache = { sig: '', keys: [] };

/**
 * Folded canonical keys of the OneDrive sync roots named by the environment. The roots are resolved once and
 * reused until the environment values change, so listing folders makes no file system call per request.
 * @param {Record<string, string | undefined>} [env]
 * @param {NodeJS.Platform} [platform]
 * @returns {string[]}
 */
export function oneDriveRootKeys(env = process.env, platform = process.platform) {
  const values = ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial'].map((k) => (typeof env[k] === 'string' ? env[k].trim() : ''));
  const sig = `${platform}|${values.join('|')}`;
  if (env === process.env && oneDriveCache.sig === sig) return oneDriveCache.keys;
  const mod = pathModuleFor(platform);
  const keys = values.filter((v) => v !== '').map((v) => keyOf(v, platform, mod));
  if (env === process.env) oneDriveCache = { sig, keys };
  return keys;
}

/**
 * Whether a stored folder path key (already real and folded) lies inside one of the OneDrive root keys.
 * @param {string} pathKey
 * @param {string[]} rootKeys
 * @param {NodeJS.Platform} [platform]
 * @returns {boolean}
 */
export function isUnderRootKeys(pathKey, rootKeys, platform = process.platform) {
  const mod = pathModuleFor(platform);
  return typeof pathKey === 'string' && rootKeys.some((k) => isSameOrInside(k, pathKey, mod));
}

/**
 * Duplicate, overlap and folder-limit check against the folders already stored. Pure and synchronous, so a route can
 * run it again right before the insert, after every await.
 * @param {string} pathKey
 * @param {Array<string | { pathKey: string }>} existing
 * @param {{ maxFolders?: number, platform?: NodeJS.Platform, total?: number }} [opts] `total` is how many folders count
 *   against the cap (default: the number of keys); a folder waiting for confirmation counts there but has no real path to compare
 * @returns {'folder_exists' | 'folder_overlaps' | 'folder_limit' | null}
 */
export function folderConflict(pathKey, existing, { maxFolders = LIMITS.maxFolders, platform = process.platform, total } = {}) {
  const mod = pathModuleFor(platform);
  const keys = existing.map((e) => (typeof e === 'string' ? e : e?.pathKey)).filter((k) => typeof k === 'string');
  if (keys.includes(pathKey)) return 'folder_exists';
  if (keys.some((k) => isSameOrInside(k, pathKey, mod) || isSameOrInside(pathKey, k, mod))) return 'folder_overlaps';
  if ((total ?? keys.length) >= maxFolders) return 'folder_limit';
  return null;
}

const fail = (code) => ({ ok: false, code });

function stripQuotes(raw) {
  let s = raw.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1).trim();
  return s;
}

/**
 * Check a typed folder path. Async because the last step opens the folder for listing.
 * @param {unknown} input
 * @param {{ env?: Record<string, string | undefined>, platform?: NodeJS.Platform, home?: string, dataDirs?: string[],
 *   execDir?: string, existing?: Array<string | { pathKey: string }>, maxFolders?: number, total?: number }} [opts]
 * @returns {Promise<{ ok: true, path: string, realPath: string, pathKey: string, name: string, warnings: string[] } | { ok: false, code: string }>}
 */
export async function validateFolderRoot(input, opts = {}) {
  const merged = { ...(testOverride ?? {}), ...opts };
  const {
    env = process.env,
    platform = process.platform,
    home = os.homedir(),
    execDir,
    existing = [],
    maxFolders = LIMITS.maxFolders,
    total,
    realpath = nativeRealpath,
  } = merged;
  const mod = pathModuleFor(platform);

  // 1. A string, trimmed, quotes stripped, a sane length, no NUL, absolute.
  if (typeof input !== 'string') return fail('folder_path_invalid');
  const typed = stripQuotes(input);
  if (typed === '' || typed.length > LIMITS.maxPathChars || typed.includes('\0')) return fail('folder_path_invalid');
  // 2. Network paths on Windows (UNC, \\?\ and \\.\ forms, with either slash).
  if (platform === 'win32' && /^[\\/]{2}/.test(typed)) return fail('folder_network_path');
  if (platform === 'win32' ? !/^[A-Za-z]:[\\/]/.test(typed) : !typed.startsWith('/')) return fail('folder_path_invalid');
  const resolved = mod.resolve(typed);

  // 3. Must exist, be a real folder and not be a link.
  let st;
  try {
    st = await fs.promises.lstat(resolved);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return fail('folder_missing');
    if (err?.code === 'EACCES' || err?.code === 'EPERM') return fail('folder_unreadable');
    return fail('folder_unreadable');
  }
  if (st.isSymbolicLink()) return fail('folder_is_link');
  if (!st.isDirectory()) return fail('folder_not_directory');

  // 4. Real location and the key every comparison uses.
  let realPath;
  try {
    realPath = await realpath(resolved);
  } catch {
    return fail('folder_unreadable');
  }
  // A mapped drive or a subst letter can resolve to a network share: refuse it like a typed UNC path.
  if (platform === 'win32' && /^[\\/]{2}/.test(realPath)) return fail('folder_network_path');
  realPath = stripTrailingSep(realPath, mod);
  const pathKey = foldPath(realPath, platform);

  // 5. Not a drive or file system root, and not home or any folder above it.
  const rootOf = mod.parse(realPath).root;
  if (foldPath(stripTrailingSep(rootOf, mod), platform) === pathKey || foldPath(rootOf, platform) === pathKey) return fail('folder_too_broad');
  if (home && isSameOrInside(pathKey, keyOf(home, platform, mod), mod)) return fail('folder_too_broad');

  // Nothing hidden below home (.ssh, .aws, .config and the like): a segment starting with a dot is refused.
  if (home) {
    const homeKey = keyOf(home, platform, mod);
    if (isSameOrInside(homeKey, pathKey, mod) && mod.relative(homeKey, pathKey).split(mod.sep).some((seg) => seg.startsWith('.'))) {
      return fail('folder_hidden');
    }
  }

  // 6. Not Burrow's own data.
  const dataDirs =
    merged.dataDirs ??
    [resolveDataDir(), ...stableDefaultDataDirs(), appDataFolderDir({ channel: 'dev' })].filter((d) => typeof d === 'string' && d !== '');
  for (const dir of dataDirs) {
    if (pathsOverlap(realPath, dir, { platform })) return fail('folder_burrow_data');
  }

  // 7. Not a system or app folder.
  for (const root of protectedRoots({ env, platform, home, execDir })) {
    if (isSameOrInside(keyOf(root, platform, mod), pathKey, mod)) return fail('folder_protected');
  }

  // 8. Must be listable.
  try {
    const dir = await fs.promises.opendir(realPath);
    await dir.close();
  } catch {
    return fail('folder_unreadable');
  }

  // 9. Duplicates, nesting in either direction, and the cap.
  const conflict = folderConflict(pathKey, existing, { maxFolders, platform, total });
  if (conflict) return fail(conflict);

  // 10. Name and warnings.
  const base = mod.basename(realPath) || realPath;
  const warnings = isOneDrivePath(realPath, env, platform) ? ['onedrive'] : [];
  return { ok: true, path: resolved, realPath, pathKey, name: base.slice(0, 120), warnings };
}
