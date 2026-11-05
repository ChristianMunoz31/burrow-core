// Builds the Burrow server as a Node Single Executable Application (SEA) sidecar for the desktop
// shell. Flow: esbuild (ESM -> one CJS file) -> SEA blob -> inject into a copy of node.exe ->
// copy to src-tauri/binaries/burrow-server-<target-triple>.exe, plus dist/ and migrations as plain
// resource files (the exe is told where via BURROW_DIST_DIR / BURROW_MIGRATIONS_DIR).
//
// Usage: node scripts/desktop/buildSidecar.js [--minify] [--bundle-only] [--no-copy] [--target <host triple>]
//        [--node-binary <path>] [--out-triple <name>] [--channel <stable|dev>] [--display-version <v>]
// Distribution: direct (default) or store, the Microsoft Store MSIX build (scripts/release/buildStore.mjs passes
// --distribution store; the environment variable BURROW_DISTRIBUTION is NOT read here). A store bundle bakes the marker in and carries a `/*! BURROW_DISTRIBUTION=store */` line.
// Data location: appdata (default) or userprofile (--data-location userprofile, valid only with --distribution store: the data folder is
// %USERPROFILE%\Burrow Data). A userprofile bundle bakes __BURROW_DATA_LOCATION__ in and carries a `/*! BURROW_DATA_LOCATION=userprofile */` line;
// like the distribution, the environment variable is NOT read here.
// Channel: stable (default; env BURROW_CHANNEL) or dev. A dev bundle (which accepts store test purchases)
// needs --display-version (env BURROW_DISPLAY_VERSION, like 0.2.0-dev.20261005.abc1234); a stable bundle
// refuses both. Every bundle starts with a `/*! BURROW_CHANNEL=<channel> */` marker line.
// The SEA embeds the local node binary, so only the host target works; any other --target fails clearly.
// CI-only escape hatch for macOS universal builds: --node-binary injects the (host-independent) blob into
// another arch's official node binary, and --out-triple names the copied file (for example x86_64-apple-darwin).
// On Windows the exe is `burrow-server-<triple>.exe`; on macOS and Linux it has no extension. The dev channel
// gets its own name, `burrow-dev-server-<triple>`, so Burrow and Burrow Dev never share a sidecar binary (a Linux
// package installs it next to the app exe). Every copied exe is scanned for its channel marker before this exits.
// Pro module (docs/adr/0001-open-core-split.md 3.10): with pro/ checked out the bundle includes it (pro/server/static.js,
// `/*! BURROW_PRO=on */`, and dist/ must have the Pro UI chunks); without pro/ the build is a working Free build
// (`/*! BURROW_PRO=off */`, a warning, dist/ must not have Pro chunks). --require-pro, BURROW_REQUIRE_PRO=1 or
// --distribution store make a missing pro/ an error; no publish path accepts a Free build.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { inject } from 'postject';
import { assertHostTarget, hostTriple, targetFromArgs } from './lib.js';
import { checkBinaryChannel, checkBundleText, checkDistDevTools, checkDistPro, checkProMarker } from '../checks/channelMarker.js';
import { resolveGitCommit } from '../../server/runtime.js';
import { resolveBuildDataLocation, assertBuildDataLocation } from '../../server/dataLocation.js';
import { resolveBuildDistribution } from '../../server/distribution.js';
import { skipDevStamp } from './devDist.js';
import {
  BUNDLE_BANNER,
  buildBackupWorkerSource,
  buildParserWorkerSource,
  bundleDefine,
  channelBanner,
  dataLocationBanner,
  devToolsPlugin,
  distributionBanner,
  proBanner,
  proPlugin,
  readBundledBuildDate,
  resolveChannelBuild,
  resolveProBuild,
} from './workerBundle.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = path.join(ROOT, '.sidecar-build');
const BUNDLE = path.join(OUT_DIR, 'server.cjs');
const BLOB = path.join(OUT_DIR, 'sea-prep.blob');
const SEA_CONFIG = path.join(OUT_DIR, 'sea-config.json');
const IS_WIN = process.platform === 'win32';
const EXE = path.join(OUT_DIR, IS_WIN ? 'burrow-server.exe' : 'burrow-server');
const SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const TAURI_DIR = path.join(ROOT, 'src-tauri');

