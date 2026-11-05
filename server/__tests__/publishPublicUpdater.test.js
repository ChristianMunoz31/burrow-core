import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ALLOWED_ASSETS,
  INSTALLER_ARM64,
  INSTALLER_X64,
  LATEST_JSON,
  MAX_SMALL_ASSET_BYTES,
  SIG_ARM64,
  SIG_X64,
  SUMS_FILE,
  UPDATER_ASSETS,
  UPDATER_SUMS_ORDER,
  allowlistAssets,
  checkSumsOrder,
  pinnedInstallerUrl,
  publish,
  validateLatestJson,
} from '../../scripts/release/publishPublic.js';
import { buildLatestJson } from '../../scripts/release/updaterManifest.js';
import { makeTestKey, signTestData } from './helpers/updaterSigning.js';

const exe = (name, extra = {}) => ({ name, size: 1000, isFile: true, header: Buffer.from('MZ'), ...extra });
const small = (name, extra = {}) => ({ name, size: 300, isFile: true, ...extra });
const three = () => [exe(INSTALLER_X64), exe(INSTALLER_ARM64), small(SUMS_FILE)];
const six = () => [...three(), small(SIG_X64), small(SIG_ARM64), small(LATEST_JSON)];

describe('allowlistAssets: 3 names with the updater off, 6 with it on', () => {
  it('the name lists are exactly 3 and 6', () => {
    expect([...ALLOWED_ASSETS].sort()).toEqual([INSTALLER_ARM64, INSTALLER_X64, SUMS_FILE].sort());
    expect(UPDATER_ASSETS).toHaveLength(6);
    expect(new Set(UPDATER_ASSETS).size).toBe(6);
    expect([...UPDATER_ASSETS].sort()).toEqual([...ALLOWED_ASSETS, SIG_X64, SIG_ARM64, LATEST_JSON].sort());
    expect(UPDATER_SUMS_ORDER).toEqual([INSTALLER_X64, INSTALLER_ARM64, SIG_X64, SIG_ARM64, LATEST_JSON]);
  });

  it('off: accepts exactly the three and refuses each updater file', () => {
    expect(allowlistAssets(three())).toHaveLength(3);
    expect(allowlistAssets(three(), { updater: false })).toHaveLength(3);
    for (const name of [SIG_X64, SIG_ARM64, LATEST_JSON]) {
      expect(() => allowlistAssets([...three(), small(name)]), name).toThrow(/Refusing to publish/);
    }
  });

  it('on: accepts exactly the six', () => {
    expect(allowlistAssets(six(), { updater: true })).toEqual([...UPDATER_ASSETS].sort());
  });

  it('on: every missing updater file is named, and the plain three are not enough', () => {
    expect(() => allowlistAssets(three(), { updater: true })).toThrow(/Missing asset\(s\): .*Burrow-Setup-x64\.exe\.sig.*latest\.json/);
    for (const name of [SIG_X64, SIG_ARM64, LATEST_JSON]) {
      expect(() => allowlistAssets(six().filter((f) => f.name !== name), { updater: true }), name).toThrow(new RegExp(`Missing asset.*${name.replace(/\./g, '\\.')}`));
    }
  });

  it('on or off: a stray or look-alike file is refused', () => {
    for (const updater of [false, true]) {
      const base = updater ? six() : three();
      for (const name of ['Burrow-Setup-x64.exe.sig.bak', 'latest.json.txt', 'burrow-0.2.0.zip', 'Latest.json', 'Burrow-Setup-x64.exe.SIG']) {
        expect(() => allowlistAssets([...base, small(name)], { updater }), name).toThrow(/Refusing to publish/);
      }
    }
  });

  it('small files have a 1 MiB cap and no MZ rule; the exes keep the MZ rule', () => {
    expect(() => allowlistAssets(six().map((f) => (f.name === LATEST_JSON ? { ...f, size: MAX_SMALL_ASSET_BYTES + 1 } : f)), { updater: true })).toThrow(/byte limit/);
    expect(() => allowlistAssets(six().map((f) => (f.name === SIG_X64 ? { ...f, size: MAX_SMALL_ASSET_BYTES } : f)), { updater: true })).not.toThrow();
    expect(() => allowlistAssets(six().map((f) => (f.name === SIG_X64 ? { ...f, size: 0 } : f)), { updater: true })).toThrow(/empty/);
    expect(() => allowlistAssets(six().map((f) => (f.name === INSTALLER_X64 ? exe(f.name, { header: Buffer.from('PK') }) : f)), { updater: true })).toThrow(/MZ/);
  });
});

