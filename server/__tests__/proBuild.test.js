// ci:always-run
// Build seams of the Pro module (docs/adr/0001-open-core-split.md 3.10): the `burrow-pro` esbuild plugin, the define
// and banner, the channelMarker --expect-pro checks, the `burrow-pro-ui` Vite plugin and check:pro-present. Fixture
// roots only, plus one real esbuild bundle of server.js built as if pro/ were absent.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { PRO_MARKER_OFF, PRO_MARKER_ON, bundleDefine, proBanner, proPlugin, resolveProBuild } from '../../scripts/desktop/workerBundle.js';
import { PRO_OFF_MARKER, PRO_ON_MARKER, checkDistPro, checkProMarker, main as channelMain } from '../../scripts/checks/channelMarker.js';
import { PRO_CHUNK_RE, proUiEnabled, proUiPlugin } from '../../scripts/build/proUi.js';
import { PRO_MISSING_MESSAGE, PRO_REQUIRED_FILES, assertProPresent, checkProPresent, main as proPresentMain } from '../../scripts/checks/proPresent.js';
import { PRO_HEADER } from '../../scripts/build/proBoundary.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let tmp;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-probuild-'));
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const write = (root, rel, text) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};

/** A fixture repo: an entry that imports the loader, the loader trio, and optionally pro/server. */
function fixture(name, { pro = false, proIndex = `${PRO_HEADER}\nexport default { name: 'PRO_SENTINEL_TEXT' };\n` } = {}) {
  const root = path.join(tmp, name);
  write(root, 'entry.js', "import { importProExtension } from './server/proExtensionsLoader.js';\nexport default importProExtension;\n");
  write(root, 'server/proExtensionsLoader.js', "export async function importProExtension() { return (await import('../pro/server/index.js')).default; }\n");
  write(root, 'server/proExtensionsLoader.none.js', "export async function importProExtension() { return 'NONE_SENTINEL_TEXT'; }\n");
  write(root, 'server/dataAccess.js', 'export const getState = () => null;\n');
  write(root, 'server/db/index.js', 'export const getDb = () => null;\n');
  if (pro) {
    write(root, 'pro/server/static.js', `${PRO_HEADER}\nimport ext from './index.js';\nexport async function importProExtension() { return ext; }\n`);
    write(root, 'pro/server/index.js', proIndex);
  }
  return root;
}

const bundleFixture = async (root, opts) =>
  (
    await build({
      entryPoints: [path.join(root, 'entry.js')],
      write: false,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
      plugins: [proPlugin({ root, ...opts })],
    })
  ).outputFiles[0].text;

describe('proPlugin (burrow-pro)', () => {
  it('resolves the loader to the null stub without pro/ and to pro/server/static.js with it', async () => {
    const free = await bundleFixture(fixture('free'));
    expect(free).toContain('NONE_SENTINEL_TEXT');
    expect(free).not.toContain('PRO_SENTINEL_TEXT');
    const pro = await bundleFixture(fixture('pro', { pro: true }));
    expect(pro).toContain('PRO_SENTINEL_TEXT');
    expect(pro).not.toContain('NONE_SENTINEL_TEXT');
  });

  it('requirePro refuses a build without pro/', async () => {
    await expect(bundleFixture(fixture('req'), { requirePro: true })).rejects.toThrow(/needs the Pro module but pro\/server\/static\.js is missing/);
    expect(() => resolveProBuild({ root: path.join(tmp, 'req'), requirePro: true })).toThrow(/official build/);
    expect(resolveProBuild({ root: path.join(tmp, 'req') })).toBe(false);
  });

  it.each([
    ['a Node built-in', "import fs from 'node:fs';"],
    ['an npm package', "import express from 'express';"],
    ['a non-allowlisted core module', "import { getDb } from '../../server/db/index.js';"],
  ])('fails the bundle when pro/server imports %s', async (_label, line) => {
    const root = fixture(`bad-${_label.replace(/\W+/g, '-')}`, { pro: true, proIndex: `${PRO_HEADER}\n${line}\nexport default {};\n` });
    await expect(bundleFixture(root)).rejects.toThrow();
  });

  it('allows a Tier A import from pro/server', async () => {
    const root = fixture('tier-a', { pro: true, proIndex: `${PRO_HEADER}\nimport * as d from '../../server/dataAccess.js';\nexport default { d, name: 'PRO_SENTINEL_TEXT' };\n` });
    expect(await bundleFixture(root)).toContain('PRO_SENTINEL_TEXT');
  });

  it('fails a Pro source file without the private header', async () => {
    const root = fixture('no-header', { pro: true, proIndex: "export default { name: 'x' };\n" });
    await expect(bundleFixture(root)).rejects.toThrow();
  });

  it('fails when anything under pro/ is loaded in a build without the Pro module', async () => {
    const root = fixture('stray', { pro: true });
    write(root, 'entry.js', "import x from './pro/server/index.js';\nexport default x;\n");
    await expect(bundleFixture(root, { exists: () => false })).rejects.toThrow();
  });
});

