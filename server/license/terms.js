// Store dates and license terms (docs/LICENSING.md section 4.5). Pure.
import { DAY_MS, UPDATE_DAYS, YEARLY_EDITIONS, inDateRange } from './constants.js';

const STORE_DATE_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Parses a store timestamp: YYYY-MM-DDTHH:MM:SS, optional 1 to 9 fraction digits, then Z or a numeric offset.
 * The result is floored to the whole second and must be inside the supported date range.
 * @param {unknown} value
 * @returns {number | null} epoch ms, or null
 */
export function parseStoreDate(value) {
  if (typeof value !== 'string') return null;
  const m = STORE_DATE_RE.exec(value);
  if (!m) return null;
  const base = Date.parse(`${m[1]}Z`);
  if (!Number.isFinite(base) || new Date(base).toISOString().slice(0, 19) !== m[1]) return null;
  let ms = base;
  if (m[2] !== 'Z') {
    const hours = Number(m[2].slice(1, 3));
    const minutes = Number(m[2].slice(4, 6));
    if (hours > 23 || minutes > 59) return null;
    ms -= (m[2][0] === '-' ? -1 : 1) * (hours * 60 + minutes) * 60_000;
  }
  return inDateRange(ms) ? ms : null;
}

/**
 * @param {{ edition: string, purchaseDateMs: number, storeExpiresAtMs?: number | null }} input
 * @returns {{ updatesUntilMs: number, expiresAtMs: number | null }}
 */
export function computeTerms({ edition, purchaseDateMs, storeExpiresAtMs = null }) {
  if (YEARLY_EDITIONS.includes(edition)) {
    const yearEnd = purchaseDateMs + UPDATE_DAYS[edition] * DAY_MS;
    const expiresAtMs = storeExpiresAtMs === null ? yearEnd : Math.min(yearEnd, storeExpiresAtMs);
    return { updatesUntilMs: expiresAtMs, expiresAtMs };
  }
  return { updatesUntilMs: purchaseDateMs + UPDATE_DAYS[edition] * DAY_MS, expiresAtMs: null };
}
