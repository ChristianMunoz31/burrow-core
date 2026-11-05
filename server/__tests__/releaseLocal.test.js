import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Release paths refuse a checkout without the Pro module (assertProPresent); these fixture roots have none, and
// server/__tests__/proReleaseGuard.test.js covers the refusal itself.
vi.mock('../../scripts/checks/proPresent.js', async (importOriginal) => ({ ...(await importOriginal()), assertProPresent: () => {} }));
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  INSTALLERS,
  checkAssetFromRun,
  checkChannelArtifacts,
  checkCiRun,
  checkCommitCi,
  checkEnv,
  checkInstallerNames,
  checkNotOlderThanHead,
  checkPeVersion,
  checkRunWorkflow,
  checkTag,
  checkVersion,
  checkX64FileName,
  formatSums,
  hasMzHeader,
  buildManifest,
  manifestProblems,
  parseCliArgs,
  parseLogHash,
  renderPlan,
  runRelease,
} from '../../scripts/release/releaseLocal.mjs';

const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const HEAD = 'c0ffee0'.padEnd(40, '1');
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

describe('parseCliArgs', () => {
  it('defaults to a dry run', () => {
    const o = parseCliArgs([]);
    expect(o).toMatchObject({ dryRun: true, publish: false, yes: false, skipBuild: false, x64FromCi: null, tag: null });
  });

  it('--publish turns the dry run off; --dry-run with --publish is refused', () => {
    expect(parseCliArgs(['--publish', '--yes'])).toMatchObject({ dryRun: false, publish: true, yes: true });
    expect(() => parseCliArgs(['--dry-run', '--publish'])).toThrow(/not both/);
  });

  it('reads the other flags', () => {
    const o = parseCliArgs(['--skip-build', '--x64-from-ci', '123456', '--out-dir', 'x', '--tag', 'v1.2.3']);
    expect(o).toMatchObject({ skipBuild: true, x64FromCi: '123456', outDir: 'x', tag: 'v1.2.3' });
  });

  it('--x64-file takes a path and cannot be combined with --x64-from-ci', () => {
    expect(parseCliArgs(['--x64-file', 'C:\\b\\Burrow_0.2.0_x64-setup.exe']).x64File).toBe('C:\\b\\Burrow_0.2.0_x64-setup.exe');
    expect(parseCliArgs([]).x64File).toBeNull();
    expect(() => parseCliArgs(['--x64-file', 'a.exe', '--x64-from-ci', '12'])).toThrow(/not both/);
    expect(() => parseCliArgs(['--x64-file', ' '])).toThrow(/needs a path/);
  });

  it('rejects a bad run id, a prerelease tag and unknown flags', () => {
    expect(() => parseCliArgs(['--x64-from-ci', 'abc'])).toThrow(/numeric run id/);
    expect(() => parseCliArgs(['--x64-from-ci', '12 34'])).toThrow(/numeric run id/);
    expect(() => parseCliArgs(['--tag', 'v1.2.3-rc.1'])).toThrow(/stable release tag/);
    expect(() => parseCliArgs(['--nope'])).toThrow();
    expect(() => parseCliArgs(['extra'])).toThrow();
  });
});

describe('tag, version and environment checks', () => {
  it('accepts only strict vX.Y.Z', () => {
    for (const ok of ['v0.1.0', 'v10.20.30']) expect(checkTag(ok)).toBe(ok);
    for (const bad of ['1.2.3', 'v1.2', 'v1.2.3-rc.1', 'v1.2.3-dev', 'v1.2.3\n', 'v1.2.3.4', ' v1.2.3', '', undefined]) {
      expect(() => checkTag(bad), String(bad)).toThrow(/stable release tag/);
    }
  });

  it('requires package.json to equal the tag', () => {
    expect(() => checkVersion('0.2.0', 'v0.2.0')).not.toThrow();
    expect(() => checkVersion('0.2.1', 'v0.2.0')).toThrow(/does not match the tag/);
    expect(() => checkVersion('0.2.0-dev.1', 'v0.2.0')).toThrow(/does not match/);
  });

  it('refuses a dev channel or a display version', () => {
    expect(() => checkEnv({})).not.toThrow();
    expect(() => checkEnv({ BURROW_CHANNEL: 'stable', BURROW_DISPLAY_VERSION: '' })).not.toThrow();
    expect(() => checkEnv({ BURROW_CHANNEL: 'dev' })).toThrow(/BURROW_CHANNEL/);
    expect(() => checkEnv({ BURROW_DISPLAY_VERSION: '0.2.0-dev.20261005.abc1234' })).toThrow(/BURROW_DISPLAY_VERSION/);
  });
});

describe('SHA256SUMS format', () => {
  it('writes standard "<hash>  <name>" lines in CI order with one trailing newline', () => {
    const text = formatSums([
      { name: 'Burrow-Setup-arm64.exe', sha256: H2 },
      { name: 'Burrow-Setup-x64.exe', sha256: H1 },
    ]);
    expect(text).toBe(`${H1}  Burrow-Setup-x64.exe\n${H2}  Burrow-Setup-arm64.exe\n`);
    expect(text).not.toContain('*');
  });

  it('rejects a missing, malformed or extra entry', () => {
    expect(() => formatSums([{ name: 'Burrow-Setup-x64.exe', sha256: H1 }])).toThrow(/arm64/);
    expect(() => formatSums([{ name: 'Burrow-Setup-x64.exe', sha256: 'zz' }, { name: 'Burrow-Setup-arm64.exe', sha256: H2 }])).toThrow(/valid sha256/);
    expect(() => formatSums([
      { name: 'Burrow-Setup-x64.exe', sha256: H1 }, { name: 'Burrow-Setup-arm64.exe', sha256: H2 }, { name: 'a.zip', sha256: H1 },
    ])).toThrow(/Only the two installers/);
  });
});

