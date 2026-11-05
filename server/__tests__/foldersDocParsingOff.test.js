// Document parsing is OFF by default (server/folders/docGate.js, issue #67): across a real folder scan (inventory, summaries;
// the index is Pro, see foldersDocParsingOff.pro.test.js) and the preview route, no parser Worker is ever created, a PDF or DOCX is listed as `unsupported` ("Not supported
// yet", the first Folders round's behaviour) and its preview is kind `none`. Synthetic temp folders, fake Ollama.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const workerCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal();
  // Counts and throws (no super()): an unexpected construction never starts a real worker.
  class CountingWorker extends actual.Worker {
    constructor() {
      workerCalls.count += 1;
      throw new Error('a parser Worker must not be constructed in this test');
    }
  }
  return { ...actual, Worker: CountingWorker };
});
vi.mock('../license/index.js', async (importOriginal) => (await import('./helpers/pro.js')).mockLicenseModule(importOriginal));
vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));

import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import fetch from 'node-fetch';
import request from 'supertest';
import { __resetAiForTests } from '../ai/index.js';
import { DOC_PARSING_ENV } from '../folders/docGate.js';
import { readTextFile } from '../folders/extract.js';
import { cancelAllFolderJobs, drainFolderJobs, waitForFolderJob } from '../folders/jobs.js';
import { DocWorkerError, __setParserWorkerFactoryForTests, activeParserWorkerCount, parseDocument, tryAcquireParseSlot } from '../folders/parseDocs.js';
import { __setPathOptionsForTests } from '../folders/pathSafety.js';
import { previewFile } from '../folders/preview.js';
import { allFileRows, getFolder, updateFile } from '../folders/store.js';
import { __setBusyDelaysForTests } from '../folders/summarize.js';
import { installFakeOllama, textReply } from './helpers/fakeOllama.js';
import { FREE, PRO, resetPro, setEntitlements } from './helpers/pro.js';
import { makeTmp, neutralPathOptions, rmTree, writeTree } from './helpers/foldersEnv.js';
import { makeDocx, makePdf } from './helpers/synthDocs.js';
import { closeTestDb, createTestDb, resetDb } from './helpers/testDb.js';

const SAME_ORIGIN = Object.freeze({ Host: '127.0.0.1:4321', Origin: 'http://127.0.0.1:4321' });
const DOCS = ['report.pdf', 'letter.docx', 'broken.pdf'];
const saved = Object.fromEntries(['APP_PASSWORD', 'AUTH_SECRET', 'SECRETS_ENCRYPTION_KEY', 'BURROW_AI', DOC_PARSING_ENV].map((k) => [k, process.env[k]]));

let app;
let db;
let root;
let dir;
let ip = 0;
let factoryCalls = 0;
const nextIp = () => `203.0.113.${(ip += 1) % 250}`;
const get = (url) => request(app).get(url).set('X-Forwarded-For', nextIp());

async function filesOf(folderId) {
  const res = await get(`/api/folders/${folderId}/files?limit=200`);
  return Object.fromEntries(res.body.data.files.map((f) => [f.path, f]));
}
async function waitJob(id) {
  const done = await waitForFolderJob(id, { timeoutMs: 30000 });
  expect(done.status).toBe('done');
  return done;
}
async function addFolder() {
  const added = await request(app).post('/api/folders').set('X-Forwarded-For', nextIp()).set(SAME_ORIGIN).send({ path: dir });
  expect(added.status, JSON.stringify(added.body)).toBe(201);
  return added.body.data;
}

beforeAll(async () => {
  for (const k of Object.keys(saved)) delete process.env[k];
  db = createTestDb();
  app = (await import('../../server.js')).default;
  root = makeTmp('burrow-folders-docsoff-');
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
  setEntitlements(FREE);
  __setPathOptionsForTests(neutralPathOptions(root));
  __resetAiForTests();
  fetch.mockReset();
  installFakeOllama(fetch, { embedModel: true, chat: () => textReply('A short note about the files.') });
  dir = path.join(root, 'docs');
  rmTree(dir);
  workerCalls.count = 0;
  factoryCalls = 0;
  __setParserWorkerFactoryForTests(() => {
    factoryCalls += 1;
    throw new Error('the parser factory must not be called while document parsing is off');
  });
});
afterEach(async () => {
  cancelAllFolderJobs('shutdown');
  await drainFolderJobs({ timeoutMs: 2000 });
  __setParserWorkerFactoryForTests(null);
  resetPro();
  vi.restoreAllMocks();
});

