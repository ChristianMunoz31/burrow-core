// checkCoreTree (docs/adr/0001-open-core-split.md 3.14) on fixture trees, and the export refusals of exportCore.mjs.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXPORT_IGNORED, MARKER_HOLDERS, PRO_HEADER, checkCoreTree, main } from '../../scripts/checks/coreTreeGuard.js';
import { normalizeRemote, preflight } from '../../scripts/release/exportCore.mjs';

let tmp;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-coretree-'));
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

let n = 0;
function tree(files) {
  n += 1;
  const root = path.join(tmp, `t${n}`);
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return root;
}

const CLEAN = {
  'server.js': "import './server/proExtensions.js';\n",
  'server/proExtensionsLoader.js': "export const x = () => import('../pro/server/index.js');\n",
  'server/proExtensions.js': 'export const PRO_API_VERSION = 1;\n',
  'src/main.jsx': 'export default 1;\n',
  'docs/OPEN_CORE.md': `Pro files start with \`${PRO_HEADER}\` and live in pro/.\n`,
  'server/__tests__/x.test.js': "// pro/server/index.js is named in tests\nconst m = 'BURROW_PRO=' + 'on';\n",
};
const DEV_ON = ['BURROW_DEV_TOOLS', 'on'].join('=');
const PRO_ON = ['BURROW_PRO', 'on'].join('=');

describe('checkCoreTree', () => {
  it('accepts a clean core tree', () => {
    expect(checkCoreTree(tree(CLEAN))).toEqual([]);
  });

  it('refuses pro/ and devtools/ paths', () => {
    const found = checkCoreTree(tree({ ...CLEAN, 'pro/server/index.js': 'x', 'devtools/server/index.js': 'y' }));
    expect(found.some((p) => p.startsWith('pro/'))).toBe(true);
    expect(found.some((p) => p.startsWith('devtools/'))).toBe(true);
  });

  it('refuses the private header in a non-Markdown file', () => {
    expect(checkCoreTree(tree({ ...CLEAN, 'src/x.js': `${PRO_HEADER}\nexport default 1;\n` }))).toEqual([expect.stringMatching(/^src\/x\.js: carries the private Pro header/)]);
  });

  it('refuses a runtime core file other than the loader that names pro/', () => {
    const found = checkCoreTree(tree({ ...CLEAN, 'server/a.js': "// see pro/ui/proExtensions.js\nexport default 1;\n", 'src/b.jsx': "import x from '../pro/ui/x.js';\n" }));
    expect(found).toEqual(expect.arrayContaining([expect.stringMatching(/^server\/a\.js: a runtime core file names pro\//), expect.stringMatching(/^src\/b\.jsx/)]));
  });

  it('refuses the build markers outside their holders', () => {
    expect(checkCoreTree(tree({ ...CLEAN, 'server/c.js': `const m = '${DEV_ON}';\n` }))).toEqual([expect.stringMatching(/server\/c\.js: contains BURROW_DEV_TOOLS=on/)]);
    expect(checkCoreTree(tree({ ...CLEAN, 'scripts/x.js': `const m = '${PRO_ON}';\n` }))).toEqual([expect.stringMatching(/scripts\/x\.js: contains BURROW_PRO=on/)]);
    const holder = MARKER_HOLDERS[PRO_ON][0];
    expect(checkCoreTree(tree({ ...CLEAN, [holder]: `const m = '${PRO_ON}';\n` }))).toEqual([]);
  });

  it('refuses every owner-chosen export-ignore path (O3)', () => {
    const files = { ...CLEAN };
    for (const p of EXPORT_IGNORED.filter((x) => !x.startsWith('pro/') && !x.startsWith('devtools/'))) files[p.endsWith('/') ? `${p}x.txt` : p] = 'x';
    files['docs/release-runbook-v9.9.9.md'] = 'x';
    const found = checkCoreTree(tree(files));
    expect(found.filter((p) => p.includes('private-only path')).length).toBe(EXPORT_IGNORED.length - 2 + 1);
  });

  it('the CLI exits 1 on problems and 0 on a clean tree', () => {
    const io = { log: () => {}, error: () => {} };
    expect(main([tree(CLEAN)], io)).toBe(0);
    expect(main([tree({ ...CLEAN, 'pro/x.js': 'x' })], io)).toBe(1);
    expect(main([], io)).toBe(1);
  });
});

describe('exportCore refusals', () => {
  const repo = () => tree({ 'package.json': '{}' });
  const fakeGit = ({ origin = 'git@github.com:ChristianMunoz31/burrow.git', status = '', outRemotes = '' } = {}) => (args) => {
    if (args[0] === 'remote' && args[1] === 'get-url') return origin;
    if (args[0] === 'remote' && args[1] === '-v') return outRemotes;
    if (args[0] === 'status') return status;
    throw new Error(`unexpected git ${args.join(' ')}`);
  };

  it('refuses an --out inside the private repo', () => {
    const root = repo();
    expect(preflight({ root, out: path.join(root, 'export'), readGit: fakeGit() })[0]).toMatch(/inside the private repository/);
  });

  it('refuses an --out whose remote is the private origin or a burrow-pro repo', () => {
    const root = repo();
    const out = tree({ '.git/HEAD': 'ref: refs/heads/main\n' });
    expect(preflight({ root, out, readGit: fakeGit({ outRemotes: 'origin\thttps://github.com/ChristianMunoz31/burrow (fetch)' }) })[0]).toMatch(/private repository as a remote/);
    expect(preflight({ root, out, readGit: fakeGit({ outRemotes: 'origin\tgit@github.com:ChristianMunoz31/burrow-pro.git (fetch)' }) })[0]).toMatch(/Pro repository remote/);
    expect(preflight({ root, out, readGit: fakeGit({ outRemotes: 'origin\thttps://github.com/ChristianMunoz31/burrow-core (fetch)' }) })).toEqual([]);
  });

  it('refuses a dirty working tree', () => {
    expect(preflight({ root: repo(), out: path.join(tmp, 'clean-out'), readGit: fakeGit({ status: ' M server.js' }) })[0]).toMatch(/not clean/);
  });

  it('normalizes remote URLs', () => {
    expect(normalizeRemote('git@github.com:ChristianMunoz31/burrow.git')).toBe(normalizeRemote('https://github.com/christianmunoz31/burrow'));
    expect(normalizeRemote('https://token@github.com/a/b.git/')).toBe('github.com/a/b');
  });
});
