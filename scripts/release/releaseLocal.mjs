// Release from the owner's own PC when CI is slow: builds the Windows ARM64 installer natively, takes the x64
// installer from a finished CI run (or a hand-built file), and publishes both to the PUBLIC downloads repo
// (burrow-releases) with the same result as release.yml: stable names, one SHA256SUMS.txt, the same notes, the same
// safety checks. The notes, the asset allowlist and the gh publish calls are publishPublic.js (imported, not copied).
//
// In-app updater: while the public key in src-tauri/tauri.release.conf.json is the placeholder, everything below is
// exactly as before (three public files). With a real key the build is signed (buildInstaller.js), both installers
// travel with their `.sig`, latest.json is written (updaterManifest.js), and every signature is verified against the
// public key before the plan is shown. Signing env vars (TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH,
// TAURI_SIGNING_PRIVATE_KEY_PASSWORD) reach the tauri build step only, never npm ci or any other child.
//
// Usage: npm run release:local -- [--tag vX.Y.Z] [--dry-run | --publish [--yes]] [--skip-build]
//          [--x64-from-ci <run-id> | --x64-file <path>] [--out-dir <dir>]
//   --dry-run          the DEFAULT. Checks, builds (unless --skip-build), prints the plan and the gh commands. No
//                      network writes: it only reads from GitHub (tag, CI run, x64 download).
//   --publish          really publish. Uses your gh sign-in (or RELEASES_TOKEN) and asks to confirm unless --yes.
//   --skip-build       reuse the installers already in <out-dir>/public instead of building. With --publish it is
//                      refused unless <out-dir>/build-manifest.json (written by a build here) matches HEAD, the
//                      package version and the hash of every staged file.
//   --x64-from-ci <id> download Burrow-Setup-x64.exe (and, with the updater on, Burrow-Setup-x64.exe.sig) from the
//                      private release assets of that CI run, by asset id, and check them against the sha256 lines
//                      the x64 job printed in its own log.
//   --x64-file <path>  a hand-built x64 installer. Its name must be Burrow_<version>_x64-setup.exe, it must start
//                      with MZ, and its PE version (when readable) must be the release version. With the updater on,
//                      <path>.sig (the signature tauri wrote beside it) must exist too.
//   --out-dir <dir>    where installers are staged (default %LOCALAPPDATA%\burrow-release\<tag>).
//   --tag vX.Y.Z       default is v<package.json version>. Stable only: no prerelease tags.
// The x64 installer cannot be built on this ARM64 PC by default: use --x64-from-ci, or --x64-file (docs/RELEASING.md).
import { execFile as execFileCb, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { main as channelMarker } from '../checks/channelMarker.js';
import { assertStableBuildEnv, stableChildEnv } from '../desktop/build.js';
import { assertProPresent } from '../checks/proPresent.js';
import { ROOT, hostTriple } from '../desktop/lib.js';
import { resolveNpmCli } from '../lib/sandboxSafety.js';
import { buildInstaller } from './buildInstaller.js';
import { verifyTauriSignature } from './minisign.js';
import {
  INSTALLER_ARM64,
  INSTALLER_X64,
  LATEST_JSON,
  PUBLIC_REPO,
  SIG_ARM64,
  SIG_X64,
  SUMS_FILE,
  UPDATER_SUMS_ORDER,
  publish,
  verifySums,
} from './publishPublic.js';
import { assertSigningEnv, updaterState, withoutSigningEnv } from './updaterConfig.js';
import { generateLatestJson } from './updaterManifest.js';

export const PRIVATE_REPO = 'ChristianMunoz31/burrow';
export const ARM64_TRIPLE = 'aarch64-pc-windows-msvc';
export const STRICT_TAG_RE = /^v[0-9]+\.[0-9]+\.[0-9]+$/;
export const INSTALLERS = Object.freeze([INSTALLER_X64, INSTALLER_ARM64]);
export const SIGNATURES = Object.freeze([SIG_X64, SIG_ARM64]);
export const MANIFEST_NAME = 'build-manifest.json';
export const X64_SUMS_ASSET = 'SHA256SUMS-desktop-windows-x64.txt';
export const ALLOWED_RUN_WORKFLOWS = Object.freeze(['.github/workflows/release-please.yml', '.github/workflows/release.yml']);
const RUN_ID_RE = /^[0-9]{1,20}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const RUN_SLACK_MS = 10 * 60 * 1000;
const MAX_BYTES = 1024 * 1024 * 1024;

const execFileRaw = promisify(execFileCb);
// git and gh children never see a signing variable, even when the owner has them set in this shell.
const execFile = (file, args, opts = {}) => execFileRaw(file, args, { ...opts, env: withoutSigningEnv(opts.env ?? process.env) });

/**
 * @typedef {{
 *   tag: string | null, publish: boolean, dryRun: boolean, yes: boolean, skipBuild: boolean,
 *   x64FromCi: string | null, x64File: string | null, outDir: string | null, help: boolean,
 * }} CliOptions
 */

/**
 * Parses the command line. Dry run is the default; `--publish` turns it off.
 * @param {string[]} argv
 * @returns {CliOptions}
 */
export function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      tag: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      publish: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      'skip-build': { type: 'boolean', default: false },
      'x64-from-ci': { type: 'string' },
      'x64-file': { type: 'string' },
      'out-dir': { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values['dry-run'] && values.publish) throw new Error('Choose --dry-run or --publish, not both');
  const runId = values['x64-from-ci'] ?? null;
  if (runId !== null && !RUN_ID_RE.test(runId)) throw new Error('--x64-from-ci needs a numeric run id, for example 12345678901');
  const x64File = values['x64-file'] ?? null;
  if (x64File !== null && x64File.trim() === '') throw new Error('--x64-file needs a path');
  if (runId !== null && x64File !== null) throw new Error('Choose --x64-from-ci or --x64-file, not both');
  if (values.tag !== undefined) checkTag(values.tag);
  return {
    tag: values.tag ?? null,
    publish: values.publish,
    dryRun: !values.publish,
    yes: values.yes,
    skipBuild: values['skip-build'],
    x64FromCi: runId,
    x64File,
    outDir: values['out-dir'] ?? null,
    help: values.help,
  };
}