const args = new Set(process.argv.slice(2));
const minify = args.has('--minify');

/** Value following `--flag <value>` in argv, or null. */
function flagValue(flag) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(flag);
  if (i === -1) return null;
  const value = argv[i + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`);
  return value;
}
const nodeBinary = flagValue('--node-binary') ?? process.execPath;
const outTriple = flagValue('--out-triple');
assertHostTarget(targetFromArgs(process.argv.slice(2)));

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const channelBuild = resolveChannelBuild({
  channel: flagValue('--channel') ?? process.env.BURROW_CHANNEL ?? null,
  displayVersion: flagValue('--display-version') ?? process.env.BURROW_DISPLAY_VERSION ?? null,
  packageVersion: pkg.version,
});

// Only the flag decides: a lingering BURROW_DISTRIBUTION in the environment is ignored, so it cannot make a Store bundle.
const distribution = resolveBuildDistribution({ BURROW_DISTRIBUTION: flagValue('--distribution') ?? '' }, '--distribution');

// Same for the data location: only the flag decides, and userprofile needs the store distribution on the stable channel.
const dataLocation = resolveBuildDataLocation({ BURROW_DATA_LOCATION: flagValue('--data-location') ?? '' }, '--data-location');
assertBuildDataLocation({ dataLocation, distribution, channel: channelBuild.channel });

// Official builds (the Store build, the release scripts through BURROW_REQUIRE_PRO=1, or --require-pro) need pro/.
const requirePro = args.has('--require-pro') || process.env.BURROW_REQUIRE_PRO === '1' || distribution === 'store';
const pro = resolveProBuild({ requirePro });
if (!pro) console.warn('Building without the Pro module: Free build (BURROW_PRO=off)');

/** True when this Node has the one-step `--build-sea` flag (Node 25.5+). */
function supportsBuildSea() {
  try {
    return /--build-sea/.test(execFileSync(process.execPath, ['--help'], { encoding: 'utf8' }));
  } catch {
    return false;
  }
}

async function bundle() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // Extra esbuild passes: the backup worker as a source string, embedded in the main bundle because a
  // SEA has no worker file on disk (see server/backup/worker/client.js).
  // Fails the bundle when dist/burrow-build-info.json is missing or invalid (run npm run build first).
  const buildDate = readBundledBuildDate(path.join(ROOT, 'dist'));
  // One git call per bundle; both bundles bake the same SHA (null when git is unavailable).
  const commit = resolveGitCommit({ cwd: ROOT });
  const workerOpts = { minify, channel: channelBuild.channel, version: channelBuild.version, buildDate, commit, distribution, dataLocation, pro };
  const workerSource = await buildBackupWorkerSource(workerOpts);
  // Third bundle: the Folders PDF/DOCX parser worker (parseDocs.js), embedded the same way.
  const parserWorkerSource = await buildParserWorkerSource(workerOpts);
  const result = await build({
    entryPoints: [path.join(ROOT, 'server.js')],
    outfile: BUNDLE,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    minify,
    legalComments: 'none',
    logLevel: 'warning',
    define: {
      ...bundleDefine(channelBuild.version, { channel: channelBuild.channel, buildDate, commit, distribution, dataLocation, pro }),
      __BURROW_BACKUP_WORKER_SRC__: JSON.stringify(workerSource),
      __BURROW_PARSER_WORKER_SRC__: JSON.stringify(parserWorkerSource),
    },
    plugins: [devToolsPlugin(channelBuild.channel), proPlugin({ requirePro })],
    banner: { js: channelBanner(channelBuild.channel) + proBanner(pro) + distributionBanner(distribution) + dataLocationBanner(dataLocation) + BUNDLE_BANNER },
  });
  // Fails closed, also under --bundle-only: a stable bundle must not carry the developer tools.
  const text = fs.readFileSync(BUNDLE, 'utf8');
  const problems = [...checkBundleText(text, channelBuild.channel), ...checkProMarker(text, pro ? 'present' : 'absent')];
  if (problems.length > 0) throw new Error(`${path.basename(BUNDLE)}: ${problems.join('; ')}`);
  return result;
}

function buildSea() {
  const config = {
    main: BUNDLE,
    output: BLOB,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  };
  fs.writeFileSync(SEA_CONFIG, JSON.stringify(config, null, 2));
  if (nodeBinary === process.execPath && supportsBuildSea()) {
    fs.writeFileSync(SEA_CONFIG, JSON.stringify({ ...config, output: EXE }, null, 2));
    execFileSync(process.execPath, ['--build-sea', SEA_CONFIG], { stdio: 'inherit' });
    return Promise.resolve();
  }
  execFileSync(process.execPath, ['--experimental-sea-config', SEA_CONFIG], { stdio: 'inherit' });
  fs.copyFileSync(nodeBinary, EXE);
  fs.chmodSync(EXE, 0o755);
  const isMac = process.platform === 'darwin';
  // The official macOS node binary is signed; injecting invalidates that, so strip it and ad-hoc sign again.
  if (isMac) execFileSync('codesign', ['--remove-signature', EXE], { stdio: 'inherit' });
  return inject(EXE, 'NODE_SEA_BLOB', fs.readFileSync(BLOB), {
    sentinelFuse: SENTINEL,
    ...(isMac ? { machoSegmentName: 'NODE_SEA' } : {}),
  }).then(() => {
    if (isMac) execFileSync('codesign', ['--sign', '-', EXE], { stdio: 'inherit' });
  });
}

function copyTree(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(to), { recursive: true });
  // The desktop:dev stamp (devDist.js) never ships.
  fs.cpSync(from, to, { recursive: true, filter: skipDevStamp });
}

function copyToTauri() {
  const triple = outTriple ?? hostTriple();
  const binDir = path.join(TAURI_DIR, 'binaries');
  fs.mkdirSync(binDir, { recursive: true });
  const base = channelBuild.channel === 'dev' ? 'burrow-dev-server' : 'burrow-server';
  const target = path.join(binDir, `${base}-${triple}${triple.includes('windows') ? '.exe' : ''}`);
  fs.copyFileSync(EXE, target);
  const bytes = fs.readFileSync(target);
  const problems = [...checkBinaryChannel(bytes, channelBuild.channel), ...checkProMarker(bytes, pro ? 'present' : 'absent')];
  if (problems.length > 0) throw new Error(`${path.basename(target)}: ${problems.join('; ')}`);
  const distDir = path.join(ROOT, 'dist');
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    throw new Error('dist/index.html is missing: run `npm run build` first');
  }
  // A stable sidecar refuses a UI built with the developer tools (npm run build:devtools), and a dev one needs it.
  // The server and the UI must agree on the Pro module: a Pro sidecar needs the Pro UI chunks, a Free one refuses them.
  const uiProblems = [...checkDistDevTools(distDir, channelBuild.channel === 'dev' ? 'present' : 'absent'), ...checkDistPro(distDir, pro ? 'present' : 'absent')];
  if (uiProblems.length > 0) throw new Error(`dist/: ${uiProblems.join('; ')}`);
  copyTree(distDir, path.join(TAURI_DIR, 'resources', 'dist'));
  // The license notices of the bundled open source (unpdf / PDF.js, fflate) travel with the built UI, so they are
  // installed next to it by every packaging path that already ships resources/dist.
  fs.copyFileSync(path.join(ROOT, 'THIRD_PARTY_NOTICES.md'), path.join(TAURI_DIR, 'resources', 'dist', 'THIRD_PARTY_NOTICES.md'));
  copyTree(path.join(ROOT, 'server', 'db', 'migrations'), path.join(TAURI_DIR, 'resources', 'migrations'));
  return target;
}

const kb = (file) => `${(fs.statSync(file).size / 1024).toFixed(0)} KB`;

await bundle();
console.log(`channel: ${channelBuild.channel}, version ${channelBuild.version}, distribution: ${distribution}, data location: ${dataLocation}, pro: ${pro ? 'on' : 'off'}`);
console.log(`bundle: ${BUNDLE} (${kb(BUNDLE)})`);
if (!args.has('--bundle-only')) {
  await buildSea();
  console.log(`sea exe: ${EXE} (${kb(EXE)})`);
  if (!args.has('--no-copy')) console.log(`copied: ${copyToTauri()}`);
}
