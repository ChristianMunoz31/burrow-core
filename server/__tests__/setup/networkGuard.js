// Test network guard (setup file for both Vitest projects).
//
// Goal: a test must never depend on whatever happens to run on the developer's machine (a real
// Ollama on 11434, the owner's live Burrow on 4321, Vite on 5174) and must never reach the
// internet. CI has none of those, so a leaky test passes locally and fails there.
//
// Mechanism: net.Socket.prototype.connect is patched once per worker (node builtins are shared
// across isolated test files, so the patch hides behind a Symbol.for key on globalThis). Every
// http/https/tls/undici/node-fetch client ends in Socket#connect. globalThis.fetch is wrapped as
// well so an absolute URL to a blocked target rejects immediately.
//
// Rules: IPC/path targets are allowed. Remote hosts are blocked. On loopback, the fixed ports
// 11434, 4321 and 5174 are blocked unless a test calls allowLoopbackPort(). Ephemeral loopback
// servers (supertest, listen(0)) are fine. If OLLAMA_HOST named a port when Vitest started (the
// developer's own Ollama on a custom port), that port is blocked too: vitest.config.js blanks
// OLLAMA_HOST for the workers and forwards the original in BURROW_GUARD_OLLAMA_HOST.
// A blocked call is recorded, fails asynchronously with code ENETBLOCKED, and the afterEach hook below throws so a test that swallows the error still
// fails loudly. An afterAll hook drains violations left by beforeAll/afterAll hooks the same way.
//
// Not covered: dns lookups, dgram (UDP) sockets and child processes. Those can leave the machine
// without passing through net.Socket#connect, so tests must not spawn network-capable children.
import net from 'node:net';
import { afterAll, afterEach } from 'vitest';

const GUARD_KEY = Symbol.for('burrow.networkGuard');
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);
const BLOCKED_LOOPBACK_PORTS = new Set([11434, 4321, 5174]);

/**
 * Extracts an explicit port from an OLLAMA_HOST value (`host:port`, `http://host:port`,
 * `[::1]:port`). Returns null when unset, unparsable, or when no port is given.
 * @param {string|undefined} value
 * @returns {number|null}
 */
export function portFromOllamaHost(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`);
    const port = Number(url.port);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

const startupOllamaPort = portFromOllamaHost(process.env.BURROW_GUARD_OLLAMA_HOST ?? process.env.OLLAMA_HOST);
if (startupOllamaPort !== null) BLOCKED_LOOPBACK_PORTS.add(startupOllamaPort);

/** @returns {{ violations: object[], allowed: Set<number>, originalFetch: Function|null }} */
function getState() {
  if (!globalThis[GUARD_KEY]) {
    globalThis[GUARD_KEY] = { violations: [], allowed: new Set(), originalFetch: null };
  }
  return globalThis[GUARD_KEY];
}

const stripBrackets = (h) => String(h).replace(/^\[|\]$/g, '').toLowerCase();

/** Normalizes the argument shapes of Socket#connect to { ipc } or { host, port }. */
function targetOf(args) {
  const [first, second] = args;
  const normalized = Array.isArray(first) ? first[0] : first;
  if (normalized && typeof normalized === 'object') {
    if (typeof normalized.path === 'string') return { ipc: true };
    const port = Number(normalized.port);
    return { host: stripBrackets(normalized.host ?? 'localhost'), port: Number.isFinite(port) ? port : null };
  }
  if (typeof first === 'string' && Number.isNaN(Number(first))) return { ipc: true };
  const port = Number(first);
  return {
    host: stripBrackets(typeof second === 'string' ? second : 'localhost'),
    port: Number.isFinite(port) ? port : null,
  };
}

function isBlocked({ ipc, host, port }) {
  if (ipc) return false;
  if (!LOOPBACK.has(host)) return true;
  if (port !== null && BLOCKED_LOOPBACK_PORTS.has(port) && !getState().allowed.has(port)) return true;
  return false;
}

function blockedError(host, port) {
  const err = new Error(
    `[networkGuard] blocked outbound connection to ${host}:${port}. ` +
      'Mock node-fetch with server/__tests__/helpers/fakeOllama.js or stub fetch.',
  );
  err.code = 'ENETBLOCKED';
  return err;
}

function install() {
  const state = getState();
  if (state.installed) return;
  state.installed = true;

  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const target = targetOf(args);
    if (!isBlocked(target)) return originalConnect.apply(this, args);
    const stack = new Error('blocked connect').stack;
    state.violations.push({ host: target.host, port: target.port, via: 'socket', stack });
    const err = blockedError(target.host, target.port);
    process.nextTick(() => this.destroy(err));
    return this;
  };

  if (typeof globalThis.fetch === 'function') {
    state.originalFetch = globalThis.fetch;
    const guardedFetch = function guardedFetch(input, init) {
      const raw = typeof input === 'string' ? input : (input?.url ?? String(input));
      let url = null;
      try {
        url = new URL(raw);
      } catch {
        /* relative URL: let the original decide (it rejects without a base) */
      }
      if (url && (url.protocol === 'http:' || url.protocol === 'https:')) {
        const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
        const host = stripBrackets(url.hostname);
        if (isBlocked({ host, port })) {
          state.violations.push({ host, port, via: 'fetch', stack: new Error('blocked fetch').stack });
          return Promise.reject(blockedError(host, port));
        }
      }
      return state.originalFetch.call(this, input, init);
    };
    globalThis.fetch = guardedFetch;
  }
}

install();

/**
 * Escape hatch for a real local fake server on a fixed, normally blocked loopback port.
 * Auto-reset after each test.
 * @param {number} port
 * @returns {() => void} undo
 */
export function allowLoopbackPort(port) {
  const { allowed } = getState();
  const n = Number(port);
  const had = allowed.has(n);
  allowed.add(n);
  return () => {
    if (!had) allowed.delete(n);
  };
}

/**
 * Drains the recorded violations.
 * @returns {Array<{ host: string, port: number|null, via: 'socket'|'fetch' }>}
 */
export function takeNetworkViolations() {
  const { violations } = getState();
  return violations.splice(0).map(({ host, port, via }) => ({ host, port, via }));
}

function failOnViolations(where) {
  const found = getState().violations.splice(0);
  if (found.length === 0) return;
  const lines = found.map((v) => `  - ${v.via} ${v.host}:${v.port}\n${String(v.stack).split('\n').slice(2, 7).join('\n')}`);
  throw new Error(
    `[networkGuard] ${found.length} blocked outbound connection(s) during ${where}:\n${lines.join('\n')}\n` +
      'Mock node-fetch with server/__tests__/helpers/fakeOllama.js or stub fetch.',
  );
}

afterEach(() => {
  getState().allowed.clear();
  failOnViolations('this test');
});

afterAll(() => {
  failOnViolations('a suite hook (beforeAll/afterAll)');
});
