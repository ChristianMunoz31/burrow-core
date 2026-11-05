// Is the direct Burrow (the installer edition, whose data is %APPDATA%\Burrow) running right now? Asked before the import
// from it. Three answers: 'no', 'yes' and 'unknown', and 'unknown' is treated like 'yes' (refuse, ask the user to quit it).
//
// Why a process check and not a lock: the direct server holds no lock a second program can try. SQLite takes byte-range
// locks inside burrow.db-shm, but probing them means opening the database through SQLite, and even a read-only SQLite
// connection creates -wal and -shm files in the folder (see the header of server/backup/stableCopy.js), which would change
// the other Burrow's folder. So the primary signal is the list of running Burrow programs with their file paths
// (Win32_Process through PowerShell): a Burrow.exe or burrow-server.exe that is NOT in this package's own folder is the
// other Burrow. A Burrow in another Windows session (another signed-in user, fast user switching) has its own data folder
// and cannot be the source, so it is ignored when both session ids are known; a missing id keeps the process counted.
// The copy itself adds a second, independent guard: it compares the file signatures (sizes, times, WAL and
// wal-index headers) before and after reading and retries or stops when they changed, which a running writer causes.
import { execFile } from 'node:child_process';
import path from 'node:path';

export const BURROW_PROCESS_NAMES = Object.freeze(['Burrow.exe', 'burrow-server.exe']);
const PS_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

const POWERSHELL_COMMAND =
  "$ErrorActionPreference='Stop'; " +
  '$cur = (Get-Process -Id $PID).SessionId; ' +
  "$p = @(Get-CimInstance Win32_Process -Filter \"Name='Burrow.exe' OR Name='burrow-server.exe'\" | " +
  "Select-Object ProcessId,Name,ExecutablePath,SessionId,@{n='CurrentSessionId';e={$cur}}); " +
  "if ($p.Count -eq 0) { Write-Output '[]' } else { ConvertTo-Json -InputObject $p -Compress }";

/**
 * Parses the PowerShell output into process records. Returns null for anything that is not the expected JSON array, so the
 * caller answers 'unknown'.
 * @param {string} text
 * @returns {Array<{ pid: number, name: string, exe: string | null, session: number | null, currentSession: number | null }> | null}
 */
export function parseProcessList(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text).trim());
  } catch {
    return null;
  }
  const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? [parsed] : null;
  if (list === null) return null;
  const out = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || !Number.isInteger(entry.ProcessId) || typeof entry.Name !== 'string') return null;
    out.push({
      pid: entry.ProcessId,
      name: entry.Name,
      exe: typeof entry.ExecutablePath === 'string' && entry.ExecutablePath ? entry.ExecutablePath : null,
      session: Number.isInteger(entry.SessionId) ? entry.SessionId : null,
      currentSession: Number.isInteger(entry.CurrentSessionId) ? entry.CurrentSessionId : null,
    });
  }
  return out;
}

const fold = (p) => path.win32.resolve(p).toLowerCase();

/**
 * Decides from a process list. A process counts as the other Burrow when it is a Burrow program that is not one of our own
 * pids and whose folder is not this package's folder; a Burrow program whose path cannot be read counts as the other one. A
 * process in another Windows session than ours does not count (both ids known); an unknown session id counts.
 * @param {Array<{ pid: number, name: string, exe: string | null, session?: number | null, currentSession?: number | null }>} processes
 * @param {{ ownPids: number[], ownDir: string }} own
 * @returns {boolean}
 */
export function otherBurrowIsRunning(processes, { ownPids, ownDir }) {
  const mine = fold(ownDir);
  return processes.some((proc) => {
    if (ownPids.includes(proc.pid)) return false;
    if (Number.isInteger(proc.session) && Number.isInteger(proc.currentSession) && proc.session !== proc.currentSession) return false;
    if (!BURROW_PROCESS_NAMES.some((name) => name.toLowerCase() === proc.name.toLowerCase())) return false;
    if (proc.exe === null) return true;
    return fold(path.win32.dirname(proc.exe)) !== mine;
  });
}

function defaultRunPowerShell(systemRoot) {
  const exe = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    execFile(
      exe,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', POWERSHELL_COMMAND],
      { timeout: PS_TIMEOUT_MS, windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

/**
 * @param {{ platform?: NodeJS.Platform, env?: Record<string, string | undefined>, ownPids?: number[], ownDir?: string,
 *   run?: () => Promise<string> }} [opts] `run` is a test seam that returns the PowerShell output.
 * @returns {Promise<'no' | 'yes' | 'unknown'>}
 */
export async function detectDirectBurrowRunning({
  platform = process.platform,
  env = process.env,
  ownPids = [process.pid, process.ppid],
  ownDir = path.dirname(process.execPath),
  run,
} = {}) {
  if (platform !== 'win32' && !run) return 'unknown';
  try {
    const output = await (run ? run() : defaultRunPowerShell(env.SystemRoot || env.windir || 'C:\\Windows'));
    const processes = parseProcessList(output);
    if (processes === null) return 'unknown';
    return otherBurrowIsRunning(processes, { ownPids, ownDir }) ? 'yes' : 'no';
  } catch {
    return 'unknown';
  }
}
