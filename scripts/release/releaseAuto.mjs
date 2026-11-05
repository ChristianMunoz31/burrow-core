// One resumable command for the owner's release from the Windows ARM64 PC when GitHub Actions cannot run:
//
//   npm run release:auto -- [--tag vX.Y.Z] [--from <stage>] [--publish] [--yes] [--gumroad] [--x64-node <file>]
//                           [--merge-pr <N[,N]>] [--merge-release-pr] [--out-dir <dir>] [--status] [--dry-plan]
//
//   --merge-pr <N>       (repeatable or comma-separated) after preflight and before the checks stage, squash-merge
//                        pull request N into main with gh, then fast-forward the local main.
//   --merge-release-pr   after the release-pr stage opened or updated the release PR, squash-merge it the same way and
//                        go on to the tag stage in the same run. Without it the run stops and you merge it yourself.
//   Both merges are explicit opt-ins. Each refuses unless the PR is open, not a draft, based on main and MERGEABLE,
//   prints its title and head branch, and asks you to type its number (without a terminal it needs --yes). The merge
//   is recorded in auto-state.json with the merged commit, so a re-run does not merge it again.
//
// It runs the steps of docs/RELEASING.md "Releasing without GitHub Actions" in order and reuses the existing scripts
// for every check (release-please 17, buildSidecar.js, channelMarker.js, smokeSidecar.js, buildInstaller.js,
// releaseLocal.mjs, publishPublic.js, syncGumroad.mjs); nothing here repeats their checks or replaces them.
// Stages: preflight, checks, release-pr, tag, x64, arm64, publish (only with --publish), after. Each completed stage
// is recorded in <out dir>\auto-state.json with its inputs (commit, tag, hashes) and outputs; a later run skips a
// stage whose inputs are unchanged and whose outputs still verify, and runs it again otherwise.
//
// Safety rules (owner decisions): a pull request is merged only when --merge-pr or --merge-release-pr names it, only
// into main, never forced, and only the merged head branch is deleted (gh pr merge --delete-branch); nothing is published without the
// owner typing the tag (or --yes together with BURROW_RELEASE_CONFIRM=<tag>); publishing goes through
// publishPublic.js directly, which is the documented path while Actions cannot run (release:local --publish would
// refuse at checkCommitCi, and that gate is not bypassed here in any other way). Tokens come from `gh auth token`
// (or RELEASES_TOKEN for the publish), reach exactly one child each through its environment, and are never printed,
// passed as an argument or written to disk. Network use: GitHub through gh and release-please (github.com,
// api.github.com), nodejs.org for the x64 node.exe (storeNode.mjs) and the npm registry for npm ci and the
// release-please install. This is developer tooling, not the app, so the app's netPolicy does not apply to it.
import { execFile as execFileCb, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { assertStableBuildEnv, stableChildEnv } from '../desktop/build.js';
import { assertProPresent } from '../checks/proPresent.js';
import { resolveNpmCli } from '../lib/sandboxSafety.js';
import {
  ARM64_TRIPLE,
  GITLEAKS_VERSION,
  PRIVATE_REPO,
  PULL_MAIN_ARGS,
  RELEASE_PLEASE_SPEC,
  RELEASE_PLEASE_VERSION_MAJOR,
  RP_TOKEN_VAR,
  STATE_FILE,
  STRICT_TAG_RE,
  USAGE,
  X64_TRIPLE,
  acquireLock,
  afterSteps,
  arm64Commands,
  assertDryRunNotes,
  assertReleaseHost,
  checkToken,
  checksCommands,
  checksRecordFor,
  decideStage,
  formatCommand,
  isInsideDir,
  isSupportedNode,
  mergeConfirmationMode,
  mergePlanCommands,
  mergeRefusal,
  missingRustTargets,
  parseAutoArgs,
  parseGithubReleaseDryRun,
  parseReleasePrDryRun,
  plainText,
  prMergeArgs,
  prViewArgs,
  publishCommand,
  publishConfirmationMode,
  readState,
  redact,
  recordMerge,
  recordStage,
  releaseDir,
  releasePleaseArgs,
  renderStatus,
  sharedDirs,
  stagesForRun,
  summarizeChangelog,
  typedNumberMatches,
  typedTagMatches,
  withoutTokenEnv,
  writeState,
  x64Commands,
  x64InstallerPath,
} from './lib/releaseAutoPlan.mjs';
import { ALLOWED_ASSETS, SUMS_FILE, UPDATER_ASSETS, verifySums } from './publishPublic.js';
import { assertUsableX64Node, ensureX64Node } from './storeNode.mjs';
import { assertSigningEnv, updaterState, withoutSigningEnv } from './updaterConfig.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHIM = path.join(ROOT, 'scripts', 'release', 'lib', 'releasePleaseShim.mjs');
const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;

const execFileRaw = promisify(execFileCb);

const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Signing variables of `env` only (the complement of withoutSigningEnv). */
function signingOnly(env) {
  const kept = new Set(Object.keys(withoutSigningEnv(env)));
  return Object.fromEntries(Object.entries(env).filter(([name]) => !kept.has(name)));
}

/**
 * The environment of a child, by kind. No kind ever carries a GitHub token (or any other credential-like variable,
 * withoutTokenEnv) except the one child that needs it. The signing variables are taken from the original environment
 * for the installer step only.
 * @param {'plain' | 'clean' | 'signing' | 'publish' | 'rp' | 'gh'} kind
 * @param {Record<string, string | undefined>} env
 * @param {string | null} [token]
 */
export function childEnv(kind, env, token = null) {
  const base = withoutTokenEnv(env);
  switch (kind) {
    case 'plain':
      // The checks run as in the owner's own shell, only without tokens and signing variables.
      return withoutSigningEnv(base);
    // Build children need the Pro module (docs/adr/0001-open-core-split.md 3.10): BURROW_REQUIRE_PRO=1 makes the web
    // build and the sidecar fail without pro/, so a Free build (BURROW_PRO=off) is never released.
    case 'clean':
      return { ...stableChildEnv(base), BURROW_REQUIRE_PRO: '1' };
    case 'signing':
      return { ...stableChildEnv(base), BURROW_REQUIRE_PRO: '1', ...signingOnly(env) };
    case 'gh':
      return withoutSigningEnv(base);
    case 'publish':
      if (!token) throw new Error('No token for the publish step');
      return { ...withoutSigningEnv(base), GH_TOKEN: token };
    case 'rp':
      if (!token) throw new Error('No token for release-please');
      return { ...withoutSigningEnv(base), [RP_TOKEN_VAR]: token };
    default:
      throw new Error(`Unknown env kind ${String(kind)}`);
  }
}

function defaultExec(file, args, { cwd, env } = {}) {
  return execFileRaw(file, args, { cwd, env, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'utf8' });
}

export function defaultStep(cmd, env) {
  const res = spawnSync(cmd.file, cmd.args, { cwd: cmd.cwd, env, stdio: 'inherit', shell: false, windowsHide: true });
  if (res.error) throw new Error(`${cmd.label} could not start (${res.error.code ?? res.error.message})`);
  if (res.status !== 0) throw new Error(`${cmd.label} failed (exit ${res.status ?? res.signal ?? 'unknown'})`);
}

/** Runs a child with piped output, prints it line by line with secrets redacted, and returns the whole text. */
function defaultStepCapture(file, args, { cwd, env, secrets = [], redactFn }) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
    let all = '';
    const pump = (stream, out) => {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const clean = redactFn(line, secrets);
          all += `${clean}\n`;
          out.write(`${clean}\n`);
        }
      });
      stream.on('end', () => {
        if (buf) {
          const clean = redactFn(buf, secrets);
          all += clean;
          out.write(`${clean}\n`);
        }
      });
    };
    pump(child.stdout, process.stdout);
    pump(child.stderr, process.stderr);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(all);
      else reject(Object.assign(new Error(`exit ${code}`), { output: all }));
    });
  });
}

