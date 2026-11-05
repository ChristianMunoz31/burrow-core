// Parser worker tests: they need document parsing on and start real parser workers, so they run only in `npm run test:parser`
// (vitest.parser.config.js, issue #67) and return to the default suite when the parser runs in its own process.
// Round 3 security-review fixes for the Folders preview: the exact limiter exemption, the process-wide parse slot (a preview
// and a scan job never judge each other's memory), the expected-sha256 refusal before any parse or cache write, a stale data
// generation or removed folder during a slow parse, the ext and path agreement, reserved Windows names and the
// needs-confirm guard of previewFile itself. Synthetic temp folders, fake Ollama, fake parser workers.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../license/index.js', async (importOriginal) => (await import('./helpers/pro.js')).mockLicenseModule(importOriginal));
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import fetch from 'node-fetch';
import { __resetAiForTests } from '../ai/index.js';
import { __resetDataGenerationForTests, bumpDataGeneration } from '../dataGeneration.js';
import { readTextFile } from '../folders/extract.js';
import { cancelAllFolderJobs, drainFolderJobs, waitForFolderJob } from '../folders/jobs.js';
import { __setParserMemoryGuardForTests, __setParserTimeoutForTests, __setParserWorkerFactoryForTests, acquireParseSlot, activeParserWorkerCount, tryAcquireParseSlot } from '../folders/parseDocs.js';
import { __setPathOptionsForTests } from '../folders/pathSafety.js';
import { clearPreviewCache, previewCacheStats } from '../folders/previewCache.js';
import { allFileRows, getFolder, updateFile } from '../folders/store.js';
import { __setBusyDelaysForTests } from '../folders/summarize.js';
import { FREE, resetPro, setEntitlements } from './helpers/pro.js';
import { installFakeOllama, textReply } from './helpers/fakeOllama.js';
import { COPY, errorBody, makeTmp, neutralPathOptions, rmTree, writeTree } from './helpers/foldersEnv.js';
import { makePdf } from './helpers/synthDocs.js';
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
const preview = (folder, file) => get(previewUrl(folder.id, file.id));

const expectError = (res, code) => {
  expect(res.status, `${code}: ${JSON.stringify(res.body)}`).toBe(COPY[code][0]);
  expect(res.body).toEqual(errorBody(code));
  expect(res.headers['cache-control']).toBe('no-store');
};

async function filesOf(folderId) {
  const res = await get(`/api/folders/${folderId}/files?limit=200`);
  return Object.fromEntries(res.body.data.files.map((f) => [f.path, f]));
}
async function scanned(files) {
  writeTree(dir, files);
  const res = await request(app).post('/api/folders').set('X-Forwarded-For', nextIp()).set(SAME_ORIGIN).send({ path: dir });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const done = await waitForFolderJob(res.body.data.job.id, { timeoutMs: 30000 });
  expect(done.status).toBe('done');
  return { folder: res.body.data.folder, files: await filesOf(res.body.data.folder.id) };
}
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
/** A factory of fake workers that answer only when the test says so. */
function fakeFactory(counter) {
  return () => {
    counter.calls += 1;
    const worker = new EventEmitter();
    worker.terminate = () => Promise.resolve(0);
    // A real worker is ready after the constructor returns; parseDocs waits for that before terminating it.
    queueMicrotask(() => worker.emit('message', { ready: true }));
    counter.workers.push(worker);
    return worker;
  };
}
const answer = (worker, text) => worker.emit('message', { ok: true, text, pages: 1, totalPages: 1, truncated: false, pageLengths: [text.length] });

beforeAll(async () => {
  for (const k of Object.keys(saved)) delete process.env[k];
  db = createTestDb();
  app = (await import('../../server.js')).default;
  root = makeTmp('burrow-folders-preview-fixes-');
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
  __setParserWorkerFactoryForTests(null);
  __setParserTimeoutForTests(null);
  __setParserMemoryGuardForTests(null);
  __resetDataGenerationForTests();
  resetPro();
  vi.restoreAllMocks();
});

