// scripts/build/devToolsUi.js: which Vite runs include the developer tools UI, and the plugin that swaps the core's
// empty Settings extension list for devtools/ui/settingsExtensions.js (or forbids loading devtools/ at all).
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { devToolsUiEnabled, devToolsUiPlugin } from '../../scripts/build/devToolsUi.js';

const ROOT = path.resolve('/virtual/burrow');
const CORE = path.join(ROOT, 'src', 'extensions', 'settingsExtensions.js');
const DEV = path.join(ROOT, 'devtools', 'ui', 'settingsExtensions.js');
const toPosix = (p) => p.split(path.sep).join('/');

const enabled = (command, mode, env, present) => devToolsUiEnabled({ command, mode, env, exists: () => present, root: ROOT });

describe('devToolsUiEnabled', () => {
  it.each([
    // command, mode, env, devtools present, expected
    ['serve', 'development', {}, true, true],
    ['serve', 'development', {}, false, false],
    ['build', 'production', {}, true, false],
    ['build', 'production', {}, false, false],
    ['build', 'production', { BURROW_CHANNEL: 'stable' }, true, false],
    ['build', 'production', { BURROW_CHANNEL: '' }, true, false],
    ['build', 'devtools', {}, true, true],
    ['build', 'production', { BURROW_CHANNEL: 'dev' }, true, true],
    ['serve', 'development', { BURROW_CHANNEL: 'dev' }, true, true],
  ])('%s / %s / %j / present=%s -> %s', (command, mode, env, present, expected) => {
    expect(enabled(command, mode, env, present)).toBe(expected);
  });

  it('fails loud when the mode or the dev channel asks for the tools and devtools/ is missing', () => {
    expect(() => enabled('build', 'devtools', {}, false)).toThrow(/settingsExtensions\.js is missing/);
    expect(() => enabled('build', 'production', { BURROW_CHANNEL: 'dev' }, false)).toThrow(/missing/);
    expect(() => enabled('serve', 'devtools', {}, false)).toThrow(/missing/);
  });

  it('an unknown channel fails a build and is ignored by the dev server', () => {
    expect(() => enabled('build', 'production', { BURROW_CHANNEL: 'beta' }, true)).toThrow(/BURROW_CHANNEL/);
    expect(enabled('serve', 'development', { BURROW_CHANNEL: 'beta' }, true)).toBe(true);
    expect(enabled('serve', 'development', { BURROW_CHANNEL: 'beta' }, false)).toBe(false);
  });
});

describe('devToolsUiPlugin', () => {
  /** Calls resolveId the way Vite does; `resolved` is what the next resolvers would answer for the source. */
  const resolveWith = async (plugin, source, resolved) => {
    const ctx = { resolve: async () => (resolved === null ? null : { id: toPosix(resolved) }) };
    return plugin.resolveId.call(ctx, source, '/virtual/burrow/src/pages/Settings.jsx', {});
  };

  it('is a pre plugin with a name', () => {
    const plugin = devToolsUiPlugin(true, { root: ROOT, platform: 'linux' });
    expect(plugin.name).toBe('burrow-dev-tools-ui');
    expect(plugin.enforce).toBe('pre');
  });

  it('swaps exactly the core extension list when included', async () => {
    const plugin = devToolsUiPlugin(true, { root: ROOT, platform: 'linux' });
    expect(await resolveWith(plugin, '../extensions/settingsExtensions', CORE)).toEqual({ id: toPosix(DEV) });
    expect(await resolveWith(plugin, './settingsExtensions', DEV)).toBeNull();
    expect(await resolveWith(plugin, '../other/settingsExtensions', path.join(ROOT, 'src', 'other', 'settingsExtensions.js'))).toBeNull();
    expect(await resolveWith(plugin, '../extensions/settingsExtensions', null)).toBeNull();
    expect(await resolveWith(plugin, 'react', path.join(ROOT, 'node_modules', 'react', 'index.js'))).toBeNull();
  });

  it('matches the core path case-insensitively on Windows only', async () => {
    const upper = CORE.toUpperCase();
    const win = devToolsUiPlugin(true, { root: ROOT, platform: 'win32' });
    expect(await resolveWith(win, '../extensions/settingsExtensions', upper)).toEqual({ id: toPosix(DEV) });
    const linux = devToolsUiPlugin(true, { root: ROOT, platform: 'linux' });
    expect(await resolveWith(linux, '../extensions/settingsExtensions', upper)).toBeNull();
  });

  it('swaps nothing and loads nothing under devtools/ when excluded', async () => {
    const plugin = devToolsUiPlugin(false, { root: ROOT, platform: 'linux' });
    expect(await resolveWith(plugin, '../extensions/settingsExtensions', CORE)).toBeNull();
    expect(() => plugin.load(toPosix(path.join(ROOT, 'devtools', 'ui', 'DeveloperSection.jsx')))).toThrow(/devtools\/ must not enter this build/);
    expect(() => plugin.load(`${toPosix(DEV)}?v=1`)).toThrow(/must not enter/);
    expect(plugin.load(toPosix(path.join(ROOT, 'src', 'pages', 'Settings.jsx')))).toBeNull();
    expect(plugin.load(toPosix(path.join(ROOT, 'node_modules', 'foo', 'devtools', 'index.js')))).toBeNull();
  });

  it('lets devtools/ load when included', () => {
    const plugin = devToolsUiPlugin(true, { root: ROOT, platform: 'linux' });
    expect(plugin.load(toPosix(DEV))).toBeNull();
  });
});
