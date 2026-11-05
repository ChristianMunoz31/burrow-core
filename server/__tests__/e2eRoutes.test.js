// ci:always-run (reads src/App.jsx as text, so `vitest related` cannot see the dependency)
// Drift guard: e2e/support/routes.js must list exactly the routes in src/App.jsx, so a new page
// cannot ship without the e2e navigation and first-run checks covering it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { A11Y_ROUTES, ROUTES, ROUTE_PATTERNS } from '../../e2e/support/routes.js';

const APP = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'App.jsx'), 'utf8');

/** Every `<Route path="..." ...>` in App.jsx, in source order. */
function appRoutes() {
  const out = [];
  for (const m of APP.matchAll(/<Route\s+path="([^"]+)"([^>]*)>/g)) {
    out.push({ pattern: m[1], redirect: /<Navigate\b/.test(m[2]) });
  }
  return out;
}

describe('e2e routes vs src/App.jsx', () => {
  const real = appRoutes().filter((r) => r.pattern !== '*');

  it('finds the routes in App.jsx (the parser itself still works)', () => {
    expect(real.length).toBeGreaterThanOrEqual(10);
    expect(real.map((r) => r.pattern)).toContain('/');
  });

  it('lists exactly the routes App.jsx declares, in the same order', () => {
    expect([...ROUTE_PATTERNS]).toEqual(real.map((r) => r.pattern));
  });

  it('wraps no route in a gate (every page opens by URL)', () => {
    expect(APP).not.toMatch(/ModeGate/);
    expect(ROUTES.some((r) => 'gated' in r)).toBe(false);
  });

  it('gives every route a concrete URL that matches its pattern and a heading', () => {
    for (const route of ROUTES) {
      const base = route.pattern.replace(/\/\*$/, '') || '/';
      expect(route.path, route.pattern).toBe(base);
      expect(route.path.startsWith('/'), route.pattern).toBe(true);
      expect(route.heading.trim().length, route.pattern).toBeGreaterThan(0);
    }
    expect(new Set(ROUTES.map((r) => r.path)).size).toBe(ROUTES.length);
  });

  it('marks exactly the redirect routes, and the a11y scan skips them (the page they land on is scanned)', () => {
    const redirects = real.filter((r) => r.redirect).map((r) => r.pattern);
    expect(redirects).toContain('/weather');
    expect(ROUTES.filter((r) => r.redirectsTo).map((r) => r.pattern)).toEqual(redirects);
    expect(A11Y_ROUTES.map((r) => r.pattern)).toEqual(real.filter((r) => !r.redirect).map((r) => r.pattern));
  });

  it('keeps the catch-all redirect in App.jsx (unknown URLs must not render a blank page)', () => {
    expect(appRoutes().some((r) => r.pattern === '*')).toBe(true);
  });
});
