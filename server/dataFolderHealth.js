// Is the data folder somewhere a sync client can reach? A sync client that uploads or rewrites a live SQLite database
// (burrow.db plus -wal and -shm) can damage it. This module only looks at paths and the folder's own link status: it
// never reads or writes the data. Used at startup (one log line) and by GET /api/app/info, so Settings and Home can show
// one dismissible warning. It never blocks anything.
//
// Why %USERPROFILE%\Burrow Data is expected to be safe: OneDrive Known Folder Move redirects Desktop, Documents, Pictures,
// Screenshots and Camera Roll (Music and Videos are not affected), not arbitrary folders under the user profile
// (https://learn.microsoft.com/en-us/sharepoint/redirect-known-folders). A user can still put the whole profile or
// the folder under OneDrive, so the check below stays.
import fs from 'node:fs';
import { canonical, foldPath, isSameOrInside, pathModuleFor } from './pathGuard.js';

/** Environment variables the OneDrive sync app sets for its sync roots. */
export const ONEDRIVE_ENV_VARS = Object.freeze(['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']);

export const ONEDRIVE_WARNING = 'Your Burrow data folder is inside OneDrive. Syncing a live database can damage it.';
export const LINKED_WARNING = 'Your Burrow data folder is a linked folder, so another program may sync or move it. Syncing a live database can damage it.';

/**
 * @param {Record<string, string | undefined>} env
 * @returns {string[]} non-empty OneDrive sync roots from the environment, without duplicates
 */
export function oneDriveRoots(env) {
  const roots = [];
  for (const name of ONEDRIVE_ENV_VARS) {
    const value = (env[name] ?? '').trim();
    if (value && !roots.includes(value)) roots.push(value);
  }
  return roots;
}

/**
 * @param {string} dir the resolved data folder
 * @param {{ env?: Record<string, string | undefined>, platform?: NodeJS.Platform, lstat?: (p: string) => { isSymbolicLink: () => boolean } }} [opts]
 *   `lstat` is a test seam.
 * @returns {{ path: string, oneDrive: boolean, linked: boolean }}
 *   `oneDrive`: the folder, or its real location, lies under a OneDrive root. `linked`: the folder itself is a symbolic
 *   link or junction (a reparse point), or a folder above it is, so its real location differs from the path.
 */
export function inspectDataFolder(dir, { env = process.env, platform = process.platform, lstat = fs.lstatSync } = {}) {
  const mod = pathModuleFor(platform);
  const resolved = mod.resolve(dir);
  const real = canonical(resolved, mod, platform);
  const roots = oneDriveRoots(env).map((root) => foldPath(canonical(root, mod, platform), platform));
  const candidates = [foldPath(resolved, platform), foldPath(real, platform)];
  const oneDrive = roots.some((root) => candidates.some((candidate) => isSameOrInside(root, candidate, mod)));
  let linked = foldPath(real, platform) !== foldPath(resolved, platform);
  if (!linked) {
    try {
      linked = lstat(resolved).isSymbolicLink();
    } catch {
      // not created yet
    }
  }
  return { path: resolved, oneDrive, linked };
}

/**
 * @param {{ oneDrive: boolean, linked: boolean }} info
 * @returns {{ code: 'onedrive' | 'linked', message: string } | null} the warning to show once, or null
 */
export function dataFolderWarning(info) {
  if (info.oneDrive) return { code: 'onedrive', message: ONEDRIVE_WARNING };
  if (info.linked) return { code: 'linked', message: LINKED_WARNING };
  return null;
}

/**
 * Logs the warning once (the desktop shell keeps stderr in server.log). Never throws.
 * @param {string} dir
 * @param {{ env?: Record<string, string | undefined>, platform?: NodeJS.Platform, warn?: (m: string) => void }} [opts]
 * @returns {{ code: 'onedrive' | 'linked', message: string } | null}
 */
export function logDataFolderWarning(dir, { warn = console.warn, ...rest } = {}) {
  try {
    const warning = dataFolderWarning(inspectDataFolder(dir, rest));
    if (warning) warn(`data folder: ${warning.code}: ${warning.message}`);
    return warning;
  } catch {
    return null;
  }
}
