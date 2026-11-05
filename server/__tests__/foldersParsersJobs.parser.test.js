// Parser worker tests: they need document parsing on and start real parser workers, so they run only in `npm run test:parser`
// (vitest.parser.config.js, issue #67) and return to the default suite when the parser runs in its own process.
// PDF and DOCX inside a folder scan: they are listed as the `document` kind and read through the parser worker, a bad
// file never fails the scan, an unreadable document is not parsed again until it changes, and cancelling a scan
// terminates an in-flight worker.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));
vi.mock('../folders/extract.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, readTextFile: vi.fn(actual.readTextFile) };
});

import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import fetch from 'node-fetch';
import { __resetAiForTests } from '../ai/index.js';
import { readTextFile } from '../folders/extract.js';
import { cancelFolderJob, enqueueFolderJob, waitForFolderJob } from '../folders/jobs.js';
import { __setParserTimeoutForTests, __setParserWorkerFactoryForTests, activeParserWorkerCount } from '../folders/parseDocs.js';
import { __setPathOptionsForTests } from '../folders/pathSafety.js';
import { allFileRows, getFolder } from '../folders/store.js';
import { __setBusyDelaysForTests } from '../folders/summarize.js';
import { installFakeOllama, textReply } from './helpers/fakeOllama.js';
import { addFolderRow, fingerprint, makeTmp, rmTree, useNeutralPaths, writeTree } from './helpers/foldersEnv.js';
import { makeDocx, makePdf } from './helpers/synthDocs.js';
import { closeTestDb, createTestDb, resetDb } from './helpers/testDb.js';

let db;
let base;
let dir;
let folder;

const rowOf = (rel) => allFileRows(folder.id).find((r) => r.rel_path === rel);
async function scan() {
  const job = enqueueFolderJob({ folderId: folder.id, kind: 'scan', trigger: 'user' });
  const done = await waitForFolderJob(job.id, { timeoutMs: 60000 });
  expect(done.status).toBe('done');
  return done;
}

beforeAll(() => {
  db = createTestDb();
  base = makeTmp('burrow-folders-docjobs-');
  useNeutralPaths(base);
  __setBusyDelaysForTests([1, 1, 1]);
});
afterAll(() => {
  __setPathOptionsForTests(null);
  __setBusyDelaysForTests(null);
  closeTestDb(db);
  rmTree(base);
});
beforeEach(async () => {
  resetDb(db);
  __resetAiForTests();
  fetch.mockReset();
  readTextFile.mockClear();
  installFakeOllama(fetch, { embedModel: true, chat: () => textReply('A short note about the files.') });
  dir = path.join(base, 'docs');
  rmTree(dir);
  writeTree(dir, {
    'notes.txt': 'Plain notes about the garden.\n',
    'plan.pdf': makePdf([['Garden plan with tomatoes'], ['Page two has peppers']]),
    'minutes.docx': makeDocx(['Minutes of the club meeting'], { header: 'Club header' }),
    'locked.pdf': makePdf([['secret']], { encrypted: true }),
    'broken.pdf': 'this is not a pdf',
    'broken.docx': 'this is not a zip',
    'blank.pdf': makePdf([[]]),
  });
  folder = await addFolderRow(dir);
});
afterEach(() => {
  __setParserWorkerFactoryForTests(null);
  __setParserTimeoutForTests(null);
});

describe('documents in a scan', () => {
  it('reads PDFs and DOCX as the document kind and keeps going past bad files', async () => {
    await scan();
    expect(rowOf('plan.pdf')).toMatchObject({ kind: 'document', status: 'ok', ext: 'pdf', summary_status: 'ok' });
    expect(rowOf('plan.pdf').word_count).toBeGreaterThan(5);
    expect(rowOf('minutes.docx')).toMatchObject({ kind: 'document', status: 'ok', summary_status: 'ok' });
    expect(rowOf('notes.txt')).toMatchObject({ kind: 'text', status: 'ok' });
    for (const bad of ['locked.pdf', 'broken.pdf', 'broken.docx']) expect(rowOf(bad)).toMatchObject({ kind: 'document', status: 'unreadable' });
    expect(rowOf('blank.pdf')).toMatchObject({ status: 'empty' });
    const { stats } = getFolder(folder.id);
    expect(stats.byKind.document.files).toBe(6);
    expect(stats.byStatus.unreadable).toBe(3);
    expect(stats.filesRead).toBe(3); // notes.txt, plan.pdf, minutes.docx
    expect(activeParserWorkerCount()).toBe(0);
  }, 60_000);

  it('a document that hits the timeout is unreadable and the scan still finishes', async () => {
    __setParserWorkerFactoryForTests(() => new Worker("require('node:worker_threads').parentPort.postMessage({ ready: true }); setInterval(() => {}, 1000);", { eval: true }));
    __setParserTimeoutForTests(100);
    await scan();
    expect(rowOf('plan.pdf').status).toBe('unreadable');
    expect(rowOf('notes.txt').status).toBe('ok');
    expect(activeParserWorkerCount()).toBe(0);
  }, 60_000);

  it('does not parse an unchanged document again, readable or not', async () => {
    await scan();
    readTextFile.mockClear();
    await scan();
    expect(readTextFile).not.toHaveBeenCalled();
    expect(rowOf('broken.pdf').status).toBe('unreadable');
  }, 60_000);

  it('parses an unreadable document again once it changes', async () => {
    await scan();
    fs.writeFileSync(path.join(dir, 'broken.pdf'), makePdf([['Fixed now and readable']]));
    await scan();
    expect(rowOf('broken.pdf')).toMatchObject({ status: 'ok' });
  }, 60_000);

  it('never changes the folder', async () => {
    const before = fingerprint(dir);
    await scan();
    expect(fingerprint(dir)).toEqual(before);
  }, 60_000);

  it('cancelling a scan terminates the worker that is parsing', async () => {
    const made = [];
    const ready = [];
    __setParserWorkerFactoryForTests(() => {
      const w = new Worker("require('node:worker_threads').parentPort.postMessage({ ready: true }); setInterval(() => {}, 1000);", { eval: true });
      made.push(w);
      ready.push(
        Promise.race([
          new Promise((resolve) => {
            const onMessage = (msg) => {
              if (msg?.ready !== true) return;
              w.removeListener('message', onMessage);
              resolve();
            };
            w.on('message', onMessage);
          }),
          once(w, 'exit').then(([code]) => {
            throw new Error(`parser test worker exited (${code}) before it was ready`);
          }),
        ]),
      );
      return w;
    });
    __setParserTimeoutForTests(60_000);
    const job = enqueueFolderJob({ folderId: folder.id, kind: 'scan', trigger: 'user' });
    for (let i = 0; i < 200 && activeParserWorkerCount() === 0; i += 1) await new Promise((r) => setTimeout(r, 25));
    expect(activeParserWorkerCount()).toBe(1);
    await ready[0]; // cancel a worker that is running, not one that is still starting
    cancelFolderJob(folder.id);
    const done = await waitForFolderJob(job.id, { timeoutMs: 30000 });
    expect(done.status).toBe('cancelled');
    expect(activeParserWorkerCount()).toBe(0);
    expect(made[0].threadId).toBe(-1);
  }, 60_000);
});
