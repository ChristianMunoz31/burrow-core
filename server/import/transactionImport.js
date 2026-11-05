// Pure helpers plus the single-transaction writer behind POST /api/transactions/import.
// Amounts are signed (negative = money out), matching how POST /api/transactions stores them.
import { withTransaction } from '../db/index.js';
import { insertMany, op, select } from '../db/query.js';

export const MAX_IMPORT_ROWS = 5000;
export const IMPORT_SOURCES = Object.freeze(['file', 'sheet']);
const MAX_DETAILS = 20;
const MAX_MERCHANT = 200;
const MAX_CATEGORY = 60;
const MAX_FILE_NAME = 120;
const MAX_ABS_AMOUNT = 1e9;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Lowercased, Unicode-folded merchant with every run of non letters/digits collapsed to one space. */
export function normalizeMerchant(s) {
  return String(s).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** @param {number} amount signed amount in dollars @returns {number} integer cents */
export const toCents = (amount) => Math.round(amount * 100);

/** Dedupe key: date + signed integer cents + normalized merchant. */
export function dedupeKey({ date, amount, merchant }) {
  return `${date}|${toCents(Number(amount))}|${normalizeMerchant(merchant)}`;
}

/** True for a real calendar date in YYYY-MM-DD form, year 1900..2100. */
export function isRealDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (y < 1900 || y > 2100) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const cleanText = (v) => v.replace(CONTROL_CHARS, ' ').replace(/ {2,}/g, ' ').trim();

/** Basename only, no path separators or control characters; '' when nothing usable remains. */
export function cleanFileName(name) {
  if (typeof name !== 'string') return '';
  const base = name.split(/[\\/]/).pop() ?? '';
  return base.replace(CONTROL_CHARS, '').trim();
}

/** Thrown for any request the importer refuses; carries the HTTP status and the error envelope. */
export class TransactionImportError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Strict validation of the request body. Rejects the whole batch on the first bad request shape or
 * any bad row. Unknown keys on rows are dropped.
 * @param {unknown} body
 * @returns {{ rows: Array<{date: string, merchant: string, amount: number, category: string}>, source: string, fileName: string }}
 */
export function validateImportBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.rows)) {
    throw new TransactionImportError(400, 'invalid_request', 'Send the transactions to import as a list of rows.');
  }
  if (!IMPORT_SOURCES.includes(body.source)) {
    throw new TransactionImportError(400, 'invalid_request', 'Say whether the rows came from a file or a sheet.');
  }
  if (body.fileName !== undefined && body.fileName !== null && typeof body.fileName !== 'string') {
    throw new TransactionImportError(400, 'invalid_request', 'The file name must be text.');
  }
  if (typeof body.fileName === 'string' && body.fileName.length > MAX_FILE_NAME) {
    throw new TransactionImportError(400, 'invalid_request', 'The file name is too long.');
  }
  if (body.rows.length === 0) {
    throw new TransactionImportError(400, 'invalid_request', 'There are no transactions to import.');
  }
  if (body.rows.length > MAX_IMPORT_ROWS) {
    throw new TransactionImportError(
      413,
      'too_many_rows',
      `You can import up to ${MAX_IMPORT_ROWS} transactions at a time. Split the file and try again.`,
    );
  }

  const rows = [];
  const details = [];
  const bad = (index, field) => {
    if (details.length < MAX_DETAILS) details.push({ index, field });
  };
  let invalid = false;
  body.rows.forEach((raw, index) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      invalid = true;
      bad(index, 'row');
      return;
    }
    let ok = true;
    const fail = (field) => {
      ok = false;
      invalid = true;
      bad(index, field);
    };
    if (!isRealDate(raw.date)) fail('date');
    const merchant = typeof raw.merchant === 'string' ? cleanText(raw.merchant) : '';
    if (merchant.length < 1 || merchant.length > MAX_MERCHANT) fail('merchant');
    let amount = NaN;
    if (typeof raw.amount === 'number' && Number.isFinite(raw.amount) && Math.abs(raw.amount) <= MAX_ABS_AMOUNT) {
      amount = toCents(raw.amount) / 100;
    }
    if (!Number.isFinite(amount) || amount === 0) fail('amount');
    const category = typeof raw.category === 'string' ? cleanText(raw.category) : '';
    if (category.length < 1 || category.length > MAX_CATEGORY) fail('category');
    if (ok) rows.push({ date: raw.date, merchant, amount, category });
  });
  if (invalid) {
    throw new TransactionImportError(
      400,
      'invalid_rows',
      'Some rows could not be read. Check the highlighted rows and try again.',
      details,
    );
  }
  const fileName = cleanFileName(body.fileName);
  return { rows, source: body.source, fileName };
}

/**
 * Marks which batch rows already exist, with multiset semantics per dedupe key: the first
 * `countInDb` batch occurrences are duplicates, the rest are new.
 * @param {Array<{date: string, merchant: string, amount: number}>} rows
 * @param {Array<{date: string, merchant: string, amount: number|string}>} existing
 * @returns {number[]} indexes into rows that are duplicates
 */
export function findDuplicateIndexes(rows, existing) {
  const remaining = new Map();
  for (const e of existing) {
    const k = dedupeKey(e);
    remaining.set(k, (remaining.get(k) ?? 0) + 1);
  }
  const dupes = [];
  rows.forEach((r, i) => {
    const k = dedupeKey(r);
    const left = remaining.get(k) ?? 0;
    if (left > 0) {
      remaining.set(k, left - 1);
      dupes.push(i);
    }
  });
  return dupes;
}

/**
 * Validates, dedupes and (unless dryRun) inserts the rows inside ONE transaction. Any error rolls
 * everything back. Inserts go through `deps.insertMany` (defaults to server/db/query.js) so a test can
 * inject a function that fails part-way and prove nothing was written.
 * @param {{ body: unknown, dryRun?: boolean, db?: import('node:sqlite').DatabaseSync, deps?: { insertMany?: typeof insertMany } }} args
 * @returns {{ received: number, inserted: number, duplicates: number, duplicateIndexes: number[], dryRun: boolean, source: string }}
 */
export function importTransactions({ body, dryRun = false, db, deps = {} }) {
  const { rows, source, fileName } = validateImportBody(body);
  const write = deps.insertMany ?? insertMany;
  const sourceFile = fileName || (source === 'sheet' ? 'Google Sheet' : 'CSV import');
  const dates = rows.map((r) => r.date).sort();
  const first = dates[0];
  const last = dates[dates.length - 1];

  return withTransaction((tx) => {
    const existing = select('transactions', {
      columns: ['date', 'merchant', 'amount'],
      where: { date: op.and(op.gte(first), op.lte(last)) },
      db: tx,
    });
    const duplicateIndexes = findDuplicateIndexes(rows, existing);
    const skip = new Set(duplicateIndexes);
    const fresh = rows
      .filter((_, i) => !skip.has(i))
      .map((r) => ({
        date: r.date,
        merchant: r.merchant,
        amount: r.amount,
        category: r.category,
        type: r.amount < 0 ? 'debit' : 'credit',
        source_file: sourceFile,
      }));
    if (!dryRun && fresh.length > 0) write('transactions', fresh, { db: tx });
    return {
      received: rows.length,
      inserted: fresh.length,
      duplicates: duplicateIndexes.length,
      duplicateIndexes,
      dryRun,
      source,
    };
  }, db);
}
