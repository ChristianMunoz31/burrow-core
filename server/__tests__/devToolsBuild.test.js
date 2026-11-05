// ci:always-run
// The developer tools must not exist in the core or in a stable build. This file proves it at the source level
// (marker holders, import boundaries between core and devtools/) and at the bundle level (real esbuild bundles of
// server.js and server/license/index.js with the same defines, plugin, minify and banner the sidecar bundler uses):
// no marker text, no devtools source, the license hook refuses to install, a stored override row and an env pin are
// ignored. It reads the source tree, so it carries the always-run marker above.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import {
  DEV_TOOLS_MARKER,
  DEV_TOOLS_ROUTE_MARKER,
  STORE_DISTRIBUTION_MARKER,
  USERPROFILE_DATA_LOCATION_MARKER,
  checkBundleText,
} from '../../scripts/checks/channelMarker.js';
import { BUNDLE_BANNER, buildBackupWorkerSource, bundleDefine, channelBanner, dataLocationBanner, devToolsPlugin, distributionBanner, proBanner, proPlugin } from '../../scripts/desktop/workerBundle.js';
import { HIDDEN_APP_STATE_KEYS } from '../dataBrowser/redact.js';
import { PROTECTED_APP_STATE_KEYS } from '../import/importExport.js';
import { hasPrivateFile } from './helpers/privateFiles.js';
import { closeTestDb, createTestDb } from './helpers/testDb.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const DISPLAY = '0.2.0-dev.20261005.abc1234';
const T0 = Date.parse('2026-10-05T12:00:00Z');
const BUILD_INFO = { buildDate: T0, buildDateIso: '2026-10-05T12:00:00Z', source: 'git', version: '0.1.0' };
const EXTENSION_NAME = 'license-tier-switcher';
// devtools/ is private-only (not in the public core export). The tests that need its code are skipped without it;
// the stable-bundle, Store-bundle and module-boundary guards still run in the core, where devtools/ must not exist.
const HAS_DEVTOOLS = hasPrivateFile('devtools/server/static.js') && hasPrivateFile('devtools/server/license/devOverride.js');
const DEV_OVERRIDE = path.join(ROOT, 'devtools', 'server', 'license', 'devOverride.js');
const loadDevOverride = () => import(/* @vite-ignore */ pathToFileURL(DEV_OVERRIDE).href);

let tmp;
let db;
const stable = {};
const dev = {};
const store = {};
const serverText = {};

const toPosix = (file) => file.split(path.sep).join('/');
const rel = (file) => toPosix(path.relative(ROOT, file));

async function bundleLicense(name, channel, defineOpts = {}) {
  const file = path.join(tmp, `${name}.cjs`);
  await build({
    entryPoints: [path.join(ROOT, 'server', 'license', 'index.js')],
    outfile: file,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    minify: true,
    legalComments: 'none',
    logLevel: 'silent',
    define: bundleDefine(channel === 'dev' ? DISPLAY : '0.1.0', { channel, ...defineOpts }),
    plugins: [devToolsPlugin(channel), proPlugin({ exists: () => false })],
    banner: { js: channelBanner(channel) + proBanner(false) + distributionBanner(defineOpts.distribution ?? 'direct') + dataLocationBanner(defineOpts.dataLocation ?? 'appdata') + BUNDLE_BANNER },
  });
  return { file, text: fs.readFileSync(file, 'utf8'), mod: require(file) };
}

/** The whole server.js bundle as the sidecar builds it (text only; nothing is run). */
async function bundleServer(channel, defineOpts = {}) {
  const result = await build({
    entryPoints: [path.join(ROOT, 'server.js')],
    write: false,
    outfile: path.join(tmp, `server-${channel}.cjs`),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    minify: true,
    legalComments: 'none',
    logLevel: 'silent',
    define: { ...bundleDefine(channel === 'dev' ? DISPLAY : '0.1.0', { channel, ...defineOpts }), __BURROW_BACKUP_WORKER_SRC__: JSON.stringify('') },
    plugins: [devToolsPlugin(channel), proPlugin({ exists: () => false })],
    banner: { js: channelBanner(channel) + proBanner(false) + distributionBanner(defineOpts.distribution ?? 'direct') + dataLocationBanner(defineOpts.dataLocation ?? 'appdata') + BUNDLE_BANNER },
  });
  return result.outputFiles[0].text;
}