describe('validateLatestJson', () => {
  const key = makeTestKey();
  const tag = 'v0.5.0';
  const installers = { x64: Buffer.from('MZ x64 bytes'), arm64: Buffer.from('MZ arm64 bytes') };
  const sigs = { x64: signTestData({ key, data: installers.x64, version: '0.5.0' }), arm64: signTestData({ key, data: installers.arm64, version: '0.5.0' }) };
  const goodText = () => buildLatestJson({ tag, sigX64: sigs.x64, sigArm64: sigs.arm64, notes: 'New:\n- A thing', now: '2026-10-07T12:00:00Z' });
  const check = (text, over = {}) => validateLatestJson({ text, tag, pubkey: key.pubkeyB64, sigs, installers, ...over });
  const mutate = (fn) => {
    const json = JSON.parse(goodText());
    fn(json);
    return JSON.stringify(json);
  };

  it('accepts what the generator writes', () => {
    expect(check(goodText())).toEqual({ version: '0.5.0' });
    expect(pinnedInstallerUrl(tag, 'x64')).toBe('https://github.com/ChristianMunoz31/burrow-releases/releases/download/v0.5.0/Burrow-Setup-x64.exe');
  });

  it.each([
    ['not JSON', () => 'nope', /not valid JSON/],
    ['an array', () => '[]', /exactly version, notes, pub_date and platforms/],
    ['an extra top-level key', () => mutate((j) => { j.extra = 1; }), /exactly version/],
    ['a missing notes key', () => mutate((j) => { delete j.notes; }), /exactly version/],
    ['a wrong version', () => mutate((j) => { j.version = '0.5.1'; }), /says version 0.5.1, the tag is v0.5.0/],
    ['non-string notes', () => mutate((j) => { j.notes = ['x']; }), /notes must be a string/],
    ['an em dash in the notes', () => mutate((j) => { j.notes = `a ${String.fromCharCode(0x2014)} b`; }), /em dash/],
    ['a private repo name in the notes', () => mutate((j) => { j.notes = 'ChristianMunoz31/burrow/issues/1'; }), /private repo/],
    ['a bad pub_date', () => mutate((j) => { j.pub_date = '2026-10-07 12:00'; }), /pub_date/],
    ['fractional seconds in pub_date', () => mutate((j) => { j.pub_date = '2026-10-07T12:00:00.123Z'; }), /pub_date/],
    ['an extra platform', () => mutate((j) => { j.platforms['windows-x86_64-nsis'] = j.platforms['windows-x86_64']; }), /exactly windows-x86_64 and windows-aarch64/],
    ['a missing platform', () => mutate((j) => { delete j.platforms['windows-aarch64']; }), /exactly windows-x86_64 and windows-aarch64/],
    ['an extra platform field', () => mutate((j) => { j.platforms['windows-x86_64'].size = 1; }), /exactly signature and url/],
    ['a URL for another tag', () => mutate((j) => { j.platforms['windows-x86_64'].url = pinnedInstallerUrl('v0.5.1', 'x64'); }), /url is not/],
    ['a URL for the other arch', () => mutate((j) => { j.platforms['windows-x86_64'].url = pinnedInstallerUrl(tag, 'arm64'); }), /url is not/],
    ['an http URL', () => mutate((j) => { j.platforms['windows-aarch64'].url = pinnedInstallerUrl(tag, 'arm64').replace('https', 'http'); }), /url is not/],
    ['another host', () => mutate((j) => { j.platforms['windows-aarch64'].url = 'https://evil.example/Burrow-Setup-arm64.exe'; }), /url is not/],
    ['a signature that is not the .sig file', () => mutate((j) => { j.platforms['windows-x86_64'].signature = sigs.arm64; }), /not the contents of the \.sig file/],
    ['an empty signature', () => mutate((j) => { j.platforms['windows-x86_64'].signature = ''; }), /signature is not a base64 string/],
  ])('refuses %s', (_name, make, re) => {
    expect(() => check(make()), _name).toThrow(re);
  });

  it('refuses a signature bound to another version or to none (downgrade guard)', () => {
    const oldSigs = { x64: signTestData({ key, data: installers.x64, version: '0.4.9' }), arm64: sigs.arm64 };
    const textFor = (s) => buildLatestJson({ tag, sigX64: s.x64, sigArm64: s.arm64, notes: ['New:', '- A thing'].join('\n'), now: '2026-10-07T12:00:00Z' });
    expect(() => check(textFor(oldSigs), { sigs: oldSigs })).toThrow(/x64 signature does not verify: .*not bound to version 0\.5\.0.*version 0\.4\.9/);
    const bare = { x64: signTestData({ key, data: installers.x64 }), arm64: sigs.arm64 };
    expect(() => check(textFor(bare), { sigs: bare })).toThrow(/not bound to version 0\.5\.0.*no version/);
  });

  it('refuses a signature that does not verify: wrong bytes, wrong key', () => {
    expect(() => check(goodText(), { installers: { ...installers, arm64: Buffer.from('MZ tampered') } })).toThrow(/arm64 signature does not verify/);
    expect(() => check(goodText(), { pubkey: makeTestKey().pubkeyB64 })).toThrow(/x64 signature does not verify/);
  });
});

