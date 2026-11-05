import { describe, it, expect } from 'vitest';
import Papa from 'papaparse';
import { toCsv } from '../export/csv.js';

const cols = [
  { name: 'id', type: 'uuid' },
  { name: 'note', type: 'text' },
  { name: 'amount', type: 'numeric' },
  { name: 'data', type: 'jsonb' },
  { name: 'tags', type: 'text[]' },
];
const parse = (csv) => Papa.parse(csv, { header: true, skipEmptyLines: true, newline: '\r\n' }).data;
const one = (note) => parse(toCsv(cols, [{ id: '1', note, amount: 1, data: null, tags: null }]))[0].note;

describe('formula injection guard', () => {
  it.each([
    ['equals', '='],
    ['plus', '+'],
    ['minus', '-'],
    ['at', '@'],
    ['tab', '\t'],
    ['carriage return', '\r'],
  ])('prefixes a text cell that starts with %s and keeps the rest intact', (_n, lead) => {
    for (const payload of [`${lead}`, `${lead}cmd|' /C calc'!A0`, `${lead}1+1`, `${lead}HYPERLINK("http://x","y")`]) {
      expect(one(payload)).toBe(`'${payload}`);
    }
  });

  it('after a real CSV parse no text cell starts with a dangerous char', () => {
    const dangerous = ['=', '+', '-', '@', '\t', '\r'];
    const rows = dangerous.map((d, i) => ({ id: String(i), note: `${d}x`, amount: 0, data: null, tags: null }));
    const parsed = parse(toCsv(cols, rows));
    expect(parsed).toHaveLength(dangerous.length);
    for (const r of parsed) expect(/^[=+\-@\t\r]/.test(r.note)).toBe(false);
  });

  it('leaves cells that merely contain a dangerous char later (or a leading apostrophe/space)', () => {
    for (const v of ['a=b', 'a+b', 'a-b', 'x@y.com', 'a\tb', "'=1", ' ok']) expect(one(v)).toBe(v);
  });

  it('guards once per cell, including multi-line values', () => {
    expect(one('=1\n=2')).toBe("'=1\n=2");
  });

  it('leaves numeric columns untouched (negative numbers stay numeric)', () => {
    const csv = toCsv(cols, [{ id: '1', note: 'ok', amount: -12.5, data: null, tags: null }]);
    expect(parse(csv)[0].amount).toBe('-12.5');
  });

  it('does not guard json/array cells (they always start with a bracket or brace)', () => {
    const csv = toCsv(cols, [{ id: '1', note: 'x', amount: 1, data: { a: '=1' }, tags: ['=x', '-y'] }]);
    const row = parse(csv)[0];
    expect(row.data).toBe('{"a":"=1"}');
    expect(row.tags).toBe('["=x","-y"]');
  });

  it('does not guard non-string values in text columns', () => {
    const csv = toCsv(cols, [{ id: '1', note: -5, amount: 1, data: null, tags: null }]);
    expect(parse(csv)[0].note).toBe('-5');
  });

  it.each([' =1', '  +1', '\u00a0@x', '\n-1', ' \t=cmd'])('guards leading whitespace before a dangerous char: %j', (v) => {
    expect(one(v)).toBe(`'${v}`);
  });

  it('guards a bare string value in a jsonb column (app_state.value)', () => {
    const stateCols = [
      { name: 'key', type: 'text' },
      { name: 'value', type: 'jsonb' },
    ];
    const rows = parse(toCsv(stateCols, [{ key: 'theme', value: '=1+1' }, { key: 'k2', value: { a: '=1' } }]));
    expect(rows[0].value).toBe("'=1+1");
    expect(rows[1].value).toBe('{"a":"=1"}');
  });

  it('guards string cells in non-text, non-numeric columns (uuid, date, boolean-as-string)', () => {
    const odd = [
      { name: 'u', type: 'uuid' },
      { name: 'd', type: 'date' },
    ];
    const rows = parse(toCsv(odd, [{ u: '=1', d: '-2026' }]));
    expect(rows[0]).toEqual({ u: "'=1", d: "'-2026" });
  });

  it('keeps plain numbers in numeric-typed columns, but guards non-plain strings there', () => {
    const numCols = [
      { name: 'n', type: 'numeric' },
      { name: 'i', type: 'integer' },
    ];
    const keep = parse(toCsv(numCols, [{ n: '-5', i: '-12.50' }]))[0];
    expect(keep).toEqual({ n: '-5', i: '-12.50' });
    for (const v of ['-5abc', '=1', ' -5', '-5.', '+5']) {
      expect(parse(toCsv(numCols, [{ n: v, i: 0 }]))[0].n).toBe(`'${v}`);
    }
  });

  it('does not exempt a plain-number string in a text column', () => {
    expect(one('-5')).toBe("'-5");
  });
});

describe('unicode, newlines and round trip', () => {
  const nasty = [
    'plain',
    'comma, inside',
    'quote " inside',
    '""',
    'line1\nline2',
    'line1\r\nline2',
    'trailing newline\n',
    '\nleading newline',
    'emoji 🎉👩‍💻 and CJK 日本語 and RTL שלום ‮',
    'zero​width and combining é',
    'ünï©ödé',
    '  padded  ',
    'tab\tinside',
    "O'Brien",
  ];

  it('round-trips every nasty value through a real CSV parser', () => {
    const rows = nasty.map((note, i) => ({ id: `id${i}`, note, amount: i, data: { n: note }, tags: [note] }));
    const parsed = parse(toCsv(cols, rows));
    expect(parsed).toHaveLength(rows.length);
    parsed.forEach((p, i) => {
      expect(p.id).toBe(`id${i}`);
      expect(p.note).toBe(nasty[i]);
      expect(JSON.parse(p.data)).toEqual({ n: nasty[i] });
      expect(JSON.parse(p.tags)).toEqual([nasty[i]]);
      expect(Number(p.amount)).toBe(i);
    });
  });

  it('round-trips guarded values as apostrophe + original', () => {
    const vals = ['=A1', '+1', '-1', '@x', '\tx', '\rx', '=1\r\n2'];
    const parsed = parse(toCsv(cols, vals.map((note, i) => ({ id: `${i}`, note, amount: 0, data: null, tags: null }))));
    expect(parsed).toHaveLength(vals.length);
    parsed.forEach((p, i) => expect(p.note).toBe(`'${vals[i]}`));
  });

  it('keeps unicode intact through UTF-8 encoding', () => {
    const csv = toCsv(cols, [{ id: '1', note: '日本語🎉', amount: 1, data: null, tags: null }]);
    expect(new TextDecoder().decode(new TextEncoder().encode(csv))).toBe(csv);
  });

  it('uses CRLF as the row terminator and quotes cells with a bare LF', () => {
    const csv = toCsv(cols, [{ id: '1', note: 'a\nb', amount: 1, data: null, tags: null }]);
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv.split('\r\n')).toHaveLength(3);
    expect(csv).toContain('"a\nb"');
  });

  it('handles null or sparse rows without throwing', () => {
    expect(() => toCsv(cols, [null, {}, { id: 1 }])).not.toThrow();
    expect(parse(toCsv(cols, [{ id: 'a' }, { id: 'x' }]))).toHaveLength(2);
  });

  it('quotes header names that need it', () => {
    expect(toCsv([{ name: 'a,b', type: 'text' }], [])).toBe('"a,b"\r\n');
  });
});
