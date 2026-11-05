import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ALLOWED_ASSETS,
  INSTALLER_ARM64,
  INSTALLER_X64,
  MAX_ASSET_BYTES,
  PUBLIC_REPO,
  SUMS_FILE,
  allowlistAssets,
  buildGhArgs,
  cleanChangelog,
  extractChangelogSection,
  missingAssets,
  publish,
  renderReleaseNotes,
  verifySums,
} from '../../scripts/release/publishPublic.js';

const EM_DASH = String.fromCharCode(0x2014);
const exe = (name, extra = {}) => ({ name, size: 1000, isFile: true, header: Buffer.from('MZ'), ...extra });
const sumsInfo = { name: SUMS_FILE, size: 200, isFile: true };
const good = () => [exe(INSTALLER_X64), exe(INSTALLER_ARM64), { ...sumsInfo }];

const CHANGELOG = `# Changelog

## [0.2.0](https://github.com/ChristianMunoz31/burrow/compare/v0.1.0...v0.2.0) (2026-10-05)


### Features

* **backup:** restore from a file ([#12](https://github.com/ChristianMunoz31/burrow/pull/12)) ([abc1234](https://github.com/ChristianMunoz31/burrow/commit/abc1234def5678abc1234def5678abc1234def56))
* add dark mode (#13) (0123abc)

### Bug Fixes

* **ui:** fix a typo ${EM_DASH} finally

## 0.1.0 (2026-09-01)

### Features

* first release
`;

describe('allowlistAssets', () => {
  it('accepts exactly the two installers and the checksum file', () => {
    expect(allowlistAssets(good())).toEqual([...ALLOWED_ASSETS].sort());
  });

  it('throws on any other file, including source-looking ones', () => {
    for (const name of ['burrow-0.2.0.zip', 'SHA256SUMS-desktop-windows.txt', 'Burrow_0.2.0_x64-setup.exe', 'server.js', 'burrow-setup-x64.exe']) {
      expect(() => allowlistAssets([...good(), { name, size: 10, isFile: true }])).toThrow(/Refusing to publish/);
    }
  });

  it('throws on a missing asset, a duplicate and a directory', () => {
    expect(() => allowlistAssets(good().slice(0, 2))).toThrow(/Missing asset/);
    expect(() => allowlistAssets([...good(), exe(INSTALLER_X64)])).toThrow(/Duplicate/);
    expect(() => allowlistAssets([exe(INSTALLER_X64, { isFile: false }), exe(INSTALLER_ARM64), sumsInfo])).toThrow(/not a regular file/);
  });

  it('rejects empty and oversized files', () => {
    expect(() => allowlistAssets([exe(INSTALLER_X64, { size: 0 }), exe(INSTALLER_ARM64), sumsInfo])).toThrow(/empty/);
    expect(() => allowlistAssets([exe(INSTALLER_X64, { size: MAX_ASSET_BYTES + 1 }), exe(INSTALLER_ARM64), sumsInfo])).toThrow(/limit/);
    expect(allowlistAssets([exe(INSTALLER_X64, { size: MAX_ASSET_BYTES }), exe(INSTALLER_ARM64), sumsInfo])).toHaveLength(3);
  });

  it('requires the MZ header on the exes only', () => {
    expect(() => allowlistAssets([exe(INSTALLER_X64, { header: Buffer.from('PK') }), exe(INSTALLER_ARM64), sumsInfo])).toThrow(/MZ/);
    expect(() => allowlistAssets([exe(INSTALLER_X64, { header: undefined }), exe(INSTALLER_ARM64), sumsInfo])).toThrow(/MZ/);
    expect(() => allowlistAssets([exe(INSTALLER_X64, { header: 'MZ' }), exe(INSTALLER_ARM64), { ...sumsInfo, header: Buffer.from('xx') }])).not.toThrow();
  });
});

