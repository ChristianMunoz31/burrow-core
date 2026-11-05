import { describe, it, expect } from 'vitest';
import {
  pearson,
  spearman,
  buildDailySeries,
  computeCrossInsights,
  toExplainSummary,
  MIN_N,
  MAX_SHOWN,
  CROSS_INSIGHT_PAIRS,
} from '../crossInsights';

const NOW = new Date(2026, 5, 15, 12, 0, 0); // window = 2026-04-16 .. 2026-06-14 (local)

const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** Local YYYY-MM-DD for the day `k` days before NOW (k=1 is yesterday). */
const dayKey = (k) => keyOf(new Date(2026, 5, 15 - k));
const noonIso = (k, hour = 10) => new Date(2026, 5, 15 - k, hour).toISOString();

const tx = (k, amount, category = 'Groceries', extra = {}) => ({
  date: dayKey(k),
  amount,
  category,
  type: 'debit',
  ...extra,
});

/** n consecutive days (k=1..n); even index = "low" day (6h sleep, extra spend). */
function binaryDataset(n, { lowSpend = 20, highSpend = 10, category = 'Dining' } = {}) {
  const transactions = [];
  const ouraDays = [];
  for (let k = 1; k <= n; k += 1) {
    const low = k % 2 === 0;
    transactions.push(tx(k, low ? lowSpend : highSpend, category));
    ouraDays.push({ day: dayKey(k), sleepHours: low ? 6 : 8, readiness: low ? 60 : 85 });
  }
  return { transactions, ouraDays, ouraSource: 'oura' };
}

const hasBadNumber = (value) => /NaN|Infinity/.test(JSON.stringify(value, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? 'NaN' : v)));

describe('pearson / spearman', () => {
  it('computes Spearman on a known dataset with ties', () => {
    // y ranks [1, 2, 3.5, 5, 3.5] vs x ranks 1..5 -> 8 / sqrt(95)
    expect(spearman([1, 2, 3, 4, 5], [5, 6, 7, 8, 7])).toBeCloseTo(0.8208, 3);
  });

  it('is 1 for any monotonic relationship and -1 for a reversed one', () => {
    expect(spearman([1, 2, 3, 4], [1, 4, 9, 16])).toBeCloseTo(1, 10);
    expect(spearman([1, 2, 3, 4], [16, 9, 4, 1])).toBeCloseTo(-1, 10);
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
  });

  it('returns null (never NaN) for n < 3, zero variance, mismatched or empty input', () => {
    expect(pearson([1, 2], [1, 2])).toBeNull();
    expect(spearman([1, 2], [2, 1])).toBeNull();
    expect(spearman([3, 3, 3, 3], [1, 2, 3, 4])).toBeNull();
    expect(pearson([1, 2, 3, 4], [5, 5, 5, 5])).toBeNull();
    expect(spearman([], [])).toBeNull();
    expect(pearson([1, 2, 3], [1, 2])).toBeNull();
    expect(spearman(undefined, undefined)).toBeNull();
  });
});

