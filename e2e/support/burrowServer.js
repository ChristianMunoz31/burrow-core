// Starts the built Burrow server for one Playwright spec file, in a sandbox that cannot reach the
// real data dir, the real Ollama or the internet.
//
//   const server = await startBurrow({ seed, ollama, fixedNow, scheduler, firstRun, distDir });
//   server.url / dataDir / expectedDataDir / fake / netlog() / outbound() / envKeys / stop()
//
// Safety, in order of enforcement:
//  1. Every path lives under one fresh temp root (`burrow-e2e-*`), the fake home included, so a
//     server that ignores BURROW_DATA_DIR still lands in temp (HOME, USERPROFILE, APPDATA,
//     LOCALAPPDATA and XDG_DATA_HOME all point into the fake home).
//  2. The data dir the server will use is computed BEFORE spawn (with the same resolver the server
//     uses) and must pass assertSafeDataDir (inside temp, unrelated to the real data dir).
//  3. After start, the `Data:` line the server prints must be that exact file, else the process is
//     killed and the start fails.
//  4. The child env is a scrubbed allowlist (buildChildEnv): no tokens, no OLLAMA_HOST unless the
//     mode sets it, and a fake Ollama can never be on 11434 (assertAiEnvSafe).
//  5. The serverNetRecorder preload fails every non-loopback connection and every connection to
//     the reserved loopback ports 11434, 4321 and 5174, and logs them.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveDataDir } from '../../server/paths.js';
import { startFakeOllama } from '../../scripts/lib/fakeOllamaServer.js';
import {
  SandboxSafetyError,
  assertAiEnvSafe,
  assertSafeDataDir,
  assertSafePort,
  assertUnderTmp,
  buildAiEnv,
  buildChildEnv,
  freePort,
  samePath,
} from '../../scripts/lib/sandboxSafety.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SUPPORT = path.dirname(fileURLToPath(import.meta.url));
const START_TIMEOUT_MS = 30_000;
const OLLAMA_MODES = ['dead', 'fake', 'default'];

const preload = (file) => pathToFileURL(path.join(SUPPORT, file)).href;

/**
 * @param {{
 *   seed?: boolean,
 *   ollama?: 'dead' | 'fake' | 'default',
 *   fixedNow?: string | null,
 *   scheduler?: boolean,
 *   firstRun?: boolean,
 *   fakeChat?: (body: object) => unknown,
 *   preseed?: { briefingToday?: boolean } | null,
 *   distDir?: string,
 * }} [opts] `distDir` is the built client the server serves (BURROW_DIST_DIR in the child env). Default: the
 *   BURROW_E2E_DIST_DIR env var, else `<repo>/dist`; an explicit option wins over the env var. `firstRun` sets no product config at all (no BURROW_DATA_DIR, BURROW_HOST,
 *   BURROW_SCHEDULER or opt-ins; only BURROW_PORT), so the server uses its per-OS default data dir,
 *   which the fake home turns into a folder inside temp. `preseed` writes test-only state before the start
 *   (e2e/support/preseed.mjs: today's briefing).
 */
