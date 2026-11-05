// Whole-release mode (repository variable RELEASE_RUNNER=self-hosted): every job of the release path may run on the
// owner's self-hosted Windows ARM64 runner. These static checks keep that mode opt-in and locked to trusted events,
// and run the real guard step under bash with a fake `gh` (skipped when bash is missing). docs/SELF_HOSTED_RUNNER.md.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasAllPrivateFiles, readPrivateFile } from './helpers/privateFiles.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const read = (name) => readPrivateFile(`.github/workflows/${name}`);
// The release workflows and scripts/runner are private-only (left out of the public core export): the whole file is skipped without them.
const HAS_RELEASE_INFRA = hasAllPrivateFiles(
  '.github/workflows/release-please.yml',
  '.github/workflows/release.yml',
  '.github/workflows/desktop-windows.yml',
  'scripts/runner/setup-runner.ps1',
  'scripts/runner/job-started.ps1',
  'scripts/runner/install-node.sh',
  'scripts/runner/install-rust.sh',
);

const RUNS_ON =
  "runs-on: ${{ vars.RELEASE_RUNNER == 'self-hosted' && fromJSON('[\"self-hosted\",\"Windows\",\"ARM64\",\"burrow\"]') || 'ubuntu-latest' }}";
const GUARD_NAME = 'Refuse untrusted events on a self-hosted runner';
const ISOLATE_NAME = 'Isolate the job from the runner profile (self-hosted only)';
const DRY_RUN_NAME = 'Refuse a branch dry run on a self-hosted runner';
const NODE_NAME = 'Install the pinned Node (self-hosted only)';
const CLEANUP_NAME = 'Remove the build outputs (self-hosted only)';
const ON_PC = "if: ${{ runner.environment != 'github-hosted' }}";
const ON_HOSTED = "if: ${{ runner.environment == 'github-hosted' }}";

/** Release-path jobs that run on a runner (jobs that call a reusable workflow have no runs-on). */
const RELEASE_JOBS = {
  'release-please.yml': ['release-please', 'release-pr'],
  'release.yml': ['assets', 'plan', 'stage', 'cleanup-staging'],
  'desktop-windows.yml': ['pick-runner', 'windows'],
};
/** Manual-only macOS/Linux jobs of release.yml: not on the release path, always hosted. */
const HOSTED_ONLY = { 'release.yml': ['plan-desktop', 'desktop'] };
/** Always hosted, and skipped in whole-release mode so RELEASES_TOKEN never reaches the PC. */
const SKIPPED_ON_PC = { 'release.yml': ['publish-public'] };
/** Jobs that check the repo out (and so must clean up after themselves on the PC). */
const CHECKOUT_JOBS = { 'release.yml': ['assets'], 'desktop-windows.yml': ['windows'] };

const withoutComments = (text) =>
  text
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

/** Top-level jobs of a workflow as { name: text }, comments removed. */
function jobsOf(text) {
  const code = withoutComments(text);
  const body = code.slice(code.indexOf('\njobs:\n') + '\njobs:\n'.length);
  const jobs = {};
  const parts = body.split(/\n(?= {2}[A-Za-z0-9_-]+:\s*$)/m);
  for (const part of parts) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/m.exec(part);
    if (m && part.trimStart().startsWith(`${m[1]}:`)) jobs[m[1]] = part;
  }
  return jobs;
}

/** Steps of a job (each starts with `- ` at the step indent). */
const stepsOf = (job) => job.split(/\n(?= {6}- )/).slice(1);
const stepName = (step) => /^ {6}- name: (.*)$/m.exec(step)?.[1]?.trim();

/** The literal `run: |` body of a step, dedented. */
function runBody(step) {
  const lines = step.split('\n');
  const at = lines.findIndex((l) => /^\s*run: \|\s*$/.test(l));
  if (at === -1) return null;
  const indent = lines[at].length - lines[at].trimStart().length;
  const body = [];
  for (let i = at + 1; i < lines.length; i += 1) {
    if (lines[i].trim() !== '' && lines[i].length - lines[i].trimStart().length <= indent) break;
    body.push(lines[i]);
  }
  return body.join('\n');
}

/** Trigger names under `on:`. */
function triggersOf(text) {
  const lines = withoutComments(text).split('\n');
  const at = lines.findIndex((l) => /^on:\s*$/.test(l));
  const keys = [];
  for (let i = at + 1; i < lines.length && (lines[i] === '' || /^\s/.test(lines[i])); i += 1) {
    const m = /^ {2}([a-z_]+):/.exec(lines[i]);
    if (m) keys.push(m[1]);
  }
  return keys;
}

const files = Object.fromEntries(Object.keys(RELEASE_JOBS).map((name) => [name, read(name)]));

