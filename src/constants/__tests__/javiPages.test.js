import { describe, it, expect } from 'vitest';
import {
  JAVI_PAGES,
  JAVI_PAGE_KEYS,
  JAVI_MAX_TOTAL_MESSAGE_CHARS,
  resolveJaviBarPageKey,
  resolveJaviPageKey,
} from '../javiPages';

describe('resolveJaviPageKey', () => {
  it.each([
    ['/', 'home'],
    ['/budget', 'budget'],
    ['/budget/planner', 'budget-planner'],
    ['/budget/planner/', 'budget-planner'],
    ['/budget/subscriptions', 'subscriptions'],
    ['/budget/subscriptions/', 'subscriptions'],
    ['/settings', 'settings'],
    ['/settings/data', 'data-browser'],
    ['/TODOS', 'todos'],
    ['/github', null],
    ['/agents', null],
    ['/budget/other', 'budget'],
    ['/nope', null],
    ['/constructor', null],
    // Weather shows in the Javi card on Home: /weather (a redirect) is Home.
    ['/calendar', 'calendar'],
    ['/weather', 'home'],
    ['/weather/', 'home'],
  ])('%s -> %s', (path, key) => {
    expect(resolveJaviPageKey(path)).toBe(key);
  });
});

describe('JAVI_PAGES', () => {
  it('gives every key a label and at least one suggestion', () => {
    for (const key of JAVI_PAGE_KEYS) {
      expect(JAVI_PAGES[key].label).toBeTruthy();
      expect(JAVI_PAGES[key].suggestions.length).toBeGreaterThan(0);
    }
  });
});

describe('resolveJaviBarPageKey (where the Javi bar and window show)', () => {
  it.each([
    ['/', null],
    ['/weather', null],
    ['/settings', null],
    ['/settings/', null],
    ['/settings/x', null],
    ['/settings/data', null],
    ['/folders', null],
    ['/nope', null],
    ['/todos', 'todos'],
    ['/calendar', 'calendar'],
    ['/budget/planner', 'budget-planner'],
  ])('%s -> %s', (path, key) => {
    expect(resolveJaviBarPageKey(path)).toBe(key);
  });
});

describe('Calendar', () => {
  it('has one page key, calendar, labelled Calendar, and no weather key', () => {
    expect(JAVI_PAGE_KEYS).not.toContain('weather');
    expect(JAVI_PAGES.calendar.label).toBe('Calendar');
  });
});

describe('caps', () => {
  it('exports the total message cap', () => {
    expect(JAVI_MAX_TOTAL_MESSAGE_CHARS).toBe(16000);
  });
});
