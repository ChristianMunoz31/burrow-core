// Release smoke test for the built desktop sidecar (the SEA exe). It launches the exe the way the Tauri shell
// does (src-tauri/src/sidecar.rs: allowlisted environment, BURROW_DESKTOP=1, per-launch 64-hex secret on
// stdin), waits for the BURROW_READY line, then checks the desktop gate end to end:
//   no cookie -> 401 on /api, bootstrap token (HMAC as server/desktop/auth.js computes it) -> 302 + cookie,
//   cookie -> 200 JSON on /api/transactions and /api/license, cookie -> 404 on /api/dev/license and devTools false
//   in /api/app/info (developer tools compiled out), cookie -> 200 HTML on /,
//   Folders documents (a synthetic PDF and DOCX extract as ok/document, a corrupt PDF is unreadable; folder removed again),
//   then closes stdin and expects exit code 0 within 10 s.
// Everything runs against a throwaway data dir and a throwaway profile (APPDATA, LOCALAPPDATA, USERPROFILE, HOME
// all point inside it), so it never touches the real Burrow data. Needs only Node built-ins.
//
// Usage: node scripts/release/smokeSidecar.js [--sidecar <exe>] [--resources <src-tauri/resources dir>]
//          [--expect-version <x.y.z>] [--expect-distribution <direct|store>] [--expect-data-location <appdata|userprofile>]
//          [--expect-pro <present|absent>] [--ready-timeout-ms 60000] [--exit-timeout-ms 10000]
// Without --sidecar and --resources it tests the stable host sidecar that `npm run desktop:sidecar` copied
// (src-tauri/binaries/burrow-server-<host triple>, src-tauri/resources).
// With --expect-pro (docs/adr/0001-open-core-split.md 3.10) it checks /api/app/info `proModule` and that
// POST /api/insights/explain with `{}` answers 400 (Pro module present: the Pro validator runs) or 501
// pro_not_included (absent) on the fresh trial data dir.
// With --expect-distribution store it also checks the ready line, /api/app/info and that the update check answers
// store_managed (no GitHub call), i.e. the Microsoft Store flavor.
// With --expect-data-location the sidecar is started WITHOUT BURROW_DATA_DIR so that it resolves its own default folder inside
// the throwaway profile, and the test checks the ready line, /api/app/info and that the folder is USERPROFILE\Burrow Data (userprofile)
// or APPDATA\Burrow (appdata) of that profile, and that the other one was not created.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { smokeDocFiles } from './smokeDocs.js';
import { hostTriple } from '../desktop/lib.js';

export const READY_PREFIX = 'BURROW_READY ';
export const BOOTSTRAP_LABEL = 'burrow-bootstrap-v1';
export const COOKIE_NAME = 'burrow_desktop';
export const READY_TIMEOUT_MS = 60_000;
export const EXIT_TIMEOUT_MS = 10_000;
const FOLDER_SCAN_TIMEOUT_MS = 30_000;

