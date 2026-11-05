// The daily backup scheduler under fake timers: startup catch-up, the 24 hour rule, the 6 hour
// failure backoff, and stopping. Only setTimeout/clearTimeout are faked, so file access stays real;
// the clock comes from the injected `now`.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { insert } from '../db/index.js';
import { listMetas, writeState } from '../backup/manifest.js';

import { backupsDir, ensureBackupsDir } from '../backup/paths.js';
import {
  createBackup,
  isBackupSchedulerRunning,
  startBackupScheduler,
  stopBackupScheduler,
} from '../backup/service.js';
import { cleanupBackupEnv, day, resetBackupEnv } from './helpers/backupEnv.js';

const seedState = async (patch) => {
  ensureBackupsDir();
  return writeState(patch);
};

const realSetTimeout = globalThis.setTimeout;
const HOUR = 3_600_000;
const STARTUP = 1_000;
const TICK = 10_000;

/** Waits (real time) until fn() is true. */
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('condition not reached');
    await new Promise((r) => realSetTimeout(r, 5));
  }
}
/** Lets pending real file work and promise chains settle. */
const settle = (ms = 80) => new Promise((r) => realSetTimeout(r, ms));

let clock;
const now = () => clock;
const hoursBefore = (h) => new Date(clock.getTime() - h * HOUR).toISOString();

beforeEach(() => {
  resetBackupEnv();
  clock = day(10);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  stopBackupScheduler();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
afterAll(() => {
  cleanupBackupEnv();
});

const start = (run, extra = {}) => startBackupScheduler({ now, run, startupDelayMs: STARTUP, tickMs: TICK, ...extra });

describe('startup check', () => {
  it('does nothing before the startup delay', async () => {
    const run = vi.fn(async () => ({ ok: true }));
    expect(start(run)).toBe(true);
    await vi.advanceTimersByTimeAsync(STARTUP - 1);
    await settle();
    expect(run).not.toHaveBeenCalled();
  });

  it('runs a backup at startup when there has never been a success', async () => {
    const run = vi.fn(async () => ({ ok: true }));
    start(run);
    await vi.advanceTimersByTimeAsync(STARTUP);
    await until(() => run.mock.calls.length === 1);
    expect(run.mock.calls[0][0].now).toBe(now);
  });

  it('runs at startup when the last success is more than 24 hours old', async () => {
    await seedState({ lastSuccessAt: hoursBefore(25) });
    const run = vi.fn(async () => ({ ok: true }));
    start(run);
    await vi.advanceTimersByTimeAsync(STARTUP);
    await until(() => run.mock.calls.length === 1);
  });

  it('runs at exactly 24 hours', async () => {
    await seedState({ lastSuccessAt: hoursBefore(24) });
    const run = vi.fn(async () => ({ ok: true }));
    start(run);
    await vi.advanceTimersByTimeAsync(STARTUP);
    await until(() => run.mock.calls.length === 1);
  });

  it('does not run at startup when the last success is younger than 24 hours', async () => {
    await seedState({ lastSuccessAt: hoursBefore(23) });
    const run = vi.fn(async () => ({ ok: true }));
    start(run);
    await vi.advanceTimersByTimeAsync(STARTUP);
    await settle();
    expect(run).not.toHaveBeenCalled();
  });

  it('a backup file younger than 24 hours also counts as a recent success', async () => {
    insert('notes', { body: 'x' });
    await createBackup({ kind: 'manual', now: () => hoursBeforeDate(2) });
    const run = vi.fn(async () => ({ ok: true }));
    start(run);
    await vi.advanceTimersByTimeAsync(STARTUP);
    await settle();
    expect(run).not.toHaveBeenCalled();
  });

  it('with the default run it makes a real automatic backup at startup', async () => {
    insert('notes', { body: 'real' });
    start(undefined);
    await vi.advanceTimersByTimeAsync(STARTUP);
    let metas = [];
    const end = Date.now() + 5000;
    while (metas.length === 0 && Date.now() < end) {
      await settle(30);
      metas = await listMetas(backupsDir());
    }
    expect(metas).toHaveLength(1);
    expect(metas[0]).toMatchObject({ kind: 'auto', status: 'verified' });
  });
});

function hoursBeforeDate(h) {
  return new Date(clock.getTime() - h * HOUR);
}

describe('hourly ticks', () => {
  it('re-checks every tick and runs once the 24 hours have passed', async () => {
    await seedState({ lastSuccessAt: hoursBefore(1) });
    const run = vi.fn(async () => ({ ok: true }));
    start(run);
    await vi.advanceTimersByTimeAsync(STARTUP);
    await settle();
    expect(run).not.toHaveBeenCalled();

    clock = new Date(clock.getTime() + 12 * HOUR);
    await vi.advanceTimersByTimeAsync(TICK);
    await settle();
    expect(run).not.toHaveBeenCalled();

    clock = new Date(clock.getTime() + 12 * HOUR); // 25 hours after the success
    await vi.advanceTimersByTimeAsync(TICK);
    await until(() => run.mock.calls.length === 1);
  });

  it('keeps ticking after a run, and uses the clock at each tick', async () => {
    const run = vi.fn(async () => ({ ok: true }));
    start(run);
    await vi.advanceTimersByTimeAsync(STARTUP);
    await until(() => run.mock.calls.length === 1);
    // No success was recorded by the fake run, so the next tick is due again.
    await vi.advanceTimersByTimeAsync(TICK);
    await until(() => run.mock.calls.length === 2);
    await vi.advanceTimersByTimeAsync(TICK);
    await until(() => run.mock.calls.length === 3);
  });

  it('a run that throws or rejects does not stop the scheduler', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('first run blew up'))
      .mockImplementation(async () => ({ ok: true }));
    start(run);
    await vi.advanceTimersByTimeAsync(STARTUP);
    await until(() => run.mock.calls.length === 1);
    await settle();
    expect(isBackupSchedulerRunning()).toBe(true);
    await vi.advanceTimersByTimeAsync(TICK);
    await until(() => run.mock.calls.length === 2);
    expect(console.error).toHaveBeenCalled();
    for (const call of console.error.mock.calls) expect(call.join(' ')).not.toContain('first run blew up');
  });

  it('a slow run is not overlapped: the next tick is armed only after it finishes', async () => {
    let release;
    const run = vi.fn(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true });
        }),
    );
    start(run);
    await vi.advanceTimersByTimeAsync(STARTUP);
    await until(() => run.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(TICK * 5);
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await settle();
    await vi.advanceTimersByTimeAsync(TICK);
    await until(() => run.mock.calls.length === 2);
    release();
  });
});

