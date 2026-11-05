// readTextFile and its helpers: what counts as text, how it is decoded, the counts, and that reading never changes a file.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeText, readTextFile, sniffBinary, textStats } from '../folders/extract.js';
import { makeTmp, rmTree, tryFileLink } from './helpers/foldersEnv.js';

let dir;
let key;
const WIN = process.platform === 'win32';
const fold = (p) => (WIN ? p.toLowerCase() : p);
const put = (name, content) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
};
const read = (file, opts = {}) => readTextFile(file, { rootKey: key, ...opts });
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

beforeAll(() => {
  dir = fs.realpathSync.native(makeTmp('burrow-folders-extract-'));
  key = fold(dir);
});
afterAll(() => rmTree(dir));

describe('textStats', () => {
  it.each([
    ['', { lines: 0, words: 0, chars: 0 }],
    ['one', { lines: 1, words: 1, chars: 3 }],
    ['a b\nc', { lines: 2, words: 3, chars: 5 }],
    ['a\nb\n', { lines: 2, words: 2, chars: 4 }],
    ['a\r\nb\r\n', { lines: 2, words: 2, chars: 6 }],
    ['a\rb', { lines: 2, words: 2, chars: 3 }],
    ['\n\n', { lines: 2, words: 0, chars: 2 }],
    ['  spaced   out  ', { lines: 1, words: 2, chars: 16 }],
  ])('counts %j', (text, expected) => {
    expect(textStats(text)).toEqual(expected);
  });
});

describe('sniffBinary and decodeText', () => {
  it('a NUL byte in the first 8 KB is binary; one after 8 KB is not', () => {
    expect(sniffBinary(Buffer.from([65, 0, 66]))).toBe(true);
    expect(sniffBinary(Buffer.concat([Buffer.alloc(8192, 65), Buffer.from([0])]))).toBe(false);
    expect(sniffBinary(Buffer.from('plain text'))).toBe(false);
  });

  it('a UTF-16 BOM makes NUL bytes legitimate', () => {
    expect(sniffBinary(Buffer.from([0xff, 0xfe, 65, 0]))).toBe(false);
    expect(sniffBinary(Buffer.from([0xfe, 0xff, 0, 65]))).toBe(false);
  });

  it('strips a UTF-8 BOM', () => {
    expect(decodeText(Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('héllo')]))).toBe('héllo');
  });

  it('decodes UTF-16 little and big endian with a BOM', () => {
    expect(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi there', 'utf16le')]))).toBe('hi there');
    const be = Buffer.from('hi there', 'utf16le').swap16();
    expect(decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))).toBe('hi there');
  });

  it('falls back to Latin-1 for invalid UTF-8', () => {
    expect(decodeText(Buffer.from([0x63, 0x61, 0x66, 0xe9]))).toBe('café');
  });

  it('keeps valid multi-byte UTF-8', () => {
    expect(decodeText(Buffer.from('日本語 text'))).toBe('日本語 text');
  });
});

