import { describe, expect, it } from 'vitest';
import { daysAgo, formatBackupDate, formatBytes, plural } from '../backupFormat';

// Local-time constructors keep these tests independent of the machine's time zone.
const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min, 0, 0);

describe('formatBackupDate', () => {
  const now = at(2026, 10, 5, 15, 30);

  it('says today, with a 24-hour clock and padded minutes', () => {
    expect(formatBackupDate(at(2026, 10, 5, 9, 5).toISOString(), now)).toBe('today 9:05');
  });

  it('says yesterday', () => {
    expect(formatBackupDate(at(2026, 10, 4, 21, 15).toISOString(), now)).toBe('yesterday 21:15');
  });

  it('uses the month and day for older dates in the same year', () => {
    expect(formatBackupDate(at(2026, 10, 1, 9).toISOString(), now)).toBe('Oct 1, 9:00');
  });

  it('adds the year for another year', () => {
    expect(formatBackupDate(at(2025, 12, 31, 23, 59).toISOString(), now)).toBe('Dec 31 2025, 23:59');
  });

  it('treats just after midnight as the new day and just before as the old one', () => {
    const justAfter = at(2026, 10, 5, 0, 1);
    const justBefore = at(2026, 10, 4, 23, 59);
    expect(formatBackupDate(justAfter.toISOString(), at(2026, 10, 5, 0, 2))).toBe('today 0:01');
    expect(formatBackupDate(justBefore.toISOString(), at(2026, 10, 5, 0, 2))).toBe('yesterday 23:59');
  });

  it('keeps calendar-day wording across a clock change (23 and 25 hour days)', () => {
    // US spring forward 2026-03-08 (23 hour day) and fall back 2026-11-01 (25 hour day).
    expect(formatBackupDate(at(2026, 3, 8, 8).toISOString(), at(2026, 3, 9, 8))).toBe('yesterday 8:00');
    expect(formatBackupDate(at(2026, 3, 8, 0, 30).toISOString(), at(2026, 3, 8, 23, 30))).toBe('today 0:30');
    expect(formatBackupDate(at(2026, 11, 1, 8).toISOString(), at(2026, 11, 2, 8))).toBe('yesterday 8:00');
    expect(formatBackupDate(at(2026, 11, 1, 0, 30).toISOString(), at(2026, 11, 1, 23, 30))).toBe('today 0:30');
  });

  it('returns an empty string for missing or invalid input', () => {
    expect(formatBackupDate(null, now)).toBe('');
    expect(formatBackupDate(undefined, now)).toBe('');
    expect(formatBackupDate('', now)).toBe('');
    expect(formatBackupDate('not a date', now)).toBe('');
  });
});

describe('daysAgo', () => {
  const now = at(2026, 10, 5, 12);

  it('counts whole 24-hour periods', () => {
    expect(daysAgo(at(2026, 10, 5, 11).toISOString(), now)).toBe(0);
    expect(daysAgo(at(2026, 10, 4, 12).toISOString(), now)).toBe(1);
    expect(daysAgo(at(2026, 10, 1, 11).toISOString(), now)).toBe(4);
  });

  it('never goes negative for a future date', () => {
    expect(daysAgo(at(2026, 10, 9).toISOString(), now)).toBe(0);
  });

  it('returns null, not about 20000 days, when the date is missing or invalid', () => {
    expect(daysAgo(null, now)).toBeNull();
    expect(daysAgo(undefined, now)).toBeNull();
    expect(daysAgo('', now)).toBeNull();
    expect(daysAgo('garbage', now)).toBeNull();
  });
});

describe('formatBytes', () => {
  it('handles bytes', () => {
    expect(formatBytes(0)).toBe('0 bytes');
    expect(formatBytes(1)).toBe('1 byte');
    expect(formatBytes(1023)).toBe('1023 bytes');
  });

  it('rounds kilobytes to whole numbers', () => {
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('2 KB');
    expect(formatBytes(1_047_000)).toBe('1022 KB');
  });

  it('rolls over to MB instead of showing 1024 KB', () => {
    expect(formatBytes(1_048_575)).toBe('1.0 MB');
    expect(formatBytes(1_048_576)).toBe('1.0 MB');
    expect(formatBytes(4_400_000)).toBe('4.2 MB');
  });

  it('rolls over to GB instead of showing 1024.0 MB', () => {
    expect(formatBytes(1_073_741_823)).toBe('1.0 GB');
    expect(formatBytes(1_073_741_824)).toBe('1.0 GB');
    expect(formatBytes(1_610_612_736)).toBe('1.5 GB');
  });

  it('returns an empty string for bad input', () => {
    expect(formatBytes(-1)).toBe('');
    expect(formatBytes(NaN)).toBe('');
    expect(formatBytes(Infinity)).toBe('');
    expect(formatBytes(undefined)).toBe('');
    expect(formatBytes(null)).toBe('');
  });
});

describe('plural', () => {
  it('picks the singular only for exactly one', () => {
    expect(plural(1, 'day', 'days')).toBe('1 day');
    expect(plural(0, 'day', 'days')).toBe('0 days');
    expect(plural(2, 'day', 'days')).toBe('2 days');
  });
});
