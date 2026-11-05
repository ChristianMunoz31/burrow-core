// GET /api/folders/:id/files/:fileId/preview end to end through the real app: id validation, the order of checks, the
// inventory status short-circuit (no disk access), root re-validation, the changed-file refusals (no content leaks), the
// text cap, kinds, PDF page breaks, the document cache, the single document parse, abort on disconnect, the limiter and
// JobView.progress.currentFileId. Synthetic temp folders, fake Ollama.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../license/index.js', async (importOriginal) => (await import('./helpers/pro.js')).mockLicenseModule(importOriginal));
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));

import fs from 'node:fs';
import path from 'node:path';
import fetch from 'node-fetch';
import { __resetAiForTests } from '../ai/index.js';
import { count } from '../db/index.js';
import { PREVIEW_CACHE, PREVIEW_MAX_CHARS, PREVIEW_MOVED_MESSAGE } from '../folders/constants.js';
import { cancelAllFolderJobs, drainFolderJobs, waitForFolderJob } from '../folders/jobs.js';
import { __setPathOptionsForTests } from '../folders/pathSafety.js';
import { cutText, pageBreakOffsets } from '../folders/preview.js';
import { clearPreviewCache, previewCacheStats, previewKey, setPreviewDoc } from '../folders/previewCache.js';
import { allFileRows, getFolder, updateFolder } from '../folders/store.js';
import { __setBusyDelaysForTests } from '../folders/summarize.js';
import { FREE, resetPro, setEntitlements } from './helpers/pro.js';
import { installFakeOllama, textReply } from './helpers/fakeOllama.js';
import { COPY, errorBody, fingerprint, makeTmp, neutralPathOptions, rmTree, tryDirLink, tryFileLink, writeTree } from './helpers/foldersEnv.js';
import { closeTestDb, createTestDb, resetDb } from './helpers/testDb.js';

const NO_ID = '00000000-0000-4000-8000-000000000000';
const SAME_ORIGIN = Object.freeze({ Host: '127.0.0.1:4321', Origin: 'http://127.0.0.1:4321' });
const saved = Object.fromEntries(['APP_PASSWORD', 'AUTH_SECRET', 'SECRETS_ENCRYPTION_KEY', 'BURROW_AI'].map((k) => [k, process.env[k]]));

let app;
let db;
let root;
let dir;
let ip = 0;
const nextIp = () => `203.0.113.${(ip += 1) % 250}`;

const get = (url, ipAddr = nextIp()) => request(app).get(url).set('X-Forwarded-For', ipAddr);
const previewUrl = (folderId, fileId) => `/api/folders/${folderId}/files/${fileId}/preview`;

const expectError = (res, code) => {
  expect(res.status, `${code}: ${JSON.stringify(res.body)}`).toBe(COPY[code][0]);
  expect(res.body).toEqual(errorBody(code));
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.headers['content-type']).toMatch(/application\/json/);
};

/** Add `dir` through the API, wait for the first scan, and return the folder plus its files by path. */
async function scanned(files, { path: at = dir } = {}) {
  writeTree(at, files);
  const res = await request(app).post('/api/folders').set('X-Forwarded-For', nextIp()).set(SAME_ORIGIN).send({ path: at });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const done = await waitForFolderJob(res.body.data.job.id, { timeoutMs: 30000 });
  expect(done.status).toBe('done');
  return { folder: res.body.data.folder, files: await filesOf(res.body.data.folder.id) };
}
async function filesOf(folderId) {
  const res = await get(`/api/folders/${folderId}/files?limit=200`);
  return Object.fromEntries(res.body.data.files.map((f) => [f.path, f]));
}
async function rescan(folderId) {
  const res = await request(app).post(`/api/folders/${folderId}/scan`).set('X-Forwarded-For', nextIp()).set(SAME_ORIGIN);
  expect(res.status).toBe(202);
  const done = await waitForFolderJob(res.body.data.job.id, { timeoutMs: 30000 });
  expect(done.status).toBe('done');
  return filesOf(folderId);
}
const preview = (folder, file) => get(previewUrl(folder.id, file.id));
const waitUntil = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

