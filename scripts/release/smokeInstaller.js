// CI-only smoke test for the Windows NSIS installer: silent per-user install into a folder under
// %LOCALAPPDATA%, check the installed app and sidecar exist, launch the installed app with
// BURROW_DESKTOP_DATA_DIR pointing at a temp dir, wait until server.log shows BURROW_READY, stop it, then run
// the silent uninstaller and check the app is gone.
//
// It refuses to run outside GitHub Actions: the installer registers the same app identifier as a real Burrow
// install, so running it on a developer machine could replace or remove the real app. The temp data dir keeps
// the real data (%APPDATA%\Burrow) out of reach in any case.
//
// Usage: node scripts/release/smokeInstaller.js --installer <Burrow-Setup-*.exe> [--ready-timeout-ms 90000]
import { execFile as execFileCb, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { parseReadyLine } from './smokeSidecar.js';

const execFile = promisify(execFileCb);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const APP_EXE = 'Burrow.exe';
export const SIDECAR_EXE = 'burrow-server.exe';
export const UNINSTALLER = 'uninstall.exe';
export const LOG_IDENTIFIER = 'com.burrow.desktop';

/**
 * Where the shell writes server.log on Windows (see docs/INSTALL.md).
 * @param {string} localAppData
 * @returns {string}
 */
export const serverLogPath = (localAppData) => path.join(localAppData, LOG_IDENTIFIER, 'logs', 'server.log');

/**
 * The ready payload in server.log text (lines look like `[out] BURROW_READY {...}`), or null.
 * @param {string} text
 */
export function readyFromServerLog(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const ready = parseReadyLine(line.replace(/^\[out\]\s*/, ''));
    if (ready) return ready;
  }
  return null;
}

/**
 * NSIS arguments for a silent per-user install. `/D=` must be the LAST argument and is not quoted.
 * @param {string} installDir
 * @returns {string[]}
 */
export const installArgs = (installDir) => ['/S', `/D=${installDir}`];

/**
 * Silent uninstall arguments. `_?=<dir>` keeps the uninstaller from copying itself away, so the call blocks until
 * the uninstall is done.
 * @param {string} installDir
 * @returns {string[]}
 */
export const uninstallArgs = (installDir) => ['/S', `_?=${installDir}`];

class SmokeError extends Error {}
const check = (condition, message) => {
  if (!condition) throw new SmokeError(message);
};

async function killApp(appPid) {
  for (const image of [APP_EXE, SIDECAR_EXE]) {
    await execFile('taskkill', ['/F', '/T', '/IM', image]).catch(() => {});
  }
  if (appPid) await execFile('taskkill', ['/F', '/T', '/PID', String(appPid)]).catch(() => {});
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { installer: { type: 'string' }, 'ready-timeout-ms': { type: 'string', default: '90000' } },
    strict: true,
  });
  check(values.installer, 'Usage: smokeInstaller.js --installer <exe>');
  check(process.env.GITHUB_ACTIONS === 'true', 'refusing to run outside GitHub Actions');
  check(process.platform === 'win32', 'the installer smoke test only runs on Windows');
  const installer = path.resolve(values.installer);
  check(fs.existsSync(installer), `installer not found: ${installer}`);
  const localAppData = process.env.LOCALAPPDATA;
  check(localAppData, 'LOCALAPPDATA is not set');

  const installDir = path.join(localAppData, 'BurrowSmoke');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-installer-smoke-'));
  const logFile = serverLogPath(localAppData);
  let appPid = null;
  let leftover;
  try {
    console.log(`installing silently into ${installDir}`);
    await execFile(installer, installArgs(installDir), { windowsHide: true, timeout: 180_000, windowsVerbatimArguments: true });
    // NSIS /S returns when the install is done for a per-user install; wait for the files to settle.
    for (let i = 0; i < 60 && !fs.existsSync(path.join(installDir, APP_EXE)); i += 1) await sleep(500);
    check(fs.existsSync(path.join(installDir, APP_EXE)), `${APP_EXE} was not installed`);
    check(fs.existsSync(path.join(installDir, SIDECAR_EXE)), `${SIDECAR_EXE} was not installed next to the app`);
    check(fs.existsSync(path.join(installDir, UNINSTALLER)), `${UNINSTALLER} was not installed`);
    console.log('installed app, sidecar and uninstaller found');

    fs.rmSync(logFile, { force: true });
    const app = spawn(path.join(installDir, APP_EXE), [], {
      env: { ...process.env, BURROW_DESKTOP_DATA_DIR: dataDir },
      stdio: 'ignore',
      windowsHide: true,
    });
    appPid = app.pid;
    let appExit = null;
    app.once('exit', (code) => (appExit = { code }));
    const timeout = Number(values['ready-timeout-ms']);
    const started = Date.now();
    let ready = null;
    while (!ready && Date.now() - started < timeout) {
      if (fs.existsSync(logFile)) ready = readyFromServerLog(fs.readFileSync(logFile, 'utf8'));
      if (ready) break;
      check(appExit === null, `the installed app exited early (code ${appExit?.code})`);
      await sleep(500);
    }
    check(ready, `server.log never showed BURROW_READY within ${timeout} ms`);
    check(path.resolve(ready.dataDir) === path.resolve(dataDir), 'installed app ignored BURROW_DESKTOP_DATA_DIR');
    console.log(`installed app is serving on port ${ready.port}, version ${ready.version}`);
  } finally {
    await killApp(appPid);
    await sleep(1500);
    if (fs.existsSync(path.join(installDir, UNINSTALLER))) {
      console.log('uninstalling silently');
      await execFile(path.join(installDir, UNINSTALLER), uninstallArgs(installDir), { windowsHide: true, timeout: 120_000, windowsVerbatimArguments: true }).catch((err) => {
        console.log(`::warning::uninstaller failed: ${err.message}`);
      });
    }
    leftover = fs.existsSync(path.join(installDir, APP_EXE));
    fs.rmSync(installDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
  check(!leftover, 'the app was still installed after the uninstaller ran');
  console.log('Installer smoke test passed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`::error::Installer smoke test failed: ${err.message}`);
    process.exit(1);
  });
}
