import { describe, it, expect } from 'vitest';
import { evaluate, formatDecimal, CALC_MAX_LENGTH, AMOUNT_MAX_LENGTH } from '../calc';
import calcSrc from '../calc.js?raw';
import evalAmountSrc from '../evalAmount.js?raw';

const EN = { locale: 'en-US' };
const val = (expr, opts) => {
  const r = evaluate(expr, { ...EN, ...opts });
  return r.ok ? r.value : r.error;
};

describe('calc: table of values', () => {
  const rows = [
    // precedence, associativity
    ['1 + 2 * 3', '7'],
    ['(1 + 2) * 3', '9'],
    ['10 - 4 - 3', '3'],
    ['64 / 4 / 2', '8'],
    ['2 * 3 / 4', '1.5'],
    // unary minus
    ['-2', '-2'],
    ['--2', '2'],
    ['-(3)', '-3'],
    ['+5', '5'],
    ['2 * -3', '-6'],
    ['-2 * -3', '6'],
    ['1 - -1', '2'],
    ['-'.repeat(150) + '1', '1'],
    ['0 * -1', '0'],
    // glyphs
    ['6 x 7', '42'],
    ['6 X 7', '42'],
    ['6 × 7', '42'],
    ['8 ÷ 2', '4'],
    ['5 − 2', '3'],
    // percent
    ['50%', '0.5'],
    ['200 * 10%', '20'],
    ['200 / 10%', '2000'],
    ['10% + 5', '5.1'],
    ['200 + 10%', '220'],
    ['200 - 10%', '180'],
    ['200 + 10% + 10%', '242'],
    ['200 + -10%', '180'],
    ['200 + (10%)', '200.1'],
    ['200 + 10% * 2', '200.2'],
    ['(200 + 10)%', '2.1'],
    ['5 %', '0.05'],
    ['5 / 0%', 'divide_by_zero'],
    ['50%%', 'invalid'],
    ['%5', 'invalid'],
    // decimals
    ['0.1 + 0.2', '0.3'],
    ['.5 + .5', '1'],
    ['5. + 1', '6'],
    ['1.2.3', 'invalid'],
    ['.', 'invalid'],
    ['1..2', 'invalid'],
    ['1 2', 'invalid'],
    // rounding
    ['1 / 3', '0.3333333333'],
    ['2 / 3', '0.6666666667'],
    ['-2 / 3', '-0.6666666667'],
    ['1 / 3 * 3', '1'],
    ['0.00000000015', '0.0000000002'],
    ['-0.00000000015', '-0.0000000002'],
    // commas and $
    ['1,234.5 + 1', '1235.5'],
    ['12,345,678', '12345678'],
    ['1,5', 'invalid'],
    ['1,23', 'invalid'],
    ['1,2345', 'invalid'],
    [',5', 'invalid'],
    ['$50 + 5', '55'],
    ['5 $', 'invalid'],
    ['$$5', 'invalid'],
    // large and small
    ['999999999999999', '999999999999999'],
    ['1000000000000000', 'out_of_range'],
    ['999999999999999.99999999999', 'out_of_range'], // rounds up to 1e15, so it is checked after rounding
    ['99999999 * 99999999', 'out_of_range'],
    ['10000000000 * 10000000000 / 10000000000', '10000000000'],
    ['0.0000000001', '0.0000000001'],
    ['1 / 10000000000 / 10', 'out_of_range'],
    // divide by zero
    ['5 / 0', 'divide_by_zero'],
    ['5 / (2 - 2)', 'divide_by_zero'],
    ['0 / 0', 'divide_by_zero'],
    ['1/0 + )', 'divide_by_zero'],
    // malformed
    ['', 'empty'],
    ['   ', 'empty'],
    ['1 +', 'invalid'],
    ['* 5', 'invalid'],
    ['()', 'invalid'],
    ['(1 + 2', 'invalid'],
    ['1 + 2)', 'invalid'],
    ['abc', 'invalid'],
    ['1e5', 'invalid'],
    ['2(3)', 'invalid'],
    // caps
    ['1+'.repeat(100) + '1', 'too_long'],
    ['a'.repeat(CALC_MAX_LENGTH + 1), 'too_long'],
    ['1+'.repeat(99) + '1', '100'],
    ['('.repeat(21) + '1' + ')'.repeat(21), 'too_deep'],
    ['('.repeat(20) + '1' + ')'.repeat(20), '1'],
  ];
  it.each(rows)('%s', (expr, expected) => {
    expect(val(expr)).toBe(expected);
  });

  it('non-strings are invalid', () => {
    expect(evaluate(null)).toEqual({ ok: false, error: 'invalid' });
    expect(evaluate(5)).toEqual({ ok: false, error: 'invalid' });
  });

  it('places: 2 rounds half away from zero', () => {
    expect(val('1.005', { places: 2 })).toBe('1.01');
    expect(val('-0.005', { places: 2 })).toBe('-0.01');
    expect(val('0.001', { places: 2 })).toBe('0');
  });
});

