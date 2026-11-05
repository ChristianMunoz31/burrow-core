// Builds the Microsoft Store flavor of Burrow: one .msix per architecture plus one .msixbundle, all on this PC.
// Nothing is published, uploaded or sent anywhere: the output is a folder of files for the owner to upload by hand in
// Partner Center. Usage:
//
//   npm run release:store -- [--arch arm64,x64] [--local-test [--sign-local-test]] [--out-dir <dir>]
//                            [--data-location appdata|userprofile] [--x64-node <node.exe>] [--reuse-web] [--keep-staging] [--skip-smoke] [--check]
//
//   --arch <list>        comma separated: arm64, x64 (default both). x64 is cross-built on an ARM64 PC: the sidecar
//                        is the server bundle injected into an official x64 node.exe of the SAME version as the node
//                        running this script (storeNode.mjs downloads it and accepts only the sha256 pinned in
//                        config/store-node.json, or pass --x64-node).
//   --local-test         build a test package for sideloading. It uses the real identity (Name and Publisher) from
//                        config/msstore.json, or a made-up one while that file still has PLACEHOLDER values. The
//                        result is for sideload only and must not be uploaded. Without it the build REFUSES while
//                        config/msstore.json still has PLACEHOLDER values, and it REFUSES a 0.x app version (the Store
//                        package version is x.y.z.0 and its first section cannot be 0); a local test may use a 0.x version.
//   --sign-local-test    with --local-test: create (or reuse) a self-signed certificate whose subject equals the package
//                        Publisher in the current user's store, export the public .cer next to the packages and sign
//                        every package (so it can be sideloaded). Never used for a Store upload: the Store signs it.
//   --data-location <v>  where the app keeps its data. `appdata` (default, or config/msstore.json "dataLocation"): the manifest has
//                        rescap:unvirtualizedResources and the app writes %APPDATA%\Burrow. `userprofile`: the fallback for when
//                        Partner Center refuses that capability: the manifest has neither unvirtualizedResources nor
//                        desktop6:FileSystemWriteVirtualization and the app writes %USERPROFILE%\Burrow Data (docs/MICROSOFT_STORE.md,
//                        "If Partner Center refuses unvirtualizedResources"). The output folder and every file name carry
//                        "userprofile", so the two kinds of package cannot be mixed up at upload. Without --local-test it must equal
//                        config/msstore.json "dataLocation" (the privacy page follows the config); a different value is refused.
//   --out-dir <dir>      default %LOCALAPPDATA%\burrow-release\store\<version> (-localtest for a test build, -userprofile for the
//                        userprofile data location). Must lie outside the repository.
//   --reuse-web          skip `npm run build` and use the existing dist/. Its burrow-build-info.json must be a stable build
//                        of this app version (checked for dist/ and again for src-tauri/resources/dist); dev or stale builds
//                        are refused.
//   --keep-staging       keep the staged package folders in <out-dir>\staging.
//   --skip-smoke         skip the sidecar smoke test that otherwise runs on every staged package (scripts/release/
//                        smokeSidecar.js --expect-distribution store: starts the staged burrow-server.exe on a throwaway data
//                        folder; the x64 one runs under emulation on an ARM64 PC). Only for a machine that cannot start the
//                        exe; build-summary.txt then says the smoke test was skipped. Do not upload such a build.
//   --check              only report the identity state and the tools found; build nothing.
//
// The Store flavor differs from the direct installer in exactly these ways: BURROW_DISTRIBUTION=store is baked into the
// sidecar and the shell (no in-app updater, Settings says updates come from the Store, the build identity says
// "Microsoft Store"), the Tauri exe is compiled with --no-bundle and NO updater overlay, and the output is MSIX.
// Details: docs/MICROSOFT_STORE.md, docs/RELEASING.md.
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { STORE_DISTRIBUTION_MARKER, USERPROFILE_DATA_LOCATION_MARKER, checkBinaryChannel, checkBuildInfo, checkDistDevTools, checkDistPro, checkDistribution } from '../checks/channelMarker.js';
import { PRO_MISSING_MESSAGE, assertProPresent, checkProPresent } from '../checks/proPresent.js';
import { assertStableBuildEnv, stableChildEnv } from '../desktop/build.js';
import { ROOT, assertSidecarChannel, hostTriple, sidecarBinaryPath } from '../desktop/lib.js';
import { resolveNpmCli } from '../lib/sandboxSafety.js';
import { APPDATA_SHELL_MARKER, DIRECT_SHELL_MARKER, STORE_SHELL_MARKER as SHELL_MARKER_STORE, USERPROFILE_SHELL_MARKER } from './buildInstaller.js';
import { readReleaseOverlay } from './updaterConfig.js';
import { STORE_CONFIG, placeholderFields, readStoreConfig, resolveDataLocationSetting, resolveIdentity } from './storeIdentity.mjs';
import { ARCHITECTURES, APP_EXECUTABLE, SIDECAR_EXECUTABLE, buildManifest, toStoreVersion } from './storeManifest.mjs';
import { REQUIRED_ASSETS, stageLayout } from './storeLayout.mjs';
import { assertUsableX64Node, ensureX64Node } from './storeNode.mjs';
import { ensureLocalTestCert, signFiles } from './storeSign.mjs';
import { findSdkTools } from './winSdk.mjs';

