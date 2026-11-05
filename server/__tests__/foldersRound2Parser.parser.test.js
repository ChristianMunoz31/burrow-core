// Parser worker tests: they need document parsing on and start real parser workers, so they run only in `npm run test:parser`
// (vitest.parser.config.js, issue #67) and return to the default suite when the parser runs in its own process.
// Security review round 2 for Folders (PR #61), one regression test per finding:
//  M1  a tiny PDF whose content stream inflates to a huge typed array is stopped by the main-thread memory watchdog (doc_oom)
//  L1  only content failures keep a PDF unreadable; transient ones (timeout, oom, crash, unavailable) are retried, at most 3 times
// (L3 and L4 are in foldersRound2Fixes.test.js; L5, the no-replace rename, is covered by the Rust unit tests in src-tauri/src/dialogs.rs.)
// Synthetic fixtures under os.tmpdir() only. The memory test inflates 96 MB in a real worker with a 32 MB watchdog.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));

import fs from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { Worker } from 'node:worker_threads';
import fetch from 'node-fetch';
import { __resetAiForTests } from '../ai/index.js';
import { __resetDataGenerationForTests } from '../dataGeneration.js';
import { __setDialogClockForTests } from '../desktop/dialogBroker.js';
import { LIMITS } from '../folders/constants.js';
import { __resetDocFailureCountersForTests, MAX_TRANSIENT_DOC_FAILURES, enqueueFolderJob, waitForFolderJob } from '../folders/jobs.js';
import { __setParserMemoryGuardForTests, __setParserTimeoutForTests, __setParserWorkerFactoryForTests, activeParserWorkerCount, parseDocument } from '../folders/parseDocs.js';
import { __setPathOptionsForTests } from '../folders/pathSafety.js';
import { allFileRows } from '../folders/store.js';
import { __setBusyDelaysForTests } from '../folders/summarize.js';
import { installFakeOllama, textReply } from './helpers/fakeOllama.js';
import { addFolderRow, makeTmp, rmTree, useNeutralPaths, writeTree } from './helpers/foldersEnv.js';
import { makePdf } from './helpers/synthDocs.js';
import { closeTestDb, createTestDb, resetDb } from './helpers/testDb.js';

const MB = 1024 * 1024;
let db;
let base;

beforeAll(() => {
  db = createTestDb();
  base = makeTmp('burrow-folders-r2-');
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
  __resetAiForTests();
  __resetDataGenerationForTests();
  __resetDocFailureCountersForTests();
  fetch.mockReset();
  installFakeOllama(fetch, { embedModel: true, chat: () => textReply('A short note about the files.') });
});
afterEach(() => {
  __setParserWorkerFactoryForTests(null);
  __setParserTimeoutForTests(null);
  __setParserMemoryGuardForTests(null);
  __setDialogClockForTests(null);
});

// ---------------------------------------------------------------------------------------------
// M1: memory watchdog
// ---------------------------------------------------------------------------------------------

