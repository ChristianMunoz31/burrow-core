// validateFolderRoot and its helpers: what may be added as a folder root. Fixtures are synthetic temp dirs.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveDataDir } from '../paths.js';
import { __setPathOptionsForTests, isInsideRoot, isOneDrivePath, protectedRoots, validateFolderRoot } from '../folders/pathSafety.js';
import { makeTmp, neutralPathOptions, rmTree, tryDirLink } from './helpers/foldersEnv.js';

const WIN = process.platform === 'win32';
let root;
let home;
let notes;

const check = (input, opts = {}) => validateFolderRoot(input, opts);

beforeAll(() => {
  root = makeTmp('burrow-folders-path-');
  home = path.join(root, 'fake-home');
  notes = path.join(home, 'Documents', 'Notes');
  fs.mkdirSync(notes, { recursive: true });
});
afterAll(() => rmTree(root));
beforeEach(() => __setPathOptionsForTests(neutralPathOptions(root)));
afterEach(() => __setPathOptionsForTests(null));

describe('input shape', () => {
  it.each([
    ['a relative path', 'notes'],
    ['a dot path', './notes'],
    ['a tilde path', '~/Documents'],
    ['an empty string', ''],
    ['only spaces', '   '],
    ['only quotes', '""'],
    ['a NUL byte', `${'x'}\u0000${'y'}`],
    ['more than 1024 characters', `${WIN ? 'C:\\' : '/'}${'a'.repeat(1030)}`],
  ])('refuses %s with folder_path_invalid', async (_label, input) => {
    expect(await check(input)).toEqual({ ok: false, code: 'folder_path_invalid' });
  });

  it('refuses a NUL byte inside an otherwise absolute path', async () => {
    expect(await check(`${notes}\u0000x`)).toEqual({ ok: false, code: 'folder_path_invalid' });
  });

  it.each([[undefined], [null], [42], [{}], [['x']], [true]])('refuses a non-string (%j)', async (input) => {
    expect(await check(input)).toEqual({ ok: false, code: 'folder_path_invalid' });
  });

  it('a Windows drive-relative path is not absolute', async () => {
    expect(await check('C:notes', { platform: 'win32' })).toEqual({ ok: false, code: 'folder_path_invalid' });
  });

  it.each([
    ['UNC with backslashes', '\\\\server\\share\\folder'],
    ['UNC with slashes', '//server/share/folder'],
    ['the \\\\?\\ form', '\\\\?\\C:\\Users\\user'],
    ['the \\\\.\\ form', '\\\\.\\C:\\x'],
    ['a quoted UNC path', '"\\\\server\\share"'],
  ])('refuses %s as a network path on Windows before touching the disk', async (_label, input) => {
    expect(await check(input, { platform: 'win32' })).toEqual({ ok: false, code: 'folder_network_path' });
  });
});

describe('the folder itself', () => {
  it('refuses a missing path', async () => {
    expect(await check(path.join(root, 'nope'))).toEqual({ ok: false, code: 'folder_missing' });
  });

  it('refuses a file', async () => {
    const file = path.join(root, 'file.txt');
    fs.writeFileSync(file, 'x');
    expect(await check(file)).toEqual({ ok: false, code: 'folder_not_directory' });
  });

  it('refuses a folder that is itself a junction or symlink', async () => {
    const link = path.join(root, 'link-root');
    if (!tryDirLink(notes, link)) return; // the OS refuses links here
    expect(await check(link)).toEqual({ ok: false, code: 'folder_is_link' });
  });

  it('accepts a normal folder and returns the real path, key, name and no warnings', async () => {
    const res = await check(notes);
    expect(res.ok).toBe(true);
    expect(res).toMatchObject({ name: 'Notes', warnings: [] });
    expect(fs.realpathSync.native(res.path)).toBe(res.realPath);
    expect(res.pathKey).toBe(WIN ? res.realPath.toLowerCase() : res.realPath);
  });

  it('strips surrounding quotes and spaces (Copy as path)', async () => {
    const res = await check(`  "${notes}"  `);
    expect(res.ok).toBe(true);
    expect(res.name).toBe('Notes');
  });

  it('a trailing separator gives the same key as none', async () => {
    const a = await check(notes);
    const b = await check(notes + path.sep);
    expect(b.pathKey).toBe(a.pathKey);
  });

  it('a folder name over 120 characters is cut to 120', async () => {
    const long = path.join(home, 'x'.repeat(130));
    fs.mkdirSync(long);
    const res = await check(long);
    expect(res.ok).toBe(true);
    expect(res.name).toHaveLength(120);
  });

  it.runIf(WIN)('folds case on Windows: the same folder in another case is a duplicate', async () => {
    const first = await check(notes);
    const res = await check(notes.toUpperCase(), { existing: [{ pathKey: first.pathKey }] });
    expect(res).toEqual({ ok: false, code: 'folder_exists' });
  });
});

