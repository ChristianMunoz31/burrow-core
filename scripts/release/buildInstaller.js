// The one place a Burrow STABLE installer is bundled for a release: `tauri build --bundles nsis`, run for CI
// (desktop-windows.yml) and for the owner's own PC (releaseLocal.mjs, and the x64 manual fallback in docs/RELEASING.md).
// The web build and the sidecar must already exist (npm run build, npm run desktop:sidecar).
//
// Usage: node scripts/release/buildInstaller.js [--target x86_64-pc-windows-msvc | aarch64-pc-windows-msvc] [--phase build | bundle]
// --phase build runs only the compile (no signing variable is read or needed), --phase bundle only the bundling and the
// checks; CI runs them as two workflow steps so the signing secrets exist on the bundle step alone. Default: both.
// With the updater off, --phase build still builds the whole installer (nothing to sign) and --phase bundle does nothing.
//
// Updater OFF (the placeholder public key is still in src-tauri/tauri.release.conf.json): the installer is built
// exactly as before, no signing variable reaches any child, and a stray `.sig` file is an error.
// Updater ON (a real public key): the release overlay is applied (`--config src-tauri/tauri.release.conf.json`) in two
// phases so the signing key only ever reaches the bundler, never the compile (build scripts, proc macros, beforeBuild
// commands run in phase 1): `tauri build --no-bundle` with NO signing variable, then `tauri bundle --bundles nsis` with
// the key and password. The run fails closed unless exactly one installer and its `.sig` exist, the signature verifies
// against the public key and its signed comment is bound to this app version (`version:<package.json version>`).
// A missing key or password stops the run before tauri starts.
// Burrow Dev never gets here: BURROW_CHANNEL=dev and BURROW_DISPLAY_VERSION are refused.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { assertStableBuildEnv, stableChildEnv } from '../desktop/build.js';
import { assertProPresent } from '../checks/proPresent.js';
import { assertNoStoreSidecars } from '../desktop/lib.js';
import { APP_EXECUTABLE } from './storeManifest.mjs';
import { verifyTauriSignature } from './minisign.js';
import { RELEASE_OVERLAY, assertSigningEnv, readReleaseOverlay, signingEnvForTauri, withoutSigningEnv } from './updaterConfig.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ALLOWED_TARGETS = Object.freeze(['x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc']);

function defaultStep(file, args, { cwd, env }) {
  const res = spawnSync(file, args, { cwd, env, stdio: 'inherit', shell: false });
  if (res.status !== 0) throw new Error(`${path.basename(args[0] ?? file)} ${args.slice(1, 4).join(' ')} failed (exit ${res.status ?? 'signal'})`);
}

/**
 * Where tauri leaves the NSIS installer for a host build or for `--target <triple>`.
 * @param {string} root
 * @param {string | undefined} target
 * @returns {string}
 */
export function nsisDirFor(root, target) {
  return path.join(root, 'src-tauri', 'target', ...(target ? [target] : []), 'release', 'bundle', 'nsis');
}

/** Marker string src-tauri/src/channel.rs (DISTRIBUTION_MARKER) compiles into the shell exe. */
export const DIRECT_SHELL_MARKER = 'burrow-distribution=direct';
export const STORE_SHELL_MARKER = 'burrow-distribution=store';
/** Marker string src-tauri/src/channel.rs (DATA_LOCATION_MARKER) compiles into the shell exe: where its data folder is. */
export const APPDATA_SHELL_MARKER = 'burrow-data-location=appdata';
export const USERPROFILE_SHELL_MARKER = 'burrow-data-location=userprofile';

/**
 * Where tauri leaves the compiled shell exe for a host build or for `--target <triple>`.
 * @param {string} root
 * @param {string | undefined} target
 * @returns {string}
 */
export function appExeFor(root, target) {
  return path.join(root, 'src-tauri', 'target', ...(target ? [target] : []), 'release', APP_EXECUTABLE);
}

/**
 * Throws unless the compiled shell exe is a direct build: it must carry the direct distribution marker and not the
 * Store one (a stray BURROW_DISTRIBUTION=store at compile time would otherwise ship a Store shell as an installer), and never
 * the userprofile data location marker (build.rs also refuses that combination).
 * @param {string} exe
 * @throws {Error} when the exe is missing or is not marked direct
 */
export function assertDirectShell(exe) {
  if (!fs.existsSync(exe)) throw new Error(`tauri did not produce ${exe}`);
  const text = fs.readFileSync(exe).toString('latin1');
  if (text.includes(STORE_SHELL_MARKER)) {
    throw new Error(`${path.basename(exe)} is a Microsoft Store build (${STORE_SHELL_MARKER}) and must never be packaged as a direct installer. Unset BURROW_DISTRIBUTION and rebuild.`);
  }
  if (!text.includes(DIRECT_SHELL_MARKER)) throw new Error(`${path.basename(exe)} carries no ${DIRECT_SHELL_MARKER} marker; refusing to package it`);
  if (text.includes(USERPROFILE_SHELL_MARKER)) {
    throw new Error(`${path.basename(exe)} keeps its data in the user profile folder (${USERPROFILE_SHELL_MARKER}), which only the Microsoft Store build may do. Unset BURROW_DATA_LOCATION and rebuild.`);
  }
}

