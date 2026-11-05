import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildLatestJson, generateLatestJson, updaterNotes } from '../../scripts/release/updaterManifest.js';
import { PUBKEY_PLACEHOLDER } from '../../scripts/release/updaterConfig.js';
import { makeOverlayRoot, makeTestKey } from './helpers/updaterSigning.js';

const EM_DASH = String.fromCharCode(0x2014);
const SIG_X64 = 'c2lnLXg2NC10ZXN0LWZpeHR1cmU=';
const SIG_ARM = 'c2lnLWFybTY0LXRlc3QtZml4dHVyZQ==';
const NOW = '2026-10-07T12:00:00.789Z';
const BASE = 'https://github.com/ChristianMunoz31/burrow-releases/releases/download';

describe('buildLatestJson', () => {
  it('writes the exact Tauri v2 static manifest', () => {
    const text = buildLatestJson({ tag: 'v0.5.0', sigX64: `${SIG_X64}\n`, sigArm64: SIG_ARM, notes: 'New:\n- A line', now: NOW });
    expect(text).toBe(`${JSON.stringify({
      version: '0.5.0',
      notes: 'New:\n- A line',
      pub_date: '2026-10-07T12:00:00Z',
      platforms: {
        'windows-x86_64': { signature: SIG_X64, url: `${BASE}/v0.5.0/Burrow-Setup-x64.exe` },
        'windows-aarch64': { signature: SIG_ARM, url: `${BASE}/v0.5.0/Burrow-Setup-arm64.exe` },
      },
    }, null, 2)}\n`);
    expect(text.endsWith('}\n')).toBe(true);
  });

  it('has only the two platform keys (no -nsis keys) and exactly the four top-level keys', () => {
    const json = JSON.parse(buildLatestJson({ tag: 'v1.2.3', sigX64: SIG_X64, sigArm64: SIG_ARM, notes: 'x', now: NOW }));
    expect(Object.keys(json)).toEqual(['version', 'notes', 'pub_date', 'platforms']);
    expect(Object.keys(json.platforms)).toEqual(['windows-x86_64', 'windows-aarch64']);
    for (const entry of Object.values(json.platforms)) expect(Object.keys(entry)).toEqual(['signature', 'url']);
  });

  it('refuses a bad tag, a dev tag, a missing or non-base64 signature and a bad date', () => {
    const ok = { tag: 'v0.5.0', sigX64: SIG_X64, sigArm64: SIG_ARM, notes: 'x', now: NOW };
    expect(() => buildLatestJson({ ...ok, tag: '0.5.0' })).toThrow(/Unexpected tag/);
    expect(() => buildLatestJson({ ...ok, tag: 'v0.5.0-dev.1' })).toThrow(/Burrow Dev/);
    expect(() => buildLatestJson({ ...ok, sigX64: '' })).toThrow(/Burrow-Setup-x64\.exe\.sig/);
    expect(() => buildLatestJson({ ...ok, sigArm64: 'not base64 !!' })).toThrow(/Burrow-Setup-arm64\.exe\.sig/);
    expect(() => buildLatestJson({ ...ok, now: 'yesterday' })).toThrow(/valid date/);
  });
});

