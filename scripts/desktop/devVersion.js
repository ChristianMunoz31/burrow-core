// Version numbers for a Burrow Dev build (the side-by-side test channel). Dev builds are never released:
// they are named after the NEXT release plus the build date and commit, so they sort between releases.
//
//   display  <next>-dev.<YYYYMMDD>.<sha7>   shown in the app, the update check, backups and the installer name
//   bundle   <next>-dev.<YYYYMMDD>+<N>      the Tauri/NSIS version; N counts days since 2024-01-01 (1..65535)
//   tag      dev-<YYYYMMDD>-<sha7>          the GitHub pre-release tag
//
// Example: commit abc1234 built on 2026-10-05 with manifest 0.1.0 gives display 0.2.0-dev.20261005.abc1234,
// bundle 0.2.0-dev.20261005+1008, Windows file version 0.2.0.1008 and tag dev-20261005-abc1234.
//
// Why the bundle version differs from the display version: it must be valid semver for tauri.conf.json and
// the NSIS template (an all-digit sha with a leading zero is not valid semver, so the sha is left out), and N
// gives Windows a numeric, monotonic X.Y.Z.N file version. The NSIS downgrade check orders builds by date.
//
// The next version is the release-please manifest bumped like release-please does: with major 0 and
// `bump-minor-pre-major`, 0.1.0 becomes 0.2.0; otherwise the minor goes up (1.4.2 becomes 1.5.0).
//
// Usage: node scripts/desktop/devVersion.js [--json]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEV_VERSION_RE } from '../../server/channel.js';
import { parseLicenseDate } from '../../server/license/constants.js';
import { resolveBuildDate } from '../license/writeBuildInfo.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DAY_MS = 86_400_000;
const EPOCH_MS = Date.UTC(2024, 0, 1);
const SEMVER_CORE_RE = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;
export const NO_GIT_MESSAGE = 'Dev builds need a git checkout.';

/**
 * The next release version after `current`.
 * @param {{ current: string, bumpMinorPreMajor: boolean }} opts a pre-release or build suffix on `current` is ignored
 * @returns {string}
 */
export function nextVersion({ current, bumpMinorPreMajor }) {
  const m = SEMVER_CORE_RE.exec(String(current).trim());
  if (!m) throw new Error(`Cannot read a version from "${String(current)}"`);
  const major = Number(m[1]);
  const minor = Number(m[2]);
  // A dev build stands for the next feature release. release-please bumps the minor for a feature, and with
  // major 0 and bump-minor-pre-major it keeps a breaking change on the minor as well, so a 0.x manifest goes to
  // 0.(minor+1).0. Past 1.0 the minor also goes up (1.4.2 becomes 1.5.0).
  if (major === 0 && bumpMinorPreMajor) return `0.${minor + 1}.0`;
  return `${major}.${minor + 1}.0`;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Next version from the checkout: the release-please manifest, else package.json.
 * @param {string} [root]
 * @returns {string}
 */
export function readNextVersion(root = ROOT) {
  const config = readJson(path.join(root, 'release-please-config.json'));
  const bumpMinorPreMajor = config?.packages?.['.']?.['bump-minor-pre-major'] === true;
  const manifest = readJson(path.join(root, '.release-please-manifest.json'));
  const fromManifest = typeof manifest?.['.'] === 'string' ? manifest['.'] : null;
  const current = fromManifest ?? readJson(path.join(root, 'package.json'))?.version;
  if (typeof current !== 'string') throw new Error('No version found in .release-please-manifest.json or package.json');
  return nextVersion({ current, bumpMinorPreMajor });
}

/**
 * All derived dev version strings.
 * @param {{ next: string, buildDateMs: number, sha: string }} opts
 * @returns {{ display: string, bundle: string, buildNumber: number, dateStamp: string, shortSha: string, tag: string }}
 */
export function devVersions({ next, buildDateMs, sha }) {
  const shortSha = String(sha).slice(0, 7).toLowerCase();
  if (!/^[0-9a-f]{7}$/.test(shortSha)) throw new Error(NO_GIT_MESSAGE);
  const dateStamp = new Date(buildDateMs).toISOString().slice(0, 10).replaceAll('-', '');
  const buildNumber = Math.floor((buildDateMs - EPOCH_MS) / DAY_MS);
  if (!Number.isInteger(buildNumber) || buildNumber < 1 || buildNumber > 65535) {
    throw new Error(`Build number ${buildNumber} is out of range 1..65535 (the build date must be after 2024-01-01)`);
  }
  const display = `${next}-dev.${dateStamp}.${shortSha}`;
  if (!DEV_VERSION_RE.test(display)) throw new Error(`Derived display version "${display}" is not a valid dev version`);
  return {
    display,
    bundle: `${next}-dev.${dateStamp}+${buildNumber}`,
    buildNumber,
    dateStamp,
    shortSha,
    tag: `dev-${dateStamp}-${shortSha}`,
  };
}

/** Full HEAD sha from git, or null. */
function gitHeadSha(root) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Reads the checkout: next version, build date (same precedence as the license build date) and HEAD sha.
 * @param {{ root?: string, env?: Record<string, string | undefined>, git?: (root: string) => string | null }} [opts]
 * @returns {ReturnType<typeof devVersions>}
 * @throws {Error} 'Dev builds need a git checkout.' when HEAD is not a 40 or 64 hex sha
 */
export function resolveDevVersions({ root = ROOT, env = process.env, git = gitHeadSha } = {}) {
  const sha = (git(root) ?? '').toLowerCase();
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha)) throw new Error(NO_GIT_MESSAGE);
  const { buildDate } = resolveBuildDate({ env, repoRoot: root });
  const buildDateMs = parseLicenseDate(buildDate);
  if (buildDateMs === null) throw new Error('The build date is not valid');
  return devVersions({ next: readNextVersion(root), buildDateMs, sha });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = resolveDevVersions();
    console.log(process.argv.includes('--json') ? JSON.stringify(result) : Object.entries(result).map(([k, v]) => `${k}: ${v}`).join('\n'));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
