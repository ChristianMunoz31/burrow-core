// Ownership marker of the user profile data folder: what the guard does with a missing, marked, empty, foreign, file, linked
// and corrupt folder. Real files in temp folders only.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DATA_MARKER_FILE,
  DataDirNotOursError,
  EXIT_DATA_DIR_NOT_OURS,
  ensureOwnedDataFolder,
  hasOwnershipMarker,
  inspectDataFolder,
  isValidMarker,
  isValidMarkerBytes,
  markerContent,
  notOursMessage,
  resetOwnershipCache,
} from '../dataFolderOwnership.js';
import { USER_PROFILE_DATA_FOLDER, ensureDataDirOwnership, getDataDir, userProfileDataDir } from '../paths.js';

// The marker texts shared with the Rust shell (src-tauri/src/data_guard.rs) and the sideload script test.
const markerCases = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'markers.json'), 'utf8')).cases.map((c) => ({
  ...c,
  bytes: c.base64 === undefined ? Buffer.from(c.text, 'utf8') : Buffer.from(c.base64, 'base64'),
}));

/** A junction (Windows) or directory symlink at `link`; false when this machine does not let the test make one. */
function makeLink(target, link) {
  try {
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  }
}

/** A copy of `fs` with some functions replaced, to inject failures and races. */
const fsWith = (overrides) => ({ ...fs, ...overrides });
const denied = () => Object.assign(new Error('denied'), { code: 'EACCES' });
const exists = () => Object.assign(new Error('exists'), { code: 'EEXIST' });

let root;
beforeEach(() => {
  resetOwnershipCache();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-own-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** Every entry under `dir` with its content, to prove a refused folder is byte-for-byte unchanged. */
const snapshot = (dir) =>
  fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((e) => {
      const full = path.join(e.parentPath, e.name);
      return `${path.relative(dir, full)}|${e.isDirectory() ? 'dir' : fs.readFileSync(full, 'hex')}`;
    })
    .sort();

describe('the folder name and the exit code', () => {
  it('is Burrow Data inside the profile, and the guard exits with 5', () => {
    expect(USER_PROFILE_DATA_FOLDER).toBe('Burrow Data');
    expect(userProfileDataDir({ env: { USERPROFILE: 'C:\\Users\\example' } })).toBe('C:\\Users\\example\\Burrow Data');
    expect(EXIT_DATA_DIR_NOT_OURS).toBe(5);
    expect(DATA_MARKER_FILE).toBe('.burrow-data.json');
  });
});

describe('the marker file', () => {
  it('has the documented fields and is accepted by the validator', () => {
    const body = JSON.parse(markerContent(new Date('2026-10-08T12:00:00.000Z')));
    expect(body).toEqual({ app: 'Burrow', edition: 'store', dataLocation: 'userprofile', createdAt: '2026-10-08T12:00:00.000Z', formatVersion: 1 });
    expect(isValidMarker(markerContent())).toBe(true);
  });

  it.each([
    ['not json', '{nope'],
    ['an array', '[]'],
    ['null', 'null'],
    ['another app', JSON.stringify({ app: 'Other', edition: 'store', dataLocation: 'userprofile', createdAt: 'x', formatVersion: 1 })],
    ['the direct edition', JSON.stringify({ app: 'Burrow', edition: 'direct', dataLocation: 'userprofile', createdAt: 'x', formatVersion: 1 })],
    ['an unknown format version', JSON.stringify({ app: 'Burrow', edition: 'store', dataLocation: 'userprofile', createdAt: 'x', formatVersion: 2 })],
    ['no createdAt', JSON.stringify({ app: 'Burrow', edition: 'store', dataLocation: 'userprofile', formatVersion: 1 })],
  ])('rejects %s', (_label, text) => {
    expect(isValidMarker(text)).toBe(false);
  });

  it('agrees with the shared fixture (the Rust shell and the sideload script read the same file)', () => {
    expect(markerCases.length).toBeGreaterThanOrEqual(30);
    for (const c of markerCases) expect(isValidMarkerBytes(c.bytes), c.name).toBe(c.valid);
  });

  it('judges the same bytes the same way when they sit in a folder', () => {
    for (const c of markerCases) {
      const dir = fs.mkdtempSync(path.join(root, 'fx-'));
      fs.writeFileSync(path.join(dir, DATA_MARKER_FILE), c.bytes);
      expect(inspectDataFolder(dir), c.name).toEqual(c.valid ? { state: 'marked' } : { state: 'refused', reason: 'bad_marker' });
    }
  });

  it('refuses formatVersion 1.0, a byte order mark and invalid UTF-8 explicitly', () => {
    const body = markerContent();
    expect(isValidMarker(body.replace('"formatVersion": 1', '"formatVersion": 1.0'))).toBe(false);
    expect(isValidMarkerBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body)]))).toBe(false);
    expect(isValidMarkerBytes(Buffer.concat([Buffer.from(body.replace('}\n', ',"n":"')), Buffer.from([0xff]), Buffer.from('"}')]))).toBe(false);
    expect(isValidMarkerBytes(Buffer.from(body))).toBe(true);
  });
});

