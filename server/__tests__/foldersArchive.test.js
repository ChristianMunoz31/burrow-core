// Folders in the full export ZIP and in the import: what is exported, what is never exported, and the rule that an
// imported folder arrives paused (confirm_state needs_confirm, no daily re-scan, no job, an empty question index) and is
// never read until the user confirms it. The importer is insert-only and idempotent.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

vi.mock('../license/index.js', async (importOriginal) => (await import('./helpers/pro.js')).mockLicenseModule(importOriginal));
vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));

import fs from 'node:fs';
import path from 'node:path';
import fetch from 'node-fetch';
import { __resetAiForTests } from '../ai/index.js';
import { FOLDER_ARCHIVE_TABLES, count, insert, openDb, select } from '../db/index.js';
import { buildExportZip } from '../exportRoutes.js';
import { cancelAllFolderJobs, drainFolderJobs, getFolderJob, waitForFolderJob } from '../folders/jobs.js';
import { FOLDER_EXPORT_DEFS } from '../folders/archiveTables.js';
import { __setPathOptionsForTests } from '../folders/pathSafety.js';
import { getFolder, updateFolder } from '../folders/store.js';
import { importZipBuffer } from '../import/importExport.js';
import { installFakeOllama, textReply } from './helpers/fakeOllama.js';
import { COPY, errorBody, makeTmp, neutralPathOptions, rmTree, writeTree } from './helpers/foldersEnv.js';
import { resetPro } from './helpers/pro.js';
import { SAME_ORIGIN, makeDialogApp, startDialogs, stopDialogs } from './helpers/dialogHarness.js';
import { closeTestDb, createTestDb, resetDb } from './helpers/testDb.js';

const FOLDER_ID = '11111111-1111-4111-8111-111111111111';
const FILE_A = '22222222-2222-4222-8222-222222222222';
const FILE_B = '33333333-3333-4333-8333-333333333333';
const SENTINEL = 'sentinel-chunk-text-xyz';
const NO_FOLDER = '00000000-0000-4000-8000-000000000000';

let src;
let dest;
let root;
let dir;
let app;

const rows = (db, table) => select(table, { db, orderBy: [{ column: 'id', dir: 'asc' }] });
const unzip = (zip) => Object.fromEntries(Object.entries(unzipSync(zip)).map(([k, v]) => [k, strFromU8(v)]));

function seedSource() {
  insert(
    'folders',
    {
      id: FOLDER_ID,
      name: 'Garden notes',
      path: dir,
      path_key: 'real-key-on-the-old-computer',
      auto_rescan: true,
      stats: { files: 2, totalBytes: 20, index: { status: 'ready', files: 2, chunks: 3, skipped: null } },
      summary: 'A short summary.',
      summary_status: 'ok',
      summary_model: 'qwen2.5:3b',
      last_scan_at: '2026-10-01T10:00:00.000Z',
      last_job_status: 'done',
      last_job_error: '{"code":"x","message":"y"}',
      last_job_at: '2026-10-01T10:00:00.000Z',
    },
    { db: src },
  );
  for (const [id, rel, hash] of [[FILE_A, 'plan.txt', 'a'.repeat(64)], [FILE_B, 'sub/recipe.md', 'b'.repeat(64)]]) {
    insert(
      'folder_files',
      {
        id,
        folder_id: FOLDER_ID,
        rel_path: rel,
        ext: rel.split('.').pop(),
        kind: 'text',
        status: 'ok',
        size_bytes: 10,
        mtime: '2026-01-02T03:04:05.000Z',
        sha256: hash,
        line_count: 2,
        word_count: 5,
        char_count: 30,
        summary: `About ${rel}`,
        summary_status: 'ok',
        summary_hash: hash,
        summary_model: 'qwen2.5:3b',
        index_hash: hash,
        index_model: 'nomic-embed-text',
        chunk_count: 1,
        seen_at: '2026-10-01T10:00:00.000Z',
      },
      { db: src },
    );
    insert('folder_chunks', { folder_id: FOLDER_ID, file_id: id, seq: 0, start_line: 1, end_line: 2, text: `${SENTINEL} ${rel}`, embedding: 'AAAA', dims: 8 }, { db: src });
  }
}

