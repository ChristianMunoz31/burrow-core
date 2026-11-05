import { describe, expect, it } from 'vitest';
import { formatCell, isLong, truncate, LONG_THRESHOLD } from '../dataFormat';

describe('formatCell', () => {
  it('renders null and undefined as a dash', () => {
    expect(formatCell(null, { name: 'x', type: 'text' })).toMatchObject({ kind: 'null', text: 'n/a' });
    expect(formatCell(undefined, { name: 'x', type: 'text' }).text).toBe('n/a');
  });

  it('formats a date-only value as a local date with no timezone shift', () => {
    const out = formatCell('2026-03-01', { name: 'date', type: 'date' });
    expect(out.text).toBe(new Date(2026, 2, 1).toLocaleDateString());
  });

  it('formats timestamps with toLocaleString and falls back on garbage', () => {
    const iso = '2026-03-01T15:30:00.000Z';
    expect(formatCell(iso, { name: 'created_at', type: 'timestamptz' }).text).toBe(new Date(iso).toLocaleString());
    expect(formatCell('nope', { name: 'created_at', type: 'timestamptz' }).text).toBe('nope');
  });

  it('formats the amount column as USD with tone', () => {
    const col = { name: 'amount', type: 'numeric' };
    expect(formatCell('-12.5', col, { amountColumn: 'amount' })).toMatchObject({ text: '-$12.50', tone: 'neg' });
    expect(formatCell(1234.5, col, { amountColumn: 'amount' })).toMatchObject({ text: '$1,234.50', tone: 'pos' });
    expect(formatCell(0, col, { amountColumn: 'amount' }).tone).toBeUndefined();
    expect(formatCell(5, col).text).toBe('5');
  });

  it('formats booleans as Yes/No', () => {
    const col = { name: 'done', type: 'boolean' };
    expect(formatCell(true, col).text).toBe('Yes');
    expect(formatCell(false, col).text).toBe('No');
  });

  it('shortens uuids to 8 chars with the full id as title', () => {
    const id = '123e4567-e89b-12d3-a456-426614174000';
    expect(formatCell(id, { name: 'id', type: 'uuid' })).toMatchObject({ text: '123e4567', title: id });
  });

  it('truncates strings only above the threshold', () => {
    const col = { name: 'body', type: 'text' };
    const exact = 'a'.repeat(LONG_THRESHOLD);
    expect(formatCell(exact, col).full).toBeUndefined();
    const long = 'a'.repeat(LONG_THRESHOLD + 1);
    const out = formatCell(long, col);
    expect(out.full).toBe(long);
    expect(out.text).toBe(`${'a'.repeat(LONG_THRESHOLD)}…`);
  });

  it('compacts json and offers a pretty full value when long', () => {
    const col = { name: 'value', type: 'jsonb' };
    expect(formatCell({ a: 1 }, col)).toMatchObject({ text: '{"a":1}', full: null });
    const big = { items: Array.from({ length: 40 }, (_, i) => i) };
    const out = formatCell(big, col);
    expect(out.text.endsWith('…')).toBe(true);
    expect(out.full).toBe(JSON.stringify(big, null, 2));
    expect(formatCell(['a', 'b'], { name: 'tags', type: 'text[]' }).text).toBe('["a","b"]');
  });

  it('flags the redacted marker', () => {
    expect(formatCell('[redacted]', { name: 'value', type: 'jsonb' })).toMatchObject({ kind: 'redacted' });
  });
});

describe('isLong / truncate', () => {
  it('handle non-strings and short strings', () => {
    expect(isLong(5)).toBe(false);
    expect(isLong('short')).toBe(false);
    expect(truncate('short')).toBe('short');
    expect(truncate(5)).toBe(5);
  });
});
