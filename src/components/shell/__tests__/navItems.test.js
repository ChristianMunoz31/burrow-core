import { describe, expect, it } from 'vitest';
import { NAV_GROUPS } from '../navItems';
import { JAVI_PAGE_KEYS } from '../../../constants/javiPages';
import { CLOUD_CATEGORY_IDS } from '../../../constants/cloudAi';

const rows = (group) => group.items.map((i) => [i.label, i.to]);

describe('NAV_GROUPS', () => {
  it('is Home, Calendar, the three sections and Settings, in that order', () => {
    expect(NAV_GROUPS.map((g) => [g.id, g.section])).toEqual([
      ['home', null],
      ['shared', null],
      ['money', 'Financials'],
      ['wellbeing', 'Health'],
      ['productivity', 'Productivity'],
      ['settings', null],
    ]);
  });

  it('lists every row in the owner order (not alphabetical)', () => {
    expect(NAV_GROUPS.map(rows)).toEqual([
      [['Home', '/']],
      [['Calendar', '/calendar']],
      [
        ['Budget', '/budget'],
        ['Subscriptions', '/budget/subscriptions'],
      ],
      [
        ['Journal', '/journal'],
        ['Habits', '/habits'],
        ['Sleep & activity', '/health'],
      ],
      [
        ['Todos', '/todos'],
        ['Notes', '/notes'],
        ['Focus', '/focus'],
        ['Countdowns', '/countdowns'],
        ['Bookmarks', '/bookmarks'],
        ['Folders', '/folders'],
      ],
      [['Settings', '/settings']],
    ]);
  });

  it('puts Home in the drawer and keeps only Settings out of it (drawer: false)', () => {
    const off = NAV_GROUPS.filter((g) => g.drawer === false).flatMap((g) => g.items.map((i) => i.label));
    expect(off).toEqual(['Settings']);
    expect(NAV_GROUPS[0].items[0]).toMatchObject({ to: '/', end: true });
  });

  it('keeps Budget inactive on its Subscriptions sibling', () => {
    const budget = NAV_GROUPS.flatMap((g) => g.items).find((i) => i.to === '/budget');
    expect(budget.exclude).toEqual(['/budget/subscriptions']);
  });

  it('shows the Health page as Sleep & activity, still found by "health" and "oura"', () => {
    const item = NAV_GROUPS.flatMap((g) => g.items).find((i) => i.to === '/health');
    expect(item.label).toBe('Sleep & activity');
    expect(item.keywords).toBe('health oura ring sleep readiness activity');
  });

  it('never names a section group like a page key or cloud category (sections are nav only)', () => {
    const sections = NAV_GROUPS.filter((g) => g.section).map((g) => g.id);
    expect(sections).toEqual(['money', 'wellbeing', 'productivity']);
    for (const id of sections) {
      expect(JAVI_PAGE_KEYS).not.toContain(id);
      expect(CLOUD_CATEGORY_IDS).not.toContain(id);
    }
  });

  it('has no Weather item and no old `modes` key; section groups define their heading icons', () => {
    const items = NAV_GROUPS.flatMap((g) => g.items);
    expect(items.some((i) => i.to === '/weather')).toBe(false);
    for (const g of NAV_GROUPS.filter((g) => g.section)) expect(g.icon).toBeDefined();
    for (const g of NAV_GROUPS.filter((g) => !g.section)) expect('icon' in g).toBe(false);
    // No workspaces: nothing on a group says which workspace owns it.
    for (const g of NAV_GROUPS) expect('workspace' in g).toBe(false);
    for (const item of items) expect('modes' in item).toBe(false);
  });
});
