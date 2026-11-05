// Guards shared by the sandbox, preview and seed scripts. They exist so a dev tool can never
// touch the real Burrow data directory or collide with the owner's live dev servers.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { appDataFolderDir, stableDefaultDataDirs } from '../../server/paths.js';
import { canonical } from '../../server/pathGuard.js';

export const SANDBOX_ROOT = path.join(os.tmpdir(), 'burrow-sandbox');
export const PREVIEW_ROOT = path.join(os.tmpdir(), 'burrow-previews');
export const RESERVED_PORTS = Object.freeze([4321, 5174]);

export class SandboxSafetyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SandboxSafetyError';
  }
}

/**
 * The per-OS default data directory of the stable Burrow, ignoring any BURROW_DATA_DIR override and
 * BURROW_CHANNEL.
 * @param {{ env?: Record<string, string | undefined>, platform?: NodeJS.Platform, home?: string }} [opts]
 * @returns {string}
 */
export function realDefaultDataDir({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  return appDataFolderDir({ env, platform, home, channel: 'stable' });
}

/**
 * The default data directories of both channels (Burrow and Burrow Dev) and, on Windows, %USERPROFILE%\Burrow Data of the
 * Microsoft Store build: all of them are real data.
 * @param {{ env?: Record<string, string | undefined>, platform?: NodeJS.Platform, home?: string }} [opts]
 * @returns {string[]}
 */
export function realDefaultDataDirs({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const base = { env: { ...env, BURROW_DATA_DIR: '' }, platform, home };
  return [...stableDefaultDataDirs(base), appDataFolderDir({ ...base, channel: 'dev' })];
}

const pathFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);

const isInside = (parent, child, mod) => {
  const rel = mod.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !mod.isAbsolute(rel);
};

/**
 * Throws unless `dir` is strictly inside the OS temp dir and unrelated to the real data dir
 * (not equal to it, not inside it, not one of its parents).
 * @param {string} dir
 * @param {{ env?: Record<string, string | undefined>, platform?: NodeJS.Platform, home?: string, tmpdir?: string }} [opts]
 * @returns {string} The resolved directory.
 */
export function assertSafeDataDir(dir, opts = {}) {
  const { env = process.env, platform = process.platform, home = os.homedir(), tmpdir = os.tmpdir() } = opts;
  if (typeof dir !== 'string' || dir.trim() === '') throw new SandboxSafetyError('A data directory is required.');
  const mod = pathFor(platform);
  const fold = (p) => (platform === 'win32' ? p.toLowerCase() : p);
  const target = fold(canonical(dir, mod, platform));
  const reals = realDefaultDataDirs({ env, platform, home }).map((d) => fold(canonical(d, mod, platform)));
  const tmp = fold(canonical(tmpdir, mod, platform));
  if (reals.some((real) => target === real || isInside(real, target, mod) || isInside(target, real, mod))) {
    throw new SandboxSafetyError('Refusing to use the real Burrow data directory.');
  }
  if (!isInside(tmp, target, mod)) {
    throw new SandboxSafetyError('The data directory must be inside the OS temp directory.');
  }
  return mod.resolve(dir);
}

/**
 * Throws unless `port` is an integer in 1024..65535 and not one of the owner's dev ports.
 * @param {unknown} port
 * @returns {number}
 */
export function assertSafePort(port) {
  const n = typeof port === 'string' && /^\d+$/.test(port.trim()) ? Number(port) : port;
  if (!Number.isInteger(n)) throw new SandboxSafetyError('Port must be an integer.');
  if (n < 1024 || n > 65535) throw new SandboxSafetyError('Port must be between 1024 and 65535.');
  if (RESERVED_PORTS.includes(n)) throw new SandboxSafetyError(`Port ${n} belongs to the live dev servers.`);
  return n;
}

/**
 * Picks a free loopback port by binding port 0 and releasing it, skipping reserved ports.
 * @returns {Promise<number>}
 */
export async function freePort() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const port = await new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const { port: p } = srv.address();
        srv.close(() => resolve(p));
      });
    });
    if (!RESERVED_PORTS.includes(port)) return port;
  }
  throw new SandboxSafetyError('Could not find a free port.');
}

