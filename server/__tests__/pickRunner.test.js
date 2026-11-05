// Runs the real `pick-runner` script of desktop-windows.yml under bash with a fake `gh`, so the fallback rules
// (hosted unless every guard passes) are tested as written, not re-implemented. Skipped when bash is missing.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasPrivateFile, readPrivateFile } from './helpers/privateFiles.js';

const WORKFLOW = path.join(path.resolve(import.meta.dirname, '..', '..'), '.github', 'workflows', 'desktop-windows.yml');

function pickScript() {
  const lines = fs.readFileSync(WORKFLOW, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l, i) => /^\s*run: \|\s*$/.test(l) && lines[i + 1]?.includes('set +e'));
  if (start === -1) throw new Error('pick-runner script not found');
  const indent = lines[start].length - lines[start].trimStart().length;
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].trim() !== '' && lines[i].length - lines[i].trimStart().length <= indent) break;
    body.push(lines[i]);
  }
  return body.join('\n');
}

const bashOk = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' }).stdout?.trim() === 'ok';

// desktop-windows.yml is private-only (left out of the public core export): the whole file is skipped without it.
const HAS_WORKFLOW = hasPrivateFile('.github/workflows/desktop-windows.yml');
const workflowText = readPrivateFile('.github/workflows/desktop-windows.yml');
const jqFilter = /gh api "repos\/\$\{GH_REPO\}\/actions\/runners" --paginate --jq '([^']+)'/.exec(workflowText)?.[1];
const jqOk = spawnSync('jq', ['--version'], { encoding: 'utf8' }).status === 0;

describe.skipIf(!HAS_WORKFLOW)('pick-runner label filter', () => {
  it('uses an exact array subtraction, not substring matching with contains()', () => {
    expect(jqFilter).toBeTruthy();
    expect(jqFilter).toContain('(["self-hosted","Windows","ARM64","burrow"] - [.labels[].name]) | length == 0');
    expect(jqFilter).not.toContain('contains(');
  });

  it.skipIf(!jqOk)('counts only online idle runners that have all four labels (real jq)', () => {
    const runner = (labels, over = {}) => ({ status: 'online', busy: false, labels: labels.map((name) => ({ name })), ...over });
    const all = ['self-hosted', 'Windows', 'ARM64', 'burrow'];
    const count = (runners) => {
      const res = spawnSync('jq', [jqFilter], { input: JSON.stringify({ runners }), encoding: 'utf8' });
      expect(res.status, res.stderr).toBe(0);
      return Number(res.stdout.trim());
    };
    expect(count([runner(all)])).toBe(1);
    expect(count([runner([...all, 'extra'])])).toBe(1);
    expect(count([runner(all.slice(0, 3))])).toBe(0);
    expect(count([runner(['self-hosted', 'Windows', 'ARM64', 'burrow-other'])])).toBe(0);
    expect(count([runner(all, { busy: true }), runner(all, { status: 'offline' })])).toBe(0);
  });
});

