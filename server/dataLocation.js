// Data location: where the Windows desktop app keeps its data folder. 'appdata' (the default and the only value a direct
// build knows) is %APPDATA%\Burrow. 'userprofile' is %USERPROFILE%\Burrow Data and exists for ONE reason: the Microsoft Store
// MSIX build without desktop6:FileSystemWriteVirtualization / rescap:unvirtualizedResources (docs/MICROSOFT_STORE.md, "If
// Partner Center refuses unvirtualizedResources"). Without them MSIX redirects new files under AppData into the package's
// LocalCache and deletes them on uninstall; %USERPROFILE% outside AppData is not virtualized.
// Like the distribution (server/distribution.js) it is a compile-time marker: the sidecar bundler bakes
// __BURROW_DATA_LOCATION__ in and the Rust shell gets the same value from build.rs, so the shell environment cannot move the
// data of a bundled build. Only a source checkout (npm start) reads BURROW_DATA_LOCATION from the environment, for tests.
// 'userprofile' is valid only for the Store distribution on the stable channel (checkDataLocation); anything else refuses to start.
/* global __BURROW_DATA_LOCATION__ */

export const DATA_LOCATIONS = Object.freeze(['appdata', 'userprofile']);
export const BUNDLED_DATA_LOCATION = typeof __BURROW_DATA_LOCATION__ === 'string' ? __BURROW_DATA_LOCATION__ : undefined;

/**
 * Exact match only.
 * @param {unknown} value
 * @returns {'appdata' | 'userprofile' | null}
 */
export function parseDataLocation(value) {
  return value === 'appdata' || value === 'userprofile' ? value : null;
}

/**
 * Data location marker of this server process. The bundled define wins; the env var is read only when unbundled.
 * Anything but the exact value `userprofile` is `appdata`.
 * @param {Record<string, string | undefined>} [env]
 * @param {string | undefined} [bundled] tests pass `undefined` to simulate a source checkout
 * @returns {'appdata' | 'userprofile'}
 */
export function getDataLocation(env = process.env, bundled = BUNDLED_DATA_LOCATION) {
  if (bundled !== undefined) return bundled === 'userprofile' ? 'userprofile' : 'appdata';
  return env.BURROW_DATA_LOCATION === 'userprofile' ? 'userprofile' : 'appdata';
}

/**
 * Build-time data location from the build environment (`BURROW_DATA_LOCATION`, trimmed; empty or unset is `appdata`).
 * An unknown value is an error, so a typo can never ship as appdata.
 * @param {Record<string, string | undefined>} env
 * @param {string} [label] name used in the error message
 * @returns {'appdata' | 'userprofile'}
 * @throws {Error} on a value other than `appdata` or `userprofile`
 */
export function resolveBuildDataLocation(env, label = 'BURROW_DATA_LOCATION') {
  const raw = (env.BURROW_DATA_LOCATION ?? '').trim();
  const location = raw === '' ? 'appdata' : parseDataLocation(raw);
  if (location === null) throw new Error(`${label} must be one of ${DATA_LOCATIONS.join(', ')} (got "${raw}")`);
  return location;
}

export const USERPROFILE_NEEDS_STORE_MESSAGE =
  'This build is marked to keep its data in the user profile folder, which only the Microsoft Store build may do. Nothing was read or changed. Reinstall Burrow.';

/**
 * A userprofile marker is valid only with the Store distribution on the stable channel.
 * @param {{ dataLocation: 'appdata' | 'userprofile', distribution: 'direct' | 'store', channel?: 'stable' | 'dev' }} opts
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function checkDataLocation({ dataLocation, distribution, channel = 'stable' }) {
  if (dataLocation !== 'userprofile') return { ok: true };
  return distribution === 'store' && channel === 'stable' ? { ok: true } : { ok: false, message: USERPROFILE_NEEDS_STORE_MESSAGE };
}

/**
 * Same rule as checkDataLocation for a build script: throws instead of answering.
 * @param {{ dataLocation: 'appdata' | 'userprofile', distribution: 'direct' | 'store', channel?: 'stable' | 'dev' }} opts
 * @throws {Error} when a userprofile data location is combined with a direct or dev build
 */
export function assertBuildDataLocation({ dataLocation, distribution, channel = 'stable' }) {
  if (!checkDataLocation({ dataLocation, distribution, channel }).ok) {
    throw new Error('The userprofile data location is only valid for a stable Microsoft Store build (--distribution store).');
  }
}
