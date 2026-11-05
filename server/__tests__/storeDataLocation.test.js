// Build side of the data location: config/msstore.json "dataLocation", the --data-location switch, the two manifests (they must differ
// only in the desktop6 / unvirtualizedResources parts), names that cannot be mixed up, and the markers every build step checks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasPrivateFile } from './helpers/privateFiles.js';
import {
  STORE_SHELL_MARKER,
  STORE_SIDECAR_MARKER,
  USERPROFILE_SIDECAR_MARKER,
  assertStoreMarkers,
  bundleName,
  dataLocationMismatch,
  describeDataLocation,
  formatSummary,
  msixName,
  packageSuffix,
  parseCliArgs,
  resolveOutDir,
} from '../../scripts/release/buildStore.mjs';
import {
  USERPROFILE_DATA_LOCATION_MARKER,
  checkBinaryChannel,
  checkDataLocationMarker,
  checkDistribution,
  main as channelMarkerMain,
} from '../../scripts/checks/channelMarker.js';
import { assertSidecarChannel } from '../../scripts/desktop/lib.js';
import { stableChildEnv } from '../../scripts/desktop/build.js';
import { assertDirectShell, USERPROFILE_SHELL_MARKER } from '../../scripts/release/buildInstaller.js';
import { LOCAL_TEST_IDENTITY, readStoreConfig, resolveDataLocationSetting } from '../../scripts/release/storeIdentity.mjs';
import { CAPABILITIES_BY_DATA_LOCATION, buildManifest } from '../../scripts/release/storeManifest.mjs';
import { DATA_LOCATION_MARKER_PREFIX, buildBackupWorkerSource, bundleDefine, dataLocationBanner } from '../../scripts/desktop/workerBundle.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const IDENTITY = { identityName: '12345Example.Burrow', publisher: 'CN=11111111-2222-3333-4444-555555555555', publisherDisplayName: 'Example Publisher', displayName: 'Burrow' };
const manifestOf = (dataLocation, arch = 'arm64') => buildManifest({ identity: IDENTITY, version: '1.4.1', arch, ...(dataLocation ? { dataLocation } : {}) });

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-dl-build-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('the two manifests', () => {
  /** Lines of `a` that `b` lacks, and the other way round (the manifests are line based and keep the same order). */
  const diff = (a, b) => ({ onlyA: a.split('\n').filter((l) => !b.split('\n').includes(l)), onlyB: b.split('\n').filter((l) => !a.split('\n').includes(l)) });

  it('appdata is the default and stays exactly the manifest of before', () => {
    expect(manifestOf()).toBe(manifestOf('appdata'));
    const xml = manifestOf('appdata');
    expect(xml).toContain('xmlns:desktop6=');
    expect(xml).toContain('IgnorableNamespaces="uap rescap desktop6"');
    expect(xml).toContain('<desktop6:FileSystemWriteVirtualization>disabled</desktop6:FileSystemWriteVirtualization>');
    expect(xml).toContain('<rescap:Capability Name="runFullTrust" />');
    expect(xml).toContain('<rescap:Capability Name="unvirtualizedResources" />');
  });

  it('userprofile leaves out the desktop6 namespace and element and the unvirtualizedResources capability, and nothing else', () => {
    const appdata = manifestOf('appdata');
    const profile = manifestOf('userprofile');
    const { onlyA, onlyB } = diff(appdata, profile);
    expect(onlyA).toEqual([
      '  xmlns:desktop6="http://schemas.microsoft.com/appx/manifest/desktop/windows10/6"',
      '  IgnorableNamespaces="uap rescap desktop6">',
      '    <desktop6:FileSystemWriteVirtualization>disabled</desktop6:FileSystemWriteVirtualization>',
      '    <rescap:Capability Name="unvirtualizedResources" />',
    ]);
    expect(onlyB).toEqual(['  IgnorableNamespaces="uap rescap">']);
    expect(profile).toContain('<rescap:Capability Name="runFullTrust" />');
    expect(profile).not.toMatch(/desktop6|unvirtualizedResources|FileSystemWriteVirtualization/);
    // Every prefix the userprofile manifest uses is declared, and every ignorable prefix is declared.
    expect(profile).toContain('IgnorableNamespaces="uap rescap">');
    for (const prefix of ['uap', 'rescap']) expect(profile).toContain(`xmlns:${prefix}=`);
    // Removing those parts from the appdata manifest gives the userprofile one, byte for byte.
    const stripped = appdata
      .replace('  xmlns:desktop6="http://schemas.microsoft.com/appx/manifest/desktop/windows10/6"\n', '')
      .replace('IgnorableNamespaces="uap rescap desktop6"', 'IgnorableNamespaces="uap rescap"')
      .replace('    <desktop6:FileSystemWriteVirtualization>disabled</desktop6:FileSystemWriteVirtualization>\n', '')
      .replace('    <rescap:Capability Name="unvirtualizedResources" />\n', '');
    expect(stripped).toBe(profile);
  });

  it('is the same for both architectures apart from the architecture', () => {
    for (const dataLocation of ['appdata', 'userprofile']) {
      const arm = manifestOf(dataLocation, 'arm64');
      const x64 = manifestOf(dataLocation, 'x64');
      expect(arm.replace('arm64', 'x64')).toBe(x64);
    }
  });

  it('refuses an unknown data location, and the capability table matches', () => {
    expect(() => manifestOf('home')).toThrow(/Unknown data location/);
    expect(CAPABILITIES_BY_DATA_LOCATION.userprofile).toEqual(['runFullTrust']);
    expect(CAPABILITIES_BY_DATA_LOCATION.appdata).toEqual(['runFullTrust', 'unvirtualizedResources']);
  });
});

