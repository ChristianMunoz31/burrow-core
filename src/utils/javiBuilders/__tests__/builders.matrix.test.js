import { describe, it, expect } from 'vitest';
import { serializeJaviContext, TRUNCATION_MARKER } from '../../javiContext';
import { buildHomeContext } from '../home';
import { buildBudgetDashboardContext, buildBudgetPlannerContext } from '../budget';
import { buildSubscriptionsContext } from '../subscriptions';
import { buildTodosContext } from '../todos';
import { buildHabitsContext } from '../habits';
import { buildFocusContext } from '../focus';
import { buildCountdownsContext } from '../countdowns';
import { buildCalendarContext } from '../calendar';
import { buildJournalContext } from '../journal';
import { buildNotesContext } from '../notes';
import { buildBookmarksContext } from '../bookmarks';
import { buildHealthContext } from '../health';
import { buildWeatherContext } from '../weather';
import { buildSettingsContext } from '../settings';
import { buildDataBrowserContext } from '../dataBrowser';
import { buildFallbackContext } from '../fallback';

const NOW = new Date(2026, 9, 2, 12, 0);
const many = (n, make) => Array.from({ length: n }, (_, i) => make(i));

// Secret-bearing free text. Each fragment must be scrubbed by redaction.
const LEAK =
  'sk-abcdefghijklmnopqrstuvwx Bearer abc123tokenvalue eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0 bob@example.com';
const FRAGMENTS = ['sk-abcdefghij', 'abc123tokenvalue', 'eyJhbGciOiJIUzI1', 'bob@example.com'];

const plan = (name) => ({
  groups: [
    {
      name,
      isIncome: false,
      budgeted: 10,
      spent: 20,
      remaining: -10,
      categories: [{ id: 'c', name, budgeted: 10, spent: 20, remaining: -10 }],
    },
  ],
  totals: {},
});
const bigPlan = (budgeted) => ({
  groups: many(40, (i) => ({
    name: `g${i}`.repeat(10),
    categories: many(20, (j) => ({
      name: `cat${j}`.repeat(10),
      budgeted,
      spent: 9,
      remaining: budgeted - 9,
    })),
  })),
  totals: {},
});

const subItem = (merchant) => ({
  merchant,
  cadence: 'monthly',
  typicalAmount: 15.49,
  monthlyEquivalent: 15.49,
  lastCharge: '2026-09-20',
  nextExpected: '2026-10-20',
  active: true,
  priceIncrease: { from: 13.99, to: 15.49, pct: 11 },
});
const subResult = (items, activeCount) => ({
  items,
  monthlyTotal: 1234.5,
  yearlyTotal: 14814,
  activeCount,
});

