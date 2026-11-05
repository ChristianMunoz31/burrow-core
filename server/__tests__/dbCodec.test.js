import { describe, it, expect } from 'vitest';
import {
  DbError,
  canonicalDate,
  canonicalTimestamp,
  decodeRow,
  decodeValue,
  encodeRow,
  encodeValue,
} from '../db/index.js';

const code = (fn) => {
  try {
    fn();
  } catch (e) {
    return e instanceof DbError ? e.code : 'other';
  }
  return null;
};

describe('canonicalTimestamp', () => {
  it('normalizes offsets, microseconds and zone spellings', () => {
    expect(canonicalTimestamp('2026-01-02T03:04:05.123456+00:00')).toBe('2026-01-02T03:04:05.123Z');
    expect(canonicalTimestamp('2026-01-02T03:04:05+0000')).toBe('2026-01-02T03:04:05.000Z');
    expect(canonicalTimestamp('2026-01-02 03:04:05+00')).toBe('2026-01-02T03:04:05.000Z');
    expect(canonicalTimestamp('2026-01-02T03:04:05z')).toBe('2026-01-02T03:04:05.000Z');
    expect(canonicalTimestamp('2026-01-02T03:04:05+02:00')).toBe('2026-01-02T01:04:05.000Z');
  });
  it('treats naive values as UTC and date-only as midnight UTC', () => {
    expect(canonicalTimestamp('2026-05-01T10:00')).toBe('2026-05-01T10:00:00.000Z');
    expect(canonicalTimestamp('2026-05-01')).toBe('2026-05-01T00:00:00.000Z');
  });
  it('accepts Date and epoch ms', () => {
    expect(canonicalTimestamp(new Date(0))).toBe('1970-01-01T00:00:00.000Z');
    expect(canonicalTimestamp(1000)).toBe('1970-01-01T00:00:01.000Z');
  });
  it('rejects invalid values', () => {
    expect(code(() => canonicalTimestamp('nope'))).toBe('invalid_value');
    expect(code(() => canonicalTimestamp('2026-13-01T00:00:00Z'))).toBe('invalid_value');
    expect(code(() => canonicalTimestamp('2026-02-30'))).toBe('invalid_value');
    expect(code(() => canonicalTimestamp(new Date('x')))).toBe('invalid_value');
    expect(code(() => canonicalTimestamp({}))).toBe('invalid_value');
  });
});

describe('canonicalDate', () => {
  it('keeps the first 10 characters of a real date', () => {
    expect(canonicalDate('2026-01-01')).toBe('2026-01-01');
    expect(canonicalDate('2026-01-01T10:00:00Z')).toBe('2026-01-01');
    expect(canonicalDate(new Date('2026-03-04T05:00:00Z'))).toBe('2026-03-04');
  });
  it('rejects non-dates and impossible dates', () => {
    expect(code(() => canonicalDate('2026-02-30'))).toBe('invalid_value');
    expect(code(() => canonicalDate('01/02/2026'))).toBe('invalid_value');
    expect(code(() => canonicalDate(5))).toBe('invalid_value');
  });
});