describe('document parsing off (the default)', () => {
  it('scans and summarizes a folder, lists PDF and DOCX as unsupported and creates no Worker', async () => {
    setEntitlements(PRO);
    writeTree(dir, {
      'note.txt': 'A plain note about the migration plan.\n',
      'report.pdf': makePdf([['Report page one'], ['Report page two']]),
      'letter.docx': makeDocx(['First paragraph', 'Second paragraph']),
      'broken.pdf': Buffer.from('%PDF-1.4\nthis is not a pdf at all'),
    });
    const { folder, job } = await addFolder();
    const done = await waitJob(job.id);
    expect(done.phase).toBe('done');

    const files = await filesOf(folder.id);
    for (const name of DOCS) {
      expect(files[name], name).toMatchObject({ status: 'unsupported', kind: 'other', lines: null, words: null, chars: null });
    }
    // The rest of the folder is unaffected: the text file was read and summarized.
    expect(files['note.txt']).toMatchObject({ status: 'ok', kind: 'text' });
    const rows = Object.fromEntries(allFileRows(folder.id).map((r) => [r.rel_path, r]));
    for (const name of DOCS) expect(rows[name]).toMatchObject({ status: 'unsupported', chunk_count: 0, summary: null });

    // A second (incremental) scan takes the same path.
    const again = await request(app).post(`/api/folders/${folder.id}/scan`).set('X-Forwarded-For', nextIp()).set(SAME_ORIGIN);
    expect(again.status).toBe(202);
    await waitJob(again.body.data.job.id);
    expect((await filesOf(folder.id))['report.pdf'].status).toBe('unsupported');

    expect(workerCalls.count).toBe(0);
    expect(factoryCalls).toBe(0);
    expect(activeParserWorkerCount()).toBe(0);
  });

  it('answers a preview of a PDF and a DOCX with kind none and "unsupported", and no Worker', async () => {
    writeTree(dir, { 'report.pdf': makePdf([['Report page']]), 'letter.docx': makeDocx(['A paragraph']) });
    const { folder, job } = await addFolder();
    await waitJob(job.id);
    const files = await filesOf(folder.id);
    for (const name of ['report.pdf', 'letter.docx']) {
      const res = await get(`/api/folders/${folder.id}/files/${files[name].id}/preview`);
      expect(res.status, name).toBe(200);
      expect(res.body.data.preview).toMatchObject({ kind: 'none', reason: 'unsupported', text: null, totalChars: null });
    }
    expect(workerCalls.count).toBe(0);
    expect(factoryCalls).toBe(0);
    // No parse slot was used.
    const slot = tryAcquireParseSlot();
    expect(slot).toBeTypeOf('function');
    slot();
  });

  it('refuses a stale inventory row that still says ok for a document, with no read and no Worker', async () => {
    writeTree(dir, { 'report.pdf': makePdf([['Report page']]) });
    const { folder, job } = await addFolder();
    await waitJob(job.id);
    const row = allFileRows(folder.id).find((r) => r.rel_path === 'report.pdf');
    // A row written by an older build or a developer run with parsing on.
    updateFile(row.id, { status: 'ok', kind: 'document', sha256: 'a'.repeat(64) });
    const res = await get(`/api/folders/${folder.id}/files/${row.id}/preview`);
    expect(res.status).toBe(200);
    expect(res.body.data.preview).toMatchObject({ kind: 'none', reason: 'unsupported', text: null });
    const direct = await previewFile(getFolder(folder.id), allFileRows(folder.id).find((r) => r.id === row.id));
    expect(direct.preview).toMatchObject({ kind: 'none', reason: 'unsupported' });
    expect(workerCalls.count).toBe(0);
    expect(factoryCalls).toBe(0);
  });

  it('readTextFile and parseDocument refuse a document before any worker, slot or file open', async () => {
    writeTree(dir, { 'report.pdf': makePdf([['Report page']]), 'letter.docx': makeDocx(['A paragraph']) });
    const open = vi.spyOn(fs.promises, 'open');
    for (const name of ['report.pdf', 'letter.docx']) {
      const res = await readTextFile(path.join(dir, name), { rootKey: dir });
      expect(res).toMatchObject({ status: 'unreadable', docFailure: 'doc_parsing_off' });
      expect(res).not.toHaveProperty('text');
    }
    expect(open).not.toHaveBeenCalled();
    await expect(parseDocument('pdf', new Uint8Array([1, 2, 3]))).rejects.toMatchObject({ name: 'DocWorkerError', code: 'doc_parsing_off' });
    await expect(parseDocument('docx', new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(DocWorkerError);
    expect(workerCalls.count).toBe(0);
    expect(factoryCalls).toBe(0);
    const slot = tryAcquireParseSlot();
    expect(slot).toBeTypeOf('function');
    slot();
  });

  it('control: with the gate allowed, parseDocument reaches the mocked Worker constructor', async () => {
    // Source checkout, not a release build, compiled in (all true when unbundled): only the developer variable is missing.
    process.env[DOC_PARSING_ENV] = '1';
    __setParserWorkerFactoryForTests(null);
    try {
      expect(Worker.name).toBe('CountingWorker');
      await expect(parseDocument('pdf', new Uint8Array([1, 2, 3]))).rejects.toMatchObject({ name: 'DocWorkerError', code: 'doc_unavailable' });
      expect(workerCalls.count).toBe(1);
    } finally {
      delete process.env[DOC_PARSING_ENV];
    }
  });
});
