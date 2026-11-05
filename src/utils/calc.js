// The one arithmetic engine of the app: exact decimal math for the calculator dialog and, through
// evalAmount, for every amount field. Pure, no module dependencies, no dynamic code of any kind (only BigInt and Intl).
//
// Hand-written recursive descent over a lazily read token stream, evaluated eagerly left to right on
// exact rationals { n, d } (BigInt, d > 0, reduced). Rounded once at the end, half away from zero.
//
//   expr    := term (('+' | '-') term)*     a bare percent term on the right is a percent of the running total
//   term    := signed (('*' | '/') signed)*
//   signed  := ('+' | '-') signed | postfix
//   postfix := primary '%'?
//   primary := number | '(' expr ')'
//
// Two profiles. 'calculator' (default, the dialog): one leading '$' ignored, commas only as real thousands
// separators, length, depth and value-range limits. 'amount' (evalAmount only): the caller has already
// removed '$' and every comma. It has no depth or value-range limit, but a length cap (AMOUNT_MAX_LENGTH, checked
// before lexing) and an intermediate size guard in make() keep a hostile field from burning CPU.

export const CALC_MAX_LENGTH = 200; // characters of the trimmed input (calculator profile)
export const CALC_MAX_DEPTH = 20; // nested parentheses (calculator profile)
export const CALC_PLACES = 10; // default fraction digits of `value`
export const AMOUNT_MAX_LENGTH = 1000; // characters of the trimmed input (amount profile)

const MAX_PLACES = 10;
const BIG_LIMIT = 10n ** 15n; // calculator: |v| must stay below this
const SMALL_LIMIT_SHIFT = 10n ** 10n; // calculator: non-zero |v| must be at least 1e-10
const SIZE_GUARD = 2n ** 4096n; // every profile: an intermediate numerator or denominator at or above this fails

// Thrown (never returned) to unwind the parser; a plain function so it works with instanceof.
function CalcFailure(error) {
  this.error = error;
}

const fail = (error) => {
  throw new CalcFailure(error);
};

const isDigit = (ch) => ch !== undefined && ch >= '0' && ch <= '9';

const gcd = (a, b) => {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
};

// Rational with d > 0, reduced by gcd.
const make = (n, d) => {
  if (n === 0n) return { n: 0n, d: 1n };
  if ((n < 0n ? -n : n) >= SIZE_GUARD || (d < 0n ? -d : d) >= SIZE_GUARD) fail('out_of_range');
  const g = gcd(n, d);
  const sign = d < 0n ? -1n : 1n;
  return { n: (sign * n) / g, d: (sign * d) / g };
};
const add = (a, b) => make(a.n * b.d + b.n * a.d, a.d * b.d);
const sub = (a, b) => make(a.n * b.d - b.n * a.d, a.d * b.d);
const mul = (a, b) => make(a.n * b.n, a.d * b.d);
const div = (a, b) => {
  if (b.n === 0n) fail('divide_by_zero');
  return make(a.n * b.d, a.d * b.n);
};
const neg = (a) => ({ n: -a.n, d: a.d });
const HUNDRED = { n: 100n, d: 1n };

// Exact rational to a plain decimal string with `places` fraction digits: no exponent, no grouping,
// no trailing zeros, never '-0'.
function toDecimal(r, places) {
  const abs = r.n < 0n ? -r.n : r.n;
  const q = abs * 10n ** BigInt(places);
  let rounded = q / r.d;
  if (2n * (q % r.d) >= r.d) rounded += 1n;
  const digits = rounded.toString().padStart(places + 1, '0');
  let out = digits;
  if (places > 0) {
    const cut = digits.length - places;
    // Trim trailing zeros of the fraction only (at most `places` characters), never scanning the integer part.
    let end = digits.length;
    while (end > cut && digits[end - 1] === '0') end--;
    out = end > cut ? `${digits.slice(0, cut)}.${digits.slice(cut, end)}` : digits.slice(0, cut);
  }
  return rounded !== 0n && r.n < 0n ? `-${out}` : out;
}

