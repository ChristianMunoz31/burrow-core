import { describe, it, expect } from 'vitest';
import { CADENCES, detectSubscriptions, normalizeMerchant } from '../subscriptions';

// Edge cases layered on top of subscriptions.test.js (which covers the happy paths).

const NOW = new Date(2026, 9, 3, 12, 0); // 2026-10-03 local

const tx = (date, merchant, amount, extra = {}) => ({
  id: `${merchant}-${date}`,
  date,
  merchant,
  amount,
  category: 'Entertainment',
  type: 'debit',
  ...extra,
});

const series = (merchant, dates, amounts, extra) =>
  dates.map((d, i) => tx(d, merchant, Array.isArray(amounts) ? amounts[i] : amounts, extra));

const run = (rows, now = NOW) => detectSubscriptions(rows, { now });

const MONTHLY_DATES = ['2026-07-15', '2026-08-15', '2026-09-15'];

describe('CADENCES', () => {
  it('exposes the documented thresholds', () => {
    expect(CADENCES.weekly).toEqual({ days: 7, tol: 2, minCount: 4 });
    expect(CADENCES.monthly).toEqual({ days: 30.44, tol: 5, minCount: 3 });
    expect(CADENCES.yearly).toEqual({ days: 365.25, tol: 15, minCount: 2 });
  });
});

describe('normalizeMerchant variants', () => {
  it.each([
    ['NETFLIX.COM', 'netflix com'],
    ['  Netflix.com  ', 'netflix com'],
    ['POS DEBIT NETFLIX.COM 866-579-7172', 'netflix com'],
    ['PURCHASE NETFLIX.COM', 'netflix com'],
    ['ACH RECURRING NETFLIX.COM', 'netflix com'],
    ['CHECKCARD NETFLIX.COM #4421', 'netflix com'],
    ['netflix.com #1234', 'netflix com'],
    ['ＮＥＴＦＬＩＸ.COM', 'netflix com'],
  ])('maps %j to %j', (raw, expected) => {
    expect(normalizeMerchant(raw)).toBe(expected);
  });

  it('strips processor prefixes', () => {
    expect(normalizeMerchant('PAYPAL *SPOTIFY')).toBe('spotify');
    expect(normalizeMerchant('TST* JOES DINER')).toBe('joes diner');
    expect(normalizeMerchant('SQ*BLUE BOTTLE')).toBe('blue bottle');
    expect(normalizeMerchant('PP*HULU')).toBe('hulu');
  });

  it('drops number-only tokens and keeps only the first 3 tokens', () => {
    expect(normalizeMerchant('REF 20260915 HULU')).toBe('ref hulu');
    expect(normalizeMerchant('alpha beta gamma delta epsilon')).toBe('alpha beta gamma');
  });

  it('strips long digit runs from tokens that still carry a name', () => {
    expect(normalizeMerchant('HULU12345 PLAN')).toBe('hulu plan');
    expect(normalizeMerchant('NETFLIX 4421')).toBe('netflix');
    expect(normalizeMerchant('AB 12345')).toBe('ab');
    expect(normalizeMerchant('X1234')).toBe('');
  });

  it('normalizes bare noise prefixes to an empty key', () => {
    expect(normalizeMerchant('POS DEBIT')).toBe('');
    expect(normalizeMerchant('PURCHASE')).toBe('');
  });

  it('M5: gives stable keys across charges that carry a reference after a star', () => {
    expect(normalizeMerchant('AMAZON PRIME*2K4LL0QF3')).toBe('amazon prime');
    expect(normalizeMerchant('AMAZON PRIME*9Z8Y7X6W5')).toBe('amazon prime');
    expect(normalizeMerchant('Prime Video*AB12CD34')).toBe('prime video');
    expect(normalizeMerchant('Prime Video*ZZ99YY88')).toBe('prime video');
    // leading processors keep the merchant that follows them
    expect(normalizeMerchant('PAYPAL *NETFLIX')).toBe('netflix');
  });

  it('M5: drops long letter+digit reference tokens but keeps short alphanumerics', () => {
    expect(normalizeMerchant('ACME 2k4ll0qf3')).toBe('acme');
    expect(normalizeMerchant('WEB3 LABS')).toBe('web3 labs');
    expect(normalizeMerchant('MP3TUNES')).toBe('mp3tunes');
  });

  it('coerces non-string input safely', () => {
    expect(normalizeMerchant(undefined)).toBe('');
    expect(normalizeMerchant(12)).toBe('12');
    expect(normalizeMerchant({})).toBe('object object');
  });
});

