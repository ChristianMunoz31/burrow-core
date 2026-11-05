import { isTransfer } from './transactionFilters';

// Recurring-charge detector. Pure: input is the normalized transaction list
// (amount is absolute, type is 'debit' | 'credit'); output is derived only from it.

export const CADENCES = Object.freeze({
  weekly: { days: 7, tol: 2, minCount: 4 },
  monthly: { days: 30.44, tol: 5, minCount: 3 },
  yearly: { days: 365.25, tol: 15, minCount: 2 },
});

const CADENCE_ORDER = ['weekly', 'monthly', 'yearly'];
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LEADING_NOISE = /^(pos|debit|purchase|ach|recurring|checkcard|card)(\s+|$)/;
const LEADING_PROCESSOR = /^(sq|tst|sp|py|pp|paypal)\s*\*\s*/;
const MERCHANT_TOKENS = 3;
const MERCHANT_MAX = 60;
const REFUND_WINDOW_DAYS = 10;
// Amount tolerances, in cents: a floor plus a ratio of the reference amount.
const FLOOR_CENTS = 50;
const CLUSTER_RATIO = 0.25;
// A cluster never spans more than this multiple of its smallest amount.
const CLUSTER_MAX_SPAN = 1.5;
const STEP_FLOOR_CENTS = 200;
const STEP_RATIO = 0.75;
// A price step is confirmed only after this many consecutive charges at the new level.
const STEP_CONFIRM_COUNT = 2;
// Median absolute deviation over median above this means the amount is not a fixed price.
const MAX_SPREAD = 0.12;
// Recurring costs that are bills (rent, utilities, insurance) rather than subscriptions.
const BILL_RE =
  /\b(rent|housing|mortgage|utilit(y|ies)|electric(ity)?|water|gas (bill|company|utility)|phone|wireless|internet|insurance|loan|hoa)\b/i;
// Money the user moves into their own savings or investments recurs like a plan but is never a charge. Skipped
// here only: budget totals keep their own transfer rule (transactionFilters.js).
const SAVINGS_RE = /^\s*(savings|investments?)\s*$/i;
// Merchant names are noisier than categories, so only unambiguous bill words count there.
const BILL_MERCHANT_RE =
  /\b(mortgage|insurance|utility|utilities|electric(ity)?|hoa|gas (company|utility)|rent(?!\s+(the|a)\b))\b|\bpower (company|co|& light)\b|\bmobile (pcs|wireless)\b/i;
// Per-cadence spread limit for subscriptions: a weekly charge is a fixed price.
const WEEKLY_MAX_SPREAD = 0.02;
// Bills in a bill category vary with usage: looser spread, monthly only.
const BILL_MAX_SPREAD = 0.5;
const BILL_MIN_REGULAR = 0.75;
// A cluster that blurs more than this many distinct repeated prices is noise, not a plan mix.
const MAX_SPLIT_PARTS = 6;
// Reference tokens: long mixes of letters and digits such as "2k4ll0qf3".
const REF_TOKEN_MIN_LENGTH = 6;

const round2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : 0);
const cents = (n) => Math.round(n * 100);

const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** Median of an already ascending array, O(1). */
const sortedMedian = (sorted) => {
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
};

const byDay = (a, b) => a.day - b.day || a.amount - b.amount;

/** YYYY-MM-DD to a UTC day number, or null when not a real calendar date. */
function dayNumber(iso) {
  const m = DATE_RE.exec(String(iso ?? ''));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    return null;
  }
  return ms / 86400000;
}

const isoFromDay = (day) => new Date(day * 86400000).toISOString().slice(0, 10);

const daysInMonth = (y, monthIndex) => new Date(Date.UTC(y, monthIndex + 1, 0)).getUTCDate();

/** Adds calendar months, clamping the day to the target month's end. */
function addMonths(iso, months, day) {
  const [y, m, d] = iso.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const nd = Math.min(day ?? d, daysInMonth(ny, nm));
  return isoFromDay(Date.UTC(ny, nm, nd) / 86400000);
}

