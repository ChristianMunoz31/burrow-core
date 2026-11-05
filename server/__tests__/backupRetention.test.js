// Retention math (pure plan, injected clock, no real waiting), settings validation, and applying a
// plan to real files. Calendar buckets are local-time, so every date here is built in local time.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../db/index.js';
import { createFsOps } from '../backup/fsops.js';
import { listMetas, writeMeta } from '../backup/manifest.js';
import { backupsDir, ensureBackupsDir, newBackupId } from '../backup/paths.js';
import { dayKey, isoWeekKey, monthKey, planRetention } from '../backup/retention.js';
import { applyRetention, cleanupOrphans } from '../backup/service.js';
import {
  BACKUP_SETTINGS_KEY,
  DEFAULT_BACKUP_SETTINGS,
  getBackupSettings,
  saveBackupSettings,
  validateBackupSettings,
} from '../backup/settings.js';
import { getState, setState } from '../dataAccess.js';
import { cleanupBackupEnv, localNoon, names, resetBackupEnv } from './helpers/backupEnv.js';

beforeEach(() => {
  resetBackupEnv();
});
afterAll(() => {
  cleanupBackupEnv();
});

let counter = 0;
const rand = () => (counter += 1).toString(16).padStart(6, '0');

/** A meta as the planner sees it. */
function meta(date, { kind = 'auto', status = 'verified' } = {}) {
  return {
    id: newBackupId(kind, date, rand),
    kind,
    status,
    createdAt: date.toISOString(),
    db: status === 'verified' ? { file: 'x', bytes: 1, sha256: 'x' } : null,
  };
}

const dailySeries = (start, count, opts) =>
  Array.from({ length: count }, (_, i) => meta(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i, 12), opts));

const plan = (metas, s, now = new Date(2030, 0, 1)) => planRetention(metas, { keepDaily: 7, keepWeekly: 4, keepMonthly: 6, ...s }, now);
const days = (list) => list.map((m) => dayKey(new Date(m.createdAt))).sort();
const ids = (list) => new Set(list.map((m) => m.id));

// Independent oracle: buckets by calendar date, Monday of the week, and year*12+month.
const mondayOf = (d) => {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  return `${t.getFullYear()}-${t.getMonth()}-${t.getDate()}`;
};
const monthOf = (d) => d.getFullYear() * 12 + d.getMonth();
function oracle(metas, { keepDaily, keepWeekly, keepMonthly }) {
  const newestFirst = [...metas].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const keep = new Set();
  for (const [count, keyOf] of [
    [keepDaily, (d) => d.toDateString()],
    [keepWeekly, mondayOf],
    [keepMonthly, monthOf],
  ]) {
    const seen = new Set();
    for (const m of newestFirst) {
      const k = keyOf(new Date(m.createdAt));
      if (seen.has(k)) continue;
      if (seen.size >= count) break;
      seen.add(k);
      keep.add(m.id);
    }
  }
  if (newestFirst.length) keep.add(newestFirst[0].id);
  return keep;
}

