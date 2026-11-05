// Gap coverage for cross-domain insights: known stat values, every gate boundary, every
// template phrasing, finite-only output, and local-day alignment (incl. DST).
// The zone is pinned BEFORE any Date is built so the DST cases are deterministic.
globalThis.process.env.TZ = 'America/New_York';

import { describe, it, expect } from 'vitest';
import {
  pearson,
  spearman,
  buildDailySeries,
  computeCrossInsights,
  toExplainSummary,
  CROSS_INSIGHT_PAIRS,
  MAX_SHOWN,
  MIN_GROUP,
  MIN_N,
  MIN_ABS_RHO,
  WINDOW_DAYS,
} from '../crossInsights';

const tzWorks = new Date(2026, 2, 8, 2, 30).getHours() === 3; // 02:30 does not exist on 2026-03-08 in New York

const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const NOW = new Date(2026, 5, 15, 12, 0, 0); // window 2026-04-16 .. 2026-06-14
const dayKey = (k, now = NOW) => keyOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - k));
const at = (k, hour = 10, min = 0, now = NOW) =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate() - k, hour, min).toISOString();

/** Throws on the first NaN/Infinity anywhere (objects, arrays, Maps). */
function assertAllFinite(value, path = 'root') {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`non-finite number at ${path}: ${value}`);
    return;
  }
  if (value instanceof Map) {
    for (const [k, v] of value) assertAllFinite(v, `${path}.${k}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertAllFinite(v, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertAllFinite(v, `${path}.${k}`);
  }
}

const debit = (k, amount, category = 'Groceries', now = NOW) => ({
  date: dayKey(k, now),
  amount,
  category,
  type: 'debit',
});

/**
 * n consecutive days (k = 1..n). `low(k)` picks the "A" group. Each opts function maps (k, low)
 * to a value; leave one out to omit that series.
 */
function build(n, low, { spend, sleep, readiness, habits, mood, events } = {}) {
  const input = { now: NOW, ouraSource: 'oura', transactions: [], ouraDays: [], journal: [], events: [] };
  const habitDefs = [];
  for (let k = 1; k <= n; k += 1) {
    const l = low(k);
    if (spend) input.transactions.push(debit(k, spend(k, l), 'Dining'));
    if (sleep || readiness) {
      input.ouraDays.push({
        day: dayKey(k),
        ...(sleep ? { sleepHours: sleep(k, l) } : {}),
        ...(readiness ? { readiness: readiness(k, l) } : {}),
      });
    }
    if (mood) input.journal.push({ date: at(k), mood: mood(k, l) });
    if (events) for (let e = 0; e < events(k, l); e += 1) input.events.push({ start: at(k, 8 + e), allDay: false });
  }
  if (habits) {
    // habit 1 always done; habit 2 done only when habits(k, low) is true.
    const done1 = [];
    const done2 = [];
    for (let k = 1; k <= n; k += 1) {
      done1.push(dayKey(k));
      if (habits(k, low(k))) done2.push(dayKey(k));
    }
    habitDefs.push(
      { frequency: 'daily', createdTime: at(59), completions: done1 },
      { frequency: 'daily', createdTime: at(59), completions: done2 },
    );
    input.habits = habitDefs;
  }
  return input;
}

const even = (k) => k % 2 === 0;
/**
 * The events series is zero-filled only between the first and last event day, so add one marker
 * event today (outside the window) and one the day after the last built day (no spend that day,
 * so it never pairs). Together they make the calendar span every built day without changing counts.
 */
const spanCalendar = (input, n) => ({
  ...input,
  events: [...input.events, { start: at(0), allDay: false }, { start: at(n + 1), allDay: false }],
});
const find = (result, id) => result.insights.find((i) => i.id === id);

describe('pearson / spearman known values', () => {
  it('Pearson matches hand-computed values', () => {
    // dx = -2..2, dy = -2,0,1,0,1 -> 6 / sqrt(10 * 6)
    expect(pearson([1, 2, 3, 4, 5], [2, 4, 5, 4, 5])).toBeCloseTo(6 / Math.sqrt(60), 10);
    expect(pearson([1, 2, 3], [1, 3, 2])).toBeCloseTo(0.5, 10);
    expect(pearson([10, 20, 30], [3, 2, 1])).toBeCloseTo(-1, 10);
  });

  it('Spearman averages tied ranks on both axes', () => {
    // ranks x: 1, 2.5, 2.5, 4   y: 1, 3.5, 3.5, 2 -> 1.5 / 4.5
    expect(spearman([1, 2, 2, 3], [1, 3, 3, 2])).toBeCloseTo(1 / 3, 10);
  });

  it('Spearman ignores magnitude, Pearson does not', () => {
    const xs = [1, 2, 3, 4, 5];
    const ys = [1, 2, 3, 4, 1000];
    expect(spearman(xs, ys)).toBeCloseTo(1, 10);
    expect(pearson(xs, ys)).toBeLessThan(0.9);
  });

  it('is symmetric and stays within [-1, 1]', () => {
    const xs = [3, 1, 4, 1, 5, 9, 2, 6];
    const ys = [2, 7, 1, 8, 2, 8, 1, 8];
    expect(spearman(xs, ys)).toBeCloseTo(spearman(ys, xs), 12);
    for (const v of [spearman(xs, ys), pearson(xs, ys), pearson([0.1, 0.2, 0.3], [0.1, 0.2, 0.3])]) {
      expect(v).toBeLessThanOrEqual(1);
      expect(v).toBeGreaterThanOrEqual(-1);
    }
  });

  it('accepts exactly 3 points and rejects 0, 1 and 2', () => {
    expect(pearson([1, 2, 3], [1, 2, 4])).not.toBeNull();
    expect(spearman([1, 2, 3], [1, 2, 4])).not.toBeNull();
    for (const n of [0, 1, 2]) {
      const a = Array.from({ length: n }, (_, i) => i);
      expect(pearson(a, a)).toBeNull();
      expect(spearman(a, a)).toBeNull();
    }
  });

  it('returns null for all-equal and one-sided zero variance, in both functions', () => {
    expect(pearson([5, 5, 5], [5, 5, 5])).toBeNull();
    expect(spearman([5, 5, 5], [5, 5, 5])).toBeNull();
    expect(spearman([1, 2, 3, 4], [9, 9, 9, 9])).toBeNull();
    expect(spearman([9, 9, 9, 9], [1, 2, 3, 4])).toBeNull();
    expect(pearson([0, 0, 0], [1, 2, 3])).toBeNull();
  });

  it('never returns NaN or Infinity for NaN, Infinity, null, undefined or huge inputs', () => {
    const bad = [
      [[1, Number.NaN, 3, 4], [1, 2, 3, 4]],
      [[1, 2, 3, 4], [1, Number.POSITIVE_INFINITY, 3, 4]],
      [[1, Number.NEGATIVE_INFINITY, 3], [1, 2, 3]],
      [[1, null, 3], [1, 2, 3]],
      [[1, undefined, 3], [1, 2, 3]],
      [[1e308, -1e308, 1e308], [1, 2, 3]],
      [[Number.NaN, Number.NaN, Number.NaN], [1, 2, 3]],
    ];
    for (const [xs, ys] of bad) {
      for (const fn of [pearson, spearman]) {
        const v = fn(xs, ys);
        expect(v === null || Number.isFinite(v)).toBe(true);
      }
    }
  });
});

describe('gate boundaries', () => {
  it('13 paired days skipped, 14 kept, when only the overlap counts', () => {
    // 20 spend days but only 13 days of sleep: n is the paired count.
    const data = build(20, even, { spend: (k, l) => (l ? 20 : 10), sleep: (k, l) => (l ? 6 : 8) });
    data.ouraDays = data.ouraDays.slice(0, 13);
    expect(computeCrossInsights(data).status).toBe('insufficient');
    const data14 = build(20, even, { spend: (k, l) => (l ? 20 : 10), sleep: (k, l) => (l ? 6 : 8) });
    data14.ouraDays = data14.ouraDays.slice(0, MIN_N);
    const ok = computeCrossInsights(data14);
    expect(ok.status).toBe('ok');
    expect(find(ok, 'sleep_dining').n).toBe(14);
  });

  it('a split group of 4 is skipped and a group of 5 is kept (MIN_GROUP)', () => {
    expect(MIN_GROUP).toBe(5);
    const mk = (lowDays) =>
      computeCrossInsights(
        build(20, (k) => k <= lowDays, { spend: (k, l) => (l ? 30 : 10), sleep: (k, l) => (l ? 5 : 8) }),
      );
    expect(find(mk(4), 'sleep_dining')).toBeUndefined();
    expect(find(mk(16), 'sleep_dining')).toBeUndefined(); // 4 days in the B group
    expect(find(mk(15), 'sleep_dining').groupB.days).toBe(5);
    const ok = find(mk(5), 'sleep_dining');
    expect(ok.groupA.days).toBe(5);
    expect(ok.text).toBe('On days you slept under 7h you spent 200% more on dining (n=20).');
  });

  it('the 7h split is strict: exactly 7h belongs to the 7h-or-more group', () => {
    const r = computeCrossInsights(
      build(20, even, { spend: (k, l) => (l ? 30 : 10), sleep: (k, l) => (l ? 6.9 : 7) }),
    );
    const i = find(r, 'sleep_dining');
    expect(i.groupA.days).toBe(10);
    expect(i.groupB.days).toBe(10);
    // everyone at 7h exactly: no A group at all
    expect(
      computeCrossInsights(build(20, even, { spend: (k, l) => (l ? 30 : 10), sleep: () => 7 })).status,
    ).toBe('insufficient');
  });

  it('the readiness split is strict at 70', () => {
    const r = computeCrossInsights(
      build(20, even, { spend: (k, l) => (l ? 30 : 10), readiness: (k, l) => (l ? 69 : 70) }),
    );
    expect(find(r, 'readiness_spend').groupA.days).toBe(10);
  });

  it('effect threshold: 10% passes, 9% skipped (percent units)', () => {
    const mk = (low) =>
      computeCrossInsights(build(30, even, { spend: (k, l) => (l ? low : 10), sleep: (k, l) => (l ? 6 : 8) }));
    expect(find(mk(11), 'sleep_dining').effectPct).toBe(10);
    expect(find(mk(10.9), 'sleep_dining')).toBeUndefined();
    expect(find(mk(11), 'sleep_dining').text).toBe('On days you slept under 7h you spent 10% more on dining (n=30).');
  });

  it('absolute dollar threshold applies when the baseline is ~0: $5.00 passes, $4.99 skipped', () => {
    const mk = (low) =>
      computeCrossInsights(build(30, even, { spend: (k, l) => (l ? low : 0), sleep: (k, l) => (l ? 6 : 8) }));
    expect(find(mk(5), 'sleep_dining').text).toBe('On days you slept under 7h you spent $5.00 more on dining (typically $5.00 vs $0.00) (n=30).');
    expect(find(mk(4.99), 'sleep_dining')).toBeUndefined();
  });

  it('mood effect threshold: 0.33 points passes, 0.27 skipped', () => {
    // Low-sleep days journal 3 "good" plus extra "okay" entries; other days a single "okay".
    const mk = (extraOkay) => {
      const input = build(30, even, { sleep: (k, l) => (l ? 6 : 8), mood: () => 'okay' });
      for (let k = 2; k <= 30; k += 2) {
        for (let e = 0; e < 3; e += 1) input.journal.push({ date: at(k), mood: 'good' });
        for (let e = 0; e < extraOkay; e += 1) input.journal.push({ date: at(k), mood: 'okay' });
      }
      return computeCrossInsights(input);
    };
    const pass = find(mk(5), 'sleep_mood'); // 3 good + 6 okay -> 3.33
    expect(pass.effectAbs).toBeCloseTo(0.33, 2);
    expect(pass.text).toBe('After nights under 7h of sleep your journal mood averaged 0.3 points higher (n=30).');
    expect(find(mk(7), 'sleep_mood')).toBeUndefined(); // 3 good + 8 okay -> 3.27
  });

  it('|rho| below 0.3 is skipped even when the group means differ widely', () => {
    expect(MIN_ABS_RHO).toBe(0.3);
    // One huge spend on one low-sleep day, otherwise unrelated: big mean gap, tiny rank correlation.
    const sleeps = [5, 8, 6, 8, 5, 8, 6, 8, 5, 8, 6, 8, 5, 8, 6, 8, 5, 8, 6, 8];
    const spends = [10, 10, 12, 12, 14, 14, 11, 11, 13, 13, 10, 10, 12, 12, 14, 14, 11, 11, 500, 13];
    const input = { now: NOW, ouraSource: 'oura', ouraDays: [], transactions: [] };
    sleeps.forEach((s, i) => {
      input.ouraDays.push({ day: dayKey(i + 1), sleepHours: s });
      input.transactions.push(debit(i + 1, spends[i], 'Dining'));
    });
    const rho = spearman(sleeps, spends);
    expect(Math.abs(rho)).toBeLessThan(MIN_ABS_RHO);
    expect(find(computeCrossInsights(input), 'sleep_dining')).toBeUndefined();
  });

  it('skips when direction is inconsistent with rho, and keeps the consistent twin as "less"', () => {
    const xs = [5, 5.5, 6, 6.2, 6.5, 6.8, 7, 7.2, 7.4, 7.6, 7.8, 8, 8.2, 8.4, 8.6, 8.8];
    const mk = (outlier) => {
      const input = { now: NOW, ouraSource: 'oura', ouraDays: [], transactions: [] };
      const ys = [1, 2, 3, 4, 5, outlier, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29];
      xs.forEach((x, i) => {
        input.ouraDays.push({ day: dayKey(i + 1), sleepHours: x });
        input.transactions.push(debit(i + 1, ys[i], 'Dining'));
      });
      return { input, xs, ys };
    };
    const bad = mk(1000);
    expect(spearman(bad.xs, bad.ys)).toBeGreaterThan(0.5); // more sleep, more spend...
    expect(find(computeCrossInsights(bad.input), 'sleep_dining')).toBeUndefined(); // ...but A mean is higher

    const good = find(computeCrossInsights(mk(6).input), 'sleep_dining');
    expect(good.effectAbs).toBe(-20.9); // the top value (29) is winsorized to 28
    expect(good.text).toBe('On days you slept under 7h you spent 86% less on dining (n=16).');
  });
});

describe('every template phrasing', () => {
  it('sleep_dining / sleep_spend (more)', () => {
    const r = computeCrossInsights(
      build(24, even, { spend: (k, l) => (l ? 30 : 20), sleep: (k, l) => (l ? 6 : 8) }),
    );
    expect(find(r, 'sleep_dining').text).toBe('On days you slept under 7h you spent 50% more on dining (n=24).');
    expect(find(r, 'sleep_spend').text).toBe('On days you slept under 7h you spent 50% more overall (n=24).');
  });

  it('sleep_spend less', () => {
    const r = computeCrossInsights(
      build(24, even, { spend: (k, l) => (l ? 10 : 20), sleep: (k, l) => (l ? 6 : 8) }),
    );
    expect(find(r, 'sleep_spend').text).toBe('On days you slept under 7h you spent 50% less overall (n=24).');
  });

  it('readiness_spend more and less', () => {
    const more = computeCrossInsights(
      build(24, even, { spend: (k, l) => (l ? 30 : 20), readiness: (k, l) => (l ? 60 : 85) }),
    );
    expect(find(more, 'readiness_spend').text).toBe('On days your readiness was under 70 you spent 50% more (n=24).');
    const less = computeCrossInsights(
      build(24, even, { spend: (k, l) => (l ? 10 : 20), readiness: (k, l) => (l ? 60 : 85) }),
    );
    expect(find(less, 'readiness_spend').text).toBe('On days your readiness was under 70 you spent 50% less (n=24).');
  });

  it('readiness_habits fewer', () => {
    // low-readiness days: 1 of 2 habits (50%); other days 2 of 2 (100%).
    const r = computeCrossInsights(
      build(24, even, { readiness: (k, l) => (l ? 60 : 85), habits: (k, l) => !l }),
    );
    const i = find(r, 'readiness_habits');
    expect(i.unit).toBe('rate');
    expect(i.groupA.mean).toBe(0.5);
    expect(i.groupB.mean).toBe(1);
    expect(i.text).toBe('On days your readiness was under 70 you completed 50% vs 100% of your habits (n=24).');
  });

  it('readiness_habits more', () => {
    // low-readiness days: 2 of 2 (100%); other days 1 of 2 (50%).
    const r = computeCrossInsights(
      build(24, even, { readiness: (k, l) => (l ? 60 : 85), habits: (k, l) => l }),
    );
    expect(find(r, 'readiness_habits').text).toBe(
      'On days your readiness was under 70 you completed 100% vs 50% of your habits (n=24).',
    );
  });

  it('busyness_spend uses the first threshold that leaves 5+ days on both sides', () => {
    const mk = (perBusyDay) =>
      computeCrossInsights(
        spanCalendar(build(24, even, { spend: (k, l) => (l ? 30 : 20), events: (k, l) => (l ? perBusyDay : 0) }), 24),
      );
    expect(find(mk(3), 'busyness_spend').text).toBe('On days with 3+ calendar events you spent 50% more (n=24).');
    expect(find(mk(2), 'busyness_spend').text).toBe('On days with 2+ calendar events you spent 50% more (n=24).');
    expect(find(mk(1), 'busyness_spend').text).toBe('On days with 1+ calendar events you spent 50% more (n=24).');
    expect(find(mk(1), 'busyness_spend').groupB.label).toBe('fewer than 1 events');
  });

  it('busyness_spend is skipped when no threshold leaves 5 days on both sides, and "less" is worded', () => {
    // only 4 busy days
    const few = computeCrossInsights(
      spanCalendar(build(24, (k) => k <= 4, { spend: (k, l) => (l ? 30 : 20), events: (k, l) => (l ? 3 : 0) }), 24),
    );
    expect(find(few, 'busyness_spend')).toBeUndefined();
    const less = computeCrossInsights(
      spanCalendar(build(24, even, { spend: (k, l) => (l ? 10 : 20), events: (k, l) => (l ? 3 : 0) }), 24),
    );
    expect(find(less, 'busyness_spend').text).toBe('On days with 3+ calendar events you spent 50% less (n=24).');
  });

  it('sleep_mood higher and lower', () => {
    const higher = computeCrossInsights(
      build(24, even, { sleep: (k, l) => (l ? 6 : 8), mood: (k, l) => (l ? 'great' : 'okay') }),
    );
    expect(find(higher, 'sleep_mood').text).toBe('After nights under 7h of sleep your journal mood averaged 2.0 points higher (n=24).');
    const lower = computeCrossInsights(
      build(24, even, { sleep: (k, l) => (l ? 6 : 8), mood: (k, l) => (l ? 'down' : 'good') }),
    );
    expect(find(lower, 'sleep_mood').text).toBe('After nights under 7h of sleep your journal mood averaged 2.0 points lower (n=24).');
    expect(find(lower, 'sleep_mood').unit).toBe('mood');
  });

  it('formats dollars as $1,234.56 and keeps the grouping comma', () => {
    const r = computeCrossInsights(
      build(30, even, { spend: (k, l) => (l ? 1234.56 : 0), sleep: (k, l) => (l ? 6 : 8) }),
    );
    expect(find(r, 'sleep_dining').text).toBe(
      'On days you slept under 7h you spent $1,234.56 more on dining (typically $1,234.56 vs $0.00) (n=30).',
    );
    expect(find(r, 'sleep_spend').text).toBe(
      'On days you slept under 7h you spent $1,234.56 more overall (typically $1,234.56 vs $0.00) (n=30).',
    );
    expect(find(r, 'sleep_dining').groupA.mean).toBe(1234.56);
  });

  it('every template is correlation-only wording with no em or en dashes', () => {
    const datasets = [
      build(24, even, { spend: (k, l) => (l ? 30 : 20), sleep: (k, l) => (l ? 6 : 8), readiness: (k, l) => (l ? 60 : 85) }),
      build(24, even, { readiness: (k, l) => (l ? 60 : 85), habits: (k, l) => !l }),
      build(24, even, { spend: (k, l) => (l ? 30 : 20), events: (k, l) => (l ? 3 : 0) }),
      build(24, even, { sleep: (k, l) => (l ? 6 : 8), mood: (k, l) => (l ? 'down' : 'good') }),
      build(30, even, { spend: (k, l) => (l ? 1234.56 : 0), sleep: (k, l) => (l ? 6 : 8) }),
    ];
    const texts = datasets.flatMap((d) => computeCrossInsights(d).insights.map((i) => i.text));
    const ids = new Set(datasets.flatMap((d) => computeCrossInsights(d).insights.map((i) => i.id)));
    expect([...ids].sort()).toEqual(CROSS_INSIGHT_PAIRS.map((p) => p.id).sort());
    expect(texts.length).toBeGreaterThanOrEqual(6);
    for (const t of texts) {
      expect(t).not.toMatch(/caus|because|leads? to|due to|result(s|ed)? in|makes? you/i);
      expect(t).not.toMatch(/[‒-―−]/);
      expect(t).toMatch(/\(n=\d+\)\.$/);
    }
  });
});

describe('degrees of freedom, readability and winsor cap', () => {
  const mk = (n, xAt, yAt, nowDay = NOW) => {
    const input = { now: nowDay, ouraSource: 'oura', ouraDays: [], transactions: [] };
    for (let k = 1; k <= n; k += 1) {
      input.ouraDays.push({ day: dayKey(k), sleepHours: xAt(k) });
      input.transactions.push(debit(k, yAt(k), 'Dining'));
    }
    return input;
  };

  it('n=14 with two days per weekday and |rho| about 0.8 does not pass (nEff = 8)', () => {
    // Deterministic noisy series: sleep falls as dining rises, but only about rho -0.8 after weekday residuals.
    const sleeps = [8, 6, 7.5, 6.5, 8.2, 6.2, 7.8, 6.8, 7.2, 6.4, 8.4, 6.6, 7.6, 6.1];
    const dining = [10, 30, 22, 14, 12, 28, 11, 26, 16, 18, 9, 24, 13, 31];
    const input = mk(14, (k) => sleeps[k - 1], (k) => dining[k - 1]);
    const r = computeCrossInsights(input);
    expect(find(r, 'sleep_dining')).toBeUndefined();
  });

  it('a strong n=60 case still passes and displays the paired n', () => {
    const r = computeCrossInsights(mk(60, (k) => (even(k) ? 6 : 8), (k) => (even(k) ? 30 : 20)));
    expect(find(r, 'sleep_dining').n).toBe(60);
  });

  it('drops weekdays seen once but keeps the paired n for display and MIN_N', () => {
    // 14 paired days over 6 weekdays; two weekdays have a single day and are dropped from the test.
    const ks = [1, 8, 15, 22, 2, 9, 16, 3, 10, 17, 4, 11, 5, 6];
    const input = { now: NOW, ouraSource: 'oura', ouraDays: [], transactions: [] };
    for (const k of ks) {
      input.ouraDays.push({ day: dayKey(k), sleepHours: even(k) ? 6 : 8 });
      input.transactions.push(debit(k, even(k) ? 30 : 20, 'Dining'));
    }
    const i = find(computeCrossInsights(input), 'sleep_dining');
    expect(i.n).toBe(14);
  });

  it('uses dollar wording with both typical values when |effectPct| > 300', () => {
    // Typical $50 vs $10 is +400%, past the 300% text limit.
    const r = computeCrossInsights(mk(40, (k) => (even(k) ? 6 : 8), (k) => (even(k) ? 50 : 10)));
    const i = find(r, 'sleep_dining');
    expect(i.effectPct).toBe(400);
    expect(i.text).toBe('On days you slept under 7h you spent $40.00 more on dining (typically $50.00 vs $10.00) (n=40).');
    const pctText = find(computeCrossInsights(mk(40, (k) => (even(k) ? 6 : 8), (k) => (even(k) ? 40 : 10))), 'sleep_dining').text;
    expect(pctText).toBe('On days you slept under 7h you spent 300% more on dining (n=40).');
  });

  it('clamps effectPct to +/-10000', () => {
    const r = computeCrossInsights(mk(40, (k) => (even(k) ? 6 : 8), (k) => (even(k) ? 100000 : 5)));
    expect(find(r, 'sleep_dining').effectPct).toBe(10000);
  });

  it('the winsor cap bites below n=20 (floor(0.95 * (n - 1)))', () => {
    const r = computeCrossInsights(
      mk(16, (k) => (even(k) ? 6 : 8), (k) => (k === 2 ? 1000 : even(k) ? 30 : 20)),
    );
    const i = find(r, 'sleep_dining');
    expect(i.groupA.mean).toBeLessThan(100); // untrimmed the 1000 would lift this above 150
  });
});

describe('result shape', () => {
  it('caps at MAX_SHOWN and sorts by |rho| descending', () => {
    const input = build(30, even, {
      spend: (k, l) => (l ? 30 : 20),
      sleep: (k, l) => (l ? 6 : 8),
      readiness: (k, l) => (l ? 60 : 85),
      habits: (k, l) => !l,
      events: (k, l) => (l ? 3 : 0),
      mood: (k, l) => (l ? 'down' : 'good'),
    });
    // weaken one pair so rho differs: flip 3 readiness values
    input.ouraDays[0].readiness = 60;
    input.ouraDays[2].readiness = 60;
    input.ouraDays[4].readiness = 60;
    const r = computeCrossInsights(input);
    expect(MAX_SHOWN).toBe(4);
    expect(r.insights).toHaveLength(4);
    const rhos = r.insights.map((i) => Math.abs(i.rho));
    expect(rhos).toEqual([...rhos].sort((a, b) => b - a));
    assertAllFinite(r);
  });

  it('reports windowDays, coverage and missing reasons for a partial dataset', () => {
    const r = computeCrossInsights(build(20, even, { spend: () => 10, sleep: () => 7 }));
    expect(r.windowDays).toBe(WINDOW_DAYS);
    expect(r.coverage).toMatchObject({ spend: 20, health: 20, habits: 0, mood: 0, calendar: 0 });
    expect(r.missing).toEqual(['no_habits', 'no_journal_mood', 'no_calendar']);
    expect(r.status).toBe('insufficient');
  });

  it('r is reported (2dp) and rho is rounded to 2dp', () => {
    const i = find(
      computeCrossInsights(build(30, even, { spend: (k, l) => (l ? 30 : 20), sleep: (k, l) => (l ? 6 : 8) })),
      'sleep_dining',
    );
    expect(i.rho).toBe(-1);
    expect(i.r).toBe(-1);
    expect(Number.isInteger(i.effectPct)).toBe(true);
    for (const v of [i.rho, i.r, i.effectAbs, i.groupA.mean, i.groupB.mean]) {
      expect(Math.round(v * 100) / 100).toBe(v);
    }
  });

  it('never emits -0', () => {
    const r = computeCrossInsights(
      build(30, even, { spend: (k, l) => (l ? 30 : 20), sleep: (k, l) => (l ? 6 : 8) }),
    );
    expect(JSON.stringify(r)).not.toContain('-0,');
    expect(JSON.stringify(r)).not.toContain('-0}');
  });
});

describe('deep finite scan with hostile inputs', () => {
  it('contaminated rows never leak NaN or Infinity and never throw', () => {
    const clean = build(30, even, {
      spend: (k, l) => (l ? 30 : 20),
      sleep: (k, l) => (l ? 6 : 8),
      readiness: (k, l) => (l ? 60 : 85),
      habits: (k, l) => !l,
      events: (k, l) => (l ? 3 : 0),
      mood: (k, l) => (l ? 'down' : 'good'),
    });
    const dirty = {
      ...clean,
      transactions: [
        ...clean.transactions,
        { date: dayKey(3), amount: Number.NaN, type: 'debit', category: 'Dining' },
        { date: dayKey(3), amount: Number.POSITIVE_INFINITY, type: 'debit', category: 'Dining' },
        { date: dayKey(3), amount: null, type: 'debit' },
        { date: dayKey(3), amount: '12abc', type: 'debit' },
        { date: dayKey(3), amount: -50, type: 'debit' },
      ],
      ouraDays: [
        ...clean.ouraDays,
        { day: dayKey(4), sleepHours: Number.POSITIVE_INFINITY, readiness: Number.NaN },
        { day: dayKey(5), sleepHours: Number.NaN, readiness: Number.NEGATIVE_INFINITY },
        { day: dayKey(6), sleepHours: null, readiness: null },
      ],
      habits: [...clean.habits, { frequency: 'daily', createdTime: 'garbage', completions: [null, 5, {}] }],
      journal: [...clean.journal, { date: Number.NaN, mood: 'good' }, { date: at(2), mood: 'great ' }],
      events: [...clean.events, { start: Number.NaN }, { start: Infinity, allDay: false }],
    };
    const r = computeCrossInsights(dirty);
    assertAllFinite(r);
    assertAllFinite(toExplainSummary(r));
    assertAllFinite(buildDailySeries(dirty, { now: NOW }));
    // The bad rows must not have changed what the clean data proved.
    expect(find(r, 'sleep_dining').groupA.mean).toBeGreaterThan(0);
  });

  it('empty, single point and all-equal datasets are finite and insufficient', () => {
    const cases = [
      {},
      { transactions: [debit(1, 5)], ouraDays: [{ day: dayKey(1), sleepHours: 6 }], ouraSource: 'oura' },
      build(30, even, { spend: () => 10, sleep: () => 8, readiness: () => 80, mood: () => 'good', events: () => 2 }),
    ];
    for (const c of cases) {
      const r = computeCrossInsights({ now: NOW, ...c });
      expect(r.status).toBe('insufficient');
      assertAllFinite(r);
    }
  });

  it('toExplainSummary tolerates undefined and empty results', () => {
    expect(toExplainSummary(undefined)).toEqual({ windowDays: WINDOW_DAYS, insights: [] });
    expect(toExplainSummary({ windowDays: Number.NaN, insights: [] }).windowDays).toBe(WINDOW_DAYS);
  });

  it('the explain payload has only numbers, ids and unit: no merchant, description or journal text', () => {
    const input = build(30, even, {
      spend: (k, l) => (l ? 30 : 20),
      sleep: (k, l) => (l ? 6 : 8),
      mood: (k, l) => (l ? 'down' : 'good'),
    });
    input.transactions.forEach((t, i) => {
      t.merchant = 'Starbucks #1234';
      t.description = 'COFFEE SHOP PRIVATE';
      t.category = i % 2 ? 'Dining' : 'Dining out';
    });
    input.journal.forEach((j) => {
      j.title = 'Secret title';
      j.content = 'dear diary: private thoughts';
    });
    const summary = toExplainSummary(computeCrossInsights(input));
    expect(summary.insights.length).toBeGreaterThan(0);
    const ids = CROSS_INSIGHT_PAIRS.map((p) => p.id);
    for (const item of summary.insights) {
      for (const [k, v] of Object.entries(item)) {
        if (k === 'id') expect(ids).toContain(v);
        else if (k === 'unit') expect(['usd', 'rate', 'mood']).toContain(v);
        else expect(v === null || typeof v === 'number').toBe(true);
      }
    }
    expect(JSON.stringify(summary)).not.toMatch(/Starbucks|COFFEE|Secret|diary|"great"|"good"|"down"|Dining out/i);
  });
});

describe('local-day alignment', () => {
  it('the window ends yesterday: today and day 61 are out, day 1 and day 60 are in', () => {
    const ouraDays = [0, 1, 60, 61].map((k) => ({ day: dayKey(k), sleepHours: 7, readiness: 80 }));
    const s = buildDailySeries({ ouraDays, ouraSource: 'oura' }, { now: NOW });
    expect([...s.sleepHours.keys()].sort()).toEqual([dayKey(60), dayKey(1)].sort());
  });

  it('timestamps either side of local midnight land on their own local day', () => {
    const justBefore = new Date(2026, 5, 10, 23, 59, 59);
    const justAfter = new Date(2026, 5, 11, 0, 0, 1);
    const s = buildDailySeries(
      {
        journal: [
          { date: justBefore.toISOString(), mood: 'rough' },
          { date: justAfter.toISOString(), mood: 'great' },
        ],
        events: [
          { start: justBefore.toISOString(), allDay: false },
          { start: new Date(2026, 5, 11, 0, 0, 0).toISOString(), allDay: false },
        ],
      },
      { now: NOW },
    );
    expect(s.mood.get('2026-06-10')).toBe(1);
    expect(s.mood.get('2026-06-11')).toBe(5);
    expect(s.events.get('2026-06-10')).toBe(1);
    expect(s.events.get('2026-06-11')).toBe(1);
  });

  it('date-only strings are used as-is (no timezone shift)', () => {
    const s = buildDailySeries({ journal: [{ date: '2026-06-10', mood: 'good' }] }, { now: NOW });
    expect(s.mood.get('2026-06-10')).toBe(4);
    expect(s.mood.size).toBe(1);
  });

  it('a UTC timestamp is converted to the local day, not sliced', () => {
    // 03:30Z on June 11 is 23:30 on June 10 in New York (EDT).
    const iso = '2026-06-11T03:30:00.000Z';
    const expected = keyOf(new Date(iso));
    const s = buildDailySeries({ journal: [{ date: iso, mood: 'good' }] }, { now: NOW });
    expect([...s.mood.keys()]).toEqual([expected]);
    if (tzWorks) expect(expected).toBe('2026-06-10');
  });

  it('sample Oura data is excluded from series and from insights, even for a perfect pattern', () => {
    const data = build(30, even, { spend: (k, l) => (l ? 30 : 20), sleep: (k, l) => (l ? 6 : 8) });
    for (const source of ['other', undefined, null, 'OURA', '']) {
      const r = computeCrossInsights({ ...data, ouraSource: source });
      expect(r.insights.filter((i) => i.id.startsWith('sleep_') || i.id.startsWith('readiness_'))).toEqual([]);
      expect(r.coverage.health).toBe(0);
      expect(r.missing).toContain('health_not_connected');
    }
    expect(computeCrossInsights({ ...data, ouraSource: 'oura' }).coverage.health).toBe(30);
  });

  it('sleep from Oura day D pairs with spend on D, not D-1', () => {
    // Sleep is low only on even days; spend is high only the day AFTER, so a shifted pairing would flip the sign.
    const data = build(30, even, { spend: (k) => (even(k) ? 30 : 20), sleep: (k, l) => (l ? 6 : 8) });
    const i = find(computeCrossInsights(data), 'sleep_spend');
    expect(i.groupA.mean).toBe(30);
  });

  describe.skipIf(!tzWorks)('DST transitions (America/New_York)', () => {
    it('the 60-day window across spring-forward has 60 distinct, consecutive local days', () => {
      const now = new Date(2026, 2, 20, 12); // window spans 2026-03-08
      const days = Array.from({ length: 60 }, (_, i) => ({ day: dayKey(i + 1, now), sleepHours: 7, readiness: 80 }));
      const s = buildDailySeries({ ouraDays: days, ouraSource: 'oura' }, { now });
      expect(s.sleepHours.size).toBe(60);
      expect(s.sleepHours.has('2026-03-08')).toBe(true);
      expect(s.sleepHours.has('2026-03-07')).toBe(true);
      expect(s.sleepHours.has('2026-03-09')).toBe(true);
    });

    it('the window across fall-back (25 hour day) also has 60 distinct days', () => {
      const now = new Date(2026, 10, 15, 12);
      const days = Array.from({ length: 60 }, (_, i) => ({ day: dayKey(i + 1, now), sleepHours: 7 }));
      const s = buildDailySeries({ ouraDays: days, ouraSource: 'oura' }, { now });
      expect(s.sleepHours.size).toBe(60);
      expect(s.sleepHours.has('2026-11-01')).toBe(true);
    });

    it('zero-fills spend across the transition without dropping or duplicating a day', () => {
      const now = new Date(2026, 2, 20, 12);
      const { spend } = buildDailySeries(
        { transactions: [debit(15, 5, 'Groceries', now), debit(5, 5, 'Groceries', now)] },
        { now },
      );
      expect(spend.size).toBe(11); // days 15..5 inclusive
      expect(spend.get('2026-03-08')).toBe(0);
    });

    it('a time inside the skipped hour and the repeated hour stays on the right day', () => {
      const now = new Date(2026, 10, 15, 12);
      const skipped = new Date(2026, 2, 8, 2, 30).toISOString(); // does not exist; JS shifts to 03:30 EDT
      const repeated = new Date(2026, 10, 1, 1, 30).toISOString(); // ambiguous hour
      const late = new Date(2026, 10, 1, 23, 30).toISOString();
      const s = buildDailySeries(
        {
          journal: [
            { date: skipped, mood: 'good' },
            { date: repeated, mood: 'great' },
            { date: late, mood: 'okay' },
          ],
        },
        { now: new Date(2026, 2, 20, 12) },
      );
      expect(s.mood.get('2026-03-08')).toBe(4);
      const s2 = buildDailySeries({ journal: [{ date: repeated, mood: 'great' }, { date: late, mood: 'okay' }] }, { now });
      expect(s2.mood.get('2026-11-01')).toBe(4); // mean of 5 and 3
    });

    it('a full insight run across spring-forward still pairs every day', () => {
      const now = new Date(2026, 2, 20, 12);
      const input = { now, ouraSource: 'oura', ouraDays: [], transactions: [] };
      for (let k = 1; k <= 30; k += 1) {
        const low = k % 2 === 0;
        input.ouraDays.push({ day: dayKey(k, now), sleepHours: low ? 6 : 8 });
        input.transactions.push(debit(k, low ? 30 : 20, 'Dining', now));
      }
      const r = computeCrossInsights(input);
      expect(find(r, 'sleep_dining').n).toBe(30);
      assertAllFinite(r);
    });
  });
});