/**
 * A local release is stable only: vX.Y.Z, never a prerelease or a -dev tag.
 * @param {string} tag
 * @returns {string}
 */
export function checkTag(tag) {
  if (typeof tag !== 'string' || !STRICT_TAG_RE.test(tag)) {
    throw new Error(`Tag "${String(tag)}" is not a stable release tag. Use vX.Y.Z (no prerelease suffix; prereleases go through CI).`);
  }
  return tag;
}

/**
 * package.json must say exactly the version the tag names.
 * @param {string} pkgVersion
 * @param {string} tag
 */
export function checkVersion(pkgVersion, tag) {
  checkTag(tag);
  if (pkgVersion !== tag.slice(1)) throw new Error(`package.json version ${String(pkgVersion)} does not match the tag ${tag}`);
}

/**
 * The environment must not ask for a dev build.
 * @param {Record<string, string | undefined>} env
 */
export function checkEnv(env) {
  const channel = (env.BURROW_CHANNEL ?? '').trim();
  const display = (env.BURROW_DISPLAY_VERSION ?? '').trim();
  if (channel !== '' && channel !== 'stable') throw new Error(`BURROW_CHANNEL is "${channel}". Unset it (or set it to stable) before a release.`);
  if (display !== '') throw new Error('BURROW_DISPLAY_VERSION is set. Unset it: it is for Burrow Dev builds only.');
}

/**
 * @param {Buffer | Uint8Array | string} bytes the first bytes of a file
 * @returns {boolean} true when they start with the Windows executable magic "MZ"
 */
export function hasMzHeader(bytes) {
  return Buffer.from(bytes).subarray(0, 2).toString('latin1') === 'MZ';
}

/**
 * The staged installer names must be exactly the two stable names (plus their two `.sig` files when the updater is
 * on) and none may mention "dev".
 * @param {string[]} names
 * @param {{ updater?: boolean }} [opts]
 */
export function checkInstallerNames(names, { updater = false } = {}) {
  for (const name of names) {
    if (/dev/i.test(name)) throw new Error(`Installer name "${name}" contains "dev": a dev build must never be released`);
  }
  const wanted = updater ? [...INSTALLERS, ...SIGNATURES] : INSTALLERS;
  const missing = wanted.filter((n) => !names.includes(n));
  if (missing.length > 0) throw new Error(`Missing installer(s): ${missing.join(', ')}`);
  const extra = names.filter((n) => !wanted.includes(n));
  if (extra.length > 0) throw new Error(`Unexpected file(s) next to the installers: ${extra.join(', ')}`);
}

/**
 * Every installer must be at least as new as the commit being released, so a stale build is never published.
 * @param {{ name: string, mtimeMs: number }[]} files
 * @param {number} headCommitMs commit time of HEAD in milliseconds
 */
export function checkNotOlderThanHead(files, headCommitMs) {
  for (const f of files) {
    if (f.mtimeMs < headCommitMs) {
      throw new Error(`${f.name} is older than the release commit (${new Date(f.mtimeMs).toISOString()} < ${new Date(headCommitMs).toISOString()}). Rebuild it.`);
    }
  }
}

/**
 * SHA256SUMS.txt in the standard `<hash>  <name>` format (two spaces, no binary marker), in the same order as
 * CI (x64, then arm64; with the updater on also x64 sig, arm64 sig, latest.json), one trailing newline.
 * @param {{ name: string, sha256: string }[]} entries
 * @param {{ updater?: boolean }} [opts]
 * @returns {string}
 */