// Same list as PASSTHROUGH in src-tauri/src/sidecar.rs.
const PASSTHROUGH = ['SystemRoot', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME', 'XDG_DATA_HOME'];

/**
 * Parses one stdout line. Null for anything that is not a well-formed ready line (port 0 included).
 * @param {string} line
 * @returns {{ port: number, dataDir: string, version: string } | null}
 */
export function parseReadyLine(line) {
  const text = String(line).replace(/[\r\n]+$/, '');
  if (!text.startsWith(READY_PREFIX)) return null;
  try {
    const ready = JSON.parse(text.slice(READY_PREFIX.length));
    const ok =
      Number.isInteger(ready?.port) && ready.port > 0 && ready.port <= 65535 &&
      typeof ready.dataDir === 'string' && typeof ready.version === 'string';
    return ok ? { port: ready.port, dataDir: ready.dataDir, version: ready.version, channel: ready.channel, distribution: ready.distribution, dataLocation: ready.dataLocation } : null;
  } catch {
    return null;
  }
}

/**
 * First valid ready payload in a block of stdout text.
 * @param {string} text
 */
export function findReady(text) {
  for (const line of String(text).split('\n')) {
    const ready = parseReadyLine(line);
    if (ready) return ready;
  }
  return null;
}

/** @returns {string} 64 lowercase hex chars (32 random bytes) */
export const newSecretHex = () => crypto.randomBytes(32).toString('hex');

/**
 * Bootstrap token the server expects: hex(HMAC-SHA256(secret bytes, 'burrow-bootstrap-v1')).
 * @param {string} secretHex 64 hex chars
 * @returns {string}
 */
export function bootstrapTokenFor(secretHex) {
  if (!/^[0-9a-f]{64}$/.test(secretHex)) throw new TypeError('secret must be 64 lowercase hex chars');
  return crypto.createHmac('sha256', Buffer.from(secretHex, 'hex')).update(BOOTSTRAP_LABEL).digest('hex');
}

/**
 * The `name=value` pair of the desktop cookie in a Set-Cookie header value (or an array of them).
 * @param {string | string[] | null | undefined} setCookie
 * @returns {string | null}
 */
export function extractCookie(setCookie) {
  const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const header of headers) {
    const pair = String(header).split(';')[0].trim();
    if (pair.startsWith(`${COOKIE_NAME}=`) && pair.length > COOKIE_NAME.length + 1) return pair;
  }
  return null;
}

/**
 * Environment for the sidecar, built like the shell does: only allowlisted variables survive, PATH is
 * System32 on Windows, and the Burrow variables are fixed. The profile variables are redirected into `profileDir`
 * so a smoke run can never reach the real user profile.
 * @param {{ base: Record<string, string | undefined>, platform: string, distDir: string, migrationsDir: string,
 *   dataDir: string | null, profileDir: string }} input `dataDir` null leaves BURROW_DATA_DIR unset (the sidecar resolves its default folder)
 * @returns {Record<string, string>}
 */
export function buildSidecarEnv({ base, platform, distDir, migrationsDir, dataDir, profileDir, channel = 'stable' }) {
  const env = {};
  for (const key of PASSTHROUGH) {
    const hit = Object.keys(base).find((k) => (platform === 'win32' ? k.toLowerCase() === key.toLowerCase() : k === key));
    if (hit !== undefined && base[hit] !== undefined && base[hit] !== '') env[key] = base[hit];
  }
  const isolated = platform === 'win32' ? ['APPDATA', 'LOCALAPPDATA', 'USERPROFILE'] : ['HOME', 'XDG_DATA_HOME'];
  for (const key of isolated) env[key] = path.join(profileDir, key.toLowerCase());
  env.PATH = platform === 'win32' ? `${env.SystemRoot ?? 'C:\\Windows'}\\System32` : '/usr/bin:/bin';
  env.BURROW_DESKTOP = '1';
  // The shell always names its channel; server/channelGuards.js refuses to start in desktop mode without a match.
  env.BURROW_SHELL_CHANNEL = channel;
  env.BURROW_HOST = '127.0.0.1';
  env.BURROW_PORT = '0';
  env.BURROW_NO_DOTENV = '1';
  // The developer switch for document parsing: a built sidecar must ignore it, which the Folders smoke step proves.
  env.BURROW_DOC_PARSING = '1';
  env.BURROW_DIST_DIR = distDir;
  env.BURROW_MIGRATIONS_DIR = migrationsDir;
  if (dataDir !== null) env.BURROW_DATA_DIR = dataDir;
  return env;
}

/** @param {string | null | undefined} contentType */
export const isJsonType = (contentType) => /^application\/(?:[\w.+-]+\+)?json\b/i.test(contentType ?? '');

/**
 * @param {string | null | undefined} contentType
 * @param {string} body
 */
export const looksLikeAppHtml = (contentType, body) =>
  /^text\/html\b/i.test(contentType ?? '') && /<!doctype html/i.test(body) && /id="root"/.test(body);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class SmokeError extends Error {}

