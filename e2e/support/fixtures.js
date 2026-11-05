// Shared Playwright `test`. Import `test` and `expect` from here, never from @playwright/test.
//
// - `useBurrow(opts)` starts one fresh server for the spec file (beforeAll) and stops it (afterAll).
//   Call it once at the top of the file; `baseURL` and `burrow` then point at that server.
// - Auto fixtures that fail a test on their own:
//     consoleErrors: any console `error` or uncaught page error. Opt out per test with
//       `test.info().annotations.push({ type: 'allow-console-errors', description: '<regex>' })`
//       (the description is optional; without it every console error is allowed).
//     browserNet: every request except the Burrow server origin (and data:/blob:) is aborted and
//       recorded; the test fails if the page tried to reach anything else.
import { test as base, expect } from '@playwright/test';
import { startBurrow } from './burrowServer.js';

let current = null;
const isHook = (testInfo) => / hook$/.test(testInfo.title) || !current;

/** The server started by `useBurrow` for the current spec file. */
export function currentServer() {
  if (!current) throw new Error('No Burrow server is running: call useBurrow() at the top of the spec file.');
  return current;
}

/**
 * Registers beforeAll/afterAll hooks that run a fresh Burrow server for this spec file.
 * @param {Parameters<typeof startBurrow>[0]} [opts]
 * @returns {{ readonly server: Awaited<ReturnType<typeof startBurrow>> }}
 */
export function useBurrow(opts = {}) {
  base.beforeAll(async () => {
    current = await startBurrow(opts);
  });
  base.afterAll(async () => {
    const server = current;
    current = null;
    await server?.stop();
  });
  return {
    get server() {
      return currentServer();
    },
  };
}

export const test = base.extend({
  // beforeAll/afterAll hooks also instantiate these fixtures, before the server exists: stay inert.
  // eslint-disable-next-line no-empty-pattern
  baseURL: async ({}, use) => {
    await use(current?.url);
  },

  // eslint-disable-next-line no-empty-pattern
  burrow: async ({}, use) => {
    await use(current);
  },

  consoleErrors: [
    async ({ page }, use, testInfo) => {
      const errors = [];
      if (isHook(testInfo)) {
        await use(errors);
        return;
      }
      page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(`console.error: ${msg.text()} (${msg.location().url})`);
      });
      page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
      await use(errors);
      const allow = testInfo.annotations.find((a) => a.type === 'allow-console-errors');
      if (allow) {
        const re = allow.description ? new RegExp(allow.description, 'i') : null;
        const left = re ? errors.filter((e) => !re.test(e)) : [];
        expect(left, 'unexpected console errors').toEqual([]);
        return;
      }
      expect(errors, 'the page logged console errors').toEqual([]);
    },
    { auto: true },
  ],

  browserNet: [
    async ({ context }, use, testInfo) => {
      const blocked = [];
      if (isHook(testInfo)) {
        await use(blocked);
        return;
      }
      const origin = new URL(currentServer().url).origin;
      await context.route('**/*', (route) => {
        const url = route.request().url();
        if (url.startsWith('data:') || url.startsWith('blob:') || new URL(url).origin === origin) return route.fallback();
        blocked.push(`${route.request().method()} ${url}`);
        return route.abort('blockedbyclient');
      });
      await use(blocked);
      expect(blocked, 'the browser tried to reach something other than the Burrow server').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