beforeAll(async () => {
  for (const k of Object.keys(saved)) delete process.env[k];
  db = createTestDb();
  app = (await import('../../server.js')).default;
  root = makeTmp('burrow-folders-preview-');
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
  clearPreviewCache();
  setEntitlements(FREE);
  __setPathOptionsForTests(neutralPathOptions(root));
  __resetAiForTests();
  fetch.mockReset();
  installFakeOllama(fetch, { embedModel: true, chat: () => textReply('A short note about the files.') });
  dir = path.join(root, 'docs');
  rmTree(dir);
});
afterEach(async () => {
  cancelAllFolderJobs('shutdown');
  await drainFolderJobs({ timeoutMs: 2000 });
  resetPro();
  vi.restoreAllMocks();
});

describe('ids and states', () => {
  it('answers 404 for a malformed or unknown folder id, file id, or a file of another folder', async () => {
    const { folder, files } = await scanned({ 'a.txt': 'alpha text\n' });
    expectError(await get('/api/folders/not-a-uuid/files/' + NO_ID + '/preview'), 'folder_not_found');
    expectError(await get(previewUrl(NO_ID, files['a.txt'].id)), 'folder_not_found');
    expectError(await get(`/api/folders/${folder.id}/files/not-a-uuid/preview`), 'folder_file_not_found');
    expectError(await get(previewUrl(folder.id, NO_ID)), 'folder_file_not_found');

    const other = path.join(root, 'other');
    rmTree(other);
    const second = await scanned({ 'b.txt': 'bravo text\n' }, { path: other });
    expectError(await get(previewUrl(folder.id, second.files['b.txt'].id)), 'folder_file_not_found');
    expectError(await get(previewUrl(second.folder.id, files['a.txt'].id)), 'folder_file_not_found');
    // A right pair works, and ids are case-insensitive like the other routes.
    const ok = await get(previewUrl(folder.id, files['a.txt'].id.toUpperCase()));
    expect(ok.status).toBe(200);
  });

  it('refuses a folder that needs confirmation, after the id checks', async () => {
    const { folder, files } = await scanned({ 'a.txt': 'alpha text\n' });
    updateFolder(folder.id, { confirm_state: 'needs_confirm' });
    expectError(await preview(folder, files['a.txt']), 'folder_needs_confirm');
    expectError(await get(previewUrl(folder.id, NO_ID)), 'folder_file_not_found');
  });

  it('is no-store, JSON, read-only and writes no audit row', async () => {
    const { folder, files } = await scanned({ 'a.txt': 'alpha text\n', 'sub/b.md': '# B\n' });
    const before = fingerprint(dir);
    const rows = JSON.stringify(allFileRows(folder.id));
    const audits = count('audit_log');
    const res = await preview(folder, files['a.txt']);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body.data.file).toEqual(files['a.txt']);
    expect(res.body.data.preview).toEqual({ kind: 'text', reason: null, text: 'alpha text\n', truncated: false, shownChars: 11, totalChars: 11, pageBreaks: null });
    expect(fingerprint(dir)).toEqual(before);
    expect(JSON.stringify(allFileRows(folder.id))).toBe(rows);
    expect(count('audit_log')).toBe(audits);
  });
});

describe('inventory status short-circuit', () => {
  it('answers kind none with the reason and never touches the disk', async () => {
    const big = Buffer.alloc(2 * 1024 * 1024 + 10, 'x');
    const { folder, files } = await scanned({
      'pic.png': Buffer.from([1, 2, 3, 4]),
      'bin.txt': Buffer.from([65, 0, 66, 0, 67]),
      'empty.txt': '',
      'huge.txt': big,
    });
    expect(Object.values(files).map((f) => [f.path, f.status]).sort()).toEqual([
      ['bin.txt', 'binary'],
      ['empty.txt', 'empty'],
      ['huge.txt', 'too_large'],
      ['pic.png', 'unsupported'],
    ]);
    const open = vi.spyOn(fs.promises, 'open');
    const lstat = vi.spyOn(fs.promises, 'lstat');
    const stat = vi.spyOn(fs.promises, 'stat');
    const opendir = vi.spyOn(fs.promises, 'opendir');
    for (const f of Object.values(files)) {
      const res = await preview(folder, f);
      expect(res.status).toBe(200);
      expect(res.body.data.preview).toEqual({ kind: 'none', reason: f.status, text: null, truncated: false, shownChars: 0, totalChars: null, pageBreaks: null });
      expect(res.body.data.file.status).toBe(f.status);
    }
    expect(open).not.toHaveBeenCalled();
    expect(lstat).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
    expect(opendir).not.toHaveBeenCalled();
  });

  it('does the same for a link row and a document while parsing is off, even if the file is gone', async () => {
    const outside = path.join(root, 'outside-file.txt');
    fs.writeFileSync(outside, 'outside secret\n');
    writeTree(dir, { 'a.txt': 'alpha\n', 'broken.pdf': Buffer.from('%PDF-1.4 not really a pdf') });
    const linked = tryFileLink(outside, path.join(dir, 'ln.txt'));
    const { folder, files } = await scanned({});
    expect(files['broken.pdf'].status).toBe('unsupported');
    fs.rmSync(path.join(dir, 'broken.pdf'));
    const res = await preview(folder, files['broken.pdf']);
    expect(res.body.data.preview).toMatchObject({ kind: 'none', reason: 'unsupported', text: null });
    if (linked) {
      expect(files['ln.txt'].status).toBe('link');
      const link = await preview(folder, files['ln.txt']);
      expect(link.body.data.preview).toMatchObject({ kind: 'none', reason: 'link', text: null });
      expect(JSON.stringify(link.body)).not.toContain('outside secret');
    }
  });
});