const check = (condition, message) => {
  if (!condition) throw new SmokeError(message);
};

/**
 * Says whether the sidecar process has exited (code or signal, the code also as hex, e.g. 0xC0000005) and its last stderr, so a
 * failed request can be attributed to a crash. It echoes what it is given: the caller redacts the launch secret from `stderr`.
 * @param {{ exitCode: number | null, signalCode: string | null }} child
 * @param {string} stderr
 */
export function describeChildState(child, stderr) {
  const tail = String(stderr).slice(-800);
  const stderrPart = tail ? `stderr tail: ${tail}` : 'stderr empty';
  if (child.exitCode === null && child.signalCode === null) return `sidecar still running; ${stderrPart}`;
  const hex = child.exitCode === null ? '' : ` (0x${(child.exitCode >>> 0).toString(16).toUpperCase()})`;
  return `sidecar exited with code ${child.exitCode ?? 'none'}${hex}, signal ${child.signalCode ?? 'none'}; ${stderrPart}`;
}

/** Every entry under `dir` with its bytes, sorted: equal before and after means nothing was written. */
function snapshotFolder(dir) {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((e) => {
      const full = path.join(e.parentPath, e.name);
      return `${path.relative(dir, full)}|${e.isDirectory() ? 'dir' : fs.readFileSync(full, 'hex')}`;
    })
    .sort();
}

/**
 * Userprofile data location only: the sidecar must refuse a folder that is not a Burrow data folder. The folder the first run
 * made is replaced by an unmarked, non-empty one; a second launch must exit with code 5 and leave it byte-for-byte unchanged
 * (no marker, no database, no logs).
 */