describe('ensureOwnedDataFolder', () => {
  it('creates a missing folder and writes the marker', () => {
    const dir = path.join(root, 'Burrow Data');
    expect(ensureOwnedDataFolder(dir)).toBe('created');
    expect(fs.readdirSync(dir)).toEqual([DATA_MARKER_FILE]);
    expect(hasOwnershipMarker(dir)).toBe(true);
  });

  it('uses a marked folder as it is', () => {
    const dir = path.join(root, 'Burrow Data');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, DATA_MARKER_FILE), markerContent());
    fs.writeFileSync(path.join(dir, 'burrow.db'), 'data');
    const before = snapshot(dir);
    expect(ensureOwnedDataFolder(dir)).toBe('marked');
    expect(snapshot(dir)).toEqual(before);
  });

  it('adopts an empty folder', () => {
    const dir = path.join(root, 'Burrow Data');
    fs.mkdirSync(dir);
    expect(ensureOwnedDataFolder(dir)).toBe('adopted');
    expect(fs.readdirSync(dir)).toEqual([DATA_MARKER_FILE]);
  });

  it.each([
    ['a visible file', (dir) => fs.writeFileSync(path.join(dir, 'readme.txt'), 'x')],
    ['only a hidden file', (dir) => fs.writeFileSync(path.join(dir, '.hidden'), 'x')],
    ['a .git folder (a source checkout)', (dir) => fs.mkdirSync(path.join(dir, '.git'))],
    ['an empty subfolder', (dir) => fs.mkdirSync(path.join(dir, 'sub'))],
    ['a burrow.db without a marker (an older or foreign layout)', (dir) => fs.writeFileSync(path.join(dir, 'burrow.db'), 'x')],
    [
      'a desktop.ini with the system and hidden attributes',
      (dir) => {
        const ini = path.join(dir, 'desktop.ini');
        fs.writeFileSync(ini, '[.ShellClassInfo]\r\n');
        if (process.platform === 'win32') expect(spawnSync('attrib', ['+s', '+h', ini]).status).toBe(0);
      },
    ],
  ])('refuses an unmarked folder with %s and leaves it byte-for-byte unchanged', (_label, fill) => {
    const dir = path.join(root, 'Burrow Data');
    fs.mkdirSync(dir);
    fill(dir);
    const before = snapshot(dir);
    let error;
    try {
      ensureOwnedDataFolder(dir);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DataDirNotOursError);
    expect(error.code).toBe('data_dir_not_ours');
    expect(error.reason).toBe('not_empty');
    expect(error.message).toContain(dir);
    expect(error.message).toMatch(/did not change anything/);
    expect(snapshot(dir)).toEqual(before);
    expect(fs.existsSync(path.join(dir, DATA_MARKER_FILE))).toBe(false);
  });

  it('refuses a path that is a file', () => {
    const file = path.join(root, 'Burrow Data');
    fs.writeFileSync(file, 'i am a file');
    expect(() => ensureOwnedDataFolder(file)).toThrow(expect.objectContaining({ code: 'data_dir_not_ours', reason: 'file' }));
    expect(fs.readFileSync(file, 'utf8')).toBe('i am a file');
  });

  it('refuses a junction or symbolic link, even to a marked folder, and never follows it', (ctx) => {
    const target = path.join(root, 'real');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, DATA_MARKER_FILE), markerContent());
    const link = path.join(root, 'Burrow Data');
    if (!makeLink(target, link)) ctx.skip('this machine does not let the test create a junction or symbolic link');
    expect(() => ensureOwnedDataFolder(link)).toThrow(expect.objectContaining({ code: 'data_dir_not_ours', reason: 'link' }));
    expect(fs.readdirSync(target)).toEqual([DATA_MARKER_FILE]);
  });

  it('refuses a dangling junction or symbolic link instead of treating it as a missing folder', (ctx) => {
    const target = path.join(root, 'real');
    fs.mkdirSync(target);
    const link = path.join(root, 'Burrow Data');
    if (!makeLink(target, link)) ctx.skip('this machine does not let the test create a junction or symbolic link');
    fs.rmdirSync(target);
    expect(() => ensureOwnedDataFolder(link)).toThrow(expect.objectContaining({ reason: 'link' }));
    expect(fs.existsSync(target)).toBe(false);
  });

  it.each([
    ['not json', '{nope'],
    ['the wrong app', JSON.stringify({ app: 'Other' })],
    ['an empty file', ''],
  ])('refuses a corrupt marker (%s) and does not repair it', (_label, text) => {
    const dir = path.join(root, 'Burrow Data');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, DATA_MARKER_FILE), text);
    expect(() => ensureOwnedDataFolder(dir)).toThrow(expect.objectContaining({ reason: 'bad_marker' }));
    expect(fs.readFileSync(path.join(dir, DATA_MARKER_FILE), 'utf8')).toBe(text);
  });

  it('refuses a marker that is a folder, and an oversized marker', () => {
    const dir = path.join(root, 'Burrow Data');
    fs.mkdirSync(path.join(dir, DATA_MARKER_FILE), { recursive: true });
    expect(inspectDataFolder(dir)).toEqual({ state: 'refused', reason: 'bad_marker' });
    fs.rmSync(path.join(dir, DATA_MARKER_FILE), { recursive: true });
    fs.writeFileSync(path.join(dir, DATA_MARKER_FILE), ' '.repeat(5000) + markerContent());
    expect(inspectDataFolder(dir)).toEqual({ state: 'refused', reason: 'bad_marker' });
  });

  it('treats a wrongly cased marker name as the marker where the folder ignores case, and refuses it where it does not', () => {
    const dir = path.join(root, 'Burrow Data');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '.Burrow-Data.json'), markerContent());
    const sameFile = fs.existsSync(path.join(dir, DATA_MARKER_FILE)); // NTFS and default APFS: one file
    const before = snapshot(dir);
    if (sameFile) {
      expect(ensureOwnedDataFolder(dir)).toBe('marked');
    } else {
      expect(() => ensureOwnedDataFolder(dir)).toThrow(expect.objectContaining({ reason: 'bad_marker' }));
    }
    expect(snapshot(dir)).toEqual(before);
  });

  it('checks a folder once per process but never skips the check for another folder', () => {
    const a = path.join(root, 'a');
    const b = path.join(root, 'b');
    expect(ensureOwnedDataFolder(a)).toBe('created');
    expect(ensureOwnedDataFolder(a)).toBe('marked');
    fs.mkdirSync(b);
    fs.writeFileSync(path.join(b, 'x'), 'x');
    expect(() => ensureOwnedDataFolder(b)).toThrow(DataDirNotOursError);
  });
});