describe('buildDailySeries', () => {
  it('zero-fills spend only between the first and last transaction date', () => {
    const { spend, dining } = buildDailySeries({ transactions: [tx(14, 5), tx(10, 7, 'Dining')] }, { now: NOW });
    expect([...spend.keys()].sort()).toEqual([14, 13, 12, 11, 10].map(dayKey).sort());
    expect(spend.get(dayKey(12))).toBe(0);
    expect(spend.has(dayKey(9))).toBe(false);
    expect(dining.get(dayKey(10))).toBe(7);
    expect(dining.get(dayKey(14))).toBe(0);
  });

  it('excludes transfers and credits, and applies the dining regex', () => {
    const { spend, dining } = buildDailySeries(
      {
        transactions: [
          tx(3, 10, 'Restaurants'),
          tx(3, 5, 'Coffee Shops'),
          tx(3, 100, 'Transfer'),
          tx(3, 50, 'Credit Card Payment'),
          tx(3, 40, 'Paycheck', { type: 'credit' }),
          tx(3, 8, 'Barber'),
        ],
      },
      { now: NOW },
    );
    expect(spend.get(dayKey(3))).toBe(23);
    expect(dining.get(dayKey(3))).toBe(15);
  });

  it('ignores sample Oura data entirely', () => {
    const days = [{ day: dayKey(2), sleepHours: 6, readiness: 60 }];
    expect(buildDailySeries({ ouraDays: days, ouraSource: 'other' }, { now: NOW }).sleepHours.size).toBe(0);
    expect(buildDailySeries({ ouraDays: days, ouraSource: null }, { now: NOW }).readiness.size).toBe(0);
    expect(buildDailySeries({ ouraDays: days, ouraSource: 'oura' }, { now: NOW }).sleepHours.get(dayKey(2))).toBe(6);
  });

  it('computes habit rate with a creation-date denominator, daily habits only', () => {
    const habits = [
      { frequency: 'daily', createdTime: noonIso(10), completions: [dayKey(5), dayKey(10)] },
      { frequency: 'daily', createdTime: noonIso(4), completions: [dayKey(3)] },
      { frequency: 'weekly', createdTime: noonIso(30), completions: [dayKey(5)] },
    ];
    const { habitRate } = buildDailySeries({ habits }, { now: NOW });
    expect(habitRate.get(dayKey(5))).toBe(1); // only the first habit exists, and it is done
    expect(habitRate.get(dayKey(3))).toBe(0.5); // both exist, one done
    expect(habitRate.has(dayKey(11))).toBe(false); // nothing created yet
  });

  it('averages mood per local day, converts timestamps to local days and skips all-day events', () => {
    const journal = [
      { date: noonIso(2, 23), mood: 'great' },
      { date: noonIso(2, 0), mood: 'down' },
      { date: dayKey(4), mood: 'okay' },
      { date: noonIso(5), mood: 'weird' },
    ];
    const events = [
      { start: noonIso(3, 9), allDay: false },
      { start: noonIso(3, 18), allDay: false },
      { start: dayKey(3), allDay: true },
      { start: noonIso(9), allDay: false }, // calendar data starts before day 7, so day 7 is a real quiet day
    ];
    const s = buildDailySeries({ journal, events }, { now: NOW });
    expect(s.mood.get(dayKey(2))).toBe(3.5);
    expect(s.mood.get(dayKey(4))).toBe(3);
    expect(s.mood.has(dayKey(5))).toBe(false);
    expect(s.events.get(dayKey(3))).toBe(2);
    expect(s.events.get(dayKey(7))).toBe(0);
    expect(s.events.get(dayKey(9))).toBe(1);
  });

  it('zero-fills events only between the first and last event day (H1)', () => {
    // Events only in the last ~20 days of the window: k=20 (first) .. k=5 (last).
    const events = [
      { start: noonIso(20, 9), allDay: false },
      { start: noonIso(12, 9), allDay: false },
      { start: noonIso(12, 14), allDay: false },
      { start: noonIso(5, 9), allDay: false },
    ];
    const { events: ev } = buildDailySeries({ events }, { now: NOW });
    for (let k = 60; k > 20; k -= 1) expect(ev.has(dayKey(k))).toBe(false); // before calendar data
    for (let k = 4; k >= 1; k -= 1) expect(ev.has(dayKey(k))).toBe(false); // after the last event
    expect(ev.get(dayKey(20))).toBe(1);
    expect(ev.get(dayKey(15))).toBe(0); // inside the span: a real quiet day
    expect(ev.get(dayKey(12))).toBe(2);
    expect(ev.get(dayKey(5))).toBe(1);
    expect(ev.size).toBe(16);
  });

  it('counts events outside the window toward the span but not the counts (H1)', () => {
    const events = [
      { start: noonIso(90, 9), allDay: false }, // long before the window
      { start: noonIso(0, 9), allDay: false }, // today, after the window
    ];
    const { events: ev } = buildDailySeries({ events }, { now: NOW });
    expect(ev.size).toBe(60);
    expect([...ev.values()].every((v) => v === 0)).toBe(true);
  });

  it('does not report a spurious busyness_spend when spend trends and the calendar starts mid-window (H1)', () => {
    const transactions = [];
    const events = [];
    for (let k = 60; k >= 1; k -= 1) {
      transactions.push(tx(k, 10 + (60 - k) * 2)); // spend rises steadily over the window
      if (k <= 20) for (let e = 0; e < 3; e += 1) events.push({ start: noonIso(k, 8 + e), allDay: false });
    }
    const series = buildDailySeries({ transactions, events }, { now: NOW });
    expect(series.events.size).toBe(20); // only the days the calendar actually covers
    expect(series.spend.size).toBe(60);
    const result = computeCrossInsights({ transactions, events, now: NOW });
    expect(result.insights.find((i) => i.id === 'busyness_spend')).toBeUndefined();
    expect(result.coverage.calendar).toBe(20);
  });

  it('leaves the calendar series undefined when there are no events', () => {
    expect(buildDailySeries({ events: [{ start: dayKey(2), allDay: true }] }, { now: NOW }).events.size).toBe(0);
  });
});