// name -> [factory with secrets in free text, factory with huge input]
const CASES = {
  home: [
    () => buildHomeContext({ briefing: { digest: LEAK }, alerts: [{ severity: 'warn', text: LEAK }] }),
    () =>
      buildHomeContext({
        widgets: many(50, (i) => `w${i}`),
        briefing: { digest: 'x '.repeat(3000) },
        alerts: many(50, () => ({ severity: 's', text: 'y '.repeat(400) })),
      }),
  ],
  'budget dashboard': [
    () => buildBudgetDashboardContext({ plan: plan(LEAK), rows: [{ name: LEAK, budgeted: 1, spent: 5 }] }),
    () =>
      buildBudgetDashboardContext({
        plan: bigPlan(1),
        rows: many(200, (i) => ({ name: `row${i}`.repeat(10), budgeted: 1, spent: 9 + i })),
      }),
  ],
  'budget planner': [
    () => buildBudgetPlannerContext({ plan: plan(LEAK) }),
    () => buildBudgetPlannerContext({ plan: bigPlan(0) }),
  ],
  subscriptions: [
    () => buildSubscriptionsContext({ result: subResult([subItem(LEAK)], 1) }),
    () =>
      buildSubscriptionsContext({
        result: subResult(
          many(200, (i) => subItem(`merchant${i}`.repeat(10))),
          200,
        ),
      }),
  ],
  todos: [
    () => buildTodosContext({ todos: [{ title: LEAK, done: false, due: '2026-09-01', priority: 'high' }], now: NOW }),
    () =>
      buildTodosContext({
        todos: many(500, (i) => ({ title: 'long '.repeat(40) + i, done: false, due: '2026-09-01', priority: 'high' })),
        now: NOW,
      }),
  ],
  habits: [
    () => buildHabitsContext({ habits: [{ title: LEAK, completions: [] }], now: NOW }),
    () =>
      buildHabitsContext({
        habits: many(300, (i) => ({ title: 'habit '.repeat(30) + i, completions: ['2026-10-02'] })),
        now: NOW,
      }),
  ],
  focus: [
    () => buildFocusContext({ today: { count: 1, minutes: 5 }, sessions: [], now: NOW }),
    () =>
      buildFocusContext({
        today: { count: 1, minutes: 5 },
        sessions: many(2000, () => ({ kind: 'focus', startedAt: NOW.toISOString(), durationMin: 25 })),
        now: NOW,
      }),
  ],
  countdowns: [
    () => buildCountdownsContext({ countdowns: [{ title: LEAK, targetDate: '2026-12-25' }], now: NOW }),
    () =>
      buildCountdownsContext({
        countdowns: many(400, (i) => ({ title: 'event '.repeat(30) + i, targetDate: '2026-12-25' })),
        now: NOW,
      }),
  ],
  calendar: [
    () => buildCalendarContext({ events: [{ summary: LEAK, start: '2026-10-03T10:00:00' }], now: NOW }),
    () =>
      buildCalendarContext({
        events: many(500, (i) => ({ summary: 'meeting '.repeat(30) + i, start: '2026-10-03T10:00:00' })),
        now: NOW,
      }),
  ],
  journal: [
    () =>
      buildJournalContext({
        entries: [{ title: LEAK, body: LEAK, date: '2026-10-01', mood: 'ok', tags: [LEAK] }],
        now: NOW,
      }),
    () =>
      buildJournalContext({
        entries: many(1000, (i) => ({ body: 'b'.repeat(500), date: '2026-10-01', mood: `mood${i}` })),
        now: NOW,
      }),
  ],
  notes: [
    () => buildNotesContext({ notes: [{ body: `${LEAK}\nmore`, pinned: true }] }),
    () => buildNotesContext({ notes: many(500, (i) => ({ body: 'n'.repeat(300) + i, pinned: i % 2 === 0 })) }),
  ],
  bookmarks: [
    () =>
      buildBookmarksContext({ bookmarks: [{ title: LEAK, url: 'https://example.com', category: LEAK }] }),
    () =>
      buildBookmarksContext({
        bookmarks: many(500, (i) => ({
          title: 'bm '.repeat(40) + i,
          url: `https://site${i}.example.com/p`,
          category: `cat${i}`,
        })),
      }),
  ],
  health: [
    () =>
      buildHealthContext({
        days: [{ day: '2026-10-01', readiness: 80 }],
        latest: { day: '2026-10-01', readiness: 80 },
      }),
    () =>
      buildHealthContext({
        days: many(400, (i) => ({ day: `d${i}`, readiness: i, sleep: i, activity: i, hrv: i, sleepHours: 7 })),
        latest: { readiness: 1 },
      }),
  ],
  weather: [
    () =>
      buildWeatherContext({
        locationSource: LEAK,
        data: {
          current: { temperature_2m: 70, weather_code: 0, wind_speed_10m: 1 },
          daily: { time: ['2026-10-02'], temperature_2m_max: [70], temperature_2m_min: [50], weather_code: [0] },
        },
      }),
    () =>
      buildWeatherContext({
        locationSource: 'x'.repeat(5000),
        data: {
          current: {},
          daily: {
            time: many(100, (i) => `t${i}`),
            temperature_2m_max: many(100, () => 1),
            temperature_2m_min: many(100, () => 1),
            weather_code: many(100, () => 1),
          },
        },
      }),
  ],
  settings: [
    () =>
      buildSettingsContext({
        mode: LEAK,
        themePreference: LEAK,
        advisorButton: true,
        autoAdvise: true,
      }),
    () =>
      buildSettingsContext({
        mode: 'm'.repeat(9000),
        themePreference: 't'.repeat(9000),
      }),
  ],
  dataBrowser: [
    () =>
      buildDataBrowserContext({
        tables: [{ id: 't', label: LEAK, group: LEAK, count: 1, status: 'ok' }],
        activeTableId: 't',
        columns: [{ name: LEAK, type: 'text' }],
        rows: [{ a: LEAK }],
        query: LEAK,
      }),
    () =>
      buildDataBrowserContext({
        tables: many(500, (i) => ({ id: `t${i}`, label: 'label'.repeat(30), group: 'g'.repeat(50), count: i, status: 'ok' })),
        columns: many(500, (i) => ({ name: 'col'.repeat(20) + i, type: 'text' })),
        rows: many(100, () => ({})),
      }),
  ],
  fallback: [
    () => buildFallbackContext({ routeName: LEAK, title: LEAK }),
    () => buildFallbackContext({ routeName: 'r'.repeat(20000), title: 't'.repeat(20000) }),
  ],
};