async function defaultPrompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/**
 * Runs release:auto.
 * @param {import('./lib/releaseAutoPlan.mjs').AutoOptions} opts
 * @param {object} [deps] seams for the tests
 * @returns {Promise<{ stoppedAt?: string, done?: boolean, plan?: string[] }>}
 */
export async function runAuto(opts, deps = {}) {
  const {
    env = process.env,
    platform = process.platform,
    arch = process.arch,
    nodeVersion = process.version,
    execPath = process.execPath,
    root = ROOT,
    log = (line) => console.log(line),
    exec = defaultExec,
    step = defaultStep,
    stepCapture = defaultStepCapture,
    fetchImpl = fetch,
    prompt = defaultPrompt,
    isTTY = Boolean(process.stdin.isTTY),
    npmCli: npmCliDep,
    ensureNode = ensureX64Node,
    usableNode = assertUsableX64Node,
    pathMod = platform === 'win32' ? path : path.win32,
    now = () => new Date(),
    redactFn,
    proCheck = assertProPresent,
  } = deps;
  const redactLine = redactFn ?? redact;
  const warn = (line) => log(`Warning: ${line}`);

  if (opts.help) {
    log(USAGE);
    return { done: true };
  }

  const pkgVersionAt = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;

  // --- read-only modes --------------------------------------------------------------------------------------
  if (opts.status) {
    const tag = opts.tag ?? null;
    const outDir = releaseDir({ env, tag, outDir: opts.outDir, pathMod });
    const file = pathMod.join(outDir, STATE_FILE);
    for (const line of renderStatus(readState(file, { tag, warn }), { file })) log(line);
    if (!opts.tag) log('Pass --tag vX.Y.Z to see the table of a tagged release.');
    return { done: true };
  }

  if (opts.dryPlan) {
    const plan = dryPlan(opts, { env, root, execPath, npmCli: npmCliDep, pathMod, pkgVersion: pkgVersionAt(root), platform, arch });
    for (const line of plan) log(line);
    return { done: true, plan };
  }

  // --- real run -----------------------------------------------------------------------------------------------
  assertReleaseHost({ platform, arch });
  if (!isSupportedNode(nodeVersion)) throw new Error(`Node ${nodeVersion} is not supported. Install Node ^22.13.0 or >=23.4.0.`);
  assertStableBuildEnv(env);
  if (typeof env.LOCALAPPDATA !== 'string' || env.LOCALAPPDATA.trim() === '') {
    throw new Error('LOCALAPPDATA is not set, so the release folder, the x64 node.exe cache and the release-please tool have no home. Run from a normal Windows PowerShell session.');
  }
  // An official release includes the Pro module: refuse a checkout without pro/ before anything runs.
  proCheck({ root });
  const npmCli = npmCliDep ?? resolveNpmCli();
  const node = execPath;
  const ghEnv = childEnv('gh', env);
  const git = async (args, cwd = root) => String((await exec('git', args, { cwd, env: ghEnv })).stdout).trim();
  // The private Pro repo (pro/, nested and ignored by core): its HEAD is pinned in auto-state.json, a dirty pro/ is
  // refused, every core worktree gets a pro worktree at that commit, and the pro repo gets the release tag.
  const proDir = pathMod.join(root, 'pro');
  // proCheck above refuses a release without pro/; only a test fixture root (proCheck stubbed) gets here without one.
  const hasProRepo = fs.existsSync(pathMod.join(proDir, '.git'));
  const proHead = async () => {
    if (!hasProRepo) return null;
    if ((await git(['status', '--porcelain'], proDir)) !== '') throw new Error(`The Pro repo ${proDir} has changes. Commit them in pro/ first.`);
    const commit = await git(['rev-parse', 'HEAD'], proDir);
    if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error(`Could not read the commit of the Pro repo ${proDir}.`);
    return commit;
  };
  const pinnedProCommit = async () => state?.stages?.preflight?.outputs?.proCommit ?? (await proHead());
  const prepareProWorktree = async (wt, proCommit) => {
    if (!proCommit) return;
    const proWt = pathMod.join(wt, 'pro');
    if (fs.existsSync(proWt)) {
      const head = await git(['rev-parse', 'HEAD'], proWt).catch(() => '');
      const dirty = await git(['status', '--porcelain'], proWt).catch(() => 'unknown');
      if (head === proCommit && dirty === '') return;
      await git(['worktree', 'remove', '--force', proWt], proDir);
    }
    await git(['worktree', 'prune'], proDir);
    await git(['worktree', 'add', '--detach', proWt, proCommit], proDir);
    log(`Pro worktree ${proWt} at ${proCommit.slice(0, 7)}.`);
  };
  const gh = async (args) => String((await exec('gh', args, { cwd: root, env: ghEnv })).stdout);
  const run = (cmd, extra = {}) => {
    log(`> ${formatCommand(cmd, { execPath })}`);
    const kind = cmd.env ?? 'clean';
    step(cmd, childEnv(kind, env, extra.token ?? null));
  };
  /** Like run, but the output is also returned (printed line by line as it comes). Never for a token child. */
  const runCapture = async (cmd) => {
    log(`> ${formatCommand(cmd, { execPath })}`);
    try {
      return await stepCapture(cmd.file, cmd.args, { cwd: cmd.cwd, env: childEnv(cmd.env ?? 'clean', env), secrets: [], redactFn: redactLine });
    } catch {
      throw new Error(`${cmd.label} failed; see its output above.`);
    }
  };

  try {
    await exec('gh', ['auth', 'status'], { cwd: root, env: ghEnv });
  } catch {
    throw new Error('gh is not signed in. Run gh auth login (with access to ChristianMunoz31/burrow), then try again.');
  }
  // Rust targets are needed by every build stage, so they are checked on every run, not only in preflight.
  let rustTargets;
  try {
    rustTargets = String((await exec('rustup', ['target', 'list', '--installed'], { cwd: root, env: ghEnv })).stdout);
  } catch {
    throw new Error('rustup was not found. Install Rust from https://rustup.rs, then run again.');
  }
  const missingTargets = missingRustTargets(rustTargets);
  if (missingTargets.length) throw new Error(`Missing Rust target(s): ${missingTargets.join(', ')}. Run: rustup target add ${missingTargets.join(' ')}`);

  let ghToken = null;
  const token = async () => {
    if (ghToken === null) {
      let raw;
      try {
        raw = (await exec('gh', ['auth', 'token'], { cwd: root, env: ghEnv })).stdout;
      } catch {
        throw new Error('gh auth token failed. Run gh auth login, then try again.');
      }
      ghToken = checkToken(raw);
    }
    return ghToken;
  };

  // The tag decides the state folder. Before the release PR exists the version is unknown, so those stages keep
  // their state in burrow-release\next.
  let tag = opts.tag;
  const tagFromMain = async () => {
    await git(['fetch', '--quiet', 'origin', 'main']);
    const pkg = JSON.parse(await git(['show', 'origin/main:package.json']));
    const t = `v${pkg.version}`;
    if (!STRICT_TAG_RE.test(t)) throw new Error(`origin/main's package.json has version ${pkg.version}, which is not a stable x.y.z`);
    return t;
  };
  const requireTag = () => {
    if (!tag) throw new Error('The release tag is not known. Pass --tag vX.Y.Z.');
    return tag;
  };
  if (opts.outDir && isInsideDir(opts.outDir, root)) throw new Error('--out-dir must be outside the repository (worktrees and installers go there), also through a link or junction.');

  let outDir = releaseDir({ env, tag, outDir: opts.outDir, pathMod });
  let stateFile = pathMod.join(outDir, STATE_FILE);
  let state = readState(stateFile, { tag: tag ?? null, warn });
  // Pull requests this run merged, kept so the record follows the run when it moves to the tag's state folder.
  const runMerges = new Map();
  // One run per release folder: the lock is taken when the stages start and for every folder the run moves to.
  const locks = new Map();
  let locking = false;
  const lockHere = () => {
    const key = pathMod.resolve(outDir).toLowerCase();
    if (!locking || locks.has(key)) return;
    locks.set(key, acquireLock(outDir, { now: now(), log }));
  };
  const switchTag = (t) => {
    if (tag === t && state.tag === t) return;
    if (opts.tag && opts.tag !== t) throw new Error(`release-please is releasing ${t}, but --tag says ${opts.tag}. Nothing more was done.`);
    tag = t;
    if (!opts.outDir) {
      outDir = releaseDir({ env, tag, pathMod });
      stateFile = pathMod.join(outDir, STATE_FILE);
    }
    lockHere();
    state = readState(stateFile, { tag, warn });
    let carried = false;
    for (const m of runMerges.values()) {
      if (!state.merges?.[String(m.number)]) {
        state = recordMerge(state, m);
        carried = true;
      }
    }
    if (carried) writeState(stateFile, state);
  };
  const save = (name, inputs, outputs) => {
    state = recordStage(state, name, { inputs, outputs, now: now() });
    writeState(stateFile, state);
  };

  const mainCurrent = async () => {
    const top = await git(['rev-parse', '--show-toplevel']);
    if (pathMod.resolve(top).toLowerCase() !== pathMod.resolve(root).toLowerCase()) throw new Error(`Run release:auto from the root of the main checkout (${top}).`);
    const branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '');
    if (branch !== 'main') throw new Error(`The checkout is on "${branch || 'a detached HEAD'}". Run git switch main; git pull first.`);
    if ((await git(['status', '--porcelain'])) !== '') throw new Error('The checkout has uncommitted changes. Commit or stash them first.');
    await git(['fetch', '--quiet', 'origin', 'main', '--tags']);
    const head = await git(['rev-parse', 'HEAD']);
    const remote = await git(['rev-parse', 'origin/main']);
    if (head !== remote) throw new Error(`main (${head.slice(0, 7)}) is not origin/main (${remote.slice(0, 7)}). Run git pull first.`);
    return head;
  };

  /**
   * Squash-merges pull request n of the private repo into main (the PR title plus " (#n)" as subject, its body as the
   * body, so release-please reads the conventional lines), then fast-forwards the local main. Refuses with a message
   * unless the PR may be merged; asks for the typed number unless --yes. The merge is recorded in the state at once.
   * @returns {Promise<{ cancelled: boolean, skipped?: boolean, sha?: string }>}
   */
  const mergePullRequest = async (n, { releaseVersion = null } = {}) => {
    const done = state.merges?.[String(n)];
    if (done) {
      log(`PR #${n} was merged by an earlier run (${done.sha.slice(0, 7)}); not merging it again.`);
      return { cancelled: false, skipped: true, sha: done.sha };
    }
    await mainCurrent();
    let pr;
    try {
      pr = JSON.parse(await gh(prViewArgs(n)));
    } catch (err) {
      throw new Error(`Could not read PR #${n} of ${PRIVATE_REPO} (gh pr view). Nothing was merged.`, { cause: err });
    }
    const why = mergeRefusal(pr, n, { releaseVersion });
    if (why) throw new Error(why);
    const title = plainText(pr.title);
    log(`PR #${n}: ${title}`);
    log(`  head branch ${plainText(pr.headRefName)}, into main (squash merge, the head branch is deleted afterwards)`);
    const mode = mergeConfirmationMode({ n, yes: opts.yes, isTTY });
    if (mode === 'prompt') {
      const answer = await prompt(`Merge PR #${n} '${title}' into main? Type the number ${n} to confirm (anything else cancels): `);
      if (!typedNumberMatches(answer, n)) {
        log(`Cancelled. PR #${n} was not merged.`);
        return { cancelled: true };
      }
    } else {
      log(`Confirmed by --yes: merging PR #${n}.`);
    }
    fs.mkdirSync(outDir, { recursive: true });
    const bodyFile = pathMod.join(outDir, `merge-pr-${n}-body.md`);
    fs.writeFileSync(bodyFile, String(pr.body ?? ''), 'utf8');
    const mergeArgs = prMergeArgs(n, { title: pr.title, headOid: pr.headRefOid, bodyFile });
    log(`> ${formatCommand({ file: 'gh', args: [...mergeArgs.slice(0, -1), '<the PR body>'] })}`);
    try {
      await gh(mergeArgs);
    } catch (err) {
      throw new Error(`gh pr merge failed for PR #${n}: ${plainText(err?.stderr ?? err?.message ?? 'unknown error').slice(0, 300)}. Check the PR on GitHub; it may be merged already.`, { cause: err });
    } finally {
      fs.rmSync(bodyFile, { force: true });
    }
    const after = JSON.parse(await gh(prViewArgs(n, 'state,mergeCommit')));
    const sha = after?.mergeCommit?.oid;
    if (after?.state !== 'MERGED' || !COMMIT_RE.test(String(sha))) {
      throw new Error(`gh pr merge finished but PR #${n} does not show as merged with a merge commit. Check it on GitHub before you run again.`);
    }
    const rec = { number: n, title: pr.title, sha, mergedAt: now().toISOString() };
    runMerges.set(n, rec);
    state = recordMerge(state, rec);
    writeState(stateFile, state);
    log(`Merged PR #${n} into main as ${sha.slice(0, 7)}.`);
    log(`> git ${PULL_MAIN_ARGS.join(' ')}`);
    try {
      await git([...PULL_MAIN_ARGS]);
    } catch (err) {
      throw new Error(`PR #${n} is merged on GitHub (${sha.slice(0, 7)}) but git pull --ff-only origin main failed. Fix the checkout (git status), pull main, then run again; the merge is recorded and will not be repeated.`, { cause: err });
    }
    await mainCurrent();
    try {
      await git(['merge-base', '--is-ancestor', sha, 'HEAD']);
    } catch {
      throw new Error(`The local main does not contain the merge commit ${sha.slice(0, 7)} of PR #${n} after the pull. Check git log, then run again.`);
    }
    return { cancelled: false, sha };
  };

  const resolveRemoteTag = async (t) => {
    let ref;
    try {
      ref = JSON.parse(await gh(['api', `repos/${PRIVATE_REPO}/git/ref/tags/${t}`]));
    } catch (err) {
      if (/HTTP 404|Not Found/i.test(String(err?.stderr ?? err?.message ?? ''))) return null;
      throw new Error(`Could not read the tag ${t} from ${PRIVATE_REPO} (gh api).`, { cause: err });
    }
    if (Array.isArray(ref)) return null; // a prefix match of other tags, not this one
    let object = ref?.object;
    for (let depth = 0; object?.type === 'tag' && depth < 5; depth += 1) {
      object = JSON.parse(await gh(['api', `repos/${PRIVATE_REPO}/git/tags/${object.sha}`]))?.object;
    }
    if (object?.type !== 'commit' || !COMMIT_RE.test(String(object.sha))) throw new Error(`The tag ${t} does not point at a commit`);
    return object.sha;
  };

  let tagCommitMemo = null;
  const tagCommit = async () => {
    requireTag();
    if (tagCommitMemo) return tagCommitMemo;
    const sha = await resolveRemoteTag(tag);
    if (!sha) throw new Error(`The tag ${tag} does not exist in ${PRIVATE_REPO} yet. Run the tag stage first (--from tag).`);
    await git(['fetch', '--quiet', 'origin', `+refs/tags/${tag}:refs/tags/${tag}`]);
    const local = await git(['rev-parse', `refs/tags/${tag}^{commit}`]);
    if (local !== sha) throw new Error(`The local tag ${tag} (${local.slice(0, 7)}) is not the one on GitHub (${sha.slice(0, 7)}).`);
    tagCommitMemo = sha;
    return sha;
  };

  // release-please 17 lives outside the repo (as docs/RELEASING.md says), installed once with npm.
  const { tools, cache } = sharedDirs({ env, pathMod });
  const rpBin = pathMod.join(tools, 'node_modules', 'release-please', 'build', 'src', 'bin', 'release-please.js');
  const ensureReleasePlease = () => {
    const pkgFile = pathMod.join(tools, 'node_modules', 'release-please', 'package.json');
    let major;
    try {
      major = Number(String(JSON.parse(fs.readFileSync(pkgFile, 'utf8')).version).split('.')[0]);
    } catch {
      major = null;
    }
    if (major === RELEASE_PLEASE_VERSION_MAJOR && fs.existsSync(rpBin)) return;
    fs.mkdirSync(tools, { recursive: true });
    run({ label: `install ${RELEASE_PLEASE_SPEC} into ${tools}`, file: node, args: [npmCli, 'install', '--prefix', tools, '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', RELEASE_PLEASE_SPEC], cwd: tools, env: 'clean' });
    const got = Number(String(JSON.parse(fs.readFileSync(pkgFile, 'utf8')).version).split('.')[0]);
    if (got !== RELEASE_PLEASE_VERSION_MAJOR) throw new Error(`Installed release-please ${got}, expected ${RELEASE_PLEASE_VERSION_MAJOR}`);
  };
  const releasePlease = async (command, { dryRun }) => {
    ensureReleasePlease();
    const t = await token();
    const args = [SHIM, rpBin, ...releasePleaseArgs(command, { dryRun })];
    log(`> ${formatCommand({ file: node, args: ['release-please', ...releasePleaseArgs(command, { dryRun }), '--token=<from gh auth token>'] }, { execPath, secrets: [t] })}`);
    try {
      return await stepCapture(node, args, { cwd: root, env: childEnv('rp', env, t), secrets: [t], redactFn: redactLine });
    } catch {
      throw new Error(`release-please ${command}${dryRun ? ' --dry-run' : ''} failed; see its output above.`);
    }
  };

  const prepareWorktree = async (wt, commit) => {
    const listed = (await git(['worktree', 'list', '--porcelain']))
      .split(/\r?\n/)
      .filter((l) => l.startsWith('worktree '))
      .map((l) => pathMod.resolve(l.slice('worktree '.length)).toLowerCase());
    const registered = listed.includes(pathMod.resolve(wt).toLowerCase());
    if (fs.existsSync(wt)) {
      if (!registered) throw new Error(`${wt} exists but is not a git worktree of this repository. Move it away, then run again.`);
      const head = await git(['rev-parse', 'HEAD'], wt).catch(() => '');
      const dirty = await git(['status', '--porcelain'], wt).catch(() => 'unknown');
      if (head === commit && dirty === '') {
        log(`Reusing the clean worktree ${wt} at ${commit.slice(0, 7)}.`);
        await prepareProWorktree(wt, await pinnedProCommit());
        return;
      }
      log(`The worktree ${wt} is ${head === commit ? 'not clean' : 'at another commit'}; recreating it.`);
      await git(['worktree', 'remove', '--force', wt]);
    } else if (registered) {
      await git(['worktree', 'prune']);
    }
    fs.mkdirSync(pathMod.dirname(wt), { recursive: true });
    await git(['worktree', 'add', '--detach', wt, commit]);
    await prepareProWorktree(wt, await pinnedProCommit());
  };

  /** Tags the Pro repo with the release tag at the pinned Pro commit (an existing tag must already point there). */
  const tagPro = async (t) => {
    const proCommit = await pinnedProCommit();
    if (!proCommit) return;
    const existing = await git(['rev-parse', '--verify', '--quiet', `refs/tags/${t}^{commit}`], proDir).catch(() => '');
    if (existing === proCommit) return;
    if (existing) throw new Error(`The Pro repo already has the tag ${t} at ${existing.slice(0, 7)}, not at the pinned Pro commit ${proCommit.slice(0, 7)}.`);
    await git(['tag', t, proCommit], proDir);
    log(`Tagged the Pro repo with ${t} at ${proCommit.slice(0, 7)}.`);
  };

  const checkWorktreeVersion = (wt) => {
    const v = pkgVersionAt(wt);
    if (`v${v}` !== tag) throw new Error(`package.json in ${wt} says ${v}, the tag is ${tag}`);
    return v;
  };

  const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && pathMod.resolve(a).toLowerCase() === pathMod.resolve(b).toLowerCase();
  const x64Dest = () => pathMod.join(outDir, 'x64', `Burrow_${requireTag().slice(1)}_x64-setup.exe`);
  const publicDirOf = () => pathMod.join(outDir, 'public');
  const fileOk = (file, hash) => typeof file === 'string' && typeof hash === 'string' && SHA256_RE.test(hash) && fs.existsSync(file) && sha256File(file) === hash;

  const stagedHashes = (publicDir, names) => {
    const found = fs.existsSync(publicDir) ? fs.readdirSync(publicDir).sort() : [];
    const want = [...names].sort();
    if (found.length !== want.length || found.some((n, i) => n !== want[i])) {
      throw new Error(`${publicDir} must hold exactly ${want.join(', ')}; it holds ${found.join(', ') || 'nothing'}`);
    }
    const hashes = {};
    for (const n of want) {
      const st = fs.lstatSync(pathMod.join(publicDir, n));
      if (!st.isFile()) throw new Error(`${n} in ${publicDir} is not a regular file`);
      hashes[n] = sha256File(pathMod.join(publicDir, n));
    }
    return hashes;
  };
  const sameFiles = (a, b) => {
    const ka = Object.keys(a ?? {}).sort();
    const kb = Object.keys(b ?? {}).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
  };

  // --- stages -------------------------------------------------------------------------------------------------
  const out = {};
  const stageImpl = {
    preflight: {
      inputs: async () => ({ commit: await mainCurrent() }),
      verify: async () => false,
      run: async (inputs) => {
        await checkBuildTools({ env, exec, warn, log, pathMod });
        const gitleaks = await gitleaksState({ exec, root, env: ghEnv });
        if (!gitleaks.installed) warn(`gitleaks is not installed, so the checks stage cannot scan for secrets. Install gitleaks ${GITLEAKS_VERSION} (winget install Gitleaks.Gitleaks, or the release zip from https://github.com/gitleaks/gitleaks/releases) and run again.`);
        else if (gitleaks.version !== GITLEAKS_VERSION) warn(`gitleaks ${gitleaks.version} is installed; CI pins ${GITLEAKS_VERSION}.`);
        if (updaterState(root).enabled) assertSigningEnv(env, { root });
        const proCommit = await proHead();
        log(`Preflight passed: Windows ARM64, Node ${nodeVersion}, main at ${inputs.commit.slice(0, 7)} = origin/main, gh signed in, Rust targets present${proCommit ? `, Pro at ${proCommit.slice(0, 7)}` : ''}.`);
        return { outputs: { commit: inputs.commit, gitleaks: gitleaks.installed, proCommit } };
      },
    },
    checks: {
      // With --tag and an existing tag the checks run on the tag commit (in the release worktree), so the record
      // covers exactly what is published; otherwise on main's HEAD, before the release PR.
      inputs: async () => {
        if (opts.tag && (await resolveRemoteTag(opts.tag))) return { commit: await tagCommit(), tag: opts.tag };
        return { commit: await mainCurrent() };
      },
      verify: async () => true,
      run: async (inputs) => {
        let cwd = root;
        if (inputs.tag) {
          cwd = pathMod.join(outDir, 'wt-arm64');
          await prepareWorktree(cwd, inputs.commit);
          log(`Running the checks on the tag commit ${inputs.commit.slice(0, 7)} in ${cwd}.`);
        }
        const gl = await gitleaksState({ exec, root, env: ghEnv });
        if (!gl.installed) warn(`gitleaks is not installed: the secret scan is SKIPPED. Install gitleaks ${GITLEAKS_VERSION} (winget install Gitleaks.Gitleaks) and run --from checks again before you publish.`);
        let lastTag;
        try {
          // On a tag commit HEAD itself carries the tag, so the range starts at the tag before it.
          lastTag = await git(['describe', '--tags', '--abbrev=0', '--match', 'v*', inputs.tag ? 'HEAD^' : 'HEAD'], cwd);
        } catch {
          lastTag = null;
        }
        for (const cmd of checksCommands({ root: cwd, node, npmCli, lastTag, gitleaks: gl.installed })) run(cmd);
        if ((await git(['status', '--porcelain'], cwd)) !== '') throw new Error(`The checks changed tracked files in ${cwd}. Look at git status, then run again.`);
        return { outputs: { commit: inputs.commit, gitleaks: gl.installed, range: lastTag ? `${lastTag}..HEAD` : 'HEAD' } };
      },
    },
    'release-pr': {
      inputs: async () => ({ commit: await mainCurrent() }),
      verify: async () => true,
      run: async (inputs) => {
        if (opts.tag && (await resolveRemoteTag(opts.tag))) {
          log(`The tag ${opts.tag} already exists; no release PR is needed.`);
          return { outputs: { commit: inputs.commit, version: opts.tag.slice(1), pr: null, alreadyTagged: true } };
        }
        const merged = JSON.parse(await gh(['pr', 'list', '-R', PRIVATE_REPO, '--state', 'merged', '--label', 'autorelease: pending', '--json', 'number,title', '--limit', '5']));
        const pendingMerged = [];
        for (const p of Array.isArray(merged) ? merged : []) {
          const v = /^chore\(main\): release (\d+\.\d+\.\d+)$/.exec(String(p?.title ?? ''))?.[1];
          if (v && !(await resolveRemoteTag(`v${v}`))) pendingMerged.push(p);
        }
        if (pendingMerged.length > 0) {
          const p = pendingMerged[0];
          const v = /release (\d+\.\d+\.\d+)$/.exec(p.title)[1];
          log(`Release PR #${p.number} (${p.title}) is merged and not tagged yet; going on to the tag stage.`);
          return { outputs: { commit: inputs.commit, version: v, pr: p.number, merged: true } };
        }
        const dry = parseReleasePrDryRun(await releasePlease('release-pr', { dryRun: true }));
        if (dry.count === 0) {
          log('release-please has nothing to release (no user-facing commit since the last tag). Nothing was changed.');
          return { outputs: null, stop: true, record: false };
        }
        const t = `v${dry.version}`;
        if (opts.tag && opts.tag !== t) throw new Error(`release-please would release ${t}, but --tag says ${opts.tag}. Nothing was changed.`);
        log(`release-please would release ${t}: ${dry.title}`);
        for (const line of summarizeChangelog(dry.body)) log(`  ${line}`);
        await releasePlease('release-pr', { dryRun: false });
        const open = JSON.parse(await gh(['pr', 'list', '-R', PRIVATE_REPO, '--state', 'open', '--label', 'autorelease: pending', '--json', 'number,title,url', '--limit', '10']));
        const pr = (Array.isArray(open) ? open : []).find((p) => typeof p?.title === 'string' && p.title.endsWith(`release ${dry.version}`));
        const prText = pr ? `PR #${pr.number} (${pr.url})` : `the release PR "${dry.title}"`;
        let cancelled = false;
        if (opts.mergeReleasePr) {
          if (!pr) {
            throw new Error(`--merge-release-pr: the release PR for ${dry.version} is not among the open "autorelease: pending" pull requests, so it cannot be merged here. Merge it on GitHub, then re-run with --tag ${t} --from tag.`);
          }
          const res = await mergePullRequest(pr.number, { releaseVersion: dry.version });
          cancelled = res.cancelled;
          if (!cancelled) return { outputs: { commit: inputs.commit, version: dry.version, pr: pr.number, merged: true } };
        }
        return {
          outputs: { commit: inputs.commit, version: dry.version, pr: pr?.number ?? null },
          stop: true,
          message: [
            `Review and merge ${prText}, then re-run with --from tag:`,
            `  npm.cmd run release:auto -- --tag ${t} --from tag${opts.publish ? ' --publish' : ''}`,
            cancelled ? 'The release PR was not merged.' : 'This script merges the release PR only when you pass --merge-release-pr.',
          ],
        };
      },
    },
    tag: {
      inputs: async () => {
        switchTag(requireTag());
        return { tag };
      },
      verify: async (rec) => (await resolveRemoteTag(tag)) === rec.outputs.commit,
      run: async () => {
        await git(['fetch', '--quiet', 'origin', 'main', '--tags']);
        const mainHead = await git(['rev-parse', 'origin/main']);
        const existing = await resolveRemoteTag(tag);
        if (existing) {
          try {
            await git(['merge-base', '--is-ancestor', existing, mainHead]);
          } catch {
            throw new Error(`The tag ${tag} exists but its commit ${existing.slice(0, 7)} is not on main.`);
          }
          log(`The tag ${tag} already exists at ${existing.slice(0, 7)} (on main).`);
          await tagPro(tag);
          return { outputs: { commit: existing, created: false } };
        }
        const would = parseGithubReleaseDryRun(await releasePlease('github-release', { dryRun: true }));
        if (would === 0) {
          throw new Error(
            `release-please would tag 0 releases, so ${tag} cannot be created yet. The release PR is not merged (or was merged without its "autorelease: pending" label). Merge it on GitHub, then run again with --from tag.`,
          );
        }
        await releasePlease('github-release', { dryRun: false });
        await git(['fetch', '--quiet', 'origin', 'main', '--tags']);
        const head = await git(['rev-parse', 'origin/main']);
        const created = await resolveRemoteTag(tag);
        if (!created) throw new Error(`release-please finished but the tag ${tag} does not exist. Check the releases page of ${PRIVATE_REPO}.`);
        if (created !== head) throw new Error(`The new tag ${tag} points at ${created.slice(0, 7)}, not at main's HEAD ${head.slice(0, 7)}. Check it before building.`);
        log(`Tagged ${tag} at ${created.slice(0, 7)} (main's HEAD) and created the private release.`);
        await tagPro(tag);
        return { outputs: { commit: created, created: true } };
      },
    },
    x64: {
      inputs: async () => {
        switchTag(requireTag());
        return { tag, commit: await tagCommit(), proCommit: await pinnedProCommit(), node: nodeVersion, x64Node: opts.x64Node ? pathMod.resolve(opts.x64Node) : 'download' };
      },
      verify: async (rec) =>
        samePath(rec.outputs.installer, x64Dest()) &&
        fileOk(rec.outputs.installer, rec.outputs.sha256) &&
        (rec.outputs.sig === null || fileOk(rec.outputs.sig, rec.outputs.sigSha256)) &&
        // The node.exe the sidecar was built with must still be the same file (re-hashed, not trusted from the record).
        fileOk(rec.outputs.nodeExe, rec.outputs.nodeSha256),
      run: async (inputs) => {
        let nodeExe;
        if (opts.x64Node) {
          nodeExe = pathMod.resolve(opts.x64Node);
          usableNode(nodeExe, { version: nodeVersion });
        } else {
          nodeExe = await ensureNode({ cacheDir: cache, version: nodeVersion, fetchImpl, log, allowUnpinned: true });
        }
        const wt = pathMod.join(outDir, 'wt-x64');
        await prepareWorktree(wt, inputs.commit);
        const version = checkWorktreeVersion(wt);
        const updater = updaterState(wt);
        if (updater.enabled) assertSigningEnv(env, { root: wt });
        for (const cmd of x64Commands({ wt, node, npmCli, nodeExe, version, pathMod })) run(cmd);
        const built = x64InstallerPath({ wt, version, pathMod });
        if (!fs.existsSync(built)) throw new Error(`buildInstaller.js finished but ${built} does not exist`);
        const head = Buffer.alloc(2);
        const fd = fs.openSync(built, 'r');
        try {
          fs.readSync(fd, head, 0, 2, 0);
        } finally {
          fs.closeSync(fd);
        }
        if (head.toString('latin1') !== 'MZ') throw new Error(`${built} is not a Windows executable`);
        if ((await git(['status', '--porcelain'], wt)) !== '') throw new Error(`The x64 build changed tracked files in ${wt}.`);
        const destDir = pathMod.dirname(x64Dest());
        fs.rmSync(destDir, { recursive: true, force: true });
        fs.mkdirSync(destDir, { recursive: true });
        const dest = x64Dest();
        if (pathMod.basename(built) !== pathMod.basename(dest)) throw new Error(`Expected ${pathMod.basename(dest)}, tauri wrote ${pathMod.basename(built)}`);
        fs.copyFileSync(built, dest);
        let sig = null;
        let sigSha256 = null;
        if (updater.enabled) {
          if (!fs.existsSync(`${built}.sig`)) throw new Error(`The updater is on but ${built}.sig is missing`);
          sig = `${dest}.sig`;
          fs.copyFileSync(`${built}.sig`, sig);
          sigSha256 = sha256File(sig);
        }
        const sha256 = sha256File(dest);
        log(`x64 installer: ${dest}`);
        log(`  sha256 ${sha256}`);
        return { outputs: { installer: dest, sha256, sig, sigSha256, nodeExe, nodeSha256: sha256File(nodeExe), updater: updater.enabled } };
      },
    },
    arm64: {
      inputs: async () => {
        switchTag(requireTag());
        const x64 = out.x64 ?? state.stages.x64?.outputs;
        if (!x64) throw new Error('There is no x64 installer for this tag yet. Run --from x64 first.');
        if (!samePath(x64.installer, x64Dest())) throw new Error(`The recorded x64 installer is not ${x64Dest()}. Run --from x64 again.`);
        if (!fileOk(x64.installer, x64.sha256)) throw new Error(`The x64 installer ${x64.installer} is missing or changed since the x64 stage. Run --from x64 again.`);
        if (x64.sig !== null && x64.sig !== undefined && !fileOk(x64.sig, x64.sigSha256)) throw new Error('The x64 signature changed since the x64 stage. Run --from x64 again.');
        out.x64 = x64;
        return { tag, commit: await tagCommit(), proCommit: await pinnedProCommit(), x64Sha256: x64.sha256 };
      },
      verify: async (rec) => {
        try {
          return samePath(rec.outputs.publicDir, publicDirOf()) && sameFiles(stagedHashes(publicDirOf(), Object.keys(rec.outputs.files ?? {})), rec.outputs.files);
        } catch {
          return false;
        }
      },
      run: async (inputs) => {
        const wt = pathMod.join(outDir, 'wt-arm64');
        await prepareWorktree(wt, inputs.commit);
        checkWorktreeVersion(wt);
        const updater = updaterState(wt);
        if (updater.enabled) assertSigningEnv(env, { root: wt });
        for (const cmd of arm64Commands({ wt, node, npmCli, tag, x64File: out.x64.installer, outDir, pathMod })) run(cmd);
        const publicDir = publicDirOf();
        const names = updater.enabled ? UPDATER_ASSETS : ALLOWED_ASSETS;
        const files = stagedHashes(publicDir, names);
        verifySums(fs.readFileSync(pathMod.join(publicDir, SUMS_FILE), 'utf8'), Object.fromEntries(Object.entries(files).filter(([n]) => n !== SUMS_FILE)));
        const manifestFile = pathMod.join(outDir, 'build-manifest.json');
        let manifest;
        try {
          manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
        } catch {
          throw new Error(`release:local did not write ${manifestFile}`);
        }
        if (manifest?.commit !== inputs.commit) throw new Error(`${manifestFile} is for ${String(manifest?.commit).slice(0, 7)}, not ${inputs.commit.slice(0, 7)}`);
        if (files['Burrow-Setup-x64.exe'] !== out.x64.sha256) throw new Error('The staged x64 installer is not the one the x64 stage built.');
        log(`Staged ${Object.keys(files).length} files in ${publicDir}:`);
        for (const [n, h] of Object.entries(files)) log(`  ${h}  ${n}`);
        const curated = pathMod.join(wt, 'release-notes', `${tag}.md`);
        if (fs.existsSync(curated)) {
          log(`--- release-notes/${tag}.md ---`);
          log(fs.readFileSync(curated, 'utf8').trimEnd());
          log('---');
        }
        return { outputs: { publicDir, files, updater: updater.enabled, wt } };
      },
    },
    publish: {
      inputs: async () => {
        switchTag(requireTag());
        const rec = out.arm64 ?? state.stages.arm64?.outputs;
        if (!rec) throw new Error('Nothing is staged for this tag yet. Run --from arm64 (or --from x64) first.');
        // The folders come from the tag, never from the state file.
        if (!samePath(rec.publicDir, publicDirOf()) || !samePath(rec.wt, pathMod.join(outDir, 'wt-arm64'))) throw new Error('The recorded staging folder is not this release\'s folder. Run --from arm64 again.');
        const arm = { ...rec, publicDir: publicDirOf(), wt: pathMod.join(outDir, 'wt-arm64') };
        out.arm64 = arm;
        return { tag, commit: await tagCommit(), files: arm.files };
      },
      verify: async (rec) => rec.outputs.published === true,
      run: async (inputs) => {
        const arm = out.arm64;
        // The release worktree must still be the one the arm64 stage built from: at the tag commit and clean.
        const armRec = state.stages.arm64;
        if (armRec?.inputs?.commit !== inputs.commit) throw new Error(`The arm64 stage was not recorded for the tag commit ${inputs.commit.slice(0, 7)}. Run --from arm64 again. Nothing was published.`);
        if (!fs.existsSync(arm.wt)) throw new Error(`The release worktree ${arm.wt} is gone. Run --from arm64 again. Nothing was published.`);
        const wtHead = await git(['rev-parse', 'HEAD'], arm.wt).catch(() => '');
        if (wtHead !== inputs.commit) throw new Error(`The release worktree ${arm.wt} is at ${wtHead.slice(0, 7) || 'an unknown commit'}, not the tag commit ${inputs.commit.slice(0, 7)}. Run --from arm64 again. Nothing was published.`);
        const wtDirty = await git(['status', '--porcelain'], arm.wt).catch(() => 'unknown');
        if (wtDirty !== '') throw new Error(`The release worktree ${arm.wt} has changes. Run --from arm64 again. Nothing was published.`);
        // The local checks stand in for CI; they must have run on this very commit, or the owner says so.
        const nextState = opts.outDir ? null : readState(pathMod.join(releaseDir({ env, tag: null, pathMod }), STATE_FILE), { tag: null });
        const checksRec = checksRecordFor({ commit: inputs.commit, states: [state, nextState] });
        if (!checksRec && !opts.checksDoneManually) {
          throw new Error(
            `No checks stage was recorded for the tag commit ${inputs.commit.slice(0, 7)}. Run npm.cmd run release:auto -- --tag ${tag} --from checks (it runs them on the tag commit), or pass --checks-done-manually if you ran the local checks of docs/RELEASING.md step 1 on this commit yourself. Nothing was published.`,
          );
        }
        const checksLine = checksRec
          ? `The local checks ran on the tag commit ${inputs.commit.slice(0, 7)} (${checksRec.completedAt}${checksRec.outputs?.gitleaks === false ? ', WITHOUT gitleaks' : ''}).`
          : `--checks-done-manually: the local checks (lint, test, build, Playwright, gitleaks) stand in for CI and were NOT recorded for the tag commit ${inputs.commit.slice(0, 7)}; you said you ran them by hand.`;
        const check = () => {
          const now2 = stagedHashes(arm.publicDir, Object.keys(arm.files));
          if (!sameFiles(now2, arm.files)) throw new Error(`The files in ${arm.publicDir} changed since the arm64 stage. Run --from arm64 again. Nothing was published.`);
        };
        check();
        const dryOutput = await runCapture(publishCommand({ wt: arm.wt, node, tag, publicDir: arm.publicDir, dryRun: true, pathMod }));
        const curatedFile = pathMod.join(arm.wt, 'release-notes', `${tag}.md`);
        const curated = fs.existsSync(curatedFile) ? fs.readFileSync(curatedFile, 'utf8') : null;
        assertDryRunNotes({ output: dryOutput, curated, tag });
        log(checksLine);
        const mode = publishConfirmationMode({ tag, yes: opts.yes, env, isTTY });
        if (mode === 'prompt') {
          log('This publishes to the PUBLIC downloads repo ChristianMunoz31/burrow-releases with publishPublic.js directly, the documented path while GitHub Actions cannot run (it skips the CI check of release:local --publish; the local checks stand in for it).');
          const answer = await prompt(`Type ${tag} to publish it (anything else cancels): `);
          if (!typedTagMatches(answer, tag)) {
            log('Cancelled. Nothing was published.');
            return { outputs: null, stop: true, record: false };
          }
        } else {
          log(`Confirmed by --yes and BURROW_RELEASE_CONFIRM=${tag}.`);
        }
        check();
        const fromEnv = String(env.RELEASES_TOKEN ?? '').trim();
        const t = fromEnv !== '' ? checkToken(fromEnv) : await token();
        run(publishCommand({ wt: arm.wt, node, tag, publicDir: arm.publicDir, dryRun: false, pathMod }), { token: t });
        log(`Published ${tag} to ChristianMunoz31/burrow-releases.`);
        return { outputs: { published: true, files: inputs.files } };
      },
    },
    after: {
      inputs: async () => {
        switchTag(requireTag());
        return { tag };
      },
      verify: async () => false,
      run: async () => {
        await tagCommit().catch(() => null);
        let privacyChanged;
        try {
          const prev = await git(['describe', '--tags', '--abbrev=0', '--match', 'v*', `${tag}^`]);
          try {
            await git(['diff', '--quiet', prev, tag, '--', 'config/privacy.json']);
            privacyChanged = false;
          } catch (err) {
            privacyChanged = err?.code === 1 ? true : null;
          }
        } catch {
          privacyChanged = null;
        }
        const published = out.publish?.published === true || state.stages.publish?.outputs?.published === true;
        if (opts.gumroad && published) {
          run({ label: 'Gumroad pages dry run (read only)', file: node, args: [npmCli, 'run', 'release:gumroad', '--', '--tag', tag], cwd: root, env: 'clean' });
        } else if (opts.gumroad) {
          log('--gumroad: skipped, nothing is published yet.');
        }
        for (const line of afterSteps({ tag, privacyChanged, outDir, published })) log(line);
        return { outputs: { privacyChanged, published } };
      },
    },
  };

  locking = true;
  try {
    lockHere();
    return await runStages();
  } finally {
    for (const release of locks.values()) release();
  }

  async function runStages() {
    for (const name of stagesForRun(opts.from)) {
      if (name === 'publish' && !opts.publish) {
        log('== publish: skipped (add --publish to publish; the installers are staged and nothing was uploaded)');
        continue;
      }
      if (name === 'checks' && opts.mergePrs.length > 0) {
        for (const n of opts.mergePrs) {
          const res = await mergePullRequest(n);
          if (res.cancelled) return { stoppedAt: 'merge-pr' };
        }
      }
      const impl = stageImpl[name];
      const inputs = await impl.inputs();
      const record = state.stages[name];
      const always = name === 'preflight' || name === 'after';
      const decision = always
        ? { skip: false, reason: 'always runs' }
        : decideStage({ stage: name, forced: opts.from, record, inputs, outputsOk: record ? await impl.verify(record) : false });
      if (decision.skip) {
        out[name] = record.outputs;
        log(`== ${name}: skipped, ${decision.reason}`);
        continue;
      }
      log(`== ${name}: running (${decision.reason})`);
      const res = await impl.run(inputs);
      if (res.record !== false) save(name, inputs, res.outputs);
      out[name] = res.outputs;
      if (res.outputs?.merged && name === 'release-pr') {
        // The release PR is merged: its version is on main now, so the state of the tagged release takes over.
        const t = `v${res.outputs.version}`;
        const onMain = await tagFromMain();
        if (onMain !== t) throw new Error(`The merged release PR says ${t} but origin/main's package.json says ${onMain}. Check main, then run again with --tag.`);
        switchTag(t);
      }
      if (res.stop) {
        for (const line of res.message ?? []) log(line);
        return { stoppedAt: name };
      }
    }
    return { done: true };
  }
}