describe('installer checks', () => {
  it('MZ header', () => {
    expect(hasMzHeader(Buffer.from('MZ\x90\x00'))).toBe(true);
    expect(hasMzHeader(Buffer.from('PK\x03\x04'))).toBe(false);
    expect(hasMzHeader(Buffer.alloc(0))).toBe(false);
  });

  it('names: exactly the two stable names, none with "dev"', () => {
    expect(() => checkInstallerNames([...INSTALLERS])).not.toThrow();
    expect(() => checkInstallerNames(['Burrow-Setup-x64.exe'])).toThrow(/Missing/);
    expect(() => checkInstallerNames([...INSTALLERS, 'notes.txt'])).toThrow(/Unexpected/);
    expect(() => checkInstallerNames(['Burrow-Dev-Setup-x64.exe', 'Burrow-Setup-arm64.exe'])).toThrow(/dev/);
  });

  it('not older than the release commit', () => {
    const head = Date.parse('2026-10-05T10:00:00Z');
    expect(() => checkNotOlderThanHead([{ name: 'a', mtimeMs: head + 1 }, { name: 'b', mtimeMs: head }], head)).not.toThrow();
    expect(() => checkNotOlderThanHead([{ name: 'a', mtimeMs: head - 1000 }], head)).toThrow(/older than the release commit/);
  });
});

describe('CI run checks (x64 from CI)', () => {
  const jobs = [
    { name: 'build-release / assets', conclusion: 'success', databaseId: 11 },
    { name: 'build-release / desktop-windows / Windows x64', conclusion: 'success', databaseId: 22 },
  ];
  const run = { status: 'completed', headSha: HEAD, jobs, createdAt: '2026-10-05T10:00:00Z', updatedAt: '2026-10-05T10:30:00Z' };

  it('accepts a finished run of the release commit with a good assets job and x64 job', () => {
    expect(() => checkCiRun(run, { tagSha: HEAD })).not.toThrow();
    expect(() => checkCiRun({ ...run, jobs: [{ name: 'assets', conclusion: 'success' }, jobs[1]] }, { tagSha: HEAD })).not.toThrow();
  });

  it('rejects an unfinished run, another commit, a missing or failed job', () => {
    expect(() => checkCiRun({ ...run, status: 'in_progress' }, { tagSha: HEAD })).toThrow(/not completed/);
    expect(() => checkCiRun({ ...run, headSha: 'd'.repeat(40) }, { tagSha: HEAD })).toThrow(/not the release commit/);
    expect(() => checkCiRun({ ...run, jobs: [jobs[0]] }, { tagSha: HEAD })).toThrow(/no "Windows x64" job/);
    expect(() => checkCiRun({ ...run, jobs: [jobs[0], { name: 'Windows x64', conclusion: 'failure' }] }, { tagSha: HEAD })).toThrow(/failure/);
  });

  it('requires the assets job (npm test) to have succeeded', () => {
    expect(() => checkCiRun({ ...run, jobs: [jobs[1]] }, { tagSha: HEAD })).toThrow(/no "assets" job/);
    expect(() => checkCiRun({ ...run, jobs: [{ name: 'build-release / assets', conclusion: 'failure' }, jobs[1]] }, { tagSha: HEAD })).toThrow(/npm test.*failure/);
    expect(() => checkCiRun({ ...run, jobs: [{ name: 'build-release / assets', conclusion: 'skipped' }, jobs[1]] }, { tagSha: HEAD })).toThrow(/skipped/);
    // A job that only ends in "assets" as a word of another name does not count.
    expect(() => checkCiRun({ ...run, jobs: [{ name: 'publish-assets', conclusion: 'success' }, jobs[1]] }, { tagSha: HEAD })).toThrow(/no "assets" job/);
  });

  it('the run must come from release-please.yml or release.yml', () => {
    expect(() => checkRunWorkflow({ path: '.github/workflows/release-please.yml' })).not.toThrow();
    expect(() => checkRunWorkflow({ path: '.github/workflows/release.yml@refs/heads/main' })).not.toThrow();
    expect(() => checkRunWorkflow({ path: '.github/workflows/evil.yml' })).toThrow(/not .*release-please\.yml/);
    expect(() => checkRunWorkflow({})).toThrow(/unknown/);
  });

  it('reads the x64 hash from the job log, and refuses none or conflicting lines', () => {
    const log = `win\tBuild\t2026-10-05T10:00:00Z ${H1}  Burrow-Setup-x64.exe\nwin\tBuild\t2026 ${H2}  Burrow-Setup-arm64.exe`;
    expect(parseLogHash(log, 'Burrow-Setup-x64.exe')).toBe(H1);
    expect(parseLogHash(`${H1.toUpperCase()} *Burrow-Setup-x64.exe`, 'Burrow-Setup-x64.exe')).toBe(H1);
    expect(() => parseLogHash('nothing here', 'Burrow-Setup-x64.exe')).toThrow(/no sha256 line/);
    expect(() => parseLogHash(`${H1}  Burrow-Setup-x64.exe\n${H2}  Burrow-Setup-x64.exe`, 'Burrow-Setup-x64.exe')).toThrow(/different sha256/);
    expect(() => parseLogHash(`${H1}  Burrow-Setup-x64.exe.bak`, 'Burrow-Setup-x64.exe')).toThrow(/no sha256 line/);
  });

  it('the asset must have been uploaded inside the run window', () => {
    expect(() => checkAssetFromRun({ name: 'x', updatedAt: '2026-10-05T10:20:00Z' }, run)).not.toThrow();
    expect(() => checkAssetFromRun({ name: 'x', updatedAt: '2026-10-04T10:20:00Z' }, run)).toThrow(/not uploaded by that run/);
    expect(() => checkAssetFromRun({ name: 'x', updatedAt: '2026-10-06T10:20:00Z' }, run)).toThrow(/not uploaded by that run/);
    expect(() => checkAssetFromRun({ name: 'x' }, run)).toThrow(/Could not read/);
  });
});