describe('define and banner', () => {
  it('bakes __BURROW_PRO__ and writes the marker line', () => {
    expect(bundleDefine('1.0.0').__BURROW_PRO__).toBe('false');
    expect(bundleDefine('1.0.0', { pro: true }).__BURROW_PRO__).toBe('true');
    expect(proBanner(true)).toBe(`${PRO_MARKER_ON}\n`);
    expect(proBanner(false)).toBe(`${PRO_MARKER_OFF}\n`);
    expect(PRO_MARKER_ON).toBe(PRO_ON_MARKER);
    expect(PRO_MARKER_OFF).toBe(PRO_OFF_MARKER);
  });
});

describe('a real bundle of server.js without pro/', () => {
  let text;
  beforeAll(async () => {
    const result = await build({
      entryPoints: [path.join(ROOT, 'server.js')],
      write: false,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      logLevel: 'silent',
      define: { ...bundleDefine('1.0.0'), __BURROW_BACKUP_WORKER_SRC__: '""', __BURROW_PARSER_WORKER_SRC__: '""' },
      plugins: [proPlugin({ exists: () => false })],
      banner: { js: `/*! BURROW_CHANNEL=stable */\n${proBanner(false)}` },
      external: ['node:sqlite'],
    });
    text = result.outputFiles[0].text;
  }, 120_000);

  it('is marked BURROW_PRO=off on line 2 and has no Pro handler code', () => {
    expect(text.split('\n')[1]).toBe(PRO_MARKER_OFF);
    expect(checkProMarker(text, 'absent')).toEqual([]);
    expect(checkProMarker(text, 'present')).not.toEqual([]);
    for (const token of ['installJarvisRoutes', 'installInsightsRoutes', 'installFolderRoutes', 'runIndexPhase', 'runFolderReport', 'PRO_CHARACTER_TEXTS', 'jarvisSystemPrompt']) {
      expect(text, token).not.toContain(token);
    }
    expect(text).toContain('pro_not_included');
  });
});

describe('channelMarker --expect-pro', () => {
  it('checks the bundle marker', () => {
    expect(checkProMarker(`/*! BURROW_CHANNEL=stable */\n${PRO_ON_MARKER}\n`, 'present')).toEqual([]);
    expect(checkProMarker(`${PRO_OFF_MARKER}`, 'present')[0]).toMatch(/does not include the Pro module/);
    expect(checkProMarker(`${PRO_ON_MARKER}${PRO_OFF_MARKER}`, 'present')[0]).toMatch(/mixes/);
    expect(checkProMarker(`${PRO_ON_MARKER}`, 'absent')[0]).toMatch(/includes the Pro module/);
    expect(checkProMarker('nothing', 'absent')[0]).toMatch(/no BURROW_PRO=off/);
    expect(checkProMarker(Buffer.from(`xx${PRO_OFF_MARKER}xx`), 'absent')).toEqual([]);
  });

  it('checks the Pro chunks of a dist folder and the CLI flag', () => {
    const dist = path.join(tmp, 'dist-pro');
    write(dist, 'assets/index-abc.js', 'x');
    write(dist, 'burrow-build-info.json', JSON.stringify({ formatVersion: 1, version: '1.0.0', channel: 'stable' }));
    expect(checkDistPro(dist, 'absent')).toEqual([]);
    expect(checkDistPro(dist, 'present')[0]).toMatch(/no Pro chunks/);
    const io = { log: () => {}, error: () => {} };
    expect(channelMain(['--expect', 'stable', '--expect-pro', 'absent', '--dist-dir', dist], io)).toBe(0);
    expect(channelMain(['--expect', 'stable', '--expect-pro', 'present', '--dist-dir', dist], io)).toBe(1);
    write(dist, 'assets/pro-abc.js', 'x');
    write(dist, 'assets/pro-FolderAskPanel-abc.js', 'x');
    expect(checkDistPro(dist, 'present')).toEqual([]);
    expect(checkDistPro(dist, 'absent')[0]).toMatch(/carries Pro chunks/);
    expect(channelMain(['--expect', 'stable', '--expect-pro', 'present', '--dist-dir', dist], io)).toBe(0);
    expect(channelMain(['--expect', 'stable', '--expect-pro', 'maybe', '--dist-dir', dist], io)).toBe(1);
  });
});

