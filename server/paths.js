// Per-user data directory (Phase 1 keeps burrow.db here). BURROW_DATA_DIR wins;
// otherwise an OS-appropriate location is used.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getChannel } from './channel.js';
import { getDataLocation } from './dataLocation.js';
import { getDistribution } from './distribution.js';
import { ensureOwnedDataFolder } from './dataFolderOwnership.js';

/**
 * Folder name of the Store build's data in the user profile (`%USERPROFILE%\Burrow Data`). Not `Burrow`: that name is easy to
 * collide with an unrelated folder (a source checkout, an old install). The Rust shell holds the same constant
 * (`USER_PROFILE_DATA_FOLDER` in src-tauri/src/data_guard.rs).
 */
export const USER_PROFILE_DATA_FOLDER = 'Burrow Data';

/**
 * Data folder name per platform and channel.
 * @param {'stable' | 'dev'} channel
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export function dataFolderName(channel, platform = process.platform) {
  const dev = channel === 'dev';
  if (platform === 'win32' || platform === 'darwin') return dev ? 'Burrow Dev' : 'Burrow';
  return dev ? 'burrow-dev' : 'burrow';
}

/**
 * %USERPROFILE%\Burrow Data: the data folder of the Microsoft Store build in the userprofile data location (Windows only).
 * @param {{ env?: Record<string, string | undefined>, home?: string }} [opts]
 * @returns {string}
 */
export function userProfileDataDir({ env = process.env, home = os.homedir() } = {}) {
  return path.win32.join(env.USERPROFILE || home, USER_PROFILE_DATA_FOLDER);
}

/**
 * True when the data folder of this build is %USERPROFILE%\Burrow Data: the userprofile marker, the Store distribution, the
 * stable channel and Windows, all four. Burrow Dev always keeps its own AppData folder.
 * @param {{ platform?: NodeJS.Platform, env?: Record<string, string | undefined>, channel?: 'stable' | 'dev',
 *   distribution?: 'direct' | 'store', dataLocation?: 'appdata' | 'userprofile' }} [opts]
 * @returns {boolean}
 */
export function usesUserProfileDir({
  platform = process.platform,
  env = process.env,
  channel = getChannel(env),
  distribution = getDistribution(env),
  dataLocation = getDataLocation(env),
} = {}) {
  return platform === 'win32' && channel === 'stable' && distribution === 'store' && dataLocation === 'userprofile';
}

/**
 * Resolve (without creating) the data directory. The one place that decides it: BURROW_DATA_DIR wins, then the
 * userprofile marker (Store build), then the per-OS default.
 * @param {{ platform?: NodeJS.Platform, env?: Record<string, string | undefined>, home?: string,
 *   channel?: 'stable' | 'dev', distribution?: 'direct' | 'store', dataLocation?: 'appdata' | 'userprofile' }} [opts]
 * @returns {string}
 */
export function resolveDataDir({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  channel = getChannel(env),
  distribution = getDistribution(env),
  dataLocation = getDataLocation(env),
} = {}) {
  const override = (env.BURROW_DATA_DIR || '').trim();
  if (override) return path.resolve(override);
  if (usesUserProfileDir({ platform, env, channel, distribution, dataLocation })) return userProfileDataDir({ env, home });
  return appDataFolderDir({ platform, env, home, channel });
}

/**
 * The per-OS default folder of a channel for a direct install (%APPDATA%\Burrow on Windows), ignoring every override
 * and marker.
 * @param {{ platform?: NodeJS.Platform, env?: Record<string, string | undefined>, home?: string, channel?: 'stable' | 'dev' }} [opts]
 * @returns {string}
 */
export function appDataFolderDir({ platform = process.platform, env = process.env, home = os.homedir(), channel = 'stable' } = {}) {
  const folder = dataFolderName(channel, platform);
  if (platform === 'win32') {
    const base = env.APPDATA || path.win32.join(home, 'AppData', 'Roaming');
    return path.win32.join(base, folder);
  }
  if (platform === 'darwin') {
    return path.posix.join(home, 'Library', 'Application Support', folder);
  }
  const base = env.XDG_DATA_HOME || path.posix.join(home, '.local', 'share');
  return path.posix.join(base, folder);
}