describe('merchant grouping', () => {
  it('groups charges whose raw descriptions normalize to the same key', () => {
    const rows = [
      tx('2026-07-15', 'NETFLIX.COM', 15.49),
      tx('2026-08-15', 'POS DEBIT NETFLIX.COM 866-579-7172', 15.49),
      tx('2026-09-15', 'netflix.com #1234', 15.49),
    ];
    const { items } = run(rows);
    expect(items).toHaveLength(1);
    expect(items[0].merchantKey).toBe('netflix com');
    expect(items[0].occurrences).toBe(3);
    // merchant is the most recent raw description
    expect(items[0].merchant).toBe('netflix.com #1234');
  });

  it('keeps different merchants separate', () => {
    const rows = [
      ...series('NETFLIX.COM', MONTHLY_DATES, 15.49),
      ...series('SPOTIFY USA', MONTHLY_DATES, 10.99),
    ];
    const { items } = run(rows);
    expect(items.map((i) => i.merchantKey).sort()).toEqual(['netflix com', 'spotify usa']);
  });

  it('skips rows whose merchant normalizes to nothing', () => {
    const rows = series('*** ###', MONTHLY_DATES, 9);
    expect(run(rows).items).toEqual([]);
    expect(run(series('POS DEBIT', MONTHLY_DATES, 9)).items).toEqual([]);
  });

  it('skips the "unknown" placeholder merchant', () => {
    expect(run(series('Unknown', MONTHLY_DATES, 9)).items).toEqual([]);
  });

  it('clips the merchant to 60 characters', () => {
    const long = `NETFLIX ${'X'.repeat(80)}`;
    const { items } = run(series(long, MONTHLY_DATES, 15.49));
    expect(items).toHaveLength(1);
    expect(items[0].merchant).toHaveLength(60);
  });

  it('falls back to category "Other" and reports the last charge category', () => {
    const rows = series('GYM', MONTHLY_DATES, 30).map((t) => ({
      ...t,
      category: undefined,
    }));
    expect(run(rows).items[0].category).toBe('Other');
    const changed = series('GYM', MONTHLY_DATES, 30);
    changed[2].category = 'Health';
    expect(run(changed).items[0].category).toBe('Health');
  });
});

describe('monthly cadence tolerance (30.44 +/- 5 days)', () => {
  it.each([
    ['35-day gaps accepted', ['2026-06-01', '2026-07-06', '2026-08-10'], true],
    ['36-day gaps rejected', ['2026-06-01', '2026-07-07', '2026-08-12'], false],
    ['26-day gaps accepted', ['2026-06-01', '2026-06-27', '2026-07-23'], true],
    ['25-day gaps rejected', ['2026-06-01', '2026-06-26', '2026-07-21'], false],
  ])('%s', (_name, dates, accepted) => {
    const { items } = run(series('GYM', dates, 30));
    if (accepted) {
      expect(items).toHaveLength(1);
      expect(items[0].cadence).toBe('monthly');
    } else {
      expect(items).toEqual([]);
    }
  });

  it('rejects a series with a skipped month when fewer than 75% of gaps are regular', () => {
    // gaps: 30, 61, 30 -> 2 of 3 regular (67%)
    const dates = ['2026-03-15', '2026-04-14', '2026-06-14', '2026-07-14'];
    expect(run(series('GYM', dates, 30)).items).toEqual([]);
  });

  it('accepts a series with one skipped month when 75% of gaps are regular', () => {
    // gaps: 30, 61, 30, 30 -> 3 of 4 regular
    const dates = ['2026-03-15', '2026-04-14', '2026-06-14', '2026-07-14', '2026-08-13'];
    const { items } = run(series('GYM', dates, 30));
    expect(items).toHaveLength(1);
    expect(items[0].occurrences).toBe(5);
  });

  it('rejects wholly irregular charges', () => {
    const dates = ['2026-01-03', '2026-02-20', '2026-03-02', '2026-06-30'];
    expect(run(series('RANDOM SHOP', dates, 25)).items).toEqual([]);
  });
});

describe('weekly cadence (7 +/- 2 days, 4+ charges)', () => {
  it('accepts 9-day gaps and rejects 10-day gaps', () => {
    const nine = ['2026-09-01', '2026-09-10', '2026-09-19', '2026-09-28'];
    expect(run(series('MEAL KIT', nine, 40)).items[0]?.cadence).toBe('weekly');
    const ten = ['2026-09-01', '2026-09-11', '2026-09-21', '2026-10-01'];
    expect(run(series('MEAL KIT', ten, 40)).items).toEqual([]);
  });

  it('needs four charges, not three', () => {
    const three = ['2026-09-12', '2026-09-19', '2026-09-26'];
    expect(run(series('CAR WASH CLUB', three, 12)).items).toEqual([]);
  });

  it('computes the monthly equivalent as weekly*52/12 rounded to 2dp', () => {
    const dates = ['2026-09-05', '2026-09-12', '2026-09-19', '2026-09-26'];
    const [item] = run(series('CAR WASH CLUB', dates, 10)).items;
    expect(item.monthlyEquivalent).toBe(43.33);
    expect(item.yearlyEquivalent).toBe(520);
  });
});

describe('yearly cadence tolerance (365.25 +/- 15 days)', () => {
  it.each([
    ['380-day gap accepted', '2026-09-25', true],
    ['381-day gap rejected', '2026-09-26', false],
    ['351-day gap accepted', '2026-08-27', true],
    ['350-day gap rejected', '2026-08-26', false],
  ])('%s', (_name, second, accepted) => {
    const { items } = run([tx('2025-09-10', 'DOMAIN CO', 99), tx(second, 'DOMAIN CO', 99)]);
    if (accepted) {
      expect(items).toHaveLength(1);
      expect(items[0].cadence).toBe('yearly');
      expect(items[0].occurrences).toBe(2);
    } else {
      expect(items).toEqual([]);
    }
  });

  it('computes the monthly equivalent as yearly/12', () => {
    const [item] = run([
      tx('2025-09-10', 'DOMAIN CO', 100),
      tx('2026-09-10', 'DOMAIN CO', 100),
    ]).items;
    expect(item.monthlyEquivalent).toBe(8.33);
    expect(item.yearlyEquivalent).toBe(100);
  });
});

