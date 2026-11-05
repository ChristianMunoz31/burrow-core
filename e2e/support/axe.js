// Shared axe helpers for the a11y project.
import AxeBuilder from '@axe-core/playwright';
import { expect } from './fixtures.js';
import { A11Y_ROUTES } from './routes.js';

export const TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa'];
export const BLOCKING = new Set(['serious', 'critical']);

// Issue #22 (fixed): the "Ollama is running" status chip in Settings > AI. axe reports it as
// "incomplete" because of the gradient page background, so issue22.spec.js measures its contrast
// itself; this selector finds the chip there.
export const ISSUE_22_SELECTOR = '#ai [role="status"] span[class*="text-accent-green"]';

// KNOWN FINDING (no issue number yet): on /todos every kanban card is a dnd-kit sortable <div
// role="button" tabindex="0" aria-label="<title>"> that contains the card's own action buttons, so
// axe reports `nested-interactive` (serious). Only that rule, only on that page, is tolerated; every
// other rule still applies there. Remove this entry when the card stops nesting controls.
export const KNOWN_FINDINGS = [{ page: 'todos', rule: 'nested-interactive' }];

/** Runs axe on the current page; attaches the raw JSON and returns serious/critical violations. */
export async function scan(page, testInfo, { name, theme, rules, include, tolerate = [] } = {}) {
  let builder = new AxeBuilder({ page }).withTags(TAGS);
  if (rules) builder = builder.withRules(rules);
  if (include) builder = builder.include(include);
  const results = await builder.analyze();
  await testInfo.attach(`axe-${name}-${theme}.json`, {
    body: JSON.stringify({ url: results.url, violations: results.violations }, null, 2),
    contentType: 'application/json',
  });
  return results.violations.filter((v) => BLOCKING.has(v.impact) && !tolerate.includes(v.id));
}

/** Compact, readable failure message for a violation list. */
export function describe(violations) {
  return violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
}

/** The pages scanned in every theme: each route that is not a redirect, plus Settings > AI. */
export const PAGES = [
  ...A11Y_ROUTES.map((r) => ({ name: r.path === '/' ? 'home' : r.path.slice(1).replace(/\//g, '-'), url: r.path, heading: r.heading })),
  { name: 'settings-ai', url: '/settings#ai', heading: 'Settings' },
];

/** Registers one test per page for a theme. Call inside a spec file that already called useBurrow. */
export function registerThemeTests(test, theme) {
  test.describe(`axe ${theme}`, () => {
    for (const p of PAGES) {
      test(`${p.name} has no serious or critical violations`, async ({ page }, testInfo) => {
        await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
        await page.goto(p.url);
        await expect(page.getByRole('heading', { level: 2, name: p.heading, exact: true }).first()).toBeVisible();
        await page.waitForLoadState('networkidle');
        if (p.name === 'settings-ai') await expect(page.getByText('Ollama is running', { exact: true })).toBeVisible();
        const violations = await scan(page, testInfo, { name: p.name, theme,
          tolerate: KNOWN_FINDINGS.filter((f) => f.page === p.name).map((f) => f.rule),
        });
        expect(describe(violations), `axe violations on ${p.url} (${theme})`).toEqual([]);
      });
    }
  });
}