/**
 * Builds the NSIS installer (and, when the updater is on, its signature).
 * @param {{
 *   root?: string,
 *   env?: Record<string, string | undefined>,
 *   target?: string,
 *   phase?: 'all' | 'build' | 'bundle',
 *   step?: (file: string, args: string[], opts: { cwd: string, env: Record<string, string | undefined> }) => void,
 *   proCheck?: (opts: { root: string }) => void,
 * }} [opts] `proCheck` (default assertProPresent) refuses a checkout without the Pro module: an official installer is never a Free build
 * @returns {{ installer: string, sig: string | null } | null} absolute paths; null when nothing was bundled in this call (updater on after `phase: 'build'`, updater off after `phase: 'bundle'`)
 */
export function buildInstaller({ root = ROOT, env = process.env, target, phase = 'all', step = defaultStep, proCheck = assertProPresent } = {}) {
  if (!['all', 'build', 'bundle'].includes(phase)) throw new Error(`--phase must be build or bundle (got ${String(phase)})`);
  assertStableBuildEnv(env);
  // Official installers include the Pro module (docs/adr/0001-open-core-split.md 3.10): refuse a checkout without the Pro module.
  proCheck({ root });
  // A sidecar that `npm run release:store` left in src-tauri/binaries must never be packaged into a direct installer.
  assertNoStoreSidecars(path.join(root, 'src-tauri', 'binaries'));
  if (target !== undefined && !ALLOWED_TARGETS.includes(target)) {
    throw new Error(`--target ${String(target)} is not allowed. Use ${ALLOWED_TARGETS.join(' or ')}.`);
  }
  const overlay = readReleaseOverlay(root);
  const enabled = overlay?.enabled === true;
  // Every child starts from the stable environment without any signing variable; tauri alone gets them back.
  const baseEnv = { ...withoutSigningEnv(stableChildEnv(env)), BURROW_REQUIRE_PRO: '1' };
  let tauriEnv = baseEnv;
  if (enabled && phase !== 'build') {
    assertSigningEnv(env, { root });
    tauriEnv = { ...baseEnv, ...signingEnvForTauri(env) };
  }

  const nsisDir = nsisDirFor(root, target);
  if (phase !== 'bundle') fs.rmSync(nsisDir, { recursive: true, force: true });
  const tauriCli = path.join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
  const targetArgs = target ? ['--target', target] : [];
  if (enabled) {
    if (phase !== 'bundle') step(process.execPath, [tauriCli, 'build', '--no-bundle', '--config', RELEASE_OVERLAY, ...targetArgs], { cwd: root, env: baseEnv });
    // Compiled (here or in an earlier --phase build): the shell must be the direct build before it is bundled or signed.
    assertDirectShell(appExeFor(root, target));
    if (phase === 'build') return null;
    step(process.execPath, [tauriCli, 'bundle', '--bundles', 'nsis', '--config', RELEASE_OVERLAY, ...targetArgs], { cwd: root, env: tauriEnv });
  } else {
    // Updater off: the compile step already built the whole installer in one go, so there is nothing to bundle or sign.
    if (phase === 'bundle') return null;
    step(process.execPath, [tauriCli, 'build', '--bundles', 'nsis', ...targetArgs], { cwd: root, env: baseEnv });
    assertDirectShell(appExeFor(root, target));
  }

  const names = fs.existsSync(nsisDir) ? fs.readdirSync(nsisDir) : [];
  const installers = names.filter((n) => n.endsWith('-setup.exe'));
  if (installers.length !== 1) {
    throw new Error(`Expected exactly one *-setup.exe in ${nsisDir}, found: ${installers.join(', ') || 'none'}`);
  }
  const installer = path.join(nsisDir, installers[0]);
  const sigs = names.filter((n) => n.endsWith('.sig'));

  if (!enabled) {
    if (sigs.length > 0) {
      throw new Error(`Found a signature file (${sigs.join(', ')}) but the updater is off (the public key in ${RELEASE_OVERLAY} is still the placeholder). Nothing is published from a half-enabled build.`);
    }
    return { installer, sig: null };
  }

  const sig = `${installer}.sig`;
  if (sigs.length !== 1 || sigs[0] !== path.basename(sig)) {
    throw new Error(`The updater is on, so tauri must write exactly ${path.basename(sig)} next to the installer; found: ${sigs.join(', ') || 'none'}`);
  }
  const sigText = fs.readFileSync(sig, 'utf8').trim();
  if (sigText === '') throw new Error(`${path.basename(sig)} is empty`);
  try {
    const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    verifyTauriSignature({ pubkeyB64: overlay.pubkey, sigB64: sigText, data: fs.readFileSync(installer), expectVersion: version });
  } catch (err) {
    throw new Error(`${path.basename(sig)} does not verify against the public key in ${RELEASE_OVERLAY}: ${err.message}`, { cause: err });
  }
  return { installer, sig };
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: { target: { type: 'string' }, phase: { type: 'string' } }, strict: true, allowPositionals: false });
  const out = buildInstaller({ target: values.target, phase: values.phase });
  if (out === null) {
    console.log('Nothing to bundle in this phase (compiled without any signing variable, or the updater is off).');
    return;
  }
  console.log(`Installer: ${out.installer}`);
  console.log(out.sig ? `Signature verified: ${out.sig}` : 'Updater is off: no signature (public key is still the placeholder).');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`::error::${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
