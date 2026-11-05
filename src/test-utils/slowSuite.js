import { vi } from 'vitest';
import { configure } from '@testing-library/react';

/**
 * Raise the time limits for the current test file. For suites that render a whole page with its
 * providers: each test needs 2 to 5 s on an idle ARM64 laptop, so the 5 s default (and the 1 s
 * Testing Library waitFor default) trips as soon as the machine or CI runner is busy. Call once at
 * the top of the file. Limits only; a passing test is no slower.
 */
export function allowSlowSuite({ testTimeout = 30_000, asyncUtilTimeout = 5_000 } = {}) {
  vi.setConfig({ testTimeout });
  configure({ asyncUtilTimeout });
}
