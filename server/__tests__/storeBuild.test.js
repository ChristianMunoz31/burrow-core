// Microsoft Store (MSIX) build: identity gate, manifest, layout staging, SDK lookup, x64 node checks, signing args,
// CLI parsing. No real build runs here; scripts/release/buildStore.mjs is the orchestration around these pieces.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Release paths refuse a checkout without the Pro module (assertProPresent); these fixture roots have none, and
// server/__tests__/proReleaseGuard.test.js covers the refusal itself.
vi.mock('../../scripts/checks/proPresent.js', async (importOriginal) => ({ ...(await importOriginal()), assertProPresent: () => {} }));
import {
  STORE_SHELL_MARKER,
  STORE_SIDECAR_MARKER,
  assertNoUpdaterInBaseConfig,
  assertStoreMarkers,
  assertWebBuild,
  cleanupCommands,
  formatSums,
  formatSummary,
  parseCliArgs,
  removeStaleOutputs,
  removeStoreArtifacts,
  resolveOutDir,
} from '../../scripts/release/buildStore.mjs';
import { checkBinaryChannel, checkDistribution, main as channelMarkerMain } from '../../scripts/checks/channelMarker.js';
import { assertNoStoreSidecars, assertSidecarChannel } from '../../scripts/desktop/lib.js';
import { buildInstaller } from '../../scripts/release/buildInstaller.js';
import { checkChannelArtifacts } from '../../scripts/release/releaseLocal.mjs';
import { LOCAL_TEST_IDENTITY, STORE_CONFIG, assertIdentityShape, isPlaceholder, placeholderFields, readStoreConfig, resolveIdentity } from '../../scripts/release/storeIdentity.mjs';
import {
  APP_EXECUTABLE,
  ARCHITECTURES,
  CAPABILITIES,
  MIN_WINDOWS_VERSION,
  SIDECAR_EXECUTABLE,
  buildManifest,
  toStoreVersion,
  xmlEscape,
} from '../../scripts/release/storeManifest.mjs';
import { REQUIRED_ASSETS, checkStagedLayout, listFiles, stageLayout } from '../../scripts/release/storeLayout.mjs';
import { MAX_NODE_BYTES, assertUsableX64Node, ensureX64Node, nodeUrls, parseShasums, peMachine, readNodePins } from '../../scripts/release/storeNode.mjs';
import { CER_PATH_ENV, SUBJECT_ENV, certScript, ensureLocalTestCert, parseThumbprint, signtoolArgs } from '../../scripts/release/storeSign.mjs';
import { findSdkTools, hostSdkArch, sortSdkVersions } from '../../scripts/release/winSdk.mjs';

import { hasPrivateFile } from './helpers/privateFiles.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// config/msstore.json is private-only (left out of the public core export): the tests that read the owner's Store identity are skipped without it.
const HAS_STORE_CONFIG = hasPrivateFile('config/msstore.json');
const DIRECT_WORKFLOWS = ['desktop-windows.yml', 'release.yml', 'dev-build.yml'].filter((n) => hasPrivateFile(`.github/workflows/${n}`));
const PLACEHOLDERS = { identityName: 'PLACEHOLDER_A', publisher: 'PLACEHOLDER_B', publisherDisplayName: 'PLACEHOLDER_C', displayName: 'Burrow' };
const REAL = { identityName: '12345Example.Burrow', publisher: 'CN=11111111-2222-3333-4444-555555555555', publisherDisplayName: 'Example Publisher', displayName: 'Burrow' };

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-store-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('owner config and identity gate', () => {
  it.skipIf(!HAS_STORE_CONFIG)('the committed config holds the Partner Center identity and passes resolveIdentity without --local-test', () => {
    const config = readStoreConfig(ROOT);
    expect(placeholderFields(config)).toEqual([]);
    expect(config.identityName).toBe('NeuralFoundry.BurrowPrivateLifeOrganizer');
    expect(config.publisher).toBe('CN=ED5E4A2A-3217-4F54-A392-3EAD302CF036');
    expect(config.publisherDisplayName).toBe('Neural Foundry');
    expect(config.displayName).toBe('Burrow: Private Life Organizer');
    expect(config.reserved).toEqual({
      packageFamilyName: 'NeuralFoundry.BurrowPrivateLifeOrganizer_mgg9wnr6rtg28',
      storeId: '9NT29CNPKBK4',
      storeUrl: 'https://apps.microsoft.com/detail/9NT29CNPKBK4',
      storeProtocol: 'ms-windows-store://pdp/?productid=9NT29CNPKBK4',
    });
    const { identity, source } = resolveIdentity({ config });
    expect(source).toBe('partner-center');
    expect(identity).toEqual({
      identityName: 'NeuralFoundry.BurrowPrivateLifeOrganizer',
      publisher: 'CN=ED5E4A2A-3217-4F54-A392-3EAD302CF036',
      publisherDisplayName: 'Neural Foundry',
      displayName: 'Burrow: Private Life Organizer',
    });
  });

  it('refuses to resolve an identity while placeholders remain, naming them and the file', () => {
    expect(() => resolveIdentity({ config: PLACEHOLDERS })).toThrow(new RegExp(`${STORE_CONFIG.replace('/', '\\/')} still has placeholders for: identityName, publisher, publisherDisplayName`));
    expect(() => resolveIdentity({ config: { ...PLACEHOLDERS, identityName: REAL.identityName } })).toThrow(/publisher, publisherDisplayName/);
  });

  it('treats empty, missing and PLACEHOLDER values (any case) as placeholders', () => {
    for (const value of ['', '   ', undefined, null, 5, 'PLACEHOLDER_X', 'placeholder', ' Placeholder_publisher']) expect(isPlaceholder(value)).toBe(true);
    expect(isPlaceholder('12345Example.Burrow')).toBe(false);
  });

  it('the local test flag falls back to the made-up identity only while placeholders remain', () => {
    const { identity, source } = resolveIdentity({ config: PLACEHOLDERS, localTest: true });
    expect(source).toBe('local-test-fallback');
    expect(identity).toEqual(LOCAL_TEST_IDENTITY);
    expect(identity.identityName).toBe('Burrow.LocalTest');
    expect(identity.publisher).toBe('CN=Burrow Local Test');
  });

  it.skipIf(!HAS_STORE_CONFIG)('the local test flag uses the real Name and Publisher once the config has them', () => {
    const { identity, source } = resolveIdentity({ config: readStoreConfig(ROOT), localTest: true });
    expect(source).toBe('local-test');
    expect(identity.identityName).toBe('NeuralFoundry.BurrowPrivateLifeOrganizer');
    expect(identity.publisher).toBe('CN=ED5E4A2A-3217-4F54-A392-3EAD302CF036');
    expect(() => resolveIdentity({ config: { ...REAL, publisher: 'not-a-cn' }, localTest: true })).toThrow(/start with CN=/);
  });

  it('accepts real Partner Center values', () => {
    expect(resolveIdentity({ config: REAL })).toEqual({ identity: REAL, source: 'partner-center' });
  });

  it('an upload identity needs a displayName: no silent fallback to "Burrow", only a local test may fall back', () => {
    for (const displayName of ['', '   ', undefined, null, 5]) {
      expect(() => resolveIdentity({ config: { ...REAL, displayName } }), String(displayName)).toThrow(/displayName is empty/);
    }
    expect(() => resolveIdentity({ config: { ...REAL, displayName: undefined } })).toThrow(new RegExp(STORE_CONFIG.replace('/', '\\/')));
    expect(resolveIdentity({ config: { ...REAL, displayName: '' }, localTest: true })).toEqual({ identity: REAL, source: 'local-test' });
    expect(resolveIdentity({ config: { ...REAL, displayName: 'Reserved: Name' } }).identity.displayName).toBe('Reserved: Name');
  });

  it('rejects malformed real values', () => {
    expect(() => assertIdentityShape({ ...REAL, identityName: 'a' })).toThrow(/valid package name/);
    expect(() => assertIdentityShape({ ...REAL, identityName: 'has space.Burrow' })).toThrow(/valid package name/);
    expect(() => assertIdentityShape({ ...REAL, publisher: '11111111-2222' })).toThrow(/start with CN=/);
    expect(() => assertIdentityShape({ ...REAL, publisherDisplayName: ' padded ' })).toThrow(/spaces around/);
    expect(() => assertIdentityShape({ ...REAL, publisherDisplayName: 'bad\nname' })).toThrow(/control character/);
  });
});

