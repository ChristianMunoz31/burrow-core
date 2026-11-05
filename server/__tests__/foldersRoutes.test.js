// /api/folders end to end through the real app: every route's envelope, every error code and its fixed copy, request
// validation, the same-origin guard, no-store, the limiters, the three exports, ask with citations, the report, and
// removing a folder without touching its files. Synthetic temp folders, fake Ollama, Pro on unless a test says otherwise.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));

import fs from 'node:fs';
import path from 'node:path';
import fetch from 'node-fetch';
import { __resetAiForTests } from '../ai/index.js';
import { listAudit } from '../audit.js';
import { count, select } from '../db/index.js';
import { __setFolderLimitsForTests, cancelAllFolderJobs, drainFolderJobs, getFolderJob, waitForFolderJob } from '../folders/jobs.js';
import { __setPathOptionsForTests } from '../folders/pathSafety.js';
import { allFileRows, getFolder, insertFolder, replaceFileChunks, updateFolder } from '../folders/store.js';
import { __setBusyDelaysForTests } from '../folders/summarize.js';
import { resolveDataDir } from '../paths.js';
import { fakeEmbedding, hangingChat, installFakeOllama, textReply } from './helpers/fakeOllama.js';
import { COPY, errorBody, fingerprint, makeTmp, neutralPathOptions, rmTree, tryDirLink, writeTree } from './helpers/foldersEnv.js';
import { closeTestDb, createTestDb, resetDb } from './helpers/testDb.js';

const SAME_ORIGIN = Object.freeze({ Host: '127.0.0.1:4321', Origin: 'http://127.0.0.1:4321' });
const NO_FOLDER = '00000000-0000-4000-8000-000000000000';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WIN = process.platform === 'win32';
const saved = Object.fromEntries(['APP_PASSWORD', 'AUTH_SECRET', 'SECRETS_ENCRYPTION_KEY', 'BURROW_AI'].map((k) => [k, process.env[k]]));

let app;
let db;
let root;
let dir;
let fake;
let ip = 0;
const nextIp = () => `203.0.113.${(ip += 1) % 250}`;

const get = (url, ipAddr = nextIp()) => request(app).get(url).set('X-Forwarded-For', ipAddr);
const post = (url, body, ipAddr = nextIp()) => {
  const req = request(app).post(url).set('X-Forwarded-For', ipAddr).set(SAME_ORIGIN);
  return body === undefined ? req : req.send(body);
};
/** A POST that always says it is JSON, even with no body (so the body check, not the media type, answers). */
const postJson = (url, body, ipAddr = nextIp()) =>
  request(app).post(url).set('X-Forwarded-For', ipAddr).set(SAME_ORIGIN).set('Content-Type', 'application/json').send(body === undefined ? '' : JSON.stringify(body));
const patch = (id, body) => request(app).patch(`/api/folders/${id}`).set('X-Forwarded-For', nextIp()).send(body);
const del = (id) => request(app).delete(`/api/folders/${id}`).set('X-Forwarded-For', nextIp());

const expectError = (res, code) => {
  expect(res.status, `${code}: ${JSON.stringify(res.body)}`).toBe(COPY[code][0]);
  expect(res.body).toEqual(errorBody(code));
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.headers['content-type']).toMatch(/application\/json/);
};

