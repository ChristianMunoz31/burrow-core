// An old export can never roll the license clock record back (docs/LICENSING.md 7.1).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { select } from '../../db/query.js';
import { importZipBuffer, PROTECTED_APP_STATE_KEYS } from '../../import/importExport.js';
import { CLOCK_STATE_KEY } from '../../license/constants.js';
import { closeTestDb, createTestDb, seedDb } from '../helpers/testDb.js';
import { T0 } from './helpers.js';

let db;
beforeEach(() => {
  db = createTestDb();
});
afterEach(() => closeTestDb(db));

describe('license.clock and import', () => {
  it('is a protected app_state key', () => {
    expect(PROTECTED_APP_STATE_KEYS.has(CLOCK_STATE_KEY)).toBe(true);
    expect(CLOCK_STATE_KEY).toBe('license.clock');
  });

  it('an archive with an older license.clock does not overwrite the stored record', () => {
    const current = { v: 1, hwm: T0, mac: 'A'.repeat(43) };
    seedDb(db, { app_state: [{ key: CLOCK_STATE_KEY, value: current }] });
    const old = { v: 1, hwm: T0 - 90 * 86_400_000, mac: 'B'.repeat(43) };
    const zip = zipSync({
      'manifest.json': strToU8(
        JSON.stringify({ format: 'burrow-export', formatVersion: 2, exportedAt: '2026-05-01T00:00:00.000Z', tables: [{ id: 'app_state' }] }),
      ),
      'json/app_state.json': strToU8(
        JSON.stringify([
          { key: CLOCK_STATE_KEY, value: old },
          { key: 'theme', value: 'dark' },
        ]),
      ),
    });
    const result = importZipBuffer(zip, { db });
    expect(result.tables.find((t) => t.id === 'app_state').skippedReasons.protected).toBe(1);
    expect(select('app_state', { where: { key: CLOCK_STATE_KEY }, db })[0].value).toEqual(current);
    expect(select('app_state', { where: { key: 'theme' }, db })[0].value).toBe('dark');
  });

  it('an archive cannot create the record on a machine that has none', () => {
    const zip = zipSync({
      'manifest.json': strToU8(
        JSON.stringify({ format: 'burrow-export', formatVersion: 2, exportedAt: '2026-05-01T00:00:00.000Z', tables: [{ id: 'app_state' }] }),
      ),
      'json/app_state.json': strToU8(JSON.stringify([{ key: CLOCK_STATE_KEY, value: { v: 1, hwm: T0, mac: 'C'.repeat(43) } }])),
    });
    importZipBuffer(zip, { db });
    expect(select('app_state', { where: { key: CLOCK_STATE_KEY }, db })).toHaveLength(0);
  });
});