/**
 * Every folder that can hold the stable Burrow's data by default, whichever data location this build uses:
 * the direct install folder and, on Windows, %USERPROFILE%\Burrow Data of the Store build. The Dev channel must never run on
 * one of them (server/channelGuards.js).
 * @param {{ platform?: NodeJS.Platform, env?: Record<string, string | undefined>, home?: string }} [opts]
 * @returns {string[]}
 */
export function stableDefaultDataDirs({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const dirs = [appDataFolderDir({ platform, env, home, channel: 'stable' })];
  if (platform === 'win32') dirs.push(userProfileDataDir({ env, home }));
  return dirs;
}

/**
 * Where the stable Burrow keeps its data (the source of "Copy my data from Burrow"). Read only by
 * server/backup/stableCopy.js, which runs only in the dev channel. BURROW_STABLE_DATA_DIR overrides.
 * @param {{ platform?: NodeJS.Platform, env?: Record<string, string | undefined>, home?: string }} [opts]
 * @returns {{ dir: string, overridden: boolean }}
 */
export function resolveStableDataDir({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const override = (env.BURROW_STABLE_DATA_DIR || '').trim();
  if (override) return { dir: path.resolve(override), overridden: true };
  return {
    dir: appDataFolderDir({ platform, env, home, channel: 'stable' }),
    overridden: false,
  };
}

/**
 * The ownership rule of the user profile data folder (server/dataFolderOwnership.js), for the default folder of a Store build in
 * the `userprofile` data location only: a missing folder is created with its marker, a marked one is used, an empty one is
 * adopted, anything else throws `data_dir_not_ours` without writing. A BURROW_DATA_DIR override, the appdata folder and the
 * Dev channel are not checked. Runs before every mkdir of the data folder and at the top of `startServer`.
 * @param {{ platform?: NodeJS.Platform, env?: Record<string, string | undefined>, home?: string,
 *   channel?: 'stable' | 'dev', distribution?: 'direct' | 'store', dataLocation?: 'appdata' | 'userprofile' }} [opts]
 * @returns {string | null} The checked folder, or null when this build has no ownership rule.
 * @throws {import('./dataFolderOwnership.js').DataDirNotOursError}
 */
export function ensureDataDirOwnership(opts = {}) {
  const env = opts.env ?? process.env;
  if ((env.BURROW_DATA_DIR || '').trim()) return null;
  if (!usesUserProfileDir({ ...opts, env })) return null;
  const dir = resolveDataDir({ ...opts, env });
  ensureOwnedDataFolder(dir);
  return dir;
}

/**
 * Resolve the data directory and create it (mkdir -p). In the user profile data location the ownership rule runs first.
 * @param {{ platform?: NodeJS.Platform, env?: Record<string, string | undefined>, home?: string,
 *   mkdir?: (dir: string, opts: { recursive: true, mode: number }) => unknown }} [opts]
 * @returns {string} Absolute path of the data directory.
 */
export function getDataDir({ mkdir = fs.mkdirSync, ...rest } = {}) {
  const dir = resolveDataDir(rest);
  ensureDataDirOwnership(rest);
  mkdir(dir, { recursive: true, mode: 0o700 });
  tightenDirMode(dir, rest.platform ?? process.platform);
  return dir;
}

/**
 * Best-effort chmod of a file (POSIX only; no-op on win32). Never throws.
 * @param {string} file
 * @param {number} mode
 */
export function chmodBestEffort(file, mode) {
  if (process.platform === 'win32') return;
  try {
    fs.chmodSync(file, mode);
  } catch {
    // missing file or not owned by us
  }
}

// mkdir's mode only applies to directories it creates; tighten a pre-existing one we own.
function tightenDirMode(dir, platform) {
  if (platform === 'win32' || process.platform === 'win32') return;
  try {
    const st = fs.statSync(dir);
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return;
    if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
  } catch {
    // best effort (injected mkdir in tests may not create a real directory)
  }
}