describe('amount clustering and step tolerance', () => {
  const four = ['2026-06-15', '2026-07-15', '2026-08-15', '2026-09-15'];

  const five = ['2026-05-15', ...four];

  it('keeps a small variation inside one series (floor of $0.50 on the cluster gap)', () => {
    expect(run(series('CLOUD', four, [4, 4, 4, 5])).items[0].occurrences).toBe(4);
    // $2 above a $4 base is outside the cluster tolerance, and a lone charge is not a step
    expect(run(series('CLOUD', four, [4, 4, 4, 6])).items[0].occurrences).toBe(3);
  });

  it('absorbs a confirmed step within 75% (min $2.00) of the previous charge', () => {
    expect(run(series('CLOUD', five, [4, 4, 4, 7, 7])).items[0].occurrences).toBe(5);
    expect(run(series('CLOUD', five, [4, 4, 4, 7.01, 7.01])).items[0].occurrences).toBe(3);
    expect(run(series('RENT SPLIT', five, [100, 100, 100, 175, 175])).items[0].occurrences).toBe(5);
    expect(run(series('RENT SPLIT', five, [100, 100, 100, 176, 176])).items[0].occurrences).toBe(3);
  });

  it('does not absorb a single trailing one-off and shows no badge for it', () => {
    const { items } = run(series('NETFLIX.COM', four, [15.49, 15.49, 15.49, 24.99]));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      occurrences: 3,
      typicalAmount: 15.49,
      priceIncrease: null,
    });
  });

  it('M1: keeps two different charges billed the same day under one merchant', () => {
    const rows = [
      ...series('APPLE.COM/BILL', MONTHLY_DATES, 2.99),
      ...series('APPLE.COM/BILL', MONTHLY_DATES, 10.99),
    ];
    const { items } = run(rows);
    expect(items.map((i) => i.typicalAmount).sort((a, b) => a - b)).toEqual([2.99, 10.99]);
  });

  it('M1: still removes true duplicates (same day, amount within a cent)', () => {
    const rows = [...series('GYM', MONTHLY_DATES, 30), tx('2026-09-15', 'GYM', 30.01)];
    expect(run(rows).items[0].occurrences).toBe(3);
  });

  it('M2: detects $0.99 and $2.99 billed on the 5th and 20th', () => {
    const rows = [
      ...series('APP STORE', ['2026-07-05', '2026-08-05', '2026-09-05'], 0.99),
      ...series('APP STORE', ['2026-07-20', '2026-08-20', '2026-09-20'], 2.99),
    ];
    expect(
      run(rows)
        .items.map((i) => i.typicalAmount)
        .sort((a, b) => a - b),
    ).toEqual([0.99, 2.99]);
  });

  it('M2: detects $9.99 and $10.99 billed on alternating dates by exact amount', () => {
    const rows = [
      ...series('STREAM PLUS', ['2026-07-05', '2026-08-05', '2026-09-05'], 9.99),
      ...series('STREAM PLUS', ['2026-07-20', '2026-08-20', '2026-09-20'], 10.99),
    ];
    const { items } = run(rows);
    expect(items.map((i) => i.typicalAmount).sort((a, b) => a - b)).toEqual([9.99, 10.99]);
    expect(items.every((i) => i.cadence === 'monthly' && i.occurrences === 3)).toBe(true);
  });

  it('M4: weekly gas that swings between $38 and $70 is not a subscription', () => {
    const weeks = Array.from({ length: 8 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 7, 8 + i * 7));
      return d.toISOString().slice(0, 10);
    });
    expect(run(series('SHELL GAS', weeks, [38, 70, 45, 62, 41, 68, 52, 59])).items).toEqual([]);
    // inside one cluster, but still too spread out to be a fixed price
    expect(run(series('SHELL GAS', weeks, [38, 50, 40, 54, 36, 48, 52, 44])).items).toEqual([]);
  });

  it('M4: a steady price with a confirmed step is not rejected for spread', () => {
    const rows = series('STREAMING CO', five, [4.99, 4.99, 4.99, 7.99, 7.99]);
    expect(run(rows).items).toHaveLength(1);
  });

  it('rejects a merchant whose amounts never cluster', () => {
    expect(run(series('GROCERY', four, [5, 50, 500, 5000])).items).toEqual([]);
  });

  it('emits one item per qualifying amount cluster with distinct ids', () => {
    const rows = [
      ...series('APPLE.COM BILL', MONTHLY_DATES, 2.99),
      ...series('APPLE.COM BILL', ['2026-07-03', '2026-08-03', '2026-09-03'], 10.99),
    ];
    const { items } = run(rows);
    expect(items.map((i) => i.typicalAmount).sort((x, y) => x - y)).toEqual([2.99, 10.99]);
    expect(new Set(items.map((i) => i.id)).size).toBe(2);
    expect(items.every((i) => i.active)).toBe(true);
  });

  it('finds a subscription among random one-off orders at the same merchant', () => {
    const prime = series('AMAZON', ['2026-06-12', '2026-07-12', '2026-08-12', '2026-09-12'], 14.99);
    const oneOffs = [
      tx('2026-06-03', 'AMAZON', 49.5),
      tx('2026-06-27', 'AMAZON', 8.2),
      tx('2026-07-21', 'AMAZON', 112.4),
      tx('2026-08-30', 'AMAZON', 63.1),
      tx('2026-09-02', 'AMAZON', 3.4),
    ];
    const { items } = run([...oneOffs, ...prime]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      typicalAmount: 14.99,
      occurrences: 4,
      active: true,
    });
  });

  it('keeps a 60% step-up in one active series and flags it', () => {
    const rows = series(
      'STREAMING CO',
      ['2026-05-15', '2026-06-15', '2026-07-15', '2026-08-15', '2026-09-15'],
      [4.99, 4.99, 4.99, 7.99, 7.99],
    );
    const { items, monthlyTotal } = run(rows);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      occurrences: 5,
      active: true,
      typicalAmount: 7.99,
      priceIncrease: { from: 4.99, to: 7.99, pct: 60 },
    });
    expect(monthlyTotal).toBe(7.99);
  });

  it('does not absorb a later charge at an off-cadence interval', () => {
    const rows = [...series('AMAZON', MONTHLY_DATES, 14.99), tx('2026-09-20', 'AMAZON', 20)];
    expect(run(rows).items[0].occurrences).toBe(3);
  });
});