/** A hand-made archive, like one an attacker or a newer build could produce. */
function craft(folders, files, extra = {}) {
  const tables = [{ id: 'folders' }, { id: 'folder_files' }, ...(extra.tables ?? [])];
  const entries = {
    'manifest.json': strToU8(JSON.stringify({ format: 'burrow-export', formatVersion: 2, exportedAt: '2026-10-08T00:00:00.000Z', tables })),
    'json/folders.json': strToU8(JSON.stringify(folders)),
    'json/folder_files.json': strToU8(JSON.stringify(files)),
    ...(extra.files ?? {}),
  };
  return zipSync(entries);
}
const goodFile = (over = {}) => ({ id: FILE_A, folder_id: FOLDER_ID, rel_path: 'plan.txt', ext: 'txt', kind: 'text', status: 'ok', size_bytes: 3, summary_status: 'none', ...over });
const goodFolder = (over = {}) => ({ id: FOLDER_ID, name: 'Garden notes', path: dir, ...over });

beforeAll(() => {
  dest = createTestDb();
  src = openDb({ filename: ':memory:' });
  root = makeTmp('burrow-folders-archive-');
  fs.mkdirSync(path.join(root, 'fake-home'), { recursive: true });
  dir = path.join(root, 'notes');
  writeTree(dir, { 'plan.txt': 'tomatoes\n', 'sub/recipe.md': '# Soup\n' });
});
afterAll(() => {
  __setPathOptionsForTests(null);
  src.close();
  closeTestDb(dest);
  rmTree(root);
});
beforeEach(() => {
  resetDb(dest);
  for (const t of ['folder_chunks', 'folder_files', 'folders']) src.exec(`DELETE FROM "${t}"`);
  startDialogs();
  app = makeDialogApp({ dialogsAvailable: false });
  __setPathOptionsForTests(neutralPathOptions(root));
  __resetAiForTests();
  fetch.mockReset();
  installFakeOllama(fetch, { chat: () => textReply('A short note about the files.') });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  cancelAllFolderJobs('shutdown');
  await drainFolderJobs({ timeoutMs: 2000 });
  stopDialogs();
  resetPro();
  vi.restoreAllMocks();
});

describe('the export ZIP', () => {
  it('carries folders and folder files, never the chunks, never the machine-bound columns', async () => {
    seedSource();
    const { zip, manifest } = await buildExportZip({ db: src });
    const files = unzip(zip);
    expect(manifest.formatVersion).toBe(2);
    expect(manifest.complete).toBe(true);
    expect(manifest.tables.map((t) => t.id)).toEqual(expect.arrayContaining(['folders', 'folder_files']));
    expect(manifest.tables.find((t) => t.id === 'folders')).toMatchObject({ rows: 1, files: ['json/folders.json', 'csv/folders.csv'] });
    expect(manifest.tables.find((t) => t.id === 'folder_files')).toMatchObject({ rows: 2 });
    expect(manifest.tables.some((t) => t.id === 'folder_chunks')).toBe(false);
    expect(Object.keys(files).some((name) => name.includes('folder_chunks'))).toBe(false);
    expect(manifest.excluded).toContain('folder question index (folder_chunks), rebuilt by a re-scan');
    expect(manifest.redaction).toContain('Folder paths are included.');
    expect(manifest.redaction).toContain('Imported folders stay paused until you confirm them on the Folders page.');
    expect(Object.values(files).join('\n')).not.toContain(SENTINEL);

    const folder = JSON.parse(files['json/folders.json'])[0];
    expect(Object.keys(folder).sort()).toEqual(FOLDER_EXPORT_DEFS[0].columns.map((c) => c.name).sort());
    expect(folder).toMatchObject({ id: FOLDER_ID, name: 'Garden notes', path: dir, auto_rescan: true });
    for (const key of ['path_key', 'confirm_state', 'last_job_status', 'last_job_error', 'last_job_at']) expect(folder).not.toHaveProperty(key);
    const file = JSON.parse(files['json/folder_files.json'])[0];
    expect(Object.keys(file).sort()).toEqual(FOLDER_EXPORT_DEFS[1].columns.map((c) => c.name).sort());
    for (const key of ['index_hash', 'index_model', 'chunk_count', 'seen_at']) expect(file).not.toHaveProperty(key);
    expect(files['csv/folders.csv'].split('\r\n')[0]).not.toContain('path_key');
  });

  it('is accepted by the importer as a v2 archive with the Folders tables listed after the data tables', () => {
    expect(FOLDER_ARCHIVE_TABLES).toEqual(['folders', 'folder_files']);
  });
});