// config/msstore.json is private-only (left out of the public core export): the tests that read the owner's Store identity are skipped without it.
const HAS_STORE_CONFIG = hasPrivateFile('config/msstore.json');

describe('choosing the data location', () => {
  it.skipIf(!HAS_STORE_CONFIG)('the committed config says userprofile (Store certification 2026-10-13 denied unvirtualizedResources); the code default stays appdata', () => {
    const config = readStoreConfig(ROOT);
    expect(config.dataLocation).toBe('userprofile');
    expect(resolveDataLocationSetting({ config: {} })).toEqual({ dataLocation: 'appdata', from: 'default' });
  });

  it('the command line wins over the config; both are validated', () => {
    expect(resolveDataLocationSetting({ config: { dataLocation: 'userprofile' } })).toEqual({ dataLocation: 'userprofile', from: 'config' });
    expect(resolveDataLocationSetting({ config: { dataLocation: 'userprofile' }, cli: 'appdata' })).toEqual({ dataLocation: 'appdata', from: 'cli' });
    expect(resolveDataLocationSetting({ config: {}, cli: 'userprofile' })).toEqual({ dataLocation: 'userprofile', from: 'cli' });
    expect(() => resolveDataLocationSetting({ config: { dataLocation: 'home' } })).toThrow(/dataLocation must be one of appdata, userprofile/);
    expect(() => resolveDataLocationSetting({ config: { dataLocation: 3 } })).toThrow(/dataLocation must be one of/);
    expect(() => resolveDataLocationSetting({ config: {}, cli: 'AppData' })).toThrow(/--data-location must be one of appdata, userprofile/);
    expect(() => resolveDataLocationSetting({ config: {}, cli: '' })).toThrow(/--data-location must be one of/);
  });

  it('an upload build refuses a --data-location that differs from config/msstore.json (the privacy page follows the config); a local test may differ', () => {
    expect(dataLocationMismatch({ dataLocation: 'userprofile', configDataLocation: 'appdata', localTest: false })).toBeInstanceOf(Error);
    expect(dataLocationMismatch({ dataLocation: 'userprofile', configDataLocation: 'appdata', localTest: false }).message).toMatch(/differs from config\/msstore\.json dataLocation appdata/);
    expect(dataLocationMismatch({ dataLocation: 'appdata', configDataLocation: 'userprofile', localTest: false })).toBeInstanceOf(Error);
    expect(dataLocationMismatch({ dataLocation: 'userprofile', configDataLocation: 'appdata', localTest: true })).toBeNull();
    expect(dataLocationMismatch({ dataLocation: 'appdata', configDataLocation: 'appdata', localTest: false })).toBeNull();
    expect(dataLocationMismatch({ dataLocation: 'userprofile', configDataLocation: 'userprofile', localTest: false })).toBeNull();
  });

  it.skipIf(!HAS_STORE_CONFIG)('the real CLI refuses a mismatching upload build before it builds anything', async () => {
    const { spawnSync } = await import('node:child_process');
    const config = readStoreConfig(ROOT);
    const other = (config.dataLocation ?? 'appdata') === 'appdata' ? 'userprofile' : 'appdata';
    // The data location gate runs before the version gate, so this is the answer even while the app version is still 0.x.
    const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'release', 'buildStore.mjs'), '--data-location', other, '--skip-smoke'], { cwd: ROOT, encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/differs from config\/msstore\.json dataLocation|first section cannot be 0|must be 1\.0\.0|0\.x/i);
  }, 60000);

  it('npm run release:store -- --data-location userprofile is parsed', () => {
    expect(parseCliArgs(['--data-location', 'userprofile']).dataLocation).toBe('userprofile');
    expect(parseCliArgs(['--local-test', '--data-location=appdata']).dataLocation).toBe('appdata');
    expect(parseCliArgs([]).dataLocation).toBeNull();
    expect(() => parseCliArgs(['--data-location'])).toThrow();
  });

  it('a lingering BURROW_DATA_LOCATION never leaks into a direct build', () => {
    expect(stableChildEnv({ BURROW_DATA_LOCATION: 'userprofile', BURROW_DISTRIBUTION: 'store' }).BURROW_DATA_LOCATION).toBeUndefined();
  });
});

