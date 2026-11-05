// Retention planning (pure). Verified automatic and manual backups follow a daily / weekly / monthly
// scheme (newest backup of each period represents it); the newest verified backup is always kept;
// safety copies are pinned outside the scheme; failed attempts are only kept briefly.
const DAY_MS = 24 * 60 * 60 * 1000;
const SAFETY_KEEP_NEWEST = 3;
const SAFETY_KEEP_DAYS = 30;
const FAILED_KEEP_NEWEST = 5;
const FAILED_KEEP_DAYS = 30;

const pad = (n) => String(n).padStart(2, '0');

/** Local-time calendar day, YYYY-MM-DD. @param {Date} d */
export const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Local-time calendar month, YYYY-MM. @param {Date} d */
export const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

/**
 * ISO-8601 week key (YYYY-Www) in local time, using the Thursday rule for the week-year.
 * @param {Date} d
 */
export function isoWeekKey(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${t.getUTCFullYear()}-W${pad(week)}`;
}

const FUTURE_SLACK_MS = DAY_MS;
const time = (m) => new Date(m.createdAt).getTime();
const newestFirst = (a, b) => time(b) - time(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** First (newest) backup of each of the first `count` distinct, non-empty buckets. */
function representatives(candidates, keyOf, count) {
  if (count <= 0) return [];
  const seen = new Map();
  for (const meta of candidates) {
    const key = keyOf(new Date(meta.createdAt));
    if (!seen.has(key)) seen.set(key, meta);
    if (seen.size >= count) break;
  }
  return [...seen.values()];
}

/**
 * @param {Array<{ id: string, kind: string, status: string, createdAt: string }>} metas
 * @param {{ keepDaily: number, keepWeekly: number, keepMonthly: number }} settings
 * @param {Date} [now]
 * @param {{ protectIds?: Iterable<string> }} [opts] ids that are never removed (the backup just made).
 *   A backup dated more than a day after `now` (clock set wrong) does not represent a bucket and is
 *   never newer than a real one when picking the newest verified backup, but it is never removed.
 * @returns {{ keep: object[], remove: object[] }}
 */
export function planRetention(metas, settings, now = new Date(), { protectIds = [] } = {}) {
  const nowMs = now.getTime();
  const isFuture = (m) => time(m) > nowMs + FUTURE_SLACK_MS;
  const sorted = [...metas].filter((m) => Number.isFinite(time(m))).sort(newestFirst);
  const keepIds = new Set(protectIds);

  const verified = [...sorted.filter((m) => m.status === 'verified' && !isFuture(m)), ...sorted.filter((m) => m.status === 'verified' && isFuture(m))];
  const candidates = verified.filter((m) => !isFuture(m) && (m.kind === 'auto' || m.kind === 'manual'));
  for (const m of representatives(candidates, dayKey, settings.keepDaily)) keepIds.add(m.id);
  for (const m of representatives(candidates, isoWeekKey, settings.keepWeekly)) keepIds.add(m.id);
  for (const m of representatives(candidates, monthKey, settings.keepMonthly)) keepIds.add(m.id);

  if (verified.length > 0) keepIds.add(verified[0].id);
  // A wrong clock must never delete history: future-dated backups stay (they only skip period selection).
  for (const m of verified) if (isFuture(m)) keepIds.add(m.id);

  verified
    .filter((m) => m.kind === 'safety')
    .forEach((m, i) => {
      if (i < SAFETY_KEEP_NEWEST || nowMs - time(m) < SAFETY_KEEP_DAYS * DAY_MS) keepIds.add(m.id);
    });

  sorted
    .filter((m) => m.status !== 'verified')
    .forEach((m, i) => {
      if (i < FAILED_KEEP_NEWEST && nowMs - time(m) < FAILED_KEEP_DAYS * DAY_MS) keepIds.add(m.id);
    });

  return {
    keep: sorted.filter((m) => keepIds.has(m.id)),
    remove: sorted.filter((m) => !keepIds.has(m.id)),
  };
}