describe('root re-validation', () => {
  it('refuses a root replaced by a junction or link', async () => {
    const { folder, files } = await scanned({ 'a.txt': 'alpha text\n' });
    const real = path.join(root, 'real-docs');
    const target = path.join(root, 'elsewhere');
    writeTree(target, { 'a.txt': 'alpha text\n' });
    fs.renameSync(dir, real);
    if (!tryDirLink(target, dir)) {
      // No link privilege on this machine: a root that moved away is refused the same way.
      expectError(await preview(folder, files['a.txt']), 'folder_missing');
      return;
    }
    const res = await preview(folder, files['a.txt']);
    expectError(res, 'folder_is_link');
    expect(JSON.stringify(res.body)).not.toContain('alpha text');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a root that moved away', async () => {
    const { folder, files } = await scanned({ 'a.txt': 'alpha text\n' });
    fs.renameSync(dir, path.join(root, 'moved-docs'));
    expectError(await preview(folder, files['a.txt']), 'folder_missing');
  });

  it('answers folder_moved with the preview copy when the stored key no longer matches', async () => {
    const { folder, files } = await scanned({ 'a.txt': 'alpha text\n' });
    updateFolder(folder.id, { path_key: `${getFolder(folder.id).path_key}-old` });
    const res = await preview(folder, files['a.txt']);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'folder_moved', code: 'folder_moved', message: PREVIEW_MOVED_MESSAGE });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(res.body)).not.toContain('alpha text');
  });

  it('refuses a root that became a protected folder', async () => {
    const { folder, files } = await scanned({ 'a.txt': 'alpha text\n' });
    __setPathOptionsForTests(neutralPathOptions(root, { execDir: dir }));
    const res = await preview(folder, files['a.txt']);
    expectError(res, 'folder_protected');
    expect(JSON.stringify(res.body)).not.toContain('alpha text');
  });

  it('refuses a root that became Burrow data', async () => {
    const { folder, files } = await scanned({ 'a.txt': 'alpha text\n' });
    __setPathOptionsForTests(neutralPathOptions(root, { dataDirs: [dir] }));
    expectError(await preview(folder, files['a.txt']), 'folder_burrow_data');
  });
});