describe('output names say which package it is', () => {
  it('folder and file names carry "userprofile" and appdata ones are unchanged', () => {
    expect(packageSuffix('appdata')).toBe('');
    expect(packageSuffix('userprofile')).toBe('-userprofile');
    expect(msixName({ version: '1.0.0', arch: 'arm64' })).toBe('Burrow_1.0.0_arm64.msix');
    expect(msixName({ version: '1.0.0', arch: 'x64', dataLocation: 'userprofile' })).toBe('Burrow_1.0.0_userprofile_x64.msix');
    expect(bundleName({ version: '1.0.0' })).toBe('Burrow_1.0.0.msixbundle');
    expect(bundleName({ version: '1.0.0', dataLocation: 'userprofile' })).toBe('Burrow_1.0.0_userprofile.msixbundle');
    const env = { LOCALAPPDATA: 'C:\\Users\\example\\AppData\\Local' };
    const dir = (over) => resolveOutDir({ root: ROOT, version: '1.0.0', localTest: false, outDir: null, env, ...over });
    expect(dir({})).toMatch(/store[\\/]1\.0\.0$/);
    expect(dir({ dataLocation: 'userprofile' })).toMatch(/store[\\/]1\.0\.0-userprofile$/);
    expect(dir({ dataLocation: 'userprofile', localTest: true })).toMatch(/1\.0\.0-localtest-userprofile$/);
  });

  it('build-summary.txt prints the data location, loudly for userprofile', () => {
    const base = {
      version: '0.4.1', storeVersion: '0.4.1.0', source: 'partner-center', identity: IDENTITY, commit: null, built: '2026-10-08T00:00:00Z',
      outputs: [], arches: ['arm64'], sdkVersion: '10.0.26100.0', x64Node: null, localTest: false, signed: false, smoke: 'passed',
    };
    const appdata = formatSummary({ ...base, dataLocation: 'appdata' });
    const profile = formatSummary({ ...base, dataLocation: 'userprofile' });
    expect(appdata).toContain('Data location: appdata');
    expect(appdata).toContain('needs a justification for unvirtualizedResources');
    expect(profile).toContain('Data location: USERPROFILE');
    expect(profile).toMatch(/FALLBACK PACKAGE FOR WHEN PARTNER CENTER REFUSES rescap:unvirtualizedResources/);
    expect(profile).toContain('no unvirtualizedResources capability');
    expect(formatSummary(base)).toContain('Data location: appdata');
    // A command line that differs from the config is flagged: the privacy page follows the config.
    expect(formatSummary({ ...base, dataLocation: 'userprofile', configDataLocation: 'appdata' })).toMatch(/NOTE: config\/msstore\.json says dataLocation appdata, but this build used userprofile/);
    expect(formatSummary({ ...base, dataLocation: 'userprofile', configDataLocation: 'userprofile' })).not.toContain('NOTE:');
    expect(describeDataLocation('userprofile').join('\n')).not.toMatch(/[\u2013\u2014]/);
  });

  it.skipIf(!HAS_STORE_CONFIG)('--check prints the data location (real CLI, builds nothing)', async () => {
    const { spawnSync } = await import('node:child_process');
    const run = (args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'release', 'buildStore.mjs'), '--check', '--local-test', ...args], { cwd: ROOT, encoding: 'utf8' });
    const profile = run(['--data-location', 'userprofile']);
    // --check looks up the Windows SDK; a machine without it cannot run this one.
    if (profile.status !== 0 && /Windows SDK|makeappx/i.test(profile.stderr)) return;
    // The Store build is official: without the Pro module checked out, --check prints everything and then fails at the
    // Pro check (docs/adr/0001-open-core-split.md 3.10); with it, it passes.
    const proPresent = fs.existsSync(path.join(ROOT, 'pro', 'server', 'index.js')) && fs.existsSync(path.join(ROOT, 'pro', 'ui', 'proExtensions.js'));
    const okStatus = proPresent ? 0 : 1;
    expect(profile.status, profile.stderr).toBe(okStatus);
    if (!proPresent) expect(profile.stderr).toMatch(/The Burrow Pro module is missing/);
    expect(profile.stdout).toContain('Data location: userprofile (--data-location)');
    expect(profile.stdout).toContain('no unvirtualizedResources capability');
    expect(profile.stdout).toContain(`Pro module: ${proPresent ? 'present' : 'MISSING'}`);
    const standard = run([]);
    expect(standard.status, standard.stderr).toBe(okStatus);
    // The committed config ships the userprofile package (the Store denied unvirtualizedResources on 2026-10-13).
    expect(standard.stdout).toContain('Data location: userprofile (config/msstore.json dataLocation)');
    expect(standard.stdout).toContain('no unvirtualizedResources capability');
    const bad = run(['--data-location', 'nope']);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/--data-location must be one of appdata, userprofile/);
  }, 60000);
});

