// Startup guards that keep the Dev channel away from the stable Burrow, run before anything touches the
// data folder. They only compare paths (real locations, no reads, no writes).
//
// This is a safety net against mistakes (a wrong BURROW_DATA_DIR, a shell and sidecar of different
// channels), not a trust boundary: a source checkout or a zip reads BURROW_CHANNEL from the environment.
import os from 'node:os';
import { BUNDLED_CHANNEL, getChannel } from './channel.js';
import { resolveDataDir, stableDefaultDataDirs } from './paths.js';
import { pathsOverlap } from './pathGuard.js';

export const DEV_DATA_DIR_MESSAGE =
  'Burrow Dev cannot use this data folder because it is the same as, or overlaps, the folder where Burrow keeps its data. ' +
  'Nothing was read or changed. Remove BURROW_DATA_DIR or choose a different folder.';

export const SHELL_CHANNEL_MESSAGE =
  'This Burrow app and its server are not the same channel (Burrow and Burrow Dev), so the server did not start. ' +
  'Nothing was read or changed. Reinstall the app.';

/**
 * Folders that belong to the stable Burrow: its per-OS default (BURROW_DATA_DIR ignored), on Windows also
 * %USERPROFILE%\Burrow Data where the Microsoft Store build may keep its data, and, when set, the BURROW_STABLE_DATA_DIR
 * copy source.
 * @param {{ env?: Record<string, string | undefined>, platform?: NodeJS.Platform, home?: string }} [opts]
 * @returns {string[]}
 */
export function stableDataDirs({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const dirs = stableDefaultDataDirs({ env, platform, home });
  const override = (env.BURROW_STABLE_DATA_DIR || '').trim();
  if (override) dirs.push(override);
  return dirs;
}

/**
 * Dev channel only: the effective data folder must not equal, contain or lie inside a stable folder.
 * @param {{ env?: Record<string, string | undefined>, platform?: NodeJS.Platform, home?: string,
 *   channel?: 'stable' | 'dev' }} [opts]
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function checkDevDataDir({ env = process.env, platform = process.platform, home = os.homedir(), channel = getChannel(env) } = {}) {
  if (channel !== 'dev') return { ok: true };
  const effective = resolveDataDir({ env, platform, home, channel });
  const clash = stableDataDirs({ env, platform, home }).some((dir) => pathsOverlap(effective, dir, { platform }));
  return clash ? { ok: false, message: DEV_DATA_DIR_MESSAGE } : { ok: true };
}

/**
 * Desktop mode only: the channel the shell says it is (BURROW_SHELL_CHANNEL) must be the channel of this
 * server. A bundled server always needs the variable; a source checkout without a bundle tolerates it missing.
 * @param {{ env?: Record<string, string | undefined>, bundled?: string | undefined, channel?: 'stable' | 'dev' }} [opts]
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function checkShellChannel({ env = process.env, bundled = BUNDLED_CHANNEL, channel = getChannel(env, bundled) } = {}) {
  const shell = env.BURROW_SHELL_CHANNEL;
  if (shell === undefined || shell === '') return bundled === undefined ? { ok: true } : { ok: false, message: SHELL_CHANNEL_MESSAGE };
  return shell === channel ? { ok: true } : { ok: false, message: SHELL_CHANNEL_MESSAGE };
}
