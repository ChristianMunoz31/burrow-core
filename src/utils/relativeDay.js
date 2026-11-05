// Plain-words relative dates for Javi context ("overdue by 3 days", "due tomorrow", "in 2 days").
// Small local models get day arithmetic wrong, so every relative phrase is computed here and
// the model only copies it. Mirrors server/relativeDay.js (kept identical by a parity test).

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_DAY = 86400000;
const pad = (n) => String(n).padStart(2, '0');

/**
 * Local YYYY-MM-DD for a Date.
 * @param {Date} [date]
 * @returns {string}
 */
export function localDayOf(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The local calendar day of a value: a date-only string is already a local day; a timestamp
 * is converted to the local day it falls on.
 * @param {unknown} value
 * @returns {string | null}
 */
export function toLocalDay(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : localDayOf(value);
  const s = String(value).trim();
  if (DAY_RE.test(s)) return s;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : localDayOf(d);
}

/**
 * Whole days from `today` to `value` (positive is the future).
 * @param {unknown} value Date-only string, timestamp or Date.
 * @param {string} today Local YYYY-MM-DD.
 * @returns {number | null}
 */
export function daysFromToday(value, today) {
  const a = DAY_RE.exec(toLocalDay(value) ?? '');
  const b = DAY_RE.exec(String(today ?? ''));
  if (!a || !b) return null;
  const ms = (m) => Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Math.round((ms(a) - ms(b)) / MS_DAY);
}

const days = (n) => `${n} day${n === 1 ? '' : 's'}`;

/**
 * Due-date status in plain words: "overdue by 3 days", "due today", "due tomorrow",
 * "due in 5 days". Null when there is no usable date.
 * @param {unknown} due
 * @param {string} today Local YYYY-MM-DD.
 * @returns {string | null}
 */
export function dueStatus(due, today) {
  const n = daysFromToday(due, today);
  if (n === null) return null;
  if (n < 0) return `overdue by ${days(-n)}`;
  if (n === 0) return 'due today';
  if (n === 1) return 'due tomorrow';
  return `due in ${days(n)}`;
}

/**
 * Relative day in plain words: "today", "tomorrow", "yesterday", "in 4 days", "6 days ago".
 * @param {unknown} value
 * @param {string} today Local YYYY-MM-DD.
 * @returns {string | null}
 */
export function relativeDay(value, today) {
  const n = daysFromToday(value, today);
  if (n === null) return null;
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return n > 0 ? `in ${days(n)}` : `${days(-n)} ago`;
}
