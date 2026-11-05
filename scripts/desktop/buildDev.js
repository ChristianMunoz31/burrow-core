// Builds the Burrow Dev installer: the side-by-side test channel (own app, data and update source).
// Versions and naming are explained in devVersion.js. Unsigned, like every Burrow desktop build.
//
// Usage:
//   npm run desktop:build:dev [-- <tauri build flags>]   full local build (host target only):
//       npm run build, sidecar (dev channel), channel check, overlay config, tauri build, then the installer
//       copied to .dev-build/ as Burrow-Dev_<display>_<arch>-setup.exe with a SHA256SUMS file
//   node scripts/desktop/buildDev.js --write-config      write src-tauri/tauri.dev.build.json (gitignored)
//   node scripts/desktop/buildDev.js --collect <dir> --platform <windows|macos|linux>
//                                                        copy the bundles with dev names, write SHA256SUMS-dev-<platform>.txt
// CI (dev-build.yml) calls the last two between its own steps.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveNpmCli } from '../lib/sandboxSafety.js';
import { resolveDevVersions } from './devVersion.js';
import { assertHostTarget, assertNoConfigFlag, assertSidecarChannel, ROOT, runTauri, targetFromArgs } from './lib.js';

const TAURI_DIR = path.join(ROOT, 'src-tauri');
const BASE_CONFIG = path.join(TAURI_DIR, 'tauri.dev.conf.json');
export const BUILD_CONFIG = path.join(TAURI_DIR, 'tauri.dev.build.json');
const BUNDLE_KINDS = ['nsis', 'dmg', 'appimage', 'deb'];
const LOCAL_OUT = path.join(ROOT, '.dev-build');
const PLATFORMS = ['windows', 'macos', 'linux'];

/** The CI platform name for this machine. */
export function hostPlatform(platform = process.platform) {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  return 'linux';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Recursive merge: objects merge, everything else (arrays, strings) is replaced by the overlay. */
export function mergeConfig(base, overlay) {
  const out = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? mergeConfig(base[key], value) : value;
  }
  return out;
}

/**
 * The Tauri config for a Dev build: the committed overlay plus the generated versions.
 * @param {Record<string, unknown>} base parsed src-tauri/tauri.dev.conf.json
 * @param {{ bundle: string, buildNumber: number }} versions
 * @returns {Record<string, unknown>}
 */
export function buildDevConfig(base, versions) {
  return mergeConfig(base, {
    version: versions.bundle,
    bundle: { macOS: { bundleVersion: String(versions.buildNumber) } },
  });
}

/**
 * The published name of a bundle file: the bundle version becomes the display version, "Burrow Dev"
 * becomes "Burrow-Dev" and no spaces remain.
 * @param {string} name file name as the bundler wrote it
 * @param {{ bundle: string, display: string }} versions
 * @returns {string}
 */
export function devArtifactName(name, versions) {
  return name.replaceAll(versions.bundle, versions.display).replaceAll('Burrow Dev', 'Burrow-Dev').replaceAll(' ', '-');
}

/** A published name must carry the display version and say it is a dev build. */
export function isValidDevArtifactName(name, display) {
  return name.includes(display) && /dev/i.test(name);
}

function bundleDirs(targetDir) {
  const roots = [path.join(targetDir, 'release', 'bundle')];
  if (fs.existsSync(targetDir)) {
    for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(path.join(targetDir, entry.name, 'release', 'bundle'));
    }
  }
  return roots.flatMap((root) => BUNDLE_KINDS.map((kind) => path.join(root, kind))).filter((dir) => fs.existsSync(dir));
}

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/**
 * Copies this build's bundles to `outDir` under their dev names and writes SHA256SUMS-dev-<platform>.txt.
 * Only files whose name carries this build's bundle version are taken, so stable installers and older
 * dev builds in the same target folder are never mixed in.
 * @param {{ outDir: string, platform: string, versions: { bundle: string, display: string }, targetDir?: string, log?: (m: string) => void }} opts
 * @returns {string[]} the published file names
 * @throws {Error} when nothing was produced, or a name does not say dev and carry the display version
 */
