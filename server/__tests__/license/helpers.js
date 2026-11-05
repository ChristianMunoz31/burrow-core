// Shared helpers for the licensing tests: fixed time constants, an activation record builder and an
// end-to-end harness (temp data dir, in-memory DB, injected clock and fetch).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { vi } from 'vitest';
import { initLicense, resetLicenseForTests } from '../../license/index.js';
import { __resetNetPolicyForTests } from '../../netPolicy.js';
import { closeTestDb, createTestDb } from '../helpers/testDb.js';
import { TEST_STORE_CONFIG } from './fixtures/storeResponses.js';

export const T0 = Date.parse('2026-10-05T12:00:00Z');
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
export const iso = (ms) => `${new Date(ms).toISOString().slice(0, 19)}Z`;

/** A stored activation record with string dates (the shape `activationStore.load()` returns). */
export function recordOf(overrides = {}) {
  return {
    v: 1,
    state: 'active',
    store: 'gumroad',
    productId: 'prod_test_123',
    variantId: null,
    edition: 'standard',
    purchaseDate: '2026-10-05T12:00:00Z',
    updatesUntil: '2027-10-05T12:00:00Z',
    expiresAt: null,
    activatedAt: '2026-10-05T12:00:00Z',
    keyHash: 'A'.repeat(43),
    keyLast4: '3333',
    email: 'buyer@example.com',
    instanceId: null,
    test: false,
    mac: 'B'.repeat(43),
    ...overrides,
  };
}

/** @returns {{ kind: 'active', record: object }} */
export const activeOf = (overrides = {}) => ({ kind: 'active', record: recordOf(overrides) });

export const BUILD = Object.freeze({
  buildDate: Date.parse('2026-10-05T12:00:00Z'),
  buildDateIso: '2026-10-05T12:00:00Z',
  source: 'git',
  version: '0.1.0',
});

/**
 * Temp data dir + in-memory DB + injected clock and fetch. `init()` (re)starts the licensing module.
 * Call `cleanup()` in afterEach.
 */
export function createHarness() {
  const h = {
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-lic-')),
    db: createTestDb(),
    ikm: randomBytes(32),
    clock: { t: T0, m: 1000 },
    logs: [],
    fetch: vi.fn(async () => {
      throw new Error('unexpected store request');
    }),
    keyOk: true,
  };
  __resetNetPolicyForTests();
  h.init = (extra = {}) =>
    initLicense({
      dataDir: h.dir,
      env: {},
      buildInfo: BUILD,
      now: () => h.clock.t,
      mono: () => h.clock.m,
      getDb: () => h.db,
      loadKey: () => (h.keyOk ? { ok: true, key: h.ikm } : { ok: false }),
      gatherEvidence: () => null,
      log: (m) => h.logs.push(m),
      fetchImpl: h.fetch,
      storeConfig: TEST_STORE_CONFIG,
      allowTest: false,
      // The pre-trial free state is the default for these tests; the lifecycle tests pass `autoStartTrial: true`.
      autoStartTrial: false,
      ...extra,
    });
  /** Moves wall and monotonic time together, as a running app sees real time pass. */
  h.advance = (ms) => {
    h.clock.t += ms;
    h.clock.m += ms;
  };
  h.cleanup = () => {
    resetLicenseForTests();
    __resetNetPolicyForTests();
    closeTestDb(h.db);
    fs.rmSync(h.dir, { recursive: true, force: true });
  };
  return h;
}
