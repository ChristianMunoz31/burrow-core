// Parsing is OFF by default until the parser runs in its own process (issue #67): see docGate.js. The code below is kept
// for #67 and runs only for the developer override (BURROW_DOC_PARSING=1 in a source checkout).
// Main-thread side of the PDF and DOCX parser: runs docParsers.js in a fresh worker thread per file, so a hostile or
// pathological file can only cost its own timeout, heap limit or crash, never the server. The worker gets the bytes
// (already read through the identity-checked read-only handle in extract.js), no environment, no file handles, and
// is terminated when it answers, times out, runs out of memory or the caller's signal aborts.
//
// What the isolation contains: JS errors, thrown exceptions and a V8 heap out-of-memory inside the worker. It does NOT
// contain a Node-level native crash (an access violation or abort in the runtime or a native addon), which takes down
// the whole process. We lower that risk where we can: a worker is not terminated before it is ready (modules loaded:
// parserWorker.js posts { ready: true } after its static imports, which is later than the 'online' event), unless it has
// exited or WORKER_START_WAIT_MS has passed. Terminating a worker that is still loading and compiling its startup module
// graph can kill the whole process natively on some Node builds (seen as 0xC0000005 on Node 24 win-arm64), so an abort,
// timeout or doc_oom during startup waits for the ready message first (finish() waits for ready, 'exit' or the cap).
//
// A Node SEA has no worker file, so the sidecar embeds the bundled worker as a source string (define
// __BURROW_PARSER_WORKER_SRC__, scripts/desktop/workerBundle.js), the same way the backup worker is embedded.
// In a source checkout the worker file is started directly.
//
// Memory: resourceLimits.maxOldGenerationSizeMb caps only the V8 heap, not ArrayBuffers/typed arrays, and pdf.js inflates
// FlateDecode streams into growing typed arrays, so a tiny PDF can inflate to GBs inside the 20 s timeout. A main-thread
// watchdog therefore polls the process RSS every LIMITS.docMemoryPollMs while a parse runs and terminates the worker (doc_oom)
// once it is more than LIMITS.docMemoryMb above where it was when the parse started. Worker.terminate() interrupts a busy
// decode loop (checked in practice: about 60 ms), and the poll runs on the main thread, which the worker never blocks.
//
// Errors thrown here:
//   AbortError   (name 'AbortError', aborted: true) the caller's signal fired; the worker was terminated
//   DocParseError with code doc_encrypted | doc_corrupt | doc_zip_limits (from the worker),
//                 doc_timeout | doc_oom | doc_crashed | doc_unavailable | doc_parsing_off (from this file)
/* global __BURROW_PARSER_WORKER_SRC__ */
import { Worker } from 'node:worker_threads';
import { LIMITS } from './constants.js';
import { DOC_PARSING_OFF, docParsingEnabled } from './docGate.js';

const BUNDLED_WORKER_SRC = typeof __BURROW_PARSER_WORKER_SRC__ === 'string' ? __BURROW_PARSER_WORKER_SRC__ : undefined;

/** Error with a stable code; the message is the code. */
export class DocWorkerError extends Error {
  /** @param {'doc_timeout'|'doc_oom'|'doc_crashed'|'doc_unavailable'|'doc_encrypted'|'doc_corrupt'|'doc_zip_limits'|'doc_parsing_off'} code */
  constructor(code) {
    super(code);
    this.name = 'DocWorkerError';
    this.code = code;
  }
}

/**
 * Failures that say nothing certain about the file (the machine was busy, the parser was killed or could not start): the
 * scan tries such a document again, a bounded number of times (jobs.js). doc_encrypted, doc_corrupt and doc_zip_limits are
 * about the content and stay final until the file changes.
 */
export const TRANSIENT_DOC_CODES = Object.freeze(new Set(['doc_timeout', 'doc_oom', 'doc_crashed', 'doc_unavailable']));

/** The per-page lengths from the worker, or null unless they are a short list of plain non-negative integers. */
const validLengths = (v) =>
  Array.isArray(v) && v.length <= LIMITS.maxDocPages && v.every((n) => Number.isSafeInteger(n) && n >= 0) ? v : null;

