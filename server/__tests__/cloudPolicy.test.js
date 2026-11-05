// Cloud AI category policy: the mapping tables are complete (a new tool, page, table or briefing
// key without a category fails here), the policy decides per page and tool, the page/briefing
// filters drop withheld data, and the fixed copy is exact and free of em dashes.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../loadEnv.js', () => ({}));

import { closeTestDb, createTestDb, seedDb } from './helpers/testDb.js';
import { BRIEFING_KEY_CATEGORIES, CATEGORY_NOUNS, CLOUD_CATEGORY_DEFAULTS, CLOUD_CATEGORY_IDS, DATA_BROWSER_TABLE_CATEGORIES, PAGE_CATEGORIES, SEARCH_ITEM_KIND_CATEGORIES, applyPagePolicy, createAiPolicy, filterBriefingSnapshot, sanitizeCloudCategories, withheldMessage, withheldToolResult } from '../ai/privacy.js';
import { JAVI_PAGE_LABELS } from '../javi/pages.js';
import { DATA_TABLES } from '../dataBrowser/tables.js';
import { buildBriefingContext, searchData } from '../dataAccess.js';

const EM_DASH = /[‒-―]/;
const allOn = Object.fromEntries(CLOUD_CATEGORY_IDS.map((id) => [id, true]));
const cloud = (categories = {}) => createAiPolicy({ isCloud: true, categories: { ...CLOUD_CATEGORY_DEFAULTS, ...categories } });
const local = () => createAiPolicy({ isCloud: false });

describe('categories and defaults', () => {
  it('lists the eleven ids in the documented order, with memory never one of them', () => {
    expect(CLOUD_CATEGORY_IDS).toEqual(['budget', 'todos', 'calendar', 'habits', 'health', 'notes', 'journal', 'bookmarks', 'countdowns', 'focus', 'folders']);
    expect(CLOUD_CATEGORY_IDS).not.toContain('memory');
  });

  it('shares everything except health, notes, journal and folders by default', () => {
    expect(Object.keys(CLOUD_CATEGORY_DEFAULTS)).toEqual(CLOUD_CATEGORY_IDS);
    expect(CLOUD_CATEGORY_IDS.filter((id) => !CLOUD_CATEGORY_DEFAULTS[id])).toEqual(['health', 'notes', 'journal', 'folders']);
  });

  it('sanitizeCloudCategories keeps known ids with boolean values only', () => {
    expect(sanitizeCloudCategories({ journal: true, health: 'yes', bogus: true, memory: true, budget: false })).toEqual({ journal: true, budget: false });
    expect(sanitizeCloudCategories(null)).toEqual({});
    expect(sanitizeCloudCategories([true])).toEqual({});
  });
});

describe('every mapping is complete (a new consumer without a category fails here)', () => {
  it('maps every Javi page, and nothing else', () => {
    expect(Object.keys(PAGE_CATEGORIES).sort()).toEqual(Object.keys(JAVI_PAGE_LABELS).sort());
  });

  it('maps every data browser table, and nothing else', () => {
    expect(Object.keys(DATA_BROWSER_TABLE_CATEGORIES).sort()).toEqual(DATA_TABLES.map((t) => t.id).sort());
  });

  it('maps every key of the real briefing snapshot (plus weather and health)', async () => {
    const db = createTestDb();
    try {
      const ctx = await buildBriefingContext();
      for (const key of [...Object.keys(ctx), 'weather', 'health']) expect(BRIEFING_KEY_CATEGORIES, key).toHaveProperty(key);
      expect(Object.keys(BRIEFING_KEY_CATEGORIES).sort()).toEqual([...Object.keys(ctx), 'weather', 'health'].sort());
    } finally {
      closeTestDb(db);
    }
  });

  it('maps every search kind and every kind a search result can carry', async () => {
    const db = createTestDb();
    try {
      seedDb(db, {
        todos: [{ title: 'zebra todo' }],
        notes: [{ body: 'zebra note' }],
        journal: [{ title: 'zebra', body: 'zebra entry', date: '2026-01-01T00:00:00.000Z' }],
        bookmarks: [{ title: 'zebra link', url: 'https://example.com/zebra' }],
        countdowns: [{ title: 'zebra day', target_date: '2030-01-01' }],
        transactions: [{ merchant: 'zebra shop', amount: -5, date: '2026-01-01', category: 'Fun', type: 'debit' }],
      });
      const { results } = await searchData({ query: 'zebra' });
      const kinds = [...new Set(results.map((r) => r.kind))].sort();
      expect(kinds).toEqual(Object.keys(SEARCH_ITEM_KIND_CATEGORIES).sort());
      for (const kind of kinds) expect(CLOUD_CATEGORY_IDS).toContain(SEARCH_ITEM_KIND_CATEGORIES[kind]);
    } finally {
      closeTestDb(db);
    }
  });

  it('has a noun for every category', () => {
    expect(Object.keys(CATEGORY_NOUNS)).toEqual(CLOUD_CATEGORY_IDS);
  });
});

