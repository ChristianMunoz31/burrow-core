// Scenario tests for the clock guard (docs/LICENSING.md sections 7 and 18): simulated DST shifts in `now`,
// the far-future cap, expiry that survives a rollback end to end, evidence through the real gatherer, and MAC
// handling across installs. Every time source is injected; nothing here waits on a real clock.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { select, upsert } from '../../db/query.js';
import { closeTestDb, createTestDb, seedDb } from '../helpers/testDb.js';
import {
  checkClockRecord,
  createClockGuard,
  deriveClockKey,
  gatherEvidence,
  makeClockRecord,
} from '../../license/clockGuard.js';
import { evaluateLicense } from '../../license/entitlements.js';
import { CLOCK_FILE_NAME, CLOCK_STATE_KEY } from '../../license/constants.js';
import { loadOrCreateKeyFile } from '../../secrets/keyFile.js';
import { DAY, HOUR, T0, activeOf, iso as licenseIso } from './helpers.js';

const FUTURE = Date.parse('2099-06-01T00:00:00Z');
const ms = (iso) => Date.parse(iso);
const iso = (t) => new Date(t).toISOString();

let dir;
let db;
let clock;
let logs;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-clock-scn-'));
  db = createTestDb();
  clock = { t: T0, m: 1000 };
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
    gatherEvidence: () => null,
    log: (m) => logs.push(m),
    ...extra,
  });

const macKey = () => deriveClockKey(loadOrCreateKeyFile({ dir }).key);
const filePath = () => path.join(dir, CLOCK_FILE_NAME);
const readFileCopy = () => JSON.parse(fs.readFileSync(filePath(), 'utf8'));
const readDbCopy = () => select('app_state', { where: { key: CLOCK_STATE_KEY }, db })[0]?.value ?? null;
const deleteBothCopies = () => {
  fs.rmSync(filePath(), { force: true });
  db.prepare('DELETE FROM app_state WHERE key = ?').run(CLOCK_STATE_KEY);
};
const touch = (file, t) => fs.utimesSync(file, t / 1000, t / 1000);

// A yearly edition whose store expiry shortens it to T0 + 30 d (the clock guard reads expiry the same way).
const EXP = T0 + 30 * DAY;
const activation = activeOf({ edition: 'student', purchaseDate: licenseIso(T0), updatesUntil: licenseIso(EXP), expiresAt: licenseIso(EXP) });
const evaluate = (obs, buildDate = T0) => evaluateLicense({ activation, buildInfo: { buildDate }, clock: obs });

describe('simulated DST: a wall-clock shift of +-1 h in now (epoch math, not the TZ env)', () => {
  it('across restarts a +-1 h shift never flags a rollback and effective never drops below H', () => {
    make().start({});
    let prevHwm = T0;
    for (const delta of [-HOUR, HOUR, -HOUR, -HOUR, HOUR, HOUR, -HOUR]) {
      clock.t += delta;
      const obs = make().start({});
      expect(obs.rollback).toBe(false);
      expect(obs.effective).toBeGreaterThanOrEqual(prevHwm);
      expect(obs.hwm).toBeGreaterThanOrEqual(prevHwm);
      prevHwm = obs.hwm;
    }
  });

  it('in session a +-1 h shift of now is not a rollback; H is bounded by monotonic time and never decreases', () => {
    const guard = make();
    guard.start({});
    clock.t = T0 + HOUR; // spring forward: wall jumps, monotonic clock does not
    const fwd = guard.observe({});
    expect(fwd.rollback).toBe(false);
    expect(fwd.hwm).toBe(T0);
    clock.t = T0 - HOUR; // fall back, two hours earlier than the jump
    const back = guard.observe({});
    expect(back.rollback).toBe(false);
    expect(back.hwm).toBe(T0);
    expect(back.effective).toBe(T0);
  });

  it('a DST hour on top of a 47 h skew is still tolerated; one millisecond past 48 h is not', () => {
    make().start({});
    clock.t = T0 - 47 * HOUR - HOUR; // 47 h skew plus a fall-back hour = exactly 48 h
    expect(make().start({}).rollback).toBe(false);
    clock.t = T0 - 48 * HOUR - 1;
    expect(make().start({}).rollback).toBe(true);
  });

  it('a fall-back hour never un-expires a license that just expired', () => {
    clock.t = EXP + 30 * 60_000; // thirty minutes past expiry, the clock then falls back an hour
    const first = make().start({});
    expect(evaluate(first).state).toBe('expired');
    clock.t -= HOUR; // wall clock now reads 30 minutes before expiry
    const second = make().start({});
    expect(second.rollback).toBe(false);
    expect(second.effective).toBe(EXP + 30 * 60_000);
    expect(evaluate(second)).toMatchObject({ state: 'expired', pro: false });
  });

  describe('TZ env changes', () => {
    const originalTz = process.env.TZ;
    afterEach(() => {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    });

    it('do not change persisted H, the expiry boundary or the evidence read from dated backup names', () => {
      fs.mkdirSync(path.join(dir, 'backups'));
      fs.writeFileSync(path.join(dir, 'backups', 'burrow-2026-08-15.zip'), '');
      touch(path.join(dir, 'backups', 'burrow-2026-08-15.zip'), ms('2026-01-01T00:00:00Z'));
      for (const tz of ['UTC', 'Pacific/Kiritimati', 'Etc/GMT+12', 'America/New_York', 'Asia/Kolkata']) {
        process.env.TZ = tz;
        expect(gatherEvidence({ dataDir: dir, getDb: () => null })).toBe(ms('2026-08-15T00:00:00Z'));
        expect(evaluate({ now: EXP - 1000, effective: EXP - 1000, rollback: false }).state).toBe('pro');
        expect(evaluate({ now: EXP, effective: EXP, rollback: false }).state).toBe('expired');
      }
      for (const tz of ['Pacific/Kiritimati', 'America/New_York']) {
        process.env.TZ = tz;
        expect(make().start({})).toMatchObject({ rollback: false, hwm: T0, effective: T0 });
      }
    });
  });
});

