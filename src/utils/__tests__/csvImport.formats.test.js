import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildRows,
  CsvImportError,
  dateOrderExamples,
  detectDateOrder,
  detectDelimiter,
  detectFormat,
  effectiveDateOrder,
  MAX_DATA_ROWS,
  MAX_TEXT_CHARS,
  parseCsvTable,
  parseDateValue,
  readCsvFile,
  readCsvText,
  suggestExpensesAre,
  toImportPayload,
} from '../csvImport';

// Synthetic fixtures only.
const CHASE = [
  'Transaction Date,Post Date,Description,Category,Type,Amount,Memo',
  '05/01/2026,05/02/2026,Corner Grocery,Groceries,Sale,-42.17,',
  '05/03/2026,05/04/2026,Coffee Shop,Food & Drink,Sale,-4.50,',
  '05/05/2026,05/05/2026,Employer Payroll,,Payment,2500.00,',
].join('\n');

const BOFA = [
  'Description,,Summary Amt.',
  'Beginning balance as of 05/01/2026,,"1,000.00"',
  'Total credits,,"2,500.00"',
  'Total debits,,"-46.67"',
  'Ending balance as of 05/31/2026,,"3,453.33"',
  '',
  'Date,Description,Amount,Running Bal.',
  '05/01/2026,Corner Grocery,-42.17,"957.83"',
  '05/03/2026,Coffee Shop,-4.50,"953.33"',
  '05/05/2026,Employer Payroll,"2,500.00","3,453.33"',
  '',
].join('\n');

const run = (csv, opts) => {
  const table = parseCsvTable(csv);
  const fmt = detectFormat(
    table.headers,
    table.rows.map((r) => r.cells),
  );
  const order = detectDateOrder(table.rows.map((r) => r.cells[fmt.mapping.date]));
  const built = buildRows(table, fmt.mapping, {
    dateOrder: order,
    expensesAre: fmt.expensesAre,
    ...opts,
  });
  return { table, fmt, order, ...built };
};

const catchErr = (fn) => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
};

afterEach(() => vi.unstubAllGlobals());