describe.skipIf(!HAS_RELEASE_INFRA)('whole-release mode: runners', () => {
  it.each(Object.entries(RELEASE_JOBS))('%s: every release-path job picks its runner from vars.RELEASE_RUNNER', (name, jobNames) => {
    const jobs = jobsOf(files[name]);
    for (const job of jobNames) {
      expect(jobs[job], `${name} ${job}`).toBeTruthy();
      if (name === 'desktop-windows.yml' && job === 'windows') continue;
      expect(jobs[job], `${name} ${job}`).toContain(`\n    ${RUNS_ON}\n`);
    }
  });

  it('desktop-windows: the windows matrix takes both runners from pick-runner, which reads vars.RELEASE_RUNNER', () => {
    const jobs = jobsOf(files['desktop-windows.yml']);
    expect(jobs.windows).toContain('runs-on: ${{ fromJSON(matrix.runs_on) }}');
    expect(jobs.windows).toContain('runs_on: ${{ needs.pick-runner.outputs.x64_runs_on }}');
    expect(jobs.windows).toContain('runs_on: ${{ needs.pick-runner.outputs.arm64_runs_on }}');
    expect(jobs.windows).toContain('cross: ${{ needs.pick-runner.outputs.x64_cross }}');
    expect(jobs.windows).toContain('needs: pick-runner');
    expect(jobs['pick-runner']).toContain('RELEASE_RUNNER: ${{ vars.RELEASE_RUNNER }}');
  });

  it('every job in the three files is either on the release path or a manual hosted-only job; no job is left out', () => {
    for (const [name, text] of Object.entries(files)) {
      const jobs = jobsOf(text);
      const known = new Set([...(RELEASE_JOBS[name] ?? []), ...(HOSTED_ONLY[name] ?? []), ...(SKIPPED_ON_PC[name] ?? [])]);
      for (const [job, body] of Object.entries(jobs)) {
        if (/\n {4}uses: \.\/\.github\/workflows\//.test(body)) continue;
        expect(known.has(job), `${name} ${job} is not classified`).toBe(true);
      }
      for (const job of HOSTED_ONLY[name] ?? []) {
        expect(jobs[job], job).toBeTruthy();
        expect(jobs[job], job).not.toMatch(/RELEASE_RUNNER|self-hosted/);
      }
    }
  });

  it('publish-public never runs on the PC: hosted runner, and skipped when RELEASE_RUNNER is self-hosted', () => {
    const job = jobsOf(files['release.yml'])['publish-public'];
    expect(job).toContain('\n    runs-on: ubuntu-latest\n');
    expect(job).toMatch(/\n {4}if: \$\{\{ !cancelled\(\) && vars\.RELEASE_RUNNER != 'self-hosted' && /);
    expect(job).not.toContain('fromJSON');
    expect(job).not.toContain('"self-hosted"');
    // The public-repo token is read in this job only.
    const code = withoutComments(files['release.yml']);
    const others = code.replace(job, '');
    expect(others).not.toContain('secrets.RELEASES_TOKEN');
    expect(job).toContain('GH_TOKEN: ${{ secrets.RELEASES_TOKEN }}');
  });

  it('no other workflow reads RELEASE_RUNNER (PR CI and the dev build stay hosted)', () => {
    const others = fs.readdirSync(path.join(ROOT, '.github', 'workflows')).filter((n) => n.endsWith('.yml') && !(n in files));
    expect(others.length).toBeGreaterThan(0);
    for (const name of others) expect(withoutComments(read(name)), name).not.toContain('RELEASE_RUNNER');
  });
});

describe.skipIf(!HAS_RELEASE_INFRA)('whole-release mode: triggers and the guard step', () => {
  it('the release workflows never trigger on pull_request or pull_request_target', () => {
    expect(triggersOf(files['release-please.yml']).sort()).toEqual(['push', 'schedule', 'workflow_dispatch']);
    expect(files['release-please.yml']).toMatch(/\non:\n {2}push:\n {4}branches: \[main\]\n/);
    expect(triggersOf(files['release.yml']).sort()).toEqual(['push', 'workflow_call', 'workflow_dispatch']);
    expect(triggersOf(files['desktop-windows.yml'])).toEqual(['workflow_call']);
    for (const text of Object.values(files)) expect(withoutComments(text)).not.toMatch(/pull_request/);
  });

  const guards = [];
  for (const [name, jobNames] of Object.entries(RELEASE_JOBS)) {
    const jobs = jobsOf(files[name]);
    for (const job of jobNames) guards.push([name, job, jobs[job]]);
  }

  it.each(guards)('%s %s: the first step is the guard, before any checkout', (name, job, body) => {
    const steps = stepsOf(body);
    expect(stepName(steps[0]), `${name} ${job}`).toBe(GUARD_NAME);
    expect(steps.filter((s) => stepName(s) === GUARD_NAME)).toHaveLength(1);
  });

  it('the guard step is byte-identical in every release-path job', () => {
    const texts = new Set(guards.map(([, , body]) => stepsOf(body)[0]));
    expect(texts.size).toBe(1);
    const guard = [...texts][0];
    expect(guard).toContain('shell: bash');
    expect(guard).toContain('RUNNER_KIND: ${{ runner.environment }}');
    expect(guard).toContain('TRIGGERING_ACTOR: ${{ github.triggering_actor }}');
    expect(guard).toContain('REPO_OWNER: ${{ github.repository_owner }}');
    // Untrusted values only through env, never interpolated into the script.
    expect(runBody(guard)).not.toContain('${{');
  });

  it('jobs that check the repo out clean the workspace first and remove the build outputs at the end on the PC', () => {
    for (const [name, jobNames] of Object.entries(CHECKOUT_JOBS)) {
      const jobs = jobsOf(files[name]);
      for (const job of jobNames) {
        const steps = stepsOf(jobs[job]);
        const checkouts = steps.filter((s) => s.includes('uses: actions/checkout@'));
        expect(checkouts.length, `${name} ${job}`).toBeGreaterThan(0);
        for (const c of checkouts) {
          expect(c).toContain('persist-credentials: false');
          expect(c).toContain('clean: true');
        }
        const last = steps[steps.length - 1];
        expect(stepName(last), `${name} ${job}`).toBe(CLEANUP_NAME);
        expect(last).toContain("if: ${{ always() && runner.environment != 'github-hosted' }}");
        expect(last).toContain('continue-on-error: true');
        expect(last).toContain('rd /s /q');
      }
    }
  });

  it.each(guards)('%s %s: the second step isolates the profile on the PC, before any checkout', (name, job, body) => {
    const steps = stepsOf(body);
    expect(stepName(steps[1]), `${name} ${job}`).toBe(ISOLATE_NAME);
    expect(steps[1]).toContain(ON_PC);
    const checkout = steps.findIndex((s) => s.includes('uses: actions/checkout@'));
    if (checkout !== -1) expect(checkout).toBeGreaterThan(1);
  });

  it('the isolation step is byte-identical in every release-path job and covers every profile, config and cache', () => {
    const texts = new Set(guards.map(([, , body]) => stepsOf(body)[1]));
    expect(texts.size).toBe(1);
    const body = runBody([...texts][0]);
    for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'npm_config_userconfig', 'npm_config_cache', 'npm_config_globalconfig', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'CARGO_HOME', 'RUSTUP_HOME']) {
      expect(body, key).toContain(`echo "${key}=`);
    }
  });

  it('no setup-node runs on the PC and no step overrides RUNNER_TOOL_CACHE (the runner resets it)', () => {
    let count = 0;
    for (const [name, text] of Object.entries(files)) expect(text, name).not.toContain('RUNNER_TOOL_CACHE');
    for (const [name, jobNames] of Object.entries(RELEASE_JOBS)) {
      const jobs = jobsOf(files[name]);
      for (const job of jobNames) {
        const steps = stepsOf(jobs[job]);
        const setup = steps.filter((s) => s.includes('uses: actions/setup-node@'));
        for (const step of setup) {
          count += 1;
          expect(step, `${name} ${job}`).toContain(ON_HOSTED);
          expect(step, `${name} ${job}`).toContain('node-version: 24');
        }
        if (setup.length > 0) {
          const node = steps.find((s) => stepName(s) === NODE_NAME);
          expect(node, `${name} ${job}`).toBeTruthy();
          expect(node).toContain(ON_PC);
          expect(node).toContain('run: bash scripts/runner/install-node.sh');
          expect(steps.indexOf(node)).toBe(steps.indexOf(setup[0]) + 1);
        }
      }
    }
    expect(count).toBe(2);
  });

  it('Rust: the hosted install step is unchanged and hosted-only; on the PC Rust is installed fresh per job', () => {
    const steps = stepsOf(jobsOf(files['desktop-windows.yml']).windows);
    const hosted = steps.find((s) => stepName(s) === 'Install Rust (stable)');
    const pc = steps.find((s) => stepName(s) === 'Install Rust (self-hosted only)');
    expect(hosted).toContain(ON_HOSTED);
    expect(hosted).not.toContain('CROSS');
    expect(pc).toContain(ON_PC);
    expect(pc).toContain('run: bash scripts/runner/install-rust.sh');
    expect(steps.indexOf(pc)).toBeLessThan(steps.findIndex((s) => stepName(s) === 'Assert the runner architecture'));
  });

  it('a dry run on the PC may only build main: the same check in plan and assets, before the checkout', () => {
    const jobs = jobsOf(files['release.yml']);
    const texts = [];
    for (const job of ['plan', 'assets']) {
      const steps = stepsOf(jobs[job]);
      const at = steps.findIndex((s) => stepName(s) === DRY_RUN_NAME);
      expect(at, job).toBeGreaterThan(1);
      expect(steps[at]).toContain(ON_PC);
      const checkout = steps.findIndex((s) => s.includes('uses: actions/checkout@'));
      if (checkout !== -1) expect(at).toBeLessThan(checkout);
      if (job === 'plan') expect(at).toBeLessThan(steps.findIndex((s) => s.includes('id: plan')));
      texts.push(steps[at]);
    }
    expect(texts[0]).toBe(texts[1]);
    expect(texts[0]).toContain('SOURCE_REF: ${{ inputs.source_ref }}');
  });

  it('every action in the release workflows is pinned by a full commit SHA', () => {
    for (const [name, text] of Object.entries(files)) {
      for (const line of text.split(/\r?\n/).filter((l) => /^\s*(?:- )?uses:/.test(l))) {
        if (/uses:\s*\.\//.test(line)) continue;
        expect(line, name).toMatch(/uses:\s*[\w.-]+\/[\w./-]+@[0-9a-f]{40}\s+# v\d+(\.\d+)*/);
      }
    }
  });
});

describe.skipIf(!HAS_RELEASE_INFRA)('whole-release mode: the x64 cross-build', () => {
  const win = jobsOf(files['desktop-windows.yml']).windows;
  const step = (name) => stepsOf(win).find((s) => stepName(s) === name);

  it('targets x64 only when pick-runner says cross, and otherwise builds exactly as before', () => {
    expect(win).toContain("INSTALLER_TARGET: ${{ matrix.cross == 'true' && matrix.triple || '' }}");
    expect(win).toMatch(/- arch: arm64\n(?: {12}.*\n)*? {12}cross: 'false'\n/);
    expect(step('Compile installer')).toContain('run: node scripts/release/buildInstaller.js --phase build ${INSTALLER_TARGET:+--target "$INSTALLER_TARGET"}');
    expect(step('Bundle and sign installer')).toContain('run: node scripts/release/buildInstaller.js --phase bundle ${INSTALLER_TARGET:+--target "$INSTALLER_TARGET"}');
  });

  it('injects the pinned official x64 node.exe (storeNode.mjs) and keeps the native path on npm run desktop:sidecar', () => {
    const body = runBody(step('Build sidecar'));
    expect(body).toContain('npm run desktop:sidecar');
    expect(body).toContain('ensureX64Node');
    expect(body).toContain("scripts/release/storeNode.mjs");
    expect(body).toContain('--node-binary "$x64_node" --out-triple "$TRIPLE"');
    expect(body).toContain('--channel stable');
    // The arm64 node that builds the blob is installed from config/store-node.json, the pin file of the x64 node.exe.
    expect(step('Pick the Node version')).toBeUndefined();
    expect(step('Install the pinned Node (self-hosted only)')).toContain('bash scripts/runner/install-node.sh');
    expect(fs.readFileSync(path.join(ROOT, 'scripts', 'runner', 'install-node.sh'), 'utf8')).toContain('config/store-node.json');
  });

  it('the smoke test still runs on the cross-built sidecar (blocking) and the architecture check knows the host', () => {
    expect(runBody(step('Smoke test the sidecar (blocking)'))).toContain('burrow-server-${TRIPLE}.exe');
    expect(step('Smoke test the sidecar (blocking)')).not.toContain('continue-on-error');
    expect(runBody(step('Assert the runner architecture'))).toContain('want_host=aarch64-pc-windows-msvc; want_node=arm64');
  });
});

const bashOk = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' }).stdout?.trim() === 'ok';

describe.skipIf(!HAS_RELEASE_INFRA || !bashOk)('the guard script (real bash, fake gh)', () => {
  const script = HAS_RELEASE_INFRA ? runBody(stepsOf(jobsOf(files['release.yml']).assets)[0]) : '';
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-guard-'));
    fs.writeFileSync(path.join(dir, 'gh'), ['#!/bin/bash', 'echo "gh:$GH_TOKEN" >> "$FAKE_LOG"', 'echo "${FAKE_PRIVATE-true}"', ''].join('\n'), { mode: 0o755 });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function run(env) {
    const log = path.join(dir, 'log.txt');
    fs.writeFileSync(log, '');
    const res = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: {
        PATH: `${dir}${path.delimiter}${process.env.PATH}`,
        FAKE_LOG: log.replaceAll('\\', '/'),
        RUNNER_KIND: 'self-hosted',
        EVENT_NAME: 'push',
        GIT_REF: 'refs/heads/main',
        ACTOR: 'owner',
        TRIGGERING_ACTOR: 'owner',
        REPO_OWNER: 'owner',
        GH_TOKEN: 'job-token',
        GH_REPO: 'owner/repo',
        ...env,
      },
    });
    return { status: res.status, out: `${res.stdout}${res.stderr}`, log: fs.readFileSync(log, 'utf8') };
  }

  it('does nothing on a GitHub-hosted runner, whatever the event', () => {
    const r = run({ RUNNER_KIND: 'github-hosted', EVENT_NAME: 'pull_request_target', ACTOR: 'stranger' });
    expect(r.status).toBe(0);
    expect(r.log).toBe('');
  });

  it.each([
    ['a push to main by the owner', {}],
    ['a v* tag push by the owner', { GIT_REF: 'refs/tags/v1.2.3' }],
    ['a schedule on main', { EVENT_NAME: 'schedule', ACTOR: 'someone', TRIGGERING_ACTOR: 'someone' }],
    ['a schedule on main re-run by the owner', { EVENT_NAME: 'schedule', ACTOR: 'someone', TRIGGERING_ACTOR: 'owner' }],
    ['a manual dispatch from main by the owner', { EVENT_NAME: 'workflow_dispatch' }],
  ])('allows %s on the PC (private repo)', (_label, env) => {
    const r = run(env);
    expect(r.status, r.out).toBe(0);
    expect(r.log).toContain('gh:job-token');
  });

  it.each([
    ['pull_request', { EVENT_NAME: 'pull_request' }],
    ['pull_request_target', { EVENT_NAME: 'pull_request_target' }],
    ['workflow_run', { EVENT_NAME: 'workflow_run' }],
    ['issue_comment', { EVENT_NAME: 'issue_comment' }],
    ['a push to another branch', { GIT_REF: 'refs/heads/feat/x' }],
    ['a push of a non-v tag', { GIT_REF: 'refs/tags/x1' }],
    ['a push by someone else', { ACTOR: 'collaborator', TRIGGERING_ACTOR: 'collaborator' }],
    ['a re-run of a push by someone else', { TRIGGERING_ACTOR: 'collaborator' }],
    ['a dispatch by someone else', { EVENT_NAME: 'workflow_dispatch', ACTOR: 'collaborator', TRIGGERING_ACTOR: 'collaborator' }],
    ['a dispatch re-run by someone else', { EVENT_NAME: 'workflow_dispatch', TRIGGERING_ACTOR: 'collaborator' }],
    ['a schedule off main', { EVENT_NAME: 'schedule', GIT_REF: 'refs/heads/feat/x' }],
    ['a schedule re-run by someone else', { EVENT_NAME: 'schedule', ACTOR: 'owner', TRIGGERING_ACTOR: 'collaborator' }],
    ['a schedule with no triggering actor', { EVENT_NAME: 'schedule', ACTOR: '', TRIGGERING_ACTOR: '' }],
    ['a dispatch from another branch by the owner', { EVENT_NAME: 'workflow_dispatch', GIT_REF: 'refs/heads/feat/x' }],
    ['a dispatch from a tag by the owner', { EVENT_NAME: 'workflow_dispatch', GIT_REF: 'refs/tags/v1.2.3' }],
    ['a public repository', { FAKE_PRIVATE: 'false' }],
    ['an unreadable visibility', { FAKE_PRIVATE: '' }],
    ['an unknown runner kind with a pull_request event', { RUNNER_KIND: '', EVENT_NAME: 'pull_request' }],
  ])('refuses %s on the PC', (_label, env) => {
    const r = run(env);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('Refused on the self-hosted runner');
  });
});

/** Writes executable fake commands into a folder (a bash script each). */
function fakeBin(dir, scripts) {
  for (const [name, body] of Object.entries(scripts)) fs.writeFileSync(path.join(dir, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
}
const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');

describe.skipIf(!HAS_RELEASE_INFRA || !bashOk)('self-hosted job steps (real bash)', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-pc-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const envOf = (file) =>
    Object.fromEntries(
      fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );

  it('the isolation step points every profile, config and cache variable into RUNNER_TEMP and refuses a reused folder', () => {
    const script = HAS_RELEASE_INFRA ? runBody(stepsOf(jobsOf(files['release.yml']).assets)[1]) : '';
    const temp = path.join(dir, 'temp');
    fs.mkdirSync(temp);
    const githubEnv = path.join(dir, 'env');
    fs.writeFileSync(githubEnv, '');
    const run = () => spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH, RUNNER_TEMP: temp, GITHUB_ENV: githubEnv } });
    const res = run();
    expect(res.status, res.stderr).toBe(0);
    const vars = envOf(githubEnv);
    const root = path.join(temp, 'burrow-job');
    for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'npm_config_cache', 'GH_CONFIG_DIR', 'CARGO_HOME', 'RUSTUP_HOME']) {
      expect(vars[key], key).toMatch(new RegExp(`^${root.replaceAll('\\', '\\\\')}/`));
      expect(fs.statSync(vars[key]).isDirectory(), key).toBe(true);
    }
    for (const key of ['npm_config_userconfig', 'npm_config_globalconfig', 'GIT_CONFIG_GLOBAL']) {
      expect(vars[key], key).toMatch(new RegExp(`^${root.replaceAll('\\', '\\\\')}/`));
      expect(fs.readFileSync(vars[key], 'utf8'), key).toBe('');
    }
    expect(vars.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(run().status).toBe(1);
  });

  it.each([
    ['', 0],
    ['main', 0],
    ['feat/x', 1],
    ['refs/heads/main', 1],
    ['main2', 1],
  ])('the dry-run step with source_ref "%s" exits %i', (ref, status) => {
    const script = HAS_RELEASE_INFRA ? runBody(stepsOf(jobsOf(files['release.yml']).plan).find((st) => stepName(st) === DRY_RUN_NAME)) : '';
    const res = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH, SOURCE_REF: ref } });
    expect(res.status, res.stdout).toBe(status);
  });

  describe('install-node.sh', () => {
    const VERSION = 'v24.15.0';
    const ZIP = `node-${VERSION}-win-arm64.zip`;
    const zipBytes = 'fake zip bytes';
    const x64Pin = 'a'.repeat(64);
    const script = path.join(ROOT, 'scripts', 'runner', 'install-node.sh');

    function setup({ cfg, sums, zip = zipBytes, nodeVersion = VERSION, nodeArch = 'arm64' } = {}) {
      const bin = path.join(dir, 'bin');
      fs.mkdirSync(bin);
      const files = path.join(dir, 'served');
      fs.mkdirSync(files);
      fs.writeFileSync(path.join(files, 'SHASUMS256.txt'), sums ?? `${sha256Hex(zipBytes)}  ${ZIP}\n${x64Pin}  win-x64/node.exe\n`);
      fs.writeFileSync(path.join(files, ZIP), zip);
      // curl -o <file> <url>: serves the file named by the URL's last part; logs every URL and flag.
      fakeBin(bin, {
        curl: 'out=""; url=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; https://*) url="$1" ;; esac; shift; done\necho "$url" >> "$FAKE_LOG"\ncp "$FAKE_FILES/${url##*/}" "$out"',
        tar: `while [ $# -gt 0 ]; do case "$1" in -C) dest="$2"; shift ;; esac; shift; done\nmkdir -p "$dest/node-${VERSION}-win-arm64"\nprintf '#!/bin/bash\\nif [ "$1" = --version ]; then echo ${nodeVersion}; else echo ${nodeArch}; fi\\n' > "$dest/node-${VERSION}-win-arm64/node.exe"\nchmod +x "$dest/node-${VERSION}-win-arm64/node.exe"`,
      });
      const cfgFile = path.join(dir, 'store-node.json');
      fs.writeFileSync(
        cfgFile,
        cfg ?? JSON.stringify({ _help: 'x ("pins") and ("arm64ZipPins")', pins: { 'v22.1.0': 'b'.repeat(64), [VERSION]: x64Pin }, arm64ZipPins: { [VERSION]: sha256Hex(zipBytes), 'v24.99.0': 'c'.repeat(64) } }, null, 2),
      );
      const temp = path.join(dir, 'temp');
      fs.mkdirSync(temp);
      const log = path.join(dir, 'log');
      const githubPath = path.join(dir, 'path');
      fs.writeFileSync(log, '');
      fs.writeFileSync(githubPath, '');
      const res = spawnSync('bash', [script, cfgFile], {
        encoding: 'utf8',
        env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, RUNNER_TEMP: temp, GITHUB_PATH: githubPath, FAKE_LOG: log, FAKE_FILES: files },
      });
      return { status: res.status, out: `${res.stdout}${res.stderr}`, urls: fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean), path: fs.readFileSync(githubPath, 'utf8') };
    }

    it('installs the newest version pinned for both architectures, after checking both pins against SHASUMS256.txt', () => {
      const r = setup();
      expect(r.status, r.out).toBe(0);
      expect(r.urls).toEqual([`https://nodejs.org/dist/${VERSION}/SHASUMS256.txt`, `https://nodejs.org/dist/${VERSION}/${ZIP}`]);
      expect(r.path.trim()).toBe(path.join(dir, 'temp', 'burrow-node', `node-${VERSION}-win-arm64`));
    });

    it('never follows redirects and only talks https', () => {
      const text = fs.readFileSync(script, 'utf8');
      expect(text).toContain("curl -fsS --proto '=https' --tlsv1.2 --max-redirs 0");
      expect(text).not.toMatch(/curl[^\n]*(-L|--location)\b/);
    });

    it.each([
      ['the arm64 pin is not what nodejs.org lists', { sums: `${'d'.repeat(64)}  ${ZIP}\n${'a'.repeat(64)}  win-x64/node.exe\n` }, 1],
      ['the x64 pin is not what nodejs.org lists', { sums: `${sha256Hex(zipBytes)}  ${ZIP}\n${'e'.repeat(64)}  win-x64/node.exe\n` }, 1],
    ])('refuses before downloading when %s', (_label, opts, urls) => {
      const r = setup(opts);
      expect(r.status, r.out).toBe(1);
      expect(r.out).toContain('Node install refused');
      expect(r.urls).toHaveLength(urls);
      expect(r.path).toBe('');
    });

    it('refuses a download that does not match the pin, a wrong version and a wrong architecture', () => {
      for (const opts of [{ zip: 'tampered' }, { nodeVersion: 'v24.14.0' }, { nodeArch: 'x64' }]) {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir);
        const r = setup(opts);
        expect(r.status, JSON.stringify(opts)).toBe(1);
        expect(r.path).toBe('');
      }
    });

    it('refuses a pin file with no version pinned for both architectures', () => {
      const r = setup({ cfg: JSON.stringify({ pins: { 'v22.1.0': 'b'.repeat(64) }, arm64ZipPins: { [VERSION]: 'c'.repeat(64) } }, null, 2) });
      expect(r.status).toBe(1);
      expect(r.urls).toHaveLength(0);
    });

    it('the committed pins give one version for both architectures, the one storeNode.mjs picks, with the verified hashes', async () => {
      const { readArm64ZipPins, readNodePins, runnerNodeVersion } = await import('../../scripts/release/storeNode.mjs');
      const x64 = readNodePins(ROOT);
      const arm64 = readArm64ZipPins(ROOT);
      expect(Object.keys(arm64).sort()).toEqual(Object.keys(x64).sort());
      expect(runnerNodeVersion(ROOT)).toBe('v24.15.0');
      expect(arm64['v24.15.0']).toBe('c9eb7402eda26e2ba7e44b6727fc85a8de56c5095b1f71ebd3062892211aa116');
      // The bash reader picks the same version from the real file.
      const r = setup({ cfg: fs.readFileSync(path.join(ROOT, 'config', 'store-node.json'), 'utf8'), sums: `${arm64['v24.15.0']}  ${ZIP}\n${x64['v24.15.0']}  win-x64/node.exe\n` });
      expect(r.urls[0]).toBe('https://nodejs.org/dist/v24.15.0/SHASUMS256.txt');
    });
  });

  describe('install-rust.sh', () => {
    const script = path.join(ROOT, 'scripts', 'runner', 'install-rust.sh');
    const pin = /^RUSTUP_INIT_SHA256=([0-9a-f]{64})$/m.exec(readPrivateFile('scripts/runner/install-rust.sh'))?.[1];

    function setup({ published = pin, exeMatches = true, cargoLeftover = false } = {}) {
      const bin = path.join(dir, 'bin');
      fs.mkdirSync(bin);
      const temp = path.join(dir, 'temp');
      const cargo = path.join(temp, 'burrow-job', 'cargo');
      const rustup = path.join(temp, 'burrow-job', 'rustup');
      fs.mkdirSync(cargo, { recursive: true });
      fs.mkdirSync(rustup, { recursive: true });
      if (cargoLeftover) fs.writeFileSync(path.join(cargo, 'planted'), 'x');
      // rustup-init.exe is "downloaded" as a script; its sha256 is made to equal the pin by faking sha256sum.
      fakeBin(bin, {
        curl: `out=""; url=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; https://*) url="$1" ;; esac; shift; done\necho "$url" >> "$FAKE_LOG"\ncase "$url" in *.sha256) echo "${published}  rustup-init.exe" > "$out" ;; *) printf '#!/bin/bash\\necho "$*" > "$FAKE_ARGS"\\nmkdir -p "$CARGO_HOME/bin"\\nprintf "#!/bin/bash\\\\necho host: aarch64-pc-windows-msvc\\\\n" > "$CARGO_HOME/bin/rustc"\\nchmod +x "$CARGO_HOME/bin/rustc"\\n' > "$out" ;; esac`,
        sha256sum: `echo "${exeMatches ? pin : 'f'.repeat(64)}  -"`,
      });
      const log = path.join(dir, 'log');
      const args = path.join(dir, 'args');
      const githubPath = path.join(dir, 'path');
      for (const f of [log, args, githubPath]) fs.writeFileSync(f, '');
      const res = spawnSync('bash', [script], {
        encoding: 'utf8',
        env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, RUNNER_TEMP: temp, CARGO_HOME: cargo, RUSTUP_HOME: rustup, GITHUB_PATH: githubPath, FAKE_LOG: log, FAKE_ARGS: args },
      });
      return { status: res.status, out: `${res.stdout}${res.stderr}`, urls: fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean), args: fs.readFileSync(args, 'utf8'), path: fs.readFileSync(githubPath, 'utf8'), cargo };
    }

    it('pins a versioned rustup-init by sha256', () => {
      expect(pin).toBe('01aa49cf9574a8bd0ae52005d7de2590e8f27181ded6748236e702c92aef826d');
      expect(fs.readFileSync(script, 'utf8')).toMatch(/^RUSTUP_VERSION=1\.29\.1$/m);
    });

    it('installs into the per-job CARGO_HOME with both Windows targets and puts it first on PATH', () => {
      const r = setup();
      expect(r.status, r.out).toBe(0);
      expect(r.urls).toEqual([
        'https://static.rust-lang.org/rustup/archive/1.29.1/aarch64-pc-windows-msvc/rustup-init.exe.sha256',
        'https://static.rust-lang.org/rustup/archive/1.29.1/aarch64-pc-windows-msvc/rustup-init.exe',
      ]);
      expect(r.args).toContain('--no-modify-path');
      expect(r.args).toContain('--target aarch64-pc-windows-msvc --target x86_64-pc-windows-msvc');
      expect(r.path.trim()).toBe(`${r.cargo}/bin`);
    });

    it.each([
      ['the published sha256 is not the pin', { published: 'e'.repeat(64) }, 1],
      ['the download does not match the pin', { exeMatches: false }, 2],
      ['CARGO_HOME is not empty', { cargoLeftover: true }, 0],
    ])('refuses when %s, and never runs rustup-init', (_label, opts, urls) => {
      const r = setup(opts);
      expect(r.status, r.out).toBe(1);
      expect(r.out).toContain('Rust install refused');
      expect(r.urls).toHaveLength(urls);
      expect(r.args).toBe('');
      expect(r.path).toBe('');
    });
  });
});