export const SUMS_NAME = 'SHA256SUMS.txt';
export const SUMMARY_NAME = 'build-summary.txt';
export const STORE_SIDECAR_MARKER = STORE_DISTRIBUTION_MARKER;
export const STORE_SHELL_MARKER = SHELL_MARKER_STORE;
export const USERPROFILE_SIDECAR_MARKER = USERPROFILE_DATA_LOCATION_MARKER;
/** Files a previous build may have left in the output folder; every build starts by removing them. */
/** Removing a staged folder can fail briefly while Windows still holds the exe that was just smoke tested (EPERM); retry. */
const RM_RETRY = { recursive: true, force: true, maxRetries: 10, retryDelay: 300 };
const STALE_OUTPUT_RE = /^(Burrow_.*\.msix|.*\.msixbundle|SHA256SUMS\.txt|build-summary\.txt|BurrowLocalTest\.cer)$/;

/**
 * @typedef {{ arches: Array<'arm64' | 'x64'>, localTest: boolean, signLocalTest: boolean, outDir: string | null,
 *   x64Node: string | null, dataLocation: string | null, reuseWeb: boolean, keepStaging: boolean, skipSmoke: boolean, check: boolean, help: boolean }} CliOptions
 */

/**
 * @param {string[]} argv
 * @returns {CliOptions}
 * @throws {Error} on an unknown flag or a combination that makes no sense
 */
export function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      arch: { type: 'string' },
      'local-test': { type: 'boolean', default: false },
      'sign-local-test': { type: 'boolean', default: false },
      'out-dir': { type: 'string' },
      'x64-node': { type: 'string' },
      'data-location': { type: 'string' },
      'reuse-web': { type: 'boolean', default: false },
      'keep-staging': { type: 'boolean', default: false },
      'skip-smoke': { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const requested = (values.arch ?? 'arm64,x64').split(',').map((a) => a.trim()).filter(Boolean);
  const unknown = requested.filter((a) => !Object.hasOwn(ARCHITECTURES, a));
  if (requested.length === 0 || unknown.length > 0) {
    throw new Error(`--arch takes a comma separated list of ${Object.keys(ARCHITECTURES).join(', ')} (got "${values.arch ?? ''}")`);
  }
  const arches = [...new Set(requested)].sort();
  if (values['sign-local-test'] && !values['local-test']) throw new Error('--sign-local-test only works with --local-test: a Store upload is never signed here');
  if (values['x64-node'] !== undefined && !arches.includes('x64')) throw new Error('--x64-node only applies when x64 is built');
  if (values['x64-node'] !== undefined && values['x64-node'].trim() === '') throw new Error('--x64-node needs a path');
  return {
    arches,
    localTest: values['local-test'],
    signLocalTest: values['sign-local-test'],
    outDir: values['out-dir'] ?? null,
    x64Node: values['x64-node'] ?? null,
    dataLocation: values['data-location'] ?? null,
    reuseWeb: values['reuse-web'],
    keepStaging: values['keep-staging'],
    skipSmoke: values['skip-smoke'],
    check: values.check,
    help: values.help,
  };
}

/**
 * An upload build must use the data location of config/msstore.json: the privacy page and the listing text follow the config,
 * so a package that keeps its data elsewhere would be described wrongly to the Store and to users. Only --local-test may differ.
 * @param {{ dataLocation: 'appdata' | 'userprofile', configDataLocation: 'appdata' | 'userprofile', localTest: boolean }} opts
 * @returns {Error | null}
 */
