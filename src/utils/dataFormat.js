export const LONG_THRESHOLD = 80;
export const PAGE_SIZES = [25, 50, 100];
export const REDACTED_VALUE = '[redacted]';

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const CURRENCY = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export const formatCurrency = (n) => CURRENCY.format(n);

export function isLong(text) {
  return typeof text === 'string' && text.length > LONG_THRESHOLD;
}

export function truncate(text, max = LONG_THRESHOLD) {
  if (typeof text !== 'string' || text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function formatDate(value) {
  const m = DATE_ONLY.exec(String(value));
  // Date-only strings are local dates; parsing them as UTC can show the previous day.
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString();
}

function formatTimestamp(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString();
}

function structured(value) {
  let compact;
  try {
    compact = JSON.stringify(value);
  } catch {
    compact = String(value);
  }
  const long = isLong(compact);
  return {
    text: long ? truncate(compact) : compact,
    full: long ? JSON.stringify(value, null, 2) : null,
  };
}

/**
 * Format one cell for display.
 * @param {unknown} value
 * @param {{ name: string, type: string }} column
 * @param {{ amountColumn?: string|null }} [opts]
 * @returns {{ kind: string, text: string, title?: string, full?: string|null, tone?: 'pos'|'neg' }}
 */
export function formatCell(value, column, { amountColumn = null } = {}) {
  if (value === null || value === undefined) return { kind: 'null', text: 'n/a' };
  if (value === REDACTED_VALUE) return { kind: 'redacted', text: 'redacted' };

  const type = column?.type;
  if (amountColumn && column?.name === amountColumn) {
    const n = Number(value);
    if (Number.isFinite(n)) {
      return { kind: 'currency', text: formatCurrency(n), tone: n < 0 ? 'neg' : n > 0 ? 'pos' : undefined };
    }
  }
  if (type === 'boolean') return { kind: 'boolean', text: value ? 'Yes' : 'No' };
  if (type === 'date') return { kind: 'date', text: formatDate(value) };
  if (type === 'timestamptz') return { kind: 'date', text: formatTimestamp(value) };
  if (type === 'uuid') return { kind: 'uuid', text: String(value).slice(0, 8), title: String(value) };
  if (type === 'jsonb' || type === 'text[]' || typeof value === 'object') {
    const { text, full } = structured(value);
    return { kind: 'json', text, full };
  }
  if (typeof value === 'string' && isLong(value)) {
    return { kind: 'text', text: truncate(value), full: value };
  }
  return { kind: 'text', text: String(value) };
}

/** Last page number for a result set (always at least 1). */
export const lastPageOf = (total, pageSize) => Math.max(1, Math.ceil(total / pageSize));

/** 1-based inclusive row range for a page, clamped to the last page. */
export function rowRange(page, pageSize, total) {
  if (total === 0) return { from: 0, to: 0 };
  const p = Math.min(Math.max(1, page), lastPageOf(total, pageSize));
  return { from: (p - 1) * pageSize + 1, to: Math.min(total, p * pageSize) };
}