export function formatSums(entries, { updater = false } = {}) {
  const order = updater ? UPDATER_SUMS_ORDER : INSTALLERS;
  const byName = new Map(entries.map((e) => [e.name, e.sha256]));
  const lines = order.map((name) => {
    const hash = byName.get(name);
    if (typeof hash !== 'string' || !SHA256_RE.test(hash)) throw new Error(`No valid sha256 for ${name}`);
    return `${hash}  ${name}`;
  });
  if (entries.some((e) => !order.includes(e.name))) {
    throw new Error(updater ? 'Only the two installers, their signatures and latest.json go in SHA256SUMS.txt' : 'Only the two installers go in SHA256SUMS.txt');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Checks a `gh run view --json status,conclusion,headSha,jobs,createdAt,updatedAt` result: the run finished, ran
 * on the release commit, its `assets` job (the npm test run) succeeded, and so did its Windows x64 job.
 * @param {{ status?: string, headSha?: string, jobs?: { name?: string, conclusion?: string }[] }} run
 * @param {{ tagSha: string }} opts
 */
export function checkCiRun(run, { tagSha }) {
  if (run?.status !== 'completed') throw new Error(`That CI run is ${String(run?.status ?? 'unknown')}, not completed. Wait for it to finish.`);
  if (run.headSha !== tagSha) throw new Error(`That CI run built ${String(run.headSha).slice(0, 7)}, not the release commit ${tagSha.slice(0, 7)}`);
  const jobs = run.jobs ?? [];
  const tests = jobs.find((j) => /(?:^|\/\s*)assets$/.test(j?.name ?? ''));
  if (!tests) throw new Error('That CI run has no "assets" job (the one that runs npm test). Is it a release.yml run?');
  if (tests.conclusion !== 'success') throw new Error(`The "assets" job (npm test) of that run ended as "${String(tests.conclusion)}"`);
  const job = jobs.find((j) => /Windows x64/.test(j?.name ?? ''));
  if (!job) throw new Error('That CI run has no "Windows x64" job. Is it a release.yml run with desktop builds?');
  if (job.conclusion !== 'success') throw new Error(`The Windows x64 job of that run ended as "${String(job.conclusion)}"`);
}

/** release.yml `assets` (npm test), ci.yml PR/manual `verify`, or the three ci.yml push-to-main unit test shards. */
export const CI_SHARDS = Object.freeze(['main-unit (1/3)', 'main-unit (2/3)', 'main-unit (3/3)']);
export const CI_PASS_JOBS = Object.freeze(['assets', 'verify', ...CI_SHARDS]);

/**
 * Checks a `gh api repos/<repo>/commits/<sha>/check-runs` result: for any `--publish`, the release commit itself must
 * have passing tests: the release.yml `assets` job, the ci.yml `verify` job, or all three `main-unit` shards of the
 * ci.yml main run. The newest run of each job name counts, so a green rerun fixes a red first attempt and a red rerun
 * cancels an earlier green one. It does not look at the x64 build: that is only checked on the --x64-from-ci path.
 * @param {{ check_runs?: { name?: string, status?: string, conclusion?: string | null, completed_at?: string | null, started_at?: string | null }[] }} result
 * @param {{ tagSha: string }} opts
 */
export function checkCommitCi(result, { tagSha }) {
  const runs = Array.isArray(result?.check_runs) ? result.check_runs : [];
  const newest = new Map();
  for (const r of runs) {
    const name = String(r?.name ?? '').replace(/^.*\s\/\s/, '').trim();
    if (!CI_PASS_JOBS.includes(name)) continue;
    const at = Date.parse(r.completed_at ?? r.started_at ?? '') || 0;
    const prev = newest.get(name);
    if (!prev || at >= prev.at) newest.set(name, { at, status: r.status, conclusion: r.conclusion });
  }
  if (newest.size === 0) {
    throw new Error(`No CI run for the release commit ${tagSha.slice(0, 7)} has a "assets", "verify" or "main-unit" job. Wait for CI on the tag commit to finish, then try again.`);
  }
  const ok = (name) => newest.get(name)?.status === 'completed' && newest.get(name)?.conclusion === 'success';
  if (ok('assets') || ok('verify') || CI_SHARDS.every(ok)) return;
  const states = [...newest.entries()].map(([n, r]) => `${n}: ${String(r.conclusion ?? r.status)}`).join(', ');
  throw new Error(`CI has not passed on the release commit ${tagSha.slice(0, 7)} (${states}). Publishing is refused.`);
}

/**
 * The run must come from one of the two release workflows. `path` is `gh api repos/<repo>/actions/runs/<id>` .path
 * (GitHub may append `@<ref>`).
 * @param {{ path?: string }} runApi
 */
export function checkRunWorkflow(runApi) {
  const p = String(runApi?.path ?? '').replace(/@.*$/, '');
  if (!ALLOWED_RUN_WORKFLOWS.includes(p)) {
    throw new Error(`That run is of the workflow "${p || 'unknown'}", not ${ALLOWED_RUN_WORKFLOWS.join(' or ')}`);
  }
}

/**
 * The private release asset must have been uploaded by that run (inside its time window), so a later run cannot
 * have replaced it unnoticed.
 * @param {{ name?: string, updatedAt?: string }} asset
 * @param {{ createdAt?: string, updatedAt?: string }} run
 */
export function checkAssetFromRun(asset, run) {
  const at = Date.parse(asset?.updatedAt ?? '');
  const from = Date.parse(run?.createdAt ?? '');
  const to = Date.parse(run?.updatedAt ?? '');
  if (![at, from, to].every(Number.isFinite)) throw new Error('Could not read the upload time of the x64 asset or the run times');
  if (at < from || at > to + RUN_SLACK_MS) {
    throw new Error(`${String(asset?.name)} on the private release was not uploaded by that run (uploaded ${asset.updatedAt}). Pass the run id that built it.`);
  }
}

/**
 * The sha256 the x64 job printed in its own log (`sha256sum --text` output: `<hash>  Burrow-Setup-x64.exe`). A
 * runner that was compromised after that line was written cannot change the log.
 * @param {string} logText output of `gh run view <run> --log --job <job id>`
 * @param {string} name installer name
 * @returns {string} the sha256 (lower case)
 */
export function parseLogHash(logText, name) {
  const re = new RegExp(`(?:^|[\\s\\t])([0-9a-fA-F]{64})[ \\t]+\\*?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`, 'gm');
  const found = new Set([...String(logText).matchAll(re)].map((m) => m[1].toLowerCase()));
  if (found.size === 0) throw new Error(`The x64 job log has no sha256 line for ${name}`);
  if (found.size > 1) throw new Error(`The x64 job log lists different sha256 values for ${name}`);
  return [...found][0];
}

/**
 * A hand-built x64 installer must be named exactly like the Tauri output for this version.
 * @param {string} file
 * @param {string} version
 */
export function checkX64FileName(file, version) {
  const expected = `Burrow_${version}_x64-setup.exe`;
  const base = path.basename(file);
  if (base !== expected) throw new Error(`--x64-file must be named ${expected} (the name Tauri gives it), not ${base}`);
}

/**
 * Compares the PE ProductVersion of a hand-built installer with the release version. A null/empty value (the
 * resource could not be read) is not an error here: the caller logs it.
 * @param {string | null} found
 * @param {string} version
 * @returns {boolean} true when it was checked and matched, false when it could not be read
 */
export function checkPeVersion(found, version) {
  const v = String(found ?? '').trim();
  if (v === '') return false;
  if (v !== version && !v.startsWith(`${version}.`)) throw new Error(`The x64 installer says it is version ${v}, not ${version}`);
  return true;
}

export async function readPeVersion(file) {
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', '[System.Diagnostics.FileVersionInfo]::GetVersionInfo($env:BURROW_PE_FILE).ProductVersion',
    ], { env: { ...withoutSigningEnv(process.env), BURROW_PE_FILE: file } });
    return String(stdout).trim();
  } catch {
    return null;
  }
}

