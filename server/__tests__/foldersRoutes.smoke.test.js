// Smoke test of the Folders backend end to end: add a synthetic temp folder, scan it against the fake Ollama, read the
// summary and the file list and export Markdown, JSON and CSV. The folder lives under
// os.tmpdir() and is checked to be byte for byte unchanged afterwards.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// Pro is on for this file (the gate itself is covered in proTierMatrix.test.js).
vi.mock('../license/index.js', async (importOriginal) => (await import('./helpers/pro.js')).mockLicenseModule(importOriginal));
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fetch from 'node-fetch';
import { __resetAiForTests } from '../ai/index.js';
import { __setBusyDelaysForTests } from '../folders/summarize.js';
import { __setPathOptionsForTests } from '../folders/pathSafety.js';
import { waitForFolderJob } from '../folders/jobs.js';
import { fakeEmbedding, installFakeOllama, textReply } from './helpers/fakeOllama.js';
import { closeTestDb, createTestDb, resetDb } from './helpers/testDb.js';

const SAME_ORIGIN = Object.freeze({ Host: '127.0.0.1:4321', Origin: 'http://127.0.0.1:4321' });
const saved = Object.fromEntries(['APP_PASSWORD', 'AUTH_SECRET', 'SECRETS_ENCRYPTION_KEY', 'BURROW_AI'].map((k) => [k, process.env[k]]));
let app;
let db;
let ip = 0;
const nextIp = () => `203.0.113.${(ip += 1) % 250}`;
let root;
let folderDir;
let fake;

const get = (url) => request(app).get(url).set('X-Forwarded-For', nextIp());
const post = (url, body) => request(app).post(url).set('X-Forwarded-For', nextIp()).set(SAME_ORIGIN).send(body);

/** Hash and mtime of every file under a folder. */
function fingerprint(dir) {
  const out = {};
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = [crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'), fs.statSync(full).mtimeMs];
    }
  };
  walk(dir);
  return out;
}

async function addFolder(name) {
  const res = await post('/api/folders', { path: folderDir, ...(name ? { name } : {}) });
  expect(res.status).toBe(201);
  const done = await waitForFolderJob(res.body.data.job.id, { timeoutMs: 20000 });
  expect(done.status).toBe('done');
  return { res, done };
}