describe('price change detection', () => {
  it('does not flag a decrease', () => {
    const [item] = run(series('NETFLIX.COM', MONTHLY_DATES, [15.49, 15.49, 12.99])).items;
    expect(item.priceIncrease).toBeNull();
    expect(item.lastAmount).toBe(12.99);
  });

  it('flags a 4% increase but not a 2.9% increase (3% threshold)', () => {
    expect(run(series('X', MONTHLY_DATES, [100, 100, 104])).items[0].priceIncrease).toEqual({
      from: 100,
      to: 104,
      pct: 4,
    });
    expect(run(series('X', MONTHLY_DATES, [100, 100, 102.9])).items[0].priceIncrease).toBeNull();
  });

  it('requires at least $0.50 absolute change even when over 3%', () => {
    expect(run(series('X', MONTHLY_DATES, [10, 10, 10.49])).items[0].priceIncrease).toBeNull();
    expect(run(series('X', MONTHLY_DATES, [10, 10, 10.5])).items[0].priceIncrease).toEqual({
      from: 10,
      to: 10.5,
      pct: 5,
    });
  });

  it('compares the last charge against the median of the earlier charges', () => {
    const dates = ['2026-06-15', '2026-07-15', '2026-08-15', '2026-09-15'];
    const [item] = run(series('X', dates, [10, 10, 10, 12])).items;
    expect(item.priceIncrease).toEqual({ from: 10, to: 12, pct: 20 });
    expect(item.typicalAmount).toBe(12);
  });

  it('compares against the median of up to 3 charges before the last', () => {
    const dates = ['2026-05-15', '2026-06-15', '2026-07-15', '2026-08-15', '2026-09-15'];
    const [item] = run(series('X', dates, [8, 10, 10, 10, 12])).items;
    expect(item.priceIncrease).toEqual({ from: 10, to: 12, pct: 20 });
  });

  it('compares thresholds in whole cents without float noise', () => {
    // +3% but only $0.30: below the $0.50 floor
    expect(run(series('X', MONTHLY_DATES, [10, 10, 10.3])).items[0].priceIncrease).toBeNull();
    // exactly 3% and $3
    expect(run(series('X', MONTHLY_DATES, [100, 100, 103])).items[0].priceIncrease).toEqual({
      from: 100,
      to: 103,
      pct: 3,
    });
    expect(
      run(series('X', MONTHLY_DATES, [29.99, 29.99, 30.88])).items[0].priceIncrease,
    ).toBeNull();
    expect(run(series('X', MONTHLY_DATES, [29.99, 29.99, 30.89])).items[0].priceIncrease).toEqual({
      from: 29.99,
      to: 30.89,
      pct: 3,
    });
  });

  it('does not flag a stable price', () => {
    expect(run(series('X', MONTHLY_DATES, 15.49)).items[0].priceIncrease).toBeNull();
  });
});

describe('predicted next charge', () => {
  it('rolls a December charge into January of the next year', () => {
    const dates = ['2025-10-15', '2025-11-15', '2025-12-15'];
    expect(run(series('GYM', dates, 30), new Date(2026, 0, 2)).items[0].nextExpected).toBe(
      '2026-01-15',
    );
  });

  it('clamps Jan 31 to Feb 29 in a leap year', () => {
    const dates = ['2027-11-30', '2027-12-31', '2028-01-31'];
    expect(run(series('CLOUD BOX', dates, 5), new Date(2028, 1, 5)).items[0].nextExpected).toBe(
      '2028-02-29',
    );
  });

  it('maps a yearly Feb 29 charge to Feb 28 the next year', () => {
    const rows = [tx('2023-02-28', 'ANNUAL CO', 50), tx('2024-02-29', 'ANNUAL CO', 50)];
    const [item] = run(rows, new Date(2024, 5, 1)).items;
    expect(item.cadence).toBe('yearly');
    expect(item.nextExpected).toBe('2025-02-28');
  });

  it('adds 7 days across a month boundary for weekly charges', () => {
    const dates = ['2026-08-11', '2026-08-18', '2026-08-25', '2026-09-01'];
    expect(run(series('MEAL KIT', dates, 40), new Date(2026, 8, 3)).items[0].nextExpected).toBe(
      '2026-09-08',
    );
  });
});

