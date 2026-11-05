// The backup worker client: drain at shutdown, abort signals, start-failure counting, the worker's
// environment, heap limit handling and the fixes that depend on them in the service and the restore.
// Fake workers are real worker threads running small CommonJS bodies (same approach as backupEventLoop).
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, insert } from '../db/index.js';
import { MIGRATIONS_DIR } from '../db/migrate.js';
import { backupsDir } from '../backup/paths.js';
import { cleanupOrphans, createBackup, ORPHAN_MIN_AGE_MS } from '../backup/service.js';
import { hasPendingUpload, inspectUpload, restoreBackup, validateCandidate } from '../backup/restore.js';
import { inspectDbFile, latestSchemaVersion, normalizeSnapshot } from '../backup/snapshot.js';
import {
  __setWorkerFactoryForTests,
  __setWorkerTimeoutForTests,
  drainBackupWorker,
  isWorkerUnavailable,
  resumeBackupWorker,
  runBackupOp,
  START_FAILURE_LIMIT,
} from '../backup/worker/client.js';
import {
  backupFile,
  cleanupBackupEnv,
  dataDir,
  day,
  fakeUploadReq,
  names,
  noSleep,
  resetBackupEnv,
} from './helpers/backupEnv.js';

// Passes through to the real function; one test makes it throw a full-disk error on the main thread.
vi.mock('../backup/snapshot.js', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, normalizeSnapshot: vi.fn(real.normalizeSnapshot) };
});

const READY = "const { parentPort } = require('node:worker_threads'); parentPort.postMessage({ type: 'ready' });";
const OK = `${READY} parentPort.on('message', () => parentPort.postMessage({ ok: true, result: { ok: true } }));`;
const SLOW_OK = `${READY} parentPort.on('message', () => setTimeout(() => parentPort.postMessage({ ok: true, result: { ok: true } }), 150));`;
const HANG = `${READY} parentPort.on('message', () => { setInterval(() => {}, 1000); });`;
const CRASH_AFTER_READY = `${READY} parentPort.on('message', () => process.exit(1));`;
const EXIT_BEFORE_READY = 'process.exit(1);';
const OOM = `${READY} parentPort.on('message', () => { const keep = []; for (;;) keep.push(new Array(100000).fill(Math.random())); });`;
const SQLITE_FULL = `${READY} parentPort.on('message', () => parentPort.postMessage({ ok: false, stage: 'inspect', error: { name: 'Error', code: 'SQLITE_FULL', errcode: 13, errstr: 'database or disk is full' } }));`;
const SQLITE_CORRUPT = SQLITE_FULL.replace('SQLITE_FULL', 'SQLITE_CORRUPT')
  .replace('errcode: 13', 'errcode: 11')
  .replace('database or disk is full', 'database disk image is malformed');

/** A factory over fake worker bodies (the last one repeats) that counts workers created and still alive. */
function tracked(...bodies) {
  const state = { created: 0, live: 0 };
  const factory = vi.fn(({ env }) => {
    const body = bodies[Math.min(state.created, bodies.length - 1)];
    state.created += 1;
    state.live += 1;
    const w = new Worker(body, { eval: true, env, resourceLimits: { maxOldGenerationSizeMb: 24 } });
    w.once('exit', () => {
      state.live -= 1;
    });
    return w;
  });
  return { factory, state };
}

const realWorker = ({ env }) => new Worker(new URL('../backup/worker/backupWorker.js', import.meta.url), { env });
const emptyZip = async () => ({ zip: new Uint8Array(22), manifest: { complete: true } });
const reason = (p) => p.then(() => null, (e) => e);

beforeEach(() => {
  resetBackupEnv();
  insert('notes', { body: 'synthetic note one' });
  insert('notes', { body: 'synthetic note two' });
  __setWorkerFactoryForTests(null);
  __setWorkerTimeoutForTests(null);
});
afterEach(() => {
  vi.restoreAllMocks();
  __setWorkerFactoryForTests(null);
  __setWorkerTimeoutForTests(null);
});
afterAll(() => {
  cleanupBackupEnv();
});

