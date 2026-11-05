import { describe, it, expect } from 'vitest';
import { currentStreak, entriesByDay, moodHistogram, topMood, isoToday } from '../journalStats';

const TODAY = '2026-05-27';
const YESTERDAY = '2026-05-26';
const TWO_DAYS_AGO = '2026-05-25';

describe('isoToday', () => {
  it('formats YYYY-MM-DD', () => {
    expect(isoToday(new Date('2026-05-27T15:30:00'))).toBe('2026-05-27');
  });
});

describe('currentStreak', () => {
  it('returns 0 for empty entries', () => {
    expect(currentStreak([], TODAY)).toBe(0);
  });

  it('returns 1 when today has an entry', () => {
    expect(currentStreak([{ date: TODAY }], TODAY)).toBe(1);
  });

  it('counts consecutive days ending today', () => {
    const entries = [{ date: TODAY }, { date: YESTERDAY }, { date: TWO_DAYS_AGO }];
    expect(currentStreak(entries, TODAY)).toBe(3);
  });

  it('credits yesterday when today is empty', () => {
    const entries = [{ date: YESTERDAY }, { date: TWO_DAYS_AGO }];
    expect(currentStreak(entries, TODAY)).toBe(2);
  });

  it('returns 0 when neither today nor yesterday has an entry', () => {
    const entries = [{ date: TWO_DAYS_AGO }];
    expect(currentStreak(entries, TODAY)).toBe(0);
  });

  it('stops on first gap', () => {
    // today + two days ago, no yesterday → streak is 1 (only today)
    const entries = [{ date: TODAY }, { date: TWO_DAYS_AGO }];
    expect(currentStreak(entries, TODAY)).toBe(1);
  });

  it('handles datetime strings (takes date prefix)', () => {
    expect(currentStreak([{ date: `${TODAY}T15:30:00Z` }], TODAY)).toBe(1);
  });
});

describe('entriesByDay', () => {
  it('returns `days` slots in order', () => {
    const out = entriesByDay([], 7, TODAY);
    expect(out.length).toBe(7);
    expect(out[6].date).toBe(TODAY);
    expect(out[0].count).toBe(0);
  });

  it('counts entries by day', () => {
    const entries = [
      { date: TODAY },
      { date: TODAY },
      { date: YESTERDAY },
    ];
    const out = entriesByDay(entries, 3, TODAY);
    expect(out[2]).toEqual({ date: TODAY, count: 2 });
    expect(out[1]).toEqual({ date: YESTERDAY, count: 1 });
    expect(out[0]).toEqual({ date: TWO_DAYS_AGO, count: 0 });
  });

  it('ignores entries outside the window', () => {
    const old = '2025-01-01';
    const out = entriesByDay([{ date: old }, { date: TODAY }], 7, TODAY);
    const total = out.reduce((s, d) => s + d.count, 0);
    expect(total).toBe(1);
  });
});

describe('moodHistogram', () => {
  it('returns all 5 buckets with 0 for empty', () => {
    const out = moodHistogram([]);
    expect(out.length).toBe(5);
    expect(out.every((b) => b.count === 0)).toBe(true);
  });

  it('counts per mood', () => {
    const entries = [
      { mood: 'great' },
      { mood: 'great' },
      { mood: 'down' },
      { mood: null },
    ];
    const out = moodHistogram(entries);
    const map = Object.fromEntries(out.map((b) => [b.mood, b.count]));
    expect(map.great).toBe(2);
    expect(map.down).toBe(1);
    expect(map.good).toBe(0);
  });

  it('preserves canonical order', () => {
    const out = moodHistogram([{ mood: 'rough' }]);
    expect(out.map((b) => b.mood)).toEqual(['great', 'good', 'okay', 'down', 'rough']);
  });
});

describe('topMood', () => {
  it('returns null for empty', () => {
    expect(topMood([])).toBeNull();
  });

  it('returns the most common mood', () => {
    const entries = [{ mood: 'good' }, { mood: 'good' }, { mood: 'great' }];
    expect(topMood(entries)).toBe('good');
  });

  it('returns null if no entries have a mood', () => {
    expect(topMood([{ mood: null }, {}])).toBeNull();
  });
});
