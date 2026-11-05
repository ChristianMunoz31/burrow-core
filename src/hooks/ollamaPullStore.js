import { aiSettingsService } from '../services/aiSettingsService';

// Module-level store for the model download, so it outlives any component that shows it:
// leaving Settings does not cancel a running pull. Only cancel() aborts it.
// status: idle | pulling | done | error | cancelled. `syncing` is true while a finished
// download waits for the caller to refresh the setup state; `syncFailed` marks a failed refresh.

const IDLE = Object.freeze({
  status: 'idle',
  model: null,
  phase: null,
  completed: 0,
  total: 0,
  error: null,
  syncing: false,
  syncFailed: false,
});

/** The server may still hold the lock for a moment after a client cancel. */
export const RESTART_WINDOW_MS = 2000;
export const RESTART_RETRY_DELAY_MS = 600;

let state = IDLE;
let controller = null;
let lastCancelAt = -Infinity;
const listeners = new Set();

function set(next) {
  state = next;
  listeners.forEach((fn) => fn());
}

export const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export const getSnapshot = () => state;

function applyProgress(prev, p) {
  const phase = p?.phase ?? prev.phase;
  let completed = Number.isFinite(p?.completed) ? p.completed : prev.completed;
  let total = Number.isFinite(p?.total) ? p.total : prev.total;
  // Within the downloading phase the percent never goes backwards: ignore a regressing update.
  if (prev.phase === 'downloading' && phase === 'downloading' && prev.total > 0 && total > 0) {
    if (completed / total < prev.completed / prev.total) {
      completed = prev.completed;
      total = prev.total;
    }
  }
  return { ...prev, phase, completed, total };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(ctl, model, onFinished, retried) {
  try {
    await aiSettingsService.pull(model, {
      signal: ctl.signal,
      onProgress: (p) => {
        if (controller !== ctl) return;
        set(applyProgress(state, p));
      },
    });
  } catch (err) {
    if (controller !== ctl) return;
    if (
      err?.code === 'pull_in_progress' &&
      !retried &&
      Date.now() - lastCancelAt < RESTART_WINDOW_MS
    ) {
      await wait(RESTART_RETRY_DELAY_MS);
      if (controller !== ctl) return;
      await run(ctl, model, onFinished, true);
      return;
    }
    controller = null;
    if (err?.name === 'AbortError') set({ ...state, status: 'cancelled' });
    else set({ ...state, status: 'error', error: err });
    return;
  }
  if (controller !== ctl) return;
  controller = null;
  set({ ...state, status: 'done', syncing: true });
  let syncFailed = false;
  try {
    await onFinished?.();
  } catch {
    syncFailed = true;
  }
  if (state.status === 'done' && state.model === model) {
    set({ ...state, syncing: false, syncFailed });
  }
}

/** Start a download. A second call while one runs (or while a finished one syncs) is a no-op. */
export function startPull(model, { onFinished } = {}) {
  if (controller || state.syncing) return;
  const ctl = new AbortController();
  controller = ctl;
  set({ ...IDLE, status: 'pulling', model, phase: 'manifest' });
  void run(ctl, model, onFinished, false);
}

/** Abort the running download (Ollama keeps the partial data). */
export function cancelPull() {
  const ctl = controller;
  if (!ctl) return;
  controller = null;
  lastCancelAt = Date.now();
  ctl.abort();
  set({ ...state, status: 'cancelled' });
}

/** Clear a finished, failed or cancelled download. Never touches a running or syncing one. */
export function resetPull() {
  if (controller || state.syncing || state === IDLE) return;
  set(IDLE);
}

/** Test hook: abort anything running and return to idle. */
export function __resetPullStoreForTests() {
  controller?.abort();
  controller = null;
  lastCancelAt = -Infinity;
  state = IDLE;
  listeners.forEach((fn) => fn());
}