describe('burrow-pro-ui (Vite)', () => {
  it('proUiEnabled follows pro/ui/proExtensions.js and BURROW_REQUIRE_PRO', () => {
    expect(proUiEnabled({ env: {}, exists: () => true, root: '/r' })).toBe(true);
    expect(proUiEnabled({ env: {}, exists: () => false, root: '/r' })).toBe(false);
    expect(() => proUiEnabled({ env: { BURROW_REQUIRE_PRO: '1' }, exists: () => false, root: '/r' })).toThrow(/official build needs the Pro module/);
    expect(proUiEnabled({ env: { BURROW_REQUIRE_PRO: '1' }, exists: () => true, root: '/r' })).toBe(true);
  });

  const root = path.resolve('/repo');
  const core = path.join(root, 'src', 'extensions', 'proExtensions.js');
  const ctx = (resolvedId) => ({ resolve: async () => (resolvedId ? { id: resolvedId } : null), error: (m) => { throw new Error(m); } });

  it('swaps exactly the core extension module for the Pro one (case-insensitive on win32)', async () => {
    const plugin = proUiPlugin(true, { root, platform: 'win32' });
    expect(plugin.name).toBe('burrow-pro-ui');
    expect(plugin.enforce).toBe('pre');
    const swapped = await plugin.resolveId.call(ctx(core.toUpperCase()), '../extensions/proExtensions.js', path.join(root, 'src', 'hooks', 'x.js'), {});
    expect(swapped.id).toBe(path.join(root, 'pro', 'ui', 'proExtensions.js').replace(/\\/g, '/'));
    expect(await plugin.resolveId.call(ctx(path.join(root, 'src', 'other', 'proExtensions.js')), './proExtensions.js', path.join(root, 'src', 'other', 'a.js'), {})).toBeNull();
    expect(await plugin.resolveId.call(ctx(core), './x.js', path.join(root, 'src', 'a.js'), {})).toBeNull();
    expect(await proUiPlugin(false, { root }).resolveId.call(ctx(core), '../extensions/proExtensions.js', path.join(root, 'src', 'a.js'), {})).toBeNull();
  });

  it('refuses to load anything under pro/ when the Pro UI is not included', () => {
    expect(() => proUiPlugin(false, { root }).load(path.join(root, 'pro', 'ui', 'proExtensions.js'))).toThrow(/pro\/ must not enter this build/);
    expect(proUiPlugin(false, { root }).load(path.join(root, 'src', 'main.jsx'))).toBeNull();
    expect(proUiPlugin(true, { root }).load(path.join(root, 'pro', 'ui', 'proExtensions.js'))).toBeNull();
  });

  it('fails a build where a pro/ui module lands in a chunk not named assets/pro-*', () => {
    const plugin = proUiPlugin(true, { root, platform: 'linux' });
    const proId = path.join(root, 'pro', 'ui', 'hooks', 'useJarvis.js').replace(/\\/g, '/');
    const ok = { 'assets/pro-abc.js': { type: 'chunk', fileName: 'assets/pro-abc.js', moduleIds: [proId] }, 'assets/index.js': { type: 'chunk', fileName: 'assets/index.js', moduleIds: ['/repo/src/main.jsx'] } };
    expect(() => plugin.generateBundle.call(ctx(null), {}, ok)).not.toThrow();
    const bad = { 'assets/shared-abc.js': { type: 'chunk', fileName: 'assets/shared-abc.js', moduleIds: [proId] } };
    expect(() => plugin.generateBundle.call(ctx(null), {}, bad)).toThrow(/landed in the core chunk assets\/shared-abc\.js/);
    expect(PRO_CHUNK_RE.test('assets/pro-FolderAskPanel-x1.js')).toBe(true);
  });

  it('vite.config.js wires the plugin and the pro group', () => {
    const cfg = fs.readFileSync(path.join(ROOT, 'vite.config.js'), 'utf8');
    expect(cfg).toContain('proUiPlugin(proUiEnabled())');
    expect(cfg).toContain("{ name: 'pro', test: /\\/pro\\/ui\\/(?!lazy\\/)/, priority: 4, includeDependenciesRecursively: false }");
  });
});

describe('check:pro-present', () => {
  it('passes with every required file and fails with a fixed message otherwise', () => {
    const full = path.join(tmp, 'present');
    for (const rel of PRO_REQUIRED_FILES) write(full, rel, 'x');
    expect(checkProPresent({ root: full })).toEqual([]);
    expect(() => assertProPresent({ root: full })).not.toThrow();
    const empty = path.join(tmp, 'absent');
    fs.mkdirSync(empty, { recursive: true });
    expect(checkProPresent({ root: empty })[0]).toMatch(/missing pro\/server\/index\.js/);
    expect(() => assertProPresent({ root: empty })).toThrow(PRO_MISSING_MESSAGE);
    const io = { log: () => {}, error: () => {} };
    expect(proPresentMain([], { ...io, root: full })).toBe(0);
    expect(proPresentMain([], { ...io, root: empty })).toBe(1);
  });

  it('with --dist-dir needs Pro chunks and with --bundle the BURROW_PRO=on banner', () => {
    const full = path.join(tmp, 'present');
    const dist = path.join(tmp, 'pp-dist');
    write(dist, 'assets/index.js', 'x');
    expect(checkProPresent({ root: full, distDir: dist })[0]).toMatch(/no Pro chunks/);
    write(dist, 'assets/pro-x.js', 'x');
    expect(checkProPresent({ root: full, distDir: dist })).toEqual([]);
    const bundle = write(tmp, 'b.cjs', `/*! BURROW_CHANNEL=stable */\n${PRO_OFF_MARKER}\n`);
    expect(checkProPresent({ root: full, bundle })[0]).toMatch(/BURROW_PRO=on/);
    fs.writeFileSync(bundle, `/*! BURROW_CHANNEL=stable */\n${PRO_ON_MARKER}\n`);
    expect(checkProPresent({ root: full, bundle })).toEqual([]);
  });
});