describe('far-future clock', () => {
  it('repeated far-future launches advance H by exactly 72 h each and persist only that', () => {
    make().start({});
    clock.t = FUTURE;
    const key = macKey();
    for (let i = 1; i <= 5; i += 1) {
      const obs = make().start({});
      expect(obs.hwm).toBe(T0 + i * 3 * DAY);
      expect(obs.rollback).toBe(false);
      expect(checkClockRecord(readFileCopy(), key)).toBe(T0 + i * 3 * DAY);
      expect(checkClockRecord(readDbCopy(), key)).toBe(T0 + i * 3 * DAY);
    }
  });

  it('a far-future launch expires a yearly license for that launch only; the next correct launch is usable again', () => {
    make().start({});
    clock.t = FUTURE;
    expect(evaluate(make().start({}))).toMatchObject({ state: 'expired', pro: false });
    clock.t = T0 + DAY;
    const back = make().start({});
    expect(back.rollback).toBe(false);
    expect(evaluate(back)).toMatchObject({ state: 'pro', pro: true });
  });

  it('far-future evidence with a valid copy has no effect: effective is the wall clock', () => {
    make().start({});
    clock.t = T0 + HOUR;
    const obs = make({ gatherEvidence: () => FUTURE }).start({});
    expect(obs.effective).toBe(T0 + HOUR);
    expect(obs.hwm).toBe(T0 + HOUR);
    expect(obs.rollback).toBe(false);
  });

  it('far-future evidence seeding an install with no valid copy lifts effective time by at most 72 h over the floor', () => {
    const obs = make({ gatherEvidence: () => FUTURE }).start({ buildDate: T0 });
    expect(obs.effective).toBe(T0 + 3 * DAY);
  });

  describe('honest user with one far-future data row (an import from a machine whose clock ran ahead)', () => {
    const evidenceFuture = { gatherEvidence: () => FUTURE };

    it('seven daily (20 h) relaunches never flag a rollback, effective is now and H tracks the real clock', () => {
      make().start({});
      for (let launch = 1; launch <= 7; launch += 1) {
        clock.t += 20 * HOUR;
        const obs = make(evidenceFuture).start({});
        expect(obs.rollback, `launch ${launch}`).toBe(false);
        expect(obs.effective, `launch ${launch}`).toBe(clock.t);
        expect(obs.hwm, `launch ${launch}`).toBe(clock.t);
        expect(checkClockRecord(readFileCopy(), macKey())).toBe(clock.t);
      }
    });

    it('a yearly license expiring in 60 h stays Pro through the relaunches before its expiry', () => {
      clock.t = EXP - 60 * HOUR;
      make().start({});
      for (const left of [40, 20]) {
        clock.t = EXP - left * HOUR;
        const obs = make(evidenceFuture).start({});
        expect(obs.rollback).toBe(false);
        expect(evaluate(obs)).toMatchObject({ state: 'pro', pro: true });
      }
      clock.t = EXP + HOUR;
      expect(evaluate(make(evidenceFuture).start({}))).toMatchObject({ state: 'expired', pro: false });
    });
  });
});

