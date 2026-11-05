// The developer tools (Settings > Developer, the license tier switcher) never reach a stable build, and
// `npm run desktop:dev` runs the normal UI unless `-- --devtools` is given (scripts/desktop/devDist.js).
// The bundle-level refusals themselves are tested in devToolsUi, devToolsBuild, channelMarkerDevTools and
// disableDevTools; this file ties each stable build path to them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { devToolsUiEnabled } from '../../scripts/build/devToolsUi.js';
import {
  DEV_STAMP_FILE,
  buildScriptFor,
  decideDistRebuild,
  parseDevArgs,
  readDevStamp,
  readGitState,
  skipDevStamp,
  writeDevStamp,
} from '../../scripts/desktop/devDist.js';
import { SETTINGS_EXTENSIONS } from '../../src/extensions/settingsExtensions.js';
import { hasPrivateFile } from './helpers/privateFiles.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8');
const COMMIT = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('stable build paths exclude the developer tools', () => {
  it('the core Settings extension list is empty', () => {
    expect(SETTINGS_EXTENSIONS).toEqual([]);
    expect(Object.isFrozen(SETTINGS_EXTENSIONS)).toBe(true);
  });

  it('npm run build is a plain vite build; only build:devtools asks for the tools', () => {
    const scripts = JSON.parse(read('package.json')).scripts;
    expect(scripts.build).toBe('vite build');
    expect(scripts['build:devtools']).toBe('vite build --mode devtools');
  });

  it('the real Vite config, as npm run build runs it, keeps the empty extension list and refuses devtools/', async () => {
    vi.stubEnv('BURROW_CHANNEL', '');
    const { default: config } = await import('../../vite.config.js');
    const resolved = config({ command: 'build', mode: 'production' });
    const plugin = resolved.plugins.find((p) => p && p.name === 'burrow-dev-tools-ui');
    expect(plugin).toBeTruthy();
    const core = path.join(ROOT, 'src', 'extensions', 'settingsExtensions.js');
    const ctx = { resolve: async () => ({ id: core }) };
    expect(await plugin.resolveId.call(ctx, '../extensions/settingsExtensions', path.join(ROOT, 'src', 'pages', 'Settings.jsx'), {})).toBeNull();
    expect(() => plugin.load(path.join(ROOT, 'devtools', 'ui', 'settingsExtensions.js'))).toThrow(/must not enter this build/);
  });

  it.each([
    ['npm run build', {}],
    ['desktop:build (stable)', { BURROW_CHANNEL: 'stable' }],
    ['release:store', { BURROW_DISTRIBUTION: 'store', BURROW_DATA_LOCATION: 'userprofile' }],
  ])('%s leaves the tools out even when devtools/ exists', (_name, env) => {
    expect(devToolsUiEnabled({ command: 'build', mode: 'production', env, exists: () => true, root: ROOT })).toBe(false);
  });

  it('every stable packaging path runs a devtools refusal', () => {
    // CI: the stable dist is checked after npm run build.
    expect(read('.github/workflows/ci.yml')).toMatch(/channelMarker\.js --expect stable --dist-dir dist/);
    // desktop:build builds the plain UI; the sidecar copy refuses a dist with the tools on the stable channel.
    expect(read('scripts/desktop/build.js')).toMatch(/'run', 'build'\]/);
    expect(read('scripts/desktop/buildSidecar.js')).toMatch(/checkDistDevTools\(distDir, channelBuild\.channel === 'dev' \? 'present' : 'absent'\)/);
    // Store build: the dist must carry no developer tools.
    expect(read('scripts/release/buildStore.mjs')).toMatch(/checkDistDevTools\(dir, 'absent'\)/);
    // Built stable sidecar: no developer route and devTools false.
    expect(read('scripts/release/smokeSidecar.js')).toMatch(/devTools === false/);
  });

  // release.yml is private-only (left out of the public core export).
  it.skipIf(!hasPrivateFile('.github/workflows/release.yml'))('the release zip removes devtools/ and refuses leftovers', () => {
    expect(read('.github/workflows/release.yml')).toMatch(/disableDevTools\.mjs/);
  });

  it('the Docker image keeps its devtools refusal (no marker in the runtime code or UI, no devtools/ folder)', () => {
    const dockerfile = read('Dockerfile');
    const runtime = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
    const marker = runtime.indexOf('RUN ! grep -rqF -e "BURROW_DEV_TOOLS=on" -e "/dev/status" server.js server dist');
    expect(marker).toBeGreaterThan(runtime.indexOf('COPY --from=build /app/dist ./dist'));
    expect(runtime).toMatch(/^RUN test ! -e devtools$/m);
    expect(read('.dockerignore').split(/\r?\n/)).toContain('devtools');
  });
});

