import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Release paths refuse a checkout without the Pro module (assertProPresent); these fixture roots have none, and
// server/__tests__/proReleaseGuard.test.js covers the refusal itself.
vi.mock('../../scripts/checks/proPresent.js', async (importOriginal) => ({ ...(await importOriginal()), assertProPresent: () => {} }));
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LOCK_FILE,
  STAGES,
  acquireLock,
  afterSteps,
  assertDryRunNotes,
  assertReleaseHost,
  checkToken,
  checksCommands,
  checksRecordFor,
  decideStage,
  emptyState,
  formatCommand,
  isInsideDir,
  isSupportedNode,
  mergeRefusal,
  missingRustTargets,
  parseAutoArgs,
  parseMergeNumbers,
  parseGithubReleaseDryRun,
  parseReleasePrDryRun,
  publishCommand,
  publishConfirmationMode,
  readState,
  recordStage,
  redact,
  releaseDir,
  releasePleaseArgs,
  squashSubject,
  stagesForRun,
  summarizeChangelog,
  typedNumberMatches,
  typedTagMatches,
  withoutTokenEnv,
  writeState,
  x64Commands,
  x64InstallerPath,
} from '../../scripts/release/lib/releaseAutoPlan.mjs';
import { childEnv, defaultStep, dryPlan, runAuto } from '../../scripts/release/releaseAuto.mjs';
import { ensureX64Node } from '../../scripts/release/storeNode.mjs';

const TOKEN = `ghp_${'A1b2C3d4'.repeat(4)}xyzw`;
const COMMIT = 'c0ffee'.padEnd(40, '7');
const MAIN = 'beef00'.padEnd(40, '1');
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'release-auto-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('parseAutoArgs', () => {
  it('has safe defaults', () => {
    expect(parseAutoArgs([])).toMatchObject({ tag: null, from: null, publish: false, yes: false, status: false, dryPlan: false });
  });
  it('offers no way to skip the checks and refuses unknown flags', () => {
    expect(() => parseAutoArgs(['--skip-checks'])).toThrow();
    expect(() => parseAutoArgs(['--publish', '--skip-checks'])).toThrow();
    expect(() => parseAutoArgs(['extra'])).toThrow();
  });
  it('validates the tag, the stage and the flag combinations', () => {
    expect(() => parseAutoArgs(['--tag', '1.2.0'])).toThrow(/--tag/);
    expect(() => parseAutoArgs(['--tag', 'v1.2.0-rc.1'])).toThrow(/stable/);
    expect(() => parseAutoArgs(['--from', 'deploy'])).toThrow(/--from must be one of/);
    expect(() => parseAutoArgs(['--yes'])).toThrow(/--publish/);
    expect(() => parseAutoArgs(['--from', 'publish'])).toThrow(/needs --publish/);
    expect(() => parseAutoArgs(['--status', '--dry-plan'])).toThrow();
    expect(() => parseAutoArgs(['--from', 'tag'])).toThrow(/needs --tag/);
    expect(() => parseAutoArgs(['--from', 'x64'])).toThrow(/needs --tag/);
    expect(() => parseAutoArgs(['--from', 'after'])).toThrow(/needs --tag/);
    expect(() => parseAutoArgs(['--checks-done-manually'])).toThrow(/--publish/);
    expect(parseAutoArgs(['--tag', 'v1.2.0', '--from', 'publish', '--publish', '--checks-done-manually']).checksDoneManually).toBe(true);
    expect(parseAutoArgs(['--from', 'checks'])).toMatchObject({ from: 'checks', tag: null });
    expect(parseAutoArgs(['--tag', 'v1.2.0', '--from', 'x64', '--publish', '--yes'])).toMatchObject({ tag: 'v1.2.0', from: 'x64', publish: true, yes: true });
  });
});

describe('host, node and tools', () => {
  it('builds only on Windows ARM64', () => {
    expect(() => assertReleaseHost({ platform: 'linux', arch: 'x64' })).toThrow(/Windows ARM64 PC only.*--dry-plan/);
    expect(() => assertReleaseHost({ platform: 'win32', arch: 'x64' })).toThrow(/Windows ARM64/);
    expect(() => assertReleaseHost({ platform: 'darwin', arch: 'arm64' })).toThrow(/Windows ARM64/);
    expect(() => assertReleaseHost({ platform: 'win32', arch: 'arm64' })).not.toThrow();
  });
  it('accepts the Node versions of package.json engines', () => {
    for (const v of ['v22.13.0', 'v22.20.1', 'v23.4.0', 'v24.15.0', 'v25.0.0']) expect(isSupportedNode(v)).toBe(true);
    for (const v of ['v22.12.9', 'v23.3.0', 'v20.18.0', 'nonsense']) expect(isSupportedNode(v)).toBe(false);
  });
  it('names the missing Rust targets', () => {
    expect(missingRustTargets('aarch64-pc-windows-msvc\r\n')).toEqual(['x86_64-pc-windows-msvc']);
    expect(missingRustTargets('aarch64-pc-windows-msvc\nx86_64-pc-windows-msvc\n')).toEqual([]);
  });
  it('puts the state of an unknown version in burrow-release\\next and a tagged one in its own folder', () => {
    expect(releaseDir({ env: { LOCALAPPDATA: 'D:\\Data\\Local' }, tag: null })).toBe('D:\\Data\\Local\\burrow-release\\next');
    expect(releaseDir({ env: { LOCALAPPDATA: 'C:\\L' }, tag: 'v1.2.0' })).toBe('C:\\L\\burrow-release\\v1.2.0');
    expect(releaseDir({ env: {}, tag: 'v1.2.0' })).toBe('%LOCALAPPDATA%\\burrow-release\\v1.2.0');
  });
  it('treats a link into the repository as inside it', () => {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
    fs.symlinkSync(repo, path.join(tmp, 'link'), 'dir');
    expect(isInsideDir(path.join(tmp, 'link', 'out', 'deeper'), repo)).toBe(true);
    expect(isInsideDir(path.join(repo, 'sub', 'new'), repo)).toBe(true);
    expect(isInsideDir(repo, repo)).toBe(true);
    expect(isInsideDir(path.join(tmp, 'elsewhere', 'out'), repo)).toBe(false);
    expect(isInsideDir(path.join(tmp, 'repo-sibling'), repo)).toBe(false);
  });
});

describe('lock file', () => {
  it('refuses a second run while the lock is fresh, takes over a stale one, and releases only its own', () => {
    const t0 = new Date('2026-10-11T10:00:00Z');
    const release = acquireLock(tmp, { now: t0, pid: 11 });
    expect(fs.existsSync(path.join(tmp, LOCK_FILE))).toBe(true);
    expect(() => acquireLock(tmp, { now: new Date(t0.getTime() + 5 * 3600e3), pid: 12 })).toThrow(/Another release:auto run holds .*process 11/);
    const logs = [];
    const release2 = acquireLock(tmp, { now: new Date(t0.getTime() + 7 * 3600e3), pid: 13, log: (l) => logs.push(l) });
    expect(logs.join('\n')).toMatch(/stale lock.*process 11.*more than 6 hours/);
    release(); // the first run's release must not remove the lock it no longer owns
    expect(JSON.parse(fs.readFileSync(path.join(tmp, LOCK_FILE), 'utf8')).pid).toBe(13);
    release2();
    expect(fs.existsSync(path.join(tmp, LOCK_FILE))).toBe(false);
  });
});

describe('secrets', () => {
  it('redacts every occurrence and ignores tiny strings', () => {
    expect(redact(`a ${TOKEN} b ${TOKEN}`, [TOKEN])).toBe('a *** b ***');
    expect(redact('abc', ['b'])).toBe('abc');
    expect(formatCommand({ file: 'release-please', args: [`--token=${TOKEN}`] }, { secrets: [TOKEN] })).toBe('release-please --token=***');
  });
  it('shows npm and node instead of their paths and quotes spaces', () => {
    const cmd = { file: '/usr/bin/node', args: ['/x/npm/bin/npm-cli.js', 'run', 'build'] };
    expect(formatCommand(cmd, { execPath: '/usr/bin/node' })).toBe('npm run build');
    expect(formatCommand({ file: '/usr/bin/node', args: ['C:\\a b\\x.js'] }, { execPath: '/usr/bin/node' })).toBe('node "C:\\a b\\x.js"');
  });
  it('strips every token variable, case-insensitively', () => {
    const env = { PATH: 'p', GH_TOKEN: 'x', gh_token: 'y', GITHUB_TOKEN: 'z', RELEASES_TOKEN: 'r', BURROW_RP_TOKEN: 'q' };
    expect(withoutTokenEnv(env)).toEqual({ PATH: 'p' });
  });
  it('never puts the token in a checkToken error', () => {
    expect(checkToken(`  ${TOKEN}\n`)).toBe(TOKEN);
    let msg = '';
    try {
      checkToken(`${TOKEN} ${TOKEN}`);
    } catch (err) {
      msg = err.message;
    }
    expect(msg).toMatch(/gh auth login/);
    expect(msg).not.toContain(TOKEN);
    expect(() => checkToken('')).toThrow();
  });
  it('gives each child only the variables it needs', () => {
    const env = { PATH: 'p', GH_TOKEN: 'old', TAURI_SIGNING_PRIVATE_KEY: 'k', TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'pw', BURROW_DISTRIBUTION: 'store' };
    const clean = childEnv('clean', env);
    expect(clean).toMatchObject({ PATH: 'p', BURROW_CHANNEL: 'stable' });
    expect(Object.keys(clean)).not.toContain('GH_TOKEN');
    expect(Object.keys(clean)).not.toContain('TAURI_SIGNING_PRIVATE_KEY');
    expect(Object.keys(clean)).not.toContain('BURROW_DISTRIBUTION');
    const signing = childEnv('signing', env);
    expect(signing).toMatchObject({ TAURI_SIGNING_PRIVATE_KEY: 'k', TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'pw', BURROW_CHANNEL: 'stable' });
    expect(Object.keys(signing)).not.toContain('GH_TOKEN');
    const pub = childEnv('publish', env, TOKEN);
    expect(pub.GH_TOKEN).toBe(TOKEN);
    expect(Object.keys(pub)).not.toContain('TAURI_SIGNING_PRIVATE_KEY');
    const rp = childEnv('rp', env, TOKEN);
    expect(rp.BURROW_RP_TOKEN).toBe(TOKEN);
    expect(Object.keys(rp)).not.toContain('GH_TOKEN');
    expect(() => childEnv('publish', env)).toThrow();
    const plain = childEnv('plain', env);
    expect(plain).toEqual({ PATH: 'p', BURROW_DISTRIBUTION: 'store' });
  });
  it('strips every credential-like variable from build, test and check children, but still signs the installer', () => {
    const env = {
      PATH: 'p',
      NPM_TOKEN: 'n',
      npm_config__authToken: 'a',
      GITHUB_PAT: 'g',
      AUTH_SECRET: 's',
      SOME_PASSWORD: 'x',
      OPENAI_API_KEY: 'o',
      APPDATA: 'keep',
      TAURI_SIGNING_PRIVATE_KEY: 'k',
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'pw',
    };
    const leaked = ['NPM_TOKEN', 'npm_config__authToken', 'GITHUB_PAT', 'AUTH_SECRET', 'SOME_PASSWORD', 'OPENAI_API_KEY'];
    for (const kind of ['plain', 'clean', 'signing', 'gh']) {
      const got = childEnv(kind, env);
      for (const name of leaked) expect(Object.keys(got)).not.toContain(name);
      expect(got.APPDATA).toBe('keep');
    }
    expect(childEnv('signing', env)).toMatchObject({ TAURI_SIGNING_PRIVATE_KEY: 'k', TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'pw' });
    expect(Object.keys(childEnv('clean', env))).not.toContain('TAURI_SIGNING_PRIVATE_KEY_PASSWORD');
    expect(Object.keys(childEnv('publish', env, TOKEN))).not.toContain('NPM_TOKEN');
  });
  it('a command that cannot start names the reason instead of "exit unknown"', () => {
    expect(() => defaultStep({ label: 'ghost tool', file: path.join(tmp, 'no-such-binary'), args: [], cwd: tmp }, process.env)).toThrow(/ghost tool could not start \(ENOENT\)/);
  });
});

