import { describe, it, expect } from 'vitest';
import { serializeJaviContext } from '../../javiContext';
import { buildHomeContext } from '../home';
import { buildBudgetDashboardContext, buildBudgetPlannerContext } from '../budget';
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

function hasKey(value, key) {
  if (Array.isArray(value)) return value.some((v) => hasKey(v, key));
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([k, v]) => k === key || hasKey(v, key));
  }
  return false;
}

const plan = {
  groups: [
    {
      name: 'Income',
      isIncome: true,
      budgeted: 5000,
      spent: 5000,
      remaining: 0,
      categories: [{ id: 'i1', name: 'Pay', budgeted: 5000, spent: 5000, remaining: 0 }],
    },
    {
      name: 'Needs',
      isIncome: false,
      budgeted: 1000,
      spent: 1300,
      remaining: -300,
      categories: [
        { id: 'c1', name: 'Rent', budgeted: 800, spent: 800, remaining: 0 },
        { id: 'c2', name: 'Food', budgeted: 200, spent: 400, remaining: -200 },
        { id: 'c3', name: 'Misc', budgeted: 0, spent: 100, remaining: -100 },
      ],
    },
  ],
  totals: { incomeBudgeted: 5000, incomeSpent: 5000, expenseBudgeted: 1000, expenseSpent: 1300, netBudgeted: 4000, netActual: 3700 },
};

describe('loading and error states', () => {
  it.each([
    ['todos', buildTodosContext, {}],
    ['habits', buildHabitsContext, {}],
    ['focus', buildFocusContext, {}],
    ['countdowns', buildCountdownsContext, {}],
    ['calendar', buildCalendarContext, {}],
    ['journal', buildJournalContext, {}],
    ['notes', buildNotesContext, {}],
    ['bookmarks', buildBookmarksContext, {}],
    ['health', buildHealthContext, {}],
    ['weather', buildWeatherContext, {}],
  ])('%s', (_name, build, base) => {
    expect(build({ ...base, loading: true })).toEqual({ status: 'loading' });
    expect(build({ ...base, error: new Error('x') })).toEqual({ status: 'error' });
  });
});

describe('home', () => {
  it('caps alerts and clips the briefing', () => {
    const out = buildHomeContext({
      mode: 'work',
      widgets: ['todos'],
      briefing: { digest: 'x'.repeat(2000), generatedAt: '2026-10-02T08:00:00Z' },
      alerts: many(20, (i) => ({ severity: 'warn', text: `a${i}` })),
    });
    expect(out.alerts).toHaveLength(8);
    expect(out.briefing.length).toBeLessThanOrEqual(800);
    expect(out.mode).toBe('work');
  });

  it('adds weather facts (no coordinates) only when a forecast is given', () => {
    expect(buildHomeContext({ widgets: [] })).not.toHaveProperty('weather');
    expect(buildHomeContext({ weather: { data: null } })).not.toHaveProperty('weather');
    const out = buildHomeContext({
      weather: {
        locationSource: 'device',
        data: { latitude: 1.23, longitude: 4.56, current: { temperature_2m: 70, weather_code: 0 }, daily: { time: ['2026-10-10'], temperature_2m_max: [72], temperature_2m_min: [55], weather_code: [3] } },
      },
    });
    expect(out.weather.current).toMatchObject({ tempF: 70, condition: 'Clear' });
    expect(out.weather.days).toEqual([{ date: '2026-10-10', highF: 72, lowF: 55, condition: 'Overcast' }]);
    expect(JSON.stringify(out)).not.toMatch(/1\.23|4\.56/);
  });

  it('keeps each alert kind so the server can drop kinds a cloud provider must not see', () => {
    const out = buildHomeContext({
      alerts: [
        { kind: 'todo', severity: 'warn', text: 'Two todos are overdue' },
        { kind: 'health', severity: 'info', text: 'Sleep was short' },
        { severity: 'info', text: 'No kind here' },
      ],
    });
    expect(out.alerts).toEqual([
      { kind: 'todo', severity: 'warn', text: 'Two todos are overdue' },
      { kind: 'health', severity: 'info', text: 'Sleep was short' },
      { kind: '', severity: 'info', text: 'No kind here' },
    ]);
  });

  it('clips a very long kind', () => {
    const out = buildHomeContext({ alerts: [{ kind: 'k'.repeat(100), severity: 'x', text: 'y' }] });
    expect(out.alerts[0].kind.length).toBeLessThanOrEqual(20);
  });
});

