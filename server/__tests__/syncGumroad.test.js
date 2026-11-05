// Tests for scripts/release/syncGumroad.mjs. The real Gumroad CLI is never run: a small fake CLI (a node script
// passed with --cli) keeps product descriptions in a temp JSON file and records every call.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyParagraph,
  backupFileName,
  bannedWordingElsewhere,
  buildWhatsNew,
  changelogItems,
  checkCopy,
  contentText,
  loadProducts,
  parseCliArgs,
  renderDiff,
  renderParagraph,
  runSync,
  timestamp,
  versionGuardProblems,
} from '../../scripts/release/syncGumroad.mjs';

const EM_DASH = String.fromCharCode(0x2014);
const PRO = 'pro-id==';
const FREE = 'free-id==';
const DOWNLOAD = 'download-id==';

const CHANGELOG = `# Changelog

## [0.2.0](https://github.com/ChristianMunoz31/burrow/compare/v0.1.0...v0.2.0) (2026-10-05)

### Features

* **backup:** add automatic daily local backups with verified restore ([#12](https://github.com/x/y/pull/12))
* **budget:** import transactions from a CSV file
* **ai:** a new AI service for everyone
* **notes:** add pinned notes

### Bug Fixes

* **ui:** fix a typo in the footer, closes #8

### Documentation

* **docs:** rewrite the contributing guide

## 0.1.0 (2026-09-01)

### Features

* first release
`;

const FAKE_CLI = `
const fs = require('node:fs');
const [group, cmd, id, ...rest] = process.argv.slice(2);
const stateFile = process.env.FAKE_STATE;
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const dir = process.env.FAKE_BACKUP_DIR;
const backups = dir && fs.existsSync(dir) ? fs.readdirSync(dir) : [];
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ call: group + ' ' + cmd, id, backups }) + '\\n');
if (group !== 'products') { process.stderr.write('unknown command'); process.exit(2); }
if (cmd === 'view') {
  if (!(id in state)) { process.stderr.write('product not found'); process.exit(1); }
  process.stdout.write(JSON.stringify({ success: true, product: { id, name: 'Product ' + id, description: state[id], ...(state.__noReceipt ? {} : { custom_receipt: (state.__receipt || {})[id] || '' }) } }));
} else if (cmd === 'content') {
  const pid = rest[0];
  if (!(pid in state)) { process.stderr.write('product not found'); process.exit(1); }
  process.stdout.write(JSON.stringify({ success: true, content: [{ type: 'paragraph', text: (state.__content || {})[pid] || '' }, { type: 'file', id: 'f1', url: 'https://cdn.test/v9.8.7/setup.exe', file_name: 'Burrow-9.8.7.exe', updated_at: '2026-01-01T00:00:00.000Z' }] }));
} else if (cmd === 'update') {
  const at = rest.indexOf('--description');
  state[id] = rest[at + 1];
  fs.writeFileSync(stateFile, JSON.stringify(state));
  process.stdout.write(JSON.stringify({ success: true }));
} else { process.stderr.write('unsupported'); process.exit(2); }
`;

describe('parseCliArgs', () => {
  it('defaults to a dry run', () => {
    expect(parseCliArgs([])).toMatchObject({ dryRun: true, publish: false, yes: false, cli: null, backupDir: null, tag: null });
  });

  it('--publish turns the dry run off; both together is refused; the tag is stable only', () => {
    expect(parseCliArgs(['--publish', '--yes', '--cli', 'x.exe', '--backup-dir', 'b', '--tag', 'v1.2.3'])).toMatchObject({
      dryRun: false, publish: true, yes: true, cli: 'x.exe', backupDir: 'b', tag: 'v1.2.3',
    });
    expect(() => parseCliArgs(['--dry-run', '--publish'])).toThrow(/not both/);
    expect(() => parseCliArgs(['--tag', 'v1.2.3-rc.1'])).toThrow(/stable release tag/);
    expect(() => parseCliArgs(['--nope'])).toThrow();
  });
});