describe('package version', () => {
  it('is the app version x.y.z with a fourth part of 0', () => {
    expect(toStoreVersion('1.0.0')).toBe('1.0.0.0');
    expect(toStoreVersion('1.4.1')).toBe('1.4.1.0');
    expect(toStoreVersion('12.0.65535')).toBe('12.0.65535.0');
    expect(toStoreVersion('65535.65535.65535')).toBe('65535.65535.65535.0');
  });

  it('is monotonic: a newer app version never maps to an older or equal package version', () => {
    const order = ['1.0.0', '1.0.1', '1.2.0', '1.10.0', '2.0.0'];
    const num = (v) => toStoreVersion(v).split('.').map(Number);
    for (let i = 1; i < order.length; i += 1) {
      const [a, b] = [num(order[i - 1]), num(order[i])];
      const firstDiff = a.findIndex((n, k) => n !== b[k]);
      expect(b[firstDiff]).toBeGreaterThan(a[firstDiff]);
    }
  });

  it('never has a zero first part for an upload build and always a zero fourth part', () => {
    for (const v of ['1.0.0', '1.4.1', '9.9.9']) {
      const parts = toStoreVersion(v).split('.').map(Number);
      expect(parts[0]).toBeGreaterThan(0);
      expect(parts[3]).toBe(0);
      expect(parts.every((p) => p >= 0 && p <= 65535)).toBe(true);
    }
  });

  it('refuses a 0.x app version for an upload build, with a message that says what to do', () => {
    for (const v of ['0.4.1', '0.0.0', '0.99.0']) {
      expect(() => toStoreVersion(v)).toThrow(/first section of a package version cannot be 0/);
      expect(() => toStoreVersion(v, {})).toThrow(/Release Burrow 1\.0\.0 or later/);
      expect(() => toStoreVersion(v, { localTest: false })).toThrow(/refuses app version/);
    }
  });

  it('lets a local sideload test use a 0.x version without changing it', () => {
    expect(toStoreVersion('0.4.1', { localTest: true })).toBe('0.4.1.0');
    expect(toStoreVersion('0.0.0', { localTest: true })).toBe('0.0.0.0');
    expect(toStoreVersion('1.2.3', { localTest: true })).toBe('1.2.3.0');
  });

  it('refuses dev, prerelease and out-of-range versions, local test or not', () => {
    for (const bad of ['0.2.0-dev.20261005.abc1234', '1.2.3-rc.1', '1.2', [1, 2, 3, 4].join('.'), '01.2.3', 'v1.2.3', '', undefined]) {
      expect(() => toStoreVersion(bad)).toThrow(/stable x\.y\.z/);
      expect(() => toStoreVersion(bad, { localTest: true })).toThrow(/stable x\.y\.z/);
    }
    expect(() => toStoreVersion('1.2.65536')).toThrow(/above 65535/);
    expect(() => toStoreVersion('1.65536.0')).toThrow(/above 65535/);
    expect(() => toStoreVersion('65536.0.0')).toThrow(/above 65535/);
    expect(() => toStoreVersion('0.65536.0', { localTest: true })).toThrow(/above 65535/);
  });
});