describe('renderPlan', () => {
  it('names the tag, mode, sources, files and says a dry run writes nothing', () => {
    const lines = renderPlan({
      tag: 'v0.2.0', commit: HEAD, publish: false, outDir: 'C:\\out',
      sources: { x64: 'from CI', arm64: 'built here' },
      files: [{ name: 'Burrow-Setup-x64.exe', size: 10, sha256: H1 }, { name: 'SHA256SUMS.txt', size: 5 }],
    });
    const text = lines.join('\n');
    expect(text).toContain('v0.2.0 (commit c0ffee0)');
    expect(text).toContain('DRY RUN (no network writes');
    expect(text).toContain('ChristianMunoz31/burrow-releases');
    expect(text).toContain('x64      from CI');
    expect(text).toContain(`Burrow-Setup-x64.exe  10 bytes  sha256 ${'a'.repeat(16)}...`);
    expect(text).toContain('SHA256SUMS.txt  5 bytes');
    expect(text).not.toContain(String.fromCharCode(0x2014));
    expect(renderPlan({ tag: 'v0.2.0', commit: HEAD, publish: true, outDir: 'x', sources: { x64: '', arm64: '' }, files: [] }).join('\n')).toContain('PUBLISH (real upload');
  });
});

describe('checkChannelArtifacts', () => {
  let root;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-rl-chan-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('skips when nothing was built, passes the artifacts it finds and refuses a dev sidecar', () => {
    const run = vi.fn(() => 0);
    expect(checkChannelArtifacts(root, run)).toEqual({ checked: false });
    fs.mkdirSync(path.join(root, '.sidecar-build'));
    fs.writeFileSync(path.join(root, '.sidecar-build', 'server.cjs'), '/*! BURROW_CHANNEL=stable */');
    fs.mkdirSync(path.join(root, 'src-tauri', 'binaries'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src-tauri', 'binaries', 'burrow-server-x.exe'), 'x');
    expect(checkChannelArtifacts(root, run)).toEqual({ checked: true });
    const argv = run.mock.calls[0][0];
    expect(argv.slice(0, 2)).toEqual(['--expect', 'stable']);
    expect(argv).toContain('--bundle');
    expect(argv).toContain('--binary');
    expect(() => checkChannelArtifacts(root, () => 1)).toThrow(/channel check failed/);
    fs.writeFileSync(path.join(root, 'src-tauri', 'binaries', 'burrow-dev-server-x.exe'), 'x');
    expect(() => checkChannelArtifacts(root, run)).toThrow(/dev sidecar/);
  });
});

describe('runRelease with fixtures (no real git, gh or build)', () => {
  let root;
  let outDir;
  let publicDir;
  let calls;

  const X64 = Buffer.concat([Buffer.from('MZ'), Buffer.from('x64 fixture')]);
  const ARM = Buffer.concat([Buffer.from('MZ'), Buffer.from('arm64 fixture')]);

  /** Fake git and gh. `over` replaces single answers. */
  function makeExec(over = {}) {
    return vi.fn(async (file, args, opts) => {
      calls.push([file, ...args]);
      const key = `${file} ${args.slice(0, 2).join(' ')}`;
      if (over[key]) return over[key](args, opts);
      if (key === 'git status --porcelain') return { stdout: '', stderr: '' };
      if (key === 'git rev-parse HEAD') return { stdout: `${HEAD}\n`, stderr: '' };
      if (key === 'git log -1') return { stdout: '1700000000\n', stderr: '' };
      if (key.startsWith('gh api repos/ChristianMunoz31/burrow/git/ref/tags/')) return { stdout: JSON.stringify({ object: { type: 'commit', sha: HEAD } }), stderr: '' };
      if (key.startsWith('gh api repos/ChristianMunoz31/burrow/commits/') && key.includes('/check-runs')) return { stdout: JSON.stringify({ check_runs: [{ name: 'assets', status: 'completed', conclusion: 'success', completed_at: '2026-01-01T00:00:00Z' }] }), stderr: '' };
      if (key === 'gh auth token') return { stdout: 'fake-token\n', stderr: '' };
      throw new Error(`unexpected call: ${file} ${args.join(' ')}`);
    });
  }

  const stage = () => {
    fs.mkdirSync(publicDir, { recursive: true });
    fs.writeFileSync(path.join(publicDir, 'Burrow-Setup-x64.exe'), X64);
    fs.writeFileSync(path.join(publicDir, 'Burrow-Setup-arm64.exe'), ARM);
  };
  const manifestFor = (over = {}) => ({
    schema: 1,
    tag: 'v0.2.0',
    version: '0.2.0',
    commit: HEAD,
    installers: {
      x64: { name: 'Burrow-Setup-x64.exe', originalName: 'Burrow-Setup-x64.exe', sha256: sha(X64), source: 'test' },
      arm64: { name: 'Burrow-Setup-arm64.exe', originalName: 'Burrow_0.2.0_arm64-setup.exe', sha256: sha(ARM), source: 'test' },
    },
    ...over,
  });
  const writeManifest = (m = manifestFor()) => fs.writeFileSync(path.join(outDir, 'build-manifest.json'), JSON.stringify(m));
  const opts = (extra = {}) => ({ tag: null, publish: false, dryRun: true, yes: false, skipBuild: true, x64FromCi: null, x64File: null, outDir, help: false, ...extra });
  const writes = () => calls.filter((c) => c[0] === 'gh' && ['create', 'upload', 'edit', 'delete'].includes(c[2]) && c[1] === 'release');

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-rl-root-'));
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-rl-out-'));
    publicDir = path.join(outDir, 'public');
    calls = [];
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.2.0' }));
    fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '# Changelog\n\n## [0.2.0](x) (2026-10-05)\n\n### Features\n\n* a thing\n');
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it('dry run: checks, writes SHA256SUMS.txt, prints the plan and calls publish in dry-run mode only', async () => {
    stage();
    const lines = [];
    const publishFn = vi.fn(async () => ({ plan: [], notes: '' }));
    const exec = makeExec();
    const res = await runRelease(opts(), { root, env: {}, exec, log: (l) => lines.push(l), publishFn, confirm: vi.fn() });
    expect(res.published).toBe(false);
    expect(publishFn).toHaveBeenCalledTimes(1);
    expect(publishFn.mock.calls[0][0]).toMatchObject({ tag: 'v0.2.0', assetsDir: publicDir, dryRun: true });
    expect(publishFn.mock.calls[0][0].env).toBeUndefined();
    expect(writes()).toEqual([]);
    expect(calls.some((c) => c.join(' ').includes('auth token'))).toBe(false);
    const sums = fs.readFileSync(path.join(publicDir, 'SHA256SUMS.txt'), 'utf8');
    expect(sums).toBe(`${sha(X64)}  Burrow-Setup-x64.exe\n${sha(ARM)}  Burrow-Setup-arm64.exe\n`);
    const out = lines.join('\n');
    expect(out).toContain('DRY RUN (no network writes');
    expect(out).toContain('stable channel check was skipped');
    expect(out).toContain('Nothing was uploaded');
  });

  it('refuses a dirty worktree, a missing tag and a HEAD that is not the tag commit', async () => {
    stage();
    const deps = (over) => ({ root, env: {}, exec: makeExec(over), log: () => {}, publishFn: vi.fn(), confirm: vi.fn() });
    await expect(runRelease(opts(), deps({ 'git status --porcelain': async () => ({ stdout: ' M file\n', stderr: '' }) }))).rejects.toThrow(/not clean/);
    const ref = 'gh api repos/ChristianMunoz31/burrow/git/ref/tags/v0.2.0';
    const obj = (o) => async () => ({ stdout: JSON.stringify({ object: o }), stderr: '' });
    await expect(runRelease(opts(), deps({ [ref]: async () => { throw new Error('404'); } }))).rejects.toThrow(/Could not find the tag v0.2.0/);
    await expect(runRelease(opts(), deps({ [ref]: obj({ type: 'commit', sha: 'd'.repeat(40) }) }))).rejects.toThrow(/is not the commit of v0.2.0/);
  });

  it('dereferences an annotated tag to its commit (git/ref, then git/tags)', async () => {
    stage();
    const tagObj = 'e'.repeat(40);
    const exec = makeExec({
      'gh api repos/ChristianMunoz31/burrow/git/ref/tags/v0.2.0': async () => ({ stdout: JSON.stringify({ object: { type: 'tag', sha: tagObj } }), stderr: '' }),
      [`gh api repos/ChristianMunoz31/burrow/git/tags/${tagObj}`]: async () => ({ stdout: JSON.stringify({ object: { type: 'commit', sha: HEAD } }), stderr: '' }),
    });
    const res = await runRelease(opts(), { root, env: {}, exec, log: () => {}, publishFn: vi.fn(async () => ({})), confirm: vi.fn() });
    expect(res.published).toBe(false);
    expect(calls.some((c) => c.join(' ').includes('/commits/'))).toBe(false);
    expect(calls.some((c) => c[2] === `repos/ChristianMunoz31/burrow/git/tags/${tagObj}`)).toBe(true);
  });

  it('refuses a tag that does not match package.json, a prerelease tag and a dev environment', async () => {
    stage();
    const d = { root, exec: makeExec(), log: () => {}, publishFn: vi.fn(), confirm: vi.fn() };
    await expect(runRelease(opts({ tag: 'v0.3.0' }), { ...d, env: {} })).rejects.toThrow(/does not match the tag/);
    await expect(runRelease(opts({ tag: 'v0.2.0-rc.1' }), { ...d, env: {} })).rejects.toThrow(/stable release tag/);
    await expect(runRelease(opts(), { ...d, env: { BURROW_CHANNEL: 'dev' } })).rejects.toThrow(/BURROW_CHANNEL/);
    expect(d.publishFn).not.toHaveBeenCalled();
  });

  it('refuses a non-exe, a dev-named extra file and an installer older than the commit', async () => {
    stage();
    const d = { root, env: {}, exec: makeExec(), log: () => {}, publishFn: vi.fn(), confirm: vi.fn() };
    fs.writeFileSync(path.join(publicDir, 'Burrow-Setup-arm64.exe'), 'PK zip');
    await expect(runRelease(opts(), d)).rejects.toThrow(/missing the MZ header/);
    stage();
    fs.writeFileSync(path.join(publicDir, 'Burrow-Dev-Setup-x64.exe'), ARM);
    await expect(runRelease(opts(), d)).rejects.toThrow(/dev/);
    fs.rmSync(path.join(publicDir, 'Burrow-Dev-Setup-x64.exe'));
    const old = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(path.join(publicDir, 'Burrow-Setup-x64.exe'), old, old);
    await expect(runRelease(opts(), d)).rejects.toThrow(/older than the release commit/);
    expect(d.publishFn).not.toHaveBeenCalled();
  });

  it('needs an x64 source: --x64-from-ci, or --skip-build with a hand-built file', async () => {
    const d = { root, env: {}, exec: makeExec(), log: () => {}, publishFn: vi.fn(), confirm: vi.fn() };
    await expect(runRelease(opts({ skipBuild: false }), d)).rejects.toThrow(/x64 has no source/);
  });

  it('publish: needs the confirmation, never calls publish when declined, passes the gh token when yes', async () => {
    stage();
    writeManifest();
    fs.mkdirSync(path.join(root, '.sidecar-build'));
    fs.writeFileSync(path.join(root, '.sidecar-build', 'server.cjs'), '/*! BURROW_CHANNEL=stable */');
    const publishFn = vi.fn(async () => ({ plan: [], notes: '' }));
    const base = { root, env: {}, exec: makeExec(), log: () => {}, publishFn, channelRun: () => 0, gumroadFn: vi.fn(async () => ({})) };
    const no =vi.fn(async () => false);
    const declined = await runRelease(opts({ publish: true, dryRun: false }), { ...base, confirm: no });
    expect(declined.published).toBe(false);
    expect(no).toHaveBeenCalledTimes(1);
    expect(publishFn).not.toHaveBeenCalled();

    const yes = vi.fn();
    const done = await runRelease(opts({ publish: true, dryRun: false, yes: true }), { ...base, confirm: yes });
    expect(done.published).toBe(true);
    expect(yes).not.toHaveBeenCalled();
    expect(publishFn).toHaveBeenCalledTimes(1);
    expect(publishFn.mock.calls[0][0]).toMatchObject({ dryRun: false, tag: 'v0.2.0' });
    expect(publishFn.mock.calls[0][0].env.GH_TOKEN).toBe('fake-token');
  });

  it('with --gumroad, after a real publish it runs the Gumroad sync as a dry run, then a publish with its own prompt; a dry run or a decline never does', async () => {
    stage();
    writeManifest();
    fs.mkdirSync(path.join(root, '.sidecar-build'));
    fs.writeFileSync(path.join(root, '.sidecar-build', 'server.cjs'), '/*! BURROW_CHANNEL=stable */');
    const order = [];
    const publishFn = vi.fn(async () => { order.push('publish'); return {}; });
    const gumroadFn = vi.fn(async (o) => { order.push(o.publish ? 'gumroad-publish' : 'gumroad-dry'); });
    const base = { root, env: {}, exec: makeExec(), log: () => {}, publishFn, channelRun: () => 0, gumroadFn };
    await runRelease(opts(), { ...base, confirm: vi.fn() });
    await runRelease(opts({ publish: true, dryRun: false, gumroad: true }), { ...base, confirm: vi.fn(async () => false) });
    expect(gumroadFn).not.toHaveBeenCalled();
    const plain = await runRelease(opts({ publish: true, dryRun: false, yes: true }), { ...base, confirm: vi.fn() });
    expect(plain.published).toBe(true);
    expect(gumroadFn, 'the Gumroad sync is not a default step').not.toHaveBeenCalled();
    const res = await runRelease(opts({ publish: true, dryRun: false, yes: true, gumroad: true }), { ...base, confirm: vi.fn() });
    expect(res.published).toBe(true);
    expect(order.slice(-3)).toEqual(['publish', 'gumroad-dry', 'gumroad-publish']);
    expect(gumroadFn.mock.calls[0][0]).toMatchObject({ tag: 'v0.2.0', dryRun: true, publish: false });
    expect(gumroadFn.mock.calls[1][0]).toMatchObject({ tag: 'v0.2.0', dryRun: false, publish: true, yes: false });
  });

  it('a Gumroad failure does not undo the publish and names the command to run again', async () => {
    stage();
    writeManifest();
    fs.mkdirSync(path.join(root, '.sidecar-build'));
    fs.writeFileSync(path.join(root, '.sidecar-build', 'server.cjs'), '/*! BURROW_CHANNEL=stable */');
    const lines = [];
    const gumroadFn = vi.fn(async () => { throw new Error('a version number (0.1.0) is written in the description'); });
    const res = await runRelease(opts({ publish: true, dryRun: false, yes: true, gumroad: true }), { root, env: {}, exec: makeExec(), log: (l) => lines.push(l), publishFn: vi.fn(async () => ({})), channelRun: () => 0, gumroadFn });
    expect(res.published).toBe(true);
    expect(gumroadFn).toHaveBeenCalledTimes(1);
    expect(lines.join('\n')).toContain('the release is published, but the Gumroad pages were not updated: a version number');
    expect(lines.join('\n')).toContain('npm run release:gumroad -- --publish');
  });

  describe('CI on the tag commit (any --publish)', () => {
    const CHECKS = 'gh api repos/ChristianMunoz31/burrow/commits/' + HEAD + '/check-runs?per_page=100';
    const checks = (check_runs) => ({ [CHECKS]: async () => ({ stdout: JSON.stringify({ check_runs }), stderr: '' }) });
    const go = (over, extra) => {
      stage();
      const publishFn = vi.fn(async () => ({}));
      const p = runRelease(opts({ publish: true, dryRun: false, yes: true, ...extra }), { root, env: {}, exec: makeExec(over), log: () => {}, publishFn, channelRun: () => 0, gumroadFn: vi.fn(async () => ({})) });
      return { p, publishFn };
    };

    it('refuses when the test job failed, is still running or is missing, and publishes nothing', async () => {
      for (const [runs, re] of [
        [[{ name: 'assets', status: 'completed', conclusion: 'failure' }], /CI has not passed.*assets: failure/],
        [[{ name: 'verify', status: 'in_progress', conclusion: null }], /CI has not passed.*verify: in_progress/],
        [[{ name: 'lint', status: 'completed', conclusion: 'success' }], /has a "assets", "verify" or "main-unit" job/],
        [[], /has a "assets", "verify" or "main-unit" job/],
      ]) {
        const { p, publishFn } = go(checks(runs));
        await expect(p).rejects.toThrow(re);
        expect(publishFn).not.toHaveBeenCalled();
      }
    });

    it('refuses when gh cannot read the check runs', async () => {
      const { p, publishFn } = go({ [CHECKS]: async () => { throw new Error('404'); } });
      await expect(p).rejects.toThrow(/Could not read the CI check runs/);
      expect(publishFn).not.toHaveBeenCalled();
    });

    it('also applies on the --x64-file path, and warns that x64 is not checked there', async () => {
      const file = path.join(os.tmpdir(), 'Burrow_0.2.0_x64-setup.exe');
      fs.writeFileSync(file, X64);
      const { p, publishFn } = go(checks([{ name: 'assets', status: 'completed', conclusion: 'failure' }]), { x64File: file });
      await expect(p).rejects.toThrow(/CI has not passed/);
      expect(publishFn).not.toHaveBeenCalled();
      fs.rmSync(file, { force: true });
    });

    it('a dry run does not ask for the check runs', async () => {
      stage();
      const exec = makeExec();
      await runRelease(opts(), { root, env: {}, exec, log: () => {}, publishFn: vi.fn(async () => ({})), channelRun: () => 0 });
      expect(calls.some((c) => String(c[2]).includes('/check-runs'))).toBe(false);
    });

    it('checkCommitCi counts the newest run of each name and accepts the ci.yml verify job', () => {
      const sha = HEAD;
      expect(() => checkCommitCi({ check_runs: [{ name: 'verify', status: 'completed', conclusion: 'success' }] }, { tagSha: sha })).not.toThrow();
      expect(() => checkCommitCi({ check_runs: [{ name: 'release / assets', status: 'completed', conclusion: 'success' }] }, { tagSha: sha })).not.toThrow();
      const shard = (n, conclusion = 'success') => ({ name: `main-unit (${n}/3)`, status: 'completed', conclusion });
      expect(() => checkCommitCi({ check_runs: [shard(1), shard(2), shard(3)] }, { tagSha: sha })).not.toThrow();
      expect(() => checkCommitCi({ check_runs: [shard(1), shard(2)] }, { tagSha: sha })).toThrow(/CI has not passed/);
      expect(() => checkCommitCi({ check_runs: [shard(1), shard(2), shard(3, 'failure')] }, { tagSha: sha })).toThrow(/main-unit \(3\/3\): failure/);
      const red = { name: 'assets', status: 'completed', conclusion: 'failure', completed_at: '2026-01-01T00:00:00Z' };
      const green = { name: 'assets', status: 'completed', conclusion: 'success', completed_at: '2026-01-01T01:00:00Z' };
      expect(() => checkCommitCi({ check_runs: [red, green] }, { tagSha: sha })).not.toThrow();
      expect(() => checkCommitCi({ check_runs: [{ ...green, completed_at: '2026-01-01T00:00:00Z' }, { ...red, completed_at: '2026-01-01T02:00:00Z' }] }, { tagSha: sha })).toThrow(/CI has not passed/);
      expect(() => checkCommitCi(null, { tagSha: sha })).toThrow(/has a "assets", "verify" or "main-unit" job/);
    });
  });

  it('publish refuses to go on without build artifacts to check the stable channel', async () => {
    stage();
    const publishFn = vi.fn();
    await expect(runRelease(opts({ publish: true, dryRun: false, yes: true }), { root, env: {}, exec: makeExec(), log: () => {}, publishFn, channelRun: () => 0 })).rejects.toThrow(/No build artifacts/);
    expect(publishFn).not.toHaveBeenCalled();
  });

  describe('--x64-from-ci (fixtures and a stubbed gh)', () => {
    const run = {
      status: 'completed',
      headSha: HEAD,
      jobs: [
        { name: 'build-release / assets', conclusion: 'success', databaseId: 11 },
        { name: 'build-release / desktop-windows / Windows x64', conclusion: 'success', databaseId: 22 },
      ],
      createdAt: '2026-10-05T10:00:00Z',
      updatedAt: '2026-10-05T10:30:00Z',
    };
    const asset = (id, name, updated = '2026-10-05T10:20:00Z') => ({ id, name, updated_at: updated });
    const releaseJson = (installerUpdated) => ({
      assets: [asset(901, 'Burrow-Setup-x64.exe', installerUpdated), asset(902, 'SHA256SUMS-desktop-windows-x64.txt')],
    });
    /** Fake gh for the x64 download. `cfg` bends single answers. */
    const over = (cfg = {}) => {
      let releaseReads = 0;
      const sumsText = `${cfg.sumHash ?? sha(X64)}  Burrow-Setup-x64.exe\n`;
      return {
        'gh run view': async (args) => {
          if (args.includes('--log')) {
            expect(args).toContain('--job');
            expect(args[args.indexOf('--job') + 1]).toBe('22');
            return { stdout: `win\tBuild\t2026-10-05T10:20:00Z ${cfg.logHash ?? sha(X64)}  Burrow-Setup-x64.exe\n`, stderr: '' };
          }
          return { stdout: JSON.stringify(cfg.run ?? run), stderr: '' };
        },
        'gh api repos/ChristianMunoz31/burrow/actions/runs/777': async () => ({ stdout: JSON.stringify({ path: cfg.path ?? '.github/workflows/release-please.yml' }), stderr: '' }),
        'gh api repos/ChristianMunoz31/burrow/releases/tags/v0.2.0': async () => {
          releaseReads += 1;
          const changed = cfg.changeAfterDownload && releaseReads > 1;
          return { stdout: JSON.stringify(releaseJson(changed ? '2026-10-05T10:25:00Z' : undefined)), stderr: '' };
        },
        'gh api -H': async (args) => {
          expect(args[2]).toBe('Accept: application/octet-stream');
          const url = args[3];
          if (url.endsWith('/assets/901')) return { stdout: cfg.bytes ?? X64, stderr: '' };
          if (url.endsWith('/assets/902')) return { stdout: Buffer.from(sumsText), stderr: '' };
          throw new Error(`unexpected asset ${url}`);
        },
      };
    };
    const stageArm = () => {
      fs.mkdirSync(publicDir, { recursive: true });
      fs.writeFileSync(path.join(publicDir, 'Burrow-Setup-arm64.exe'), ARM);
    };
    const go = (cfg, extra) => runRelease(opts({ x64FromCi: '777', ...extra }), { root, env: {}, exec: makeExec(over(cfg)), log: () => {}, publishFn: vi.fn(async () => ({})) });

    it('downloads by asset id, verifies against the checksum asset and the job log, and only reads from GitHub', async () => {
      stageArm();
      await go();
      expect(fs.readFileSync(path.join(publicDir, 'Burrow-Setup-x64.exe'))).toEqual(X64);
      const dl = calls.filter((c) => c[1] === 'api' && c[2] === '-H');
      expect(dl.map((c) => c[4])).toEqual(['repos/ChristianMunoz31/burrow/releases/assets/901', 'repos/ChristianMunoz31/burrow/releases/assets/902']);
      expect(calls.some((c) => c[1] === 'release')).toBe(false);
      expect(calls.some((c) => c.join(' ').includes('burrow-releases'))).toBe(false);
      expect(calls.filter((c) => c[2] === 'repos/ChristianMunoz31/burrow/releases/tags/v0.2.0')).toHaveLength(2);
      expect(writes()).toEqual([]);
    });

    it('stops on a mismatch with the checksum asset', async () => {
      stageArm();
      await expect(go({ sumHash: 'f'.repeat(64) })).rejects.toThrow(/does not match/);
    });

    it('stops when the hash differs from the line the x64 job printed in its own log', async () => {
      stageArm();
      await expect(go({ logHash: 'f'.repeat(64) })).rejects.toThrow(/job printed in its own log/);
    });

    it('stops when the asset changed (updated_at) while it was being downloaded', async () => {
      stageArm();
      await expect(go({ changeAfterDownload: true })).rejects.toThrow(/changed while it was being downloaded/);
      expect(fs.existsSync(path.join(publicDir, 'Burrow-Setup-x64.exe'))).toBe(false);
    });

    it('refuses a run of another workflow, and a run whose assets job (npm test) failed', async () => {
      stageArm();
      await expect(go({ path: '.github/workflows/other.yml' })).rejects.toThrow(/not .*release-please\.yml/);
      const failed = { ...run, jobs: [{ name: 'build-release / assets', conclusion: 'failure' }, run.jobs[1]] };
      await expect(go({ run: failed })).rejects.toThrow(/npm test/);
    });

    it('refuses when the staged file no longer has the hash kept at download', async () => {
      stageArm();
      const exec = makeExec(over());
      const realCopy = fs.copyFileSync;
      const spy = vi.spyOn(fs, 'copyFileSync').mockImplementation((from, to, ...rest) => {
        realCopy(from, to, ...rest);
        if (String(to).endsWith('Burrow-Setup-x64.exe')) fs.writeFileSync(to, Buffer.concat([Buffer.from('MZ'), Buffer.from('swapped')]));
      });
      try {
        await expect(runRelease(opts({ x64FromCi: '777' }), { root, env: {}, exec, log: () => {}, publishFn: vi.fn() })).rejects.toThrow(/changed between the download/);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('--x64-file (hand-built x64)', () => {
    const name = 'Burrow_0.2.0_x64-setup.exe';
    let src;
    beforeEach(() => {
      src = path.join(outDir, 'hand', name);
      fs.mkdirSync(path.dirname(src), { recursive: true });
      fs.writeFileSync(src, X64);
      fs.mkdirSync(publicDir, { recursive: true });
      fs.writeFileSync(path.join(publicDir, 'Burrow-Setup-arm64.exe'), ARM);
    });
    const go = (file, pe = async () => '0.2.0.0', extra = {}) => runRelease(opts({ x64File: file, ...extra }), { root, env: {}, exec: makeExec(), log: () => {}, publishFn: vi.fn(async () => ({})), peVersion: pe });

    it('stages a correctly named installer with an MZ header', async () => {
      await go(src);
      expect(fs.readFileSync(path.join(publicDir, 'Burrow-Setup-x64.exe'))).toEqual(X64);
    });

    it('refuses a wrong name, a non-exe and a wrong PE version, and tolerates an unreadable one', async () => {
      const wrong = path.join(outDir, 'hand', 'Burrow_0.1.0_x64-setup.exe');
      fs.copyFileSync(src, wrong);
      await expect(go(wrong)).rejects.toThrow(/must be named Burrow_0\.2\.0_x64-setup\.exe/);
      fs.writeFileSync(src, 'PK zip');
      await expect(go(src)).rejects.toThrow(/missing the MZ header/);
      fs.writeFileSync(src, X64);
      await expect(go(src, async () => '0.1.9.0')).rejects.toThrow(/version 0\.1\.9\.0, not 0\.2\.0/);
      await expect(go(src, async () => null)).resolves.toMatchObject({ published: false });
      await expect(go(path.join(outDir, 'hand', 'missing.exe'))).rejects.toThrow(/not a file/);
    });

    it('lets --skip-build --publish go on for the hand-built x64 when the ARM64 manifest matches', async () => {
      fs.mkdirSync(path.join(root, '.sidecar-build'));
      fs.writeFileSync(path.join(root, '.sidecar-build', 'server.cjs'), '/*! BURROW_CHANNEL=stable */');
      writeManifest(manifestFor({ installers: { arm64: manifestFor().installers.arm64 } }));
      const publishFn = vi.fn(async () => ({}));
      const res = await runRelease(opts({ x64File: src, publish: true, dryRun: false, yes: true }), { root, env: {}, exec: makeExec(), log: () => {}, publishFn, channelRun: () => 0, peVersion: async () => null, gumroadFn: vi.fn(async () => ({})) });
      expect(res.published).toBe(true);
    });
  });

  describe('--skip-build and the build manifest', () => {
    beforeEach(() => {
      stage();
      fs.mkdirSync(path.join(root, '.sidecar-build'));
      fs.writeFileSync(path.join(root, '.sidecar-build', 'server.cjs'), '/*! BURROW_CHANNEL=stable */');
    });
    const pub = (extra = {}) => {
      const publishFn = vi.fn(async () => ({}));
      const lines = [];
      const p = runRelease(opts({ publish: true, dryRun: false, yes: true, ...extra }), { root, env: {}, exec: makeExec(), log: (l) => lines.push(l), publishFn, channelRun: () => 0, gumroadFn: vi.fn(async () => ({})) });
      return { p, publishFn, lines };
    };

    it('--publish refuses without a manifest, and publishes nothing', async () => {
      const { p, publishFn } = pub();
      await expect(p).rejects.toThrow(/not tied to v0\.2\.0.*no build-manifest\.json/);
      expect(publishFn).not.toHaveBeenCalled();
    });

    it('--publish refuses a manifest for another commit, another version or a different file hash', async () => {
      writeManifest(manifestFor({ commit: 'd'.repeat(40) }));
      await expect(pub().p).rejects.toThrow(/made for commit ddddddd/);
      writeManifest(manifestFor({ version: '0.1.0' }));
      await expect(pub().p).rejects.toThrow(/is for version 0\.1\.0/);
      const m = manifestFor();
      m.installers.arm64.sha256 = H1;
      writeManifest(m);
      await expect(pub().p).rejects.toThrow(/Burrow-Setup-arm64\.exe is not the file that was built/);
      const m2 = manifestFor();
      m2.installers.x64.sha256 = H2;
      writeManifest(m2);
      await expect(pub().p).rejects.toThrow(/Burrow-Setup-x64\.exe is not the file that was built/);
      fs.writeFileSync(path.join(outDir, 'build-manifest.json'), 'not json');
      await expect(pub().p).rejects.toThrow(/no build-manifest\.json/);
    });

    it('--publish goes on when the manifest matches HEAD, the version and every hash', async () => {
      writeManifest();
      const { p, publishFn } = pub();
      await expect(p).resolves.toMatchObject({ published: true });
      expect(publishFn).toHaveBeenCalledTimes(1);
    });

    it('a dry run only warns', async () => {
      const lines = [];
      await runRelease(opts(), { root, env: {}, exec: makeExec(), log: (l) => lines.push(l), publishFn: vi.fn(async () => ({})), channelRun: () => 0 });
      expect(lines.join('\n')).toContain('Warning: not publishable with --skip-build');
    });
  });

  describe('building ARM64', () => {
    const arm = { hostTripleFn: () => 'aarch64-pc-windows-msvc', arch: 'arm64' };
    const nsis = () => path.join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
    const makeStep = (onTauri) => {
      const steps = [];
      const step = vi.fn((file, args) => {
        steps.push(args.map((a) => path.basename(a)));
        if (args.includes('--bundles')) onTauri();
      });
      return { step, steps };
    };
    const buildInstaller = () => {
      fs.mkdirSync(path.join(root, 'src-tauri', 'target', 'release'), { recursive: true });
      fs.writeFileSync(path.join(root, 'src-tauri', 'target', 'release', 'Burrow.exe'), Buffer.from('MZ burrow-distribution=direct'));
      fs.mkdirSync(nsis(), { recursive: true });
      fs.writeFileSync(path.join(nsis(), 'Burrow_0.2.0_arm64-setup.exe'), ARM);
    };
    const x64Src = () => {
      const f = path.join(outDir, 'Burrow_0.2.0_x64-setup.exe');
      fs.writeFileSync(f, X64);
      return f;
    };

    it('runs npm ci before npm run build, then writes build-manifest.json tied to HEAD', async () => {
      const { step, steps } = makeStep(buildInstaller);
      await runRelease(opts({ skipBuild: false, x64File: x64Src() }), { root, env: {}, exec: makeExec(), step, log: () => {}, publishFn: vi.fn(async () => ({})), channelRun: () => 0, peVersion: async () => null, ...arm });
      const flat = steps.map((s) => s.join(' '));
      const ci = flat.findIndex((s) => /\bci$/.test(s));
      const build = flat.findIndex((s) => /run build$/.test(s));
      expect(ci).toBeGreaterThanOrEqual(0);
      expect(ci).toBeLessThan(build);
      const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'build-manifest.json'), 'utf8'));
      expect(manifest).toMatchObject({ commit: HEAD, version: '0.2.0', tag: 'v0.2.0' });
      expect(manifest.installers.arm64).toMatchObject({ name: 'Burrow-Setup-arm64.exe', originalName: 'Burrow_0.2.0_arm64-setup.exe', sha256: sha(ARM) });
      expect(manifest.installers.x64).toMatchObject({ name: 'Burrow-Setup-x64.exe', originalName: 'Burrow_0.2.0_x64-setup.exe', sha256: sha(X64) });
    });

    it('refuses when the build left the worktree dirty (git status is checked again after the build)', async () => {
      let statusCalls = 0;
      const exec = makeExec({
        'git status --porcelain': async () => {
          statusCalls += 1;
          return { stdout: statusCalls === 1 ? '' : ' M package-lock.json\n', stderr: '' };
        },
      });
      const { step } = makeStep(buildInstaller);
      await expect(runRelease(opts({ skipBuild: false, x64File: x64Src() }), { root, env: {}, exec, step, log: () => {}, publishFn: vi.fn(), channelRun: () => 0, peVersion: async () => null, ...arm })).rejects.toThrow(/build changed files in the worktree/);
      expect(fs.existsSync(path.join(outDir, 'build-manifest.json'))).toBe(false);
    });
  });
});

describe('build manifest helpers', () => {
  const installers = [
    { name: 'Burrow-Setup-x64.exe', arch: 'x64', originalName: 'Burrow_0.2.0_x64-setup.exe', sha256: H1, source: 'hand-built' },
    { name: 'Burrow-Setup-arm64.exe', arch: 'arm64', originalName: 'Burrow_0.2.0_arm64-setup.exe', sha256: H2, source: 'built here' },
  ];
  const hashes = [{ name: 'Burrow-Setup-x64.exe', sha256: H1 }, { name: 'Burrow-Setup-arm64.exe', sha256: H2 }];

  it('records commit, version, original name and sha256 per arch', () => {
    const m = buildManifest({ commit: HEAD, version: '0.2.0', tag: 'v0.2.0', installers });
    expect(m).toMatchObject({ commit: HEAD, version: '0.2.0', tag: 'v0.2.0' });
    expect(m.installers.x64).toEqual({ name: 'Burrow-Setup-x64.exe', originalName: 'Burrow_0.2.0_x64-setup.exe', sha256: H1, source: 'hand-built' });
    expect(manifestProblems(m, { commit: HEAD, version: '0.2.0', hashes })).toEqual([]);
  });

  it('lists every difference', () => {
    const m = buildManifest({ commit: HEAD, version: '0.2.0', tag: 'v0.2.0', installers });
    expect(manifestProblems(null, { commit: HEAD, version: '0.2.0', hashes })[0]).toMatch(/no build-manifest\.json/);
    expect(manifestProblems(m, { commit: 'a'.repeat(40), version: '0.2.1', hashes })).toHaveLength(2);
    const swapped = [{ ...hashes[0], sha256: H2 }, hashes[1]];
    expect(manifestProblems(m, { commit: HEAD, version: '0.2.0', hashes: swapped })[0]).toMatch(/x64.exe is not the file that was built/);
    expect(manifestProblems(m, { commit: HEAD, version: '0.2.0', hashes: swapped, skip: ['Burrow-Setup-x64.exe'] })).toEqual([]);
  });

  it('x64 file name and PE version helpers', () => {
    expect(() => checkX64FileName(path.join('a', 'Burrow_0.2.0_x64-setup.exe'), '0.2.0')).not.toThrow();
    expect(() => checkX64FileName(path.join('a', 'Burrow-Setup-x64.exe'), '0.2.0')).toThrow(/must be named/);
    expect(checkPeVersion('0.2.0.0', '0.2.0')).toBe(true);
    expect(checkPeVersion('0.2.0', '0.2.0')).toBe(true);
    expect(checkPeVersion('', '0.2.0')).toBe(false);
    expect(checkPeVersion(null, '0.2.0')).toBe(false);
    expect(() => checkPeVersion('0.2.0-dev.1', '0.2.0')).toThrow(/not 0\.2\.0/);
    expect(() => checkPeVersion('0.2.01', '0.2.0')).toThrow();
  });
});
