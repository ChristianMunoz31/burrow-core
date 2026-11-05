// Distribution: how this build reached the user. 'direct' (the default: the Burrow-Setup installer from the
// public downloads repo, with the opt-in in-app updater) or 'store' (the Microsoft Store MSIX build, which the
// Store updates, so the in-app update check and installer are off).
// The sidecar bundler bakes __BURROW_DISTRIBUTION__ in, so the shell environment cannot switch a bundled build.
// Only a source checkout (npm start) reads BURROW_DISTRIBUTION from the environment, for tests and previews.
// An absent value is always 'direct', so every build made before this file existed behaves as before.
/* global __BURROW_DISTRIBUTION__ */

export const DISTRIBUTIONS = Object.freeze(['direct', 'store']);
export const BUNDLED_DISTRIBUTION = typeof __BURROW_DISTRIBUTION__ === 'string' ? __BURROW_DISTRIBUTION__ : undefined;

/**
 * Exact match only.
 * @param {unknown} value
 * @returns {'direct' | 'store' | null}
 */
export function parseDistribution(value) {
  return value === 'direct' || value === 'store' ? value : null;
}

/**
 * Runtime distribution of this server process. The bundled define wins; the env var is read only when unbundled.
 * Anything but the exact value `store` is `direct`.
 * @param {Record<string, string | undefined>} [env]
 * @param {string | undefined} [bundled] tests pass `undefined` to simulate a source checkout
 * @returns {'direct' | 'store'}
 */
export function getDistribution(env = process.env, bundled = BUNDLED_DISTRIBUTION) {
  if (bundled !== undefined) return bundled === 'store' ? 'store' : 'direct';
  return env.BURROW_DISTRIBUTION === 'store' ? 'store' : 'direct';
}

/**
 * The one place to ask "is this the Microsoft Store build?".
 * @param {Record<string, string | undefined>} [env]
 * @param {string | undefined} [bundled]
 * @returns {boolean}
 */
export const isStoreDistribution = (env = process.env, bundled = BUNDLED_DISTRIBUTION) => getDistribution(env, bundled) === 'store';

/**
 * Build-time distribution from the build environment (`BURROW_DISTRIBUTION`, trimmed; empty or unset is `direct`).
 * Unlike getDistribution(), an unknown value is an error, so a typo can never ship as direct.
 * @param {Record<string, string | undefined>} env
 * @param {string} [label] name used in the error message
 * @returns {'direct' | 'store'}
 * @throws {Error} on a value other than `direct` or `store`
 */
export function resolveBuildDistribution(env, label = 'BURROW_DISTRIBUTION') {
  const raw = (env.BURROW_DISTRIBUTION ?? '').trim();
  const distribution = raw === '' ? 'direct' : parseDistribution(raw);
  if (distribution === null) throw new Error(`${label} must be one of ${DISTRIBUTIONS.join(', ')} (got "${raw}")`);
  return distribution;
}
