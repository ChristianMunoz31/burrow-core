// Keeps this PC's installed Burrow up to date from a developer checkout (Windows only). Not part of the app and
// never shipped: the app itself makes no network call for this. The only network use is `--from latest`, which
// downloads from the public releases repo when the developer runs it.
//
// Usage: npm run desktop:install -- [--channel dev|stable] [--skip-build | --from latest|<installer path>]
//          [--close] [--install | --yes]
//   --channel dev      (default) builds this checkout with `npm run desktop:build:dev -- --bundles nsis` and installs
//                      over Burrow Dev. With --skip-build it reuses the installer in .dev-build/ if it was built from
//                      HEAD (name carries this checkout's dev version, SHA256SUMS-dev-windows.txt agrees).
//   --channel stable   installs over Burrow. Needs --from latest (public release download, sha256 checked against
//                      SHA256SUMS.txt) or --from <path> (a local installer, e.g. the one release:local staged).
//                      A stable installer is never built from a checkout here.
//   --close            ask the running app to close (taskkill without /F), wait up to 20 s, refuse if it is still
//                      running. This script never kills anything. Without --close a running app is a refusal, and the
//                      check runs again right before the installer starts (a silent NSIS install force-shuts-down a
//                      running app through the Restart Manager, so the installer is never started while it runs).
//   --install          really do it, after a confirm prompt.   --yes   really do it, no prompt.
//   Dry run is the DEFAULT: it prints the plan and changes nothing.
// Steps: resolve the target identity from the Tauri configs, back up the target data folder to
// %LOCALAPPDATA%\burrow-release\data-backups\<channel>-<YYYYMMDD-HHMMSS>\ (copied to <name>.partial, every file
// checked by sha256, PRAGMA integrity_check on the copied burrow.db, then renamed; newest 10 kept), run
// `<installer> /S` (waits up to 10 minutes, never kills it), then require the installed exe's ProductVersion to be
// the expected one. Only the default per-user install folder is supported.
// The other channel's install folder and data are never touched.
import { execFile as execFileCb, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { dataFolderName } from '../../server/paths.js';
import { PUBLIC_REPO, SUMS_FILE } from '../release/publishPublic.js';
import { defaultConfirm, hasMzHeader, readPeVersion } from '../release/releaseLocal.mjs';
import { resolveNpmCli } from '../lib/sandboxSafety.js';
import { ROOT } from './lib.js';
import { resolveDevVersions } from './devVersion.js';

export const CHANNELS = Object.freeze(['dev', 'stable']);
export const KEEP_BACKUPS = 10;
export const CLOSE_TIMEOUT_MS = 20_000;
export const CLOSE_POLL_MS = 1000;
export const INSTALLER_TIMEOUT_MS = 10 * 60 * 1000;
export const DEV_BUILD_DIR = '.dev-build';
export const DEV_SUMS_FILE = 'SHA256SUMS-dev-windows.txt';
const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;
const SHA256_RE = /^[0-9a-f]{64}$/;
const DEV_INSTALLER_RE = /^Burrow-Dev_(.+)_(arm64|x64)-setup\.exe$/;

const execFile = promisify(execFileCb);

/**
 * @typedef {{
 *   channel: 'dev' | 'stable', from: string | null, skipBuild: boolean, close: boolean,
 *   install: boolean, yes: boolean, help: boolean,
 * }} CliOptions
 */

/**
 * Parses and validates the command line. Dry run is the default; `--install` or `--yes` turns it off.
 * @param {string[]} argv
 * @returns {CliOptions}
 */
export function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      channel: { type: 'string', default: 'dev' },
      from: { type: 'string' },
      'skip-build': { type: 'boolean', default: false },
      close: { type: 'boolean', default: false },
      install: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const channel = values.channel;
  if (!CHANNELS.includes(channel)) throw new Error(`--channel must be dev or stable, not "${channel}"`);
  const from = values.from ?? null;
  if (from !== null && from.trim() === '') throw new Error('--from needs "latest" or the path of an installer');
  if (channel === 'dev' && from !== null) {
    throw new Error('--from is for --channel stable only. The dev channel installs a build of this checkout (or --skip-build).');
  }
  if (channel === 'stable' && values['skip-build']) {
    throw new Error('--skip-build is for --channel dev only. A stable installer is never built here.');
  }
  if (channel === 'stable' && from === null && !values.help) {
    throw new Error('--channel stable needs --from latest or --from <installer path>. Stable is never built from a checkout here.');
  }
  return {
    channel,
    from,
    skipBuild: values['skip-build'],
    close: values.close,
    install: values.install || values.yes,
    yes: values.yes,
    help: values.help,
  };
}