describe('the process-wide parse slot', () => {
  it('is first come first served, aborts a waiter and passes on release', async () => {
    const first = tryAcquireParseSlot();
    expect(first).toBeTypeOf('function');
    expect(tryAcquireParseSlot()).toBeNull();
    const order = [];
    const second = acquireParseSlot().then((release) => {
      order.push('second');
      return release;
    });
    const controller = new AbortController();
    const aborted = acquireParseSlot({ signal: controller.signal });
    const third = acquireParseSlot().then((release) => {
      order.push('third');
      return release;
    });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ aborted: true, name: 'AbortError' });
    await expect(acquireParseSlot({ signal: controller.signal })).rejects.toMatchObject({ aborted: true });
    first();
    first();
    const releaseSecond = await second;
    expect(order).toEqual(['second']);
    expect(tryAcquireParseSlot()).toBeNull();
    releaseSecond();
    (await third)();
    expect(order).toEqual(['second', 'third']);
    const free = tryAcquireParseSlot();
    expect(free).toBeTypeOf('function');
    free();
  });

  it('a preview during a running job parse answers 429 and the job document still parses (no false doc_oom)', async () => {
    const { folder, files } = await scanned({ 'changed.pdf': makePdf([['Version one']]), 'other.pdf': makePdf([['Other document']]) });
    expect(files['changed.pdf'].status).toBe('ok');
    expect(files['other.pdf'].status).toBe('ok');
    const counter = { calls: 0, workers: [] };
    __setParserWorkerFactoryForTests(fakeFactory(counter));
    __setParserTimeoutForTests(20_000);
    // A second parse starting meanwhile would raise the probe by 1000 bytes: with the old per-parse watchdog that is a false doc_oom.
    __setParserMemoryGuardForTests({ limitBytes: 500, pollMs: 5, probe: () => 1000 * Math.max(0, counter.calls - 1) });

    const file = path.join(dir, 'changed.pdf');
    fs.writeFileSync(file, makePdf([['Version two is longer than version one']]));
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(file, later, later);
    const scan = await request(app).post(`/api/folders/${folder.id}/scan`).set('X-Forwarded-For', nextIp()).set(SAME_ORIGIN);
    expect(scan.status).toBe(202);
    await waitUntil(() => counter.calls === 1 && activeParserWorkerCount() === 1);

    expectError(await preview(folder, files['other.pdf']), 'folder_preview_busy');
    expect(counter.calls).toBe(1);
    await new Promise((r) => setTimeout(r, 60));

    answer(counter.workers[0], 'Version two text');
    const done = await waitForFolderJob(scan.body.data.job.id, { timeoutMs: 30000 });
    expect(done.status).toBe('done');
    const rows = Object.fromEntries(allFileRows(folder.id).map((r) => [r.rel_path, r]));
    expect(rows['changed.pdf']).toMatchObject({ status: 'ok' });
    expect(rows['changed.pdf'].char_count).toBe('Version two text'.length);
    expect(counter.calls).toBe(1);
    expect(activeParserWorkerCount()).toBe(0);
  });

  it('a cached document is served while another parse holds the slot', async () => {
    const { folder, files } = await scanned({ 'a.pdf': makePdf([['Cached alpha']]), 'b.pdf': makePdf([['Slow bravo']]) });
    const warm = await preview(folder, files['a.pdf']);
    expect(warm.status).toBe(200);
    expect(previewCacheStats().entries).toBe(1);

    const counter = { calls: 0 };
    __setParserWorkerFactoryForTests(hangingFactory(counter));
    __setParserTimeoutForTests(10_000);
    const slow = get(previewUrl(folder.id, files['b.pdf'].id));
    slow.end(() => {});
    await waitUntil(() => counter.calls === 1 && activeParserWorkerCount() === 1);

    const hit = await preview(folder, files['a.pdf']);
    expect(hit.status).toBe(200);
    expect(hit.body).toEqual(warm.body);
    expectError(await preview(folder, files['b.pdf']), 'folder_preview_busy');
    expect(counter.calls).toBe(1);

    slow.abort();
    await waitUntil(() => activeParserWorkerCount() === 0);
  });
});