describe('commands', () => {
  it('release-please arguments never carry a token', () => {
    const args = releasePleaseArgs('release-pr', { dryRun: true });
    expect(args).toEqual([
      'release-pr',
      '--repo-url=ChristianMunoz31/burrow',
      '--target-branch=main',
      '--config-file=release-please-config.json',
      '--manifest-file=.release-please-manifest.json',
      '--dry-run',
    ]);
    expect(releasePleaseArgs('github-release', { dryRun: false }).join(' ')).not.toMatch(/token|dry-run/);
    expect(() => releasePleaseArgs('merge', { dryRun: false })).toThrow();
  });
  it('the checks follow the runbook and include gitleaks over the last tag only when it is installed', () => {
    const cmds = checksCommands({ root: '/r', node: 'node', npmCli: 'npm-cli.js', lastTag: 'v1.1.0', gitleaks: true });
    const shown = cmds.map((c) => formatCommand(c, { execPath: 'node' }));
    expect(shown).toEqual([
      'npm ci',
      'npm run lint',
      'npm run check',
      'npm test',
      'npm run build',
      'npm run check:bundle',
      'npm exec --no -- playwright test --project=flows --project=first-run --project=a11y',
      'gitleaks git --config .gitleaks.toml --log-opts=v1.1.0..HEAD --redact .',
    ]);
    expect(checksCommands({ root: '/r', node: 'node', npmCli: 'npm-cli.js', lastTag: null, gitleaks: false })).toHaveLength(7);
  });
  it('the x64 stage runs the documented sidecar, channel, smoke and installer commands', () => {
    const cmds = x64Commands({ wt: 'C:\\o\\wt-x64', node: 'node', npmCli: 'npm-cli.js', nodeExe: 'C:\\c\\node.exe', version: '1.2.0' });
    const shown = cmds.map((c) => formatCommand(c, { execPath: 'node' }));
    expect(shown[2]).toBe('node C:\\o\\wt-x64\\scripts\\desktop\\buildSidecar.js --minify --channel stable --node-binary C:\\c\\node.exe --out-triple x86_64-pc-windows-msvc');
    expect(shown[3]).toContain('channelMarker.js --expect stable --bundle C:\\o\\wt-x64\\.sidecar-build\\server.cjs');
    expect(shown[4]).toContain('smokeSidecar.js --sidecar C:\\o\\wt-x64\\src-tauri\\binaries\\burrow-server-x86_64-pc-windows-msvc.exe');
    expect(shown[4]).toContain('--expect-version 1.2.0');
    expect(shown[5]).toBe('node C:\\o\\wt-x64\\scripts\\release\\buildInstaller.js --target x86_64-pc-windows-msvc');
    expect(cmds[5].env).toBe('signing');
    expect(cmds.slice(0, 5).every((c) => c.env === 'clean')).toBe(true);
    expect(x64InstallerPath({ wt: 'C:\\o\\wt-x64', version: '1.2.0' })).toBe('C:\\o\\wt-x64\\src-tauri\\target\\x86_64-pc-windows-msvc\\release\\bundle\\nsis\\Burrow_1.2.0_x64-setup.exe');
  });
  it('both publish commands pass the release worktree\'s CHANGELOG.md, so the curated notes ship', () => {
    const input = { wt: 'C:\\o\\wt-arm64', node: 'node', tag: 'v1.2.0', publicDir: 'C:\\o\\public' };
    const dry = publishCommand({ ...input, dryRun: true });
    const real = publishCommand({ ...input, dryRun: false });
    expect(dry.args).toEqual([
      'C:\\o\\wt-arm64\\scripts\\release\\publishPublic.js',
      '--tag',
      'v1.2.0',
      '--assets-dir',
      'C:\\o\\public',
      '--notes-from',
      'C:\\o\\wt-arm64\\CHANGELOG.md',
      '--dry-run',
    ]);
    expect(real.args).toEqual([
      'C:\\o\\wt-arm64\\scripts\\release\\publishPublic.js',
      '--tag',
      'v1.2.0',
      '--assets-dir',
      'C:\\o\\public',
      '--notes-from',
      'C:\\o\\wt-arm64\\CHANGELOG.md',
    ]);
    expect([dry.cwd, dry.env, real.cwd, real.env]).toEqual(['C:\\o\\wt-arm64', 'clean', 'C:\\o\\wt-arm64', 'publish']);
  });
  it('the publish dry run must show the curated notes and never the "no listed changes" fallback', () => {
    const curated = '\r\nPress Alt+J to open Javi.\r\n- More\r\n';
    expect(() => assertDryRunNotes({ output: "## What's new\n\nPress Alt+J to open Javi.\n- More\n", curated, tag: 'v1.2.0' })).not.toThrow();
    expect(() => assertDryRunNotes({ output: "## What's new\n\nThis release has behind-the-scenes improvements.\n", curated, tag: 'v1.2.0' })).toThrow(/release-notes\/v1\.2\.0\.md.*Press Alt\+J/);
    expect(() => assertDryRunNotes({ output: 'This release has no listed changes.\n', curated: null, tag: 'v1.2.0' })).toThrow(/no listed changes/);
    expect(() => assertDryRunNotes({ output: '* a fix\n', curated: null, tag: 'v1.2.0' })).not.toThrow();
  });
});

describe('release-please output', () => {
  const dry = [
    'Would open 1 pull requests',
    'fork: false',
    'title: chore(main): release 1.2.0',
    'branch: release-please--branches--main',
    'draft: false',
    'body: :robot: I have created a release *beep* *boop*',
    '---',
    '## [1.2.0](https://example.invalid/compare/v1.1.0...v1.2.0) (2026-10-11)',
    '### Features',
    '* menu sections ([#98](https://example.invalid/98))',
    '* weather location ([#101](https://example.invalid/101))',
    'updates: 3',
  ].join('\n');
  it('reads the version and a short changelog', () => {
    const r = parseReleasePrDryRun(dry);
    expect(r).toMatchObject({ count: 1, version: '1.2.0', title: 'chore(main): release 1.2.0' });
    const summary = summarizeChangelog(r.body);
    expect(summary).toContain('Features:');
    expect(summary.filter((l) => l.startsWith('  *'))).toHaveLength(2);
  });
  it('reports nothing to release, and refuses output it does not understand', () => {
    expect(parseReleasePrDryRun('Would open 0 pull requests\n')).toMatchObject({ count: 0, version: null });
    expect(() => parseReleasePrDryRun('error')).toThrow();
    expect(() => parseReleasePrDryRun('Would open 1 pull requests\ntitle: chore: something\n')).toThrow(/stable version/);
  });
  it('counts the releases github-release would tag', () => {
    expect(parseGithubReleaseDryRun('Would tag 0 releases:')).toBe(0);
    expect(parseGithubReleaseDryRun('info: Would tag 1 releases:')).toBe(1);
    expect(() => parseGithubReleaseDryRun('boom')).toThrow();
  });
});

describe('publish confirmation gate', () => {
  it('non-interactive needs BOTH --yes and BURROW_RELEASE_CONFIRM equal to the tag', () => {
    expect(publishConfirmationMode({ tag: 'v1.2.0', yes: true, env: { BURROW_RELEASE_CONFIRM: 'v1.2.0' }, isTTY: false })).toBe('env');
    expect(() => publishConfirmationMode({ tag: 'v1.2.0', yes: true, env: {}, isTTY: true })).toThrow(/BURROW_RELEASE_CONFIRM/);
    expect(() => publishConfirmationMode({ tag: 'v1.2.0', yes: true, env: { BURROW_RELEASE_CONFIRM: 'v1.2.1' }, isTTY: true })).toThrow();
    expect(() => publishConfirmationMode({ tag: 'v1.2.0', yes: true, env: { BURROW_RELEASE_CONFIRM: ' v1.2.0' }, isTTY: true })).toThrow();
  });
  it('the env variable alone never skips the question, and no terminal means no publish', () => {
    expect(publishConfirmationMode({ tag: 'v1.2.0', yes: false, env: { BURROW_RELEASE_CONFIRM: 'v1.2.0' }, isTTY: true })).toBe('prompt');
    expect(() => publishConfirmationMode({ tag: 'v1.2.0', yes: false, env: { BURROW_RELEASE_CONFIRM: 'v1.2.0' }, isTTY: false })).toThrow(/terminal/);
  });
  it('the typed answer must be exactly the tag', () => {
    expect(typedTagMatches('v1.2.0', 'v1.2.0')).toBe(true);
    expect(typedTagMatches(' v1.2.0 \n', 'v1.2.0')).toBe(true);
    for (const a of ['y', 'yes', '1.2.0', 'V1.2.0', 'v1.2.00', '', undefined]) expect(typedTagMatches(a, 'v1.2.0')).toBe(false);
  });
});

describe('state file', () => {
  it('round-trips, atomically, and reads a missing file as empty', () => {
    const file = path.join(tmp, 'v1.2.0', 'auto-state.json');
    expect(readState(file, { tag: 'v1.2.0' })).toEqual(emptyState('v1.2.0'));
    const s = recordStage(emptyState('v1.2.0'), 'tag', { inputs: { tag: 'v1.2.0' }, outputs: { commit: COMMIT }, now: new Date('2026-10-11T10:00:00Z') });
    writeState(file, s);
    expect(readState(file, { tag: 'v1.2.0' })).toEqual(s);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['auto-state.json']);
  });
  it('treats a corrupt, foreign or other-tag file as empty and warns', () => {
    const file = path.join(tmp, 'auto-state.json');
    const warnings = [];
    const warn = (l) => warnings.push(l);
    fs.writeFileSync(file, '{oops');
    expect(readState(file, { tag: 'v1.2.0', warn })).toEqual(emptyState('v1.2.0'));
    fs.writeFileSync(file, JSON.stringify({ version: 99, stages: {} }));
    expect(readState(file, { tag: 'v1.2.0', warn }).stages).toEqual({});
    writeState(file, recordStage(emptyState('v1.1.0'), 'tag', { inputs: {}, outputs: {} }));
    expect(readState(file, { tag: 'v1.2.0', warn }).stages).toEqual({});
    expect(warnings).toHaveLength(3);
  });
  it('drops unknown stages and malformed records', () => {
    const file = path.join(tmp, 'auto-state.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, tag: 'v1.2.0', stages: { deploy: { completedAt: 'x', inputs: {}, outputs: {} }, x64: { completedAt: 1 }, tag: { completedAt: 'x', inputs: {}, outputs: {} } } }));
    expect(Object.keys(readState(file, { tag: 'v1.2.0' }).stages)).toEqual(['tag']);
  });
  it('refuses to write anything that looks like a GitHub token', () => {
    const file = path.join(tmp, 'auto-state.json');
    const s = recordStage(emptyState('v1.2.0'), 'tag', { inputs: { leak: TOKEN }, outputs: {} });
    expect(() => writeState(file, s)).toThrow(/token/);
    expect(fs.existsSync(file)).toBe(false);
  });
  it('a changed stage result drops the later stages, an identical one keeps them', () => {
    let s = emptyState('v1.2.0');
    s = recordStage(s, 'tag', { inputs: { tag: 'v1.2.0' }, outputs: { commit: COMMIT } });
    s = recordStage(s, 'x64', { inputs: { commit: COMMIT }, outputs: { sha256: 'a'.repeat(64) } });
    s = recordStage(s, 'arm64', { inputs: { x64Sha256: 'a'.repeat(64) }, outputs: {} });
    expect(Object.keys(recordStage(s, 'x64', { inputs: { commit: COMMIT }, outputs: { sha256: 'a'.repeat(64) } }).stages)).toEqual(['tag', 'x64', 'arm64']);
    expect(Object.keys(recordStage(s, 'x64', { inputs: { commit: COMMIT }, outputs: { sha256: 'b'.repeat(64) } }).stages)).toEqual(['tag', 'x64']);
  });
});