export async function startBurrow({ seed = false, ollama = 'dead', fixedNow = null, scheduler = false, firstRun = false, fakeChat, preseed = null, distDir } = {}) {
  if (!OLLAMA_MODES.includes(ollama)) throw new Error(`Unknown ollama mode: ${String(ollama)}`);
  if (firstRun && (seed || fixedNow || preseed)) throw new Error('firstRun means an empty data dir and the real clock: no seed, no fixedNow, no preseed.');
  const resolvedDistDir = path.resolve(distDir ?? (globalThis.process?.env?.BURROW_E2E_DIST_DIR || path.join(REPO_ROOT, 'dist')));
  if (!fs.existsSync(path.join(resolvedDistDir, 'index.html'))) {
    throw new Error(`${resolvedDistDir} has no index.html. Run \`npm run build\` before the e2e tests.`);
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-e2e-'));
  assertUnderTmp(root);
  const homeDir = path.join(root, 'home');
  const netlogFile = path.join(root, 'netlog.jsonl');
  fs.writeFileSync(netlogFile, '');
  const port = assertSafePort(await freePort());

  /** @type {Awaited<ReturnType<typeof startFakeOllama>> | null} */
  let fake = null;
  let child = null;
  const cleanupAll = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    }
    await fake?.close();
    fs.rmSync(assertUnderTmp(root), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };

  try {
    const extra = { BURROW_NO_DOTENV: '1', BURROW_PORT: String(port), BURROW_E2E_NETLOG: netlogFile, BURROW_DIST_DIR: resolvedDistDir };
    let dataDir;
    if (firstRun) {
      // Nothing else: no BURROW_DATA_DIR, no BURROW_HOST, no BURROW_SCHEDULER, no opt-ins.
    } else {
      dataDir = assertSafeDataDir(path.join(root, 'data'));
      fs.mkdirSync(dataDir, { recursive: true });
      extra.BURROW_DATA_DIR = dataDir;
      extra.BURROW_HOST = '127.0.0.1';
      if (!scheduler) extra.BURROW_SCHEDULER = '0';
    }
    if (fixedNow) extra.BURROW_E2E_FIXED_NOW = fixedNow;

    if (ollama === 'fake') {
      fake = await startFakeOllama({ chat: fakeChat });
      Object.assign(extra, buildAiEnv({ mode: 'fake', fakeUrl: fake.url }));
    } else if (ollama === 'dead') {
      Object.assign(extra, buildAiEnv({ mode: 'none', deadPort: await freePort() }));
    }

    const env = buildChildEnv({ homeDir, extra });
    if (ollama !== 'default') assertAiEnvSafe(ollama === 'fake' ? 'fake' : 'none', env);
    else if (env.OLLAMA_HOST) throw new SandboxSafetyError('The default-Ollama mode must not set OLLAMA_HOST.');

    // The data dir the server will use, computed with the server's own resolver and the child env.
    const expectedDataDir = assertSafeDataDir(resolveDataDir({ env, platform: process.platform, home: homeDir }));
    for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_DATA_HOME']) {
      assertUnderTmp(env[key]);
    }
    const dbFile = path.join(expectedDataDir, 'burrow.db');

    if (seed) {
      const args = [path.join(REPO_ROOT, 'scripts', 'seedDemo.js'), '--data-dir', expectedDataDir];
      if (fixedNow) args.push('--now', fixedNow);
      const res = spawnSync(process.execPath, args, { cwd: REPO_ROOT, env, stdio: 'pipe', shell: false, encoding: 'utf8' });
      if (res.status !== 0) throw new Error(`Seeding failed (exit ${res.status ?? 'signal'}): ${res.stderr || res.stdout}`);
    }

    if (preseed) {
      // Under the same fixed clock as the server, so the briefing time matches the server's "now".
      const args = [...(fixedNow ? ['--import', preload('fixedClock.mjs')] : []), path.join(SUPPORT, 'preseed.mjs'), JSON.stringify(preseed)];
      const res = spawnSync(process.execPath, args, { cwd: REPO_ROOT, env, stdio: 'pipe', shell: false, encoding: 'utf8' });
      if (res.status !== 0) throw new Error(`Preseed failed (exit ${res.status ?? 'signal'}): ${res.stderr || res.stdout}`);
    }

    const nodeArgs = ['--import', preload('serverNetRecorder.mjs')];
    if (fixedNow) nodeArgs.push('--import', preload('fixedClock.mjs'));
    nodeArgs.push(path.join(REPO_ROOT, 'server.js'));
    child = spawn(process.execPath, nodeArgs, { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });

    const log = [];
    let reportedDb = null;
    await new Promise((resolve, reject) => {
      let gotAddress = false;
      const timer = setTimeout(() => reject(new Error(`The server did not start in ${START_TIMEOUT_MS} ms.\n${log.join('\n')}`)), START_TIMEOUT_MS);
      const fail = (err) => {
        clearTimeout(timer);
        reject(err);
      };
      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        log.push(line);
        if (line.startsWith('Burrow running at ')) {
          let reported = null;
          try {
            reported = new URL(line.slice('Burrow running at '.length).trim());
          } catch {
            // Falls through to the mismatch error.
          }
          if (!reported || Number(reported.port) !== port) return fail(new SandboxSafetyError(`The server reported a different address: ${line}`));
          gotAddress = true;
        } else if (line.startsWith('Data: ')) {
          reportedDb = line.slice('Data: '.length).trim();
          if (!samePath(reportedDb, dbFile)) return fail(new SandboxSafetyError(`The server reported a different data file than expected (${reportedDb}, expected ${dbFile}).`));
          if (!gotAddress) return fail(new Error('The server printed its data file before its address.'));
          clearTimeout(timer);
          resolve();
        }
        return undefined;
      });
      readline.createInterface({ input: child.stderr }).on('line', (line) => log.push(`stderr: ${line}`));
      child.once('error', (err) => fail(err));
      child.once('exit', (code) => fail(new Error(`The server exited early (code ${code}).\n${log.join('\n')}`)));
    });
    child.removeAllListeners('exit');

    const readNetlog = () =>
      fs
        .readFileSync(netlogFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));

    return {
      url: `http://127.0.0.1:${port}`,
      port,
      dataDir: expectedDataDir,
      reportedDbFile: reportedDb,
      expectedDataDir,
      /** Names of the env vars the server was started with (values are never exposed). */
      envKeys: Object.keys(env).sort(),
      fake,
      netlog: readNetlog,
      /** Outbound attempts: everything except the simulated "no Ollama" loopback refusals. */
      outbound: () => readNetlog().filter((e) => e.kind !== 'loopback-reserved'),
      stop: cleanupAll,
    };
  } catch (err) {
    await cleanupAll().catch(() => {});
    throw err;
  }
}
