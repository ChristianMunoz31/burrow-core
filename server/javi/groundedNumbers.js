// Deterministic check that every figure in a model answer also appears in the facts the model was
// given. Pure: no I/O, no server imports, safe to reuse for any text (advice, explain, briefing).
//
// The model is told to copy numbers exactly and never to calculate. This catches the cases where it
// does anyway: an invented or computed figure is "ungrounded". Dates, clock times, years, ordinals,
// list markers and small whole numbers are ignored by default (they are wording, not data).

/** @typedef {{ raw: string, value: number, kind: 'currency'|'percent'|'number' }} ExtractedNumber */

// $1,234.50 | 1,234 | 1234.5 | 12% | 12.0 percent. The sign is not captured: values are absolute.
const NUMBER_RE = /(?<![A-Za-z0-9_.])(\$)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(\s?%|\s+percent\b)?/gi;

const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
// Spans that read as dates, times, ordinals or list markers; blanked before the answer is scanned.
const IGNORED_SPAN_RES = Object.freeze({
  dates: [
    /\b\d{4}-\d{2}-\d{2}\b/g,
    /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g,
    new RegExp(`\\b${MONTH}\\s+\\d{1,2}(?:\\s*,\\s*\\d{4})?\\b`, 'gi'),
    new RegExp(`\\b\\d{1,2}\\s+${MONTH}(?:\\s+\\d{4})?\\b`, 'gi'),
  ],
  times: [/\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]\.?m\.?)?/gi, /\b\d{1,2}\s?[ap]\.?m\b\.?/gi],
  ordinals: [/\b\d+(?:st|nd|rd|th)\b/gi, /^[ \t]*(?:[-*+][ \t]+)?[*_]{0,2}\d{1,2}[.)][*_]{0,2}(?=\s)/gm],
});

const blank = (s) => ' '.repeat(s.length);

function maskSpans(text, groups) {
  let out = text;
  for (const group of groups) for (const re of IGNORED_SPAN_RES[group]) out = out.replace(re, blank);
  return out;
}

/**
 * Pull every number out of a text.
 *
 * @param {unknown} text Any text.
 * @returns {ExtractedNumber[]} In order of appearance. `value` is absolute (a leading minus is
 *   ignored) and has thousands separators removed. `raw` is the matched text.
 */
export function extractNumbers(text) {
  const s = typeof text === 'string' ? text : '';
  /** @type {ExtractedNumber[]} */
  const out = [];
  for (const m of s.matchAll(NUMBER_RE)) {
    const [raw, dollar, whole, fraction, percent] = m;
    const value = Number(`${whole.replaceAll(',', '')}${fraction ?? ''}`);
    if (!Number.isFinite(value)) continue;
    out.push({ raw: raw.trim(), value, kind: dollar ? 'currency' : percent ? 'percent' : 'number' });
  }
  return out;
}

const decimalsOf = (raw) => {
  const m = /\.(\d+)/.exec(raw);
  return m ? Math.min(m[1].length, 6) : 0;
};

/**
 * Which numbers in an answer are not among the facts.
 *
 * A figure is grounded when a fact number equals it at the precision the answer shows
 * ("$1,235" matches a fact of 1234.5; "12%" matches a fact of 12 or 12.0). Signs are ignored.
 *
 * @param {unknown} answerText The model answer.
 * @param {unknown} factsText The exact text the model was given.
 * @param {{ ignoreSmallIntegers?: number, ignoreYears?: boolean, ignoreDates?: boolean,
 *   ignoreTimes?: boolean, ignoreOrdinals?: boolean }} [opts] `ignoreSmallIntegers` (default 10)
 *   skips whole numbers up to that value unless they are money or a percent; 0 turns it off.
 * @returns {{ ungrounded: string[], grounded: string[] }} Distinct `raw` strings, in order.
 */
export function checkGroundedNumbers(answerText, factsText, opts = {}) {
  const { ignoreSmallIntegers = 10, ignoreYears = true, ignoreDates = true, ignoreTimes = true, ignoreOrdinals = true } = opts;
  const groups = [ignoreDates && 'dates', ignoreTimes && 'times', ignoreOrdinals && 'ordinals'].filter(Boolean);
  const answer = maskSpans(typeof answerText === 'string' ? answerText : '', groups);

  const facts = extractNumbers(factsText).map((n) => n.value);
  const exact = new Set(facts);
  /** @type {Map<number, Set<number>>} */
  const rounded = new Map();
  const roundedAt = (d) => {
    if (!rounded.has(d)) rounded.set(d, new Set(facts.map((f) => Number(f.toFixed(d)))));
    return rounded.get(d);
  };

  const grounded = [];
  const ungrounded = [];
  const seen = new Set();
  for (const n of extractNumbers(answer)) {
    if (seen.has(n.raw)) continue;
    seen.add(n.raw);
    const isWhole = !n.raw.includes('.') && Number.isInteger(n.value);
    if (n.kind === 'number' && isWhole) {
      if (n.value <= ignoreSmallIntegers) continue;
      if (ignoreYears && !n.raw.includes(',') && n.value >= 1900 && n.value <= 2100) continue;
    }
    const d = decimalsOf(n.raw);
    const ok = exact.has(n.value) || roundedAt(d).has(Number(n.value.toFixed(d)));
    (ok ? grounded : ungrounded).push(n.raw);
  }
  return { ungrounded, grounded };
}