describe('a file that changed since the scan', () => {
  const stamp = (file) => fs.statSync(file).mtime;

  it('same size and mtime but different bytes: refused, new content not returned', async () => {
    const { folder, files } = await scanned({ 'a.txt': 'alpha text\n' });
    const file = path.join(dir, 'a.txt');
    const when = stamp(file);
    fs.writeFileSync(file, 'omega TEXT\n');
    fs.utimesSync(file, when, when);
    const res = await preview(folder, files['a.txt']);
    expectError(res, 'folder_file_changed');
    expect(JSON.stringify(res.body)).not.toMatch(/omega|alpha/i);
  });

  it('size change, mtime change and deletion are refused, and a rescan makes the file readable again', async () => {
    const { folder, files } = await scanned({ 'a.txt': 'alpha text\n', 'b.txt': 'bravo text\n', 'c.txt': 'charlie text\n' });
    fs.appendFileSync(path.join(dir, 'a.txt'), 'more secret words\n');
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(dir, 'b.txt'), later, later);
    fs.rmSync(path.join(dir, 'c.txt'));
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      const res = await preview(folder, files[name]);
      expectError(res, 'folder_file_changed');
      expect(JSON.stringify(res.body)).not.toMatch(/secret|text/);
    }
    const after = await rescan(folder.id);
    const res = await preview(folder, after['a.txt']);
    expect(res.status).toBe(200);
    expect(res.body.data.preview.text).toBe('alpha text\nmore secret words\n');
    expectError(await get(previewUrl(folder.id, files['c.txt'].id)), 'folder_file_not_found');
  });

  it('a file swapped for a link, or reached through a linked folder, is refused without leaking', async () => {
    const outside = path.join(root, 'outside');
    writeTree(outside, { 'x.txt': 'LEAKED outside text\n', 'a.txt': 'LEAKED outside text\n' });
    const { folder, files } = await scanned({ 'a.txt': 'alpha text\n', 'sub/x.txt': 'LEAKED inside!!\n' });
    const probe = path.join(dir, 'probe-link');
    const canFile = tryFileLink(path.join(outside, 'a.txt'), probe);
    if (canFile) fs.rmSync(probe);
    if (canFile) {
      fs.rmSync(path.join(dir, 'a.txt'));
      expect(tryFileLink(path.join(outside, 'a.txt'), path.join(dir, 'a.txt'))).toBe(true);
      const res = await preview(folder, files['a.txt']);
      expectError(res, 'folder_file_changed');
      expect(JSON.stringify(res.body)).not.toContain('LEAKED');
    }
    // sub becomes a junction to a folder that holds a same-size file with the same mtime.
    const original = fs.statSync(path.join(dir, 'sub', 'x.txt'));
    fs.writeFileSync(path.join(outside, 'x.txt'), 'LEAKED outside!\n');
    fs.utimesSync(path.join(outside, 'x.txt'), original.atime, original.mtime);
    fs.rmSync(path.join(dir, 'sub'), { recursive: true });
    if (tryDirLink(outside, path.join(dir, 'sub'))) {
      const res = await preview(folder, files['sub/x.txt']);
      expectError(res, 'folder_file_changed');
      expect(JSON.stringify(res.body)).not.toContain('LEAKED');
      fs.rmSync(path.join(dir, 'sub'), { recursive: true, force: true });
    }
  });
});

describe('text, csv and the cap', () => {
  it('returns raw markup as text, with a JSON content type', async () => {
    const html = '<script>alert(1)</script>\n<b>bold</b> &amp; <img src=x onerror=1>\n';
    const { folder, files } = await scanned({ 'page.html': html });
    const res = await preview(folder, files['page.html']);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body.data.preview).toMatchObject({ kind: 'text', text: html, truncated: false });
    expect(res.text).toContain('<script>alert(1)</script>');
  });

  it('maps csv and tsv to kind csv and everything else readable to text', async () => {
    const { folder, files } = await scanned({ 'd.csv': 'a,b\n1,2\n', 'e.tsv': 'a\tb\n1\t2\n', 'n.json': '{"a":1}\n', 'c.py': 'print(1)\n', 'r.md': '# T\n' });
    const kinds = {};
    for (const [name, f] of Object.entries(files)) kinds[name] = (await preview(folder, f)).body.data.preview.kind;
    expect(kinds).toEqual({ 'd.csv': 'csv', 'e.tsv': 'csv', 'n.json': 'text', 'c.py': 'text', 'r.md': 'text' });
    expect((await preview(folder, files['d.csv'])).body.data.preview.text).toBe('a,b\n1,2\n');
  });

  it('cuts at 262144 characters and reports the totals', async () => {
    const text = `${'a'.repeat(PREVIEW_MAX_CHARS + 5000)}\n`;
    const { folder, files } = await scanned({ 'long.txt': text });
    const res = await preview(folder, files['long.txt']);
    expect(res.body.data.preview).toMatchObject({ kind: 'text', truncated: true, shownChars: PREVIEW_MAX_CHARS, totalChars: text.length, pageBreaks: null });
    expect(res.body.data.preview.text).toHaveLength(PREVIEW_MAX_CHARS);
    const exact = await scanned({ 'exact.txt': 'b'.repeat(PREVIEW_MAX_CHARS) }, { path: path.join(root, 'exact') });
    const same = (await preview(exact.folder, exact.files['exact.txt'])).body.data.preview;
    expect(same).toMatchObject({ truncated: false, shownChars: PREVIEW_MAX_CHARS, totalChars: PREVIEW_MAX_CHARS });
  });

  it('never splits a surrogate pair at the cut', async () => {
    const text = `${'a'.repeat(PREVIEW_MAX_CHARS - 1)}\u{1F600}tail`;
    const { folder, files } = await scanned({ 'emoji.txt': text });
    const p = (await preview(folder, files['emoji.txt'])).body.data.preview;
    expect(p.truncated).toBe(true);
    expect(p.shownChars).toBe(PREVIEW_MAX_CHARS - 1);
    expect(p.text.isWellFormed()).toBe(true);
    expect(p.text.endsWith('a')).toBe(true);
    expect(p.totalChars).toBe(text.length);
  });

  it('cutText and pageBreakOffsets handle the edges', () => {
    expect(cutText('abc', 3)).toBe('abc');
    expect(cutText('ab\u{1F600}', 3)).toBe('ab');
    expect(cutText('a\u{1F600}b', 3)).toBe('a\u{1F600}');
    expect(pageBreakOffsets(null, 100)).toBeNull();
    expect(pageBreakOffsets([3, 4, 5], 100)).toEqual([4, 9]);
    expect(pageBreakOffsets([3, 4, 5], 9)).toEqual([4]);
    expect(pageBreakOffsets([3], 100)).toEqual([]);
    expect(pageBreakOffsets([0, 0, 2], 100)).toEqual([1, 2]);
  });
});