function isReferenceToken(t) {
  if (t.length < REF_TOKEN_MIN_LENGTH) return false;
  return /[a-z]/.test(t) && (t.match(/\d/g) ?? []).length >= 2;
}

/**
 * Stable merchant key from a raw bank description. Empty string when nothing usable.
 * @param {string} raw
 * @returns {string}
 */
export function normalizeMerchant(raw) {
  let s = String(raw ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .trim();
  let prev;
  do {
    prev = s;
    s = s.replace(LEADING_NOISE, '').replace(LEADING_PROCESSOR, '');
  } while (s !== prev);
  // "AMAZON PRIME*2K4LL0QF3": once a name precedes a '*', a lone token with a digit is a
  // reference. Otherwise ("GOOGLE *YouTube Premium") the text after it is the real name.
  const star = s.indexOf('*');
  if (star > 0 && /[a-z0-9]/.test(s.slice(0, star))) {
    const rest = s.slice(star + 1).trim();
    s = /^\S+$/.test(rest) && /\d/.test(rest) ? s.slice(0, star) : s.replace('*', ' ');
  }
  const tokens = s
    .replace(/#\d+/g, ' ')
    .split(/\s+/)
    .map((t) => {
      // Long digit runs are reference numbers: drop number-only tokens, strip them
      // from tokens that still carry a name (e.g. "hulu12345").
      if (t.replace(/\D/g, '').length < 4) return t;
      const letters = (t.match(/[a-z]/g) ?? []).length;
      return letters < 3 ? '' : t.replace(/\d{4,}/g, ' ');
    })
    .map((t) => t.replace(/[^a-z0-9]+/g, ' ').trim())
    .join(' ')
    .split(/\s+/)
    .filter((t) => t && !isReferenceToken(t));
  return tokens.slice(0, MERCHANT_TOKENS).join(' ');
}

// The day of the month a monthly or yearly plan bills on. Monthly bills drift to short-month ends, so a monthly
// plan anchors on the latest billing day of its last 3 charges (a Jan 31 plan stays on the 31st after Feb 28).
function anchorDayOf(cadence, series) {
  if (cadence === 'weekly') return null;
  if (cadence === 'yearly') return Number(series[series.length - 1].date.slice(8, 10));
  return Math.max(...series.slice(-3).map((c) => Number(c.date.slice(8, 10))));
}

function nextExpected(cadence, series) {
  const lastIso = series[series.length - 1].date;
  if (cadence === 'weekly') return isoFromDay(dayNumber(lastIso) + 7);
  if (cadence === 'yearly') return addMonths(lastIso, 12);
  const anchor = anchorDayOf(cadence, series);
  // Whichever of this month's or next month's anchor day is after the last charge and
  // closest to one month away (a late charge on May 1 still expects May 31).
  const lastDay = dayNumber(lastIso);
  const candidates = [addMonths(lastIso, 0, anchor), addMonths(lastIso, 1, anchor)].filter(
    (iso) => dayNumber(iso) > lastDay,
  );
  const dist = (iso) => Math.abs(dayNumber(iso) - lastDay - CADENCES.monthly.days);
  return candidates.reduce((best, iso) => (dist(iso) < dist(best) ? iso : best));
}

function intervalsOf(series) {
  const intervals = [];
  for (let i = 1; i < series.length; i += 1) intervals.push(series[i].day - series[i - 1].day);
  return intervals;
}

function cadenceOf(series) {
  if (series.length < 2) return null;
  const m = median(intervalsOf(series));
  return CADENCE_ORDER.find((c) => Math.abs(m - CADENCES[c].days) <= CADENCES[c].tol) ?? null;
}

/**
 * Groups charges whose amounts sit close together (gap vs the running cluster median),
 * and never lets a cluster span more than CLUSTER_MAX_SPAN x its smallest amount.
 */
function clusterByAmount(charges) {
  const sorted = [...charges].sort((a, b) => a.amount - b.amount || a.day - b.day);
  const clusters = [];
  let cur = [];
  let amounts = [];
  for (const c of sorted) {
    if (cur.length > 0) {
      const med = cents(sortedMedian(amounts));
      const tooFar = cents(c.amount) - med > Math.max(FLOOR_CENTS, CLUSTER_RATIO * med);
      const tooWide = cents(c.amount) > cents(cur[0].amount) * CLUSTER_MAX_SPAN;
      if (tooFar || tooWide) {
        clusters.push(cur);
        cur = [];
        amounts = [];
      }
    }
    cur.push(c);
    amounts.push(c.amount);
  }
  if (cur.length > 0) clusters.push(cur);
  return clusters;
}

const withinCluster = (a, b) => {
  const [x, y] = [cents(a), cents(b)];
  return Math.abs(x - y) <= Math.max(FLOOR_CENTS, CLUSTER_RATIO * Math.min(x, y));
};

/**
 * Keeps the leading runs of absorbed charges that hold their level for at least
 * STEP_CONFIRM_COUNT consecutive charges. A trailing outlier is left out.
 */
function confirmedRuns(tail) {
  const runs = [];
  for (const c of tail) {
    const run = runs[runs.length - 1];
    if (run && withinCluster(run[run.length - 1].amount, c.amount)) run.push(c);
    else runs.push([c]);
  }
  const confirmed = [];
  for (const run of runs) {
    if (run.length < STEP_CONFIRM_COUNT) break;
    confirmed.push(run);
  }
  return confirmed;
}

/** One charge per day within a series: the larger when two land on the same date. */
function collapseSameDay(charges) {
  const byDate = new Map();
  for (const c of charges) {
    const seen = byDate.get(c.day);
    if (!seen || c.amount > seen.amount) byDate.set(c.day, c);
  }
  return [...byDate.values()].sort(byDay);
}

/** Index of the first charge in a day-sorted list that falls after `day`. */
function firstAfter(sorted, day) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid].day <= day) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Extends a cluster with later charges (from other clusters) that follow the previously
 * accepted charge at a plausible interval and within the step tolerance, so a confirmed
 * price increase stays in one series. Same-day charges collapse here (the larger wins) so
 * the cadence is judged on one charge per day.
 * @param {object[]} base charges of one amount cluster
 * @param {object[]} all every charge of the merchant, sorted by day
 * @returns {{ series: object[], breaks: number[] }} breaks are the series indexes where a
 *   confirmed price level starts
 */
