// Pure CSV transaction import helpers (no React, no network). The Import dialog drives them:
//   parseCsvTable(text)          -> table (delimiter, header row, data rows with line numbers)
//   detectFormat(headers, rows)  -> suggested column mapping + format name
//   detectDateOrder(values)      -> how the file writes numeric dates
//   buildRows(table, mapping, o) -> rows ready for POST /api/transactions/import + unreadable rows
// Amounts in the output are SIGNED: negative = money out, positive = money in.
import { parseAmount } from './csv';
import { DELIMITERS, detectDelimiter, isBlankRow, parseWith } from './csvSplit';
import { CATEGORIES, categorizeTransaction } from './budgetConfig';

export { DELIMITERS, detectDelimiter, parseWith };

export const MAX_TEXT_CHARS = 5 * 1024 * 1024;
export const MAX_DATA_ROWS = 5000;
export const MAX_MERCHANT_CHARS = 200;
export const MAX_CATEGORY_CHARS = 60;
export const MAX_COLUMNS = 200;
const MAX_DATE_CELL_CHARS = 40;
const MAX_ABS_AMOUNT = 1e9;
const HEADER_SCAN_ROWS = 20;

/** Error with a plain-language `message` that is safe to show to the user. */
export class CsvImportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CsvImportError';
    this.code = code;
  }
}

// --- Reading text ------------------------------------------------------------

/**
 * Normalize raw CSV text: strips a UTF-8 BOM and turns CRLF / CR into LF.
 * Throws CsvImportError (empty, too_large, not_text) with friendly copy.
 * @param {string} raw
 * @returns {string}
 */
export function readCsvText(raw) {
  const text = String(raw ?? '');
  if (text.length > MAX_TEXT_CHARS) {
    throw new CsvImportError('too_large', 'That file is too big. Files up to 5 MB can be imported.');
  }
  if (text.includes('\u0000')) {
    throw new CsvImportError(
      'not_text',
      'That does not look like a CSV file. Export your transactions as CSV from your bank and try again.',
    );
  }
  const clean = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (clean.trim() === '') {
    throw new CsvImportError('empty', 'That file is empty. Choose a file that has your transactions in it.');
  }
  return clean;
}

/**
 * Read a File chosen by the user, locally (no network).
 * @param {File} file
 * @returns {Promise<string>} the raw text
 */
export async function readCsvFile(file) {
  if (!file) throw new CsvImportError('empty', 'Choose a file to import.');
  const name = String(file.name ?? '').toLowerCase();
  const type = String(file.type ?? '').toLowerCase();
  const looksCsv =
    name.endsWith('.csv') || type.includes('csv') || (name.endsWith('.txt') && type.startsWith('text/'));
  if (!looksCsv) {
    throw new CsvImportError(
      'not_csv',
      'That is not a CSV file. Export your transactions as CSV from your bank and try again.',
    );
  }
  if (file.size === 0) {
    throw new CsvImportError('empty', 'That file is empty. Choose a file that has your transactions in it.');
  }
  if (file.size > MAX_TEXT_CHARS) {
    throw new CsvImportError('too_large', 'That file is too big. Files up to 5 MB can be imported.');
  }
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () =>
      reject(new CsvImportError('read_failed', 'We could not read that file. Try choosing it again.'));
    reader.readAsText(file);
  });
}

// --- Headers -----------------------------------------------------------------

