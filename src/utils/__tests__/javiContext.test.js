import { describe, it, expect } from 'vitest';
import { TRUNCATION_MARKER, clip, round2, serializeJaviContext } from '../javiContext';
import { JAVI_CONTEXT_MAX_CHARS } from '../../constants/javiPages';

const NOW = new Date(2026, 9, 2, 14, 5);

describe('serializeJaviContext', () => {
  it('emits valid JSON under the cap with page, today, localTime and data', () => {
    const { context, truncated } = serializeJaviContext({ pageKey: 'todos', data: { n: 1 }, now: NOW });
    expect(truncated).toBe(false);
    expect(context.length).toBeLessThanOrEqual(JAVI_CONTEXT_MAX_CHARS);
    expect(JSON.parse(context)).toEqual({
      page: 'todos',
      today: '2026-10-02',
      localTime: '14:05',
      data: { n: 1 },
    });
  });

  it('truncates oversized payloads to exactly the cap with the marker', () => {
    const { context, truncated } = serializeJaviContext({
      pageKey: 'notes',
      data: { text: 'word '.repeat(2000) },
      now: NOW,
    });
    expect(truncated).toBe(true);
    expect(context).toHaveLength(JAVI_CONTEXT_MAX_CHARS);
    // The cut is inside the data: the clock (the last member) survives it.
    expect(context.endsWith(`${TRUNCATION_MARKER},"localTime":"14:05"}`)).toBe(true);
  });

  it('keeps the clock when only a tiny cap is left', () => {
    const { context } = serializeJaviContext({ pageKey: 'notes', data: { text: 'x'.repeat(500) }, now: NOW, maxChars: 60 });
    expect(context.length).toBeLessThanOrEqual(60);
    expect(context.endsWith('"localTime":"14:05"}')).toBe(true);
  });

  it('redacts secrets', () => {
    const { context } = serializeJaviContext({
      pageKey: 'notes',
      data: { apiKey: 'abc', note: 'use gsk_secret1234567890abcdef' },
      now: NOW,
    });
    expect(context).not.toContain('gsk_secret');
    expect(context).not.toContain('"abc"');
  });

  it('notes missing data', () => {
    const { context } = serializeJaviContext({ pageKey: 'home', data: null, now: NOW });
    expect(JSON.parse(context).data).toEqual({ note: 'No page data registered' });
  });
});

describe('helpers', () => {
  it('clip trims and adds an ellipsis', () => {
    expect(clip('  hello   world ', 50)).toBe('hello world');
    expect(clip('abcdefghij', 5)).toBe('abcd…');
    expect(clip(null, 5)).toBe('');
  });

  it('round2 rounds finite numbers and nulls the rest', () => {
    expect(round2(1.2349)).toBe(1.23);
    expect(round2('4.567')).toBe(4.57);
    expect(round2(undefined)).toBeNull();
    expect(round2(null)).toBeNull();
    expect(round2(NaN)).toBeNull();
  });
});