describe('resume decisions', () => {
  const record = { completedAt: '2026-10-11T10:00:00.000Z', inputs: { commit: COMMIT, node: 'v24.15.0' }, outputs: {} };
  it('skips a stage only when its inputs match and its outputs verify, and never the --from stage', () => {
    expect(decideStage({ stage: 'x64', forced: null, record, inputs: { node: 'v24.15.0', commit: COMMIT }, outputsOk: true }).skip).toBe(true);
    expect(decideStage({ stage: 'x64', forced: 'x64', record, inputs: record.inputs, outputsOk: true })).toMatchObject({ skip: false, reason: expect.stringMatching(/--from/) });
    expect(decideStage({ stage: 'x64', forced: null, record, inputs: { commit: MAIN, node: 'v24.15.0' }, outputsOk: true })).toMatchObject({ skip: false, reason: 'its inputs changed' });
    expect(decideStage({ stage: 'x64', forced: null, record, inputs: record.inputs, outputsOk: false })).toMatchObject({ skip: false, reason: expect.stringMatching(/outputs/) });
    expect(decideStage({ stage: 'x64', forced: null, record: undefined, inputs: record.inputs, outputsOk: false }).skip).toBe(false);
  });
  it('walks the stages from --from to the end', () => {
    expect(stagesForRun(null)).toEqual(STAGES);
    expect(stagesForRun('x64')).toEqual(['x64', 'arm64', 'publish', 'after']);
  });
  it('lists the after steps, with the privacy page only when it changed', () => {
    const changed = afterSteps({ tag: 'v1.2.0', privacyChanged: true, outDir: 'C:\\o', published: true }).join('\n');
    expect(changed).toContain('npm.cmd run privacy:render');
    expect(changed).toContain('npm.cmd run release:gumroad -- --tag v1.2.0');
    expect(changed).toContain('npm.cmd run release:store -- --check');
    expect(changed).toContain('npm.cmd run store:screenshots');
    expect(afterSteps({ tag: 'v1.2.0', privacyChanged: false, outDir: 'C:\\o', published: true }).join('\n')).not.toContain('privacy:render');
  });
  it('before the publish, the after steps name only the publish command and hold back Gumroad and the worktree removal', () => {
    const text = afterSteps({ tag: 'v1.2.0', privacyChanged: true, outDir: 'C:\\o', published: false }).join('\n');
    expect(text).toContain('npm.cmd run release:auto -- --tag v1.2.0 --from publish --publish');
    expect(text).toMatch(/not published yet/);
    expect(text).toMatch(/Do not run release:gumroad --publish and do not remove the release worktrees yet/);
    expect(text).not.toContain('npm.cmd run release:gumroad -- --tag');
    expect(text).not.toContain('git worktree remove');
    expect(text).not.toContain('releases/latest/download');
  });
  it('finds a checks record only for the exact commit, in the tag state or the pending one', () => {
    const rec = (commit) => recordStage(emptyState(null), 'checks', { inputs: { commit }, outputs: { commit } });
    expect(checksRecordFor({ commit: COMMIT, states: [emptyState('v1.2.0'), rec(MAIN)] })).toBeNull();
    expect(checksRecordFor({ commit: COMMIT, states: [emptyState('v1.2.0'), null, rec(COMMIT)] })?.outputs.commit).toBe(COMMIT);
    expect(checksRecordFor({ commit: 'not-a-commit', states: [rec('not-a-commit')] })).toBeNull();
  });
  it('a new checks record keeps the build records after it (checks feed no later stage)', () => {
    let s = emptyState('v1.2.0');
    s = recordStage(s, 'checks', { inputs: { commit: MAIN }, outputs: { commit: MAIN } });
    s = recordStage(s, 'x64', { inputs: { commit: COMMIT }, outputs: { sha256: 'a'.repeat(64) } });
    s = recordStage(s, 'checks', { inputs: { commit: COMMIT, tag: 'v1.2.0' }, outputs: { commit: COMMIT } });
    expect(Object.keys(s.stages)).toEqual(['checks', 'x64']);
  });
});

describe('x64 node.exe without a pin (release:auto only)', () => {
  const pe = () => {
    const b = Buffer.alloc(512);
    b.write('MZ', 0, 'latin1');
    b.writeUInt32LE(0x80, 0x3c);
    b.write('PE\0\0', 0x80, 'latin1');
    b.writeUInt16LE(0x8664, 0x84);
    return b;
  };
  const body = pe();
  const good = sha(body);
  const ab = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const makeFetch = (sumsHash) => {
    const calls = [];
    return {
      calls,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        if (url.endsWith('SHASUMS256.txt')) return { ok: true, status: 200, url, text: async () => `${'1'.repeat(64)}  node-v24.99.0-win-x64.zip\n${sumsHash}  win-x64/node.exe\n` };
        return { ok: true, status: 200, url, headers: { get: () => null }, arrayBuffer: async () => ab(body) };
      },
    };
  };
  const run = () => ({ status: 0, stdout: 'v24.99.0\n' });

  it('still refuses an unpinned version by default (the Store build is unchanged)', async () => {
    const { fetchImpl, calls } = makeFetch(good);
    await expect(ensureX64Node({ cacheDir: path.join(tmp, 'c'), version: 'v24.99.0', pins: {}, fetchImpl, run })).rejects.toThrow(/No pinned sha256/);
    expect(calls).toHaveLength(0);
  });
  it('with allowUnpinned verifies the download against SHASUMS256.txt over https, without redirects', async () => {
    const { fetchImpl, calls } = makeFetch(good);
    const file = await ensureX64Node({ cacheDir: path.join(tmp, 'c'), version: 'v24.99.0', pins: {}, fetchImpl, run, allowUnpinned: true });
    expect(sha(fs.readFileSync(file))).toBe(good);
    expect(calls.map((c) => c.url)).toEqual(['https://nodejs.org/dist/v24.99.0/SHASUMS256.txt', 'https://nodejs.org/dist/v24.99.0/win-x64/node.exe']);
    for (const c of calls) expect(c.init).toEqual({ redirect: 'error' });
    // A cached copy is re-checked against a fresh SHASUMS256.txt, not trusted blindly.
    await ensureX64Node({ cacheDir: path.join(tmp, 'c'), version: 'v24.99.0', pins: {}, fetchImpl, run, allowUnpinned: true });
    expect(calls).toHaveLength(3);
  });
  it('discards a download that does not match the listed sha256', async () => {
    const { fetchImpl } = makeFetch('0'.repeat(64));
    await expect(ensureX64Node({ cacheDir: path.join(tmp, 'c'), version: 'v24.99.0', pins: {}, fetchImpl, run, allowUnpinned: true })).rejects.toThrow(/does not match the listed sha256/);
    expect(fs.existsSync(path.join(tmp, 'c', 'node-v24.99.0-win-x64.exe'))).toBe(false);
  });
});

describe('dry plan and read-only modes', () => {
  it('prints the plan on any host without running anything and never shows a token', async () => {
    const logs = [];
    const calls = [];
    const res = await runAuto(parseAutoArgs(['--dry-plan', '--tag', 'v1.2.0', '--from', 'x64', '--publish']), {
      env: { LOCALAPPDATA: 'C:\\L', GH_TOKEN: TOKEN },
      platform: 'linux',
      arch: 'x64',
      log: (l) => logs.push(l),
      exec: async (...a) => calls.push(a),
      step: (...a) => calls.push(a),
    });
    expect(calls).toHaveLength(0);
    const text = logs.join('\n');
    expect(res.done).toBe(true);
    expect(text).toContain('a real run refuses this host');
    expect(text).toContain('--x64-file C:\\L\\burrow-release\\v1.2.0\\x64\\Burrow_1.2.0_x64-setup.exe');
    expect(text).toContain(
      'node C:\\L\\burrow-release\\v1.2.0\\wt-arm64\\scripts\\release\\publishPublic.js --tag v1.2.0 --assets-dir C:\\L\\burrow-release\\v1.2.0\\public --notes-from C:\\L\\burrow-release\\v1.2.0\\wt-arm64\\CHANGELOG.md --dry-run',
    );
    expect(text).toContain(
      'node C:\\L\\burrow-release\\v1.2.0\\wt-arm64\\scripts\\release\\publishPublic.js --tag v1.2.0 --assets-dir C:\\L\\burrow-release\\v1.2.0\\public --notes-from C:\\L\\burrow-release\\v1.2.0\\wt-arm64\\CHANGELOG.md\n',
    );
    expect(text).toContain('type v1.2.0');
    expect(text).not.toContain('[checks]');
    expect(text).not.toContain(TOKEN);
  });
  it('the full plan shows the release-please token only as a placeholder and the stop after the release PR', () => {
    const text = dryPlan(parseAutoArgs([]), { env: {}, root: '/r', execPath: 'node', pathMod: path.win32, pkgVersion: '1.1.0', platform: 'win32', arch: 'arm64' }).join('\n');
    expect(text).toContain('burrow-release\\next\\auto-state.json');
    expect(text).toContain('--token=<from gh auth token>');
    expect(text).toContain('Add --merge-release-pr to merge it here instead.');
    expect(text).toContain('merges    none');
    expect(text).toContain('[publish] skipped (needs --publish)');
  });
  it('refuses a real run on the wrong host before any command', async () => {
    const calls = [];
    await expect(runAuto(parseAutoArgs(['--tag', 'v1.2.0', '--from', 'x64']), { platform: 'linux', arch: 'x64', exec: async (...a) => calls.push(a), log: () => {} })).rejects.toThrow(/Windows ARM64/);
    await expect(runAuto(parseAutoArgs(['--tag', 'v1.2.0']), { platform: 'win32', arch: 'x64', exec: async (...a) => calls.push(a), log: () => {} })).rejects.toThrow(/Windows ARM64/);
    expect(calls).toHaveLength(0);
  });
  it('--status prints the stage table', async () => {
    const outDir = path.join(tmp, 'out');
    writeState(path.join(outDir, 'auto-state.json'), recordStage(emptyState('v1.2.0'), 'tag', { inputs: { tag: 'v1.2.0' }, outputs: { commit: COMMIT } }));
    const logs = [];
    await runAuto(parseAutoArgs(['--status', '--tag', 'v1.2.0', '--out-dir', outDir]), { platform: 'linux', arch: 'x64', log: (l) => logs.push(l), pathMod: path });
    const text = logs.join('\n');
    expect(text).toMatch(/tag\s+done .*commit c0ffee7/);
    expect(text).toMatch(/x64\s+not done/);
  });
});