describe('active vs possibly cancelled', () => {
  // A same-day unrelated charge pins the data horizon to today.
  const TODAY_ANCHOR = tx('2026-10-03', 'COFFEE', 4);
  const itemOf = (rows, key) =>
    run([...rows, TODAY_ANCHOR]).items.find((i) => i.merchantKey === key);

  it('monthly: 50 days since the last charge is active, 51 is not', () => {
    const active = series('GYM', ['2026-06-14', '2026-07-14', '2026-08-14'], 30);
    const stale = series('GYM', ['2026-06-13', '2026-07-13', '2026-08-13'], 30);
    expect(itemOf(active, 'gym').active).toBe(true);
    expect(itemOf(stale, 'gym').active).toBe(false);
  });

  it('weekly: 12 days since the last charge is active, 13 is not', () => {
    const active = series('MEAL KIT', ['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21'], 40);
    const stale = series('MEAL KIT', ['2026-08-30', '2026-09-06', '2026-09-13', '2026-09-20'], 40);
    expect(itemOf(active, 'meal kit').active).toBe(true);
    expect(itemOf(stale, 'meal kit').active).toBe(false);
  });

  it('measures activity against the newest data when the import is stale', () => {
    // newest charge is 70 days before "now": still active relative to the data
    const result = run(series('GYM', ['2026-05-26', '2026-06-26', '2026-07-26'], 30));
    expect(result.items[0].active).toBe(true);
    expect(result.activeCount).toBe(1);
    expect(result.monthlyTotal).toBe(30);
  });

  it('still marks a series inactive when other merchants have newer data', () => {
    const rows = [
      ...series('GYM', ['2026-05-26', '2026-06-26', '2026-07-26'], 30),
      ...series('NETFLIX.COM', MONTHLY_DATES, 15.49),
    ];
    const byKey = Object.fromEntries(run(rows).items.map((i) => [i.merchantKey, i.active]));
    expect(byKey).toEqual({ gym: false, 'netflix com': true });
  });

  it('never looks past today when the data contains future dates', () => {
    const rows = [...series('GYM', MONTHLY_DATES, 30), tx('2027-06-01', 'COFFEE', 4)];
    expect(run(rows).items[0].active).toBe(true);
  });

  it('keeps inactive items in the list but out of every total', () => {
    const result = run([
      ...series('OLD APP', ['2025-10-15', '2025-11-15', '2025-12-15'], 20),
      TODAY_ANCHOR,
    ]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].active).toBe(false);
    expect(result).toMatchObject({
      monthlyTotal: 0,
      yearlyTotal: 0,
      activeCount: 0,
    });
  });

  it('sorts active first, then by monthly equivalent desc, then by merchant key', () => {
    const rows = [
      ...series('CHEAP', MONTHLY_DATES, 5),
      ...series('PRICEY', MONTHLY_DATES, 50),
      ...series('ALPHA', MONTHLY_DATES, 5),
      ...series('DEAD', ['2025-10-15', '2025-11-15', '2025-12-15'], 500),
    ];
    expect(run(rows).items.map((i) => i.merchantKey)).toEqual(['pricey', 'alpha', 'cheap', 'dead']);
  });

  it('sums monthly equivalents across cadences', () => {
    const rows = [
      ...series('GYM', MONTHLY_DATES, 30),
      ...series('MEAL KIT', ['2026-09-05', '2026-09-12', '2026-09-19', '2026-09-26'], 12),
      tx('2025-09-10', 'DOMAIN CO', 120),
      tx('2026-09-10', 'DOMAIN CO', 120),
    ];
    const result = run(rows);
    expect(result.activeCount).toBe(3);
    expect(result.monthlyTotal).toBe(92); // 30 + 52 + 10
    expect(result.yearlyTotal).toBe(1104);
  });
});

describe('refunds, negative amounts and mixed signs', () => {
  it('ignores non-positive debit amounts entirely', () => {
    const rows = series('NETFLIX.COM', MONTHLY_DATES, -15.49);
    expect(run(rows)).toEqual({
      items: [],
      monthlyTotal: 0,
      yearlyTotal: 0,
      activeCount: 0,
      billsMonthlyTotal: 0,
      billsActiveCount: 0,
    });
    expect(run(series('NETFLIX.COM', MONTHLY_DATES, 0)).items).toEqual([]);
  });

  it('counts only positive debits when the same merchant has credits and negative rows', () => {
    const rows = [
      ...series('NETFLIX.COM', MONTHLY_DATES, 15.49),
      tx('2026-08-30', 'NETFLIX.COM', 15.49, { type: 'credit' }),
      tx('2026-09-01', 'NETFLIX.COM', -15.49),
      tx('2026-09-02', 'NETFLIX.COM', 15.49, { type: undefined }),
    ];
    const { items } = run(rows);
    expect(items).toHaveLength(1);
    expect(items[0].occurrences).toBe(3);
    expect(items[0].lastCharge).toBe('2026-09-15');
  });

  it('does not create a subscription from credits alone', () => {
    const rows = series('PAYROLL', MONTHLY_DATES, 2000, {
      type: 'credit',
      category: 'Income',
    });
    expect(run(rows).items).toEqual([]);
  });

  it('ignores Credit Card Payment transfers', () => {
    const rows = series('CHASE EPAY', MONTHLY_DATES, 300, {
      category: 'Credit Card Payment',
    });
    expect(run(rows).items).toEqual([]);
  });
});