/**
 * The record of what a build here produced, written next to the staged installers.
 * @param {{
 *   commit: string, version: string, tag: string,
 *   installers: { name: string, arch: string, originalName: string, sha256: string, source: string, sig?: { name: string, sha256: string } }[],
 * }} input `sig` is the updater signature file of that installer (only when the updater is on)
 */
export function buildManifest({ commit, version, tag, installers }) {
  return {
    schema: 1,
    tag,
    version,
    commit,
    builtAt: new Date().toISOString(),
    installers: Object.fromEntries(installers.map((i) => [i.arch, { name: i.name, originalName: i.originalName, sha256: i.sha256, source: i.source, ...(i.sig ? { sig: { name: i.sig.name, sha256: i.sig.sha256 } } : {}) }])),
  };
}

/**
 * What is wrong between a build manifest and the files staged now. Empty means it is tied to this commit.
 * @param {unknown} manifest parsed JSON, or null when there is none
 * @param {{ commit: string, version: string, hashes: { name: string, sha256: string }[], skip?: string[] }} now
 *   `skip` lists installer names whose hash is checked some other way (a fresh CI download or --x64-file)
 * @returns {string[]}
 */
export function manifestProblems(manifest, { commit, version, hashes, skip = [] }) {
  if (manifest === null || typeof manifest !== 'object') return [`there is no ${MANIFEST_NAME} (it is written by a build made with this script)`];
  const m = /** @type {Record<string, any>} */ (manifest);
  const problems = [];
  if (m.commit !== commit) problems.push(`${MANIFEST_NAME} was made for commit ${String(m.commit).slice(0, 7)}, HEAD is ${commit.slice(0, 7)}`);
  if (m.version !== version) problems.push(`${MANIFEST_NAME} is for version ${String(m.version)}, package.json says ${version}`);
  const slots = { [INSTALLER_X64]: ['x64', false], [INSTALLER_ARM64]: ['arm64', false], [SIG_X64]: ['x64', true], [SIG_ARM64]: ['arm64', true] };
  for (const { name, sha256 } of hashes) {
    if (skip.includes(name) || !slots[name]) continue;
    const [arch, isSig] = slots[name];
    const installer = m.installers?.[arch];
    const entry = isSig ? installer?.sig : installer;
    if (!entry || entry.name !== name) problems.push(`${MANIFEST_NAME} has no entry for ${name}`);
    else if (entry.sha256 !== sha256) problems.push(`${name} is not the file that was built (sha256 differs from ${MANIFEST_NAME})`);
  }
  return problems;
}

const shortHash = (h) => `${h.slice(0, 16)}...`;

/**
 * The plan printed before anything is published.
 * @param {{
 *   tag: string, commit: string, publish: boolean, outDir: string,
 *   sources: { x64: string, arm64: string },
 *   files: { name: string, size: number, sha256?: string }[],
 * }} input
 * @returns {string[]} lines
 */
export function renderPlan({ tag, commit, publish: isPublish, outDir, sources, files }) {
  const lines = [
    'Burrow release:local',
    `  tag      ${tag} (commit ${commit.slice(0, 7)})`,
    `  mode     ${isPublish ? 'PUBLISH (real upload to the public repo)' : 'DRY RUN (no network writes; add --publish to upload)'}`,
    `  target   ${PUBLIC_REPO}, full release marked latest`,
    `  x64      ${sources.x64}`,
    `  arm64    ${sources.arm64}`,
    `  folder   ${outDir}`,
    'Files:',
  ];
  for (const f of files) lines.push(`  ${f.name}  ${f.size} bytes${f.sha256 ? `  sha256 ${shortHash(f.sha256)}` : ''}`);
  return lines;
}

const sha256Bytes = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const sha256File = (file) => sha256Bytes(fs.readFileSync(file));

function readHead(file, n = 2) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, 0);
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Runs the stable channel checks on the build artifacts that exist (bundle, resources, sidecar binaries).
 * @param {string} root
 * @param {(argv: string[]) => number} run channelMarker main
 * @returns {{ checked: boolean }} checked is false when there are no build artifacts to look at
 */
export function checkChannelArtifacts(root, run = channelMarker) {
  const bundle = path.join(root, '.sidecar-build', 'server.cjs');
  const dist = path.join(root, 'src-tauri', 'resources', 'dist');
  const binDir = path.join(root, 'src-tauri', 'binaries');
  const names = fs.existsSync(binDir) ? fs.readdirSync(binDir) : [];
  const dev = names.filter((n) => n.startsWith('burrow-dev-server-'));
  if (dev.length > 0) throw new Error(`A dev sidecar is present: ${dev.join(', ')}. Remove it and rebuild.`);
  const bins = names.filter((n) => n.startsWith('burrow-server-'));
  const argv = ['--expect', 'stable', '--expect-distribution', 'direct'];
  if (fs.existsSync(bundle)) argv.push('--bundle', bundle);
  if (fs.existsSync(dist)) argv.push('--dist-dir', dist);
  for (const b of bins) argv.push('--binary', path.join(binDir, b));
  if (argv.length === 4) return { checked: false };
  if (run(argv) !== 0) throw new Error('The stable channel check failed (see the lines above)');
  return { checked: true };
}

/**
 * @typedef {{
 *   env?: Record<string, string | undefined>,
 *   root?: string,
 *   exec?: (file: string, args: string[], opts?: object) => Promise<{ stdout: string | Buffer, stderr: string | Buffer }>,
 *   step?: (file: string, args: string[], opts: { cwd: string, env: Record<string, string | undefined> }) => void,
 *   log?: (line: string) => void,
 *   confirm?: (question: string) => Promise<boolean>,
 *   publishFn?: typeof publish,
 *   hostTripleFn?: () => string,
 *   updater?: { enabled: boolean, pubkey?: string | null },
 *   arch?: string,
 *   channelRun?: (argv: string[]) => number,
 *   peVersion?: (file: string) => Promise<string | null>,
 *   gumroadFn?: (opts: object, deps: object) => Promise<unknown>,
 *   proCheck?: (opts: { root: string }) => void,
 * }} Deps
 * `proCheck` (default assertProPresent, docs/adr/0001-open-core-split.md 3.10) refuses a checkout without the Pro module.
 */