/** Lowercase words only, so "Running Bal." and "running  bal" compare equal. */
export function normalizeHeader(h) {
  return String(h ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Highest priority first: when several columns could be a field, the earliest alias wins.
export const FIELD_ALIASES = {
  date: [
    'date', 'transaction date', 'trans date', 'posting date', 'post date', 'posted date',
    'date posted', 'posted', 'booking date', 'value date', 'effective date', 'trade date',
    'settlement date',
  ],
  merchant: [
    'description', 'merchant', 'merchant name', 'payee', 'transaction description',
    'original description', 'name', 'details', 'narrative', 'particulars', 'transaction',
    'reference', 'memo',
  ],
  amount: ['amount', 'transaction amount', 'amt', 'amount usd', 'value', 'sum'],
  debit: [
    'debit', 'debits', 'debit amount', 'withdrawal', 'withdrawals', 'money out', 'paid out',
    'outflow', 'charge', 'spent',
  ],
  credit: [
    'credit', 'credits', 'credit amount', 'deposit', 'deposits', 'money in', 'paid in',
    'inflow', 'received',
  ],
  category: ['category', 'categories', 'class'],
};

const FIELD_NAMES = Object.keys(FIELD_ALIASES);

function fieldMatches(normalizedHeader) {
  return FIELD_NAMES.filter((f) => FIELD_ALIASES[f].includes(normalizedHeader));
}

function matchedFields(cells) {
  const set = new Set();
  for (const c of cells) for (const f of fieldMatches(normalizeHeader(c))) set.add(f);
  return set;
}

/**
 * Index of the real header row among the first ~20 non-empty rows. Banks put summary lines
 * above it. Needs a date column plus an amount-like column; else any row with 2+ known
 * columns; else the first non-empty row.
 * @param {string[][]} rows non-blank rows (cells only)
 * @returns {number} index into `rows`, or -1 when there are no rows
 */
export function detectHeaderRow(rows) {
  const scan = rows.slice(0, HEADER_SCAN_ROWS);
  if (scan.length === 0) return -1;
  const strict = scan.findIndex((cells) => {
    const f = matchedFields(cells);
    return f.has('date') && (f.has('amount') || f.has('debit') || f.has('credit'));
  });
  if (strict !== -1) return strict;
  const loose = scan.findIndex((cells) => matchedFields(cells).size >= 2);
  return loose !== -1 ? loose : 0;
}

/**
 * Parse CSV text into a table. `line` numbers count rows in the file starting at 1.
 * @param {string} rawText
 * @returns {{ delimiter: string, headers: string[], headerLine: number,
 *   rows: { line: number, cells: string[] }[] }}
 * @throws {CsvImportError}
 */
export function parseCsvTable(rawText) {
  const text = readCsvText(rawText);
  const delimiter = detectDelimiter(text);
  const all = [];
  for (const [i, cells] of parseWith(text, delimiter).entries()) {
    if (cells.length > MAX_COLUMNS) {
      throw new CsvImportError(
        'too_many_columns',
        `That file has more than ${MAX_COLUMNS} columns, so it does not look like a list of transactions. Export just your transactions as CSV and try again.`,
      );
    }
    if (!isBlankRow(cells)) all.push({ line: i + 1, cells: cells.map((c) => String(c ?? '').trim()) });
  }
  const headerIdx = detectHeaderRow(all.map((r) => r.cells));
  if (headerIdx === -1) {
    throw new CsvImportError('empty', 'We could not find any transactions in that file.');
  }
  const header = all[headerIdx];
  const rows = all.slice(headerIdx + 1);
  if (rows.length === 0) {
    throw new CsvImportError('no_rows', 'We could not find any transactions in that file.');
  }
  if (rows.length > MAX_DATA_ROWS) {
    throw new CsvImportError(
      'too_many_rows',
      'That file has more than 5,000 transactions. Split it into smaller files and import them one at a time.',
    );
  }
  return { delimiter, headers: header.cells, headerLine: header.line, rows };
}

// --- Format and mapping ------------------------------------------------------

function pickColumn(normalized, field, taken) {
  for (const alias of FIELD_ALIASES[field]) {
    const idx = normalized.findIndex((h, i) => h === alias && !taken.has(i));
    if (idx !== -1) {
      taken.add(idx);
      return idx;
    }
  }
  return null;
}

/**
 * Guess whether spending is shown as negative or positive numbers from the amounts.
 * Spending is the default negative convention; positive only when positives clearly dominate.
 * @param {string[][]} dataCells rows of cells
 * @param {number|null} amountIdx
 * @returns {'negative'|'positive'}
 */
export function suggestExpensesAre(dataCells, amountIdx) {
  if (amountIdx === null || amountIdx === undefined) return 'negative';
  let neg = 0;
  let pos = 0;
  for (const cells of dataCells) {
    const n = parseMoney(cells[amountIdx]);
    if (Number.isNaN(n) || n === 0) continue;
    if (n < 0) neg += 1;
    else pos += 1;
  }
  return pos > neg * 1.5 && pos > 0 ? 'positive' : 'negative';
}

/**
 * Suggest a column mapping and format from the header names.
 * Mapping values are column indexes (or null). `mode` is 'single' (one amount column)
 * or 'split' (separate money out / money in columns).
 * @param {string[]} headers
 * @param {string[][]} [dataCells] data rows, used only to guess the sign convention
 * @returns {{ id: 'chase'|'bofa'|'split'|'generic', name: string, recognized: boolean,
 *   mapping: { mode: 'single'|'split', date: number|null, merchant: number|null,
 *     amount: number|null, debit: number|null, credit: number|null, category: number|null },
 *   expensesAre: 'negative'|'positive' }}
 */
export function detectFormat(headers, dataCells = []) {
  const normalized = headers.map(normalizeHeader);
  const taken = new Set();
  const date = pickColumn(normalized, 'date', taken);
  const merchant = pickColumn(normalized, 'merchant', taken);
  const debit = pickColumn(normalized, 'debit', taken);
  const credit = pickColumn(normalized, 'credit', taken);
  const amount = pickColumn(normalized, 'amount', taken);
  const category = pickColumn(normalized, 'category', taken);
  const mode = debit !== null && credit !== null && amount === null ? 'split' : 'single';

  const has = (h) => normalized.includes(h);
  let id = 'generic';
  let name = 'a standard transactions file';
  let recognized = false;
  if (
    (has('transaction date') && has('post date') && has('description') && has('amount')) ||
    (has('details') && has('posting date') && has('description') && has('amount') && (has('balance') || has('check or slip')))
  ) {
    id = 'chase';
    name = 'Chase';
    recognized = true;
  } else if (has('date') && has('description') && has('amount') && has('running bal')) {
    id = 'bofa';
    name = 'Bank of America';
    recognized = true;
  } else if (mode === 'split') {
    id = 'split';
    name = 'a file with separate money out and money in columns';
  }

  const expensesAre =
    id === 'chase' || id === 'bofa' || mode === 'split' ? 'negative' : suggestExpensesAre(dataCells, amount);
  return {
    id,
    name,
    recognized,
    mapping: { mode, date, merchant, amount, debit, credit, category },
    expensesAre,
  };
}

// --- Money -------------------------------------------------------------------

/**
 * Parse a money cell to a number (NaN when it has no number). Understands $1,234.56,
 * (12.00), 12.00 DR, and a decimal comma such as 12,50 or 1.234,56.
 * @param {unknown} raw
 * @returns {number}
 */
export function parseMoney(raw) {
  if (raw === null || raw === undefined) return NaN;
  let s = String(raw).trim().replace(/[−–—]/g, '-');
  if (s === '') return NaN;
  // Trailing minus ("12.50-").
  if (/^[\d.,\s$£€¥]+-$/.test(s)) s = `-${s.slice(0, -1)}`;
  // Decimal comma: 1.234,56 or 12,5 or 12,50 (a comma followed by 1 or 2 digits at the end).
  const body = s.replace(/[$£€¥\s]/g, '').replace(/^[-+(]+|\)$/g, '');
  if (/^\d{1,3}(\.\d{3})*,\d{1,2}$/.test(body) || /^\d+,\d{1,2}$/.test(body)) {
    s = s.replace(/\./g, '').replace(',', '.');
  }
  const n = parseAmount(s);
  // parseAmount only accepts plain decimals; also reject absurd sizes.
  if (!Number.isFinite(n) || Math.abs(n) > MAX_ABS_AMOUNT) return NaN;
  return Math.round(n * 100) / 100;
}

// --- Dates -------------------------------------------------------------------

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const pad2 = (n) => String(n).padStart(2, '0');

function validIso(year, month, day) {
  let y = year;
  if (y < 100) y += y < 70 ? 2000 : 1900;
  if (y < 1900 || y > 2100 || month < 1 || month > 12 || day < 1) return null;
  const d = new Date(Date.UTC(y, month - 1, day));
  if (d.getUTCFullYear() !== y || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${y}-${pad2(month)}-${pad2(day)}`;
}

// Break a date cell into a structure without deciding day/month order.
//   { kind: 'ymd', y, m, d }       unambiguous (ISO, year first, month names)
//   { kind: 'numeric', a, b, y }   two numbers then a year; order unknown
function splitDate(raw) {
  let s = String(raw ?? '').trim();
  if (s === '' || s.length > MAX_DATE_CELL_CHARS) return null;
  // Drop a time part: "2026-05-01T10:00:00Z", "05/01/2026 10:30 AM".
  s = s.replace(/(?:[T\s]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s*[ap]m)?\s*(?:z|[+-]\d{2}:?\d{2})?)$/i, '').trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return { kind: 'ymd', y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return { kind: 'ymd', y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (m) return { kind: 'numeric', a: Number(m[1]), b: Number(m[2]), y: Number(m[3]) };
  m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3,9})\.?,?[\s-](\d{2}|\d{4})$/);
  if (m) {
    const month = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (month) return { kind: 'ymd', y: Number(m[3]), m: month, d: Number(m[1]) };
  }
  m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2}|\d{4})$/);
  if (m) {
    const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (month) return { kind: 'ymd', y: Number(m[3]), m: month, d: Number(m[2]) };
  }
  return null;
}

/**
 * Work out how a column writes its numeric dates, looking at ALL values.
 * Returns 'ymd' (nothing numeric to decide: ISO or month names), 'mdy', 'dmy',
 * 'ambiguous' (every numeric value has both parts 12 or less: ask the user) or
 * 'mixed' (some values prove day-first and others month-first).
 * @param {string[]} values
 * @returns {'ymd'|'mdy'|'dmy'|'ambiguous'|'mixed'}
 */
export function detectDateOrder(values) {
  let numeric = 0;
  let firstOver = false;
  let secondOver = false;
  for (const v of values) {
    const p = splitDate(v);
    if (!p || p.kind !== 'numeric') continue;
    numeric += 1;
    if (p.a > 12) firstOver = true;
    if (p.b > 12) secondOver = true;
  }
  if (numeric === 0) return 'ymd';
  if (firstOver && secondOver) return 'mixed';
  if (firstOver) return 'dmy';
  if (secondOver) return 'mdy';
  return 'ambiguous';
}

/**
 * The order to parse with, given what was detected and what the user chose.
 * Ambiguous and mixed files default to month first.
 * @param {'ymd'|'mdy'|'dmy'|'ambiguous'|'mixed'} detected
 * @param {'mdy'|'dmy'|null} [choice]
 * @returns {'ymd'|'mdy'|'dmy'}
 */
export function effectiveDateOrder(detected, choice = null) {
  if (detected === 'ambiguous') return choice === 'dmy' ? 'dmy' : 'mdy';
  if (detected === 'mixed') return 'mdy';
  return detected;
}

/**
 * Parse one date cell to YYYY-MM-DD, or null when it is not a real calendar date.
 * @param {unknown} raw
 * @param {'ymd'|'mdy'|'dmy'|'ambiguous'|'mixed'} [order]
 * @returns {string|null}
 */
export function parseDateValue(raw, order = 'mdy') {
  const p = splitDate(raw);
  if (!p) return null;
  if (p.kind === 'ymd') return validIso(p.y, p.m, p.d);
  const eff = effectiveDateOrder(order === 'ymd' ? 'mdy' : order);
  return eff === 'dmy' ? validIso(p.y, p.b, p.a) : validIso(p.y, p.a, p.b);
}

/** "March 4, 2026" for an ISO date, or '' when invalid. */
export function formatLongDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
  if (!m) return '';
  return `${MONTH_NAMES[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

/**
 * Examples for the "How are dates written?" question, built from a real value in the file.
 * @param {string[]} values
 * @returns {{ sample: string, mdy: string, dmy: string } | null} `mdy` / `dmy` are long dates
 */
export function dateOrderExamples(values) {
  let sample = null;
  for (const v of values) {
    const p = splitDate(v);
    if (!p || p.kind !== 'numeric') continue;
    if (!sample) sample = String(v).trim();
    if (p.a !== p.b) {
      sample = String(v).trim();
      break;
    }
  }
  if (!sample) return null;
  return {
    sample,
    mdy: formatLongDate(parseDateValue(sample, 'mdy')),
    dmy: formatLongDate(parseDateValue(sample, 'dmy')),
  };
}

// --- Categories --------------------------------------------------------------

const CATEGORY_NAME_BY_ID = new Map(CATEGORIES.map((c) => [c.id, c.name]));

/**
 * Rule-based category (no AI): credits are 'Income'; debits use the budget's merchant
 * rules and give that category's name, or 'Other' when nothing matches.
 * @param {{ merchant: string, type: 'debit'|'credit' }} t
 * @returns {string}
 */
export function autoCategory({ merchant, type }) {
  if (type === 'credit') return 'Income';
  const result = categorizeTransaction({ merchant, category: '', type });
  if (result.confidence === 'fallback') return 'Other';
  return CATEGORY_NAME_BY_ID.get(result.subcategoryId) ?? 'Other';
}

// --- Build rows --------------------------------------------------------------

// Mirrors the server: control characters become spaces, then whitespace is collapsed.
// eslint-disable-next-line no-control-regex
const cleanText = (v) => String(v ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Turn a parsed table into import rows using the user's column choices.
 * @param {{ rows: { line: number, cells: string[] }[] }} table from parseCsvTable
 * @param {{ mode?: 'single'|'split', date: number|null, merchant: number|null,
 *   amount?: number|null, debit?: number|null, credit?: number|null,
 *   category?: number|null }} mapping column indexes
 * @param {{ dateOrder?: 'ymd'|'mdy'|'dmy'|'ambiguous'|'mixed',
 *   expensesAre?: 'negative'|'positive' }} [options]
 * @returns {{ rows: { line: number, date: string, merchant: string, amount: number,
 *     category: string, type: 'debit'|'credit' }[],
 *   bad: { line: number, reason: string }[] }}
 */
export function buildRows(table, mapping, { dateOrder = 'mdy', expensesAre = 'negative' } = {}) {
  const rows = [];
  const bad = [];
  const split = mapping.mode === 'split';
  const cell = (cells, idx) => (idx === null || idx === undefined ? '' : String(cells[idx] ?? '').trim());

  for (const { line, cells } of table.rows) {
    const rawDate = cell(cells, mapping.date);
    if (rawDate === '') {
      bad.push({ line, reason: 'The date is missing' });
      continue;
    }
    const date = parseDateValue(rawDate, dateOrder);
    if (!date) {
      bad.push({ line, reason: 'The date could not be read' });
      continue;
    }

    const merchant = cleanText(cell(cells, mapping.merchant)).slice(0, MAX_MERCHANT_CHARS);
    if (merchant === '') {
      bad.push({ line, reason: 'The description is missing' });
      continue;
    }

    let amount;
    if (split) {
      const rawOut = cell(cells, mapping.debit);
      const rawIn = cell(cells, mapping.credit);
      if (rawOut === '' && rawIn === '') {
        bad.push({ line, reason: 'The amount is missing' });
        continue;
      }
      const out = rawOut === '' ? 0 : parseMoney(rawOut);
      const inn = rawIn === '' ? 0 : parseMoney(rawIn);
      if (Number.isNaN(out) || Number.isNaN(inn)) {
        bad.push({ line, reason: 'The amount could not be read' });
        continue;
      }
      if (out !== 0 && inn !== 0) {
        bad.push({ line, reason: 'Both money out and money in are filled in' });
        continue;
      }
      amount = out !== 0 ? -Math.abs(out) : Math.abs(inn);
    } else {
      const rawAmount = cell(cells, mapping.amount);
      if (rawAmount === '') {
        bad.push({ line, reason: 'The amount is missing' });
        continue;
      }
      const n = parseMoney(rawAmount);
      if (Number.isNaN(n)) {
        bad.push({ line, reason: 'The amount could not be read' });
        continue;
      }
      amount = expensesAre === 'positive' ? -n : n;
    }
    if (amount === 0 || Object.is(amount, -0)) {
      bad.push({ line, reason: 'The amount is zero' });
      continue;
    }

    const type = amount < 0 ? 'debit' : 'credit';
    const given = cleanText(cell(cells, mapping.category)).slice(0, MAX_CATEGORY_CHARS);
    const category = given || autoCategory({ merchant, type });
    rows.push({ line, date, merchant, amount, category, type });
  }
  return { rows, bad };
}

/**
 * The request body rows for POST /api/transactions/import.
 * @param {{ date: string, merchant: string, amount: number, category: string }[]} rows
 */
export function toImportPayload(rows) {
  return rows.map(({ date, merchant, amount, category }) => ({ date, merchant, amount, category }));
}

/** Values of the date column across all data rows (for detectDateOrder). */
export function columnValues(table, idx) {
  if (idx === null || idx === undefined) return [];
  return table.rows.map((r) => r.cells[idx] ?? '').filter((v) => v !== '');
}