/** Longest a finishing parse waits for a worker that is still loading its modules before it terminates it anyway. */
const WORKER_START_WAIT_MS = 10_000;

const abortError = () => Object.assign(new Error('Aborted'), { name: 'AbortError', aborted: true });

// One process-wide parse slot. The RSS watchdog below judges growth since the parse started, so two parses running at once
// (a scan job and a preview, or two jobs) would blame each other's memory (false doc_oom). Every caller of parseDocument
// therefore holds this slot around the parse only (extract.js), never around the read or the hash.
let slotHeld = false;
/** @type {{ grant: (release: () => void) => void, signal?: AbortSignal, onAbort: () => void }[]} */
const slotWaiters = [];

function makeRelease() {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const next = slotWaiters.shift();
    if (next) {
      // The slot passes straight to the first waiter; it stays held.
      next.signal?.removeEventListener('abort', next.onAbort);
      next.grant(makeRelease());
    } else slotHeld = false;
  };
}

/** Take the parse slot if it is free. @returns {(() => void) | null} the release function, or null while the slot is held */
export function tryAcquireParseSlot() {
  if (slotHeld) return null;
  slotHeld = true;
  return makeRelease();
}

/**
 * Wait for the parse slot (first come, first served).
 * @param {{ signal?: AbortSignal }} [opts] an aborted signal stops the wait (AbortError, `aborted: true`)
 * @returns {Promise<() => void>} the release function
 */
export function acquireParseSlot({ signal } = {}) {
  if (signal?.aborted) return Promise.reject(abortError());
  const release = tryAcquireParseSlot();
  if (release) return Promise.resolve(release);
  return new Promise((resolve, reject) => {
    const waiter = {
      grant: resolve,
      signal,
      onAbort() {
        const at = slotWaiters.indexOf(waiter);
        if (at !== -1) slotWaiters.splice(at, 1);
        reject(abortError());
      },
    };
    signal?.addEventListener('abort', waiter.onAbort, { once: true });
    slotWaiters.push(waiter);
  });
}

/** @type {Set<Worker>} workers that are running right now (tests check that none is left behind) */
const active = new Set();
export const activeParserWorkerCount = () => active.size;

/** @type {((spec: { kind: string, bytes: Uint8Array, limits: object }) => Worker) | null} */
let factoryOverride = null;

/**
 * Test seam: replace how the worker is created (null restores the real one).
 * @param {typeof factoryOverride} fn
 */
export function __setParserWorkerFactoryForTests(fn) {
  if (!process.env.VITEST) throw new Error('__setParserWorkerFactoryForTests is a test seam');
  factoryOverride = fn;
}

function defaultFactory({ kind, bytes, limits }) {
  const options = {
    workerData: { kind, bytes, limits },
    transferList: [bytes.buffer],
    env: {},
    resourceLimits: { maxOldGenerationSizeMb: LIMITS.docHeapMb },
  };
  if (BUNDLED_WORKER_SRC) return new Worker(BUNDLED_WORKER_SRC, { eval: true, ...options });
  return new Worker(new URL('./parserWorker.js', import.meta.url), options);
}

let timeoutOverrideMs = null;
/** @type {{ limitBytes?: number, pollMs?: number, probe?: () => number } | null} */
let memoryOverride = null;

/**
 * Test seam: change the memory watchdog (null restores LIMITS.docMemoryMb, LIMITS.docMemoryPollMs and the process RSS).
 * `probe` returns the current memory use in bytes.
 * @param {typeof memoryOverride} opts
 */
export function __setParserMemoryGuardForTests(opts) {
  if (!process.env.VITEST) throw new Error('__setParserMemoryGuardForTests is a test seam');
  memoryOverride = opts;
}

/** Test seam: force the per-file timeout (null restores LIMITS.docTimeoutMs). @param {number | null} ms */
export function __setParserTimeoutForTests(ms) {
  if (!process.env.VITEST) throw new Error('__setParserTimeoutForTests is a test seam');
  timeoutOverrideMs = ms;
}

/**
 * Extract the text of a PDF or DOCX in a worker thread.
 * @param {'pdf'|'docx'} kind
 * @param {Uint8Array} input The file bytes (copied for the worker; the caller's buffer is untouched).
 * @param {{ signal?: AbortSignal, timeoutMs?: number }} [opts]
 * @returns {Promise<{ text: string, pages: number | null, totalPages: number | null, truncated: boolean, pageLengths: number[] | null }>}
 * @throws {Error} AbortError, or a DocWorkerError (see the list at the top of this file)
 */
