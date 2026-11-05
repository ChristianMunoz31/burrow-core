// --- Value normalization helpers (pure, individually testable) -------------

// Parse a money string into a signed number. Strips currency symbols, thousands
// separators, and CR/DR suffixes; treats (123.45) as -123.45 (accounting style).
// Returns NaN when there's no numeric content, so callers can flag the row
// rather than silently defaulting to 0.
export function parseAmount(raw) {
  if (raw === null || raw === undefined) return NaN;
  let s = String(raw).trim();
  if (s === '') return NaN;
  let sign = 1;
  // Accounting-style parentheses denote a negative.
  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    s = s.slice(1, -1);
  }
  // Trailing CR/DR markers (some banks emit "12.34 DR").
  const m = s.match(/\b(cr|dr)\b\s*$/i);
  if (m) {
    if (m[1].toLowerCase() === 'dr') sign = -1;
    s = s.slice(0, m.index);
  }
  // Drop currency symbols, thousands separators, and spaces.
  s = s.replace(/[$£€¥]/g, '').replace(/,/g, '').replace(/\s/g, '');
  if (s === '' || s === '-' || s === '+') return NaN;
  // Only a plain decimal is a number here: no exponents, hex or Infinity.
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) return NaN;
  const n = Number(s);
  if (!Number.isFinite(n)) return NaN;
  return sign * n;
}