// bookmarks use user text (category) as object keys; redactForJavi
// scrubs keys as well as values, so these cases cover key redaction too.
describe.each(Object.entries(CASES))('%s builder', (name, [leaky, huge]) => {
  it('returns a plain JSON-serializable object', () => {
    const out = leaky();
    expect(out && typeof out === 'object' && !Array.isArray(out)).toBe(true);
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it('serializes with secrets, bearer tokens, JWTs and emails redacted', () => {
    const { context } = serializeJaviContext({ pageKey: name, data: leaky(), now: NOW });
    for (const frag of FRAGMENTS) expect(context).not.toContain(frag);
  });

  it('serializes oversized input to at most 4000 chars, with the marker whenever it was cut', () => {
    const { context, truncated } = serializeJaviContext({ pageKey: name, data: huge(), now: NOW });
    expect(context.length).toBeLessThanOrEqual(4000);
    if (truncated) {
      // The marker is followed only by the clock tail, which is kept so the model still knows the time.
      expect(context).toMatch(/,"localTime":"\d{2}:\d{2}"\}$/);
      expect(context.replace(/,"localTime":"\d{2}:\d{2}"\}$/, '').endsWith(TRUNCATION_MARKER)).toBe(true);
    } else {
      expect(() => JSON.parse(context)).not.toThrow();
    }
  });
});

describe('settings builder secret exclusion', () => {
  it('drops api keys, last4 and app_state even when passed in', () => {
    const out = buildSettingsContext({
      mode: 'all',
      apiKey: 'gsk_abcdefghijklmnopqrstuvwxyz',
      secrets: [{ name: 'GROQ_API_KEY', last4: '1234' }],
      app_state: { a: 1 },
      appState: { a: 1 },
    });
    expect(JSON.stringify(out)).not.toMatch(/gsk_|GROQ|1234|app_?state/i);
  });
});

describe('data browser row values', () => {
  it('has no row values or cell data anywhere in the output', () => {
    const out = buildDataBrowserContext({
      tables: [{ id: 't', label: 'T', count: 1 }],
      activeTableId: 't',
      columns: [{ name: 'k', type: 'text' }],
      rows: [{ k: 'ROWVALUE_ONE' }, { k: 'ROWVALUE_TWO' }],
    });
    expect(JSON.stringify(out)).not.toContain('ROWVALUE');
  });
});

describe('truncation marker for an oversized payload', () => {
  it('ends with the marker at exactly the cap', () => {
    const { context, truncated } = serializeJaviContext({
      pageKey: 'x',
      data: { blob: Array.from({ length: 800 }, (_, i) => `w${i}`) },
      now: NOW,
    });
    expect(truncated).toBe(true);
    expect(context).toHaveLength(4000);
    expect(context).toMatch(/,"localTime":"\d{2}:\d{2}"\}$/);
    expect(context.replace(/,"localTime":"\d{2}:\d{2}"\}$/, '').endsWith(TRUNCATION_MARKER)).toBe(true);
  });
});