beforeAll(async () => {
  for (const k of Object.keys(saved)) delete process.env[k];
  db = createTestDb();
  app = (await import('../../server.js')).default;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-folders-smoke-'));
  // The temp folder sits inside the real AppData on Windows: give the path rules a neutral environment.
  __setPathOptionsForTests({ env: {}, home: path.join(root, 'fake-home'), execDir: path.join(root, 'fake-exec') });
  __setBusyDelaysForTests([1, 1, 1]);
});
afterAll(() => {
  __setPathOptionsForTests(null);
  __setBusyDelaysForTests(null);
  closeTestDb(db);
  fs.rmSync(root, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
beforeEach(() => {
  resetDb(db);
  __resetAiForTests();
  fetch.mockReset();
  fake = installFakeOllama(fetch, { embedModel: true, embed: (body) => body.input.map((t) => (t.includes('zzzz') ? new Array(8).fill(-1) : fakeEmbedding(t))), chat: () => textReply('A short note about the files.') });
  folderDir = path.join(root, 'notes');
  fs.rmSync(folderDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(folderDir, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(folderDir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(folderDir, 'plan.txt'), 'The garden plan has tomatoes and peppers.\nWater them every morning.\n');
  fs.writeFileSync(path.join(folderDir, 'sub', 'recipe.md'), '# Soup\nTomatoes, basil and garlic.\n');
  fs.writeFileSync(path.join(folderDir, 'sub', 'copy.md'), '# Soup\nTomatoes, basil and garlic.\n');
  fs.writeFileSync(path.join(folderDir, '=data.csv'), 'a,b\n1,2\n');
  fs.writeFileSync(path.join(folderDir, 'picture.png'), 'not really a picture');
  fs.writeFileSync(path.join(folderDir, 'blob.txt'), Buffer.from([65, 0, 66, 0, 67, 0]));
  fs.writeFileSync(path.join(folderDir, 'node_modules', 'skipped.txt'), 'never listed');
  fs.writeFileSync(path.join(folderDir, '.hidden.txt'), 'never listed');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('Folders backend smoke', () => {
  it('adds, scans and summarizes a folder without touching a file', async () => {
    const before = fingerprint(folderDir);
    const { res, done } = await addFolder();
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data.folder).toMatchObject({ name: 'notes', autoRescan: false, warnings: [] });
    expect(done.error).toBeNull();

    const list = await get('/api/folders');
    expect(list.status).toBe(200);
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.body.data.limits).toMatchObject({ maxFolders: 20, maxFiles: 5000, embedModel: 'nomic-embed-text' });
    const [folder] = list.body.data.folders;
    expect(folder.summary).toMatchObject({ status: 'ok', text: 'A short note about the files.' });
    expect(folder.lastScanAt).toEqual(expect.any(String));
    expect(folder.stats).toMatchObject({ filesTotal: 6, filesRead: 4, duplicateGroups: 1, dirsSkipped: 1 });
    expect(folder.stats.byStatus).toMatchObject({ ok: 4, unsupported: 1, binary: 1 });

    const files = await get(`/api/folders/${folder.id}/files?sort=size&dir=desc&limit=3`);
    expect(files.status).toBe(200);
    expect(files.body.data).toMatchObject({ total: 6, offset: 0, limit: 3 });
    expect(files.body.data.files).toHaveLength(3);
    const all = (await get(`/api/folders/${folder.id}/files`)).body.data.files;
    expect(all.map((f) => f.path)).toEqual(['=data.csv', 'blob.txt', 'picture.png', 'plan.txt', 'sub/copy.md', 'sub/recipe.md']);
    expect(all.find((f) => f.path === 'plan.txt')).toMatchObject({ status: 'ok', summaryStatus: 'ok', indexed: false, lines: 2 });
    expect(all.find((f) => f.path === 'picture.png')).toMatchObject({ status: 'unsupported', summaryStatus: 'not_text' });

    expect(fingerprint(folderDir)).toEqual(before);
    // Every chat prompt carried precomputed facts and the file text in a fence.
    expect(fake.chatBodies.length).toBeGreaterThan(0);
    for (const body of fake.chatBodies) expect(JSON.stringify(body.messages)).toContain('exactly as written');
  });

  it('exports Markdown, JSON and CSV, with the injection guard on the CSV', async () => {
    await addFolder('My notes');
    const [folder] = (await get('/api/folders')).body.data.folders;
    const md = await post(`/api/folders/${folder.id}/export`, { format: 'md' });
    expect(md.status).toBe(200);
    expect(md.headers['content-type']).toMatch(/^text\/markdown/);
    expect(md.headers['content-disposition']).toMatch(/^attachment; filename="burrow-folder-my-notes-\d{4}-\d{2}-\d{2}\.md"$/);
    expect(md.headers['access-control-expose-headers']).toBe('Content-Disposition');
    expect(md.text).toContain('# Folder report: My notes');
    expect(md.text).toContain('plan.txt');

    const json = await post(`/api/folders/${folder.id}/export`, { format: 'json' });
    expect(json.status).toBe(200);
    expect(json.headers['content-type']).toMatch(/^application\/json/);
    expect(JSON.parse(json.text)).toMatchObject({ format: 'burrow-folder', folder: { name: 'My notes' } });
    expect(JSON.parse(json.text).files).toHaveLength(6);

    const csv = await post(`/api/folders/${folder.id}/export`, { format: 'csv' });
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/^text\/csv/);
    expect(csv.text.split('\r\n')[0]).toBe('Path,Extension,Kind,Status,Size (bytes),Modified,Lines,Words,Summary');
    expect(csv.text).toContain("'=data.csv");
    expect(csv.text).not.toMatch(/^=data/m);

    const bad = await post(`/api/folders/${folder.id}/export`, { format: 'pdf' });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: 'invalid_request', code: 'invalid_request' });
  });

  it('removes a folder from Burrow and leaves the files alone', async () => {
    const before = fingerprint(folderDir);
    await addFolder();
    const [folder] = (await get('/api/folders')).body.data.folders;
    const del = await request(app).delete(`/api/folders/${folder.id}`).set('X-Forwarded-For', nextIp());
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ data: { removed: true } });
    expect((await get('/api/folders')).body.data.folders).toEqual([]);
    expect(fingerprint(folderDir)).toEqual(before);
  });

  it('refuses a bad path, a duplicate, a foreign origin and a missing folder with fixed copy', async () => {
    const relative = await post('/api/folders', { path: 'notes' });
    expect(relative.status).toBe(422);
    expect(relative.body.code).toBe('folder_path_invalid');
    const missing = await post('/api/folders', { path: path.join(root, 'nope') });
    expect(missing.body.code).toBe('folder_missing');
    const foreign = await request(app).post('/api/folders').set('X-Forwarded-For', nextIp()).set({ Host: '127.0.0.1:4321', Origin: 'http://localhost:5174' }).send({ path: folderDir });
    expect(foreign.status).toBe(403);
    expect(foreign.body.code).toBe('folder_origin_blocked');
    await addFolder();
    const dupe = await post('/api/folders', { path: folderDir });
    expect(dupe.status).toBe(409);
    expect(dupe.body.code).toBe('folder_exists');
    const unknown = await get('/api/folders/not-a-uuid/job');
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('folder_not_found');
  });
});
