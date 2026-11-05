// Pure helpers of release:auto (scripts/release/releaseAuto.mjs): arguments, stages, the resume state file, token
// redaction, the publish confirmation gate and the commands each stage runs. No network, no child process here, so
// the tests can check every decision without a build. The commands are built in one place and used both by the real
// run and by --dry-plan, so the plan shows exactly what would run.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

export const PRIVATE_REPO = 'ChristianMunoz31/burrow';
export const STAGES = Object.freeze(['preflight', 'checks', 'release-pr', 'tag', 'x64', 'arm64', 'publish', 'after']);
export const STATE_FILE = 'auto-state.json';
export const STATE_VERSION = 1;
export const STRICT_TAG_RE = /^v[0-9]+\.[0-9]+\.[0-9]+$/;
export const X64_TRIPLE = 'x86_64-pc-windows-msvc';
export const ARM64_TRIPLE = 'aarch64-pc-windows-msvc';
export const RUST_TARGETS = Object.freeze([ARM64_TRIPLE, X64_TRIPLE]);
export const GITLEAKS_VERSION = '8.30.1';
export const RELEASE_PLEASE_VERSION_MAJOR = 17;
export const RELEASE_PLEASE_SPEC = `release-please@${RELEASE_PLEASE_VERSION_MAJOR}`;
/** The folder (under burrow-release) that holds the state of a release whose version is not known yet. */
export const PENDING_DIR = 'next';
/** Variable that carries the token into the release-please shim; set for that one child only. */
export const RP_TOKEN_VAR = 'BURROW_RP_TOKEN';
/** Env names that hold a GitHub token and must never reach a build, test or check child. */
export const TOKEN_ENV_RE = /^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|RELEASES_TOKEN|BURROW_RP_TOKEN)$/i;
/**
 * Any other env name that looks like a credential (NPM_TOKEN, GITHUB_PAT, AUTH_SECRET, *_PASSWORD, *_API_KEY, ...).
 * No build, test or check step needs one: npm ci uses the public registry, and the updater signing variables (one of
 * them ends in PASSWORD) are handed to the installer step separately by childEnv('signing') from the original
 * environment, so they need no exception here.
 */
export const SECRET_ENV_RE = /(TOKEN|PAT|SECRET|PASSWORD|API_KEY)$/i;
/** Lock file in the release folder: a second concurrent run is refused. */
export const LOCK_FILE = 'auto.lock';
/** A lock older than this may be taken over (with a message); a run never takes this long. */
export const LOCK_STALE_MS = 6 * 60 * 60 * 1000;
const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;

export const USAGE = `Usage: npm run release:auto -- [--tag vX.Y.Z] [--from <stage>] [--publish] [--yes] [--checks-done-manually]
                              [--merge-pr <N[,N]>] [--merge-release-pr] [--gumroad] [--x64-node <node.exe>]
                              [--out-dir <dir>] [--status] [--dry-plan]
Stages: ${STAGES.join(', ')}
  --from <stage>   start at this stage (it always runs; later stages run again only when their inputs changed)
  --tag vX.Y.Z     the release tag. Needed from the tag stage on unless main's package.json already has the version
  --publish        also run the publish stage (asks you to type the tag; --yes needs BURROW_RELEASE_CONFIRM=<tag> too)
  --checks-done-manually
                   publish although no checks stage was recorded for the tag commit (you ran the local checks of
                   docs/RELEASING.md step 1 on that commit by hand). Otherwise run --from checks --tag vX.Y.Z first
  --merge-pr <N>   before the checks stage, squash-merge pull request N into main (repeatable or comma-separated),
                   then fast-forward the local main. Asks you to type N; without a terminal it needs --yes
  --merge-release-pr
                   after the release-pr stage opened or updated the release PR, squash-merge it the same way and go on
                   to the tag stage in the same run (without it the run stops and asks you to merge it yourself)
  --yes            also answers the two merge questions above (publishing still needs BURROW_RELEASE_CONFIRM=<tag>)
  --gumroad        the after stage also runs the release:gumroad dry run (read only)
  --x64-node <f>   use this x64 node.exe (Node of the same version as this node) instead of downloading it
  --out-dir <dir>  the release folder (default %LOCALAPPDATA%\\burrow-release\\<tag>)
  --status         print the stage table and exit
  --dry-plan       print the plan and the commands without running anything (works on any computer)
See docs/RELEASING.md ("One command: release:auto").`;

/**
 * @typedef {{
 *   tag: string | null, from: string | null, publish: boolean, yes: boolean, gumroad: boolean,
 *   x64Node: string | null, outDir: string | null, status: boolean, dryPlan: boolean, help: boolean,
 *   checksDoneManually: boolean, mergePrs: number[], mergeReleasePr: boolean,
 * }} AutoOptions
 */

/**
 * Parses the command line. Unknown flags (for example a --skip-checks) are refused.
 * @param {string[]} argv
 * @returns {AutoOptions}
 */
