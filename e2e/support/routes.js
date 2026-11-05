// Every routed page in src/App.jsx. A vitest test (server/__tests__/e2eRoutes.test.js) parses App.jsx
// and fails when this list drifts, so a new page cannot ship without an e2e navigation check.
// `pattern` is the `<Route path>` value; `path` is the URL the tests open.
// `heading` is the page's h2 text. `via` is how a person reaches it in the shell: the top bar's
// `wordmark` (Home, also the first menu row) or `gear` (Settings), the `drawer` (the menu link's name is
// the heading; `section` is its menu dropdown, `Financials`, `Health` or `Productivity`, and absent for
// Calendar below the divider), or `url` only. `redirectsTo` marks a route that only redirects (App.jsx `<Navigate>`).
export const ROUTES = Object.freeze([
  { pattern: '/', path: '/', heading: 'Overview', via: 'wordmark' },
  { pattern: '/budget/*', path: '/budget', heading: 'Budget', via: 'drawer', section: 'Financials' },
  // Redirects to Home (the Javi card there shows the weather).
  { pattern: '/weather', path: '/weather', heading: 'Overview', via: 'url', redirectsTo: '/' },
  { pattern: '/health', path: '/health', heading: 'Sleep & activity', via: 'drawer', section: 'Health' },
  { pattern: '/todos', path: '/todos', heading: 'Todos', via: 'drawer', section: 'Productivity' },
  { pattern: '/habits', path: '/habits', heading: 'Habits', via: 'drawer', section: 'Health' },
  { pattern: '/focus', path: '/focus', heading: 'Focus', via: 'drawer', section: 'Productivity' },
  { pattern: '/folders', path: '/folders', heading: 'Folders', via: 'drawer', section: 'Productivity' },
  { pattern: '/countdowns', path: '/countdowns', heading: 'Countdowns', via: 'drawer', section: 'Productivity' },
  { pattern: '/calendar', path: '/calendar', heading: 'Calendar', via: 'drawer' },
  { pattern: '/journal', path: '/journal', heading: 'Journal', via: 'drawer', section: 'Health' },
  { pattern: '/notes', path: '/notes', heading: 'Notes', via: 'drawer', section: 'Productivity' },
  { pattern: '/bookmarks', path: '/bookmarks', heading: 'Bookmarks', via: 'drawer', section: 'Productivity' },
  { pattern: '/settings', path: '/settings', heading: 'Settings', via: 'gear' },
  { pattern: '/settings/data', path: '/settings/data', heading: 'Browse your data', via: 'url' },
]);

export const ROUTE_PATTERNS = Object.freeze(ROUTES.map((r) => r.pattern));

// The pages the a11y project scans: a redirect lands on a page already in the list, so it is not scanned twice.
export const A11Y_ROUTES = Object.freeze(ROUTES.filter((r) => !r.redirectsTo));