describe('drainBackupWorker', () => {
  it('with nothing running it resolves at once, then refuses new operations until resumed', async () => {
    const { factory, state } = tracked(OK);
    __setWorkerFactoryForTests(factory);
    await expect(drainBackupWorker({ timeoutMs: 1000 })).resolves.toEqual({ terminated: false, dropped: 0 });
    await expect(runBackupOp('integrityCheck', { file: 'x' })).rejects.toMatchObject({ code: 'worker_cancelled' });
    expect(state.created).toBe(0);
    resumeBackupWorker();
    await expect(runBackupOp('integrityCheck', { file: 'x' })).resolves.toEqual({ ok: true });
  });

  it('waits for a running operation that ends inside the bound, and leaves no worker', async () => {
    const { factory, state } = tracked(SLOW_OK);
    __setWorkerFactoryForTests(factory);
    const running = runBackupOp('integrityCheck', { file: 'x' });
    await expect(drainBackupWorker({ timeoutMs: 5000 })).resolves.toEqual({ terminated: false, dropped: 0 });
    await expect(running).resolves.toEqual({ ok: true });
    await vi.waitFor(() => expect(state.live).toBe(0));
  });

  it('after the bound it drops the queued jobs (worker_cancelled), terminates the running worker and awaits it', async () => {
    const { factory, state } = tracked(HANG);
    __setWorkerFactoryForTests(factory);
    const first = reason(runBackupOp('integrityCheck', { file: 'a' }));
    const second = reason(runBackupOp('integrityCheck', { file: 'b' }));
    const result = await drainBackupWorker({ timeoutMs: 200 });
    expect(result).toEqual({ terminated: true, dropped: 1 });
    expect(await first).toMatchObject({ code: 'worker_cancelled' });
    expect(await second).toMatchObject({ code: 'worker_cancelled' });
    expect(state.created).toBe(1);
    await vi.waitFor(() => expect(state.live).toBe(0));
  });
});

describe('abort signal', () => {
  it('an already aborted signal never starts a worker', async () => {
    const { factory } = tracked(OK);
    __setWorkerFactoryForTests(factory);
    const ac = new AbortController();
    ac.abort();
    await expect(runBackupOp('integrityCheck', { file: 'x' }, { signal: ac.signal })).rejects.toMatchObject({
      code: 'worker_cancelled',
    });
    expect(factory).not.toHaveBeenCalled();
  });

  it('a queued job is dropped without starting a worker; a running one is terminated and the queue moves on', async () => {
    const { factory, state } = tracked(HANG, OK);
    __setWorkerFactoryForTests(factory);
    const runningAc = new AbortController();
    const queuedAc = new AbortController();
    const running = reason(runBackupOp('integrityCheck', { file: 'a' }, { signal: runningAc.signal }));
    const queued = reason(runBackupOp('integrityCheck', { file: 'b' }, { signal: queuedAc.signal }));
    const next = runBackupOp('integrityCheck', { file: 'c' });

    queuedAc.abort();
    expect(await queued).toMatchObject({ code: 'worker_cancelled' });
    expect(state.created).toBe(1);

    runningAc.abort();
    expect(await running).toMatchObject({ code: 'worker_cancelled' });
    // The next job runs on a fresh (answering) worker.
    await expect(next).resolves.toEqual({ ok: true });
    expect(state.created).toBe(2);
    await vi.waitFor(() => expect(state.live).toBe(0));
  });
});