describe('too broad', () => {
  it('refuses a drive or file system root', async () => {
    expect(await check(path.parse(root).root)).toEqual({ ok: false, code: 'folder_too_broad' });
  });

  it('refuses home itself and every folder above it, but accepts a folder inside it', async () => {
    expect(await check(home)).toEqual({ ok: false, code: 'folder_too_broad' });
    expect(await check(root)).toEqual({ ok: false, code: 'folder_too_broad' });
    expect(await check(path.dirname(root))).toEqual({ ok: false, code: 'folder_too_broad' });
    expect((await check(path.join(home, 'Documents'))).ok).toBe(true);
  });
});

describe('protected folders', () => {
  it('refuses the folder holding the running program and anything inside it', async () => {
    const exec = path.join(root, 'fake-exec');
    fs.mkdirSync(path.join(exec, 'sub'), { recursive: true });
    expect(await check(exec)).toEqual({ ok: false, code: 'folder_protected' });
    expect(await check(path.join(exec, 'sub'))).toEqual({ ok: false, code: 'folder_protected' });
  });

  it('refuses the per-user app folders of the platform under home', async () => {
    const sub = WIN ? 'AppData' : process.platform === 'darwin' ? 'Library' : '.config';
    const dir = path.join(home, sub, 'Some App');
    fs.mkdirSync(dir, { recursive: true });
    expect(await check(dir)).toEqual({ ok: false, code: 'folder_protected' });
    expect(await check(path.join(home, sub))).toEqual({ ok: false, code: 'folder_protected' });
  });

  it.runIf(WIN)('refuses folders named by the Windows environment (system, program files, ProgramData, APPDATA)', async () => {
    for (const key of ['SystemRoot', 'windir', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'APPDATA', 'LOCALAPPDATA']) {
      const dir = path.join(root, `env-${key.replace(/\W/g, '')}`);
      fs.mkdirSync(path.join(dir, 'inner'), { recursive: true });
      __setPathOptionsForTests(neutralPathOptions(root, { env: { [key]: dir } }));
      expect(await check(dir), key).toEqual({ ok: false, code: 'folder_protected' });
      expect(await check(path.join(dir, 'inner')), `${key} inner`).toEqual({ ok: false, code: 'folder_protected' });
    }
  });

  it('a folder that only shares a name prefix with a protected root is allowed', async () => {
    const exec = path.join(root, 'fake-exec');
    const sibling = path.join(root, 'fake-exec-extra');
    fs.mkdirSync(exec, { recursive: true });
    fs.mkdirSync(sibling, { recursive: true });
    // sibling is outside home on purpose: give it a home that does not contain it
    __setPathOptionsForTests(neutralPathOptions(root, { home: path.join(root, 'elsewhere') }));
    expect((await check(sibling)).ok).toBe(true);
  });

  it('lists the roots per platform', () => {
    const win = protectedRoots({
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows', ProgramData: 'C:\\ProgramData', APPDATA: 'C:\\Users\\example\\AppData\\Roaming' },
      home: 'C:\\Users\\example',
      execDir: 'C:\\App',
    });
    expect(win).toEqual(expect.arrayContaining(['C:\\Windows', 'C:\\ProgramData', 'C:\\Users\\example\\AppData\\Roaming', 'C:\\Users\\example\\AppData', 'C:\\App']));
    const mac = protectedRoots({ platform: 'darwin', env: {}, home: '/Users/example', execDir: '/x/app' });
    expect(mac).toEqual(expect.arrayContaining(['/System', '/Library', '/Applications', '/usr', '/bin', '/sbin', '/etc', '/var', '/private', '/opt', '/Users/example/Library', '/x/app']));
    const linux = protectedRoots({ platform: 'linux', env: {}, home: '/home/example', execDir: '/x/app' });
    expect(linux).toEqual(
      expect.arrayContaining(['/usr', '/bin', '/sbin', '/etc', '/var', '/proc', '/sys', '/dev', '/boot', '/run', '/opt', '/home/example/.config', '/home/example/.local', '/x/app']),
    );
  });

  it('ignores blank or non-string Windows environment values (only the well-known system folders remain)', () => {
    const list = protectedRoots({ platform: 'win32', env: { SystemRoot: '   ', windir: 5, ProgramData: '' }, home: '', execDir: '' });
    expect(list).toEqual(['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData', 'C:\\Windows.old']);
  });

  it('on Windows the well-known system folders are protected even when the environment names none (the sidecar passes little)', () => {
    const list = protectedRoots({ platform: 'win32', env: {}, home: 'C:\\Users\\example', execDir: 'C:\\App' });
    expect(list).toEqual(expect.arrayContaining(['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData', 'C:\\Users\\example\\AppData', 'C:\\App']));
  });

  it('the system drive comes from SystemDrive, else SystemRoot, else C:', () => {
    expect(protectedRoots({ platform: 'win32', env: { SystemDrive: 'd:' }, home: '', execDir: '' })).toContain('D:\\Windows');
    expect(protectedRoots({ platform: 'win32', env: { SystemRoot: 'E:\\WINNT' }, home: '', execDir: '' })).toContain('E:\\Program Files');
    expect(protectedRoots({ platform: 'win32', env: { windir: 'F:\\Windows' }, home: '', execDir: '' })).toContain('F:\\ProgramData');
    expect(protectedRoots({ platform: 'win32', env: {}, home: '', execDir: '' })).toContain('C:\\Windows');
  });
});