describe('importing folders', () => {
  it('adds them paused, with the placeholder key, no daily re-scan, no job state and an empty index', async () => {
    seedSource();
    const { zip } = await buildExportZip({ db: src });
    const result = importZipBuffer(zip, { db: dest });
    expect(result.foldersToConfirm).toBe(1);
    expect(result.tables.find((t) => t.id === 'folders')).toMatchObject({ received: 1, inserted: 1, skipped: 0 });
    expect(result.tables.find((t) => t.id === 'folder_files')).toMatchObject({ received: 2, inserted: 2, skipped: 0 });
    expect(result.ignoredTables).toEqual([]);

    const folder = getFolder(FOLDER_ID);
    expect(folder).toMatchObject({
      name: 'Garden notes',
      path: dir,
      confirm_state: 'needs_confirm',
      path_key: `imported:${FOLDER_ID}`,
      auto_rescan: false,
      last_job_status: null,
      last_job_error: null,
      last_job_at: null,
      summary: 'A short summary.',
      summary_status: 'ok',
      last_scan_at: '2026-10-01T10:00:00.000Z',
    });
    expect(folder.stats).toEqual({ files: 2, totalBytes: 20, index: { status: 'none', files: 0, chunks: 0, skipped: null } });
    const files = rows(dest, 'folder_files');
    expect(files).toHaveLength(2);
    for (const f of files) {
      expect(f).toMatchObject({ index_hash: null, index_model: null, chunk_count: 0, seen_at: null, folder_id: FOLDER_ID, summary_status: 'ok' });
      expect(f.sha256).toMatch(/^[ab]{64}$/);
    }
    expect(count('folder_chunks', { db: dest })).toBe(0);
    expect(getFolderJob(FOLDER_ID)).toBeNull();
  });

  it('a dry run counts but writes nothing and reports no folders to confirm', async () => {
    seedSource();
    const { zip } = await buildExportZip({ db: src });
    const result = importZipBuffer(zip, { db: dest, dryRun: true });
    expect(result.foldersToConfirm).toBe(0);
    expect(result.tables.find((t) => t.id === 'folders').inserted).toBe(1);
    expect(count('folders', { db: dest })).toBe(0);
    expect(count('folder_files', { db: dest })).toBe(0);
  });

  it('an older archive without folder tables imports as before', async () => {
    const { zip } = await buildExportZip({ db: src, tables: ['notes'] });
    const result = importZipBuffer(zip, { db: dest });
    expect(result.foldersToConfirm).toBe(0);
    expect(result.tables.map((t) => t.id)).toEqual(['notes']);
    const legacy = zipSync({
      'manifest.json': strToU8(JSON.stringify({ format: 'burrow-export', formatVersion: 2, tables: [{ id: 'notes' }] })),
      'json/notes.json': strToU8('[]'),
    });
    expect(importZipBuffer(legacy, { db: dest }).foldersToConfirm).toBe(0);
  });

  it('ignores everything the archive says about confirmation, keys, jobs and the index', () => {
    const zip = craft(
      [goodFolder({ confirm_state: 'ok', path_key: 'real-key', auto_rescan: true, last_job_status: 'done', last_job_error: 'x', last_job_at: '2026-01-01T00:00:00.000Z', stats: 'not an object' })],
      [goodFile({ index_hash: 'c'.repeat(64), index_model: 'nomic-embed-text', chunk_count: 9, seen_at: '2026-01-01T00:00:00.000Z' })],
    );
    importZipBuffer(zip, { db: dest });
    expect(getFolder(FOLDER_ID)).toMatchObject({ confirm_state: 'needs_confirm', path_key: `imported:${FOLDER_ID}`, auto_rescan: false, last_job_status: null, last_job_error: null, last_job_at: null, stats: {} });
    expect(rows(dest, 'folder_files')[0]).toMatchObject({ index_hash: null, index_model: null, chunk_count: 0, seen_at: null });
  });

  it('does not touch a stats object that is empty (never scanned)', () => {
    importZipBuffer(craft([goodFolder({ stats: {} })], []), { db: dest });
    expect(getFolder(FOLDER_ID).stats).toEqual({});
  });

  it('skips unsafe or malformed file rows as invalid and keeps the good one', () => {
    const bad = [
      ['a parent segment', { id: '44444444-4444-4444-8444-444444444441', rel_path: '../x' }],
      ['an inner parent segment', { id: '44444444-4444-4444-8444-444444444442', rel_path: 'a/../../x' }],
      ['an absolute path', { id: '44444444-4444-4444-8444-444444444443', rel_path: '/etc/passwd' }],
      ['a backslash', { id: '44444444-4444-4444-8444-444444444444', rel_path: 'a\\b.txt' }],
      ['an empty segment', { id: '44444444-4444-4444-8444-444444444445', rel_path: 'a//b.txt' }],
      ['a dot segment', { id: '44444444-4444-4444-8444-444444444446', rel_path: './a.txt' }],
      ['a NUL', { id: '44444444-4444-4444-8444-444444444447', rel_path: 'a\0b.txt' }],
      ['a long path', { id: '44444444-4444-4444-8444-444444444448', rel_path: 'a'.repeat(1025) }],
      ['an unknown status', { id: '44444444-4444-4444-8444-444444444449', rel_path: 'b.txt', status: 'weird' }],
      ['an unknown kind', { id: '44444444-4444-4444-8444-44444444444a', rel_path: 'c.txt', kind: 'weird' }],
      ['an unknown summary status', { id: '44444444-4444-4444-8444-44444444444b', rel_path: 'd.txt', summary_status: 'weird' }],
      ['an ext that differs from the path', { id: '44444444-4444-4444-8444-44444444444c', rel_path: 'e.pdf', ext: 'txt' }],
      ['an empty ext for a path that has one', { id: '44444444-4444-4444-8444-44444444444d', rel_path: 'f.docx', ext: '' }],
    ];
    const result = importZipBuffer(craft([goodFolder()], [goodFile(), ...bad.map(([, over]) => goodFile(over))]), { db: dest });
    const files = result.tables.find((t) => t.id === 'folder_files');
    expect(files).toMatchObject({ inserted: 1, skipped: bad.length });
    expect(files.skippedReasons.invalid).toBe(bad.length);
    expect(rows(dest, 'folder_files').map((f) => f.rel_path)).toEqual(['plan.txt']);
  });

  it('skips a folder with a bad name or path as invalid', () => {
    const zip = craft(
      [
        goodFolder({ id: '55555555-5555-4555-8555-555555555551', name: '' }),
        goodFolder({ id: '55555555-5555-4555-8555-555555555552', name: 'x'.repeat(121) }),
        goodFolder({ id: '55555555-5555-4555-8555-555555555553', path: '' }),
        goodFolder({ id: '55555555-5555-4555-8555-555555555554', path: 'a\0b' }),
        goodFolder({ id: 'not-a-uuid' }),
        { name: 'no id', path: dir },
        goodFolder(),
      ],
      [],
    );
    const result = importZipBuffer(zip, { db: dest });
    const folders = result.tables.find((t) => t.id === 'folders');
    expect(folders).toMatchObject({ inserted: 1, skipped: 6 });
    expect(folders.skippedReasons).toMatchObject({ invalid: 5, missing_id: 1 });
    expect(rows(dest, 'folders').map((f) => f.id)).toEqual([FOLDER_ID]);
  });

  it('files of a folder that was not imported are orphans, or protected when that folder is local', () => {
    importZipBuffer(craft([goodFolder()], []), { db: dest });
    const zip = craft([], [goodFile({ folder_id: '66666666-6666-4666-8666-666666666666' }), goodFile({ id: FILE_B, rel_path: 'b.txt' })]);
    const files = importZipBuffer(zip, { db: dest }).tables.find((t) => t.id === 'folder_files');
    expect(files.skippedReasons).toMatchObject({ orphan: 1, protected: 1 });
    expect(count('folder_files', { db: dest })).toBe(0);
  });

  it('is idempotent: a second import changes nothing and never touches a confirmed folder', async () => {
    seedSource();
    const { zip } = await buildExportZip({ db: src });
    importZipBuffer(zip, { db: dest });
    const before = { folders: rows(dest, 'folders'), files: rows(dest, 'folder_files') };
    const second = importZipBuffer(zip, { db: dest });
    expect(second.foldersToConfirm).toBe(0);
    expect(second.totals.inserted).toBe(0);
    expect(second.tables.find((t) => t.id === 'folders').skippedReasons.protected).toBe(1);
    expect(second.tables.find((t) => t.id === 'folder_files').skippedReasons.protected).toBe(2);
    expect({ folders: rows(dest, 'folders'), files: rows(dest, 'folder_files') }).toEqual(before);

    updateFolder(FOLDER_ID, { confirm_state: 'ok', path_key: 'confirmed-key', auto_rescan: true, name: 'Renamed' });
    const confirmed = rows(dest, 'folders');
    importZipBuffer(zip, { db: dest });
    expect(rows(dest, 'folders')).toEqual(confirmed);
  });

  it('skips a folder whose path is already a local folder', async () => {
    insert('folders', { name: 'Mine', path: dir, path_key: 'local-key' }, { db: dest });
    seedSource();
    const { zip } = await buildExportZip({ db: src });
    const result = importZipBuffer(zip, { db: dest });
    expect(result.tables.find((t) => t.id === 'folders').skippedReasons.protected).toBe(1);
    expect(result.tables.find((t) => t.id === 'folder_files').skippedReasons.orphan).toBe(2);
    expect(result.foldersToConfirm).toBe(0);
    expect(count('folders', { db: dest })).toBe(1);
  });

  it('ignores a folder_chunks table in an archive', () => {
    const zip = craft([goodFolder()], [goodFile()], {
      tables: [{ id: 'folder_chunks' }],
      files: { 'json/folder_chunks.json': strToU8(JSON.stringify([{ id: '77777777-7777-4777-8777-777777777777', folder_id: FOLDER_ID, file_id: FILE_A, seq: 0, start_line: 1, end_line: 1, text: SENTINEL }])) },
    });
    const result = importZipBuffer(zip, { db: dest });
    expect(result.ignoredTables).toEqual([{ id: 'folder_chunks', reason: 'unknown_table' }]);
    expect(count('folder_chunks', { db: dest })).toBe(0);
  });

  it('stops at the 20 folder limit', () => {
    const many = Array.from({ length: 25 }, (_, i) => goodFolder({ id: `88888888-8888-4888-8888-${String(i).padStart(12, '0')}`, path: path.join(root, `p${i}`) }));
    const result = importZipBuffer(craft(many, []), { db: dest });
    expect(result.tables.find((t) => t.id === 'folders')).toMatchObject({ inserted: 20, skipped: 5 });
    expect(result.foldersToConfirm).toBe(20);
  });
});