describe('reparse points that are not symbolic links or junctions (Windows)', () => {
  const markedDir = () => {
    const dir = path.join(root, 'Burrow Data');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, DATA_MARKER_FILE), markerContent());
    return dir;
  };

  it.runIf(process.platform === 'win32')('libuv reports a real junction as a link in the listing of its parent (the signal the check relies on)', (ctx) => {
    const target = path.join(root, 'real');
    fs.mkdirSync(target);
    if (!makeLink(target, path.join(root, 'linked'))) ctx.skip('this machine does not let the test create a junction');
    const entries = fs.readdirSync(root, { withFileTypes: true });
    expect(entries.find((e) => e.name === 'linked').isSymbolicLink()).toBe(true);
    expect(entries.find((e) => e.name === 'real').isSymbolicLink()).toBe(false);
  });

  it('refuses a folder whose entry in the parent listing is a link although lstat says directory, with its own reason', () => {
    const dir = markedDir();
    const fake = fsWith({
      readdirSync: (p, o) =>
        path.resolve(String(p)) === root && o?.withFileTypes
          ? fs.readdirSync(p, o).map((e) => (e.name === 'Burrow Data' ? { name: e.name, isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false } : e))
          : fs.readdirSync(p, o),
    });
    const before = snapshot(dir);
    expect(inspectDataFolder(dir, { fsImpl: fake, platform: 'win32' })).toEqual({ state: 'refused', reason: 'reparse' });
    expect(() => ensureOwnedDataFolder(dir, { fsImpl: fake, platform: 'win32' })).toThrow(expect.objectContaining({ code: 'data_dir_not_ours', reason: 'reparse' }));
    expect(snapshot(dir)).toEqual(before);
    // The same folder on a plain listing is fine.
    expect(inspectDataFolder(dir, { platform: 'win32' })).toEqual({ state: 'marked' });
  });

  it('refuses a folder whose real path is not its parent plus its name', () => {
    const dir = markedDir();
    const realpathSync = Object.assign((p) => fs.realpathSync(p), {
      native: (p) => (path.resolve(String(p)) === dir ? path.join(root, 'somewhere-else') : fs.realpathSync.native(p)),
    });
    expect(inspectDataFolder(dir, { fsImpl: fsWith({ realpathSync }), platform: 'win32' })).toEqual({ state: 'refused', reason: 'reparse' });
  });

  it('fails closed when the parent listing or the real path cannot be read', () => {
    const dir = markedDir();
    const noList = fsWith({
      readdirSync: (p, o) => {
        if (path.resolve(String(p)) === root) throw denied();
        return fs.readdirSync(p, o);
      },
    });
    expect(inspectDataFolder(dir, { fsImpl: noList, platform: 'win32' })).toEqual({ state: 'refused', reason: 'unreadable' });
    const noReal = fsWith({
      realpathSync: Object.assign((p) => fs.realpathSync(p), {
        native: () => {
          throw denied();
        },
      }),
    });
    expect(inspectDataFolder(dir, { fsImpl: noReal, platform: 'win32' })).toEqual({ state: 'refused', reason: 'unreadable' });
  });

  it('does not run the extra check outside Windows, where lstat already sees every link', () => {
    const dir = markedDir();
    const fake = fsWith({
      readdirSync: (p, o) => (path.resolve(String(p)) === root && o?.withFileTypes ? [{ name: 'Burrow Data', isSymbolicLink: () => true }] : fs.readdirSync(p, o)),
    });
    expect(inspectDataFolder(dir, { fsImpl: fake, platform: 'linux' })).toEqual({ state: 'marked' });
  });

  it('refuses a marker that the listing reports as a link or a folder', () => {
    const dir = markedDir();
    const fake = fsWith({
      readdirSync: (p, o) =>
        path.resolve(String(p)) === dir && o?.withFileTypes
          ? [{ name: DATA_MARKER_FILE, isFile: () => false, isSymbolicLink: () => true, isDirectory: () => false }]
          : fs.readdirSync(p, o),
    });
    expect(inspectDataFolder(dir, { fsImpl: fake, platform: 'linux' })).toEqual({ state: 'refused', reason: 'bad_marker' });
  });
});