describe("Burrow's own data", () => {
  it('refuses the data dir, a folder inside it and a folder that contains it', async () => {
    const parent = path.join(root, 'holder');
    const dir = path.join(parent, 'burrow-data');
    const inside = path.join(dir, 'backups');
    fs.mkdirSync(inside, { recursive: true });
    for (const target of [dir, inside]) {
      expect(await check(target, { dataDirs: [dir] })).toEqual({ ok: false, code: 'folder_burrow_data' });
    }
    // contains: the parent of the data dir (home is elsewhere so it is not "too broad")
    __setPathOptionsForTests(neutralPathOptions(root, { home: path.join(root, 'elsewhere') }));
    expect(await check(parent, { dataDirs: [dir] })).toEqual({ ok: false, code: 'folder_burrow_data' });
  });

  it('knows the real data dir of this process (the test data dir) without being told', async () => {
    const dataDir = resolveDataDir();
    const inside = path.join(dataDir, 'folders-inside-data');
    fs.mkdirSync(inside, { recursive: true });
    expect(await check(inside)).toEqual({ ok: false, code: 'folder_burrow_data' });
  });

  it('refuses any of several data dirs (stable and dev channel dirs are passed the same way)', async () => {
    const a = path.join(root, 'stable-data');
    const b = path.join(root, 'dev-data');
    fs.mkdirSync(a, { recursive: true });
    fs.mkdirSync(b, { recursive: true });
    expect(await check(b, { dataDirs: [a, b] })).toEqual({ ok: false, code: 'folder_burrow_data' });
    expect(await check(a, { dataDirs: [a, b] })).toEqual({ ok: false, code: 'folder_burrow_data' });
  });
});

