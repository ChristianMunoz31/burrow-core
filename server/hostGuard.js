// DNS-rebinding defence. A page on an attacker's hostname can be re-pointed at
// 127.0.0.1; the browser then sends requests with the attacker's Host header. Rejecting
// any Host that is not an expected name closes that path. Loopback names are accepted on
// any port (a rebinding page can never present them as its own hostname); every other
// name must be listed in BURROW_ALLOWED_HOSTS or be the non-loopback BURROW_HOST.
import { VITE_DEV_PORT, isLoopbackHost, resolveListenConfig } from './config.js';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const WILDCARD_BINDS = new Set(['0.0.0.0', '::', '[::]']);
const DEFAULT_PORTS = { 'http:': 80, 'https:': 443 };

/**
 * Split a Host header / host[:port] entry. Returns null when malformed.
 * @param {unknown} value
 * @returns {{ hostname: string, port: number | null } | null}
 */
export function parseHostPort(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (!v || /[\s/\\@?#]/.test(v)) return null;
  let hostname = v;
  let portText = '';
  if (v.startsWith('[')) {
    const end = v.indexOf(']');
    if (end < 0) return null;
    hostname = v.slice(0, end + 1);
    const rest = v.slice(end + 1);
    if (rest) {
      if (!rest.startsWith(':')) return null;
      portText = rest.slice(1);
    }
  } else {
    const colon = v.indexOf(':');
    if (colon >= 0) {
      if (v.indexOf(':', colon + 1) >= 0) return null;
      hostname = v.slice(0, colon);
      portText = v.slice(colon + 1);
    }
  }
  if (!hostname) return null;
  if (portText === '') return { hostname, port: null };
  if (!/^\d{1,5}$/.test(portText)) return null;
  const port = Number(portText);
  if (port < 1 || port > 65535) return null;
  return { hostname, port };
}

/**
 * Build the allowlist policy from env.
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ listenPort: number, entries: Array<{ hostname: string, port: number | null }> }}
 */
export function resolveHostPolicy(env = process.env) {
  const { host, port } = resolveListenConfig(env);
  const entries = [];
  if (!isLoopbackHost(host) && !WILDCARD_BINDS.has(host)) {
    const bound = parseHostPort(host.includes(':') && !host.startsWith('[') ? `[${host}]` : host);
    if (bound) entries.push(bound);
  }
  for (const raw of (env.BURROW_ALLOWED_HOSTS || '').split(',')) {
    const parsed = parseHostPort(raw);
    if (parsed) entries.push(parsed);
  }
  return { listenPort: port, entries };
}

/**
 * @param {unknown} hostHeader
 * @param {ReturnType<typeof resolveHostPolicy>} policy
 * @returns {boolean}
 */
export function isHostAllowed(hostHeader, policy) {
  const parsed = parseHostPort(hostHeader);
  if (!parsed) return false;
  if (LOOPBACK_HOSTNAMES.has(parsed.hostname)) return true;
  return policy.entries.some((e) => {
    if (e.hostname !== parsed.hostname) return false;
    if (e.port !== null) return e.port === parsed.port;
    return parsed.port === null || parsed.port === policy.listenPort || parsed.port === VITE_DEV_PORT;
  });
}

/**
 * Same-origin test that does not trust the Host header: the Origin's scheme + host +
 * port must be an allowed host AND equal the request's Host (so a page served from one
 * allowed name cannot be paired with another).
 * @param {string} origin
 * @param {unknown} hostHeader
 * @param {ReturnType<typeof resolveHostPolicy>} policy
 * @returns {boolean}
 */
export function isSameOrigin(origin, hostHeader, policy) {
  try {
    const url = new URL(origin);
    const defaultPort = DEFAULT_PORTS[url.protocol];
    if (!defaultPort) return false;
    if (!isHostAllowed(url.host, policy) || !isHostAllowed(hostHeader, policy)) return false;
    const req = parseHostPort(hostHeader);
    if (!req) return false;
    const originPort = url.port ? Number(url.port) : defaultPort;
    return url.hostname === req.hostname && originPort === (req.port ?? defaultPort);
  } catch {
    return false;
  }
}

/**
 * Express middleware: 421 for any Host outside the allowlist. Mount first.
 * @param {Record<string, string | undefined>} [env]
 * @returns {import('express').RequestHandler}
 */
export function createHostGuard(env = process.env) {
  const policy = resolveHostPolicy(env);
  return (req, res, next) => {
    if (isHostAllowed(req.headers.host, policy)) return next();
    return res.status(421).json({ error: 'Host not allowed' });
  };
}
