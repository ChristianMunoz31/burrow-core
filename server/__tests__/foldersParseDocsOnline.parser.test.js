// Parser worker tests: they need document parsing on and start real parser workers, so they run only in `npm run test:parser`
// (vitest.parser.config.js, issue #67) and return to the default suite when the parser runs in its own process.
// Regression for the parser worker start gate (parseDocs.js finish()): a worker is never terminated before it is ready
// ({ ready: true } message, or has exited), waits at most WORKER_START_WAIT_MS, and leaves no listener or timer behind. Fake EventEmitter workers
// with fake timers for the exact contract, then real workers aborted at staggered times for the stress case.
// Synthetic bytes only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  __setParserMemoryGuardForTests,
  __setParserTimeoutForTests,
  __setParserWorkerFactoryForTests,
  activeParserWorkerCount,
  parseDocument,
} from '../folders/parseDocs.js';
import { makeDocx, makePdf } from './helpers/synthDocs.js';

const START_WAIT_MS = 10_000; // WORKER_START_WAIT_MS in parseDocs.js (not exported)
const BYTES = new Uint8Array([1, 2, 3]);
const READY = { ready: true };

/** An EventEmitter worker that stays "starting" until the test emits the ready message. terminate() is recorded and, like a real one, then exits. */
function makeFake() {
  const w = new EventEmitter();
  w.terminate = vi.fn(() => {
    queueMicrotask(() => w.emit('exit', 1));
    return Promise.resolve(1);
  });
  return w;
}

/** Records how a promise settled, so a rejection is never unhandled while the test advances timers. */
const track = (p) => {
  const out = { done: false };
  p.then(
    (value) => Object.assign(out, { done: true, value }),
    (err) => Object.assign(out, { done: true, err }),
  );
  return out;
};
const flush = () => vi.advanceTimersByTimeAsync(0);
const counts = (w) => ({ message: w.listenerCount('message'), exit: w.listenerCount('exit') });

