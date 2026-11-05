// Friendly date, size and count text for the backups UI.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 24 * 60 * 60 * 1000;
const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const clock = (d) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;

/** A Date for a usable ISO value, or null for missing or invalid input (null must not become 1970). */
function parseDate(iso) {
  if (iso === null || iso === undefined || iso === '') return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "today 9:00", "yesterday 21:15", "Oct 1, 9:00" (year added for another year). Empty for bad input. */
export function formatBackupDate(iso, now = new Date()) {
  const date = parseDate(iso);
  if (!date) return '';
  // Compare calendar days (rounded) so a 23 or 25 hour day around a clock change still counts as one day.
  const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);
  if (days === 0) return `today ${clock(date)}`;
  if (days === 1) return `yesterday ${clock(date)}`;
  const year = date.getFullYear() === now.getFullYear() ? '' : ` ${date.getFullYear()}`;
  return `${MONTHS[date.getMonth()]} ${date.getDate()}${year}, ${clock(date)}`;
}

/** Whole 24-hour periods between the date and now (never negative). Null when the date is missing or invalid. */
export function daysAgo(iso, now = new Date()) {
  const date = parseDate(iso);
  if (!date) return null;
  return Math.max(0, Math.floor((now - date) / DAY_MS));
}

/** "4.2 MB", "310 KB", "512 bytes". Rounds up into the next unit instead of showing "1024 KB". */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < KB) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  const kb = Math.round(bytes / KB);
  if (kb < 1024) return `${kb} KB`;
  const mb = Number((bytes / MB).toFixed(1));
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(bytes / GB).toFixed(1)} GB`;
}

export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
