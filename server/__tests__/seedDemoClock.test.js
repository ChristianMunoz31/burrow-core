import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildChildEnv } from '../../scripts/lib/sandboxSafety.js';
import { seedDemo } from '../../scripts/seedDemo.js';
import { TABLES, insert, openDb, setDbForTests } from '../db/index.js';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'seedDemo.js');

// The only columns allowed to hold a future value: user-chosen scheduled dates. Everything else (every created_at, updated_at,
// started_at, journal date, completion and transaction date, JSON dates in app_state) must be <= now.
const FUTURE_ALLOWED = new Set([
  'calendar_events.start_at', // upcoming events the user scheduled
  'calendar_events.end_at', // end of those scheduled events
  'todos.due', // due dates are chosen by the user
  'countdowns.target_date', // a countdown target is by definition ahead
]);

// Minimal env plus the real per-user dirs, so the CLI can tell the real data dir from the temp one
// (it only reads them to refuse that dir; the data dir passed with --data-dir is the only one written).
const cliEnv = () =>
  buildChildEnv({
    extra: Object.fromEntries(
      ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_DATA_HOME', 'TMPDIR', 'TZ']
        .filter((k) => typeof process.env[k] === 'string')
        .map((k) => [k, process.env[k]]),
    ),
  });

// Local wall-clock times, so the day-of-month and hour logic of the seed is exercised.
const CLOCKS = [
  ['00:30', new Date(2026, 5, 15, 0, 30, 0)],
  ['09:00', new Date(2026, 5, 15, 9, 0, 0)],
  ['23:59', new Date(2026, 5, 15, 23, 59, 0)],
  ['month start 00:30', new Date(2026, 2, 1, 0, 30, 0)],
  ['month end 23:59', new Date(2026, 0, 31, 23, 59, 0)],
  ['year end 23:59', new Date(2026, 11, 31, 23, 59, 0)],
  ['leap day 09:00', new Date(2028, 1, 29, 9, 0, 0)],
];

const pad = (n) => String(n).padStart(2, '0');
const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

/** Returns a message when `value` is an ISO date or timestamp later than `now`, else null. */
function futureProblem(value, now) {
  if (typeof value !== 'string') return null;
  if (DAY_RE.test(value)) return value > localDay(now) ? `date ${value} is after today` : null;
  if (STAMP_RE.test(value)) return Date.parse(value) > now.getTime() ? `timestamp ${value} is after now` : null;
  return null;
}

function jsonProblems(value, now, where, out) {
  if (typeof value === 'string') {
    const p = futureProblem(value, now);
    if (p) out.push(`${where}: ${p}`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => jsonProblems(v, now, `${where}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) jsonProblems(v, now, `${where}.${k}`, out);
  }
}

/** Every future value in the DB that is not allowlisted. A date/timestamp column or any ISO-looking value counts. */
function futureValues(raw, now) {
  const out = [];
  let checked = 0;
  for (const [table, def] of Object.entries(TABLES)) {
    const cols = Object.keys(def.columns);
    const rows = raw.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM "${table}"`).all();
    for (const row of rows) {
      for (const col of cols) {
        const value = row[col];
        const type = def.columns[col];
        const isTime = col.endsWith('_at') || col === 'date' || type === 'date' || type === 'timestamptz';
        if (typeof value !== 'string' || (!isTime && !DAY_RE.test(value) && !STAMP_RE.test(value) && type !== 'jsonb')) continue;
        if (type === 'jsonb') {
          try {
            jsonProblems(JSON.parse(value), now, `${table}.${col}`, out);
          } catch {
            out.push(`${table}.${col}: not valid JSON`);
          }
          continue;
        }
        if (FUTURE_ALLOWED.has(`${table}.${col}`)) continue;
        checked += 1;
        const problem = futureProblem(value, now);
        if (problem) out.push(`${table}.${col}: ${problem}`);
        else if (isTime && !DAY_RE.test(value) && !STAMP_RE.test(value)) out.push(`${table}.${col}: unparseable ${value}`);
      }
    }
  }
  return { problems: out, checked };
}

describe('seedDemo never writes future timestamps', () => {
  const dirs = [];
  const tmpDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-seedclock-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    setDbForTests(null);
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each(CLOCKS)('at %s every timestamp and date is <= now (except scheduled dates)', async (_label, now) => {
    const file = path.join(tmpDir(), 'burrow.db');
    const db = openDb({ filename: file });
    setDbForTests(db);
    try {
      await seedDemo({ insert, now });
    } finally {
      setDbForTests(null);
      db.close();
    }
    const raw = new DatabaseSync(file, { readOnly: true });
    try {
      const { problems, checked } = futureValues(raw, now);
      expect(problems).toEqual([]);
      expect(checked).toBeGreaterThan(500);
    } finally {
      raw.close();
    }
  });

  it('only allowlisted scheduled columns ever hold a future value', async () => {
    const now = new Date(2026, 5, 15, 0, 30, 0);
    const file = path.join(tmpDir(), 'burrow.db');
    const db = openDb({ filename: file });
    setDbForTests(db);
    try {
      await seedDemo({ insert, now });
    } finally {
      setDbForTests(null);
      db.close();
    }
    const raw = new DatabaseSync(file, { readOnly: true });
    try {
      const future = new Set();
      for (const key of FUTURE_ALLOWED) {
        const [table, col] = key.split('.');
        const rows = raw.prepare(`SELECT "${col}" AS v FROM "${table}"`).all();
        if (rows.some((r) => futureProblem(r.v, now))) future.add(key);
      }
      // The scheduled data really is ahead of the clock, so the allowlist is not vacuous.
      expect([...future].sort()).toEqual([...FUTURE_ALLOWED].sort());
    } finally {
      raw.close();
    }
  });

  it('the CLI honours --now and writes nothing after it', () => {
    const dir = tmpDir();
    const now = new Date(2026, 5, 15, 0, 30, 0);
    const res = spawnSync(process.execPath, [SCRIPT, '--data-dir', dir, '--now', now.toISOString()], {
      env: cliEnv(),
      encoding: 'utf8',
      shell: false,
    });
    expect(res.status, res.stderr).toBe(0);
    const raw = new DatabaseSync(path.join(dir, 'burrow.db'), { readOnly: true });
    try {
      expect(futureValues(raw, now).problems).toEqual([]);
    } finally {
      raw.close();
    }
  });

  it.each([
    ['not-a-date', 'not-a-date'],
    ['a loose string', 'June 1'],
    ['a bare year', '2026'],
    ['a date without a time', '2026-06-15'],
    ['a future value', new Date(Date.now() + 86_400_000).toISOString()],
  ])('rejects --now for %s', (_label, value) => {
    const res = spawnSync(process.execPath, [SCRIPT, '--data-dir', tmpDir(), '--now', value], {
      env: cliEnv(),
      encoding: 'utf8',
      shell: false,
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--now');
  });
});