/** Starts the bundled licensing module on the shared temp DB. */
function startBundled(mod, extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(tmp, 'data-'));
  const key = randomBytes(32);
  mod.initLicense({
    dataDir,
    env: {},
    buildInfo: BUILD_INFO,
    now: () => T0,
    mono: () => 1000,
    getDb: () => db,
    loadKey: () => ({ ok: true, key }),
    gatherEvidence: () => null,
    log: () => {},
    allowTest: false,
    autoStartTrial: false,
    ...extra,
  });
}

const FAKE_HOOK = {
  inputs: () => ({
    activation: { kind: 'none' },
    trial: { kind: 'none' },
    clock: { now: T0, effective: T0, hwm: T0, rollback: false, persisted: false },
    notices: { welcome: true, endingSoon: true, ended: true },
    saveNotices: () => {},
  }),
};

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-devtools-'));
  db = createTestDb();
  Object.assign(stable, await bundleLicense('stable', 'stable'));
  if (HAS_DEVTOOLS) Object.assign(dev, await bundleLicense('dev', 'dev'));
  Object.assign(store, await bundleLicense('store', 'stable', { distribution: 'store', dataLocation: 'userprofile' }));
}, 60_000);

afterAll(() => {
  stable.mod?.resetLicenseForTests?.();
  store.mod?.resetLicenseForTests?.();
  dev.mod?.resetLicenseForTests?.();
  if (db) closeTestDb(db);
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const storeOverride = async (preset = 'pro_founding') => {
  const { saveStoredOverride } = await loadDevOverride();
  return expect(
    saveStoredOverride(
      () => db,
      { v: 1, preset, trialDaysLeft: null, anchorAt: Math.floor(T0 / 1000) * 1000, notices: { welcome: true, endingSoon: true, ended: true } },
      () => T0,
    ),
  ).toBe(true);
};

const SKIP = new Set(['node_modules', 'dist', '.git', '.sidecar-build', 'src-tauri', 'coverage', '.claude', '__tests__', 'docs']);

function walkFiles(dir, extensions = /\.(js|jsx|mjs|cjs|json)$/) {
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (extensions.test(entry.name)) files.push(full);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return files;
}

const rootFiles = () => fs.readdirSync(ROOT).filter((f) => /\.(js|mjs|cjs)$/.test(f)).map((f) => path.join(ROOT, f));
const read = (file) => fs.readFileSync(file, 'utf8');

describe('the markers', () => {
  it.skipIf(!HAS_DEVTOOLS)('BURROW_DEV_TOOLS=on lives in the two developer-tools files and the checker, nowhere else in shipped source', () => {
    expect(DEV_TOOLS_MARKER).toBe('BURROW_DEV_TOOLS=on');
    const files = [...['server', 'src', 'scripts', 'devtools'].flatMap((d) => walkFiles(path.join(ROOT, d))), ...rootFiles()];
    const holders = files.filter((f) => read(f).includes(DEV_TOOLS_MARKER)).map(rel);
    expect(holders.sort()).toEqual(['devtools/server/license/devOverride.js', 'devtools/ui/DeveloperSection.jsx', 'scripts/checks/channelMarker.js']);
  });

  it('the developer routes path is nowhere in the core: server/, src/ and server.js, comments included', () => {
    expect(DEV_TOOLS_ROUTE_MARKER).toBe('/dev/license');
    const files = [...['server', 'src'].flatMap((d) => walkFiles(path.join(ROOT, d), /\.(js|jsx|mjs|cjs)$/)), path.join(ROOT, 'server.js')];
    expect(files.filter((f) => read(f).includes(DEV_TOOLS_ROUTE_MARKER)).map(rel)).toEqual([]);
  });

  it.skipIf(!HAS_DEVTOOLS)('the real module writes the marker in a runtime-live log line, which survives minify', async () => {
    const real = await loadDevOverride();
    const lines = [];
    real.logOverride((m) => lines.push(m), 'pro_founding');
    real.logOverride((m) => lines.push(m), null);
    expect(lines).toEqual([`license: developer override pro_founding (${DEV_TOOLS_MARKER})`, `license: developer override cleared (${DEV_TOOLS_MARKER})`]);
  });
});

describe('devToolsPlugin', () => {
  const loaderEntry = () => {
    const entry = path.join(tmp, 'loader-entry.js');
    fs.writeFileSync(entry, `import { importDevExtension } from ${JSON.stringify(path.join(ROOT, 'server', 'devExtensionsLoader.js'))};\nexport { importDevExtension };\n`);
    return entry;
  };
  const run = async (channel, entry, outName) => {
    const out = path.join(tmp, outName);
    await build({ entryPoints: [entry], outfile: out, bundle: true, platform: 'node', format: 'cjs', target: 'node24', logLevel: 'silent', define: bundleDefine(DISPLAY, { channel }), plugins: [devToolsPlugin(channel)], banner: { js: BUNDLE_BANNER } });
    return out;
  };

  it.skipIf(!HAS_DEVTOOLS)('resolves the loader to the null stub for stable and to the static extension for dev', async () => {
    const stableOut = await run('stable', loaderEntry(), 'loader-stable.cjs');
    expect(await require(stableOut).importDevExtension()).toBeNull();
    expect(read(stableOut)).not.toContain(EXTENSION_NAME);
    expect(read(stableOut)).not.toContain(DEV_TOOLS_MARKER);

    const devOut = await run('dev', loaderEntry(), 'loader-dev.cjs');
    const ext = await require(devOut).importDevExtension();
    expect(ext.name).toBe(EXTENSION_NAME);
    expect(ext.available({})).toBe(true);
    expect(read(devOut)).toContain(DEV_TOOLS_MARKER);
  }, 60_000);

  it('does not swap a different file that happens to be called devExtensionsLoader.js', async () => {
    const other = path.join(tmp, 'other');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'devExtensionsLoader.js'), 'export const which = "unrelated";\n');
    const entry = path.join(tmp, 'other-entry.js');
    fs.writeFileSync(entry, 'import { which } from "./other/devExtensionsLoader.js";\nexport { which };\n');
    const out = path.join(tmp, 'other.cjs');
    await build({ entryPoints: [entry], outfile: out, bundle: true, platform: 'node', format: 'cjs', target: 'node24', logLevel: 'silent', plugins: [devToolsPlugin('stable')] });
    expect(require(out).which).toBe('unrelated');
  });

  it.skipIf(!HAS_DEVTOOLS)('a stable bundle fails when anything under devtools/ is still loaded', async () => {
    const entry = path.join(tmp, 'stable-leak.js');
    fs.writeFileSync(entry, `import ext from ${JSON.stringify(path.join(ROOT, 'devtools', 'server', 'index.js'))};\nexport default ext;\n`);
    await expect(run('stable', entry, 'stable-leak.cjs')).rejects.toThrow(/devtools must not enter a stable bundle/);
  }, 60_000);

  it('a dev bundle fails loud when devtools/ is missing', () => {
    const plugin = devToolsPlugin('dev', { root: path.join(tmp, 'no-such-root'), exists: () => false });
    expect(() => plugin.setup({ onResolve() {}, onLoad() {} })).toThrow(/developer tools but .*static\.js is missing/);
  });

  it('a stable plugin does not need devtools/ at all', () => {
    const plugin = devToolsPlugin('stable', { root: path.join(tmp, 'no-such-root'), exists: () => false });
    const hooks = [];
    expect(() => plugin.setup({ onResolve: () => hooks.push('resolve'), onLoad: () => hooks.push('load') })).not.toThrow();
    expect(hooks).toEqual(['resolve', 'load']);
  });

  it('has a name and setup, and rejects an unknown channel', () => {
    const plugin = devToolsPlugin('stable');
    expect(typeof plugin.name).toBe('string');
    expect(typeof plugin.setup).toBe('function');
    expect(() => devToolsPlugin('beta')).toThrow(/Unknown channel/);
  });
});

