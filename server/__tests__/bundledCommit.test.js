// A packaged sidecar must never run git: the commit is baked in at bundle time (__BURROW_COMMIT__).
// Bundles a tiny entry that imports server/runtime.js with node:child_process replaced by a recording shim.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { BUNDLE_BANNER, bundleDefine } from '../../scripts/desktop/workerBundle.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNTIME = path.join(ROOT, 'server', 'runtime.js');

let tmp;

const SHIM = `
export function execFileSync(...args) {
  (globalThis.__gitCalls ||= []).push(args);
  throw new Error('git must not run in a packaged build');
}
export function spawnSync(...args) { return execFileSync(...args); }
export function execSync(...args) { return execFileSync(...args); }
export function spawn(...args) { return execFileSync(...args); }
`;

/** Bundles the entry with the given define and returns the loaded module plus the recorded child_process calls. */
async function bundleAndLoad(name, commitOpt) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const shimPath = path.join(dir, 'child_process_shim.mjs');
  const entryPath = path.join(dir, 'entry.mjs');
  const outfile = path.join(dir, 'bundle.cjs');
  fs.writeFileSync(shimPath, SHIM);
  fs.writeFileSync(
    entryPath,
    `import { getCommit } from ${JSON.stringify(RUNTIME.replace(/\\/g, '/'))};\nexport { getCommit };\n`,
  );
  await build({
    entryPoints: [entryPath],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    logLevel: 'silent',
    define: bundleDefine('0.1.0', commitOpt),
    banner: { js: BUNDLE_BANNER },
    plugins: [
      {
        name: 'shim-child-process',
        setup(b) {
          b.onResolve({ filter: /^(node:)?child_process$/ }, () => ({ path: shimPath }));
        },
      },
    ],
  });
  globalThis.__gitCalls = [];
  const mod = createRequire(import.meta.url)(outfile);
  return { mod, calls: () => globalThis.__gitCalls };
}

describe('bundled commit (packaged build never runs git)', () => {
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-bundled-commit-'));
  });

  afterAll(() => {
    delete globalThis.__gitCalls;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('bakes the commit into the define as a JSON string, or null', () => {
    expect(bundleDefine('0.1.0', { commit: 'abc1234' }).__BURROW_COMMIT__).toBe('"abc1234"');
    expect(bundleDefine('0.1.0', { commit: null }).__BURROW_COMMIT__).toBe('null');
  });

  it('returns the baked commit and never invokes child_process', async () => {
    const { mod, calls } = await bundleAndLoad('with-commit', { commit: 'abc1234' });
    expect(mod.getCommit()).toBe('abc1234');
    expect(calls()).toEqual([]);
  }, 30000);

  it('returns null for a baked null commit and never falls back to git', async () => {
    const { mod, calls } = await bundleAndLoad('null-commit', { commit: null });
    expect(mod.getCommit()).toBeNull();
    expect(calls()).toEqual([]);
  }, 30000);

  it('sanity: the shim does record a call when the unbundled-style git path is used', async () => {
    // No __BURROW_COMMIT__ define at all: getCommit falls back to git, proving the shim detects it.
    const dir = path.join(tmp, 'no-define');
    fs.mkdirSync(dir, { recursive: true });
    const shimPath = path.join(dir, 'shim.mjs');
    const entryPath = path.join(dir, 'entry.mjs');
    const outfile = path.join(dir, 'bundle.cjs');
    fs.writeFileSync(shimPath, SHIM);
    fs.writeFileSync(entryPath, `export { getCommit } from ${JSON.stringify(RUNTIME.replace(/\\/g, '/'))};\n`);
    await build({
      entryPoints: [entryPath],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      logLevel: 'silent',
      define: { 'import.meta.url': '__importMetaUrl' },
      banner: { js: BUNDLE_BANNER },
      plugins: [{ name: 'shim', setup: (b) => b.onResolve({ filter: /^(node:)?child_process$/ }, () => ({ path: shimPath })) }],
    });
    globalThis.__gitCalls = [];
    const mod = createRequire(import.meta.url)(outfile);
    expect(mod.getCommit()).toBeNull();
    expect(globalThis.__gitCalls.length).toBe(1);
    expect(globalThis.__gitCalls[0][0]).toBe('git');
  }, 30000);
});
