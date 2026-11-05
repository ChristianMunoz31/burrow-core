// Cross-domain insights: pure, no React. Aligns daily series (spend, dining, sleep,
// readiness, habits, calendar, mood), then reports only pairs that clear every gate
// (min paired days, n-aware Fisher-z significance with a Bonferroni correction across the
// pairs, Spearman strength, group sizes, effect size, direction).
// Wording is correlation only. Nothing here returns NaN or Infinity.
import { isTransfer } from './transactionFilters';
import { formatCurrency } from './budgetAggregate';
import { localDayOf, toLocalDay } from './relativeDay';

export const WINDOW_DAYS = 60; // ending yesterday (local); today is partial
export const MIN_N = 14; // paired days
export const MIN_GROUP = 5; // days per split group
export const MIN_ABS_RHO = 0.3; // Spearman gate
// Bonferroni across 6 pairs at alpha 0.05: two-sided p < 0.05 / 6 -> z >= 2.64.
export const Z_GATE = 2.64;
export const WINSOR_PCTL = 0.95; // usd group means are capped at this percentile
export const MIN_BASE_USD = 5; // below this |meanB|, percentages are meaningless
export const MAX_EFFECT_PCT = 10000;
export const MIN_EFFECT_PCT = 10; // relative effect gate
export const MIN_EFFECT_USD = 5; // when the baseline mean is ~0
export const MIN_EFFECT_MOOD = 0.3; // points on 1..5
export const MAX_SHOWN = 4;
export const MOOD_SCORE = { great: 5, good: 4, okay: 3, down: 2, rough: 1 };
export const DINING_RE = /dining|restaurant|fast food|food & drink|coffee|cafe|\bbars?\b/i;

export const CROSS_INSIGHT_PAIRS = [
  { id: 'sleep_dining', x: 'sleepHours', y: 'dining', split: { lt: 7 } },
  { id: 'sleep_spend', x: 'sleepHours', y: 'spend', split: { lt: 7 } },
  { id: 'readiness_spend', x: 'readiness', y: 'spend', split: { lt: 70 } },
  { id: 'readiness_habits', x: 'readiness', y: 'habitRate', split: { lt: 70 } },
  { id: 'busyness_spend', x: 'events', y: 'spend', split: { gte: [3, 2, 1] } },
  { id: 'sleep_mood', x: 'sleepHours', y: 'mood', split: { lt: 7 } },
];

const UNIT_BY_Y = { spend: 'usd', dining: 'usd', habitRate: 'rate', mood: 'mood' };
const DAY_RE = /^\d{4}-\d{2}-\d{2}/;

const finite = (x, fallback = 0) => (typeof x === 'number' && Number.isFinite(x) ? x : fallback);
const round2 = (x) => Math.round(finite(x) * 100) / 100 + 0; // + 0 turns -0 into 0
const mean = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0);

function windowKeys(now) {
  const keys = [];
  for (let i = WINDOW_DAYS; i >= 1; i -= 1) {
    keys.push(localDayOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));
  }
  return keys;
}

/**
 * Pearson correlation. Null when n < 3, lengths differ, or either series has zero variance.
 * @param {number[]} xs
 * @param {number[]} ys
 * @returns {number | null}
 */
export function pearson(xs, ys) {
  if (!Array.isArray(xs) || !Array.isArray(ys) || xs.length !== ys.length || xs.length < 3) return null;
  const n = xs.length;
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  const denom = Math.sqrt(sxx * syy);
  if (!(denom > 0) || !Number.isFinite(denom)) return null;
  const r = sxy / denom;
  if (!Number.isFinite(r)) return null;
  return Math.max(-1, Math.min(1, r));
}

function averageRanks(values) {
  const idx = values.map((v, i) => i).sort((a, b) => values[a] - values[b]);
  const ranks = new Array(values.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && values[idx[j + 1]] === values[idx[i]]) j += 1;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) ranks[idx[k]] = rank;
    i = j + 1;
  }
  return ranks;
}

/**
 * Spearman rank correlation (average ranks for ties, then Pearson).
 * @param {number[]} xs
 * @param {number[]} ys
 * @returns {number | null}
 */
export function spearman(xs, ys) {
  if (!Array.isArray(xs) || !Array.isArray(ys) || xs.length !== ys.length || xs.length < 3) return null;
  return pearson(averageRanks(xs), averageRanks(ys));
}