describe('manifest', () => {
  const manifest = (over = {}) => buildManifest({ identity: REAL, version: '1.4.1', arch: 'arm64', ...over });

  it('writes the identity, the package version (the app version plus .0) and the architecture', () => {
    const xml = manifest();
    expect(xml).toContain('<Identity Name="12345Example.Burrow" Publisher="CN=11111111-2222-3333-4444-555555555555" Version="1.4.1.0" ProcessorArchitecture="arm64" />');
    expect(manifest({ version: '1.0.0' })).toContain('Version="1.0.0.0"');
    expect(manifest({ arch: 'x64' })).toContain('ProcessorArchitecture="x64"');
    expect(xml).toContain('<PublisherDisplayName>Example Publisher</PublisherDisplayName>');
    expect(xml).toContain('<DisplayName>Burrow</DisplayName>');
    expect(xml).toMatch(/Version="[1-9]\d*\.\d+\.\d+\.0"/);
  });

  it('uses the reserved Store name, colon included, for the package and the Start menu entry', () => {
    const name = 'Burrow: Private Life Organizer';
    const xml = manifest({ identity: { ...REAL, displayName: name } });
    expect(xml).toContain(`<DisplayName>${name}</DisplayName>`);
    expect(xml).toContain(`DisplayName="${name}"`);
    expect(xml).not.toMatch(/&(amp|lt|gt|quot|apos);/);
    expect(() => assertIdentityShape({ ...REAL, displayName: name })).not.toThrow();
  });

  it('refuses a 0.x version for an upload manifest and allows it for a local test manifest', () => {
    expect(() => manifest({ version: '0.4.1' })).toThrow(/cannot be 0/);
    expect(manifest({ version: '0.4.1', localTest: true })).toContain('Version="0.4.1.0"');
    expect(() => manifest({ version: '0.4.1-dev.1.abc1234', localTest: true })).toThrow(/stable x\.y\.z/);
  });

  it.skipIf(!HAS_STORE_CONFIG)('the committed identity produces a manifest with the real names and package version 1.0.0.0', () => {
    const { identity } = resolveIdentity({ config: readStoreConfig(ROOT) });
    const xml = buildManifest({ identity, version: '1.0.0', arch: 'arm64' });
    expect(xml).toContain('Name="NeuralFoundry.BurrowPrivateLifeOrganizer" Publisher="CN=ED5E4A2A-3217-4F54-A392-3EAD302CF036" Version="1.0.0.0"');
    expect(xml).toContain('<DisplayName>Burrow: Private Life Organizer</DisplayName>');
    expect(xml).toContain('<PublisherDisplayName>Neural Foundry</PublisherDisplayName>');
  });

  it('declares full trust, unvirtualized resources and write virtualization off', () => {
    const xml = manifest();
    expect(CAPABILITIES).toEqual(['runFullTrust', 'unvirtualizedResources']);
    expect(xml).toContain('<rescap:Capability Name="runFullTrust" />');
    expect(xml).toContain('<rescap:Capability Name="unvirtualizedResources" />');
    expect(xml).toContain('<desktop6:FileSystemWriteVirtualization>disabled</desktop6:FileSystemWriteVirtualization>');
    expect(xml).toContain('IgnorableNamespaces="uap rescap desktop6"');
    expect(xml).not.toContain('RegistryWriteVirtualization');
  });

  it('targets desktop Windows 10 1903 (build 18362, the first with write virtualization control) and later, as a full trust app that starts Burrow.exe', () => {
    const xml = manifest();
    expect(MIN_WINDOWS_VERSION).toBe('10.0.18362.0');
    expect(xml).toContain('<TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.18362.0"');
    expect(xml).toContain(`<TargetDeviceFamily Name="Windows.Desktop" MinVersion="${MIN_WINDOWS_VERSION}"`);
    expect(xml).toContain(`Executable="${APP_EXECUTABLE}" EntryPoint="Windows.FullTrustApplication"`);
    expect(xml).not.toMatch(/S ?Mode/i);
  });

  it('escapes XML in every owner value', () => {
    const xml = manifest({ identity: { ...REAL, publisher: 'CN="A & B", O=<C>', publisherDisplayName: `Tom's <Co>` } });
    expect(xml).toContain('Publisher="CN=&quot;A &amp; B&quot;, O=&lt;C&gt;"');
    expect(xml).toContain('<PublisherDisplayName>Tom&apos;s &lt;Co&gt;</PublisherDisplayName>');
    expect(xmlEscape('<&>"\'')).toBe('&lt;&amp;&gt;&quot;&apos;');
  });

  it('refuses an unknown architecture and a dev version', () => {
    expect(() => manifest({ arch: 'x86' })).toThrow(/Unknown architecture/);
    expect(() => manifest({ version: '0.2.0-dev.20261005.abc1234' })).toThrow(/stable x\.y\.z/);
  });

  it('references only assets the layout stages', () => {
    const xml = manifest();
    for (const asset of REQUIRED_ASSETS) expect(xml).toContain(`Assets\\${asset}`);
  });
});

