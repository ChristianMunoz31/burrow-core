import { describe, expect, it } from 'vitest';
import {
  CsvImportError,
  MAX_COLUMNS,
  buildRows,
  detectDelimiter,
  parseCsvTable,
  parseDateValue,
  parseMoney,
} from '../csvImport';

describe('time-strip regex is not exploitable', () => {
  it('finishes fast on a huge run of spaces', () => {
    const cell = `1 1:11${' '.repeat(200000)}x`;
    const start = performance.now();
    expect(parseDateValue(cell)).toBeNull();
    expect(performance.now() - start).toBeLessThan(50);
  });

  it('still reads dates with a time and AM/PM', () => {
    expect(parseDateValue('2026-05-01T10:00:00Z')).toBe('2026-05-01');
    expect(parseDateValue('05/01/2026 10:30 AM', 'mdy')).toBe('2026-05-01');
    expect(parseDateValue('05/01/2026 10:30PM', 'mdy')).toBe('2026-05-01');
  });
});

describe('column cap', () => {
  const wide = (n) => Array.from({ length: n }, (_, i) => `c${i}`).join(',');

  it('rejects a header wider than the cap', () => {
    const run = () => parseCsvTable(`${wide(MAX_COLUMNS + 1)}\n${wide(MAX_COLUMNS + 1)}`);
    expect(run).toThrow(CsvImportError);
    try {
      run();
    } catch (err) {
      expect(err.code).toBe('too_many_columns');
      expect(err.message).toMatch(/columns/);
    }
  });

  it('rejects a data row wider than the cap', () => {
    const text = `Date,Description,Amount\n2026-05-01,Coffee,-4.50\n2026-05-02,${wide(MAX_COLUMNS + 1)}`;
    expect(() => parseCsvTable(text)).toThrow(/columns/);
  });

  it('accepts exactly the cap', () => {
    const table = parseCsvTable(`${wide(MAX_COLUMNS)}\n${wide(MAX_COLUMNS)}`);
    expect(table.headers).toHaveLength(MAX_COLUMNS);
  });
});

describe('delimiter probing is bounded', () => {
  it('detects the delimiter of a large file from its start', () => {
    const rows = Array.from({ length: 60000 }, (_, i) => `2026-05-01;Shop ${i};-1.00`);
    const text = `Date;Description;Amount\n${rows.join('\n')}`;
    const start = performance.now();
    expect(detectDelimiter(text)).toBe(';');
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('still parses a small semicolon file', () => {
    const table = parseCsvTable('Date;Description;Amount\n2026-05-01;Coffee;-4,50\n');
    expect(table.delimiter).toBe(';');
    expect(table.rows).toHaveLength(1);
  });
});

describe('control characters in text cells', () => {
  const table = (merchant, category = '') => ({
    rows: [{ line: 2, cells: ['2026-05-01', merchant, '-4.50', category] }],
  });
  const mapping = { mode: 'single', date: 0, merchant: 1, amount: 2, category: 3 };

  it('treats a merchant made only of control characters as missing', () => {
    const out = buildRows(table('\u0001\u0002\u007F\u001F'), mapping);
    expect(out.rows).toHaveLength(0);
    expect(out.bad[0].reason).toMatch(/description is missing/);
  });

  it('turns control characters into single spaces', () => {
    const out = buildRows(table('Corner\u0001\u0002Shop', 'Food\u0007Out'), mapping);
    expect(out.rows[0].merchant).toBe('Corner Shop');
    expect(out.rows[0].category).toBe('Food Out');
  });
});

describe('parseMoney only accepts plain decimals', () => {
  it.each(['1e400', '1e3', '0x1F', 'Infinity', '-Infinity', 'NaN', '1e', '12abc'])('rejects %s', (v) => {
    expect(parseMoney(v)).toBeNaN();
  });

  it('rejects amounts above one billion', () => {
    expect(parseMoney('1000000001')).toBeNaN();
    expect(parseMoney('-1000000001.00')).toBeNaN();
    expect(parseMoney('1000000000')).toBe(1000000000);
  });

  it('keeps reading normal formats', () => {
    expect(parseMoney('$1,234.56')).toBe(1234.56);
    expect(parseMoney('(12.00)')).toBe(-12);
    expect(parseMoney('12.00 DR')).toBe(-12);
    expect(parseMoney('12.50-')).toBe(-12.5);
    expect(parseMoney('1.234,56')).toBe(1234.56);
    expect(parseMoney('+7')).toBe(7);
  });
});
