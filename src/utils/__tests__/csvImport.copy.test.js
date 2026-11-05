import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { describe, expect, it } from 'vitest';

// Burrow copy never uses em or en dashes. Comments are exempt; the one input-cleaning regex in
// parseMoney (it must READ those characters from bank files) is allow-listed by its call shape.
const FILES = [
  'src/utils/csvImport.js',
  'src/components/budget/ImportTransactionsDialog.jsx',
  'src/components/budget/openTransactionImport.js',
  'src/services/transactionImportService.js',
  'src/pages/Budget.jsx',
];
const DASHES = /[\u2013\u2014]/;

// Vitest runs from the repo root.
const read = (rel) => readFileSync(resolve(process.cwd(), rel), 'utf8');

function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/\s.*$/, '$1'))
    .map((line) => line.replace(/^\s*\{\/\*.*\*\/\}\s*$/, ''));
}

describe('import feature copy', () => {
  it.each(FILES)('%s has no em or en dash in strings or JSX text', (rel) => {
    const source = read(rel);
    const offenders = codeOnly(source)
      .map((text, i) => ({ n: i + 1, text }))
      .filter(({ text }) => DASHES.test(text))
      // parseMoney normalizes minus-like characters from bank exports; it is input handling.
      .filter(({ text }) => !/\.replace\(\/\[[^\]]*\]\/g, '-'\)/.test(text));
    expect(offenders).toEqual([]);
  });

  it('the allow-listed regex really is the only dash in csvImport.js code', () => {
    const source = read('src/utils/csvImport.js');
    const hits = codeOnly(source).filter((t) => DASHES.test(t));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/parseMoney|\.replace/);
  });
});
