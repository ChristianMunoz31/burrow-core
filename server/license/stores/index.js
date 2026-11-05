// The store registry (docs/LICENSING.md section 3): ordered adapters and key-format detection.
import { MAX_KEY_INPUT_CHARS } from '../constants.js';
import { gumroad } from './gumroad.js';
import { lemonSqueezy } from './lemonSqueezy.js';

/** Gumroad first: it is the default in the UI. */
export const STORES = Object.freeze([gumroad, lemonSqueezy]);

/**
 * @param {unknown} id
 * @returns {typeof gumroad | typeof lemonSqueezy | null}
 */
export function getStore(id) {
  return STORES.find((s) => s.id === id) ?? null;
}

/**
 * The one store whose key format matches (the two formats cannot both match). Each adapter normalizes with its own rule.
 * @param {unknown} rawKey
 * @returns {'gumroad' | 'lemonsqueezy' | null}
 */
export function detectStore(rawKey) {
  if (typeof rawKey !== 'string' || rawKey.length > MAX_KEY_INPUT_CHARS) return null;
  return STORES.find((s) => s.matchesKey(s.normalizeKey(rawKey)))?.id ?? null;
}
