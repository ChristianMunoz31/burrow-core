// Run a branch or pull request in an isolated git worktree with demo data, without touching the
// main checkout, the real data dir or the live dev ports.
//
//   npm run preview:branch -- <branch|#N|N> [--port N] [--dry-run] [--no-install] [--yes] [--real-ai | --no-ai]
//   npm run preview:clean
//
// AI follows scripts/sandbox.js: a bundled fake Ollama by default; --real-ai (real Ollama on
// 127.0.0.1:11434) and --no-ai (dead port) are passed through to the sandbox.
//
// The worktree lives under the OS temp dir (PREVIEW_ROOT). The server is started by THIS
// checkout's scripts/sandbox.js (older branches do not have it) with --app-dir pointing at the
// worktree, so the sandbox safety rules always apply.
//
// A preview runs that branch's code (npm ci, the build and the server). npm and the server run
// without a shell, with a minimal allowlisted env and a fake home under the sandbox folder. A PR
// number needs --yes (or an interactive y/N answer) before anything beyond the fetch.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  PREVIEW_ROOT,
  SANDBOX_ROOT,
  SandboxSafetyError,
  assertSafePort,
  resolveAiMode,
  assertUnderTmp,
  buildChildEnv,
  runNpm,
  sandboxHomeFor,
} from './lib/sandboxSafety.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRANCH_RE = /^[A-Za-z0-9._/-]+$/;
const PR_RE = /^#?(\d+)$/;
const PREVIEW_BRANCH_PREFIX = 'preview/pr-';

const USAGE = `Usage: npm run preview:branch -- <branch|#N|N> [--port N] [--dry-run] [--no-install] [--yes] [--real-ai | --no-ai]
       npm run preview:clean
  AI (default: bundled fake Ollama, no real model): --real-ai uses the real local Ollama, --no-ai a dead port`;

function parseArgs(argv) {
  const out = { target: '', port: null, dryRun: false, install: true, clean: false, yes: false, realAi: false, noAi: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--no-install') out.install = false;
    else if (a === '--clean') out.clean = true;
    else if (a === '--real-ai') out.realAi = true;
    else if (a === '--no-ai') out.noAi = true;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--port') {
      if (i + 1 >= argv.length) throw new SandboxSafetyError(`--port needs a value.\n${USAGE}`);
      out.port = argv[(i += 1)];
    } else if (a.startsWith('-')) throw new SandboxSafetyError(`Unknown argument: ${a}\n${USAGE}`);
    else if (out.target) throw new SandboxSafetyError(`Only one branch or PR is allowed.\n${USAGE}`);
    else out.target = a;
  }
  resolveAiMode(out);
  return out;
}

/**
 * Validates the target and derives the slug, fetch command and ref.
 * @param {string} target
 * @returns {{ kind: 'pr' | 'branch', slug: string, fetchArgs: string[], ref: string, fallbackRef: string | null }}
 */
function resolveTarget(target) {
  const pr = PR_RE.exec(target);
  if (pr) {
    const n = String(Number(pr[1]));
    const ref = `${PREVIEW_BRANCH_PREFIX}${n}`;
    return { kind: 'pr', slug: `pr-${n}`, fetchArgs: ['fetch', 'origin', `+pull/${n}/head:refs/heads/${ref}`], ref, fallbackRef: null };
  }
  if (!BRANCH_RE.test(target) || target.startsWith('-') || target.includes('..') || target.endsWith('/') || target.endsWith('.lock')) {
    throw new SandboxSafetyError('Branch names may only contain letters, digits, dot, dash, underscore and slash.');
  }
  const slug = target.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 40) || 'branch';
  return { kind: 'branch', slug, fetchArgs: ['fetch', 'origin', target], ref: `origin/${target}`, fallbackRef: `refs/heads/${target}` };
}

const git = (args, opts = {}) => spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', ...opts });

