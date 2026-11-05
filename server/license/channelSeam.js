// The two places licensing reads the build channel and the environment (docs/LICENSING.md 4.7):
// whether store TEST purchases are accepted, and whether a loopback mock replaces a store origin.
/* global __BURROW_RELEASE_BUILD__, __BURROW_DEV_TOOLS__, __BURROW_PRO__ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDevChannel } from '../channel.js';
import { isDesktopMode } from '../runtime.js';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const STORE_ORIGINS = Object.freeze({
  gumroad: 'https://api.gumroad.com',
  lemonsqueezy: 'https://api.lemonsqueezy.com',
});
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** True in builds made by the release pipeline (the sidecar bundler defines `__BURROW_RELEASE_BUILD__` true). */
export function isReleaseBuild() {
  return typeof __BURROW_RELEASE_BUILD__ === 'boolean' && __BURROW_RELEASE_BUILD__;
}

/**
 * False when the bundler compiled the developer tools out (every stable sidecar defines `__BURROW_DEV_TOOLS__`
 * false and swaps the dev extension loader for a null stub); true in a dev bundle and in unbundled code, where it
 * is undefined. The policy that decides whether the tools may run belongs to the developer extension (see server/devExtensionsLoader.js).
 */
export function devToolsCompiledIn() {
  return typeof __BURROW_DEV_TOOLS__ !== 'boolean' || __BURROW_DEV_TOOLS__;
}

/**
 * False when the bundler built without the Pro module (`__BURROW_PRO__` false, the loader swapped for a null stub);
 * true in a bundle with the Pro module and in unbundled code, where it is undefined (the loader then decides by the folder).
 */
export function proCompiledIn() {
  return typeof __BURROW_PRO__ !== 'boolean' || __BURROW_PRO__;
}

/**
 * True only in a source checkout (a `.git` file or folder at the repo root; a git worktree has a `.git` file).
 * No environment variable counts, Vitest included: tests inject `checkout: true` instead. The release zip is a
 * `git archive` without `.git`, so `npm start` from it fails closed for the store test hooks.
 * @param {string} [root]
 */
export function isSourceCheckout(root = REPO_ROOT) {
  try {
    fs.statSync(path.join(root, '.git'));
    return true;
  } catch {
    return false;
  }
}

/**
 * True when a record with `test: true` must not give Pro: the running build is desktop or release and is not
 * the Dev channel, so a record minted from a checkout or a Dev build cannot unlock the stable app.
 * @param {Record<string, string | undefined>} [env]
 * @param {{ release?: boolean, devChannel?: boolean }} [opts]
 */
export function rejectsTestRecords(env = process.env, { release = isReleaseBuild(), devChannel = isDevChannel(env) } = {}) {
  return (isDesktopMode(env) || release) && !devChannel;
}

/**
 * Store TEST purchases (Gumroad `test: true`, Lemon Squeezy `test_mode: true`) are accepted only in
 * Burrow Dev builds, or by an explicit env switch in a source checkout (not desktop mode, not a release build).
 * @param {Record<string, string | undefined>} [env]
 * @param {{ release?: boolean, devChannel?: boolean, checkout?: boolean }} [opts]
 */
export function allowStoreTestPurchases(
  env = process.env,
  { release = isReleaseBuild(), devChannel = isDevChannel(env), checkout = isSourceCheckout() } = {},
) {
  return devChannel || (env.BURROW_LICENSE_STORE_TEST === '1' && !isDesktopMode(env) && !release && checkout);
}

/**
 * Origin for a store's license API. `BURROW_LICENSE_STORE_BASE_URL` replaces it only for a loopback
 * http URL without credentials, in a source checkout only (not desktop mode, not a release build, not a
 * release zip); otherwise it is ignored.
 * @param {'gumroad' | 'lemonsqueezy'} storeId
 * @param {Record<string, string | undefined>} [env]
 * @param {{ release?: boolean, checkout?: boolean, log?: (message: string) => void }} [opts]
 * @returns {string} origin without a trailing slash
 */
export function storeBaseUrl(
  storeId,
  env = process.env,
  { release = isReleaseBuild(), checkout = isSourceCheckout(), log = (m) => console.warn(m) } = {},
) {
  const real = STORE_ORIGINS[storeId];
  const raw = env.BURROW_LICENSE_STORE_BASE_URL;
  if (typeof raw !== 'string' || raw === '') return real;
  let url;
  try {
    url = new URL(raw);
  } catch {
    url = null;
  }
  const ok =
    url !== null &&
    url.protocol === 'http:' &&
    LOOPBACK_HOSTS.has(url.hostname) &&
    url.username === '' &&
    url.password === '' &&
    !isDesktopMode(env) &&
    !release &&
    checkout;
  if (!ok) {
    log('license: store base URL override ignored');
    return real;
  }
  return url.origin;
}