export function dataLocationMismatch({ dataLocation, configDataLocation, localTest }) {
  if (localTest || dataLocation === configDataLocation) return null;
  return new Error(
    `--data-location ${dataLocation} differs from ${STORE_CONFIG} dataLocation ${configDataLocation}, and the privacy page and the listing text follow the config. Set dataLocation in ${STORE_CONFIG}, run npm run privacy:render, and build again (only --local-test may differ).`,
  );
}

/** `-userprofile` for the userprofile data location, empty for appdata: the folder and file names say which kind of package it is. */
export function packageSuffix(dataLocation) {
  return dataLocation === 'userprofile' ? '-userprofile' : '';
}

/**
 * File name of one architecture's package: Burrow_<version>_<arch>.msix, Burrow_<version>_userprofile_<arch>.msix for the
 * userprofile data location.
 * @param {{ version: string, arch: string, dataLocation?: 'appdata' | 'userprofile' }} opts
 * @returns {string}
 */
export function msixName({ version, arch, dataLocation = 'appdata' }) {
  return `Burrow_${version}${dataLocation === 'userprofile' ? '_userprofile' : ''}_${arch}.msix`;
}

/** File name of the bundle: Burrow_<version>.msixbundle, Burrow_<version>_userprofile.msixbundle for the userprofile data location. */
export function bundleName({ version, dataLocation = 'appdata' }) {
  return `Burrow_${version}${dataLocation === 'userprofile' ? '_userprofile' : ''}.msixbundle`;
}

function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Where the packages go. Always outside the repository.
 * @param {{ root: string, version: string, localTest: boolean, outDir: string | null, dataLocation?: 'appdata' | 'userprofile', env?: Record<string, string | undefined> }} opts
 * @returns {string}
 */
export function resolveOutDir({ root, version, localTest, outDir, dataLocation = 'appdata', env = process.env }) {
  const base = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const dir = path.resolve(outDir ?? path.join(base, 'burrow-release', 'store', `${version}${localTest ? '-localtest' : ''}${packageSuffix(dataLocation)}`));
  if (isInside(root, dir)) throw new Error(`The output folder must be outside the repository (got ${dir})`);
  return dir;
}

/**
 * @param {string} file
 * @returns {Promise<string>} sha256 hex, streamed
 */
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * The text of SHA256SUMS.txt (`<hash>  <file>`, sorted by name).
 * @param {Array<{ name: string, sha256: string }>} entries
 * @returns {string}
 */
export function formatSums(entries) {
  return `${[...entries].sort((a, b) => a.name.localeCompare(b.name)).map((e) => `${e.sha256}  ${e.name}`).join('\n')}\n`;
}

/**
 * Throws when the compiled app is not a Store build of the wanted data location: the sidecar must carry the store marker and the
 * shell exe its own, and both must agree on `dataLocation` (the sidecar carries the userprofile marker only for userprofile; the
 * shell exe always carries burrow-data-location=<value>).
 * @param {{ sidecar: Buffer, exe: Buffer, dataLocation?: 'appdata' | 'userprofile' }} bytes
 */
export function assertStoreMarkers({ sidecar, exe, dataLocation = 'appdata' }) {
  if (!sidecar.toString('latin1').includes(STORE_SIDECAR_MARKER)) throw new Error('The sidecar is not a Store build (no distribution marker); rebuild it');
  if (!exe.toString('latin1').includes(STORE_SHELL_MARKER)) throw new Error('The app exe is not a Store build (no distribution marker); it was compiled without BURROW_DISTRIBUTION=store');
  if (exe.toString('latin1').includes(DIRECT_SHELL_MARKER)) throw new Error('The app exe carries the direct distribution marker as well; refusing a mixed build');
  const sidecarText = sidecar.toString('latin1');
  const exeText = exe.toString('latin1');
  // The shell exe always carries burrow-data-location=<value> (build.rs); an appdata build is only required to lack the other one.
  if (dataLocation === 'userprofile' && !exeText.includes(USERPROFILE_SHELL_MARKER)) throw new Error(`The app exe carries no ${USERPROFILE_SHELL_MARKER} marker; it was compiled for another data location`);
  if (dataLocation === 'userprofile' && exeText.includes(APPDATA_SHELL_MARKER)) throw new Error(`The app exe carries ${APPDATA_SHELL_MARKER} as well; refusing a mixed build`);
  if (dataLocation === 'appdata' && exeText.includes(USERPROFILE_SHELL_MARKER)) throw new Error(`The app exe carries ${USERPROFILE_SHELL_MARKER} but this build is appdata; refusing a mixed build`);
  const sidecarIsProfile = sidecarText.includes(USERPROFILE_SIDECAR_MARKER);
  if (sidecarIsProfile !== (dataLocation === 'userprofile')) {
    throw new Error(`The sidecar ${sidecarIsProfile ? 'keeps its data in the user profile folder' : 'keeps its data in %APPDATA%'} but this build is ${dataLocation}; rebuild it`);
  }
}