describe('a stable bundle', () => {
  it('has no marker and passes the channel check', () => {
    expect(stable.text).not.toContain(DEV_TOOLS_MARKER);
    expect(stable.text).not.toContain('BURROW_DEV_TOOLS');
    expect(checkBundleText(stable.text, 'stable')).toEqual([]);
    expect(stable.text.split('\n', 1)[0]).toBe('/*! BURROW_CHANNEL=stable */');
    // Open core: a bundle built without the Pro module carries BURROW_PRO=off on line 2 (docs/adr/0001-open-core-split.md 3.10).
    expect(stable.text.split('\n')[1]).toBe('/*! BURROW_PRO=off */');
  });

  it('refuses to install a license hook, even a valid one', () => {
    expect(stable.mod.installLicenseDevHook(FAKE_HOOK)).toBeNull();
    expect(stable.mod.installLicenseDevHook(null)).toBeNull();
  });

  it.skipIf(!HAS_DEVTOOLS)('ignores a stored override row: entitlements are the real ones', async () => {
    await storeOverride('pro_founding');
    startBundled(stable.mod);
    expect(stable.mod.getEntitlements()).toEqual({ pro: false, edition: null, reasons: ['no_license'] });
    expect(stable.mod.getLicenseStatus()).toMatchObject({ state: 'free', pro: false, proSource: null, perks: { founderBackground: false } });
  });

  it('ignores an env pin, even with a dev channel in the environment', () => {
    startBundled(stable.mod, { env: { BURROW_DEV_TIER: 'pro_founding', BURROW_CHANNEL: 'dev', BURROW_DESKTOP: '1' } });
    expect(stable.mod.getEntitlements().pro).toBe(false);
  });

  it('a stable worker bundle has no marker either', async () => {
    const text = await buildBackupWorkerSource({ minify: true, channel: 'stable', version: '0.1.0' });
    expect(checkBundleText(text, 'stable')).toEqual([]);
  });

  it('the whole server.js bundle (as the sidecar builds it) has no marker, route or devtools source', async () => {
    serverText.stable = await bundleServer('stable');
    const text = serverText.stable;
    expect(text).not.toContain(DEV_TOOLS_MARKER);
    expect(text).not.toContain(DEV_TOOLS_ROUTE_MARKER);
    expect(text).not.toContain(EXTENSION_NAME);
    expect(text).not.toContain('dev_tools_unavailable');
    expect(checkBundleText(text, 'stable')).toEqual([]);
  }, 60_000);

  it('the stable check refuses both developer markers', () => {
    expect(checkBundleText(`${channelBanner('stable')}x("${DEV_TOOLS_MARKER}")`, 'stable').join(' ')).toMatch(/developer tools/);
    expect(checkBundleText(`${channelBanner('stable')}x("${DEV_TOOLS_ROUTE_MARKER}")`, 'stable').join(' ')).toMatch(/developer tools/);
  });
});

