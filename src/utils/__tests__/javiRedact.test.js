import { describe, it, expect } from 'vitest';
import { REDACTED, redactForJavi, redactText } from '../javiRedact';

describe('redactText', () => {
  it.each([
    ['key gsk_abcdef1234567890ABCD', 'gsk_'],
    ['key sk-abcdef1234567890ABCDEFGH', 'sk-abc'],
    ['token ghp_abcdefghijklmnop1234567890', 'ghp_'],
    ['aws AKIAABCDEFGHIJKLMNOP end', 'AKIA'],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig', 'eyJ'],
    ['Authorization: Bearer abc.def.ghi', 'abc.def'],
    ['blob ' + 'a'.repeat(45), 'aaaaaaaaaa'],
  ])('redacts secrets in %s', (input, leaked) => {
    const out = redactText(input);
    expect(out).toContain(REDACTED);
    expect(out).not.toContain(leaked);
  });

  it('redacts emails and URL userinfo', () => {
    expect(redactText('mail me@example.com now')).toBe('mail [email] now');
    expect(redactText('https://user:pw@host.io/x')).toBe('https://host.io/x');
  });

  it.each(['task-runner', 'risk-free', 'desk-lamp', 'ask-me', 'a sk-short'])(
    'does not mangle ordinary hyphenated words: %s',
    (word) => {
      expect(redactText(`see ${word} here`)).toBe(`see ${word} here`);
    },
  );

  it('leaves ordinary text alone', () => {
    expect(redactText('Buy milk tomorrow')).toBe('Buy milk tomorrow');
  });
});

describe('redactForJavi', () => {
  it('redacts sensitive keys, including camelCase and coordinates', () => {
    const out = redactForJavi({
      apiKey: 'x',
      GROQ_API_KEY: 'x',
      last4: '1234',
      lat: 1,
      lon: 2,
      sessionToken: 'x',
    });
    for (const v of Object.values(out)) expect(v).toBe(REDACTED);
  });

  it('keeps author and title', () => {
    expect(redactForJavi({ author: 'Ann', title: 'Plan' })).toEqual({ author: 'Ann', title: 'Plan' });
  });

  it('does not mutate its input and drops functions/undefined', () => {
    const input = { a: { token: 't', list: [1, undefined, () => 1] }, f: () => 1, u: undefined };
    const snapshot = JSON.stringify(input);
    const out = redactForJavi(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(out).toEqual({ a: { token: REDACTED, list: [1] } });
  });

  it('serializes dates and fails closed on deep nesting', () => {
    expect(redactForJavi({ d: new Date('2026-01-02T03:04:05Z') })).toEqual({
      d: '2026-01-02T03:04:05.000Z',
    });
    let deep = { v: 1 };
    for (let i = 0; i < 12; i += 1) deep = { n: deep };
    expect(JSON.stringify(redactForJavi(deep))).toContain(REDACTED);
  });
});
