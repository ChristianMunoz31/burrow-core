// Runtime configuration resolvers. Pure functions of an env object so they can be
// tested without importing server.js or opening a socket.

import { isDesktopMode } from './runtime.js';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 4321;
export const VITE_DEV_PORT = 5174;

/**
 * Where the HTTP server listens. Loopback only unless BURROW_HOST says otherwise. Port 0 (any free
 * port) is accepted only in desktop mode.
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ host: string, port: number }}
 */
export function resolveListenConfig(env = process.env) {
  const host = (env.BURROW_HOST || '').trim() || DEFAULT_HOST;
  const raw = (env.BURROW_PORT || '').trim();
  const min = isDesktopMode(env) ? 0 : 1;
  const port = /^\d{1,5}$/.test(raw) && Number(raw) >= min && Number(raw) <= 65535 ? Number(raw) : DEFAULT_PORT;
  return { host, port };
}

/**
 * Human-readable URL for a listen config (wildcard binds are shown as localhost).
 * @param {{ host: string, port: number }} config
 * @returns {string}
 */
export function formatListenUrl({ host, port }) {
  const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  return `http://${shown.includes(':') ? `[${shown}]` : shown}:${port}`;
}

/**
 * Cross-origin browser allowlist. ALLOWED_ORIGINS (comma-separated) overrides the
 * defaults: loopback origins on the Burrow port and on the Vite dev port. Desktop mode is
 * same-origin only (empty list).
 * @param {Record<string, string | undefined>} [env]
 * @returns {string[]}
 */
export function resolveAllowedOrigins(env = process.env) {
  if (isDesktopMode(env)) return [];
  const configured = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (configured.length > 0) return configured;
  const { port } = resolveListenConfig(env);
  return [...new Set([port, VITE_DEV_PORT].flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`]))];
}

/**
 * Express `trust proxy` value. Off unless BURROW_TRUST_PROXY=1 (one reverse-proxy hop).
 * @param {Record<string, string | undefined>} [env]
 * @returns {number | false}
 */
export function resolveTrustProxy(env = process.env) {
  return env.BURROW_TRUST_PROXY === '1' ? 1 : false;
}

/**
 * Whether the in-process scheduler should run (BURROW_SCHEDULER=0 disables it). This is the global
 * dev/test kill switch for every scheduled job, backups included; the user's automatic backups
 * switch (app_state backup.auto) only gates the backup job.
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isSchedulerEnabled(env = process.env) {
  return (env.BURROW_SCHEDULER || '').trim() !== '0';
}

/**
 * Whether a bind address is loopback-only (localhost, 127.x.x.x, ::1).
 * @param {string} host
 * @returns {boolean}
 */
export function isLoopbackHost(host) {
  const h = String(host || '').trim().toLowerCase();
  return h === 'localhost' || h === '::1' || h === '[::1]' || /^127(\.\d{1,3}){3}$/.test(h);
}

export const MIN_AUTH_SECRET_LENGTH = 32;

/**
 * Decide whether the server may start with this environment. Pure.
 *  - Desktop mode: the bind host must be loopback (APP_PASSWORD and AUTH_SECRET are ignored there).
 *  - APP_PASSWORD set with an AUTH_SECRET shorter than 32 chars: refuse.
 *  - Non-loopback BURROW_HOST without both APP_PASSWORD and AUTH_SECRET: refuse, unless
 *    BURROW_ALLOW_INSECURE_LAN=1 (then start with a loud warning).
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
export function checkStartupSecurity(env = process.env) {
  const errors = [];
  const warnings = [];
  if (isDesktopMode(env)) {
    if (!isLoopbackHost(resolveListenConfig(env).host)) {
      errors.push('Desktop mode only listens on a loopback address. Set BURROW_HOST to 127.0.0.1.');
    }
    return { ok: errors.length === 0, errors, warnings };
  }
  const password = env.APP_PASSWORD || '';
  const secret = env.AUTH_SECRET || '';
  const { host } = resolveListenConfig(env);

  if (password && secret.length < MIN_AUTH_SECRET_LENGTH) {
    errors.push(
      `AUTH_SECRET must be at least ${MIN_AUTH_SECRET_LENGTH} characters when APP_PASSWORD is set. ` +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"',
    );
  }
  if (!isLoopbackHost(host) && !(password && secret)) {
    if (env.BURROW_ALLOW_INSECURE_LAN === '1') {
      warnings.push(
        `WARNING: listening on ${host} with NO sign-in. Anyone who can reach this port can read and change all your data. ` +
          'Set APP_PASSWORD and AUTH_SECRET, or bind to 127.0.0.1.',
      );
    } else {
      errors.push(
        `Refusing to listen on ${host} without sign-in. Set APP_PASSWORD and AUTH_SECRET, bind to 127.0.0.1, ` +
          'or set BURROW_ALLOW_INSECURE_LAN=1 to accept the risk.',
      );
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}