describe('expired stays expired after a clock rollback (guard plus entitlements)', () => {
  // Daily launches keep H at the wall clock (gaps under 72 h), so H reaches the expiry date.
  const runDaily = (fromDay, toDay) => {
    let obs;
    for (let d = fromDay; d <= toDay; d += 1) {
      clock.t = T0 + d * DAY;
      obs = make().start({});
    }
    return obs;
  };

  it('Pro until expiresAt, then expired; a rollback past 48 h gives clock_issue, never pro', () => {
    expect(evaluate(runDaily(0, 29))).toMatchObject({ state: 'pro', pro: true });
    expect(evaluate(runDaily(30, 31))).toMatchObject({ state: 'expired', pro: false });

    clock.t = EXP - 10 * DAY;
    const rolled = make().start({});
    expect(rolled.rollback).toBe(true);
    expect(rolled.effective).toBe(T0 + 31 * DAY);
    expect(evaluate(rolled)).toMatchObject({ state: 'clock_issue', pro: false });
    expect(evaluate(rolled).reasons).toEqual(['clock_issue', 'clock_rollback']);
    expect(rolled.hwm).toBe(T0 + 31 * DAY);
  });

  it('a rollback inside the 48 h tolerance leaves the license expired, with no rollback flag', () => {
    runDaily(0, 31);
    clock.t = T0 + 31 * DAY - 47 * HOUR; // wall is before expiresAt, but H is past it
    const obs = make().start({});
    expect(obs.rollback).toBe(false);
    expect(obs.now).toBeLessThan(EXP);
    expect(evaluate(obs)).toMatchObject({ state: 'expired', pro: false, reasons: ['expired'] });
  });

  it('after the clock is corrected it reads plainly expired, and the whole cycle never reports pro', () => {
    runDaily(0, 31);
    const seen = [];
    for (const t of [EXP - 10 * DAY, EXP - 5 * DAY, EXP + 2 * DAY, EXP + 3 * DAY]) {
      clock.t = t;
      seen.push(evaluate(make().start({})));
    }
    expect(seen.map((e) => e.state)).toEqual(['clock_issue', 'clock_issue', 'expired', 'expired']);
    expect(seen.some((e) => e.pro)).toBe(false);
    expect(seen[2].reasons).toEqual(['expired']);
  });

  it('in session: expiry reached, then the clock is set back, stays expired or clock_issue', () => {
    const guard = make();
    guard.start({});
    clock.m += 31 * DAY;
    clock.t = EXP + DAY;
    expect(evaluate(guard.observe({}))).toMatchObject({ state: 'expired' });
    clock.t = EXP - 5 * DAY; // monotonic time did not move
    const rolled = guard.observe({});
    expect(rolled.rollback).toBe(true);
    expect(evaluate(rolled)).toMatchObject({ state: 'clock_issue', pro: false });
    clock.t = EXP - DAY; // exactly 48 h behind H (EXP + 1 day): tolerated, still expired
    const edge = guard.observe({});
    expect(edge.rollback).toBe(false);
    expect(evaluate(edge)).toMatchObject({ state: 'expired', pro: false });
  });
});