/** Host architecture as the installers name it. */
export function installerArch(arch) {
  if (arch === 'arm64') return 'arm64';
  if (arch === 'x64') return 'x64';
  throw new Error(`Unsupported CPU architecture "${arch}": only arm64 and x64 Windows installers exist.`);
}

function readJson(fsApi, file) {
  try {
    return JSON.parse(fsApi.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`Cannot read ${file}`);
  }
}

/**
 * Where a channel lives on this PC, read from the Tauri configs (never guessed).
 * @param {'dev' | 'stable'} channel
 * @param {{ fs?: typeof fs, root?: string, env: Record<string, string | undefined> }} ctx
 * @returns {{ channel: string, identifier: string, productName: string, installDir: string, mainExe: string,
 *   sidecarExe: string, dataDir: string }}
 */
export function resolveIdentity(channel, { fs: fsApi = fs, root = ROOT, env }) {
  const localAppData = (env.LOCALAPPDATA ?? '').trim();
  const appData = (env.APPDATA ?? '').trim();
  if (!localAppData || !appData) throw new Error('LOCALAPPDATA and APPDATA must be set (this is a Windows per-user install).');
  const tauriDir = path.join(root, 'src-tauri');
  const base = readJson(fsApi, path.join(tauriDir, 'tauri.conf.json'));
  const overlay = channel === 'dev' ? readJson(fsApi, path.join(tauriDir, 'tauri.dev.conf.json')) : {};
  const productName = overlay.productName ?? base.productName;
  const identifier = overlay.identifier ?? base.identifier;
  const binary = overlay.mainBinaryName ?? base.mainBinaryName ?? productName;
  const externalBin = overlay.bundle?.externalBin ?? base.bundle?.externalBin;
  if (!productName || !identifier || !binary || !Array.isArray(externalBin) || externalBin.length === 0) {
    throw new Error(`The Tauri config for the ${channel} channel is missing productName, identifier or externalBin.`);
  }
  return {
    channel,
    identifier,
    productName,
    installDir: path.join(localAppData, productName),
    mainExe: `${binary}.exe`,
    sidecarExe: `${path.basename(externalBin[0])}.exe`,
    dataDir: path.join(appData, dataFolderName(channel, 'win32')),
  };
}

const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * The target channel must share nothing with the other one: no executable name, no install folder, no data folder
 * (equal or nested). A broken config that made them overlap stops here, before anything is written.
 * @param {ReturnType<typeof resolveIdentity>} target
 * @param {ReturnType<typeof resolveIdentity>} other
 */
export function assertIsolated(target, other) {
  const lower = (s) => s.toLowerCase();
  if (target.identifier === other.identifier) throw new Error('Both channels have the same app identifier; refusing.');
  for (const key of ['mainExe', 'sidecarExe']) {
    if (lower(target[key]) === lower(other[key])) throw new Error(`Both channels use ${target[key]}; refusing to touch either.`);
  }
  for (const a of ['installDir', 'dataDir']) {
    for (const b of ['installDir', 'dataDir']) {
      const x = target[a].toLowerCase();
      const y = other[b].toLowerCase();
      if (inside(x, y) || inside(y, x)) {
        throw new Error(`The ${target.channel} ${a} (${target[a]}) overlaps the ${other.channel} ${b} (${other[b]}); refusing.`);
      }
    }
  }
}

const sha256Bytes = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/** @returns {Map<string, string>} file name to lowercase sha256 from a sha256sum style list */
export function parseSums(text) {
  const out = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (!m) throw new Error(`Malformed line in the checksums file: ${line.slice(0, 80)}`);
    out.set(m[2], m[1].toLowerCase());
  }
  return out;
}

/**
 * Backup folder name: <channel>-YYYYMMDD-HHMMSS in local time.
 * @param {'dev' | 'stable'} channel
 * @param {Date} date
 */