/** Median of a numeric array (0 when empty). */
function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Local weekday (0..6) of a YYYY-MM-DD key. */
function weekdayOf(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

/** Subtract each weekday's median (over the given days) so weekly rhythm is not mistaken for a link. */
function residualise(values, weekdays) {
  const byDay = new Map();
  values.forEach((v, i) => {
    const list = byDay.get(weekdays[i]) ?? [];
    list.push(v);
    byDay.set(weekdays[i], list);
  });
  const med = new Map([...byDay].map(([k, list]) => [k, median(list)]));
  return values.map((v, i) => v - med.get(weekdays[i]));
}

/**
 * Upper-cap values at the given percentile. The cap index is floor(pctl * (n - 1)), so the top
 * value is always trimmed for n >= 2, including below n = 20 where a nearest-rank
 * ceil(pctl * n) - 1 index lands on the maximum and trims nothing.
 */
function winsorize(values, pctl) {
  if (!values.length) return values;
  const sorted = [...values].sort((a, b) => a - b);
  const cap = sorted[Math.floor(pctl * (sorted.length - 1))];
  return values.map((v) => Math.min(v, cap));
}

/**
 * Fisher-z test statistic for a correlation over an effective sample size (Spearman variance
 * inflation 1.06). Null when no degrees of freedom are left (nEff - 3 < 1).
 */
function fisherZ(rho, nEff) {
  if (nEff - 3 < 1) return null;
  return Math.atanh(Math.min(0.999999, Math.abs(rho))) * Math.sqrt((nEff - 3) / 1.06);
}

function addTo(map, key, value) {
  map.set(key, (map.get(key) ?? 0) + value);
}

/**
 * Aligned daily series keyed by local YYYY-MM-DD, within the WINDOW_DAYS ending yesterday.
 * @param {{ transactions?: object[], ouraDays?: object[], ouraSource?: string | null, habits?: object[], journal?: object[], events?: object[] }} input
 * @param {{ now?: Date }} [opts]
 * @returns {Record<'spend'|'dining'|'sleepHours'|'readiness'|'habitRate'|'events'|'mood', Map<string, number>>}
 */
export function buildDailySeries(input = {}, { now = new Date() } = {}) {
  const { transactions, ouraDays, ouraSource, habits, journal, events } = input ?? {};
  const keys = windowKeys(now);
  const inWindow = new Set(keys);
  const series = {
    spend: new Map(),
    dining: new Map(),
    sleepHours: new Map(),
    readiness: new Map(),
    habitRate: new Map(),
    events: new Map(),
    mood: new Map(),
  };

  // Spend / dining: zero-fill only between the first and last transaction date.
  const txs = Array.isArray(transactions) ? transactions : [];
  let first = null;
  let last = null;
  const spendByDay = new Map();
  const diningByDay = new Map();
  for (const t of txs) {
    if (!t || typeof t.date !== 'string' || !DAY_RE.test(t.date)) continue;
    const day = t.date.slice(0, 10);
    if (first === null || day < first) first = day;
    if (last === null || day > last) last = day;
    const amount = Number(t.amount);
    if (t.type !== 'debit' || isTransfer(t) || !Number.isFinite(amount) || amount <= 0) continue;
    addTo(spendByDay, day, amount);
    if (DINING_RE.test(String(t.category ?? ''))) addTo(diningByDay, day, amount);
  }
  if (first !== null) {
    for (const key of keys) {
      if (key < first || key > last) continue;
      series.spend.set(key, spendByDay.get(key) ?? 0);
      series.dining.set(key, diningByDay.get(key) ?? 0);
    }
  }

  // Health: only days that came from the user's real Oura data count; anything else is ignored.
  if (ouraSource === 'oura' && Array.isArray(ouraDays)) {
    for (const d of ouraDays) {
      if (!d || typeof d.day !== 'string' || !inWindow.has(d.day)) continue;
      if (typeof d.sleepHours === 'number' && Number.isFinite(d.sleepHours) && d.sleepHours > 0) {
        series.sleepHours.set(d.day, d.sleepHours);
      }
      if (typeof d.readiness === 'number' && Number.isFinite(d.readiness)) {
        series.readiness.set(d.day, d.readiness);
      }
    }
  }

  // Habits: daily only; completed on D / habits created on or before D.
  const daily = (Array.isArray(habits) ? habits : []).filter((h) => h && h.frequency === 'daily');
  if (daily.length) {
    const prepared = daily.map((h) => ({
      created: toLocalDay(h.createdTime),
      done: new Set(Array.isArray(h.completions) ? h.completions : []),
    }));
    for (const key of keys) {
      const active = prepared.filter((h) => h.created === null || h.created <= key);
      if (!active.length) continue;
      const completed = active.filter((h) => h.done.has(key)).length;
      series.habitRate.set(key, completed / active.length);
    }
  }

  // Calendar: non all-day events by start day; zero-fill only between the first and last event
  // day (across all events, not just the window) so days before calendar data are not "quiet".
  const counts = new Map();
  let firstEv = null;
  let lastEv = null;
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || e.allDay) continue;
    const day = toLocalDay(e.start);
    if (!day) continue;
    if (firstEv === null || day < firstEv) firstEv = day;
    if (lastEv === null || day > lastEv) lastEv = day;
    if (inWindow.has(day)) addTo(counts, day, 1);
  }
  if (firstEv !== null) {
    for (const key of keys) {
      if (key < firstEv || key > lastEv) continue;
      series.events.set(key, counts.get(key) ?? 0);
    }
  }

  // Mood: mean score of the day's journal entries.
  const moods = new Map();
  for (const entry of Array.isArray(journal) ? journal : []) {
    const score = MOOD_SCORE[entry?.mood];
    const day = toLocalDay(entry?.date);
    if (!score || !day || !inWindow.has(day)) continue;
    const list = moods.get(day) ?? [];
    list.push(score);
    moods.set(day, list);
  }
  for (const [day, list] of moods) series.mood.set(day, mean(list));

  return series;
}

