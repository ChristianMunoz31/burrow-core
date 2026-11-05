// User-facing public release notes: the filter is run on the real v0.2.0 CHANGELOG section, plus the
// curated "What's new" block (release-notes/vX.Y.Z.md).
import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  INSTALLER_ARM64,
  INSTALLER_X64,
  SUMS_FILE,
  extractChangelogSection,
  isUserFacingEntry,
  linkedReleaseTags,
  loadCuratedNotes,
  publish,
  renderReleaseNotes,
  userFacingChanges,
} from '../../scripts/release/publishPublic.js';

const EM_DASH = String.fromCharCode(0x2014);
const real = extractChangelogSection(fs.readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8'), '0.2.0');
const INTERNAL = /docker|\bci\b|workflow|sidecar|signed license files?|ed25519|worker|lockfile|dependabot|\bnsis\b|\btauri\b|\bnpm\b/i;
const sums = `${'a'.repeat(64)}  ${INSTALLER_X64}`;

describe('user-facing changes from the real v0.2.0 section', () => {
  it('finds the real section', () => {
    expect(real).toContain('### Features');
  });

  it('keeps only Features, Bug Fixes and Performance and names them for users', () => {
    const text = userFacingChanges(real);
    const headings = [...text.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
    expect(headings.length).toBeGreaterThan(0);
    for (const h of headings) expect(['New', 'Fixed', 'Faster']).toContain(h);
    expect(text).not.toMatch(/BREAKING|refactor|Documentation|### Docs/i);
  });

  it('drops every internal entry and keeps the product ones', () => {
    const text = userFacingChanges(real);
    expect(text).not.toMatch(INTERNAL);
    expect(text).toMatch(/automatic daily local backups/i);
    expect(text).toMatch(/Import transactions from a CSV file/);
    expect(text).toMatch(/Ollama setup/);
    expect(text).not.toMatch(/\*\*|\(#\d+\)|closes #|&gt;/);
    for (const line of text.split('\n').filter((l) => l.trim() && !l.startsWith('###'))) expect(line).toMatch(/^- [A-Z]/);
  });

  it('the full notes keep the SmartScreen note and the checksum steps', () => {
    const notes = renderReleaseNotes({ version: '0.2.0', section: real, sums });
    const whatsNew = notes.slice(notes.indexOf('## What'), notes.indexOf('## Download'));
    expect(whatsNew).not.toMatch(INTERNAL);
    expect(notes).toContain('Windows protected your PC');
    expect(notes).toContain('Get-FileHash');
    expect(notes).not.toContain(EM_DASH);
  });
});

describe('isUserFacingEntry', () => {
  it.each([
    ['**ci:** pin the runner image', false],
    ['**test:** add a fixture', false],
    ['**docs:** explain backups', false],
    ['**chore:** bump a thing', false],
    ['**refactor:** split a module', false],
    ['**build:** change the bundler', false],
    ['**deps:** bump vite', false],
    ['**release:** emit sums', false],
    ['docs: explain backups', false],
    ['chore(deps): bump vite', false],
    ['**backup:** run the export in a worker thread', false],
    ['**ai:** pin the docker image', false],
    ['**ui:** fix the CI badge', false],
    ['**license:** verify signed license files offline', false],
    ['**license:** sign with Ed25519', false],
    ['**deps:** refresh the lockfile', false],
    ['**release:** run the sidecar smoke test', false],
    ['**backup:** add automatic daily local backups', true],
    ['**budget:** import transactions from a CSV file', true],
    ['add dark mode', true],
    ['', false],
  ])('%j is %s', (entry, expected) => {
    expect(isUserFacingEntry(entry)).toBe(expected);
  });

  it('says so plainly when only internal entries are left', () => {
    const section = '### Features\n\n* **ci:** add a job\n\n### refactor\n\n* tidy';
    expect(userFacingChanges(section)).toBe('');
    expect(renderReleaseNotes({ version: '0.3.0', section, sums: 'aa  x' })).toContain('behind-the-scenes improvements');
  });
});

describe('release-notes/v0.2.0.md (the hand-written public notes)', () => {
  const text = fs.readFileSync(new URL('../../release-notes/v0.2.0.md', import.meta.url), 'utf8');

  it('is a complete document with the download, SmartScreen and checksum steps', () => {
    expect(text).toMatch(/^## Download/m);
    expect(text).toContain('Burrow-Setup-x64.exe');
    expect(text).toContain('Burrow-Setup-arm64.exe');
    expect(text).toContain('Windows protected your PC');
    expect(text).toContain('Get-FileHash');
    expect(text).toContain('SHA256SUMS.txt');
    expect(renderReleaseNotes({ version: '0.2.0', section: real, sums, curated: text })).toBe(`${text.trim()}\n`);
  });

  it('has no em dashes, no private repo links and none of the internal or service wording', () => {
    expect(text).not.toContain(EM_DASH);
    expect(text).not.toMatch(/ChristianMunoz31\/burrow(?![-\w])/);
    expect(text).not.toMatch(/docker|signed license|ed25519|worker|lockfile|sidecar|\bAI\b|chatbot/i);
  });
});

describe('a curated block', () => {
  it('replaces the changelog list verbatim and keeps the download, SmartScreen and checksum parts', () => {
    const curated = 'Burrow keeps your budget private.\r\n\r\n- One\n- Two';
    const notes = renderReleaseNotes({ version: '0.2.0', section: real, sums, curated });
    expect(notes).toContain('Burrow keeps your budget private.\n\n- One\n- Two\n\n## Download');
    expect(notes).not.toContain('automatic daily local backups');
    expect(notes).toContain('Windows protected your PC');
    expect(notes).toContain('Get-FileHash');
  });

  it('is the complete notes when it already has a Download section', () => {
    const full = '# Burrow 0.2.0\n\nHello.\n\n## Download\n\nGet it.';
    expect(renderReleaseNotes({ version: '0.2.0', section: real, sums, curated: full })).toBe(`${full}\n`);
  });

  it('an empty curated text falls back to the filtered list', () => {
    expect(renderReleaseNotes({ version: '0.2.0', section: real, sums, curated: '  \n ' })).toContain(
      'automatic daily local backups',
    );
  });

  it('loadCuratedNotes reads release-notes/<tag>.md next to the changelog, with the base-version fallback', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-curated-'));
    const changelog = path.join(dir, 'CHANGELOG.md');
    fs.writeFileSync(changelog, '# Changelog');
    expect(loadCuratedNotes({ tag: 'v9.9.9', notesFrom: changelog })).toBeNull();
    fs.mkdirSync(path.join(dir, 'release-notes'));
    fs.writeFileSync(path.join(dir, 'release-notes', 'v9.9.9.md'), '\nFrom the file\n');
    expect(loadCuratedNotes({ tag: 'v9.9.9', notesFrom: changelog })).toBe('From the file');
    expect(loadCuratedNotes({ tag: 'v9.9.9-dryrun.1', notesFrom: changelog })).toBe('From the file');
  });

  it('publish uses the file in a dry run and refuses an em dash or a private repo link in it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-curated-pub-'));
    const assets = path.join(dir, 'assets');
    fs.mkdirSync(assets);
    const x64 = Buffer.concat([Buffer.from('MZ'), Buffer.from('x64')]);
    const arm = Buffer.concat([Buffer.from('MZ'), Buffer.from('arm')]);
    fs.writeFileSync(path.join(assets, INSTALLER_X64), x64);
    fs.writeFileSync(path.join(assets, INSTALLER_ARM64), arm);
    const h = (b) => crypto.createHash('sha256').update(b).digest('hex');
    fs.writeFileSync(path.join(assets, SUMS_FILE), `${h(x64)}  ${INSTALLER_X64}\n${h(arm)}  ${INSTALLER_ARM64}\n`);
    const changelog = path.join(dir, 'CHANGELOG.md');
    fs.writeFileSync(changelog, '## 0.2.0 (2026-10-05)\n\n### Features\n\n* **backup:** daily backups\n');
    fs.mkdirSync(path.join(dir, 'release-notes'));
    const file = path.join(dir, 'release-notes', 'v0.2.0.md');
    const quiet = { info: vi.fn(), warn: vi.fn() };
    const run = () =>
      publish({ updater: { enabled: false }, tag: 'v0.2.0', assetsDir: assets, notesFrom: changelog, dryRun: true, env: {}, exec: vi.fn(), log: quiet });

    fs.writeFileSync(file, 'Hand written intro.');
    const out = await run();
    expect(out.notes).toContain('Hand written intro.');
    expect(out.notes).not.toContain('daily backups');

    fs.writeFileSync(file, `Bad ${EM_DASH} text`);
    await expect(run()).rejects.toThrow(/em dash/);
    fs.writeFileSync(file, 'See https://github.com/ChristianMunoz31/burrow/issues/1');
    await expect(run()).rejects.toThrow(/private repo/);
  });
});

describe('guards on hand-written notes', () => {
  const BASE = 'https://github.com/ChristianMunoz31/burrow-releases/releases';

  /** Temp assets with valid hashes; `notesText` becomes release-notes/v0.2.0.md when given. */
  function setup(notesText) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-guard-'));
    const assets = path.join(dir, 'assets');
    fs.mkdirSync(assets);
    const x64 = Buffer.concat([Buffer.from('MZ'), Buffer.from('x64')]);
    const arm = Buffer.concat([Buffer.from('MZ'), Buffer.from('arm')]);
    fs.writeFileSync(path.join(assets, INSTALLER_X64), x64);
    fs.writeFileSync(path.join(assets, INSTALLER_ARM64), arm);
    const h = (b) => crypto.createHash('sha256').update(b).digest('hex');
    fs.writeFileSync(path.join(assets, SUMS_FILE), [`${h(x64)}  ${INSTALLER_X64}`, `${h(arm)}  ${INSTALLER_ARM64}`, ''].join('\n'));
    const changelog = path.join(dir, 'CHANGELOG.md');
    fs.writeFileSync(changelog, ['## 0.2.0 (2026-10-05)', '', '### Features', '', '* **backup:** daily backups', ''].join('\n'));
    if (notesText !== undefined) {
      fs.mkdirSync(path.join(dir, 'release-notes'));
      fs.writeFileSync(path.join(dir, 'release-notes', 'v0.2.0.md'), notesText);
    }
    const quiet = { info: vi.fn(), warn: vi.fn() };
    return (tag) => publish({ updater: { enabled: false }, tag, assetsDir: assets, notesFrom: changelog, dryRun: true, env: {}, exec: vi.fn(), log: quiet });
  }

  it('the private repo guard ignores letter case', async () => {
    for (const link of ['https://github.com/christianmunoz31/burrow/issues/1', 'https://github.com/CHRISTIANMUNOZ31/Burrow']) {
      await expect(setup(`See ${link}`)('v0.2.0')).rejects.toThrow(/private repo/);
    }
    // the public repo name starts the same way and must not trip the guard
    await expect(setup(`See ${BASE}`)('v0.2.0')).resolves.toBeTruthy();
  });

  it('finds the tag of release links and ignores links without one', () => {
    const text = `[a](${BASE}/download/v0.2.0/Burrow-Setup-x64.exe) [b](${BASE}/tag/v0.3.0) [c](${BASE}/latest/download/x.exe) [d](${BASE})`;
    expect(linkedReleaseTags(text)).toEqual(['v0.2.0', 'v0.3.0']);
  });

  it('a prerelease tag that falls back to the stable notes file fails when that file links to the stable tag', async () => {
    const run = setup(`Get it: ${BASE}/download/v0.2.0/Burrow-Setup-x64.exe`);
    const err = await run('v0.2.0-rc.1').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('link to v0.2.0, not v0.2.0-rc.1');
    await expect(run('v0.2.0')).resolves.toBeTruthy(); // the stable tag may link to itself
  });

  it('a prerelease tag may reuse notes that link to no tag', async () => {
    const run = setup(`Intro. See all versions on the releases page: ${BASE}`);
    await expect(run('v0.2.0-rc.1')).resolves.toBeTruthy();
  });
});