/**
 * The base Tauri config must not carry the updater: the Store build uses it as is.
 * @param {string} root
 * @throws {Error} when plugins.updater or updater artifacts are configured in tauri.conf.json
 */
export function assertNoUpdaterInBaseConfig(root) {
  const conf = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  if (conf?.plugins?.updater !== undefined || conf?.bundle?.createUpdaterArtifacts !== undefined) {
    throw new Error('src-tauri/tauri.conf.json configures the updater; the Store build must not');
  }
}

/**
 * Refuses a built UI that is not a stable build of this app version: `burrow-build-info.json` in each folder must be
 * valid, carry the stable channel (a dev build is refused), carry no developer tools (a `npm run build:devtools` UI is refused) and the version in package.json (a stale build is refused).
 * @param {{ dirs: string[], version: string, expectPro?: 'present' | 'absent' }} opts folders that hold a built UI (dist/, src-tauri/resources/dist); `expectPro` (default present) is the Pro chunk rule
 * @throws {Error} naming the folder and the problem
 */
export function assertWebBuild({ dirs, version, expectPro = 'present' }) {
  for (const dir of dirs) {
    const file = path.join(dir, 'burrow-build-info.json');
    let info;
    try {
      info = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw new Error(`${file} is missing or not valid JSON; run npm run build (or leave out --reuse-web)`);
    }
    // The Store build is official: its UI must carry the Pro chunks (docs/adr/0001-open-core-split.md 3.10).
    const problems = [...checkBuildInfo(info, 'stable'), ...checkDistDevTools(dir, 'absent')];
    if (problems.length === 0 && info.version !== version) problems.push(`build info version "${String(info.version)}" is not the app version ${version} (stale build)`);
    problems.push(...checkDistPro(dir, expectPro));
    if (problems.length > 0) throw new Error(`${file}: ${problems.join('; ')}. Run npm run build (or leave out --reuse-web).`);
  }
}

/**
 * Deletes what an earlier build left in the output folder (packages, bundle, sums, summary, test certificate), so the
 * folder never mixes files of two builds.
 * @param {string} outDir
 * @returns {string[]} the names removed
 */
export function removeStaleOutputs(outDir) {
  if (!fs.existsSync(outDir)) return [];
  const removed = [];
  for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
    if (entry.isFile() && STALE_OUTPUT_RE.test(entry.name)) {
      fs.rmSync(path.join(outDir, entry.name), { force: true });
      removed.push(entry.name);
    }
  }
  return removed;
}

/**
 * Deletes build leftovers that are Store builds (a sidecar in src-tauri/binaries, the bundle in .sidecar-build) and keeps
 * everything else: a file without the Store marker, for example a direct sidecar, is never touched.
 * @param {string[]} files
 * @returns {string[]} the files removed
 */
export function removeStoreArtifacts(files) {
  const removed = [];
  for (const file of files) {
    let bytes;
    try {
      bytes = fs.readFileSync(file);
    } catch {
      continue;
    }
    if (checkDistribution(bytes, 'direct').length > 0) {
      fs.rmSync(file, { force: true });
      removed.push(file);
    }
  }
  return removed;
}

/**
 * PowerShell commands that undo a sideload test with the real Publisher. Printed in build-summary.txt.
 * @param {{ identityName: string, publisher: string }} identity
 * @returns {string[]}
 */
export function cleanupCommands(identity) {
  const quoted = `'${identity.publisher.replace(/'/g, "''")}'`;
  return [
    `Get-AppxPackage -Name ${identity.identityName} | Remove-AppxPackage`,
    `Get-ChildItem Cert:\\CurrentUser\\My | Where-Object { $_.Subject -eq ${quoted} } | Remove-Item`,
    `Get-ChildItem Cert:\\LocalMachine\\TrustedPeople | Where-Object { $_.Subject -eq ${quoted} } | Remove-Item   # elevated; only if you trusted BurrowLocalTest.cer there`,
  ];
}

