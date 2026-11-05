// The Folders tables and the store functions on top of them (real SQLite): constraints, upserts that keep identity,
// unseen-file clean-up, paging, atomic chunk replacement and cascades; plus the row to view conversions.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { count, select, withTransaction } from '../db/index.js';
import { FOLDER_MESSAGES, FOLDER_STATUS, FolderError } from '../folders/constants.js';
import {
  allFileRows,
  countIndex,
  deleteFileChunks,
  deleteUnseenFiles,
  getChunkTexts,
  getFile,
  getFolder,
  insertFolder,
  listChunkVectors,
  listFiles,
  listFolders,
  removeFolder,
  replaceFileChunks,
  updateFile,
  updateFolder,
  upsertFileRows,
} from '../folders/store.js';
import { parseJobError, stringifyJobError, toFileView, toFolderView } from '../folders/views.js';
import { folderCsv, folderJson, folderMarkdown } from '../folders/exportReport.js';
import { closeTestDb, createTestDb, resetDb } from './helpers/testDb.js';

let db;
beforeAll(() => {
  db = createTestDb();
});
afterAll(() => closeTestDb(db));
beforeEach(() => resetDb(db));

const mkFolder = (name = 'Notes', key = name.toLowerCase()) => insertFolder({ name, path: `C:/x/${name}`, pathKey: key });
const fileRow = (rel, over = {}) => ({ rel_path: rel, ext: 'txt', kind: 'text', status: 'ok', size_bytes: 10, ...over });
// Two little-endian float32 values (1 and 1), the stored form of a 2-dimension vector.
const EMBEDDING = 'AACAPwAAgD8=';
const chunk = (seq, text = `chunk ${seq}`) => ({ seq, startLine: seq + 1, endLine: seq + 2, text, embedding: EMBEDDING, dims: 2 });