describe('computeCrossInsights gates', () => {
  it('reports the dining insight with exact phrasing when everything clears', () => {
    const result = computeCrossInsights({ ...binaryDataset(30), now: NOW });
    expect(result.status).toBe('ok');
    const dining = result.insights.find((i) => i.id === 'sleep_dining');
    expect(dining.text).toBe('On days you slept under 7h you spent 100% more on dining (n=30).');
    expect(dining).toMatchObject({ n: 30, rho: -1, effectPct: 100, unit: 'usd' });
    expect(dining.groupA).toEqual({ label: 'under 7h', days: 15, mean: 20 });
    expect(dining.groupB.days).toBe(15);
    expect(result.insights.find((i) => i.id === 'sleep_spend').text).toBe(
      'On days you slept under 7h you spent 100% more overall (n=30).',
    );
    expect(result.insights.length).toBeLessThanOrEqual(4);
    expect(hasBadNumber(result)).toBe(false);
  });

  it('skips below the minimum paired days (13 skipped, 14 kept)', () => {
    expect(MIN_N).toBe(14);
    expect(computeCrossInsights({ ...binaryDataset(13), now: NOW }).status).toBe('insufficient');
    expect(computeCrossInsights({ ...binaryDataset(14), now: NOW }).status).toBe('ok');
  });

  it('skips when a split group has fewer than 5 days', () => {
    const transactions = [];
    const ouraDays = [];
    for (let k = 1; k <= 20; k += 1) {
      const low = k <= 4;
      transactions.push(tx(k, low ? 30 : 10, 'Dining'));
      ouraDays.push({ day: dayKey(k), sleepHours: low ? 5 : 8 });
    }
    const result = computeCrossInsights({ transactions, ouraDays, ouraSource: 'oura', now: NOW });
    expect(result.insights.find((i) => i.id === 'sleep_dining')).toBeUndefined();
  });

  it('skips a weak correlation (rho 0)', () => {
    const transactions = [];
    const ouraDays = [];
    for (let k = 1; k <= 28; k += 1) {
      // x alternates with k%2, y alternates with floor(k/2)%2: independent.
      transactions.push(tx(k, Math.floor(k / 2) % 2 ? 20 : 10, 'Dining'));
      ouraDays.push({ day: dayKey(k), sleepHours: k % 2 ? 8 : 6 });
    }
    const result = computeCrossInsights({ transactions, ouraDays, ouraSource: 'oura', now: NOW });
    expect(result.status).toBe('insufficient');
  });

  it('skips an effect under 10%', () => {
    const data = binaryDataset(30, { lowSpend: 10.9, highSpend: 10, category: 'Groceries' });
    expect(computeCrossInsights({ ...data, now: NOW }).status).toBe('insufficient');
  });

  it('phrases a zero baseline in dollars instead of a percentage', () => {
    const data = binaryDataset(30, { lowSpend: 20, highSpend: 0, category: 'Dining' });
    const dining = computeCrossInsights({ ...data, now: NOW }).insights.find((i) => i.id === 'sleep_dining');
    expect(dining.effectPct).toBeNull();
    expect(dining.text).toBe('On days you slept under 7h you spent $20.00 more on dining (typically $20.00 vs $0.00) (n=30).');
  });

  it('falls back through the busyness thresholds 3 -> 2', () => {
    const transactions = [];
    const events = [];
    for (let k = 1; k <= 30; k += 1) {
      const busy = k % 2 === 0;
      transactions.push(tx(k, busy ? 30 : 10));
      if (busy) events.push({ start: noonIso(k, 9), allDay: false }, { start: noonIso(k, 15), allDay: false });
    }
    // Calendar coverage must reach yesterday (k=1) so all 30 spend days stay paired.
    events.push({ start: noonIso(1, 9), allDay: false });
    const result = computeCrossInsights({ transactions, events, now: NOW });
    const busy = result.insights.find((i) => i.id === 'busyness_spend');
    expect(busy.text).toBe('On days with 2+ calendar events you spent 200% more (n=30).');
    expect(busy.groupA.label).toBe('2+ events');
  });

  it('never uses data that is not from Oura and reports health as missing', () => {
    const data = binaryDataset(30);
    const result = computeCrossInsights({ ...data, ouraSource: 'other', now: NOW });
    expect(result.status).toBe('insufficient');
    expect(result.missing).toContain('health_not_connected');
    expect(result.coverage.health).toBe(0);
  });
});