describe('format detection and parsing', () => {
  it('Chase-like: recognized, spending negative, category column wins', () => {
    const { fmt, rows, bad, order } = run(CHASE);
    expect(fmt).toMatchObject({ id: 'chase', name: 'Chase', recognized: true, expensesAre: 'negative' });
    expect(fmt.mapping).toMatchObject({ mode: 'single', date: 0, merchant: 2, amount: 5, category: 3 });
    expect(order).toBe('ambiguous');
    expect(bad).toEqual([]);
    expect(rows.map((r) => [r.date, r.merchant, r.amount, r.category])).toEqual([
      ['2026-05-01', 'Corner Grocery', -42.17, 'Groceries'],
      ['2026-05-03', 'Coffee Shop', -4.5, 'Food & Drink'],
      ['2026-05-05', 'Employer Payroll', 2500, 'Income'],
    ]);
  });

  it('Bank of America-like: skips the summary block and trailing blank line', () => {
    const { table, fmt, rows, bad } = run(BOFA);
    expect(table.headers).toEqual(['Date', 'Description', 'Amount', 'Running Bal.']);
    expect(table.headerLine).toBe(7);
    expect(table.rows.map((r) => r.line)).toEqual([8, 9, 10]);
    expect(fmt).toMatchObject({ id: 'bofa', name: 'Bank of America', recognized: true });
    expect(bad).toEqual([]);
    expect(rows.map((r) => r.amount)).toEqual([-42.17, -4.5, 2500]);
  });

  it('generic Debit/Credit columns use split mode', () => {
    const { fmt, rows } = run(
      'Date,Description,Debit,Credit\n2026-05-01,City Water,60.25,\n2026-05-02,Employer Payroll,,1800\n',
    );
    expect(fmt).toMatchObject({ id: 'split', recognized: false, expensesAre: 'negative' });
    expect(fmt.mapping).toMatchObject({ mode: 'split', debit: 2, credit: 3, amount: null });
    expect(rows.map((r) => [r.amount, r.type])).toEqual([
      [-60.25, 'debit'],
      [1800, 'credit'],
    ]);
  });

  it('Money out / Money in variant is also split', () => {
    const { fmt, rows } = run(
      'Date,Details,Money out,Money in\n2026-05-01,City Water,12.00,\n2026-05-09,Refund,,3.5\n',
    );
    expect(fmt.mapping).toMatchObject({ mode: 'split', merchant: 1, debit: 2, credit: 3 });
    expect(rows.map((r) => r.amount)).toEqual([-12, 3.5]);
  });

  it('generic single-amount file is "a standard transactions file"', () => {
    const { fmt } = run('Date,Description,Amount\n2026-05-01,Coffee Shop,-3\n');
    expect(fmt).toMatchObject({ id: 'generic', recognized: false, name: 'a standard transactions file' });
  });

  it('semicolon-delimited with decimal-comma amounts', () => {
    const csv =
      'Date;Description;Amount\n01.05.2026;Corner Grocery;-12,50\n13.05.2026;Employer Payroll;"1.234,56"\n';
    const { table, rows, order } = run(csv);
    expect(table.delimiter).toBe(';');
    expect(order).toBe('dmy');
    expect(rows.map((r) => [r.date, r.amount])).toEqual([
      ['2026-05-01', -12.5],
      ['2026-05-13', 1234.56],
    ]);
  });

  it('tab-delimited', () => {
    const csv = 'Date\tDescription\tAmount\n2026-05-01\tCoffee Shop\t-4.50\n2026-05-02\tCorner Grocery\t-9.99\n';
    const { table, rows } = run(csv);
    expect(table.delimiter).toBe('\t');
    expect(rows).toHaveLength(2);
  });

  it('quoted commas, escaped quotes and an embedded newline stay in one field', () => {
    const csv =
      'Date,Description,Amount\n2026-05-01,"Coffee Shop, Main St",-4.50\n2026-05-02,"The ""Corner"" Grocery",-9.00\n2026-05-03,"Line one\nline two",-1.00\n2026-05-04,After,-2.00\n';
    const { table, rows, bad } = run(csv);
    expect(bad).toEqual([]);
    expect(table.rows).toHaveLength(4);
    expect(rows.map((r) => r.merchant)).toEqual([
      'Coffee Shop, Main St',
      'The "Corner" Grocery',
      'Line one line two',
      'After',
    ]);
  });

  it('handles a UTF-8 BOM, CRLF and lone CR line endings', () => {
    const body = ['Date,Description,Amount', '2026-05-01,Coffee Shop,-4.50', '2026-05-02,Corner Grocery,-9.00'];
    for (const eol of ['\r\n', '\r', '\n']) {
      const { table, rows } = run(`\uFEFF${body.join(eol)}${eol}`);
      expect(table.headers).toEqual(['Date', 'Description', 'Amount']);
      expect(rows).toHaveLength(2);
    }
    expect(readCsvText('﻿a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('ignores blank lines in the middle and at the end, keeping file line numbers', () => {
    const t = parseCsvTable('Date,Description,Amount\n\n2026-05-01,A,-1\n\n\n2026-05-02,B,-2\n\n\n');
    expect(t.rows.map((r) => r.line)).toEqual([3, 6]);
  });

  it('reports bad rows with line numbers and plain reasons while good rows still parse', () => {
    const csv = [
      'Date,Description,Amount',
      '2026-05-01,Coffee Shop,-4.50',
      'sometime soon,Corner Grocery,-9.00',
      '2026-05-03,City Water,',
      '2026-05-04,Employer Payroll,0.00',
      '2026-05-05,Corner Grocery,-1.25',
      '2026-05-06,Coffee Shop,abc',
    ].join('\n');
    const { rows, bad } = run(csv);
    expect(rows.map((r) => r.line)).toEqual([2, 6]);
    expect(bad).toEqual([
      { line: 3, reason: 'The date could not be read' },
      { line: 4, reason: 'The amount is missing' },
      { line: 5, reason: 'The amount is zero' },
      { line: 7, reason: 'The amount could not be read' },
    ]);
  });

  it('reports a missing date and rows with both debit and credit', () => {
    const csv =
      'Date,Description,Debit,Credit\n,Coffee Shop,5,\n2026-05-02,City Water,5,5\n2026-05-03,Corner Grocery,,\n2026-05-04,Fine,2,\n';
    const { rows, bad } = run(csv);
    expect(rows.map((r) => r.merchant)).toEqual(['Fine']);
    expect(bad).toEqual([
      { line: 2, reason: 'The date is missing' },
      { line: 3, reason: 'Both money out and money in are filled in' },
      { line: 4, reason: 'The amount is missing' },
    ]);
  });

  it('positive-expenses convention is suggested and flips signs', () => {
    const csv =
      'Date,Description,Amount\n2026-05-01,Coffee Shop,4.50\n2026-05-02,Corner Grocery,9.00\n2026-05-03,Refund,-3.00\n2026-05-04,City Water,60\n';
    const { fmt, rows } = run(csv);
    expect(fmt.expensesAre).toBe('positive');
    expect(rows.map((r) => [r.amount, r.type])).toEqual([
      [-4.5, 'debit'],
      [-9, 'debit'],
      [3, 'credit'],
      [-60, 'debit'],
    ]);
  });

  it('suggestExpensesAre defaults to negative without an amount column or with mostly negatives', () => {
    expect(suggestExpensesAre([['1']], null)).toBe('negative');
    expect(suggestExpensesAre([['-1'], ['-2'], ['5']], 0)).toBe('negative');
    expect(suggestExpensesAre([], 0)).toBe('negative');
  });

  it('toImportPayload keeps only the four server fields', () => {
    const { rows } = run(CHASE);
    const payload = toImportPayload(rows);
    expect(payload).toHaveLength(3);
    for (const p of payload) expect(Object.keys(p).sort()).toEqual(['amount', 'category', 'date', 'merchant']);
  });

  it('truncates long merchants to 200 characters', () => {
    const { rows } = run(`Date,Description,Amount\n2026-05-01,${'x'.repeat(500)},-1\n`);
    expect(rows[0].merchant).toHaveLength(200);
  });
});

describe('limits and unreadable input', () => {
  it('rejects empty and whitespace-only text', () => {
    for (const t of ['', '   \n\t ', null, undefined]) {
      const err = catchErr(() => parseCsvTable(t));
      expect(err).toBeInstanceOf(CsvImportError);
      expect(err.code).toBe('empty');
    }
  });

  it('rejects text over the size limit', () => {
    expect(catchErr(() => readCsvText('a'.repeat(MAX_TEXT_CHARS + 1))).code).toBe('too_large');
    expect(() => readCsvText('a'.repeat(MAX_TEXT_CHARS))).not.toThrow();
  });

  it('rejects more than 5000 rows but accepts exactly 5000', () => {
    const mk = (n) => `Date,Description,Amount\n${'2026-01-01,A,-1\n'.repeat(n)}`;
    expect(parseCsvTable(mk(MAX_DATA_ROWS)).rows).toHaveLength(MAX_DATA_ROWS);
    const err = catchErr(() => parseCsvTable(mk(MAX_DATA_ROWS + 1)));
    expect(err).toBeInstanceOf(CsvImportError);
    expect(err.code).toBe('too_many_rows');
    expect(err.message).toMatch(/5,000/);
  });

  it('rejects NUL bytes as not text', () => {
    const err = catchErr(() => parseCsvTable('Date,Description\u0000,Amount\n1,2,3'));
    expect(err).toBeInstanceOf(CsvImportError);
    expect(err.code).toBe('not_text');
  });

  it('rejects a header with no data rows', () => {
    expect(catchErr(() => parseCsvTable('Date,Description,Amount\n')).code).toBe('no_rows');
  });

  it('readCsvFile rejects non-CSV, empty and oversized files and reads CSV text', async () => {
    await expect(readCsvFile(new File(['x'], 'photo.png', { type: 'image/png' }))).rejects.toMatchObject({
      code: 'not_csv',
    });
    await expect(readCsvFile(null)).rejects.toMatchObject({ code: 'empty' });
    await expect(readCsvFile(new File([], 'empty.csv', { type: 'text/csv' }))).rejects.toMatchObject({
      code: 'empty',
    });
    await expect(
      readCsvFile({ name: 'big.csv', type: 'text/csv', size: MAX_TEXT_CHARS + 1 }),
    ).rejects.toMatchObject({ code: 'too_large' });
    await expect(readCsvFile(new File(['a,b\n1,2'], 'ok.CSV', { type: '' }))).resolves.toBe('a,b\n1,2');
    await expect(readCsvFile(new File(['a,b'], 'ok.txt', { type: 'text/plain' }))).resolves.toBe('a,b');
  });

  it('detectDelimiter falls back to a comma for single-column text', () => {
    expect(detectDelimiter('hello\nworld')).toBe(',');
    expect(detectDelimiter('')).toBe(',');
  });
});

describe('dates', () => {
  it('parses ISO with a time part and other ymd forms', () => {
    expect(parseDateValue('2026-05-01T10:00:00Z', 'ymd')).toBe('2026-05-01');
    expect(parseDateValue('2026-05-01 23:59:59')).toBe('2026-05-01');
    expect(parseDateValue('2026/5/1')).toBe('2026-05-01');
    expect(parseDateValue('20260501')).toBe('2026-05-01');
    expect(parseDateValue('05/01/2026 10:30 AM', 'mdy')).toBe('2026-05-01');
  });

  it('M/D/Y and D/M/Y give different correct results for the same text', () => {
    expect(parseDateValue('03/04/2026', 'mdy')).toBe('2026-03-04');
    expect(parseDateValue('03/04/2026', 'dmy')).toBe('2026-04-03');
  });

  it('auto-detects D/M/Y when a day above 12 appears, and M/D/Y likewise', () => {
    expect(detectDateOrder(['03/04/2026', '25/04/2026'])).toBe('dmy');
    expect(detectDateOrder(['03/04/2026', '04/25/2026'])).toBe('mdy');
    const { rows } = run('Date,Description,Amount\n03/04/2026,Coffee Shop,-1\n25/04/2026,Corner Grocery,-2\n');
    expect(rows.map((r) => r.date)).toEqual(['2026-04-03', '2026-04-25']);
  });

  it('all-ambiguous files need a choice and each choice gives a different correct date', () => {
    const csv = 'Date,Description,Amount\n03/04/2026,Coffee Shop,-1\n05/06/2026,Corner Grocery,-2\n';
    const { table, fmt } = run(csv);
    const detected = detectDateOrder(table.rows.map((r) => r.cells[0]));
    expect(detected).toBe('ambiguous');
    const us = buildRows(table, fmt.mapping, { dateOrder: effectiveDateOrder(detected, 'mdy') });
    const eu = buildRows(table, fmt.mapping, { dateOrder: effectiveDateOrder(detected, 'dmy') });
    expect(us.rows.map((r) => r.date)).toEqual(['2026-03-04', '2026-05-06']);
    expect(eu.rows.map((r) => r.date)).toEqual(['2026-04-03', '2026-06-05']);
    expect(effectiveDateOrder(detected, null)).toBe('mdy');
  });

  it('mixed files are detected and default to month first (non-fitting rows go to bad)', () => {
    expect(detectDateOrder(['13/01/2026', '01/13/2026'])).toBe('mixed');
    expect(effectiveDateOrder('mixed', 'dmy')).toBe('mdy');
    const csv = 'Date,Description,Amount\n13/01/2026,Coffee Shop,-1\n01/13/2026,Corner Grocery,-2\n';
    const { rows, bad } = run(csv);
    expect(rows.map((r) => r.date)).toEqual(['2026-01-13']);
    expect(bad).toEqual([{ line: 2, reason: 'The date could not be read' }]);
  });

  it('invalid calendar dates become bad rows', () => {
    expect(parseDateValue('02/30/2026', 'mdy')).toBeNull();
    expect(parseDateValue('29/02/2026', 'dmy')).toBeNull();
    expect(parseDateValue('2026-02-29')).toBeNull();
    expect(parseDateValue('02/29/2028', 'mdy')).toBe('2028-02-29');
    expect(parseDateValue('2026-13-01')).toBeNull();
    expect(parseDateValue('2026-00-10')).toBeNull();
    const { rows, bad } = run('Date,Description,Amount\n02/29/2026,A,-1\n02/28/2026,B,-1\n');
    expect(rows).toHaveLength(1);
    expect(bad).toEqual([{ line: 2, reason: 'The date could not be read' }]);
  });

  it('two-digit years pivot at 70', () => {
    expect(parseDateValue('03/04/26', 'mdy')).toBe('2026-03-04');
    expect(parseDateValue('03/04/69', 'mdy')).toBe('2069-03-04');
    expect(parseDateValue('03/04/70', 'mdy')).toBe('1970-03-04');
    expect(parseDateValue('3-Apr-26')).toBe('2026-04-03');
  });

  it('reads month names in both orders', () => {
    expect(parseDateValue('01-May-2026')).toBe('2026-05-01');
    expect(parseDateValue('1 September 2026')).toBe('2026-09-01');
    expect(parseDateValue('May 1, 2026')).toBe('2026-05-01');
    expect(parseDateValue('Sept 3rd, 2026')).toBe('2026-09-03');
    expect(parseDateValue('Foo 1, 2026')).toBeNull();
    expect(detectDateOrder(['May 1, 2026', '2 Jun 2026'])).toBe('ymd');
  });

  it('rejects junk and blanks', () => {
    for (const v of ['', '   ', null, 'yesterday', '12', '1/2']) expect(parseDateValue(v)).toBeNull();
  });

  it('dateOrderExamples builds both readings from a real value, preferring a day != month sample', () => {
    expect(dateOrderExamples(['03/03/2026', '03/04/2026'])).toEqual({
      sample: '03/04/2026',
      mdy: 'March 4, 2026',
      dmy: 'April 3, 2026',
    });
    expect(dateOrderExamples(['05/05/2026'])).toMatchObject({
      sample: '05/05/2026',
      mdy: 'May 5, 2026',
      dmy: 'May 5, 2026',
    });
    expect(dateOrderExamples(['2026-05-01'])).toBeNull();
    expect(dateOrderExamples([])).toBeNull();
  });
});

describe('no network is involved in parsing', () => {
  it('never calls fetch while parsing and categorizing', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    run(CHASE);
    run(BOFA);
    run('Date,Description,Amount\n2026-05-01,Mystery Vendor,-5\n');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
