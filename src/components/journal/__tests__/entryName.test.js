import { describe, expect, it } from 'vitest';
import { entryName } from '../entryName';

describe('entryName', () => {
  it('prefers the title', () => {
    expect(entryName({ title: 'Trip', date: '2026-10-01' })).toBe('Trip');
  });

  it('does not invent a time for a date-only value', () => {
    expect(entryName({ date: '2026-10-01' })).toBe('entry from earlier');
  });

  it('uses the local time for a full timestamp', () => {
    expect(entryName({ date: '2026-10-01T15:30:00' })).toMatch(/^entry from \d{1,2}:30\s?(AM|PM)$/);
  });
});