describe('budget', () => {
  it('dashboard lists over-budget categories, top spend and totals', () => {
    const out = buildBudgetDashboardContext({
      month: '2026-10',
      source: 'transactions',
      plan,
      rows: [
        { name: 'Rent', budgeted: 800, spent: 800 },
        { name: 'Food', budgeted: 200, spent: 400 },
        { name: 'Fun', budgeted: 50, spent: 40 },
      ],
    });
    expect(out.view).toBe('dashboard');
    expect(out['over budget']).toEqual([{ category: 'Food', budgeted: '$200.00', spent: '$400.00', over: '$200.00' }]);
    expect(out['top spending'][0]).toEqual({ category: 'Rent', spent: '$800.00' });
    expect(out.totals['net actual']).toBe('$3,700.00');
    expect(out).not.toHaveProperty('summary'); // its figures are all in totals, with their basis in the key
    expect(out.groups.map((g) => g.type)).toEqual(['income', 'expense']);
    expect(out.groups).toHaveLength(2);
  });

  it('planner reports overspent and unbudgeted categories', () => {
    const out = buildBudgetPlannerContext({ month: '2026-10', plan });
    expect(out.overspent.map((c) => c.name)).toEqual(['Food', 'Misc']);
    expect(out['spent without a budget']).toEqual([{ name: 'Misc', group: 'Needs', spent: '$100.00' }]);
    expect(out.overspent[0]).toMatchObject({ budgeted: '$200.00', spent: '$400.00', remaining: '-$200.00' });
    expect(hasKey(out, 'id')).toBe(false);
  });

  it('formats every money field as a $x,xxx.xx string and keeps negatives as -$x', () => {
    const out = buildBudgetDashboardContext({
      plan,
      rows: [],
    });
    for (const [k, v] of Object.entries(out.totals)) {
      expect(v).toMatch(k.startsWith('savings rate') ? /^-?\d+%$/ : /^-?\$[\d,]+\.\d{2}$/);
    }
    for (const g of out.groups) {
      const keys = g.type === 'income' ? ['budgeted', 'received', 'still to come'] : ['budgeted', 'spent', 'remaining'];
      for (const k of keys) expect(g[k]).toMatch(/^-?\$[\d,]+\.\d{2}$/);
    }
  });

  it('caps over-budget rows at 8', () => {
    const rows = many(30, (i) => ({ name: `c${i}`, budgeted: 10, spent: 20 + i }));
    expect(buildBudgetDashboardContext({ plan, rows })['over budget']).toHaveLength(8);
  });

  it('uses plain-word keys, never camelCase jargon the model could echo', () => {
    const out = JSON.stringify([
      buildBudgetDashboardContext({ month: '2026-10', plan, rows: [] }),
      buildBudgetPlannerContext({ month: '2026-10', plan }),
    ]);
    const keys = [...out.matchAll(/"([^"]+)":/g)].map((m) => m[1]);
    expect(keys.filter((k) => /[a-z][A-Z]/.test(k))).toEqual([]);
  });
});

