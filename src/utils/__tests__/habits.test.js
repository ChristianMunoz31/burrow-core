import { describe, it, expect } from 'vitest';
import { currentStreak, buildGrid, isoToday } from '../habits';

const TODAY = '2026-05-27';

describe('isoToday', () => {
  it('returns a YYYY-MM-DD string', () => {
    const value = isoToday();
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('currentStreak', () => {
  it('returns 0 for empty completions', () => {
    expect(currentStreak([], TODAY)).toBe(0);
  });

  it('returns 0 for null/undefined input', () => {
    expect(currentStreak(null, TODAY)).toBe(0);
    expect(currentStreak(undefined, TODAY)).toBe(0);
  });

  it('returns 1 when only today is done', () => {
    expect(currentStreak([TODAY], TODAY)).toBe(1);
  });

  it('counts a 5-day streak ending today', () => {
    const completions = [
      '2026-05-23',
      '2026-05-24',
      '2026-05-25',
      '2026-05-26',
      '2026-05-27',
    ];
    expect(currentStreak(completions, TODAY)).toBe(5);
  });

  it('stops counting at a gap in the middle', () => {
    // Today + yesterday done, day before missing, two earlier days done.
    const completions = ['2026-05-23', '2026-05-24', '2026-05-26', '2026-05-27'];
    expect(currentStreak(completions, TODAY)).toBe(2);
  });

  it('still counts streak when today is not done but yesterday is', () => {
    const completions = ['2026-05-24', '2026-05-25', '2026-05-26'];
    expect(currentStreak(completions, TODAY)).toBe(3);
  });

  it('returns 0 if neither today nor yesterday is done', () => {
    const completions = ['2026-05-20', '2026-05-21'];
    expect(currentStreak(completions, TODAY)).toBe(0);
  });
});

describe('buildGrid', () => {
  it('returns the requested number of days', () => {
    expect(buildGrid([], 30, TODAY)).toHaveLength(30);
    expect(buildGrid([], 7, TODAY)).toHaveLength(7);
  });

  it('returns days in oldest -> newest order ending on today', () => {
    const grid = buildGrid([], 30, TODAY);
    expect(grid[grid.length - 1].date).toBe(TODAY);
    // Oldest date should be 29 days before today.
    expect(grid[0].date).toBe('2026-04-28');
  });

  it('flags done correctly for matching dates', () => {
    const completions = ['2026-05-27', '2026-05-20', '2026-04-30'];
    const grid = buildGrid(completions, 30, TODAY);
    const byDate = Object.fromEntries(grid.map((g) => [g.date, g.done]));
    expect(byDate['2026-05-27']).toBe(true);
    expect(byDate['2026-05-20']).toBe(true);
    expect(byDate['2026-04-30']).toBe(true);
    expect(byDate['2026-05-26']).toBe(false);
    expect(byDate['2026-05-15']).toBe(false);
  });

  it('treats missing completions as not done', () => {
    const grid = buildGrid([], 30, TODAY);
    expect(grid.every((cell) => cell.done === false)).toBe(true);
  });
});
