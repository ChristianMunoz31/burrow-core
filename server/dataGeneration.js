// Data generation counter. A whole-database reset (see server/erase/) bumps it; any async writer that
// started earlier (a briefing, a Javi run) takes a snapshot first and drops its result when the snapshot
// no longer matches, so nothing derived from the old data is written after the reset.
// Neutral module: AI and agent code may import it, and it names no operation.
import { currentOp, isGateClosed } from './backup/lock.js';

let generation = 0;
/** @type {Set<() => void>} */
const resetHooks = new Set();

/** @returns {number} the current generation */
export const currentDataGeneration = () => generation;

/** Called by the reset. @returns {number} the new generation */
export function bumpDataGeneration() {
  generation += 1;
  return generation;
}

/**
 * Snapshot of the generation for one async job. `isStale()` is true once the data was reset since the
 * snapshot, or while a restore or reset holds the request gate or the op lock (nothing may be written then).
 * @returns {{ generation: number, isStale: () => boolean }}
 */
export function captureDataGeneration() {
  const taken = generation;
  return {
    generation: taken,
    isStale: () => taken !== generation || isGateClosed() || currentOp() === 'restore' || currentOp() === 'erase',
  };
}

/**
 * Registers a function that forgets in-memory state describing the old data (parked Javi writes, cached
 * data-browser totals). A module that holds such state registers it where it is defined, so the reset needs
 * no import of it (the Javi tool modules stay reachable only through their Pro-gated entry points).
 * @param {() => void} hook
 * @returns {() => void} unregister
 */
export function onDataReset(hook) {
  resetHooks.add(hook);
  return () => resetHooks.delete(hook);
}

/** Called by the reset after the commit. A failing hook never stops the others. */
export function runDataResetHooks() {
  for (const hook of resetHooks) {
    try {
      hook();
    } catch (e) {
      console.error('Data reset hook failed:', e?.code ?? e?.name ?? 'unknown');
    }
  }
}

/** Test hook. */
export function __resetDataGenerationForTests() {
  generation = 0;
}