describe('copy rule', () => {
  it('rejects the banned phrases', () => {
    for (const bad of [
      'A new AI service for everyone',
      'Get access to AI today',
      'Access to an AI assistant',
      'Includes AI tools',
      'Meet the Burrow chatbot',
      'An AI chat bot',
      `Great ${EM_DASH} really`,
    ]) {
      expect(checkCopy(bad).length, bad).toBeGreaterThan(0);
    }
  });

  it('accepts the approved wording', () => {
    for (const ok of ['A desktop app with a built-in helper', 'Your data stays on your computer', 'Add pinned notes; fix a typo']) {
      expect(checkCopy(ok), ok).toEqual([]);
    }
  });

  it('renderParagraph refuses banned text and escapes HTML', () => {
    expect(() => renderParagraph('0.2.0', 'adds access to AI')).toThrow(/store copy rule/);
    expect(renderParagraph('0.2.0', 'Fix <b>bold</b> & more.')).toBe("<p>Latest version: 0.2.0. What's new: Fix &lt;b&gt;bold&lt;/b&gt; &amp; more.</p>");
  });
});

describe('applyParagraph', () => {
  const p1 = renderParagraph('0.2.0', 'New thing');

  it('appends when there is no paragraph yet and leaves the rest byte for byte', () => {
    const r = applyParagraph('<p>About</p>\n<ul><li>a</li></ul>', p1);
    expect(r).toEqual({ next: `<p>About</p>\n<ul><li>a</li></ul>\n${p1}`, before: null, changed: true });
    expect(applyParagraph('', p1).next).toBe(p1);
  });

  it('replaces the existing paragraph in place, even with attributes', () => {
    const old = '<p class="x">Latest version: 0.1.0. What\'s new: old stuff.</p>';
    const r = applyParagraph(`<h2>Hi</h2>${old}<p>Tail</p>`, p1);
    expect(r.next).toBe(`<h2>Hi</h2>${p1}<p>Tail</p>`);
    expect(r.before).toBe(old);
  });

  it('does not mistake <pre> for a paragraph, and finds the line inside <p><strong>', () => {
    const pre = '<pre>Latest version: 0.1.0. keep me</pre>';
    const r1 = applyParagraph(pre, p1);
    expect(r1.before).toBeNull();
    expect(r1.next).toBe(`${pre}\n${p1}`);
    const strong = '<p><strong>Latest version: 0.1.0.</strong> What\'s new: old.</p>';
    const r2 = applyParagraph(`<p>A</p>${strong}<p>Tail</p>`, p1);
    expect(r2.before).toBe(strong);
    expect(r2.next).toBe(`<p>A</p>${p1}<p>Tail</p>`);
    const spaced = '<p class="x">\n  <em> Latest version: 0.1.0.</em></p>';
    expect(applyParagraph(spaced, p1).next).toBe(p1);
    // Text that merely mentions the phrase later in a paragraph is not the managed line.
    expect(applyParagraph('<p>See the Latest version: page</p>', p1).before).toBeNull();
  });

  it('warns about banned wording elsewhere on the page without blocking', () => {
    expect(bannedWordingElsewhere('<p>Our AI service is great</p><p>Latest version: 0.1.0. x</p>')).toEqual(['"AI service"']);
    expect(bannedWordingElsewhere('<p>Latest version: 0.1.0. chatbot talk</p><p>clean</p>')).toEqual([]);
    expect(bannedWordingElsewhere('<p>A desktop app with a built-in helper</p>')).toEqual([]);
  });

  it('is idempotent', () => {
    const once = applyParagraph('<p>A</p>', p1).next;
    const twice = applyParagraph(once, p1);
    expect(twice.next).toBe(once);
    expect(twice.changed).toBe(false);
  });
});

