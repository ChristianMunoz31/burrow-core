import { describe, it, expect } from 'vitest';
import { daysFromToday, dueStatus, localDayOf, relativeDay, toLocalDay } from '../relativeDay';

const TODAY = '2026-10-04';

describe('dueStatus', () => {
  it.each([
    ['2026-10-01', 'overdue by 3 days'],
    ['2026-10-03', 'overdue by 1 day'],
    ['2026-10-04', 'due today'],
    ['2026-10-05', 'due tomorrow'],
    ['2026-10-06', 'due in 2 days'],
    ['2026-11-03', 'due in 30 days'],
  ])('%s -> %s', (due, expected) => {
    expect(dueStatus(due, TODAY)).toBe(expected);
  });

  it('returns null for missing or malformed dates', () => {
    expect(dueStatus(null, TODAY)).toBeNull();
    expect(dueStatus('', TODAY)).toBeNull();
    expect(dueStatus('not a date', TODAY)).toBeNull();
    expect(dueStatus('2026-10-01', 'bad')).toBeNull();
  });
});

describe('relativeDay', () => {
  it.each([
    ['2026-10-04', 'today'],
    ['2026-10-05', 'tomorrow'],
    ['2026-10-03', 'yesterday'],
    ['2026-10-08', 'in 4 days'],
    ['2026-09-28', '6 days ago'],
  ])('%s -> %s', (day, expected) => {
    expect(relativeDay(day, TODAY)).toBe(expected);
  });

  it('crosses month and year boundaries and DST without drift', () => {
    expect(daysFromToday('2027-01-01', '2026-12-31')).toBe(1);
    expect(daysFromToday('2026-03-09', '2026-03-07')).toBe(2);
    expect(daysFromToday('2026-11-02', '2026-10-31')).toBe(2);
    expect(relativeDay('2026-02-28', '2026-03-01')).toBe('yesterday');
  });
});

describe('toLocalDay', () => {
  it('keeps date-only strings as local days and converts timestamps to the local day', () => {
    expect(toLocalDay('2026-10-04')).toBe('2026-10-04');
    const late = new Date(2026, 9, 4, 23, 30);
    expect(toLocalDay(late)).toBe('2026-10-04');
    expect(toLocalDay(late.toISOString())).toBe('2026-10-04');
    expect(localDayOf(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(toLocalDay(new Date('nope'))).toBeNull();
    expect(toLocalDay(undefined)).toBeNull();
  });
});
