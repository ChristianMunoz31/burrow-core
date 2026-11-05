import { describe, expect, it } from 'vitest';
import { detectSubscriptions, upcomingCharges } from '../subscriptions';

const NOW = new Date(2026, 9, 15, 12, 0, 0); // 2026-10-15, local
const item = (over) => ({
  id: over.merchant,
  kind: 'subscription',
  active: true,
  cadence: 'monthly',
  typicalAmount: 10,
  ...over,
});
const run = (items, days = 30) => upcomingCharges({ items }, { now: NOW, days });

describe('upcomingCharges', () => {
  it('keeps charges from today through day 30, soonest first', () => {
    const { charges } = run([
      item({ merchant: 'Day31', nextExpected: '2026-11-15' }),
      item({ merchant: 'Day30', nextExpected: '2026-11-14' }),
      item({ merchant: 'Tomorrow', nextExpected: '2026-10-16' }),
      item({ merchant: 'Today', nextExpected: '2026-10-15' }),
    ]);
    expect(charges.map((c) => [c.merchant, c.date, c.daysAway])).toEqual([
      ['Today', '2026-10-15', 0],
      ['Tomorrow', '2026-10-16', 1],
      ['Day30', '2026-11-14', 30],
    ]);
  });

  it('repeats a weekly plan inside the window and totals every charge in cents', () => {
    const { charges, total } = run([
      item({ merchant: 'Weekly', cadence: 'weekly', typicalAmount: 0.1, nextExpected: '2026-10-15' }),
      item({ merchant: 'Monthly', typicalAmount: 0.2, nextExpected: '2026-10-20' }),
    ]);
    expect(charges.filter((c) => c.merchant === 'Weekly').map((c) => c.daysAway)).toEqual([0, 7, 14, 21, 28]);
    expect(total).toBe(0.7);
  });

  it('projects a monthly plan by its billing day, clamped to short months', () => {
    const { charges } = run([item({ merchant: 'EndOfMonth', nextExpected: '2026-10-31' })], 60);
    expect(charges.map((c) => c.date)).toEqual(['2026-10-31', '2026-11-30']);
  });

  it('skips a late date inside the tolerance but drops an item overdue past it', () => {
    const { charges } = run([
      item({ merchant: 'Late', nextExpected: '2026-10-12' }),
      item({ merchant: 'Stopped', nextExpected: '2026-10-05' }),
    ]);
    expect(charges.map((c) => [c.merchant, c.date])).toEqual([['Late', '2026-11-12']]);
  });

  it('leaves out bills, inactive items and bad dates', () => {
    const { charges, total } = run([
      item({ merchant: 'Rent', kind: 'bill', nextExpected: '2026-10-20' }),
      item({ merchant: 'Old', active: false, nextExpected: '2026-10-20' }),
      item({ merchant: 'Broken', nextExpected: 'not a date' }),
      item({ merchant: 'Odd', cadence: 'daily', nextExpected: '2026-10-20' }),
    ]);
    expect(charges).toEqual([]);
    expect(total).toBe(0);
  });

  it('handles an empty or missing result', () => {
    expect(upcomingCharges(undefined, { now: NOW })).toEqual({ charges: [], total: 0 });
    expect(upcomingCharges({ items: [] }, { now: NOW })).toEqual({ charges: [], total: 0 });
  });

  it('a plan billed on the 31st stays on the 31st after a short month (detector anchor, not the clamped date)', () => {
    const tx = (date) => ({ date, merchant: 'MONTH END APP', amount: 12, type: 'debit', category: 'Software' });
    const now = new Date(2026, 1, 27, 12, 0, 0); // 2026-02-27; the window ends 2026-03-29
    const result = detectSubscriptions(['2025-10-31', '2025-11-30', '2025-12-31', '2026-01-31'].map(tx), { now });
    const plan = result.items[0];
    expect(plan).toMatchObject({ nextExpected: '2026-02-28', anchorDay: 31 });
    const { charges, total } = upcomingCharges(result, { now });
    expect(charges.map((c) => c.date)).toEqual(['2026-02-28']);
    expect(total).toBe(12);
    // A wider window shows the March charge on the 31st, not the 28th.
    expect(upcomingCharges(result, { now, days: 40 }).charges.map((c) => c.date)).toEqual(['2026-02-28', '2026-03-31']);
  });
});