describe('same-day duplicates, refund netting, rounding, anchors', () => {
  it('collapses same-day duplicate charges, keeping the larger', () => {
    const rows = [
      ...series('GYM', MONTHLY_DATES, 30),
      tx('2026-08-15', 'GYM', 5),
      tx('2026-09-15', 'GYM', 30),
    ];
    const [item] = run(rows).items;
    expect(item.occurrences).toBe(3);
    expect(item.typicalAmount).toBe(30);
  });

  it('keeps the larger amount of a same-day pair', () => {
    const rows = [
      tx('2026-07-15', 'GYM', 30),
      tx('2026-08-15', 'GYM', 30),
      tx('2026-09-15', 'GYM', 25),
      tx('2026-09-15', 'GYM', 30),
    ];
    expect(run(rows).items[0].lastAmount).toBe(30);
  });

  it('nets a debit reversed by a same-amount credit within 10 days', () => {
    const rows = [
      ...series('NETFLIX.COM', MONTHLY_DATES, 15.49),
      tx('2026-09-16', 'NETFLIX.COM', 15.49, { type: 'credit' }),
    ];
    expect(run(rows).items).toEqual([]); // 2 charges left
  });

  it('does not net a credit after the window, of another amount, or from another merchant', () => {
    const late = tx('2026-09-26', 'NETFLIX.COM', 15.49, { type: 'credit' });
    const other = tx('2026-09-16', 'NETFLIX.COM', 9, { type: 'credit' });
    const elsewhere = tx('2026-09-16', 'HULU', 15.49, { type: 'credit' });
    for (const credit of [late, other, elsewhere]) {
      const { items } = run([...series('NETFLIX.COM', MONTHLY_DATES, 15.49), credit]);
      expect(items[0].occurrences).toBe(3);
    }
  });

  it('lets one credit reverse only one debit', () => {
    const rows = [
      ...series('NETFLIX.COM', MONTHLY_DATES, 15.49),
      tx('2026-09-16', 'NETFLIX.COM', 15.49, { type: 'credit' }),
      tx('2026-10-01', 'NETFLIX.COM', 15.49),
      tx('2026-10-02', 'NETFLIX.COM', 15.49, { type: 'credit' }),
    ];
    expect(run(rows).items).toEqual([]);
  });

  it('rounds once: a $99.99 yearly charge has a $99.99 yearly equivalent', () => {
    const rows = [tx('2025-09-10', 'DOMAIN CO', 99.99), tx('2026-09-10', 'DOMAIN CO', 99.99)];
    const [item] = run(rows).items;
    expect(item.yearlyEquivalent).toBe(99.99);
    expect(item.monthlyEquivalent).toBe(8.33);
  });

  it('computes totals from unrounded sums', () => {
    const rows = [
      tx('2025-09-10', 'DOMAIN A', 100),
      tx('2026-09-10', 'DOMAIN A', 100),
      tx('2025-09-12', 'DOMAIN B', 100),
      tx('2026-09-12', 'DOMAIN B', 100),
    ];
    const result = run(rows);
    // 2 x 8.3333 = 16.67 (not 2 x 8.33 = 16.66); yearly is exactly 200
    expect(result.monthlyTotal).toBe(16.67);
    expect(result.yearlyTotal).toBe(200);
  });

  it('anchors the next monthly date on the latest billing day of the last 3 charges', () => {
    const rows = [
      tx('2026-07-31', 'CLOUD BOX', 5),
      tx('2026-08-31', 'CLOUD BOX', 5),
      tx('2026-09-30', 'CLOUD BOX', 5),
    ];
    expect(run(rows).items[0].nextExpected).toBe('2026-10-31');
  });

  it('clamps the anchored day in short months', () => {
    const rows = [
      tx('2026-11-30', 'CLOUD BOX', 5),
      tx('2026-12-31', 'CLOUD BOX', 5),
      tx('2027-01-30', 'CLOUD BOX', 5),
    ];
    expect(run(rows, new Date(2027, 1, 5)).items[0].nextExpected).toBe('2027-02-28');
  });

  it('includes the typical amount in the item id', () => {
    expect(run(series('GYM', MONTHLY_DATES, 30)).items[0].id).toBe('gym|monthly|30');
  });
});

