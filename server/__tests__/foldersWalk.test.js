// walkFolder: read-only, sorted, never follows a link, honours its limits and an abort signal.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { __setPathOptionsForTests, validateFolderRoot } from '../folders/pathSafety.js';
import { newWalkMeta, walkFolder } from '../folders/walk.js';
import { fingerprint, makeTmp, rmTree, tryDirLink, tryFileLink, useNeutralPaths, writeTree } from './helpers/foldersEnv.js';

const SECRET = 'OUTSIDE_TARGET_SECRET_93kd';
let base;
let dir;
let outside;
let n = 0;

async function walk(opts = {}) {
  const checked = await validateFolderRoot(dir, { existing: [] });
  expect(checked.ok).toBe(true);
  const meta = newWalkMeta();
  const items = [];
  for await (const item of walkFolder(checked.realPath, { rootKey: checked.pathKey, meta, ...opts })) items.push(item);
  return { items, meta, checked };
}
const files = (items) => items.filter((i) => i.type === 'file').map((i) => i.relPath);

beforeAll(() => {
  base = makeTmp('burrow-folders-walk-');
  useNeutralPaths(base);
});
afterAll(() => {
  __setPathOptionsForTests(null);
  rmTree(base);
});
beforeEach(() => {
  n += 1;
  dir = path.join(base, `case-${n}`, 'root');
  outside = path.join(base, `case-${n}`, 'outside');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
});
afterEach(() => __setPathOptionsForTests(null) || useNeutralPaths(base));

describe('what is listed', () => {
  it('lists files with a forward-slash relative path, depth first, in sorted order', async () => {
    writeTree(dir, { 'b.txt': 'b', 'a/z.txt': 'z', 'a/y.txt': 'y', 'c.txt': 'c', 'a/m/deep.txt': 'd' });
    const { items } = await walk();
    expect(files(items)).toEqual(['a/m/deep.txt', 'a/y.txt', 'a/z.txt', 'b.txt', 'c.txt']);
    const deep = items.find((i) => i.relPath === 'a/m/deep.txt');
    expect(deep).toMatchObject({ type: 'file', depth: 2, outside: false });
    expect(deep.absPath).toBe(path.join((await validateFolderRoot(dir)).realPath, 'a', 'm', 'deep.txt'));
    expect(deep.lstat.size).toBe(1);
  });

  it('the order is the same on every run', async () => {
    writeTree(dir, Object.fromEntries(['q', 'a', 'Z', 'm', '1', '_x'].map((name) => [`${name}.txt`, name])));
    const a = files((await walk()).items);
    const b = files((await walk()).items);
    expect(a).toEqual(b);
    expect(a).toEqual([...a].sort());
  });

  it('skips hidden files silently and reports hidden and well-known folders as skipDir without entering them', async () => {
    writeTree(dir, {
      'keep.txt': 'k',
      '.hidden.txt': 'h',
      '.git/config': 'g',
      'node_modules/pkg/index.js': 'n',
      'NODE_MODULES_UPPER/x.txt': 'x',
      '__pycache__/a.pyc': 'p',
      '.venv/lib.py': 'v',
      'venv/lib.py': 'v',
      '$Recycle.Bin/x.txt': 'r',
      'System Volume Information/x.txt': 's',
      '.vscode/settings.json': '{}',
    });
    const { items, meta } = await walk();
    expect(files(items)).toEqual(['NODE_MODULES_UPPER/x.txt', 'keep.txt']);
    const skipped = items.filter((i) => i.type === 'skipDir').map((i) => i.relPath);
    expect(skipped).toEqual(expect.arrayContaining(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '$Recycle.Bin', 'System Volume Information', '.vscode']));
    expect(skipped).not.toContain('NODE_MODULES_UPPER');
    expect(meta.dirsSkipped).toBe(skipped.length);
    expect(items.some((i) => i.relPath.startsWith('node_modules/'))).toBe(false);
  });

  it('counts the folders it entered', async () => {
    writeTree(dir, { 'a/x.txt': 'x', 'a/b/y.txt': 'y', 'c/z.txt': 'z' });
    const { meta } = await walk();
    expect(meta.dirsScanned).toBe(4); // root, a, a/b, c
    expect(meta.entries).toBe(6);
    expect([...meta.limitsHit]).toEqual([]);
  });

  it('an empty folder yields nothing', async () => {
    expect((await walk()).items).toEqual([]);
  });
});