describe('a Microsoft Store bundle (stable channel, store distribution, userprofile data location)', () => {
  it('is a stable bundle with the store markers and no developer tools', () => {
    expect(store.text).toContain(STORE_DISTRIBUTION_MARKER);
    expect(store.text).toContain(USERPROFILE_DATA_LOCATION_MARKER);
    expect(store.text).not.toContain(DEV_TOOLS_MARKER);
    expect(store.text).not.toContain('BURROW_DEV_TOOLS');
    expect(checkBundleText(store.text, 'stable')).toEqual([]);
    expect(store.text.split('\n', 1)[0]).toBe('/*! BURROW_CHANNEL=stable */');
  });

  it('refuses a hook and ignores a stored override row and an env pin', async () => {
    expect(store.mod.installLicenseDevHook(FAKE_HOOK)).toBeNull();
    if (HAS_DEVTOOLS) await storeOverride('pro_founding');
    startBundled(store.mod, { env: { BURROW_DEV_TIER: 'pro_founding', BURROW_CHANNEL: 'dev' } });
    expect(store.mod.getEntitlements().pro).toBe(false);
  });

  it('the whole server.js and worker bundles (as the sidecar builds a Store build) have no developer tools', async () => {
    const workerSource = await buildBackupWorkerSource({ minify: true, channel: 'stable', version: '0.1.0', distribution: 'store', dataLocation: 'userprofile' });
    expect(checkBundleText(workerSource, 'stable')).toEqual([]);
    const text = await bundleServer('stable', { distribution: 'store', dataLocation: 'userprofile' });
    expect(text).toContain(STORE_DISTRIBUTION_MARKER);
    expect(text).not.toContain(DEV_TOOLS_MARKER);
    expect(text).not.toContain(DEV_TOOLS_ROUTE_MARKER);
    expect(text).not.toContain(EXTENSION_NAME);
    expect(checkBundleText(text, 'stable')).toEqual([]);
  }, 60_000);
});

