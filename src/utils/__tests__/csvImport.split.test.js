import { describe, expect, it } from 'vitest';
import { parseWith } from '../csvImport';

// parseWith replaced a CSV library. The expected values below are what that library returned for the same
// text (checked against it over millions of random inputs when the swap was made), including the lenient
// reading of malformed quotes.
describe('parseWith (CSV row splitter)', () => {
  it('splits plain rows and keeps empty cells and a trailing empty row', () => {
    expect(parseWith('a,b,c\n1,,3\n', ',')).toEqual([['a', 'b', 'c'], ['1', '', '3'], ['']]);
    expect(parseWith('', ',')).toEqual([]);
    expect(parseWith('a;b\tc', ';')).toEqual([['a', 'b\tc']]);
  });

  it('reads quoted cells with delimiters, line breaks and doubled quotes', () => {
    expect(parseWith('"a,b","he said ""hi""",x\n"line\nbreak",2', ',')).toEqual([
      ['a,b', 'he said "hi"', 'x'],
      ['line\nbreak', '2'],
    ]);
  });

  it('counts a quoted line break as one row', () => {
    expect(parseWith('h1,h2\n"a\nb",c\nd,e', ',')).toHaveLength(3);
  });

  it('allows spaces between a closing quote and the delimiter or line end', () => {
    expect(parseWith('"a"  ,b\n"c"  \nd,e', ',')).toEqual([['a', 'b'], ['c'], ['d', 'e']]);
  });

  it('keeps a quote in the middle of an unquoted cell as text', () => {
    expect(parseWith('ab"c,d', ',')).toEqual([['ab"c', 'd']]);
  });

  it('reads malformed quotes the lenient way', () => {
    expect(parseWith('"abc"d,e\nf,g', ',')).toEqual([['abc"d,e\nf,g']]);
    expect(parseWith('"never closed,1\n2,3', ',')).toEqual([['never closed,1\n2,3']]);
    expect(parseWith('a,"b"', ',')).toEqual([['a', 'b']]);
  });

  it('stops after the preview row count', () => {
    expect(parseWith('1\n2\n3\n4', ',', 2)).toEqual([['1'], ['2']]);
    expect(parseWith('"1"\n"2"\n"3"', ',', 2)).toEqual([['1'], ['2']]);
  });

  it('is fast on a large single-column file', () => {
    const text = `"x"\n${'row\n'.repeat(200000)}`;
    const started = Date.now();
    expect(parseWith(text, ',').length).toBe(200002);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
