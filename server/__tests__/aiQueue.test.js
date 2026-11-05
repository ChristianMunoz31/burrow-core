// FIFO semaphore for model calls (server/ai/queue.js).
import { describe, expect, it } from 'vitest';
import { AiQueue, createQueueFromEnv } from '../ai/queue.js';
import { AiBusyError } from '../ai/gate.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('AiQueue', () => {
  it('grants slots in FIFO order with concurrency 1', async () => {
    const q = new AiQueue({ concurrency: 1, max: 5 });
    const order = [];
    const release1 = await q.acquire();
    const p2 = q.acquire().then((rel) => {
      order.push(2);
      return rel;
    });
    const p3 = q.acquire().then((rel) => {
      order.push(3);
      return rel;
    });
    await tick();
    expect(order).toEqual([]);
    expect(q.size).toBe(2);
    release1();
    const release2 = await p2;
    await tick();
    expect(order).toEqual([2]);
    release2();
    (await p3)();
    expect(order).toEqual([2, 3]);
    expect(q.active).toBe(0);
  });

  it('release is idempotent', async () => {
    const q = new AiQueue({ concurrency: 1 });
    const release = await q.acquire();
    release();
    release();
    expect(q.active).toBe(0);
  });

  it('refuses with AiBusyError when more than max callers wait', async () => {
    const q = new AiQueue({ concurrency: 1, max: 1 });
    await q.acquire();
    const waiting = q.acquire();
    await expect(q.acquire()).rejects.toBeInstanceOf(AiBusyError);
    expect(q.size).toBe(1);
    waiting.catch(() => {});
  });

  it('an aborted waiter leaves the queue and the next one moves up', async () => {
    const q = new AiQueue({ concurrency: 1, max: 5 });
    const release = await q.acquire();
    const ac = new AbortController();
    const aborted = q.acquire({ signal: ac.signal });
    const next = q.acquire();
    ac.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    expect(q.size).toBe(1);
    release();
    const r = await next;
    expect(typeof r).toBe('function');
  });

  it('rejects at once for a pre-aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(new AiQueue().acquire({ signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('a waiter past the queue timeout gets AiBusyError and is removed', async () => {
    const q = new AiQueue({ concurrency: 1, max: 5, timeoutMs: 20 });
    await q.acquire();
    await expect(q.acquire()).rejects.toBeInstanceOf(AiBusyError);
    expect(q.size).toBe(0);
  });

  it('honors concurrency above 1', async () => {
    const q = new AiQueue({ concurrency: 2, max: 0 });
    await q.acquire();
    await q.acquire();
    await expect(q.acquire()).rejects.toBeInstanceOf(AiBusyError);
  });

  it('reads its limits from env with safe defaults', () => {
    const q = createQueueFromEnv({ BURROW_AI_CONCURRENCY: '2', BURROW_AI_QUEUE_MAX: '3', BURROW_AI_QUEUE_TIMEOUT_MS: '1000' });
    expect([q.concurrency, q.max, q.timeoutMs]).toEqual([2, 3, 1000]);
    const d = createQueueFromEnv({ BURROW_AI_CONCURRENCY: 'x', BURROW_AI_QUEUE_MAX: '-1' });
    expect([d.concurrency, d.max, d.timeoutMs]).toEqual([1, 8, 300000]);
  });
});
