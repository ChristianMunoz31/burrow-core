// Top-level path segment ("/budget/planner" -> "/budget"); used as the content key.
export function routeKey(pathname) {
  return `/${pathname.split('/')[1] ?? ''}`;
}

// The page Back falls back to when there is no in-app history: /settings for its sub-pages, else Home.
export function parentPath(pathname) {
  return /^\/settings\/./.test(pathname) ? '/settings' : '/';
}