export function parseAutoArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      tag: { type: 'string' },
      from: { type: 'string' },
      publish: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      'checks-done-manually': { type: 'boolean', default: false },
      'merge-pr': { type: 'string', multiple: true },
      'merge-release-pr': { type: 'boolean', default: false },
      gumroad: { type: 'boolean', default: false },
      'x64-node': { type: 'string' },
      'out-dir': { type: 'string' },
      status: { type: 'boolean', default: false },
      'dry-plan': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const opts = {
    tag: values.tag ?? null,
    from: values.from ?? null,
    publish: values.publish,
    yes: values.yes,
    gumroad: values.gumroad,
    x64Node: values['x64-node'] ?? null,
    outDir: values['out-dir'] ?? null,
    status: values.status,
    dryPlan: values['dry-plan'],
    help: values.help,
    checksDoneManually: values['checks-done-manually'],
    mergePrs: parseMergeNumbers(values['merge-pr'] ?? []),
    mergeReleasePr: values['merge-release-pr'],
  };
  if (opts.tag !== null && !STRICT_TAG_RE.test(opts.tag)) throw new Error(`--tag must look like v1.2.3 (stable only), got "${opts.tag}"`);
  if (opts.from !== null && !STAGES.includes(opts.from)) throw new Error(`--from must be one of ${STAGES.join(', ')}, got "${opts.from}"`);
  if (opts.yes && !opts.publish && opts.mergePrs.length === 0 && !opts.mergeReleasePr) throw new Error('--yes only applies to --publish, --merge-pr and --merge-release-pr');
  if (opts.mergePrs.length > 0 && opts.from !== null && STAGES.indexOf(opts.from) > STAGES.indexOf('checks')) {
    throw new Error(`--merge-pr merges before the checks stage, so it cannot go with --from ${opts.from}`);
  }
  if (opts.mergeReleasePr && opts.from !== null && STAGES.indexOf(opts.from) > STAGES.indexOf('release-pr')) {
    throw new Error(`--merge-release-pr merges after the release-pr stage, so it cannot go with --from ${opts.from}`);
  }
  if (opts.checksDoneManually && !opts.publish) throw new Error('--checks-done-manually only applies to --publish');
  if (opts.from === 'publish' && !opts.publish) throw new Error('--from publish needs --publish');
  if (opts.from !== null && STAGES.indexOf(opts.from) >= STAGES.indexOf('tag') && opts.tag === null) {
    throw new Error(`--from ${opts.from} needs --tag vX.Y.Z (the release to work on), so an older release is never rebuilt by mistake`);
  }
  if (opts.status && opts.dryPlan) throw new Error('Choose --status or --dry-plan, not both');
  return opts;
}

/**
 * The build stages run only on the owner's Windows ARM64 PC.
 * @param {{ platform: string, arch: string }} host
 * @throws {Error} on any other host
 */
export function assertReleaseHost({ platform, arch }) {
  if (platform !== 'win32' || arch !== 'arm64') {
    throw new Error(
      `release:auto builds the release on the Windows ARM64 PC only. This is ${platform} ${arch}. Use --dry-plan to see the plan here, or --status to read the stage table.`,
    );
  }
}

/**
 * True for a Node version that package.json's engines accept (^22.13.0 || >=23.4.0).
 * @param {string} version for example v24.15.0
 * @returns {boolean}
 */
export function isSupportedNode(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(version));
  if (!m) return false;
  const [maj, min] = [Number(m[1]), Number(m[2])];
  if (maj === 22) return min >= 13;
  if (maj === 23) return min >= 4;
  return maj > 23;
}

/**
 * Missing Rust targets, from the output of `rustup target list --installed`.
 * @param {string} installed
 * @returns {string[]}
 */
export function missingRustTargets(installed) {
  const have = new Set(String(installed).split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  return RUST_TARGETS.filter((t) => !have.has(t));
}

/**
 * The release folder: --out-dir, else %LOCALAPPDATA%\burrow-release\<tag or "next">.
 * @param {{ env: Record<string, string | undefined>, tag: string | null, outDir?: string | null, pathMod?: typeof path }} input
 * @returns {string}
 */
export function releaseDir({ env, tag, outDir = null, pathMod = path.win32 }) {
  if (outDir) return pathMod.resolve(outDir);
  const base = env.LOCALAPPDATA && env.LOCALAPPDATA.trim() !== '' ? env.LOCALAPPDATA : '%LOCALAPPDATA%';
  return pathMod.join(base, 'burrow-release', tag ?? PENDING_DIR);
}

/**
 * The folder under burrow-release that caches the x64 node.exe and the release-please tool.
 * @param {{ env: Record<string, string | undefined>, pathMod?: typeof path }} input
 * @returns {{ cache: string, tools: string }}
 */
export function sharedDirs({ env, pathMod = path.win32 }) {
  const base = env.LOCALAPPDATA && env.LOCALAPPDATA.trim() !== '' ? env.LOCALAPPDATA : '%LOCALAPPDATA%';
  return { cache: pathMod.join(base, 'burrow-release', 'cache'), tools: pathMod.join(base, 'burrow-release', 'tools', `release-please-${RELEASE_PLEASE_VERSION_MAJOR}`) };
}

// ---------------------------------------------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------------------------------------------

/**
 * Replaces every occurrence of each secret with ***. Secrets shorter than 8 characters are ignored (a token is never
 * that short, and redacting tiny strings would garble output).
 * @param {string} text
 * @param {Array<string | null | undefined>} secrets
 * @returns {string}
 */
export function redact(text, secrets) {
  let out = String(text);
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 8) continue;
    out = out.split(secret).join('***');
  }
  return out;
}

/**
 * A copy of the environment without any GitHub token variable and without any other credential-like variable
 * (SECRET_ENV_RE; names matched case-insensitively, as on Windows).
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string | undefined>}
 */
