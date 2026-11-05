// The client stripDashes must behave exactly like the server one (they cannot share a module).
import { describe, it, expect } from 'vitest';
import { stripDashes as serverStrip } from '../javi/validateAdvice.js';
import { stripDashes as clientStrip } from '../../src/utils/javiDashes.js';

const CASES = [
  ['EN dash digit range', 'Try 3–5 bullets', 'Try 3-5 bullets'],
  ['figure dash digit range', 'Try 3‒5 bullets', 'Try 3-5 bullets'],
  ['dollar range with spaces', 'Cut $50 – $75 a month', 'Cut $50-$75 a month'],
  ['dollar range without spaces', 'Cut $50–$75 a month', 'Cut $50-$75 a month'],
  ['ISO date range', '2026-10-03 – 2026-10-05', '2026-10-03 to 2026-10-05'],
  ['em dash is never a range', '$1,200 — 3 categories', '$1,200, 3 categories'],
  ['em dash between digits', 'Pick 3—5 items', 'Pick 3, 5 items'],
  ['table placeholder cell', '| — |', '| n/a |'],
  ['table placeholder among cells', '| a | — | — |', '| a | n/a | n/a |'],
  ['prose em dash', 'word — word', 'word, word'],
  ['prose en dash', 'word – word', 'word, word'],
  ['prose horizontal bar', 'word ― word', 'word, word'],
  ['prose dash without spaces', 'word—word', 'word, word'],
  ['line-start dashes dropped', '— First\n  – Second', 'First\n  Second'],
  ['dash-only text', ' — ', ' '],
  ['adjacent comma before', 'a, — b', 'a, b'],
  ['adjacent comma after', 'a —, b', 'a, b'],
  ['repeated dashes', 'a — — b', 'a, b'],
  ['dash after an inline code span', '`x` — y', '`x`, y'],
  ['inline code span untouched', 'use `a — b , c` here', 'use `a — b , c` here'],
  ['fenced code untouched', 'x — y\n```\na — b , c\n```\nz — w', 'x, y\n```\na — b , c\n```\nz, w'],
  ['no dashes, spaced comma', 'a , b', 'a , b'],
  ['no dashes, dollar amount', '$1,234.56', '$1,234.56'],
  ['hyphen bullet kept', '- keep this well-known hyphen', '- keep this well-known hyphen'],
];

describe('stripDashes server/client parity', () => {
  it.each(CASES)('%s', (_name, input, expected) => {
    expect(serverStrip(input)).toBe(expected);
    expect(clientStrip(input)).toBe(expected);
    expect(clientStrip(input)).toBe(serverStrip(input));
  });

  it('never leaves a markdown bullet from a line-start dash', () => {
    expect(serverStrip('— First')).not.toMatch(/^\s*- /m);
    expect(clientStrip('– First')).not.toMatch(/^\s*- /m);
  });

  it('returns an empty string for non-strings', () => {
    expect(serverStrip(undefined)).toBe('');
    expect(clientStrip(null)).toBe('');
  });

  it('handles long runs of spaces in linear time', () => {
    const text = `${' '.repeat(100000)}x — y`;
    const started = Date.now();
    expect(clientStrip(text)).toBe(`${' '.repeat(100000)}x, y`);
    expect(serverStrip(text)).toBe(`${' '.repeat(100000)}x, y`);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
