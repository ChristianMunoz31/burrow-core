// A small in-memory window of how local model calls went, so Javi can suggest cloud AI
// only when this computer really is slow. Nothing is stored or sent anywhere.
//   slow = at least 2 timeouts among the last 10 local calls, or a median time to first
//          token above 60 s over the last 5 calls (needs at least 3 timing samples).

export const WINDOW_CALLS = 10;
export const MEDIAN_WINDOW = 5;
export const MIN_SAMPLES = 3;
export const SLOW_TIMEOUTS = 2;
export const SLOW_FIRST_TOKEN_MS = 60_000;

/** @type {Array<{ firstTokenMs: number | null, timedOut: boolean }>} */
let calls = [];

/**
 * @param {{ firstTokenMs?: number | null, timedOut?: boolean }} sample
 */
export function recordLocalCall({ firstTokenMs = null, timedOut = false } = {}) {
  const ms = Number.isFinite(firstTokenMs) && firstTokenMs >= 0 ? firstTokenMs : null;
  calls.push({ firstTokenMs: ms, timedOut: timedOut === true });
  if (calls.length > WINDOW_CALLS) calls = calls.slice(-WINDOW_CALLS);
}

/** @returns {boolean} Whether recent local calls look slow. */
export function localSlowSignal() {
  if (calls.filter((c) => c.timedOut).length >= SLOW_TIMEOUTS) return true;
  const samples = calls
    .slice(-MEDIAN_WINDOW)
    .map((c) => c.firstTokenMs)
    .filter((v) => v !== null);
  if (samples.length < MIN_SAMPLES) return false;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return median > SLOW_FIRST_TOKEN_MS;
}

/** Test hook. */
export function __resetLocalPerfForTests() {
  calls = [];
}