describe('checkSumsOrder', () => {
  const line = (n) => `${'a'.repeat(64)}  ${n}`;
  it('needs the documented order', () => {
    expect(() => checkSumsOrder(`${UPDATER_SUMS_ORDER.map(line).join('\n')}\n`, UPDATER_SUMS_ORDER)).not.toThrow();
    expect(() => checkSumsOrder(`${[...UPDATER_SUMS_ORDER].reverse().map(line).join('\n')}\n`, UPDATER_SUMS_ORDER)).toThrow(/in that order/);
    expect(() => checkSumsOrder(`${UPDATER_SUMS_ORDER.slice(0, 4).map(line).join('\n')}\n`, UPDATER_SUMS_ORDER)).toThrow(/in that order/);
  });
});

describe('publish with the updater on (mocked gh, synthetic keys)', () => {
  const cleanups = [];
  afterEach(() => cleanups.splice(0).forEach((fn) => fn()));
  const quiet = { info: vi.fn(), warn: vi.fn() };
  const key = makeTestKey();
  const h = (b) => crypto.createHash('sha256').update(b).digest('hex');

  const makeDir = ({ tag = 'v0.2.0', skip = [], over = {} } = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-publish-upd-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const x64 = Buffer.concat([Buffer.from('MZ'), Buffer.from('x64 installer')]);
    const arm = Buffer.concat([Buffer.from('MZ'), Buffer.from('arm64 installer')]);
    const sigX64 = signTestData({ key, data: x64, version: tag.slice(1) });
    const sigArm = signTestData({ key, data: arm, version: tag.slice(1) });
    const latest = buildLatestJson({ tag, sigX64, sigArm64: sigArm, notes: 'New:\n- A thing', now: '2026-10-07T12:00:00Z' });
    const files = { [INSTALLER_X64]: x64, [INSTALLER_ARM64]: arm, [SIG_X64]: sigX64, [SIG_ARM64]: sigArm, [LATEST_JSON]: latest };
    const sums = UPDATER_SUMS_ORDER.map((n) => `${h(files[n])}  ${n}`).join('\n');
    const all = { ...files, [SUMS_FILE]: `${sums}\n`, ...over };
    for (const [name, body] of Object.entries(all)) if (!skip.includes(name)) fs.writeFileSync(path.join(dir, name), body);
    return dir;
  };
  const on = { enabled: true, pubkey: key.pubkeyB64 };
  const dry = (dir, extra = {}) => publish({ tag: 'v0.2.0', assetsDir: dir, dryRun: true, env: {}, exec: vi.fn(), log: quiet, updater: on, ...extra });

  it('a dry run verifies everything and plans to upload exactly the six files', async () => {
    const out = await dry(makeDir());
    const planned = out.plan[0].filter((a) => /\.(exe|sig|json|txt)$/.test(a)).map((a) => path.basename(a));
    expect(planned.sort()).toEqual([...UPDATER_ASSETS].sort());
  });

  it('refuses the plain three when the updater is on, and a sig when it is off', async () => {
    await expect(dry(makeDir({ skip: [SIG_X64, SIG_ARM64, LATEST_JSON] }))).rejects.toThrow(/Missing asset/);
    await expect(dry(makeDir(), { updater: { enabled: false } })).rejects.toThrow(/Refusing to publish "(?:Burrow-Setup-(?:x64|arm64)\.exe\.sig|latest\.json)"/);
  });

  it('refuses a tampered installer, a wrong key and a swapped signature before any gh call', async () => {
    const exec = vi.fn();
    const tampered = makeDir();
    fs.appendFileSync(path.join(tampered, INSTALLER_X64), 'x');
    await expect(dry(tampered, { exec })).rejects.toThrow(/does not match/);
    await expect(dry(makeDir(), { exec, updater: { enabled: true, pubkey: makeTestKey().pubkeyB64 } })).rejects.toThrow(/does not verify/);
    const swapped = makeDir();
    const x = fs.readFileSync(path.join(swapped, SIG_X64));
    const a = fs.readFileSync(path.join(swapped, SIG_ARM64));
    fs.writeFileSync(path.join(swapped, SIG_X64), a);
    fs.writeFileSync(path.join(swapped, SIG_ARM64), x);
    const sums = UPDATER_SUMS_ORDER.map((n) => `${h(fs.readFileSync(path.join(swapped, n)))}  ${n}`).join('\n');
    fs.writeFileSync(path.join(swapped, SUMS_FILE), `${sums}\n`);
    await expect(dry(swapped, { exec })).rejects.toThrow(/not the contents of the \.sig file/);
    expect(exec).not.toHaveBeenCalled();
  });

  it('refuses a latest.json for another version or URL', async () => {
    const dir = makeDir({ tag: 'v0.9.0' });
    await expect(dry(dir)).rejects.toThrow(/says version 0.9.0, the tag is v0.2.0/);
  });

  it('refuses sums in the wrong order or missing a line', async () => {
    const dir = makeDir();
    const lines = fs.readFileSync(path.join(dir, SUMS_FILE), 'utf8').trim().split('\n');
    fs.writeFileSync(path.join(dir, SUMS_FILE), `${[lines[1], lines[0], ...lines.slice(2)].join('\n')}\n`);
    await expect(dry(dir)).rejects.toThrow(/in that order/);
    fs.writeFileSync(path.join(dir, SUMS_FILE), `${lines.slice(0, 4).join('\n')}\n`);
    await expect(dry(dir)).rejects.toThrow(/does not match|unexpected/);
  });

  it('a real publish uploads the six files and strips signing variables from the gh environment', async () => {
    const dir = makeDir();
    const exec = vi.fn(async (_file, args) => {
      if (args[1] === 'view' && !args.includes('assets,isDraft,isPrerelease,tagName')) throw Object.assign(new Error('x'), { stderr: 'release not found' });
      if (args[0] === 'api') return { stdout: JSON.stringify({ tag_name: 'v0.2.0' }), stderr: '' };
      if (args.includes('assets,isDraft,isPrerelease,tagName')) return { stdout: JSON.stringify({ assets: UPDATER_ASSETS.map((name) => ({ name, size: 10 })) }), stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const env = { GH_TOKEN: 'tok-test-1234', TAURI_SIGNING_PRIVATE_KEY: 'k', TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'p', PATH: 'p' };
    await publish({ tag: 'v0.2.0', assetsDir: dir, env, exec, log: quiet, updater: on });
    const create = exec.mock.calls.find(([, args]) => args[1] === 'create')[1];
    expect(create.filter((a) => a.startsWith(dir)).map((a) => path.basename(a)).sort()).toEqual([...UPDATER_ASSETS].sort());
    for (const [, , opts] of exec.mock.calls) {
      expect(Object.keys(opts.env).filter((k) => /^TAURI_/.test(k))).toEqual([]);
      expect(opts.env.PATH).toBe('p');
    }
  });

  it('reads on or off from the overlay of the given root when no updater option is passed', async () => {
    const { makeOverlayRoot } = await import('./helpers/updaterSigning.js');
    const made = makeOverlayRoot(key.pubkeyB64);
    cleanups.push(made.cleanup);
    const out = await publish({ tag: 'v0.2.0', assetsDir: makeDir(), dryRun: true, env: {}, exec: vi.fn(), log: quiet, root: made.root });
    expect(out.plan[0].filter((a) => a.endsWith('latest.json'))).toHaveLength(1);
  });
});