describe('creating the folder', () => {
  it('uses one non-recursive mkdir, and a missing parent is a create failure, never "already exists"', () => {
    const dir = path.join(root, 'no-profile', 'Burrow Data');
    const calls = [];
    const spy = fsWith({
      mkdirSync: (...args) => {
        calls.push(args);
        return fs.mkdirSync(...args);
      },
    });
    let error;
    try {
      ensureOwnedDataFolder(dir, { fsImpl: spy });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DataDirNotOursError);
    expect(error.reason).toBe('create_failed');
    expect(error.message).toMatch(/could not create or mark its data folder/);
    expect(error.message).not.toMatch(/already exists/);
    expect(calls).toHaveLength(1);
    expect(calls[0][1].recursive).toBeUndefined();
    expect(fs.existsSync(path.join(root, 'no-profile'))).toBe(false);
  });

  it('reports a denied mkdir and a denied marker write as create failures', () => {
    const dir = path.join(root, 'Burrow Data');
    const noMkdir = fsWith({
      mkdirSync: () => {
        throw denied();
      },
    });
    expect(() => ensureOwnedDataFolder(dir, { fsImpl: noMkdir })).toThrow(expect.objectContaining({ reason: 'create_failed' }));
    expect(fs.existsSync(dir)).toBe(false);
    const noWrite = fsWith({
      writeFileSync: () => {
        throw denied();
      },
    });
    expect(() => ensureOwnedDataFolder(dir, { fsImpl: noWrite })).toThrow(expect.objectContaining({ reason: 'create_failed' }));
  });

  it('inspects again when somebody else created the folder first (EEXIST) instead of writing into it', () => {
    const raced = (fill) =>
      fsWith({
        mkdirSync: (p, o) => {
          fs.mkdirSync(p, o);
          fill(p);
          throw exists();
        },
      });
    // The other process also wrote a valid marker: the folder is used and nothing changes.
    const a = path.join(root, 'a');
    expect(ensureOwnedDataFolder(a, { fsImpl: raced((p) => fs.writeFileSync(path.join(p, DATA_MARKER_FILE), markerContent())) })).toBe('marked');
    // The other process put its own files there: refused, byte-for-byte unchanged, no marker.
    const b = path.join(root, 'b');
    expect(() => ensureOwnedDataFolder(b, { fsImpl: raced((p) => fs.writeFileSync(path.join(p, 'theirs.txt'), 'theirs')) })).toThrow(expect.objectContaining({ reason: 'not_empty' }));
    expect(fs.readdirSync(b)).toEqual(['theirs.txt']);
    // The other process created an empty folder: adopted like any empty folder.
    const c = path.join(root, 'c');
    expect(ensureOwnedDataFolder(c, { fsImpl: raced(() => {}) })).toBe('adopted');
    expect(fs.readdirSync(c)).toEqual([DATA_MARKER_FILE]);
    // EEXIST but nothing there at all: a create failure, not a folder that is ours.
    const ghost = fsWith({
      mkdirSync: () => {
        throw exists();
      },
    });
    expect(() => ensureOwnedDataFolder(path.join(root, 'd'), { fsImpl: ghost })).toThrow(expect.objectContaining({ reason: 'create_failed' }));
  });

  it('accepts a valid marker that appears between our look at an empty folder and our exclusive write, and refuses a corrupt one', () => {
    const racing = (body) =>
      fsWith({
        writeFileSync: (file, content, opts) => {
          fs.writeFileSync(file, body);
          return fs.writeFileSync(file, content, opts); // flag wx: now throws EEXIST
        },
      });
    const ours = path.join(root, 'ours');
    fs.mkdirSync(ours);
    expect(ensureOwnedDataFolder(ours, { fsImpl: racing(markerContent()) })).toBe('marked');
    const corrupt = path.join(root, 'corrupt');
    fs.mkdirSync(corrupt);
    expect(() => ensureOwnedDataFolder(corrupt, { fsImpl: racing('{nope') })).toThrow(expect.objectContaining({ reason: 'bad_marker' }));
    expect(fs.readFileSync(path.join(corrupt, DATA_MARKER_FILE), 'utf8')).toBe('{nope');
  });
});

