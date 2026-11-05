// Builds the desktop installer: web UI -> sidecar -> `tauri build`.
// Usage: npm run desktop:build [-- --target <triple> | any other `tauri build` flag]
// The sidecar embeds the local node.exe, so only the host target is supported here; CI builds each
// target natively.
// This makes STABLE builds only. A Burrow Dev build is `npm run desktop:build:dev` (buildDev.js).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertHostTarget, assertNoConfigFlag, assertSidecarChannel, ROOT, runTauri, targetFromArgs } from './lib.js';
import { resolveNpmCli } from '../lib/sandboxSafety.js';
import { withoutSigningEnv } from '../release/updaterConfig.js';

export const STABLE_ONLY_MESSAGE = 'desktop:build makes stable builds only. For a Burrow Dev build run npm run desktop:build:dev.';

/**
 * Refuses a build environment that asks for the dev channel or sets a display version.
 * @param {Record<string, string | undefined>} vars
 * @throws {Error} STABLE_ONLY_MESSAGE
 */
export function assertStableBuildEnv(vars) {
  const channel = (vars.BURROW_CHANNEL ?? '').trim();
  const display = (vars.BURROW_DISPLAY_VERSION ?? '').trim();
  if ((channel !== '' && channel !== 'stable') || display !== '') throw new Error(STABLE_ONLY_MESSAGE);
}

/**
 * The environment the children run in: explicitly stable, with no display version, no distribution or data location override and no updater signing variable
 * (desktop:build never signs; only scripts/release/buildInstaller.js hands a signing key to tauri).
 * @param {Record<string, string | undefined>} vars
 * @returns {Record<string, string | undefined>}
 */
export function stableChildEnv(vars) {
  const childEnv = { ...vars, BURROW_CHANNEL: 'stable' };
  delete childEnv.BURROW_DISPLAY_VERSION;
  // A lingering BURROW_DISTRIBUTION=store must never turn a direct build into a Store shell; scripts/release/buildStore.mjs
  // sets it explicitly for its own children.
  delete childEnv.BURROW_DISTRIBUTION;
  // Same for the data location: a direct build always keeps its data in %APPDATA%\Burrow.
  delete childEnv.BURROW_DATA_LOCATION;
  // The Tauri v2 CLI merges config from TAURI_CONFIG, which would bypass assertNoConfigFlag.
  delete childEnv.TAURI_CONFIG;
  return withoutSigningEnv(childEnv);
}

function node(args, childEnv) {
  const res = spawnSync(process.execPath, args, { cwd: ROOT, env: childEnv, stdio: 'inherit', shell: false });
  if (res.status !== 0) throw new Error(`${path.basename(args[0])} ${args.slice(1).join(' ')} failed (exit ${res.status ?? 'signal'})`);
}

function main() {
  const passthrough = process.argv.slice(2);
  try {
    assertStableBuildEnv(process.env);
    assertNoConfigFlag(passthrough);
    const childEnv = stableChildEnv(process.env);
    assertHostTarget(targetFromArgs(passthrough));
    node([resolveNpmCli(), 'run', 'build'], childEnv);
    node([path.join(ROOT, 'scripts', 'desktop', 'buildSidecar.js'), '--minify', '--channel', 'stable'], childEnv);
    // The sidecar that gets packaged must be the stable one, whatever was built into src-tauri/binaries before.
    assertSidecarChannel('stable');
    runTauri(['build', ...passthrough], childEnv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
