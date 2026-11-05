// When to quietly mention that a cloud AI is an option: only when AI is on and working
// locally, the computer is small or slow, and the hint has not been shown in the last 14
// days. It is a suggestion only; nothing is turned on and nothing is sent.
import os from 'node:os';
import { isAiEnabled } from './gate.js';
import { getCloudHintState } from './consent.js';
import { localSlowSignal } from './localPerf.js';
import { recommendModels } from './recommend.js';

export const CLOUD_HINT_INTERVAL_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export const NO_CLOUD_HINT = Object.freeze({ show: false, reason: null });

/**
 * @param {{ ai?: { kind?: string } | null, available: boolean, totalmem?: () => number, now?: () => number | Date,
 *   state?: { lastShownAt: string | null } }} opts `state` is injected by tests; production reads it.
 * @returns {Promise<{ show: boolean, reason: 'slow' | 'low_memory' | null }>}
 */
export async function getCloudHint({ ai, available, totalmem = () => os.totalmem(), now = Date.now, state } = {}) {
  if (!isAiEnabled() || !available || ai?.kind === 'cloud') return { ...NO_CLOUD_HINT };
  let reason = null;
  if (localSlowSignal()) reason = 'slow';
  else if (recommendModels(totalmem()).tier === 'tiny') reason = 'low_memory';
  if (!reason) return { ...NO_CLOUD_HINT };
  const { lastShownAt } = state ?? (await getCloudHintState());
  if (lastShownAt) {
    const at = Date.parse(lastShownAt);
    const t = now instanceof Date ? now.getTime() : Number(typeof now === 'function' ? now() : now);
    if (Number.isFinite(at) && t - at < CLOUD_HINT_INTERVAL_DAYS * DAY_MS) return { ...NO_CLOUD_HINT };
  }
  return { show: true, reason };
}
