// Runs the heavy SQLite steps of a backup in a worker thread (see backupWorker.js), one worker per
// operation, terminated afterwards. Only one operation runs at a time (a 1-slot FIFO), so a backup
// never competes with an inspection for CPU. When a worker cannot be created at all, callers run the
// same step on the main thread (workerUnavailable stays set for the rest of the process).
//
// Limits of cancelling: worker.terminate() stops the thread's JavaScript, but it cannot interrupt a
// native SQLite call that is already running (one VACUUM INTO or integrity_check). A cancelled or timed
// out operation therefore settles at once for the caller (worker_cancelled / worker_timeout), while the
// thread may keep working until that single call returns; it is then stopped before it can post anything.
// Callers must not assume the CPU or file handles are free the instant the promise rejects, which is why
// shutdown (drainBackupWorker) bounds how long it waits for terminate().
//
// Errors thrown here (all carry `code`):
//   worker_unavailable  no worker could start (factory threw or init failed: permanent for the process;
//                       a ready timeout or an exit before ready: permanent after 3 in a row)
//   worker_crashed      the worker died or errored after it was ready
//   worker_oom          the worker hit its heap limit (WORKER_HEAP_MB); never retried on the main thread
//   worker_timeout      the operation did not finish in time; the worker was terminated
//   worker_cancelled    the caller's AbortSignal fired, or the client is draining for shutdown
//   worker_op_failed    the operation threw inside the worker; `stage` says where
/* global __BURROW_BACKUP_WORKER_SRC__ */
import { Worker } from 'node:worker_threads';
import { MIGRATIONS_DIR } from '../../db/migrate.js';

const MIN_MS = 60 * 1000;
export const READY_TIMEOUT_MS = 5000;
/** Consecutive "never became ready" failures after which the worker is given up for this process. */
export const START_FAILURE_LIMIT = 3;
export const WORKER_HEAP_MB = 512;
/** How long drainBackupWorker waits for terminate() of the active worker before it gives up on it. */
export const TERMINATE_WAIT_MS = 500;
export const OP_TIMEOUT_MS = Object.freeze({
  snapshotInspect: 15 * MIN_MS,
  inspectFile: 10 * MIN_MS,
  integrityCheck: 10 * MIN_MS,
  buildExport: 5 * MIN_MS,
});

/** Source of the bundled worker (desktop sidecar build), else undefined. */
const BUNDLED_WORKER_SRC = typeof __BURROW_BACKUP_WORKER_SRC__ === 'string' ? __BURROW_BACKUP_WORKER_SRC__ : undefined;

/**
 * The worker's whole environment: where the migrations are (the one thing it reads, at module load) and
 * the temp folder variables. No tokens, keys or other settings of this process.
 */
