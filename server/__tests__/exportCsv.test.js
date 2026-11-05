import { describe, it, expect } from 'vitest';
import { toCsv } from '../export/csv.js';

const cols = [
  { name: 'id', type: 'uuid' },
  { name: 'note', type: 'text' },
  { name: 'amount', type: 'numeric' },
  { name: 'data', type: 'jsonb' },
];

describe('toCsv', () => {
  it('writes a header-only file for no rows, with CRLF', () => {
    expect(toCsv(cols, [])).toBe('id,note,amount,data\r\n');
  });

  it('quotes commas, quotes, CR and LF and doubles embedded quotes', () => {
    const csv = toCsv(cols, [{ id: '1', note: 'a,b "c"\nd', amount: 1, data: null }]);
    expect(csv).toBe('id,note,amount,data\r\n1,"a,b ""c""\nd",1,\r\n');
  });

  it('renders null and undefined as empty cells', () => {
    expect(toCsv(cols, [{ id: '1' }])).toBe('id,note,amount,data\r\n1,,,\r\n');
  });

  it('stringifies jsonb and array cells', () => {
    const csv = toCsv(
      [
        { name: 'tags', type: 'text[]' },
        { name: 'data', type: 'jsonb' },
      ],
      [{ tags: ['a', 'b'], data: { k: 1 } }],
    );
    expect(csv).toBe('tags,data\r\n"[""a"",""b""]","{""k"":1}"\r\n');
  });

  it.each(['=SUM(A1)', '+1', '-1', '@cmd', '\tx'])('guards text cell %j against formula injection', (v) => {
    const csv = toCsv(cols, [{ id: '1', note: v, amount: 0, data: null }]);
    expect(csv).toBe(`id,note,amount,data\r\n1,'${v},0,\r\n`);
  });

  it('guards a leading carriage return (and quotes the cell)', () => {
    const csv = toCsv(cols, [{ id: '1', note: '\rx', amount: 0, data: null }]);
    expect(csv).toBe('id,note,amount,data\r\n1,"\'\rx",0,\r\n');
  });

  it('does not guard numeric columns', () => {
    const csv = toCsv(cols, [{ id: '1', note: 'ok', amount: -5, data: null }]);
    expect(csv).toBe('id,note,amount,data\r\n1,ok,-5,\r\n');
  });

  it('leaves ordinary text alone', () => {
    expect(toCsv(cols, [{ id: '1', note: 'a-b = c', amount: 1, data: null }])).toContain(',a-b = c,');
  });
});
