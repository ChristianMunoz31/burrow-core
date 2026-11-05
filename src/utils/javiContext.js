import { JAVI_CONTEXT_MAX_CHARS } from '../constants/javiPages';
import { redactForJavi } from './javiRedact';

export const TRUNCATION_MARKER = '…[truncated]';

const CLOCK_TAIL_RE = /,"localTime":"\d{2}:\d{2}"\}$/;

const pad = (n) => String(n).padStart(2, '0');

/**
 * Serializes page data into the compact, redacted, size-capped context string.
 * @param {{ pageKey: string, data: unknown, now?: Date, maxChars?: number }} input
 * @returns {{ context: string, truncated: boolean }}
 */
export function serializeJaviContext({
  pageKey,
  data,
  now = new Date(),
  maxChars = JAVI_CONTEXT_MAX_CHARS,
}) {
  const payload = {
    page: pageKey,
    today: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    data: redactForJavi(data ?? { note: 'No page data registered' }),
    localTime: `${pad(now.getHours())}:${pad(now.getMinutes())}`, // last: it changes every minute, the data prefix stays stable
  };
  const s = JSON.stringify(payload);
  if (s.length <= maxChars) return { context: s, truncated: false };
  // The clock is the last member: cut inside the data and keep it, so a long page still tells the model the time.
  const tail = CLOCK_TAIL_RE.exec(s)?.[0] ?? '';
  const keep = Math.max(0, maxChars - TRUNCATION_MARKER.length - tail.length);
  return {
    context: s.slice(0, Math.min(keep, s.length - tail.length)) + TRUNCATION_MARKER + tail,
    truncated: true,
  };
}

/**
 * Trims a value to at most n characters, ending in an ellipsis when cut.
 * @param {unknown} str
 * @param {number} n
 * @returns {string}
 */
export function clip(str, n) {
  const s = String(str ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s;
}

/**
 * @param {unknown} n
 * @returns {number | null}
 */
export function round2(n) {
  const v = typeof n === 'number' ? n : Number(n);
  return n !== null && n !== '' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}

/** Local YYYY-MM-DD for a Date. */
export function localDay(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
