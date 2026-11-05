// Page catalogue for the Javi page advisor. Pure JS with NO imports: the backend
// parity test (server/__tests__/javiPagesParity.test.js) imports this from Node and
// compares it with server/javi/pages.js.

export const JAVI_CONTEXT_MAX_CHARS = 4000;
export const JAVI_MAX_MESSAGES = 12; // wire window sent to the server
export const JAVI_MAX_MESSAGE_CHARS = 4000; // server cap per message
export const JAVI_MAX_TOTAL_MESSAGE_CHARS = 16000; // server cap across the whole wire window
export const JAVI_MAX_INPUT_CHARS = 1000; // composer maxLength (user typing)

/** @type {Readonly<Record<string, { label: string, suggestions: readonly string[] }>>} */
export const JAVI_PAGES = Object.freeze({
  home: {
    label: 'Home',
    suggestions: ['What should I focus on today?', 'Anything overdue or at risk?'],
  },
  budget: {
    label: 'Budget',
    suggestions: ['Where am I overspending this month?', 'How is my savings rate trending?'],
  },
  'budget-planner': {
    label: 'Budget Planner',
    suggestions: ['Which envelopes should I adjust?', 'Is my plan realistic vs actual spend?'],
  },
  subscriptions: {
    label: 'Subscriptions',
    suggestions: ['What am I paying for every month?', 'Which subscriptions went up in price?'],
  },
  todos: {
    label: 'Todos',
    suggestions: ['What should I tackle first?', 'Which todos look stale?'],
  },
  habits: {
    label: 'Habits',
    suggestions: ['Which habit is slipping?', 'How do I protect my best streak?'],
  },
  focus: {
    label: 'Focus',
    suggestions: [
      'How much deep work did I do today?',
      'Suggest a focus plan for the rest of the day',
    ],
  },
  countdowns: {
    label: 'Countdowns',
    suggestions: ['What is coming up soonest?', 'What should I prepare this week?'],
  },
  calendar: {
    label: 'Calendar',
    suggestions: ['How busy is my week?', 'Where can I fit a focus block?'],
  },
  journal: {
    label: 'Journal',
    suggestions: ['Any patterns in my recent mood?', 'Give me a reflection prompt'],
  },
  notes: {
    label: 'Notes',
    suggestions: ['Summarize my pinned notes', 'Which notes should become todos?'],
  },
  bookmarks: {
    label: 'Bookmarks',
    suggestions: ['How could I organize these better?', 'Which categories are cluttered?'],
  },
  health: {
    label: 'Sleep & activity',
    suggestions: [
      'How is my recovery trending?',
      'What should I change tonight for better sleep?',
    ],
  },
  settings: { label: 'Settings', suggestions: ['Which settings should I review?'] },
  'data-browser': {
    label: 'Browse your data',
    suggestions: ['Which tables hold the most data?', 'Which sections are empty?'],
  },
});

export const JAVI_PAGE_KEYS = Object.freeze(Object.keys(JAVI_PAGES));

const hasPage = (key) => Object.prototype.hasOwnProperty.call(JAVI_PAGES, key);

/**
 * Pathname to page key, or null when the route is unknown.
 * @param {string} pathname
 * @returns {string | null}
 */
export function resolveJaviPageKey(pathname) {
  let path = String(pathname ?? '').toLowerCase();
  path = path.replace(/\/+$/, '');
  if (path === '') path = '/';
  if (path === '/') return 'home';
  if (path === '/budget/planner') return 'budget-planner';
  if (path === '/budget/subscriptions') return 'subscriptions';
  if (path === '/settings/data') return 'data-browser';
  if (path === '/weather') return 'home'; // redirects to Home, where the Javi card shows the weather
  const first = path.split('/')[1] ?? '';
  return hasPage(first) ? first : null;
}

/**
 * Page key for the Javi bar and window, or null where they are not shown: Home (the Javi card on Home
 * carries the insight and the briefing) and Settings with its sub-pages. Folders has no page key at all.
 * @param {string} pathname
 * @returns {string | null}
 */
export function resolveJaviBarPageKey(pathname) {
  const key = resolveJaviPageKey(pathname);
  return key === 'home' || key === 'settings' || key === 'data-browser' ? null : key;
}