async function checkRefusesForeignFolder({ exe, env, folder, exitTimeoutMs, log }) {
  fs.rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(path.join(folder, '.git'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'README.md'), 'not a Burrow folder');
  const before = snapshotFolder(folder);
  const child = spawn(exe, [], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  child.stdin.on('error', () => {});
  const exited = new Promise((resolve) => {
    child.once('error', (err) => resolve({ code: null, error: err }));
    child.once('exit', (code) => resolve({ code }));
  });
  try {
    child.stdin.write(`${newSecretHex()}\n`);
    const result = await Promise.race([exited, sleep(Math.max(exitTimeoutMs, 30_000)).then(() => null)]);
    check(result, 'the sidecar did not exit on a folder that is not a Burrow data folder');
    check(result.code === 5, `the sidecar exited with code ${result.code}, expected 5 for a folder that is not ours: ${stderr.slice(-300)}`);
    check(stderr.includes(folder), 'the refusal did not name the folder');
    check(JSON.stringify(snapshotFolder(folder)) === JSON.stringify(before), `the refused folder was changed: ${folder}`);
    log('refuses an unmarked, non-empty data folder (exit code 5), nothing written');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.race([exited, sleep(5000)]);
  }
}

/**
 * Folders document handling inside the real SEA exe. PDF and DOCX parsing ships OFF until the parser runs in its own
 * process (issue #67), and a bundled build bakes that in (the BURROW_DOC_PARSING variable cannot turn it on). A throwaway
 * folder with a synthetic PDF, a DOCX and a corrupt PDF is added through the API and scanned: the scan must finish, all
 * three must be listed as `unsupported` ("Not supported yet", kind `other`, nothing read and no parser worker started)
 * and the preview of one must answer kind `none`. Then the folder is removed again (files on disk are never touched by
 * that) and the temp folder deleted. No network and no AI needed: the inventory completes without Ollama. The sidecar
 * runs without any shell dialog capability, so adding by typed path works even once a desktop shell that can show the
 * native picker makes the API require it (`folder_pick_required`).
 */
async function checkFolderDocuments({ get, cookie, base, log }) {
  const docsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-smoke-docs-'));
  const headers = { cookie, origin: base, 'content-type': 'application/json' };
  let folderId = null;
  try {
    for (const [name, bytes] of Object.entries(smokeDocFiles())) fs.writeFileSync(path.join(docsDir, name), bytes);
    const add = await get('/api/folders', { method: 'POST', headers, body: JSON.stringify({ path: docsDir }) });
    const addText = await add.text();
    check(add.status === 201, `adding the smoke folder returned ${add.status}, expected 201: ${addText.slice(0, 200)}`);
    folderId = JSON.parse(addText)?.data?.folder?.id;
    check(typeof folderId === 'string', 'adding the smoke folder returned no folder id');

    const deadline = Date.now() + FOLDER_SCAN_TIMEOUT_MS;
    let job = null;
    while (Date.now() < deadline) {
      const res = await get(`/api/folders/${folderId}/job`, { headers: { cookie } });
      check(res.status === 200, `/api/folders/:id/job returned ${res.status}, expected 200`);
      job = JSON.parse(await res.text())?.data?.job;
      if (job && job.status !== 'queued' && job.status !== 'running') break;
      await sleep(250);
    }
    check(job && job.status === 'done', `the folder scan did not finish in ${FOLDER_SCAN_TIMEOUT_MS} ms (status ${job?.status ?? 'none'}, error ${job?.error ?? 'none'})`);

    const filesRes = await get(`/api/folders/${folderId}/files?limit=50`, { headers: { cookie } });
    check(filesRes.status === 200, `/api/folders/:id/files returned ${filesRes.status}, expected 200`);
    const files = JSON.parse(await filesRes.text())?.data?.files ?? [];
    const byPath = new Map(files.map((f) => [f.path, f]));
    for (const name of ['report.pdf', 'letter.docx', 'broken.pdf']) {
      const f = byPath.get(name);
      check(f, `${name} is missing from the scanned folder`);
      check(f.status === 'unsupported' && f.kind === 'other', `${name} scanned as ${f.status}/${f.kind}, expected unsupported/other (document parsing is off)`);
      check(!(f.words > 0) && !(f.chars > 0), `${name} has counted text although document parsing is off`);
    }
    const previewRes = await get(`/api/folders/${folderId}/files/${byPath.get('report.pdf').id}/preview`, { headers: { cookie } });
    check(previewRes.status === 200, `the PDF preview returned ${previewRes.status}, expected 200`);
    const shown = JSON.parse(await previewRes.text())?.data?.preview;
    check(shown?.kind === 'none' && shown.reason === 'unsupported' && shown.text === null, 'the PDF preview did not answer kind none / unsupported');
    log('folders: PDF, DOCX and corrupt PDF listed as unsupported (document parsing is off), no text read');

    const del = await get(`/api/folders/${folderId}`, { method: 'DELETE', headers: { cookie, origin: base } });
    check(del.status === 200, `removing the smoke folder returned ${del.status}, expected 200`);
    await del.arrayBuffer();
    folderId = null;
    check(fs.readdirSync(docsDir).length === 3, 'removing the folder from Burrow changed the files on disk');
    log('folders: smoke folder removed');
  } finally {
    if (folderId !== null) {
      try {
        const res = await get(`/api/folders/${folderId}`, { method: 'DELETE', headers: { cookie, origin: base } });
        await res.arrayBuffer();
      } catch {
        /* the sidecar is torn down by the caller */
      }
    }
    fs.rmSync(docsDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

/**
 * Runs the whole smoke test. Resolves with a summary, rejects with the first failed check.
 * @param {{ sidecar: string, resources: string, expectVersion?: string, expectDistribution?: 'direct' | 'store', expectDataLocation?: 'appdata' | 'userprofile', expectPro?: 'present' | 'absent', readyTimeoutMs?: number,
 *   exitTimeoutMs?: number, log?: (line: string) => void }} opts
 */
export async function runSmoke({
  sidecar,
  resources,
  expectVersion,
  expectDistribution,
  expectDataLocation,
  expectPro,
  readyTimeoutMs = READY_TIMEOUT_MS,
  exitTimeoutMs = EXIT_TIMEOUT_MS,
  log = (line) => console.log(line),
}) {
  if (expectPro !== undefined && expectPro !== 'present' && expectPro !== 'absent') throw new Error('--expect-pro must be present or absent');
  const exe = path.resolve(sidecar);
  const distDir = path.resolve(resources, 'dist');
  const migrationsDir = path.resolve(resources, 'migrations');
  check(fs.statSync(exe, { throwIfNoEntry: false })?.isFile(), `sidecar not found: ${exe}`);
  check(fs.existsSync(path.join(distDir, 'index.html')), `no index.html in ${distDir}`);
  check(fs.existsSync(migrationsDir), `no migrations folder at ${migrationsDir}`);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-smoke-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
  const secret = newSecretHex();
  const profileDir = path.join(root, 'profile');
  const env = buildSidecarEnv({
    base: process.env, platform: process.platform, distDir, migrationsDir, dataDir: expectDataLocation ? null : dataDir, profileDir,
  });
  for (const dir of ['appdata', 'localappdata', 'userprofile', 'home', 'xdg_data_home']) {
    fs.mkdirSync(path.join(root, 'profile', dir), { recursive: true });
  }

  const child = spawn(exe, [], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  child.stdin.on('error', () => {});
  const exited = new Promise((resolve) => {
    child.once('error', (err) => resolve({ code: null, signal: null, error: err }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  try {
    child.stdin.write(`${secret}\n`);
    log(`launched ${path.basename(exe)}, waiting up to ${readyTimeoutMs} ms for ${READY_PREFIX.trim()}`);

    let ready = null;
    let early = null;
    let userProfileDir = null;
    void exited.then((r) => (early = r));
    const started = Date.now();
    while (!ready && Date.now() - started < readyTimeoutMs) {
      ready = findReady(stdout);
      if (ready) break;
      check(early === null, `sidecar exited before ready (code ${early?.code}, ${early?.error?.message ?? 'no error'}): ${stderr.slice(-500)}`);
      await sleep(100);
    }
    check(ready, `no ${READY_PREFIX.trim()} line within ${readyTimeoutMs} ms: ${stderr.slice(-500)}`);
    log(`ready on port ${ready.port}, version ${ready.version}`);
    if (expectDataLocation) {
      // The sidecar picked its own folder: it must be the one the data location names, inside the throwaway profile.
      const wanted = expectDataLocation === 'userprofile' ? path.join(profileDir, 'userprofile', 'Burrow Data') : path.join(profileDir, 'appdata', 'Burrow');
      const other = expectDataLocation === 'userprofile' ? path.join(profileDir, 'appdata', 'Burrow') : path.join(profileDir, 'userprofile', 'Burrow Data');
      check(path.resolve(ready.dataDir).toLowerCase() === path.resolve(wanted).toLowerCase(), `sidecar data dir ${ready.dataDir}, expected ${wanted}`);
      check((ready.dataLocation ?? 'appdata') === expectDataLocation, `sidecar data location ${ready.dataLocation}, expected ${expectDataLocation}`);
      check(fs.existsSync(path.join(wanted, 'burrow.db')), `no burrow.db in ${wanted}`);
      check(!fs.existsSync(other), `the other data folder was created: ${other}`);
      if (expectDataLocation === 'userprofile') {
        // The folder was missing, so the sidecar created it with the ownership marker.
        check(fs.existsSync(path.join(wanted, '.burrow-data.json')), `no .burrow-data.json in ${wanted}`);
        userProfileDir = wanted;
      }
    } else {
      check(path.resolve(ready.dataDir) === path.resolve(dataDir), 'sidecar reported an unexpected data dir');
    }
    check(ready.channel === undefined || ready.channel === 'stable', `sidecar channel ${ready.channel}, expected stable`);
    if (expectVersion) check(ready.version === expectVersion, `sidecar version ${ready.version}, expected ${expectVersion}`);
    if (expectDistribution) check((ready.distribution ?? 'direct') === expectDistribution, `sidecar distribution ${ready.distribution}, expected ${expectDistribution}`);
    check(!stdout.includes(secret) && !stderr.includes(secret), 'the launch secret appeared in the sidecar output');

    const base = `http://127.0.0.1:${ready.port}`;
    const get = async (p, init) => {
      try {
        return await fetch(`${base}${p}`, { redirect: 'manual', signal: AbortSignal.timeout(15_000), ...init });
      } catch (err) {
        await Promise.race([exited, sleep(1000)]); // give a crash a moment to report its exit code
        const safeStderr = secret ? stderr.replaceAll(secret, '[redacted]') : stderr;
        throw new SmokeError(`fetch ${p.split('?')[0]} failed (${err?.cause?.code ?? err?.message}); ${describeChildState(child, safeStderr)}`);
      }
    };

    const denied = await get('/api/transactions');
    check(denied.status === 401, `/api/transactions without a cookie returned ${denied.status}, expected 401`);
    await denied.arrayBuffer();

    const boot = await get(`/desktop/bootstrap?token=${bootstrapTokenFor(secret)}`);
    check(boot.status === 302, `bootstrap returned ${boot.status}, expected 302`);
    await boot.arrayBuffer();
    const cookie = extractCookie(boot.headers.getSetCookie());
    check(cookie, `bootstrap did not set the ${COOKIE_NAME} cookie`);

    for (const route of ['/api/transactions', '/api/license']) {
      const res = await get(route, { headers: { cookie } });
      check(res.status === 200, `${route} returned ${res.status}, expected 200`);
      check(isJsonType(res.headers.get('content-type')), `${route} did not return JSON`);
      JSON.parse(await res.text());
      log(`${route} -> 200 JSON`);
    }

    // The developer tier switcher must be compiled out of a stable sidecar: no route, and the app info says so.
    const devRoute = await get('/api/dev/license', { headers: { cookie } });
    check(devRoute.status === 404, `/api/dev/license returned ${devRoute.status}, expected 404 (developer tools must not be in a stable sidecar)`);
    await devRoute.arrayBuffer();
    const infoRes = await get('/api/app/info', { headers: { cookie } });
    check(infoRes.status === 200, `/api/app/info returned ${infoRes.status}, expected 200`);
    check(JSON.parse(await infoRes.text())?.data?.devTools === false, '/api/app/info reports devTools other than false in a stable sidecar');
    log('/api/dev/license -> 404, devTools false');
    if (expectPro) await checkProModule({ get, cookie, base, expectPro, log });
    if (expectDistribution) {
      const info = await get('/api/app/info', { headers: { cookie } });
      check(info.status === 200, `/api/app/info returned ${info.status}, expected 200`);
      const infoBody = JSON.parse(await info.text());
      check(infoBody?.data?.distribution === expectDistribution, `/api/app/info distribution ${infoBody?.data?.distribution}, expected ${expectDistribution}`);
      log(`/api/app/info -> distribution ${expectDistribution}`);
      if (expectDataLocation) {
        check(infoBody?.data?.dataLocation === expectDataLocation, `/api/app/info dataLocation ${infoBody?.data?.dataLocation}, expected ${expectDataLocation}`);
        check(path.resolve(String(infoBody?.data?.dataDir)).toLowerCase() === path.resolve(ready.dataDir).toLowerCase(), '/api/app/info dataDir does not match the ready line');
        log(`/api/app/info -> data location ${expectDataLocation}, ${infoBody.data.dataDir}`);
      }
      if (expectDistribution === 'store') {
        const updates = await get('/api/settings/updates/check', { headers: { cookie } });
        const updatesBody = JSON.parse(await updates.text());
        check(updates.status === 200 && updatesBody?.data?.status === 'store_managed', 'the update check did not answer store_managed');
        log('/api/settings/updates/check -> store_managed (no network)');
      }
    }

    const page = await get('/', { headers: { cookie } });
    check(page.status === 200, `/ returned ${page.status}, expected 200`);
    check(looksLikeAppHtml(page.headers.get('content-type'), await page.text()), '/ did not return the app HTML');
    log('/ -> 200 HTML');

    await checkFolderDocuments({ get, cookie, base, log });

    child.stdin.end();
    const result = await Promise.race([exited, sleep(exitTimeoutMs).then(() => null)]);
    check(result, `sidecar still running ${exitTimeoutMs} ms after stdin closed`);
    check(result.code === 0, `sidecar exited with code ${result.code ?? result.signal}, expected 0`);
    log('clean exit (code 0) after stdin closed');
    if (userProfileDir !== null) await checkRefusesForeignFolder({ exe, env, folder: userProfileDir, exitTimeoutMs, log });
    return { port: ready.port, version: ready.version };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.race([exited, sleep(5000)]);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

/**
 * The Pro module check: `proModule` in /api/app/info and the explain route. With the module the Pro validator answers
 * 400 for an empty body; without it core answers 501 pro_not_included (the fresh data dir has an active trial).
 */
async function checkProModule({ get, cookie, base, expectPro, log }) {
  const info = await get('/api/app/info', { headers: { cookie } });
  check(info.status === 200, `/api/app/info returned ${info.status}, expected 200`);
  const proModule = JSON.parse(await info.text())?.data?.proModule;
  check(proModule === (expectPro === 'present'), `/api/app/info proModule is ${proModule}, expected ${expectPro === 'present'}`);
  const res = await get('/api/insights/explain', {
    method: 'POST',
    headers: { cookie, origin: base, 'content-type': 'application/json' },
    body: '{}',
  });
  const body = await res.text();
  const wanted = expectPro === 'present' ? 400 : 501;
  check(res.status === wanted, `POST /api/insights/explain returned ${res.status}, expected ${wanted}`);
  if (expectPro === 'absent') check(JSON.parse(body)?.error === 'pro_not_included', 'POST /api/insights/explain did not answer pro_not_included');
  log(`Pro module ${expectPro}: proModule ${proModule}, /api/insights/explain -> ${res.status}`);
}

/** The stable host sidecar and resources that `npm run desktop:sidecar` writes. */
export function defaultSidecarPaths(root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')) {
  const triple = hostTriple();
  return {
    sidecar: path.join(root, 'src-tauri', 'binaries', `burrow-server-${triple}${triple.includes('windows') ? '.exe' : ''}`),
    resources: path.join(root, 'src-tauri', 'resources'),
  };
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      sidecar: { type: 'string' },
      resources: { type: 'string' },
      'expect-version': { type: 'string' },
      'expect-distribution': { type: 'string' },
      'expect-data-location': { type: 'string' },
      'expect-pro': { type: 'string' },
      'ready-timeout-ms': { type: 'string', default: String(READY_TIMEOUT_MS) },
      'exit-timeout-ms': { type: 'string', default: String(EXIT_TIMEOUT_MS) },
    },
    strict: true,
  });
  if (Boolean(values.sidecar) !== Boolean(values.resources)) {
    throw new Error('Usage: smokeSidecar.js [--sidecar <exe> --resources <dir>] [--expect-version x.y.z] [--expect-pro present|absent]');
  }
  const defaults = values.sidecar ? null : defaultSidecarPaths();
  await runSmoke({
    sidecar: values.sidecar ?? defaults.sidecar,
    resources: values.resources ?? defaults.resources,
    expectPro: values['expect-pro'],
    expectVersion: values['expect-version'],
    expectDistribution: values['expect-distribution'],
    expectDataLocation: values['expect-data-location'],
    readyTimeoutMs: Number(values['ready-timeout-ms']),
    exitTimeoutMs: Number(values['exit-timeout-ms']),
  });
  console.log('Sidecar smoke test passed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`::error::Sidecar smoke test failed: ${err.message}`);
    process.exit(1);
  });
}
