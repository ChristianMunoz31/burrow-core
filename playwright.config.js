import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

// Chromium only. No `webServer`: every spec file starts its own sandboxed Burrow server in
// beforeAll (e2e/support/burrowServer.js) so each file gets a fresh data dir. Needs `npm run build`.
// Projects (each matches its folder): flows, first-run, a11y, visual, and pro-flows (pro/e2e/flows, only when pro/e2e exists). The visual project only runs
// on Linux, because its baselines are rendered in the pinned Playwright container (see
// scripts/visualUpdate.js); anywhere else it is skipped, never silently compared.
const CI = Boolean(globalThis.process?.env?.CI);
const onLinux = globalThis.process?.platform === 'linux';

// The private Pro flows live in pro/e2e (absent in the public core checkout, so the project is then not defined).
const proE2e = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pro', 'e2e');
const hasPro = fs.existsSync(proE2e);

if (!onLinux && !globalThis.process?.env?.TEST_WORKER_INDEX) {
  console.log('[playwright] visual project skipped: baselines are Linux only (npm run test:visual:update renders them in Docker).');
}

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results',
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFileName}/{arg}{ext}',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: CI ? 2 : undefined,
  reporter: CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'flows', testMatch: 'flows/**/*.spec.js' },
    { name: 'first-run', testMatch: 'first-run/**/*.spec.js' },
    { name: 'a11y', testMatch: 'a11y/**/*.spec.js' },
    {
      name: 'visual',
      testMatch: 'visual/**/*.spec.js',
      ...(onLinux ? {} : { testIgnore: '**' }),
    },
    ...(hasPro ? [{ name: 'pro-flows', testDir: path.join(proE2e, 'flows'), testMatch: '**/*.spec.js' }] : []),
  ],
});
