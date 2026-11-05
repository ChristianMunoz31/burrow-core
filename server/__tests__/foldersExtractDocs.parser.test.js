// Parser worker tests: they need document parsing on and start real parser workers, so they run only in `npm run test:parser`
// (vitest.parser.config.js, issue #67) and return to the default suite when the parser runs in its own process.
// readTextFile on a PDF that cannot be opened right now (a transient doc_unavailable failure).
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readTextFile } from '../folders/extract.js';
import { makeTmp, rmTree } from './helpers/foldersEnv.js';

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

beforeAll(() => {
  dir = fs.realpathSync.native(makeTmp('burrow-folders-extract-'));
  key = fold(dir);
});
afterAll(() => rmTree(dir));

describe('a document that cannot be opened right now', () => {
  it('is unreadable with a transient failure code, so the next scan tries it again', async () => {
    const file = put('locked.pdf', Buffer.from('%PDF-1.4\n%%EOF\n'));
    const text = put('locked.txt', 'plain text');
    const open = fs.promises.open;
    fs.promises.open = async () => {
      throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
    };
    try {
      expect(await read(file)).toMatchObject({ status: 'unreadable', docFailure: 'doc_unavailable' });
      const plain = await read(text);
      expect(plain.status).toBe('unreadable');
      expect(plain).not.toHaveProperty('docFailure');
    } finally {
      fs.promises.open = open;
    }
  });
});
