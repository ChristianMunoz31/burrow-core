// In-process scheduler (no dependencies) for the daily jobs:
//  - daily briefing build at BRIEFING_HOUR_LOCAL, only when AI is enabled and a model
//    is available (a lazy, cached probe of the configured Ollama host);
//  - audit-log prune shortly after startup and then once a day;
//  - Folders re-scan (private module, local AI only) every few hours for folders with the daily re-scan switch on.
// The briefing and the re-scan are provided by the private module (registerProScheduledJob); without the module
// a job is skipped silently.
// All timers are unref'd so they never keep the process alive.
// The user's automatic backups switch does not affect these jobs (it only gates the backup
// scheduler in server/backup/service.js).
import { pruneAudit } from './audit.js';
import { describeAi, isAiEnabled } from './ai/index.js';
import {
  dataBusy,
  drainScheduledJobs,
  isPaused,
  pauseScheduledJobs,
  resumeScheduledJobs,
  runTracked,
  scheduledJobsInFlight,
} from './scheduledJobGate.js';

// Pause, drain and resume live in scheduledJobGate.js (no Javi imports, so the data reset can use them);
// they are part of this module's API too.
export { drainScheduledJobs, pauseScheduledJobs, resumeScheduledJobs, scheduledJobsInFlight };

export const BRIEFING_HOUR_LOCAL = 7;
export const PRUNE_STARTUP_DELAY_MS = 30_000;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const FOLDER_RESCAN_STARTUP_DELAY_MS = 10 * 60_000;
export const FOLDER_RESCAN_INTERVAL_MS = 6 * 60 * 60_000;

/**
 * Milliseconds from `now` until the next occurrence of `hour`:00 local time.
 * @param {number} hour 0-23
 * @param {Date} [now]
 * @returns {number}
 */
export function msUntilNextHour(hour, now = new Date()) {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

/** Default AI check: AI on, and the chat model resolves (Ollama reachable, a model installed). */
async function defaultAiConfigured() {
  if (!isAiEnabled()) return false;
  return (await describeAi('chat')).available;
}

let active = null; // { timers: Set<Timeout> } while running

// Jobs the private module registers through server/proExtensions.js (ctx.scheduler.register).
const PRO_JOB_NAMES = new Set(['briefing', 'folderRescan']);
/** @type {{ briefing?: Function, folderRescan?: Function }} */
let proJobs = {};

/**
 * Registers a Pro scheduled job. Called only by server/proExtensions.js and tests.
 * @param {'briefing' | 'folderRescan'} name
 * @param {(opts: { trigger?: string, signal: AbortSignal }) => Promise<unknown>} job
 */
export function registerProScheduledJob(name, job) {
  if (!PRO_JOB_NAMES.has(name)) throw new Error(`Unknown scheduled job: ${String(name)}`);
  if (typeof job !== 'function') throw new Error('A scheduled job must be a function');
  proJobs = { ...proJobs, [name]: job };
}

/** Forgets every registered Pro job. For tests and the install rollback. */
export function resetProScheduledJobsForTests() {
  proJobs = {};
}

/**
 * Start the scheduler. A second call while running is a no-op.
 * @param {{
 *   briefing?: (opts: { trigger: string, signal: AbortSignal }) => Promise<unknown>,
 *   prune?: () => Promise<unknown>,
 *   folderRescan?: (opts: { signal: AbortSignal }) => Promise<unknown>,
 *   aiConfigured?: () => boolean | Promise<boolean>,
 *   now?: () => Date,
 *   briefingHour?: number,
 *   pruneDelayMs?: number,
 *   folderDelayMs?: number,
 * }} [opts] overrides exist for tests
 * @returns {boolean} true when this call started it
 */
export function startScheduler({
  briefing = undefined,
  prune = pruneAudit,
  folderRescan = undefined,
  aiConfigured = defaultAiConfigured,
  now = () => new Date(),
  briefingHour = BRIEFING_HOUR_LOCAL,
  pruneDelayMs = PRUNE_STARTUP_DELAY_MS,
  folderDelayMs = FOLDER_RESCAN_STARTUP_DELAY_MS,
} = {}) {
  if (active) return false;
  const state = { timers: new Set() };
  active = state;

  const arm = (delayMs, job, rearm) => {
    const timer = setTimeout(async () => {
      state.timers.delete(timer);
      // Paused, or a restore or reset holds the data: runTracked skips this run, the next one is still armed.
      await runTracked(job, (err) => {
        console.error('Scheduled job failed:', err?.code || err?.name || 'unknown');
      });
      if (active === state) rearm();
    }, Math.max(delayMs, 0));
    timer.unref?.();
    state.timers.add(timer);
  };

  const briefingJob = async (signal) => {
    if (!(await aiConfigured())) return;
    // The data may have been reset while the AI check was awaited.
    if (signal?.aborted || isPaused() || dataBusy()) return;
    const run = briefing ?? proJobs.briefing;
    if (!run) return;
    await run({ trigger: 'scheduled', signal });
  };
  const scheduleBriefing = () => arm(msUntilNextHour(briefingHour, now()), briefingJob, scheduleBriefing);
  const pruneJob = async () => {
    if (isPaused() || dataBusy()) return;
    await prune();
  };
  const schedulePrune = () => arm(DAY_MS, pruneJob, schedulePrune);

  // The module keeps its own local-only checks; core checks the pause and data-busy skip.
  const folderJob = async (signal) => {
    if (isPaused() || dataBusy()) return;
    const run = folderRescan ?? proJobs.folderRescan;
    if (!run) return;
    await run({ signal });
  };
  const scheduleFolders = () => arm(FOLDER_RESCAN_INTERVAL_MS, folderJob, scheduleFolders);

  scheduleBriefing();
  arm(pruneDelayMs, pruneJob, schedulePrune);
  arm(folderDelayMs, folderJob, scheduleFolders);
  return true;
}

/** Stop all timers. Safe to call when not running. */
export function stopScheduler() {
  if (!active) return;
  for (const timer of active.timers) clearTimeout(timer);
  active.timers.clear();
  active = null;
}

/** @returns {boolean} whether the scheduler is running */
export const isSchedulerRunning = () => active !== null;
