// Parser worker tests: they need document parsing on and start real parser workers, so they run only in `npm run test:parser`
// (vitest.parser.config.js, issue #67) and return to the default suite when the parser runs in its own process.
// GET /api/folders/:id/files/:fileId/preview for documents (PDF and DOCX) end to end through the real app: PDF page breaks,
// the document cache, the single document parse and abort on disconnect. Synthetic temp folders, fake Ollama.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));

import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import fetch from 'node-fetch';
import { __resetAiForTests } from '../ai/index.js';
import { runDataResetHooks } from '../dataGeneration.js';
import { readTextFile } from '../folders/extract.js';
import { cancelAllFolderJobs, drainFolderJobs, waitForFolderJob } from '../folders/jobs.js';
import { __setParserTimeoutForTests, __setParserWorkerFactoryForTests, activeParserWorkerCount } from '../folders/parseDocs.js';
import { __setPathOptionsForTests } from '../folders/pathSafety.js';
import { clearPreviewCache, previewCacheStats } from '../folders/previewCache.js';
import { getFolder } from '../folders/store.js';
import { __setBusyDelaysForTests } from '../folders/summarize.js';
import { installFakeOllama, textReply } from './helpers/fakeOllama.js';
import { COPY, errorBody, makeTmp, neutralPathOptions, rmTree, writeTree } from './helpers/foldersEnv.js';
import { makeDocx, makePdf } from './helpers/synthDocs.js';
import { closeTestDb, createTestDb, resetDb } from './helpers/testDb.js';

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

/** A parser worker factory that counts calls and runs the real parser. */
function countingFactory(counter) {
  return ({ kind, bytes, limits }) => {
    counter.calls += 1;
    return new Worker(new URL('../folders/parserWorker.js', import.meta.url), { workerData: { kind, bytes, limits }, transferList: [bytes.buffer], env: {} });
  };
}
/** A factory whose worker never answers (until the caller terminates it). */
function hangingFactory(counter) {
  return () => {
    counter.calls += 1;
    return new Worker("require('node:worker_threads').parentPort.postMessage({ ready: true }); setInterval(() => {}, 1000);", { eval: true });
  };
}

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
  __setParserWorkerFactoryForTests(null);
  __setParserTimeoutForTests(null);
  vi.restoreAllMocks();
});