describe('readTextFile', () => {
  it('reads a text file: text, sha256 of the raw bytes, size, ISO modified time and counts', async () => {
    const bytes = Buffer.from('Hello world\nsecond line here\n');
    const file = put('a.txt', bytes);
    const res = await read(file);
    expect(res).toMatchObject({ status: 'ok', text: bytes.toString('utf8'), sha256: sha(bytes), sizeBytes: bytes.length, lines: 2, words: 5, chars: bytes.length });
    expect(res.mtime).toBe(new Date(fs.statSync(file).mtimeMs).toISOString());
  });

  it('is read-only: bytes, size and modified time are unchanged afterwards', async () => {
    const file = put('ro.txt', 'keep me exactly as I am\n');
    const old = new Date('2020-01-02T03:04:05.000Z');
    fs.utimesSync(file, old, old);
    const before = { bytes: fs.readFileSync(file), st: fs.statSync(file) };
    await read(file);
    await read(file);
    const after = { bytes: fs.readFileSync(file), st: fs.statSync(file) };
    expect(after.bytes.equals(before.bytes)).toBe(true);
    expect(after.st.mtimeMs).toBe(before.st.mtimeMs);
    expect(after.st.size).toBe(before.st.size);
    expect(fs.readdirSync(dir).filter((n) => n.startsWith('ro'))).toEqual(['ro.txt']);
  });

  it('reads a file marked read-only by the OS (the read flag only is used)', async () => {
    const file = put('locked.txt', 'readable');
    fs.chmodSync(file, 0o444);
    expect((await read(file)).status).toBe('ok');
    fs.chmodSync(file, 0o644);
  });

  it('a binary file (NUL byte) is `binary`, with its size but no text and no hash', async () => {
    const bytes = Buffer.from([65, 0, 66, 0, 67, 0]);
    const res = await read(put('b.txt', bytes));
    expect(res).toMatchObject({ status: 'binary', sizeBytes: 6 });
    expect(res.text).toBeUndefined();
    expect(res.sha256).toBeUndefined();
  });

  it('decodes a UTF-16 file with a BOM as text', async () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('wide text\nline two', 'utf16le')]);
    const res = await read(put('wide.txt', bytes));
    expect(res).toMatchObject({ status: 'ok', text: 'wide text\nline two', lines: 2, words: 4 });
  });

  it('strips a UTF-8 BOM from the text and the counts, but hashes the raw bytes', async () => {
    const bytes = Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('bom here')]);
    const res = await read(put('bom.txt', bytes));
    expect(res).toMatchObject({ status: 'ok', text: 'bom here', chars: 8, sha256: sha(bytes) });
  });

  it('a file over the limit is `too_large` and its text is not returned', async () => {
    const res = await read(put('big.txt', 'x'.repeat(200)), { maxBytes: 100 });
    expect(res).toMatchObject({ status: 'too_large', sizeBytes: 200 });
    expect(res.text).toBeUndefined();
  });

  it('a file exactly at the limit is read', async () => {
    expect((await read(put('edge.txt', 'x'.repeat(100)), { maxBytes: 100 })).status).toBe('ok');
  });

  it('an empty file is `empty` with zero counts and the hash of nothing', async () => {
    const res = await read(put('empty.txt', ''));
    expect(res).toMatchObject({ status: 'empty', sizeBytes: 0, lines: 0, words: 0, chars: 0, sha256: sha(Buffer.alloc(0)) });
  });

  it('a file of only whitespace is `empty`', async () => {
    expect(await read(put('blank.txt', '  \n\n \t\n'))).toMatchObject({ status: 'empty', words: 0 });
  });

  it('a missing file, and a folder, are `unreadable`', async () => {
    expect((await read(path.join(dir, 'nope.txt'))).status).toBe('unreadable');
    fs.mkdirSync(path.join(dir, 'adir'), { recursive: true });
    expect((await read(path.join(dir, 'adir'))).status).toBe('unreadable');
  });

  it('a file that is not inside the root is `outside_root` and is never read', async () => {
    const other = makeTmp('burrow-folders-extract-other-');
    try {
      const file = path.join(other, 'secret.txt');
      fs.writeFileSync(file, 'SECRET_TEXT');
      const res = await read(file);
      expect(res.status).toBe('outside_root');
      expect(res.text).toBeUndefined();
    } finally {
      rmTree(other);
    }
  });

  it('a file symlink inside the root that points outside is `outside_root`', async () => {
    const other = makeTmp('burrow-folders-extract-other-');
    try {
      fs.writeFileSync(path.join(other, 'secret.txt'), 'SECRET_TEXT');
      if (!tryFileLink(path.join(other, 'secret.txt'), path.join(dir, 'sneaky.txt'))) return;
      const res = await read(path.join(dir, 'sneaky.txt'));
      expect(res.status).toBe('outside_root');
      expect(res.text).toBeUndefined();
    } finally {
      rmTree(other);
    }
  });

  it('the same content gives the same hash, different content a different one', async () => {
    const a = await read(put('h1.txt', 'same'));
    const b = await read(put('h2.txt', 'same'));
    const c = await read(put('h3.txt', 'diff'));
    expect(a.sha256).toBe(b.sha256);
    expect(a.sha256).not.toBe(c.sha256);
  });
});
