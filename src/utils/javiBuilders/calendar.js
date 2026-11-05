import { clip, localDay } from '../javiContext';
import { relativeDay } from '../relativeDay';
import { statusContext } from './_status';

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// Date-only (all-day) strings are local dates; new Date('YYYY-MM-DD') would read UTC and
// shift the day for anyone west of Greenwich.
const parseMs = (v) => {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  const m = DATE_ONLY_RE.exec(s);
  const t = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : new Date(s).getTime();
  return Number.isNaN(t) ? null : t;
};

const startMs = (e) => parseMs(e?.start);

// A date-only end is exclusive (Google/ICS all-day events), so it must be after today's
// start; a timed end only has to be at or after it.
const endsInOrAfter = (e, ms) => {
  const end = parseMs(e?.end);
  if (end === null) return null;
  return DATE_ONLY_RE.test(String(e.end).trim()) ? end > ms : end >= ms;
};

/**
 * Titles and times only; never descriptions or locations. Includes events already in
 * progress (started earlier, end at or after the start of today).
 * @param {{ events?: Array<object>, loading?: boolean, error?: unknown, now?: Date }} input
 */
export function buildCalendarContext({ events, loading, error, now = new Date() } = {}) {
  const early = statusContext({ loading, error });
  if (early) return early;
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  const weekEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7).getTime();
  const upcoming = (Array.isArray(events) ? events : [])
    .filter((e) => {
      const t = startMs(e);
      if (t === null || t >= weekEnd) return false;
      if (t >= dayStart) return true;
      return endsInOrAfter(e, dayStart) === true;
    })
    .sort((a, b) => startMs(a) - startMs(b));
  const todayCount = upcoming.filter((e) => startMs(e) < dayEnd).length;
  const today = localDay(now);
  // Plain-words timing per event so the model never does date arithmetic.
  const when = (e) => {
    const t = startMs(e);
    if (t < dayStart) return `ongoing, started ${relativeDay(new Date(t), today)}`;
    return relativeDay(new Date(t), today);
  };
  return {
    'next 7 days': upcoming.slice(0, 20).map((e) => ({
      summary: clip(e.summary, 80),
      when: when(e),
      start: clip(e.start, 30),
      end: e.end ? clip(e.end, 30) : null,
      'all day': !!e.allDay,
    })),
    'events today': todayCount,
    'events in the next 7 days': upcoming.length,
  };
}