describe('messages', () => {
  it('say the same thing as the Rust shell, with their own wording for links, other reparse points and a failed create', () => {
    const dir = 'C:\\Users\\example\\Burrow Data';
    const head = `Burrow did not start because the folder ${dir} already exists and is not a Burrow data folder`;
    const tail = 'Burrow did not change anything in it. Rename or move that folder, then start Burrow again, or contact support.';
    expect(notOursMessage(dir, 'not_empty')).toBe(`${head} (it already holds other files). ${tail}`);
    expect(notOursMessage(dir, 'link')).toBe(`${head} (it is a shortcut, symbolic link or junction). ${tail}`);
    expect(notOursMessage(dir, 'reparse')).toBe(`${head} (it is a cloud or other special folder (reparse point)). ${tail}`);
    expect(notOursMessage(dir, 'create_failed')).toBe(
      `Burrow did not start because it could not create or mark its data folder ${dir}. Check that the folder above it exists and that you can write to it, then start Burrow again, or contact support.`,
    );
  });
});

describe('ensureDataDirOwnership and getDataDir', () => {
  const profileEnv = (home) => ({ USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming') });
  const storeProfile = { platform: 'win32', distribution: 'store', dataLocation: 'userprofile', channel: 'stable' };

  it.runIf(process.platform === 'win32')('checks the user profile folder before getDataDir creates anything', () => {
    const home = path.join(root, 'home');
    fs.mkdirSync(path.join(home, 'Burrow Data'), { recursive: true });
    fs.writeFileSync(path.join(home, 'Burrow Data', 'precious.txt'), 'mine');
    const mkdirCalls = [];
    const opts = { env: profileEnv(home), home, ...storeProfile, mkdir: (...args) => mkdirCalls.push(args) };
    expect(() => getDataDir(opts)).toThrow(DataDirNotOursError);
    expect(mkdirCalls).toEqual([]);
    expect(fs.readdirSync(path.join(home, 'Burrow Data'))).toEqual(['precious.txt']);
  });

  it.runIf(process.platform === 'win32')('gives a marked folder back and writes the marker of a new one', () => {
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    const opts = { env: profileEnv(home), home, ...storeProfile };
    expect(getDataDir(opts).toLowerCase()).toBe(path.join(home, 'Burrow Data').toLowerCase());
    expect(hasOwnershipMarker(path.join(home, 'Burrow Data'))).toBe(true);
  });

  it('has no rule for appdata, direct, Dev, other systems or a BURROW_DATA_DIR override', () => {
    const home = path.join(root, 'home');
    const env = profileEnv(home);
    expect(ensureDataDirOwnership({ env, home, platform: 'win32', distribution: 'store', dataLocation: 'appdata', channel: 'stable' })).toBeNull();
    expect(ensureDataDirOwnership({ env, home, platform: 'win32', distribution: 'direct', dataLocation: 'userprofile', channel: 'stable' })).toBeNull();
    expect(ensureDataDirOwnership({ env, home, ...storeProfile, channel: 'dev' })).toBeNull();
    expect(ensureDataDirOwnership({ env, home, ...storeProfile, platform: 'linux' })).toBeNull();
    expect(ensureDataDirOwnership({ env: { ...env, BURROW_DATA_DIR: path.join(root, 'elsewhere') }, home, ...storeProfile })).toBeNull();
    expect(fs.existsSync(home)).toBe(false);
  });
});