describe('layout staging', () => {
  function inputs() {
    const exe = path.join(tmp, 'in', 'Burrow.exe');
    const sidecar = path.join(tmp, 'in', 'burrow-server-aarch64-pc-windows-msvc.exe');
    const distDir = path.join(tmp, 'in', 'dist');
    const migrationsDir = path.join(tmp, 'in', 'migrations');
    const assetsDir = path.join(tmp, 'in', 'assets');
    for (const dir of [distDir, path.join(distDir, 'assets'), migrationsDir, assetsDir]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(exe, 'exe');
    fs.writeFileSync(sidecar, 'sidecar');
    fs.writeFileSync(path.join(distDir, 'index.html'), '<html></html>');
    fs.writeFileSync(path.join(distDir, 'assets', 'app.js'), 'x');
    fs.writeFileSync(path.join(migrationsDir, '001_init.sql'), 'select 1;');
    for (const name of REQUIRED_ASSETS) fs.writeFileSync(path.join(assetsDir, name), 'png');
    return { stageDir: path.join(tmp, 'stage'), exe, sidecar, distDir, migrationsDir, assetsDir, manifestXml: '<Package/>' };
  }

  it('lays the files out the way the shell resolves them', () => {
    const files = stageLayout(inputs());
    expect(files).toEqual([
      'Assets/Square150x150Logo.png',
      'Assets/Square44x44Logo.png',
      'Assets/StoreLogo.png',
      'AppxManifest.xml',
      'Burrow.exe',
      'burrow-server.exe',
      'resources/dist/assets/app.js',
      'resources/dist/index.html',
      'resources/migrations/001_init.sql',
    ].sort());
    expect(fs.readFileSync(path.join(tmp, 'stage', 'burrow-server.exe'), 'utf8')).toBe('sidecar');
    expect(checkStagedLayout(path.join(tmp, 'stage'))).toEqual([]);
  });

  it('empties a stale stage folder first', () => {
    const args = inputs();
    fs.mkdirSync(args.stageDir, { recursive: true });
    fs.writeFileSync(path.join(args.stageDir, 'stale.txt'), 'old');
    expect(stageLayout(args)).not.toContain('stale.txt');
  });

  it('fails clearly when an input is missing', () => {
    const args = inputs();
    fs.rmSync(args.sidecar);
    expect(() => stageLayout(args)).toThrow(/sidecar is missing/);
    const args2 = inputs();
    fs.rmSync(path.join(args2.assetsDir, 'StoreLogo.png'));
    expect(() => stageLayout(args2)).toThrow(/StoreLogo\.png is missing/);
    const args3 = inputs();
    fs.rmSync(path.join(args3.migrationsDir, '001_init.sql'));
    expect(() => stageLayout(args3)).toThrow(/no \.sql files/);
  });

  it('reports every problem of a half-staged folder', () => {
    fs.mkdirSync(path.join(tmp, 'half'), { recursive: true });
    const problems = checkStagedLayout(path.join(tmp, 'half'));
    expect(problems).toEqual(expect.arrayContaining(['missing AppxManifest.xml', 'missing Burrow.exe', 'missing burrow-server.exe', 'missing resources/dist/index.html']));
    expect(listFiles(path.join(tmp, 'half'))).toEqual([]);
  });

  it('names match the Tauri shell: Burrow.exe next to the sidecar the shell launches', () => {
    expect(APP_EXECUTABLE).toBe('Burrow.exe');
    expect(SIDECAR_EXECUTABLE).toBe('burrow-server.exe');
    expect(fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', 'channel.rs'), 'utf8')).toContain('Channel::Stable => "burrow-server"');
    const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
    expect(conf.bundle.externalBin).toEqual(['binaries/burrow-server']);
    expect(conf.bundle.resources).toEqual(['resources/dist', 'resources/migrations']);
    const cargo = fs.readFileSync(path.join(ROOT, 'src-tauri', 'Cargo.toml'), 'utf8');
    expect(cargo).toMatch(/\[\[bin\]\]\s*\nname = "Burrow"/);
  });
});

describe('Windows SDK lookup', () => {
  const kits = 'C:\\Kits\\bin';
  const present = new Set([
    path.join(kits, '10.0.22621.0', 'arm64', 'makeappx.exe'),
    path.join(kits, '10.0.22621.0', 'arm64', 'signtool.exe'),
    path.join(kits, '10.0.26100.0', 'x64', 'makeappx.exe'),
    path.join(kits, '10.0.26100.0', 'x64', 'signtool.exe'),
  ]);
  const seams = { kitsBin: kits, readdir: () => ['10.0.22621.0', '10.0.26100.0', 'x64', 'junk'], exists: (f) => present.has(f) };

  it('sorts SDK folders newest first and drops other names', () => {
    expect(sortSdkVersions(['10.0.9.0', '10.0.26100.0', 'x64', '10.0.22621.1', '10.0.22621.0'])).toEqual(['10.0.26100.0', '10.0.22621.1', '10.0.22621.0', '10.0.9.0']);
  });

  it('prefers the newest SDK that has every tool for the host architecture, else falls back to x64', () => {
    expect(findSdkTools({ ...seams, arch: 'arm64' })).toMatchObject({ sdkVersion: '10.0.26100.0', arch: 'x64' });
    expect(findSdkTools({ ...seams, arch: 'x64' }).arch).toBe('x64');
    const both = new Set([...present, path.join(kits, '10.0.26100.0', 'arm64', 'makeappx.exe'), path.join(kits, '10.0.26100.0', 'arm64', 'signtool.exe')]);
    const found = findSdkTools({ ...seams, exists: (f) => both.has(f), arch: 'arm64' });
    expect(found.arch).toBe('arm64');
    expect(found.tools.makeappx).toBe(path.join(kits, '10.0.26100.0', 'arm64', 'makeappx.exe'));
  });

  it('explains what to install when nothing is found', () => {
    expect(() => findSdkTools({ kitsBin: kits, readdir: () => [], exists: () => false })).toThrow(/Windows SDK/);
    expect(() => findSdkTools({ kitsBin: kits, readdir: () => { throw new Error('nope'); }, exists: () => false })).toThrow(/makeappx\.exe and signtool\.exe/);
    expect(hostSdkArch('arm64')).toBe('arm64');
    expect(hostSdkArch('x64')).toBe('x64');
    expect(hostSdkArch('ia32')).toBe('x86');
  });
});

describe('x64 node.exe', () => {
  const pe = (machine) => {
    const buf = Buffer.alloc(0x100);
    buf.writeUInt16LE(0x5a4d, 0);
    buf.writeUInt32LE(0x80, 0x3c);
    buf.write('PE\0\0', 0x80, 'latin1');
    buf.writeUInt16LE(machine, 0x84);
    return buf;
  };

  it('reads the machine type from the PE header', () => {
    expect(peMachine(pe(0x8664))).toBe('x64');
    expect(peMachine(pe(0xaa64))).toBe('arm64');
    expect(peMachine(pe(0x14c))).toBe('other');
    expect(peMachine(Buffer.from('not an exe'))).toBeNull();
  });

  it('builds the official URLs and finds the win-x64 sha256', () => {
    expect(nodeUrls('v24.15.0')).toEqual({
      exe: 'https://nodejs.org/dist/v24.15.0/win-x64/node.exe',
      sums: 'https://nodejs.org/dist/v24.15.0/SHASUMS256.txt',
    });
    expect(() => nodeUrls('24.15.0')).toThrow(/Unexpected Node version/);
    const hash = 'a'.repeat(64);
    expect(parseShasums(`${'b'.repeat(64)}  win-arm64/node.exe\n${hash}  win-x64/node.exe\n`)).toBe(hash);
    expect(() => parseShasums('nothing')).toThrow(/no win-x64/);
  });

  it('accepts only an x64 node.exe of the running version', () => {
    const file = path.join(tmp, 'node.exe');
    fs.writeFileSync(file, pe(0x8664));
    const ok = () => ({ status: 0, stdout: 'v24.15.0\n' });
    expect(() => assertUsableX64Node(file, { version: 'v24.15.0', run: ok })).not.toThrow();
    expect(() => assertUsableX64Node(file, { version: 'v24.14.0', run: ok })).toThrow(/must be Node v24\.14\.0/);
    fs.writeFileSync(file, pe(0xaa64));
    expect(() => assertUsableX64Node(file, { version: 'v24.15.0', run: ok })).toThrow(/not an x64/);
    expect(() => assertUsableX64Node(path.join(tmp, 'missing.exe'))).toThrow(/could not be read/);
  });

  describe('ensureX64Node', () => {
    const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
    const body = pe(0x8664);
    const good = sha(body);
    const VERSION = 'v24.15.0';
    const runOk = () => ({ status: 0, stdout: `${VERSION}\n` });
    const ab = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    /** An injected fetch: records url and init, answers SHASUMS256.txt and node.exe. */
    const makeFetch = ({ sumsHash = good, exeBody = body, exeHeaders = {}, exeUrl, sumsUrl } = {}) => {
      const calls = [];
      const fetchImpl = async (url, init) => {
        calls.push({ url, init });
        if (url.endsWith('SHASUMS256.txt')) {
          return { ok: true, status: 200, url: sumsUrl ?? url, text: async () => `${sumsHash}  win-x64/node.exe\n` };
        }
        return {
          ok: true,
          status: 200,
          url: exeUrl ?? url,
          headers: { get: (name) => exeHeaders[name.toLowerCase()] ?? null },
          arrayBuffer: async () => ab(exeBody),
        };
      };
      return { fetchImpl, calls };
    };
    const pins = { [VERSION]: good };
    const go = (opts) => ensureX64Node({ cacheDir: path.join(tmp, 'cache'), version: VERSION, pins, run: runOk, ...opts });

    it('the committed pin file holds the verified v24.15.0 hash and every entry is well formed', () => {
      const committed = readNodePins(ROOT);
      expect(committed['v24.15.0']).toBe('3331e1ffe19874215472217c5e94f5a0c6d8e18c4ac7111d3937aa0ad5e9b4a5');
      for (const [version, hash] of Object.entries(committed)) {
        expect(version).toMatch(/^v\d+\.\d+\.\d+$/);
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
      }
    });

    it('refuses a Node version with no pin before any request, and names the way out', async () => {
      const { fetchImpl, calls } = makeFetch();
      await expect(go({ fetchImpl, version: 'v24.99.0', pins })).rejects.toThrow(/No pinned sha256.*v24\.99\.0.*--x64-node/s);
      expect(calls).toHaveLength(0);
    });

    it('downloads once without following redirects, verifies the pin, caches, and re-verifies the cache', async () => {
      const { fetchImpl, calls } = makeFetch();
      const file = await go({ fetchImpl });
      expect(path.basename(file)).toBe('node-v24.15.0-win-x64.exe');
      expect(calls).toHaveLength(2);
      for (const call of calls) expect(call.init).toEqual({ redirect: 'error' });
      expect(fs.existsSync(`${file}.partial`)).toBe(false);
      await go({ fetchImpl });
      expect(calls).toHaveLength(2);
    });

    it('a cached copy is checked against the pin and run: a changed file is downloaded again, a non-matching version fails', async () => {
      const { fetchImpl, calls } = makeFetch();
      const file = await go({ fetchImpl });
      fs.writeFileSync(file, pe(0x8664).fill(7, 0x90));
      await go({ fetchImpl });
      expect(calls).toHaveLength(4);
      expect(sha(fs.readFileSync(file))).toBe(good);
      await expect(go({ fetchImpl, run: () => ({ status: 0, stdout: 'v1.0.0\n' }) })).rejects.toThrow(/must be Node v24\.15\.0/);
    });

    it('discards a download that does not match the pin, and a pin that nodejs.org does not list', async () => {
      const wrong = pe(0x8664).fill(9, 0x90);
      await expect(go({ fetchImpl: makeFetch({ exeBody: wrong }).fetchImpl })).rejects.toThrow(/does not match the pinned sha256/);
      const sumsDiffer = makeFetch({ sumsHash: '0'.repeat(64) });
      await expect(go({ fetchImpl: sumsDiffer.fetchImpl })).rejects.toThrow(/lists 0{64}.*pins/);
      expect(sumsDiffer.calls).toHaveLength(1);
      expect(fs.existsSync(path.join(tmp, 'cache'))).toBe(false);
    });

    it('refuses an answer from another host and an oversized or empty announced length before reading the body', async () => {
      await expect(go({ fetchImpl: makeFetch({ exeUrl: 'https://example.invalid/node.exe' }).fetchImpl })).rejects.toThrow(/not https:\/\/nodejs\.org\/dist/);
      await expect(go({ fetchImpl: makeFetch({ sumsUrl: 'https://nodejs.org.evil.invalid/SHASUMS256.txt' }).fetchImpl })).rejects.toThrow(/refusing it/);
      for (const length of [String(MAX_NODE_BYTES + 1), '0']) {
        const read = vi.fn(async () => ab(body));
        const fetchImpl = async (url) =>
          url.endsWith('SHASUMS256.txt')
            ? { ok: true, status: 200, url, text: async () => `${good}  win-x64/node.exe\n` }
            : { ok: true, status: 200, url, headers: { get: () => length }, arrayBuffer: read };
        await expect(go({ fetchImpl })).rejects.toThrow(/unexpected size/);
        expect(read).not.toHaveBeenCalled();
      }
      expect(fs.existsSync(path.join(tmp, 'cache'))).toBe(false);
    });

    it('refuses a failed request and a file that is not an x64 executable', async () => {
      const failing = async () => ({ ok: false, status: 503, url: 'https://nodejs.org/dist/x' });
      await expect(go({ fetchImpl: failing })).rejects.toThrow(/HTTP 503/);
      const arm = pe(0xaa64);
      await expect(go({ fetchImpl: makeFetch({ exeBody: arm, sumsHash: sha(arm) }).fetchImpl, pins: { [VERSION]: sha(arm) } })).rejects.toThrow(/not an x64/);
    });
  });
});

describe('local test signing', () => {
  it('builds a PowerShell script that keeps a non-exportable key in the user store and exports only the .cer', () => {
    const script = certScript();
    expect(script).toContain('Cert:\\CurrentUser\\My');
    expect(script).toContain('Export-Certificate');
    expect(script).toContain('-KeyExportPolicy NonExportable');
    expect(script).not.toMatch(/Export-PfxCertificate|LocalMachine/);
  });

  it('passes the subject and the .cer path as environment variables, never inside the script text', () => {
    const script = certScript();
    expect(script).toContain(`$subject = $env:${SUBJECT_ENV}`);
    expect(script).toContain(`$cerPath = $env:${CER_PATH_ENV}`);
    expect(script).toContain('-FilePath $cerPath');
    expect(script).not.toContain('CN=');
    const hostile = "CN=x'; Remove-Item C:\\ -Recurse; '";
    const seen = [];
    const run = (file, args, options) => {
      seen.push({ args, options });
      return `${'AB'.repeat(20)}\n`;
    };
    ensureLocalTestCert({ outDir: "C:\\out\\it's", subject: hostile, run });
    const { args, options } = seen[0];
    expect(args.join(' ')).not.toContain('Remove-Item C:');
    expect(args.join(' ')).not.toContain("it's");
    expect(options.env[SUBJECT_ENV]).toBe(hostile);
    expect(options.env[CER_PATH_ENV]).toBe(path.join("C:\\out\\it's", 'BurrowLocalTest.cer'));
  });

  it('creates the test certificate for the package Publisher, never for another subject', () => {
    const calls = [];
    const run = (file, args, options) => {
      calls.push(options.env[SUBJECT_ENV]);
      return `${'AB'.repeat(20)}\n`;
    };
    const out = ensureLocalTestCert({ outDir: 'C:\\out', subject: 'CN=ED5E4A2A-3217-4F54-A392-3EAD302CF036', run });
    expect(out.thumbprint).toBe('AB'.repeat(20));
    expect(calls[0]).toBe('CN=ED5E4A2A-3217-4F54-A392-3EAD302CF036');
    expect(() => ensureLocalTestCert({ outDir: 'C:\\out', subject: 'Burrow', run })).toThrow(/Publisher/);
    expect(() => ensureLocalTestCert({ outDir: 'C:\\out', run })).toThrow(/Publisher/);
  });

  it('parses the thumbprint and builds the signtool arguments', () => {
    const t = 'AB'.repeat(20);
    expect(parseThumbprint(`warning\n${t.toLowerCase()}\n`)).toBe(t);
    expect(() => parseThumbprint('nothing')).toThrow(/thumbprint/);
    expect(signtoolArgs({ thumbprint: t, file: 'x.msix' })).toEqual(['sign', '/fd', 'SHA256', '/sha1', t, '/s', 'My', 'x.msix']);
    expect(() => signtoolArgs({ thumbprint: 'zz', file: 'x.msix' })).toThrow(/Invalid certificate/);
  });
});

describe('buildStore CLI helpers', () => {
  it('defaults to both architectures and refuses nonsense', () => {
    expect(parseCliArgs([])).toMatchObject({ arches: ['arm64', 'x64'], localTest: false, signLocalTest: false, check: false });
    expect(parseCliArgs(['--arch', 'x64,arm64,x64']).arches).toEqual(['arm64', 'x64']);
    expect(() => parseCliArgs(['--arch', 'x86'])).toThrow(/--arch takes/);
    expect(() => parseCliArgs(['--arch', ''])).toThrow(/--arch takes/);
    expect(() => parseCliArgs(['--publish'])).toThrow();
  });

  it('signing is only for the local test build', () => {
    expect(() => parseCliArgs(['--sign-local-test'])).toThrow(/only works with --local-test/);
    expect(parseCliArgs(['--local-test', '--sign-local-test']).signLocalTest).toBe(true);
    expect(() => parseCliArgs(['--arch', 'arm64', '--x64-node', 'n.exe'])).toThrow(/only applies when x64/);
  });

  it('puts the output outside the repo and names a test build apart', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\example\\AppData\\Local' };
    const real = resolveOutDir({ root: ROOT, version: '0.4.1', localTest: false, outDir: null, env });
    expect(real).toBe(path.resolve('C:\\Users\\example\\AppData\\Local', 'burrow-release', 'store', '0.4.1'));
    expect(resolveOutDir({ root: ROOT, version: '0.4.1', localTest: true, outDir: null, env })).toMatch(/0\.4\.1-localtest$/);
    expect(() => resolveOutDir({ root: ROOT, version: '0.4.1', localTest: false, outDir: path.join(ROOT, 'out'), env })).toThrow(/outside the repository/);
  });

  it('checks the compiled markers and that the base Tauri config has no updater', () => {
    const sidecar = Buffer.from(`${STORE_SIDECAR_MARKER}\n...`);
    const exe = Buffer.from(`xx ${STORE_SHELL_MARKER} xx`);
    expect(() => assertStoreMarkers({ sidecar, exe })).not.toThrow();
    expect(() => assertStoreMarkers({ sidecar: Buffer.from('plain'), exe })).toThrow(/sidecar is not a Store build/);
    expect(() => assertStoreMarkers({ sidecar, exe: Buffer.from('burrow-distribution=direct') })).toThrow(/not a Store build/);
    expect(() => assertStoreMarkers({ sidecar, exe: Buffer.from(`${STORE_SHELL_MARKER} burrow-distribution=direct`) })).toThrow(/mixed/);
    expect(() => assertNoUpdaterInBaseConfig(ROOT)).not.toThrow();
  });

  it('formats the sums and the summary', () => {
    expect(formatSums([{ name: 'b.msix', sha256: '2' }, { name: 'a.msix', sha256: '1' }])).toBe('1  a.msix\n2  b.msix\n');
    const summary = formatSummary({
      version: '0.4.1', storeVersion: '0.4.1.0', source: 'local-test-fallback', identity: LOCAL_TEST_IDENTITY, commit: 'abc1234', built: '2026-10-08T00:00:00Z',
      outputs: [{ name: 'a.msix', sha256: '1', bytes: 2 * 1024 * 1024 }], arches: ['arm64'], sdkVersion: '10.0.26100.0', x64Node: null, localTest: true, signed: false,
    });
    expect(summary).toContain('LOCAL TEST BUILD, unsigned. FOR SIDELOAD ONLY, NOT FOR UPLOAD.');
    expect(summary).toContain('app version 0.4.1, Store package version 0.4.1.0');
    expect(summary).toContain('a.msix  2.0 MiB  sha256 1');
    expect(summary).not.toMatch(/Microsoft Store signs/);
  });

  it.skipIf(!HAS_STORE_CONFIG)('a signed test build with the real identity says it is self-signed, sideload only and shares the Store identity', () => {
    const { identity, source } = resolveIdentity({ config: readStoreConfig(ROOT), localTest: true });
    const summary = formatSummary({
      version: '0.4.1', storeVersion: '0.4.1.0', source, identity, commit: null, built: '2026-10-08T00:00:00Z',
      outputs: [], arches: ['arm64'], sdkVersion: '10.0.26100.0', x64Node: null, localTest: true, signed: true,
    });
    expect(summary).toContain('self-signed with a test certificate (subject equals the Publisher). FOR SIDELOAD ONLY, NOT FOR UPLOAD.');
    expect(summary).toContain('same identity as the Store app: uninstall it');
    expect(summary).toContain('NeuralFoundry.BurrowPrivateLifeOrganizer / CN=ED5E4A2A-3217-4F54-A392-3EAD302CF036 (local-test)');
  });

  it.skipIf(!HAS_STORE_CONFIG)('a signed test build with the real identity ends with cleanup commands for the package and the Publisher certificate', () => {
    const { identity, source } = resolveIdentity({ config: readStoreConfig(ROOT), localTest: true });
    const base = { version: '0.4.1', storeVersion: '0.4.1.0', source, identity, commit: null, built: '2026-10-08T00:00:00Z', outputs: [], arches: ['arm64'], sdkVersion: '10.0.26100.0', x64Node: null, localTest: true, signed: true };
    const summary = formatSummary(base);
    expect(summary).toContain('Cleanup after the sideload test');
    for (const command of cleanupCommands(identity)) expect(summary).toContain(command);
    expect(cleanupCommands(identity)[0]).toBe('Get-AppxPackage -Name NeuralFoundry.BurrowPrivateLifeOrganizer | Remove-AppxPackage');
    expect(cleanupCommands(identity)[1]).toBe("Get-ChildItem Cert:\\CurrentUser\\My | Where-Object { $_.Subject -eq 'CN=ED5E4A2A-3217-4F54-A392-3EAD302CF036' } | Remove-Item");
    expect(cleanupCommands(identity)[2]).toContain('Cert:\\LocalMachine\\TrustedPeople');
    expect(summary).not.toContain('—');
    expect(formatSummary({ ...base, source: 'local-test-fallback', identity: LOCAL_TEST_IDENTITY })).not.toContain('Cleanup after the sideload test');
    expect(formatSummary({ ...base, localTest: false, signed: false, source: 'partner-center' })).not.toContain('Cleanup after the sideload test');
  });

  it('the summary says whether the sidecar smoke test ran, and --skip-smoke is parsed', () => {
    const base = { version: '0.4.1', storeVersion: '0.4.1.0', source: 'partner-center', identity: REAL, commit: null, built: 'now', outputs: [], arches: ['arm64', 'x64'], sdkVersion: '10', x64Node: null, localTest: false, signed: false };
    expect(formatSummary({ ...base, smoke: 'passed' })).toContain('smoke test (scripts/release/smokeSidecar.js, --expect-distribution store): passed for arm64, x64');
    expect(formatSummary({ ...base, smoke: 'skipped' })).toContain('SKIPPED (--skip-smoke). Do not upload this build');
    expect(parseCliArgs([]).skipSmoke).toBe(false);
    expect(parseCliArgs(['--skip-smoke']).skipSmoke).toBe(true);
  });

  it('assertWebBuild refuses a missing, dev, stale or invalid build info in any folder', () => {
    const write = (name, info) => {
      const dir = path.join(tmp, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'burrow-build-info.json'), typeof info === 'string' ? info : JSON.stringify(info));
      return dir;
    };
    const stable = write('stable', { formatVersion: 1, version: '0.4.1', channel: 'stable' });
    const legacy = write('legacy', { formatVersion: 1, version: '0.4.1' });
    expect(() => assertWebBuild({ dirs: [stable, legacy], version: '0.4.1', expectPro: 'absent' })).not.toThrow();
    expect(() => assertWebBuild({ dirs: [stable], version: '0.4.1' })).toThrow(/no Pro chunks/);
    expect(() => assertWebBuild({ dirs: [write('dev', { version: '0.4.1-dev.20261005.abc1234', channel: 'dev' })], version: '0.4.1' })).toThrow(/channel is "dev", expected "stable"/);
    expect(() => assertWebBuild({ dirs: [write('old', { version: '0.4.0', channel: 'stable' })], version: '0.4.1' })).toThrow(/stale build/);
    expect(() => assertWebBuild({ dirs: [write('bad', 'not json')], version: '0.4.1' })).toThrow(/missing or not valid JSON/);
    expect(() => assertWebBuild({ dirs: [path.join(tmp, 'nothing-here')], version: '0.4.1' })).toThrow(/npm run build/);
    expect(() => assertWebBuild({ dirs: [stable, write('dev2', { version: '0.4.1', channel: 'dev' })], version: '0.4.1', expectPro: 'absent' })).toThrow(/dev2/);
  });

  it('removeStaleOutputs deletes the packages, bundle, sums, summary and test certificate of an earlier build, nothing else', () => {
    const out = path.join(tmp, 'out');
    fs.mkdirSync(path.join(out, 'staging'), { recursive: true });
    const stale = ['Burrow_0.4.0_arm64.msix', 'Burrow_0.4.0_x64.msix', 'Burrow_0.4.0.msixbundle', 'Other.msixbundle', 'SHA256SUMS.txt', 'build-summary.txt', 'BurrowLocalTest.cer'];
    const keep = ['notes.txt', 'Burrow.cer.bak'];
    for (const name of [...stale, ...keep]) fs.writeFileSync(path.join(out, name), 'x');
    expect(removeStaleOutputs(out).sort()).toEqual([...stale].sort());
    expect(fs.readdirSync(out).sort()).toEqual([...keep, 'staging'].sort());
    expect(removeStaleOutputs(path.join(tmp, 'no-such-folder'))).toEqual([]);
  });

  it('removeStoreArtifacts deletes only Store-marked sidecars and bundles, never a direct one', () => {
    const storeExe = path.join(tmp, 'burrow-server-aarch64-pc-windows-msvc.exe');
    const directExe = path.join(tmp, 'burrow-server-x86_64-pc-windows-msvc.exe');
    const storeBundle = path.join(tmp, 'store.cjs');
    const directBundle = path.join(tmp, 'direct.cjs');
    fs.writeFileSync(storeExe, `MZ /*! BURROW_CHANNEL=stable */ ${STORE_SIDECAR_MARKER}`);
    fs.writeFileSync(directExe, 'MZ /*! BURROW_CHANNEL=stable */');
    fs.writeFileSync(storeBundle, `/*! BURROW_CHANNEL=stable */\n${STORE_SIDECAR_MARKER}\n`);
    fs.writeFileSync(directBundle, '/*! BURROW_CHANNEL=stable */\n');
    const removed = removeStoreArtifacts([storeExe, directExe, storeBundle, directBundle, path.join(tmp, 'missing.exe')]);
    expect(removed).toEqual([storeExe, storeBundle]);
    expect(fs.existsSync(storeExe)).toBe(false);
    expect(fs.existsSync(storeBundle)).toBe(false);
    expect(fs.existsSync(directExe)).toBe(true);
    expect(fs.existsSync(directBundle)).toBe(true);
  });

  it('every build step order: smoke test after staging each arch, stale cleanup first, web check after the sidecar copy', () => {
    const text = fs.readFileSync(path.join(ROOT, 'scripts', 'release', 'buildStore.mjs'), 'utf8');
    const at = (needle) => {
      const i = text.indexOf(needle, text.indexOf('async function main'));
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    expect(at('removeStaleOutputs(outDir)')).toBeLessThan(at("node('build the web app"));
    expect(at('compileArch({ arch')).toBeLessThan(at('assertWebBuild({ dirs: [distDir, resourcesDist]'));
    expect(at('assertWebBuild({ dirs: [distDir, resourcesDist]')).toBeLessThan(at('stageLayout({'));
    expect(at('stageLayout({')).toBeLessThan(at('smokeStaged({'));
    expect(at('smokeStaged({')).toBeLessThan(at('makeappx pack'));
    expect(text).toContain("'--expect-distribution', 'store'");
    expect(text).toContain("'--sidecar', path.join(stageDir, SIDECAR_EXECUTABLE)");
    expect(text).toContain("'--resources', path.join(stageDir, 'resources')");
  });

  it('the npm script exists', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['release:store']).toBe('node scripts/release/buildStore.mjs');
  });

  it('exports the architecture to triple map the build uses', () => {
    expect(ARCHITECTURES).toEqual({ arm64: 'aarch64-pc-windows-msvc', x64: 'x86_64-pc-windows-msvc' });
  });
});