describe('todos', () => {
  const todos = [
    { id: '1', title: 'Late', done: false, due: '2026-09-30', priority: 'high', status: 'Doing' },
    { id: '2', title: 'Soon', done: false, due: '2026-10-05', priority: 'low', status: 'Todo' },
    { id: '3', title: 'Done', done: true, due: '2026-09-01' },
    ...many(40, (i) => ({ id: `x${i}`, title: `t${i}`, done: false, due: '2026-09-01', priority: 'high' })),
  ];
  it('counts, overdue, due this week and caps lists', () => {
    const out = buildTodosContext({ todos, now: NOW });
    expect(out.counts.total).toBe(43);
    expect(out.counts.done).toBe(1);
    expect(out.counts['by column'].Doing).toBe(1);
    expect(out.overdue).toHaveLength(10);
    expect(out['due this week'].map((t) => t.title)).toEqual(['Soon']);
    expect(out['high priority']).toHaveLength(10);
    expect(hasKey(out, 'id')).toBe(false);
  });

  it('precomputes a plain-words status per item from the local date', () => {
    const out = buildTodosContext({
      todos: [
        { title: 'Renew passport', done: false, due: '2026-09-29', priority: 'high' },
        { title: 'Call plumber', done: false, due: '2026-10-02' },
        { title: 'Dentist', done: false, due: '2026-10-03' },
        { title: 'Taxes', done: false, due: '2026-10-07' },
        { title: 'Someday', done: false, priority: 'high' },
      ],
      now: NOW,
    });
    expect(out.overdue).toEqual([{ title: 'Renew passport', status: 'overdue by 3 days', due: '2026-09-29', priority: 'high' }]);
    expect(out['due this week'].map((t) => t.status)).toEqual(['due today', 'due tomorrow', 'due in 5 days']);
    expect(out['high priority'].map((t) => t.status)).toEqual(['overdue by 3 days', 'no due date']);
    const keys = [...JSON.stringify(out).matchAll(/"([^"]+)":/g)].map((m) => m[1]);
    expect(keys.filter((k) => /[a-z][A-Z]/.test(k))).toEqual([]);
  });
});

describe('habits', () => {
  it('reports streak and today completion', () => {
    const out = buildHabitsContext({
      habits: [{ id: 'h', title: 'Read', frequency: 'daily', completions: ['2026-10-02', '2026-10-01', '2026-09-30'] }],
      now: NOW,
    });
    expect(out.habits[0]).toMatchObject({
      title: 'Read',
      'done today': true,
      'streak in days': 3,
      'done in the last 30 days': '10%',
    });
  });
});

describe('focus', () => {
  it('sums the last 7 days of focus sessions', () => {
    const out = buildFocusContext({
      today: { count: 1, minutes: 25 },
      sessions: [
        { kind: 'focus', startedAt: new Date(2026, 9, 1, 9).toISOString(), durationMin: 25 },
        { kind: 'break', startedAt: new Date(2026, 9, 1, 9).toISOString(), durationMin: 5 },
        { kind: 'focus', startedAt: new Date(2026, 8, 1, 9).toISOString(), durationMin: 50 },
      ],
      now: NOW,
    });
    expect(out.today).toEqual({ count: 1, minutes: 25 });
    expect(out['last 7 days']).toEqual({ count: 1, minutes: 25 });
  });
});

describe('countdowns', () => {
  it('sorts upcoming and counts past', () => {
    const out = buildCountdownsContext({
      countdowns: [
        { title: 'Later', targetDate: '2026-12-25' },
        { title: 'Soon', targetDate: '2026-10-04' },
        { title: 'Tomorrow', targetDate: '2026-10-03' },
        { title: 'Today', targetDate: '2026-10-02' },
        { title: 'Gone', targetDate: '2026-01-01' },
      ],
      now: NOW,
    });
    expect(out.upcoming.map((c) => c.title)).toEqual(['Today', 'Tomorrow', 'Soon', 'Later']);
    expect(out.upcoming.map((c) => c.when)).toEqual(['today', 'tomorrow', 'in 2 days', 'in 84 days']);
    expect(out.upcoming[2]).toEqual({ title: 'Soon', date: '2026-10-04', when: 'in 2 days' });
    expect(out.past).toBe(1);
  });
});

