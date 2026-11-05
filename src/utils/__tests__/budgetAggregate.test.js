import { describe, it, expect } from 'vitest';
import { formatCurrencyCompact, trendSeries } from '../budgetAggregate';

describe('formatCurrencyCompact', () => {
  it('formats zero without decimals', () => {
    expect(formatCurrencyCompact(0)).toBe('$0');
  });

  it('formats negative values', () => {
    expect(formatCurrencyCompact(-1500)).toBe('-$1.5K');
  });

  it('keeps sub-thousand values whole', () => {
    expect(formatCurrencyCompact(999)).toBe('$999');
  });

  it('abbreviates thousands', () => {
    expect(formatCurrencyCompact(1500)).toBe('$1.5K');
  });

  it('abbreviates millions', () => {
    expect(formatCurrencyCompact(1200000)).toBe('$1.2M');
  });

  it('treats NaN as zero', () => {
    expect(formatCurrencyCompact(NaN)).toBe('$0');
  });
});

describe('trendSeries chronological order', () => {
  it('sorts months oldest to newest, including across a year boundary', () => {
    const shuffled = [
      { month: '2026-02', income: '10', expense: 5 },
      { month: '2025-12', income: 20, expense: 7 },
      { month: '2026-10', income: 30, expense: 9 },
      { month: '2026-01', income: 40, expense: 11 },
      { month: '2025-09', income: 50, expense: 13 },
    ];
    const out = trendSeries(shuffled);
    expect(out.map((r) => r.month)).toEqual(['2025-09', '2025-12', '2026-01', '2026-02', '2026-10']);
    expect(out[3]).toEqual({ month: '2026-02', income: 10, expense: 5 });
    expect(shuffled[0].month).toBe('2026-02');
  });
});