export function parseDocument(kind, input, { signal, timeoutMs = timeoutOverrideMs ?? LIMITS.docTimeoutMs } = {}) {
  if (signal?.aborted) return Promise.reject(abortError());
  // Last line of defence behind extract.js: with parsing off (docGate.js) no worker is ever created.
  if (!docParsingEnabled()) return Promise.reject(new DocWorkerError(DOC_PARSING_OFF));
  const guard = {
    limitBytes: memoryOverride?.limitBytes ?? LIMITS.docMemoryMb * 1024 * 1024,
    pollMs: memoryOverride?.pollMs ?? LIMITS.docMemoryPollMs,
    probe: memoryOverride?.probe ?? (() => process.memoryUsage.rss()),
  };
  const baseline = guard.probe();
  const bytes = new Uint8Array(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength));
  const limits = {
    maxPages: LIMITS.maxDocPages,
    maxChars: LIMITS.maxFileBytes,
    maxEntries: LIMITS.docxMaxEntries,
    maxEntryBytes: LIMITS.docxMaxEntryBytes,
    maxTotalBytes: LIMITS.docxMaxTotalBytes,
  };
  let worker;
  try {
    worker = (factoryOverride ?? defaultFactory)({ kind, bytes, limits });
  } catch {
    return Promise.reject(new DocWorkerError('doc_unavailable'));
  }
  active.add(worker);
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let watchdog = null;
    let ready = false;
    let exited = false;
    const readyWaiters = new Set();
    // Resolves once terminate() is safe: the worker is ready (modules loaded), has exited, or WORKER_START_WAIT_MS passed.
    const whenStarted = () =>
      ready || exited
        ? Promise.resolve()
        : new Promise((resolveWait) => {
            let waitTimer = null;
            const done = () => {
              clearTimeout(waitTimer);
              readyWaiters.delete(done);
              worker.removeListener('exit', done);
              resolveWait();
            };
            waitTimer = setTimeout(done, WORKER_START_WAIT_MS);
            waitTimer.unref?.();
            readyWaiters.add(done);
            worker.once('exit', done);
          });
    const finish = (settle) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(watchdog);
      signal?.removeEventListener('abort', onAbort);
      whenStarted()
        .then(() => worker.terminate())
        .catch(() => {})
        .then(() => {
          active.delete(worker);
          settle();
        });
    };
    const fail = (error) => finish(() => reject(error));
    function onAbort() {
      fail(abortError());
    }
    timer = setTimeout(() => fail(new DocWorkerError('doc_timeout')), timeoutMs);
    timer.unref?.();
    watchdog = setInterval(() => {
      let used;
      try {
        used = guard.probe();
      } catch {
        return;
      }
      if (used - baseline > guard.limitBytes) fail(new DocWorkerError('doc_oom'));
    }, guard.pollMs);
    watchdog.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.on('error', (err) => fail(new DocWorkerError(err?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'doc_oom' : 'doc_crashed')));
    worker.on('messageerror', () => fail(new DocWorkerError('doc_crashed')));
    worker.on('exit', () => {
      exited = true;
      fail(new DocWorkerError('doc_crashed'));
    });
    worker.on('message', (msg) => {
      if (msg?.ready === true && msg.ok === undefined) {
        ready = true;
        for (const done of [...readyWaiters]) done();
        return;
      }
      if (msg?.ok === true && typeof msg.text === 'string') {
        finish(() => resolve({ text: msg.text, pages: msg.pages ?? null, totalPages: msg.totalPages ?? null, truncated: Boolean(msg.truncated), pageLengths: validLengths(msg.pageLengths) }));
      } else if (msg?.ok === false) {
        const known = ['doc_encrypted', 'doc_corrupt', 'doc_zip_limits'];
        fail(new DocWorkerError(known.includes(msg.code) ? msg.code : 'doc_corrupt'));
      } else fail(new DocWorkerError('doc_crashed'));
    });
    if (signal?.aborted) onAbort();
  });
}