/**
 * Throws unless `root` is strictly inside the OS temp dir (used before any recursive delete).
 * @param {string} root
 * @returns {string}
 */
export function assertUnderTmp(root) {
  const mod = path;
  const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  if (!isInside(fold(canonical(os.tmpdir(), mod, process.platform)), fold(canonical(root, mod, process.platform)), mod)) {
    throw new SandboxSafetyError('Refusing to delete outside the OS temp directory.');
  }
  return root;
}

const ENV_ALLOWLIST = ['PATH', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP'];

/**
 * Case-insensitive path equality on win32, exact elsewhere.
 * @param {string} a
 * @param {string} b
 * @param {NodeJS.Platform} [platform]
 * @returns {boolean}
 */
export function samePath(a, b, platform = process.platform) {
  return platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
}

/**
 * The per-sandbox fake home folder, a child of the sandbox data dir.
 * @param {string} dataDir
 * @returns {string}
 */
export const sandboxHomeFor = (dataDir) => path.join(dataDir, 'home');

/**
 * Env vars that redirect every per-user default location into `homeDir`, so a branch that ignores
 * BURROW_DATA_DIR still lands in temp. Creates the folders.
 * @param {string} homeDir
 * @returns {Record<string, string>}
 */
export function sandboxHomeEnv(homeDir) {
  const dirs = {
    HOME: homeDir,
    USERPROFILE: homeDir,
    APPDATA: path.join(homeDir, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(homeDir, 'AppData', 'Local'),
    XDG_DATA_HOME: path.join(homeDir, '.local', 'share'),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  return dirs;
}

/**
 * Builds a minimal child env: only allowlisted system vars from `source`, the fake-home vars and
 * the explicit `extra` vars. No tokens, no OLLAMA_HOST, no cloud keys, NODE_OPTIONS unset.
 * @param {{ extra?: Record<string, string>, homeDir?: string | null, source?: Record<string, string | undefined>, platform?: NodeJS.Platform }} [opts]
 * @returns {Record<string, string>}
 */
export function buildChildEnv({ extra = {}, homeDir = null, source = process.env, platform = process.platform } = {}) {
  const wanted = new Map(ENV_ALLOWLIST.map((k) => [platform === 'win32' ? k.toLowerCase() : k, k]));
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && wanted.has(platform === 'win32' ? key.toLowerCase() : key)) env[key] = value;
  }
  if (homeDir) Object.assign(env, sandboxHomeEnv(homeDir));
  return Object.assign(env, extra);
}

/**
 * Finds npm's JS entry point without a shell: `npm_execpath` when it is npm-cli.js, else the npm
 * bundled next to the running node binary.
 * @param {{ env?: Record<string, string | undefined>, execPath?: string, platform?: NodeJS.Platform, exists?: (p: string) => boolean }} [opts]
 * @returns {string}
 */
export function resolveNpmCli({ env = process.env, execPath = process.execPath, platform = process.platform, exists = fs.existsSync } = {}) {
  const mod = pathFor(platform);
  const fromEnv = env.npm_execpath;
  if (typeof fromEnv === 'string' && mod.basename(fromEnv) === 'npm-cli.js' && exists(fromEnv)) return fromEnv;
  const nodeDir = mod.dirname(execPath);
  const bundled =
    platform === 'win32'
      ? mod.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
      : mod.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (exists(bundled)) return bundled;
  throw new SandboxSafetyError(`Could not find npm-cli.js (looked at ${bundled}). Run this through npm or install npm next to node.`);
}

/**
 * Runs npm through node with no shell and the given (minimal) env. Throws on a non-zero exit.
 * @param {string[]} args
 * @param {{ cwd: string, env: Record<string, string> }} opts
 */
export function runNpm(args, { cwd, env }) {
  const res = spawnSync(process.execPath, [resolveNpmCli(), ...args], { cwd, env, stdio: 'inherit', shell: false });
  if (res.status !== 0) throw new Error(`npm ${args.join(' ')} failed (exit ${res.status ?? 'signal'})`);
}

// ---------------------------------------------------------------------------
// AI mode. The sandbox env is scrubbed, so a server started without OLLAMA_HOST resolves the
// default Ollama (http://127.0.0.1:11434): the owner's real one. Every sandbox therefore gets an
// explicit OLLAMA_HOST, and only --real-ai may point it at 11434.
// ---------------------------------------------------------------------------

export const REAL_OLLAMA_PORT = 11434;
export const AI_MODES = Object.freeze(['fake', 'real', 'none']);
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Picks the AI mode from the CLI flags: fake (default), real (--real-ai) or none (--no-ai).
 * @param {{ realAi?: boolean, noAi?: boolean }} flags
 * @returns {'fake' | 'real' | 'none'}
 */
export function resolveAiMode({ realAi = false, noAi = false } = {}) {
  if (realAi && noAi) throw new SandboxSafetyError('--real-ai and --no-ai cannot be used together.');
  if (realAi) return 'real';
  if (noAi) return 'none';
  return 'fake';
}

/** The loopback port named by an OLLAMA_HOST value, or null when it is not an explicit loopback http origin. */
function loopbackOllamaPort(value) {
  if (typeof value !== 'string') return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' || !LOOPBACK_NAMES.has(url.hostname) || url.username || url.password) return null;
  const port = Number(url.port);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null;
}

/**
 * The OLLAMA_HOST the sandbox server gets for an AI mode (pure).
 * @param {{ mode: 'fake' | 'real' | 'none', fakeUrl?: string | null, deadPort?: number | null }} opts
 * @returns {{ OLLAMA_HOST: string }}
 */
export function buildAiEnv({ mode, fakeUrl = null, deadPort = null }) {
  if (mode === 'real') return { OLLAMA_HOST: `http://127.0.0.1:${REAL_OLLAMA_PORT}` };
  if (mode === 'fake') {
    if (!fakeUrl) throw new SandboxSafetyError('The fake AI needs its address (fakeUrl).');
    return { OLLAMA_HOST: fakeUrl };
  }
  if (mode === 'none') {
    if (!Number.isInteger(deadPort)) throw new SandboxSafetyError('--no-ai needs a dead loopback port.');
    return { OLLAMA_HOST: `http://127.0.0.1:${deadPort}` };
  }
  throw new SandboxSafetyError(`Unknown AI mode: ${String(mode)}`);
}

/**
 * Throws unless the child env's OLLAMA_HOST matches the mode: only 'real' may name port 11434, and
 * 'fake' and 'none' must name an explicit loopback http origin on another port. Call before spawn.
 * @param {'fake' | 'real' | 'none'} mode
 * @param {Record<string, string | undefined>} env
 */
export function assertAiEnvSafe(mode, env) {
  if (!AI_MODES.includes(mode)) throw new SandboxSafetyError(`Unknown AI mode: ${String(mode)}`);
  const port = loopbackOllamaPort(env?.OLLAMA_HOST);
  if (mode === 'real') {
    if (port !== REAL_OLLAMA_PORT) throw new SandboxSafetyError('--real-ai must point OLLAMA_HOST at http://127.0.0.1:11434.');
    return;
  }
  if (port === null) throw new SandboxSafetyError(`Refusing to start: a ${mode === 'fake' ? 'fake-AI' : '--no-ai'} sandbox needs an explicit loopback OLLAMA_HOST.`);
  if (port === REAL_OLLAMA_PORT) throw new SandboxSafetyError(`Refusing to start: this sandbox would use the real Ollama (port ${REAL_OLLAMA_PORT}). Pass --real-ai to allow that.`);
}

/**
 * The Ollama host saved in a sandbox database (`app_state` `ai.settings`), which outranks
 * OLLAMA_HOST. Best effort: null when the file, table or value is missing or unreadable.
 * @param {string} dbFile
 * @returns {string | null}
 */
export function savedOllamaHost(dbFile) {
  if (!fs.existsSync(dbFile)) return null;
  let db = null;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true });
    const row = db.prepare('SELECT value FROM app_state WHERE key = ?').get('ai.settings');
    const parsed = row && typeof row.value === 'string' ? JSON.parse(row.value) : null;
    return parsed && typeof parsed.ollamaHost === 'string' && parsed.ollamaHost.trim() ? parsed.ollamaHost.trim() : null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Nothing to release.
    }
  }
}