describe('createAiPolicy', () => {
  it('local allows every category, memory and anything unknown', () => {
    const p = local();
    expect(p.isCloud).toBe(false);
    expect([...p.allowed]).toEqual(CLOUD_CATEGORY_IDS);
    expect(p.allows('journal')).toBe(true);
    expect(p.allows('memory')).toBe(true);
  });

  it('cloud allows only the ticked categories; null is always allowed; memory and unknown never', () => {
    const p = cloud();
    expect([...p.allowed]).toEqual(['budget', 'todos', 'calendar', 'habits', 'bookmarks', 'countdowns', 'focus']);
    expect(p.allows('todos')).toBe(true);
    expect(p.allows('journal')).toBe(false);
    expect(p.allows(null)).toBe(true);
    expect(p.allows(undefined)).toBe(true);
    expect(p.allows('memory')).toBe(false);
    expect(p.allows('bogus')).toBe(false);
  });

  it('is frozen', () => {
    const p = cloud();
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.allowed)).toBe(true);
  });

  it('missing keys use the defaults and unknown keys are dropped', () => {
    const p = createAiPolicy({ isCloud: true, categories: { journal: true, bogus: true } });
    expect(p.allows('journal')).toBe(true);
    expect(p.allows('health')).toBe(false);
    expect(p.allows('budget')).toBe(true);
  });

  describe('pageDecision', () => {
    it('public pages and mixed pages are allowed with no categories', () => {
      expect(cloud().pageDecision('settings')).toEqual({ allowed: true, mode: 'public', categories: [], withheld: [] });
      // Calendar follows the calendar category.
      expect(cloud().pageDecision('calendar').categories).toEqual(['calendar']);
      expect(cloud().pageDecision('home')).toEqual({ allowed: true, mode: 'mixed', categories: [], withheld: [] });
      expect(cloud().pageDecision('data-browser').mode).toBe('mixed');
    });

    it('a single-category page follows its category (budget covers planner and subscriptions)', () => {
      expect(cloud().pageDecision('todos')).toEqual({ allowed: true, mode: 'single', categories: ['todos'], withheld: [] });
      expect(cloud().pageDecision('journal')).toEqual({ allowed: false, mode: 'single', categories: ['journal'], withheld: ['journal'] });
      for (const page of ['budget', 'budget-planner', 'subscriptions']) expect(cloud().pageDecision(page).categories).toEqual(['budget']);
      expect(cloud({ budget: false }).pageDecision('subscriptions').allowed).toBe(false);
    });

    it('an unknown page is not allowed under cloud and allowed locally', () => {
      expect(cloud().pageDecision('nope').allowed).toBe(false);
      expect(local().pageDecision('nope').allowed).toBe(true);
    });

    it('local allows every page', () => {
      for (const page of Object.keys(JAVI_PAGE_LABELS)) expect(local().pageDecision(page).allowed, page).toBe(true);
    });
  });

  describe('toolDecision', () => {
    it('allows a tool whose category is shared and refuses one that is not', () => {
      expect(cloud().toolDecision('list_todos', {})).toMatchObject({ allowed: true, categories: ['todos'], withheld: [] });
      expect(cloud().toolDecision('list_journal', {})).toMatchObject({ allowed: false, categories: [], withheld: ['journal'] });
      expect(cloud().toolDecision('add_journal_entry', { body: 'x' })).toMatchObject({ allowed: false, withheld: ['journal'] });
      expect(cloud({ health: true }).toolDecision('get_health', {}).allowed).toBe(true);
    });

    it('weather has no category and is always allowed; an unknown tool never is under cloud', () => {
      expect(cloud().toolDecision('get_weather', {}).allowed).toBe(true);
      expect(cloud().toolDecision('format_disk', {})).toMatchObject({ allowed: false, withheld: [] });
      expect(local().toolDecision('format_disk', {}).allowed).toBe(true);
    });

    it('search_data with no kinds searches only the shared kinds', () => {
      const d = cloud().toolDecision('search_data', { query: 'x' });
      expect(d.allowed).toBe(true);
      expect(d.args.kinds).toEqual(['todos', 'bookmarks', 'countdowns', 'transactions']);
      expect(d.args.query).toBe('x');
      expect(d.categories).toEqual(['budget', 'todos', 'bookmarks', 'countdowns']);
      expect(d.withheld).toEqual(['notes', 'journal']);
    });

    it('search_data narrows requested kinds and refuses when none are shared', () => {
      expect(cloud().toolDecision('search_data', { query: 'x', kinds: ['journal', 'todos'] }).args.kinds).toEqual(['todos']);
      const none = cloud().toolDecision('search_data', { query: 'x', kinds: ['journal', 'notes'] });
      expect(none).toMatchObject({ allowed: false, withheld: ['notes', 'journal'] });
    });

    it('local leaves search_data untouched', () => {
      const args = { query: 'x', kinds: ['journal'] };
      expect(local().toolDecision('search_data', args).args).toBe(args);
    });
  });
});

