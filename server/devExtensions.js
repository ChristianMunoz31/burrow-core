// Seam for optional developer extensions. They live outside the core, in a top-level folder that is never part of
// the public core or of any stable build (only server/devExtensionsLoader.js names it). Core knows only this contract: an extension has `available(env)` and
// `install(router, { env, log })`. The tools stay off unless a successful install happened; a stable bundle
// resolves the loader to a null stub, so nothing here can switch anything on.
import express from 'express';
import { importDevExtension } from './devExtensionsLoader.js';
import { isDevChannel } from './channel.js';
import { devToolsCompiledIn, isReleaseBuild, isSourceCheckout } from './license/channelSeam.js';
import { installLicenseDevHook } from './license/index.js';

const router = express.Router();
let active = false;
let loading = null;

/** Router that server.js mounts once; stays empty unless a dev extension installs into it. */
export function devExtensionRouter() {
  return router;
}

/** Error code for the local log only: never a message or path, which can name folders. */
const errCode = (err) => (typeof err?.code === 'string' ? err.code : 'error');

/**
 * Core-side copy of the policy the extension applies itself (that copy stays authoritative there): a bundled
 * sidecar only on the Dev channel, unbundled only in a source checkout. A devtools folder dropped into a zip or
 * Docker install (no .git) therefore does nothing, even if the extension would say yes.
 */
function policyAllows(env, { release, devChannel, checkout }) {
  return (release ?? isReleaseBuild()) ? (devChannel ?? isDevChannel(env)) : (checkout ?? isSourceCheckout());
}

async function load({ env, log, importer, seams }) {
  if (!devToolsCompiledIn()) return false;
  if (!policyAllows(env, seams)) return false;
  let ext;
  try {
    ext = await importer();
  } catch (err) {
    log(`dev extensions: failed to load (${errCode(err)})`);
    return false;
  }
  if (!ext || typeof ext.available !== 'function' || typeof ext.install !== 'function') return false;
  try {
    if (ext.available(env) !== true) return false;
  } catch (err) {
    log(`dev extensions: availability check failed (${errCode(err)})`);
    return false;
  }
  try {
    ext.install(router, { env, log });
  } catch (err) {
    log(`dev extensions: install failed (${errCode(err)})`);
    installLicenseDevHook(null);
    router.stack.length = 0;
    return false;
  }
  active = true;
  return true;
}

/**
 * Loads and installs the dev extension when there is one and it is available. Idempotent.
 * @param {{ env?: Record<string, string | undefined>, log?: (m: string) => void, importer?: () => Promise<object | null>, release?: boolean, devChannel?: boolean, checkout?: boolean }} [opts]
 * @returns {Promise<boolean>} whether an extension is installed
 */
export async function loadDevExtensions({
  env = process.env,
  log = console.warn,
  importer = importDevExtension,
  release,
  devChannel,
  checkout,
} = {}) {
  if (active) return true;
  loading ??= load({ env, log, importer, seams: { release, devChannel, checkout } }).finally(() => {
    loading = null;
  });
  return loading;
}

/** True only after a successful install. The default for /api/app/info `devTools`. */
export function devToolsActive() {
  return active;
}

/** Empties the router, uninstalls the license hook and forgets the install. For tests only. */
export function resetDevExtensionsForTests() {
  router.stack.length = 0;
  active = false;
  loading = null;
  installLicenseDevHook(null);
}
