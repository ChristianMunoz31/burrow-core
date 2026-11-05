// Import limits and shapes of the Folders tables that the main archive test does not reach: more than 20 folders
// beside folders that already exist, more than 5000 files in one folder, a duplicate path inside one archive, upper
// case ids, and an older archive that has no Folders tables at all.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';

vi.mock('../../loadEnv.js', () => ({}));

import path from 'node:path';
import { count, select } from '../db/index.js';
import { LIMITS } from '../folders/constants.js';
import { insertFolder } from '../folders/store.js';
import { importZipBuffer } from '../import/importExport.js';
import { makeTmp, rmTree } from './helpers/foldersEnv.js';
import { closeTestDb, createTestDb, resetDb } from './helpers/testDb.js';

let dest;
let root;

const fid = (i) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`;
const xid = (i) => `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, '0')}`;
const folder = (i, over = {}) => ({ id: fid(i), name: `Folder ${i}`, path: path.join(root, `p${i}`), ...over });
const file = (i, folderId, over = {}) => ({ id: xid(i), folder_id: folderId, rel_path: `f${i}.txt`, ext: 'txt', kind: 'text', status: 'ok', size_bytes: 1, summary_status: 'none', ...over });
function craft(folders, files, { manifestTables } = {}) {
  const tables = manifestTables ?? [{ id: 'folders' }, { id: 'folder_files' }];
  const entries = { 'manifest.json': strToU8(JSON.stringify({ format: 'burrow-export', formatVersion: 2, exportedAt: '2026-10-08T00:00:00.000Z', tables })) };
  if (folders) entries['json/folders.json'] = strToU8(JSON.stringify(folders));
  if (files) entries['json/folder_files.json'] = strToU8(JSON.stringify(files));
  return zipSync(entries);
}
const tableResult = (result, id) => result.tables.find((t) => t.id === id);

beforeAll(() => {
  dest = createTestDb();
  root = makeTmp('burrow-folders-archive-limits-');
});
afterAll(() => {
  closeTestDb(dest);
  rmTree(root);
});
beforeEach(() => resetDb(dest));

describe('import limits', () => {
  it('counts the folders already on this computer toward the limit of 20', async () => {
    for (let i = 0; i < 15; i += 1) insertFolder({ name: `Local ${i}`, path: path.join(root, `local${i}`), pathKey: `local-key-${i}` });
    const result = importZipBuffer(craft(Array.from({ length: 10 }, (_, i) => folder(i)), []), { db: dest });
    expect(tableResult(result, 'folders')).toMatchObject({ inserted: 5, skipped: 5 });
    expect(result.foldersToConfirm).toBe(5);
    expect(count('folders', { db: dest })).toBe(LIMITS.maxFolders);
  });

  it('skips a second imported folder with the same path inside one archive', () => {
    const same = path.join(root, 'same');
    const result = importZipBuffer(craft([folder(1, { path: same }), folder(2, { path: same })], []), { db: dest });
    expect(tableResult(result, 'folders')).toMatchObject({ inserted: 1, skipped: 1 });
    expect(select('folders', { db: dest }).map((r) => r.id)).toEqual([fid(1)]);
  });

  it('reads upper case ids as the same ids, so a re-import is still a no-op', () => {
    const upper = (v) => v.toUpperCase();
    const zip = craft([folder(1, { id: upper(fid(1)) })], [file(1, upper(fid(1)), { id: upper(xid(1)) })]);
    const first = importZipBuffer(zip, { db: dest });
    expect(tableResult(first, 'folders').inserted).toBe(1);
    expect(tableResult(first, 'folder_files').inserted).toBe(1);
    const second = importZipBuffer(zip, { db: dest });
    expect(tableResult(second, 'folders')).toMatchObject({ inserted: 0, skipped: 1 });
    expect(tableResult(second, 'folder_files')).toMatchObject({ inserted: 0, skipped: 1 });
    expect(count('folders', { db: dest })).toBe(1);
    expect(count('folder_files', { db: dest })).toBe(1);
  });

  it('keeps at most 5000 files per folder and counts each extra file as invalid', () => {
    const total = LIMITS.maxFiles + 120;
    const files = Array.from({ length: total }, (_, i) => file(i, fid(1)));
    const result = importZipBuffer(craft([folder(1)], files), { db: dest });
    const t = tableResult(result, 'folder_files');
    expect(t.inserted).toBe(LIMITS.maxFiles);
    expect(t.skipped).toBe(120);
    expect(t.skippedReasons).toMatchObject({ invalid: 120 });
    expect(count('folder_files', { db: dest })).toBe(LIMITS.maxFiles);
  });

  it('applies the 5000 file limit per folder, not per archive', () => {
    const files = [
      ...Array.from({ length: LIMITS.maxFiles }, (_, i) => file(i, fid(1))),
      ...Array.from({ length: 50 }, (_, i) => file(10_000 + i, fid(2), { rel_path: `g${i}.txt` })),
    ];
    const result = importZipBuffer(craft([folder(1), folder(2)], files), { db: dest });
    expect(tableResult(result, 'folder_files')).toMatchObject({ inserted: LIMITS.maxFiles + 50, skipped: 0 });
  });

  it('imports a v2 archive whose manifest lists no Folders tables, and one that lists them with no data files', () => {
    const none = importZipBuffer(craft(null, null, { manifestTables: [] }), { db: dest });
    expect(none.foldersToConfirm).toBe(0);
    expect(count('folders', { db: dest })).toBe(0);
    const listedOnly = importZipBuffer(craft(null, null), { db: dest });
    expect(listedOnly.foldersToConfirm).toBe(0);
    expect(count('folders', { db: dest })).toBe(0);
  });
});