// A fake Windows ARM64 PC: exec answers git, gh and rustup; step records the build commands and creates what the real
// scripts would leave behind.
function fakePc({ root, local, tagSha = COMMIT, tagExists = true, rpOutput = {}, updater = false, curated = null, dropNotes = false } = {}) {
  const calls = { exec: [], step: [], capture: [] };
  const worktrees = [];
  const exec = async (file, args, opts = {}) => {
    calls.exec.push({ file, args, env: opts.env });
    const key = `${file} ${args.join(' ')}`;
    const ok = (stdout = '') => ({ stdout, stderr: '' });
    if (key === 'gh auth status') return ok();
    if (key === 'gh auth token') return ok(`${TOKEN}\n`);
    if (key === 'rustup target list --installed') return ok('aarch64-pc-windows-msvc\nx86_64-pc-windows-msvc\n');
    if (file === 'gh' && args[0] === 'api' && /git\/ref\/tags\//.test(args[1])) {
      if (!tagExists) throw Object.assign(new Error('gh: Not Found (HTTP 404)'), { stderr: 'gh: Not Found (HTTP 404)' });
      return ok(JSON.stringify({ object: { type: 'commit', sha: tagSha } }));
    }
    if (file === 'git') {
      if (args[0] === 'fetch') return ok();
      if (args[0] === 'rev-parse' && args[1] === 'origin/main') return ok(`${MAIN}\n`);
      if (args[0] === 'rev-parse' && args[1].startsWith('refs/tags/')) return ok(`${tagSha}\n`);
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok(`${tagSha}\n`);
      if (args[0] === 'status') return ok('');
      if (args[0] === 'worktree' && args[1] === 'list') return ok(worktrees.map((w) => `worktree ${w}\nHEAD ${tagSha}\n`).join('\n'));
      if (args[0] === 'worktree' && args[1] === 'add') {
        const wt = args[3];
        worktrees.push(wt);
        fs.mkdirSync(wt, { recursive: true });
        fs.writeFileSync(path.join(wt, 'package.json'), JSON.stringify({ version: '9.9.9' }));
        if (curated !== null) {
          fs.mkdirSync(path.join(wt, 'release-notes'), { recursive: true });
          fs.writeFileSync(path.join(wt, 'release-notes', 'v9.9.9.md'), curated);
        }
        if (updater) fs.mkdirSync(path.join(wt, 'src-tauri'), { recursive: true });
        return ok();
      }
      if (args[0] === 'worktree' && args[1] === 'remove') {
        const wt = args[args.length - 1];
        worktrees.splice(worktrees.indexOf(wt), 1);
        fs.rmSync(wt, { recursive: true, force: true });
        return ok();
      }
      if (args[0] === 'merge-base') return ok();
      if (args[0] === 'describe') throw Object.assign(new Error('no tag'), { code: 128 });
    }
    throw new Error(`unexpected exec: ${key}`);
  };
  const step = (cmd, env) => {
    calls.step.push({ cmd, env });
    const script = path.basename(cmd.args[0] ?? '');
    if (script === 'buildInstaller.js') {
      const out = x64InstallerPath({ wt: cmd.cwd, version: '9.9.9', pathMod: path });
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(64)]));
    }
    if (script === 'releaseLocal.mjs') {
      const outDir = cmd.args[cmd.args.indexOf('--out-dir') + 1];
      const x64 = cmd.args[cmd.args.indexOf('--x64-file') + 1];
      const pub = path.join(outDir, 'public');
      fs.mkdirSync(pub, { recursive: true });
      fs.copyFileSync(x64, path.join(pub, 'Burrow-Setup-x64.exe'));
      fs.writeFileSync(path.join(pub, 'Burrow-Setup-arm64.exe'), Buffer.from('MZarm'));
      const lines = ['Burrow-Setup-x64.exe', 'Burrow-Setup-arm64.exe'].map((n) => `${sha(fs.readFileSync(path.join(pub, n)))}  ${n}`);
      fs.writeFileSync(path.join(pub, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`);
      fs.writeFileSync(path.join(outDir, 'build-manifest.json'), JSON.stringify({ commit: COMMIT }));
    }
  };
  const stepCapture = async (file, args, opts) => {
    if (path.basename(args[0] ?? '') === 'publishPublic.js') {
      // Like publishPublic.js --dry-run: the notes come from CHANGELOG.md and release-notes/<tag>.md next to the
      // --notes-from file; without --notes-from it renders the "no listed changes" fallback.
      calls.step.push({ cmd: { file, args, cwd: opts.cwd }, env: opts.env });
      const i = args.indexOf('--notes-from');
      let changes = 'This release has no listed changes.';
      if (i >= 0) {
        const notesFile = path.join(path.dirname(args[i + 1]), 'release-notes', `${args[args.indexOf('--tag') + 1]}.md`);
        changes = fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8').trim() : '* a fix';
      }
      if (dropNotes) changes = 'This release has behind-the-scenes improvements.';
      return `DRY RUN: would publish\n--- release notes ---\n# Burrow 9.9.9\n\n## What's new\n\n${changes}\n`;
    }
    calls.capture.push({ file, args, env: opts.env });
    const command = args[2];
    const dry = args.includes('--dry-run');
    return rpOutput[`${command}${dry ? ':dry' : ''}`] ?? '';
  };
  // release-please 17 "installed" in the tools folder
  const tools = path.join(local, 'burrow-release', 'tools', 'release-please-17', 'node_modules', 'release-please');
  fs.mkdirSync(path.join(tools, 'build', 'src', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(tools, 'package.json'), JSON.stringify({ version: '17.11.2' }));
  fs.writeFileSync(path.join(tools, 'build', 'src', 'bin', 'release-please.js'), '');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  return { calls, exec, step, stepCapture };
}

// Adds the answers of a clean main checkout at MAIN (git at the repo root) to a fake PC's exec.
function onMain(pc, root, extra = async () => undefined) {
  return async (file, args, opts = {}) => {
    const got = await extra(file, args, opts);
    if (got !== undefined) return got;
    if (file === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { stdout: `${root}\n` };
    if (file === 'git' && args[0] === 'symbolic-ref') return { stdout: 'main\n' };
    if (file === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD' && opts.cwd === root) return { stdout: `${MAIN}\n` };
    if (file === 'gh' && args[0] === 'pr' && args.includes('merge')) throw new Error('must never merge');
    return pc.exec(file, args, opts);
  };
}

describe('runAuto on a fake Windows ARM64 PC', () => {
  const base = (pc, extra = {}) => ({
    env: { LOCALAPPDATA: path.join(tmp, 'local'), PATH: 'p', GH_TOKEN: 'shell-token-must-not-leak' },
    platform: 'win32',
    arch: 'arm64',
    nodeVersion: 'v24.15.0',
    execPath: 'node',
    root: path.join(tmp, 'repo'),
    npmCli: 'npm-cli.js',
    exec: pc.exec,
    step: pc.step,
    stepCapture: pc.stepCapture,
    pathMod: path,
    ensureNode: async ({ cacheDir }) => {
      fs.mkdirSync(cacheDir, { recursive: true });
      const f = path.join(cacheDir, 'node-x64.exe');
      fs.writeFileSync(f, 'MZnode');
      return f;
    },
    ...extra,
  });

  it('refuses an --out-dir inside the repository', async () => {
    const pc = fakePc({ root: path.join(tmp, 'repo'), local: path.join(tmp, 'local') });
    await expect(runAuto(parseAutoArgs(['--tag', 'v9.9.9', '--from', 'x64', '--out-dir', path.join(tmp, 'repo', 'out')]), { ...base(pc), log: () => {} })).rejects.toThrow(/outside the repository/);
    expect(pc.calls.step).toHaveLength(0);
  });

  it('tag stage: 0 releases to tag explains that the release PR is not merged, and never prints the token', async () => {
    const pc = fakePc({ root: path.join(tmp, 'repo'), local: path.join(tmp, 'local'), tagExists: false, rpOutput: { 'github-release:dry': 'Would tag 0 releases:' } });
    const logs = [];
    await expect(runAuto(parseAutoArgs(['--tag', 'v9.9.9', '--from', 'tag']), { ...base(pc), log: (l) => logs.push(l) })).rejects.toThrow(/would tag 0 releases.*not merged.*--from tag/s);
    expect(pc.calls.capture).toHaveLength(1);
    const rp = pc.calls.capture[0];
    expect(rp.args.join(' ')).not.toContain(TOKEN);
    expect(rp.env.BURROW_RP_TOKEN).toBe(TOKEN);
    expect(rp.env.GH_TOKEN).toBeUndefined();
    expect(logs.join('\n')).not.toContain(TOKEN);
    expect(logs.join('\n')).toContain('--token=<from gh auth token>');
  });

  it('release-pr stage: shows the version, opens the PR and stops with the next command, never merging', async () => {
    const pc = fakePc({
      root: path.join(tmp, 'repo'),
      local: path.join(tmp, 'local'),
      rpOutput: { 'release-pr:dry': 'Would open 1 pull requests\ntitle: chore(main): release 9.9.9\nbody: ### Features\n* a thing\nupdates: 2\n', 'release-pr': '[ 7 ]' },
    });
    const exec = async (file, args, opts) => {
      if (file === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { stdout: `${path.join(tmp, 'repo')}\n` };
      if (file === 'git' && args[0] === 'symbolic-ref') return { stdout: 'main\n' };
      if (file === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') return { stdout: `${MAIN}\n` };
      if (file === 'gh' && args[0] === 'pr' && args.includes('merged')) return { stdout: '[]' };
      if (file === 'gh' && args[0] === 'pr' && args.includes('open')) return { stdout: JSON.stringify([{ number: 7, title: 'chore(main): release 9.9.9', url: 'https://github.com/x/pull/7' }]) };
      if (file === 'gh' && args[0] === 'pr' && args.includes('merge')) throw new Error('must never merge');
      return pc.exec(file, args, opts);
    };
    const logs = [];
    const res = await runAuto(parseAutoArgs(['--from', 'release-pr']), { ...base(pc), exec, log: (l) => logs.push(l) });
    expect(res.stoppedAt).toBe('release-pr');
    const text = logs.join('\n');
    expect(text).toContain('release-please would release v9.9.9');
    expect(text).toContain('Review and merge PR #7');
    expect(text).toContain('npm.cmd run release:auto -- --tag v9.9.9 --from tag');
    expect(text).toContain('This script merges the release PR only when you pass --merge-release-pr.');
    expect(pc.calls.capture.map((c) => c.args.includes('--dry-run'))).toEqual([true, false]);
    const state = readState(path.join(tmp, 'local', 'burrow-release', 'next', 'auto-state.json'), { tag: null });
    expect(state.stages['release-pr'].outputs).toMatchObject({ version: '9.9.9', pr: 7 });
  });

  it('x64 then arm64: builds, records hashes, and a later run skips what is still current', async () => {
    const pc = fakePc({ root: path.join(tmp, 'repo'), local: path.join(tmp, 'local') });
    const logs = [];
    const res = await runAuto(parseAutoArgs(['--tag', 'v9.9.9', '--from', 'x64']), { ...base(pc), log: (l) => logs.push(l) });
    expect(res.done).toBe(true);
    const shown = pc.calls.step.map((s) => path.basename(s.cmd.args[0]) + (s.cmd.args[1] ? ` ${s.cmd.args[1]}` : ''));
    expect(shown).toEqual(['npm-cli.js ci', 'npm-cli.js run', 'buildSidecar.js --minify', 'channelMarker.js --expect', 'smokeSidecar.js --sidecar', 'buildInstaller.js --target', 'npm-cli.js ci', 'releaseLocal.mjs --tag']);
    for (const s of pc.calls.step) {
      expect(Object.keys(s.env)).not.toContain('GH_TOKEN');
      expect(s.cmd.args.join(' ')).not.toContain(TOKEN);
    }
    const rl = pc.calls.step.find((s) => path.basename(s.cmd.args[0]) === 'releaseLocal.mjs');
    expect(rl.cmd.args).toContain('--dry-run');
    expect(rl.cmd.args).not.toContain('--publish');
    const stateFile = path.join(tmp, 'local', 'burrow-release', 'v9.9.9', 'auto-state.json');
    const state = readState(stateFile, { tag: 'v9.9.9' });
    expect(Object.keys(state.stages)).toEqual(['x64', 'arm64', 'after']);
    expect(Object.keys(state.stages.arm64.outputs.files).sort()).toEqual(['Burrow-Setup-arm64.exe', 'Burrow-Setup-x64.exe', 'SHA256SUMS.txt']);
    expect(logs.join('\n')).toContain('publish: skipped');

    // Resume: a run from the tag stage re-verifies the tag, then skips x64 and arm64 because nothing changed.
    pc.calls.step.length = 0;
    fs.writeFileSync(stateFile, JSON.stringify({ ...state, stages: { tag: { completedAt: 'x', inputs: { tag: 'v9.9.9' }, outputs: { commit: COMMIT, created: false } }, ...state.stages } }));
    const logs2 = [];
    await runAuto(parseAutoArgs(['--tag', 'v9.9.9', '--from', 'tag']), { ...base(pc), log: (l) => logs2.push(l) });
    expect(pc.calls.step).toHaveLength(0);
    expect(logs2.join('\n')).toMatch(/x64: skipped/);
    expect(logs2.join('\n')).toMatch(/arm64: skipped/);

    // A staged file that changed makes arm64 run again.
    fs.appendFileSync(path.join(tmp, 'local', 'burrow-release', 'v9.9.9', 'public', 'Burrow-Setup-arm64.exe'), 'x');
    await runAuto(parseAutoArgs(['--tag', 'v9.9.9', '--from', 'tag']), { ...base(pc), log: () => {} });
    expect(pc.calls.step.map((s) => path.basename(s.cmd.args[0]))).toEqual(['npm-cli.js', 'releaseLocal.mjs']);
  });

  it('refuses a real run without LOCALAPPDATA before any command', async () => {
    const pc = fakePc({ root: path.join(tmp, 'repo'), local: path.join(tmp, 'local') });
    const b = base(pc);
    for (const LOCALAPPDATA of [undefined, '', '  ']) {
      await expect(runAuto(parseAutoArgs(['--tag', 'v9.9.9', '--from', 'x64']), { ...b, env: { PATH: 'p', LOCALAPPDATA }, log: () => {} })).rejects.toThrow(/LOCALAPPDATA is not set/);
    }
    expect(pc.calls.exec).toHaveLength(0);
    expect(fs.existsSync(path.join(process.cwd(), '%LOCALAPPDATA%'))).toBe(false);
  });

  it('refuses an --out-dir that reaches into the repository through a link', async () => {
    const pc = fakePc({ root: path.join(tmp, 'repo'), local: path.join(tmp, 'local') });
    fs.symlinkSync(path.join(tmp, 'repo'), path.join(tmp, 'link'), 'dir');
    await expect(runAuto(parseAutoArgs(['--tag', 'v9.9.9', '--from', 'x64', '--out-dir', path.join(tmp, 'link', 'out')]), { ...base(pc), log: () => {} })).rejects.toThrow(/outside the repository/);
    expect(pc.calls.step).toHaveLength(0);
  });

  it('refuses a second concurrent run on the same release folder and frees the lock when done', async () => {
    const pc = fakePc({ root: path.join(tmp, 'repo'), local: path.join(tmp, 'local') });
    const dir = path.join(tmp, 'local', 'burrow-release', 'v9.9.9');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, LOCK_FILE), JSON.stringify({ pid: 4242, startedAt: new Date().toISOString() }));
    await expect(runAuto(parseAutoArgs(['--tag', 'v9.9.9', '--from', 'x64']), { ...base(pc), log: () => {} })).rejects.toThrow(/Another release:auto run holds/);
    expect(pc.calls.step).toHaveLength(0);
    fs.rmSync(path.join(dir, LOCK_FILE));
    await runAuto(parseAutoArgs(['--tag', 'v9.9.9', '--from', 'x64']), { ...base(pc), log: () => {} });
    expect(fs.existsSync(path.join(dir, LOCK_FILE))).toBe(false);
  });

  it('x64 resume re-hashes the node.exe the sidecar was built with', async () => {
    const pc = fakePc({ root: path.join(tmp, 'repo'), local: path.join(tmp, 'local') });
    await runAuto(parseAutoArgs(['--tag', 'v9.9.9', '--from', 'x64']), { ...base(pc), log: () => {} });
    const stateFile = path.join(tmp, 'local', 'burrow-release', 'v9.9.9', 'auto-state.json');
    const state = readState(stateFile, { tag: 'v9.9.9' });
    expect(state.stages.x64.outputs.nodeSha256).toBe(sha(Buffer.from('MZnode')));
    fs.writeFileSync(stateFile, JSON.stringify({ ...state, stages: { tag: { completedAt: 'x', inputs: { tag: 'v9.9.9' }, outputs: { commit: COMMIT, created: false } }, ...state.stages } }));
    const logs = [];
    fs.appendFileSync(state.stages.x64.outputs.nodeExe, 'tampered');
    await runAuto(parseAutoArgs(['--tag', 'v9.9.9', '--from', 'tag']), { ...base(pc), log: (l) => logs.push(l) });
    expect(logs.join('\n')).toMatch(/x64: running \(its outputs changed or are gone\)/);
  });

  it('a dirty or moved worktree is recreated, and a folder that is not a worktree is refused', async () => {
    const pc = fakePc({ root: path.join(tmp, 'repo'), local: path.join(tmp, 'local') });
    await runAuto(parseAutoArgs(['--tag', 'v9.9.9', '--from', 'x64']), { ...base(pc), log: () => {} });
    const wtX64 = path.join(tmp, 'local', 'burrow-release', 'v9.9.9', 'wt-x64');
    for (const [kind, answer] of [
      ['dirty', (args) => (args[0] === 'status' ? { stdout: ' M package.json\n' } : undefined)],
      ['moved', (args) => (args[0] === 'rev-parse' && args[1] === 'HEAD' ? { stdout: `${MAIN}\n` } : undefined)],
    ]) {
      let once = true;
      const exec = async (file, args, opts = {}) => {
        if (file === 'git' && opts.cwd === wtX64 && once) {
          const got = answer(args);
          if (got) {
            if (args[0] === 'status' || kind === 'moved') once = false;
            return got;
          }
        }
        return pc.exec(file, args, opts);
      };
      pc.calls.exec.length = 0;
      const logs = [];
      await runAuto(parseAutoArgs(['--tag', 'v9.9.9', '--from', 'x64']), { ...base(pc), exec, log: (l) => logs.push(l) });
      expect(logs.join('\n')).toContain(kind === 'dirty' ? 'is not clean; recreating it' : 'is at another commit; recreating it');
      const gitCalls = pc.calls.exec.filter((c) => c.file === 'git').map((c) => c.args.join(' '));
      expect(gitCalls).toContain(`worktree remove --force ${wtX64}`);
      expect(gitCalls).toContain(`worktree add --detach ${wtX64} ${COMMIT}`);
    }
    // A folder in the worktree's place that git does not know is never deleted.
    const pc2 = fakePc({ root: path.join(tmp, 'repo'), local: path.join(tmp, 'local2') });
    const b2 = base(pc2);
    fs.mkdirSync(path.join(tmp, 'local2', 'burrow-release', 'v9.9.9', 'wt-x64'), { recursive: true });
    await expect(runAuto(parseAutoArgs(['--tag', 'v9.9.9', '--from', 'x64']), { ...b2, env: { ...b2.env, LOCALAPPDATA: path.join(tmp, 'local2') }, log: () => {} })).rejects.toThrow(/exists but is not a git worktree/);
  });

  it('tag stage: an existing tag whose commit is not on main is refused', async () => {
    const pc = fakePc({ root: path.join(tmp, 'repo'), local: path.join(tmp, 'local') });
    const exec = async (file, args, opts) => {
      if (file === 'git' && args[0] === 'merge-base') throw Object.assign(new Error('not ancestor'), { code: 1 });
      return pc.exec(file, args, opts);
    };
    await expect(runAuto(parseAutoArgs(['--tag', 'v9.9.9', '--from', 'tag']), { ...base(pc), exec, log: () => {} })).rejects.toThrow(/exists but its commit c0ffee7 is not on main/);
    expect(pc.calls.step).toHaveLength(0);
    expect(pc.calls.capture).toHaveLength(0);
  });

  it('release-pr stage: an existing tag needs no release PR and release-please is not called', async () => {
    const root = path.join(tmp, 'repo');
    const pc = fakePc({ root, local: path.join(tmp, 'local') });
    const logs = [];
    const res = await runAuto(parseAutoArgs(['--tag', 'v9.9.9', '--from', 'release-pr']), { ...base(pc), exec: onMain(pc, root), log: (l) => logs.push(l) });
    expect(res.done).toBe(true);
    expect(logs.join('\n')).toContain('The tag v9.9.9 already exists; no release PR is needed.');
    expect(pc.calls.capture).toHaveLength(0);
    const state = readState(path.join(tmp, 'local', 'burrow-release', 'v9.9.9', 'auto-state.json'), { tag: 'v9.9.9' });
    expect(state.stages['release-pr'].outputs).toMatchObject({ version: '9.9.9', pr: null, alreadyTagged: true });
  });

  it('release-pr stage: a merged, untagged release PR goes on to the tag stage under the tag\'s state', async () => {
    const root = path.join(tmp, 'repo');
    const pc = fakePc({ root, local: path.join(tmp, 'local'), tagExists: false, rpOutput: { 'github-release:dry': 'Would tag 0 releases:' } });
    const exec = onMain(pc, root, async (file, args) => {
      if (file === 'gh' && args[0] === 'pr' && args.includes('merged')) return { stdout: JSON.stringify([{ number: 7, title: 'chore(main): release 9.9.9' }]) };
      if (file === 'git' && args[0] === 'show' && args[1] === 'origin/main:package.json') return { stdout: JSON.stringify({ version: '9.9.9' }) };
      return undefined;
    });
    const logs = [];
    await expect(runAuto(parseAutoArgs(['--from', 'release-pr']), { ...base(pc), exec, log: (l) => logs.push(l) })).rejects.toThrow(/would tag 0 releases/);
    expect(logs.join('\n')).toContain('Release PR #7 (chore(main): release 9.9.9) is merged and not tagged yet; going on to the tag stage.');
    expect(logs.join('\n')).toMatch(/== tag: running/);
    // Only the tag stage's github-release dry run ran; release-pr was not asked to open anything.
    expect(pc.calls.capture.map((c) => c.args[2])).toEqual(['github-release']);
    const next = readState(path.join(tmp, 'local', 'burrow-release', 'next', 'auto-state.json'), { tag: null });
    expect(next.stages['release-pr'].outputs).toMatchObject({ version: '9.9.9', pr: 7, merged: true });
  });

  it('checks with an existing --tag run on the tag commit in the release worktree and are recorded for it', async () => {
    const root = path.join(tmp, 'repo');
    const pc = fakePc({ root, local: path.join(tmp, 'local') });
    const logs = [];
    await runAuto(parseAutoArgs(['--tag', 'v9.9.9', '--from', 'checks']), { ...base(pc), exec: onMain(pc, root), log: (l) => logs.push(l) });
    const wtArm = path.join(tmp, 'local', 'burrow-release', 'v9.9.9', 'wt-arm64');
    const checks = pc.calls.step.filter((st) => st.cmd.label === 'lint' || st.cmd.label === 'unit tests');
    expect(checks).toHaveLength(2);
    for (const c of checks) expect(c.cmd.cwd).toBe(wtArm);
    expect(logs.join('\n')).toContain(`Running the checks on the tag commit c0ffee7 in ${wtArm}.`);
    const state = readState(path.join(tmp, 'local', 'burrow-release', 'v9.9.9', 'auto-state.json'), { tag: 'v9.9.9' });
    expect(state.stages.checks.inputs).toEqual({ commit: COMMIT, tag: 'v9.9.9' });
    expect(state.stages.checks.outputs.commit).toBe(COMMIT);
    expect(Object.keys(state.stages)).toEqual(['checks', 'release-pr', 'tag', 'x64', 'arm64', 'after']);
  });

  it('after stage: when nothing was published it prints only the publish command', async () => {
    const pc = fakePc({ root: path.join(tmp, 'repo'), local: path.join(tmp, 'local') });
    const logs = [];
    await runAuto(parseAutoArgs(['--tag', 'v9.9.9', '--from', 'x64']), { ...base(pc), log: (l) => logs.push(l) });
    const text = logs.join('\n');
    expect(text).toContain('npm.cmd run release:auto -- --tag v9.9.9 --from publish --publish');
    expect(text).not.toContain('npm.cmd run release:gumroad -- --tag v9.9.9 --publish');
    expect(text).not.toContain('git worktree remove');
  });

  describe('publish', () => {
    const stateFileOf = () => path.join(tmp, 'local', 'burrow-release', 'v9.9.9', 'auto-state.json');
    const stage = async (pcOpts = {}, { checks = true } = {}) => {
      const pc = fakePc({ root: path.join(tmp, 'repo'), local: path.join(tmp, 'local'), ...pcOpts });
      await runAuto(parseAutoArgs(['--tag', 'v9.9.9', '--from', 'x64']), { ...base(pc), log: () => {} });
      if (checks) writeState(stateFileOf(), recordStage(readState(stateFileOf(), { tag: 'v9.9.9' }), 'checks', { inputs: { commit: COMMIT, tag: 'v9.9.9' }, outputs: { commit: COMMIT, gitleaks: true } }));
      pc.calls.step.length = 0;
      return pc;
    };
    const publishSteps = (pc) => pc.calls.step.filter((s) => path.basename(s.cmd.args[0]) === 'publishPublic.js');

    it('a wrong typed answer cancels after the dry run; nothing is published and no token is handed out', async () => {
      const pc = await stage();
      const logs = [];
      const res = await runAuto(parseAutoArgs(['--tag', 'v9.9.9', '--from', 'publish', '--publish']), { ...base(pc), isTTY: true, prompt: async () => 'yes', log: (l) => logs.push(l) });
      expect(res.stoppedAt).toBe('publish');
      const steps = publishSteps(pc);
      expect(steps).toHaveLength(1);
      expect(steps[0].cmd.args).toContain('--dry-run');
      expect(steps[0].env.GH_TOKEN).toBeUndefined();
      expect(logs.join('\n')).toContain('Cancelled. Nothing was published.');
    });

    it('typing the tag publishes with GH_TOKEN for that one child, never as an argument', async () => {
      const pc = await stage();
      const logs = [];
      await runAuto(parseAutoArgs(['--tag', 'v9.9.9', '--from', 'publish', '--publish']), { ...base(pc), isTTY: true, prompt: async () => 'v9.9.9', log: (l) => logs.push(l) });
      const steps = publishSteps(pc);
      expect(steps.map((s) => s.cmd.args.includes('--dry-run'))).toEqual([true, false]);
      expect(steps[1].env.GH_TOKEN).toBe(TOKEN);
      expect(steps[1].cmd.args.join(' ')).not.toContain(TOKEN);
      expect(logs.join('\n')).not.toContain(TOKEN);
      const state = readState(path.join(tmp, 'local', 'burrow-release', 'v9.9.9', 'auto-state.json'), { tag: 'v9.9.9' });
      expect(state.stages.publish.outputs.published).toBe(true);
    });

    it('--yes without BURROW_RELEASE_CONFIRM publishes nothing; with it, it publishes without a question', async () => {
      const pc = await stage();
      await expect(runAuto(parseAutoArgs(['--tag', 'v9.9.9', '--from', 'publish', '--publish', '--yes']), { ...base(pc), isTTY: false, log: () => {} })).rejects.toThrow(/BURROW_RELEASE_CONFIRM/);
      expect(publishSteps(pc).every((s) => s.cmd.args.includes('--dry-run'))).toBe(true);
      pc.calls.step.length = 0;
      const b = base(pc);
      await runAuto(parseAutoArgs(['--tag', 'v9.9.9', '--from', 'publish', '--publish', '--yes']), { ...b, env: { ...b.env, BURROW_RELEASE_CONFIRM: 'v9.9.9' }, isTTY: false, prompt: async () => { throw new Error('must not ask'); }, log: () => {} });
      expect(publishSteps(pc).map((s) => s.cmd.args.includes('--dry-run'))).toEqual([true, false]);
    });

    it('refuses when a staged file changed since the arm64 stage, before any publish command', async () => {
      const pc = await stage();
      fs.appendFileSync(path.join(tmp, 'local', 'burrow-release', 'v9.9.9', 'public', 'Burrow-Setup-x64.exe'), 'x');
      await expect(runAuto(parseAutoArgs(['--tag', 'v9.9.9', '--from', 'publish', '--publish']), { ...base(pc), isTTY: true, prompt: async () => 'v9.9.9', log: () => {} })).rejects.toThrow(/changed since the arm64 stage/);
      expect(publishSteps(pc)).toHaveLength(0);
    });

    it('never publishes from a folder the state file names instead of this release\'s folder', async () => {
      const pc = await stage();
      const stateFile = path.join(tmp, 'local', 'burrow-release', 'v9.9.9', 'auto-state.json');
      const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      const evil = path.join(tmp, 'elsewhere');
      fs.cpSync(st.stages.arm64.outputs.publicDir, evil, { recursive: true });
      st.stages.arm64.outputs.publicDir = evil;
      fs.writeFileSync(stateFile, JSON.stringify(st));
      await expect(runAuto(parseAutoArgs(['--tag', 'v9.9.9', '--from', 'publish', '--publish']), { ...base(pc), isTTY: true, prompt: async () => 'v9.9.9', log: () => {} })).rejects.toThrow(/not this release's folder/);
      expect(publishSteps(pc)).toHaveLength(0);
    });

    it('re-checks the staged files after the question', async () => {
      const pc = await stage();
      const prompt = async () => {
        fs.appendFileSync(path.join(tmp, 'local', 'burrow-release', 'v9.9.9', 'public', 'SHA256SUMS.txt'), '\n');
        return 'v9.9.9';
      };
      await expect(runAuto(parseAutoArgs(['--tag', 'v9.9.9', '--from', 'publish', '--publish']), { ...base(pc), isTTY: true, prompt, log: () => {} })).rejects.toThrow(/changed/);
      expect(publishSteps(pc).every((s) => s.cmd.args.includes('--dry-run'))).toBe(true);
    });

    it('both publish runs pass --notes-from <release worktree>/CHANGELOG.md, and the curated notes reach the dry run', async () => {
      const pc = await stage({ curated: 'Press Alt+J to open Javi.\n- One menu for your money and your days.\n' });
      const logs = [];
      await runAuto(parseAutoArgs(['--tag', 'v9.9.9', '--from', 'publish', '--publish']), { ...base(pc), isTTY: true, prompt: async () => 'v9.9.9', log: (l) => logs.push(l) });
      const wtArm = path.join(tmp, 'local', 'burrow-release', 'v9.9.9', 'wt-arm64');
      const publicDir = path.join(tmp, 'local', 'burrow-release', 'v9.9.9', 'public');
      const steps = publishSteps(pc);
      const want = [path.join(wtArm, 'scripts', 'release', 'publishPublic.js'), '--tag', 'v9.9.9', '--assets-dir', publicDir, '--notes-from', path.join(wtArm, 'CHANGELOG.md')];
      expect(steps.map((st) => st.cmd.args)).toEqual([[...want, '--dry-run'], want]);
      expect(steps.map((st) => st.cmd.cwd)).toEqual([wtArm, wtArm]);
      expect(steps[0].env.GH_TOKEN).toBeUndefined();
    });

    it('refuses before the question when the dry run does not show the curated notes', async () => {
      const pc = await stage({ curated: 'Press Alt+J to open Javi.\n', dropNotes: true });
      let asked = false;
      await expect(
        runAuto(parseAutoArgs(['--tag', 'v9.9.9', '--from', 'publish', '--publish']), { ...base(pc), isTTY: true, prompt: async () => { asked = true; return 'v9.9.9'; }, log: () => {} }),
      ).rejects.toThrow(/did not render release-notes\/v9\.9\.9\.md.*Nothing was published/);
      expect(asked).toBe(false);
      expect(publishSteps(pc).map((st) => st.cmd.args.includes('--dry-run'))).toEqual([true]);
    });

    it('without a terminal and without --yes it publishes nothing and hands out no token', async () => {
      const pc = await stage();
      const b = base(pc);
      await expect(
        runAuto(parseAutoArgs(['--tag', 'v9.9.9', '--from', 'publish', '--publish']), { ...b, env: { ...b.env, BURROW_RELEASE_CONFIRM: 'v9.9.9' }, isTTY: false, prompt: async () => { throw new Error('must not ask'); }, log: () => {} }),
      ).rejects.toThrow(/type the tag in a terminal.*Nothing was published/);
      const steps = publishSteps(pc);
      expect(steps.map((st) => st.cmd.args.includes('--dry-run'))).toEqual([true]);
      for (const st of steps) expect(st.env.GH_TOKEN).toBeUndefined();
      expect(pc.calls.exec.some((c) => c.file === 'gh' && c.args.join(' ') === 'auth token')).toBe(false);
      expect(readState(stateFileOf(), { tag: 'v9.9.9' }).stages.publish).toBeUndefined();
    });

    it('refuses when the release worktree moved, has changes, or the arm64 record is for another commit', async () => {
      const wtArm = path.join(tmp, 'local', 'burrow-release', 'v9.9.9', 'wt-arm64');
      const cases = [
        [(args) => (args[0] === 'rev-parse' && args[1] === 'HEAD' ? { stdout: `${MAIN}\n` } : undefined), /is at beef001, not the tag commit c0ffee7/],
        [(args) => (args[0] === 'status' ? { stdout: '?? stray.txt\n' } : undefined), /release worktree .* has changes/],
      ];
      for (const [answer, err] of cases) {
        const pc = await stage();
        const exec = async (file, args, opts = {}) => (file === 'git' && opts.cwd === wtArm && answer(args)) || pc.exec(file, args, opts);
        await expect(runAuto(parseAutoArgs(['--tag', 'v9.9.9', '--from', 'publish', '--publish']), { ...base(pc), exec, isTTY: true, prompt: async () => 'v9.9.9', log: () => {} })).rejects.toThrow(err);
        expect(publishSteps(pc)).toHaveLength(0);
        fs.rmSync(path.join(tmp, 'local'), { recursive: true, force: true });
      }
      const pc = await stage();
      const st = JSON.parse(fs.readFileSync(stateFileOf(), 'utf8'));
      st.stages.arm64.inputs.commit = MAIN;
      fs.writeFileSync(stateFileOf(), JSON.stringify(st));
      await expect(runAuto(parseAutoArgs(['--tag', 'v9.9.9', '--from', 'publish', '--publish']), { ...base(pc), isTTY: true, prompt: async () => 'v9.9.9', log: () => {} })).rejects.toThrow(/arm64 stage was not recorded for the tag commit/);
      expect(publishSteps(pc)).toHaveLength(0);
    });

    it('needs a checks record for the tag commit, or --checks-done-manually, and says which in the prompt', async () => {
      const pc = await stage({}, { checks: false });
      const run = (args, logs = []) => runAuto(parseAutoArgs(['--tag', 'v9.9.9', '--from', 'publish', '--publish', ...args]), { ...base(pc), isTTY: true, prompt: async () => 'nope', log: (l) => logs.push(l) });
      await expect(run([])).rejects.toThrow(/No checks stage was recorded for the tag commit c0ffee7.*--from checks.*--checks-done-manually/);
      expect(publishSteps(pc)).toHaveLength(0);

      // A record for an older main commit (before the release PR merged) does not count.
      const nextFile = path.join(tmp, 'local', 'burrow-release', 'next', 'auto-state.json');
      writeState(nextFile, recordStage(emptyState(null), 'checks', { inputs: { commit: MAIN }, outputs: { commit: MAIN } }));
      await expect(run([])).rejects.toThrow(/No checks stage/);

      const manual = [];
      await run(['--checks-done-manually'], manual);
      expect(manual.join('\n')).toMatch(/--checks-done-manually: the local checks \(lint, test, build, Playwright, gitleaks\) stand in for CI and were NOT recorded for the tag commit c0ffee7/);

      // A record for the tag commit in the pending state is accepted.
      writeState(nextFile, recordStage(emptyState(null), 'checks', { inputs: { commit: COMMIT }, outputs: { commit: COMMIT, gitleaks: true } }));
      const recorded = [];
      await run([], recorded);
      expect(recorded.join('\n')).toMatch(/The local checks ran on the tag commit c0ffee7/);
    });

    it('after a publish the after stage prints the post-publish steps', async () => {
      const pc = await stage();
      const logs = [];
      await runAuto(parseAutoArgs(['--tag', 'v9.9.9', '--from', 'publish', '--publish']), { ...base(pc), isTTY: true, prompt: async () => 'v9.9.9', log: (l) => logs.push(l) });
      const text = logs.join('\n');
      expect(text).toContain('npm.cmd run release:gumroad -- --tag v9.9.9 --publish');
      expect(text).toContain('git worktree remove');
      expect(text).not.toContain('is not published yet');
    });
  });
});

// --- --merge-pr and --merge-release-pr ---------------------------------------------------------------------------

const NEW_MAIN = 'abc123'.padEnd(40, '9');
const PR_HEAD = 'f00d00'.padEnd(40, '2');
const goodPr = (over = {}) => ({
  title: 'feat(x): add y',
  body: 'Adds y.\n\nfeat(x): add y',
  state: 'OPEN',
  isDraft: false,
  baseRefName: 'main',
  headRefName: 'feat/x',
  headRefOid: PR_HEAD,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  ...over,
});

// A fake GitHub plus the local main: gh pr view / merge, git pull, and the two heads that move with them.
function mergeWorld(prs) {
  const world = { head: MAIN, origin: MAIN, prs, calls: [], bodies: {} };
  world.answer = async (file, args, opts = {}) => {
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'view') {
      world.calls.push(`gh ${args.join(' ')}`);
      const n = Number(args[2]);
      const pr = world.prs[n];
      if (!pr) throw Object.assign(new Error('gh: Could not resolve to a PullRequest'), { stderr: 'not found' });
      if (args[args.indexOf('--json') + 1].includes('mergeCommit')) {
        return { stdout: JSON.stringify({ state: pr.merged ? 'MERGED' : pr.state, mergeCommit: pr.merged ? { oid: NEW_MAIN } : null }) };
      }
      return { stdout: JSON.stringify({ number: n, ...pr }) };
    }
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'merge') {
      world.calls.push(`gh ${args.join(' ')}`);
      const n = Number(args[2]);
      world.bodies[n] = fs.readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
      world.prs[n].merged = true;
      world.origin = NEW_MAIN;
      return { stdout: '' };
    }
    if (file === 'git' && args[0] === 'pull') {
      world.calls.push(`git ${args.join(' ')}`);
      world.head = world.origin;
      return { stdout: '' };
    }
    if (file === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD' && opts.cwd === path.join(tmp, 'repo')) return { stdout: `${world.head}\n` };
    if (file === 'git' && args[0] === 'rev-parse' && args[1] === 'origin/main') return { stdout: `${world.origin}\n` };
    return undefined;
  };
  world.merges = () => world.calls.filter((c) => c.startsWith('gh pr merge'));
  return world;
}

describe('merging pull requests', () => {
  it('parses --merge-pr (repeatable, comma-separated, unique) and --merge-release-pr', () => {
    expect(parseMergeNumbers(['5', '6,7', '5'])).toEqual([5, 6, 7]);
    expect(parseAutoArgs(['--merge-pr', '111', '--merge-pr', '112,113']).mergePrs).toEqual([111, 112, 113]);
    expect(parseAutoArgs([])).toMatchObject({ mergePrs: [], mergeReleasePr: false });
    expect(parseAutoArgs(['--merge-release-pr']).mergeReleasePr).toBe(true);
    for (const bad of ['0', '-3', 'abc', '1.5', '', '4,,5']) expect(() => parseAutoArgs([`--merge-pr=${bad}`])).toThrow(/pull request numbers/);
    expect(() => parseAutoArgs(['--merge-pr'])).toThrow();
  });
  it('--yes also goes with the merge flags, but not alone', () => {
    expect(parseAutoArgs(['--merge-pr', '5', '--yes']).yes).toBe(true);
    expect(parseAutoArgs(['--merge-release-pr', '--yes']).yes).toBe(true);
    expect(() => parseAutoArgs(['--yes'])).toThrow(/--publish, --merge-pr and --merge-release-pr/);
  });
  it('refuses a merge flag with a --from that never reaches its place in the run', () => {
    expect(() => parseAutoArgs(['--merge-pr', '5', '--tag', 'v1.2.0', '--from', 'tag'])).toThrow(/before the checks stage/);
    expect(() => parseAutoArgs(['--merge-release-pr', '--tag', 'v1.2.0', '--from', 'tag'])).toThrow(/after the release-pr stage/);
    expect(parseAutoArgs(['--merge-pr', '5', '--from', 'checks']).mergePrs).toEqual([5]);
    expect(parseAutoArgs(['--merge-release-pr', '--from', 'release-pr']).mergeReleasePr).toBe(true);
  });
  it('accepts only an open, non-draft PR into main that is MERGEABLE', () => {
    const ok = { number: 5, ...goodPr() };
    expect(mergeRefusal(ok, 5)).toBeNull();
    expect(mergeRefusal({ ...ok, mergeStateStatus: 'UNSTABLE' }, 5)).toBeNull();
    expect(mergeRefusal({ ...ok, isDraft: true }, 5)).toMatch(/draft/);
    expect(mergeRefusal({ ...ok, state: 'MERGED' }, 5)).toMatch(/not open \(state MERGED\)/);
    expect(mergeRefusal({ ...ok, state: 'CLOSED' }, 5)).toMatch(/not open/);
    expect(mergeRefusal({ ...ok, baseRefName: 'develop' }, 5)).toMatch(/base is "develop", not main/);
    expect(mergeRefusal({ ...ok, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }, 5)).toMatch(/CONFLICTING, not MERGEABLE \(merge state DIRTY\)/);
    expect(mergeRefusal({ ...ok, mergeable: 'UNKNOWN' }, 5)).toMatch(/UNKNOWN, not MERGEABLE/);
    expect(mergeRefusal({ ...ok, headRefName: 'main' }, 5)).toMatch(/head branch/);
    expect(mergeRefusal({ ...ok, headRefOid: 'abc' }, 5)).toMatch(/head commit/);
    expect(mergeRefusal({ ...ok, number: 6 }, 5)).toMatch(/answered for PR #6/);
    expect(mergeRefusal(null, 5)).toMatch(/did not return it/);
    expect(mergeRefusal({ ...ok, title: 'chore(main): release 1.4.0' }, 5, { releaseVersion: '1.4.0' })).toBeNull();
    expect(mergeRefusal({ ...ok, title: 'feat: sneaky' }, 5, { releaseVersion: '1.4.0' })).toMatch(/not "chore\(main\): release 1.4.0"/);
    for (const msg of [mergeRefusal({ ...ok, isDraft: true }, 5)]) expect(msg).toMatch(/Nothing was merged\.$/);
  });
  it('builds the squash subject like GitHub and checks the typed number', () => {
    expect(squashSubject('feat(x): add y', 5)).toBe('feat(x): add y (#5)');
    expect(typedNumberMatches(' 5\n', 5)).toBe(true);
    for (const a of ['', '05', '#5', '5 5', 'yes', null, undefined]) expect(typedNumberMatches(a, 5)).toBe(false);
  });

  describe('--merge-pr on a fake PC', () => {
    const setup = (prs, over = {}) => {
      const root = path.join(tmp, 'repo');
      const pc = fakePc({ root, local: path.join(tmp, 'local'), tagExists: false, rpOutput: { 'release-pr:dry': 'Would open 0 pull requests\n' }, ...over });
      const world = mergeWorld(prs);
      const exec = onMain(pc, root, async (file, args, o) => {
        if (file === 'gh' && args[0] === 'pr' && args[1] === 'list') return { stdout: '[]' };
        return world.answer(file, args, o);
      });
      const prompts = [];
      const opts = (answer, extra = {}) => ({
        env: { LOCALAPPDATA: path.join(tmp, 'local'), PATH: 'p' },
        platform: 'win32',
        arch: 'arm64',
        nodeVersion: 'v24.15.0',
        execPath: 'node',
        root,
        npmCli: 'npm-cli.js',
        exec,
        step: pc.step,
        stepCapture: pc.stepCapture,
        pathMod: path,
        isTTY: true,
        prompt: async (q) => {
          prompts.push(q);
          return answer;
        },
        ...extra,
      });
      return { pc, world, prompts, opts };
    };
    const nextState = () => readState(path.join(tmp, 'local', 'burrow-release', 'next', 'auto-state.json'), { tag: null });

    it('refuses a draft, a closed, a wrong-base or a not mergeable PR, merges nothing and runs no check', async () => {
      const cases = {
        draft: [goodPr({ isDraft: true }), /it is a draft/],
        closed: [goodPr({ state: 'CLOSED' }), /not open \(state CLOSED\)/],
        merged: [goodPr({ state: 'MERGED' }), /not open \(state MERGED\)/],
        base: [goodPr({ baseRefName: 'release' }), /base is "release", not main/],
        conflict: [goodPr({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }), /CONFLICTING, not MERGEABLE/],
        unknown: [goodPr({ mergeable: 'UNKNOWN' }), /UNKNOWN, not MERGEABLE/],
      };
      for (const [name, [pr, message]] of Object.entries(cases)) {
        const { pc, world, prompts, opts } = setup({ 5: pr });
        await expect(runAuto(parseAutoArgs(['--from', 'checks', '--merge-pr', '5']), { ...opts('5'), log: () => {} }), name).rejects.toThrow(message);
        expect(world.merges(), name).toHaveLength(0);
        expect(prompts, name).toHaveLength(0);
        expect(pc.calls.step, name).toHaveLength(0);
      }
      const gone = setup({});
      await expect(runAuto(parseAutoArgs(['--from', 'checks', '--merge-pr', '9']), { ...gone.opts('9'), log: () => {} })).rejects.toThrow(/Could not read PR #9.*Nothing was merged/);
    });

    it('prints the title and head branch, asks for the number, and cancels on anything else', async () => {
      const { pc, world, prompts, opts } = setup({ 5: goodPr() });
      const logs = [];
      const res = await runAuto(parseAutoArgs(['--from', 'checks', '--merge-pr', '5']), { ...opts('yes'), log: (l) => logs.push(l) });
      expect(res.stoppedAt).toBe('merge-pr');
      expect(prompts).toEqual(["Merge PR #5 'feat(x): add y' into main? Type the number 5 to confirm (anything else cancels): "]);
      const text = logs.join('\n');
      expect(text).toContain('PR #5: feat(x): add y');
      expect(text).toContain('head branch feat/x');
      expect(text).toContain('Cancelled. PR #5 was not merged.');
      expect(world.merges()).toHaveLength(0);
      expect(world.calls.some((c) => c.startsWith('git pull'))).toBe(false);
      expect(pc.calls.step).toHaveLength(0);
      expect(nextState().merges).toBeUndefined();
    });

    it('without a terminal it needs --yes, and says so before merging anything', async () => {
      const { world, prompts, opts } = setup({ 5: goodPr() });
      await expect(runAuto(parseAutoArgs(['--from', 'checks', '--merge-pr', '5']), { ...opts('5', { isTTY: false }), log: () => {} })).rejects.toThrow(/needs you to type its number in a terminal \(or --yes\)\. Nothing was merged\./);
      expect(prompts).toHaveLength(0);
      expect(world.merges()).toHaveLength(0);
    });

    it('merges with a squash, the PR title and body, deletes only its head, pulls main, records it and runs the checks on the new main', async () => {
      const { pc, world, prompts, opts } = setup({ 5: goodPr() });
      const logs = [];
      const res = await runAuto(parseAutoArgs(['--from', 'checks', '--merge-pr', '5']), { ...opts(' 5 '), log: (l) => logs.push(l) });
      expect(prompts).toHaveLength(1);
      expect(res.stoppedAt).toBe('release-pr'); // release-please has nothing to release in this fake
      const merge = world.merges();
      expect(merge).toHaveLength(1);
      expect(merge[0]).toContain('pr merge 5 -R ChristianMunoz31/burrow --squash --delete-branch');
      expect(merge[0]).toContain(`--match-head-commit ${PR_HEAD}`);
      expect(merge[0]).toContain('--subject feat(x): add y (#5)');
      expect(merge[0]).not.toMatch(/--admin|--force|--auto|--rebase|--merge /);
      expect(world.bodies[5]).toBe('Adds y.\n\nfeat(x): add y');
      // The order is: read, merge, read the merge commit, pull.
      const kinds = world.calls.map((c) => c.split(' ').slice(0, c.startsWith('gh') ? 4 : 2).join(' '));
      expect(kinds).toEqual(['gh pr view 5', 'gh pr merge 5', 'gh pr view 5', 'git pull']);
      expect(world.calls[3]).toBe('git pull --ff-only origin main');
      // The checks ran on the pulled main, and the merge is recorded with its commit.
      expect(pc.calls.step.some((s) => s.cmd.label === 'lint')).toBe(true);
      const state = nextState();
      expect(state.merges['5']).toMatchObject({ number: 5, title: 'feat(x): add y', sha: NEW_MAIN });
      expect(state.stages.checks.inputs.commit).toBe(NEW_MAIN);
      expect(logs.join('\n')).toContain(`Merged PR #5 into main as ${NEW_MAIN.slice(0, 7)}.`);
      expect(fs.readdirSync(path.join(tmp, 'local', 'burrow-release', 'next')).some((n) => n.startsWith('merge-pr-'))).toBe(false);
    });

    it('--yes confirms without a prompt, even without a terminal, and several PRs merge in order', async () => {
      const { world, prompts, opts } = setup({ 5: goodPr(), 6: goodPr({ title: 'fix(y): repair z', headRefName: 'fix/y' }) });
      const logs = [];
      await runAuto(parseAutoArgs(['--from', 'checks', '--merge-pr', '5,6', '--yes']), { ...opts('no', { isTTY: false }), log: (l) => logs.push(l) });
      expect(prompts).toHaveLength(0);
      expect(world.merges().map((c) => c.split(' ')[3])).toEqual(['5', '6']);
      expect(world.merges()[1]).toContain('--subject fix(y): repair z (#6)');
      expect(logs.join('\n')).toContain('Confirmed by --yes: merging PR #5.');
      expect(Object.keys(nextState().merges)).toEqual(['5', '6']);
    });

    it('a re-run does not merge a recorded PR again', async () => {
      const { world, opts } = setup({ 5: goodPr() });
      await runAuto(parseAutoArgs(['--from', 'checks', '--merge-pr', '5']), { ...opts('5'), log: () => {} });
      expect(world.merges()).toHaveLength(1);
      // The PR now shows as merged on GitHub; the recorded merge keeps the re-run from refusing or merging.
      const logs = [];
      await runAuto(parseAutoArgs(['--from', 'checks', '--merge-pr', '5']), { ...opts('5'), log: (l) => logs.push(l) });
      expect(world.merges()).toHaveLength(1);
      expect(logs.join('\n')).toContain(`PR #5 was merged by an earlier run (${NEW_MAIN.slice(0, 7)}); not merging it again.`);
    });

    it('a pull that fails says the merge is recorded, and the next run does not merge again', async () => {
      const { pc, world, opts } = setup({ 5: goodPr() });
      const answer = world.answer;
      const failing = onMain(pc, path.join(tmp, 'repo'), async (file, args, o) => {
        if (file === 'git' && args[0] === 'pull') throw new Error('not possible to fast-forward');
        return answer(file, args, o);
      });
      await expect(runAuto(parseAutoArgs(['--from', 'checks', '--merge-pr', '5']), { ...opts('5', { exec: failing }), log: () => {} })).rejects.toThrow(/PR #5 is merged on GitHub \(abc1239\) but git pull --ff-only origin main failed.*will not be repeated/s);
      expect(nextState().merges['5'].sha).toBe(NEW_MAIN);
    });

    it('--status lists a recorded merge', async () => {
      const { opts } = setup({ 5: goodPr() });
      await runAuto(parseAutoArgs(['--from', 'checks', '--merge-pr', '5']), { ...opts('5'), log: () => {} });
      const logs = [];
      await runAuto(parseAutoArgs(['--status']), { ...opts('5'), log: (l) => logs.push(l) });
      expect(logs.join('\n')).toMatch(/merged\s+PR #5 at abc1239/);
    });

    it('never calls gh pr merge without the flag', async () => {
      const { world, opts } = setup({ 5: goodPr() });
      await runAuto(parseAutoArgs(['--from', 'checks']), { ...opts('5'), log: () => {} });
      expect(world.calls).toEqual([]);
    });
  });

  describe('--merge-release-pr on a fake PC', () => {
    const releaseRp = { 'release-pr:dry': 'Would open 1 pull requests\ntitle: chore(main): release 9.9.9\nbody: ### Features\n* a thing\nupdates: 2\n', 'release-pr': '[ 7 ]', 'github-release:dry': 'Would tag 0 releases:' };
    const releasePr = (over = {}) => goodPr({ title: 'chore(main): release 9.9.9', body: '### Features\n* a thing', headRefName: 'release-please--branches--main', ...over });
    const setup = (prs) => {
      const root = path.join(tmp, 'repo');
      const pc = fakePc({ root, local: path.join(tmp, 'local'), tagExists: false, rpOutput: releaseRp });
      const world = mergeWorld(prs);
      const exec = onMain(pc, root, async (file, args, o) => {
        if (file === 'gh' && args[0] === 'pr' && args[1] === 'list') {
          if (args.includes('merged')) return { stdout: '[]' };
          return { stdout: JSON.stringify([{ number: 7, title: 'chore(main): release 9.9.9', url: 'https://github.com/x/pull/7' }]) };
        }
        if (file === 'git' && args[0] === 'show' && args[1] === 'origin/main:package.json') return { stdout: JSON.stringify({ version: '9.9.9' }) };
        return world.answer(file, args, o);
      });
      const prompts = [];
      const opts = (answer, extra = {}) => ({
        env: { LOCALAPPDATA: path.join(tmp, 'local'), PATH: 'p' },
        platform: 'win32',
        arch: 'arm64',
        nodeVersion: 'v24.15.0',
        execPath: 'node',
        root,
        npmCli: 'npm-cli.js',
        exec,
        step: pc.step,
        stepCapture: pc.stepCapture,
        pathMod: path,
        isTTY: true,
        prompt: async (q) => {
          prompts.push(q);
          return answer;
        },
        ...extra,
      });
      return { pc, world, prompts, opts };
    };

    it('merges the release PR after the dry-run summary and goes on to the tag stage in the same run', async () => {
      const { pc, world, prompts, opts } = setup({ 7: releasePr() });
      const logs = [];
      // The fake tag never appears, so the tag stage stops with its 0 releases error; what matters is that it ran.
      await expect(runAuto(parseAutoArgs(['--from', 'release-pr', '--merge-release-pr']), { ...opts('7'), log: (l) => logs.push(l) })).rejects.toThrow(/would tag 0 releases/);
      const text = logs.join('\n');
      expect(text.indexOf('release-please would release v9.9.9')).toBeGreaterThan(-1);
      expect(text.indexOf('release-please would release v9.9.9')).toBeLessThan(text.indexOf('PR #7: chore(main): release 9.9.9'));
      expect(prompts).toEqual(["Merge PR #7 'chore(main): release 9.9.9' into main? Type the number 7 to confirm (anything else cancels): "]);
      expect(world.merges()).toHaveLength(1);
      expect(world.merges()[0]).toContain('--subject chore(main): release 9.9.9 (#7)');
      expect(world.bodies[7]).toBe('### Features\n* a thing');
      expect(world.calls).toContain('git pull --ff-only origin main');
      expect(text).not.toContain('Review and merge PR #7');
      expect(text).toMatch(/== tag: running/);
      // release-please ran its dry run and the real one for release-pr, then the tag stage's github-release dry run.
      expect(pc.calls.capture.map((c) => c.args[2])).toEqual(['release-pr', 'release-pr', 'github-release']);
      // The merge is recorded in the pending state and followed the run into the tag's own state folder.
      const next = readState(path.join(tmp, 'local', 'burrow-release', 'next', 'auto-state.json'), { tag: null });
      expect(next.merges['7'].sha).toBe(NEW_MAIN);
      expect(next.stages['release-pr'].outputs).toMatchObject({ version: '9.9.9', pr: 7, merged: true });
      const tagged = readState(path.join(tmp, 'local', 'burrow-release', 'v9.9.9', 'auto-state.json'), { tag: 'v9.9.9' });
      expect(tagged.merges['7'].sha).toBe(NEW_MAIN);
    });

    it('--yes needs no terminal', async () => {
      const yes = setup({ 7: releasePr() });
      await expect(runAuto(parseAutoArgs(['--from', 'release-pr', '--merge-release-pr', '--yes']), { ...yes.opts('x', { isTTY: false }), log: () => {} })).rejects.toThrow(/would tag 0 releases/);
      expect(yes.prompts).toHaveLength(0);
      expect(yes.world.merges()).toHaveLength(1);
    });

    it('a wrong typed answer cancels and falls back to the manual stop', async () => {
      const no = setup({ 7: releasePr() });
      const logs = [];
      const res = await runAuto(parseAutoArgs(['--from', 'release-pr', '--merge-release-pr']), { ...no.opts('v9.9.9'), log: (l) => logs.push(l) });
      expect(res.stoppedAt).toBe('release-pr');
      expect(no.world.merges()).toHaveLength(0);
      const text = logs.join('\n');
      expect(text).toContain('Cancelled. PR #7 was not merged.');
      expect(text).toContain('Review and merge PR #7');
      expect(text).toContain('The release PR was not merged.');
    });

    it('refuses a release PR that is a draft or whose title is not the release, merging nothing', async () => {
      const draft = setup({ 7: releasePr({ isDraft: true }) });
      await expect(runAuto(parseAutoArgs(['--from', 'release-pr', '--merge-release-pr']), { ...draft.opts('7'), log: () => {} })).rejects.toThrow(/Not merging PR #7: it is a draft/);
      const odd = setup({ 7: releasePr({ title: 'feat: not the release' }) });
      await expect(runAuto(parseAutoArgs(['--from', 'release-pr', '--merge-release-pr']), { ...odd.opts('7'), log: () => {} })).rejects.toThrow(/title is "feat: not the release", not "chore\(main\): release 9.9.9"/);
      expect(draft.world.merges()).toHaveLength(0);
      expect(odd.world.merges()).toHaveLength(0);
    });

    it('without the flag the run still stops and says it merges only with --merge-release-pr', async () => {
      const { world, opts } = setup({ 7: releasePr() });
      const logs = [];
      const res = await runAuto(parseAutoArgs(['--from', 'release-pr']), { ...opts('7'), log: (l) => logs.push(l) });
      expect(res.stoppedAt).toBe('release-pr');
      expect(logs.join('\n')).toContain('This script merges the release PR only when you pass --merge-release-pr.');
      expect(world.calls).toEqual([]);
    });

    it('a re-run after the merge goes on from the merged PR and does not merge again', async () => {
      const { world, opts } = setup({ 7: releasePr() });
      await expect(runAuto(parseAutoArgs(['--from', 'release-pr', '--merge-release-pr']), { ...opts('7'), log: () => {} })).rejects.toThrow(/would tag 0 releases/);
      expect(world.merges()).toHaveLength(1);
      const again = setup({ 7: releasePr() });
      again.world.prs[7].merged = true;
      again.world.prs[7].state = 'MERGED';
      await expect(runAuto(parseAutoArgs(['--from', 'release-pr', '--merge-release-pr']), { ...again.opts('7'), log: () => {} })).rejects.toThrow();
      expect(again.world.merges()).toHaveLength(0);
    });
  });

  it('the dry plan lists the merge steps and the release PR merge', () => {
    const env = { LOCALAPPDATA: 'C:\\L' };
    const text = dryPlan(parseAutoArgs(['--merge-pr', '111,112', '--merge-release-pr']), { env, root: '/r', execPath: 'node', pathMod: path.win32, pkgVersion: '1.1.0', platform: 'win32', arch: 'arm64' }).join('\n');
    expect(text).toContain('PR #111, #112 before the checks (--merge-pr)');
    expect(text).toContain('the release PR after the release-pr stage (--merge-release-pr)');
    expect(text).toContain('[merge PR #111] --merge-pr, before the checks, after preflight');
    expect(text).toContain('[merge PR #112]');
    expect(text).toContain('gh pr view 111 -R ChristianMunoz31/burrow --json');
    expect(text).toContain('gh pr merge 111 -R ChristianMunoz31/burrow --squash --delete-branch');
    expect(text).toContain('"<PR title> (#111)"');
    expect(text).toContain('git pull --ff-only origin main');
    expect(text).toContain('--merge-release-pr merges the release PR');
    expect(text).toContain('gh pr merge "<release PR number>"');
    expect(text.indexOf('[preflight]')).toBeLessThan(text.indexOf('[merge PR #111]'));
    expect(text.indexOf('[merge PR #111]')).toBeLessThan(text.indexOf('[checks]'));
    expect(text).not.toContain('never merged by this script');
    const plain = dryPlan(parseAutoArgs([]), { env, root: '/r', execPath: 'node', pathMod: path.win32, pkgVersion: '1.1.0', platform: 'win32', arch: 'arm64' }).join('\n');
    expect(plain).toContain('merges    none');
    expect(plain).toContain('Add --merge-release-pr to merge it here instead.');
    expect(plain).not.toContain('[merge PR');
  });
});