/** A valid one-page PDF whose only content stream is a small FlateDecode stream that inflates to `inflatedBytes` spaces. */
function inflatingPdf(inflatedBytes) {
  const data = deflateSync(Buffer.alloc(inflatedBytes, 0x20), { level: 9 });
  const parts = [];
  const offsets = [];
  let pos = 0;
  const push = (chunk) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'latin1');
    parts.push(buf);
    pos += buf.length;
  };
  push('%PDF-1.4\n');
  const obj = (n, body) => {
    offsets[n] = pos;
    push(`${n} 0 obj\n${body}\nendobj\n`);
  };
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>');
  offsets[4] = pos;
  push(`4 0 obj\n<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`);
  push(data);
  push('\nendstream\nendobj\n');
  const xref = pos;
  push(`xref\n0 5\n0000000000 65535 f \n${[1, 2, 3, 4].map((i) => `${String(offsets[i]).padStart(10, '0')} 00000 n \n`).join('')}`);
  push(`trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

describe('M1: a small PDF that inflates to a huge stream', () => {
  it('the fixture is tiny on disk and inflates 96 MB', () => {
    const pdf = inflatingPdf(96 * MB);
    expect(pdf.length).toBeLessThan(400 * 1024);
  });

  it('repro: the 512 MB heap cap alone does not stop it (typed arrays are outside the heap), so the parse completes', async () => {
    __setParserMemoryGuardForTests({ limitBytes: 64 * 1024 * MB }); // watchdog effectively off
    // A generous timeout so a loaded machine cannot turn the completed parse into doc_timeout; the point is that
    // nothing but the (disabled) watchdog would have stopped it, not how fast it ran.
    __setParserTimeoutForTests(55_000);
    try {
      const out = await parseDocument('pdf', inflatingPdf(96 * MB));
      expect(out).toMatchObject({ pages: 1, totalPages: 1 });
    } finally {
      __setParserTimeoutForTests(null);
    }
    expect(activeParserWorkerCount()).toBe(0);
  }, 60_000);

  it('the watchdog terminates the busy worker as doc_oom, well before the timeout, and leaves no worker behind', async () => {
    __setParserMemoryGuardForTests({ limitBytes: 32 * MB, pollMs: 20 });
    __setParserTimeoutForTests(50_000);
    const started = Date.now();
    await expect(parseDocument('pdf', inflatingPdf(96 * MB))).rejects.toMatchObject({ code: 'doc_oom' });
    // terminate() interrupted the decode loop: far below the 50 s timeout (and below the 20 s production one).
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(activeParserWorkerCount()).toBe(0);
  }, 60_000);

  it('uses the production limits by default: 384 MB above where the parse started, polled every 100 ms', () => {
    expect(LIMITS.docMemoryMb).toBe(384);
    expect(LIMITS.docMemoryPollMs).toBe(100);
    expect(LIMITS.docMemoryMb * MB).toBeLessThan(LIMITS.docHeapMb * MB);
  });

  it('is deterministic with an injected probe: growth past the limit is doc_oom, growth under it is not', async () => {
    const hang = () => () => new Worker("require('node:worker_threads').parentPort.postMessage({ ready: true }); setInterval(() => {}, 1000);", { eval: true });
    __setParserWorkerFactoryForTests(hang());
    let used = 1000 * MB;
    __setParserMemoryGuardForTests({ limitBytes: 100 * MB, pollMs: 5, probe: () => used });
    __setParserTimeoutForTests(400);
    const small = parseDocument('pdf', new Uint8Array([1, 2, 3]));
    used += 99 * MB; // under the limit above the baseline taken at the start
    await expect(small).rejects.toMatchObject({ code: 'doc_timeout' });

    __setParserWorkerFactoryForTests(hang());
    __setParserTimeoutForTests(20_000);
    used = 1000 * MB;
    const big = parseDocument('pdf', new Uint8Array([1, 2, 3]));
    setTimeout(() => {
      used += 101 * MB;
    }, 30);
    await expect(big).rejects.toMatchObject({ code: 'doc_oom' });
    expect(activeParserWorkerCount()).toBe(0);
  }, 30_000);

  it('a probe that throws never fails a parse', async () => {
    __setParserMemoryGuardForTests({
      limitBytes: 1,
      pollMs: 5,
      probe: (() => {
        let calls = 0;
        return () => {
          calls += 1;
          if (calls > 1) throw new Error('probe broke');
          return 0;
        };
      })(),
    });
    const out = await parseDocument('pdf', makePdf([['Plain page text']]));
    expect(out.text).toContain('Plain page text');
  });
});

// ---------------------------------------------------------------------------------------------
// L1: transient parser failures are retried a bounded number of times
// ---------------------------------------------------------------------------------------------

describe('L1: which unreadable documents stay unreadable', () => {
  let dir;
  let folder;
  let calls;
  const rowOf = (rel) => allFileRows(folder.id).find((r) => r.rel_path === rel);
  async function scan() {
    const job = enqueueFolderJob({ folderId: folder.id, kind: 'scan', trigger: 'user' });
    const done = await waitForFolderJob(job.id, { timeoutMs: 60_000 });
    expect(done.status).toBe('done');
  }
  const hangingFactory = () => () => {
    calls += 1;
    return new Worker("require('node:worker_threads').parentPort.postMessage({ ready: true }); setInterval(() => {}, 1000);", { eval: true });
  };
  const unavailableFactory = () => () => {
    calls += 1;
    throw new Error('cannot start');
  };
  const realFactory = () => ({ kind, bytes, limits }) => {
    calls += 1;
    return new Worker(new URL('../folders/parserWorker.js', import.meta.url), { workerData: { kind, bytes, limits }, transferList: [bytes.buffer], env: {} });
  };
  beforeEach(() => {
    calls = 0;
    dir = path.join(base, 'l1');
    rmTree(dir);
  });

  it('a timed-out PDF is tried again on the next scans, 3 attempts in all, then stays unreadable until it changes', async () => {
    writeTree(dir, { 'slow.pdf': makePdf([['A document that never finishes']]) });
    folder = await addFolderRow(dir);
    __setParserWorkerFactoryForTests(hangingFactory());
    __setParserTimeoutForTests(80);
    expect(MAX_TRANSIENT_DOC_FAILURES).toBe(3);
    for (let i = 1; i <= MAX_TRANSIENT_DOC_FAILURES; i += 1) {
      await scan();
      expect(calls).toBe(i);
      expect(rowOf('slow.pdf').status).toBe('unreadable');
    }
    await scan();
    await scan();
    expect(calls).toBe(3); // sticky now
    expect(rowOf('slow.pdf').status).toBe('unreadable');

    // A changed file starts over, and a good parse clears the history.
    fs.writeFileSync(path.join(dir, 'slow.pdf'), makePdf([['Changed, still hanging']]));
    await scan();
    expect(calls).toBe(4);
    __setParserWorkerFactoryForTests(realFactory());
    __setParserTimeoutForTests(null);
    fs.writeFileSync(path.join(dir, 'slow.pdf'), makePdf([['Now it parses fine']]));
    await scan();
    expect(rowOf('slow.pdf').status).toBe('ok');
    expect(activeParserWorkerCount()).toBe(0);
  }, 60_000);

  it('a parser that cannot start (doc_unavailable) is retried the same bounded way', async () => {
    writeTree(dir, { 'a.pdf': makePdf([['Some text here']]) });
    folder = await addFolderRow(dir);
    __setParserWorkerFactoryForTests(unavailableFactory());
    for (let i = 0; i < 5; i += 1) await scan();
    expect(calls).toBe(3);
    expect(rowOf('a.pdf').status).toBe('unreadable');
  }, 60_000);

  it('a retry that succeeds on the next scan reads the document without any change to it', async () => {
    writeTree(dir, { 'ok-later.pdf': makePdf([['Readable once the machine is calmer']]) });
    folder = await addFolderRow(dir);
    __setParserWorkerFactoryForTests(hangingFactory());
    __setParserTimeoutForTests(80);
    await scan();
    expect(rowOf('ok-later.pdf').status).toBe('unreadable');
    __setParserWorkerFactoryForTests(realFactory());
    __setParserTimeoutForTests(null);
    await scan();
    expect(rowOf('ok-later.pdf').status).toBe('ok');
  }, 60_000);

  it('content failures (corrupt, encrypted) are parsed once and stay unreadable', async () => {
    writeTree(dir, {
      'broken.pdf': Buffer.from('%PDF-1.4\nthis is not a pdf at all'),
      'locked.pdf': makePdf([['Secret']], { encrypted: true }),
    });
    folder = await addFolderRow(dir);
    __setParserWorkerFactoryForTests(realFactory());
    await scan();
    expect(calls).toBe(2);
    await scan();
    await scan();
    expect(calls).toBe(2);
    expect(rowOf('broken.pdf').status).toBe('unreadable');
    expect(rowOf('locked.pdf').status).toBe('unreadable');
  }, 60_000);
});