describe.skipIf(!HAS_DEVTOOLS)('a dev bundle', () => {
  it('the license module accepts a hook and hands back its access facade', () => {
    const access = dev.mod.installLicenseDevHook(FAKE_HOOK);
    expect(access).not.toBeNull();
    expect(Object.keys(access)).toEqual(expect.arrayContaining(['context', 'status', 'realStatus', 'records', 'override', 'observeClock', 'reconcileTrial', 'setRealTrialNotices', 'forgetTrial', 'reloadTrial', 'fail']));
    startBundled(dev.mod);
    expect(dev.mod.getLicenseStatus()).toMatchObject({ state: 'free', pro: false });
    expect(dev.mod.installLicenseDevHook(null)).toBeNull();
  });

  it('the whole server.js bundle carries the marker and the route and passes the dev check', async () => {
    serverText.dev = await bundleServer('dev');
    expect(serverText.dev).toContain(DEV_TOOLS_MARKER);
    expect(serverText.dev).toContain(DEV_TOOLS_ROUTE_MARKER);
    expect(serverText.dev).toContain(EXTENSION_NAME);
    expect(checkBundleText(serverText.dev, 'dev')).toEqual([]);
    expect(checkBundleText(serverText.dev, 'stable').join(' ')).toMatch(/developer tools/);
  }, 60_000);
});

describe('define table', () => {
  it('bakes __BURROW_DEV_TOOLS__ false for stable and true for dev', () => {
    expect(bundleDefine('0.1.0').__BURROW_DEV_TOOLS__).toBe('false');
    expect(bundleDefine('0.1.0', { channel: 'stable' }).__BURROW_DEV_TOOLS__).toBe('false');
    expect(bundleDefine(DISPLAY, { channel: 'dev' }).__BURROW_DEV_TOOLS__).toBe('true');
  });
});