describe('existing folders', () => {
  it('refuses the same folder as folder_exists', async () => {
    const first = await check(notes);
    expect(await check(notes, { existing: [{ pathKey: first.pathKey }] })).toEqual({ ok: false, code: 'folder_exists' });
    expect(await check(notes, { existing: [first.pathKey] })).toEqual({ ok: false, code: 'folder_exists' });
  });

  it('refuses a folder inside an added one, and one that contains an added one', async () => {
    const parent = await check(path.join(home, 'Documents'));
    expect(await check(notes, { existing: [{ pathKey: parent.pathKey }] })).toEqual({ ok: false, code: 'folder_overlaps' });
    const child = await check(notes);
    expect(await check(path.join(home, 'Documents'), { existing: [{ pathKey: child.pathKey }] })).toEqual({ ok: false, code: 'folder_overlaps' });
  });

  it('a sibling that only shares a name prefix is not an overlap', async () => {
    const a = path.join(home, 'proj');
    const b = path.join(home, 'proj-two');
    fs.mkdirSync(a, { recursive: true });
    fs.mkdirSync(b, { recursive: true });
    const first = await check(a);
    expect((await check(b, { existing: [{ pathKey: first.pathKey }] })).ok).toBe(true);
  });

  it('allows 19 folders and refuses the 20th more with folder_limit', async () => {
    const keys = (n) => Array.from({ length: n }, (_v, i) => ({ pathKey: path.join(root, `other-${i}`).toLowerCase() }));
    expect((await check(notes, { existing: keys(19) })).ok).toBe(true);
    expect(await check(notes, { existing: keys(20) })).toEqual({ ok: false, code: 'folder_limit' });
  });
});

describe('warnings', () => {
  it('warns about OneDrive for a folder inside a sync root named by the environment', async () => {
    for (const key of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
      __setPathOptionsForTests(neutralPathOptions(root, { env: { [key]: path.join(home, 'Documents') } }));
      expect((await check(notes)).warnings, key).toEqual(['onedrive']);
    }
  });

  it('no warning outside the sync root or with a blank value', async () => {
    __setPathOptionsForTests(neutralPathOptions(root, { env: { OneDrive: path.join(root, 'else'), OneDriveConsumer: '  ' } }));
    expect((await check(notes)).warnings).toEqual([]);
  });

  it('isOneDrivePath matches the root itself, not a name prefix', () => {
    const od = path.join(root, 'OneDrive');
    expect(isOneDrivePath(od, { OneDrive: od })).toBe(true);
    expect(isOneDrivePath(`${od}-other`, { OneDrive: od })).toBe(false);
    expect(isOneDrivePath(path.join(od, 'a'), {})).toBe(false);
  });
});

describe('isInsideRoot', () => {
  it('is true for the root and files below it, false for siblings, parents and prefix lookalikes', () => {
    const fold = (p) => (WIN ? p.toLowerCase() : p);
    const key = fold(path.join(root, 'r'));
    expect(isInsideRoot(key, fold(path.join(root, 'r')))).toBe(true);
    expect(isInsideRoot(key, fold(path.join(root, 'r', 'a', 'b.txt')))).toBe(true);
    expect(isInsideRoot(key, fold(path.join(root, 'r-other', 'b.txt')))).toBe(false);
    expect(isInsideRoot(key, fold(root))).toBe(false);
    expect(isInsideRoot(key, fold(path.join(root, 'x')))).toBe(false);
  });
});