function absorbLater(base, all) {
  const inBase = new Set(base);
  const series = collapseSameDay(base);
  const baseCadence = cadenceOf(series);
  const cadences = baseCadence ? [baseCadence] : CADENCE_ORDER;
  let last = series[series.length - 1];
  const tail = [];
  for (let i = firstAfter(all, last.day); i < all.length; i += 1) {
    const c = all[i];
    if (inBase.has(c)) continue;
    const gap = c.day - last.day;
    if (!cadences.some((k) => Math.abs(gap - CADENCES[k].days) <= CADENCES[k].tol)) continue;
    const p = cents(last.amount);
    if (Math.abs(cents(c.amount) - p) <= Math.max(STEP_FLOOR_CENTS, Math.round(STEP_RATIO * p))) {
      tail.push(c);
      last = c;
    }
  }
  const breaks = [];
  for (const run of confirmedRuns(tail)) {
    breaks.push(series.length);
    series.push(...run);
  }
  return { series, breaks };
}

/** Largest MAD/median across the constant-price segments of a series. */
function spreadOf(series, breaks) {
  const edges = [0, ...breaks, series.length];
  let worst = 0;
  for (let i = 1; i < edges.length; i += 1) {
    const amounts = series.slice(edges[i - 1], edges[i]).map((c) => c.amount);
    const med = median(amounts);
    if (med > 0) worst = Math.max(worst, median(amounts.map((a) => Math.abs(a - med))) / med);
  }
  return worst;
}