describe('an imported folder is not read until it is confirmed', () => {
  const importOne = () => {
    importZipBuffer(craft([goodFolder({ auto_rescan: true })], [goodFile()]), { db: dest });
    return getFolder(FOLDER_ID);
  };
  const call = (method, url, body) => {
    const r = request(app)[method](url);
    return method === 'get' ? r : r.set(SAME_ORIGIN).send(body ?? {});
  };
  const expectError = (res, code) => {
    expect(res.status, `${code}: ${JSON.stringify(res.body)}`).toBe(COPY[code][0]);
    expect(res.body).toEqual(errorBody(code));
    expect(res.headers['cache-control']).toBe('no-store');
  };

  it('lists it with needsConfirm and answers 409 folder_needs_confirm for scan and the daily switch', async () => {
    importOne();
    const list = await call('get', '/api/folders');
    expect(list.body.data.folders).toHaveLength(1);
    expect(list.body.data.folders[0]).toMatchObject({ id: FOLDER_ID, needsConfirm: true, autoRescan: false, job: null });
    expectError(await call('post', `/api/folders/${FOLDER_ID}/scan`), 'folder_needs_confirm');
    expectError(await call('patch', `/api/folders/${FOLDER_ID}`, { autoRescan: true }), 'folder_needs_confirm');
    expect(getFolderJob(FOLDER_ID)).toBeNull();
    expect(getFolder(FOLDER_ID).auto_rescan).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('still allows renaming, turning the switch off, the file list, export and removal', async () => {
    importOne();
    const renamed = await call('patch', `/api/folders/${FOLDER_ID}`, { name: 'Renamed', autoRescan: false });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data.folder).toMatchObject({ name: 'Renamed', needsConfirm: true });
    const files = await call('get', `/api/folders/${FOLDER_ID}/files`);
    expect(files.status).toBe(200);
    expect(files.body.data.files.map((f) => f.path)).toEqual(['plan.txt']);
    expect((await call('post', `/api/folders/${FOLDER_ID}/export`, { format: 'csv' })).status).toBe(200);
    expect((await call('delete', `/api/folders/${FOLDER_ID}`)).status).toBe(200);
    expect(count('folders', { db: dest })).toBe(0);
  });

  it('is released by the pasted-path confirm, which runs the normal path checks', async () => {
    importOne();
    expectError(await call('post', `/api/folders/${FOLDER_ID}/confirm`, { path: path.join(root, 'missing') }), 'folder_missing');
    expect(getFolder(FOLDER_ID).confirm_state).toBe('needs_confirm');
    const ok = await call('post', `/api/folders/${FOLDER_ID}/confirm`, { path: dir });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    await waitForFolderJob(ok.body.data.job.id, { timeoutMs: 20000 });
    expect(getFolder(FOLDER_ID)).toMatchObject({ confirm_state: 'ok', auto_rescan: false });
    expect((await call('post', `/api/folders/${FOLDER_ID}/scan`)).status).toBe(202);
  });

  it('refuses a confirm that overlaps a confirmed folder', async () => {
    importOne();
    const added = await call('post', '/api/folders', { path: dir });
    await waitForFolderJob(added.body.data.job.id, { timeoutMs: 20000 });
    expectError(await call('post', `/api/folders/${FOLDER_ID}/confirm`, { path: path.join(dir, 'sub') }), 'folder_overlaps');
    expectError(await call('post', `/api/folders/${NO_FOLDER}/confirm`, { path: dir }), 'folder_not_found');
    expect(getFolder(FOLDER_ID).confirm_state).toBe('needs_confirm');
  });
});
