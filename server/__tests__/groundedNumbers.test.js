import { describe, it, expect } from 'vitest';
import { checkGroundedNumbers, extractNumbers } from '../javi/groundedNumbers.js';

describe('extractNumbers', () => {
  it('reads currency, percent and plain numbers in the usual formats', () => {
    expect(extractNumbers('Spent $1,234.50, up 12%, 12.0 percent, 1,234 items, 1234.5 total')).toEqual([
      { raw: '$1,234.50', value: 1234.5, kind: 'currency' },
      { raw: '12%', value: 12, kind: 'percent' },
      { raw: '12.0 percent', value: 12, kind: 'percent' },
      { raw: '1,234', value: 1234, kind: 'number' },
      { raw: '1234.5', value: 1234.5, kind: 'number' },
    ]);
  });

  it('uses absolute values and tolerates non-strings', () => {
    expect(extractNumbers('-$5.00 and -3')).toEqual([
      { raw: '$5.00', value: 5, kind: 'currency' },
      { raw: '3', value: 3, kind: 'number' },
    ]);
    expect(extractNumbers(null)).toEqual([]);
  });
});

describe('checkGroundedNumbers', () => {
  const facts = '{"dining":{"over":102,"spent":1234.5,"pct":35},"open":12,"net":-48.25,"today":"2026-10-09"}';

  it('accepts figures that appear in the facts, in any display format', () => {
    const out = checkGroundedNumbers('Dining is over by $102.00, spent $1,234.50, 35% of budget, 12 open, owe $48.25.', facts);
    expect(out.ungrounded).toEqual([]);
    expect(out.grounded).toEqual(['$102.00', '$1,234.50', '35%', '12', '$48.25']);
  });

  it('accepts a figure rounded to the precision it displays', () => {
    expect(checkGroundedNumbers('About $1,235 spent.', facts).ungrounded).toEqual([]);
  });

  it('flags invented and computed figures', () => {
    const out = checkGroundedNumbers('Groceries is over by $58.50, about $9.10 a day, $63,222,050.50 in 7 years, 41%.', facts);
    expect(out.ungrounded).toEqual(['$58.50', '$9.10', '$63,222,050.50', '41%']);
  });

  it('ignores list markers, small integers, years, dates, times and ordinals by default', () => {
    const answer = '1. First, 3-5 bullets by 5:30 pm on Oct 12 or 2026-10-12, in 2025, the 3rd of 8 items at 14:05.';
    expect(checkGroundedNumbers(answer, '').ungrounded).toEqual([]);
  });

  it('keeps money and percents that are small, and honours the options', () => {
    expect(checkGroundedNumbers('Only $7 and 5% left.', '').ungrounded).toEqual(['$7', '5%']);
    expect(checkGroundedNumbers('You have 7 left.', '', { ignoreSmallIntegers: 0 }).ungrounded).toEqual(['7']);
    expect(checkGroundedNumbers('Back in 2025.', '', { ignoreYears: false }).ungrounded).toEqual(['2025']);
    expect(checkGroundedNumbers('Due 10/12.', '', { ignoreDates: false, ignoreSmallIntegers: 0 }).ungrounded).toEqual(['10', '12']);
  });

  it('treats an empty answer or empty facts without throwing', () => {
    expect(checkGroundedNumbers('', facts)).toEqual({ ungrounded: [], grounded: [] });
    expect(checkGroundedNumbers(undefined, undefined)).toEqual({ ungrounded: [], grounded: [] });
  });
});