function analyzeSeries(key, { series, breaks }, horizon, billCategory = false) {
  const cadence = cadenceOf(series);
  if (!cadence || (billCategory && cadence !== 'monthly')) return null;

  const { days, tol, minCount } = CADENCES[cadence];
  if (series.length < minCount) return null;
  const intervals = intervalsOf(series);
  const regular = intervals.filter((i) => Math.abs(i - days) <= tol).length;
  if (regular / intervals.length < (billCategory ? BILL_MIN_REGULAR : 0.75)) return null;

  const last = series[series.length - 1];
  const isBill =
    BILL_RE.test(String(last.category)) || BILL_MERCHANT_RE.test(String(last.merchant));
  let maxSpread = MAX_SPREAD;
  if (billCategory) maxSpread = BILL_MAX_SPREAD;
  else if (cadence === 'weekly' && !isBill) maxSpread = WEEKLY_MAX_SPREAD;
  if (spreadOf(series, breaks) > maxSpread) return null;
  // A confirmed step compares the new level with the charges just before it; otherwise
  // the latest charge is compared with the three before it.
  const stepAt = breaks.length > 0 ? breaks[breaks.length - 1] : null;
  const before =
    stepAt === null ? series.slice(-4, -1) : series.slice(Math.max(0, stepAt - 3), stepAt);
  const prev = median(before.map((c) => c.amount));
  const lastC = cents(last.amount);
  const prevC = cents(prev);
  const recent = stepAt === null || series.length - stepAt <= 3;
  let priceIncrease = null;
  if (recent && lastC * 100 >= prevC * 103 && lastC - prevC >= 50) {
    priceIncrease = {
      from: round2(prev),
      to: round2(last.amount),
      pct: Math.round(((lastC - prevC) / prevC) * 100),
    };
  }

  const typical = priceIncrease
    ? round2(last.amount)
    : round2(median(series.slice(-3).map((c) => c.amount)));
  let monthlyRaw = typical;
  let yearlyRaw = typical * 12;
  if (cadence === 'weekly') {
    monthlyRaw = (typical * 52) / 12;
    yearlyRaw = typical * 52;
  } else if (cadence === 'yearly') {
    monthlyRaw = typical / 12;
    yearlyRaw = typical;
  }
  const next = nextExpected(cadence, series);
  const active = horizon - last.day <= days * 1.5 + tol;

  return {
    item: {
      id: `${key}|${cadence}|${typical}`,
      merchant: String(last.merchant).slice(0, MERCHANT_MAX),
      merchantKey: key,
      category: last.category,
      kind: isBill ? 'bill' : 'subscription',
      cadence,
      typicalAmount: typical,
      monthlyEquivalent: round2(monthlyRaw),
      yearlyEquivalent: round2(yearlyRaw),
      lastCharge: last.date,
      lastAmount: round2(last.amount),
      nextExpected: next,
      anchorDay: anchorDayOf(cadence, series),
      occurrences: series.length,
      active,
      overdue: active && horizon > dayNumber(next) + tol,
      priceIncrease,
    },
    monthlyRaw,
    yearlyRaw,
    members: new Set(series),
  };
}

/** Drops each debit that a same-amount credit from the same merchant reverses within days. */
function netRefunds(debits, credits) {
  const gone = new Set();
  for (const cr of [...credits].sort(byDay)) {
    let hit = null;
    for (const d of debits) {
      const age = cr.day - d.day;
      if (gone.has(d) || age < 0 || age > REFUND_WINDOW_DAYS) continue;
      if (Math.abs(cents(d.amount) - cents(cr.amount)) > 1) continue;
      if (!hit || d.day > hit.day) hit = d;
    }
    if (hit) gone.add(hit);
  }
  return debits.filter((d) => !gone.has(d));
}