describe('start failures', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('a worker that exits before it is ready is retried on the main thread, and only the third in a row is permanent', async () => {
    const { factory } = tracked(EXIT_BEFORE_READY);
    __setWorkerFactoryForTests(factory);
    for (let i = 1; i < START_FAILURE_LIMIT; i += 1) {
      await expect(runBackupOp('integrityCheck', { file: 'x' })).rejects.toMatchObject({ code: 'worker_unavailable' });
      expect(isWorkerUnavailable()).toBe(false);
    }
    await expect(runBackupOp('integrityCheck', { file: 'x' })).rejects.toMatchObject({ code: 'worker_unavailable' });
    expect(isWorkerUnavailable()).toBe(true);
    const calls = factory.mock.calls.length;
    await expect(runBackupOp('integrityCheck', { file: 'x' })).rejects.toMatchObject({ code: 'worker_unavailable' });
    expect(factory.mock.calls.length).toBe(calls);
    const logged = console.error.mock.calls.filter((c) => String(c[0]).startsWith('Backup worker unavailable'));
    expect(logged).toHaveLength(1);
  });

  it('a worker that becomes ready resets the count', async () => {
    const { factory } = tracked(EXIT_BEFORE_READY, EXIT_BEFORE_READY, OK, EXIT_BEFORE_READY, EXIT_BEFORE_READY);
    __setWorkerFactoryForTests(factory);
    for (let i = 0; i < 2; i += 1) await reason(runBackupOp('integrityCheck', { file: 'x' }));
    await expect(runBackupOp('integrityCheck', { file: 'x' })).resolves.toEqual({ ok: true });
    for (let i = 0; i < 2; i += 1) await reason(runBackupOp('integrityCheck', { file: 'x' }));
    expect(isWorkerUnavailable()).toBe(false);
  });

  it('a factory that throws, or an ERR_WORKER_INIT_FAILED error before ready, is permanent at once', async () => {
    __setWorkerFactoryForTests(() => {
      throw new Error('no threads');
    });
    await expect(runBackupOp('integrityCheck', { file: 'x' })).rejects.toMatchObject({ code: 'worker_unavailable' });
    expect(isWorkerUnavailable()).toBe(true);

    __setWorkerFactoryForTests(() => {
      const fake = new EventEmitter();
      fake.terminate = () => Promise.resolve(0);
      fake.postMessage = () => {};
      setImmediate(() => fake.emit('error', Object.assign(new Error('init'), { code: 'ERR_WORKER_INIT_FAILED' })));
      return fake;
    });
    await expect(runBackupOp('integrityCheck', { file: 'x' })).rejects.toMatchObject({ code: 'worker_unavailable' });
    expect(isWorkerUnavailable()).toBe(true);
  });
});

describe('worker environment', () => {
  it('holds the migrations folder and temp variables only: no tokens or other settings of this process', async () => {
    process.env.BURROW_TEST_SECRET_TOKEN = 'synthetic-secret-value';
    try {
      let seen;
      __setWorkerFactoryForTests(({ env }) => {
        seen = env;
        return new Worker(OK, { eval: true, env });
      });
      await runBackupOp('integrityCheck', { file: 'x' });
      expect(seen.BURROW_MIGRATIONS_DIR).toBe(MIGRATIONS_DIR);
      expect(JSON.stringify(seen)).not.toContain('synthetic-secret-value');
      for (const key of Object.keys(seen)) expect(['BURROW_MIGRATIONS_DIR', 'TMPDIR', 'TMP', 'TEMP']).toContain(key);
    } finally {
      delete process.env.BURROW_TEST_SECRET_TOKEN;
    }
  });

  it('a real worker still does the work with that environment', async () => {
    __setWorkerFactoryForTests(realWorker);
    const { meta } = await createBackup({ kind: 'manual', now: day(1), exportFn: emptyZip });
    expect(meta.status).toBe('verified');
    expect(meta.rowCounts.notes).toBe(2);
    expect(isWorkerUnavailable()).toBe(false);
  });
});

describe('heap limit (worker_oom)', () => {
  it('the client reports worker_oom for a worker that exhausts its heap', async () => {
    __setWorkerFactoryForTests(tracked(OOM).factory);
    await expect(runBackupOp('integrityCheck', { file: 'x' })).rejects.toMatchObject({ code: 'worker_oom' });
  }, 60_000);

  it('a snapshot that runs out of memory is backup_failed, with no main-thread retry and no leftovers', async () => {
    const { factory } = tracked(OOM);
    __setWorkerFactoryForTests(factory);
    await expect(createBackup({ kind: 'manual', now: day(2), exportFn: emptyZip })).rejects.toMatchObject({
      code: 'backup_failed',
      status: 500,
    });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(names().filter((n) => n.endsWith('.db') || n.includes('.partial'))).toEqual([]);
    expect(isWorkerUnavailable()).toBe(false);
  }, 60_000);

  it('an export that runs out of memory is a failed export on a backup that still succeeds', async () => {
    let calls = 0;
    const oom = tracked(OOM);
    const factory = vi.fn((opts) => {
      calls += 1;
      return calls === 1 ? realWorker(opts) : oom.factory(opts);
    });
    __setWorkerFactoryForTests(factory);
    const { meta } = await createBackup({ kind: 'manual', now: day(3) });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(meta.status).toBe('verified');
    expect(meta.export).toMatchObject({ status: 'failed', file: null });
    expect(names().filter((n) => n.includes('.partial'))).toEqual([]);
  }, 60_000);
});

