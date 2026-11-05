// Backups and upload inspections must not freeze the event loop on a large database: the heavy SQLite
// steps (VACUUM INTO, integrity_check, the content fingerprint) run in a worker thread. These tests
// seed about 30k transactions plus 2k journal entries (synthetic) into the per-file temp data dir,
// sample the event loop while an operation runs, and check the worker results equal the main thread's.
// The JSON export ZIP of a backup is built in the worker too, so the loop tests run the full createBackup.
import fs from 'node:fs';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../db/index.js';
import { backupsDir } from '../backup/paths.js';
import { __resetLockForTests } from '../backup/lock.js';
import { createBackup } from '../backup/service.js';
import { __resetUploadsForTests, inspectUpload } from '../backup/restore.js';
import { inspectDbFile, latestSchemaVersion } from '../backup/snapshot.js';
import {
  __setWorkerFactoryForTests,
  __setWorkerTimeoutForTests,
  isWorkerUnavailable,
  runBackupOp,
} from '../backup/worker/client.js';
import { seedDb } from './helpers/testDb.js';
import { backupFile, cleanupBackupEnv, day, names, resetBackupEnv } from './helpers/backupEnv.js';

const TX_COUNT = 40_000;
const JOURNAL_COUNT = 2_000;
// With the worker the probe sees gaps of about 20 ms on a dev machine; forcing the worker off (a
// throwing factory) makes the same operations block the loop for roughly 0.5 to 1 s at this size, so
// these limits are loose enough for a loaded CI runner and still fail clearly without the worker.
const MAX_GAP_MS = 150;
const P99_MS = 100;

// A test seam that keeps the export on the main thread: for the tests that are about the snapshot step.
const emptyZip = async () => ({ zip: new Uint8Array(22), manifest: { complete: true } });

