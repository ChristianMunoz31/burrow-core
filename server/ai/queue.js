// FIFO semaphore for model calls. A local model serves one request at a time well, so
// callers wait in order. Over `max` waiters the request is refused (AiBusyError); a
// waiter whose signal aborts, or who waits longer than `timeoutMs`, leaves the queue.
import { AiBusyError } from './gate.js';

const positiveInt = (v, fallback) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Abort error thrown when the caller's signal fires while waiting. */
const abortError = () => Object.assign(new Error('Aborted while waiting for the AI queue'), { name: 'AbortError', aborted: true });

export class AiQueue {
  /**
   * @param {{ concurrency?: number, max?: number, timeoutMs?: number }} [opts]
   */
  constructor({ concurrency = 1, max = 8, timeoutMs = 300_000 } = {}) {
    this.concurrency = positiveInt(concurrency, 1);
    this.max = Math.max(0, Math.floor(Number(max)) || 0);
    this.timeoutMs = positiveInt(timeoutMs, 300_000);
    this.active = 0;
    /** @type {Array<{ grant: () => void }>} */
    this.waiting = [];
  }

  /** Number of callers waiting for a slot. */
  get size() {
    return this.waiting.length;
  }

  /**
   * Wait for a slot. Resolves with an idempotent release function.
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {Promise<() => void>}
   */
  acquire({ signal } = {}) {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.active < this.concurrency) {
      this.active += 1;
      return Promise.resolve(this.#releaser());
    }
    if (this.waiting.length >= this.max) return Promise.reject(new AiBusyError());

    return new Promise((resolve, reject) => {
      let timer = null;
      const entry = {
        grant: () => {
          cleanup();
          resolve(this.#releaser());
        },
      };
      const leave = () => {
        const i = this.waiting.indexOf(entry);
        if (i !== -1) this.waiting.splice(i, 1);
      };
      const onAbort = () => {
        leave();
        cleanup();
        reject(abortError());
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
      };
      timer = setTimeout(() => {
        leave();
        cleanup();
        reject(new AiBusyError());
      }, this.timeoutMs);
      timer.unref?.();
      signal?.addEventListener?.('abort', onAbort, { once: true });
      this.waiting.push(entry);
    });
  }

  #releaser() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      // Hand the slot straight to the next waiter (active count unchanged).
      if (next) next.grant();
      else this.active = Math.max(0, this.active - 1);
    };
  }
}

/**
 * Queue configured from env: BURROW_AI_CONCURRENCY, BURROW_AI_QUEUE_MAX, BURROW_AI_QUEUE_TIMEOUT_MS.
 * @param {Record<string, string | undefined>} [env]
 * @returns {AiQueue}
 */
export function createQueueFromEnv(env = process.env) {
  const max = env.BURROW_AI_QUEUE_MAX !== undefined && env.BURROW_AI_QUEUE_MAX !== '' ? Number(env.BURROW_AI_QUEUE_MAX) : 8;
  return new AiQueue({
    concurrency: positiveInt(env.BURROW_AI_CONCURRENCY, 1),
    max: Number.isFinite(max) && max >= 0 ? Math.floor(max) : 8,
    timeoutMs: positiveInt(env.BURROW_AI_QUEUE_TIMEOUT_MS, 300_000),
  });
}