describe('updaterNotes', () => {
  it('turns release-please sections into plain text', () => {
    const section = [
      '### Features',
      '',
      '* **backup:** restore from a file ([#12](https://github.com/ChristianMunoz31/burrow/pull/12)) ([abc1234](https://github.com/ChristianMunoz31/burrow/commit/abc1234def5678abc1234def5678abc1234def56))',
      '* add `dark` mode (#13)',
      '',
      '### Bug Fixes',
      '',
      '* fix a typo',
    ].join('\n');
    expect(updaterNotes({ section })).toBe('New:\n- Restore from a file\n- Add dark mode\nFixed:\n- Fix a typo');
  });

  it('strips markdown from curated text, drops blank lines and keeps bullets', () => {
    const curated = '### Faster\n\n* The **home page** opens quicker, see [the docs](https://example.invalid/x)\n+ Another `thing` https://example.invalid/y\n';
    expect(updaterNotes({ section: null, curated })).toBe('Faster:\n- The home page opens quicker, see the docs\n- Another thing');
  });

  it('a full curated document gives only its What\'s new section', () => {
    const curated = ['# Burrow 0.5.0', '', "## What's new", '', '- Better backups', '- Faster search', '', '## Download', '', '- [Burrow-Setup-x64.exe](https://example.invalid/a.exe)', '', '## Windows may warn you', 'Run anyway.'].join('\n');
    expect(updaterNotes({ section: null, curated })).toBe('- Better backups\n- Faster search');
  });

  it('caps at 1500 characters, cut at a line boundary', () => {
    const line = `- ${'word '.repeat(19).trim()}`;
    const curated = Array.from({ length: 60 }, () => line).join('\n');
    const notes = updaterNotes({ section: null, curated });
    expect(notes.length).toBeLessThanOrEqual(1500);
    expect(notes.split('\n').every((l) => l === line)).toBe(true);
    expect(notes.length).toBeGreaterThan(1400);
  });

  it('has fallback wording and refuses an em dash or a private repo mention', () => {
    expect(updaterNotes({ section: null })).toBe('This release has no listed changes.');
    expect(updaterNotes({ section: '### Refactor\n\n* internal' })).toBe('This release has behind-the-scenes improvements.');
    expect(() => updaterNotes({ section: null, curated: `- Fast ${EM_DASH} faster` })).toThrow(/em dash/);
    expect(() => updaterNotes({ section: null, curated: '- See ChristianMunoz31/burrow/issues/5' })).toThrow(/private repository/);
    expect(updaterNotes({ section: null, curated: '- A fix for ChristianMunoz31/burrow-releases links' })).toContain('burrow-releases');
  });

  it('never produces markdown link syntax', () => {
    const notes = updaterNotes({ section: null, curated: '- [one](https://example.invalid) and ![img](x.png) and **bold**' });
    expect(notes).not.toMatch(/[[\]()*`]|https?:/);
  });
});

describe('generateLatestJson (the CLI core)', () => {
  const cleanups = [];
  afterEach(() => cleanups.splice(0).forEach((fn) => fn()));
  const assets = (withSigs = true) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-manifest-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    if (withSigs) {
      fs.writeFileSync(path.join(dir, 'Burrow-Setup-x64.exe.sig'), SIG_X64);
      fs.writeFileSync(path.join(dir, 'Burrow-Setup-arm64.exe.sig'), `${SIG_ARM}\n`);
    }
    return dir;
  };
  const changelog = (dir) => {
    const file = path.join(dir, 'CHANGELOG.md');
    fs.writeFileSync(file, '# Changelog\n\n## [0.5.0](https://example.invalid) (2026-10-07)\n\n### Features\n\n* add dark mode\n');
    return file;
  };

  it('is a no-op while the updater is off', () => {
    const made = makeOverlayRoot(PUBKEY_PLACEHOLDER);
    cleanups.push(made.cleanup);
    const dir = assets();
    const lines = [];
    expect(generateLatestJson({ tag: 'v0.5.0', assetsDir: dir, root: made.root, log: (l) => lines.push(l) })).toEqual({ written: false, file: null });
    expect(fs.existsSync(path.join(dir, 'latest.json'))).toBe(false);
    expect(lines.join('\n')).toContain('updater is off');
  });

  it('writes latest.json from the two .sig files and the changelog when on', () => {
    const made = makeOverlayRoot(makeTestKey().pubkeyB64);
    cleanups.push(made.cleanup);
    const dir = assets();
    const out = generateLatestJson({ tag: 'v0.5.0', assetsDir: dir, notesFrom: changelog(dir), now: NOW, root: made.root, log: () => {} });
    expect(out).toEqual({ written: true, file: path.join(dir, 'latest.json') });
    const json = JSON.parse(fs.readFileSync(out.file, 'utf8'));
    expect(json).toMatchObject({ version: '0.5.0', notes: 'New:\n- Add dark mode', pub_date: '2026-10-07T12:00:00Z' });
    expect(json.platforms['windows-x86_64'].signature).toBe(SIG_X64);
    expect(json.platforms['windows-aarch64'].signature).toBe(SIG_ARM);
  });

  it('fails clearly when a .sig is missing while the updater is on', () => {
    const made = makeOverlayRoot(makeTestKey().pubkeyB64);
    cleanups.push(made.cleanup);
    expect(() => generateLatestJson({ tag: 'v0.5.0', assetsDir: assets(false), root: made.root, log: () => {} })).toThrow(/Burrow-Setup-x64\.exe\.sig is missing/);
  });
});
