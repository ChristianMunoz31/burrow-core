import { describe, it, expect } from 'vitest';
import { budgetMonths, latestDataMonth, selectMonth } from '../budgetPlan';

const NOW = new Date('2026-10-15T12:00:00');
const MONTHS = budgetMonths(['2026-01', '2026-03'], NOW); // 2026-01 .. 2027-10

describe('selectMonth preferred argument', () => {
  it('uses preferred instead of the current month when it is in range', () => {
    expect(selectMonth(MONTHS, '', NOW, '2026-03')).toBe('2026-03');
  });

  it('a valid picked month beats preferred', () => {
    expect(selectMonth(MONTHS, '2026-05', NOW, '2026-03')).toBe('2026-05');
  });

  it('ignores preferred when it is out of range and falls back to current', () => {
    expect(selectMonth(MONTHS, '', NOW, '1999-01')).toBe('2026-10');
  });

  it('ignores an empty preferred', () => {
    expect(selectMonth(MONTHS, '', NOW, '')).toBe('2026-10');
  });

  it('falls back to the first month when neither preferred nor current is listed', () => {
    expect(selectMonth(['2020-01', '2020-02'], '', NOW, '2030-01')).toBe('2020-01');
  });

  it('ignores an invalid picked month and honors preferred', () => {
    expect(selectMonth(MONTHS, '1999-01', NOW, '2026-03')).toBe('2026-03');
  });

  it('returns empty string for an empty list', () => {
    expect(selectMonth([], '', NOW, '2026-03')).toBe('');
  });
});

describe('latestDataMonth', () => {
  it('returns the greatest data month inside the range', () => {
    expect(latestDataMonth(['2026-01', '2026-03', '2026-02'], MONTHS)).toBe('2026-03');
  });

  it('skips data months outside the month list', () => {
    expect(latestDataMonth(['2026-03', '2031-01'], MONTHS)).toBe('2026-03');
  });

  it('ignores malformed entries', () => {
    expect(latestDataMonth(['garbage', '2026-13', 42, null, '2026-02'], MONTHS)).toBe('2026-02');
  });

  it('returns empty string with no data months', () => {
    expect(latestDataMonth([], MONTHS)).toBe('');
  });

  it('returns empty string for non-array inputs', () => {
    expect(latestDataMonth(undefined, MONTHS)).toBe('');
    expect(latestDataMonth(['2026-01'], undefined)).toBe('');
  });

  it('is independent of input order', () => {
    expect(latestDataMonth(['2026-03', '2026-01'], MONTHS)).toBe('2026-03');
    expect(latestDataMonth(['2026-01', '2026-03'], MONTHS)).toBe('2026-03');
  });
});