export function backupName(channel, date) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${channel}-${p(date.getFullYear(), 4)}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** Relative path to size for every file under `dir`. */
export function listFiles(dir, fsApi = fs) {
  const out = new Map();
  const walk = (current) => {
    for (const entry of fsApi.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.set(path.relative(dir, full), fsApi.statSync(full).size);
    }
  };
  walk(dir);
  return out;
}

/**
 * PRAGMA integrity_check on a database file, opened read-only. Only ever called on a copy in the backup folder.
 * @returns {string[]} the result rows; ['ok'] means healthy. An unreadable file is reported as one message.
 */
export function integrityCheckFile(file) {
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    return db.prepare('PRAGMA integrity_check').all().map((row) => String(Object.values(row)[0]));
  } catch (err) {
    return [`could not open: ${err instanceof Error ? err.message : String(err)}`];
  } finally {
    try {
      db?.close();
    } catch {
      // nothing to close
    }
  }
}

const sha256File = (file, fsApi) => sha256Bytes(fsApi.readFileSync(file));

/**
 * Copies the data folder to `<backupDir>.partial`, checks the copy (same files, same sizes, same sha256 for every
 * file, and a healthy PRAGMA integrity_check on the copied burrow.db), and only then renames it to `backupDir`.
 * The live database is never opened. Any mismatch throws and leaves the `.partial` folder for inspection.
 * @returns {{ files: number, bytes: number }}
 */
export function backupDataDir({ dataDir, backupDir, fs: fsApi = fs, integrity = integrityCheckFile }) {
  const partial = `${backupDir}.partial`;
  if (fsApi.existsSync(backupDir)) throw new Error(`The backup folder ${backupDir} already exists; refusing to merge into it.`);
  fsApi.mkdirSync(path.dirname(backupDir), { recursive: true });
  fsApi.rmSync(partial, { recursive: true, force: true });
  fsApi.cpSync(dataDir, partial, { recursive: true, errorOnExist: true });
  const a = listFiles(dataDir, fsApi);
  const b = listFiles(partial, fsApi);
  if (a.size !== b.size) throw new Error(`Backup check failed: ${a.size} files in the data folder, ${b.size} in the copy (${partial}).`);
  let bytes = 0;
  for (const [file, size] of a) {
    if (b.get(file) !== size) throw new Error(`Backup check failed: ${file} differs in size (${size} vs ${b.get(file) ?? 'missing'}) in ${partial}.`);
    if (sha256File(path.join(dataDir, file), fsApi) !== sha256File(path.join(partial, file), fsApi)) {
      throw new Error(`Backup check failed: ${file} differs in sha256 from the data folder (${partial}).`);
    }
    bytes += size;
  }
  if (a.has('burrow.db')) {
    const result = integrity(path.join(partial, 'burrow.db'));
    // A read-only open of a WAL database can leave a -shm file behind; it is a cache, not data.
    if (!a.has('burrow.db-shm')) fsApi.rmSync(path.join(partial, 'burrow.db-shm'), { force: true });
    if (result.length !== 1 || result[0] !== 'ok') {
      throw new Error(`Backup check failed: PRAGMA integrity_check on the copied burrow.db said ${result.slice(0, 3).join('; ')} (${partial}).`);
    }
  }
  fsApi.renameSync(partial, backupDir);
  return { files: a.size, bytes };
}

/**
 * Deletes all but the newest `keep` backups of `channel`. Only folders named exactly <channel>-YYYYMMDD-HHMMSS
 * (so never a `.partial` copy) are considered, the backup just made (`protect`) is never removed, and the other
 * channel's backups and any other folder are never touched.
 * @returns {string[]} removed folder names
 */
export function pruneBackups({ root, channel, keep = KEEP_BACKUPS, protect = null, fs: fsApi = fs }) {
  if (!fsApi.existsSync(root)) return [];
  const re = new RegExp(`^${channel}-\\d{8}-\\d{6}$`);
  const names = fsApi
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && re.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
  const removed = names.slice(keep).filter((name) => name !== protect);
  for (const name of removed) fsApi.rmSync(path.join(root, name), { recursive: true, force: true });
  return removed;
}