describe('calendar', () => {
  it('lists the next 7 days with titles and times only', () => {
    const out = buildCalendarContext({
      events: [
        { id: 'e1', summary: 'Standup', start: '2026-10-02T15:00:00', end: '2026-10-02T15:30:00', description: 'secret', location: 'HQ' },
        { id: 'e2', summary: 'Far', start: '2026-11-20T15:00:00' },
        { id: 'e3', summary: 'Next week', start: '2026-10-08T10:00:00' },
      ],
      now: NOW,
    });
    expect(out['next 7 days'].map((e) => e.summary)).toEqual(['Standup', 'Next week']);
    expect(out['next 7 days'].map((e) => e.when)).toEqual(['today', 'in 6 days']);
    expect(out['events today']).toBe(1);
    expect(JSON.stringify(out)).not.toContain('secret');
    expect(JSON.stringify(out)).not.toContain('HQ');
  });
});

describe('calendar dates', () => {
  it('treats date-only strings as local days and includes in-progress events', () => {
    const out = buildCalendarContext({
      events: [
        { summary: 'All day today', start: '2026-10-02', end: '2026-10-03', allDay: true },
        { summary: 'Ended yesterday', start: '2026-10-01', end: '2026-10-02', allDay: true },
        { summary: 'Trip', start: '2026-09-30T09:00:00', end: '2026-10-04T17:00:00' },
        { summary: 'Finished', start: '2026-09-30T09:00:00', end: '2026-10-01T17:00:00' },
        { summary: 'Day after week', start: '2026-10-09', allDay: true },
        { summary: 'Day 6', start: '2026-10-08', allDay: true },
      ],
      now: NOW,
    });
    expect(out['next 7 days'].map((e) => e.summary)).toEqual(['Trip', 'All day today', 'Day 6']);
    expect(out['next 7 days'].map((e) => e.when)).toEqual(['ongoing, started 2 days ago', 'today', 'in 6 days']);
    expect(out['events today']).toBe(2);
  });
});

describe('journal', () => {
  it('never includes bodies, titles or tags', () => {
    const out = buildJournalContext({
      entries: [
        { id: 'j1', title: 'Private title', body: 'TOP SECRET BODY', date: '2026-10-01', mood: 'happy', tags: ['x'] },
        { id: 'j2', body: 'another body', date: '2026-09-20', mood: 'happy' },
      ],
      now: NOW,
    });
    const s = JSON.stringify(out);
    expect(s).not.toContain('SECRET BODY');
    expect(s).not.toContain('another body');
    expect(s).not.toContain('Private title');
    expect(out.total).toBe(2);
    expect(out['mood counts']).toEqual({ happy: 2 });
    expect(out.recent[0]).toEqual({ date: '2026-10-01', mood: 'happy' });
  });
});

describe('notes and bookmarks', () => {
  it('notes caps pinned and recent', () => {
    const notes = many(30, (i) => ({ body: `note ${i}`, pinned: i < 10 }));
    const out = buildNotesContext({ notes });
    expect(out.pinnedTitles).toHaveLength(5);
    expect(out.recentTitles).toHaveLength(8);
    expect(out.pinnedCount).toBe(10);
    expect(out.total).toBe(30);
  });

  it('notes send clipped titles only, never body excerpts', () => {
    const out = buildNotesContext({
      notes: [{ body: `${'T'.repeat(80)}\nSECRET SECOND LINE`, pinned: true }],
    });
    expect(JSON.stringify(out)).not.toContain('SECRET');
    expect(out.pinnedTitles[0].length).toBeLessThanOrEqual(40);
    expect(hasKey(out, 'body')).toBe(false);
  });

  it('todos clip priority and status', () => {
    const out = buildTodosContext({
      todos: [{ title: 't', done: false, due: '2026-10-03', priority: 'high', status: 'S'.repeat(200) }],
      now: NOW,
    });
    expect(out['high priority'][0].column.length).toBeLessThanOrEqual(40);
    const odd = buildTodosContext({
      todos: [{ title: 't', done: false, due: '2026-10-03', priority: 'P'.repeat(200) }],
      now: NOW,
    });
    expect(odd['due this week'][0].priority.length).toBeLessThanOrEqual(20);
  });

  it('bookmarks groups by category and reduces urls to domains', () => {
    const out = buildBookmarksContext({
      bookmarks: [
        { id: 'b', title: 'A', url: 'https://example.com/path?token=abc', category: 'Dev' },
        { title: 'B', url: 'not a url ::' },
      ],
    });
    expect(out.byCategory).toEqual({ Dev: 1, Ungrouped: 1 });
    expect(out.recent[0].domain).toBe('example.com');
    expect(JSON.stringify(out)).not.toContain('token=abc');
  });
});

