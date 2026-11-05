import { clip, localDay } from '../javiContext';
import { daysFromToday, relativeDay } from '../relativeDay';
import { statusContext } from './_status';

/**
 * Each upcoming countdown carries a plain-words `when` ("tomorrow", "in 12 days") so the
 * model never computes it from the date.
 * @param {{ countdowns?: Array<{title:string,targetDate:string}>, loading?: boolean,
 *   error?: unknown, now?: Date }} input
 */
export function buildCountdownsContext({ countdowns, loading, error, now = new Date() } = {}) {
  const early = statusContext({ loading, error });
  if (early) return early;
  const today = localDay(now);
  const rows = [];
  let past = 0;
  for (const c of Array.isArray(countdowns) ? countdowns : []) {
    const target = String(c?.targetDate ?? '').slice(0, 10);
    const days = daysFromToday(target, today);
    if (days === null) continue;
    if (days < 0) past += 1;
    else rows.push({ days, row: { title: clip(c.title, 80), date: target, when: relativeDay(target, today) } });
  }
  rows.sort((a, b) => a.days - b.days);
  return { 'upcoming count': rows.length, upcoming: rows.slice(0, 10).map((r) => r.row), past };
}