function readHead(file, fsApi, n = 2) {
  const fd = fsApi.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    fsApi.readSync(fd, buf, 0, n, 0);
    return buf;
  } finally {
    fsApi.closeSync(fd);
  }
}

/** Refuses a file that is not a Windows executable. */
export function assertInstallerFile(file, fsApi = fs) {
  if (!fsApi.existsSync(file)) throw new Error(`Installer not found: ${file}`);
  if (!hasMzHeader(readHead(file, fsApi))) throw new Error(`${file} is not a Windows executable (no MZ header).`);
}

/** True when `exe` is running (tasklist, exact image name). */
export async function isRunning(exec, exe) {
  const { stdout } = await exec('tasklist', ['/FI', `IMAGENAME eq ${exe}`, '/FO', 'CSV', '/NH']);
  const wanted = `"${exe.toLowerCase()}"`;
  return String(stdout).split(/\r?\n/).some((line) => line.toLowerCase().startsWith(wanted));
}

/**
 * Makes sure the target app and its sidecar are not running. With `close`, asks them to close gracefully
 * (`taskkill /IM <exe>`, never /F) and polls for up to `timeoutMs`; refuses if still running.
 */
export async function ensureClosed({ exec, exes, close, sleep, log, timeoutMs = CLOSE_TIMEOUT_MS, pollMs = CLOSE_POLL_MS }) {
  const running = async () => {
    const found = [];
    for (const exe of exes) if (await isRunning(exec, exe)) found.push(exe);
    return found;
  };
  let found = await running();
  if (found.length === 0) return;
  if (!close) {
    throw new Error(`${found.join(' and ')} is running. Close it, or add --close to ask it to close.`);
  }
  for (const exe of found) {
    log(`Asking ${exe} to close (no force)...`);
    try {
      await exec('taskkill', ['/IM', exe]);
    } catch {
      // taskkill exits non-zero when the process has no window to ask; the wait below decides.
    }
  }
  for (let waited = 0; waited < timeoutMs; waited += pollMs) {
    await sleep(pollMs);
    found = await running();
    if (found.length === 0) return;
  }
  throw new Error(`${found.join(' and ')} is still running after ${Math.round(timeoutMs / 1000)} s. Close it yourself and run this again (this script never kills anything).`);
}

/** Last check before the installer starts: a silent NSIS install would force-shut-down a running app. */
export async function assertNoneRunning(exec, exes) {
  const found = [];
  for (const exe of exes) if (await isRunning(exec, exe)) found.push(exe);
  if (found.length > 0) {
    throw new Error(`${found.join(' and ')} is running, so the installer was not started (a silent install would force-close it). Close it and run this again.`);
  }
}