/**
 * The summary and --check lines that say which data location a build has. The userprofile ones are loud on purpose: that
 * package has no unvirtualizedResources capability and must be submitted without its justification text.
 * @param {'appdata' | 'userprofile'} dataLocation
 * @returns {string[]}
 */
export function describeDataLocation(dataLocation) {
  if (dataLocation === 'userprofile') {
    return [
      'Data location: USERPROFILE (the app keeps its data in %USERPROFILE%\\Burrow Data). THIS IS THE FALLBACK PACKAGE FOR WHEN PARTNER CENTER REFUSES rescap:unvirtualizedResources.',
      'Manifest: runFullTrust only; no unvirtualizedResources capability and no desktop6:FileSystemWriteVirtualization. Leave the unvirtualizedResources justification out of Submission options.',
    ];
  }
  return [
    'Data location: appdata (the app keeps its data in %APPDATA%\\Burrow).',
    'Manifest: runFullTrust and unvirtualizedResources, with desktop6:FileSystemWriteVirtualization disabled; Partner Center needs a justification for unvirtualizedResources (docs/MICROSOFT_STORE.md).',
  ];
}

/**
 * Human readable build summary.
 * @param {{ version: string, storeVersion: string, source: string, identity: { identityName: string, publisher: string },
 *   commit: string | null, built: string, outputs: Array<{ name: string, sha256: string, bytes: number }>,
 *   arches: string[], sdkVersion: string, x64Node: string | null, localTest: boolean, signed: boolean,
 *   smoke?: 'passed' | 'skipped', dataLocation?: 'appdata' | 'userprofile', configDataLocation?: 'appdata' | 'userprofile' }} s
 * @returns {string}
 */
export function formatSummary(s) {
  const lines = [
    `Burrow Microsoft Store build: app version ${s.version}, Store package version ${s.storeVersion}`,
    `Built: ${s.built}${s.commit ? `, commit ${s.commit}` : ''}`,
    `Identity: ${s.identity.identityName} / ${s.identity.publisher} (${s.source})`,
    `Architectures: ${s.arches.join(', ')}`,
    ...describeDataLocation(s.dataLocation ?? 'appdata'),
    s.configDataLocation && s.configDataLocation !== (s.dataLocation ?? 'appdata')
      ? `NOTE: ${STORE_CONFIG} says dataLocation ${s.configDataLocation}, but this build used ${s.dataLocation} (--data-location). The privacy page in pages/ and the listing text describe ${s.configDataLocation}. Set dataLocation in ${STORE_CONFIG} and run npm run privacy:render before you submit.`
      : null,
    `Windows SDK: ${s.sdkVersion}`,
    s.x64Node ? `x64 node.exe: ${s.x64Node}` : null,
    s.localTest
      ? `LOCAL TEST BUILD${s.signed ? ', self-signed with a test certificate (subject equals the Publisher)' : ', unsigned'}. FOR SIDELOAD ONLY, NOT FOR UPLOAD.`
      : 'Unsigned on purpose: the Microsoft Store signs the package after you upload the .msixbundle in Partner Center.',
    s.localTest && s.source === 'local-test'
      ? 'This test package has the same identity as the Store app: uninstall it (Remove-AppxPackage) before installing from the Store.'
      : null,
    s.localTest && s.source === 'local-test' ? '' : null,
    ...(s.localTest && s.source === 'local-test'
      ? ['Cleanup after the sideload test (PowerShell; the test certificate carries the real Publisher, so do not leave it trusted):', ...cleanupCommands(s.identity).map((c) => `  ${c}`)]
      : []),
    s.smoke === 'passed' ? `Sidecar smoke test (scripts/release/smokeSidecar.js, --expect-distribution store): passed for ${s.arches.join(', ')}.` : null,
    s.smoke === 'skipped' ? 'Sidecar smoke test: SKIPPED (--skip-smoke). Do not upload this build until it has been run.' : null,
    '',
    'Files:',
    ...s.outputs.map((o) => `  ${o.name}  ${(o.bytes / (1024 * 1024)).toFixed(1)} MiB  sha256 ${o.sha256}`),
    '',
  ];
  return lines.filter((l) => l !== null).join('\n');
}