describe('retention math: daily, weekly, monthly representatives', () => {
  it('120 daily backups keep exactly 7 daily + 4 weekly + 6 monthly representatives, overlaps counted once', () => {
    const metas = dailySeries(new Date(2026, 0, 1), 120);
    const now = localNoon(2026, 4, 30);
    const { keep, remove } = plan(metas, {}, now);
    // 2026-01-01 is a Thursday, so the newest backup (Apr 30) is a Thursday too.
    expect(days(keep)).toEqual([
      '2026-01-31', // month Jan
      '2026-02-28', // month Feb
      '2026-03-31', // month Mar
      '2026-04-12', // week Apr 6-12
      '2026-04-19', // week Apr 13-19
      '2026-04-24',
      '2026-04-25',
      '2026-04-26', // daily and week Apr 20-26
      '2026-04-27',
      '2026-04-28',
      '2026-04-29',
      '2026-04-30', // daily, current week and current month
    ]);
    expect(keep).toHaveLength(12);
    expect(keep).toHaveLength(7 + (4 - 2) + (4 - 1)); // 4 weeks minus 2 overlaps, 4 months (only 4 exist) minus 1 overlap
    expect(remove).toHaveLength(108);
    expect(ids(keep)).toEqual(oracle(metas, { keepDaily: 7, keepWeekly: 4, keepMonthly: 6 }));
  });

  it('250 daily backups reach all 6 monthly representatives', () => {
    const metas = dailySeries(new Date(2026, 0, 1), 250);
    const { keep, remove } = plan(metas, {}, localNoon(2026, 9, 7));
    expect(days(keep)).toEqual([
      '2026-04-30',
      '2026-05-31',
      '2026-06-30',
      '2026-07-31',
      '2026-08-23', // week Aug 17-23
      '2026-08-30', // week Aug 24-30
      '2026-08-31', // month Aug
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
      '2026-09-05',
      '2026-09-06', // daily and week Aug 31-Sep 6
      '2026-09-07',
    ]);
    expect(remove).toHaveLength(250 - 14);
    expect(ids(keep)).toEqual(oracle(metas, { keepDaily: 7, keepWeekly: 4, keepMonthly: 6 }));
  });

  it.each([
    [{ keepDaily: 1, keepWeekly: 0, keepMonthly: 0 }],
    [{ keepDaily: 3, keepWeekly: 2, keepMonthly: 1 }],
    [{ keepDaily: 60, keepWeekly: 52, keepMonthly: 60 }],
    [{ keepDaily: 14, keepWeekly: 0, keepMonthly: 3 }],
    [{ keepDaily: 2, keepWeekly: 9, keepMonthly: 0 }],
  ])('matches the independent oracle for %o', (settings) => {
    const metas = dailySeries(new Date(2025, 10, 3), 200);
    expect(ids(plan(metas, settings).keep)).toEqual(oracle(metas, settings));
  });

  it('keep and remove partition the input and keep is newest first', () => {
    const metas = dailySeries(new Date(2026, 0, 1), 40);
    const { keep, remove } = plan(metas, { keepDaily: 3, keepWeekly: 1, keepMonthly: 1 });
    expect(keep.length + remove.length).toBe(40);
    expect(new Set([...ids(keep), ...ids(remove)]).size).toBe(40);
    const times = keep.map((m) => Date.parse(m.createdAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('does not depend on the input order', () => {
    const metas = dailySeries(new Date(2026, 0, 1), 60);
    const shuffled = [...metas].sort((a, b) => (a.id < b.id ? -1 : 1)).reverse();
    expect(ids(plan(shuffled, {}).keep)).toEqual(ids(plan(metas, {}).keep));
  });

  it('with no backups the plan is empty', () => {
    expect(plan([], {})).toEqual({ keep: [], remove: [] });
  });

  it('several backups on one day: only the newest represents the day', () => {
    const metas = [8, 12, 18].map((h) => meta(localNoon(2026, 2, 5, h)));
    const { keep, remove } = plan(metas, { keepDaily: 1, keepWeekly: 0, keepMonthly: 0 });
    expect(keep.map((m) => m.createdAt)).toEqual([localNoon(2026, 2, 5, 18).toISOString()]);
    expect(remove).toHaveLength(2);
  });

  it('manual and automatic backups share the same buckets', () => {
    const metas = [meta(localNoon(2026, 2, 5, 9), { kind: 'auto' }), meta(localNoon(2026, 2, 5, 20), { kind: 'manual' })];
    const { keep } = plan(metas, { keepDaily: 1, keepWeekly: 0, keepMonthly: 0 });
    expect(keep.map((m) => m.kind)).toEqual(['manual']);
  });

  it('an equal timestamp is broken deterministically by id', () => {
    const when = localNoon(2026, 2, 5);
    const a = { ...meta(when), id: '20260205T120000Z-auto-000001' };
    const b = { ...meta(when), id: '20260205T120000Z-auto-000002' };
    const first = plan([a, b], { keepDaily: 1, keepWeekly: 0, keepMonthly: 0 }).keep.map((m) => m.id);
    const second = plan([b, a], { keepDaily: 1, keepWeekly: 0, keepMonthly: 0 }).keep.map((m) => m.id);
    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
  });

  it('entries with an unusable timestamp are ignored rather than crashing', () => {
    const good = meta(localNoon(2026, 2, 5));
    const bad = { ...meta(localNoon(2026, 2, 6)), createdAt: 'not a date' };
    const { keep, remove } = plan([good, bad], {});
    expect(keep.map((m) => m.id)).toEqual([good.id]);
    expect(remove).toEqual([]);
  });
});

describe('retention with sparse days (the computer was off for weeks)', () => {
  const sparse = () =>
    [
      [2026, 1, 1],
      [2026, 1, 11],
      [2026, 1, 21],
      [2026, 1, 31],
      [2026, 2, 10],
      [2026, 2, 20],
      [2026, 3, 2],
      [2026, 3, 12],
      [2026, 3, 22],
      [2026, 4, 1],
    ].map(([y, m, d]) => meta(localNoon(y, m, d)));

  it('keepDaily counts days that have a backup, not calendar days', () => {
    const metas = sparse();
    const { keep } = plan(metas, { keepDaily: 7, keepWeekly: 0, keepMonthly: 0 }, localNoon(2026, 4, 2));
    expect(days(keep)).toEqual(['2026-02-20', '2026-03-02', '2026-03-12', '2026-03-22', '2026-04-01', '2026-02-10', '2026-01-31'].sort());
  });

  it('weeks and months with no backup do not use up a slot', () => {
    const metas = sparse();
    // Every backup sits in its own week, so 4 weekly slots reach back 4 backups, not 4 calendar weeks.
    const weekly = plan(metas, { keepDaily: 1, keepWeekly: 4, keepMonthly: 0 }, localNoon(2026, 4, 2));
    expect(days(weekly.keep)).toEqual(['2026-03-02', '2026-03-12', '2026-03-22', '2026-04-01']);
    const monthly = plan(metas, { keepDaily: 1, keepWeekly: 0, keepMonthly: 3 }, localNoon(2026, 4, 2));
    expect(days(monthly.keep)).toEqual(['2026-02-20', '2026-03-22', '2026-04-01']);
  });

  it('a long gap does not drop the only backups there are', () => {
    const metas = [meta(localNoon(2025, 6, 1)), meta(localNoon(2025, 6, 2))];
    const { keep, remove } = plan(metas, { keepDaily: 7, keepWeekly: 4, keepMonthly: 6 }, localNoon(2026, 6, 1));
    expect(keep).toHaveLength(2);
    expect(remove).toHaveLength(0);
  });

  it('the clock is only used for age-based rules (safety and failed copies), not for the daily scheme', () => {
    const metas = dailySeries(new Date(2026, 0, 1), 10);
    const early = plan(metas, { keepDaily: 3, keepWeekly: 0, keepMonthly: 0 }, localNoon(2026, 1, 11));
    const late = plan(metas, { keepDaily: 3, keepWeekly: 0, keepMonthly: 0 }, localNoon(2030, 1, 11));
    expect(ids(early.keep)).toEqual(ids(late.keep));
  });
});

describe('ISO week and calendar boundaries', () => {
  it.each([
    [new Date(2026, 11, 28), '2026-W53'], // Monday
    [new Date(2026, 11, 29), '2026-W53'],
    [new Date(2026, 11, 31), '2026-W53'],
    [new Date(2027, 0, 1), '2026-W53'], // Friday: still the old week-year
    [new Date(2027, 0, 3), '2026-W53'], // Sunday
    [new Date(2027, 0, 4), '2027-W01'], // Monday
    [new Date(2024, 11, 29), '2024-W52'], // Sunday
    [new Date(2024, 11, 30), '2025-W01'], // Monday: new week-year starts before Jan 1
    [new Date(2025, 0, 1), '2025-W01'],
    [new Date(2025, 11, 28), '2025-W52'],
    [new Date(2025, 11, 29), '2026-W01'],
    [new Date(2021, 0, 1), '2020-W53'],
    [new Date(2021, 0, 4), '2021-W01'],
    [new Date(2026, 5, 15), '2026-W25'],
  ])('isoWeekKey(%s) is %s', (date, key) => {
    expect(isoWeekKey(date)).toBe(key);
  });

  it('isoWeekKey ignores the time of day', () => {
    expect(isoWeekKey(new Date(2027, 0, 3, 23, 59, 59))).toBe('2026-W53');
    expect(isoWeekKey(new Date(2027, 0, 4, 0, 0, 1))).toBe('2027-W01');
  });

  it('Dec 29 to Jan 4: two backups in the same ISO week across New Year are one weekly bucket', () => {
    const metas = [
      localNoon(2026, 12, 29),
      localNoon(2026, 12, 30),
      localNoon(2026, 12, 31),
      localNoon(2027, 1, 1),
      localNoon(2027, 1, 2),
      localNoon(2027, 1, 3),
      localNoon(2027, 1, 4),
    ].map((d) => meta(d));
    const { keep } = plan(metas, { keepDaily: 1, keepWeekly: 2, keepMonthly: 0 }, localNoon(2027, 1, 4));
    // Jan 4 (2027-W01) and Jan 3 (newest of 2026-W53). Jan 1 does not represent the week.
    expect(days(keep)).toEqual(['2027-01-03', '2027-01-04']);
  });

  it('the weekly scheme does not merge the same week number from different years', () => {
    const metas = [meta(localNoon(2025, 1, 2)), meta(localNoon(2026, 1, 2))];
    expect(isoWeekKey(new Date(2025, 0, 2))).toBe('2025-W01');
    expect(isoWeekKey(new Date(2026, 0, 2))).toBe('2026-W01');
    const { keep } = plan(metas, { keepDaily: 1, keepWeekly: 2, keepMonthly: 0 }, localNoon(2026, 1, 3));
    expect(keep).toHaveLength(2);
  });

  it('month boundaries: Jan 31 late evening and Feb 1 just after midnight are different day, week-or-not, and month buckets', () => {
    const late = new Date(2026, 0, 31, 23, 30);
    const early = new Date(2026, 1, 1, 0, 30);
    expect(dayKey(late)).toBe('2026-01-31');
    expect(dayKey(early)).toBe('2026-02-01');
    expect(monthKey(late)).toBe('2026-01');
    expect(monthKey(early)).toBe('2026-02');
    const { keep } = plan([meta(late), meta(early)], { keepDaily: 1, keepWeekly: 0, keepMonthly: 2 });
    expect(keep).toHaveLength(2);
  });

  it('month keys pad single digits and keep the year', () => {
    expect(monthKey(new Date(2026, 8, 5))).toBe('2026-09');
    expect(monthKey(new Date(2027, 11, 31))).toBe('2027-12');
    expect(dayKey(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('a leap day is its own day and the last day of February', () => {
    const metas = [meta(localNoon(2028, 2, 29)), meta(localNoon(2028, 2, 28)), meta(localNoon(2028, 3, 1))];
    const { keep } = plan(metas, { keepDaily: 3, keepWeekly: 0, keepMonthly: 0 });
    expect(days(keep)).toEqual(['2028-02-28', '2028-02-29', '2028-03-01']);
    const monthly = plan(metas, { keepDaily: 1, keepWeekly: 0, keepMonthly: 2 });
    expect(days(monthly.keep)).toEqual(['2028-02-29', '2028-03-01']);
  });
});

describe('retention of safety copies', () => {
  const now = localNoon(2026, 6, 30);
  const ago = (n, opts) => meta(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n, 12), opts);

  it('keeps the newest three even when old, plus anything younger than 30 days', () => {
    const safeties = [40, 50, 60, 70, 80].map((n) => ago(n, { kind: 'safety' }));
    const { keep, remove } = plan([ago(0), ...safeties], {}, now);
    expect(keep.filter((m) => m.kind === 'safety').map((m) => m.id)).toEqual(safeties.slice(0, 3).map((m) => m.id));
    expect(remove.map((m) => m.id).sort()).toEqual(safeties.slice(3).map((m) => m.id).sort());
  });

  it('all safety copies younger than 30 days stay, however many there are', () => {
    const safeties = [1, 2, 3, 4, 5, 6, 20, 29].map((n) => ago(n, { kind: 'safety' }));
    const { remove } = plan([ago(0), ...safeties], {}, now);
    expect(remove).toEqual([]);
  });

  it('exactly 30 days old is no longer protected by age', () => {
    const safeties = [ago(1, { kind: 'safety' }), ago(2, { kind: 'safety' }), ago(3, { kind: 'safety' }), ago(30, { kind: 'safety' })];
    const { remove } = plan([ago(0), ...safeties], {}, localNoon(2026, 6, 30));
    expect(remove.map((m) => m.id)).toEqual([safeties[3].id]);
  });

  it('safety copies do not use up daily, weekly or monthly slots', () => {
    const auto = ago(2);
    const safety = ago(0, { kind: 'safety' });
    const { keep } = plan([auto, safety], { keepDaily: 1, keepWeekly: 0, keepMonthly: 0 }, now);
    expect(ids(keep)).toEqual(new Set([auto.id, safety.id]));
  });

  it('a failed safety copy is not pinned like a verified one', () => {
    const failed = ago(100, { kind: 'safety', status: 'failed' });
    const { remove } = plan([ago(0), failed], {}, now);
    expect(remove.map((m) => m.id)).toEqual([failed.id]);
  });
});

describe('retention of failed attempts', () => {
  const now = localNoon(2026, 6, 30);
  const ago = (n, opts) => meta(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n, 12), opts);

  it('keeps the newest 5 younger than 30 days and prunes the rest', () => {
    const failed = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ago(n, { status: 'failed' }));
    const { keep, remove } = plan([ago(0), ...failed], {}, now);
    expect(keep.filter((m) => m.status === 'failed').map((m) => m.id)).toEqual(failed.slice(0, 5).map((m) => m.id));
    expect(remove.map((m) => m.id).sort()).toEqual(failed.slice(5).map((m) => m.id).sort());
  });

  it('prunes a failed attempt older than 30 days even when it is among the newest 5', () => {
    const failed = [ago(5, { status: 'failed' }), ago(45, { status: 'failed' })];
    const { keep, remove } = plan([ago(0), ...failed], {}, now);
    expect(keep.map((m) => m.id)).toContain(failed[0].id);
    expect(remove.map((m) => m.id)).toEqual([failed[1].id]);
  });

  it('failed metas never count as verified backups for the daily scheme', () => {
    const failedToday = ago(0, { status: 'failed' });
    const good = ago(3);
    const { keep } = plan([failedToday, good], { keepDaily: 1, keepWeekly: 0, keepMonthly: 0 }, now);
    expect(ids(keep)).toEqual(new Set([good.id, failedToday.id]));
  });
});

describe('the newest verified backup is never deleted', () => {
  const now = localNoon(2026, 6, 30);
  const ago = (n, opts) => meta(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n, 12), opts);

  it('with keepDaily=1, keepWeekly=0, keepMonthly=0 the newest survives and older ones go', () => {
    const metas = [0, 1, 2, 3, 40].map((n) => ago(n));
    const { keep, remove } = plan(metas, { keepDaily: 1, keepWeekly: 0, keepMonthly: 0 }, now);
    expect(keep.map((m) => m.id)).toEqual([metas[0].id]);
    expect(remove).toHaveLength(4);
  });

  it('when the newest verified backup is a safety copy it is kept, and the newest automatic one still counts as the day', () => {
    const auto = ago(5);
    const olderAuto = ago(9);
    const safety = ago(0, { kind: 'safety' });
    const { keep, remove } = plan([auto, olderAuto, safety], { keepDaily: 1, keepWeekly: 0, keepMonthly: 0 }, now);
    expect(ids(keep)).toEqual(new Set([safety.id, auto.id]));
    expect(remove.map((m) => m.id)).toEqual([olderAuto.id]);
  });

  it('a single old safety copy is the newest verified backup and stays', () => {
    const safety = ago(400, { kind: 'safety' });
    const { keep, remove } = plan([safety, ago(1, { status: 'failed' })], { keepDaily: 1, keepWeekly: 0, keepMonthly: 0 }, now);
    expect(keep.map((m) => m.id)).toContain(safety.id);
    expect(remove.map((m) => m.id)).not.toContain(safety.id);
  });

  it('with only failed attempts newer than it, the old verified backup is kept', () => {
    const good = ago(200);
    const failed = [1, 2, 3, 4, 5, 6].map((n) => ago(n, { status: 'failed' }));
    const { keep } = plan([good, ...failed], { keepDaily: 1, keepWeekly: 0, keepMonthly: 0 }, now);
    expect(keep.map((m) => m.id)).toContain(good.id);
  });

  it('holds for every legal setting combination at the bounds', () => {
    const metas = dailySeries(new Date(2026, 0, 1), 30);
    const newest = metas[metas.length - 1];
    for (const keepDaily of [1, 2, 60]) {
      for (const keepWeekly of [0, 1, 52]) {
        for (const keepMonthly of [0, 1, 60]) {
          expect(ids(plan(metas, { keepDaily, keepWeekly, keepMonthly }).keep).has(newest.id)).toBe(true);
        }
      }
    }
  });
});

describe('backup settings validation', () => {
  const ok = (o) => ({ keepDaily: 7, keepWeekly: 4, keepMonthly: 6, ...o });

  it.each([
    [{ keepDaily: 1, keepWeekly: 0, keepMonthly: 0 }],
    [{ keepDaily: 60, keepWeekly: 52, keepMonthly: 60 }],
    [{ keepDaily: 7, keepWeekly: 4, keepMonthly: 6 }],
  ])('accepts %o', (input) => {
    expect(validateBackupSettings(input)).toEqual(input);
  });

  it.each([
    ['keepDaily 0', ok({ keepDaily: 0 })],
    ['keepDaily 61', ok({ keepDaily: 61 })],
    ['keepDaily negative', ok({ keepDaily: -1 })],
    ['keepWeekly 53', ok({ keepWeekly: 53 })],
    ['keepWeekly negative', ok({ keepWeekly: -1 })],
    ['keepMonthly 61', ok({ keepMonthly: 61 })],
    ['keepMonthly negative', ok({ keepMonthly: -1 })],
    ['fraction', ok({ keepDaily: 1.5 })],
    ['numeric string', ok({ keepDaily: '7' })],
    ['NaN', ok({ keepWeekly: Number.NaN })],
    ['Infinity', ok({ keepMonthly: Number.POSITIVE_INFINITY })],
    ['null value', ok({ keepDaily: null })],
    ['boolean value', ok({ keepDaily: true })],
    ['missing key', { keepDaily: 7, keepWeekly: 4 }],
    ['extra key', { ...ok({}), keepYearly: 1 }],
    ['unknown key replacing one', { keepDaily: 7, keepWeekly: 4, keepYearly: 6 }],
    ['empty object', {}],
    ['null', null],
    ['undefined', undefined],
    ['array', [7, 4, 6]],
    ['string', 'keepDaily=7'],
    ['number', 7],
  ])('rejects %s with invalid_settings (400)', (_label, input) => {
    expect(() => validateBackupSettings(input)).toThrowError(expect.objectContaining({ code: 'invalid_settings', status: 400 }));
  });

  it('returns a clean copy that does not alias the input', () => {
    const input = ok({});
    const out = validateBackupSettings(input);
    expect(out).not.toBe(input);
  });

  it('defaults are 7 daily, 4 weekly, 6 monthly and are frozen', () => {
    expect(DEFAULT_BACKUP_SETTINGS).toEqual({ keepDaily: 7, keepWeekly: 4, keepMonthly: 6 });
    expect(Object.isFrozen(DEFAULT_BACKUP_SETTINGS)).toBe(true);
  });

  it('getBackupSettings returns the defaults when nothing is saved, and a copy each time', async () => {
    const a = await getBackupSettings();
    expect(a).toEqual(DEFAULT_BACKUP_SETTINGS);
    a.keepDaily = 99;
    expect(await getBackupSettings()).toEqual(DEFAULT_BACKUP_SETTINGS);
  });

  it('saveBackupSettings persists under app_state backup.settings and getBackupSettings reads it back', async () => {
    expect(BACKUP_SETTINGS_KEY).toBe('backup.settings');
    await saveBackupSettings({ keepDaily: 3, keepWeekly: 2, keepMonthly: 1 });
    expect(await getState(BACKUP_SETTINGS_KEY, null)).toEqual({ keepDaily: 3, keepWeekly: 2, keepMonthly: 1 });
    expect(await getBackupSettings()).toEqual({ keepDaily: 3, keepWeekly: 2, keepMonthly: 1 });
  });

  it('an invalid save leaves the stored settings alone', async () => {
    await saveBackupSettings({ keepDaily: 3, keepWeekly: 2, keepMonthly: 1 });
    await expect(saveBackupSettings({ keepDaily: 0, keepWeekly: 2, keepMonthly: 1 })).rejects.toMatchObject({ code: 'invalid_settings' });
    expect(await getBackupSettings()).toEqual({ keepDaily: 3, keepWeekly: 2, keepMonthly: 1 });
  });

  it('a corrupt stored value falls back to the defaults instead of failing', async () => {
    getDb();
    await setState(BACKUP_SETTINGS_KEY, { keepDaily: 999, keepWeekly: 'x', keepMonthly: -3 });
    expect(await getBackupSettings()).toEqual(DEFAULT_BACKUP_SETTINGS);
    await setState(BACKUP_SETTINGS_KEY, 'garbage');
    expect(await getBackupSettings()).toEqual(DEFAULT_BACKUP_SETTINGS);
  });
});

describe('applying retention to files', () => {
  async function putBackup(date, opts = {}) {
    const m = meta(date, opts);
    const dir = ensureBackupsDir();
    const base = path.join(dir, `burrow-${m.id}`);
    fs.writeFileSync(`${base}.db`, 'db');
    fs.writeFileSync(`${base}.export.zip`, 'zip');
    await writeMeta({ format: 'burrow-backup', formatVersion: 1, ...m }, dir);
    return m;
  }

  it('removes the meta first, then the .db, then the export ZIP, for every dropped backup', async () => {
    const keepMeta = await putBackup(localNoon(2026, 3, 2));
    const dropMeta = await putBackup(localNoon(2026, 3, 1));
    const calls = [];
    const real = createFsOps();
    const fsOps = createFsOps({
      rm: async (target, ...rest) => {
        calls.push(path.basename(target));
        return real.rm(target, ...rest);
      },
    });
    const { removed } = await applyRetention({
      settings: { keepDaily: 1, keepWeekly: 0, keepMonthly: 0 },
      now: localNoon(2026, 3, 3),
      fsOps,
    });
    expect(removed).toEqual([dropMeta.id]);
    expect(calls).toEqual([`burrow-${dropMeta.id}.meta.json`, `burrow-${dropMeta.id}.db`, `burrow-${dropMeta.id}.export.zip`]);
    expect(names().filter((n) => n.includes(dropMeta.id))).toEqual([]);
    expect(names().filter((n) => n.includes(keepMeta.id))).toHaveLength(3);
  });

  it('leaves unrelated files and the state file alone', async () => {
    await putBackup(localNoon(2026, 3, 2));
    await putBackup(localNoon(2026, 3, 1));
    const dir = backupsDir();
    fs.writeFileSync(path.join(dir, 'state.json'), '{}');
    fs.writeFileSync(path.join(dir, 'notes-from-me.txt'), 'hello');
    await applyRetention({ settings: { keepDaily: 1, keepWeekly: 0, keepMonthly: 0 }, now: localNoon(2026, 3, 3) });
    expect(names()).toEqual(expect.arrayContaining(['state.json', 'notes-from-me.txt']));
  });

  it('uses the saved settings when none are passed', async () => {
    for (let d = 1; d <= 5; d += 1) await putBackup(localNoon(2026, 3, d));
    await saveBackupSettings({ keepDaily: 2, keepWeekly: 0, keepMonthly: 0 });
    const { removed } = await applyRetention({ now: localNoon(2026, 3, 6) });
    expect(removed).toHaveLength(3);
    expect((await listMetas(backupsDir())).map((m) => dayKey(new Date(m.createdAt)))).toEqual(['2026-03-05', '2026-03-04']);
  });

  it('does nothing when the backups folder does not exist', async () => {
    expect(await applyRetention({ settings: DEFAULT_BACKUP_SETTINGS, dir: path.join(backupsDir(), 'missing') })).toEqual({ removed: [] });
  });

  it('keeps the newest verified backup even with 1/0/0 and a newer failed attempt', async () => {
    const good = await putBackup(localNoon(2026, 3, 1));
    await putBackup(localNoon(2026, 3, 9), { status: 'failed' });
    await applyRetention({ settings: { keepDaily: 1, keepWeekly: 0, keepMonthly: 0 }, now: localNoon(2026, 3, 10) });
    expect((await listMetas(backupsDir())).map((m) => m.id)).toContain(good.id);
    expect(fs.existsSync(path.join(backupsDir(), `burrow-${good.id}.db`))).toBe(true);
  });
});

describe('orphan cleanup', () => {
  const HOUR = 3_600_000;
  const touch = (name, ageMs, content = 'x') => {
    const dir = ensureBackupsDir();
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(file, t, t);
    return file;
  };

  it('removes old partial, tmp and incoming files and data files that have no meta', async () => {
    touch('burrow-20260101T000000Z-manual-aaaaaa.db.partial', 2 * HOUR);
    touch('burrow-20260101T000000Z-manual-aaaaaa.export.zip.partial', 2 * HOUR);
    touch('state.json.1234abcd.tmp', 2 * HOUR);
    touch('.incoming-0123456789abcdef0123456789abcdef.db', 2 * HOUR);
    touch('burrow-20260101T000000Z-manual-bbbbbb.db', 2 * HOUR);
    touch('burrow-20260101T000000Z-manual-bbbbbb.export.zip', 2 * HOUR);
    const { removed } = await cleanupOrphans();
    expect(removed).toHaveLength(6);
    expect(names()).toEqual([]);
  });

  it('keeps recent leftovers (they may belong to a running backup)', async () => {
    touch('burrow-20260101T000000Z-manual-aaaaaa.db.partial', 10 * 60_000);
    touch('burrow-20260101T000000Z-manual-bbbbbb.db', 59 * 60_000);
    const { removed } = await cleanupOrphans();
    expect(removed).toEqual([]);
    expect(names()).toHaveLength(2);
  });

  it('never touches files of a backup that has a meta, however old', async () => {
    const m = meta(localNoon(2026, 1, 1));
    const dir = ensureBackupsDir();
    await writeMeta({ format: 'burrow-backup', formatVersion: 1, ...m }, dir);
    touch(`burrow-${m.id}.db`, 100 * HOUR);
    touch(`burrow-${m.id}.export.zip`, 100 * HOUR);
    const { removed } = await cleanupOrphans();
    expect(removed).toEqual([]);
    expect(names()).toHaveLength(3);
  });

  it('never touches unrelated files, the state file or names with an invalid id', async () => {
    touch('state.json', 100 * HOUR);
    touch('readme.txt', 100 * HOUR);
    touch('burrow-not-an-id.db', 100 * HOUR);
    const { removed } = await cleanupOrphans();
    expect(removed).toEqual([]);
    expect(names()).toEqual(['burrow-not-an-id.db', 'readme.txt', 'state.json']);
  });

  it('honors the injected clock', async () => {
    touch('burrow-20260101T000000Z-manual-aaaaaa.db.partial', 0);
    expect((await cleanupOrphans()).removed).toEqual([]);
    expect((await cleanupOrphans({ now: new Date(Date.now() + 2 * HOUR) })).removed).toHaveLength(1);
  });

  it('a missing folder is fine', async () => {
    expect(await cleanupOrphans({ dir: path.join(backupsDir(), 'nope') })).toEqual({ removed: [] });
  });
});