/**
 * Exact calculation of a typed expression.
 * @param {string} expr Non-strings return { ok: false, error: 'invalid' }.
 * @param {{ places?: number, profile?: 'calculator' | 'amount', locale?: string }} [options]
 *   places: integer 0 to 10, default 10. locale: BCP 47 tag for `display` only (default: the runtime locale).
 * @returns {{ ok: true, value: string, display: string } |
 *   { ok: false, error: 'empty' | 'invalid' | 'divide_by_zero' | 'too_long' | 'too_deep' | 'out_of_range' }}
 */
export function evaluate(expr, { places = CALC_PLACES, profile = 'calculator', locale } = {}) {
  if (typeof expr !== 'string') return { ok: false, error: 'invalid' };
  const calc = profile !== 'amount';
  const dp = Number.isInteger(places) && places >= 0 && places <= MAX_PLACES ? places : CALC_PLACES;
  let src = expr.trim();
  if (src === '') return { ok: false, error: 'empty' };
  if (calc && src.length > CALC_MAX_LENGTH) return { ok: false, error: 'too_long' };
  if (!calc && src.length > AMOUNT_MAX_LENGTH) return { ok: false, error: 'too_long' };
  if (calc && src[0] === '$') src = src.slice(1);

  const len = src.length;
  let pos = 0;
  let tok = null;

  const lexNumber = () => {
    let int = '';
    let frac = '';
    while (isDigit(src[pos])) int += src[pos++];
    if (calc && int !== '') {
      // A comma is valid only as a thousands separator: exactly three digits follow, then a non-digit.
      while (src[pos] === ',') {
        const group = src.slice(pos + 1, pos + 4);
        if (!/^[0-9]{3}$/.test(group) || isDigit(src[pos + 4])) fail('invalid');
        int += group;
        pos += 4;
      }
    }
    if (src[pos] === '.') {
      pos++;
      while (isDigit(src[pos])) frac += src[pos++];
      if (int === '' && frac === '') fail('invalid');
    }
    return { t: 'num', v: make(BigInt(int + frac || '0'), 10n ** BigInt(frac.length)) };
  };

  const peek = () => {
    if (tok) return tok;
    while (pos < len && /\s/.test(src[pos])) pos++;
    if (pos >= len) {
      tok = { t: 'end' };
      return tok;
    }
    const ch = src[pos];
    if (isDigit(ch) || ch === '.') {
      tok = lexNumber();
      return tok;
    }
    let t;
    if (ch === '+') t = '+';
    else if (ch === '-' || ch === '−') t = '-';
    else if (ch === '*' || ch === 'x' || ch === 'X' || ch === '×') t = '*';
    else if (ch === '/' || ch === '÷') t = '/';
    else if (ch === '(' || ch === ')' || ch === '%') t = ch;
    else fail('invalid');
    pos++;
    tok = { t };
    return tok;
  };
  const next = () => {
    const t = peek();
    tok = null;
    return t;
  };

  // postfix := primary '%'?   (returns { v, pct }: pct is true when the percent sign sat on this operand)
  const parsePostfix = (depth) => {
    const t = next();
    let v;
    if (t.t === 'num') {
      v = t.v;
    } else if (t.t === '(') {
      if (calc && depth + 1 > CALC_MAX_DEPTH) fail('too_deep');
      v = parseExpr(depth + 1);
      if (next().t !== ')') fail('invalid');
    } else {
      fail('invalid');
    }
    if (peek().t === '%') {
      next();
      return { v: div(v, HUNDRED), pct: true };
    }
    return { v, pct: false };
  };

  const parseSigned = (depth) => {
    const t = peek().t;
    if (t === '+' || t === '-') {
      next();
      const inner = parseSigned(depth);
      return { v: t === '-' ? neg(inner.v) : inner.v, pct: inner.pct };
    }
    return parsePostfix(depth);
  };

  const parseTerm = (depth) => {
    const first = parseSigned(depth);
    let { v } = first;
    let pct = first.pct;
    for (;;) {
      const t = peek().t;
      if (t !== '*' && t !== '/') break;
      next();
      const rhs = parseSigned(depth);
      v = t === '*' ? mul(v, rhs.v) : div(v, rhs.v);
      pct = false;
    }
    return { v, pct };
  };

  function parseExpr(depth) {
    let acc = parseTerm(depth).v;
    for (;;) {
      const t = peek().t;
      if (t !== '+' && t !== '-') break;
      next();
      const rhs = parseTerm(depth);
      const operand = rhs.pct ? mul(acc, rhs.v) : rhs.v; // bare percent: of the running total on the left
      acc = t === '+' ? add(acc, operand) : sub(acc, operand);
    }
    return acc;
  }

  let value;
  try {
    const result = parseExpr(0);
    if (peek().t !== 'end') fail('invalid');
    if (calc) {
      const abs = result.n < 0n ? -result.n : result.n;
      if (abs >= BIG_LIMIT * result.d) fail('out_of_range');
      if (abs !== 0n && abs * SMALL_LIMIT_SHIFT < result.d) fail('out_of_range');
    }
    value = toDecimal(result, dp);
    // The range applies to what is shown: a value that rounds up to 1e15 has 16 integer digits.
    if (calc && value.replace('-', '').split('.')[0].length > 15) fail('out_of_range');
  } catch (e) {
    if (e instanceof CalcFailure) return { ok: false, error: e.error };
    if (!calc && e instanceof RangeError) return { ok: false, error: 'invalid' }; // extreme nesting (amount profile)
    throw e;
  }
  // The amount profile (evalAmount) only needs `value`; skip the Intl work.
  return { ok: true, value, display: calc ? formatDecimal(value, locale) : '' };
}