describe('changed bytes with the same size and mtime', () => {
  it('a document answers 409 with no parse and nothing cached', async () => {
    const pdf = makePdf([['Original page one']]);
    const { folder, files } = await scanned({ 'doc.pdf': pdf });
    const file = path.join(dir, 'doc.pdf');
    const when = fs.statSync(file).mtime;
    const edited = Buffer.from(pdf);
    edited.write('Replaced page one', edited.indexOf('Original page one'), 'latin1');
    fs.writeFileSync(file, edited);
    fs.utimesSync(file, when, when);

    const counter = { calls: 0 };
    __setParserWorkerFactoryForTests(countingFactory(counter));
    const res = await preview(folder, files['doc.pdf']);
    expectError(res, 'folder_file_changed');
    expect(counter.calls).toBe(0);
    expect(previewCacheStats().entries).toBe(0);
    expect(JSON.stringify(res.body)).not.toMatch(/Original|Replaced/);
  });

  it('readTextFile with expectedSha256 answers changed before parsing or caching', async () => {
    const { folder } = await scanned({ 'a.txt': 'alpha\n', 'doc.pdf': makePdf([['Some page']]) });
    const rootKey = getFolder(folder.id).path_key;
    const wrong = '0'.repeat(64);
    const text = await readTextFile(path.join(dir, 'a.txt'), { rootKey, expectedSha256: wrong });
    expect(text.status).toBe('changed');
    expect(text.text).toBeUndefined();
    const plain = await readTextFile(path.join(dir, 'a.txt'), { rootKey });
    expect((await readTextFile(path.join(dir, 'a.txt'), { rootKey, expectedSha256: plain.sha256 })).status).toBe('ok');

    const counter = { calls: 0 };
    __setParserWorkerFactoryForTests(countingFactory(counter));
    const docCache = { get: vi.fn(() => undefined), set: vi.fn() };
    const doc = await readTextFile(path.join(dir, 'doc.pdf'), { rootKey, expectedSha256: wrong, docCache });
    expect(doc.status).toBe('changed');
    expect(counter.calls).toBe(0);
    expect(docCache.get).not.toHaveBeenCalled();
    expect(docCache.set).not.toHaveBeenCalled();
  });
});

describe('a folder that goes stale while a document is parsed', () => {
  const slowPreview = async () => {
    const { folder, files } = await scanned({ 'doc.pdf': makePdf([['Slow page']]) });
    const counter = { calls: 0, workers: [] };
    __setParserWorkerFactoryForTests(fakeFactory(counter));
    __setParserTimeoutForTests(20_000);
    const pending = preview(folder, files['doc.pdf']).then((r) => r);
    await waitUntil(() => counter.calls === 1 && activeParserWorkerCount() === 1);
    return { folder, counter, pending };
  };

  it('a data reset during the parse: no cache write and folder_not_found', async () => {
    const { counter, pending } = await slowPreview();
    bumpDataGeneration();
    answer(counter.workers[0], 'Slow page');
    const res = await pending;
    expectError(res, 'folder_not_found');
    expect(previewCacheStats().entries).toBe(0);
    expect(JSON.stringify(res.body)).not.toContain('Slow page');
  });

  it('the folder removed during the parse: no cache write and folder_not_found', async () => {
    const { folder, counter, pending } = await slowPreview();
    const del = await request(app).delete(`/api/folders/${folder.id}`).set('X-Forwarded-For', nextIp());
    expect(del.status).toBe(200);
    answer(counter.workers[0], 'Slow page');
    expectError(await pending, 'folder_not_found');
    expect(previewCacheStats().entries).toBe(0);
  });
});

describe('ext and path agreement for a document', () => {
  it('a row that claims a plain ext for a document path is refused too (kind comes from the path)', async () => {
    const { folder, files } = await scanned({ 'doc.pdf': makePdf([['Doc page']]) });
    updateFile(files['doc.pdf'].id, { ext: 'txt' });
    const counter = { calls: 0 };
    __setParserWorkerFactoryForTests(countingFactory(counter));
    expectError(await preview(folder, files['doc.pdf']), 'folder_file_changed');
    expect(counter.calls).toBe(0);
  });
});