describe('empty and degenerate input', () => {
  it('returns insufficient with no NaN for undefined, empty and zero-variance inputs', () => {
    const empty = computeCrossInsights({ now: NOW });
    expect(empty.status).toBe('insufficient');
    expect(empty.insights).toEqual([]);
    expect(empty.missing).toEqual([
      'health_not_connected',
      'no_transactions',
      'no_habits',
      'no_journal_mood',
      'no_calendar',
    ]);
    expect(hasBadNumber(empty)).toBe(false);
    expect(computeCrossInsights().status).toBe('insufficient');
    expect(computeCrossInsights({ transactions: [], ouraDays: [], habits: [], journal: [], events: [], now: NOW }).status).toBe(
      'insufficient',
    );

    const flat = { transactions: [], ouraDays: [], ouraSource: 'oura' };
    for (let k = 1; k <= 30; k += 1) {
      flat.transactions.push(tx(k, 10, 'Dining'));
      flat.ouraDays.push({ day: dayKey(k), sleepHours: 7, readiness: 80 });
    }
    const result = computeCrossInsights({ ...flat, now: NOW });
    expect(result.status).toBe('insufficient');
    expect(hasBadNumber(result)).toBe(false);
  });

  it('tolerates malformed rows', () => {
    const result = computeCrossInsights({
      transactions: [null, { date: 'nope' }, { date: dayKey(2), amount: 'x', type: 'debit' }],
      ouraDays: [null, { day: 5 }],
      ouraSource: 'oura',
      habits: [null, { frequency: 'daily' }],
      journal: [null, { date: 'bad', mood: 'good' }],
      events: [null, { start: 'bad' }],
      now: NOW,
    });
    expect(result.status).toBe('insufficient');
    expect(hasBadNumber(result)).toBe(false);
  });
});

describe('toExplainSummary', () => {
  it('keeps only numeric stats, ids and units', () => {
    const result = computeCrossInsights({ ...binaryDataset(30), now: NOW });
    const summary = toExplainSummary(result);
    expect(summary.windowDays).toBe(60);
    for (const i of summary.insights) {
      expect(Object.keys(i).sort()).toEqual(['effectPct', 'id', 'meanA', 'meanB', 'n', 'nA', 'nB', 'rho', 'unit']);
      expect(CROSS_INSIGHT_PAIRS.map((p) => p.id)).toContain(i.id);
    }
    expect(JSON.stringify(summary)).not.toMatch(/On days|Dining|text/);
  });
});

describe('computeCrossInsights cap', () => {
  /** 30 days where every one of the 6 pairs qualifies: low days sleep 6h, ready 60, spend more, busier, worse mood, fewer habits. */
  function everyPairDataset() {
    const base = binaryDataset(30);
    const events = [];
    const journal = [];
    const completions = [];
    for (let k = 1; k <= 30; k += 1) {
      const low = k % 2 === 0;
      if (low) for (let e = 0; e < 3; e += 1) events.push({ start: noonIso(k, 9 + e), allDay: false });
      journal.push({ date: dayKey(k), mood: low ? 'down' : 'great' });
      if (!low) completions.push(dayKey(k));
    }
    return { ...base, events, journal, habits: [{ frequency: 'daily', completions }], now: NOW };
  }

  const ids = (result) => result.insights.map((i) => i.id);
  const SPEND_PAIRS = ['sleep_dining', 'sleep_spend', 'readiness_spend', 'busyness_spend'];
  const JOURNAL_PAIRS = ['readiness_habits', 'sleep_mood'];

  it('pairs carry no workspace', () => {
    for (const p of CROSS_INSIGHT_PAIRS) expect(p).not.toHaveProperty('workspace');
  });

  it('all pairs compete for the 4 slots by abs(rho), whatever their outcome', () => {
    const data = everyPairDataset();
    // Precondition: all 6 pairs qualify (spend pairs without the journal data, journal pairs without transactions).
    expect(ids(computeCrossInsights({ ...data, journal: [], habits: [] })).sort()).toEqual([...SPEND_PAIRS].sort());
    expect(ids(computeCrossInsights({ ...data, transactions: [] })).sort()).toEqual([...JOURNAL_PAIRS].sort());
    const all = computeCrossInsights(data);
    expect(all.insights).toHaveLength(MAX_SHOWN);
    expect(ids(all).some((id) => JOURNAL_PAIRS.includes(id))).toBe(true);
    expect(ids(all).some((id) => SPEND_PAIRS.includes(id))).toBe(true);
    const strengths = all.insights.map((i) => Math.abs(i.rho));
    expect(strengths).toEqual([...strengths].sort((a, b) => b - a));
  });

  it('ignores a legacy workspace argument', () => {
    const data = everyPairDataset();
    expect(computeCrossInsights({ ...data, workspace: 'budget' })).toEqual(computeCrossInsights(data));
  });
});