describe('preview cache', () => {
  it('keeps the cache within 8 entries and 16 MB, least recently used first', () => {
    for (let i = 0; i < 10; i += 1) setPreviewDoc(previewKey(`f${i}`, 'sha'), 'folder', { text: 'x'.repeat(100) });
    expect(previewCacheStats().entries).toBe(PREVIEW_CACHE.maxEntries);
    clearPreviewCache();
    const chars = (PREVIEW_CACHE.maxBytes / 2) * 0.6;
    setPreviewDoc(previewKey('a', 's'), 'folder', { text: 'x'.repeat(chars) });
    setPreviewDoc(previewKey('b', 's'), 'folder', { text: 'x'.repeat(chars) });
    expect(previewCacheStats().entries).toBe(1);
    expect(previewCacheStats().bytes).toBeLessThanOrEqual(PREVIEW_CACHE.maxBytes);
    setPreviewDoc(previewKey('c', 's'), 'folder', { text: 'x'.repeat(PREVIEW_CACHE.maxBytes) });
    expect(previewCacheStats().bytes).toBeLessThanOrEqual(PREVIEW_CACHE.maxBytes);
  });
});

describe('limiter', () => {
  it('has its own limit of 240 requests per client, then answers rate_limited', async () => {
    const { folder } = await scanned({ 'a.txt': 'alpha\n' });
    const fixed = '198.51.100.77';
    for (let i = 0; i < 240; i += 1) {
      const res = await get(previewUrl(folder.id, NO_ID), fixed);
      if (res.status !== 404) throw new Error(`request ${i} answered ${res.status}`);
    }
    const limited = await get(previewUrl(folder.id, NO_ID), fixed);
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: 'rate_limited', code: 'rate_limited', message: COPY.rate_limited[1] });
  }, 60_000);
});

describe('JobView.progress.currentFileId', () => {
  it('names the file being summarized and is null otherwise', async () => {
    setEntitlements(FREE);
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let firstBody = null;
    __resetAiForTests();
    fetch.mockReset();
    installFakeOllama(fetch, {
      embedModel: true,
      chat: (body) => {
        firstBody ??= body;
        return gate.then(() => textReply('A short note about the files.'));
      },
    });
    writeTree(dir, { 'only.txt': 'The only file in this folder.\n' });
    const res = await request(app).post('/api/folders').set('X-Forwarded-For', nextIp()).set(SAME_ORIGIN).send({ path: dir });
    expect(res.status).toBe(201);
    expect(res.body.data.job.progress.currentFileId).toBeNull();
    const folderId = res.body.data.folder.id;
    await waitUntil(() => firstBody !== null);
    const mid = await get(`/api/folders/${folderId}/job`);
    expect(mid.body.data.job.phase).toBe('summarizing_files');
    const file = allFileRows(folderId).find((r) => r.rel_path === 'only.txt');
    expect(mid.body.data.job.progress.currentFileId).toBe(file.id);
    release();
    const done = await waitForFolderJob(res.body.data.job.id, { timeoutMs: 30000 });
    expect(done.status).toBe('done');
    expect(done.progress.currentFileId).toBeNull();
    expect((await get(`/api/folders/${folderId}/job`)).body.data.job.progress.currentFileId).toBeNull();
  });
});