function workerEnv() {
  const env = { BURROW_MIGRATIONS_DIR: MIGRATIONS_DIR };
  for (const name of ['TMPDIR', 'TMP', 'TEMP']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

const workerOptions = ({ env }) => ({ env, resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB } });

function defaultFactory(opts) {
  if (BUNDLED_WORKER_SRC) return new Worker(BUNDLED_WORKER_SRC, { eval: true, ...workerOptions(opts) });
  return new Worker(new URL('./backupWorker.js', import.meta.url), workerOptions(opts));
}

/** @type {((opts: { env: Record<string, string | undefined> }) => import('node:worker_threads').Worker) | null} */
let factoryOverride = null;
let timeoutOverrideMs = null;
let workerUnavailable = false;
let unavailableLogged = false;
let startFailures = 0;
let draining = false;
/** @type {{ op: string, payload: object, limit: number, resolve: Function, reject: Function, detach: () => void }[]} */
const queue = [];
/** @type {{ job: object, cancel: (e: Error) => Promise<void>, finished: Promise<void> } | null} */
let active = null;

/**
 * Test seam: replace how workers are created (null restores the real one) and forget an earlier
 * "worker unavailable" verdict and any drain.
 * @param {typeof factoryOverride} fn
 */
export function __setWorkerFactoryForTests(fn) {
  factoryOverride = fn;
  workerUnavailable = false;
  unavailableLogged = false;
  startFailures = 0;
  draining = false;
}

/** Test seam: force every operation timeout, read when the worker is ready (null restores the defaults). */
export function __setWorkerTimeoutForTests(ms) {
  timeoutOverrideMs = ms;
}

export const isWorkerUnavailable = () => workerUnavailable;

/** Lets operations run again after drainBackupWorker (the server calls it when it starts). */
export function resumeBackupWorker() {
  draining = false;
}

function workerError(code, extra = {}) {
  return Object.assign(new Error(code), { code, ...extra });
}

/**
 * Records a worker that could not start. A factory throw or ERR_WORKER_INIT_FAILED is permanent; any other
 * start failure counts toward START_FAILURE_LIMIT in a row. Either way the caller runs this one
 * operation on the main thread (worker_unavailable).
 */
function markUnavailable(cause, { permanent = false } = {}) {
  if (permanent) {
    workerUnavailable = true;
  } else {
    startFailures += 1;
    if (startFailures >= START_FAILURE_LIMIT) workerUnavailable = true;
  }
  if (workerUnavailable && !unavailableLogged) {
    unavailableLogged = true;
    console.error('Backup worker unavailable, using the main thread:', cause?.code ?? 'unknown');
  }
  return workerError('worker_unavailable', { cause });
}

const rejected = (e) => ({ promise: Promise.reject(e), cancel: () => Promise.resolve() });

/**
 * Starts one worker for one operation.
 * @returns {{ promise: Promise<unknown>, cancel: (e: Error) => Promise<void> }} cancel settles the
 *   promise with `e` and resolves once the thread was terminated
 */
function execute(op, payload, timeoutMs) {
  if (workerUnavailable) return rejected(workerError('worker_unavailable'));
  let worker;
  try {
    worker = (factoryOverride ?? defaultFactory)({ env: workerEnv() });
  } catch (e) {
    return rejected(markUnavailable(e, { permanent: true }));
  }
  let cancel = () => Promise.resolve();
  const promise = new Promise((resolve, reject) => {
    let settled = false;
    let ready = false;
    let timer = null;
    let markClosed = () => {};
    const closed = new Promise((r) => {
      markClosed = r;
    });
    const finish = (settle) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Wait for the thread to stop so its file handles are closed (Windows keeps a file open until then).
      Promise.resolve()
        .then(() => worker.terminate())
        .catch(() => {})
        .then(() => {
          settle();
          markClosed();
        });
    };
    const fail = (e) => finish(() => reject(e));
    cancel = (e) => {
      fail(e);
      return closed;
    };
    const arm = (ms, make) => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(make()), ms);
      timer.unref?.();
    };
    const lost = (cause) => {
      if (settled) return;
      if (ready) {
        fail(workerError(cause?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'worker_oom' : 'worker_crashed', { cause }));
        return;
      }
      fail(markUnavailable(cause, { permanent: cause?.code === 'ERR_WORKER_INIT_FAILED' }));
    };

    arm(READY_TIMEOUT_MS, () => markUnavailable(workerError('worker_ready_timeout')));
    worker.on('error', lost);
    worker.on('messageerror', lost);
    worker.on('exit', (exitCode) => {
      if (!settled) lost(workerError('worker_exit', { exitCode }));
    });
    worker.on('message', (msg) => {
      if (settled) return;
      if (!ready) {
        if (msg?.type !== 'ready') return lost(workerError('worker_bad_message'));
        ready = true;
        startFailures = 0;
        arm(timeoutOverrideMs ?? timeoutMs, () => workerError('worker_timeout', { op }));
        try {
          worker.postMessage({ op, payload });
        } catch (e) {
          lost(e);
        }
        return undefined;
      }
      if (msg?.ok === true) return finish(() => resolve(msg.result));
      if (msg?.ok === false) {
        const info = msg.error ?? {};
        const e = Object.assign(new Error(info.errstr ?? info.name ?? 'worker_op_failed'), {
          name: info.name ?? 'Error',
          code: info.code ?? 'worker_op_failed',
          errcode: info.errcode ?? null,
          errstr: info.errstr ?? null,
          stage: msg.stage,
          workerOpFailed: true,
        });
        return fail(e);
      }
      return lost(workerError('worker_bad_message'));
    });
  });
  return { promise, cancel: (e) => cancel(e) };
}

