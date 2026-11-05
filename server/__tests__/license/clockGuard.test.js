import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { select, upsert } from '../../db/query.js';
import { closeTestDb, createTestDb, seedDb } from '../helpers/testDb.js';
import {
  EVIDENCE_COLUMNS,
  checkClockRecord,
  createClockGuard,
  deriveClockKey,
  gatherEvidence,
  makeClockRecord,
} from '../../license/clockGuard.js';
import { CLOCK_FILE_NAME, CLOCK_STATE_KEY } from '../../license/constants.js';
import { loadOrCreateKeyFile } from '../../secrets/keyFile.js';
import { DAY, HOUR, T0 } from './helpers.js';

const LOG_LINE = 'license: clock record ignored (invalid)';

let dir;
let db;
let clock;
let evidence;
let logs;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-clock-'));
  db = createTestDb();
  clock = { t: T0, m: 1000 };
  evidence = { value: null };
  logs = [];
});
afterEach(() => {
  closeTestDb(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

const make = (extra = {}) =>
  createClockGuard({
    dataDir: dir,
    now: () => clock.t,
    mono: () => clock.m,
    getDb: () => db,
    gatherEvidence: () => evidence.value,
    log: (m) => logs.push(m),
    ...extra,
  });

const macKey = () => deriveClockKey(loadOrCreateKeyFile({ dir }).key);
const readFileCopy = () => JSON.parse(fs.readFileSync(path.join(dir, CLOCK_FILE_NAME), 'utf8'));
const readDbCopy = () => select('app_state', { where: { key: CLOCK_STATE_KEY }, db })[0]?.value ?? null;
const setMono = (delta) => {
  clock.m += delta;
  clock.t += delta;
};

describe('startup observation', () => {
  it('a fresh install trusts the clock and persists both copies', () => {
    const obs = make().start({});
    expect(obs).toMatchObject({ now: T0, effective: T0, hwm: T0, rollback: false, persisted: true });
    const key = macKey();
    expect(checkClockRecord(readFileCopy(), key)).toBe(T0);
    expect(checkClockRecord(readDbCopy(), key)).toBe(T0);
  });

  it('a restart moves H to now when the gap is under 72 h', () => {
    make().start({});
    clock.t = T0 + HOUR;
    const obs = make().start({});
    expect(obs).toMatchObject({ hwm: T0 + HOUR, rollback: false, effective: T0 + HOUR });
  });

  it('detects a rollback beyond 48 h but not 47 h', () => {
    make().start({});
    clock.t = T0 - 47 * HOUR;
    expect(make().start({}).rollback).toBe(false);
    clock.t = T0 - 49 * HOUR;
    const obs = make().start({});
    expect(obs.rollback).toBe(true);
    expect(obs.effective).toBe(T0);
    expect(obs.hwm).toBe(T0);
  });

  it('exactly 48 h back is tolerated', () => {
    make().start({});
    clock.t = T0 - 48 * HOUR;
    expect(make().start({}).rollback).toBe(false);
  });

  it('H never decreases across rollbacks', () => {
    make().start({});
    const seen = [];
    for (const t of [T0 - 10 * DAY, T0 + HOUR, T0 - 3 * DAY, T0 + 2 * HOUR, T0 - 40 * DAY]) {
      clock.t = t;
      seen.push(make().start({}).hwm);
    }
    for (let i = 1; i < seen.length; i += 1) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
  });

  it('build date and license issuedAt are floors', () => {
    const obs = make().start({ buildDate: T0 + 10 * DAY, issuedAt: T0 + 9 * DAY });
    expect(obs.rollback).toBe(true);
    expect(obs.effective).toBe(T0 + 10 * DAY);
    const lagging = make().start({ issuedAt: T0 + 5 * DAY });
    expect(lagging.rollback).toBe(true);
  });

  it('long absence lags and catches up 72 h per launch', () => {
    make().start({});
    clock.t = T0 + 21 * DAY;
    const marks = [];
    for (let i = 0; i < 3; i += 1) marks.push(make().start({}).hwm);
    expect(marks).toEqual([T0 + 3 * DAY, T0 + 6 * DAY, T0 + 9 * DAY]);
  });
});

describe('time zone and DST independence', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('flipping TZ never triggers a rollback (same epoch ms)', () => {
    clock.t = T0;
    for (const tz of ['UTC', 'Pacific/Kiritimati', 'Etc/GMT+12', 'America/New_York', 'Asia/Kolkata']) {
      process.env.TZ = tz;
      expect(make().start({ buildDate: T0 - DAY }).rollback).toBe(false);
    }
  });

  it('offsets of up to 26 h (UTC-12 to UTC+14) and a DST hour are tolerated, 49 h is not', () => {
    make().start({});
    for (const back of [HOUR, 14 * HOUR, 26 * HOUR, 27 * HOUR]) {
      clock.t = T0 - back;
      expect(make().start({}).rollback).toBe(false);
    }
    clock.t = T0 - 49 * HOUR;
    expect(make().start({}).rollback).toBe(true);
  });

  it('a spring forward and a fall back hour do not move epoch ms', () => {
    // 2026-11-01 06:00Z is the US fall-back instant: wall clocks repeat an hour, epoch ms is continuous.
    const fallBack = Date.parse('2026-11-01T06:00:00Z');
    clock.t = fallBack - HOUR;
    make().start({});
    for (const t of [fallBack - 1, fallBack, fallBack + 1, fallBack + HOUR]) {
      clock.t = t;
      expect(make().start({}).rollback).toBe(false);
    }
  });
});

describe('far-future clock', () => {
  const FUTURE = Date.parse('2099-06-01T00:00:00Z');

  it('moves the mark at most 72 h per launch, never to 2099', () => {
    make().start({});
    clock.t = FUTURE;
    const first = make().start({});
    expect(first.hwm).toBe(T0 + 3 * DAY);
    const second = make().start({});
    expect(second.hwm).toBe(T0 + 6 * DAY);
  });

  it('a one-off far-future launch then a correct clock leaves a time-limited license usable', () => {
    make().start({});
    clock.t = FUTURE;
    const future = make().start({});
    expect(future.effective).toBe(FUTURE);
    clock.t = T0 + DAY;
    const back = make().start({});
    expect(back.hwm).toBe(T0 + 3 * DAY);
    expect(back.rollback).toBe(false);
    expect(back.effective).toBe(T0 + 3 * DAY);
  });

  it('in-session H is bounded by monotonic elapsed time when the wall clock jumps', () => {
    const guard = make();
    guard.start({});
    clock.t = FUTURE; // wall jump, monotonic clock unchanged
    const jumped = guard.observe({});
    expect(jumped.hwm).toBe(T0);
    clock.m += 10 * 60_000; // ten real minutes pass
    clock.t = FUTURE + 10 * 60_000;
    expect(guard.observe({}).hwm).toBe(T0 + 10 * 60_000);
    clock.t = T0 + 20 * 60_000; // clock corrected
    const fixed = guard.observe({});
    expect(fixed.rollback).toBe(false);
    expect(fixed.hwm).toBe(T0 + 10 * 60_000);
  });

  it('with a valid stored copy, far-future evidence is ignored: no rollback flag, no lift, never persisted', () => {
    make().start({});
    evidence.value = FUTURE;
    const key = macKey();
    clock.t = T0 + HOUR;
    const early = make().start({});
    expect(early.rollback).toBe(false);
    expect(early.hwm).toBe(T0 + HOUR);
    expect(early.effective).toBe(T0 + HOUR);
    expect(checkClockRecord(readFileCopy(), key)).toBe(T0 + HOUR);
    // H keeps following the real clock, never the evidence.
    clock.t = T0 + 30 * HOUR;
    const later = make().start({});
    expect(later.hwm).toBe(T0 + 30 * HOUR);
    expect(later.rollback).toBe(false);
    expect(checkClockRecord(readFileCopy(), key)).toBe(T0 + 30 * HOUR);
    expect(checkClockRecord(readDbCopy(), key)).toBe(T0 + 30 * HOUR);
  });

  it('evidence is used only when no copy is valid: one invalid copy and one valid copy ignore it', () => {
    make().start({});
    fs.rmSync(path.join(dir, CLOCK_FILE_NAME));
    evidence.value = FUTURE;
    clock.t = T0 + HOUR;
    const obs = make().start({});
    expect(obs.rollback).toBe(false);
    expect(obs.effective).toBe(T0 + HOUR);
  });

  it('a tampered copy and a deleted copy leave no valid copy, so evidence seeds H again', () => {
    make().start({});
    fs.writeFileSync(path.join(dir, CLOCK_FILE_NAME), '{"v":1,"hwm":1,"mac":"x"}');
    db.prepare('DELETE FROM app_state WHERE key = ?').run(CLOCK_STATE_KEY);
    evidence.value = T0 + DAY;
    clock.t = T0 - 2 * DAY;
    const obs = make().start({ buildDate: T0 - DAY });
    expect(obs.rollback).toBe(true);
    expect(obs.effective).toBe(T0 + DAY);
  });

  it('persisting the DB copy refreshes the app_state updated_at', () => {
    make().start({});
    const read = () => db.prepare('SELECT updated_at FROM app_state WHERE key = ?').get(CLOCK_STATE_KEY).updated_at;
    expect(read()).toBe(new Date(T0).toISOString());
    clock.t = T0 + HOUR;
    make().start({});
    expect(read()).toBe(new Date(T0 + HOUR).toISOString());
  });
});

describe('in-session observation', () => {
  it('H follows real elapsed time and a rollback in session is flagged', () => {
    const guard = make();
    guard.start({});
    setMono(2 * HOUR);
    expect(guard.observe({})).toMatchObject({ hwm: T0 + 2 * HOUR, rollback: false });
    clock.t = T0 - 3 * DAY;
    const back = guard.observe({});
    expect(back.rollback).toBe(true);
    expect(back.effective).toBe(T0 + 2 * HOUR);
    expect(back.hwm).toBe(T0 + 2 * HOUR);
  });

  it('a newly installed license issuedAt joins the floor', () => {
    const guard = make();
    guard.start({});
    expect(guard.observe({ issuedAt: T0 + 10 * DAY }).rollback).toBe(true);
  });

  it('writes at most once per throttle window and only when H grew', () => {
    const guard = make();
    guard.start({});
    setMono(60_000);
    expect(guard.observe({}).persisted).toBe(false);
    setMono(10 * 60_000);
    expect(guard.observe({}).persisted).toBe(true);
    expect(checkClockRecord(readFileCopy(), macKey())).toBe(clock.t);
    expect(guard.observe({}).persisted).toBe(false);
  });

  it('observe before start behaves like a start', () => {
    expect(make().observe({}).hwm).toBe(T0);
  });
});

describe('clock storage', () => {
  it('a deleted file falls back to the DB copy and is repaired', () => {
    make().start({});
    clock.t = T0 - 10 * DAY;
    fs.rmSync(path.join(dir, CLOCK_FILE_NAME));
    const obs = make().start({});
    expect(obs.rollback).toBe(true);
    expect(checkClockRecord(readFileCopy(), macKey())).toBe(T0);
  });

  it('a deleted DB row falls back to the file copy and is rewritten', () => {
    make().start({});
    clock.t = T0 - 10 * DAY;
    db.prepare('DELETE FROM app_state WHERE key = ?').run(CLOCK_STATE_KEY);
    const obs = make().start({});
    expect(obs.rollback).toBe(true);
    expect(checkClockRecord(readDbCopy(), macKey())).toBe(T0);
  });

  it('a tampered file copy is ignored, logged without values, and repaired', () => {
    make().start({});
    const key = macKey();
    const forged = { ...readFileCopy(), hwm: T0 - 90 * DAY };
    fs.writeFileSync(path.join(dir, CLOCK_FILE_NAME), JSON.stringify(forged));
    clock.t = T0 - 10 * DAY;
    const obs = make().start({});
    expect(obs.rollback).toBe(true); // the DB copy still wins
    expect(logs).toEqual([LOG_LINE]);
    expect(logs.join('')).not.toMatch(/\d{6}/);
    expect(checkClockRecord(readFileCopy(), key)).toBe(T0);
  });

  it('a tampered DB copy is ignored too, and a raised hwm cannot expire a license early', () => {
    make().start({});
    const key = macKey();
    const forged = { ...readDbCopy(), hwm: T0 + 900 * DAY };
    upsert('app_state', { key: CLOCK_STATE_KEY, value: forged }, { conflict: ['key'], db });
    clock.t = T0 + HOUR;
    const obs = make().start({});
    expect(obs.hwm).toBe(T0 + HOUR);
    expect(obs.rollback).toBe(false);
    expect(logs).toEqual([LOG_LINE]);
    expect(checkClockRecord(readDbCopy(), key)).toBe(T0 + HOUR);
  });

  it('rejects records with a wrong shape, a bad version or an out of range hwm', () => {
    const key = macKey();
    const good = makeClockRecord(key, T0);
    for (const raw of [
      null,
      [],
      'x',
      { ...good, v: 2 },
      { ...good, extra: 1 },
      { v: 1, hwm: T0 },
      { ...good, hwm: 1.5 },
      { ...good, hwm: String(T0) },
      { ...good, mac: 'short' },
      { ...good, mac: 'A'.repeat(43) },
      makeClockRecord(key, 5),
    ]) {
      expect(checkClockRecord(raw, key)).toBeNull();
    }
    expect(checkClockRecord(good, key)).toBe(T0);
    expect(checkClockRecord(good, Buffer.alloc(32, 7))).toBeNull();
  });

  it('with both copies deleted, build date and issuedAt still catch a rollback', () => {
    make().start({ buildDate: T0 });
    fs.rmSync(path.join(dir, CLOCK_FILE_NAME));
    db.prepare('DELETE FROM app_state WHERE key = ?').run(CLOCK_STATE_KEY);
    clock.t = T0 - 10 * DAY;
    expect(make().start({ buildDate: T0 }).rollback).toBe(true);
    fs.rmSync(path.join(dir, CLOCK_FILE_NAME));
    db.prepare('DELETE FROM app_state WHERE key = ?').run(CLOCK_STATE_KEY);
    expect(make().start({ issuedAt: T0 }).rollback).toBe(true);
  });

  it('with both copies deleted, data timestamps corroborate and seed H', () => {
    evidence.value = T0 + DAY;
    clock.t = T0 - 2 * DAY;
    const obs = make().start({ buildDate: T0 - DAY });
    // floor = build date; evidence leads it by at most 72 h
    expect(obs.rollback).toBe(true);
    expect(obs.effective).toBe(T0 + DAY);
    expect(obs.hwm).toBe(T0 + DAY);
  });

  it('with no floor at all, evidence seeds H when both copies are gone', () => {
    evidence.value = T0 + DAY;
    const obs = make().start({});
    expect(obs.hwm).toBe(T0 + DAY);
    expect(obs.effective).toBe(T0 + DAY);
    expect(obs.rollback).toBe(false);
  });

  it('evidence never leads the floor by more than 72 h', () => {
    evidence.value = Date.parse('2099-01-01T00:00:00Z');
    const obs = make().start({ buildDate: T0 });
    expect(obs.effective).toBe(T0 + 3 * DAY);
  });

  it('runs without persistence and never throws when secrets.key is unavailable', () => {
    const guard = make({ loadKey: () => ({ ok: false, reason: 'unavailable' }) });
    const obs = guard.start({ buildDate: T0 - DAY });
    expect(obs).toMatchObject({ rollback: false, persisted: false });
    setMono(HOUR);
    expect(guard.observe({}).persisted).toBe(false);
    expect(fs.existsSync(path.join(dir, CLOCK_FILE_NAME))).toBe(false);
    expect(readDbCopy()).toBeNull();
    clock.t = T0 - 10 * DAY;
    expect(guard.observe({}).rollback).toBe(true);
  });

  it('survives a read-only or missing data dir and a missing database', () => {
    const missing = path.join(dir, 'does', 'not', 'exist');
    const guard = make({ dataDir: missing, getDb: () => null, loadKey: () => ({ ok: true, key: Buffer.alloc(32, 1) }) });
    expect(() => guard.start({})).not.toThrow();
    setMono(HOUR);
    expect(() => guard.observe({})).not.toThrow();
    const thrower = make({ getDb: () => { throw new Error('no db'); } });
    expect(() => thrower.start({})).not.toThrow();
  });

  it('a throwing evidence gatherer is ignored', () => {
    const guard = make({ gatherEvidence: () => { throw new Error('boom'); } });
    expect(guard.start({}).rollback).toBe(false);
  });
});

describe('evidence gathering', () => {
  const iso = (ms) => new Date(ms).toISOString();

  it('uses only the allowlist of write timestamps', () => {
    expect(EVIDENCE_COLUMNS.map(([t]) => t)).not.toContain('app_state');
    expect(EVIDENCE_COLUMNS.map(([, c]) => c).every((c) => c === 'created_at' || c === 'updated_at')).toBe(true);
  });

  it('reads the newest write timestamp and ignores user-chosen dates', () => {
    seedDb(db, {
      transactions: [{ date: '2999-01-01', merchant: 'm', amount: 1, category: 'c', type: 'expense', created_at: iso(T0 - 5 * DAY) }],
      todos: [{ title: 't', due: '2998-01-01', created_at: iso(T0 - 7 * DAY) }],
      journal: [{ title: 'j', date: '2997-01-01T00:00:00Z', body: 'b', created_at: iso(T0 - 6 * DAY) }],
      calendar_events: [{ summary: 'e', start_at: '2996-01-01T00:00:00Z', end_at: '2996-01-01T01:00:00Z', created_at: iso(T0 - 9 * DAY) }],
      countdowns: [{ title: 'c', target_date: '2995-01-01', created_at: iso(T0 - 8 * DAY) }],
    });
    expect(gatherEvidence({ dataDir: dir, getDb: () => db })).toBe(T0 - 5 * DAY);
  });

  it('reads data dir mtimes', () => {
    const stamp = Date.parse('2026-06-01T00:00:00Z') / 1000;
    fs.writeFileSync(path.join(dir, 'burrow.db'), '');
    fs.utimesSync(path.join(dir, 'burrow.db'), stamp, stamp);
    expect(gatherEvidence({ dataDir: dir, getDb: () => null })).toBe(stamp * 1000);
  });

  it('reads a backups folder: entry mtimes and dates in file names', () => {
    const backups = path.join(dir, 'backups');
    fs.mkdirSync(backups);
    const old = Date.parse('2026-01-01T00:00:00Z') / 1000;
    const named = path.join(backups, 'burrow-2026-08-15.zip');
    const plain = path.join(backups, 'something-else');
    fs.writeFileSync(named, '');
    fs.writeFileSync(plain, '');
    fs.utimesSync(named, old, old);
    fs.utimesSync(plain, Date.parse('2026-03-01T00:00:00Z') / 1000, Date.parse('2026-03-01T00:00:00Z') / 1000);
    expect(gatherEvidence({ dataDir: dir, getDb: () => null })).toBe(Date.parse('2026-08-15T00:00:00Z'));
  });

  it('drops out of range values and tolerates absent sources', () => {
    const f = path.join(dir, 'burrow.db');
    fs.writeFileSync(f, '');
    fs.utimesSync(f, 1000, 1000); // 1970
    expect(gatherEvidence({ dataDir: dir, getDb: () => null })).toBeNull();
    expect(gatherEvidence({ dataDir: path.join(dir, 'nope'), getDb: () => { throw new Error('x'); } })).toBeNull();
    fs.writeFileSync(path.join(dir, 'backups'), 'not a folder');
    expect(gatherEvidence({ dataDir: dir, getDb: () => null })).toBeNull();
  });
});