describe('parseDocument waits for the worker to be ready (modules loaded) before terminate()', () => {
  let worker;

  beforeEach(() => {
    vi.useFakeTimers();
    worker = makeFake();
    __setParserWorkerFactoryForTests(() => worker);
    __setParserMemoryGuardForTests({ probe: () => 0 }); // the watchdog must not read the real RSS here
  });
  afterEach(() => {
    __setParserWorkerFactoryForTests(null);
    __setParserTimeoutForTests(null);
    __setParserMemoryGuardForTests(null);
    vi.useRealTimers();
  });

  /** Runs one finish path against a worker that is not ready yet and checks the gate around the ready message. */
  async function expectGated({ start, trigger, check }) {
    const controller = new AbortController();
    const result = track(start(controller));
    expect(activeParserWorkerCount()).toBe(1);
    await trigger({ controller });
    await flush();
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(result.done).toBe(false);
    expect(activeParserWorkerCount()).toBe(1);
    worker.emit('message', READY);
    await flush();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(result.done).toBe(true);
    check(result.err);
    expect(activeParserWorkerCount()).toBe(0);
  }

  it('abort before ready: terminate waits, then the promise rejects with AbortError', async () => {
    await expectGated({
      start: (c) => parseDocument('pdf', BYTES, { signal: c.signal }),
      trigger: ({ controller }) => controller.abort(),
      check: (err) => expect(err).toMatchObject({ name: 'AbortError', aborted: true }),
    });
  });

  it('timeout before ready: terminate waits, then doc_timeout', async () => {
    __setParserTimeoutForTests(100);
    await expectGated({
      start: () => parseDocument('pdf', BYTES),
      trigger: () => vi.advanceTimersByTimeAsync(150),
      check: (err) => expect(err).toMatchObject({ name: 'DocWorkerError', code: 'doc_timeout' }),
    });
  });

  it('memory guard before ready: terminate waits, then doc_oom', async () => {
    let rss = 0;
    __setParserMemoryGuardForTests({ limitBytes: 1000, pollMs: 10, probe: () => rss });
    await expectGated({
      start: () => parseDocument('pdf', BYTES),
      trigger: () => {
        rss = 5000;
        return vi.advanceTimersByTimeAsync(30);
      },
      check: (err) => expect(err).toMatchObject({ code: 'doc_oom' }),
    });
  });

  it('worker error before ready: terminate waits, then doc_crashed', async () => {
    await expectGated({
      start: () => parseDocument('pdf', BYTES),
      trigger: () => worker.emit('error', new Error('boom')),
      check: (err) => expect(err).toMatchObject({ code: 'doc_crashed' }),
    });
  });

  it('ERR_WORKER_OUT_OF_MEMORY before ready: terminate waits, then doc_oom', async () => {
    await expectGated({
      start: () => parseDocument('pdf', BYTES),
      trigger: () => worker.emit('error', Object.assign(new Error('heap'), { code: 'ERR_WORKER_OUT_OF_MEMORY' })),
      check: (err) => expect(err).toMatchObject({ code: 'doc_oom' }),
    });
  });

  it('a successful answer before ready is also gated and still resolves', async () => {
    const result = track(parseDocument('pdf', BYTES));
    worker.emit('message', { ok: true, text: 'hello', pages: 1, totalPages: 1, truncated: false, pageLengths: [5] });
    await flush();
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(result.done).toBe(false);
    worker.emit('message', READY);
    await flush();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(result.value).toMatchObject({ text: 'hello', pages: 1 });
  });

  it("an 'exit' before ready releases the gate: settles as doc_crashed", async () => {
    const result = track(parseDocument('pdf', BYTES));
    worker.emit('exit', 1);
    await flush();
    expect(result.done).toBe(true);
    expect(result.err).toMatchObject({ code: 'doc_crashed' });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(activeParserWorkerCount()).toBe(0);
  });

  it('a worker that never becomes ready is terminated after the 10000 ms cap and the promise settles', async () => {
    const controller = new AbortController();
    const result = track(parseDocument('pdf', BYTES, { signal: controller.signal }));
    controller.abort();
    await vi.advanceTimersByTimeAsync(START_WAIT_MS - 1);
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(result.done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(result.done).toBe(true);
    expect(result.err).toMatchObject({ name: 'AbortError' });
    expect(activeParserWorkerCount()).toBe(0);
  });

  it('still cleans up when terminate() rejects', async () => {
    worker.terminate = vi.fn(() => Promise.reject(new Error('already gone')));
    const controller = new AbortController();
    const result = track(parseDocument('pdf', BYTES, { signal: controller.signal }));
    worker.emit('message', READY);
    controller.abort();
    await flush();
    expect(result.err).toMatchObject({ name: 'AbortError' });
    expect(activeParserWorkerCount()).toBe(0);
  });

  it('an already-ready worker is terminated immediately, with no added delay', async () => {
    const controller = new AbortController();
    const result = track(parseDocument('pdf', BYTES, { signal: controller.signal }));
    worker.emit('message', READY);
    controller.abort();
    await flush(); // zero fake time passes
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(result.done).toBe(true);
    expect(result.err).toMatchObject({ name: 'AbortError' });
  });

  it('leaves no start-gate listeners or timers behind when released by ready', async () => {
    const controller = new AbortController();
    const result = track(parseDocument('pdf', BYTES, { signal: controller.signal }));
    const baseline = counts(worker);
    controller.abort();
    await flush();
    expect(counts(worker)).toEqual({ message: baseline.message, exit: baseline.exit + 1 }); // the gate is waiting
    worker.emit('message', READY);
    await flush();
    expect(result.done).toBe(true);
    expect(counts(worker).exit).toBeLessThanOrEqual(baseline.exit); // gate's exit listener removed
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no start-gate listeners or timers behind when the cap fires', async () => {
    const controller = new AbortController();
    const result = track(parseDocument('pdf', BYTES, { signal: controller.signal }));
    const baseline = counts(worker);
    controller.abort();
    await flush();
    expect(vi.getTimerCount()).toBe(1); // only the gate's cap timer
    await vi.advanceTimersByTimeAsync(START_WAIT_MS + 10);
    expect(result.done).toBe(true);
    expect(worker.listenerCount('message')).toBeLessThanOrEqual(baseline.message);
    expect(worker.listenerCount('exit')).toBeLessThanOrEqual(baseline.exit);
    expect(vi.getTimerCount()).toBe(0);
    expect(activeParserWorkerCount()).toBe(0);
  });

  it('a { ready: true } message is never a parse result', async () => {
    const result = track(parseDocument('pdf', BYTES));
    worker.emit('message', READY);
    await flush();
    expect(result.done).toBe(false);
    expect(worker.terminate).not.toHaveBeenCalled();
    worker.emit('message', READY);
    await flush();
    expect(result.done).toBe(false);
    worker.emit('message', { ok: true, text: 'real', pages: 1, totalPages: 1, truncated: false, pageLengths: [4] });
    await flush();
    expect(result.value).toMatchObject({ text: 'real' });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('an already-aborted signal never creates a worker', async () => {
    const factory = vi.fn(() => worker);
    __setParserWorkerFactoryForTests(factory);
    const controller = new AbortController();
    controller.abort();
    await expect(parseDocument('pdf', BYTES, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(factory).not.toHaveBeenCalled();
  });
});

describe('parseDocument with real workers aborted at staggered times', () => {
  afterEach(() => {
    __setParserMemoryGuardForTests(null);
    __setParserTimeoutForTests(null);
  });

  it('settles every parse, leaves no worker behind and keeps the process alive', async () => {
    // RSS is shared by concurrent workers, so the per-parse growth guard would blame them for each other.
    __setParserMemoryGuardForTests({ probe: () => 0 });
    // Generous so a loaded machine never turns a slow parse into a timeout; a real hang is caught by the test timeout.
    __setParserTimeoutForTests(60_000);
    const pdf = makePdf([['Synthetic page one'], ['Synthetic page two']]);
    const docx = makeDocx(['Synthetic paragraph'], { header: 'Header' });
    // Five waves of four concurrent workers. 0: aborted right after creation, before the worker can be ready;
    // null: never aborted, must finish by itself; the rest abort at staggered times around the ready message.
    const waves = [
      [0, 0, 1, null],
      [0, 3, 8, null],
      [0, 15, 30, null],
      [0, 60, 120, null],
      [0, 2, 5, null],
    ];
    const wave = (offset) =>
      Promise.allSettled(
        waves[offset].map(async (delay, i) => {
          const controller = new AbortController();
          const isPdf = (offset + i) % 2 === 0;
          const p = parseDocument(isPdf ? 'pdf' : 'docx', isPdf ? pdf : docx, { signal: controller.signal });
          if (delay === 0) controller.abort(); // right after creation, before the worker can be ready
          else if (delay !== null) setTimeout(() => controller.abort(), delay);
          return p;
        }),
      );

    const results = [];
    for (let w = 0; w < waves.length; w += 1) results.push(...(await wave(w))); // 20 parses, 4 workers at a time

    expect(results).toHaveLength(20);
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') expect(r.value.text, `parse ${i}`).toMatch(/Synthetic/);
      else expect(r.reason, `parse ${i}`).toMatchObject({ name: 'AbortError', aborted: true });
    });
    // The parses nobody aborted finish by themselves; the ones aborted at once never do.
    for (const i of [3, 7, 11, 15, 19]) expect(results[i].status, `parse ${i}`).toBe('fulfilled');
    for (const i of [0, 4, 8, 12, 16]) expect(results[i].status, `parse ${i}`).toBe('rejected');
    expect(activeParserWorkerCount()).toBe(0);
    // Still alive and able to parse afterwards.
    const after = await parseDocument('pdf', pdf);
    expect(after.text).toMatch(/Synthetic/);
    expect(activeParserWorkerCount()).toBe(0);
  }, 120_000);
});