describe('robustness: odd input never yields NaN', () => {
  const EMPTY = {
    items: [],
    monthlyTotal: 0,
    yearlyTotal: 0,
    activeCount: 0,
    billsMonthlyTotal: 0,
    billsActiveCount: 0,
  };

  it.each([[null], [undefined], ['nope'], [42], [{}]])(
    'returns empty for non-array %j',
    (input) => {
      expect(run(input)).toEqual(EMPTY);
    },
  );

  it('skips null rows, bad dates and bad amounts', () => {
    const bad = [
      null,
      undefined,
      tx('', 'GYM', 30),
      tx('2026-13-01', 'GYM', 30),
      tx('2026-02-30', 'GYM', 30),
      tx('09/15/2026', 'GYM', 30),
      tx(null, 'GYM', 30),
      tx('2026-09-15', 'GYM', null),
      tx('2026-09-15', 'GYM', undefined),
      tx('2026-09-15', 'GYM', NaN),
      tx('2026-09-15', 'GYM', Infinity),
      tx('2026-09-15', 'GYM', 'abc'),
      tx('2026-09-15', null, 30),
    ];
    expect(run(bad)).toEqual(EMPTY);
  });

  it('still detects the valid rows mixed in with junk', () => {
    const rows = [
      null,
      tx('2026-13-01', 'GYM', 30),
      tx('2026-09-15', 'GYM', null),
      ...series('GYM', MONTHLY_DATES, 30),
    ];
    const result = run(rows);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].occurrences).toBe(3);
  });

  it('accepts numeric strings for amount', () => {
    const rows = series('GYM', MONTHLY_DATES, '30.00');
    expect(run(rows).items[0].typicalAmount).toBe(30);
  });

  it('produces only finite numbers in every field', () => {
    const rows = [
      ...series('NETFLIX.COM', MONTHLY_DATES, [15.49, 15.49, 17.49]),
      ...series('MEAL KIT', ['2026-09-05', '2026-09-12', '2026-09-19', '2026-09-26'], 33.33),
      tx('2025-09-10', 'DOMAIN CO', 99.99),
      tx('2026-09-10', 'DOMAIN CO', 99.99),
    ];
    const result = run(rows);
    expect(Number.isFinite(result.monthlyTotal)).toBe(true);
    expect(Number.isFinite(result.yearlyTotal)).toBe(true);
    for (const item of result.items) {
      for (const k of ['typicalAmount', 'monthlyEquivalent', 'yearlyEquivalent', 'lastAmount']) {
        expect(Number.isFinite(item[k])).toBe(true);
      }
      expect(item.nextExpected).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(JSON.stringify(result)).not.toMatch(/NaN|Infinity/);
  });

  it('is deterministic, order independent and does not mutate its input', () => {
    const rows = [
      ...series('NETFLIX.COM', MONTHLY_DATES, 15.49),
      ...series('GYM', MONTHLY_DATES, 30),
    ];
    const frozen = rows.map((r) => Object.freeze({ ...r }));
    const a = run(frozen);
    const b = run([...frozen].reverse());
    expect(b).toEqual(a);
    expect(run(frozen)).toEqual(a);
  });

  it('works without an options argument', () => {
    const result = detectSubscriptions(series('GYM', MONTHLY_DATES, 30));
    expect(result.items).toHaveLength(1);
    expect(Number.isFinite(result.monthlyTotal)).toBe(true);
  });
});

describe('bills vs subscriptions', () => {
  const rows = [
    ...series('NETFLIX.COM', MONTHLY_DATES, 15.49),
    ...series('LANDLORD LLC', MONTHLY_DATES, 1725, { category: 'Rent' }),
    ...series('CITY POWER CO', MONTHLY_DATES, 90, { category: 'Utilities' }),
    ...series('STATE FARM', MONTHLY_DATES, 120, { category: 'Other' }),
  ];

  it('classifies each item as a subscription or a bill by category or merchant', () => {
    const kinds = Object.fromEntries(run(rows).items.map((i) => [i.merchantKey, i.kind]));
    expect(kinds).toEqual({
      'netflix com': 'subscription',
      'landlord llc': 'bill',
      'city power co': 'bill',
      'state farm': 'subscription',
    });
    const insurance = series('GEICO INSURANCE', MONTHLY_DATES, 80);
    expect(run(insurance).items[0].kind).toBe('bill');
  });

  it('keeps subscription totals free of bills and reports bills separately', () => {
    const result = run(rows);
    expect(result.monthlyTotal).toBe(135.49);
    expect(result.yearlyTotal).toBe(1625.88);
    expect(result.activeCount).toBe(2);
    expect(result.billsMonthlyTotal).toBe(1815);
    expect(result.billsActiveCount).toBe(2);
  });

  it('does not count a cancelled bill in the bills totals', () => {
    const stale = series('LANDLORD LLC', ['2025-10-15', '2025-11-15', '2025-12-15'], 1725, {
      category: 'Rent',
    });
    const result = run([...stale, tx('2026-10-01', 'COFFEE', 4)]);
    expect(result.items[0]).toMatchObject({ kind: 'bill', active: false });
    expect(result).toMatchObject({ billsMonthlyTotal: 0, billsActiveCount: 0 });
  });
});

describe('performance', () => {
  it('handles 10k rows from a single merchant quickly', () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const rows = Array.from({ length: 10000 }, (_, i) => {
      const d = new Date(Date.UTC(2000, 0, 1 + i));
      return tx(d.toISOString().slice(0, 10), 'BIG BOX STORE', Math.round(rand() * 20000) / 100);
    });
    const started = performance.now();
    const result = run(rows);
    // Generous wall-clock budget: the suite runs in parallel workers, so CPU contention
    // can stretch a linear pass well past 200ms. 1s still fails an O(n^2) regression
    // on 10k rows.
    expect(performance.now() - started).toBeLessThan(1000);
    expect(Number.isFinite(result.monthlyTotal)).toBe(true);
  });
});

