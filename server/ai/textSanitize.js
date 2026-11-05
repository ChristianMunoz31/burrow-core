// Output clean-up applied to model text before it reaches the user.
//   fixDollarAmounts: "$1234.5" -> "$1,234.50", "$-5" -> "-$5". Only amounts that already
//     carry a $ are touched; bare numbers are never given one.
//   sanitizeModelText: fixDollarAmounts(stripDashes(text)).
// Code spans are left alone by both.
import { stripDashes } from '../javi/validateAdvice.js';

// Fenced and inline code spans are captured, so split() keeps them at odd indexes.
export const CODE_SPAN_RE = /(```[\s\S]*?```|`[^`\n]*`)/;

// Optional sign before or after the $, then digits (optionally already grouped), then decimals.
const DOLLAR_RE = /(-?)\$(-?)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?![\d,]*\d)/g;

const group = (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function fixAmount(match, signBefore, signAfter, intPart, decimals) {
  const digits = intPart.replace(/,/g, '');
  let dec = decimals || '';
  if (dec.length === 2) dec = `${dec}0`;
  else if (dec.length > 3) {
    // Round to cents; a carry into the integer part is handled by Number math.
    const value = Number(`${digits}${dec}`);
    if (!Number.isFinite(value)) return match;
    const [i, d] = value.toFixed(2).split('.');
    return `${signBefore || signAfter ? '-' : ''}$${group(i)}.${d}`;
  }
  const negative = signBefore === '-' || signAfter === '-';
  return `${negative ? '-' : ''}$${group(digits.replace(/^0+(?=\d)/, ''))}${dec}`;
}

function fixPart(part) {
  return part.includes('$') ? part.replace(DOLLAR_RE, fixAmount) : part;
}

/**
 * Normalize dollar amounts that already start with "$": thousands separators, two
 * decimals when decimals are present, and a leading minus ("$-5" -> "-$5").
 * @param {unknown} text
 * @returns {string}
 */
export function fixDollarAmounts(text) {
  if (typeof text !== 'string') return '';
  if (!text.includes('$')) return text;
  return text
    .split(CODE_SPAN_RE)
    .map((part, i) => (i % 2 === 1 ? part : fixPart(part)))
    .join('');
}

/**
 * The standard clean-up for model text shown to the user.
 * @param {unknown} text
 * @returns {string}
 */
export const sanitizeModelText = (text) => fixDollarAmounts(stripDashes(text));
