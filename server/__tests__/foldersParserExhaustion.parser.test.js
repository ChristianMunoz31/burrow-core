// Parser worker tests: they need document parsing on and start real parser workers, so they run only in `npm run test:parser`
// (vitest.parser.config.js, issue #67) and return to the default suite when the parser runs in its own process.
// Parser exhaustion: several documents that hang must not stall a scan (each costs one bounded timeout, once), and a
// changed document is parsed a known, small number of times per scan (the inventory, the summary and the index each
// re-read the file). The counts are measured through the worker factory seam with the real parser worker.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));

import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import fetch from 'node-fetch';
import { __resetAiForTests } from '../ai/index.js';
import { createDocTextCache, readTextFile } from '../folders/extract.js';
import { MAX_TRANSIENT_DOC_FAILURES, __resetDocFailureCountersForTests, enqueueFolderJob, waitForFolderJob } from '../folders/jobs.js';
import { __setParserTimeoutForTests, __setParserWorkerFactoryForTests, activeParserWorkerCount } from '../folders/parseDocs.js';
import { __setPathOptionsForTests } from '../folders/pathSafety.js';
import { allFileRows } from '../folders/store.js';
import { __setBusyDelaysForTests } from '../folders/summarize.js';
import { installFakeOllama, textReply } from './helpers/fakeOllama.js';
import { addFolderRow, makeTmp, rmTree, useNeutralPaths, writeTree } from './helpers/foldersEnv.js';
import { makeDocx, makePdf } from './helpers/synthDocs.js';
import { closeTestDb, createTestDb, resetDb } from './helpers/testDb.js';

let db;
let base;
let dir;
let folder;
let calls;

const rowOf = (rel) => allFileRows(folder.id).find((r) => r.rel_path === rel);
async function scan() {
  const job = enqueueFolderJob({ folderId: folder.id, kind: 'scan', trigger: 'user' });
  const done = await waitForFolderJob(job.id, { timeoutMs: 60000 });
  expect(done.status).toBe('done');
  return done;
}
const hangingFactory = () => ({ bytes }) => {
  calls.push(bytes.length);
  return new Worker("require('node:worker_threads').parentPort.postMessage({ ready: true }); setInterval(() => {}, 1000);", { eval: true });
};
// The real parser worker, with a counter in front of it.
const countingFactory = () => ({ kind, bytes, limits }) => {
  calls.push(bytes.length);
  return new Worker(new URL('../folders/parserWorker.js', import.meta.url), {
    workerData: { kind, bytes, limits },
    transferList: [bytes.buffer],
    env: {},
  });
};

beforeAll(() => {
  db = createTestDb();
  base = makeTmp('burrow-folders-exhaust-');
  useNeutralPaths(base);
  __setBusyDelaysForTests([1, 1, 1]);
});
afterAll(() => {
  __setPathOptionsForTests(null);
  __setBusyDelaysForTests(null);
  closeTestDb(db);
  rmTree(base);
});
beforeEach(() => {
  resetDb(db);
  __resetDocFailureCountersForTests();
  __resetAiForTests();
  fetch.mockReset();
  installFakeOllama(fetch, { embedModel: true, chat: () => textReply('A short note about the files.') });
  calls = [];
  dir = path.join(base, 'docs');
  rmTree(dir);
});
afterEach(() => {
  __setParserWorkerFactoryForTests(null);
  __setParserTimeoutForTests(null);
});

