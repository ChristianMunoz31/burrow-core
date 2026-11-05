// pickSummaryParts (the windows a long file is summarized from). The question-index chunker is tested in the Pro twin.
import { describe, expect, it } from 'vitest';
import { pickSummaryParts } from '../folders/chunk.js';

describe('pickSummaryParts', () => {
  const text = (n) => Array.from({ length: n }, (_v, i) => String.fromCharCode(97 + (i % 26))).join('');

  it('a text that fits one window is returned whole (also empty and null)', () => {
    expect(pickSummaryParts('short')).toEqual(['short']);
    expect(pickSummaryParts(text(3000))).toEqual([text(3000)]);
    expect(pickSummaryParts('')).toEqual(['']);
    expect(pickSummaryParts(null)).toEqual(['']);
  });

  it('a longer text gives ceil(length / partChars) windows, at most 4', () => {
    expect(pickSummaryParts(text(3001))).toHaveLength(2);
    expect(pickSummaryParts(text(7000))).toHaveLength(3);
    expect(pickSummaryParts(text(9000))).toHaveLength(3);
    expect(pickSummaryParts(text(12001))).toHaveLength(4);
    expect(pickSummaryParts(text(500000))).toHaveLength(4);
  });

  it('every window is partChars long and the first and last windows are the start and end of the text', () => {
    const src = text(20000);
    const parts = pickSummaryParts(src);
    expect(parts).toHaveLength(4);
    for (const p of parts) expect(p).toHaveLength(3000);
    expect(parts[0]).toBe(src.slice(0, 3000));
    expect(parts.at(-1)).toBe(src.slice(-3000));
  });

  it('the windows are spaced evenly', () => {
    const src = Array.from({ length: 20000 }, (_v, i) => i).map((i) => String.fromCharCode(0x4e00 + (i % 5000))).join('');
    const parts = pickSummaryParts(src);
    const starts = parts.map((p) => src.indexOf(p));
    const gaps = starts.slice(1).map((s, i) => s - starts[i]);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
  });

  it('honours partChars and maxParts', () => {
    const parts = pickSummaryParts(text(1000), { partChars: 100, maxParts: 2 });
    expect(parts).toHaveLength(2);
    expect(parts[0]).toHaveLength(100);
    expect(pickSummaryParts(text(1000), { partChars: 100, maxParts: 1 })).toEqual([text(1000).slice(0, 100)]);
  });
});
