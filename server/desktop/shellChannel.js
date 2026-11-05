// Server -> shell request channel (desktop sidecar only). The shell reads every stdout line of this process, so an
// update request is one authenticated line:
//   BURROW_UPDATE_REQUEST {"v":1,"version":"x.y.z","nonce":"<32 hex>","mac":"<64 hex>"}
// The mac comes from the per-launch secret (server/desktop/auth.js `updateRequestMac`), so a line printed by
// anything else (a console.log of user text, for example) cannot start an update. The shell re-checks everything
// else (channel, version, signature) from its own baked config; see src-tauri/README.md.
// A dialog request (folder picker, save dialog) is the same kind of line, under its own key:
//   BURROW_DIALOG_REQUEST {"v":1,"kind":"pick_folder|save_file","id":"<32 hex>","ttl":900,"name":"","ext":"","bytes":0,"mac":"<64 hex>"}
// and the shell answers on the sidecar's stdin (server/desktop/shellInbox.js, state in dialogBroker.js).
import crypto from 'node:crypto';
import { STABLE_VERSION_RE, getChannel } from '../channel.js';
import { isStoreDistribution } from '../distribution.js';
import { isDesktopMode } from '../runtime.js';
import { dialogRequestMac, updateRequestMac } from './auth.js';

export const UPDATE_REQUEST_PREFIX = 'BURROW_UPDATE_REQUEST ';
export const DIALOG_REQUEST_PREFIX = 'BURROW_DIALOG_REQUEST ';
export const DIALOG_MAX_SAVE_BYTES = 32 * 1024 * 1024;
export const DIALOG_SAVE_EXTS = Object.freeze(['md', 'json', 'csv']);
const DIALOG_ID_RE = /^[0-9a-f]{32}$/;
const DIALOG_NAME_RE = /^[^\\/:*?"<>|]{1,200}$/;
const hasControlChar = (text) => [...text].some((c) => c.charCodeAt(0) <= 0x1f || (c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) <= 0x9f));

/**
 * True when the desktop shell can install updates: desktop mode, the stable channel and the fixed
 * `BURROW_SHELL_UPDATER=1` the stable shell sets only when it registered the updater plugin (the plugin is compiled into
 * every build, but registered only for the stable channel with a real public key). Never in the Microsoft Store
 * distribution: the Store delivers updates, so the in-app installer stays off whatever the environment says.
 * (Not in server/runtime.js: that file stays builtins-only because loadEnv.js imports it first.)
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isShellUpdaterAvailable(env = process.env) {
  return isDesktopMode(env) && env.BURROW_SHELL_UPDATER === '1' && getChannel(env) === 'stable' && !isStoreDistribution(env);
}

/**
 * 'x64' | 'arm64' for a Windows installer this process can use, else null.
 * @param {string} [arch]
 * @returns {'x64' | 'arm64' | null}
 */
export function installerArch(arch = process.arch) {
  return arch === 'x64' || arch === 'arm64' ? arch : null;
}

/**
 * The desktop app on the stable direct channel without a working shell updater (the placeholder key), on Windows:
 * the copy that gets the manual download (installer link plus its SHA-256) instead of Download and install.
 * @param {Record<string, string | undefined>} [env]
 * @param {{ platform?: string, arch?: string }} [host]
 * @returns {boolean}
 */
export function isManualDownloadAvailable(env = process.env, { platform = process.platform, arch = process.arch } = {}) {
  return (
    isDesktopMode(env) &&
    getChannel(env) === 'stable' &&
    !isStoreDistribution(env) &&
    !isShellUpdaterAvailable(env) &&
    platform === 'win32' &&
    installerArch(arch) !== null
  );
}

/**
 * Ask the shell to download and install `version`. Writes exactly one stdout line in a single call.
 * @param {string} version strict x.y.z (no prerelease, no leading zeros)
 * @param {{ out?: { write: (chunk: string) => unknown }, randomBytes?: (size: number) => Buffer,
 *   desktop?: boolean }} [opts] test seams
 * @returns {{ nonce: string }}
 */
export function requestShellUpdate(
  version,
  { out = process.stdout, randomBytes = crypto.randomBytes, desktop = isDesktopMode() } = {},
) {
  if (!desktop) throw new Error('The shell channel only exists in the desktop app');
  if (typeof version !== 'string' || !STABLE_VERSION_RE.test(version)) throw new TypeError('Invalid update version');
  const nonce = randomBytes(16).toString('hex');
  const mac = updateRequestMac(version, nonce);
  out.write(`${UPDATE_REQUEST_PREFIX}${JSON.stringify({ v: 1, version, nonce, mac })}\n`);
  return { nonce };
}

/**
 * True when the desktop shell can open native dialogs for us (the folder picker and the save dialog): desktop mode and the
 * fixed `BURROW_SHELL_DIALOGS=1` that every shell sets for its sidecar. Outside the desktop app the Folders page keeps
 * the pasted path.
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isShellDialogAvailable(env = process.env) {
  return isDesktopMode(env) && env.BURROW_SHELL_DIALOGS === '1';
}

/**
 * Ask the shell to open a native dialog. Writes exactly one stdout line in a single call:
 *   BURROW_DIALOG_REQUEST {"v":1,"kind","id","ttl","name","ext","bytes","mac"}
 * The reply comes back as one authenticated stdin line (server/desktop/shellInbox.js). A pick request carries empty
 * `name` and `ext` and `bytes` 0; a save request carries the clean file name, its extension and the exact byte length.
 * @param {{ kind: 'pick_folder' | 'save_file', id: string, ttl: number, name: string, ext: string, bytes: number }} request
 * @param {{ out?: { write: (chunk: string) => unknown }, desktop?: boolean }} [opts] test seams
 * @returns {void}
 */
export function requestShellDialog(
  { kind, id, ttl, name, ext, bytes },
  { out = process.stdout, desktop = isDesktopMode() } = {},
) {
  if (!desktop) throw new Error('The shell channel only exists in the desktop app');
  if (kind !== 'pick_folder' && kind !== 'save_file') throw new TypeError('Invalid dialog kind');
  if (typeof id !== 'string' || !DIALOG_ID_RE.test(id)) throw new TypeError('Invalid dialog id');
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 3600) throw new TypeError('Invalid dialog ttl');
  if (kind === 'pick_folder') {
    if (name !== '' || ext !== '' || bytes !== 0) throw new TypeError('Invalid folder dialog request');
  } else if (
    !DIALOG_SAVE_EXTS.includes(ext) ||
    typeof name !== 'string' ||
    !DIALOG_NAME_RE.test(name) ||
    hasControlChar(name) ||
    !name.endsWith(`.${ext}`) ||
    !Number.isInteger(bytes) ||
    bytes < 1 ||
    bytes > DIALOG_MAX_SAVE_BYTES
  ) {
    throw new TypeError('Invalid save dialog request');
  }
  const mac = dialogRequestMac({ kind, id, ttl, name, ext, bytes });
  out.write(`${DIALOG_REQUEST_PREFIX}${JSON.stringify({ v: 1, kind, id, ttl, name, ext, bytes, mac })}\n`);
}