describe('a Store sidecar never ships through a direct build', () => {
  const STORE_BIN = Buffer.from('MZ ... /*! BURROW_CHANNEL=stable */ /*! BURROW_DISTRIBUTION=store */ ...');
  const DIRECT_BIN = Buffer.from('MZ ... /*! BURROW_CHANNEL=stable */ ...');
  const STORE_BUNDLE = '/*! BURROW_CHANNEL=stable */\n/*! BURROW_DISTRIBUTION=store */\nconsole.log(1)\n';
  const DIRECT_BUNDLE = '/*! BURROW_CHANNEL=stable */\nconsole.log(1)\n';
  const quiet = { log: () => {}, error: () => {} };
  const write = (name, content) => {
    const file = path.join(tmp, name);
    fs.writeFileSync(file, content);
    return file;
  };

  it('checkDistribution tells the two apart', () => {
    expect(checkDistribution(STORE_BIN, 'direct')).toHaveLength(1);
    expect(checkDistribution(DIRECT_BIN, 'direct')).toEqual([]);
    expect(checkDistribution(STORE_BUNDLE, 'store')).toEqual([]);
    expect(checkDistribution(DIRECT_BUNDLE, 'store')).toHaveLength(1);
    expect(checkBinaryChannel(STORE_BIN, 'stable')).toEqual([]);
  });

  it('the marker check refuses a store sidecar with --expect-distribution direct and accepts it for store', () => {
    const storeBin = write('store.exe', STORE_BIN);
    const storeBundle = write('store.cjs', STORE_BUNDLE);
    const directBin = write('direct.exe', DIRECT_BIN);
    const directBundle = write('direct.cjs', DIRECT_BUNDLE);
    const base = ['--expect', 'stable'];
    expect(channelMarkerMain([...base, '--expect-distribution', 'direct', '--binary', storeBin], quiet)).toBe(1);
    expect(channelMarkerMain([...base, '--expect-distribution', 'direct', '--bundle', storeBundle], quiet)).toBe(1);
    expect(channelMarkerMain([...base, '--expect-distribution', 'direct', '--binary', directBin, '--bundle', directBundle], quiet)).toBe(0);
    expect(channelMarkerMain([...base, '--expect-distribution', 'store', '--binary', storeBin, '--bundle', storeBundle], quiet)).toBe(0);
    expect(channelMarkerMain([...base, '--expect-distribution', 'store', '--binary', directBin], quiet)).toBe(1);
    expect(channelMarkerMain([...base, '--expect-distribution', 'maybe', '--binary', directBin], quiet)).toBe(1);
    expect(channelMarkerMain([...base, '--binary', directBin], quiet)).toBe(0);
  });

  it('assertSidecarChannel defaults to direct and refuses a store sidecar and bundle', () => {
    const storeBin = write('s.exe', STORE_BIN);
    const storeBundle = write('s.cjs', STORE_BUNDLE);
    const directBin = write('d.exe', DIRECT_BIN);
    const directBundle = write('d.cjs', DIRECT_BUNDLE);
    const run = (argv) => channelMarkerMain(argv, quiet);
    expect(() => assertSidecarChannel('stable', { binary: storeBin, bundle: directBundle, run })).toThrow(/not a stable build with the direct distribution/);
    expect(() => assertSidecarChannel('stable', { binary: directBin, bundle: storeBundle, run })).toThrow(/Microsoft Store sidecar is never packaged/);
    expect(() => assertSidecarChannel('stable', { binary: directBin, bundle: directBundle, run })).not.toThrow();
    expect(() => assertSidecarChannel('stable', { binary: storeBin, bundle: storeBundle, distribution: 'store', run })).not.toThrow();
  });

  it('buildInstaller refuses a store sidecar left in src-tauri/binaries before running tauri', () => {
    const root = path.join(tmp, 'repo');
    const bin = path.join(root, 'src-tauri', 'binaries');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'burrow-server-aarch64-pc-windows-msvc.exe'), STORE_BIN);
    fs.writeFileSync(path.join(bin, 'burrow-server-x86_64-pc-windows-msvc.exe'), DIRECT_BIN);
    let ran = false;
    expect(() => buildInstaller({ root, env: {}, step: () => { ran = true; } })).toThrow(/Microsoft Store sidecar is present.*burrow-server-aarch64-pc-windows-msvc\.exe/);
    expect(ran).toBe(false);
    expect(() => assertNoStoreSidecars(path.join(tmp, 'no-such-folder'))).not.toThrow();
  });

  it('releaseLocal channel check refuses a store sidecar', () => {
    const root = path.join(tmp, 'repo2');
    const bin = path.join(root, 'src-tauri', 'binaries');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'burrow-server-aarch64-pc-windows-msvc.exe'), STORE_BIN);
    const run = (argv) => channelMarkerMain(argv, quiet);
    expect(() => checkChannelArtifacts(root, run)).toThrow(/channel check failed/);
    fs.writeFileSync(path.join(bin, 'burrow-server-aarch64-pc-windows-msvc.exe'), DIRECT_BIN);
    expect(checkChannelArtifacts(root, run)).toEqual({ checked: true });
  });

  it('every CI step that checks a sidecar before tauri build passes --expect-distribution direct', () => {
    // The release and dev-build workflows are private-only (left out of the public core export).
    for (const name of DIRECT_WORKFLOWS) {
      const text = fs.readFileSync(path.join(ROOT, '.github', 'workflows', name), 'utf8');
      const calls = text.match(/channelMarker\.js [^\n]*--(bundle|binary)[^\n]*/g) ?? [];
      expect(calls.length, name).toBeGreaterThan(0);
      for (const call of calls) expect(call, `${name}: ${call}`).toContain('--expect-distribution direct');
    }
  });
});
