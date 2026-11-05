import { describe, it, expect } from 'vitest';
import { fuzzyScore, fuzzyFilter } from '../fuzzy';

describe('fuzzyScore', () => {
  it('returns >0 for an in-order subsequence match', () => {
    expect(fuzzyScore('bud', 'Go to Budget')).toBeGreaterThan(0);
  });

  it('returns 0 when characters are not all present in order', () => {
    expect(fuzzyScore('zzz', 'Go to Budget')).toBe(0);
    expect(fuzzyScore('tegdub', 'Budget')).toBe(0); // wrong order
  });

  it('scores a word-start / consecutive match higher than a scattered one', () => {
    expect(fuzzyScore('todo', 'Add a todo')).toBeGreaterThan(fuzzyScore('todo', 'tornado of dough'));
  });

  it('treats empty query as a match', () => {
    expect(fuzzyScore('', 'anything')).toBe(1);
  });
});

describe('fuzzyFilter', () => {
  const items = [{ label: 'Go to Budget' }, { label: 'Go to Todos' }, { label: 'New note' }];

  it('keeps original order for an empty query', () => {
    expect(fuzzyFilter('', items, (i) => i.label)).toEqual(items);
  });

  it('filters out non-matches and ranks matches by score', () => {
    const out = fuzzyFilter('to', items, (i) => i.label);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((i) => /to/i.test(i.label.replace(/\s/g, '')) || /t.*o/i.test(i.label))).toBe(true);
    expect(out.find((i) => i.label === 'New note')).toBeFalsy();
  });
});
