// Erase all my data removes the saved weather location (it is user data, not one of the kept license rows).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, upsert } from '../db/index.js';
import { eraseAllData } from '../erase/eraseService.js';
import { resetLicenseForTests } from '../license/index.js';
import { WEATHER_LOCATION_KEY, getSavedWeatherLocation } from '../weatherLocation.js';
import { cleanupBackupEnv } from './helpers/backupEnv.js';
import { freshDb, stateKeys } from './helpers/eraseEnv.js';

beforeEach(() => {
  freshDb();
});
afterEach(() => {
  resetLicenseForTests();
  cleanupBackupEnv();
});

describe('erase and the weather location', () => {
  it('deletes weather.location', async () => {
    upsert('app_state', { key: WEATHER_LOCATION_KEY, value: { lat: 12.34, lon: 56.78 }, updated_at: new Date().toISOString() }, { conflict: ['key'] });
    expect(await getSavedWeatherLocation()).toEqual({ lat: 12.34, lon: 56.78 });
    await eraseAllData({ now: () => new Date('2026-10-11T12:00:00.000Z') });
    expect(stateKeys(getDb())).not.toContain(WEATHER_LOCATION_KEY);
    expect(await getSavedWeatherLocation()).toBeNull();
  });
});