describe('the privacy page names the data folder of each edition', () => {
  it('follows config/msstore.json dataLocation, and the committed page matches the committed config', async () => {
    const { renderPrivacyPage, renderPages, dataFolderText } = await import('../../scripts/privacy/renderPrivacy.mjs');
    const privacy = { policyVersion: '2026-10-08', effectiveDate: '2026-10-08' };
    const appdata = renderPrivacyPage(privacy, 'help@example.com', [], { storeDataLocation: 'appdata' });
    const profile = renderPrivacyPage(privacy, 'help@example.com', [], { storeDataLocation: 'userprofile' });
    expect(appdata).toContain('in the folder <code>%APPDATA%\\Burrow</code>, in both the direct download edition and the Microsoft Store edition');
    expect(appdata).not.toContain('USERPROFILE');
    expect(profile).toContain('<code>%APPDATA%\\Burrow</code> for the direct download edition, and <code>%USERPROFILE%\\Burrow Data</code> (inside your user folder) for the Microsoft Store edition');
    expect(profile).toContain('delete its data folder');
    expect(dataFolderText('userprofile').remove).toContain('%USERPROFILE%');
    expect(profile).not.toMatch(/[–—]/);
    expect(renderPages()['privacy/index.html']).toBe(fs.readFileSync(path.join(ROOT, 'pages', 'privacy', 'index.html'), 'utf8'));
  });
});

