// Pause, drain and resume for the scheduler's jobs, plus the in-flight tracking behind them. Kept apart from
// server/scheduler.js (which imports the Javi briefing) so that code that must stop jobs, such as a reset of
// the user's data, can do so without importing any Javi module. scheduler.js re-exports these.
import { currentOp, isGateClosed } from './backup/lock.js';

// Module level on purpose: a pause holds even when the scheduler was never started, and survives a stop
// and start.
/** @type {Set<{ promise: Promise<void>, controller: AbortController }>} */
const inFlightJobs = new Set();
let paused = false;

/** True while a restore or a whole-data reset holds the request gate or the op lock: no job may start or write. */
export const dataBusy = () => isGateClosed() || currentOp() === 'restore' || currentOp() === 'erase';

/** @returns {boolean} whether scheduled jobs are paused */
export const isPaused = () => paused;

/** Stops new scheduled jobs from starting (a job that is due is skipped; the next one is still armed). */
export function pauseScheduledJobs() {
  paused = true;
}

/** Lets scheduled jobs start again. */
export function resumeScheduledJobs() {
  paused = false;
}

/**
 * Runs a job unless paused or the data is busy, tracking it so a drain can abort and await it.
 * @param {(signal: AbortSignal) => Promise<unknown> | unknown} job
 * @param {(err: unknown) => void} onError
 * @returns {Promise<void>} resolves when the job (or the skip) is done; never rejects
 */
export async function runTracked(job, onError) {
  if (paused || dataBusy()) return;
  const controller = new AbortController();
  const entry = { controller, promise: Promise.resolve() };
  entry.promise = (async () => {
    try {
      await job(controller.signal);
    } catch (err) {
      onError(err);
    }
  })();
  inFlightJobs.add(entry);
  try {
    await entry.promise;
  } finally {
    inFlightJobs.delete(entry);
  }
}

/**
 * Aborts every job in flight and waits for it to settle.
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<boolean>} true when nothing is left running, false when the timeout passed first
 */
export async function drainScheduledJobs({ timeoutMs = 5000 } = {}) {
  const jobs = [...inFlightJobs];
  for (const job of jobs) job.controller.abort();
  if (jobs.length === 0) return true;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([Promise.allSettled(jobs.map((j) => j.promise)).then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** @returns {number} jobs running right now */
export const scheduledJobsInFlight = () => inFlightJobs.size;