describe('documents that never finish parsing', () => {
  it('six hanging PDFs cost one short timeout each, once, and the scan still finishes with the rest read', async () => {
    const files = { 'notes.txt': 'Plain notes about the garden.\n' };
    for (let i = 0; i < 6; i += 1) files[`hang${i}.pdf`] = makePdf([[`Hanging document number ${i} ${'x'.repeat(i * 7)}`]]);
    writeTree(dir, files);
    folder = await addFolderRow(dir);
    __setParserWorkerFactoryForTests(hangingFactory());
    __setParserTimeoutForTests(150);
    const started = Date.now();
    await scan();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(15_000);
    expect(calls).toHaveLength(6); // one parse per document for the whole scan, not one per phase
    for (let i = 0; i < 6; i += 1) expect(rowOf(`hang${i}.pdf`).status).toBe('unreadable');
    expect(rowOf('notes.txt').status).toBe('ok');
    expect(activeParserWorkerCount()).toBe(0);
  }, 60_000);

  it('retries a timed-out document on later scans a bounded number of times, then waits until it changes', async () => {
    const files = {};
    for (let i = 0; i < 3; i += 1) files[`hang${i}.pdf`] = makePdf([[`Hanging ${i} ${'y'.repeat(i * 5)}`]]);
    writeTree(dir, files);
    folder = await addFolderRow(dir);
    __setParserWorkerFactoryForTests(hangingFactory());
    __setParserTimeoutForTests(100);
    // A timeout is transient: each unchanged document is tried once per scan until it failed MAX_TRANSIENT_DOC_FAILURES times.
    for (let n = 1; n <= MAX_TRANSIENT_DOC_FAILURES; n += 1) {
      await scan();
      expect(calls).toHaveLength(3 * n);
    }
    const capped = 3 * MAX_TRANSIENT_DOC_FAILURES;
    await scan();
    expect(calls).toHaveLength(capped);
    fs.writeFileSync(path.join(dir, 'hang1.pdf'), makePdf([['Changed and still hanging']]));
    await scan();
    expect(calls).toHaveLength(capped + 1);
    expect(activeParserWorkerCount()).toBe(0);
  }, 60_000);

  it('hanging documents do not delay a cancel beyond one worker teardown', async () => {
    const files = {};
    for (let i = 0; i < 4; i += 1) files[`hang${i}.pdf`] = makePdf([[`Hanging ${i} ${'z'.repeat(i * 3)}`]]);
    writeTree(dir, files);
    folder = await addFolderRow(dir);
    __setParserWorkerFactoryForTests(hangingFactory());
    __setParserTimeoutForTests(60_000);
    const { cancelFolderJob } = await import('../folders/jobs.js');
    const job = enqueueFolderJob({ folderId: folder.id, kind: 'scan', trigger: 'user' });
    for (let i = 0; i < 200 && activeParserWorkerCount() === 0; i += 1) await new Promise((r) => setTimeout(r, 25));
    const started = Date.now();
    cancelFolderJob(folder.id);
    const done = await waitForFolderJob(job.id, { timeoutMs: 30000 });
    expect(done.status).toBe('cancelled');
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(calls).toHaveLength(1); // the later documents were never started
    expect(activeParserWorkerCount()).toBe(0);
  }, 60_000);
});

describe('how many times a document is parsed', () => {
  it('a new document is parsed once per scan, an unchanged one never, a changed one the same as a new one', async () => {
    writeTree(dir, {
      'plan.pdf': makePdf([['Garden plan with tomatoes'], ['Page two has peppers']]),
      'minutes.docx': makeDocx(['Minutes of the club meeting'], { header: 'Club header' }),
    });
    folder = await addFolderRow(dir);
    __setParserWorkerFactoryForTests(countingFactory());
    __setParserTimeoutForTests(20_000);

    await scan();
    const firstScan = calls.length;
    expect(rowOf('plan.pdf')).toMatchObject({ status: 'ok', summary_status: 'ok' });
    // Two documents: inventory and summary each read the file, but only the first read parses it (the index phase is Pro).
    expect(firstScan).toBe(2);

    calls.length = 0;
    await scan();
    expect(calls).toHaveLength(0);

    fs.writeFileSync(path.join(dir, 'plan.pdf'), makePdf([['Garden plan with tomatoes and beans'], ['Page two has peppers and kale']]));
    calls.length = 0;
    await scan();
    expect(calls).toHaveLength(1);
    expect(activeParserWorkerCount()).toBe(0);
  }, 90_000);

  it('a document changed between phases of one job is never served from the cache', async () => {
    writeTree(dir, { 'plan.pdf': makePdf([['Original garden plan with tomatoes']]) });
    const file = path.join(fs.realpathSync.native(dir), 'plan.pdf');
    const key = process.platform === 'win32' ? path.dirname(file).toLowerCase() : path.dirname(file);
    __setParserWorkerFactoryForTests(countingFactory());
    __setParserTimeoutForTests(20_000);
    const docCache = createDocTextCache();
    const first = await readTextFile(file, { rootKey: key, docCache });
    const again = await readTextFile(file, { rootKey: key, docCache });
    expect(first.status).toBe('ok');
    expect(again.text).toBe(first.text);
    expect(calls).toHaveLength(1); // identical bytes: the second read reuses the parse
    fs.writeFileSync(file, makePdf([['Replaced plan about peppers and kale']]));
    const changed = await readTextFile(file, { rootKey: key, docCache });
    expect(changed.status).toBe('ok');
    expect(changed.sha256).not.toBe(first.sha256);
    expect(changed.text).toContain('peppers');
    expect(changed.text).not.toContain('tomatoes');
    expect(calls).toHaveLength(2); // changed bytes: parsed again
  }, 60_000);

  it('stops caching once the byte budget is used', () => {
    const cache = createDocTextCache(100);
    cache.set('a', { text: 'x'.repeat(40) });
    cache.set('b', { text: 'y'.repeat(40) });
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('b')).toBeUndefined();
    cache.clear();
    expect(cache.get('a')).toBeUndefined();
  });
});