describe('live database path (no DatabaseSync#location)', () => {
  it('still runs the snapshot in the worker, using resolveDbPath()', async () => {
    const proto = DatabaseSync.prototype;
    const original = Object.getOwnPropertyDescriptor(proto, 'location');
    Object.defineProperty(proto, 'location', { value: undefined, configurable: true, writable: true });
    try {
      const factory = vi.fn(realWorker);
      __setWorkerFactoryForTests(factory);
      const { meta } = await createBackup({ kind: 'manual', now: day(4), exportFn: emptyZip });
      expect(meta.status).toBe('verified');
      expect(factory).toHaveBeenCalledTimes(1);
    } finally {
      if (original) Object.defineProperty(proto, 'location', original);
      else delete proto.location;
    }
  });
});

describe('normalizeSnapshot: no on-disk journal while the keys are stripped', () => {
  const cipher = 'SYNTHETIC-CIPHERTEXT-0123456789abcdef';

  it('strips app_secrets without ever creating a rollback journal, and leaves a self-contained file', () => {
    getDb()
      .prepare('INSERT INTO app_secrets (name, ciphertext, iv, auth_tag, last4, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('SYNTHETIC_KEY', cipher, 'iv', 'tag', '1234', new Date().toISOString());
    const file = path.join(dataDir(), 'normalize-check.db');
    getDb().exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
    expect(fs.readFileSync(file).includes(cipher)).toBe(true);

    // Deterministic on every OS: record the statements in order. The delete must run with the journal in
    // memory (and secure_delete on), and only afterwards go back to an on-disk journal at rest.
    const execSpy = vi.spyOn(DatabaseSync.prototype, 'exec');
    let statements;
    try {
      normalizeSnapshot(file);
      statements = execSpy.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, ' ').trim().toLowerCase());
    } finally {
      execSpy.mockRestore();
    }
    const at = (sql) => statements.indexOf(sql);
    const del = at('delete from app_secrets');
    expect(del).toBeGreaterThan(-1);
    expect(at('pragma journal_mode = memory')).toBeGreaterThan(-1);
    expect(at('pragma journal_mode = memory')).toBeLessThan(del);
    expect(at('pragma secure_delete = on')).toBeGreaterThan(-1);
    expect(at('pragma secure_delete = on')).toBeLessThan(del);
    expect(statements.lastIndexOf('pragma journal_mode = delete')).toBeGreaterThan(del);

    const bytes = fs.readFileSync(file);
    expect(bytes.includes(cipher)).toBe(false);
    // Header bytes 18 and 19 are 1 for a rollback-journal database (2 means WAL).
    expect([bytes[18], bytes[19]]).toEqual([1, 1]);
    expect(fs.existsSync(`${file}-wal`)).toBe(false);
    expect(fs.existsSync(`${file}-shm`)).toBe(false);
    expect(fs.existsSync(`${file}-journal`)).toBe(false);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      expect(db.prepare('PRAGMA journal_mode').get().journal_mode).toBe('delete');
      expect(db.prepare('SELECT COUNT(*) AS n FROM app_secrets').get().n).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe('leftovers of a partial copy', () => {
  it('cleanupOrphans removes .partial, .partial-journal, .partial-wal and .partial-shm', async () => {
    const dir = backupsDir();
    fs.mkdirSync(dir, { recursive: true });
    const stale = ['.partial', '.partial-journal', '.partial-wal', '.partial-shm'].map((s) => `burrow-x.db${s}`);
    for (const n of stale) fs.writeFileSync(path.join(dir, n), 'x');
    const { removed } = await cleanupOrphans({ now: new Date(Date.now() + ORPHAN_MIN_AGE_MS + 60_000) });
    expect(removed.sort()).toEqual([...stale].sort());
    expect(names().filter((n) => n.startsWith('burrow-x'))).toEqual([]);
  });

  it('a failed backup removes the partial copy and its journal, wal and shm', async () => {
    const snapshotFn = (_db, partialPath) => {
      for (const suffix of ['', '-journal', '-wal', '-shm']) fs.writeFileSync(`${partialPath}${suffix}`, 'half');
      throw new Error('boom');
    };
    await expect(createBackup({ kind: 'manual', now: day(5), snapshotFn })).rejects.toMatchObject({ code: 'backup_failed' });
    expect(names().filter((n) => n.includes('.partial'))).toEqual([]);
  });
});

describe('a full disk while the copy is normalized', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('worker path: SQLITE_FULL is disk_full (no integrity_failed, no retry)', async () => {
    const { factory } = tracked(SQLITE_FULL);
    __setWorkerFactoryForTests(factory);
    await expect(createBackup({ kind: 'manual', now: day(6), exportFn: emptyZip })).rejects.toMatchObject({
      code: 'disk_full',
      status: 507,
    });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(names().filter((n) => n.includes('.partial'))).toEqual([]);
  });

  it('worker path: another SQLite error in that step is still a damaged copy', async () => {
    __setWorkerFactoryForTests(tracked(SQLITE_CORRUPT).factory);
    await expect(createBackup({ kind: 'manual', now: day(7), exportFn: emptyZip })).rejects.toMatchObject({
      code: 'backup_failed',
    });
  });

  it('main-thread path: SQLITE_FULL from normalizeSnapshot is disk_full', async () => {
    __setWorkerFactoryForTests(() => {
      throw new Error('no threads');
    });
    vi.mocked(normalizeSnapshot).mockImplementationOnce(() => {
      throw Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR', errcode: 13 });
    });
    await expect(createBackup({ kind: 'manual', now: day(8), exportFn: emptyZip })).rejects.toMatchObject({
      code: 'disk_full',
      status: 507,
    });
    expect(names().filter((n) => n.includes('.partial'))).toEqual([]);
  });

  it('main-thread path: any other error from normalizeSnapshot is a damaged copy', async () => {
    __setWorkerFactoryForTests(() => {
      throw new Error('no threads');
    });
    vi.mocked(normalizeSnapshot).mockImplementationOnce(() => {
      throw new Error('something else');
    });
    await expect(createBackup({ kind: 'manual', now: day(9), exportFn: emptyZip })).rejects.toMatchObject({
      code: 'backup_failed',
    });
  });
});

describe('restore of our own backup versus an uploaded file when the worker fails', () => {
  it('own backup: a worker that dies is restore_failed, and so is one that times out', async () => {
    const { meta } = await createBackup({ kind: 'manual', now: day(10), exportFn: emptyZip });
    __setWorkerFactoryForTests(tracked(CRASH_AFTER_READY).factory);
    await expect(restoreBackup({ id: meta.id, hooks: { sleep: noSleep } })).rejects.toMatchObject({
      code: 'restore_failed',
      status: 500,
    });
    __setWorkerFactoryForTests(tracked(HANG).factory);
    __setWorkerTimeoutForTests(300);
    await expect(restoreBackup({ id: meta.id, hooks: { sleep: noSleep } })).rejects.toMatchObject({ code: 'restore_failed' });
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM notes').get().n).toBe(2);
  }, 60_000);

  it('own backup: the same crash with working workers restores fine afterwards', async () => {
    const { meta } = await createBackup({ kind: 'manual', now: day(11), exportFn: emptyZip });
    __setWorkerFactoryForTests(tracked(CRASH_AFTER_READY).factory);
    await reason(restoreBackup({ id: meta.id, hooks: { sleep: noSleep } }));
    __setWorkerFactoryForTests(null);
    const result = await restoreBackup({ id: meta.id, hooks: { sleep: noSleep } });
    expect(result.restoredFrom).toBe(meta.id);
  }, 60_000);

  it('uploaded file: a worker that dies is backup_invalid', async () => {
    const { meta } = await createBackup({ kind: 'manual', now: day(12), exportFn: emptyZip });
    const bytes = fs.readFileSync(backupFile(meta.id, '.db'));
    const upload = await inspectUpload(fakeUploadReq(bytes));
    __setWorkerFactoryForTests(tracked(CRASH_AFTER_READY).factory);
    await expect(restoreBackup({ uploadToken: upload.uploadToken, hooks: { sleep: noSleep } })).rejects.toMatchObject({
      code: 'backup_invalid',
      status: 422,
    });
  }, 60_000);
});

describe('upload inspection cancel', () => {
  it('the client going away terminates the running check, removes the file and frees the worker slot', async () => {
    const { meta } = await createBackup({ kind: 'manual', now: day(13), exportFn: emptyZip });
    const bytes = fs.readFileSync(backupFile(meta.id, '.db'));
    const hang = tracked(HANG);
    __setWorkerFactoryForTests(hang.factory);
    const ac = new AbortController();
    const uploading = reason(inspectUpload(fakeUploadReq(bytes), { signal: ac.signal }));
    await vi.waitFor(() => expect(hang.state.created).toBe(1));
    const started = Date.now();
    ac.abort();
    const e = await uploading;
    expect(e).toMatchObject({ code: 'invalid_request' });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(names().filter((n) => n.startsWith('.incoming-'))).toEqual([]);
    expect(hasPendingUpload()).toBe(false);
    await vi.waitFor(() => expect(hang.state.live).toBe(0));
    // The slot is free: another operation runs at once.
    __setWorkerFactoryForTests(realWorker);
    await expect(runBackupOp('integrityCheck', { file: backupFile(meta.id, '.db') })).resolves.toEqual({ ok: true });
  }, 60_000);

  it('a restore that starts cancels an upload check in progress (backup_busy) and then runs', async () => {
    const { meta } = await createBackup({ kind: 'manual', now: day(14), exportFn: emptyZip });
    const bytes = fs.readFileSync(backupFile(meta.id, '.db'));
    let calls = 0;
    const hang = tracked(HANG);
    __setWorkerFactoryForTests((opts) => {
      calls += 1;
      return calls === 1 ? hang.factory(opts) : realWorker(opts);
    });
    const uploading = reason(inspectUpload(fakeUploadReq(bytes)));
    await vi.waitFor(() => expect(hang.state.created).toBe(1));
    const restoring = restoreBackup({ id: meta.id, hooks: { sleep: noSleep } });
    expect(await uploading).toMatchObject({ code: 'backup_busy', status: 409 });
    const result = await restoring;
    expect(result.restoredFrom).toBe(meta.id);
    expect(names().filter((n) => n.startsWith('.incoming-'))).toEqual([]);
    await vi.waitFor(() => expect(hang.state.live).toBe(0));
  }, 60_000);

  it('a restore without any upload in progress is unaffected', async () => {
    const { meta } = await createBackup({ kind: 'manual', now: day(15), exportFn: emptyZip });
    await expect(restoreBackup({ id: meta.id, hooks: { sleep: noSleep } })).resolves.toMatchObject({ restoredFrom: meta.id });
  }, 60_000);
});

describe('uploads', () => {
  it('two uploads that finish one after the other keep only the newer file (the older one is discarded)', async () => {
    const { meta } = await createBackup({ kind: 'manual', now: day(16), exportFn: emptyZip });
    const bytes = fs.readFileSync(backupFile(meta.id, '.db'));
    const finished = [];
    const run = () => inspectUpload(fakeUploadReq(bytes)).then((r) => (finished.push(r.uploadToken), r));
    const [a, b] = await Promise.all([run(), run()]);
    expect(a.uploadToken).not.toBe(b.uploadToken);
    const files = names().filter((n) => n.startsWith('.incoming-'));
    expect(files).toHaveLength(1);
    expect(hasPendingUpload()).toBe(true);
    expect(files[0]).toContain(finished[1]);
  }, 60_000);

  it('the saved-keys table is not listed in the preview counts', async () => {
    const { meta } = await createBackup({ kind: 'manual', now: day(17), exportFn: emptyZip });
    const upload = await inspectUpload(fakeUploadReq(fs.readFileSync(backupFile(meta.id, '.db'))));
    expect(upload.rowCounts).not.toHaveProperty('app_secrets');
    expect(upload.rowCounts.notes).toBe(2);
    expect(upload.totalRows).toBe(Object.values(upload.rowCounts).reduce((n, c) => n + c, 0));
  }, 60_000);

  it('a file whose header claims more than the bound is too_large before the integrity scan', async () => {
    const { meta } = await createBackup({ kind: 'manual', now: day(18), exportFn: emptyZip });
    const file = backupFile(meta.id, '.db');
    const latestVersion = latestSchemaVersion();
    expect(() => inspectDbFile(file, { latestVersion, maxBytes: 4096 })).toThrowError(expect.objectContaining({ code: 'too_large' }));
    expect(inspectDbFile(file, { latestVersion, maxBytes: 1024 * 1024 * 1024 }).integrityOk).toBe(true);
    await expect(runBackupOp('inspectFile', { file, latestVersion, maxBytes: 4096 })).rejects.toMatchObject({
      workerOpFailed: true,
      code: 'too_large',
    });
    await expect(validateCandidate(file, { maxBytes: 4096 })).rejects.toMatchObject({ code: 'too_large', status: 413 });
    await expect(validateCandidate(file, { maxBytes: 1024 * 1024 * 1024 })).resolves.toMatchObject({ integrityOk: true });
  }, 60_000);
});