describe('documents', () => {
  it('returns PDF text with page breaks and the same text the summaries use', async () => {
    const pdf = makePdf([['Page one alpha'], ['Page two bravo'], ['Page three charlie']]);
    const { folder, files } = await scanned({ 'doc.pdf': pdf });
    const res = await preview(folder, files['doc.pdf']);
    expect(res.status).toBe(200);
    const p = res.body.data.preview;
    expect(p).toMatchObject({ kind: 'document', reason: null, truncated: false });
    expect(p.pageBreaks).toHaveLength(2);
    expect(p.text.slice(p.pageBreaks[0]).startsWith('Page two bravo')).toBe(true);
    expect(p.text.slice(p.pageBreaks[1]).startsWith('Page three charlie')).toBe(true);
    expect(p.text[p.pageBreaks[0] - 1]).toBe('\n');
    expect(p.text.startsWith('Page one alpha')).toBe(true);
    // Nothing was inserted: it is exactly the text the scan reads.
    const read = await readTextFile(path.join(dir, 'doc.pdf'), { rootKey: getFolder(folder.id).path_key });
    expect(p.text).toBe(read.text);
    expect(p.shownChars).toBe(p.text.length);
    expect(p.totalChars).toBe(read.text.length);
  });

  it('returns DOCX text with no page breaks', async () => {
    const { folder, files } = await scanned({ 'doc.docx': makeDocx(['First paragraph', 'Second paragraph'], { header: 'Head', footer: 'Foot' }) });
    const p = (await preview(folder, files['doc.docx'])).body.data.preview;
    expect(p).toMatchObject({ kind: 'document', pageBreaks: null, truncated: false });
    expect(p.text).toContain('First paragraph');
    expect(p.text).toContain('Second paragraph');
  });

  it('does not parse a cached document again, and a changed file is never served from the cache', async () => {
    const pdf = makePdf([['Cached page one'], ['Cached page two']]);
    const { folder, files } = await scanned({ 'doc.pdf': pdf });
    const counter = { calls: 0 };
    __setParserWorkerFactoryForTests(countingFactory(counter));
    const first = await preview(folder, files['doc.pdf']);
    expect(first.status).toBe(200);
    expect(counter.calls).toBe(1);
    expect(previewCacheStats().entries).toBe(1);
    const second = await preview(folder, files['doc.pdf']);
    expect(second.body).toEqual(first.body);
    expect(counter.calls).toBe(1);

    // Same size, same mtime, different bytes: the file is read, its hash differs, nothing stale is returned.
    const file = path.join(dir, 'doc.pdf');
    const when = fs.statSync(file).mtime;
    const edited = Buffer.from(pdf);
    const at = edited.indexOf('Cached page one');
    edited.write('Edited page one', at, 'latin1');
    fs.writeFileSync(file, edited);
    fs.utimesSync(file, when, when);
    const changed = await preview(folder, files['doc.pdf']);
    expectError(changed, 'folder_file_changed');
    expect(JSON.stringify(changed.body)).not.toMatch(/Cached|Edited/);

    // A rescan clears the folder's entries; the new content is then parsed and served.
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(file, later, later);
    const after = await rescan(folder.id);
    expect(previewCacheStats().entries).toBe(0);
    const fresh = await preview(folder, after['doc.pdf']);
    expect(fresh.body.data.preview.text).toContain('Edited page one');
  });

  it('clears the cache on a data reset and when the folder is removed', async () => {
    const { folder, files } = await scanned({ 'doc.pdf': makePdf([['Reset page']]) });
    expect((await preview(folder, files['doc.pdf'])).status).toBe(200);
    expect(previewCacheStats().entries).toBe(1);
    runDataResetHooks();
    expect(previewCacheStats().entries).toBe(0);
    expect((await preview(folder, files['doc.pdf'])).status).toBe(200);
    expect(previewCacheStats().entries).toBe(1);
    const res = await request(app).delete(`/api/folders/${folder.id}`).set('X-Forwarded-For', nextIp());
    expect(res.status).toBe(200);
    expect(previewCacheStats().entries).toBe(0);
  });

  it('allows one document parse at a time (429 for another), and a client abort ends the parse', async () => {
    const { folder, files } = await scanned({
      'one.pdf': makePdf([['First document']]),
      'two.pdf': makePdf([['Second document']]),
      'note.txt': 'plain note\n',
    });
    const counter = { calls: 0 };
    __setParserWorkerFactoryForTests(hangingFactory(counter));
    __setParserTimeoutForTests(10_000);
    const first = get(previewUrl(folder.id, files['one.pdf'].id));
    first.end(() => {});
    await waitUntil(() => counter.calls === 1 && activeParserWorkerCount() === 1);

    const busy = await preview(folder, files['two.pdf']);
    expectError(busy, 'folder_preview_busy');
    expect(counter.calls).toBe(1);
    // Plain text is not held up by the document in flight.
    expect((await preview(folder, files['note.txt'])).status).toBe(200);

    first.abort();
    await waitUntil(() => activeParserWorkerCount() === 0);

    // The slot is free again.
    __setParserWorkerFactoryForTests(null);
    const next = await preview(folder, files['two.pdf']);
    expect(next.status).toBe(200);
    expect(next.body.data.preview.text).toContain('Second document');
    expect(activeParserWorkerCount()).toBe(0);
  });

  it('a parse that times out answers 200 none (unreadable) and releases the slot', async () => {
    const { folder, files } = await scanned({ 'one.pdf': makePdf([['First document']]) });
    const counter = { calls: 0 };
    __setParserWorkerFactoryForTests(hangingFactory(counter));
    __setParserTimeoutForTests(150);
    const res = await preview(folder, files['one.pdf']);
    expect(res.status).toBe(200);
    expect(res.body.data.preview).toMatchObject({ kind: 'none', reason: 'unreadable', text: null });
    expect(activeParserWorkerCount()).toBe(0);
    __setParserWorkerFactoryForTests(null);
    expect((await preview(folder, files['one.pdf'])).status).toBe(200);
  });
});