function pump() {
  if (active || queue.length === 0) return;
  const job = queue.shift();
  const run = execute(job.op, job.payload, job.limit);
  const entry = { job, cancel: run.cancel, finished: Promise.resolve() };
  entry.finished = run.promise.then(job.resolve, job.reject).then(() => {
    job.detach();
    if (active === entry) active = null;
    pump();
  });
  active = entry;
}

function cancelJob(job) {
  const i = queue.indexOf(job);
  if (i !== -1) {
    queue.splice(i, 1);
    job.detach();
    job.reject(workerError('worker_cancelled'));
    return;
  }
  if (active?.job === job) void active.cancel(workerError('worker_cancelled'));
}

/**
 * Runs one operation in a fresh worker. Resolves with the operation's result. An aborted `signal` drops
 * the job when it is still queued and terminates its worker when it is running (worker_cancelled).
 * @param {'snapshotInspect' | 'inspectFile' | 'integrityCheck' | 'buildExport'} op
 * @param {object} payload absolute paths and plain values only
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [opts]
 */
export function runBackupOp(op, payload, { timeoutMs, signal } = {}) {
  const limit = timeoutMs ?? OP_TIMEOUT_MS[op] ?? OP_TIMEOUT_MS.inspectFile;
  return new Promise((resolve, reject) => {
    if (draining || signal?.aborted) {
      reject(workerError('worker_cancelled'));
      return;
    }
    const job = { op, payload, limit, resolve, reject, detach: () => {} };
    if (signal) {
      const onAbort = () => cancelJob(job);
      signal.addEventListener('abort', onAbort, { once: true });
      job.detach = () => signal.removeEventListener('abort', onAbort);
    }
    queue.push(job);
    pump();
  });
}

/**
 * Shutdown: waits up to `timeoutMs` for the running and queued operations; when they are not done by
 * then, drops the queued ones (worker_cancelled) and terminates the running worker, waiting at most
 * TERMINATE_WAIT_MS for the thread to stop. Afterwards new operations are refused (worker_cancelled)
 * until resumeBackupWorker() or a test reset. Never rejects.
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ terminated: boolean, dropped: number }>}
 */
export async function drainBackupWorker({ timeoutMs = 2000 } = {}) {
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve('expired'), timeoutMs);
  });
  const idle = (async () => {
    while (active) await active.finished;
    return 'idle';
  })();
  const outcome = await Promise.race([idle, expired]);
  clearTimeout(timer);
  draining = true;
  if (outcome === 'idle') return { terminated: false, dropped: 0 };
  const dropped = queue.splice(0);
  for (const job of dropped) {
    job.detach();
    job.reject(workerError('worker_cancelled'));
  }
  const current = active;
  if (current) {
    let waitTimer;
    const gaveUp = new Promise((resolve) => {
      waitTimer = setTimeout(resolve, TERMINATE_WAIT_MS);
    });
    await Promise.race([current.cancel(workerError('worker_cancelled')), gaveUp]);
    clearTimeout(waitTimer);
  }
  return { terminated: Boolean(current), dropped: dropped.length };
}

/** True for the failures after which the caller may run the same step on the main thread. */
export const canFallBackToMainThread = (e) => e?.code === 'worker_unavailable';

/** Failures that must not be retried on the main thread (the same work would block or exhaust it). */
export const isTerminalWorkerFailure = (e) =>
  e?.code === 'worker_timeout' || e?.code === 'worker_cancelled' || e?.code === 'worker_oom';