/** Runs the installer and waits for it. On timeout it fails with a clear message and does not kill it. */
export async function runInstaller({ exec, installer, timeoutMs = INSTALLER_TIMEOUT_MS }) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`The installer did not finish within ${Math.round(timeoutMs / 60000)} minutes. It was NOT stopped and may still be running; check it, then run this again.`)),
      timeoutMs,
    );
  });
  try {
    await Promise.race([exec(installer, ['/S'], { windowsHide: true }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The newest dev installer for this checkout's version, checked against SHA256SUMS-dev-windows.txt.
 * @returns {{ file: string, name: string, sha256: string }}
 */
export function findDevInstaller({ dir, versions, arch, fs: fsApi = fs }) {
  const wanted = `Burrow-Dev_${versions.display}_${arch}-setup.exe`;
  const present = fsApi.existsSync(dir)
    ? fsApi.readdirSync(dir).filter((n) => DEV_INSTALLER_RE.test(n))
    : [];
  if (!present.includes(wanted)) {
    throw new Error(
      `No ${wanted} in ${dir}, so there is no installer built from HEAD (${versions.shortSha}).` +
        (present.length > 0 ? ` Found: ${present.join(', ')}.` : '') +
        ' Run without --skip-build to build it.',
    );
  }
  const file = path.join(dir, wanted);
  assertInstallerFile(file, fsApi);
  const sha256 = sha256Bytes(fsApi.readFileSync(file));
  const sumsFile = path.join(dir, DEV_SUMS_FILE);
  if (!fsApi.existsSync(sumsFile)) throw new Error(`${DEV_SUMS_FILE} is missing from ${dir}; cannot check ${wanted}.`);
  const listed = parseSums(fsApi.readFileSync(sumsFile, 'utf8')).get(wanted);
  if (listed !== sha256) throw new Error(`${wanted} does not match ${DEV_SUMS_FILE} (it was changed after the build, or the build is stale).`);
  return { file, name: wanted, sha256 };
}

/** The versions a dev build can report: the bundle form (what the installed exe carries), the plain Windows file version, the display form. */
export function devVersionForms(versions) {
  const next = versions.display.split('-dev.')[0];
  return [versions.bundle, `${next}.${versions.buildNumber}`, versions.display];
}

export const latestUrl = (name) => `https://github.com/${PUBLIC_REPO}/releases/latest/download/${name}`;

async function fetchBytes(fetchFn, url, limit) {
  if (!url.startsWith('https://')) throw new Error(`Refusing a non-https download: ${url}`);
  const res = await fetchFn(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > limit) throw new Error(`${url} is larger than ${limit} bytes; refusing.`);
  return bytes;
}

/**
 * The expected sha256 of `name` from the release's SHA256SUMS.txt.
 * @returns {Promise<string>}
 */
export async function fetchExpectedHash({ fetchFn, name }) {
  const text = (await fetchBytes(fetchFn, latestUrl(SUMS_FILE), 1024 * 1024)).toString('utf8');
  const hash = parseSums(text).get(name);
  if (!hash || !SHA256_RE.test(hash)) throw new Error(`${SUMS_FILE} of the latest release has no entry for ${name}.`);
  return hash;
}

function defaultRunBuild(root) {
  const res = spawnSync(process.execPath, [resolveNpmCli(), 'run', 'desktop:build:dev', '--', '--bundles', 'nsis'], {
    cwd: root,
    stdio: 'inherit',
    shell: false,
  });
  if (res.status !== 0) throw new Error(`npm run desktop:build:dev failed (exit ${res.status ?? 'signal'})`);
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @typedef {{
 *   env?: Record<string, string | undefined>, root?: string, platform?: NodeJS.Platform, arch?: string,
 *   exec?: (file: string, args: string[], opts?: object) => Promise<{ stdout: string }>,
 *   fs?: typeof fs, fetchFn?: typeof fetch, confirm?: (q: string) => Promise<boolean>,
 *   log?: (line: string) => void, sleep?: (ms: number) => Promise<void>, now?: () => Date,
 *   peVersion?: (file: string) => Promise<string | null>, runBuild?: () => void | Promise<void>,
 *   devVersions?: () => ReturnType<typeof resolveDevVersions>, nowMs?: () => number,
 *   integrity?: (file: string) => string[], installerTimeoutMs?: number,
 * }} Deps
 */

/**
 * Runs the whole flow. Every outside effect is injected.
 * @param {CliOptions} opts
 * @param {Deps} [deps]
 * @returns {Promise<{ installed: boolean, plan: string[], backupDir: string | null, version: string | null }>}
 */
export async function runInstall(opts, deps = {}) {
  const {
    env = process.env,
    root = ROOT,
    platform = process.platform,
    arch = process.arch,
    exec = execFile,
    fs: fsApi = fs,
    fetchFn = globalThis.fetch,
    confirm = defaultConfirm,
    log = (line) => console.log(line),
    sleep = sleepMs,
    now = () => new Date(),
    peVersion = readPeVersion,
    runBuild = () => defaultRunBuild(root),
    devVersions = () => resolveDevVersions({ root }),
    nowMs = () => Date.now(),
    integrity = integrityCheckFile,
    installerTimeoutMs = INSTALLER_TIMEOUT_MS,
  } = deps;
  const startedMs = nowMs();

  if (platform !== 'win32') throw new Error('desktop:install works on Windows only (it drives the per-user NSIS installers).');
  const hostArch = installerArch(arch);
  const channel = opts.channel;
  const target = resolveIdentity(channel, { fs: fsApi, root, env });
  const other = resolveIdentity(channel === 'dev' ? 'stable' : 'dev', { fs: fsApi, root, env });
  assertIsolated(target, other);
  const real = opts.install || opts.yes;
  const backupsRoot = path.join(env.LOCALAPPDATA, 'burrow-release', 'data-backups');
  const backupDir = path.join(backupsRoot, backupName(channel, now()));
  const dataExists = fsApi.existsSync(target.dataDir);

  // The source: what will be installed and which version the installed exe must report.
  /** @type {{ describe: string, installer: string | null, acquire: () => Promise<{ installer: string, cleanup?: () => void }>, expected: string[] | null, expectedText: string }} */
  let source;
  if (channel === 'dev') {
    const versions = devVersions();
    const dir = path.join(root, DEV_BUILD_DIR);
    const forms = devVersionForms(versions);
    const found = opts.skipBuild ? findDevInstaller({ dir, versions, arch: hostArch, fs: fsApi }) : null;
    source = {
      describe: opts.skipBuild
        ? `existing installer built from HEAD ${versions.shortSha} (sha256 ${found.sha256})`
        : 'build of this checkout: npm run desktop:build:dev -- --bundles nsis',
      installer: found ? found.file : path.join(dir, `Burrow-Dev_${versions.display}_${hostArch}-setup.exe`),
      acquire: async () => {
        if (!opts.skipBuild) await runBuild();
        return { installer: findDevInstaller({ dir, versions, arch: hostArch, fs: fsApi }).file };
      },
      expected: forms,
      expectedText: `${forms[0]} (or ${forms[1]}; dev ${versions.display})`,
    };
  } else if (opts.from === 'latest') {
    const name = `Burrow-Setup-${hostArch}.exe`;
    const hash = await fetchExpectedHash({ fetchFn, name });
    source = {
      describe: `download ${latestUrl(name)} (expected sha256 ${hash} from ${SUMS_FILE})`,
      installer: null,
      acquire: async () => {
        const dir = path.join(env.LOCALAPPDATA, 'burrow-release', 'downloads', backupName('stable', now()));
        const file = path.join(dir, name);
        const bytes = await fetchBytes(fetchFn, latestUrl(name), MAX_DOWNLOAD_BYTES);
        const actual = sha256Bytes(bytes);
        if (actual !== hash) throw new Error(`sha256 mismatch for ${name}: downloaded ${actual}, ${SUMS_FILE} says ${hash}. Not installing.`);
        fsApi.mkdirSync(dir, { recursive: true });
        fsApi.writeFileSync(file, bytes);
        return { installer: file, cleanup: () => fsApi.rmSync(dir, { recursive: true, force: true }) };
      },
      expected: null,
      expectedText: 'the PE ProductVersion of the downloaded installer',
    };
  } else {
    const file = path.resolve((env.INIT_CWD ?? '').trim() || process.cwd(), opts.from);
    if (/dev/i.test(path.basename(file))) {
      throw new Error(`${path.basename(file)} looks like a Dev installer. The stable channel only takes a stable installer.`);
    }
    assertInstallerFile(file, fsApi);
    const sha = sha256Bytes(fsApi.readFileSync(file));
    const version = String((await peVersion(file)) ?? '').trim();
    if (version === '') throw new Error(`Could not read the PE version of ${file}; cannot tell which version to expect.`);
    if (/-dev\./.test(version)) throw new Error(`${path.basename(file)} reports version ${version}, which is a Dev build. The stable channel only takes a stable installer.`);
    source = {
      describe: `local installer ${file} (sha256 ${sha})`,
      installer: file,
      acquire: async () => ({ installer: file }),
      expected: [version],
      expectedText: `${version} (the installer's PE ProductVersion)`,
    };
  }

  const exes = [target.mainExe, target.sidecarExe];
  const running = [];
  for (const exe of exes) if (await isRunning(exec, exe)) running.push(exe);

  const plan = [
    `Burrow desktop install: ${real ? 'INSTALL' : 'DRY RUN (nothing is changed; add --install or --yes to do it)'}`,
    `  channel    ${channel} (${target.productName}, ${target.identifier}); the ${other.channel} channel is not touched`,
    `  source     ${source.describe}`,
    `  installer  ${source.installer ?? '(downloaded when you run it for real)'}`,
    `  install in ${target.installDir} (${target.mainExe}, sidecar ${target.sidecarExe})`,
    `  data       ${target.dataDir}${dataExists ? '' : ' (not there yet, so no backup)'}`,
    `  backup     ${dataExists ? backupDir : 'none'} (every file checked by sha256, PRAGMA integrity_check on the copy; newest ${KEEP_BACKUPS} ${channel} backups kept)`,
    `  stop       every other process that writes ${target.dataDir} (for example npm start without BURROW_DATA_DIR uses the real stable data)`,
    `  command    "${source.installer ?? `<downloaded Burrow-Setup-${hostArch}.exe>`}" /S`,
    `  running    ${running.length === 0 ? 'no' : `${running.join(', ')}${opts.close ? ' (will be asked to close)' : ' (add --close, or close it, before installing)'}`}`,
    `  expect     installed ${target.mainExe} ProductVersion ${source.expectedText}`,
  ];
  for (const line of plan) log(line);

  if (!real) {
    log('Dry run finished. Nothing was changed.');
    return { installed: false, plan, backupDir: null, version: null };
  }

  if (!opts.yes && !(await confirm(`Install over ${target.productName} on this PC now?`))) {
    log('Cancelled. Nothing was changed.');
    return { installed: false, plan, backupDir: null, version: null };
  }

  const acquired = await source.acquire();
  try {
    assertInstallerFile(acquired.installer, fsApi);
    let expected = source.expected;
    if (expected === null) {
      const version = String((await peVersion(acquired.installer)) ?? '').trim();
      if (version === '') throw new Error('Could not read the PE version of the downloaded installer; not installing.');
      expected = [version];
    }

    await ensureClosed({ exec, exes, close: opts.close, sleep, log });

    let madeBackup = null;
    if (dataExists) {
      const result = backupDataDir({ dataDir: target.dataDir, backupDir, fs: fsApi, integrity });
      madeBackup = backupDir;
      log(`Backed up ${target.dataDir} to ${backupDir} (${result.files} files, ${result.bytes} bytes, verified).`);
      const removed = pruneBackups({ root: backupsRoot, channel, protect: path.basename(backupDir), fs: fsApi });
      if (removed.length > 0) log(`Removed ${removed.length} old ${channel} backup(s): ${removed.join(', ')}`);
    }

    log(`Running the installer: ${acquired.installer} /S`);
    await assertNoneRunning(exec, exes);
    await runInstaller({ exec, installer: acquired.installer, timeoutMs: installerTimeoutMs });

    const installedExe = path.join(target.installDir, target.mainExe);
    const found = String((await peVersion(installedExe)) ?? '').trim();
    if (found === '') throw new Error(`Installed, but could not read the version of ${installedExe}.`);
    if (!expected.includes(found)) {
      throw new Error(`Installed ${installedExe} reports version ${found}, expected ${expected.join(' or ')}. Your data backup is ${madeBackup ?? 'not needed (no data folder)'}.`);
    }
    if (channel === 'dev' && !opts.skipBuild) {
      // A build made by this run is newer than the run's start; an old exe with a matching version is not proof.
      const mtimeMs = fsApi.existsSync(installedExe) ? fsApi.statSync(installedExe).mtimeMs : 0;
      if (mtimeMs < startedMs - 2000) {
        throw new Error(`${installedExe} reports ${found} but was not written by this install (it is older than this run). Your data backup is ${madeBackup ?? 'not needed (no data folder)'}.`);
      }
    }
    for (const line of [
      `Done: ${target.productName} ${found} installed in ${target.installDir}.`,
      `  data folder  ${target.dataDir} (kept)`,
      `  backup       ${madeBackup ?? 'none (no data folder yet)'}`,
      `  other channel (${other.productName}) was not touched.`,
    ]) log(line);
    return { installed: true, plan, backupDir: madeBackup, version: found };
  } finally {
    acquired.cleanup?.();
  }
}

const HELP = `Usage: npm run desktop:install -- [--channel dev|stable] [--skip-build | --from latest|<installer path>] [--close] [--install | --yes]
Dry run is the default. See CONTRIBUTING.md ("Keep this PC's Burrow up to date").`;

async function main(argv) {
  const opts = parseCliArgs(argv);
  if (opts.help) {
    console.log(HELP);
    return;
  }
  await runInstall(opts);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
