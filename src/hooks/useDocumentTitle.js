import { useEffect } from 'react';
import { matchPath } from 'react-router-dom';
import { NAV_GROUPS } from '../components/shell/navItems';

const APP_NAME = 'Burrow';
const NAV_ITEMS = NAV_GROUPS.flatMap((group) => group.items);

/**
 * Tab title for a path: "<Page> · Burrow", or just "Burrow" for Home and unknown paths.
 * The longest matching nav path wins, so /budget/subscriptions is Subscriptions, not Budget.
 * @param {string} pathname
 * @returns {string}
 */
export function titleForPath(pathname) {
  let best = null;
  for (const item of NAV_ITEMS) {
    if (!matchPath({ path: item.to, end: item.end ?? false }, pathname)) continue;
    if (!best || item.to.length > best.to.length) best = item;
  }
  if (!best || best.to === '/') return APP_NAME;
  return `${best.label} · ${APP_NAME}`;
}

/** Keeps document.title in step with the current route. */
export function useDocumentTitle(pathname) {
  useEffect(() => {
    document.title = titleForPath(pathname);
  }, [pathname]);
}
