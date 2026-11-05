// In-process scheduler: daily briefing only when AI is configured, audit prune at startup and
// daily, clean start/stop, and no timers that keep the process alive.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Pro is on for this file (the Pro gate itself is covered in proGating.test.js).

vi.mock('../../loadEnv.js', () => ({}));

import {
  BRIEFING_HOUR_LOCAL,
  DAY_MS,
  drainScheduledJobs,
  isSchedulerRunning,
  msUntilNextHour,
  pauseScheduledJobs,
  resumeScheduledJobs,
  scheduledJobsInFlight,
  startScheduler,
  stopScheduler,
} from '../scheduler.js';
import { __resetLockForTests, closeGate, openGate, tryAcquire } from '../backup/lock.js';

const HOUR = 60 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 5, 1, 12, 0, 0)); // local noon
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  stopScheduler();
  resumeScheduledJobs();
  __resetLockForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const deps = (over = {}) => ({
  briefing: vi.fn(async () => ({})),
  prune: vi.fn(async () => ({ ok: true })),
  aiConfigured: vi.fn(() => true),
  pruneDelayMs: 1000,
  ...over,
});

describe('msUntilNextHour', () => {
  it('rolls to the next day when the hour has passed', () => {
    expect(msUntilNextHour(7, new Date(2026, 5, 1, 12, 0, 0))).toBe(19 * HOUR);
  });
  it('is later today when the hour is still ahead', () => {
    expect(msUntilNextHour(7, new Date(2026, 5, 1, 6, 0, 0))).toBe(HOUR);
  });
  it('treats exactly the hour as passed', () => {
    expect(msUntilNextHour(7, new Date(2026, 5, 1, 7, 0, 0))).toBe(DAY_MS);
  });
});

describe('start/stop', () => {
  it('starts once, reports running, and stops cleanly', () => {
    expect(isSchedulerRunning()).toBe(false);
    expect(startScheduler(deps())).toBe(true);
    expect(isSchedulerRunning()).toBe(true);
    expect(startScheduler(deps())).toBe(false);
    stopScheduler();
    expect(isSchedulerRunning()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    stopScheduler(); // safe when already stopped
  });

  it('runs nothing after stop', async () => {
    const d = deps();
    startScheduler(d);
    stopScheduler();
    await vi.advanceTimersByTimeAsync(3 * DAY_MS);
    expect(d.prune).not.toHaveBeenCalled();
    expect(d.briefing).not.toHaveBeenCalled();
  });
});

describe('audit prune', () => {
  it('runs shortly after startup and then once a day', async () => {
    const d = deps();
    startScheduler(d);
    expect(d.prune).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(d.prune).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(d.prune).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(d.prune).toHaveBeenCalledTimes(3);
  });

  it('keeps running after a prune failure', async () => {
    const d = deps({ prune: vi.fn(async () => { throw new Error('boom'); }) });
    startScheduler(d);
    await vi.advanceTimersByTimeAsync(1000 + DAY_MS);
    expect(d.prune).toHaveBeenCalledTimes(2);
  });
});

describe('daily briefing', () => {
  it('builds the briefing at the local briefing hour with trigger scheduled', async () => {
    const d = deps();
    startScheduler(d);
    await vi.advanceTimersByTimeAsync(msUntilNextHour(BRIEFING_HOUR_LOCAL, new Date()) - 1);
    expect(d.briefing).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(d.briefing).toHaveBeenCalledTimes(1);
    expect(d.briefing).toHaveBeenCalledWith({ trigger: 'scheduled', signal: expect.any(AbortSignal) });
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(d.briefing).toHaveBeenCalledTimes(2);
  });

  it('makes no briefing (and no AI or network call) when AI is not configured', async () => {
    const d = deps({ aiConfigured: vi.fn(() => false) });
    startScheduler(d);
    await vi.advanceTimersByTimeAsync(3 * DAY_MS);
    expect(d.aiConfigured).toHaveBeenCalled();
    expect(d.briefing).not.toHaveBeenCalled();
    expect(d.prune).toHaveBeenCalled();
  });

  it('survives a failing briefing and schedules the next one', async () => {
    const d = deps({ briefing: vi.fn(async () => { throw new Error('llm down'); }) });
    startScheduler(d);
    await vi.advanceTimersByTimeAsync(2 * DAY_MS);
    expect(d.briefing.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(isSchedulerRunning()).toBe(true);
  });
});

describe('pause, drain and resume', () => {
  const untilBriefing = () => msUntilNextHour(BRIEFING_HOUR_LOCAL, new Date());

  it('a paused scheduler skips a due job, keeps its timers, and runs the next one after resume', async () => {
    const d = deps();
    startScheduler(d);
    pauseScheduledJobs();
    await vi.advanceTimersByTimeAsync(untilBriefing() + 1);
    expect(d.briefing).not.toHaveBeenCalled();
    expect(d.prune).not.toHaveBeenCalled();
    expect(isSchedulerRunning()).toBe(true);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    resumeScheduledJobs();
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(d.briefing).toHaveBeenCalledTimes(1);
    expect(d.prune).toHaveBeenCalled();
  });

  it('skips jobs while the request gate or a restore holds the data, and runs them again after', async () => {
    const d = deps();
    startScheduler(d);
    closeGate('erase');
    await vi.advanceTimersByTimeAsync(untilBriefing() + 1);
    expect(d.briefing).not.toHaveBeenCalled();
    openGate();
    const release = tryAcquire('restore');
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(d.briefing).not.toHaveBeenCalled();
    release();
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(d.briefing).toHaveBeenCalledTimes(1);
  });

  it('drain aborts a job in flight, waits for it, and the job does not start its write', async () => {
    let seen;
    const wrote = vi.fn();
    const d = deps({
      briefing: vi.fn(
        ({ signal }) =>
          new Promise((resolve) => {
            seen = signal;
            signal.addEventListener('abort', () => resolve(), { once: true });
            // would write here when it finishes normally
          }).then(() => {
            if (!signal.aborted) wrote();
          }),
      ),
    });
    startScheduler(d);
    await vi.advanceTimersByTimeAsync(untilBriefing());
    expect(scheduledJobsInFlight()).toBe(1);
    pauseScheduledJobs();
    expect(await drainScheduledJobs({ timeoutMs: 1000 })).toBe(true);
    expect(seen.aborted).toBe(true);
    expect(scheduledJobsInFlight()).toBe(0);
    expect(wrote).not.toHaveBeenCalled();
  });

  it('drain with nothing running is true at once', async () => {
    expect(await drainScheduledJobs({ timeoutMs: 10 })).toBe(true);
  });

  it('drain gives up after the timeout (last: that job never settles) for a job that ignores the abort, and reports false', async () => {
    const d = deps({ briefing: vi.fn(() => new Promise(() => {})) });
    startScheduler(d);
    await vi.advanceTimersByTimeAsync(untilBriefing());
    const drained = drainScheduledJobs({ timeoutMs: 200 });
    await vi.advanceTimersByTimeAsync(200);
    expect(await drained).toBe(false);
  });
});
