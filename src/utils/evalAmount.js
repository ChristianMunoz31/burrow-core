import { evaluate } from './calc';

// Money amount from a field: a plain number or a small calculation ("1,200.50", "$50", "200 + 10%").
// One arithmetic engine for the app (calc.js). The cleanup below is the one evalAmount always did:
// one leading "$" and every comma are removed first, so "1,2" is still 12.
// Returns a Number rounded to cents, or null when the input is empty, invalid or does not fit a Number.
export function evalAmount(input) {
  if (typeof input !== 'string') return null;
  const cleaned = input.replace(/^\s*\$/, '').replace(/,/g, '');
  const r = evaluate(cleaned, { places: 2, profile: 'amount' });
  if (!r.ok) return null;
  const n = Number(r.value);
  return Number.isFinite(n) ? n : null;
}