// True when Intl.NumberFormat formats a numeric string exactly (Intl.NumberFormat v3). Probed once at load with a
// fixed locale and no grouping: an engine without string input converts to a Number and prints ...992.
const STRING_INPUT =
  new Intl.NumberFormat('en-US', { useGrouping: false }).format('9007199254740993') === '9007199254740993';

/**
 * Locale display of an exact plain decimal string in the `value` shape ('-1234.5', '0.3'; at most 10 fraction
 * digits, never '-0'). Never converts the value to a Number, so it is exact beyond 2^53.
 * @param {string} value
 * @param {string} [locale] default undefined = the runtime locale
 * @param {boolean} [stringInput] defaults to STRING_INPUT; tests pass false to run the split path
 * @returns {string}
 */
export function formatDecimal(value, locale = undefined, stringInput = STRING_INPUT) {
  const nf = new Intl.NumberFormat(locale, { maximumFractionDigits: 10 }); // built per call: no load-order trap in tests
  if (stringInput) return nf.format(value);
  // Split path: the integer part as a BigInt (exact at any size), then the locale's decimal separator and digits.
  const isNeg = value.startsWith('-');
  const [int, frac = ''] = (isNeg ? value.slice(1) : value).split('.');
  const n = BigInt(int);
  // BigInt has no negative zero, so '-0.5' borrows the sign layout of -1n and swaps in the localized zero.
  const parts = nf.formatToParts(isNeg ? (n === 0n ? -1n : -n) : n);
  if (isNeg && n === 0n) parts.find((p) => p.type === 'integer').value = nf.format(0);
  const out = parts.map((p) => p.value);
  if (frac) {
    const decimal = nf.formatToParts(1.5).find((p) => p.type === 'decimal').value;
    const digits = [...frac].map((d) => nf.format(Number(d))).join(''); // single digits: localized numerals
    const at = parts.findLastIndex((p) => p.type === 'integer' || p.type === 'group') + 1;
    out.splice(at, 0, decimal + digits);
  }
  return out.join('');
}