describe('markers in the bundle and the executables', () => {
  it('the bundle define and banner: appdata by default, userprofile only with the Store distribution', () => {
    expect(bundleDefine('1.0.0').__BURROW_DATA_LOCATION__).toBe('"appdata"');
    expect(bundleDefine('1.0.0', { distribution: 'store', dataLocation: 'userprofile' }).__BURROW_DATA_LOCATION__).toBe('"userprofile"');
    expect(() => bundleDefine('1.0.0', { dataLocation: 'userprofile' })).toThrow(/only valid for a stable Microsoft Store build/);
    expect(() => bundleDefine('1.0.0', { distribution: 'store', channel: 'dev', dataLocation: 'userprofile' })).toThrow();
    expect(() => bundleDefine('1.0.0', { dataLocation: 'home' })).toThrow(/Unknown data location/);
    expect(dataLocationBanner('appdata')).toBe('');
    expect(dataLocationBanner('userprofile')).toBe('/*! BURROW_DATA_LOCATION=userprofile */\n');
    expect(dataLocationBanner('userprofile').startsWith(DATA_LOCATION_MARKER_PREFIX)).toBe(true);
    expect(USERPROFILE_DATA_LOCATION_MARKER).toBe('/*! BURROW_DATA_LOCATION=userprofile */');
    expect(USERPROFILE_SIDECAR_MARKER).toBe(USERPROFILE_DATA_LOCATION_MARKER);
  });

  it('the real worker bundle carries the marker only for userprofile, after the channel and distribution markers', async () => {
    const profile = await buildBackupWorkerSource({ distribution: 'store', dataLocation: 'userprofile', version: '1.0.0' });
    // The Pro marker is the second line (docs/adr/0001-open-core-split.md 3.10); the worker bundle has no Pro module by default.
    expect(profile.split('\n').slice(0, 4)).toEqual(['/*! BURROW_CHANNEL=stable */', '/*! BURROW_PRO=off */', '/*! BURROW_DISTRIBUTION=store */', '/*! BURROW_DATA_LOCATION=userprofile */']);
    const store = await buildBackupWorkerSource({ distribution: 'store', version: '1.0.0' });
    expect(store).not.toContain('BURROW_DATA_LOCATION=');
    const direct = await buildBackupWorkerSource({ version: '1.0.0' });
    expect(direct).not.toContain('BURROW_DATA_LOCATION=');
  }, 60_000);

  it('the sidecar bundler takes only the flag and checks the combination', () => {
    const sidecar = fs.readFileSync(path.join(ROOT, 'scripts', 'desktop', 'buildSidecar.js'), 'utf8');
    expect(sidecar).toMatch(/resolveBuildDataLocation\(\{ BURROW_DATA_LOCATION: flagValue\('--data-location'\)/);
    expect(sidecar).toMatch(/assertBuildDataLocation\(\{ dataLocation, distribution, channel: channelBuild\.channel \}\)/);
    expect(sidecar).toMatch(/dataLocationBanner\(dataLocation\)/);
  });

  it('a direct check refuses a userprofile sidecar, a store check can demand it', () => {
    const profileBundle = `/*! BURROW_CHANNEL=stable */\n${STORE_SIDECAR_MARKER}\n${USERPROFILE_DATA_LOCATION_MARKER}\n`;
    const storeBundle = `/*! BURROW_CHANNEL=stable */\n${STORE_SIDECAR_MARKER}\n`;
    expect(checkDistribution(profileBundle, 'direct')[0]).toMatch(/Microsoft Store/);
    expect(checkDistribution(`/*! BURROW_CHANNEL=stable */\n${USERPROFILE_DATA_LOCATION_MARKER}\n`, 'direct')[0]).toMatch(/user profile folder/);
    expect(checkDistribution('/*! BURROW_CHANNEL=stable */\n', 'direct')).toEqual([]);
    expect(checkDataLocationMarker(profileBundle, 'userprofile')).toEqual([]);
    expect(checkDataLocationMarker(storeBundle, 'appdata')).toEqual([]);
    expect(checkDataLocationMarker(profileBundle, 'appdata')[0]).toMatch(/expected appdata/);
    expect(checkDataLocationMarker(storeBundle, 'userprofile')[0]).toMatch(/no userprofile data location marker/);
    expect(checkDataLocationMarker(`/*! BURROW_CHANNEL=stable */\n${USERPROFILE_DATA_LOCATION_MARKER}\n`, 'userprofile')[0]).toMatch(/only valid together with the store distribution/);
    expect(checkBinaryChannel(Buffer.from(profileBundle), 'stable')).toEqual([]);
  });

  it('channelMarker.js --expect-data-location works on a bundle file, and its value is validated', () => {
    const file = path.join(tmp, 'server.cjs');
    const lines = [];
    const io = { log: (m) => lines.push(m), error: (m) => lines.push(m) };
    fs.writeFileSync(file, `/*! BURROW_CHANNEL=stable */\n${STORE_SIDECAR_MARKER}\n${USERPROFILE_DATA_LOCATION_MARKER}\n`);
    expect(channelMarkerMain(['--expect', 'stable', '--bundle', file, '--expect-distribution', 'store', '--expect-data-location', 'userprofile'], io)).toBe(0);
    expect(channelMarkerMain(['--expect', 'stable', '--bundle', file, '--expect-distribution', 'store', '--expect-data-location', 'appdata'], io)).toBe(1);
    expect(channelMarkerMain(['--expect', 'stable', '--bundle', file, '--expect-distribution', 'direct'], io)).toBe(1);
    expect(channelMarkerMain(['--expect', 'stable', '--bundle', file, '--expect-data-location', 'home'], io)).toBe(1);
    expect(lines.join('\n')).toMatch(/--expect-data-location must be one of appdata, userprofile/);
  });

  it('every direct build path asks for appdata, and the sidecar check passes it on', () => {
    const calls = [];
    assertSidecarChannel('stable', { binary: 'b', bundle: 's', run: (argv) => (calls.push(argv), 0) });
    assertSidecarChannel('stable', { binary: 'b', bundle: 's', distribution: 'store', dataLocation: 'userprofile', run: (argv) => (calls.push(argv), 0) });
    expect(calls[0].slice(-4)).toEqual(['--expect-distribution', 'direct', '--expect-data-location', 'appdata']);
    expect(calls[1].slice(-4)).toEqual(['--expect-distribution', 'store', '--expect-data-location', 'userprofile']);
    expect(() => assertSidecarChannel('stable', { binary: 'b', bundle: 's', dataLocation: 'userprofile', run: () => 1 })).toThrow(/userprofile data location/);
  });

  it('a direct installer refuses a shell exe compiled for the user profile data location', () => {
    const exe = path.join(tmp, 'Burrow.exe');
    fs.writeFileSync(exe, Buffer.from('MZ burrow-distribution=direct burrow-data-location=appdata'));
    expect(() => assertDirectShell(exe)).not.toThrow();
    fs.writeFileSync(exe, Buffer.from(`MZ burrow-distribution=direct ${USERPROFILE_SHELL_MARKER}`));
    expect(() => assertDirectShell(exe)).toThrow(/user profile folder/);
  });

  it('a Store build must agree with itself: shell exe and sidecar carry the same data location', () => {
    const storeSidecar = Buffer.from(`${STORE_SIDECAR_MARKER}\n`);
    const profileSidecar = Buffer.from(`${STORE_SIDECAR_MARKER}\n${USERPROFILE_SIDECAR_MARKER}\n`);
    const appExe = Buffer.from(`${STORE_SHELL_MARKER} burrow-data-location=appdata`);
    const profileExe = Buffer.from(`${STORE_SHELL_MARKER} ${USERPROFILE_SHELL_MARKER}`);
    expect(() => assertStoreMarkers({ sidecar: storeSidecar, exe: appExe })).not.toThrow();
    expect(() => assertStoreMarkers({ sidecar: profileSidecar, exe: profileExe, dataLocation: 'userprofile' })).not.toThrow();
    expect(() => assertStoreMarkers({ sidecar: storeSidecar, exe: profileExe, dataLocation: 'userprofile' })).toThrow(/keeps its data in %APPDATA%/);
    expect(() => assertStoreMarkers({ sidecar: profileSidecar, exe: profileExe, dataLocation: 'appdata' })).toThrow(/appdata; refusing a mixed build/);
    expect(() => assertStoreMarkers({ sidecar: profileSidecar, exe: appExe, dataLocation: 'userprofile' })).toThrow(/no burrow-data-location=userprofile marker/);
    expect(() => assertStoreMarkers({ sidecar: profileSidecar, exe: Buffer.from(`${STORE_SHELL_MARKER} ${USERPROFILE_SHELL_MARKER} burrow-data-location=appdata`), dataLocation: 'userprofile' })).toThrow(/mixed/);
    expect(() => assertStoreMarkers({ sidecar: profileSidecar, exe: appExe })).toThrow(/keeps its data in the user profile folder/);
  });

  it('uses the fallback identity unchanged (the data location is independent of the identity)', () => {
    expect(LOCAL_TEST_IDENTITY.identityName).toBe('Burrow.LocalTest');
  });
});