describe.skipIf(!HAS_RELEASE_INFRA)('the runner job-started hook (setup-runner.ps1)', () => {
  const setup = readPrivateFile('scripts/runner/setup-runner.ps1');
  const hook = readPrivateFile('scripts/runner/job-started.ps1');
  const PATTERN = String.raw`^ChristianMunoz31/burrow/\.github/workflows/(release-please|release)\.yml@refs/(heads/main|tags/v[0-9]+\.[0-9]+\.[0-9]+)$`;

  it('the hook allows only this repository, the two release workflows on main or a vX.Y.Z tag, three events and the owner', () => {
    expect(hook).toContain(`$WorkflowRefPattern = '${PATTERN}'`);
    expect(hook).toContain("$AllowedRepository = 'ChristianMunoz31/burrow'");
    expect(hook).toContain("$Owner = 'ChristianMunoz31'");
    expect(hook).toContain("$AllowedEvents = @('push', 'schedule', 'workflow_dispatch')");
    for (const name of ['GITHUB_REPOSITORY', 'GITHUB_WORKFLOW_REF', 'GITHUB_EVENT_NAME', 'GITHUB_ACTOR', 'GITHUB_TRIGGERING_ACTOR']) expect(hook).toContain(`$env:${name}`);
    // Case-sensitive comparisons only.
    expect(hook).toContain('-cne $AllowedRepository');
    expect(hook).toContain('-cnotmatch $WorkflowRefPattern');
    expect(hook).toMatch(/exit 1/);
  });

  it.each([
    ['ChristianMunoz31/burrow/.github/workflows/release-please.yml@refs/heads/main', true],
    ['ChristianMunoz31/burrow/.github/workflows/release.yml@refs/tags/v1.2.3', true],
    ['ChristianMunoz31/burrow/.github/workflows/release.yml@refs/heads/main', true],
    ['ChristianMunoz31/burrow/.github/workflows/desktop-windows.yml@refs/heads/main', false],
    ['ChristianMunoz31/burrow/.github/workflows/release.yml@refs/heads/feat/x', false],
    ['ChristianMunoz31/burrow/.github/workflows/release.yml@refs/tags/v1.2.3-rc.1', false],
    ['ChristianMunoz31/burrow/.github/workflows/ci.yml@refs/heads/main', false],
    ['ChristianMunoz31/burrow/.github/workflows/releasexyml@refs/heads/main', false],
    ['other/burrow/.github/workflows/release.yml@refs/heads/main', false],
    ['ChristianMunoz31/burrow/.github/workflows/release.yml@refs/heads/main\nx', false],
  ])('the workflow-ref pattern on %j is %s', (ref, ok) => {
    expect(new RegExp(PATTERN).test(ref)).toBe(ok);
  });

  it('setup-runner.ps1 copies the hook into an admin-owned hooks folder with a locked ACL and names it in .env', () => {
    expect(setup).toContain("$script:HookSource = Join-Path $PSScriptRoot 'job-started.ps1'");
    expect(setup).toContain("$script:HookEnvName = 'ACTIONS_RUNNER_HOOK_JOB_STARTED'");
    expect(setup).toContain("Join-Path $RunnerDir '.env'");
    expect(setup).toContain("(Join-Path (Join-Path $RunnerDir 'hooks') 'job-started.ps1')");
    // Administrators and SYSTEM full control, the service account read and execute only, inheritance off.
    expect(setup).toContain("New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')");
    expect(setup).toContain("New-Object Security.Principal.SecurityIdentifier('S-1-5-18')");
    expect(setup).toContain('FileSystemAccessRule($admins, $fs::FullControl');
    expect(setup).toContain('FileSystemAccessRule($system, $fs::FullControl');
    expect(setup).toContain('FileSystemAccessRule($svcSid, $fs::ReadAndExecute');
    expect(setup).toContain('$sec.SetAccessRuleProtection($true, $false)');
    expect(setup).toContain("Set-Acl -LiteralPath $hook -AclObject (New-LockedSecurity $ServiceSid -File)");
    expect(setup).toContain("Set-Acl -LiteralPath $hooks -AclObject (New-LockedSecurity $ServiceSid)");
    // The copy is verified, installed before the service is registered, and shown by -Status.
    expect(setup).toMatch(/Get-FileHash -LiteralPath \$hook -Algorithm SHA256/);
    const installCall = setup.search(/^ +Install-JobHook\r?$/m);
    expect(installCall).toBeGreaterThan(-1);
    expect(installCall).toBeLessThan(setup.indexOf('& $cfg @cfgArgs'));
    // The service SID is looked up only inside ShouldProcess, so -WhatIf works before the user exists.
    expect(setup).toMatch(/ShouldProcess\(\$hook, [^\n]*\n +\$ServiceSid = Get-ServiceSid/);
    expect(setup).toMatch(/function Show-Status \{[\s\S]*?Show-HookStatus/);
    expect(setup).toContain('Restart-Service -Name $svc.Name');
    expect(setup).toMatch(/\$PSCmdlet\.ShouldProcess\(\$hook,/);
  });
});

const pwsh = ['pwsh', 'powershell'].find((cmd) => spawnSync(cmd, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' }).status === 0);

describe.skipIf(!HAS_RELEASE_INFRA || !pwsh)('the job-started hook (real PowerShell)', () => {
  const hookFile = path.join(ROOT, 'scripts', 'runner', 'job-started.ps1');
  const base = {
    GITHUB_REPOSITORY: 'ChristianMunoz31/burrow',
    GITHUB_WORKFLOW_REF: 'ChristianMunoz31/burrow/.github/workflows/release.yml@refs/tags/v1.2.3',
    GITHUB_EVENT_NAME: 'push',
    GITHUB_ACTOR: 'ChristianMunoz31',
    GITHUB_TRIGGERING_ACTOR: 'ChristianMunoz31',
  };
  const run = (env) => spawnSync(pwsh, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', hookFile], { encoding: 'utf8', env: { ...process.env, ...base, ...env } }).status;

  it.each([
    ['a tag push by the owner', {}],
    ['a dispatch from main by the owner', { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_WORKFLOW_REF: 'ChristianMunoz31/burrow/.github/workflows/release.yml@refs/heads/main' }],
    ['a schedule', { GITHUB_EVENT_NAME: 'schedule', GITHUB_ACTOR: 'someone', GITHUB_TRIGGERING_ACTOR: 'someone' }],
  ])('allows %s', (_label, env) => expect(run(env)).toBe(0));

  it.each([
    ['another repository', { GITHUB_REPOSITORY: 'someone/burrow' }],
    ['another workflow', { GITHUB_WORKFLOW_REF: 'ChristianMunoz31/burrow/.github/workflows/ci.yml@refs/heads/main' }],
    ['a branch', { GITHUB_WORKFLOW_REF: 'ChristianMunoz31/burrow/.github/workflows/release.yml@refs/heads/feat/x' }],
    ['a pull_request event', { GITHUB_EVENT_NAME: 'pull_request' }],
    ['a push by someone else', { GITHUB_ACTOR: 'someone', GITHUB_TRIGGERING_ACTOR: 'someone' }],
    ['a re-run by someone else', { GITHUB_TRIGGERING_ACTOR: 'someone' }],
    ['a schedule re-run by someone else', { GITHUB_EVENT_NAME: 'schedule', GITHUB_TRIGGERING_ACTOR: 'someone' }],
    ['a different case of the owner', { GITHUB_ACTOR: 'christianmunoz31', GITHUB_TRIGGERING_ACTOR: 'christianmunoz31' }],
  ])('refuses %s', (_label, env) => expect(run(env)).toBe(1));
});