describe('both copies deleted: corroboration through the real evidence gatherer', () => {
  const realEvidence = () => ({ gatherEvidence: () => gatherEvidence({ dataDir: dir, getDb: () => db }) });
  const prime = () => {
    macKey(); // creates secrets.key so its own mtime is controlled below
    touch(path.join(dir, 'secrets.key'), T0 - 400 * DAY);
  };

  it('a data-dir file mtime ahead of the clock flags a rollback', () => {
    prime();
    fs.writeFileSync(path.join(dir, 'burrow.db'), '');
    touch(path.join(dir, 'burrow.db'), T0 + DAY);
    clock.t = T0 - 2 * DAY;
    const obs = make(realEvidence()).start({ buildDate: T0 - DAY });
    expect(obs.rollback).toBe(true);
    expect(obs.effective).toBe(T0 + DAY);
  });

  it('a backups folder entry mtime ahead of the clock flags a rollback', () => {
    prime();
    fs.mkdirSync(path.join(dir, 'backups'));
    const file = path.join(dir, 'backups', 'snapshot');
    fs.writeFileSync(file, '');
    touch(file, T0 + DAY);
    clock.t = T0 - 2 * DAY;
    const obs = make(realEvidence()).start({ buildDate: T0 - DAY });
    expect(obs.rollback).toBe(true);
    expect(obs.effective).toBe(T0 + DAY);
  });

  it('a date in a backup file name ahead of the clock flags a rollback', () => {
    prime();
    fs.mkdirSync(path.join(dir, 'backups'));
    const file = path.join(dir, 'backups', `burrow-${iso(T0 + 2 * DAY).slice(0, 10)}.zip`);
    fs.writeFileSync(file, '');
    touch(file, T0 - 300 * DAY);
    clock.t = T0 - 2 * DAY;
    const obs = make(realEvidence()).start({ buildDate: T0 - DAY });
    expect(obs.rollback).toBe(true);
    expect(obs.effective).toBe(ms('2026-10-07T00:00:00Z'));
  });

  it('a write timestamp in the data ahead of the clock flags a rollback', () => {
    prime();
    seedDb(db, {
      transactions: [{ date: '2026-01-01', merchant: 'm', amount: 1, category: 'c', type: 'expense', created_at: iso(T0 + DAY) }],
    });
    clock.t = T0 - 2 * DAY;
    const obs = make(realEvidence()).start({ buildDate: T0 - DAY });
    expect(obs.rollback).toBe(true);
    expect(obs.effective).toBe(T0 + DAY);
  });

  it('user-chosen dates far in the future do not trigger anything', () => {
    prime();
    seedDb(db, {
      transactions: [{ date: '2999-01-01', merchant: 'm', amount: 1, category: 'c', type: 'expense', created_at: iso(T0 - 10 * DAY) }],
      todos: [{ title: 't', due: '2998-01-01', created_at: iso(T0 - 11 * DAY) }],
      calendar_events: [{ summary: 'e', start_at: '2997-01-01T00:00:00Z', end_at: '2997-01-01T01:00:00Z', created_at: iso(T0 - 12 * DAY) }],
      countdowns: [{ title: 'c', target_date: '2996-01-01', created_at: iso(T0 - 13 * DAY) }],
    });
    const obs = make(realEvidence()).start({ buildDate: T0 - DAY });
    expect(obs.rollback).toBe(false);
    expect(obs.effective).toBe(T0);
  });

  it('with the guard files deleted after a normal run, a rolled-back clock is caught from data timestamps', () => {
    prime();
    seedDb(db, {
      transactions: [{ date: '2026-01-01', merchant: 'm', amount: 1, category: 'c', type: 'expense', created_at: iso(T0) }],
    });
    make(realEvidence()).start({});
    deleteBothCopies();
    clock.t = T0 - 10 * DAY;
    const obs = make(realEvidence()).start({ buildDate: T0 - 10 * DAY });
    expect(obs.rollback).toBe(true);
    expect(obs.effective).toBe(T0 - 7 * DAY); // capped at floor + 72 h
  });
});

describe('MAC handling', () => {
  it('records copied from another install (valid MAC under a different secrets.key) are ignored in both places', () => {
    make().start({});
    const other = deriveClockKey(Buffer.alloc(32, 9));
    const foreign = makeClockRecord(other, T0 - 90 * DAY);
    fs.writeFileSync(filePath(), JSON.stringify(foreign));
    upsert('app_state', { key: CLOCK_STATE_KEY, value: foreign }, { conflict: ['key'], db });
    clock.t = T0 + HOUR;
    const obs = make().start({});
    expect(logs).toEqual(['license: clock record ignored (invalid)', 'license: clock record ignored (invalid)']);
    expect(obs).toMatchObject({ hwm: T0 + HOUR, rollback: false });
    // both copies were repaired under this install's key
    expect(checkClockRecord(readFileCopy(), macKey())).toBe(T0 + HOUR);
    expect(checkClockRecord(readDbCopy(), macKey())).toBe(T0 + HOUR);
  });

  it('with both copies forged lower, build date and issuedAt floors still catch a rollback', () => {
    make().start({ buildDate: T0 });
    const key = macKey();
    const forged = { v: 1, hwm: T0 - 100 * DAY, mac: makeClockRecord(key, T0).mac };
    fs.writeFileSync(filePath(), JSON.stringify(forged));
    upsert('app_state', { key: CLOCK_STATE_KEY, value: forged }, { conflict: ['key'], db });
    clock.t = T0 - 10 * DAY;
    const obs = make().start({ buildDate: T0 });
    expect(obs.rollback).toBe(true);
    expect(obs.effective).toBe(T0);
  });

  it('a valid but older record in one place loses to the newer valid record in the other', () => {
    const guard = make();
    guard.start({});
    const key = macKey();
    const older = makeClockRecord(key, T0 - 20 * DAY);
    fs.writeFileSync(filePath(), JSON.stringify(older));
    clock.t = T0 - 10 * DAY;
    const obs = make().start({});
    expect(logs).toEqual([]);
    expect(obs.rollback).toBe(true); // the DB copy still says T0
    expect(obs.effective).toBe(T0);
  });

  it('a single flipped MAC character is rejected', () => {
    const key = macKey();
    const good = makeClockRecord(key, T0);
    const flipped = `${good.mac[0] === 'A' ? 'B' : 'A'}${good.mac.slice(1)}`;
    expect(checkClockRecord({ ...good, mac: flipped }, key)).toBeNull();
    expect(checkClockRecord({ ...good, hwm: good.hwm + 1 }, key)).toBeNull();
  });
});