function mustGit(args) {
  const res = git(args, { stdio: 'inherit', encoding: undefined });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed (exit ${res.status ?? 'signal'})`);
}

const WARNING = "Warning: a preview runs that branch's code (npm ci, build and server) on this machine.";

async function confirmRun(target) {
  if (!process.stdin.isTTY) {
    throw new SandboxSafetyError(`Refusing to run ${target} without confirmation. Pass --yes to run its code.`);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(`Run the code from ${target}? [y/N] `, resolve));
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) throw new SandboxSafetyError('Cancelled.');
}

const norm = (p) => path.resolve(p).toLowerCase();
const isUnder = (parent, child) => {
  const rel = path.relative(norm(parent), norm(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

function listWorktrees() {
  const res = git(['worktree', 'list', '--porcelain']);
  if (res.status !== 0) throw new Error('git worktree list failed');
  return res.stdout
    .split(/\r?\n/)
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length).trim());
}

function clean() {
  assertUnderTmp(PREVIEW_ROOT);
  assertUnderTmp(SANDBOX_ROOT);
  const slugs = new Set();
  for (const wt of listWorktrees()) {
    if (!isUnder(PREVIEW_ROOT, wt)) continue;
    console.log(`Removing worktree ${wt}`);
    git(['worktree', 'remove', '--force', wt], { stdio: 'inherit', encoding: undefined });
    slugs.add(path.basename(wt));
  }
  git(['worktree', 'prune']);
  if (fs.existsSync(PREVIEW_ROOT)) {
    for (const entry of fs.readdirSync(PREVIEW_ROOT)) {
      slugs.add(entry);
      fs.rmSync(path.join(PREVIEW_ROOT, entry), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    }
    fs.rmSync(PREVIEW_ROOT, { recursive: true, force: true });
  }
  const branches = git(['for-each-ref', '--format=%(refname:short)', `refs/heads/${PREVIEW_BRANCH_PREFIX.slice(0, -3)}`]);
  for (const b of branches.stdout.split(/\r?\n/).filter((x) => x.startsWith(PREVIEW_BRANCH_PREFIX))) {
    console.log(`Deleting branch ${b}`);
    git(['branch', '-D', b], { stdio: 'inherit', encoding: undefined });
  }
  for (const slug of slugs) {
    const dir = path.join(SANDBOX_ROOT, slug);
    if (isUnder(SANDBOX_ROOT, dir) && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      console.log(`Removed sandbox data ${dir}`);
    }
  }
  console.log('Preview clean-up done.');
}

function refExists(ref) {
  return git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).status === 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.clean) {
    clean();
    return;
  }
  if (!args.target) throw new SandboxSafetyError(USAGE);
  const port = args.port === null ? null : assertSafePort(args.port);
  const plan = resolveTarget(args.target);
  const dir = path.join(PREVIEW_ROOT, plan.slug);
  assertUnderTmp(dir);

  const homeDir = sandboxHomeFor(path.join(SANDBOX_ROOT, plan.slug));
  const sandboxArgs = [path.join(REPO_ROOT, 'scripts', 'sandbox.js'), '--app-dir', dir, '--name', plan.slug];
  if (port !== null) sandboxArgs.push('--port', String(port));
  if (args.realAi) sandboxArgs.push('--real-ai');
  if (args.noAi) sandboxArgs.push('--no-ai');

  if (args.dryRun) {
    console.log(`Preview plan for ${args.target} (dry run, nothing will change):`);
    console.log(`  1. git ${plan.fetchArgs.join(' ')}   (falls back to ${plan.fallbackRef ?? 'nothing'} if the fetch fails)`);
    console.log(`  2. git worktree add --detach ${dir} ${plan.ref}`);
    if (args.install) console.log(`  3. npm ci --ignore-scripts   (in ${dir}, no shell, minimal env)`);
    console.log(`  4. npm run build   (in ${dir}, no shell, minimal env)`);
    console.log(`  5. node ${sandboxArgs.join(' ')}`);
    if (plan.kind === 'pr') console.log('  A PR number needs --yes (or an interactive y/N answer) before step 2.');
    console.log(WARNING);
    console.log('Clean up afterwards with: npm run preview:clean');
    return;
  }

  console.log(WARNING);

  const fetched = git(plan.fetchArgs, { stdio: 'inherit', encoding: undefined });
  let ref = plan.ref;
  if (fetched.status !== 0 || !refExists(ref)) {
    if (plan.fallbackRef && refExists(plan.fallbackRef)) {
      console.log(`Could not fetch ${args.target} from origin; using the local branch.`);
      ref = plan.fallbackRef;
    } else {
      throw new Error(`Could not resolve ${args.target}.`);
    }
  }

  if (plan.kind === 'pr' && !args.yes) await confirmRun(args.target);

  fs.mkdirSync(PREVIEW_ROOT, { recursive: true });
  if (fs.existsSync(dir) || listWorktrees().some((wt) => norm(wt) === norm(dir))) {
    git(['worktree', 'remove', '--force', dir], { stdio: 'inherit', encoding: undefined });
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    git(['worktree', 'prune']);
  }
  mustGit(['worktree', 'add', '--detach', dir, ref]);
  const env = buildChildEnv({ homeDir });
  if (args.install) runNpm(['ci', '--ignore-scripts'], { cwd: dir, env });
  runNpm(['run', 'build'], { cwd: dir, env });

  const child = spawn(process.execPath, sandboxArgs, { cwd: REPO_ROOT, env, stdio: 'inherit', shell: false });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
  child.once('exit', (code) => {
    console.log('Preview stopped. Remove it with: npm run preview:clean');
    process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error(err.message);
  process.exit(err instanceof SandboxSafetyError ? 2 : 1);
});