describe('encodeValue', () => {
  it('handles null for every type', () => {
    for (const t of ['uuid', 'text', 'date', 'timestamptz', 'numeric', 'integer', 'real', 'boolean', 'jsonb', 'text[]']) {
      expect(encodeValue(t, null)).toBeNull();
    }
  });
  it('text and uuid', () => {
    expect(encodeValue('text', 'a')).toBe('a');
    expect(encodeValue('text', 5)).toBe('5');
    expect(encodeValue('text', true)).toBe('true');
    expect(code(() => encodeValue('text', {}))).toBe('invalid_value');
    expect(code(() => encodeValue('uuid', Number.NaN))).toBe('invalid_value');
  });
  it('numeric, real and integer', () => {
    expect(encodeValue('numeric', '12.50')).toBe(12.5);
    expect(encodeValue('real', '1e2')).toBe(100);
    expect(encodeValue('numeric', -3)).toBe(-3);
    expect(encodeValue('integer', '7')).toBe(7);
    expect(code(() => encodeValue('integer', 1.5))).toBe('invalid_value');
    expect(code(() => encodeValue('numeric', 'abc'))).toBe('invalid_value');
    expect(code(() => encodeValue('numeric', Infinity))).toBe('invalid_value');
  });
  it('boolean', () => {
    for (const v of [true, 1, 'true', 't', '1']) expect(encodeValue('boolean', v)).toBe(1);
    for (const v of [false, 0, 'false', 'f', '0']) expect(encodeValue('boolean', v)).toBe(0);
    expect(code(() => encodeValue('boolean', 'yes'))).toBe('invalid_value');
  });
  it('jsonb stores JSON, including strings', () => {
    expect(encodeValue('jsonb', { a: 1 })).toBe('{"a":1}');
    expect(encodeValue('jsonb', 'dark')).toBe('"dark"');
    expect(encodeValue('jsonb', 0)).toBe('0');
    expect(code(() => encodeValue('jsonb', () => 1))).toBe('invalid_value');
  });
  it('text[] from arrays and PG literals', () => {
    expect(encodeValue('text[]', ['a', null, 3])).toBe('["a","","3"]');
    expect(encodeValue('text[]', '{a,b}')).toBe('["a","b"]');
    expect(encodeValue('text[]', '{}')).toBe('[]');
    expect(code(() => encodeValue('text[]', 'a,b'))).toBe('invalid_value');
  });
  it('date and timestamptz delegate to the canonical helpers', () => {
    expect(encodeValue('date', '2026-01-01T10:00:00Z')).toBe('2026-01-01');
    expect(encodeValue('timestamptz', '2026-01-02T03:04:05.5+00:00')).toBe('2026-01-02T03:04:05.500Z');
  });
  it('reports the column on error', () => {
    try {
      encodeValue('integer', 1.5, 'order');
    } catch (e) {
      expect(e.column).toBe('order');
      expect(e.status).toBe(400);
    }
  });
});

describe('decodeValue / decodeRow', () => {
  it('decodes booleans, json and arrays', () => {
    expect(decodeValue('boolean', 1)).toBe(true);
    expect(decodeValue('boolean', 0)).toBe(false);
    expect(decodeValue('jsonb', '{"a":1}')).toEqual({ a: 1 });
    expect(decodeValue('text[]', '["a"]')).toEqual(['a']);
    expect(decodeValue('jsonb', null)).toBeNull();
  });
  it('returns null for bad JSON without throwing', () => {
    expect(decodeValue('jsonb', '{oops')).toBeNull();
    expect(decodeValue('text[]', 'nope')).toBeNull();
  });
  it('passes other types and unknown keys through', () => {
    expect(decodeValue('numeric', 2.5)).toBe(2.5);
    expect(decodeRow('notes', { id: 'x', pinned: 1, rowid: 9 })).toEqual({ id: 'x', pinned: true, rowid: 9 });
  });
});

describe('encodeRow', () => {
  it('drops undefined keys and autofills on insert', () => {
    const { columns, values } = encodeRow('notes', { body: 'hi', color: undefined }, { forInsert: true });
    expect(columns).toContain('id');
    expect(columns).toContain('created_at');
    expect(columns).not.toContain('color');
    expect(values[columns.indexOf('body')]).toBe('hi');
    expect(values[columns.indexOf('id')]).toMatch(/^[0-9a-f-]{36}$/);
    expect(values[columns.indexOf('created_at')]).toMatch(/Z$/);
  });
  it('does not autofill without forInsert', () => {
    expect(encodeRow('notes', { body: 'hi' })).toEqual({ columns: ['body'], values: ['hi'] });
  });
  it('keeps a text primary key unfilled', () => {
    const { columns } = encodeRow('app_state', { value: 1 }, { forInsert: true });
    expect(columns).not.toContain('key');
  });
  it('rejects unknown tables and columns', () => {
    expect(code(() => encodeRow('nope', {}))).toBe('unknown_table');
    expect(code(() => encodeRow('__proto__', {}))).toBe('unknown_table');
    expect(code(() => encodeRow('notes', { evil: 1 }))).toBe('unknown_column');
    expect(code(() => encodeRow('notes', { constructor: 1 }))).toBe('unknown_column');
  });
});