/** Best-effort Visual Studio Build Tools check through vswhere; only prints guidance. */
async function checkBuildTools({ env, exec, warn, log, pathMod }) {
  const base = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const vswhere = pathMod.join(base, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!fs.existsSync(vswhere)) {
    warn('Could not find vswhere.exe, so the Visual Studio Build Tools were not checked. The builds need the MSVC ARM64 and the ARM64-hosted x64 compilers (VS Build Tools 2026, MSVC 14.50).');
    return;
  }
  for (const [label, component] of [
    ['ARM64', 'Microsoft.VisualStudio.Component.VC.Tools.ARM64'],
    ['x64', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64'],
  ]) {
    let found;
    try {
      found = String((await exec(vswhere, ['-products', '*', '-latest', '-requires', component, '-property', 'installationPath'], {})).stdout).trim();
    } catch {
      found = '';
    }
    if (found) log(`Visual Studio Build Tools: the ${label} compiler is installed (${found}).`);
    else warn(`Visual Studio Build Tools: no ${label} compiler (${component}). Add it in the Visual Studio Installer before the ${label === 'x64' ? 'x64' : 'arm64'} stage.`);
  }
}

async function gitleaksState({ exec, root, env }) {
  try {
    const { stdout } = await exec('gitleaks', ['version'], { cwd: root, env });
    const version = /(\d+\.\d+\.\d+)/.exec(String(stdout))?.[1] ?? 'unknown';
    return { installed: true, version };
  } catch {
    return { installed: false, version: null };
  }
}

function planMergesSummary(opts) {
  const parts = [];
  if (opts.mergePrs.length > 0) parts.push(`PR ${opts.mergePrs.map((n) => `#${n}`).join(', ')} before the checks (--merge-pr)`);
  if (opts.mergeReleasePr) parts.push('the release PR after the release-pr stage (--merge-release-pr)');
  if (parts.length === 0) return 'none (add --merge-pr N or --merge-release-pr)';
  return `${parts.join('; ')}; ${opts.yes ? 'confirmed by --yes' : 'after you type each PR number'}`;
}

/**
 * The plan without running anything: the stages this invocation would walk through and the commands of each.
 * @returns {string[]}
 */
export function dryPlan(opts, { env, root, execPath, npmCli, pathMod = path.win32, pkgVersion, platform, arch }) {
  const tag = opts.tag ?? null;
  const shownTag = tag ?? `v${pkgVersion} (main's package.json; release-please decides the real version)`;
  const effectiveTag = tag ?? `v${pkgVersion}`;
  const version = effectiveTag.slice(1);
  const tagKnown = tag !== null || (opts.from !== null && stagesForRun(opts.from).length <= stagesForRun('tag').length);
  const outDir = releaseDir({ env, tag: tagKnown ? effectiveTag : null, outDir: opts.outDir, pathMod });
  const tagDir = releaseDir({ env, tag: effectiveTag, outDir: opts.outDir, pathMod });
  const node = execPath;
  const npm = npmCli ?? 'npm-cli.js';
  const show = (cmd) => `    ${formatCommand(cmd, { execPath })}`;
  const { cache, tools } = sharedDirs({ env, pathMod });
  const lines = [
    'release:auto plan (--dry-plan: nothing is run)',
    `  tag       ${shownTag}`,
    `  state     ${pathMod.join(outDir, STATE_FILE)}`,
    `  host      ${platform} ${arch}${platform === 'win32' && arch === 'arm64' ? '' : ' (a real run refuses this host: Windows ARM64 only)'}`,
    `  merges    ${planMergesSummary(opts)}`,
    `  publish   ${opts.publish ? (opts.yes ? 'yes, confirmed by --yes plus BURROW_RELEASE_CONFIRM=<tag>' : 'yes, after you type the tag') : 'no (add --publish)'}`,
  ];
  const wtX64 = pathMod.join(tagDir, 'wt-x64');
  const wtArm = pathMod.join(tagDir, 'wt-arm64');
  const x64File = pathMod.join(tagDir, 'x64', `Burrow_${version}_x64-setup.exe`);
  const publicDir = pathMod.join(tagDir, 'public');
  for (const stage of stagesForRun(opts.from)) {
    lines.push('');
    switch (stage) {
      case 'preflight':
        lines.push('[preflight] always runs');
        lines.push('    Windows ARM64 host, Node ^22.13.0 || >=23.4.0, gh auth status, a clean main checkout equal to origin/main,');
        lines.push(`    rustup target list --installed has ${ARM64_TRIPLE} and ${X64_TRIPLE}, Visual Studio Build Tools (vswhere, best effort),`);
        lines.push(`    gitleaks ${GITLEAKS_VERSION} present (warning only), and the signing variables when the updater is on.`);
        break;
      case 'checks':
        for (const n of opts.mergePrs) {
          lines.push(`[merge PR #${n}] --merge-pr, before the checks, after preflight`);
          lines.push('    refuses unless the PR is OPEN, not a draft, based on main and MERGEABLE; prints its title and head branch;');
          lines.push(`    asks you to type ${n} (without a terminal it needs --yes); the squash subject is "<PR title> (#${n})", the body is the PR body`);
          for (const cmd of mergePlanCommands(n)) lines.push(show(cmd));
          lines.push('    then records the merged commit in the state file, so a re-run does not merge it again, and checks main equals origin/main.');
          lines.push('');
        }
        lines.push(tag ? `[checks] on the tag commit in ${wtArm} once ${tag} exists (else on main's HEAD); skipped when that commit was already checked` : "[checks] skipped when main is at the commit already checked");
        for (const cmd of checksCommands({ root, node, npmCli: npm, lastTag: '<last tag>', gitleaks: true })) lines.push(show(cmd));
        break;
      case 'release-pr':
        lines.push(`[release-pr] ${RELEASE_PLEASE_SPEC} in ${tools}; the token comes from gh auth token and reaches release-please through its environment only`);
        lines.push(show({ file: 'release-please', args: [...releasePleaseArgs('release-pr', { dryRun: true }), '--token=<from gh auth token>'] }));
        lines.push(show({ file: 'release-please', args: [...releasePleaseArgs('release-pr', { dryRun: false }), '--token=<from gh auth token>'] }));
        if (opts.mergeReleasePr) {
          lines.push('    then, after that summary, --merge-release-pr merges the release PR (it refuses unless the title is chore(main): release X.Y.Z,');
          lines.push('    the PR is OPEN, not a draft, based on main and MERGEABLE), asks you to type its number (or needs --yes) and goes on to the tag stage:');
          for (const cmd of mergePlanCommands('<release PR number>')) lines.push(show(cmd));
        } else {
          lines.push('    then STOPS: "Review and merge PR #N, then re-run with --from tag". Add --merge-release-pr to merge it here instead.');
        }
        break;
      case 'tag':
        lines.push('[tag] skipped when the tag already exists on main');
        lines.push(show({ file: 'release-please', args: [...releasePleaseArgs('github-release', { dryRun: true }), '--token=<from gh auth token>'] }));
        lines.push(show({ file: 'release-please', args: [...releasePleaseArgs('github-release', { dryRun: false }), '--token=<from gh auth token>'] }));
        lines.push(`    then checks that ${effectiveTag} exists and points at main's HEAD (0 releases tagged = the release PR is not merged yet).`);
        break;
      case 'x64':
        lines.push(`[x64] worktree ${wtX64} at the tag commit`);
        lines.push(`    x64 node.exe ${opts.x64Node ? `from --x64-node ${opts.x64Node}` : `for this Node version from https://nodejs.org/dist/<version>/win-x64/node.exe, sha256 from SHASUMS256.txt (and the pin in config/store-node.json when there is one), cached in ${cache}`}`);
        for (const cmd of x64Commands({ wt: wtX64, node, npmCli: npm, nodeExe: '<x64 node.exe>', version, pathMod })) lines.push(show(cmd));
        lines.push(`    then copies ${x64InstallerPath({ wt: wtX64, version, pathMod })} to ${x64File} and records its sha256.`);
        break;
      case 'arm64':
        lines.push(`[arm64] worktree ${wtArm} at the tag commit`);
        for (const cmd of arm64Commands({ wt: wtArm, node, npmCli: npm, tag: effectiveTag, x64File, outDir: tagDir, pathMod })) lines.push(show(cmd));
        lines.push(`    then checks ${publicDir} holds exactly 3 files (6 with the updater on) and SHA256SUMS.txt matches them.`);
        break;
      case 'publish':
        if (!opts.publish) {
          lines.push('[publish] skipped (needs --publish)');
          break;
        }
        lines.push('[publish] publishPublic.js directly (the documented path while Actions cannot run)');
        lines.push(show(publishCommand({ wt: wtArm, node, tag: effectiveTag, publicDir, dryRun: true, pathMod })));
        lines.push(`    first refuses unless ${wtArm} is clean and at the tag commit, and a checks stage was recorded for that commit${opts.checksDoneManually ? ' (here: --checks-done-manually, you ran the checks by hand)' : ' (or --checks-done-manually)'}`);
        lines.push(`    the dry run must render release-notes/${effectiveTag}.md when it exists (its first line is looked for in the output)`);
        lines.push(`    then asks you to type ${effectiveTag} (or needs --yes and BURROW_RELEASE_CONFIRM=${effectiveTag}), re-checks the staged hashes, and runs with GH_TOKEN for that one child:`);
        lines.push(show(publishCommand({ wt: wtArm, node, tag: effectiveTag, publicDir, dryRun: false, pathMod })));
        break;
      case 'after':
        lines.push('[after] always runs: prints the owner-only steps');
        if (opts.gumroad) lines.push(show({ file: node, args: [npm, 'run', 'release:gumroad', '--', '--tag', effectiveTag] }));
        for (const line of afterSteps({ tag: effectiveTag, privacyChanged: null, outDir: tagDir, published: opts.publish })) lines.push(`    ${line}`);
        break;
      default:
        break;
    }
  }
  return lines;
}

async function main(argv) {
  const opts = parseAutoArgs(argv);
  await runAuto(opts);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