async function addFolder(body = { path: dir }, { wait = true } = {}) {
  const res = await post('/api/folders', body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  if (wait) {
    const done = await waitForFolderJob(res.body.data.job.id, { timeoutMs: 20000 });
    expect(done.status).toBe('done');
  }
  return res.body.data.folder;
}
const listed = async () => (await get('/api/folders')).body.data.folders;
const filesOf = (id, query = '') => get(`/api/folders/${id}/files${query}`);

function useFake(opts = {}) {
  __resetAiForTests();
  fetch.mockReset();
  fake = installFakeOllama(fetch, {
    embedModel: true,
    embed: (body) => body.input.map((t) => (t.includes('zzzz') ? new Array(8).fill(-1) : fakeEmbedding(t))),
    chat: () => textReply('A short note about the files.'),
    ...opts,
  });
}

beforeAll(async () => {
  for (const k of Object.keys(saved)) delete process.env[k];
  db = createTestDb();
  app = (await import('../../server.js')).default;
  root = makeTmp('burrow-folders-routes-');
  fs.mkdirSync(path.join(root, 'fake-home'), { recursive: true });
  __setBusyDelaysForTests([1, 1, 1]);
});
afterAll(() => {
  __setPathOptionsForTests(null);
  __setBusyDelaysForTests(null);
  closeTestDb(db);
  rmTree(root);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
beforeEach(() => {
  resetDb(db);
  __setPathOptionsForTests(neutralPathOptions(root));
  useFake();
  dir = path.join(root, 'notes');
  rmTree(dir);
  writeTree(dir, {
    'plan.txt': 'The garden plan has tomatoes and peppers.\nWater them every morning.\n',
    'sub/recipe.md': '# Soup\nTomatoes, basil and garlic.\n',
    'sub/copy.md': '# Soup\nTomatoes, basil and garlic.\n',
    'picture.png': 'not really a picture',
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  cancelAllFolderJobs('shutdown');
  await drainFolderJobs({ timeoutMs: 2000 });
  __setFolderLimitsForTests(null);
  delete process.env.BURROW_AI;
  vi.restoreAllMocks();
});

describe('GET /api/folders', () => {
  it('is an empty list with the limits when there are no folders', async () => {
    const res = await get('/api/folders');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      data: {
        folders: [],
        limits: { maxFolders: 20, maxFiles: 5000, maxFileBytes: 2097152, maxTotalBytes: 209715200, maxDepth: 12, summaryFiles: 300, maxIndexChunks: 10000, embedModel: 'nomic-embed-text' },
        canPickFolder: false,
        canSaveFile: false,
      },
    });
  });

  it('lists a folder view with exactly the contract keys', async () => {
    await addFolder();
    const [f] = await listed();
    expect(Object.keys(f).sort()).toEqual(['autoRescan', 'createdAt', 'id', 'job', 'lastJob', 'lastScanAt', 'name', 'needsConfirm', 'path', 'report', 'stats', 'summary', 'warnings'].sort());
    expect(f).toMatchObject({
      name: 'notes',
      autoRescan: false,
      needsConfirm: false,
      report: null,
      warnings: [],
      summary: { status: 'ok', text: 'A short note about the files.', model: 'qwen2.5:3b', at: expect.any(String) },
      lastJob: { status: 'done', errorCode: null, message: null, at: expect.any(String) },
      job: { kind: 'scan', status: 'done' },
    });
    expect(f.id).toMatch(UUID);
    expect(f.stats).toMatchObject({ filesTotal: 4, filesRead: 3, duplicateGroups: 1 });
    expect(Object.keys(f.stats).sort()).toEqual(
      ['bytesRead', 'bytesTotal', 'byExt', 'byKind', 'byStatus', 'dirsScanned', 'dirsSkipped', 'duplicateGroups', 'filesRead', 'filesTotal', 'index', 'largestFiles', 'limitsHit', 'linesTotal', 'newestModifiedAt', 'oldestModifiedAt', 'wordsTotal'].sort(),
    );
  });

  it('shows a folder that was never scanned with stats null and no summary', async () => {
    const row = insertFolder({ name: 'Raw', path: dir, pathKey: `${dir.toLowerCase()}-raw` });
    const f = (await listed()).find((x) => x.id === row.id);
    expect(f).toMatchObject({ stats: null, lastScanAt: null, job: null, lastJob: null, report: null, summary: { status: 'none', text: null, model: null, at: null } });
  });

  it('lists folders oldest first', async () => {
    const a = insertFolder({ name: 'A', path: dir, pathKey: 'k-a' });
    await new Promise((r) => setTimeout(r, 5)); // created_at has millisecond resolution
    const b = insertFolder({ name: 'B', path: dir, pathKey: 'k-b' });
    expect((await listed()).map((f) => f.id)).toEqual([a.id, b.id]);
  });

  it('warns about OneDrive for a folder inside a sync root', async () => {
    const was = process.env.OneDrive;
    process.env.OneDrive = root;
    try {
      __setPathOptionsForTests(neutralPathOptions(root, { env: { OneDrive: root } }));
      const res = await post('/api/folders', { path: dir });
      expect(res.body.data.folder.warnings).toEqual(['onedrive']);
      await waitForFolderJob(res.body.data.job.id, { timeoutMs: 20000 });
      expect((await listed())[0].warnings).toEqual(['onedrive']);
    } finally {
      if (was === undefined) delete process.env.OneDrive;
      else process.env.OneDrive = was;
    }
  });
});

describe('POST /api/folders (add)', () => {
  it('creates the folder, queues the first scan and answers 201 { data: { folder, job } }', async () => {
    const res = await post('/api/folders', { path: dir });
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(Object.keys(res.body)).toEqual(['data']);
    expect(Object.keys(res.body.data).sort()).toEqual(['folder', 'job']);
    expect(res.body.data.folder).toMatchObject({ name: 'notes', path: dir, autoRescan: false, warnings: [] });
    expect(Object.keys(res.body.data.job).sort()).toEqual(['error', 'finishedAt', 'folderId', 'id', 'kind', 'notices', 'phase', 'progress', 'queuePosition', 'startedAt', 'status', 'trigger']);
    expect(res.body.data.job).toMatchObject({ folderId: res.body.data.folder.id, kind: 'scan', trigger: 'user', error: null });
    await waitForFolderJob(res.body.data.job.id, { timeoutMs: 20000 });
    expect(count('folders')).toBe(1);
  });

  it('uses the name given, trimmed, and the folder name otherwise', async () => {
    const res = await post('/api/folders', { path: dir, name: '  My notes  ' });
    expect(res.body.data.folder.name).toBe('My notes');
    await waitForFolderJob(res.body.data.job.id, { timeoutMs: 20000 });
  });

  it('accepts a name of exactly 120 characters', async () => {
    const res = await post('/api/folders', { path: dir, name: 'n'.repeat(120) });
    expect(res.status).toBe(201);
    await waitForFolderJob(res.body.data.job.id, { timeoutMs: 20000 });
  });

  it('accepts a path pasted with quotes (Copy as path)', async () => {
    const res = await post('/api/folders', { path: `"${dir}"` });
    expect(res.status).toBe(201);
    expect(res.body.data.folder.path).toBe(dir);
    await waitForFolderJob(res.body.data.job.id, { timeoutMs: 20000 });
  });

  it.each([
    ['no body', undefined],
    ['an empty object', {}],
    ['an array', []],
    ['a path that is not a string', { path: 42 }],
    ['an array path', { path: ['x'] }],
    ['an unknown key', { path: 'x', autoRescan: true }],
    ['a name that is not a string', { path: 'x', name: 5 }],
    ['a null name', { path: 'x', name: null }],
    ['an empty name', { path: 'x', name: '' }],
    ['a blank name', { path: 'x', name: '   ' }],
    ['a name of 121 characters', { path: 'x', name: 'n'.repeat(121) }],
    ['a name with a control character', { path: 'x', name: 'bad\nname' }],
    ['a name with a NUL', { path: 'x', name: 'bad\u0000name' }],
  ])('refuses %s with 400 invalid_request and creates nothing', async (_label, body) => {
    const res = await postJson('/api/folders', body);
    expectError(res, 'invalid_request');
    expect(count('folders')).toBe(0);
  });

  it('refuses a body that is not JSON with 415 unsupported_media_type', async () => {
    const res = await request(app).post('/api/folders').set('X-Forwarded-For', nextIp()).set(SAME_ORIGIN).set('Content-Type', 'text/plain').send(`{"path":"${dir}"}`);
    expectError(res, 'unsupported_media_type');
    expect(count('folders')).toBe(0);
  });

  it('refuses a form-encoded body too', async () => {
    const res = await request(app).post('/api/folders').set('X-Forwarded-For', nextIp()).set(SAME_ORIGIN).type('form').send({ path: dir });
    expectError(res, 'unsupported_media_type');
  });

  // Malformed JSON never reaches the Folders handler, so registerFolderRoutes ends with an error handler for /api/folders
  // that answers the contract body { error: 'invalid_request', code, message } with no-store.
  it('malformed JSON answers the Folders invalid_request body', async () => {
    const res = await request(app).post('/api/folders').set('X-Forwarded-For', nextIp()).set(SAME_ORIGIN).set('Content-Type', 'application/json').send('{"path":');
    expectError(res, 'invalid_request');
  });

  it('malformed JSON is still a 400 and creates nothing', async () => {
    const res = await request(app).post('/api/folders').set('X-Forwarded-For', nextIp()).set(SAME_ORIGIN).set('Content-Type', 'application/json').send('{"path":');
    expect(res.status).toBe(400);
    expect(count('folders')).toBe(0);
  });

  describe('same origin', () => {
    const foreign = (headers) => request(app).post('/api/folders').set('X-Forwarded-For', nextIp()).set(headers).send({ path: dir });

    it.each([
      ['another loopback port (the dev server)', { Host: '127.0.0.1:4321', Origin: 'http://localhost:5174' }],
      ['no Origin at all', { Host: '127.0.0.1:4321' }],
      ['the right Origin but a cross-site fetch', { ...SAME_ORIGIN, 'Sec-Fetch-Site': 'cross-site' }],
      ['the right Origin but a same-site (not same-origin) fetch', { ...SAME_ORIGIN, 'Sec-Fetch-Site': 'same-site' }],
    ])('answers 403 folder_origin_blocked for %s and adds nothing', async (_label, headers) => {
      const res = await foreign(headers);
      expectError(res, 'folder_origin_blocked');
      expect(count('folders')).toBe(0);
      expect(fake.urls).toEqual([]);
    });

    // The app-wide CORS layer turns away a page on any other site, or a null origin, first and with its own body.
    it.each([
      ['another site', 'https://evil.example'],
      ['a null origin', 'null'],
    ])('%s is refused with 403 before the route runs, and adds nothing', async (_label, origin) => {
      const res = await foreign({ Host: '127.0.0.1:4321', Origin: origin });
      expect(res.status).toBe(403);
      expect(count('folders')).toBe(0);
      expect(fake.urls).toEqual([]);
    });

    it('is checked before the media type and before the body', async () => {
      const res = await request(app).post('/api/folders').set('X-Forwarded-For', nextIp()).set({ Host: '127.0.0.1:4321', Origin: 'http://localhost:5174' }).set('Content-Type', 'text/plain').send('x');
      expectError(res, 'folder_origin_blocked');
    });

    it('lets the Burrow window through, with or without a Sec-Fetch-Site header', async () => {
      for (const extra of [{}, { 'Sec-Fetch-Site': 'same-origin' }, { 'Sec-Fetch-Site': 'none' }]) {
        fs.rmSync(path.join(root, 'k'), { recursive: true, force: true });
        const own = path.join(root, `own-${Object.keys(extra).length}-${extra['Sec-Fetch-Site'] ?? 'x'}`);
        writeTree(own, { 'a.txt': 'hello\n' });
        const res = await request(app).post('/api/folders').set('X-Forwarded-For', nextIp()).set({ ...SAME_ORIGIN, ...extra }).send({ path: own });
        expect(res.status).toBe(201);
        await waitForFolderJob(res.body.data.job.id, { timeoutMs: 20000 });
      }
    });

    it('other routes do not need an Origin (only adding a folder does)', async () => {
      expect((await get('/api/folders')).status).toBe(200);
      expect((await request(app).delete(`/api/folders/${NO_FOLDER}`).set('X-Forwarded-For', nextIp())).status).toBe(404);
    });
  });

  describe('path refusals', () => {
    const add = (p) => post('/api/folders', { path: p });

    it('a relative path is folder_path_invalid (422)', async () => expectError(await add('notes'), 'folder_path_invalid'));
    it('a path that does not exist is folder_missing (422)', async () => expectError(await add(path.join(root, 'nope')), 'folder_missing'));
    it('a file is folder_not_directory (422)', async () => expectError(await add(path.join(dir, 'plan.txt')), 'folder_not_directory'));
    it.runIf(WIN)('a network path is folder_network_path (422)', async () => expectError(await add('\\\\server\\share\\x'), 'folder_network_path'));

    it('a junction or symlink is folder_is_link (422)', async () => {
      const link = path.join(root, 'link-to-notes');
      if (!tryDirLink(dir, link)) return;
      expectError(await add(link), 'folder_is_link');
    });

    it('home and the drive root are folder_too_broad (422)', async () => {
      expectError(await add(path.join(root, 'fake-home')), 'folder_too_broad');
      expectError(await add(path.parse(root).root), 'folder_too_broad');
    });

    it('a system or app folder is folder_protected (422)', async () => {
      const exec = path.join(root, 'fake-exec');
      fs.mkdirSync(exec, { recursive: true });
      expectError(await add(exec), 'folder_protected');
    });

    it("Burrow's own data folder is folder_burrow_data (422)", async () => {
      const inside = path.join(resolveDataDir(), 'folders-route-test');
      fs.mkdirSync(inside, { recursive: true });
      expectError(await add(inside), 'folder_burrow_data');
    });

    it('the same folder twice is folder_exists (409)', async () => {
      await addFolder();
      expectError(await add(dir), 'folder_exists');
      expect(count('folders')).toBe(1);
    });

    it('a folder inside, or containing, an added one is folder_overlaps (409)', async () => {
      await addFolder({ path: path.join(dir, 'sub') });
      expectError(await add(dir), 'folder_overlaps');
      const nested = path.join(dir, 'sub', 'deeper');
      fs.mkdirSync(nested);
      expectError(await add(nested), 'folder_overlaps');
    });

    it('the 21st folder is folder_limit (409)', async () => {
      for (let i = 0; i < 20; i += 1) insertFolder({ name: `F${i}`, path: dir, pathKey: `key-${i}` });
      expectError(await add(dir), 'folder_limit');
      expect(count('folders')).toBe(20);
    });

    it('a refusal queues no job and creates no row', async () => {
      await add('notes');
      expect(count('folders')).toBe(0);
      expect(fake.urls).toEqual([]);
    });
  });

  it('a full job queue rolls the new folder back and answers 429 folder_queue_full', async () => {
    __setFolderLimitsForTests({ maxQueued: 0 });
    expectError(await post('/api/folders', { path: dir }), 'folder_queue_full');
    expect(count('folders')).toBe(0);
  });
});

describe('PATCH /api/folders/:id', () => {
  it('renames a folder (trimmed) and answers { data: { folder } }', async () => {
    const f = await addFolder();
    const res = await patch(f.id, { name: '  Renamed  ' });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(Object.keys(res.body)).toEqual(['data']);
    expect(Object.keys(res.body.data)).toEqual(['folder']);
    expect(res.body.data.folder).toMatchObject({ id: f.id, name: 'Renamed', autoRescan: false });
    expect((await listed())[0].name).toBe('Renamed');
  });

  it('turns the daily re-scan on (Pro) and off, and both persist', async () => {
    const f = await addFolder();
    expect((await patch(f.id, { autoRescan: true })).body.data.folder.autoRescan).toBe(true);
    expect((await listed())[0].autoRescan).toBe(true);
    expect(getFolder(f.id).auto_rescan).toBe(true);
    expect((await patch(f.id, { autoRescan: false })).body.data.folder.autoRescan).toBe(false);
    expect((await listed())[0].autoRescan).toBe(false);
  });

  it('can set both keys at once', async () => {
    const f = await addFolder();
    const res = await patch(f.id, { name: 'Both', autoRescan: true });
    expect(res.body.data.folder).toMatchObject({ name: 'Both', autoRescan: true });
  });

  it('does not change anything else (path, summary, stats)', async () => {
    const f = await addFolder();
    const before = getFolder(f.id);
    await patch(f.id, { name: 'X' });
    const after = getFolder(f.id);
    expect({ ...after, name: before.name, updated_at: before.updated_at }).toEqual(before);
  });

  it.each([
    ['no body', undefined],
    ['an empty object', {}],
    ['an array', []],
    ['an unknown key (path)', { path: 'C:\\x' }],
    ['an unknown key beside a good one', { name: 'ok', summary: 'x' }],
    ['an empty name', { name: '' }],
    ['a blank name', { name: '   ' }],
    ['a name that is not a string', { name: 5 }],
    ['a name of 121 characters', { name: 'n'.repeat(121) }],
    ['a name with a control character', { name: 'a\tb' }],
    ['autoRescan as a string', { autoRescan: 'yes' }],
    ['autoRescan as a number', { autoRescan: 1 }],
    ['autoRescan null', { autoRescan: null }],
    ['a good name with a bad autoRescan', { name: 'ok', autoRescan: 'no' }],
  ])('refuses %s with 400 invalid_request', async (_label, body) => {
    const f = await addFolder();
    const before = getFolder(f.id);
    const res = await request(app).patch(`/api/folders/${f.id}`).set('X-Forwarded-For', nextIp()).set('Content-Type', 'application/json').send(body === undefined ? '' : JSON.stringify(body));
    expectError(res, 'invalid_request');
    expect(getFolder(f.id)).toEqual(before);
  });

  it('refuses a non-JSON body with 415', async () => {
    const f = await addFolder();
    const res = await request(app).patch(`/api/folders/${f.id}`).set('X-Forwarded-For', nextIp()).set('Content-Type', 'text/plain').send('name=x');
    expectError(res, 'unsupported_media_type');
  });

  it('answers 404 folder_not_found for an unknown or malformed id', async () => {
    for (const id of [NO_FOLDER, 'not-a-uuid', '123', `${NO_FOLDER}0`, 'x'.repeat(200)]) expectError(await patch(id, { name: 'x' }), 'folder_not_found');
  });

  it('the daily re-scan can be turned on and off with no gate (the scheduler runs it only when the module provides it)', async () => {
    const f = await addFolder();
    const on = await patch(f.id, { autoRescan: true });
    expect(on.status).toBe(200);
    expect(getFolder(f.id).auto_rescan).toBe(true);
    expect((await patch(f.id, { autoRescan: false })).status).toBe(200);
    expect(getFolder(f.id).auto_rescan).toBe(false);
    expect((await patch(f.id, { name: 'Renamed' })).status).toBe(200);
  });
});

describe('DELETE /api/folders/:id', () => {
  it('removes the folder, its files and its chunks, and answers { data: { removed: true } }', async () => {
    const f = await addFolder();
    expect(count('folder_files')).toBe(4);
    const [file] = allFileRows(f.id);
    replaceFileChunks(file.id, f.id, [{ seq: 0, startLine: 1, endLine: 1, text: 'chunk text', embedding: 'AACAPwAAgD8=', dims: 2 }], { index_hash: file.sha256, index_model: 'nomic-embed-text', chunk_count: 1 });
    expect(count('folder_chunks')).toBe(1);
    const res = await del(f.id);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ data: { removed: true } });
    expect(count('folders')).toBe(0);
    expect(count('folder_files')).toBe(0);
    expect(count('folder_chunks')).toBe(0);
    expect(getFolderJob(f.id)).toBeNull();
    expect(await listed()).toEqual([]);
  });

  it('leaves every file on disk untouched (hash, size and modified time)', async () => {
    const before = fingerprint(dir);
    const names = fs.readdirSync(dir).sort();
    const f = await addFolder();
    expect((await del(f.id)).status).toBe(200);
    expect(fingerprint(dir)).toEqual(before);
    expect(fs.readdirSync(dir).sort()).toEqual(names);
  });

  it('removing one folder keeps another one and its index', async () => {
    const other = path.join(root, 'other');
    writeTree(other, { 'o.txt': 'other folder text\n' });
    const a = await addFolder();
    const b = await addFolder({ path: other });
    await del(a.id);
    expect((await listed()).map((x) => x.id)).toEqual([b.id]);
    expect(allFileRows(b.id)).toHaveLength(1);
    expect(select('folder_chunks').every((c) => c.folder_id === b.id)).toBe(true);
  });

  it('cancels a running job first and still removes the folder', async () => {
    useFake({ chat: hangingChat });
    const f = await addFolder({ path: dir }, { wait: false });
    await vi.waitFor(() => expect(fake.chatBodies.length).toBe(1));
    const res = await del(f.id);
    expect(res.status).toBe(200);
    expect(count('folders')).toBe(0);
    expect(count('folder_files')).toBe(0);
    expect(getFolderJob(f.id)).toBeNull();
  });

  it('answers 404 folder_not_found for an unknown id, a malformed id and a second delete', async () => {
    const f = await addFolder();
    await del(f.id);
    for (const id of [f.id, NO_FOLDER, 'nope']) expectError(await del(id), 'folder_not_found');
  });

  it('removing a folder lets the same path be added again', async () => {
    const f = await addFolder();
    await del(f.id);
    const again = await addFolder();
    expect(again.id).not.toBe(f.id);
  });
});

describe('POST /api/folders/:id/scan and /cancel, GET /api/folders/:id/job', () => {
  it('scan answers 202 { data: { job } } and the job runs to done', async () => {
    const f = await addFolder();
    const res = await post(`/api/folders/${f.id}/scan`);
    expect(res.status).toBe(202);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(Object.keys(res.body)).toEqual(['data']);
    expect(Object.keys(res.body.data)).toEqual(['job']);
    expect(res.body.data.job).toMatchObject({ folderId: f.id, kind: 'scan', trigger: 'user' });
    expect((await waitForFolderJob(res.body.data.job.id, { timeoutMs: 20000 })).status).toBe('done');
  });

  it('scan while a job is queued or running is 409 folder_job_running', async () => {
    useFake({ chat: hangingChat });
    const f = await addFolder({ path: dir }, { wait: false });
    expectError(await post(`/api/folders/${f.id}/scan`), 'folder_job_running');
  });

  it('scan with a full queue is 429 folder_queue_full', async () => {
    const f = await addFolder();
    __setFolderLimitsForTests({ maxQueued: 0 });
    expectError(await post(`/api/folders/${f.id}/scan`), 'folder_queue_full');
  });

  it('scan and cancel answer 404 folder_not_found for an unknown or malformed id', async () => {
    for (const id of [NO_FOLDER, 'bad-id']) {
      expectError(await post(`/api/folders/${id}/scan`), 'folder_not_found');
      expectError(await post(`/api/folders/${id}/cancel`), 'folder_not_found');
      expectError(await get(`/api/folders/${id}/job`), 'folder_not_found');
    }
  });

  it('cancel with nothing running is 409 folder_no_job', async () => {
    const f = await addFolder();
    expectError(await post(`/api/folders/${f.id}/cancel`), 'folder_no_job');
  });

  it('cancel stops a running job, answers { data: { job } } with where it ended, and keeps what was read', async () => {
    useFake({ chat: hangingChat });
    const f = await addFolder({ path: dir }, { wait: false });
    await vi.waitFor(() => expect(fake.chatBodies.length).toBe(1));
    const res = await post(`/api/folders/${f.id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data.job).toMatchObject({ status: 'cancelled', error: { code: 'cancelled', message: COPY.cancelled[1] } });
    expect(allFileRows(f.id)).toHaveLength(4);
    const view = (await listed())[0];
    expect(view.lastJob).toMatchObject({ status: 'cancelled', errorCode: 'cancelled', message: COPY.cancelled[1] });
    expect(view.stats.filesTotal).toBe(4);
  });

  it('job is { data: { job: null } } before any job exists', async () => {
    const row = insertFolder({ name: 'Raw', path: dir, pathKey: 'raw-key' });
    const res = await get(`/api/folders/${row.id}/job`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ data: { job: null } });
  });

  it('job shows the latest job with its progress, and a finished one stays visible', async () => {
    const f = await addFolder();
    const res = await get(`/api/folders/${f.id}/job`);
    expect(res.body.data.job).toMatchObject({ folderId: f.id, kind: 'scan', status: 'done', phase: 'done', error: null, queuePosition: null });
    expect(res.body.data.job.progress).toMatchObject({ filesSeen: 4, summariesTotal: 3, summariesDone: 3 });
  });

  it('job shows a queued job with its place in line', async () => {
    const other = path.join(root, 'other');
    writeTree(other, { 'o.txt': 'other\n' });
    useFake({ chat: hangingChat });
    await addFolder({ path: dir }, { wait: false });
    const b = await addFolder({ path: other }, { wait: false });
    const res = await get(`/api/folders/${b.id}/job`);
    expect(res.body.data.job).toMatchObject({ status: 'queued', phase: 'queued', queuePosition: 1 });
  });

  it('accepts an upper-case id', async () => {
    const f = await addFolder();
    const res = await get(`/api/folders/${f.id.toUpperCase()}/job`);
    expect(res.status).toBe(200);
    expect(res.body.data.job.folderId).toBe(f.id);
  });

  it('a malformed percent escape in the id is a 400 invalid_request from the app', async () => {
    const res = await get('/api/folders/%E0%A4%A/job');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });
});

describe('GET /api/folders/:id/files', () => {
  async function folderWithFiles() {
    const big = path.join(root, 'many');
    const tree = { 'b.txt': 'bb', 'a.txt': 'a'.repeat(50), 'c.md': 'c'.repeat(10), 'd.png': 'png' };
    writeTree(big, tree);
    const t = (d) => new Date(Date.UTC(2026, 0, d));
    fs.utimesSync(path.join(big, 'a.txt'), t(3), t(3));
    fs.utimesSync(path.join(big, 'b.txt'), t(1), t(1));
    fs.utimesSync(path.join(big, 'c.md'), t(2), t(2));
    fs.utimesSync(path.join(big, 'd.png'), t(4), t(4));
    return addFolder({ path: big });
  }

  it('returns the first page, sorted by path, with the FileView keys', async () => {
    const f = await folderWithFiles();
    const res = await filesOf(f.id);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(Object.keys(res.body.data).sort()).toEqual(['files', 'limit', 'offset', 'total']);
    expect(res.body.data).toMatchObject({ total: 4, offset: 0, limit: 100 });
    expect(res.body.data.files.map((x) => x.path)).toEqual(['a.txt', 'b.txt', 'c.md', 'd.png']);
    expect(Object.keys(res.body.data.files[0]).sort()).toEqual(
      ['chars', 'ext', 'id', 'indexed', 'kind', 'lines', 'modifiedAt', 'path', 'sizeBytes', 'status', 'summary', 'summaryStatus', 'words'].sort(),
    );
    expect(res.body.data.files[0]).toMatchObject({ path: 'a.txt', ext: 'txt', kind: 'text', status: 'ok', sizeBytes: 50, lines: 1, words: 1, chars: 50, summaryStatus: 'ok', summary: 'A short note about the files.', indexed: false });
    expect(res.body.data.files[3]).toMatchObject({ path: 'd.png', kind: 'other', status: 'unsupported', summary: null, summaryStatus: 'not_text', indexed: false });
  });

  it.each([
    ['path', 'asc', ['a.txt', 'b.txt', 'c.md', 'd.png']],
    ['path', 'desc', ['d.png', 'c.md', 'b.txt', 'a.txt']],
    ['size', 'desc', ['a.txt', 'c.md', 'd.png', 'b.txt']],
    ['size', 'asc', ['b.txt', 'd.png', 'c.md', 'a.txt']],
    ['modified', 'asc', ['b.txt', 'c.md', 'a.txt', 'd.png']],
    ['modified', 'desc', ['d.png', 'a.txt', 'c.md', 'b.txt']],
    ['status', 'asc', ['a.txt', 'b.txt', 'c.md', 'd.png']],
    ['status', 'desc', ['d.png', 'a.txt', 'b.txt', 'c.md']],
  ])('sorts by %s %s', async (sort, dirq, expected) => {
    const f = await folderWithFiles();
    const res = await filesOf(f.id, `?sort=${sort}&dir=${dirq}`);
    expect(res.body.data.files.map((x) => x.path)).toEqual(expected);
  });

  it('pages with offset and limit and reports the total', async () => {
    const f = await folderWithFiles();
    const one = await filesOf(f.id, '?limit=2');
    expect(one.body.data).toMatchObject({ total: 4, offset: 0, limit: 2 });
    expect(one.body.data.files.map((x) => x.path)).toEqual(['a.txt', 'b.txt']);
    const two = await filesOf(f.id, '?limit=2&offset=2');
    expect(two.body.data.files.map((x) => x.path)).toEqual(['c.md', 'd.png']);
    const past = await filesOf(f.id, '?offset=500');
    expect(past.body.data).toMatchObject({ files: [], total: 4, offset: 500 });
  });

  it('accepts the largest page (200) and the smallest (1)', async () => {
    const f = await folderWithFiles();
    expect((await filesOf(f.id, '?limit=200')).status).toBe(200);
    expect((await filesOf(f.id, '?limit=1')).body.data.files).toHaveLength(1);
  });

  it.each([
    ['limit=0'],
    ['limit=201'],
    ['limit=-1'],
    ['limit=abc'],
    ['limit=1.5'],
    ['limit='],
    ['limit=1&limit=2'],
    ['limit[]=1'],
    ['limit[a]=1'],
    ['offset=-1'],
    ['offset=abc'],
    ['offset=1e3'],
    ['offset=1234567890'],
    ['offset=1&offset=2'],
    ['sort=bogus'],
    ['sort=PATH'],
    ['sort[]=path'],
    ['dir=up'],
    ['dir=ASC'],
    ['dir=asc&dir=desc'],
  ])('refuses ?%s with 400 invalid_request', async (query) => {
    const f = await folderWithFiles();
    expectError(await filesOf(f.id, `?${query}`), 'invalid_request');
  });

  it('ignores unknown query keys', async () => {
    const f = await folderWithFiles();
    expect((await filesOf(f.id, '?foo=bar')).status).toBe(200);
  });

  it('is empty for a folder that was never scanned', async () => {
    const row = insertFolder({ name: 'Raw', path: dir, pathKey: 'raw-key' });
    expect((await filesOf(row.id)).body.data).toEqual({ files: [], total: 0, offset: 0, limit: 100 });
  });

  it('answers 404 folder_not_found for an unknown or malformed id', async () => {
    for (const id of [NO_FOLDER, 'xyz']) expectError(await filesOf(id), 'folder_not_found');
  });
});

describe('POST /api/folders/:id/export', () => {
  const exportOf = (id, body) => postJson(`/api/folders/${id}/export`, body);

  it('Markdown: a report with the name, path, summary, facts and every file', async () => {
    const f = await addFolder({ path: dir, name: 'My notes' });
    const res = await exportOf(f.id, { format: 'md' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="burrow-folder-my-notes-\d{4}-\d{2}-\d{2}\.md"$/);
    expect(res.headers['access-control-expose-headers']).toBe('Content-Disposition');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toContain('# Folder report: My notes');
    expect(res.text).toContain(`Folder: ${dir}`);
    expect(res.text).toContain('## Summary');
    expect(res.text).toContain('A short note about the files.');
    expect(res.text).toMatch(/- Files: 4\n/);
    for (const p of ['plan.txt', 'picture.png', 'sub/copy.md', 'sub/recipe.md']) expect(res.text).toContain(p);
  });

  it('JSON: format burrow-folder with the folder, summary, stats and files', async () => {
    const f = await addFolder({ path: dir, name: 'My notes' });
    const res = await exportOf(f.id, { format: 'json' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="burrow-folder-my-notes-\d{4}-\d{2}-\d{2}\.json"$/);
    const body = JSON.parse(res.text);
    expect(body).toMatchObject({ format: 'burrow-folder', formatVersion: 1, folder: { name: 'My notes', path: dir, scanned: true }, summary: { status: 'ok', text: 'A short note about the files.' }, report: null });
    expect(body.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.stats).toMatchObject({ filesTotal: 4 });
    expect(body.files.map((x) => x.path)).toEqual(['picture.png', 'plan.txt', 'sub/copy.md', 'sub/recipe.md']);
    expect(Object.keys(body.files[0]).sort()).toEqual(Object.keys((await filesOf(f.id)).body.data.files[0]).sort());
  });

  it('CSV: a header and one row per file', async () => {
    const f = await addFolder({ path: dir, name: 'My notes' });
    const res = await exportOf(f.id, { format: 'csv' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="burrow-folder-my-notes-\d{4}-\d{2}-\d{2}\.csv"$/);
    const lines = res.text.split('\r\n');
    expect(lines[0]).toBe('Path,Extension,Kind,Status,Size (bytes),Modified,Lines,Words,Summary');
    expect(lines.slice(1, -1).map((l) => l.split(',')[0]).sort()).toEqual(['picture.png', 'plan.txt', 'sub/copy.md', 'sub/recipe.md']);
    expect(lines.at(-1)).toBe('');
  });

  it('CSV: a path or summary that starts with = + - or @ is neutralised', async () => {
    const odd = path.join(root, 'odd');
    writeTree(odd, { '=cmd.txt': 'one\n', '+plus.txt': 'two\n', '-minus.txt': 'three\n', '@at.txt': 'four\n', 'plain.txt': 'five\n' });
    useFake({ chat: () => textReply('=HYPERLINK note about the file.') });
    const f = await addFolder({ path: odd });
    const res = await exportOf(f.id, { format: 'csv' });
    const rows = res.text.split('\r\n').slice(1, -1);
    const first = (l) => l.split(',')[0];
    expect(rows.map(first).sort()).toEqual(["'+plus.txt", "'-minus.txt", "'=cmd.txt", "'@at.txt", 'plain.txt'].sort());
    expect(rows.some((l) => /^[=+\-@]/.test(l))).toBe(false);
    // the model's summary text is guarded the same way
    for (const l of rows) {
      const summary = l.split(',').slice(8).join(',');
      expect(summary).toMatch(/^"?'=HYPERLINK note/);
    }
    // the JSON export keeps the true names
    const json = JSON.parse((await exportOf(f.id, { format: 'json' })).text);
    expect(json.files.map((x) => x.path).sort()).toEqual(['+plus.txt', '-minus.txt', '=cmd.txt', '@at.txt', 'plain.txt']);
  });

  it('the file name is a safe slug of the folder name', async () => {
    const f = await addFolder({ path: dir, name: 'Ünï "quoted" ../..\\x; y' });
    const name = (res) => /filename="([^"]*)"/.exec(res.headers['content-disposition'])[1];
    const res = await exportOf(f.id, { format: 'md' });
    expect(name(res)).toMatch(/^burrow-folder-uni-quoted-x-y-\d{4}-\d{2}-\d{2}\.md$/);
    await patch(f.id, { name: '日本語' });
    expect(name(await exportOf(f.id, { format: 'csv' }))).toMatch(/^burrow-folder-folder-\d{4}-\d{2}-\d{2}\.csv$/);
    await patch(f.id, { name: '=cmd|calc' });
    const formula = await exportOf(f.id, { format: 'csv' });
    expect(name(formula)).toMatch(/^burrow-folder-cmd-calc-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it('a folder name that starts with = + - or @ is kept as it is in Markdown and JSON, and cannot break the file name', async () => {
    const f = await addFolder({ path: dir, name: '=SUM(A1)' });
    const md = await exportOf(f.id, { format: 'md' });
    expect(md.text).toContain('# Folder report: =SUM(A1)');
    expect(md.headers['content-disposition']).not.toMatch(/filename="[^"]*[=()][^"]*"/);
    expect(JSON.parse((await exportOf(f.id, { format: 'json' })).text).folder.name).toBe('=SUM(A1)');
  });

  it('works before any scan: the header and "Not read yet." (Markdown), an empty list (JSON and CSV)', async () => {
    const row = insertFolder({ name: 'Fresh', path: dir, pathKey: 'fresh-key' });
    const md = await exportOf(row.id, { format: 'md' });
    expect(md.status).toBe(200);
    expect(md.text).toContain('# Folder report: Fresh');
    expect(md.text).toContain('Not read yet.');
    const json = JSON.parse((await exportOf(row.id, { format: 'json' })).text);
    expect(json).toMatchObject({ folder: { scanned: false, lastScanAt: null }, stats: null, files: [], report: null });
    expect((await exportOf(row.id, { format: 'csv' })).text).toBe('Path,Extension,Kind,Status,Size (bytes),Modified,Lines,Words,Summary\r\n');
  });

  it('works after the folder was emptied on disk and re-scanned', async () => {
    const f = await addFolder();
    for (const entry of fs.readdirSync(dir)) fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    const scan = await post(`/api/folders/${f.id}/scan`);
    await waitForFolderJob(scan.body.data.job.id, { timeoutMs: 20000 });
    const md = await exportOf(f.id, { format: 'md' });
    expect(md.status).toBe(200);
    expect(md.text).toContain('- Files: 0');
    expect(md.text).not.toContain('plan.txt');
    expect(JSON.parse((await exportOf(f.id, { format: 'json' })).text).files).toEqual([]);
    expect((await exportOf(f.id, { format: 'csv' })).text.split('\r\n')).toHaveLength(2);
  });

  it('exports are free: Free users get all three', async () => {
    const f = await addFolder();
    for (const format of ['md', 'json', 'csv']) expect((await exportOf(f.id, { format })).status).toBe(200);
  });

  it('writes one audit row per export with the format and file count, and no names or text', async () => {
    const f = await addFolder({ path: dir, name: 'Secret folder name' });
    await exportOf(f.id, { format: 'csv' });
    await exportOf(f.id, { format: 'json' });
    const { entries } = await listAudit({ limit: 50 });
    const rows = entries.filter((r) => r.feature === 'folder_export');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.meta.format).sort()).toEqual(['csv', 'json']);
    expect(rows[0]).toMatchObject({ kind: 'export', page: 'folders', status: 'ok' });
    expect(rows[0].meta.files).toBe(4);
    expect(JSON.stringify(rows)).not.toMatch(/Secret folder name|plan\.txt|tomatoes/);
  });

  it.each([
    ['no body', undefined],
    ['an empty object', {}],
    ['an array', []],
    ['a format that is not offered', { format: 'pdf' }],
    ['a format in the wrong case', { format: 'MD' }],
    ['a format that is not a string', { format: 1 }],
    ['an array format', { format: ['md'] }],
    ['an unknown key beside the format', { format: 'md', extra: 1 }],
    ['an inherited property name', { format: 'toString' }],
    ['a prototype key', { format: '__proto__' }],
  ])('refuses %s with 400 invalid_request', async (_label, body) => {
    const f = await addFolder();
    expectError(await exportOf(f.id, body), 'invalid_request');
  });

  it('refuses a non-JSON body with 415', async () => {
    const f = await addFolder();
    const res = await request(app).post(`/api/folders/${f.id}/export`).set('X-Forwarded-For', nextIp()).set('Content-Type', 'text/plain').send('md');
    expectError(res, 'unsupported_media_type');
  });

  it('answers 404 folder_not_found for an unknown or malformed id (before the body is checked)', async () => {
    for (const id of [NO_FOLDER, 'bad']) {
      expectError(await exportOf(id, { format: 'md' }), 'folder_not_found');
      expectError(await exportOf(id, { format: 'nope' }), 'folder_not_found');
    }
  });
});

describe('no-store on every Folders response', () => {
  it('sets Cache-Control: no-store on successes, errors and exports', async () => {
    const f = await addFolder();
    const responses = [
      await get('/api/folders'),
      await get(`/api/folders/${f.id}/job`),
      await get(`/api/folders/${f.id}/files`),
      await get(`/api/folders/${f.id}/files?limit=0`),
      await get(`/api/folders/${NO_FOLDER}/job`),
      await get('/api/folders/not-a-uuid/files'),
      await post(`/api/folders/${f.id}/export`, { format: 'md' }),
      await post(`/api/folders/${f.id}/export`, { format: 'zip' }),
      await post(`/api/folders/${f.id}/cancel`),
      await post('/api/folders', { path: 'relative' }),
      await patch(f.id, { name: 'x' }),
      await patch(f.id, {}),
      await del(NO_FOLDER),
    ];
    for (const res of responses) expect(res.headers['cache-control'], `${res.status} ${res.req.method} ${res.req.path}`).toBe('no-store');
  });
});

describe('failures never leak internals', () => {
  it('a database failure is 500 folder_failed with fixed copy, and only a code is logged', async () => {
    const f = await addFolder();
    db.exec('ALTER TABLE folders RENAME TO folders_hidden');
    try {
      const res = await get('/api/folders');
      expectError(res, 'folder_failed');
      expect(JSON.stringify(res.body)).not.toMatch(/folders_hidden|no such table|sqlite/i);
      const logged = console.error.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(logged).not.toMatch(/no such table|folders_hidden/i);
    } finally {
      db.exec('ALTER TABLE folders_hidden RENAME TO folders');
    }
    expect((await get('/api/folders')).status).toBe(200);
    expect(f.id).toBeTruthy();
  });
});

describe('rate limits', () => {
  it('the write limiter answers 429 rate_limited after 60 requests from one address in a window', async () => {
    const who = '198.51.100.10';
    for (let i = 0; i < 60; i += 1) {
      const res = await post(`/api/folders/${NO_FOLDER}/cancel`, undefined, who);
      expect(res.status).toBe(404);
    }
    const res = await post(`/api/folders/${NO_FOLDER}/cancel`, undefined, who);
    expectError(res, 'rate_limited');
    expect(res.headers['ratelimit-limit'] ?? res.headers['ratelimit']).toBeDefined();
    // another address is not affected, and reads are not counted against writes
    expect((await post(`/api/folders/${NO_FOLDER}/cancel`, undefined, '198.51.100.11')).status).toBe(404);
    expect((await get('/api/folders', who)).status).toBe(200);
  });

  it('the add, patch, delete and scan routes share the write limiter', async () => {
    const who = '198.51.100.12';
    for (let i = 0; i < 15; i += 1) {
      await post('/api/folders', { path: 'relative' }, who);
      await request(app).patch(`/api/folders/${NO_FOLDER}`).set('X-Forwarded-For', who).send({ name: 'x' });
      await request(app).delete(`/api/folders/${NO_FOLDER}`).set('X-Forwarded-For', who);
      await post(`/api/folders/${NO_FOLDER}/scan`, undefined, who);
    }
    expectError(await post(`/api/folders/${NO_FOLDER}/scan`, undefined, who), 'rate_limited');
    expectError(await post('/api/folders', { path: 'relative' }, who), 'rate_limited');
    expectError(await request(app).delete(`/api/folders/${NO_FOLDER}`).set('X-Forwarded-For', who), 'rate_limited');
  });

  it('the export limiter answers 429 after 30 requests', async () => {
    const who = '198.51.100.15';
    for (let i = 0; i < 30; i += 1) expect((await post(`/api/folders/${NO_FOLDER}/export`, { format: 'md' }, who)).status).toBe(404);
    expectError(await post(`/api/folders/${NO_FOLDER}/export`, { format: 'md' }, who), 'rate_limited');
  });

  it('polling the job is exempt from the app-wide limit of 300 and has its own larger limit of 1200', async () => {
    const who = '198.51.100.16';
    const poll = () => get(`/api/folders/${NO_FOLDER}/job`, who);
    for (let batch = 0; batch < 24; batch += 1) {
      const results = await Promise.all(Array.from({ length: 50 }, poll));
      for (const res of results) expect(res.status).toBe(404); // the folder is unknown, but never rate limited
    }
    expectError(await poll(), 'rate_limited');
    // other reads from the same address are still under the app-wide limiter, which the polls did not use up
    expect((await get('/api/folders', who)).status).toBe(200);
  }, 60000);

  it('other reads are limited by the app-wide limiter (300 per window)', async () => {
    const who = '198.51.100.17';
    let limited = null;
    for (let batch = 0; batch < 7 && !limited; batch += 1) {
      const results = await Promise.all(Array.from({ length: 50 }, () => get('/api/folders', who)));
      limited = results.find((r) => r.status === 429) ?? null;
    }
    expect(limited).not.toBeNull();
  }, 60000);
});

describe('lastJob after a restart', () => {
  it('comes from the stored row when no job is in memory', async () => {
    const row = insertFolder({ name: 'Old', path: dir, pathKey: 'old-key' });
    updateFolder(row.id, { last_job_status: 'interrupted', last_job_error: JSON.stringify({ code: 'shutdown', message: COPY.shutdown[1] }), last_job_at: '2026-10-01T00:00:00.000Z' });
    const f = (await listed()).find((x) => x.id === row.id);
    expect(f.job).toBeNull();
    expect(f.lastJob).toEqual({ status: 'interrupted', errorCode: 'shutdown', message: COPY.shutdown[1], at: '2026-10-01T00:00:00.000Z' });
  });

  it('survives a stored error that is not valid', async () => {
    const row = insertFolder({ name: 'Odd', path: dir, pathKey: 'odd-key' });
    updateFolder(row.id, { last_job_status: 'failed', last_job_error: 'not json', last_job_at: '2026-10-01T00:00:00.000Z' });
    const f = (await listed()).find((x) => x.id === row.id);
    expect(f.lastJob).toMatchObject({ status: 'failed', errorCode: null, message: null });
  });
});