describe('fixed copy', () => {
  it('names one singular category with "isn\'t"', () => {
    expect(withheldMessage(['journal'])).toBe("Your journal isn't shared with cloud AI. You can change that in Settings > AI.");
  });

  it('uses "aren\'t" for two or more, and for a single plural noun', () => {
    expect(withheldMessage(['journal', 'health'])).toBe("Your health data and journal aren't shared with cloud AI. You can change that in Settings > AI.");
    expect(withheldMessage(['todos'])).toBe("Your todos aren't shared with cloud AI. You can change that in Settings > AI.");
  });

  it('joins three as "a, b and c" in category order, whatever order they come in', () => {
    expect(withheldMessage(['journal', 'notes', 'health'])).toBe("Your health data, notes and journal aren't shared with cloud AI. You can change that in Settings > AI.");
  });

  it('ignores unknown ids and has a generic fallback', () => {
    expect(withheldMessage(['bogus', 'journal'])).toBe(withheldMessage(['journal']));
    expect(withheldMessage([])).toBe("That isn't shared with cloud AI. You can change that in Settings > AI.");
  });

  it('withheld tool results say what is missing and tell the model not to guess', () => {
    expect(withheldToolResult('journal')).toEqual({
      not_shared: true,
      category: 'journal',
      message: "The user's journal is not shared with cloud AI. Do not guess it.",
    });
    expect(withheldToolResult('todos').message).toBe("The user's todos are not shared with cloud AI. Do not guess it.");
    expect(withheldToolResult(undefined)).toMatchObject({ not_shared: true, category: null });
  });

  it('no message contains an em dash or an en dash', () => {
    const all = [
      ...CLOUD_CATEGORY_IDS.map((id) => withheldMessage([id])),
      withheldMessage(CLOUD_CATEGORY_IDS),
      ...CLOUD_CATEGORY_IDS.map((id) => withheldToolResult(id).message),
      withheldToolResult(null).message,
    ];
    for (const text of all) expect(text).not.toMatch(EM_DASH);
  });
});

