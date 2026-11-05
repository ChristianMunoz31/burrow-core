// ci:always-run
// The developer tools must not exist in the core or in a stable build. This file proves it at the source level
// (marker holders, import boundaries between core and devtools/) and at the bundle level (real esbuild bundles of
// server.js with the same defines, plugin, minify and banner the sidecar bundler uses): no marker text, no route
// path and no devtools source in a stable or Store bundle. It reads the source tree, so it carries the always-run
// marker above.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const DISPLAY = '0.2.0-dev.20261005.abc1234';
const EXTENSION_NAME = 'developer-tools';
// devtools/ is private-only (not in the public core export). The tests that need its code are skipped without it;
// the stable-bundle, Store-bundle and module-boundary guards still run in the core, where devtools/ must not exist.
const HAS_DEVTOOLS = hasPrivateFile('devtools/server/static.js') && hasPrivateFile('devtools/server/devStatusRoute.js');
const DEVTOOLS_SERVER_INDEX = path.join(ROOT, 'devtools', 'server', 'index.js');

let tmp;
const serverText = {};

const toPosix = (file) => file.split(path.sep).join('/');
const rel = (file) => toPosix(path.relative(ROOT, file));

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

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-devtools-'));
});

afterAll(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

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
  it.skipIf(!HAS_DEVTOOLS)('BURROW_DEV_TOOLS=on lives only in devtools/ (server and UI) and the checker, nowhere else in shipped source', () => {
    expect(DEV_TOOLS_MARKER).toBe('BURROW_DEV_TOOLS=on');
    const files = [...['server', 'src', 'scripts', 'devtools'].flatMap((d) => walkFiles(path.join(ROOT, d))), ...rootFiles()];
    const holders = files.filter((f) => read(f).includes(DEV_TOOLS_MARKER)).map(rel);
    expect(holders).toContain('scripts/checks/channelMarker.js');
    expect(holders).toContain('devtools/server/index.js');
    expect(holders.filter((h) => h !== 'scripts/checks/channelMarker.js' && !h.startsWith('devtools/'))).toEqual([]);
  });

  it('the developer routes path is nowhere in the core: server/, src/ and server.js, comments included', () => {
    expect(DEV_TOOLS_ROUTE_MARKER).toBe('/dev/status');
    const files = [...['server', 'src'].flatMap((d) => walkFiles(path.join(ROOT, d), /\.(js|jsx|mjs|cjs)$/)), path.join(ROOT, 'server.js')];
    expect(files.filter((f) => read(f).includes(DEV_TOOLS_ROUTE_MARKER)).map(rel)).toEqual([]);
  });

  it.skipIf(!HAS_DEVTOOLS)('the real extension writes the marker in a runtime-live log line, which survives minify', async () => {
    const { default: ext } = await import(/* @vite-ignore */ pathToFileURL(DEVTOOLS_SERVER_INDEX).href);
    const lines = [];
    ext.install({ get() {} }, { env: {}, log: (m) => lines.push(m) });
    expect(lines).toEqual([`developer tools on (${DEV_TOOLS_MARKER})`]);
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
  it('the whole server.js bundle (as the sidecar builds it) has no marker, route or devtools source, and passes the channel check', async () => {
    serverText.stable = await bundleServer('stable');
    const text = serverText.stable;
    expect(text).not.toContain(DEV_TOOLS_MARKER);
    expect(text).not.toContain('BURROW_DEV_TOOLS');
    expect(text).not.toContain(DEV_TOOLS_ROUTE_MARKER);
    expect(text).not.toContain(EXTENSION_NAME);
    expect(checkBundleText(text, 'stable')).toEqual([]);
    expect(text.split('\n', 1)[0]).toBe('/*! BURROW_CHANNEL=stable */');
    // Open core: a bundle built without the private module carries BURROW_PRO=off on line 2 (docs/adr/0001-open-core-split.md 3.10).
    expect(text.split('\n')[1]).toBe('/*! BURROW_PRO=off */');
    // Burrow is free for everyone: the bundle has no license route and no store host.
    expect(text).not.toContain('/api/license');
    expect(text).not.toContain('api.gumroad.com');
    expect(text).not.toContain('api.lemonsqueezy.com');
  }, 60_000);

  it('a stable worker bundle has no marker either', async () => {
    const text = await buildBackupWorkerSource({ minify: true, channel: 'stable', version: '0.1.0' });
    expect(checkBundleText(text, 'stable')).toEqual([]);
  });

  it('the stable check refuses both developer markers', () => {
    expect(checkBundleText(`${channelBanner('stable')}x("${DEV_TOOLS_MARKER}")`, 'stable').join(' ')).toMatch(/developer tools/);
    expect(checkBundleText(`${channelBanner('stable')}x("${DEV_TOOLS_ROUTE_MARKER}")`, 'stable').join(' ')).toMatch(/developer tools/);
  });
});

describe('a Microsoft Store bundle (stable channel, store distribution, userprofile data location)', () => {
  it('the whole server.js and worker bundles (as the sidecar builds a Store build) have the store markers and no developer tools', async () => {
    const workerSource = await buildBackupWorkerSource({ minify: true, channel: 'stable', version: '0.1.0', distribution: 'store', dataLocation: 'userprofile' });
    expect(checkBundleText(workerSource, 'stable')).toEqual([]);
    const text = await bundleServer('stable', { distribution: 'store', dataLocation: 'userprofile' });
    expect(text).toContain(STORE_DISTRIBUTION_MARKER);
    expect(text).toContain(USERPROFILE_DATA_LOCATION_MARKER);
    expect(text).not.toContain(DEV_TOOLS_MARKER);
    expect(text).not.toContain('BURROW_DEV_TOOLS');
    expect(text).not.toContain(DEV_TOOLS_ROUTE_MARKER);
    expect(text).not.toContain(EXTENSION_NAME);
    expect(checkBundleText(text, 'stable')).toEqual([]);
    expect(text.split('\n', 1)[0]).toBe('/*! BURROW_CHANNEL=stable */');
  }, 60_000);
});

describe.skipIf(!HAS_DEVTOOLS)('a dev bundle', () => {
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
    const allowed = new Set(['server/license/channelSeam.js', 'server/channel.js']);
    const files = walkFiles(path.join(ROOT, 'devtools'), /\.(js|jsx)$/);
    expect(files.length).toBeGreaterThan(3);
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
      .filter((f) => /(?:from\s+|import\s*\(\s*)['"][^'"]*(?:\/server\/|devStatusRoute)/.test(read(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('server.js mounts the extension router after the update routes and before the /api 404, and loads extensions before listening', () => {
    const text = read(path.join(ROOT, 'server.js'));
    const before = text.indexOf('registerAiSettingsRoutes(app)');
    const mount = text.indexOf('app.use(devExtensionRouter())');
    const notFound = text.indexOf("app.use('/api', (req, res) => res.status(404)");
    expect(before).toBeGreaterThan(-1);
    expect(mount).toBeGreaterThan(before);
    expect(notFound).toBeGreaterThan(mount);
    const load = text.indexOf('await loadDevExtensions()');
    expect(load).toBeGreaterThan(-1);
    expect(load).toBeLessThan(text.indexOf('app.listen(listenConfig.port'));
  });

  it('the override row is protected from import and hidden from the state API and data browser (literal key, reserved by devtools/)', () => {
    expect(PROTECTED_APP_STATE_KEYS.has('dev.licenseOverride')).toBe(true);
    expect(HIDDEN_APP_STATE_KEYS.has('dev.licenseOverride')).toBe(true);
  });

  it('the loader trio exists and only the stable stub is a null loader', () => {
    for (const name of ['devExtensionsLoader.js', 'devExtensionsLoader.none.js']) expect(fs.existsSync(path.join(ROOT, 'server', name))).toBe(true);
    expect(read(path.join(ROOT, 'server', 'devExtensionsLoader.none.js'))).toMatch(/return null/);
  });

  it.skipIf(!HAS_DEVTOOLS)('the static extension the dev loader resolves to exists', () => {
    expect(fs.existsSync(path.join(ROOT, 'devtools', 'server', 'static.js'))).toBe(true);
  });
});

describe('no em dashes in the shipped developer tools copy', () => {
  it.each(['devtools/server/index.js', 'devtools/server/devStatusRoute.js', 'devtools/ui/DeveloperSection.jsx', 'server/devExtensions.js'].filter(hasPrivateFile))('%s', (file) => {
    expect(read(path.join(ROOT, file))).not.toMatch(/—/);
  });
});