function seed() {
  const cats = ['Groceries', 'Rent', 'Transport', 'Dining', 'Utilities'];
  const transactions = Array.from({ length: TX_COUNT }, (_, i) => ({
    date: `2025-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
    merchant: `Merchant ${i % 500}`,
    amount: ((i * 37) % 50_000) / 100,
    category: cats[i % cats.length],
    type: i % 9 === 0 ? 'income' : 'expense',
    source_file: `synthetic-${i % 20}.csv`,
  }));
  const journal = Array.from({ length: JOURNAL_COUNT }, (_, i) => ({
    title: `Entry ${i}`,
    body: `Synthetic journal body number ${i}. `.repeat(10),
    mood: 'ok',
    tags: ['synthetic'],
  }));
  seedDb(getDb(), { transactions, journal });
  getDb().exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

/** Runs fn while sampling the event loop (10 ms histogram plus a 5 ms max-gap probe). */
async function measureLoop(fn) {
  const hist = monitorEventLoopDelay({ resolution: 10 });
  let last = performance.now();
  let maxGap = 0;
  const probe = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 5);
  await new Promise((r) => setTimeout(r, 40));
  maxGap = 0;
  last = performance.now();
  hist.enable();
  let result;
  try {
    result = await fn();
  } finally {
    // A blocking call ends before the next tick can record it: count the time since the last tick.
    maxGap = Math.max(maxGap, performance.now() - last);
    hist.disable();
    clearInterval(probe);
  }
  return { result, maxGap, p99: hist.percentile(99) / 1e6, max: hist.max / 1e6 };
}

/** A real worker thread running `body` (CommonJS source), as a stand-in for backupWorker.js. */
const fakeWorker = (body) => () => new Worker(body, { eval: true });
const READY = "const { parentPort } = require('node:worker_threads'); parentPort.postMessage({ type: 'ready' });";
const CRASH_AFTER_READY = `${READY} parentPort.on('message', () => process.exit(1));`;
const HANG_AFTER_WRITING_PARTIAL = `${READY}
parentPort.on('message', (m) => {
  const p = m.payload.partialPath;
  if (p) require('node:fs').writeFileSync(p, 'half written');
  setInterval(() => {}, 1000);
});`;

const clearBackups = () => {
  const dir = backupsDir();
  if (!fs.existsSync(dir)) return;
  for (const n of fs.readdirSync(dir)) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
};

function uploadReqFor(file) {
  const req = fs.createReadStream(file);
  req.headers = { 'content-length': String(fs.statSync(file).size) };
  return req;
}

beforeAll(() => {
  resetBackupEnv();
  seed();
}, 120_000);
beforeEach(() => {
  __resetLockForTests();
  __resetUploadsForTests();
  __setWorkerFactoryForTests(null);
  __setWorkerTimeoutForTests(null);
  clearBackups();
});
afterEach(() => {
  vi.restoreAllMocks();
  __setWorkerFactoryForTests(null);
  __setWorkerTimeoutForTests(null);
});
afterAll(() => {
  cleanupBackupEnv();
});

// Timing tests: a real worker must be in use (not a fallen-back main thread) or the numbers mean nothing,
// and a loaded machine can add a stall once, so each gets two retries. The limits stay absolute. They
// cannot run alone in their file (the vitest config has no per-file parallelism switch).
describe('large database, worker on', () => {
  it('createBackup keeps the event loop free and records what a main-thread inspection finds', { retry: 2, timeout: 120_000 }, async () => {
    expect(isWorkerUnavailable()).toBe(false);
    const { result, maxGap, p99 } = await measureLoop(() =>
      createBackup({ kind: 'manual', now: day(1) }),
    );
    expect(result.created).toBe(true);
    expect(result.meta.export).toMatchObject({ status: 'ok', file: `burrow-${result.meta.id}.export.zip` });
    expect(fs.statSync(backupFile(result.meta.id, '.export.zip')).size).toBe(result.meta.export.bytes);
    expect(isWorkerUnavailable()).toBe(false);
    expect(maxGap).toBeLessThan(MAX_GAP_MS);
    expect(p99).toBeLessThan(P99_MS);

    const expected = inspectDbFile(backupFile(result.meta.id, '.db'), { latestVersion: latestSchemaVersion() });
    expect(expected.integrityOk).toBe(true);
    expect(result.meta.status).toBe('verified');
    expect(result.meta.fingerprint).toBe(expected.fingerprint);
    expect(result.meta.rowCounts).toEqual(expected.rowCounts);
    expect(result.meta.totalRows).toBe(expected.totalRows);
    expect(result.meta.rowCounts.transactions).toBe(TX_COUNT);
    expect(result.meta.rowCounts.journal).toBe(JOURNAL_COUNT);
    expect(names().filter((n) => n.endsWith('.partial'))).toEqual([]);
  });

  it('upload inspection keeps the event loop free and reports what a main-thread inspection finds', { retry: 2, timeout: 120_000 }, async () => {
    expect(isWorkerUnavailable()).toBe(false);
    const { result: made } = await measureLoop(() => createBackup({ kind: 'manual', now: day(2) }));
    const file = backupFile(made.meta.id, '.db');
    const expected = inspectDbFile(file, { latestVersion: latestSchemaVersion() });

    const { result, maxGap, p99 } = await measureLoop(() => inspectUpload(uploadReqFor(file)));
    expect(maxGap).toBeLessThan(MAX_GAP_MS);
    expect(p99).toBeLessThan(P99_MS);
    expect(result.schemaVersion).toBe(expected.schemaVersion);
    // The preview leaves the saved-keys table out (always empty in a backup).
    const { app_secrets: secrets, ...shown } = expected.rowCounts;
    expect(secrets).toBe(0);
    expect(result.rowCounts).toEqual(shown);
    expect(result.totalRows).toBe(expected.totalRows);
    expect(result.migrationNeeded).toBe(false);
  });
});

describe('fallbacks', () => {
  it('a factory that throws: the backup is still made on the main thread, and the worker is not tried again', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const factory = vi.fn(() => {
      throw Object.assign(new Error('no threads'), { code: 'ERR_WORKER_INIT_FAILED' });
    });
    __setWorkerFactoryForTests(factory);

    const first = await createBackup({ kind: 'manual', now: day(3), exportFn: emptyZip });
    const second = await createBackup({ kind: 'manual', now: day(4), exportFn: emptyZip });
    for (const r of [first, second]) {
      expect(r.created).toBe(true);
      expect(r.meta.status).toBe('verified');
      expect(r.meta.rowCounts.transactions).toBe(TX_COUNT);
    }
    expect(isWorkerUnavailable()).toBe(true);
    expect(factory).toHaveBeenCalledTimes(1);
    const worker = err.mock.calls.filter((c) => String(c[0]).startsWith('Backup worker unavailable'));
    expect(worker).toHaveLength(1);
    expect(worker[0]).toEqual([expect.any(String), 'ERR_WORKER_INIT_FAILED']);
  }, 120_000);

  it('a worker that dies in the middle of a backup: one retry on the main thread', async () => {
    const factory = vi.fn(fakeWorker(CRASH_AFTER_READY));
    __setWorkerFactoryForTests(factory);
    const { created, meta } = await createBackup({ kind: 'manual', now: day(5), exportFn: emptyZip });
    expect(created).toBe(true);
    expect(meta.status).toBe('verified');
    expect(meta.rowCounts.transactions).toBe(TX_COUNT);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(isWorkerUnavailable()).toBe(false);
    expect(names().filter((n) => n.endsWith('.partial'))).toEqual([]);
  }, 120_000);

  it('a file that kills the worker during upload inspection is backup_invalid, with no retry and no leftovers', async () => {
    const { meta } = await createBackup({ kind: 'manual', now: day(6), exportFn: emptyZip });
    const file = backupFile(meta.id, '.db');
    const factory = vi.fn(fakeWorker(CRASH_AFTER_READY));
    __setWorkerFactoryForTests(factory);
    await expect(inspectUpload(uploadReqFor(file))).rejects.toMatchObject({ code: 'backup_invalid', status: 422 });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(names().filter((n) => n.startsWith('.incoming-'))).toEqual([]);
  }, 120_000);

  it('a worker that never answers: the backup fails with backup_failed and leaves no .partial file', async () => {
    const factory = vi.fn(fakeWorker(HANG_AFTER_WRITING_PARTIAL));
    __setWorkerFactoryForTests(factory);
    __setWorkerTimeoutForTests(300);
    await expect(createBackup({ kind: 'manual', now: day(7), exportFn: emptyZip })).rejects.toMatchObject({
      code: 'backup_failed',
      status: 500,
    });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(names().filter((n) => n.endsWith('.partial') || n.endsWith('.db'))).toEqual([]);
    // The next run works once a real worker is back.
    __setWorkerFactoryForTests(null);
    __setWorkerTimeoutForTests(null);
    const { meta } = await createBackup({ kind: 'manual', now: day(8), exportFn: emptyZip });
    expect(meta.status).toBe('verified');
  }, 120_000);

  it('a worker that never answers during upload inspection: backup_invalid', async () => {
    const { meta } = await createBackup({ kind: 'manual', now: day(9), exportFn: emptyZip });
    const file = backupFile(meta.id, '.db');
    __setWorkerFactoryForTests(fakeWorker(HANG_AFTER_WRITING_PARTIAL));
    __setWorkerTimeoutForTests(300);
    await expect(inspectUpload(uploadReqFor(file))).rejects.toMatchObject({ code: 'backup_invalid' });
    expect(names().filter((n) => n.startsWith('.incoming-'))).toEqual([]);
  }, 120_000);
});

describe('export step in the worker', () => {
  const realWorker = ({ env }) => new Worker(new URL('../backup/worker/backupWorker.js', import.meta.url), { env });
  /** Real worker for the first operation (the snapshot), then `next` for the export. */
  const snapshotThen = (next) => {
    let calls = 0;
    return vi.fn((opts) => {
      calls += 1;
      return calls === 1 ? realWorker(opts) : next(opts);
    });
  };
  const zipNames = () => names().filter((n) => n.endsWith('.export.zip') || n.endsWith('.export.zip.partial'));

  it('no worker at all: the export is built on the main thread and the backup is complete', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    __setWorkerFactoryForTests(() => {
      throw Object.assign(new Error('no threads'), { code: 'ERR_WORKER_INIT_FAILED' });
    });
    const { meta } = await createBackup({ kind: 'manual', now: day(11) });
    expect(meta.status).toBe('verified');
    expect(meta.export.status).toBe('ok');
    expect(names().filter((n) => n.endsWith('.partial'))).toEqual([]);
  }, 120_000);

  it('a worker that dies during the export: one retry on the main thread, export ok', async () => {
    const factory = snapshotThen(fakeWorker(CRASH_AFTER_READY));
    __setWorkerFactoryForTests(factory);
    const { meta } = await createBackup({ kind: 'manual', now: day(12) });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(meta.status).toBe('verified');
    expect(meta.export.status).toBe('ok');
    expect(meta.export.bytes).toBeGreaterThan(22);
    expect(names().filter((n) => n.endsWith('.partial'))).toEqual([]);
  }, 120_000);

  it('a worker that never answers during the export: export status failed, the backup still succeeds, no leftovers', async () => {
    const factory = snapshotThen((opts) => {
      __setWorkerTimeoutForTests(300);
      return fakeWorker(HANG_AFTER_WRITING_PARTIAL)(opts);
    });
    __setWorkerFactoryForTests(factory);
    const { meta } = await createBackup({ kind: 'manual', now: day(13) });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(meta.status).toBe('verified');
    expect(meta.export).toMatchObject({ status: 'failed', file: null });
    expect(zipNames()).toEqual([]);
    expect(names().filter((n) => n.endsWith('.partial'))).toEqual([]);
  }, 120_000);

  it('export_too_large from the worker maps to status too_large, without a retry', async () => {
    const TOO_LARGE = `${READY}
parentPort.on('message', () => parentPort.postMessage({ ok: false, stage: 'export', error: { name: 'Error', code: 'export_too_large' } }));`;
    const factory = snapshotThen(fakeWorker(TOO_LARGE));
    __setWorkerFactoryForTests(factory);
    const { meta } = await createBackup({ kind: 'manual', now: day(14) });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(meta.status).toBe('verified');
    expect(meta.export).toMatchObject({ status: 'too_large', file: null });
    expect(zipNames()).toEqual([]);
  }, 120_000);
});

describe('worker client', () => {
  it('runs one operation at a time, in order', async () => {
    let live = 0;
    let peak = 0;
    const started = [];
    __setWorkerFactoryForTests(() => {
      live += 1;
      peak = Math.max(peak, live);
      started.push(live);
      const w = new Worker(
        `const { parentPort } = require('node:worker_threads');
         parentPort.postMessage({ type: 'ready' });
         parentPort.on('message', () => setTimeout(() => parentPort.postMessage({ ok: true, result: { ok: true } }), 30));`,
        { eval: true },
      );
      w.once('exit', () => {
        live -= 1;
      });
      return w;
    });
    const results = await Promise.all([1, 2, 3].map(() => runBackupOp('integrityCheck', { file: 'x' })));
    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(peak).toBe(1);
    expect(started).toHaveLength(3);
  });

  it('integrityCheck says ok for a good file; a file that is not a database fails with stage inspect', async () => {
    const { meta } = await createBackup({ kind: 'manual', now: day(10), exportFn: emptyZip });
    await expect(runBackupOp('integrityCheck', { file: backupFile(meta.id, '.db') })).resolves.toEqual({ ok: true });
    const junk = path.join(backupsDir(), 'not-a-db.tmp');
    fs.writeFileSync(junk, Buffer.alloc(8192, 7));
    await expect(runBackupOp('integrityCheck', { file: junk })).rejects.toMatchObject({
      workerOpFailed: true,
      stage: 'inspect',
    });
  }, 60_000);

  it('errors from the worker carry a code but no file path', async () => {
    const missing = path.join(backupsDir(), 'nope', 'missing.db');
    const e = await runBackupOp('inspectFile', { file: missing, latestVersion: 1 }).catch((x) => x);
    expect(e.workerOpFailed).toBe(true);
    expect(JSON.stringify([e.message, e.errstr, e.code])).not.toContain('missing.db');
  });
});