describe('links are never followed', () => {
  it('a junction or symlink inside the root that points outside is listed as `link` and its target is never entered', async () => {
    writeTree(outside, { 'secret.txt': SECRET, 'deep/more.txt': SECRET });
    writeTree(dir, { 'real.txt': 'real' });
    if (!tryDirLink(outside, path.join(dir, 'link'))) return; // the OS refuses links here
    const { items } = await walk();
    const link = items.find((i) => i.relPath === 'link');
    expect(link).toMatchObject({ type: 'link' });
    expect(items.filter((i) => i.relPath.startsWith('link/'))).toEqual([]);
    expect(files(items)).toEqual(['real.txt']);
    expect(JSON.stringify(items.map((i) => i.relPath))).not.toContain('secret');
  });

  it('a file symlink pointing outside is listed as `link`', async () => {
    writeTree(outside, { 'secret.txt': SECRET });
    if (!tryFileLink(path.join(outside, 'secret.txt'), path.join(dir, 'shortcut.txt'))) return;
    const { items } = await walk();
    expect(items.map((i) => [i.type, i.relPath])).toEqual([['link', 'shortcut.txt']]);
  });

  it('a hidden link is skipped entirely', async () => {
    writeTree(outside, { 'secret.txt': SECRET });
    if (!tryDirLink(outside, path.join(dir, '.hidden-link'))) return;
    expect((await walk()).items).toEqual([]);
  });

  it('a link to the root itself does not loop', async () => {
    writeTree(dir, { 'a.txt': 'a' });
    if (!tryDirLink(dir, path.join(dir, 'self'))) return;
    const { items } = await walk();
    expect(items.map((i) => [i.type, i.relPath])).toEqual([['file', 'a.txt'], ['link', 'self']]);
  });

  it('walking never changes a file (bytes, size and modified time)', async () => {
    writeTree(dir, { 'a.txt': 'alpha', 'sub/b.md': '# beta\n' });
    const before = fingerprint(dir);
    await walk();
    expect(fingerprint(dir)).toEqual(before);
  });
});

describe('limits', () => {
  it('stops going deeper than 12 levels (default) and records max_depth', async () => {
    const parts = Array.from({ length: 13 }, (_v, i) => `d${i + 1}`);
    const tree = {};
    for (let i = 1; i <= 13; i += 1) tree[`${parts.slice(0, i).join('/')}/f${i}.txt`] = 'x';
    writeTree(dir, tree);
    const { items, meta } = await walk();
    const listed = files(items);
    expect(listed).toContain(`${parts.slice(0, 12).join('/')}/f12.txt`);
    expect(listed.some((p) => p.endsWith('/f13.txt'))).toBe(false);
    expect([...meta.limitsHit]).toEqual(['max_depth']);
    expect(items.some((i) => i.type === 'skipDir' && i.relPath === parts.slice(0, 13).join('/'))).toBe(true);
  });

  it('honours a smaller maxDepth', async () => {
    writeTree(dir, { 'top.txt': 't', 'a/one.txt': '1', 'a/b/two.txt': '2' });
    const { items, meta } = await walk({ maxDepth: 1 });
    expect(files(items)).toEqual(['a/one.txt', 'top.txt']);
    expect(meta.limitsHit.has('max_depth')).toBe(true);
  });

  it('stops after maxEntries and records max_entries', async () => {
    writeTree(dir, Object.fromEntries(Array.from({ length: 10 }, (_v, i) => [`f${String(i).padStart(2, '0')}.txt`, 'x'])));
    const { items, meta } = await walk({ maxEntries: 4 });
    expect(files(items)).toEqual(['f00.txt', 'f01.txt', 'f02.txt', 'f03.txt']);
    expect(meta.limitsHit.has('max_entries')).toBe(true);
    expect(meta.entries).toBe(4);
  });

  it('maxEntries also stops the walk across folders', async () => {
    writeTree(dir, { 'a/1.txt': '1', 'a/2.txt': '2', 'b/3.txt': '3', 'b/4.txt': '4' });
    const { items, meta } = await walk({ maxEntries: 4 });
    expect(files(items).length).toBeLessThan(4);
    expect(meta.limitsHit.has('max_entries')).toBe(true);
  });

  it('exactly maxEntries entries is not a limit hit', async () => {
    writeTree(dir, { 'a.txt': 'a', 'b.txt': 'b' });
    const { meta } = await walk({ maxEntries: 2 });
    expect(meta.limitsHit.has('max_entries')).toBe(false);
  });
});

describe('abort', () => {
  it('an already aborted signal stops before listing anything', async () => {
    writeTree(dir, { 'a.txt': 'a' });
    const controller = new AbortController();
    controller.abort();
    await expect(walk({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError', aborted: true });
  });

  it('aborting between items stops the walk with an AbortError', async () => {
    writeTree(dir, { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' });
    const controller = new AbortController();
    const checked = await validateFolderRoot(dir);
    const seen = [];
    const run = async () => {
      for await (const item of walkFolder(checked.realPath, { rootKey: checked.pathKey, signal: controller.signal })) {
        seen.push(item.relPath);
        if (seen.length === 1) controller.abort();
      }
    };
    await expect(run()).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen).toEqual(['a.txt']);
  });
});