export async function defaultConfirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function defaultStep(file, args, { cwd, env }) {
  const res = spawnSync(file, args, { cwd, env, stdio: 'inherit', shell: false });
  if (res.status !== 0) throw new Error(`${path.basename(file)} ${args.slice(0, 3).join(' ')} failed (exit ${res.status ?? 'signal'})`);
}

/**
 * Builds the ARM64 installer natively, with the same steps as desktop-windows.yml: npm ci, web build, sidecar,
 * channel checks, sidecar smoke test (blocking), then buildInstaller.js (`tauri build --bundles nsis`; signed and
 * self-verified when the updater is on). Only that last step sees the signing variables.
 * @returns {{ installer: string, sig: string | null }} paths of the NSIS installer and of its `.sig`
 */
function buildArm64({ root, env, step, version, hostTripleFn, arch, channelRun }) {
  const host = hostTripleFn();
  if (host !== ARM64_TRIPLE || arch !== 'arm64') {
    throw new Error(`release:local builds the ARM64 installer natively. This machine is ${host} (node ${arch}). Run it on the ARM64 PC, or use --skip-build.`);
  }
  assertStableBuildEnv(env);
  // BURROW_REQUIRE_PRO=1: the web build and the sidecar fail without pro/ (docs/adr/0001-open-core-split.md 3.10).
  const childEnv = { ...withoutSigningEnv(stableChildEnv(env)), BURROW_REQUIRE_PRO: '1' };
  const node = (args) => step(process.execPath, args, { cwd: root, env: childEnv });
  const npm = resolveNpmCli();
  // Clean install first: the build must use exactly the locked dependencies, not whatever is in node_modules.
  node([npm, 'ci']);
  node([npm, 'run', 'build']);
  node([npm, 'run', 'desktop:sidecar']);
  node([path.join(root, 'scripts', 'license', 'writeBuildInfo.js'), '--check', '--dist-dir', path.join(root, 'src-tauri', 'resources', 'dist')]);
  checkChannelArtifacts(root, channelRun);
  node([
    path.join(root, 'scripts', 'release', 'smokeSidecar.js'),
    '--sidecar', path.join(root, 'src-tauri', 'binaries', `burrow-server-${ARM64_TRIPLE}.exe`),
    '--resources', path.join(root, 'src-tauri', 'resources'),
    '--expect-version', version,
  ]);
  const built = buildInstaller({ root, env, step });
  const expected = `Burrow_${version}_arm64-setup.exe`;
  if (path.basename(built.installer) !== expected) {
    throw new Error(`Expected exactly ${expected} in ${path.dirname(built.installer)}, found: ${path.basename(built.installer)}`);
  }
  return built;
}

/**
 * Resolves a tag to the commit it points at. Annotated tags are dereferenced (the ref points at a tag object).
 * @returns {Promise<string>}
 */
async function resolveTagCommit(exec, tag) {
  const ghJson = async (args) => JSON.parse(String((await exec('gh', args)).stdout));
  const ref = await ghJson(['api', `repos/${PRIVATE_REPO}/git/ref/tags/${tag}`]);
  let object = ref?.object;
  for (let depth = 0; object?.type === 'tag' && depth < 5; depth += 1) {
    object = (await ghJson(['api', `repos/${PRIVATE_REPO}/git/tags/${object.sha}`]))?.object;
  }
  if (object?.type !== 'commit' || typeof object.sha !== 'string') throw new Error(`The tag ${tag} does not point at a commit`);
  return object.sha;
}

const ghBinary = async (exec, args) => {
  const res = await exec('gh', args, { encoding: 'buffer', maxBuffer: MAX_BYTES });
  return Buffer.isBuffer(res.stdout) ? res.stdout : Buffer.from(String(res.stdout), 'latin1');
};

/**
 * Downloads the x64 installer from the private release assets of a finished CI run, by asset id, and verifies it
 * three ways: the checksum asset the build job attached, the sha256 line the x64 job printed in its own log, and
 * a second read of the release proving the asset (id and updated_at) did not change while downloading.
 * With the updater on, the `.sig` asset goes through the same three checks.
 * @returns {Promise<{ file: string, sha256: string, assetId: number, sigFile: string | null }>} path and sha256 of the verified installer
 */