describe('round 3 regressions', () => {
  const MONTHS = ['2026-07-15', '2026-08-15', '2026-09-15'];
  const kindOf = (rows) => run(rows).items.map((i) => i.kind);

  it('M1: matches bill words as whole words, and only unambiguous ones in merchants', () => {
    expect(kindOf(series('Rent the Runway', MONTHS, 89))).toEqual(['subscription']);
    expect(kindOf(series('PowerSchool', MONTHS, 12))).toEqual(['subscription']);
    expect(kindOf(series('City Power & Light', MONTHS, 90, { category: 'Other' }))).toEqual([
      'bill',
    ]);
    expect(kindOf(series('Oakview Apts Rent', MONTHS, 1500, { category: 'Other' }))).toEqual([
      'bill',
    ]);
    expect(kindOf(series('Acme Co', MONTHS, 60, { category: 'Utilities' }))).toEqual(['bill']);
    expect(kindOf(series('Acme Co', MONTHS, 60, { category: 'Waterfront Dining' }))).toEqual([
      'subscription',
    ]);
  });

  it('M2: keeps the name after a star unless it is a lone reference token', () => {
    expect(normalizeMerchant('GOOGLE *YouTube Premium')).toBe('google youtube premium');
    expect(normalizeMerchant('AMAZON PRIME*2K4LL0QF3')).toBe('amazon prime');
    expect(normalizeMerchant('Prime Video*AB12CD34')).toBe('prime video');
    const result = run([
      ...series('GOOGLE *YouTube Premium', MONTHS, 13.99),
      ...series('GOOGLE *Domains', ['2024-09-15', '2025-09-15', '2026-09-15'], 12),
    ]);
    expect(result.items).toHaveLength(2);
    expect(result.items.map((i) => i.cadence).sort()).toEqual(['monthly', 'yearly']);
  });

  it('M3: splits two yearly prices renewing 30 days apart', () => {
    const rows = [
      ...series('NAMECHEAP', ['2024-09-01', '2025-09-01'], 10.98),
      ...series('NAMECHEAP', ['2024-10-01', '2025-10-01'], 12.98),
    ];
    const items = run(rows).items;
    expect(items.map((i) => i.typicalAmount).sort()).toEqual([10.98, 12.98]);
  });

  it('M4: detects an electric bill that varies a lot month to month', () => {
    const dates = [
      '2026-04-10',
      '2026-05-10',
      '2026-06-10',
      '2026-07-10',
      '2026-08-10',
      '2026-09-10',
    ];
    const rows = series('CITY ELECTRIC', dates, [95, 160, 120, 140, 110, 150], {
      category: 'Utilities',
    });
    const items = run(rows).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'bill',
      cadence: 'monthly',
      occurrences: 6,
    });
  });

  it('M5: weekly charges with a varying amount are not a subscription', () => {
    const dates = Array.from({ length: 8 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 7, 8 + i * 7));
      return d.toISOString().slice(0, 10);
    });
    const rows = series('WHOLE FOODS', dates, [85, 105, 95, 100, 90, 105, 85, 95], {
      category: 'Groceries',
    });
    expect(run(rows).items).toEqual([]);
    expect(run(series('GYM WEEKLY', dates, 9.99)).items).toHaveLength(1);
  });

  it('M6: overdue is computed against the horizon and the cadence tolerance', () => {
    const rows = series('NETFLIX.COM', MONTHS, 15.49); // next expected 2026-10-15
    const at = (d) =>
      run([...rows, tx(d, 'COFFEE', 4)], new Date(2026, 9, Number(d.slice(8)))).items.find(
        (i) => i.merchantKey === 'netflix com',
      );
    expect(at('2026-10-20').overdue).toBe(false);
    expect(at('2026-10-21').overdue).toBe(true);
    expect(run(rows).items[0].overdue).toBe(false);
    const stale = run([
      ...series('OLD APP', ['2025-10-15', '2025-11-15', '2025-12-15'], 20),
      tx('2026-10-01', 'COFFEE', 4),
    ]).items[0];
    expect(stale).toMatchObject({ active: false, overdue: false });
  });

  it('M7: a late charge after short months still expects the anchor day', () => {
    const rows = series('PLAN', ['2026-01-31', '2026-02-28', '2026-03-31', '2026-05-01'], 20);
    const item = run(rows, new Date(2026, 4, 2)).items[0];
    expect(item.nextExpected).toBe('2026-05-31');
  });

  it('M8: rent in a Housing category is a bill, and a recurring move to Savings is never a charge', () => {
    const items = run([
      ...series('Maple Court Apartments', MONTHS, 1450, { category: 'Housing' }),
      ...series('Transfer to Savings', MONTHS, 300, { category: 'Savings' }),
      ...series('Brokerage Deposit', MONTHS, 200, { category: 'Investments' }),
      ...series('NETFLIX.COM', MONTHS, 15.49),
    ]).items;
    expect(items.find((i) => /maple/i.test(i.merchant ?? i.merchantKey))?.kind).toBe('bill');
    expect(items.some((i) => /savings|brokerage/i.test(i.merchant ?? i.merchantKey))).toBe(false);
    expect(items.find((i) => i.merchantKey === 'netflix com')?.kind).toBe('subscription');
  });
});