describe('release text', () => {
  let root;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-sg-text-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('takes the user-facing items (New, Fixed) without scopes or issue numbers, and skips lines that break the copy rule', () => {
    const { items, skipped } = changelogItems(CHANGELOG, '0.2.0');
    expect(items).toEqual([
      'Add automatic daily local backups with verified restore',
      'Import transactions from a CSV file',
      'Add pinned notes',
    ]);
    expect(skipped).toBe(1);
    expect(changelogItems(CHANGELOG, '9.9.9')).toEqual({ items: [], skipped: 0 });
    const technical = '## [0.4.0](x) (2026-10-07)\n\n### Features\n\n* **ai:** local model behind a single server/ai module\n* **desktop:** add a Tauri sidecar with HMAC checks\n* **notes:** add pinned notes\n';
    expect(changelogItems(technical, '0.4.0')).toEqual({ items: ['Add pinned notes'], skipped: 0 });
    expect(changelogItems(CHANGELOG, '0.2.0').items.join(' ')).not.toMatch(/closes|#8|contributing/i);
  });

  it('uses the Fixed items when there are few new ones, and a generic line when nothing is there', () => {
    const only = '## [0.3.0](x) (2026-10-06)\n\n### Bug Fixes\n\n* **ui:** fix a typo in the footer, closes #8\n';
    expect(changelogItems(only, '0.3.0').items).toEqual(['Fix a typo in the footer']);
    fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '# Changelog\n');
    const warn = vi.fn();
    expect(buildWhatsNew({ tag: 'v0.3.0', root, warn })).toEqual({ text: 'Small fixes and improvements', source: 'generic line' });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('release-notes/<tag>.md wins over the changelog', () => {
    fs.writeFileSync(path.join(root, 'CHANGELOG.md'), CHANGELOG);
    fs.mkdirSync(path.join(root, 'release-notes'));
    fs.writeFileSync(path.join(root, 'release-notes', 'v0.2.0.md'), '- Faster start\n- Pinned notes\n');
    expect(buildWhatsNew({ tag: 'v0.2.0', root })).toEqual({ text: 'Faster start. Pinned notes', source: 'release-notes/v0.2.0.md' });
  });
});

describe('small helpers', () => {
  it('timestamps and backup names are filesystem safe', () => {
    const d = new Date('2026-10-05T10:30:00.123Z');
    expect(timestamp(d)).toBe('20261005-103000Z');
    expect(backupFileName(d, 'pro', 'ab/cd+ef==')).toBe('20261005-103000Z_pro_ab_cd_ef__.json');
  });

  it('renderDiff shows before and after, or says nothing changes', () => {
    const base = { label: 'Burrow Pro', id: 'x', after: '<p>new</p>', oldLength: 10, newLength: 20 };
    const text = renderDiff({ ...base, before: '<p>old</p>', changed: true }).join('\n');
    expect(text).toContain('- <p>old</p>');
    expect(text).toContain('+ <p>new</p>');
    expect(text).toContain('10 -> 20 characters');
    expect(renderDiff({ ...base, before: null, changed: true }).join('\n')).toContain('will be added at the end');
    expect(renderDiff({ ...base, before: null, changed: false }).join('\n')).toContain('already up to date');
  });
});

describe('runSync with a fake CLI', () => {
  let root;
  let work;
  let cli;
  let stateFile;
  let logFile;
  let backupDir;

  const writeJson = (rel, value) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), JSON.stringify(value));
  };
  const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const calls = () => fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const opts = (extra = {}) => ({ tag: null, publish: false, dryRun: true, yes: false, cli, backupDir, notesFrom: null, help: false, ...extra });
  const deps = (extra = {}) => ({ root, env: { LOCALAPPDATA: work }, log: () => {}, now: () => new Date('2026-10-05T10:30:00Z'), ...extra });
  const runWith = (o, d = {}) => {
    const lines = [];
    const promise = runSync(o, deps({ log: (l) => lines.push(l), ...d }));
    return promise.then((r) => ({ r, out: lines.join('\n') }));
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-sg-root-'));
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-sg-work-'));
    cli = path.join(work, 'fake-gumroad.cjs');
    stateFile = path.join(work, 'state.json');
    logFile = path.join(work, 'calls.log');
    backupDir = path.join(work, 'backups');
    fs.writeFileSync(cli, FAKE_CLI);
    fs.writeFileSync(logFile, '');
    // The fake CLI runs as a child process and reads these from the inherited environment.
    Object.assign(process.env, { FAKE_STATE: stateFile, FAKE_LOG: logFile, FAKE_BACKUP_DIR: backupDir });
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        [PRO]: '<p>Burrow Pro</p><p>Latest version: 0.1.0. What\'s new: old.</p><p>Thanks</p>',
        [FREE]: '<p>Student and nonprofit</p><p>Latest version: 0.1.0. What\'s new: old.</p>',
        [DOWNLOAD]: '<h2>Download and install</h2><p>Latest version: 0.1.0. What\'s new: old.</p><p>Download Burrow</p>',
      }),
    );
    writeJson('package.json', { version: '0.2.0' });
    fs.writeFileSync(path.join(root, 'CHANGELOG.md'), CHANGELOG);
    writeJson('config/gumroad-sync.json', { proProductId: PRO, freeLicenseProductId: FREE, downloadProductId: DOWNLOAD });
  });
  afterEach(() => {
    for (const k of ['FAKE_STATE', 'FAKE_LOG', 'FAKE_BACKUP_DIR']) delete process.env[k];
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  });

  it('loadProducts reads the three ids and leaves out an empty one', () => {
    expect(loadProducts(root).map((p) => [p.key, p.id])).toEqual([['pro', PRO], ['free-license', FREE], ['download', DOWNLOAD]]);
    writeJson('config/gumroad-sync.json', { proProductId: PRO, freeLicenseProductId: '', downloadProductId: DOWNLOAD });
    expect(loadProducts(root).map((p) => p.key)).toEqual(['pro', 'download']);
  });

  it('dry run: shows a diff per product, only reads, and writes nothing (no backup folder either)', async () => {
    const before = fs.readFileSync(stateFile, 'utf8');
    const { r, out } = await runWith(opts());
    expect(r.updated).toEqual([]);
    expect(r.backups).toEqual([]);
    expect(calls().map((c) => c.call)).toEqual(['products view', 'products content', 'products view', 'products content', 'products view', 'products content']);
    expect(fs.readFileSync(stateFile, 'utf8')).toBe(before);
    expect(fs.existsSync(backupDir)).toBe(false);
    expect(out).toContain('DRY RUN');
    expect(out).toContain('== Burrow Pro (pro-id==) ==');
    expect(out).toContain("- <p>Latest version: 0.1.0. What's new: old.</p>");
    expect(out).toContain("+ <p>Latest version: 0.2.0. What's new: Add automatic daily local backups with verified restore; Import transactions from a CSV file; Add pinned notes.</p>");
    expect(out).toContain('3 of 3 page(s) would change. Nothing was written');
  });

  it('publish: saves a backup of every changing page before the first write, then updates', async () => {
    const original = state();
    const confirm = vi.fn(async () => true);
    const { r, out } = await runWith(opts({ publish: true, dryRun: false }), { confirm });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(r.backups).toHaveLength(3);
    const log = calls();
    const firstUpdate = log.findIndex((c) => c.call === 'products update');
    expect(firstUpdate).toBeGreaterThan(0);
    for (const c of log.filter((x) => x.call === 'products update')) expect(c.backups).toHaveLength(3);
    expect(log.slice(0, firstUpdate).every((c) => c.call === 'products view' || c.call === 'products content')).toBe(true);
    for (const file of r.backups) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(saved.description).toBe(original[saved.productId]);
      expect(saved.tag).toBe('v0.2.0');
      expect(path.dirname(file)).toBe(backupDir);
      expect(path.basename(file)).toMatch(/^20261005-103000Z_(pro|free-license|download)_/);
    }
    const now = state();
    expect(now[PRO]).toBe(`<p>Burrow Pro</p>${renderParagraph('0.2.0', 'Add automatic daily local backups with verified restore; Import transactions from a CSV file; Add pinned notes')}<p>Thanks</p>`);
    expect(now[FREE].startsWith('<p>Student and nonprofit</p><p>Latest version: 0.2.0.')).toBe(true);
    expect(r.updated).toEqual(['pro', 'free-license', 'download']);
    expect(out).toContain('Updated Burrow Pro');
  });

  it('publish asks first and writes nothing when declined; --yes skips the question', async () => {
    const before = fs.readFileSync(stateFile, 'utf8');
    const no = vi.fn(async () => false);
    const { r } = await runWith(opts({ publish: true, dryRun: false }), { confirm: no });
    expect(no).toHaveBeenCalledTimes(1);
    expect(r.updated).toEqual([]);
    expect(fs.readFileSync(stateFile, 'utf8')).toBe(before);
    expect(fs.existsSync(backupDir)).toBe(false);

    const never = vi.fn();
    const { r: done } = await runWith(opts({ publish: true, dryRun: false, yes: true }), { confirm: never });
    expect(never).not.toHaveBeenCalled();
    expect(done.updated).toHaveLength(3);
  });

  it('a second publish finds everything up to date and writes no backup and no update', async () => {
    await runWith(opts({ publish: true, dryRun: false, yes: true }));
    const backupsBefore = fs.readdirSync(backupDir).length;
    const callsBefore = calls().length;
    const { r, out } = await runWith(opts({ publish: true, dryRun: false, yes: true }));
    expect(r.updated).toEqual([]);
    expect(out).toContain('already up to date');
    expect(fs.readdirSync(backupDir)).toHaveLength(backupsBefore);
    expect(calls().slice(callsBefore).every((c) => c.call === 'products view' || c.call === 'products content')).toBe(true);
  });

  it('a missing CLI gives a clear error and calls nothing', async () => {
    await expect(runWith(opts({ cli: path.join(work, 'nope.exe') }))).rejects.toThrow(/Gumroad CLI was not found at .*nope\.exe.*gumroad auth login/);
    expect(calls()).toEqual([]);
  });

  it('a CLI failure (not signed in, unknown product) is explained and nothing is written', async () => {
    writeJson('config/gumroad-sync.json', { proProductId: PRO, freeLicenseProductId: FREE, downloadProductId: 'missing-id==' });
    await expect(runWith(opts({ publish: true, dryRun: false, yes: true }))).rejects.toThrow(/products view failed: product not found.*signed in/);
    expect(calls().some((c) => c.call === 'products update')).toBe(false);
    expect(fs.existsSync(backupDir)).toBe(false);
  });

  it('banned wording in a hand-written release note stops the run before any CLI call', async () => {
    fs.mkdirSync(path.join(root, 'release-notes'));
    fs.writeFileSync(path.join(root, 'release-notes', 'v0.2.0.md'), '- Now with access to AI\n');
    await expect(runWith(opts({ publish: true, dryRun: false, yes: true }))).rejects.toThrow(/store copy rule/);
    expect(calls()).toEqual([]);
  });

  it('refuses a backup folder inside the repository and a bad tag', async () => {
    await expect(runWith(opts({ backupDir: path.join(root, 'backups') }))).rejects.toThrow(/inside the repository/);
    await expect(runWith(opts({ tag: 'v0.2.0-rc.1' }))).rejects.toThrow(/stable release tag/);
  });

  it('refuses a description too long for the command line', async () => {
    const s = state();
    s[PRO] = `<p>${'x'.repeat(29000)}</p>`;
    fs.writeFileSync(stateFile, JSON.stringify(s));
    await expect(runWith(opts())).rejects.toThrow(/too long to send through the CLI/);
  });

  describe('version guard (the version lives in one place)', () => {
    const setState = (patch) => fs.writeFileSync(stateFile, JSON.stringify({ ...state(), ...patch }));
    const both = async (extra = {}) => {
      await expect(runWith(opts(extra))).rejects.toThrow();
      return runWith(opts(extra)).catch((e) => String(e.message));
    };
    const para = (v) => `<p>Latest version: ${v}. What's new: x.</p>`;

    it('passes (dry run and publish) when each page has one paragraph and no other version', async () => {
      await expect(runWith(opts())).resolves.toBeTruthy();
      await expect(runWith(opts({ publish: true, dryRun: false, yes: true }))).resolves.toBeTruthy();
    });

    it('fails a version number elsewhere in a description, in dry run and publish, and writes nothing', async () => {
      setState({ [PRO]: `<p>Burrow 0.1.0 is great</p>${para('0.1.0')}` });
      const before = fs.readFileSync(stateFile, 'utf8');
      for (const extra of [{}, { publish: true, dryRun: false, yes: true }]) {
        const msg = await both(extra);
        expect(msg).toMatch(/Burrow Pro: a version number \(0\.1\.0\) is written in the description/);
        expect(msg).toContain('nothing was written');
      }
      expect(fs.readFileSync(stateFile, 'utf8')).toBe(before);
      expect(fs.existsSync(backupDir)).toBe(false);
      expect(calls().some((c) => c.call === 'products update')).toBe(false);
    });

    it('fails a version number in the custom receipt or the rich content', async () => {
      setState({ __receipt: { [FREE]: '<p>Thanks for Burrow 1.2.3</p>' } });
      expect(await both()).toMatch(/\(1\.2\.3\) is written in the custom receipt/);
      setState({ __receipt: {}, __content: { [DOWNLOAD]: 'Install v2.0.1 now' } });
      expect(await both()).toMatch(/\(v2\.0\.1\) is written in the rich content/);
    });

    it('scans only text fields of the rich content, not urls, file names or ids', () => {
      const json = JSON.stringify({ content: [{ type: 'file', url: 'https://x.test/v1.2.3/a.exe', file_name: 'Burrow-1.2.3.exe', id: '1.2.3' }, { type: 'paragraph', content: [{ type: 'text', text: 'Burrow 4.5.6' }] }] });
      expect(contentText(json)).toBe('Burrow 4.5.6');
      expect(contentText(JSON.stringify({ html: '<p>a 7.8.9</p>', body: 'b', description: 'c', name: 'd', other: 'e', url: 'f' }))).toBe('<p>a 7.8.9</p>\nb\nc\nd');
      expect(contentText('not json 1.2.3')).toBe('not json 1.2.3');
      expect(versionGuardProblems({ label: 'P', description: para('0.3.0'), content: contentText(json) })).toHaveLength(1);
    });

    it('a version only in a file url or name does not fail the page (through the fake CLI)', async () => {
      await expect(runWith(opts())).resolves.toBeTruthy();
    });

    it('warns, and does not fail, when the product has no custom_receipt field', async () => {
      setState({ __noReceipt: true });
      const { out } = await runWith(opts());
      expect(out).toMatch(/has no custom_receipt field, so the receipt of Burrow Pro was not checked/);
    });

    it('fails zero or two "Latest version:" paragraphs', async () => {
      setState({ [PRO]: '<p>Burrow Pro</p>' });
      expect(await both()).toMatch(/Burrow Pro: the description has 0 "Latest version:" paragraphs/);
      setState({ [PRO]: `${para('0.1.0')}${para('0.1.0')}` });
      expect(await both()).toMatch(/has 2 "Latest version:" paragraphs/);
    });

    it('reports every page that is wrong in one message', async () => {
      setState({ [PRO]: '<p>x</p>', [FREE]: '<p>y</p>' });
      const msg = await both();
      expect(msg).toMatch(/Burrow Pro:/);
      expect(msg).toMatch(/Burrow student and nonprofit \(hidden\):/);
    });

    it('catches short forms but not sizes, ranges or prices', () => {
      const bad = (t) => versionGuardProblems({ label: 'P', description: para('0.3.0'), content: t }).length;
      for (const t of ['Burrow 0.2 for Windows', 'Get v0.3 today', 'version 1.4', 'Burrow v1.2.3']) expect(bad(t), t).toBe(1);
      for (const t of ['Needs 1.3 to 4.7 GB of space', 'Uses 2.5 GB', 'Only $9.99 once', 'Takes 0.5 seconds', 'Rated 4.8 stars', 'Windows 10 and 11']) expect(bad(t), t).toBe(0);
    });

    it('versionGuardProblems ignores markup, other numbers and the managed paragraph', () => {
      expect(versionGuardProblems({ label: 'P', description: `<a href="https://x.test/v1.2.3">link</a><p>Windows 10 and 2.5 GB</p>${para('9.9.9')}` })).toEqual([]);
      expect(versionGuardProblems({ label: 'P', description: para('0.3.0'), receipt: 'v 4.5.6' })).toHaveLength(1);
    });
  });

  it('warns when a page does not show the new version when read back', async () => {
    // A CLI that accepts the update but stores something else.
    fs.writeFileSync(cli, FAKE_CLI.replace('state[id] = rest[at + 1];', 'state[id] = "<p>changed by gumroad</p>";'));
    const { out } = await runWith(opts({ publish: true, dryRun: false, yes: true }));
    expect(out).toContain('Warning: Burrow Pro was updated but the page does not show');
  });
});
