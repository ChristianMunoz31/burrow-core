// Which UI `npm run desktop:dev` runs, and when it rebuilds dist/. The normal UI (npm run build) is the default; the
// developer tools UI (npm run build:devtools, the placeholder status route) only with `npm run desktop:dev -- --devtools`.
// dist/ is rebuilt when it is missing, when its developer tools presence differs from the requested mode, or when the
// stamp written after the last desktop:dev build does not match the current git HEAD or the worktree has changes.
// The stamp lives in dist/ on purpose: any other `vite build` empties dist/ and so removes it, which forces a rebuild.
// It holds no user data, and the sidecar copy (buildSidecar.js) and the Store layout skip it.
// The stamp also records whether the private Pro repo (pro/) was present and its HEAD (docs/adr/0001-open-core-split.md
// 3.10), so moving pro/ in or out, or a new Pro commit, rebuilds dist/; a dirty pro/ counts as worktree changes.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const DEV_STAMP_FILE = '.burrow-dev-stamp.json';

/**
 * @param {string[]} argv arguments after `npm run desktop:dev --`
 * @returns {{ devtools: boolean }}
 * @throws {Error} on any argument other than --devtools
 */
export function parseDevArgs(argv) {
  const unknown = argv.filter((arg) => arg !== '--devtools');
  if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown[0]} (only --devtools is accepted)`);
  return { devtools: argv.includes('--devtools') };
}

/** @param {{ devtools: boolean }} mode @returns {'build' | 'build:devtools'} the npm script that builds the UI */
export function buildScriptFor({ devtools }) {
  return devtools ? 'build:devtools' : 'build';
}

/**
 * Pure staleness decision.
 * @param {{ hasIndex: boolean, distDevTools: boolean, wantDevTools: boolean, stamp: { commit?: unknown, dirty?: unknown, devtools?: unknown, pro?: unknown, proCommit?: unknown } | null, git: { commit: string | null, dirty: boolean, pro?: 'present' | 'absent', proCommit?: string | null } }} state
 * @returns {{ rebuild: boolean, reason: string }}
 */
export function decideDistRebuild({ hasIndex, distDevTools, wantDevTools, stamp, git }) {
  if (!hasIndex) return { rebuild: true, reason: 'dist/index.html is missing' };
  if (distDevTools !== wantDevTools) {
    return { rebuild: true, reason: distDevTools ? 'dist has the developer tools' : 'dist has no developer tools' };
  }
  if (!stamp || typeof stamp !== 'object') return { rebuild: true, reason: 'dist was not built by desktop:dev' };
  if (stamp.devtools !== wantDevTools) return { rebuild: true, reason: 'dist was built for the other mode' };
  if ((stamp.pro ?? 'absent') !== (git.pro ?? 'absent')) {
    return { rebuild: true, reason: git.pro === 'present' ? 'dist was built without the Pro module' : 'dist was built with the Pro module' };
  }
  if ((stamp.proCommit ?? null) !== (git.proCommit ?? null)) return { rebuild: true, reason: 'dist was built from another Pro commit' };
  if (!git.commit) return { rebuild: true, reason: 'the git commit could not be read' };
  if (git.dirty) return { rebuild: true, reason: 'the worktree has uncommitted changes' };
  if (stamp.dirty !== false) return { rebuild: true, reason: 'dist was built from uncommitted changes' };
  if (stamp.commit !== git.commit) return { rebuild: true, reason: 'dist was built from another commit' };
  return { rebuild: false, reason: `dist is current (${git.commit.slice(0, 7)})` };
}

/**
 * The status read takes no optional index lock (`--no-optional-locks`), so it never races a git command the
 * developer runs at the same time; untracked files count as changes.
 * @param {string} root @param {typeof execFileSync} [exec] test seam
 * @returns {{ commit: string | null, dirty: boolean }}
 */
export function readGitState(root, exec = execFileSync, exists = fs.existsSync) {
  const gitIn = (cwd, args) => exec('git', args, { cwd, timeout: 10000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const git = (args) => gitIn(root, args);
  let state;
  try {
    const commit = git(['rev-parse', 'HEAD']).trim();
    if (!/^[0-9a-f]{40,64}$/.test(commit)) return { commit: null, dirty: true };
    const status = git(['--no-optional-locks', 'status', '--porcelain', '--untracked-files=normal']);
    state = { commit, dirty: status.trim() !== '' };
  } catch {
    return { commit: null, dirty: true };
  }
  const proDir = path.join(root, 'pro');
  if (!exists(path.join(proDir, 'server', 'index.js'))) return state;
  try {
    const proCommit = gitIn(proDir, ['rev-parse', 'HEAD']).trim();
    const proStatus = gitIn(proDir, ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=normal']);
    return { ...state, dirty: state.dirty || proStatus.trim() !== '', pro: 'present', proCommit: /^[0-9a-f]{40,64}$/.test(proCommit) ? proCommit : null };
  } catch {
    return { ...state, dirty: true, pro: 'present', proCommit: null };
  }
}

/** @param {string} distDir @returns {object | null} */
export function readDevStamp(distDir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(distDir, DEV_STAMP_FILE), 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/** @param {string} distDir @param {{ commit: string | null, dirty: boolean, devtools: boolean, pro?: 'present' | 'absent', proCommit?: string | null }} stamp */
export function writeDevStamp(distDir, { commit, dirty, devtools, pro, proCommit }) {
  const value = { commit, dirty, devtools, ...(pro === undefined ? {} : { pro, proCommit: proCommit ?? null }) };
  fs.writeFileSync(path.join(distDir, DEV_STAMP_FILE), `${JSON.stringify(value)}\n`);
}

/** cpSync filter that leaves the desktop:dev stamp out of a copied dist/. */
export function skipDevStamp(src) {
  return path.basename(src) !== DEV_STAMP_FILE;
}
