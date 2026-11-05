// RFC 4180 CSV for the data export. The formula-injection guard applies to EVERY string
// cell (including bare strings in jsonb columns such as app_state.value), except plain
// numbers in numeric-typed columns, so -12.50 stays numeric.

const FORMULA_START_RE = /^(?:\s*[=+\-@]|[\t\r])/;
const PLAIN_NUMBER_RE = /^-?\d+(\.\d+)?$/;
const NUMERIC_TYPES = new Set(['numeric', 'integer', 'real']);
const NEEDS_QUOTES_RE = /[",\r\n]/;

function cellText(value, type) {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (typeof value === 'string' && FORMULA_START_RE.test(text)) {
    const plainNumber = NUMERIC_TYPES.has(type) && PLAIN_NUMBER_RE.test(text);
    if (!plainNumber) text = `'${text}`;
  }
  return NEEDS_QUOTES_RE.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * @param {ReadonlyArray<{ name: string, type: string }>} columns
 * @param {ReadonlyArray<Record<string, unknown>>} rows
 * @returns {string} CSV with CRLF row endings (header-only when there are no rows)
 */
export function toCsv(columns, rows) {
  const lines = [columns.map((c) => cellText(c.name, 'header')).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => cellText(row?.[c.name], c.type)).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}
