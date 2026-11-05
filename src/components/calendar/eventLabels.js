const TIME_FMT = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
const LABEL_DATE_FMT = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});

export const formatEventDate = (date) => LABEL_DATE_FMT.format(date);

/** Clock time such as `10:00 AM`. Accepts a Date, ISO string, or timestamp. */
export const formatTime = (value) => TIME_FMT.format(new Date(value));

export const timeText = (e) => (e.allDay ? 'All day' : formatTime(e.start));

/** Short time for narrow chips: `9a`, `2:30p`; empty for all-day (no room in a phone cell). */
export function compactTimeText(e) {
  if (e.allDay) return '';
  const d = new Date(e.start);
  const h = d.getHours();
  const m = d.getMinutes();
  const suffix = h < 12 ? 'a' : 'p';
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''}${suffix}`;
}

const RANGE_DAY_FMT = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const RANGE_DAY_YEAR_FMT = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

const sameDay = (a, b) => a.toDateString() === b.toDateString();

/**
 * Human-readable `{ date, time }` for the details view.
 * - all-day: date `Mon, Oct 5` (or `Mon, Oct 5 – Wed, Oct 7`), time `All day`
 * - timed, one day: date `Mon, Oct 5`, time `10:00 AM – 11:00 AM` (start only without an end)
 * - timed, multi-day: date `Mon, Oct 5, 10:00 PM – Tue, Oct 6, 1:00 AM`, time `null`
 * An all-day end at local midnight is treated as exclusive (ICS DTEND convention).
 * The year is shown only when it differs from `now`'s year.
 */
export function formatEventWhen(e, now = new Date()) {
  const start = new Date(e.start);
  let end = e.end ? new Date(e.end) : null;
  if (end && !(end > start)) end = null;
  if (end && e.allDay && end.getHours() === 0 && end.getMinutes() === 0 && end.getSeconds() === 0) {
    end = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 1);
  }
  const year = now.getFullYear();
  const fmt = (d) =>
    (start.getFullYear() !== year || (end && end.getFullYear() !== year)
      ? RANGE_DAY_YEAR_FMT
      : RANGE_DAY_FMT
    ).format(d);

  if (e.allDay) {
    const multi = end && !sameDay(start, end) && end > start;
    return { date: multi ? `${fmt(start)} to ${fmt(end)}` : fmt(start), time: 'All day' };
  }
  if (!end) return { date: fmt(start), time: formatTime(start) };
  if (sameDay(start, end)) {
    return { date: fmt(start), time: `${formatTime(start)} to ${formatTime(end)}` };
  }
  return {
    date: `${fmt(start)}, ${formatTime(start)} to ${fmt(end)}, ${formatTime(end)}`,
    time: null,
  };
}

/**
 * `Open event: {title}, {time or All day}, {date}`. Optimistic (not yet saved)
 * events read `Saving event: ...` instead.
 */
export function eventAriaLabel(e, readOnly = false) {
  return `${readOnly ? 'Saving' : 'Open'} event: ${e.summary}, ${timeText(e)}, ${formatEventDate(new Date(e.start))}`;
}