function sign(x) {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

const MAX_TEXT_PCT = 300; // above this a percentage reads as noise; show dollars instead

function buildText(pair, { n, effectPct, effectAbs, threshold, meanA, meanB }) {
  const more = effectAbs > 0;
  const pct = effectPct === null ? null : Math.abs(effectPct);
  // Dollar means are winsorized daily means, so the card calls them "typical".
  const spent = (tail) => {
    const dir = more ? 'more' : 'less';
    if (pct === null || pct > MAX_TEXT_PCT) {
      const typical = `typically ${formatCurrency(meanA)} vs ${formatCurrency(meanB)}`;
      return `you spent ${formatCurrency(Math.abs(effectAbs))} ${dir}${tail} (${typical}) (n=${n}).`;
    }
    return `you spent ${pct}% ${dir}${tail} (n=${n}).`;
  };
  switch (pair.id) {
    case 'sleep_dining':
      return `On days you slept under 7h ${spent(' on dining')}`;
    case 'sleep_spend':
      return `On days you slept under 7h ${spent(' overall')}`;
    case 'readiness_spend':
      return `On days your readiness was under 70 ${spent('')}`;
    case 'readiness_habits':
      return `On days your readiness was under 70 you completed ${Math.round(meanA * 100)}% vs ${Math.round(meanB * 100)}% of your habits (n=${n}).`;
    case 'busyness_spend':
      return `On days with ${threshold}+ calendar events ${spent('')}`;
    case 'sleep_mood':
      return `After nights under 7h of sleep your journal mood averaged ${Math.abs(effectAbs).toFixed(1)} points ${more ? 'higher' : 'lower'} (n=${n}).`;
    default:
      return '';
  }
}

const GROUP_LABELS = {
  sleepHours: ['under 7h', '7h or more'],
  readiness: ['readiness under 70', 'readiness 70 or more'],
};

function evaluatePair(pair, series) {
  const xs = series[pair.x];
  const ys = series[pair.y];
  if (!xs || !ys) return null;
  const days = [...xs.keys()].filter((k) => ys.has(k)).sort();
  const n = days.length;
  if (n < MIN_N) return null;
  const xv = days.map((k) => xs.get(k));
  const yv = days.map((k) => ys.get(k));

  // Correlation is computed on weekday-adjusted series; group effects below stay in raw units.
  // A weekday seen once has a residual of 0 on both sides, so it is dropped. Each remaining
  // weekday median costs one degree of freedom: nEff = m - (k - 1) for m kept days, k weekdays.
  const weekdays = days.map(weekdayOf);
  const counts = new Map();
  for (const w of weekdays) counts.set(w, (counts.get(w) ?? 0) + 1);
  const keep = weekdays.map((w) => counts.get(w) > 1);
  const wk = weekdays.filter((_, i) => keep[i]);
  const nEff = wk.length - (new Set(wk).size - 1);
  const xr = residualise(xv.filter((_, i) => keep[i]), wk);
  const yr = residualise(yv.filter((_, i) => keep[i]), wk);
  const rho = spearman(xr, yr);
  if (rho === null || Math.abs(rho) < MIN_ABS_RHO) return null;
  const z = fisherZ(rho, nEff);
  if (z === null || z < Z_GATE) return null;
  const r = pearson(xr, yr);

  let threshold;
  let inA;
  let labels;
  if ('lt' in pair.split) {
    threshold = pair.split.lt;
    inA = (x) => x < threshold;
    labels = GROUP_LABELS[pair.x];
  } else {
    threshold = pair.split.gte.find((t) => {
      const a = xv.filter((x) => x >= t).length;
      return a >= MIN_GROUP && n - a >= MIN_GROUP;
    });
    if (threshold === undefined) return null;
    inA = (x) => x >= threshold;
    labels = [`${threshold}+ events`, `fewer than ${threshold} events`];
  }
  const unit = UNIT_BY_Y[pair.y];
  const yg = unit === 'usd' ? winsorize(yv, WINSOR_PCTL) : yv;
  const aVals = [];
  const bVals = [];
  for (let i = 0; i < n; i += 1) (inA(xv[i]) ? aVals : bVals).push(yg[i]);
  if (aVals.length < MIN_GROUP || bVals.length < MIN_GROUP) return null;

  const meanA = mean(aVals);
  const meanB = mean(bVals);
  const effectAbs = finite(meanA - meanB);
  const minBase = unit === 'usd' ? MIN_BASE_USD : 0.01;
  const effectPct =
    Math.abs(meanB) < minBase
      ? null
      : Math.max(-MAX_EFFECT_PCT, Math.min(MAX_EFFECT_PCT, Math.round((effectAbs / Math.abs(meanB)) * 100)));

  if (unit === 'usd') {
    const ok = effectPct === null ? Math.abs(effectAbs) >= MIN_EFFECT_USD : Math.abs(effectPct) >= MIN_EFFECT_PCT;
    if (!ok) return null;
  } else if (unit === 'rate') {
    if (effectPct === null || Math.abs(effectPct) < MIN_EFFECT_PCT) return null;
  } else if (Math.abs(effectAbs) < MIN_EFFECT_MOOD) {
    return null;
  }

  const expected = 'lt' in pair.split ? -sign(rho) : sign(rho);
  if (sign(effectAbs) !== expected) return null;

  return {
    id: pair.id,
    n,
    rho: round2(rho),
    r: r === null ? null : round2(r),
    groupA: { label: labels[0], days: aVals.length, mean: round2(meanA) },
    groupB: { label: labels[1], days: bVals.length, mean: round2(meanB) },
    effectPct,
    effectAbs: round2(effectAbs),
    unit,
    text: buildText(pair, { n, effectPct, effectAbs, threshold, meanA, meanB }),
  };
}

/**
 * Compute the cross-domain insights shown on Home.
 * @param {{ transactions?: object[], ouraDays?: object[], ouraSource?: string | null, habits?: object[], journal?: object[], events?: object[], now?: Date }} input
 * Every pair competes for the MAX_SHOWN slots by abs(rho).
 * @returns {{ status: 'ok' | 'insufficient', insights: object[], windowDays: number, coverage: object, missing: string[] }}
 */
export function computeCrossInsights({ transactions, ouraDays, ouraSource, habits, journal, events, now = new Date() } = {}) {
  const series = buildDailySeries({ transactions, ouraDays, ouraSource, habits, journal, events }, { now });

  const insights = CROSS_INSIGHT_PAIRS.map((p) => evaluatePair(p, series))
    .filter(Boolean)
    .sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho))
    .slice(0, MAX_SHOWN);

  const health = Math.max(series.sleepHours.size, series.readiness.size);
  const missing = [];
  if (health === 0) missing.push('health_not_connected');
  if (series.spend.size === 0) missing.push('no_transactions');
  if (series.habitRate.size === 0) missing.push('no_habits');
  if (series.mood.size === 0) missing.push('no_journal_mood');
  if (series.events.size === 0) missing.push('no_calendar');

  return {
    status: insights.length ? 'ok' : 'insufficient',
    insights,
    windowDays: WINDOW_DAYS,
    coverage: {
      spend: series.spend.size,
      health,
      habits: series.habitRate.size,
      mood: series.mood.size,
      calendar: series.events.size,
    },
    missing,
  };
}

/**
 * Reduce a result to the numeric-only payload sent to POST /api/insights/explain.
 * No labels, text, descriptions or raw rows leave the browser.
 * @param {{ windowDays: number, insights: object[] }} result
 * @returns {{ windowDays: number, insights: object[] }}
 */
export function toExplainSummary(result) {
  return {
    windowDays: finite(result?.windowDays, WINDOW_DAYS),
    insights: (result?.insights ?? []).map((i) => ({
      id: i.id,
      n: i.n,
      rho: i.rho,
      nA: i.groupA.days,
      nB: i.groupB.days,
      meanA: i.groupA.mean,
      meanB: i.groupB.mean,
      effectPct: i.effectPct === null ? null : Math.max(-MAX_EFFECT_PCT, Math.min(MAX_EFFECT_PCT, i.effectPct)),
      unit: i.unit,
    })),
  };
}
