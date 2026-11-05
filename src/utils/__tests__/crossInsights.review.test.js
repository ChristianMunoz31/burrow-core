// Regression tests for the review fixes: n-aware Fisher-z gate (Bonferroni across 6 pairs),
// weekday adjustment, winsorised dollar means, small-baseline percentages, explain clamp.
globalThis.process.env.TZ = 'America/New_York';

import { describe, it, expect } from 'vitest';
import { computeCrossInsights, spearman, toExplainSummary, Z_GATE } from '../crossInsights';

const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const NOW = new Date(2026, 5, 15, 12, 0, 0);
const dateOf = (k) => new Date(2026, 5, 15 - k);
const dayKey = (k) => keyOf(dateOf(k));

/** Deterministic PRNG (mulberry32) so fixtures never flake. */
function rng(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** n days of sleep + dining spend where spend loosely falls as sleep rises. */
function noisy(n, seed, slope) {
  const r = rng(seed);
  const input = { now: NOW, ouraSource: 'oura', ouraDays: [], transactions: [] };
  for (let k = 1; k <= n; k += 1) {
    const sleep = Math.round((5 + 4 * r()) * 10) / 10;
    const spend = Math.max(1, Math.round(40 - slope * sleep + 12 * (r() - 0.5) * 2));
    input.ouraDays.push({ day: dayKey(k), sleepHours: sleep });
    input.transactions.push({ date: dayKey(k), amount: spend, category: 'Dining', type: 'debit' });
  }
  return input;
}

const find = (result, id) => result.insights.find((i) => i.id === id);

describe('H1 n-aware significance gate', () => {
  it('exposes the Bonferroni-corrected z threshold', () => {
    expect(Z_GATE).toBe(2.64);
  });

  it('n=14 with |rho| about 0.45 is skipped (z is far below the gate)', () => {
    const input = noisy(14, 3, 4);
    const rho = spearman(
      input.ouraDays.map((d) => d.sleepHours),
      input.transactions.map((t) => t.amount),
    );
    expect(Math.abs(rho)).toBeGreaterThan(0.3); // the old fixed 0.3 gate would have let this through
    expect(find(computeCrossInsights(input), 'sleep_dining')).toBeUndefined();
  });

  it('n=60 with |rho| about 0.35 is kept', () => {
    const kept = find(computeCrossInsights(noisy(60, 9, 2)), 'sleep_dining');
    expect(kept).toBeDefined();
    expect(Math.abs(kept.rho)).toBeGreaterThanOrEqual(0.3);
    expect(Math.abs(kept.rho)).toBeLessThan(0.4);
  });

  it('n=60 with |rho| just under the z gate (0.34) is skipped', () => {
    expect(find(computeCrossInsights(noisy(60, 1, 3)), 'sleep_dining')).toBeUndefined();
  });
});

describe('M3 weekday adjustment', () => {
  it('skips a pure weekend effect that drives both series', () => {
    const r = rng(7);
    const input = { now: NOW, ouraSource: 'oura', ouraDays: [], transactions: [] };
    const sleeps = [];
    const spends = [];
    for (let k = 1; k <= 60; k += 1) {
      const weekend = [0, 6].includes(dateOf(k).getDay());
      const sleep = (weekend ? 6 : 8) + (r() - 0.5) * 0.4;
      const spend = (weekend ? 45 : 20) + (r() - 0.5) * 6;
      sleeps.push(sleep);
      spends.push(spend);
      input.ouraDays.push({ day: dayKey(k), sleepHours: sleep });
      input.transactions.push({ date: dayKey(k), amount: spend, category: 'Dining', type: 'debit' });
    }
    expect(Math.abs(spearman(sleeps, spends))).toBeGreaterThan(0.5); // raw series look strongly linked
    expect(computeCrossInsights(input).insights).toEqual([]);
  });
});

describe('M1 winsorised dollar means', () => {
  it('caps one huge spend at the 95th percentile before averaging', () => {
    const input = { now: NOW, ouraSource: 'oura', ouraDays: [], transactions: [] };
    for (let k = 1; k <= 40; k += 1) {
      const low = k % 2 === 0;
      const base = (low ? 30 : 20) + (k % 3);
      input.ouraDays.push({ day: dayKey(k), sleepHours: (low ? 6 : 8) + (k % 5) * 0.01 });
      input.transactions.push({
        date: dayKey(k),
        amount: k === 20 ? 1000 : base,
        category: 'Dining',
        type: 'debit',
      });
    }
    const i = find(computeCrossInsights(input), 'sleep_dining');
    expect(i).toBeDefined();
    expect(i.groupA.mean).toBeLessThan(40); // unwinsorised it would be about 80
    expect(i.groupA.mean).toBeGreaterThan(25);
  });
});

describe('M2 small baselines and the explain clamp', () => {
  it('uses dollar wording when the baseline mean is under $5', () => {
    const input = { now: NOW, ouraSource: 'oura', ouraDays: [], transactions: [] };
    for (let k = 1; k <= 30; k += 1) {
      const low = k % 2 === 0;
      input.ouraDays.push({ day: dayKey(k), sleepHours: low ? 6 : 8 });
      input.transactions.push({ date: dayKey(k), amount: low ? 12 : 2, category: 'Dining', type: 'debit' });
    }
    const i = find(computeCrossInsights(input), 'sleep_dining');
    expect(i.effectPct).toBeNull();
    expect(i.text).toBe('On days you slept under 7h you spent $10.00 more on dining (typically $12.00 vs $2.00) (n=30).');
  });

  it('clamps effectPct to +/-10000 in the explain summary', () => {
    const mk = (effectPct) => ({
      windowDays: 60,
      insights: [
        { id: 'sleep_dining', n: 20, rho: -0.4, groupA: { days: 8, mean: 1 }, groupB: { days: 12, mean: 1 }, effectPct, unit: 'usd' },
      ],
    });
    expect(toExplainSummary(mk(250000)).insights[0].effectPct).toBe(10000);
    expect(toExplainSummary(mk(-250000)).insights[0].effectPct).toBe(-10000);
    expect(toExplainSummary(mk(38)).insights[0].effectPct).toBe(38);
    expect(toExplainSummary(mk(null)).insights[0].effectPct).toBeNull();
  });
});