describe('health and weather', () => {
  it('health averages the last 7 days', () => {
    const days = many(10, (i) => ({ day: `2026-09-${20 + i}`, readiness: 80 + i, sleep: 70, activity: 60, hrv: 40, sleepHours: 7 }));
    const out = buildHealthContext({ days, latest: days[9] });
    expect(out.latest.readiness).toBe(89);
    expect(out.avg7.readiness).toBe(86);
  });

  it('weather has no coordinates', () => {
    const out = buildWeatherContext({
      locationSource: 'device',
      data: {
        latitude: 12.3,
        longitude: 45.6,
        current: { temperature_2m: 70.5, weather_code: 0, wind_speed_10m: 5 },
        daily: {
          time: many(7, (i) => `2026-10-0${i + 1}`),
          temperature_2m_max: many(7, () => 75),
          temperature_2m_min: many(7, () => 55),
          weather_code: many(7, () => 3),
        },
      },
    });
    expect(out.current).toEqual({ tempF: 70.5, condition: 'Clear', windMph: 5 });
    expect(out.days).toHaveLength(5);
    expect(JSON.stringify(out)).not.toMatch(/lat|lon|12\.3|45\.6/i);
  });
});

describe('settings', () => {
  it('settings emits exactly its four keys', () => {
    const out = buildSettingsContext({ mode: 'all', themePreference: 'dark', advisorButton: true, autoAdvise: false, apiKey: 'sk-leak', last4: '1234' });
    expect(Object.keys(out).sort()).toEqual(['advisorButton', 'autoAdvise', 'mode', 'themePreference']);
  });
});

describe('data browser', () => {
  it('never includes row values', () => {
    const out = buildDataBrowserContext({
      tables: many(40, (i) => ({ id: `t${i}`, label: `T${i}`, group: 'g', count: i, status: 'ok' })),
      activeTableId: 't1',
      view: 'rows',
      page: 2,
      pageSize: 25,
      query: 'abc',
      total: 100,
      columns: [{ name: 'key', type: 'text' }, { name: 'value', type: 'jsonb' }],
      rows: [{ key: 'GROQ_API_KEY', value: 'gsk_leak' }],
    });
    expect(out.tables).toHaveLength(30);
    expect(out.active.columns).toEqual(['key', 'value']);
    expect(out.searching).toBe(true);
    expect(JSON.stringify(out)).not.toContain('gsk_leak');
    expect(out).not.toHaveProperty('rows');
  });
});

describe('generic builders', () => {
  it('fallback', () => {
    expect(buildFallbackContext({ routeName: 'x', title: 'X page' })).toEqual({ route: 'x', title: 'X page' });
  });
});

describe('size cap', () => {
  it('stays at or under 4000 chars even with large fixtures', () => {
    const big = buildTodosContext({
      todos: many(500, (i) => ({ id: `${i}`, title: 'long title '.repeat(20), done: false, due: '2026-09-01', priority: 'high', status: 'Doing' })),
      now: NOW,
    });
    const { context } = serializeJaviContext({ pageKey: 'todos', data: big, now: NOW });
    expect(context.length).toBeLessThanOrEqual(4000);
  });
});