/** Removes true duplicates only: the same day and an amount within $0.01. */
function dropDuplicates(charges) {
  const perDay = new Map();
  for (const c of charges) {
    const kept = perDay.get(c.day) ?? [];
    if (kept.some((o) => Math.abs(cents(o.amount) - cents(c.amount)) <= 1)) continue;
    kept.push(c);
    perDay.set(c.day, kept);
  }
  return [...perDay.values()].flat().sort(byDay);
}

/** Parts of a cluster that repeat at the exact same amount (2+ charges), when 2 to 6 parts exist. */
function repeatedAmountParts(cluster) {
  const byAmount = new Map();
  for (const c of cluster) {
    const list = byAmount.get(cents(c.amount)) ?? [];
    list.push(c);
    byAmount.set(cents(c.amount), list);
  }
  const parts = [...byAmount.values()].filter((p) => p.length >= 2);
  return parts.length >= 2 && parts.length <= MAX_SPLIT_PARTS ? parts : [];
}

function analyzeGroup(key, charges, horizon) {
  const found = [];
  const analyze = (base) => analyzeSeries(key, absorbLater(base, charges), horizon);
  // Usage-based bills (electric, water) vary too much to cluster by amount: one series.
  if (BILL_RE.test(String(charges[charges.length - 1].category))) {
    const billRes = analyzeSeries(
      key,
      { series: collapseSameDay(charges), breaks: [] },
      horizon,
      true,
    );
    if (billRes) return [billRes];
  }
  for (const base of clusterByAmount(charges)) {
    if (base.length < 2) continue;
    const res = analyze(base);
    if (res) {
      found.push(res);
      continue;
    }
    // Two prices billed on alternating dates blur into one cluster: retry per exact price.
    for (const part of repeatedAmountParts(base)) {
      const partRes = analyze(part);
      if (partRes) found.push(partRes);
    }
  }
  const covered = (r) =>
    found.some(
      (o) =>
        o !== r && o.members.size > r.members.size && [...r.members].every((m) => o.members.has(m)),
    );
  const seen = new Set();
  return found.filter((r) => !covered(r) && !seen.has(r.item.id) && seen.add(r.item.id));
}

/**
 * Detects recurring charges (weekly, monthly, yearly) in a transaction list.
 * Credits, refunds and transfers are ignored; a debit reversed by a same-amount credit
 * within 10 days is dropped. "Active" is judged against the newest charge in the data
 * (capped at today) so a stale import does not mark everything cancelled. Each item is a
 * 'subscription' or a 'bill' (rent, utilities, insurance, ...); the totals and
 * activeCount cover subscriptions only, bills are summarised in billsMonthlyTotal and
 * billsActiveCount.
 * @param {Array<{date: string, merchant: string, amount: number, category?: string, type?: string}>} transactions
 * @param {{ now?: Date }} [options]
 * @returns {{ items: object[], monthlyTotal: number, yearlyTotal: number, activeCount: number,
 *   billsMonthlyTotal: number, billsActiveCount: number }}
 */
