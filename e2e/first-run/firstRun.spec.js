// "I downloaded the app, I opened it, and it just worked."
//
// The built app on a brand-new, empty data dir with NO configuration: no BURROW_DATA_DIR,
// OLLAMA_HOST, BURROW_HOST, BURROW_SCHEDULER or opt-ins; only BURROW_PORT (a free port) plus the
// fake-home variables that make the server's per-OS default data dir land inside a temp folder.
// Tests run in order against one server (serial) because they share its data.
import os from 'node:os';
import path from 'node:path';
import { test, expect, useBurrow } from '../support/fixtures.js';
import { realDefaultDataDir, samePath } from '../../scripts/lib/sandboxSafety.js';
import { ROUTES } from '../support/routes.js';
import { onboarding } from '../pages/onboarding.js';
import { javi } from '../pages/javi.js';
import { todos } from '../pages/todos.js';
import { journal } from '../pages/journal.js';
import { nav } from '../pages/nav.js';

test.describe.configure({ mode: 'serial' });

const ctx = useBurrow({ firstRun: true, ollama: 'default', scheduler: true });

const BAD_TEXT = /error|failed|undefined|NaN|\[object/i;
const SETUP_WALL = /setup (is )?(required|needed)|you must (first )?(set up|configure)|before you can use|complete (the )?setup/i;

const isInside = (parent, child) => {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

test('the server uses a default data dir inside the temp folder, never the real one', async () => {
  const { server } = ctx;
  const real = realDefaultDataDir();
  const tmp = os.tmpdir();

  expect(isInside(tmp, server.expectedDataDir), 'expected data dir is inside the OS temp dir').toBe(true);
  expect(samePath(server.expectedDataDir, real), 'expected data dir is not the real one').toBe(false);
  expect(isInside(real, server.expectedDataDir) || isInside(server.expectedDataDir, real)).toBe(false);
  // The server itself reported the same data file after start.
  expect(samePath(server.reportedDbFile, path.join(server.expectedDataDir, 'burrow.db'))).toBe(true);
  expect(isInside(tmp, server.reportedDbFile)).toBe(true);

  // No configuration: nothing but the port (and test instrumentation) was handed to the server.
  const forbidden = [
    'BURROW_DATA_DIR',
    'BURROW_HOST',
    'BURROW_SCHEDULER',
    'BURROW_NETWORK_OPTIN',
    'OLLAMA_HOST',
    'BURROW_AI',
    'APP_PASSWORD',
    'AUTH_SECRET',
    'SECRETS_ENCRYPTION_KEY',
  ];
  for (const name of forbidden) expect(server.envKeys, `${name} must not be set`).not.toContain(name);
  expect(server.envKeys).toContain('BURROW_PORT');
});

test('onboarding completes with only a display name; the Ollama step can be skipped', async ({ page }) => {
  await page.goto('/');
  const flow = onboarding(page);
  await flow.expectVisible();
  await flow.continueWithName('Casey');

  // The Javi step never blocks: a visible skip control moves on.
  const step = page.getByRole('dialog', { name: 'Set up Javi' });
  await expect(step).toBeVisible();
  await expect(step.getByRole('button', { name: 'Skip for now' })).toBeVisible();
  await step.getByRole('button', { name: 'Skip for now' }).click();

  await flow.finishWithoutBudget();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 2, name: 'Overview' })).toBeVisible();
});

test('every route loads: no console errors, friendly empty states, no setup wall', async ({ page }) => {
  const n = nav(page);
  for (const route of ROUTES) {
    await test.step(route.path, async () => {
      await n.open(route);
      await page.waitForLoadState('networkidle');
      await expect(page.getByRole('dialog'), 'nothing may block the page').toHaveCount(0);
      const text = await page.locator('main').innerText();
      expect(text, `${route.path} shows raw error text`).not.toMatch(BAD_TEXT);
      expect(text, `${route.path} asks for setup`).not.toMatch(SETUP_WALL);
    });
  }
});

test('the app is useful without AI: Javi explains it needs Ollama, todos and journal still work', async ({ page }) => {
  // KNOWN FINDING (reported, not suppressed elsewhere): opening Javi with no Ollama makes the panel
  // call POST /api/jarvis/advice, which answers 503 ollama_unavailable, and Chrome logs that as a
  // console error even though the UI handles it well. Only that one request is allowed here;
  // remove this line when the panel skips the advice call while /api/jarvis/status says unavailable.
  test.info().annotations.push({ type: 'allow-console-errors', description: 'status of 503 .*/api/jarvis/advice' });
  // Journal, not Home: Home has the Javi card instead of the Javi bar.
  await page.goto('/journal');
  const j = javi(page);
  await j.open();
  await expect(j.needsOllama()).toBeVisible();
  // Friendly, with a way forward, and no raw error text.
  await expect(j.panel.getByRole('link', { name: /Settings > AI/ })).toBeVisible();
  expect(await j.panel.innerText()).not.toMatch(/failed|undefined|NaN|\[object|stack|ECONN/i);
  await j.close();

  await todos(page).open();
  await todos(page).add('Buy stamps');
  await expect(todos(page).item('Buy stamps')).toBeVisible();
  await page.reload();
  await expect(todos(page).item('Buy stamps')).toBeVisible();

  await journal(page).open();
  await journal(page).add('First entry, written without any AI.');
  await expect(journal(page).item('First entry, written without any AI.')).toBeVisible();
});

test('the whole first run made zero outbound network calls', async () => {
  // The server's recorder logs every attempt; "no Ollama" refusals on reserved loopback ports
  // are simulated and do not count. (The browser side is guarded by the browserNet fixture.)
  expect(ctx.server.outbound()).toEqual([]);
});
