import { describe, it, expect } from 'vitest';
import { parseAmount } from '../csv';

describe('parseAmount', () => {
  it('parses plain numbers', () => {
    expect(parseAmount('25.50')).toBe(25.5);
    expect(parseAmount('-25.50')).toBe(-25.5);
  });

  it('strips currency symbols and thousands separators', () => {
    expect(parseAmount('$1,234.56')).toBe(1234.56);
    expect(parseAmount('1,234.56')).toBe(1234.56);
  });

  it('treats parentheses as negative', () => {
    expect(parseAmount('(45.00)')).toBe(-45);
    expect(parseAmount('($1,000.00)')).toBe(-1000);
  });

  it('honors trailing CR/DR markers', () => {
    expect(parseAmount('12.34 DR')).toBe(-12.34);
    expect(parseAmount('12.34 CR')).toBe(12.34);
  });

  it('returns NaN for empty / non-numeric input', () => {
    expect(parseAmount('')).toBeNaN();
    expect(parseAmount(null)).toBeNaN();
    expect(parseAmount('   ')).toBeNaN();
    expect(parseAmount('abc')).toBeNaN();
  });
});
