// Import, export and the generic state route versus the stored activation (docs/LICENSING.md 5.5):
// license.activation is protected, never exported, never written by an archive or by PUT /api/state.
// Restore carrying is asserted in backupHardening.test.js.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { select } from '../../db/query.js';
import { buildExportZip } from '../../exportRoutes.js';
import { importZipBuffer, isProtectedAppStateKey, PROTECTED_APP_STATE_KEYS } from '../../import/importExport.js';
import { ACTIVATION_STATE_KEY, CLOCK_STATE_KEY, TRIAL_STATE_KEY } from '../../license/constants.js';
import { closeTestDb, createTestDb, seedDb } from '../helpers/testDb.js';
import { recordOf } from './helpers.js';

let db;
beforeEach(() => {
  db = createTestDb();
});
afterEach(() => closeTestDb(db));

const archive = (rows) =>
  zipSync({
    'manifest.json': strToU8(
      JSON.stringify({ format: 'burrow-export', formatVersion: 2, exportedAt: '2026-05-01T00:00:00.000Z', tables: [{ id: 'app_state' }] }),
    ),
    'json/app_state.json': strToU8(JSON.stringify(rows)),
  });
const stored = () => select('app_state', { where: { key: ACTIVATION_STATE_KEY }, db })[0]?.value;

describe('license.activation is a protected app_state key', () => {
  it('is in PROTECTED_APP_STATE_KEYS next to the clock and trial records', () => {
    expect(ACTIVATION_STATE_KEY).toBe('license.activation');
    for (const key of [ACTIVATION_STATE_KEY, CLOCK_STATE_KEY, TRIAL_STATE_KEY]) {
      expect(PROTECTED_APP_STATE_KEYS.has(key)).toBe(true);
      expect(isProtectedAppStateKey(key)).toBe(true);
    }
  });

  it('an archive cannot create the record on a machine that has none', () => {
    const result = importZipBuffer(archive([{ key: ACTIVATION_STATE_KEY, value: recordOf() }]), { db });
    expect(result.tables.find((t) => t.id === 'app_state').skippedReasons.protected).toBe(1);
    expect(stored()).toBeUndefined();
  });

  it('an archive cannot replace or roll back the stored record', () => {
    const live = { v: 1, state: 'cleared', clearedAt: '2026-10-05T12:00:00Z', mac: 'L'.repeat(43) };
    seedDb(db, { app_state: [{ key: ACTIVATION_STATE_KEY, value: live }] });
    importZipBuffer(
      archive([
        { key: ACTIVATION_STATE_KEY, value: recordOf({ edition: 'founding' }) },
        { key: 'theme', value: 'dark' },
      ]),
      { db },
    );
    expect(stored()).toEqual(live);
    expect(select('app_state', { where: { key: 'theme' }, db })[0].value).toBe('dark');
  });
});

describe('export skips the activation row', () => {
  it('has no license.activation row, email or key hash in any entry, while the clock and trial rows are kept', async () => {
    const record = recordOf({ email: 'buyer.activation@example.com', keyHash: 'K'.repeat(43) });
    seedDb(db, {
      app_state: [
        { key: ACTIVATION_STATE_KEY, value: record },
        { key: CLOCK_STATE_KEY, value: { v: 1, hwm: 1_790_000_000_000, mac: 'C'.repeat(43) } },
        { key: TRIAL_STATE_KEY, value: { v: 1, startedAt: 1_790_000_000_000, endsAt: 1_790_604_800_000, mac: 'T'.repeat(43) } },
        { key: 'theme', value: 'dark' },
      ],
    });
    const { zip, manifest } = await buildExportZip({ db });
    const files = unzipSync(new Uint8Array(zip));
    for (const [name, bytes] of Object.entries(files)) {
      const text = strFromU8(bytes);
      expect(text, name).not.toContain(ACTIVATION_STATE_KEY);
      expect(text, name).not.toContain('buyer.activation@example.com');
      expect(text, name).not.toContain('K'.repeat(43));
    }
    const rows = JSON.parse(strFromU8(files['json/app_state.json']));
    expect(rows.map((r) => r.key).sort()).toEqual([CLOCK_STATE_KEY, 'theme', TRIAL_STATE_KEY].sort());
    expect(manifest.tables.find((t) => t.id === 'app_state').rows).toBe(3);
  });

  it('an export of an install with only the activation row has an empty app_state', async () => {
    seedDb(db, { app_state: [{ key: ACTIVATION_STATE_KEY, value: recordOf() }] });
    const { zip } = await buildExportZip({ db });
    const files = unzipSync(new Uint8Array(zip));
    expect(JSON.parse(strFromU8(files['json/app_state.json']))).toEqual([]);
  });
});