describe('module boundaries', () => {
  const CORE_DIRS = ['server', 'src'];
  const coreFiles = () => [...CORE_DIRS.flatMap((d) => walkFiles(path.join(ROOT, d), /\.(js|jsx|mjs|cjs)$/)), path.join(ROOT, 'server.js')];
  const DEVTOOLS_IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"][^'"]*devtools[\\/]/;
  const IMPORT_SPEC = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;

  it('core never imports devtools/, except the one loader file', () => {
    const offenders = coreFiles().filter((f) => DEVTOOLS_IMPORT.test(read(f))).map(rel);
    expect(offenders).toEqual(['server/devExtensionsLoader.js']);
  });

  it('the core names the developer folder only in the loader and in the two data-hygiene key lists', () => {
    const files = coreFiles().filter((f) => /devtools\//.test(read(f))).map(rel);
    expect(files.sort()).toEqual(['server/dataBrowser/redact.js', 'server/devExtensionsLoader.js', 'server/import/importExport.js']);
  });

  it.skipIf(!HAS_DEVTOOLS)('devtools imports only the allowed core modules', () => {
    const allowed = new Set([
      'server/license/index.js',
      'server/license/constants.js',
      'server/license/trialStore.js',
      'server/license/store.js',
      'server/license/channelSeam.js',
      'server/license/messages.js',
      'server/secrets/keyFile.js',
      'server/channel.js',
      'server/runtime.js',
    ]);
    const files = walkFiles(path.join(ROOT, 'devtools'), /\.(js|jsx)$/);
    expect(files.length).toBeGreaterThan(5);
    const violations = [];
    for (const file of files) {
      for (const m of read(file).matchAll(IMPORT_SPEC)) {
        if (!m[1].startsWith('.')) continue;
        const target = rel(path.resolve(path.dirname(file), m[1]));
        if (target.startsWith('server/') && !allowed.has(target) && !target.startsWith('server/db/')) violations.push(`${rel(file)} -> ${target}`);
        if (rel(file).startsWith('devtools/ui/') && target.startsWith('server/')) violations.push(`${rel(file)} -> ${target}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('the client never imports the server or the developer routes', () => {
    const offenders = walkFiles(path.join(ROOT, 'src'), /\.(js|jsx)$/)
      .filter((f) => /(?:from\s+|import\s*\(\s*)['"][^'"]*(?:\/server\/|devOverride|devLicense)/.test(read(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('server.js mounts the extension router after the license routes and before the /api 404, and loads extensions before listening', () => {
    const text = read(path.join(ROOT, 'server.js'));
    const license = text.indexOf('registerLicenseRoutes(app)');
    const mount = text.indexOf('app.use(devExtensionRouter())');
    const notFound = text.indexOf("app.use('/api', (req, res) => res.status(404)");
    expect(license).toBeGreaterThan(-1);
    expect(mount).toBeGreaterThan(license);
    expect(notFound).toBeGreaterThan(mount);
    const load = text.indexOf('await loadDevExtensions()');
    expect(load).toBeGreaterThan(-1);
    expect(load).toBeLessThan(text.indexOf('app.listen(listenConfig.port'));
  });

  it('the override row is protected from import and hidden from the state API and data browser (literal key, reserved by devtools/)', () => {
    expect(PROTECTED_APP_STATE_KEYS.has('dev.licenseOverride')).toBe(true);
    expect(HIDDEN_APP_STATE_KEYS.has('dev.licenseOverride')).toBe(true);
  });

  it('the test setup clears the env pin so a developer shell cannot leak into tests', () => {
    expect(process.env.BURROW_DEV_TIER).toBeUndefined();
    expect(process.env.BURROW_DEV_TRIAL_DAYS).toBeUndefined();
    const setup = read(path.join(ROOT, 'server', '__tests__', 'setup', 'dataDir.js'));
    expect(setup).toContain("'BURROW_DEV_TIER'");
    expect(setup).toContain("'BURROW_DEV_TRIAL_DAYS'");
  });

  it('the loader trio exists and only the stable stub is a null loader', () => {
    for (const name of ['devExtensionsLoader.js', 'devExtensionsLoader.none.js']) expect(fs.existsSync(path.join(ROOT, 'server', name))).toBe(true);
    expect(read(path.join(ROOT, 'server', 'devExtensionsLoader.none.js'))).toMatch(/return null/);
  });

  it.skipIf(!HAS_DEVTOOLS)('the static extension the dev loader resolves to exists', () => {
    expect(fs.existsSync(path.join(ROOT, 'devtools', 'server', 'static.js'))).toBe(true);
  });
});

describe('no em dashes in the shipped switcher copy', () => {
  it.each(['devtools/server/license/devOverride.js', 'devtools/server/license/devLicense.js', 'devtools/server/devLicenseRoutes.js', 'devtools/ui/DeveloperSection.jsx', 'server/devExtensions.js'].filter(hasPrivateFile))('%s', (file) => {
    expect(read(path.join(ROOT, file))).not.toMatch(/—/);
  });
});