describe('desktop:dev mode', () => {
  it('builds the normal UI by default and the developer tools UI only with --devtools', () => {
    expect(buildScriptFor(parseDevArgs([]))).toBe('build');
    expect(buildScriptFor(parseDevArgs(['--devtools']))).toBe('build:devtools');
    expect(() => parseDevArgs(['--dev-tools'])).toThrow(/Unknown argument/);
  });

  it('dev.js takes its build script from the mode, never a fixed build:devtools', () => {
    const src = read('scripts/desktop/dev.js');
    expect(src).toMatch(/buildScriptFor\(mode\)/);
    expect(src).toMatch(/parseDevArgs\(process\.argv\.slice\(2\)\)/);
    expect(src).not.toMatch(/'build:devtools'/);
  });
});

describe('decideDistRebuild', () => {
  const clean = { commit: COMMIT, dirty: false };
  const current = { hasIndex: true, distDevTools: false, wantDevTools: false, stamp: { commit: COMMIT, dirty: false, devtools: false }, git: clean };

  it('reuses a dist built by desktop:dev from this commit in the same mode', () => {
    expect(decideDistRebuild(current)).toEqual({ rebuild: false, reason: 'dist is current (aaaaaaa)' });
    expect(decideDistRebuild({ ...current, distDevTools: true, wantDevTools: true, stamp: { ...current.stamp, devtools: true } }).rebuild).toBe(false);
  });

  it.each([
    ['no index.html', { hasIndex: false }, /index\.html is missing/],
    ['dist has the tools, normal wanted', { distDevTools: true }, /has the developer tools/],
    ['dist lacks the tools, tools wanted', { wantDevTools: true }, /has no developer tools/],
    ['no stamp (a plain npm run build)', { stamp: null }, /not built by desktop:dev/],
    ['stamp for the other mode', { stamp: { commit: COMMIT, dirty: false, devtools: true } }, /other mode/],
    ['git commit unknown', { git: { commit: null, dirty: true } }, /could not be read/],
    ['dirty worktree', { git: { commit: COMMIT, dirty: true } }, /uncommitted changes/],
    ['built from a dirty tree', { stamp: { commit: COMMIT, dirty: true, devtools: false } }, /built from uncommitted/],
    ['another commit', { stamp: { commit: OTHER, dirty: false, devtools: false } }, /another commit/],
  ])('rebuilds when %s', (_name, patch, reason) => {
    const out = decideDistRebuild({ ...current, ...patch });
    expect(out.rebuild).toBe(true);
    expect(out.reason).toMatch(reason);
  });
});

describe('readGitState', () => {
  it('reads the status without optional locks and counts untracked files', () => {
    const calls = [];
    const exec = vi.fn((cmd, args) => {
      calls.push([cmd, args]);
      return args[0] === 'rev-parse' ? `${COMMIT}\n` : '?? new-file.js\n';
    });
    expect(readGitState('/repo', exec)).toEqual({ commit: COMMIT, dirty: true });
    expect(calls).toEqual([
      ['git', ['rev-parse', 'HEAD']],
      ['git', ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=normal']],
    ]);
    expect(exec.mock.calls[1][2]).toMatchObject({ cwd: '/repo' });
  });

  it('a clean status is not dirty, and a failing git reads as dirty with no commit', () => {
    expect(readGitState('/repo', (_c, args) => (args[0] === 'rev-parse' ? COMMIT : ''))).toEqual({ commit: COMMIT, dirty: false });
    expect(
      readGitState('/repo', () => {
        throw new Error('no git');
      }),
    ).toEqual({ commit: null, dirty: true });
  });
});

describe('the desktop:dev stamp', () => {
  it('round-trips and is skipped by the dist copies', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-devstamp-'));
    const out = `${dir}-copy`;
    try {
      expect(readDevStamp(dir)).toBeNull();
      writeDevStamp(dir, { commit: COMMIT, dirty: false, devtools: false });
      expect(readDevStamp(dir)).toEqual({ commit: COMMIT, dirty: false, devtools: false });
      fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html>');
      fs.cpSync(dir, out, { recursive: true, filter: skipDevStamp });
      expect(fs.existsSync(path.join(out, 'index.html'))).toBe(true);
      expect(fs.existsSync(path.join(out, DEV_STAMP_FILE))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(out, { recursive: true, force: true });
    }
  });

  it('an unreadable stamp reads as none', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-devstamp-'));
    try {
      fs.writeFileSync(path.join(dir, DEV_STAMP_FILE), '{not json');
      expect(readDevStamp(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the sidecar copy and the Store layout use the skip filter', () => {
    expect(read('scripts/desktop/buildSidecar.js')).toMatch(/filter: skipDevStamp/);
    expect(read('scripts/release/storeLayout.mjs')).toMatch(/filter: skipDevStamp/);
  });
});