describe('applyPagePolicy', () => {
  const messages = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'earlier answer' },
    { role: 'user', content: 'last' },
  ];
  const homeContext = (extra = {}) =>
    JSON.stringify({
      mode: 'all',
      widgets: ['budget'],
      briefing: 'Your day at a glance.',
      briefingAt: '2026-01-01T07:00:00.000Z',
      alerts: [
        { kind: 'todo', severity: 'warn', text: '2 overdue todos' },
        { kind: 'health', severity: 'warn', text: 'Low readiness today' },
        { kind: 'budget', severity: 'info', text: 'spend' },
        { text: 'no kind' },
      ],
      ...extra,
    });

  it('local passes everything through unchanged', () => {
    const input = { page: 'journal', context: homeContext(), messages };
    expect(applyPagePolicy(input, local())).toMatchObject({ allowed: true, context: input.context, messages, withheld: [] });
  });

  it('a withheld single-category page is blocked with nothing to send', () => {
    expect(applyPagePolicy({ page: 'journal', context: 'secret text', messages }, cloud())).toEqual({
      allowed: false,
      context: '',
      messages: [],
      categories: [],
      withheld: ['journal'],
    });
  });

  it('an allowed single-category page passes the context and only the user messages', () => {
    const out = applyPagePolicy({ page: 'todos', context: '{"open":2}', messages }, cloud());
    const users = messages.filter((m) => m.role === 'user').map((m) => m.content);
    expect(out).toMatchObject({ allowed: true, context: '{"open":2}', categories: ['todos'], withheld: [] });
    expect(out.messages).toEqual([{ role: 'user', content: users.join('\n\n') }]);
  });

  it('home: drops the briefing unless every briefing category is shared, and alerts of withheld kinds', () => {
    const out = applyPagePolicy({ page: 'home', context: homeContext(), messages }, cloud());
    const ctx = JSON.parse(out.context);
    expect(ctx).not.toHaveProperty('briefing');
    expect(ctx).not.toHaveProperty('briefingAt');
    expect(ctx.alerts.map((a) => a.kind)).toEqual(['todo', 'budget']);
    expect(out.withheld).toEqual(['health']);
    expect(out.categories).toEqual(['budget', 'todos']);
    // Earlier turns may be derived from withheld data: only the question goes.
    expect(out.messages).toEqual([messages[2]]);
  });

  it('home: keeps the briefing, and only the last question, when every briefing category is shared', () => {
    const out = applyPagePolicy({ page: 'home', context: homeContext({ alerts: [{ kind: 'todo', text: 't' }] }), messages }, cloud({ health: true }));
    expect(JSON.parse(out.context).briefing).toBe('Your day at a glance.');
    expect(out.withheld).toEqual([]);
    expect(out.messages).toEqual([messages[2]]);
  });

  it('home: an unparseable context becomes a fixed note and only the last question is sent', () => {
    const out = applyPagePolicy({ page: 'home', context: 'not json {', messages }, cloud());
    expect(out.context).toBe('{"page":"home","note":"Page details are not shared with cloud AI."}');
    expect(out.messages).toEqual([messages[2]]);
    expect(out.allowed).toBe(true);
  });

  it('data browser: removes entries and the active table for withheld tables, keeps metadata tables', () => {
    const context = JSON.stringify({
      tables: [
        { id: 'todos', label: 'Todos', count: 3 },
        { id: 'journal', label: 'Journal', count: 40 },
        { id: 'app_state', label: 'App state', count: 9 },
        { id: 'mystery', label: 'Unknown', count: 1 },
      ],
      active: { id: 'journal', view: 'rows', columns: ['body'] },
      searching: false,
    });
    const out = applyPagePolicy({ page: 'data-browser', context, messages }, cloud());
    const ctx = JSON.parse(out.context);
    expect(ctx.tables.map((t) => t.id)).toEqual(['todos', 'app_state']);
    expect(ctx).not.toHaveProperty('active');
    expect(out.withheld).toEqual(['journal']);
    expect(out.messages).toEqual([messages[2]]);
  });

  it('data browser: an active table that is shared stays, and a null active id drops the active block', () => {
    const shared = JSON.stringify({ tables: [{ id: 'todos' }], active: { id: 'todos', view: 'rows' } });
    expect(JSON.parse(applyPagePolicy({ page: 'data-browser', context: shared, messages }, cloud()).context).active).toEqual({ id: 'todos', view: 'rows' });
    const none = JSON.stringify({ tables: [], active: { id: null, view: 'rows' } });
    expect(JSON.parse(applyPagePolicy({ page: 'data-browser', context: none, messages }, cloud()).context)).not.toHaveProperty('active');
  });
});