describe('calc: display', () => {
  it('en-US', () => {
    expect(evaluate('0.1 + 0.2', EN).display).toBe('0.3');
    expect(evaluate('1 / 3', EN).display).toBe('0.3333333333');
    expect(evaluate('1,234.5 + 1', EN).display).toBe('1,235.5');
    expect(evaluate('999999999999999', EN).display).toBe('999,999,999,999,999');
    expect(evaluate('123456789012.3456789012', EN).display).toBe('123,456,789,012.3456789012');
  });

  it('de-DE shows the locale marks, value stays plain', () => {
    const a = evaluate('0.1 + 0.2', { locale: 'de-DE' });
    expect(a.value).toBe('0.3');
    expect(a.display).toBe('0,3');
    const b = evaluate('1,234.5 + 1', { locale: 'de-DE' });
    expect(b.value).toBe('1235.5');
    expect(b.display).toBe('1.235,5');
  });

  it('shape: exact keys', () => {
    expect(Object.keys(evaluate('1', EN)).sort()).toEqual(['display', 'ok', 'value']);
    expect(Object.keys(evaluate('x', EN)).sort()).toEqual(['error', 'ok']);
  });

  const values = ['0', '0.3', '-0.5', '-1234.5', '999999999999999', '123456789012.3456789012', '0.0000000001'];
  for (const locale of ['en-US', 'de-DE']) {
    it.each(values)(`formatDecimal split path equals string path (${locale}) %s`, (v) => {
      expect(formatDecimal(v, locale, false)).toBe(formatDecimal(v, locale, true));
    });
  }

  it('no locale given uses the runtime locale', () => {
    expect(formatDecimal('0.3')).toBe(new Intl.NumberFormat(undefined, { maximumFractionDigits: 10 }).format('0.3'));
  });
});

describe('calc: amount profile', () => {
  const amt = (expr, places = 2) => evaluate(expr, { profile: 'amount', places });
  it('treats $ and , as invalid (the wrapper removes them first)', () => {
    expect(amt('$5')).toEqual({ ok: false, error: 'invalid' });
    expect(amt('1,2')).toEqual({ ok: false, error: 'invalid' });
  });
  it('has no depth or range limit', () => {
    expect(amt('1+'.repeat(100) + '1').value).toBe('101');
    expect(amt('('.repeat(25) + '1' + ')'.repeat(25)).value).toBe('1');
    expect(amt('1000000000000000').value).toBe('1000000000000000');
    expect(amt('0.00000000001').value).toBe('0');
  });
  it('caps the length before lexing: 1000 ok, 1001 too_long, extreme nesting never reaches the parser', () => {
    expect(amt('1'.repeat(AMOUNT_MAX_LENGTH)).ok).toBe(true);
    expect(amt('1'.repeat(AMOUNT_MAX_LENGTH + 1))).toEqual({ ok: false, error: 'too_long' });
    expect(amt('('.repeat(100000) + '1' + ')'.repeat(100000))).toEqual({ ok: false, error: 'too_long' });
  });
  it('the largest legal operands stay under the size guard (it is a backstop for the length cap)', () => {
    expect(amt('9'.repeat(499) + '*' + '9'.repeat(499)).ok).toBe(true);
    expect(amt('9'.repeat(400) + '/' + '9'.repeat(400)).value).toBe('1');
  });
  it('skips the display (empty string)', () => {
    expect(amt('1').display).toBe('');
  });
  it('toDecimal trims zeros without scanning the integer part (1000-char input)', () => {
    const t0 = Date.now();
    expect(amt('1' + '0'.repeat(999), 10).value).toBe('1' + '0'.repeat(999));
    expect(amt('0'.repeat(980) + '.5000000000', 10).value).toBe('0.5');
    expect(amt('5.' + '0'.repeat(990), 10).value).toBe('5');
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});

describe('no dynamic code', () => {
  for (const [name, src] of [
    ['calc.js', calcSrc],
    ['evalAmount.js', evalAmountSrc],
  ]) {
    it(`${name} has no eval, Function or import call (comments included)`, () => {
      expect(src).not.toMatch(/\beval\s*\(/);
      expect(src).not.toMatch(/\bFunction\s*\(/);
      expect(src).not.toMatch(/\bimport\s*\(/);
      expect(src).not.toMatch(/\bconstructor\b/);
      expect(src).not.toMatch(/\bset(Timeout|Interval)\b/);
      expect(src).not.toMatch(/\bReflect\b/);
      expect(src).not.toMatch(/\bglobalThis\b/);
      expect(src).not.toMatch(/\bWorker\b/);
    });
  }
  it('calc.js has no import keyword at all', () => {
    expect(calcSrc).not.toMatch(/\bimport\b/);
  });
});
