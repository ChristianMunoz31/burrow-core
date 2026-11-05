// Release-side view of the in-app updater: is it switched on, and is the signing environment sane?
//
// "Enabled" has one rule (docs/RELEASING.md, mirrored by the Rust shell): `plugins.updater.pubkey` in
// src-tauri/tauri.release.conf.json is not the placeholder and decodes to a valid minisign public key. While the
// placeholder is in place the release pipeline publishes exactly the three assets it always did.
//
// Signing variables (names and rules):
//   TAURI_SIGNING_PRIVATE_KEY           key text, or a path to the key file (handed to the tauri child only)
//   TAURI_SIGNING_PRIVATE_KEY_PATH      Burrow alias: a path to the key file; it must lie OUTSIDE the repo
//   TAURI_SIGNING_PRIVATE_KEY_PASSWORD  required and non-empty when the updater is enabled
// Every other child process (npm ci, builds, smoke tests, gh, git) gets the environment without any of them.
import fs from 'node:fs';
import path from 'node:path';
import { parsePubkey } from './minisign.js';

export const RELEASE_OVERLAY = 'src-tauri/tauri.release.conf.json';
export const PUBKEY_PLACEHOLDER = 'BURROW_UPDATER_PUBKEY_PLACEHOLDER';
export const SIGNING_KEY_VAR = 'TAURI_SIGNING_PRIVATE_KEY';
export const SIGNING_KEY_PATH_VAR = 'TAURI_SIGNING_PRIVATE_KEY_PATH';
export const SIGNING_PASSWORD_VAR = 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD';

export const MISSING_SIGNING_MESSAGE =
  `Updater signing is on (${RELEASE_OVERLAY} has a public key) but ${SIGNING_KEY_VAR} (or ${SIGNING_KEY_PATH_VAR}) and ${SIGNING_PASSWORD_VAR} are not both set. ` +
  'Set them for this shell only (docs/RELEASING.md "Updater signing key"), or in CI add the two secrets to the GitHub "release" environment (not repository secrets).';

// Any variable the Tauri CLI would read a signing key or password from, current and legacy names.
const SIGNING_ENV_RE = /^(?:TAURI_SIGNING_|TAURI_PRIVATE_KEY|TAURI_KEY_PASSWORD)/i;

/**
 * @typedef {{ file: string, pubkey: string, enabled: boolean }} ReleaseOverlay
 */

/**
 * Reads the release overlay and decides whether the updater is enabled.
 * @param {string} root repository root
 * @returns {ReleaseOverlay | null} null when the overlay file does not exist
 * @throws {Error} when the file is not valid JSON, has no pubkey, or the pubkey is neither the placeholder nor a valid key
 */
export function readReleaseOverlay(root) {
  const file = path.join(root, ...RELEASE_OVERLAY.split('/'));
  if (!fs.existsSync(file)) return null;
  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${RELEASE_OVERLAY} is not valid JSON`);
  }
  const pubkey = config?.plugins?.updater?.pubkey;
  if (typeof pubkey !== 'string' || pubkey.trim() === '') throw new Error(`${RELEASE_OVERLAY} has no plugins.updater.pubkey`);
  if (pubkey === PUBKEY_PLACEHOLDER) return { file, pubkey, enabled: false };
  try {
    parsePubkey(pubkey);
  } catch (err) {
    throw new Error(`${RELEASE_OVERLAY}: plugins.updater.pubkey is neither the placeholder nor a valid minisign public key (${err.message})`, { cause: err });
  }
  return { file, pubkey, enabled: true };
}

/**
 * @param {string} root
 * @returns {boolean}
 */
export function isUpdaterEnabled(root) {
  return readReleaseOverlay(root)?.enabled === true;
}

/**
 * The updater state release scripts pass around: `{ enabled, pubkey }` (pubkey is null when disabled).
 * @param {string} root
 * @returns {{ enabled: boolean, pubkey: string | null }}
 */
export function updaterState(root) {
  const overlay = readReleaseOverlay(root);
  return overlay?.enabled ? { enabled: true, pubkey: overlay.pubkey } : { enabled: false, pubkey: null };
}

function realPath(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * @param {string} parent
 * @param {string} child
 * @returns {boolean} true when child is parent or lies below it
 */
function isInside(parent, child) {
  const rel = path.relative(realPath(parent), realPath(child));
  return rel === '' || (rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel));
}

function assertKeyFileOutsideRepo(file, root, varName) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new Error(`${varName} points at ${file}, which does not exist. Use the key file that "npx tauri signer generate" wrote (docs/RELEASING.md).`);
  }
  if (!stat.isFile()) throw new Error(`${varName} must be a file, not a folder: ${file}`);
  if (isInside(root, file)) {
    throw new Error(`${varName} points inside the repository (${file}). A signing key must live outside every repo, for example %USERPROFILE%\\.burrow-keys.`);
  }
}

const present = (value) => typeof value === 'string' && value.trim() !== '';

/**
 * Checks the signing variables for an updater-enabled build and returns what to hand to the tauri child.
 * @param {Record<string, string | undefined>} env
 * @param {{ root: string }} opts
 * @returns {{ privateKey: string, password: string }} privateKey is key text or an absolute key file path
 * @throws {Error} with the owner-facing message when something is missing or unsafe
 */
export function assertSigningEnv(env, { root }) {
  const key = env[SIGNING_KEY_VAR];
  const keyPath = env[SIGNING_KEY_PATH_VAR];
  const password = env[SIGNING_PASSWORD_VAR];
  if (present(key) && present(keyPath)) {
    throw new Error(`Set only one of ${SIGNING_KEY_VAR} and ${SIGNING_KEY_PATH_VAR}, not both.`);
  }
  if ((!present(key) && !present(keyPath)) || typeof password !== 'string' || password === '') {
    throw new Error(MISSING_SIGNING_MESSAGE);
  }
  if (present(keyPath)) {
    const file = path.resolve(keyPath.trim());
    assertKeyFileOutsideRepo(file, root, SIGNING_KEY_PATH_VAR);
    return { privateKey: file, password };
  }
  const value = key.trim();
  // TAURI_SIGNING_PRIVATE_KEY may be a path as well as the key text: a single line that names a file is a path.
  if (value.length < 1024 && !/[\r\n]/.test(value) && fs.existsSync(value) && fs.statSync(value).isFile()) {
    assertKeyFileOutsideRepo(path.resolve(value), root, SIGNING_KEY_VAR);
    return { privateKey: path.resolve(value), password };
  }
  return { privateKey: key, password };
}

/**
 * The two variables the tauri child needs (the _PATH alias becomes TAURI_SIGNING_PRIVATE_KEY).
 * @param {Record<string, string | undefined>} env a validated environment
 * @returns {Record<string, string>}
 */
export function signingEnvForTauri(env) {
  const keyPath = env[SIGNING_KEY_PATH_VAR];
  return {
    [SIGNING_KEY_VAR]: present(keyPath) ? path.resolve(keyPath.trim()) : String(env[SIGNING_KEY_VAR] ?? ''),
    [SIGNING_PASSWORD_VAR]: String(env[SIGNING_PASSWORD_VAR] ?? ''),
  };
}

/**
 * A copy of the environment with every signing variable removed (names matched case-insensitively, as Windows does).
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string | undefined>}
 */
export function withoutSigningEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !SIGNING_ENV_RE.test(name)));
}
