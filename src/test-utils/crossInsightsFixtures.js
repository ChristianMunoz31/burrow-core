// Test-only fixtures for cross-insights: ~60 days where daily spend clearly tracks the number
// of timed calendar events (the busyness_spend pair), with no health, habit or journal data.
import { expect } from 'vitest';
import { WINDOW_DAYS } from '../utils/crossInsights';

function localKey(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Deterministic pseudo-random sequence in [0, 1) so fixtures never flake. */
function lcg(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

/**
 * Transactions + calendar events for the WINDOW_DAYS ending yesterday relative to `now`.
 * Event counts are 0..4 per day (not weekday-periodic); spend is about 8 + 14 per event.
 * @param {Date} [now]
 * @returns {{ transactions: object[], events: object[], days: string[] }}
 */
export function busynessSpendFixture(now = new Date()) {
  const rand = lcg(42);
  const transactions = [];
  const events = [];
  const days = [];
  for (let i = WINDOW_DAYS; i >= 1; i -= 1) {
    const key = localKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i));
    days.push(key);
    const count = Math.floor(rand() * 5);
    for (let e = 0; e < count; e += 1) {
      events.push({ id: `${key}-${e}`, title: `Meeting ${e}`, start: `${key}T${String(9 + e).padStart(2, '0')}:00:00`, allDay: false });
    }
    const spend = 8 + 14 * count + Math.floor(rand() * 4);
    transactions.push({ id: `tx-${key}`, date: key, amount: spend, type: 'debit', category: 'Shopping', description: 'Store' });
  }
  // Noise that must be ignored: an all-day event and a credit.
  events.push({ id: 'allday', title: 'Holiday', start: days[10], allDay: true });
  transactions.push({ id: 'pay', date: days[0], amount: 2000, type: 'credit', category: 'Income', description: 'Paycheck' });
  return { transactions, events, days };
}

/** Asserts the card rendered nothing of its own (the ToastProvider's empty live region is ignored). */
export function expectCardAbsent(container) {
  expect(container.querySelector('section')).toBeNull();
  expect(container.textContent).toBe('');
}
