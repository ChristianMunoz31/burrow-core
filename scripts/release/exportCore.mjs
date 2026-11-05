// One-way export of the public core (docs/adr/0001-open-core-split.md 3.14): `git archive --format=tar HEAD` (honours
// export-ignore; pro/ is untracked anyway) extracted into <dir>, then checkCoreTree(<dir>) from
// scripts/checks/coreTreeGuard.js. The private repo stays the working repo; the public repo starts from a fresh root
// commit of this output (owner runbook: docs/PUBLISHING_CORE.md). Refuses: an --out inside the private repo, an --out
// whose git remote is the private origin or names burrow-pro, a dirty working tree, and any core tree guard problem.
// Usage: npm run export:core -- --out <dir>
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkCoreTree } from '../checks/coreTreeGuard.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** True when `child` is `parent` or inside it (real paths, case-folded on Windows). */
export function isInside(child, parent) {
  const real = (p) => {
    let cur = path.resolve(p);
    const rest = [];
    while (!fs.existsSync(cur)) {
      rest.unshift(path.basename(cur));
      const up = path.dirname(cur);
      if (up === cur) break;
      cur = up;
    }
    return path.join(fs.realpathSync.native(cur), ...rest);
  };
  const norm = (p) => (process.platform === 'win32' ? real(p).toLowerCase() : real(p));
  const rel = path.relative(norm(parent), norm(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Normalizes a git remote URL for comparison (scheme, user, .git suffix and case dropped). */
export const normalizeRemote = (url) =>
  String(url ?? '')
    .trim()
    .toLowerCase()
    .replace(/^git@([^:]+):/, '$1/')
    .replace(/^[a-z+]+:\/\/(?:[^@/]+@)?/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');

/**
 * Refusals that need no export (ADR 3.14).
 * @param {{ root: string, out: string, readGit?: (args: string[], cwd: string) => string }} opts
 * @returns {string[]} problems
 */
export function preflight({ root, out, readGit = git }) {
  const problems = [];
  if (isInside(out, root)) problems.push(`--out ${out} is inside the private repository`);
  let origin;
  try {
    origin = readGit(['remote', 'get-url', 'origin'], root);
  } catch {
    origin = '';
  }
  if (fs.existsSync(path.join(out, '.git'))) {
    let remotes;
    try {
      remotes = readGit(['remote', '-v'], out).split(/\r?\n/).map((l) => l.split(/\s+/)[1]).filter(Boolean);
    } catch {
      remotes = [];
    }
    for (const url of remotes) {
      if (origin && normalizeRemote(url) === normalizeRemote(origin)) problems.push(`--out ${out} has the private repository as a remote (${url})`);
      if (/burrow-pro/i.test(url)) problems.push(`--out ${out} has a Pro repository remote (${url})`);
    }
  }
  let status = '';
  try {
    status = readGit(['status', '--porcelain'], root);
  } catch {
    problems.push('git status failed: run this from the private repository');
  }
  if (status !== '') problems.push('the working tree is not clean: commit first, the export takes HEAD');
  return [...new Set(problems)];
}

/**
 * The tar to extract with. On Windows the bundled bsdtar in System32, because GNU tar from Git for Windows (often first
 * on PATH) cannot open drive-letter paths such as C:\... (it reads them as a remote host).
 * @returns {string}
 */
function tarCommand() {
  if (process.platform !== 'win32') return 'tar';
  const systemTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return fs.existsSync(systemTar) ? systemTar : 'tar';
}

/**
 * Writes HEAD (minus export-ignore paths) into `out` and checks it. The previous content of `out` is replaced,
 * except its .git folder (a sync into an existing public checkout).
 * @param {{ root?: string, out: string, log?: (m: string) => void }} opts
 * @returns {{ files: number }}
 */
export function exportCore({ root = ROOT, out, log = console.log }) {
  const target = path.resolve(out);
  const problems = preflight({ root, out: target });
  if (problems.length) throw new Error(`export:core refused:\n  ${problems.join('\n  ')}`);
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(target)) {
    if (entry !== '.git') fs.rmSync(path.join(target, entry), { recursive: true, force: true });
  }
  // PowerShell 5.1 corrupts binary data in native pipes, so the tar goes through a file.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-export-'));
  try {
    const tarFile = path.join(tmp, 'core.tar');
    git(['archive', '--format=tar', '-o', tarFile, 'HEAD'], root);
    const res = spawnSync(tarCommand(), ['-xf', tarFile, '-C', target], { stdio: 'inherit' });
    if (res.status !== 0) throw new Error('tar could not extract the archive');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const found = checkCoreTree(target);
  if (found.length) throw new Error(`export:core: the exported tree failed the core tree guard:\n  ${found.slice(0, 50).join('\n  ')}`);
  const files = git(['ls-tree', '-r', '--name-only', 'HEAD'], root).split(/\r?\n/).length;
  log(`Exported the public core to ${target} (core tree guard passed). Next: docs/PUBLISHING_CORE.md.`);
  return { files };
}

function main(argv) {
  const i = argv.indexOf('--out');
  const out = i === -1 ? null : argv[i + 1];
  if (!out || out.startsWith('--')) throw new Error('Usage: npm run export:core -- --out <dir>');
  exportCore({ out });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
