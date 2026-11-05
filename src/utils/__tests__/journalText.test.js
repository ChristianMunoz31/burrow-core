import { describe, it, expect } from 'vitest';
import { wordCount, normalize, topWords, STOPWORDS } from '../journalText';

describe('normalize', () => {
  it('lowercases and strips punctuation', () => {
    expect(normalize('Hello, World! How are You?')).toBe('hello world how are you');
  });
  it('handles empty/null', () => {
    expect(normalize('')).toBe('');
    expect(normalize(null)).toBe('');
  });
  it('keeps apostrophes', () => {
    expect(normalize("can't won't")).toBe("can't won't");
  });
});

describe('wordCount', () => {
  it('returns 0 for empty', () => {
    expect(wordCount('')).toBe(0);
    expect(wordCount(null)).toBe(0);
  });
  it('counts words in a sentence', () => {
    expect(wordCount('one two three')).toBe(3);
  });
  it('handles extra whitespace and punctuation', () => {
    expect(wordCount('  Hello,   world!  ')).toBe(2);
  });
});

describe('topWords', () => {
  it('returns empty for no entries', () => {
    expect(topWords([])).toEqual([]);
  });
  it('counts and ranks words across entries', () => {
    const entries = [
      { body: 'coffee coffee meetings' },
      { body: 'coffee bagels meetings' },
      { body: 'walking bagels bagels' },
    ];
    const out = topWords(entries, 5);
    const map = Object.fromEntries(out.map(({ word, count }) => [word, count]));
    expect(map.coffee).toBe(3);
    expect(map.bagels).toBe(3);
    expect(map.meetings).toBe(2);
    expect(map.walking).toBe(1);
  });
  it('excludes stopwords', () => {
    const entries = [{ body: 'the the and walked' }];
    const out = topWords(entries);
    expect(out.find((w) => w.word === 'the')).toBeUndefined();
    expect(out.find((w) => w.word === 'walked').count).toBe(1);
  });
  it('excludes 1-2 char tokens', () => {
    const entries = [{ body: 'a an it hi hello' }];
    const out = topWords(entries);
    expect(out.find((w) => w.word === 'hi')).toBeUndefined();
    expect(out.find((w) => w.word === 'hello').count).toBe(1);
  });
  it('honors the n parameter', () => {
    const entries = [{ body: 'apple banana cherry date elderberry fig grape' }];
    const out = topWords(entries, 3);
    expect(out.length).toBe(3);
  });
});

describe('STOPWORDS', () => {
  it('contains common pronouns', () => {
    expect(STOPWORDS.has('the')).toBe(true);
    expect(STOPWORDS.has('i')).toBe(true);
    expect(STOPWORDS.has('you')).toBe(true);
  });
});