describe('folders', () => {
  it('inserts with defaults and a generated id and timestamps', () => {
    const f = mkFolder();
    expect(f).toMatchObject({ name: 'Notes', path: 'C:/x/Notes', path_key: 'notes', auto_rescan: false, stats: {}, summary: null, summary_status: 'none', report: null, last_scan_at: null, last_job_status: null });
    expect(f.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(f.created_at).toEqual(expect.any(String));
    expect(f.updated_at).toEqual(expect.any(String));
  });

  it('path_key is unique', () => {
    mkFolder('A', 'same');
    expect(() => mkFolder('B', 'same')).toThrow();
  });

  it('the name must be 1 to 120 characters and the path 1 to 1024', () => {
    expect(() => insertFolder({ name: '', path: 'p', pathKey: 'k1' })).toThrow();
    expect(() => insertFolder({ name: 'n'.repeat(121), path: 'p', pathKey: 'k2' })).toThrow();
    expect(() => insertFolder({ name: 'ok', path: '', pathKey: 'k3' })).toThrow();
    expect(() => insertFolder({ name: 'ok', path: 'p'.repeat(1025), pathKey: 'k4' })).toThrow();
    expect(insertFolder({ name: 'n'.repeat(120), path: 'p'.repeat(1024), pathKey: 'k5' }).id).toBeTruthy();
  });

  it('lists oldest first and gets one by id', async () => {
    const a = mkFolder('A');
    await new Promise((r) => setTimeout(r, 5)); // created_at has millisecond resolution
    const b = mkFolder('B');
    expect(listFolders().map((f) => f.id)).toEqual([a.id, b.id]);
    expect(getFolder(b.id).name).toBe('B');
    expect(getFolder('00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('updateFolder patches the row and moves updated_at', async () => {
    const f = mkFolder();
    await new Promise((r) => setTimeout(r, 5));
    const after = updateFolder(f.id, { name: 'Renamed', auto_rescan: true, stats: { filesTotal: 3 } });
    expect(after).toMatchObject({ name: 'Renamed', auto_rescan: true, stats: { filesTotal: 3 } });
    expect(after.updated_at > f.updated_at).toBe(true);
    expect(after.created_at).toBe(f.created_at);
  });

  it('removeFolder deletes its files and chunks (cascade)', () => {
    const f = mkFolder();
    const [file] = upsertFileRows(f.id, [fileRow('a.txt')]);
    replaceFileChunks(file.id, f.id, [chunk(0), chunk(1)], { chunk_count: 2 });
    expect(removeFolder(f.id)).toBe(1);
    expect(count('folder_files')).toBe(0);
    expect(count('folder_chunks')).toBe(0);
    expect(removeFolder(f.id)).toBe(0);
  });

  it('a file row needs an existing folder', () => {
    expect(() => upsertFileRows('00000000-0000-4000-8000-000000000000', [fileRow('a.txt')])).toThrow();
  });
});

describe('upsertFileRows', () => {
  it('inserts, and updates by (folder, path) keeping the id and created_at and any column left out', () => {
    const f = mkFolder();
    const [first] = upsertFileRows(f.id, [fileRow('a.txt', { size_bytes: 5, summary: 'kept', summary_status: 'ok' })]);
    const [second] = upsertFileRows(f.id, [fileRow('a.txt', { size_bytes: 9 })]);
    expect(second.id).toBe(first.id);
    expect(second.created_at).toBe(first.created_at);
    expect(second).toMatchObject({ size_bytes: 9, summary: 'kept', summary_status: 'ok' });
    expect(count('folder_files')).toBe(1);
  });

  it('the same path in two folders is two rows', () => {
    const a = mkFolder('A');
    const b = mkFolder('B');
    upsertFileRows(a.id, [fileRow('x.txt')]);
    upsertFileRows(b.id, [fileRow('x.txt')]);
    expect(count('folder_files')).toBe(2);
  });

  it('writes more than one batch of 100 and returns the rows in input order', () => {
    const f = mkFolder();
    const rows = Array.from({ length: 250 }, (_v, i) => fileRow(`f${String(i).padStart(3, '0')}.txt`));
    const out = upsertFileRows(f.id, rows);
    expect(out).toHaveLength(250);
    expect(out.map((r) => r.rel_path)).toEqual(rows.map((r) => r.rel_path));
    expect(count('folder_files', { where: { folder_id: f.id } })).toBe(250);
  });

  it('a bad row rolls back its whole batch of 100', () => {
    const f = mkFolder();
    const rows = Array.from({ length: 5 }, (_v, i) => fileRow(`ok${i}.txt`));
    rows.push(fileRow('', {})); // rel_path must not be empty
    expect(() => upsertFileRows(f.id, rows)).toThrow();
    expect(count('folder_files')).toBe(0);
  });

  it('the path is at most 1024 characters', () => {
    const f = mkFolder();
    expect(() => upsertFileRows(f.id, [fileRow('p'.repeat(1025))])).toThrow();
  });
});

describe('deleteUnseenFiles', () => {
  it('removes rows not seen since the scan began, and rows never seen, with their chunks', () => {
    const f = mkFolder();
    const [kept, stale, never] = upsertFileRows(f.id, [
      fileRow('kept.txt', { seen_at: '2026-10-08T10:00:00.000Z' }),
      fileRow('stale.txt', { seen_at: '2026-10-07T10:00:00.000Z' }),
      fileRow('never.txt'),
    ]);
    replaceFileChunks(stale.id, f.id, [chunk(0)], { chunk_count: 1 });
    expect(deleteUnseenFiles(f.id, '2026-10-08T10:00:00.000Z')).toBe(2);
    expect(allFileRows(f.id).map((r) => r.rel_path)).toEqual(['kept.txt']);
    expect(count('folder_chunks')).toBe(0);
    expect(kept.id).toBeTruthy();
    expect(never.id).toBeTruthy();
  });

  it('only touches the given folder', () => {
    const a = mkFolder('A');
    const b = mkFolder('B');
    upsertFileRows(a.id, [fileRow('x.txt')]);
    upsertFileRows(b.id, [fileRow('y.txt')]);
    deleteUnseenFiles(a.id, '2999-01-01T00:00:00.000Z');
    expect(count('folder_files', { where: { folder_id: b.id } })).toBe(1);
  });
});

describe('listFiles', () => {
  const setup = () => {
    const f = mkFolder();
    upsertFileRows(f.id, [
      fileRow('b.txt', { size_bytes: 20, mtime: '2026-01-02T00:00:00.000Z', status: 'ok' }),
      fileRow('A.txt', { size_bytes: 10, mtime: '2026-01-03T00:00:00.000Z', status: 'binary' }),
      fileRow('c.txt', { size_bytes: 20, mtime: '2026-01-01T00:00:00.000Z', status: 'ok' }),
    ]);
    return f;
  };

  it('sorts by path ignoring case, with the total', () => {
    const f = setup();
    const { rows, total } = listFiles(f.id);
    expect(total).toBe(3);
    expect(rows.map((r) => r.rel_path)).toEqual(['A.txt', 'b.txt', 'c.txt']);
  });

  it('sorts by size with ties by path, and by modified time, in both directions', () => {
    const f = setup();
    expect(listFiles(f.id, { sort: 'size', dir: 'desc' }).rows.map((r) => r.rel_path)).toEqual(['b.txt', 'c.txt', 'A.txt']);
    expect(listFiles(f.id, { sort: 'modified', dir: 'asc' }).rows.map((r) => r.rel_path)).toEqual(['c.txt', 'b.txt', 'A.txt']);
    expect(listFiles(f.id, { sort: 'status', dir: 'asc' }).rows.map((r) => r.rel_path)).toEqual(['A.txt', 'b.txt', 'c.txt']);
  });

  it('an unknown sort falls back to the path', () => {
    const f = setup();
    expect(listFiles(f.id, { sort: 'nonsense' }).rows.map((r) => r.rel_path)).toEqual(['A.txt', 'b.txt', 'c.txt']);
  });

  it('pages with offset and limit', () => {
    const f = setup();
    expect(listFiles(f.id, { limit: 2 }).rows).toHaveLength(2);
    expect(listFiles(f.id, { limit: 2, offset: 2 }).rows.map((r) => r.rel_path)).toEqual(['c.txt']);
    expect(listFiles(f.id, { offset: 10 })).toMatchObject({ rows: [], total: 3 });
  });
});

describe('chunks', () => {
  function indexed() {
    const f = mkFolder();
    const [file] = upsertFileRows(f.id, [fileRow('a.txt')]);
    replaceFileChunks(file.id, f.id, [chunk(0, 'zero'), chunk(1, 'one')], { index_hash: 'h', index_model: 'm', chunk_count: 2 });
    return { f, file };
  }

  it('replaceFileChunks stores the chunks and the file index fields together', () => {
    const { f, file } = indexed();
    expect(select('folder_chunks', { where: { file_id: file.id }, orderBy: [{ column: 'seq' }] }).map((c) => [c.seq, c.start_line, c.end_line, c.text, c.dims])).toEqual([
      [0, 1, 2, 'zero', 2],
      [1, 2, 3, 'one', 2],
    ]);
    expect(getFile(file.id)).toMatchObject({ index_hash: 'h', index_model: 'm', chunk_count: 2 });
    expect(countIndex(f.id)).toEqual({ chunks: 2 });
  });

  it('replaces the old chunks instead of adding to them', () => {
    const { f, file } = indexed();
    replaceFileChunks(file.id, f.id, [chunk(0, 'fresh')], { index_hash: 'h2', chunk_count: 1 });
    expect(select('folder_chunks', { where: { file_id: file.id } }).map((c) => c.text)).toEqual(['fresh']);
    expect(getFile(file.id).index_hash).toBe('h2');
  });

  it('is atomic: a failing insert keeps the old chunks and the old file fields', () => {
    const { f, file } = indexed();
    expect(() => replaceFileChunks(file.id, f.id, [chunk(0, 'new'), chunk(0, 'duplicate seq')], { index_hash: 'broken', chunk_count: 2 })).toThrow();
    expect(select('folder_chunks', { where: { file_id: file.id }, orderBy: [{ column: 'seq' }] }).map((c) => c.text)).toEqual(['zero', 'one']);
    expect(getFile(file.id)).toMatchObject({ index_hash: 'h', chunk_count: 2 });
  });

  it('listChunkVectors leaves the text out; getChunkTexts finds text by id', () => {
    const { f } = indexed();
    const vectors = listChunkVectors(f.id);
    expect(vectors).toHaveLength(2);
    expect(Object.keys(vectors[0]).sort()).toEqual(['dims', 'embedding', 'end_line', 'file_id', 'id', 'seq', 'start_line']);
    const texts = getChunkTexts(vectors.map((v) => v.id));
    expect([...texts.values()].sort()).toEqual(['one', 'zero']);
    expect(getChunkTexts([]).size).toBe(0);
    expect(getChunkTexts(['00000000-0000-4000-8000-000000000000']).size).toBe(0);
  });

  it('deleteFileChunks removes one file only', () => {
    const { f, file } = indexed();
    const [other] = upsertFileRows(f.id, [fileRow('b.txt')]);
    replaceFileChunks(other.id, f.id, [chunk(0, 'other')], { chunk_count: 1 });
    expect(deleteFileChunks(file.id)).toBe(2);
    expect(count('folder_chunks')).toBe(1);
  });

  it('a file cannot have the same seq twice and a chunk needs its file and folder', () => {
    const { f, file } = indexed();
    expect(() => withTransaction(() => replaceFileChunks(file.id, '00000000-0000-4000-8000-000000000000', [chunk(0)], {}))).toThrow();
    expect(count('folder_chunks', { where: { folder_id: f.id } })).toBe(2);
  });

  it('updateFile patches one row', () => {
    const { file } = indexed();
    expect(updateFile(file.id, { summary: 'hi', summary_status: 'ok' })).toMatchObject({ summary: 'hi', summary_status: 'ok' });
  });
});

describe('job error storage', () => {
  it('round-trips a code and message, clipping long values', () => {
    expect(parseJobError(stringifyJobError({ code: 'shutdown', message: 'Closed.' }))).toEqual({ code: 'shutdown', message: 'Closed.' });
    const long = stringifyJobError({ code: 'c'.repeat(100), message: 'm'.repeat(1000) });
    const back = parseJobError(long);
    expect(back.code).toHaveLength(60);
    expect(back.message).toHaveLength(300);
    expect(stringifyJobError(null)).toBeNull();
  });

  it('falls back to the fixed copy for a known code without a message, and to null for junk', () => {
    expect(parseJobError(JSON.stringify({ code: 'folder_moved' }))).toEqual({ code: 'folder_moved', message: FOLDER_MESSAGES.folder_moved });
    expect(parseJobError(JSON.stringify({ code: 'something_else' }))).toEqual({ code: 'something_else', message: null });
    for (const junk of [null, undefined, '', 'not json', '[]', '{"message":"x"}', '42']) expect(parseJobError(junk)).toBeNull();
  });
});

describe('FolderError', () => {
  it('carries the fixed copy and status of its code, and an unknown code becomes folder_failed', () => {
    const e = new FolderError('folder_exists');
    expect(e).toMatchObject({ name: 'FolderError', code: 'folder_exists', status: 409, message: FOLDER_MESSAGES.folder_exists });
    expect(e).toBeInstanceOf(Error);
    const odd = new FolderError('made_up');
    expect(odd).toMatchObject({ code: 'folder_failed', status: 500 });
    expect(new FolderError('__proto__').code).toBe('folder_failed');
    expect(FOLDER_STATUS.folder_queue_full).toBe(429);
  });

  it('no fixed copy contains an em or en dash', () => {
    for (const message of Object.values(FOLDER_MESSAGES)) expect(message).not.toMatch(/[\u2013\u2014]/);
  });
});

describe('views and exports of stored rows', () => {
  it('toFileView hides the summary of a file that is not readable text', () => {
    expect(toFileView({ id: 'i', rel_path: 'p.png', ext: 'png', kind: 'other', status: 'unsupported', size_bytes: 3, summary: 'leftover', summary_status: 'ok' })).toMatchObject({ summary: null, summaryStatus: 'not_text', indexed: false });
  });

  it('indexed is true only for a readable file whose index matches its hash and has chunks', () => {
    const base = { id: 'i', rel_path: 'a.txt', ext: 'txt', kind: 'text', status: 'ok', size_bytes: 1, sha256: 'h', index_hash: 'h', chunk_count: 2 };
    expect(toFileView(base).indexed).toBe(true);
    expect(toFileView({ ...base, index_hash: 'old' }).indexed).toBe(false);
    expect(toFileView({ ...base, chunk_count: 0 }).indexed).toBe(false);
    expect(toFileView({ ...base, index_hash: null }).indexed).toBe(false);
  });

  it('toFolderView of a bare row has no stats and no report', () => {
    const row = mkFolder();
    expect(toFolderView(row)).toMatchObject({ stats: null, report: null, job: null, lastJob: null, summary: { status: 'none', text: null } });
  });

  it('exports of a folder with no files are well formed', () => {
    const row = updateFolder(mkFolder().id, { last_scan_at: '2026-10-08T10:00:00.000Z' });
    expect(folderMarkdown(row, [])).toContain('## Files');
    expect(JSON.parse(folderJson(row, [], new Date('2026-10-08T12:00:00Z'))).exportedAt).toBe('2026-10-08T12:00:00.000Z');
    expect(folderCsv([])).toBe('Path,Extension,Kind,Status,Size (bytes),Modified,Lines,Words,Summary\r\n');
  });

  const hostileFile = { id: 'i', rel_path: 'a\n## Heading.txt', ext: 'txt', kind: 'text', status: 'ok', size_bytes: 1, summary: 'line one\n# Fake heading', summary_status: 'ok' };

  it('Markdown keeps a hostile folder name, file name and summary on one line each', () => {
    const row = updateFolder(mkFolder('Evil\n# Injected').id, { last_scan_at: '2026-10-08T10:00:00.000Z' });
    const md = folderMarkdown(row, [hostileFile]);
    expect(md).not.toMatch(/^# Injected/m);
    expect(md).not.toMatch(/^# Fake heading/m);
    expect(md).toContain('- a ## Heading.txt (ok, 1 bytes): line one # Fake heading');
  });

  it('a file name with a line break cannot start a new Markdown line through the Largest files fact', () => {
    const row = updateFolder(mkFolder('Facts').id, { last_scan_at: '2026-10-08T10:00:00.000Z' });
    const md = folderMarkdown(row, [hostileFile]);
    expect(md).not.toMatch(/^## Heading\.txt/m);
  });
});
