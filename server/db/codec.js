// Value codec between JS values and SQLite storage forms. See tables.js for the type map.
import { randomUUID } from 'node:crypto';
import { DbError } from './errors.js';
import { getTable } from './tables.js';

export const nowIso = () => new Date().toISOString();

const invalid = (column) => new DbError('invalid_value', `Invalid value for ${column}`, { column });

const TS_RE = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?\s*(Z|z|[+-]\d{2}(?::?\d{2})?)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NUM_RE = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;

/**
 * Canonical UTC timestamp 'YYYY-MM-DDTHH:MM:SS.sssZ'.
 * @param {Date | number | string} value
 * @param {string} [column]
 * @returns {string}
 */
export function canonicalTimestamp(value, column = '?') {
  if (value instanceof Date || typeof value === 'number') {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) throw invalid(column);
    return d.toISOString();
  }
  if (typeof value !== 'string') throw invalid(column);
  const m = TS_RE.exec(value.trim());
  if (!m) throw invalid(column);
  const [, date, hh = '00', mi = '00', ss = '00', frac = '', zoneRaw = 'Z'] = m;
  const ms = (frac + '000').slice(0, 3);
  let zone = 'Z';
  if (zoneRaw.toUpperCase() !== 'Z') {
    const sign = zoneRaw[0];
    const digits = zoneRaw.slice(1).replace(':', '');
    zone = `${sign}${digits.slice(0, 2)}:${digits.length > 2 ? digits.slice(2, 4) : '00'}`;
  }
  const iso = `${date}T${hh}:${mi}:${ss}.${ms}${zone}`;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw invalid(column);
  // Reject calendar rollover (e.g. Feb 30) regardless of how Date.parse treats it.
  const check = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== date) throw invalid(column);
  return new Date(t).toISOString();
}

/**
 * 'YYYY-MM-DD' from a Date or a string whose first 10 chars are a real calendar date.
 * @param {Date | string} value
 * @param {string} [column]
 * @returns {string}
 */
export function canonicalDate(value, column = '?') {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw invalid(column);
    return value.toISOString().slice(0, 10);
  }
  if (typeof value !== 'string') throw invalid(column);
  const head = value.slice(0, 10);
  if (!DATE_RE.test(head)) throw invalid(column);
  const d = new Date(`${head}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== head) throw invalid(column);
  return head;
}

function toNumber(value, column) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid(column);
    return value;
  }
  if (typeof value === 'string' && NUM_RE.test(value.trim())) {
    const n = Number(value.trim());
    if (Number.isFinite(n)) return n;
  }
  throw invalid(column);
}

/**
 * JS value -> bind parameter (string | number | null).
 * @param {string} type
 * @param {unknown} value
 * @param {string} [column]
 * @returns {string | number | null}
 */
export function encodeValue(type, value, column = '?') {
  if (value === null) return null;
  switch (type) {
    case 'uuid':
    case 'text':
      if (typeof value === 'string') return value;
      if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean') return String(value);
      throw invalid(column);
    case 'date':
      return canonicalDate(/** @type {Date | string} */ (value), column);
    case 'timestamptz':
      return canonicalTimestamp(/** @type {Date | number | string} */ (value), column);
    case 'numeric':
    case 'real':
      return toNumber(value, column);
    case 'integer': {
      const n = toNumber(value, column);
      if (!Number.isSafeInteger(n)) throw invalid(column);
      return n;
    }
    case 'boolean':
      if (value === true || value === 1 || value === 'true' || value === 't' || value === '1') return 1;
      if (value === false || value === 0 || value === 'false' || value === 'f' || value === '0') return 0;
      throw invalid(column);
    case 'jsonb': {
      const s = JSON.stringify(value);
      if (s === undefined) throw invalid(column);
      return s;
    }
    case 'text[]': {
      if (Array.isArray(value)) return JSON.stringify(value.map((x) => (x == null ? '' : String(x))));
      if (typeof value === 'string' && /^\{.*\}$/s.test(value)) {
        const inner = value.slice(1, -1);
        const parts = inner === '' ? [] : inner.split(',');
        return JSON.stringify(parts);
      }
      throw invalid(column);
    }
    default:
      throw invalid(column);
  }
}

/**
 * Stored value -> JS.
 * @param {string} type
 * @param {unknown} raw
 * @returns {unknown}
 */
export function decodeValue(type, raw) {
  if (raw === null || raw === undefined) return null;
  if (type === 'boolean') return raw === 1 || raw === 1n || raw === true;
  if (type === 'jsonb' || type === 'text[]') {
    if (typeof raw !== 'string') return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw;
}

/**
 * Validates table/columns, drops undefined values, optionally autofills id and autoNow columns.
 * @param {string} table
 * @param {Record<string, unknown>} row
 * @param {{ forInsert?: boolean }} [opts]
 * @returns {{ columns: string[], values: Array<string | number | null> }}
 */
export function encodeRow(table, row, { forInsert = false } = {}) {
  const def = getTable(table);
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    throw new DbError('invalid_query', 'Row must be an object');
  }
  const entries = [];
  for (const [col, val] of Object.entries(row)) {
    if (!Object.hasOwn(def.columns, col)) {
      throw new DbError('unknown_column', 'Unknown column', { column: col });
    }
    if (val !== undefined) entries.push([col, val]);
  }
  const present = new Set(entries.map(([c]) => c));
  if (forInsert) {
    if (def.columns[def.primaryKey] === 'uuid' && !present.has(def.primaryKey)) {
      entries.push([def.primaryKey, randomUUID()]);
    }
    const now = nowIso();
    for (const col of def.autoNow) {
      if (!present.has(col)) entries.push([col, now]);
    }
  }
  return {
    columns: entries.map(([c]) => c),
    values: entries.map(([c, v]) => encodeValue(def.columns[c], v, c)),
  };
}

/**
 * Decodes every known column; unknown keys pass through unchanged.
 * @param {string} table
 * @param {Record<string, unknown>} raw
 * @returns {Record<string, unknown>}
 */
export function decodeRow(table, raw) {
  const def = getTable(table);
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = Object.hasOwn(def.columns, k) ? decodeValue(def.columns[k], v) : v;
  }
  return out;
}