export function detectSubscriptions(transactions, { now = new Date() } = {}) {
  const empty = {
    items: [],
    monthlyTotal: 0,
    yearlyTotal: 0,
    activeCount: 0,
    billsMonthlyTotal: 0,
    billsActiveCount: 0,
  };
  if (!Array.isArray(transactions) || transactions.length === 0) return empty;

  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86400000;
  const debitsByKey = new Map();
  const creditsByKey = new Map();
  for (const t of transactions) {
    if (!t || (t.type !== 'debit' && t.type !== 'credit') || isTransfer(t) || SAVINGS_RE.test(String(t.category ?? ''))) continue;
    const amount = Number(t.amount);
    const day = dayNumber(t.date);
    if (day === null || !Number.isFinite(amount) || amount <= 0) continue;
    const key = normalizeMerchant(t.merchant);
    if (!key || key === 'unknown') continue;
    const target = t.type === 'debit' ? debitsByKey : creditsByKey;
    const list = target.get(key) ?? [];
    list.push({
      day,
      date: t.date,
      amount,
      merchant: t.merchant,
      category: t.category || 'Other',
    });
    target.set(key, list);
  }

  const groups = new Map();
  let newest = -Infinity;
  for (const [key, debits] of debitsByKey) {
    const charges = dropDuplicates(netRefunds(debits, creditsByKey.get(key) ?? []));
    if (charges.length === 0) continue;
    groups.set(key, charges);
    newest = Math.max(newest, charges[charges.length - 1].day);
  }
  const horizon = Math.min(today, newest);

  const found = [];
  for (const [key, charges] of groups) found.push(...analyzeGroup(key, charges, horizon));
  found.sort(
    (a, b) =>
      Number(b.item.active) - Number(a.item.active) ||
      b.item.monthlyEquivalent - a.item.monthlyEquivalent ||
      a.item.merchantKey.localeCompare(b.item.merchantKey) ||
      a.item.id.localeCompare(b.item.id),
  );

  const active = found.filter((f) => f.item.active);
  const subs = active.filter((f) => f.item.kind === 'subscription');
  const bills = active.filter((f) => f.item.kind === 'bill');
  const sum = (list, field) => round2(list.reduce((total, f) => total + f[field], 0));
  return {
    items: found.map((f) => f.item),
    monthlyTotal: sum(subs, 'monthlyRaw'),
    yearlyTotal: sum(subs, 'yearlyRaw'),
    activeCount: subs.length,
    billsMonthlyTotal: sum(bills, 'monthlyRaw'),
    billsActiveCount: bills.length,
  };
}

/**
 * The charges the active subscriptions (bills excluded) are expected to make from today through
 * `days` days ahead, soonest first, and their total. Pure, computed from detectSubscriptions'
 * output: each item is projected from its nextExpected date by its cadence, so a weekly plan can
 * appear several times. An item whose next charge is later than its cadence tolerance (it may
 * have stopped) is left out, and a projected date before today is skipped.
 * @param {{ items?: object[] }} result output of detectSubscriptions
 * @param {{ now?: Date, days?: number }} [options]
 * @returns {{ charges: Array<{ id: string, merchant: string, amount: number, date: string,
 *   daysAway: number }>, total: number }}
 */
export function upcomingCharges(result, { now = new Date(), days = 30 } = {}) {
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86400000;
  const end = today + days;
  const charges = [];
  for (const item of result?.items ?? []) {
    const spec = CADENCES[item?.cadence];
    const first = dayNumber(item?.nextExpected);
    if (item.kind !== 'subscription' || !item.active || !spec || first === null) continue;
    if (first < today - spec.tol) continue;
    // nextExpected may already be clamped to a short month's end (Feb 28 for a plan billed on the 31st), so later
    // charges are projected from the detector's own anchor day, never from that clamped date.
    const anchor = item.anchorDay ?? Number(item.nextExpected.slice(8, 10));
    const at = (k) => {
      if (item.cadence === 'weekly') return first + 7 * k;
      const months = item.cadence === 'yearly' ? 12 * k : k;
      return dayNumber(addMonths(item.nextExpected, months, anchor));
    };
    for (let k = 0, day = first; day <= end; k += 1, day = at(k)) {
      if (day < today) continue;
      const date = isoFromDay(day);
      charges.push({
        id: `${item.id}|${date}`,
        merchant: item.merchant,
        amount: item.typicalAmount,
        date,
        daysAway: day - today,
      });
    }
  }
  charges.sort((a, b) => a.daysAway - b.daysAway || a.merchant.localeCompare(b.merchant));
  const totalCents = charges.reduce((sum, c) => sum + cents(c.amount), 0);
  return { charges, total: totalCents / 100 };
}