describe('extractChangelogSection', () => {
  it('finds a linked heading and stops at the next version', () => {
    const section = extractChangelogSection(CHANGELOG, '0.2.0');
    expect(section).toContain('restore from a file');
    expect(section).toContain('### Bug Fixes');
    expect(section).not.toContain('first release');
  });

  it('finds a plain heading, accepts a leading v and is exact about the version', () => {
    expect(extractChangelogSection(CHANGELOG, 'v0.1.0')).toBe('### Features\n\n* first release');
    expect(extractChangelogSection(CHANGELOG, '0.2')).toBeNull();
    expect(extractChangelogSection(CHANGELOG, '0.2.0-dryrun.1')).toBeNull();
    expect(extractChangelogSection('', '0.1.0')).toBeNull();
  });

  it('handles CRLF', () => {
    expect(extractChangelogSection(CHANGELOG.replace(/\n/g, '\r\n'), '0.1.0')).toBe('### Features\n\n* first release');
  });
});

describe('release notes', () => {
  const sums = `${'a'.repeat(64)}  ${INSTALLER_X64}\n${'b'.repeat(64)}  ${INSTALLER_ARM64}\n`;
  const render = (section = extractChangelogSection(CHANGELOG, '0.2.0')) => renderReleaseNotes({ version: '0.2.0', section, sums });

  it('strips hashes, PR numbers and private links, and renames the headings', () => {
    const text = cleanChangelog(extractChangelogSection(CHANGELOG, '0.2.0'));
    expect(text).toContain('* **backup:** restore from a file');
    expect(text).toContain('* add dark mode');
    expect(text).toContain('### New');
    expect(text).toContain('### Fixed');
    expect(text).not.toMatch(/abc1234|0123abc|#12|#13|https?:|\]\(/);
  });

  it('has no em dashes and no private repo URL', () => {
    for (const notes of [render(), render(null), render('see https://github.com/ChristianMunoz31/burrow/issues/5')]) {
      expect(notes).not.toContain(EM_DASH);
      expect(notes).not.toMatch(/ChristianMunoz31\/burrow(?![-\w])/);
    }
  });

  it('explains SmartScreen, signing and checksum verification and lists the sums', () => {
    const notes = render();
    expect(notes).toContain('Windows protected your PC');
    expect(notes).toContain('More info');
    expect(notes).toContain('Run anyway');
    expect(notes).toMatch(/not code-signed/);
    expect(notes).toContain('Get-FileHash');
    expect(notes).toContain(`${'a'.repeat(64)}  ${INSTALLER_X64}`);
    expect(notes).toContain(`https://github.com/${PUBLIC_REPO}/releases/download/v0.2.0/${INSTALLER_X64}`);
  });

  it('falls back to a plain line when there is no section', () => {
    expect(render(null)).toContain('This release has no listed changes.');
  });
});

describe('verifySums', () => {
  const hashes = { [INSTALLER_X64]: 'a'.repeat(64), [INSTALLER_ARM64]: 'b'.repeat(64) };
  const line = (n, h) => `${h}  ${n}`;

  it('accepts matching sums in both sha256sum styles', () => {
    expect(() => verifySums(`${line(INSTALLER_X64, hashes[INSTALLER_X64])}\n${hashes[INSTALLER_ARM64]} *${INSTALLER_ARM64}\n`, hashes)).not.toThrow();
  });

  it('rejects a wrong hash, a missing line, an extra file and junk', () => {
    expect(() => verifySums(`${line(INSTALLER_X64, 'c'.repeat(64))}\n${line(INSTALLER_ARM64, hashes[INSTALLER_ARM64])}`, hashes)).toThrow(/does not match/);
    expect(() => verifySums(line(INSTALLER_X64, hashes[INSTALLER_X64]), hashes)).toThrow(/does not match/);
    expect(() => verifySums(`${line(INSTALLER_X64, hashes[INSTALLER_X64])}\n${line(INSTALLER_ARM64, hashes[INSTALLER_ARM64])}\n${line('x.zip', 'd'.repeat(64))}`, hashes)).toThrow(/unexpected/);
    expect(() => verifySums('not a checksum line', hashes)).toThrow(/Malformed/);
  });
});

describe('buildGhArgs', () => {
  const base = { tag: 'v0.2.0', assets: ['/a/x.exe', '/a/SHA256SUMS.txt'], notesFile: '/n/notes.md' };

  it('creates a full release marked latest in the public repo', () => {
    const [args, ...rest] = buildGhArgs({ ...base, exists: false });
    expect(rest).toEqual([]);
    expect(args.slice(0, 3)).toEqual(['release', 'create', 'v0.2.0']);
    expect(args).toEqual(expect.arrayContaining(['-R', PUBLIC_REPO, '--latest', '--notes-file', '/n/notes.md', '--title', 'Burrow 0.2.0']));
    expect(args).not.toContain('--draft');
  });

  it('never marks a draft or prerelease latest', () => {
    const draft = buildGhArgs({ ...base, draft: true, exists: false })[0];
    expect(draft).toContain('--draft');
    expect(draft).not.toContain('--latest');
    const pre = buildGhArgs({ ...base, prerelease: true, exists: false })[0];
    expect(pre).toContain('--prerelease');
    expect(pre).not.toContain('--latest');
  });

  it('uploads with --clobber then edits an existing release', () => {
    const [upload, edit] = buildGhArgs({ ...base, exists: true });
    expect(upload).toEqual(['release', 'upload', 'v0.2.0', ...base.assets, '-R', PUBLIC_REPO, '--clobber']);
    expect(edit.slice(0, 3)).toEqual(['release', 'edit', 'v0.2.0']);
    expect(edit).toEqual(expect.arrayContaining(['--latest', '--draft=false', '--prerelease=false', '-R', PUBLIC_REPO]));
    const editDraft = buildGhArgs({ ...base, draft: true, exists: true })[1];
    expect(editDraft).toContain('--draft=true');
    expect(editDraft).not.toContain('--latest');
  });

  it('validates its input and always targets only the public repo', () => {
    expect(() => buildGhArgs({ ...base, tag: 'main', exists: false })).toThrow(/tag/);
    expect(() => buildGhArgs({ ...base, assets: [], exists: false })).toThrow(/assets/);
    expect(() => buildGhArgs({ ...base, draft: true, prerelease: true, exists: false })).toThrow(/not both/);
    for (const exists of [true, false]) {
      for (const args of buildGhArgs({ ...base, exists })) {
        expect(args[args.indexOf('-R') + 1]).toBe(PUBLIC_REPO);
      }
    }
  });
});

describe('missingAssets', () => {
  it('reports absent and empty assets', () => {
    const view = { assets: [{ name: 'a', size: 5 }, { name: 'b', size: 0 }] };
    expect(missingAssets(view, ['a', 'b', 'c'])).toEqual(['b', 'c']);
    expect(missingAssets({}, ['a'])).toEqual(['a']);
  });
});

describe('publish (mocked gh)', () => {
  const makeDir = (overrides = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-publish-test-'));
    const x64 = Buffer.concat([Buffer.from('MZ'), Buffer.from('x64 installer')]);
    const arm = Buffer.concat([Buffer.from('MZ'), Buffer.from('arm64 installer')]);
    fs.writeFileSync(path.join(dir, INSTALLER_X64), x64);
    fs.writeFileSync(path.join(dir, INSTALLER_ARM64), arm);
    const h = (b) => crypto.createHash('sha256').update(b).digest('hex');
    fs.writeFileSync(path.join(dir, SUMS_FILE), `${h(x64)}  ${INSTALLER_X64}\n${h(arm)}  ${INSTALLER_ARM64}\n`);
    for (const [name, body] of Object.entries(overrides)) fs.writeFileSync(path.join(dir, name), body);
    return dir;
  };
  const changelog = (dir) => {
    const file = path.join(os.tmpdir(), `CHANGELOG-${path.basename(dir)}.md`);
    fs.writeFileSync(file, CHANGELOG);
    return file;
  };
  const quiet = { info: vi.fn(), warn: vi.fn() };
  const view = JSON.stringify({ tagName: 'v0.2.0', assets: ALLOWED_ASSETS.map((name) => ({ name, size: 10 })) });
  const isFinalView = (args) => args[1] === 'view' && args.includes('assets,isDraft,isPrerelease,tagName');

  it('dry run validates and prints a plan without calling gh or needing a token', async () => {
    const dir = makeDir();
    const exec = vi.fn();
    const out = await publish({ updater: { enabled: false }, tag: 'v0.2.0', assetsDir: dir, notesFrom: changelog(dir), dryRun: true, env: {}, exec, log: quiet });
    expect(exec).not.toHaveBeenCalled();
    expect(out.plan[0]).toContain('--latest');
    expect(out.notes).toContain('Restore from a file');
  });

  it('dry run for a dry-run tag falls back to the base version section', async () => {
    const dir = makeDir();
    const out = await publish({ updater: { enabled: false }, tag: 'v0.2.0-dryrun.1', assetsDir: dir, notesFrom: changelog(dir), dryRun: true, env: {}, exec: vi.fn(), log: quiet });
    expect(out.notes).toContain('Restore from a file');
  });

  it('refuses a stray file before any gh call', async () => {
    const dir = makeDir({ 'server.js': 'console.log(1)' });
    const exec = vi.fn();
    await expect(publish({ updater: { enabled: false }, tag: 'v0.2.0', assetsDir: dir, dryRun: true, env: {}, exec, log: quiet })).rejects.toThrow(/Refusing to publish/);
    expect(exec).not.toHaveBeenCalled();
  });

  it('refuses sums that do not match the installers', async () => {
    const dir = makeDir({ [SUMS_FILE]: `${'0'.repeat(64)}  ${INSTALLER_X64}\n${'1'.repeat(64)}  ${INSTALLER_ARM64}\n` });
    await expect(publish({ updater: { enabled: false }, tag: 'v0.2.0', assetsDir: dir, dryRun: true, env: {}, exec: vi.fn(), log: quiet })).rejects.toThrow(/does not match/);
  });

  it('fails early with an empty token and never calls gh', async () => {
    const dir = makeDir();
    const exec = vi.fn();
    await expect(publish({ updater: { enabled: false }, tag: 'v0.2.0', assetsDir: dir, env: { GH_TOKEN: '' }, exec, log: quiet })).rejects.toThrow(/RELEASES_TOKEN/);
    expect(exec).not.toHaveBeenCalled();
  });

  it('creates a new release, passes the token only through the environment, and verifies latest', async () => {
    const dir = makeDir();
    const token = 'tok-secret-123';
    const exec = vi.fn(async (_file, args) => {
      if (args[1] === 'view' && !isFinalView(args)) {
        throw Object.assign(new Error('Command failed'), { stderr: 'release not found' });
      }
      if (args[0] === 'api') return { stdout: JSON.stringify({ tag_name: 'v0.2.0' }), stderr: '' };
      if (isFinalView(args)) return { stdout: view, stderr: '' };
      return { stdout: '', stderr: '' };
    });
    await publish({
      updater: { enabled: false },
      tag: 'v0.2.0', assetsDir: dir, notesFrom: changelog(dir), env: { GH_TOKEN: token, GITHUB_TOKEN: 'other', GH_REPO: 'x/y', PATH: 'p' }, exec, log: quiet,
    });
    const calls = exec.mock.calls;
    expect(calls.every(([file]) => file === 'gh')).toBe(true);
    expect(calls.some(([, args]) => args[1] === 'create')).toBe(true);
    expect(calls.some(([, args]) => args[1] === 'upload')).toBe(false);
    for (const [, args, opts] of calls) {
      expect(JSON.stringify(args)).not.toContain(token);
      expect(opts.env.GH_TOKEN).toBe(token);
      expect(opts.env.GITHUB_TOKEN).toBeUndefined();
      expect(opts.env.GH_REPO).toBeUndefined();
      expect(opts.shell).toBeUndefined();
    }
  });

  it('uploads with --clobber and edits when the release already exists', async () => {
    const dir = makeDir();
    const exec = vi.fn(async (_file, args) => {
      if (args[0] === 'api') return { stdout: JSON.stringify({ tag_name: 'v0.2.0' }), stderr: '' };
      if (isFinalView(args)) return { stdout: view, stderr: '' };
      return { stdout: '{}', stderr: '' };
    });
    await publish({ updater: { enabled: false }, tag: 'v0.2.0', assetsDir: dir, env: { GH_TOKEN: 'tok-test-1234' }, exec, log: quiet });
    const verbs = exec.mock.calls.map(([, args]) => args[1]);
    expect(verbs).toEqual(['view', 'upload', 'edit', 'view', 'repos/ChristianMunoz31/burrow-releases/releases/latest']);
    expect(exec.mock.calls[1][1]).toContain('--clobber');
    expect(exec.mock.calls[2][1]).toContain('--latest');
  });

  it('does not treat other gh failures as "release missing" and redacts the token', async () => {
    const dir = makeDir();
    const exec = vi.fn(async () => {
      throw Object.assign(new Error('boom'), { stderr: 'HTTP 401 tok-abc bad credentials' });
    });
    const err = await publish({ updater: { enabled: false }, tag: 'v0.2.0', assetsDir: dir, env: { GH_TOKEN: 'tok-abc' }, exec, log: quiet }).catch((e) => e);
    expect(err.message).toMatch(/failed/);
    expect(err.message).not.toContain('tok-abc');
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('fails when latest points at another tag', async () => {
    const dir = makeDir();
    const exec = vi.fn(async (_file, args) => {
      if (args[0] === 'api') return { stdout: JSON.stringify({ tag_name: 'v9.9.9' }), stderr: '' };
      if (isFinalView(args)) return { stdout: view, stderr: '' };
      return { stdout: '{}', stderr: '' };
    });
    await expect(publish({ updater: { enabled: false }, tag: 'v0.2.0', assetsDir: dir, env: { GH_TOKEN: 'tok-test-1234' }, exec, log: quiet })).rejects.toThrow(/Latest release is v9.9.9/);
  });

  it('a draft skips the latest check', async () => {
    const dir = makeDir();
    const exec = vi.fn(async (_file, args) => {
      if (args[1] === 'view' && !isFinalView(args)) throw Object.assign(new Error('x'), { stderr: 'release not found' });
      if (isFinalView(args)) return { stdout: view, stderr: '' };
      return { stdout: '', stderr: '' };
    });
    await publish({ updater: { enabled: false }, tag: 'v0.2.0', assetsDir: dir, draft: true, env: { GH_TOKEN: 'tok-test-1234' }, exec, log: quiet });
    expect(exec.mock.calls.some(([, args]) => args[0] === 'api')).toBe(false);
  });
});

describe('dev tags', () => {
  it('refuses to build publish arguments for a -dev tag', () => {
    expect(() => buildGhArgs({ tag: 'v0.3.0-dev.4', assets: ['a'], notesFile: 'n', exists: false })).toThrow(/Burrow Dev/);
  });
});

describe('checksum instructions', () => {
  it('has the one-line Get-FileHash instruction pointing at SHA256SUMS.txt', () => {
    const notes = renderReleaseNotes({ version: '0.2.0', tag: 'v0.2.0', section: '### Features\n\n* a thing', sums: 'aa  Burrow-Setup-x64.exe\nbb  Burrow-Setup-arm64.exe' });
    expect(notes).toContain('`Get-FileHash .\\Burrow-Setup-x64.exe -Algorithm SHA256`, then compare it to SHA256SUMS.txt.');
    expect(notes).not.toMatch(/SHA256SUMS-desktop/);
  });
});
