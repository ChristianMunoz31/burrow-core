// Packaging seams. In the repo these resolve from import.meta.url / package.json as before; the
// desktop sidecar bundle (scripts/desktop/buildSidecar.js) points them at files shipped beside the
// executable via env, and bakes the app version in at build time.
/* global __BURROW_APP_VERSION__, __BURROW_COMMIT__ */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Directory override from env (absolute), or undefined when unset/blank.
 * @param {string} name Env var name, e.g. BURROW_DIST_DIR.
 * @param {Record<string, string | undefined>} [env]
 * @returns {string | undefined}
 */
export function envDir(name, env = process.env) {
  const value = (env[name] || '').trim();
  return value ? path.resolve(value) : undefined;
}

/** App version injected by the sidecar bundler (esbuild define), else undefined. */
export const BUNDLED_APP_VERSION = typeof __BURROW_APP_VERSION__ === 'string' ? __BURROW_APP_VERSION__ : undefined;

/**
 * Desktop (Tauri sidecar) mode is on iff BURROW_DESKTOP=1.
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isDesktopMode(env = process.env) {
  return env.BURROW_DESKTOP === '1';
}

let cachedVersion;

/**
 * App version: the bundler-injected value, else package.json, else 'unknown'.
 * @returns {string}
 */
export function getAppVersion() {
  if (BUNDLED_APP_VERSION) return BUNDLED_APP_VERSION;
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const raw = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8');
    const version = JSON.parse(raw).version;
    cachedVersion = typeof version === 'string' && version ? version : 'unknown';
  } catch {
    cachedVersion = 'unknown';
  }
  return cachedVersion;
}

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMMIT_RE = /^[0-9a-f]{7,}$/;

/** Short commit SHA injected by the sidecar bundler (string, or null when git was unavailable), else undefined. */
const BUNDLED_COMMIT = typeof __BURROW_COMMIT__ !== 'undefined' ? __BURROW_COMMIT__ : undefined;

/**
 * Normalizes a candidate SHA to 7 lowercase hex characters.
 * @param {unknown} value
 * @returns {string | null}
 */
function shortSha(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return COMMIT_RE.test(text) ? text.slice(0, 7) : null;
}

/**
 * Runs `git rev-parse --short=7 HEAD` in the repo. Never throws; null on any failure (no git, no repo, bad output).
 * @param {{ exec?: typeof execFileSync, cwd?: string }} [opts] `exec` is a test seam.
 * @returns {string | null}
 */
export function resolveGitCommit({ exec = execFileSync, cwd = REPO_ROOT } = {}) {
  try {
    const out = exec('git', ['rev-parse', '--short=7', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    return shortSha(out);
  } catch {
    return null;
  }
}

let cachedCommit;

/**
 * Short (7 char) commit SHA of this build: the bundler-injected value, else git in the repo (unbundled runs).
 * Resolved once and cached, including a null result. Never throws.
 * @returns {string | null}
 */
export function getCommit() {
  if (cachedCommit !== undefined) return cachedCommit;
  cachedCommit = BUNDLED_COMMIT !== undefined ? shortSha(BUNDLED_COMMIT) : resolveGitCommit();
  return cachedCommit;
}

/** Clears the cached commit. For tests only. */
export function resetCommitForTests() {
  cachedCommit = undefined;
}
