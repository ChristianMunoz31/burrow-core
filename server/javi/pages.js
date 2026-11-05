// Javi page advisor: server-side page allowlist and size caps.
// Mirrors src/constants/javiPages.js (a parity test keeps the two in sync).
export const JAVI_CONTEXT_MAX_CHARS = 4000;
export const JAVI_MAX_MESSAGES = 12;
export const JAVI_MAX_MESSAGE_CHARS = 4000;
export const JAVI_MAX_TOTAL_MESSAGE_CHARS = 16000;

export const JAVI_PAGE_LABELS = Object.freeze({
  home: 'Home',
  budget: 'Budget',
  'budget-planner': 'Budget Planner',
  subscriptions: 'Subscriptions',
  todos: 'Todos',
  habits: 'Habits',
  focus: 'Focus',
  countdowns: 'Countdowns',
  calendar: 'Calendar',
  journal: 'Journal',
  notes: 'Notes',
  bookmarks: 'Bookmarks',
  health: 'Sleep & activity',
  settings: 'Settings',
  'data-browser': 'Browse your data',
});

/** @param {unknown} k */
export const isJaviPage = (k) =>
  typeof k === 'string' && Object.prototype.hasOwnProperty.call(JAVI_PAGE_LABELS, k);

const SPECIAL_PATHS = {
  home: '/',
  'budget-planner': '/budget/planner',
  subscriptions: '/budget/subscriptions',
  'data-browser': '/settings/data',
};

/** Route of each Javi page (the inbox item `to`); parity-tested against resolveJaviPageKey. */
export const JAVI_PAGE_PATHS = Object.freeze(
  Object.fromEntries(Object.keys(JAVI_PAGE_LABELS).map((k) => [k, SPECIAL_PATHS[k] ?? `/${k}`])),
);
