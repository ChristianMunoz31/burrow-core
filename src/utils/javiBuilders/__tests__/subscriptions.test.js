import { describe, it, expect } from 'vitest';
import { buildSubscriptionsContext } from '../subscriptions';
import { detectSubscriptions } from '../../subscriptions';
import { serializeJaviContext } from '../../javiContext';

const item = (over = {}) => ({
  merchant: 'Netflix',
  merchantKey: 'netflix',
  cadence: 'monthly',
  typicalAmount: 15.49,
  monthlyEquivalent: 15.49,
  lastCharge: '2026-09-15',
  nextExpected: '2026-10-15',
  active: true,
  priceIncrease: null,
  ...over,
});

const result = (items, extra = {}) => ({
  items,
  monthlyTotal: 1234.56,
  yearlyTotal: 14814.72,
  activeCount: items.filter((i) => i.active).length,
  ...extra,
});

describe('buildSubscriptionsContext', () => {
  it('short-circuits on loading and error', () => {
    expect(buildSubscriptionsContext({ loading: true, result: result([item()]) })).toEqual({
      status: 'loading',
    });
    expect(buildSubscriptionsContext({ error: true, result: result([item()]) })).toEqual({
      status: 'error',
    });
  });

  it('formats money as $1,234.56 strings', () => {
    const ctx = buildSubscriptionsContext({
      result: result([item({ typicalAmount: 1234.56, monthlyEquivalent: 1234.56 })]),
    });
    expect(ctx).toMatchObject({
      view: 'subscriptions',
      monthlyTotal: '$1,234.56',
      yearlyTotal: '$14,814.72',
      activeCount: 1,
    });
    expect(ctx.items[0]).toMatchObject({
      merchant: 'Netflix',
      cadence: 'monthly',
      typical: '$1,234.56',
      monthly: '$1,234.56',
      nextExpected: '2026-10-15',
    });
    expect(ctx.items[0]).not.toHaveProperty('priceIncrease');
    expect(ctx.items[0]).not.toHaveProperty('lastCharge');
  });

  it('puts the summary fields before the items', () => {
    const ctx = buildSubscriptionsContext({ result: result([item()]) });
    expect(Object.keys(ctx)).toEqual([
      'view',
      'monthlyTotal',
      'yearlyTotal',
      'activeCount',
      'billsMonthlyTotal',
      'billsActiveCount',
      'inactiveCount',
      'items',
      'bills',
    ]);
  });

  it('formats a price increase as +$delta (pct%) without float noise', () => {
    const ctx = buildSubscriptionsContext({
      result: result([item({ priceIncrease: { from: 15.49, to: 17.49, pct: 13 } })]),
    });
    expect(ctx.items[0].priceIncrease).toBe('+$2.00 (13%)');
  });

  it('lists only active items and reports the inactive count', () => {
    const ctx = buildSubscriptionsContext({
      result: result([item(), item({ merchant: 'Old', active: false }), item({ merchant: 'Old2', active: false })]),
    });
    expect(ctx.items.map((i) => i.merchant)).toEqual(['Netflix']);
    expect(ctx.inactiveCount).toBe(2);
  });

  it('caps the item list at 15', () => {
    const many = Array.from({ length: 60 }, (_, i) => item({ merchant: `Merchant ${i}` }));
    const ctx = buildSubscriptionsContext({ result: result(many) });
    expect(ctx.items).toHaveLength(15);
    expect(ctx.items[0].merchant).toBe('Merchant 0');
    expect(ctx.activeCount).toBe(60);
  });

  it('clips long merchant names to 40 characters', () => {
    const ctx = buildSubscriptionsContext({ result: result([item({ merchant: 'M'.repeat(200) })]) });
    expect(ctx.items[0].merchant.length).toBeLessThanOrEqual(40);
  });

  it('cleans store numbers and reference ids out of the merchant label', () => {
    const ctx = buildSubscriptionsContext({
      result: result([item({ merchant: 'NETFLIX.COM  #1234  866-579-7172 REF20260915X' })]),
    });
    expect(ctx.items[0].merchant).toBe('NETFLIX.COM');
  });

  it('falls back to the merchant key when the cleaned label is empty', () => {
    const ctx = buildSubscriptionsContext({
      result: result([item({ merchant: '#1234 20260915', merchantKey: 'hulu' })]),
    });
    expect(ctx.items[0].merchant).toBe('hulu');
  });

  it('redacts before clipping so a secret cannot survive a cut', () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz0';
    const merchant = `${'A'.repeat(30)} ${secret}`;
    const ctx = buildSubscriptionsContext({ result: result([item({ merchant })]) });
    const label = ctx.items[0].merchant;
    expect(label).not.toMatch(/sk-/);
    expect(label.length).toBeLessThanOrEqual(40);
  });

  it('relabels person-to-person items generically and keeps them listed', () => {
    const ctx = buildSubscriptionsContext({
      result: result([
        item({ merchant: 'VENMO PAYMENT', merchantKey: 'venmo payment' }),
        item({ merchant: 'Zelle to Bob', merchantKey: 'zelle to bob' }),
        item({ merchant: 'Cash App', merchantKey: 'cash app' }),
        item({ merchant: 'PayPal Transfer', merchantKey: 'paypal transfer' }),
        item(),
      ]),
    });
    expect(ctx.items.map((i) => i.merchant)).toEqual([
      'Personal payment (Venmo)',
      'Personal payment (Zelle)',
      'Personal payment (Cash App)',
      'Personal payment (PayPal)',
      'Netflix',
    ]);
    expect(JSON.stringify(ctx)).not.toMatch(/Bob/);
  });

  it('hides PayPal-processed person names but counts them, and keeps known merchants', () => {
    const ctx = buildSubscriptionsContext({
      result: result([
        item({ merchant: 'PayPal *JohnSmith', merchantKey: 'johnsmith' }),
        item({ merchant: 'PAYPAL *NETFLIX', merchantKey: 'netflix' }),
        item(),
      ]),
    });
    expect(JSON.stringify(ctx)).not.toMatch(/JohnSmith/i);
    expect(ctx.items.map((i) => i.merchant)).toEqual([
      'Personal payment (PayPal)',
      'PAYPAL *NETFLIX',
      'Netflix',
    ]);
    expect(ctx.activeCount).toBe(3);
  });

  it('matches known PayPal merchants as whole words only, so a name containing one stays hidden', () => {
    const ctx = buildSubscriptionsContext({
      result: result([item({ merchant: 'PayPal *Appleby Steamer', merchantKey: 'appleby steamer' })]),
    });
    expect(JSON.stringify(ctx)).not.toMatch(/appleby|steamer/i);
    expect(ctx.items[0].merchant).toBe('Personal payment (PayPal)');
  });

  it('totals equal the result totals even with person-to-person items present', () => {
    const ctx = buildSubscriptionsContext({
      result: {
        items: [
          item({ monthlyEquivalent: 15.49 }),
          item({ merchant: 'Venmo Bob', merchantKey: 'venmo bob', monthlyEquivalent: 100 }),
        ],
        monthlyTotal: 115.49,
        yearlyTotal: 1385.88,
        activeCount: 2,
      },
    });
    expect(ctx).toMatchObject({ monthlyTotal: '$115.49', yearlyTotal: '$1,385.88', activeCount: 2 });
    expect(ctx.items).toHaveLength(2);
    expect(JSON.stringify(ctx)).not.toMatch(/Bob/);
  });

  it('reports bills separately: bills total, count, and at most 5 listed bills', () => {
    const bills = Array.from({ length: 8 }, (_, i) =>
      item({ merchant: `Bill ${i}`, merchantKey: `bill ${i}`, kind: 'bill', monthlyEquivalent: 100 }),
    );
    const ctx = buildSubscriptionsContext({
      result: {
        ...result([item({ kind: 'subscription' }), ...bills]),
        monthlyTotal: 15.49,
        yearlyTotal: 185.88,
        activeCount: 1,
        billsMonthlyTotal: 800,
        billsActiveCount: 8,
      },
    });
    expect(ctx).toMatchObject({
      monthlyTotal: '$15.49',
      activeCount: 1,
      billsMonthlyTotal: '$800.00',
      billsActiveCount: 8,
    });
    expect(ctx.items.map((i) => i.merchant)).toEqual(['Netflix']);
    expect(ctx.bills.map((i) => i.merchant)).toEqual(['Bill 0', 'Bill 1', 'Bill 2', 'Bill 3', 'Bill 4']);
  });

  it('omits priceIncrease when absent and keeps it when present', () => {
    const ctx = buildSubscriptionsContext({
      result: result([item(), item({ priceIncrease: { from: 1, to: 2, pct: 100 } })]),
    });
    expect(ctx.items[0]).not.toHaveProperty('priceIncrease');
    expect(ctx.items[1].priceIncrease).toBe('+$1.00 (100%)');
  });

  it('uses 0 for non-finite totals instead of NaN', () => {
    const ctx = buildSubscriptionsContext({
      result: { items: [], monthlyTotal: NaN, yearlyTotal: Infinity, activeCount: NaN },
    });
    expect(ctx).toMatchObject({ monthlyTotal: '$0.00', yearlyTotal: '$0.00', activeCount: 0 });
  });

  it('serializes 15 realistic 40-character items without truncation', () => {
    const items = Array.from({ length: 15 }, (_, i) =>
      item({
        merchant: `Streaming Service Provider Name ${String(i).padStart(2, '0')} Plus`.slice(0, 40),
        merchantKey: `streaming ${i}`,
        typicalAmount: 1234.56,
        monthlyEquivalent: 1234.56,
        priceIncrease: { from: 1000.5, to: 1234.56, pct: 23 },
      }),
    );
    const ctx = buildSubscriptionsContext({ result: result(items) });
    expect(ctx.items).toHaveLength(15);
    const { truncated } = serializeJaviContext({ pageKey: 'subscriptions', data: ctx, now: new Date() });
    expect(truncated).toBe(false);
  });

  it('handles a missing or empty result with zeros and no NaN', () => {
    for (const input of [{}, undefined, { result: undefined }, { result: { items: [] } }]) {
      const ctx = buildSubscriptionsContext(input);
      expect(ctx).toMatchObject({
        view: 'subscriptions',
        monthlyTotal: '$0.00',
        yearlyTotal: '$0.00',
        items: [],
        inactiveCount: 0,
      });
      expect(JSON.stringify(ctx)).not.toMatch(/NaN|Infinity/);
    }
  });

  it('never emits the string NaN for malformed items', () => {
    const ctx = buildSubscriptionsContext({
      result: {
        items: [
          null,
          item({ typicalAmount: NaN, monthlyEquivalent: undefined, priceIncrease: { from: 1, to: NaN, pct: NaN } }),
        ],
        monthlyTotal: 5,
        yearlyTotal: 60,
      },
    });
    expect(JSON.stringify(ctx)).not.toMatch(/NaN|Infinity|undefined/);
  });

  it('falls back to counting active items when activeCount is absent', () => {
    const ctx = buildSubscriptionsContext({
      result: { items: [item(), item({ active: false })], monthlyTotal: 15.49, yearlyTotal: 185.88 },
    });
    expect(ctx.activeCount).toBe(1);
  });

  it('serializes real detector output within size limits', () => {
    const rows = [];
    for (let n = 0; n < 40; n += 1) {
      for (const d of ['2026-07-15', '2026-08-15', '2026-09-15']) {
        rows.push({
          id: `${n}-${d}`,
          date: d,
          merchant: `SERVICE${String.fromCharCode(97 + (n % 26))}${n >= 26 ? 'x' : ''} PLAN`,
          amount: 5 + n,
          category: 'Entertainment',
          type: 'debit',
        });
      }
    }
    const detected = detectSubscriptions(rows, { now: new Date(2026, 9, 3) });
    const ctx = buildSubscriptionsContext({ result: detected });
    expect(ctx.items.length).toBeLessThanOrEqual(15);
    expect(ctx.monthlyTotal).toMatch(/^\$[\d,]+\.\d{2}$/);
    const { context } = serializeJaviContext({ pageKey: 'subscriptions', data: ctx, now: new Date() });
    expect(context).not.toMatch(/NaN/);
  });
});
