import { describe, expect, it } from 'vitest';
import {
  buildRows,
  CsvImportError,
  detectDateOrder,
  detectDelimiter,
  detectFormat,
  MAX_DATA_ROWS,
  parseCsvTable,
  parseDateValue,
  parseMoney,
} from '../csvImport';

const BOFA = [
  'Description,,Summary Amt.',
  'Beginning balance as of 05/01/2026,,"1,000.00"',
  'Total credits,,"500.00"',
  '',
  'Date,Description,Amount,Running Bal.',
  '05/02/2026,"COFFEE SHOP, DOWNTOWN",-4.50,"995.50"',
  '05/13/2026,PAYROLL ACME,"2,000.00","2,995.50"',
].join('\r\n');

describe('parseCsvTable', () => {
  it('finds the real header below a bank preamble and keeps line numbers', () => {
    const t = parseCsvTable(`\uFEFF${BOFA}`);
    expect(t.headers).toEqual(['Date', 'Description', 'Amount', 'Running Bal.']);
    expect(t.headerLine).toBe(5);
    expect(t.rows.map((r) => r.line)).toEqual([6, 7]);
    expect(t.rows[0].cells[1]).toBe('COFFEE SHOP, DOWNTOWN');
  });

  it('rejects empty text and too many rows', () => {
    expect(() => parseCsvTable('  \n ')).toThrow(CsvImportError);
    const big = `Date,Description,Amount\n${'2026-01-01,A,-1\n'.repeat(MAX_DATA_ROWS + 1)}`;
    expect(() => parseCsvTable(big)).toThrow(/5,000/);
  });
});

describe('detectDelimiter', () => {
  it('detects semicolons, tabs and pipes, ignoring commas inside quotes', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
    expect(detectDelimiter('a|b|c\n1|2|3')).toBe('|');
    expect(detectDelimiter('a,b\n"x, y",2')).toBe(',');
  });
});

describe('detectFormat and buildRows', () => {
  it('recognizes Bank of America and signs amounts', () => {
    const t = parseCsvTable(BOFA);
    const f = detectFormat(t.headers);
    expect(f.id).toBe('bofa');
    const { rows, bad } = buildRows(t, f.mapping, { dateOrder: detectDateOrder(t.rows.map((r) => r.cells[0])) });
    expect(bad).toEqual([]);
    expect(rows.map((r) => [r.date, r.amount, r.type])).toEqual([
      ['2026-05-02', -4.5, 'debit'],
      ['2026-05-13', 2000, 'credit'],
    ]);
    expect(rows[1].category).toBe('Income');
  });

  it('recognizes Chase and uses its category column', () => {
    const csv =
      'Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n01/05/2026,01/06/2026,STORE,Groceries,Sale,-20.00,\n';
    const t = parseCsvTable(csv);
    const f = detectFormat(t.headers);
    expect(f.id).toBe('chase');
    const { rows } = buildRows(t, f.mapping, { dateOrder: 'mdy' });
    expect(rows[0]).toMatchObject({ date: '2026-01-05', category: 'Groceries', amount: -20 });
  });

  it('handles separate money out and money in columns and bad rows', () => {
    const csv = 'Date,Description,Debit,Credit\n2026-05-01,Rent,900.00,\n2026-05-02,Pay,,50\n2026-02-30,Bad,1,\n2026-05-03,Zero,0,\n2026-05-04,,5,\n';
    const t = parseCsvTable(csv);
    const f = detectFormat(t.headers);
    expect(f.mapping.mode).toBe('split');
    const { rows, bad } = buildRows(t, f.mapping, { dateOrder: 'ymd' });
    expect(rows.map((r) => r.amount)).toEqual([-900, 50]);
    expect(bad.map((b) => [b.line, b.reason])).toEqual([
      [4, 'The date could not be read'],
      [5, 'The amount is zero'],
      [6, 'The description is missing'],
    ]);
  });

  it('flips signs when spending is positive', () => {
    const t = parseCsvTable('Date,Description,Amount\n2026-05-01,Shop,12.50\n2026-05-02,Refund,-3\n');
    const { rows } = buildRows(t, detectFormat(t.headers).mapping, { dateOrder: 'ymd', expensesAre: 'positive' });
    expect(rows.map((r) => r.amount)).toEqual([-12.5, 3]);
  });
});

describe('dates', () => {
  it('detects the order over every value', () => {
    expect(detectDateOrder(['13/01/2026', '02/03/2026'])).toBe('dmy');
    expect(detectDateOrder(['01/13/2026', '02/03/2026'])).toBe('mdy');
    expect(detectDateOrder(['01/02/2026', '03/04/2026'])).toBe('ambiguous');
    expect(detectDateOrder(['13/01/2026', '01/13/2026'])).toBe('mixed');
    expect(detectDateOrder(['2026-01-02', '01-May-2026'])).toBe('ymd');
  });

  it('parses formats and validates the calendar', () => {
    expect(parseDateValue('2026-05-01T10:00:00Z')).toBe('2026-05-01');
    expect(parseDateValue('01-May-2026')).toBe('2026-05-01');
    expect(parseDateValue('May 1, 2026')).toBe('2026-05-01');
    expect(parseDateValue('03/04/26', 'dmy')).toBe('2026-04-03');
    expect(parseDateValue('03/04/2026', 'mdy')).toBe('2026-03-04');
    expect(parseDateValue('02/30/2026', 'mdy')).toBeNull();
  });
});

describe('parseMoney', () => {
  it('reads common money formats', () => {
    expect(parseMoney('$1,234.56')).toBe(1234.56);
    expect(parseMoney('(12.00)')).toBe(-12);
    expect(parseMoney('12,50')).toBe(12.5);
    expect(parseMoney('1.234,56')).toBe(1234.56);
    expect(parseMoney('')).toBeNaN();
    expect(parseMoney('abc')).toBeNaN();
  });
});
