// Client mirror of stripDashes in server/javi/validateAdvice.js (server and client do not
// share modules). Keep the two in sync: Javi's replies never show em or en dashes.
// server/__tests__/javiDashesParity.test.js asserts both give identical output.

const DASH = '[\u2012-\u2015\u2E3A\u2E3B\uFE31\uFE32\uFE58]';
const HAS_DASH_RE = new RegExp(DASH);
// Fenced and inline code spans are captured, so split() keeps them at odd indexes.
const CODE_SPAN_RE = /(```[\s\S]*?```|`[^`\n]*`)/;
const TABLE_PLACEHOLDER_RE = new RegExp(String.raw`(\|[ \t]*)${DASH}+(?=[ \t]*\|)`, 'g');
// EN or figure dash between a digit and a digit or $ is a range.
const RANGE_RE = /(\d)[ \t]*[\u2012\u2013][ \t]*(?=[$\d])/g;
const ISO_DATE_END_RE = /^\d{4}-\d{2}-\d{2}$/;
const LINE_START_FIRST_RE = new RegExp(String.raw`(^|\n)([ \t]*)(?:${DASH}[ \t]*)+`, 'g');
const LINE_START_MID_RE = new RegExp(String.raw`(\n)([ \t]*)(?:${DASH}[ \t]*)+`, 'g');
// The lookbehind stops matches from starting inside a run of spaces (no quadratic scan).
const PROSE_RE = new RegExp(
  String.raw`(?<![ \t]),?[ \t]*${DASH}(?:[ \t]*${DASH})*[ \t]*(?:,[ \t]*)?`,
  'g',
);

function stripDashesInPart(part, atLineStart) {
  return part
    .replace(TABLE_PLACEHOLDER_RE, '$1n/a')
    .replace(RANGE_RE, (_m, digit, offset, whole) =>
      ISO_DATE_END_RE.test(whole.slice(Math.max(0, offset - 9), offset + 1))
        ? `${digit} to `
        : `${digit}-`,
    )
    .replace(atLineStart ? LINE_START_FIRST_RE : LINE_START_MID_RE, '$1$2')
    .replace(PROSE_RE, ', ');
}

/**
 * Remove em/en-style dashes from model output (U+2012 to U+2015 and a few lookalikes).
 * Code spans are left alone. EN/figure-dash digit ranges ("3–5", "$50 – $75") become a
 * hyphen ("to" after an ISO date), a lone "| — |" table cell becomes "n/a", a dash leading a
 * line is dropped (never leaving "- ", which markdown would render as a bullet), and any
 * other dash becomes ", ". Mirrors server/javi/validateAdvice.js.
 * @param {unknown} text
 * @returns {string}
 */
export function stripDashes(text) {
  if (typeof text !== 'string') return '';
  if (!HAS_DASH_RE.test(text)) return text;
  return text
    .split(CODE_SPAN_RE)
    .map((part, i) => (i % 2 === 1 ? part : stripDashesInPart(part, i === 0)))
    .join('');
}