function step(label, file, args, opts = {}) {
  console.log(`> ${label}`);
  const res = spawnSync(file, args, { cwd: ROOT, stdio: 'inherit', shell: false, windowsHide: true, ...opts });
  if (res.status !== 0) throw new Error(`${label} failed (exit ${res.status ?? 'signal'})`);
}

function node(label, args, env) {
  step(label, process.execPath, args, { env });
}

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

function makeAssets(env, workDir) {
  const iconsDir = path.join(workDir, 'icons');
  fs.rmSync(iconsDir, { recursive: true, force: true });
  const tauri = path.join(ROOT, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
  node('generate Store logos from src-tauri/icons/source.svg', [tauri, 'icon', path.join('src-tauri', 'icons', 'source.svg'), '-o', iconsDir], env);
  const assets = path.join(workDir, 'assets');
  fs.rmSync(assets, { recursive: true, force: true });
  fs.mkdirSync(assets, { recursive: true });
  for (const name of REQUIRED_ASSETS) {
    const from = path.join(iconsDir, name);
    if (!fs.existsSync(from)) throw new Error(`tauri icon did not write ${name}`);
    fs.copyFileSync(from, path.join(assets, name));
  }
  return assets;
}

/**
 * Starts the STAGED sidecar (the file that goes into the package) the way the shell does and checks it end to end:
 * ready line, desktop gate, store distribution, store_managed update check, clean exit. The UI and the migrations come
 * from the stage folder, so a wrong layout fails here. The x64 sidecar runs under emulation on an ARM64 PC.
 * @throws {Error} when the smoke test fails
 */
function smokeStaged({ arch, stageDir, version, env, dataLocation }) {
  step(
    `${arch}: smoke test the staged sidecar`,
    process.execPath,
    [
      path.join(ROOT, 'scripts', 'release', 'smokeSidecar.js'),
      '--sidecar', path.join(stageDir, SIDECAR_EXECUTABLE),
      '--resources', path.join(stageDir, 'resources'),
      '--expect-version', version,
      '--expect-distribution', 'store',
      '--expect-data-location', dataLocation,
    ],
    { env },
  );
}

/**
 * Compiles the sidecar and the shell for one architecture and returns the paths to package.
 */
function compileArch({ arch, env, x64Node, dataLocation }) {
  const triple = ARCHITECTURES[arch];
  const host = hostTriple();
  const sidecarArgs = [path.join(ROOT, 'scripts', 'desktop', 'buildSidecar.js'), '--minify', '--channel', 'stable', '--distribution', 'store', ...(dataLocation === 'userprofile' ? ['--data-location', 'userprofile'] : []), '--out-triple', triple];
  if (triple !== host) {
    if (arch !== 'x64' || !x64Node) throw new Error(`Cannot build ${arch} on a ${host} machine without a matching node.exe`);
    sidecarArgs.push('--node-binary', x64Node);
  }
  node(`${arch}: build the Store sidecar`, sidecarArgs, env);
  assertSidecarChannel('stable', { binary: sidecarBinaryPath('stable', triple), distribution: 'store', dataLocation });
  const tauri = path.join(ROOT, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
  node(`${arch}: compile the app (tauri build --no-bundle --target ${triple})`, [tauri, 'build', '--no-bundle', '--target', triple], env);
  const exe = path.join(ROOT, 'src-tauri', 'target', triple, 'release', APP_EXECUTABLE);
  const sidecar = sidecarBinaryPath('stable', triple);
  if (!fs.existsSync(exe)) throw new Error(`tauri did not produce ${exe}`);
  const sidecarBytes = fs.readFileSync(sidecar);
  const problems = checkBinaryChannel(sidecarBytes, 'stable');
  if (problems.length > 0) throw new Error(`${path.basename(sidecar)}: ${problems.join('; ')}`);
  assertStoreMarkers({ sidecar: sidecarBytes, exe: fs.readFileSync(exe), dataLocation });
  return { exe, sidecar, triple };
}

async function main(argv) {
  const opts = parseCliArgs(argv);
  if (opts.help) {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
    return;
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const version = pkg.version;
  const config = readStoreConfig(ROOT);
  const { dataLocation } = resolveDataLocationSetting({ config, cli: opts.dataLocation });
  const { dataLocation: configDataLocation } = resolveDataLocationSetting({ config });

  if (opts.check) {
    const missing = placeholderFields(config);
    console.log(`${STORE_CONFIG}: ${missing.length === 0 ? 'every owner value is filled in' : `still has placeholders for ${missing.join(', ')}`}`);
    if (missing.length === 0) console.log(`Identity: ${resolveIdentity({ config }).identity.identityName}`);
    console.log(`App version: ${version}`);
    let versionError = null;
    try {
      console.log(`Store package version: ${toStoreVersion(version, { localTest: opts.localTest })}${opts.localTest ? ' (local test only)' : ''}`);
    } catch (err) {
      versionError = err;
      console.log('Store package version: REFUSED (see below)');
    }
    console.log(`Local test identity: ${resolveIdentity({ config, localTest: true }).source === 'local-test' ? 'the real identity above' : 'made-up fallback (placeholders remain)'}`);
    const setting = resolveDataLocationSetting({ config, cli: opts.dataLocation });
    console.log(`Data location: ${setting.dataLocation} (${setting.from === 'cli' ? '--data-location' : setting.from === 'config' ? `${STORE_CONFIG} dataLocation` : 'default'})`);
    for (const line of describeDataLocation(setting.dataLocation).slice(1)) console.log(line);
    const proProblems = checkProPresent({ root: ROOT });
    console.log(`Pro module: ${proProblems.length === 0 ? 'present' : `MISSING (${proProblems.join('; ')})`}`);
    const sdk = findSdkTools();
    console.log(`Windows SDK ${sdk.sdkVersion} (${sdk.arch}): ${sdk.tools.makeappx}`);
    if (versionError) throw versionError;
    if (proProblems.length > 0) throw new Error(PRO_MISSING_MESSAGE);
    const mismatch = dataLocationMismatch({ dataLocation: setting.dataLocation, configDataLocation, localTest: opts.localTest });
    if (mismatch) throw mismatch;
    return;
  }

  // Gate on the data location and the version before anything is built: an upload build keeps the data location of
  // config/msstore.json and needs an app version of 1.0.0 or later.
  const mismatch = dataLocationMismatch({ dataLocation, configDataLocation, localTest: opts.localTest });
  if (mismatch) throw mismatch;
  const storeVersion = toStoreVersion(version, { localTest: opts.localTest });

  // The Store build is official: it includes the Pro module and never ships a Free build (BURROW_PRO=off).
  assertProPresent({ root: ROOT });

  // Gate first: no placeholder identity ever reaches a build that could be uploaded.
  const { identity, source } = resolveIdentity({ config, localTest: opts.localTest });
  const outDir = resolveOutDir({ root: ROOT, version, localTest: opts.localTest, outDir: opts.outDir, dataLocation });
  const sdk = findSdkTools();
  assertStableBuildEnv(process.env);
  assertNoUpdaterInBaseConfig(ROOT);
  if (readReleaseOverlay(ROOT)?.enabled) console.log('Note: the updater overlay is on for direct installers; the Store build never applies it.');

  const env = { ...stableChildEnv(process.env), BURROW_REQUIRE_PRO: '1', BURROW_DISTRIBUTION: 'store', ...(dataLocation === 'userprofile' ? { BURROW_DATA_LOCATION: 'userprofile' } : {}) };
  fs.mkdirSync(outDir, { recursive: true });
  const stale = removeStaleOutputs(outDir);
  if (stale.length > 0) console.log(`Removed files of an earlier build: ${stale.join(', ')}`);
  const workDir = path.join(outDir, 'work');
  const stagingRoot = path.join(outDir, 'staging');
  fs.rmSync(workDir, RM_RETRY);
  fs.rmSync(stagingRoot, RM_RETRY);
  fs.mkdirSync(workDir, { recursive: true });
  console.log(`Store build ${version} (package version ${storeVersion}, data location ${dataLocation}) -> ${outDir} (${source} identity ${identity.identityName})`);

  let x64NodePath = null;
  if (opts.arches.includes('x64') && hostTriple() !== ARCHITECTURES.x64) {
    if (opts.x64Node) {
      x64NodePath = path.resolve(opts.x64Node);
      assertUsableX64Node(x64NodePath);
    } else {
      const cacheDir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'burrow-release', 'cache');
      x64NodePath = await ensureX64Node({ cacheDir, log: (line) => console.log(line) });
    }
  }

  const distDir = path.join(ROOT, 'dist');
  const resourcesDist = path.join(ROOT, 'src-tauri', 'resources', 'dist');
  if (opts.reuseWeb) assertWebBuild({ dirs: [distDir], version });
  else node('build the web app (npm run build)', [resolveNpmCli(), 'run', 'build'], env);
  const assetsDir = makeAssets(env, workDir);

  const packages = [];
  // The Store sidecars are written into src-tauri/binaries and the Store bundle into .sidecar-build, where a direct build
  // would look. They are removed when the build ends, on failure too, but only if they are store-marked; the direct build
  // paths also refuse a store-marked sidecar (assertNoStoreSidecars). After a Store build, run npm run desktop:sidecar
  // before direct dev work.
  const storeSidecars = ['server.cjs', 'burrow-server.exe'].map((name) => path.join(ROOT, '.sidecar-build', name));
  try {
    for (const arch of opts.arches) {
      storeSidecars.push(sidecarBinaryPath('stable', ARCHITECTURES[arch]));
      const { exe, sidecar } = compileArch({ arch, env, x64Node: x64NodePath, dataLocation });
      // The sidecar build copied dist/ into src-tauri/resources/dist: both copies must be the stable build of this version.
      assertWebBuild({ dirs: [distDir, resourcesDist], version });
      const stageDir = path.join(stagingRoot, arch);
      const files = stageLayout({
        stageDir,
        exe,
        sidecar,
        distDir: resourcesDist,
        migrationsDir: path.join(ROOT, 'src-tauri', 'resources', 'migrations'),
        assetsDir,
        manifestXml: buildManifest({ identity, version, arch, localTest: opts.localTest, dataLocation }),
      });
      console.log(`${arch}: staged ${files.length} files`);
      if (!opts.skipSmoke) smokeStaged({ arch, stageDir, version, env: process.env, dataLocation });
      const msix = path.join(outDir, msixName({ version, arch, dataLocation }));
      fs.rmSync(msix, { force: true });
      step(`${arch}: makeappx pack`, sdk.tools.makeappx, ['pack', '/d', stageDir, '/p', msix, '/o']);
      packages.push({ arch, msix });
    }
  } finally {
    // Only Store builds are removed; a direct sidecar or bundle in the same place is never touched.
    removeStoreArtifacts(storeSidecars);
  }

  const bundleInput = path.join(workDir, 'bundle-input');
  fs.mkdirSync(bundleInput, { recursive: true });
  for (const { msix } of packages) fs.copyFileSync(msix, path.join(bundleInput, path.basename(msix)));
  const bundle = path.join(outDir, bundleName({ version, dataLocation }));
  fs.rmSync(bundle, { force: true });
  step('makeappx bundle', sdk.tools.makeappx, ['bundle', '/d', bundleInput, '/p', bundle, '/bv', storeVersion, '/o']);

  const artifacts = [...packages.map((p) => p.msix), bundle];
  let signed = false;
  if (opts.signLocalTest) {
    const { thumbprint, cerPath } = ensureLocalTestCert({ outDir, subject: identity.publisher });
    console.log(`Local test certificate ${identity.publisher} (${thumbprint}); public part: ${cerPath}`);
    signFiles({ signtool: sdk.tools.signtool, thumbprint, files: artifacts });
    signed = true;
  }

  const outputs = [];
  for (const file of artifacts) {
    outputs.push({ name: path.basename(file), sha256: await sha256File(file), bytes: fs.statSync(file).size });
  }
  fs.writeFileSync(path.join(outDir, SUMS_NAME), formatSums(outputs));
  fs.writeFileSync(
    path.join(outDir, SUMMARY_NAME),
    formatSummary({
      version,
      storeVersion,
      source,
      identity,
      commit: gitCommit(),
      built: new Date().toISOString(),
      outputs,
      arches: opts.arches,
      sdkVersion: sdk.sdkVersion,
      x64Node: x64NodePath,
      localTest: opts.localTest,
      signed,
      smoke: opts.skipSmoke ? 'skipped' : 'passed',
      dataLocation,
      configDataLocation,
    }),
  );
  fs.rmSync(workDir, RM_RETRY);
  if (!opts.keepStaging) fs.rmSync(stagingRoot, RM_RETRY);
  console.log(`\n${fs.readFileSync(path.join(outDir, SUMMARY_NAME), 'utf8')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