describe.skipIf(!HAS_WORKFLOW || !bashOk)('pick-runner script', () => {
  let dir;
  const SELF = '["self-hosted","Windows","ARM64","burrow"]';
  const HOSTED = '"windows-11-arm"';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-pick-'));
    // Fake gh: the repo call answers FAKE_PRIVATE, the runners call answers FAKE_ONLINE; each logs its token.
    fs.writeFileSync(
      path.join(dir, 'gh'),
      [
        '#!/bin/bash',
        'case "$2" in',
        '  */actions/runners) echo "runners:$GH_TOKEN" >> "$FAKE_LOG"; echo "${FAKE_ONLINE:-0}" ;;',
        '  repos/*) echo "repo:$GH_TOKEN" >> "$FAKE_LOG"; echo "${FAKE_PRIVATE-true}" ;;',
        '  *) exit 1 ;;',
        'esac',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function run(env) {
    const out = path.join(dir, 'output.txt');
    const summary = path.join(dir, 'summary.txt');
    const log = path.join(dir, 'log.txt');
    for (const f of [out, summary, log]) fs.writeFileSync(f, '');
    const res = spawnSync('bash', ['-c', pickScript()], {
      encoding: 'utf8',
      env: {
        PATH: `${dir}${path.delimiter}${process.env.PATH}`,
        GITHUB_OUTPUT: out.replaceAll('\\', '/'),
        GITHUB_STEP_SUMMARY: summary.replaceAll('\\', '/'),
        FAKE_LOG: log.replaceAll('\\', '/'),
        GH_REPO: 'owner/repo',
        READ_TOKEN: 'read-token',
        EVENT_NAME: 'push',
        STRICT_VERSION: 'true',
        ...env,
      },
    });
    expect(res.status, res.stderr).toBe(0);
    const output = fs.readFileSync(out, 'utf8');
    const value = (key) => new RegExp(`^${key}=(.*)$`, 'm').exec(output)?.[1]?.trim();
    return { picked: value('arm64_runs_on'), x64: value('x64_runs_on'), cross: value('x64_cross'), log: fs.readFileSync(log, 'utf8'), all: res.stdout };
  }

  it('is hosted by default, with no admin token', () => {
    expect(run({}).picked).toBe(HOSTED);
  });

  it('is self-hosted only when an online idle burrow runner exists and every guard passes', () => {
    const r = run({ ADMIN_TOKEN: 'admin-token', FAKE_ONLINE: '1' });
    expect(r.picked).toBe(SELF);
    expect(r.log).toContain('repo:read-token');
    expect(r.log).toContain('runners:admin-token');
    expect(run({ ADMIN_TOKEN: 'admin-token', FAKE_ONLINE: '0' }).picked).toBe(HOSTED);
  });

  it('never uses the admin token for the repo visibility call and never prints it', () => {
    const r = run({ ADMIN_TOKEN: 'admin-token', FAKE_ONLINE: '1' });
    expect(r.log).not.toContain('repo:admin-token');
    expect(r.all).not.toContain('admin-token');
  });

  it.each(['pull_request', 'pull_request_target', 'workflow_run', 'issue_comment'])('is hosted for a %s event even with an online runner and the override', (event) => {
    expect(run({ EVENT_NAME: event, ADMIN_TOKEN: 'admin-token', FAKE_ONLINE: '1', OVERRIDE: 'self-hosted' }).picked).toBe(HOSTED);
  });

  it('is hosted for a branch dry run (strict_version false) and for a repo not confirmed private', () => {
    expect(run({ STRICT_VERSION: 'false', ADMIN_TOKEN: 'admin-token', FAKE_ONLINE: '1', OVERRIDE: 'self-hosted' }).picked).toBe(HOSTED);
    expect(run({ FAKE_PRIVATE: 'false', ADMIN_TOKEN: 'admin-token', FAKE_ONLINE: '1', OVERRIDE: 'self-hosted' }).picked).toBe(HOSTED);
    expect(run({ FAKE_PRIVATE: '', ADMIN_TOKEN: 'admin-token', FAKE_ONLINE: '1' }).picked).toBe(HOSTED);
  });

  it('the ARM64_RUNNER variable overrides the online check, after the guards', () => {
    expect(run({ OVERRIDE: 'self-hosted' }).picked).toBe(SELF);
    expect(run({ OVERRIDE: 'hosted', ADMIN_TOKEN: 'admin-token', FAKE_ONLINE: '1' }).picked).toBe(HOSTED);
    expect(run({ OVERRIDE: 'something-else', ADMIN_TOKEN: 'admin-token', FAKE_ONLINE: '1' }).picked).toBe(SELF);
  });

  describe('whole-release mode (RELEASE_RUNNER)', () => {
    const X64_HOSTED = '"windows-latest"';

    it('keeps x64 on windows-latest, native, whenever RELEASE_RUNNER is not self-hosted', () => {
      for (const env of [{}, { RELEASE_RUNNER: 'hosted' }, { RELEASE_RUNNER: 'Self-Hosted' }, { OVERRIDE: 'self-hosted' }, { ADMIN_TOKEN: 'admin-token', FAKE_ONLINE: '1' }]) {
        const r = run(env);
        expect(r.x64, JSON.stringify(env)).toBe(X64_HOSTED);
        expect(r.cross, JSON.stringify(env)).toBe('false');
      }
    });

    it('puts both builds on the PC, x64 cross-built, without listing runners', () => {
      const r = run({ RELEASE_RUNNER: 'self-hosted', ADMIN_TOKEN: 'admin-token', FAKE_ONLINE: '0', OVERRIDE: 'hosted' });
      expect(r.picked).toBe(SELF);
      expect(r.x64).toBe(SELF);
      expect(r.cross).toBe('true');
      expect(r.log).toContain('repo:read-token');
      expect(r.log).not.toContain('runners:');
    });

    it('keeps a dispatch dry run (strict_version false) on hosted runners, x64 native, without any API call', () => {
      const r = run({ RELEASE_RUNNER: 'self-hosted', STRICT_VERSION: 'false', EVENT_NAME: 'workflow_dispatch', ADMIN_TOKEN: 'admin-token', FAKE_ONLINE: '1' });
      expect(r.picked).toBe(HOSTED);
      expect(r.x64).toBe(X64_HOSTED);
      expect(r.cross).toBe('false');
      expect(r.log).toBe('');
    });

    it.each(['pull_request', 'pull_request_target', 'workflow_run'])('stays hosted for a %s event', (event) => {
      const r = run({ RELEASE_RUNNER: 'self-hosted', EVENT_NAME: event });
      expect(r.picked).toBe(HOSTED);
      expect(r.x64).toBe(X64_HOSTED);
      expect(r.cross).toBe('false');
    });

    it('stays hosted when the repository is not confirmed private', () => {
      for (const priv of ['false', '']) {
        const r = run({ RELEASE_RUNNER: 'self-hosted', FAKE_PRIVATE: priv });
        expect(r.picked).toBe(HOSTED);
        expect(r.x64).toBe(X64_HOSTED);
        expect(r.cross).toBe('false');
      }
    });
  });
});
