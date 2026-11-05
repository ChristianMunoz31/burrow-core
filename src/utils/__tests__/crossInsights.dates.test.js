// Date-boundary tests for the Cross-insights window (the private windowKeys helper, observed
// through buildDailySeries): 60 local calendar days ending yesterday, across month ends, leap day,
// year rollover, DST transitions and the gap between local and UTC midnight. The expected keys come
// from pure UTC calendar arithmetic, so the result must not depend on the machine time zone.
import { afterEach, describe, expect, it } from 'vitest';
import process from 'node:process';
import { WINDOW_DAYS, buildDailySeries } from '../crossInsights';

const pad = (n) => String(n).padStart(2, '0');
const utcKey = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

/** The 60 days ending the day before the LOCAL calendar day of `now`, oldest first. */
function expectedWindow(now) {
  const keys = [];
  for (let i = WINDOW_DAYS; i >= 1; i -= 1) keys.push(utcKey(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() - i)));
  return keys;
}

/** Window keys as the code under test produces them (transactions spanning the whole window zero-fill every key). */
function windowOf(now) {
  const tx = (date) => ({ date, amount: 1, category: 'Groceries', type: 'debit' });
  const { spend } = buildDailySeries({ transactions: [tx('2000-01-01'), tx('2099-12-31')] }, { now });
  return [...spend.keys()];
}

const CASES = [
  ['mid-month', new Date(2026, 5, 15, 12)],
  ['first of a 31-day month', new Date(2026, 0, 1, 12)],
  ['last day of January', new Date(2026, 0, 31, 12)],
  ['first of March after a 28-day February', new Date(2027, 2, 1, 12)],
  ['last day of a 30-day month', new Date(2026, 3, 30, 12)],
  ['leap day itself (2028-02-29)', new Date(2028, 1, 29, 12)],
  ['day after leap day (2028-03-01)', new Date(2028, 2, 1, 12)],
  ['two days after leap day (2028-03-02)', new Date(2028, 2, 2, 12)],
  ['year rollover: Dec 31', new Date(2026, 11, 31, 12)],
  ['year rollover: Jan 1', new Date(2027, 0, 1, 12)],
  ['year rollover: Jan 2', new Date(2027, 0, 2, 12)],
  ['US DST start day (2026-03-08)', new Date(2026, 2, 8, 12)],
  ['day after US DST start', new Date(2026, 2, 9, 12)],
  ['US DST end day (2026-11-01)', new Date(2026, 10, 1, 12)],
  ['day after US DST end', new Date(2026, 10, 2, 12)],
  ['EU DST start day (2026-03-29)', new Date(2026, 2, 29, 12)],
  ['EU DST end day (2026-10-25)', new Date(2026, 9, 25, 12)],
  ['just after local midnight', new Date(2026, 2, 1, 0, 0, 1)],
  ['just before local midnight', new Date(2026, 2, 1, 23, 59, 59)],
];

describe('cross-insights window dates', () => {
  it.each(CASES)('%s: 60 consecutive local days ending yesterday', (_label, now) => {
    const keys = windowOf(now);
    expect(keys).toHaveLength(WINDOW_DAYS);
    expect(keys).toEqual(expectedWindow(now));
    expect(new Set(keys).size).toBe(WINDOW_DAYS);
    expect([...keys].sort()).toEqual(keys);
  });

  it('never includes today and always ends on the day before it', () => {
    for (const [, now] of CASES) {
      const keys = windowOf(now);
      const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      expect(keys).not.toContain(today);
      expect(keys.at(-1)).toBe(utcKey(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() - 1)));
    }
  });

  it('month ends: Feb 28 to Mar 1 and Apr 30 to May 1 are adjacent', () => {
    const feb = windowOf(new Date(2027, 2, 20, 12));
    expect(feb[feb.indexOf('2027-02-28') + 1]).toBe('2027-03-01');
    const apr = windowOf(new Date(2027, 4, 20, 12));
    expect(apr[apr.indexOf('2027-04-30') + 1]).toBe('2027-05-01');
  });

  it('leap day 2028-02-29 exists in the window and sits between Feb 28 and Mar 1', () => {
    const keys = windowOf(new Date(2028, 2, 15, 12));
    const i = keys.indexOf('2028-02-29');
    expect(i).toBeGreaterThan(0);
    expect(keys[i - 1]).toBe('2028-02-28');
    expect(keys[i + 1]).toBe('2028-03-01');
  });

  it('the window ends on the leap day when now is 2028-03-01, and has no Feb 29 in 2027', () => {
    expect(windowOf(new Date(2028, 2, 1, 12)).at(-1)).toBe('2028-02-29');
    expect(windowOf(new Date(2027, 2, 15, 12))).not.toContain('2027-02-29');
  });

  it('year rollover: Dec 31 is followed by Jan 1 with no gap or repeat', () => {
    const keys = windowOf(new Date(2027, 1, 10, 12));
    expect(keys[keys.indexOf('2026-12-31') + 1]).toBe('2027-01-01');
    expect(windowOf(new Date(2027, 0, 1, 0, 5)).at(-1)).toBe('2026-12-31');
  });

  it('assigns transactions on the boundary days by their date: yesterday in, today out, day 61 out', () => {
    const now = new Date(2028, 2, 1, 9, 0, 0);
    const tx = (date, amount) => ({ date, amount, category: 'Groceries', type: 'debit' });
    const { spend } = buildDailySeries(
      { transactions: [tx('2027-12-31', 7), tx('2028-01-01', 11), tx('2028-02-29', 13), tx('2028-03-01', 17)] },
      { now },
    );
    const keys = [...spend.keys()];
    expect(keys[0]).toBe('2028-01-01'); // 60 days back from 2028-03-01
    expect(spend.get('2028-01-01')).toBe(11);
    expect(spend.get('2028-02-29')).toBe(13);
    expect(spend.has('2027-12-31')).toBe(false);
    expect(spend.has('2028-03-01')).toBe(false);
  });
});

describe('cross-insights window under explicit time zones', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  const ZONES = ['UTC', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Pacific/Auckland', 'Asia/Kolkata'];
  // Local wall times whose UTC date differs from the local date in at least one zone, plus both DST changes.
  const WALL_TIMES = [
    [2026, 2, 8, 0, 30],
    [2026, 2, 8, 23, 30],
    [2026, 10, 1, 0, 30],
    [2026, 10, 1, 23, 30],
    [2026, 2, 29, 0, 30],
    [2026, 9, 25, 23, 30],
    [2028, 2, 1, 0, 30],
    [2027, 0, 1, 23, 30],
  ];

  it.each(ZONES)('%s: window matches calendar arithmetic when the zone is honoured', (zone) => {
    process.env.TZ = zone;
    // If the runtime ignored the TZ change the check still holds (calendar arithmetic is zone-free),
    // so this never skips: it only gets stronger where the zone applies.
    for (const [y, m, d, hh, mm] of WALL_TIMES) {
      const now = new Date(y, m, d, hh, mm);
      expect(windowOf(now)).toEqual(expectedWindow(now));
    }
  });
});