async function downloadX64({ runId, tag, tagSha, outDir, exec, log, updater }) {
  const ghJson = async (args) => JSON.parse(String((await exec('gh', args)).stdout));
  const run = await ghJson(['run', 'view', runId, '-R', PRIVATE_REPO, '--json', 'status,conclusion,headSha,jobs,createdAt,updatedAt']);
  checkCiRun(run, { tagSha });
  checkRunWorkflow(await ghJson(['api', `repos/${PRIVATE_REPO}/actions/runs/${runId}`]));
  const x64Job = (run.jobs ?? []).find((j) => /Windows x64/.test(j?.name ?? ''));
  const jobId = String(x64Job?.databaseId ?? '');
  if (!RUN_ID_RE.test(jobId)) throw new Error('Could not read the id of the Windows x64 job');

  const readAssets = async () => {
    const release = await ghJson(['api', `repos/${PRIVATE_REPO}/releases/tags/${tag}`]);
    const pick = (name) => {
      const a = (release.assets ?? []).find((x) => x.name === name);
      if (!a) throw new Error(`The private release ${tag} has no ${name} asset`);
      if (!Number.isInteger(a.id)) throw new Error(`The asset ${name} has no numeric id`);
      return { id: a.id, name: a.name, updatedAt: a.updated_at };
    };
    return { installer: pick(INSTALLER_X64), sums: pick(X64_SUMS_ASSET), ...(updater.enabled ? { sig: pick(SIG_X64) } : {}) };
  };
  const before = await readAssets();
  checkAssetFromRun(before.installer, run);
  checkAssetFromRun(before.sums, run);
  if (before.sig) checkAssetFromRun(before.sig, run);

  const fetchAsset = (asset) => ghBinary(exec, ['api', '-H', 'Accept: application/octet-stream', `repos/${PRIVATE_REPO}/releases/assets/${asset.id}`]);
  const installerBytes = await fetchAsset(before.installer);
  const sumsBytes = await fetchAsset(before.sums);
  const sigBytes = before.sig ? await fetchAsset(before.sig) : null;
  const after = await readAssets();
  for (const key of /** @type {const} */ (['installer', 'sums', ...(before.sig ? ['sig'] : [])])) {
    if (after[key].id !== before[key].id || after[key].updatedAt !== before[key].updatedAt) {
      throw new Error(`${before[key].name} on the private release changed while it was being downloaded. Nothing was staged; start again.`);
    }
  }

  const sha256 = sha256Bytes(installerBytes);
  const sigSha256 = sigBytes ? sha256Bytes(sigBytes) : null;
  verifySums(sumsBytes.toString('utf8'), { [INSTALLER_X64]: sha256, ...(sigSha256 ? { [SIG_X64]: sigSha256 } : {}) });
  const logText = String((await exec('gh', ['run', 'view', runId, '-R', PRIVATE_REPO, '--log', '--job', jobId])).stdout);
  if (parseLogHash(logText, INSTALLER_X64) !== sha256) {
    throw new Error(`${INSTALLER_X64} does not match the sha256 the x64 job printed in its own log. Do not publish it.`);
  }
  if (sigSha256 && parseLogHash(logText, SIG_X64) !== sigSha256) {
    throw new Error(`${SIG_X64} does not match the sha256 the x64 job printed in its own log. Do not publish it.`);
  }

  const dl = path.join(outDir, 'dl-x64');
  fs.rmSync(dl, { recursive: true, force: true });
  fs.mkdirSync(dl, { recursive: true });
  const file = path.join(dl, INSTALLER_X64);
  fs.writeFileSync(file, installerBytes);
  fs.utimesSync(file, new Date(), new Date());
  let sigFile = null;
  if (sigBytes) {
    sigFile = path.join(dl, SIG_X64);
    fs.writeFileSync(sigFile, sigBytes);
  }
  log(`Downloaded ${INSTALLER_X64}${sigFile ? ` and ${SIG_X64}` : ''} (asset ${before.installer.id}) from the private release (CI run ${runId}); the checksum asset and the job log agree`);
  return { file, sha256, assetId: before.installer.id, sigFile };
}

/**
 * Validates a hand-built x64 installer: name, MZ header, not older than the release commit, and the PE version.
 * @returns {Promise<string>} the sha256
 */
async function checkHandBuiltX64({ file, version, headCommitMs, peVersion, log, updater }) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`--x64-file ${file} is not a file`);
  checkX64FileName(file, version);
  if (updater.enabled && (!fs.existsSync(`${file}.sig`) || !fs.statSync(`${file}.sig`).isFile())) {
    throw new Error(`The updater is on, so --x64-file needs its signature beside it: ${file}.sig (build it with: node scripts/release/buildInstaller.js --target x86_64-pc-windows-msvc, docs/RELEASING.md)`);
  }
  if (!hasMzHeader(readHead(file))) throw new Error(`${path.basename(file)} is not a Windows executable (missing the MZ header)`);
  checkNotOlderThanHead([{ name: path.basename(file), mtimeMs: fs.statSync(file).mtimeMs }], headCommitMs);
  const found = await peVersion(file);
  if (checkPeVersion(found, version)) log(`The PE version of ${path.basename(file)} is ${String(found).trim()} (matches ${version})`);
  else log('Warning: the PE version resource of the x64 installer could not be read, so only its name and header were checked.');
  return sha256File(file);
}

/**
 * Runs the whole flow. Every outside effect (git, gh, builds, prompt, publish) is injected.
 * @param {CliOptions} opts
 * @param {Deps} [deps]
 * @returns {Promise<{ outDir: string, publicDir: string, published: boolean }>}
 */
