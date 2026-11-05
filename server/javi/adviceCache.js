// In-memory cache of finished insight-card answers (single-shot page advice on a local model).
//
// A card is re-asked on every panel open; the same page data under the same model gives the same
// card, so a hit replays the stored text and makes no model call. Never used for cloud answers
// (the caller checks), never persisted, and dropped on a whole-data reset. Entries expire after
// ADVICE_CACHE_TTL_MS, the least recently used one goes when ADVICE_CACHE_MAX is exceeded, and an
// entry written before the data generation changed is never served.
import { createHash } from 'node:crypto';
import { currentDataGeneration, onDataReset } from '../dataGeneration.js';

export const ADVICE_CACHE_TTL_MS = 10 * 60 * 1000;
export const ADVICE_CACHE_MAX = 50;

/** @type {Map<string, { content: string, groundingNote: string | null, expires: number, generation: number }>} */
const entries = new Map();

/** Forget every cached answer. */
export function clearAdviceCache() {
  entries.clear();
}

onDataReset(clearAdviceCache);

/**
 * Cache key: sha256 over everything the answer depends on.
 *
 * @param {{ model: string, kind: string, host?: string | null, page: string, context: string, promptVersion: string, displayName?: string | null, character?: string | null, hourBucket?: string | null }} parts
 *   `context` is the exact text sent to the model; `displayName` and `character` (the Javi character id) are in the system prompt;
 *   `hourBucket` is the local hour (HH) of the clock line the model saw, so a card never replays across an hour boundary.
 * @returns {string} Hex digest.
 */
export function adviceCacheKey({ model, kind, host, page, context, promptVersion, displayName, character, hourBucket }) {
  const h = createHash('sha256');
  for (const part of [model, kind, host ?? '', page, promptVersion, displayName ?? '', character ?? '', hourBucket ?? 'none', context]) {
    h.update(String(part ?? ''));
    h.update('\0');
  }
  return h.digest('hex');
}

/**
 * @param {string} key
 * @param {number} [now]
 * @returns {{ content: string, groundingNote: string | null } | null} The stored answer, or null.
 */
export function getCachedAdvice(key, now = Date.now()) {
  const hit = entries.get(key);
  if (!hit) return null;
  entries.delete(key);
  if (hit.expires <= now || hit.generation !== currentDataGeneration()) return null;
  entries.set(key, hit); // most recently used goes last
  return { content: hit.content, groundingNote: hit.groundingNote };
}

/**
 * @param {string} key
 * @param {{ content: string, groundingNote: string | null }} value
 * @param {number} generation The data generation captured before the model call started.
 * @param {number} [now]
 */
export function putCachedAdvice(key, value, generation, now = Date.now()) {
  if (generation !== currentDataGeneration()) return;
  entries.delete(key);
  entries.set(key, { content: value.content, groundingNote: value.groundingNote ?? null, expires: now + ADVICE_CACHE_TTL_MS, generation });
  while (entries.size > ADVICE_CACHE_MAX) entries.delete(entries.keys().next().value);
}
