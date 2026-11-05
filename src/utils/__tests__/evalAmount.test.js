import { describe, it, expect } from 'vitest';
import { evalAmount } from '../evalAmount';

describe('evalAmount', () => {
  describe('arithmetic', () => {
    it('adds', () => {
      expect(evalAmount('50+25')).toBe(75);
    });

    it('subtracts', () => {
      expect(evalAmount('100-30')).toBe(70);
    });

    it('multiplies (with a decimal operand)', () => {
      expect(evalAmount('12.5*4')).toBe(50);
    });

    it('divides', () => {
      expect(evalAmount('100/4')).toBe(25);
    });

    it('respects parentheses with division', () => {
      expect(evalAmount('(100+50)/2')).toBe(75);
    });

    it('respects parentheses with multiplication', () => {
      expect(evalAmount('(20+30)*2')).toBe(100);
    });
  });

  describe('plain numbers', () => {
    it('parses an integer', () => {
      expect(evalAmount('42')).toBe(42);
    });

    it('parses a decimal', () => {
      expect(evalAmount('50.5')).toBe(50.5);
    });

    it('parses a leading-minus (unary) number', () => {
      expect(evalAmount('-10')).toBe(-10);
    });

    it('parses zero', () => {
      expect(evalAmount('0')).toBe(0);
    });
  });

  describe('friendly cleanup', () => {
    it('strips thousands separators', () => {
      expect(evalAmount('1,200')).toBe(1200);
    });

    it('strips a leading dollar sign', () => {
      expect(evalAmount('$50')).toBe(50);
    });

    it('tolerates surrounding and internal whitespace', () => {
      expect(evalAmount('  7 * 3 ')).toBe(21);
    });

    it('strips both a dollar sign and thousands separators with a decimal', () => {
      expect(evalAmount('$1,200.50')).toBe(1200.5);
    });
  });

  describe('float rounding to cents', () => {
    it('rounds 0.1 + 0.2 to 0.3', () => {
      expect(evalAmount('0.1+0.2')).toBe(0.3);
    });
  });

  describe('invalid or empty input → null', () => {
    it('rejects an empty string', () => {
      expect(evalAmount('')).toBe(null);
    });

    it('rejects a whitespace-only string', () => {
      expect(evalAmount('   ')).toBe(null);
    });

    it('rejects non-numeric text', () => {
      expect(evalAmount('abc')).toBe(null);
    });

    it('rejects a trailing operator', () => {
      expect(evalAmount('50+')).toBe(null);
    });

    it('rejects a leading binary operator', () => {
      expect(evalAmount('*5')).toBe(null);
    });

    it('rejects division by zero', () => {
      expect(evalAmount('5/0')).toBe(null);
    });

    it('rejects empty parentheses', () => {
      expect(evalAmount('()')).toBe(null);
    });

    it('rejects unbalanced parentheses', () => {
      expect(evalAmount('1+(2')).toBe(null);
    });

    it('rejects two numbers with no operator', () => {
      expect(evalAmount('1 2')).toBe(null);
    });

    it('rejects a non-string input', () => {
      expect(evalAmount(null)).toBe(null);
      expect(evalAmount(undefined)).toBe(null);
    });
  });
});

describe('evalAmount keeps its results (one engine, calc.js)', () => {
  const cases = [
    ['1,2', 12],
    [',5', 5],
    ['1,,2', 12],
    ['1,234.5', 1234.5],
    ['$1,200.50', 1200.5],
    ['$$5', null],
    ['5$', null],
    ['-$5', null],
    ['1000000000000000', 1000000000000000],
    ['0.00000000001', 0],
    ['1+'.repeat(100) + '1', 101],
    ['('.repeat(25) + '1' + ')'.repeat(25), 1],
    ['9'.repeat(400), null],
    ['.5', 0.5],
    ['5.', 5],
    ['.', null],
    ['1.2.3', null],
    ['1 2', null],
    ['1e5', null],
    ['1/3', 0.33],
    ['2/3', 0.67],
    ['0.1+0.2', 0.3],
    ['5/0', null],
    ['0/0', null],
  ];
  it.each(cases)('%s -> %s', (input, expected) => {
    expect(evalAmount(input)).toBe(expected);
  });
});

describe('evalAmount accepted behaviour changes', () => {
  const cases = [
    ['1.005', 1.01],
    ['-1.005', -1.01],
    ['-0.125', -0.13],
    ['-0.005', -0.01],
    ['9'.repeat(400) + '/' + '9'.repeat(400), 1],
    ['200+10%', 220],
    ['200-10%', 180],
    ['50%', 0.5],
    ['10%*200', 20],
    ['6x7', 42],
    ['6X7', 42],
    ['6×7', 42],
    ['8÷2', 4],
    ['5−2', 3],
    ['0x10', 0], // x is multiplication: 0 * 10
  ];
  it.each(cases)('%s -> %s', (input, expected) => {
    expect(evalAmount(input)).toBe(expected);
  });

  it.each(['-0.004', '-0', '0*-1'])('%s is 0, never -0', (input) => {
    expect(Object.is(evalAmount(input), 0)).toBe(true);
  });
});

describe('evalAmount is bounded against hostile input', () => {
  it('rejects input over the 1000-char cap, keeps the legacy 801-char row', () => {
    expect(evalAmount('1'.repeat(1001))).toBeNull();
    expect(evalAmount('9'.repeat(400) + '/' + '9'.repeat(400))).toBe(1);
  });
  it.each([
    ['*1.01 chain', '1' + '*1.01'.repeat(199)],
    ['+1% chain', '1' + '+1%'.repeat(333)],
    ['over-cap *1.01 chain', '1' + '*1.01'.repeat(5000)],
  ])('%s completes well under a second', (_name, input) => {
    const t0 = Date.now();
    evalAmount(input);
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});