export function collectArtifacts({ outDir, platform, versions, targetDir = path.join(TAURI_DIR, 'target'), log = console.log }) {
  if (!PLATFORMS.includes(platform)) throw new Error(`--platform must be one of ${PLATFORMS.join(', ')}`);
  fs.mkdirSync(outDir, { recursive: true });
  const published = [];
  for (const dir of bundleDirs(targetDir)) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.includes(versions.bundle)) continue;
      const name = devArtifactName(entry.name, versions);
      if (!isValidDevArtifactName(name, versions.display)) {
        throw new Error(`Refusing to publish "${name}": the name must carry ${versions.display} and say dev.`);
      }
      fs.copyFileSync(path.join(dir, entry.name), path.join(outDir, name));
      published.push(name);
    }
  }
  if (published.length === 0) throw new Error(`No Burrow Dev installers for ${versions.bundle} found under src-tauri/target.`);
  const sums = published.map((name) => `${sha256(path.join(outDir, name))}  ${name}`).join('\n');
  fs.writeFileSync(path.join(outDir, `SHA256SUMS-dev-${platform}.txt`), `${sums}\n`);
  for (const name of published) log(`collected: ${path.join(outDir, name)}`);
  return published;
}

function writeConfig(versions) {
  const base = JSON.parse(fs.readFileSync(BASE_CONFIG, 'utf8'));
  fs.writeFileSync(BUILD_CONFIG, `${JSON.stringify(buildDevConfig(base, versions), null, 2)}\n`);
  console.log(`wrote ${path.relative(ROOT, BUILD_CONFIG)} (bundle version ${versions.bundle})`);
}

function flag(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const value = argv[i + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
}

function run(args, env) {
  const res = spawnSync(process.execPath, args, { cwd: ROOT, env, stdio: 'inherit', shell: false });
  if (res.status !== 0) throw new Error(`${path.basename(args[0])} ${args.slice(1).join(' ')} failed (exit ${res.status ?? 'signal'})`);
}

/** Versions from the checkout. A BURROW_DISPLAY_VERSION already in the environment (CI) must agree. */
function resolveVersions() {
  const versions = resolveDevVersions();
  const given = (process.env.BURROW_DISPLAY_VERSION ?? '').trim();
  if (given && given !== versions.display) {
    throw new Error(`BURROW_DISPLAY_VERSION (${given}) does not match this checkout (${versions.display}).`);
  }
  return versions;
}

function fullBuild(passthrough) {
  assertNoConfigFlag(passthrough);
  assertHostTarget(targetFromArgs(passthrough));
  const versions = resolveVersions();
  console.log(`Burrow Dev ${versions.display} (bundle version ${versions.bundle}, tag ${versions.tag})`);
  const env = { ...process.env, BURROW_CHANNEL: 'dev', BURROW_DISPLAY_VERSION: versions.display };
  // The Tauri v2 CLI merges config from TAURI_CONFIG, which would bypass assertNoConfigFlag.
  delete env.TAURI_CONFIG;
  run([resolveNpmCli(), 'run', 'build'], env);
  run([path.join(ROOT, 'scripts', 'desktop', 'buildSidecar.js'), '--minify', '--channel', 'dev'], env);
  run(
    [
      path.join(ROOT, 'scripts', 'checks', 'channelMarker.js'),
      '--expect', 'dev',
      '--bundle', path.join(ROOT, '.sidecar-build', 'server.cjs'),
      '--dist-dir', path.join(TAURI_DIR, 'resources', 'dist'),
    ],
    env,
  );
  writeConfig(versions);
  // The sidecar that gets packaged must be the dev one, whatever was built into src-tauri/binaries before.
  assertSidecarChannel('dev');
  runTauri(['build', '--config', path.relative(ROOT, BUILD_CONFIG), ...passthrough], env);
  const names = collectArtifacts({ outDir: LOCAL_OUT, platform: hostPlatform(), versions });
  console.log(`Burrow Dev installers: ${names.join(', ')} in ${LOCAL_OUT}`);
}

function main() {
  const argv = process.argv.slice(2);
  try {
    if (argv.includes('--write-config')) {
      writeConfig(resolveVersions());
    } else if (argv.includes('--collect')) {
      const outDir = path.resolve(flag(argv, '--collect'));
      const platform = flag(argv, '--platform') ?? hostPlatform();
      collectArtifacts({ outDir, platform, versions: resolveVersions() });
    } else {
      fullBuild(argv);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