describe('filterBriefingSnapshot', () => {
  const snapshot = {
    today: '2026-01-01',
    events: [{ summary: 'e' }],
    openTodos: [{ title: 't' }],
    overdueTodos: [],
    overdueCount: 0,
    dueTodayTodos: [],
    dueTodayCount: 0,
    habitsRemaining: [{ title: 'h' }],
    habitsRemainingCount: 1,
    soonCountdowns: [],
    budget: { net: 1 },
    weather: { current: null },
    health: { readiness: 60 },
    surprise: 'not in the mapping',
  };

  it('local returns the snapshot unchanged', () => {
    expect(filterBriefingSnapshot(snapshot, local())).toEqual({ snapshot, shared: [], withheld: [] });
  });

  it('cloud keeps shared categories, no-category keys, drops withheld and unknown keys', () => {
    const out = filterBriefingSnapshot(snapshot, cloud());
    expect(Object.keys(out.snapshot)).toEqual([
      'today',
      'events',
      'openTodos',
      'overdueTodos',
      'overdueCount',
      'dueTodayTodos',
      'dueTodayCount',
      'habitsRemaining',
      'habitsRemainingCount',
      'soonCountdowns',
      'budget',
      'weather',
    ]);
    expect(out.shared).toEqual(['budget', 'todos', 'calendar', 'habits', 'countdowns']);
    expect(out.withheld).toEqual(['health']);
  });

  it('a category turned off removes exactly its keys', () => {
    const out = filterBriefingSnapshot(snapshot, cloud({ todos: false, budget: false }));
    for (const k of ['openTodos', 'overdueTodos', 'overdueCount', 'dueTodayTodos', 'dueTodayCount', 'budget']) expect(out.snapshot, k).not.toHaveProperty(k);
    expect(out.snapshot).toHaveProperty('events');
    expect(out.withheld).toEqual(['budget', 'todos', 'health']);
  });

  it('a withheld key with nothing in it is dropped quietly (no empty "not shared" notice)', () => {
    const empty = { today: '2026-01-01', openTodos: [], overdueCount: 0, budget: null, health: null, events: [] };
    const out = filterBriefingSnapshot(empty, cloud({ todos: false, budget: false, calendar: false }));
    expect(out.snapshot).toEqual({ today: '2026-01-01' });
    expect(out.withheld).toEqual([]);
  });

  it('everything on keeps every mapped key', () => {
    const out = filterBriefingSnapshot(snapshot, createAiPolicy({ isCloud: true, categories: allOn }));
    expect(out.snapshot).toHaveProperty('health');
    expect(out.snapshot).not.toHaveProperty('surprise');
    expect(out.withheld).toEqual([]);
  });
});