export function withoutTokenEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !TOKEN_ENV_RE.test(name) && !SECRET_ENV_RE.test(name)));
}

/**
 * True when `target` lies inside `root` (or is it), after resolving symbolic links and junctions: the nearest
 * existing parent of `target` and `root` itself are realpath'd first, so a link that points into the repository
 * counts as inside.
 * @param {string} target
 * @param {string} root
 * @returns {boolean}
 */
export function isInsideDir(target, root) {
  const real = (p) => {
    let cur = path.resolve(p);
    const rest = [];
    for (;;) {
      try {
        return path.join(fs.realpathSync.native(cur), ...rest.reverse());
      } catch (err) {
        if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') throw err;
        const parent = path.dirname(cur);
        if (parent === cur) return path.join(cur, ...rest.reverse());
        rest.push(path.basename(cur));
        cur = parent;
      }
    }
  };
  const fold = (p) => (process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p);
  const rel = path.relative(fold(real(root)), fold(real(target)));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Takes the lock file of a release folder. A second run is refused while the lock is fresh; a lock older than
 * LOCK_STALE_MS (or unreadable) is taken over with a message.
 * @param {string} dir
 * @param {{ now?: Date, pid?: number, log?: (line: string) => void }} [opts]
 * @returns {() => void} releases the lock
 */
export function acquireLock(dir, { now = new Date(), pid = process.pid, log = () => {} } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, LOCK_FILE);
  const body = `${JSON.stringify({ pid, startedAt: now.toISOString() })}\n`;
  const take = () => {
    const fd = fs.openSync(file, 'wx');
    try {
      fs.writeFileSync(fd, body, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
  };
  try {
    take();
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
    let started = null;
    let holder = 'unknown';
    try {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      const t = Date.parse(json?.startedAt);
      if (Number.isFinite(t)) started = t;
      if (Number.isInteger(json?.pid)) holder = String(json.pid);
    } catch {
      started = null;
    }
    if (started === null) {
      try {
        started = fs.statSync(file).mtimeMs;
      } catch {
        started = 0;
      }
    }
    const age = now.getTime() - started;
    if (age < LOCK_STALE_MS) {
      throw new Error(`Another release:auto run holds ${file} (process ${holder}, started ${new Date(started).toISOString()}). Wait for it to finish. If no other run is going, delete that file and run again.`, { cause: err });
    }
    log(`Taking over the stale lock ${file} (process ${holder}, started ${new Date(started).toISOString()}, more than 6 hours ago).`);
    fs.rmSync(file, { force: true });
    take();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (json?.pid === pid && json?.startedAt === now.toISOString()) fs.rmSync(file, { force: true });
    } catch {
      // already gone
    }
  };
}

/**
 * Checks the answer of `gh auth token` without ever putting it in an error message.
 * @param {string} raw
 * @returns {string} the trimmed token
 */
export function checkToken(raw) {
  const token = String(raw ?? '').trim();
  if (token === '' || token.length > 512 || /\s/.test(token)) throw new Error('gh auth token gave no usable token. Run gh auth login, then try again.');
  return token;
}

// ---------------------------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------------------------

/**
 * @typedef {{ label: string, file: string, args: string[], cwd: string, env?: 'plain' | 'clean' | 'signing' | 'publish', allowFail?: boolean }} Command
 */

/**
 * How a command is shown: node instead of the node path, npm/npx instead of the npm-cli.js path. Secrets redacted.
 * @param {{ file: string, args: string[] }} cmd
 * @param {{ execPath?: string, secrets?: string[] }} [opts]
 * @returns {string}
 */
export function formatCommand(cmd, { execPath = process.execPath, secrets = [] } = {}) {
  let parts = [cmd.file, ...cmd.args];
  if (cmd.file === execPath || cmd.file === 'node') {
    const first = cmd.args[0] ?? '';
    if (/npm-cli\.js$/.test(first)) parts = ['npm', ...cmd.args.slice(1)];
    else parts = ['node', ...cmd.args];
  }
  const shown = parts.map((p) => (p === '' ? '""' : /[\s"]/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p)).join(' ');
  return redact(shown, secrets);
}

/**
 * The checks stage: the same commands as "Releasing without GitHub Actions" step 1.
 * @param {{ root: string, node: string, npmCli: string, lastTag: string | null, gitleaks: boolean }} input
 * @returns {Command[]}
 */
export function checksCommands({ root, node, npmCli, lastTag, gitleaks }) {
  const npm = (label, ...args) => ({ label, file: node, args: [npmCli, ...args], cwd: root, env: 'plain' });
  const cmds = [
    npm('install the locked dependencies', 'ci'),
    npm('lint', 'run', 'lint'),
    npm('em dash, personal data, keys and privacy checks', 'run', 'check'),
    npm('unit tests', 'test'),
    npm('web build', 'run', 'build'),
    npm('bundle budget', 'run', 'check:bundle'),
    npm('Playwright flows, first-run and a11y', 'exec', '--no', '--', 'playwright', 'test', '--project=flows', '--project=first-run', '--project=a11y'),
  ];
  if (gitleaks) {
    const range = lastTag ? `${lastTag}..HEAD` : 'HEAD';
    cmds.push({ label: `gitleaks over ${range}`, file: 'gitleaks', args: ['git', '--config', '.gitleaks.toml', `--log-opts=${range}`, '--redact', '.'], cwd: root, env: 'plain' });
  }
  return cmds;
}

/**
 * Arguments of release-please (without --token, which the shim adds from its environment).
 * @param {'release-pr' | 'github-release'} command
 * @param {{ dryRun: boolean }} opts
 * @returns {string[]}
 */
export function releasePleaseArgs(command, { dryRun }) {
  if (command !== 'release-pr' && command !== 'github-release') throw new Error(`Unexpected release-please command ${String(command)}`);
  return [
    command,
    `--repo-url=${PRIVATE_REPO}`,
    '--target-branch=main',
    '--config-file=release-please-config.json',
    '--manifest-file=.release-please-manifest.json',
    ...(dryRun ? ['--dry-run'] : []),
  ];
}

/**
 * The x64 stage after `npm ci`: web build, cross-built sidecar, its channel check and smoke test, then the installer.
 * The exact commands of "x64 without CI (manual fallback)" and the v1.2.0 runbook step 4.
 * @param {{ wt: string, node: string, npmCli: string, nodeExe: string, version: string, pathMod?: typeof path }} input
 * @returns {Command[]}
 */
export function x64Commands({ wt, node, npmCli, nodeExe, version, pathMod = path.win32 }) {
  const j = (...p) => pathMod.join(wt, ...p);
  const sidecar = j('src-tauri', 'binaries', `burrow-server-${X64_TRIPLE}.exe`);
  return [
    { label: 'install the locked dependencies (x64 worktree)', file: node, args: [npmCli, 'ci'], cwd: wt, env: 'clean' },
    { label: 'web build', file: node, args: [npmCli, 'run', 'build'], cwd: wt, env: 'clean' },
    {
      label: 'x64 sidecar (postject may print "The signature seems corrupted!", which is expected)',
      file: node,
      args: [j('scripts', 'desktop', 'buildSidecar.js'), '--minify', '--channel', 'stable', '--node-binary', nodeExe, '--out-triple', X64_TRIPLE],
      cwd: wt,
      env: 'clean',
    },
    {
      label: 'channel check of the x64 sidecar',
      file: node,
      args: [j('scripts', 'checks', 'channelMarker.js'), '--expect', 'stable', '--bundle', j('.sidecar-build', 'server.cjs'), '--dist-dir', j('src-tauri', 'resources', 'dist'), '--binary', sidecar],
      cwd: wt,
      env: 'clean',
    },
    {
      label: 'x64 sidecar smoke test (under emulation)',
      file: node,
      args: [j('scripts', 'release', 'smokeSidecar.js'), '--sidecar', sidecar, '--resources', j('src-tauri', 'resources'), '--expect-version', version],
      cwd: wt,
      env: 'clean',
    },
    { label: 'x64 installer', file: node, args: [j('scripts', 'release', 'buildInstaller.js'), '--target', X64_TRIPLE], cwd: wt, env: 'signing' },
  ];
}

/**
 * Where tauri leaves the x64 installer in the x64 worktree.
 * @param {{ wt: string, version: string, pathMod?: typeof path }} input
 * @returns {string}
 */
export function x64InstallerPath({ wt, version, pathMod = path.win32 }) {
  return pathMod.join(wt, 'src-tauri', 'target', X64_TRIPLE, 'release', 'bundle', 'nsis', `Burrow_${version}_x64-setup.exe`);
}

/**
 * The arm64 stage: npm ci, then release:local as a dry run with the x64 installer (it builds arm64 and stages both).
 * @param {{ wt: string, node: string, npmCli: string, tag: string, x64File: string, outDir: string, pathMod?: typeof path }} input
 * @returns {Command[]}
 */
export function arm64Commands({ wt, node, npmCli, tag, x64File, outDir, pathMod = path.win32 }) {
  return [
    { label: 'install the locked dependencies (release worktree)', file: node, args: [npmCli, 'ci'], cwd: wt, env: 'clean' },
    {
      label: 'release:local dry run (builds arm64, stages both installers, prints the plan and the notes; uploads nothing)',
      file: node,
      args: [pathMod.join(wt, 'scripts', 'release', 'releaseLocal.mjs'), '--tag', tag, '--x64-file', x64File, '--out-dir', outDir, '--dry-run'],
      cwd: wt,
      env: 'signing',
    },
  ];
}

/**
 * The publish stage: publishPublic.js directly (the documented path while Actions cannot run), dry run then real.
 * `--notes-from` names the CHANGELOG.md of the release worktree (at the tag), so publishPublic.js renders the
 * changelog section and uses release-notes/<tag>.md next to it, as the CI publish job does.
 * @param {{ wt: string, node: string, tag: string, publicDir: string, dryRun: boolean, pathMod?: typeof path }} input
 * @returns {Command}
 */
export function publishCommand({ wt, node, tag, publicDir, dryRun, pathMod = path.win32 }) {
  return {
    label: dryRun ? 'publish plan (no token, no network)' : 'publish to the public downloads repo',
    file: node,
    args: [
      pathMod.join(wt, 'scripts', 'release', 'publishPublic.js'),
      '--tag',
      tag,
      '--assets-dir',
      publicDir,
      '--notes-from',
      pathMod.join(wt, 'CHANGELOG.md'),
      ...(dryRun ? ['--dry-run'] : []),
    ],
    cwd: wt,
    env: dryRun ? 'clean' : 'publish',
  };
}

/**
 * Checks the output of the publish dry run before the owner is asked: the rendered notes must contain the first
 * line of the hand-written release-notes/<tag>.md when that file exists, and must never be the "no listed changes"
 * fallback (which means publishPublic.js found neither the changelog section nor the curated notes).
 * @param {{ output: string, curated: string | null, tag: string }} input
 * @throws {Error} when the notes are not the ones that should ship
 */
export function assertDryRunNotes({ output, curated, tag }) {
  const norm = (t) => String(t ?? '').replace(/\r\n?/g, '\n');
  const text = norm(output);
  const lines = new Set(text.split('\n').map((l) => l.trim()).filter(Boolean));
  if (typeof curated === 'string') {
    const first = norm(curated).split('\n').map((l) => l.trim()).find(Boolean);
    if (first && !lines.has(first)) {
      throw new Error(`The publish dry run did not render release-notes/${tag}.md (its first line "${first}" is missing from the notes). Nothing was published.`);
    }
  }
  if (text.includes('This release has no listed changes.')) {
    throw new Error(`The publish dry run found no changelog section and no release notes for ${tag} ("This release has no listed changes."). Nothing was published.`);
  }
}

/**
 * The checks record that covers `commit`, from the tag's state or the pending ("next") state, or null.
 * @param {{ commit: string, states: Array<AutoState | null | undefined> }} input
 * @returns {StageRecord | null}
 */
export function checksRecordFor({ commit, states }) {
  for (const st of states) {
    const rec = st?.stages?.checks;
    if (rec && COMMIT_RE.test(String(commit)) && rec.outputs?.commit === commit) return rec;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// release-please output
// ---------------------------------------------------------------------------------------------------------------

/**
 * Reads the version a `release-pr --dry-run` would release. null when it would open no pull request.
 * @param {string} text the dry run's output
 * @returns {{ count: number, version: string | null, title: string | null, body: string }}
 */
export function parseReleasePrDryRun(text) {
  const s = String(text);
  const count = /Would open (\d+) pull requests?/.exec(s);
  if (!count) throw new Error('release-please did not report what it would open; see its output above.');
  const n = Number(count[1]);
  if (n === 0) return { count: 0, version: null, title: null, body: '' };
  const title = /^title:\s*(.+)$/m.exec(s)?.[1]?.trim() ?? null;
  const version = title ? (/release (\d+\.\d+\.\d+)\s*$/.exec(title)?.[1] ?? null) : null;
  if (!version) throw new Error(`release-please would open a pull request but its title does not name a stable version (${title ?? 'no title'}).`);
  const bodyMatch = /^body:\s*([\s\S]*?)^updates:/m.exec(s);
  return { count: n, version, title, body: bodyMatch ? bodyMatch[1].trim() : '' };
}

/**
 * A short changelog summary: the section headings and their bullet lines, at most `max` bullets.
 * @param {string} body
 * @param {number} [max]
 * @returns {string[]}
 */
export function summarizeChangelog(body, max = 30) {
  const out = [];
  let bullets = 0;
  for (const raw of String(body).split(/\r?\n/)) {
    const line = raw.trim();
    if (/^#{2,4}\s/.test(line)) out.push(line.replace(/^#+\s*/, '') + ':');
    else if (/^[*-]\s/.test(line)) {
      bullets += 1;
      if (bullets <= max) out.push(`  ${line}`);
    }
  }
  if (bullets > max) out.push(`  ... and ${bullets - max} more`);
  return out;
}

/**
 * How many releases a `github-release --dry-run` would tag.
 * @param {string} text
 * @returns {number}
 */
export function parseGithubReleaseDryRun(text) {
  const m = /Would tag (\d+) releases?/.exec(String(text));
  if (!m) throw new Error('release-please did not report how many releases it would tag; see its output above.');
  return Number(m[1]);
}

// ---------------------------------------------------------------------------------------------------------------
// Publish confirmation
// ---------------------------------------------------------------------------------------------------------------

/**
 * Decides how the publish is confirmed. Non-interactive needs BOTH --yes and BURROW_RELEASE_CONFIRM equal to the tag;
 * anything else asks the owner to type the tag, which needs a terminal.
 * @param {{ tag: string, yes: boolean, env: Record<string, string | undefined>, isTTY: boolean }} input
 * @returns {'env' | 'prompt'}
 * @throws {Error} when neither way is available
 */
export function publishConfirmationMode({ tag, yes, env, isTTY }) {
  const confirmVar = env.BURROW_RELEASE_CONFIRM;
  if (yes) {
    if (confirmVar === tag) return 'env';
    throw new Error(`--yes publishes without a question only when BURROW_RELEASE_CONFIRM is exactly ${tag}. Nothing was published.`);
  }
  if (!isTTY) throw new Error(`Publishing needs you to type the tag in a terminal (or --yes with BURROW_RELEASE_CONFIRM=${tag}). Nothing was published.`);
  return 'prompt';
}

/**
 * True when the typed answer is exactly the tag (surrounding spaces ignored).
 * @param {string} answer
 * @param {string} tag
 * @returns {boolean}
 */
export function typedTagMatches(answer, tag) {
  return typeof answer === 'string' && STRICT_TAG_RE.test(tag) && answer.trim() === tag;
}

// ---------------------------------------------------------------------------------------------------------------
// Merging pull requests (--merge-pr, --merge-release-pr)
// ---------------------------------------------------------------------------------------------------------------

/** The gh pr view fields the merge decision and the squash message need. */
export const PR_VIEW_FIELDS = 'number,title,body,state,isDraft,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus';

/**
 * Parses the values of --merge-pr (repeatable, each may be a comma-separated list) into unique pull request numbers.
 * @param {string[]} values
 * @returns {number[]}
 */
export function parseMergeNumbers(values) {
  const out = [];
  for (const raw of values) {
    for (const part of String(raw).split(',')) {
      const text = part.trim();
      if (!/^[1-9][0-9]{0,8}$/.test(text)) throw new Error(`--merge-pr needs pull request numbers like 111 or 111,112, got "${text}"`);
      const n = Number(text);
      if (!out.includes(n)) out.push(n);
    }
  }
  return out;
}

/** The gh arguments that read a pull request of the private repo. */
export function prViewArgs(n, fields = PR_VIEW_FIELDS) {
  return ['pr', 'view', String(n), '-R', PRIVATE_REPO, '--json', fields];
}

/**
 * The gh arguments of the squash merge. The subject is the PR title plus " (#N)" like GitHub adds it, the body comes
 * from a file (a release PR body can be longer than a command line allows), and --match-head-commit makes gh refuse
 * when the branch moved after it was read.
 * @param {number} n
 * @param {{ title: string, headOid: string, bodyFile: string }} input
 */
export function prMergeArgs(n, { title, headOid, bodyFile }) {
  return ['pr', 'merge', String(n), '-R', PRIVATE_REPO, '--squash', '--delete-branch', '--match-head-commit', headOid, '--subject', squashSubject(title, n), '--body-file', bodyFile];
}

/** The git arguments that fast-forward the local main after a merge. */
export const PULL_MAIN_ARGS = Object.freeze(['pull', '--ff-only', 'origin', 'main']);

/** @returns {string} the squash commit subject: the PR title with GitHub's " (#N)" suffix */
export function squashSubject(title, n) {
  return `${String(title).trim()} (#${n})`;
}

/** Control characters from a remote title or branch name never reach the terminal. */
export function plainText(value) {
  return Array.from(String(value ?? ''), (ch) => {
    const c = ch.codePointAt(0);
    return c < 0x20 || (c >= 0x7f && c <= 0x9f) ? ' ' : ch;
  })
    .join('')
    .trim();
}

/**
 * Why a pull request must not be merged, or null when it may be. Only an open, non-draft PR into main that GitHub
 * calls MERGEABLE is accepted; anything else is a refusal with a plain message.
 * @param {unknown} pr the parsed gh pr view output
 * @param {number} n the number that was asked for
 * @param {{ releaseVersion?: string | null }} [opts] for the release PR: its title must be exactly the release
 * @returns {string | null}
 */
export function mergeRefusal(pr, n, { releaseVersion = null } = {}) {
  const no = (why) => `Not merging PR #${n}: ${why}. Nothing was merged.`;
  if (pr === null || typeof pr !== 'object') return no('GitHub did not return it');
  if (pr.number !== n) return no(`GitHub answered for PR #${plainText(pr.number)}`);
  if (pr.state !== 'OPEN') return no(`it is not open (state ${plainText(pr.state) || 'unknown'}). If it is already merged, leave this flag out`);
  if (pr.isDraft !== false) return no('it is a draft');
  if (pr.baseRefName !== 'main') return no(`its base is "${plainText(pr.baseRefName)}", not main`);
  if (typeof pr.headRefName !== 'string' || pr.headRefName === '' || pr.headRefName === 'main') return no('its head branch is missing or is main');
  if (pr.mergeable !== 'MERGEABLE') return no(`GitHub says it is ${plainText(pr.mergeable) || 'unknown'}, not MERGEABLE (merge state ${plainText(pr.mergeStateStatus) || 'unknown'})`);
  if (typeof pr.title !== 'string' || plainText(pr.title) === '') return no('it has no title');
  if (!COMMIT_RE.test(String(pr.headRefOid))) return no('its head commit could not be read');
  if (releaseVersion !== null && pr.title !== `chore(main): release ${releaseVersion}`) {
    return no(`its title is "${plainText(pr.title)}", not "chore(main): release ${releaseVersion}"`);
  }
  return null;
}

/**
 * How a merge is confirmed: --yes, or a typed number in a terminal.
 * @param {{ n: number, yes: boolean, isTTY: boolean }} input
 * @returns {'yes' | 'prompt'}
 */
export function mergeConfirmationMode({ n, yes, isTTY }) {
  if (yes) return 'yes';
  if (!isTTY) throw new Error(`Merging PR #${n} needs you to type its number in a terminal (or --yes). Nothing was merged.`);
  return 'prompt';
}

/** True when the typed answer is exactly the PR number (surrounding spaces ignored). */
export function typedNumberMatches(answer, n) {
  return typeof answer === 'string' && Number.isInteger(n) && answer.trim() === String(n);
}

/** What the dry plan shows for one merge: the commands in order. */
export function mergePlanCommands(n) {
  return [
    { file: 'gh', args: prViewArgs(n) },
    { file: 'gh', args: ['pr', 'merge', String(n), '-R', PRIVATE_REPO, '--squash', '--delete-branch', '--match-head-commit', '<head commit>', '--subject', `<PR title> (#${n})`, '--body-file', '<PR body>'] },
    { file: 'git', args: [...PULL_MAIN_ARGS] },
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// State file
// ---------------------------------------------------------------------------------------------------------------

/**
 * @typedef {{ completedAt: string, inputs: Record<string, unknown>, outputs: Record<string, unknown> }} StageRecord
 * @typedef {{ number: number, title: string, sha: string, mergedAt: string }} MergeRecord
 * @typedef {{ version: number, tag: string | null, stages: Record<string, StageRecord>, merges?: Record<string, MergeRecord> }} AutoState
 */

/** @returns {AutoState} */
export function emptyState(tag) {
  return { version: STATE_VERSION, tag: tag ?? null, stages: {} };
}

const SECRETISH_RE = /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/;

/**
 * Reads the state file. A missing, unreadable or foreign file gives an empty state (every stage then re-checks its
 * own outputs, so nothing is skipped on a doubt). A file for another tag is ignored.
 * @param {string} file
 * @param {{ tag: string | null, warn?: (line: string) => void }} opts
 * @returns {AutoState}
 */
export function readState(file, { tag, warn = () => {} }) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') warn(`Could not read ${file}; starting from an empty stage table.`);
    return emptyState(tag);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    warn(`${file} is not valid JSON; starting from an empty stage table.`);
    return emptyState(tag);
  }
  if (json === null || typeof json !== 'object' || json.version !== STATE_VERSION || typeof json.stages !== 'object' || json.stages === null || Array.isArray(json.stages)) {
    warn(`${file} has an unexpected shape; starting from an empty stage table.`);
    return emptyState(tag);
  }
  if ((json.tag ?? null) !== (tag ?? null)) {
    warn(`${file} belongs to ${json.tag ?? 'no tag'}, not ${tag ?? 'the pending release'}; starting from an empty stage table.`);
    return emptyState(tag);
  }
  const stages = {};
  for (const [name, rec] of Object.entries(json.stages)) {
    if (!STAGES.includes(name)) continue;
    if (rec === null || typeof rec !== 'object' || typeof rec.completedAt !== 'string') continue;
    if (typeof rec.inputs !== 'object' || rec.inputs === null || typeof rec.outputs !== 'object' || rec.outputs === null) continue;
    stages[name] = { completedAt: rec.completedAt, inputs: rec.inputs, outputs: rec.outputs };
  }
  const merges = {};
  for (const [key, m] of Object.entries(json.merges !== null && typeof json.merges === 'object' && !Array.isArray(json.merges) ? json.merges : {})) {
    if (m && Number.isInteger(m.number) && String(m.number) === key && typeof m.title === 'string' && COMMIT_RE.test(String(m.sha)) && typeof m.mergedAt === 'string') {
      merges[key] = { number: m.number, title: m.title, sha: m.sha, mergedAt: m.mergedAt };
    }
  }
  return { version: STATE_VERSION, tag: tag ?? null, stages, ...(Object.keys(merges).length ? { merges } : {}) };
}

/**
 * Returns a new state that remembers a merged pull request, so a re-run never merges it again.
 * @param {AutoState} state
 * @param {MergeRecord} merge
 * @returns {AutoState}
 */
export function recordMerge(state, merge) {
  return { ...state, merges: { ...(state.merges ?? {}), [String(merge.number)]: merge } };
}

/**
 * Writes the state atomically (temp file, then rename). Refuses anything that looks like a GitHub token.
 * @param {string} file
 * @param {AutoState} state
 */
export function writeState(file, state) {
  const text = `${JSON.stringify(state, null, 2)}\n`;
  if (SECRETISH_RE.test(text)) throw new Error('Refusing to write a GitHub token into the state file.');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** Stages whose result feeds no later stage: recording them again never drops the later records. */
const INDEPENDENT_STAGES = new Set(['preflight', 'checks']);

/**
 * Returns a new state with the stage recorded. When the stage's inputs or outputs differ from its previous record,
 * every LATER stage is dropped too (their inputs came from the old result); a re-run with the same result keeps them.
 * preflight and checks are independent: a checks run on the tag commit after the builds keeps the build records.
 * @param {AutoState} state
 * @param {string} stage
 * @param {{ inputs: Record<string, unknown>, outputs: Record<string, unknown>, now?: Date }} rec
 * @returns {AutoState}
 */
export function recordStage(state, stage, { inputs, outputs, now = new Date() }) {
  const idx = STAGES.indexOf(stage);
  if (idx < 0) throw new Error(`Unknown stage ${stage}`);
  const prev = state.stages[stage];
  const unchanged = INDEPENDENT_STAGES.has(stage) || (prev !== undefined && sameInputs(prev.inputs, inputs) && sameInputs(prev.outputs, outputs));
  const stages = {};
  for (const name of STAGES) {
    const i = STAGES.indexOf(name);
    if (i === idx) stages[name] = { completedAt: now.toISOString(), inputs, outputs };
    else if (state.stages[name] && (i < idx || unchanged)) stages[name] = state.stages[name];
  }
  return { ...state, stages };
}

/**
 * Stable comparison of two flat-ish JSON values.
 * @returns {boolean}
 */
export function sameInputs(a, b) {
  const canon = (v) => JSON.stringify(v, (_k, val) => (val && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.entries(val).sort(([x], [y]) => (x < y ? -1 : 1))) : val));
  return canon(a) === canon(b);
}

/**
 * Whether a stage can be skipped: it is not the --from stage, a record exists with the same inputs, and its outputs
 * still verify (checked by the caller and passed as `outputsOk`).
 * @param {{ stage: string, forced: string | null, record: StageRecord | undefined, inputs: Record<string, unknown>, outputsOk: boolean }} input
 * @returns {{ skip: boolean, reason: string }}
 */
export function decideStage({ stage, forced, record, inputs, outputsOk }) {
  if (stage === forced) return { skip: false, reason: 'start of this run (--from)' };
  if (!record) return { skip: false, reason: 'not done yet' };
  if (!sameInputs(record.inputs, inputs)) return { skip: false, reason: 'its inputs changed' };
  if (!outputsOk) return { skip: false, reason: 'its outputs changed or are gone' };
  return { skip: true, reason: `done ${record.completedAt}` };
}

/**
 * The first stage of a run: --from, else preflight (each later stage is then skipped when it is still current).
 * @param {string | null} from
 * @returns {string[]} the stages this run walks through, in order
 */
export function stagesForRun(from) {
  return STAGES.slice(from ? STAGES.indexOf(from) : 0);
}

/**
 * The stage table for --status.
 * @param {AutoState} state
 * @param {{ file: string }} opts
 * @returns {string[]}
 */
export function renderStatus(state, { file }) {
  const lines = [`release:auto state for ${state.tag ?? 'the pending release'} (${file})`];
  for (const m of Object.values(state.merges ?? {})) lines.push(`  merged      PR #${m.number} at ${m.sha.slice(0, 7)} (${m.mergedAt})`);
  for (const stage of STAGES) {
    const rec = state.stages[stage];
    const detail = rec ? `done ${rec.completedAt}${describeOutputs(rec.outputs)}` : 'not done';
    lines.push(`  ${stage.padEnd(11)} ${detail}`);
  }
  return lines;
}

function describeOutputs(outputs) {
  const bits = [];
  if (typeof outputs.commit === 'string' && COMMIT_RE.test(outputs.commit)) bits.push(`commit ${outputs.commit.slice(0, 7)}`);
  if (typeof outputs.version === 'string') bits.push(`version ${outputs.version}`);
  if (typeof outputs.pr === 'number') bits.push(`PR #${outputs.pr}`);
  if (typeof outputs.sha256 === 'string' && SHA256_RE.test(outputs.sha256)) bits.push(`sha256 ${outputs.sha256.slice(0, 12)}`);
  if (outputs.files && typeof outputs.files === 'object') bits.push(`${Object.keys(outputs.files).length} staged files`);
  return bits.length ? ` (${bits.join(', ')})` : '';
}

/**
 * The owner-only steps after the publish, as printable lines. When nothing was published yet, only the next command
 * (the publish) is printed, with a warning not to start the post-publish steps.
 * @param {{ tag: string, privacyChanged: boolean | null, outDir: string, published: boolean }} input
 * @returns {string[]}
 */
export function afterSteps({ tag, privacyChanged, outDir, published }) {
  if (published !== true) {
    return [
      `${tag} is not published yet. Next, when you are ready to publish:`,
      `  npm.cmd run release:auto -- --tag ${tag} --from publish --publish`,
      'Do not run release:gumroad --publish and do not remove the release worktrees yet: the publish needs them, and the Gumroad pages must not announce a version that is not downloadable.',
    ];
  }
  const lines = [
    `Remaining owner steps for ${tag}:`,
    '  1. Check both downloads and their hashes:',
    '       https://github.com/ChristianMunoz31/burrow-releases/releases/latest/download/Burrow-Setup-x64.exe',
    '       https://github.com/ChristianMunoz31/burrow-releases/releases/latest/download/Burrow-Setup-arm64.exe',
    '       Get-FileHash -Algorithm SHA256 <file>   (compare with SHA256SUMS.txt)',
    '  2. Optional, only while you keep the Gumroad pages up to date (Burrow is free for everyone, so skip this otherwise). Gumroad pages (dry run, then publish and answer y):',
    `       npm.cmd run release:gumroad -- --tag ${tag}`,
    `       npm.cmd run release:gumroad -- --tag ${tag} --publish`,
  ];
  if (privacyChanged === true) {
    lines.push(
      '  3. config/privacy.json changed since the last tag: re-publish the privacy page (scripts/privacy/README.md, "To update later"):',
      '       npm.cmd run privacy:render   (then commit, and copy pages/ to the gh-pages branch of burrow-releases)',
    );
  } else if (privacyChanged === null) {
    lines.push('  3. Could not tell whether config/privacy.json changed since the last tag; check it, and re-publish the privacy page if it did (scripts/privacy/README.md).');
  } else {
    lines.push('  3. Privacy page: config/privacy.json did not change since the last tag, nothing to re-publish.');
  }
  lines.push(
    '  4. Microsoft Store package (upload by hand in Partner Center):',
    '       npm.cmd run release:store -- --check',
    '       npm.cmd run release:store',
    '       npm.cmd run desktop:sidecar   (before direct dev work again)',
    '  5. Store and Gumroad screenshots when the UI changed:',
    '       npm.cmd run store:screenshots',
    '  6. Install the arm64 installer on this PC once, and the x64 one on an Intel or AMD PC if you have one.',
    `  7. When done, remove the release worktrees: git worktree remove "${path.win32.join(outDir, 'wt-x64')}"; git worktree remove "${path.win32.join(outDir, 'wt-arm64')}"`,
    '  Do not re-run the Release workflow jobs that queued on the merge.',
  );
  return lines;
}