export async function runRelease(opts, deps = {}) {
  const {
    env = process.env,
    root = ROOT,
    exec = execFile,
    step = defaultStep,
    log = (line) => console.log(line),
    confirm = defaultConfirm,
    publishFn = publish,
    hostTripleFn = hostTriple,
    updater: updaterDep,
    arch = process.arch,
    channelRun = channelMarker,
    peVersion = readPeVersion,
    gumroadFn = async (o, d) => (await import('./syncGumroad.mjs')).runSync(o, d),
    proCheck = assertProPresent,
  } = deps;
  const git = async (...args) => String((await exec('git', args, { cwd: root })).stdout).trim();

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const tag = opts.tag ?? `v${pkg.version}`;
  checkVersion(pkg.version, tag);
  checkEnv(env);
  // An official release includes the Pro module: a Free build (BURROW_PRO=off) is never built or published here.
  proCheck({ root });
  const updater = updaterDep ?? updaterState(root);
  // Fail before any download or build when the updater is on and this shell cannot sign.
  if (updater.enabled && !opts.skipBuild) assertSigningEnv(env, { root });

  if ((await git('status', '--porcelain')) !== '') throw new Error('The worktree is not clean. Commit or stash your changes first.');
  const head = await git('rev-parse', 'HEAD');
  let tagSha;
  try {
    tagSha = await resolveTagCommit(exec, tag);
  } catch {
    throw new Error(`Could not find the tag ${tag} in ${PRIVATE_REPO}. Is gh signed in (gh auth status) and has release-please made the tag?`);
  }
  if (tagSha !== head) throw new Error(`HEAD (${head.slice(0, 7)}) is not the commit of ${tag} (${tagSha.slice(0, 7)}). Check out the tag first.`);
  const headCommitMs = Number(await git('log', '-1', '--format=%ct', 'HEAD')) * 1000;
  if (opts.publish) {
    let checkRuns;
    try {
      checkRuns = JSON.parse(String((await exec('gh', ['api', `repos/${PRIVATE_REPO}/commits/${tagSha}/check-runs?per_page=100`])).stdout));
    } catch {
      throw new Error(`Could not read the CI check runs of ${tagSha.slice(0, 7)} in ${PRIVATE_REPO}. Publishing needs a passing CI run on the tag commit.`);
    }
    checkCommitCi(checkRuns, { tagSha });
    log(`CI passed on the release commit ${tagSha.slice(0, 7)}.`);
    if (opts.x64File) log('Warning: the x64 installer is hand-built (--x64-file), so its CI build is not checked. --x64-from-ci is preferred.');
  }

  if (!opts.x64FromCi && !opts.x64File && !opts.skipBuild) {
    throw new Error('x64 has no source. Pass --x64-from-ci <run-id> or --x64-file <path>.');
  }
  let token = null;
  if (opts.publish) {
    token = (env.RELEASES_TOKEN ?? '').trim();
    if (!token) {
      try {
        token = String((await exec('gh', ['auth', 'token'])).stdout).trim();
      } catch {
        throw new Error('gh is not signed in. Run gh auth login, or set RELEASES_TOKEN, then try again.');
      }
    }
    if (!token) throw new Error('No GitHub token available. Run gh auth login first.');
  }

  const outDir = path.resolve(opts.outDir ?? path.join(env.LOCALAPPDATA ?? os.tmpdir(), 'burrow-release', tag));
  const publicDir = path.join(outDir, 'public');
  const manifestFile = path.join(outDir, MANIFEST_NAME);
  fs.mkdirSync(publicDir, { recursive: true });
  const sources = { x64: '', arm64: '' };
  const originals = { x64: INSTALLER_X64, arm64: INSTALLER_ARM64 };
  /** The hash of the x64 installer when it was fetched or checked, compared again once it is staged. */
  let x64Kept = null;

  if (opts.x64FromCi) {
    const got = await downloadX64({ runId: opts.x64FromCi, tag, tagSha, outDir, exec, log, updater });
    fs.copyFileSync(got.file, path.join(publicDir, INSTALLER_X64));
    if (got.sigFile) fs.copyFileSync(got.sigFile, path.join(publicDir, SIG_X64));
    x64Kept = got.sha256;
    sources.x64 = `downloaded from the private release assets of CI run ${opts.x64FromCi} (asset ${got.assetId}; checksum asset and job log verified)`;
  } else if (opts.x64File) {
    const file = path.resolve(opts.x64File);
    x64Kept = await checkHandBuiltX64({ file, version: pkg.version, headCommitMs, peVersion, log, updater });
    fs.copyFileSync(file, path.join(publicDir, INSTALLER_X64));
    if (updater.enabled) fs.copyFileSync(`${file}.sig`, path.join(publicDir, SIG_X64));
    originals.x64 = path.basename(file);
    sources.x64 = `hand-built, from ${file} (name, MZ header and PE version checked)`;
  } else {
    sources.x64 = `reused from ${publicDir} (--skip-build), not built here`;
  }
  if (opts.skipBuild) {
    sources.arm64 = `reused from ${publicDir} (--skip-build)`;
  } else {
    const built = buildArm64({ root, env, step, version: pkg.version, hostTripleFn, arch, channelRun });
    fs.copyFileSync(built.installer, path.join(publicDir, INSTALLER_ARM64));
    if (built.sig) fs.copyFileSync(built.sig, path.join(publicDir, SIG_ARM64));
    originals.arm64 = path.basename(built.installer);
    sources.arm64 = 'built natively on this PC (npm ci, sidecar smoke test passed)';
    // The build must not have changed any tracked file, or what was built is not the tagged commit.
    if ((await git('status', '--porcelain')) !== '') throw new Error('The build changed files in the worktree, so the installer is not built from the tag alone. Check git status.');
  }

  // Checks on what is about to be published.
  // latest.json is rewritten below on every run, so an old one is not "unexpected".
  const present = fs.readdirSync(publicDir).filter((n) => n !== SUMS_FILE && !(updater.enabled && n === LATEST_JSON));
  checkInstallerNames(present, { updater: updater.enabled });
  for (const name of INSTALLERS) {
    if (!hasMzHeader(readHead(path.join(publicDir, name)))) throw new Error(`${name} is not a Windows executable (missing the MZ header)`);
  }
  if (updater.enabled) {
    // Both signatures must verify against the public key and the exact staged installer bytes (all three x64 paths).
    for (const [installer, sig] of [[INSTALLER_X64, SIG_X64], [INSTALLER_ARM64, SIG_ARM64]]) {
      try {
        verifyTauriSignature({
          pubkeyB64: updater.pubkey,
          sigB64: fs.readFileSync(path.join(publicDir, sig), 'utf8').trim(),
          data: fs.readFileSync(path.join(publicDir, installer)),
          expectVersion: tag.slice(1),
        });
      } catch (err) {
        throw new Error(`${sig} does not verify against ${installer} and the public key in src-tauri/tauri.release.conf.json: ${err.message}`, { cause: err });
      }
    }
  }
  checkNotOlderThanHead(INSTALLERS.map((name) => ({ name, mtimeMs: fs.statSync(path.join(publicDir, name)).mtimeMs })), headCommitMs);
  const channel = checkChannelArtifacts(root, channelRun);
  if (!channel.checked) {
    if (opts.publish) throw new Error('No build artifacts to check the stable channel against. Build here (no --skip-build) before publishing.');
    log('Warning: no build artifacts found, so the stable channel check was skipped (a real publish refuses this).');
  }
  if ((await git('rev-parse', 'HEAD')) !== head) throw new Error('HEAD moved during the build. Start again.');

  const hashes = INSTALLERS.map((name) => ({ name, sha256: sha256File(path.join(publicDir, name)) }));
  const sigHashes = updater.enabled ? SIGNATURES.map((name) => ({ name, sha256: sha256File(path.join(publicDir, name)) })) : [];
  const staged64 = hashes.find((h) => h.name === INSTALLER_X64)?.sha256;
  if (x64Kept !== null && staged64 !== x64Kept) {
    throw new Error(`${INSTALLER_X64} changed between the download or check and staging (sha256 differs). Start again.`);
  }

  if (opts.skipBuild) {
    // Not built by this run: only publishable when an earlier build here left a manifest that still matches.
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    } catch {
      manifest = null;
    }
    const problems = manifestProblems(manifest, { commit: head, version: pkg.version, hashes: [...hashes, ...sigHashes], skip: x64Kept !== null ? [INSTALLER_X64, SIG_X64] : [] });
    if (problems.length > 0) {
      if (opts.publish) {
        throw new Error(`--skip-build with --publish is refused because the installers are not tied to ${tag}: ${problems.join('; ')}. Build here (without --skip-build) or rehearse with a dry run.`);
      }
      for (const p of problems) log(`Warning: not publishable with --skip-build: ${p}`);
    }
  } else {
    const entries = hashes.map((h) => ({
      name: h.name,
      arch: h.name === INSTALLER_X64 ? 'x64' : 'arm64',
      originalName: h.name === INSTALLER_X64 ? originals.x64 : originals.arm64,
      sha256: h.sha256,
      source: h.name === INSTALLER_X64 ? sources.x64 : sources.arm64,
      ...(updater.enabled ? { sig: sigHashes.find((x) => x.name === (h.name === INSTALLER_X64 ? SIG_X64 : SIG_ARM64)) } : {}),
    }));
    fs.writeFileSync(manifestFile, `${JSON.stringify(buildManifest({ commit: head, version: pkg.version, tag, installers: entries }), null, 2)}\n`, 'utf8');
  }

  // latest.json first (it needs the .sig files), then the sums over everything that is published.
  const listed = [...hashes, ...sigHashes];
  if (updater.enabled) {
    generateLatestJson({ tag, assetsDir: publicDir, notesFrom: path.join(root, 'CHANGELOG.md'), root, log });
    listed.push({ name: LATEST_JSON, sha256: sha256File(path.join(publicDir, LATEST_JSON)) });
  }
  const sums = formatSums(listed, { updater: updater.enabled });
  fs.writeFileSync(path.join(publicDir, SUMS_FILE), sums, 'utf8');
  verifySums(sums, Object.fromEntries(listed.map((h) => [h.name, h.sha256])));

  const files = [...(updater.enabled ? UPDATER_SUMS_ORDER : INSTALLERS), SUMS_FILE].map((name) => ({
    name,
    size: fs.statSync(path.join(publicDir, name)).size,
    sha256: listed.find((h) => h.name === name)?.sha256,
  }));
  for (const line of renderPlan({ tag, commit: head, publish: opts.publish, outDir, sources, files })) log(line);

  const common = { tag, assetsDir: publicDir, root, updater, notesFrom: path.join(root, 'CHANGELOG.md'), log: { info: log, warn: (m) => log(`Warning: ${m}`) } };
  if (opts.dryRun) {
    await publishFn({ ...common, dryRun: true });
    log('Dry run finished. Nothing was uploaded. Run again with --publish to release.');
    return { outDir, publicDir, published: false };
  }

  if (!opts.yes && !(await confirm(`Publish ${tag} to ${PUBLIC_REPO} now? This is public.`))) {
    log('Cancelled. Nothing was uploaded.');
    return { outDir, publicDir, published: false };
  }
  await publishFn({ ...common, dryRun: false, env: { ...env, GH_TOKEN: token } });
  log(`Published ${tag}.`);

  // The version on the Gumroad pages comes from the same tag: preview first, then the write with its own prompt.
  // A failure here never undoes the release; the owner is told the one command to run again.
  const sync = { tag, yes: false, cli: null, backupDir: null, notesFrom: null, help: false };
  const syncDeps = { env: withoutSigningEnv(env), root, log, confirm };
  try {
    log('Updating the Gumroad pages (dry run first).');
    await gumroadFn({ ...sync, publish: false, dryRun: true }, syncDeps);
    await gumroadFn({ ...sync, publish: true, dryRun: false }, syncDeps);
  } catch (err) {
    log(`Warning: the release is published, but the Gumroad pages were not updated: ${err instanceof Error ? err.message : String(err)}`);
    log('Fix that, then run: npm run release:gumroad -- --publish');
  }
  // A hint only: installing over this PC's Burrow is a separate step the owner runs on purpose.
  const staged = path.join(publicDir, arch === 'x64' ? INSTALLER_X64 : INSTALLER_ARM64);
  log(`To update this PC's installed Burrow (asks before installing): npm.cmd run desktop:install -- --channel stable --from "${staged}" --install`);
  return { outDir, publicDir, published: true };
}

const HELP = `Usage: npm run release:local -- [--tag vX.Y.Z] [--dry-run | --publish [--yes]] [--skip-build] [--x64-from-ci <run-id> | --x64-file <path>] [--out-dir <dir>]
Dry run is the default. See docs/RELEASING.md ("When CI is slow: release:local").`;

async function main(argv) {
  const opts = parseCliArgs(argv);
  if (opts.help) {
    console.log(HELP);
    return;
  }
  await runRelease(opts);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
