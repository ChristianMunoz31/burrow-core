import { describe, expect, it } from 'vitest';
import { formatEventWhen } from '../eventLabels';

// Fixed "now" (local) and local-constructed dates keep these timezone-robust.
const NOW = new Date(2026, 9, 2, 12, 0);
const d = (y, m, day, h = 0, min = 0) => new Date(y, m, day, h, min);
const iso = (date) => date.toISOString();
// ICU may emit narrow no-break spaces in times.
const norm = (r) => ({ date: r.date, time: r.time && r.time.replace(/\s/g, ' ') });

describe('formatEventWhen', () => {
  it('timed single-day shows start - end', () => {
    const r = formatEventWhen(
      { allDay: false, start: iso(d(2026, 9, 5, 10)), end: iso(d(2026, 9, 5, 11, 30)) },
      NOW,
    );
    expect(norm(r)).toEqual({ date: 'Mon, Oct 5', time: '10:00 AM to 11:30 AM' });
  });

  it('timed with no end shows only the start time', () => {
    expect(norm(formatEventWhen({ allDay: false, start: iso(d(2026, 9, 5, 14, 5)), end: null }, NOW))).toEqual({
      date: 'Mon, Oct 5',
      time: '2:05 PM',
    });
  });

  it('an end not after the start is ignored', () => {
    const s = iso(d(2026, 9, 5, 10));
    expect(norm(formatEventWhen({ allDay: false, start: s, end: s }, NOW)).time).toBe('10:00 AM');
  });

  it('all-day single day', () => {
    expect(formatEventWhen({ allDay: true, start: iso(d(2026, 9, 5)), end: null }, NOW)).toEqual({
      date: 'Mon, Oct 5',
      time: 'All day',
    });
  });

  it('all-day multi-day shows a range with an inclusive end', () => {
    expect(
      formatEventWhen({ allDay: true, start: iso(d(2026, 9, 5)), end: iso(d(2026, 9, 7, 15)) }, NOW),
    ).toEqual({ date: 'Mon, Oct 5 to Wed, Oct 7', time: 'All day' });
  });

  it('ICS exclusive midnight end is not shown as two days', () => {
    expect(
      formatEventWhen({ allDay: true, start: iso(d(2026, 9, 5)), end: iso(d(2026, 9, 6)) }, NOW),
    ).toEqual({ date: 'Mon, Oct 5', time: 'All day' });
  });

  it('ICS exclusive midnight end on a multi-day span shows the last real day', () => {
    expect(
      formatEventWhen({ allDay: true, start: iso(d(2026, 9, 5)), end: iso(d(2026, 9, 8)) }, NOW).date,
    ).toBe('Mon, Oct 5 to Wed, Oct 7');
  });

  it('timed multi-day has a combined date and null time', () => {
    const r = formatEventWhen(
      { allDay: false, start: iso(d(2026, 9, 5, 22)), end: iso(d(2026, 9, 6, 1)) },
      NOW,
    );
    expect(r.time).toBeNull();
    expect(norm(r).date).toBe('Mon, Oct 5, 10:00 PM to Tue, Oct 6, 1:00 AM');
  });

  it('shows the year only when it differs from now', () => {
    const other = formatEventWhen({ allDay: true, start: iso(d(2027, 0, 4)), end: null }, NOW);
    expect(other.date).toBe('Mon, Jan 4, 2027');
    expect(formatEventWhen({ allDay: true, start: iso(d(2026, 0, 5)), end: null }, NOW).date).toBe('Mon, Jan 5');
    // same year as now: no year
    expect(formatEventWhen({ allDay: true, start: iso(d(2026, 9, 5)), end: null }, NOW).date).not.toMatch(/2026/);
  });

  it('uses the year on both ends when the range crosses into another year', () => {
    const r = formatEventWhen(
      { allDay: true, start: iso(d(2026, 11, 30)), end: iso(d(2027, 0, 2, 9)) },
      NOW,
    );
    expect(r.date).toBe('Wed, Dec 30, 2026 to Sat, Jan 2, 2027');
  });
});