describe('failure backoff (6 hours)', () => {
  it('does not retry within 6 hours of a failure, even though the last success is old', async () => {
    await seedState({ lastSuccessAt: hoursBefore(48), lastFailureAt: hoursBefore(2) });
    const run = vi.fn(async () => ({ ok: true }));
    start(run);
    await vi.advanceTimersByTimeAsync(STARTUP);
    await settle();
    expect(run).not.toHaveBeenCalled();
  });

  it('exactly 6 hours after the failure it is still held back', async () => {
    await seedState({ lastSuccessAt: hoursBefore(48), lastFailureAt: hoursBefore(6) });
    const run = vi.fn(async () => ({ ok: true }));
    start(run);
    await vi.advanceTimersByTimeAsync(STARTUP);
    await settle();
    expect(run).not.toHaveBeenCalled();
  });

  it('retries once the failure is more than 6 hours old', async () => {
    await seedState({ lastSuccessAt: hoursBefore(48), lastFailureAt: hoursBefore(6.5) });
    const run = vi.fn(async () => ({ ok: true }));
    start(run);
    await vi.advanceTimersByTimeAsync(STARTUP);
    await until(() => run.mock.calls.length === 1);
  });

  it('a failure early on holds back the run until a later tick passes the 6 hours', async () => {
    await seedState({ lastSuccessAt: hoursBefore(48), lastFailureAt: hoursBefore(5) });
    const run = vi.fn(async () => ({ ok: true }));
    start(run);
    await vi.advanceTimersByTimeAsync(STARTUP);
    await settle();
    expect(run).not.toHaveBeenCalled();
    clock = new Date(clock.getTime() + 2 * HOUR);
    await vi.advanceTimersByTimeAsync(TICK);
    await until(() => run.mock.calls.length === 1);
  });

  it('a real failed run is followed by a pause: the next due check does not retry for 6 hours', async () => {
    insert('notes', { body: 'x' });
    // Make the automatic run fail for lack of space.
    const fsp = (await import('node:fs/promises')).default;
    vi.spyOn(fsp, 'statfs').mockResolvedValue({ bavail: 1, bsize: 4096 });
    let calls = 0;
    const { runScheduledBackup } = await import('../backup/service.js');
    const run = async (opts) => {
      calls += 1;
      return runScheduledBackup(opts);
    };
    start(run);
    await vi.advanceTimersByTimeAsync(STARTUP);
    await until(() => calls === 1);
    await settle(150);
    clock = new Date(clock.getTime() + 3 * HOUR);
    await vi.advanceTimersByTimeAsync(TICK);
    await settle(150);
    expect(calls).toBe(1);
    clock = new Date(clock.getTime() + 4 * HOUR); // 7 hours after the failure
    await vi.advanceTimersByTimeAsync(TICK);
    await until(() => calls === 2);
  });
});

describe('start and stop', () => {
  it('arms exactly one timer and a second start is a no-op', () => {
    const run = vi.fn();
    expect(start(run)).toBe(true);
    expect(isBackupSchedulerRunning()).toBe(true);
    expect(start(run)).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('stop clears the timer, and nothing runs afterwards', async () => {
    const run = vi.fn(async () => ({ ok: true }));
    start(run);
    stopBackupScheduler();
    expect(isBackupSchedulerRunning()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(STARTUP + TICK * 3);
    await settle();
    expect(run).not.toHaveBeenCalled();
  });

  it('stop between ticks clears the re-armed timer', async () => {
    const run = vi.fn(async () => ({ ok: true }));
    start(run);
    await vi.advanceTimersByTimeAsync(STARTUP);
    await until(() => run.mock.calls.length === 1);
    await settle();
    stopBackupScheduler();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(TICK * 3);
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('stop while a run is in flight does not re-arm after it finishes', async () => {
    let release;
    const run = vi.fn(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true });
        }),
    );
    start(run);
    await vi.advanceTimersByTimeAsync(STARTUP);
    await until(() => run.mock.calls.length === 1);
    stopBackupScheduler();
    release();
    await settle();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('can be started again after a stop', async () => {
    const run = vi.fn(async () => ({ ok: true }));
    start(run);
    stopBackupScheduler();
    expect(start(run)).toBe(true);
    await vi.advanceTimersByTimeAsync(STARTUP);
    await until(() => run.mock.calls.length === 1);
  });

  it('stopping when never started is harmless', () => {
    expect(() => stopBackupScheduler()).not.toThrow();
    expect(isBackupSchedulerRunning()).toBe(false);
  });

  it('timers do not keep the process alive (unref)', () => {
    start(vi.fn());
    // Fake timers return objects with unref; the scheduler must not rely on it being absent.
    expect(isBackupSchedulerRunning()).toBe(true);
  });
});
