// The saved weather location (app_state `weather.location`): validation, its own routes, the forecast route's
// fallback order and the opt-in gate, the generic state route refusing it, and export, import and erase.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({
  default: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ current: { temperature_2m: 60 } }) })),
}));

import fetch from 'node-fetch';
import { getState, setState } from '../dataAccess.js';
import { remove } from '../db/index.js';
import {
  WEATHER_LOCATION_KEY,
  getSavedWeatherLocation,
  parseWeatherLocation,
  resolveWeatherLocation,
} from '../weatherLocation.js';
import { buildExportZip } from '../exportRoutes.js';
import { importZipBuffer } from '../import/importExport.js';
import { closeTestDb, createTestDb, resetDb, rowsOf, seedDb } from './helpers/testDb.js';

const ENV_KEYS = ['BURROW_NETWORK_OPTIN', 'WEATHER_LAT', 'WEATHER_LON', 'APP_PASSWORD', 'AUTH_SECRET'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let app;
let n = 0;
const ip = () => `198.51.100.${(n += 1) % 250}`;
const get = (path) => request(app).get(path).set('X-Forwarded-For', ip());
const put = (path, body) => request(app).put(path).set('X-Forwarded-For', ip()).send(body);
const del = (path) => request(app).delete(path).set('X-Forwarded-For', ip());

beforeAll(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  app = (await import('../../server.js')).default;
});
afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
beforeEach(async () => {
  fetch.mockClear();
  delete process.env.BURROW_NETWORK_OPTIN;
  delete process.env.WEATHER_LAT;
  delete process.env.WEATHER_LON;
  remove('app_state', { where: { key: WEATHER_LOCATION_KEY } });
  remove('app_state', { where: { key: 'network.optIn' } });
});

describe('parseWeatherLocation', () => {
  it('accepts numbers and numeric strings in range, rounded to 2 decimals', () => {
    expect(parseWeatherLocation({ lat: 40.7128, lon: -74.006 })).toEqual({ lat: 40.71, lon: -74.01 });
    expect(parseWeatherLocation({ lat: '-90', lon: '180' })).toEqual({ lat: -90, lon: 180 });
    expect(parseWeatherLocation({ lat: '-0.001', lon: 0 })).toEqual({ lat: 0, lon: 0 });
  });

  it.each([
    [{ lat: 91, lon: 0 }],
    [{ lat: 0, lon: -180.5 }],
    [{ lat: 1.23456, lon: 0 }],
    [{ lat: 'abc', lon: 0 }],
    [{ lat: '1e2', lon: 0 }],
    [{ lat: 1e-7, lon: 0 }],
    [{ lat: 0, lon: -5e-7 }],
    [{ lat: '', lon: 0 }],
    [{ lat: null, lon: 0 }],
    [{ lat: Number.NaN, lon: 0 }],
    [{ lat: 1 }],
    [{ lat: 1, lon: 2, extra: 3 }],
    [[1, 2]],
    [null],
    ['1,2'],
  ])('refuses %j', (body) => {
    expect(parseWeatherLocation(body)).toBeNull();
  });
});

describe('/api/settings/weather-location', () => {
  it('saves, reads and clears the location, no-store, with no network call', async () => {
    expect((await get('/api/settings/weather-location')).body).toEqual({ location: null });
    const saved = await put('/api/settings/weather-location', { lat: 51.5074, lon: -0.1278 });
    expect(saved.status).toBe(200);
    expect(saved.headers['cache-control']).toBe('no-store');
    expect(saved.body).toEqual({ location: { lat: 51.51, lon: -0.13 } });
    expect(await getState(WEATHER_LOCATION_KEY)).toEqual({ lat: 51.51, lon: -0.13 });
    expect((await get('/api/settings/weather-location')).body).toEqual({ location: { lat: 51.51, lon: -0.13 } });
    expect((await del('/api/settings/weather-location')).body).toEqual({ location: null });
    expect(await getState(WEATHER_LOCATION_KEY)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([[{ lat: 100, lon: 0 }], [{ lat: 0, lon: 200 }], [{ lat: 1.12345, lon: 2 }], [{ lat: 'x', lon: 'y' }], [{}]])(
    'answers 400 invalid_location for %j and saves nothing',
    async (body) => {
      const res = await put('/api/settings/weather-location', body);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'invalid_location', code: 'invalid_location' });
      expect(await getState(WEATHER_LOCATION_KEY)).toBeNull();
    },
  );

  it('cannot be written through the generic state route', async () => {
    const res = await put(`/api/state/${WEATHER_LOCATION_KEY}`, { value: { lat: 'evil', lon: 1 } });
    expect(res.status).toBe(403);
    expect(await getState(WEATHER_LOCATION_KEY)).toBeNull();
  });
});

describe('GET /api/weather location order', () => {
  it('uses the saved location when the request has no coordinates', async () => {
    process.env.BURROW_NETWORK_OPTIN = 'weather';
    process.env.WEATHER_LAT = '10';
    process.env.WEATHER_LON = '20';
    await setState(WEATHER_LOCATION_KEY, { lat: 48.86, lon: 2.35 });
    const res = await get('/api/weather');
    expect(res.status).toBe(200);
    expect(res.body.locationSource).toBe('saved');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toContain('latitude=48.86&longitude=2.35');
  });

  it('falls back to WEATHER_LAT / WEATHER_LON, then answers 503 weather_location_missing', async () => {
    process.env.BURROW_NETWORK_OPTIN = 'weather';
    process.env.WEATHER_LAT = '10';
    process.env.WEATHER_LON = '20';
    const env = await get('/api/weather');
    expect(env.body.locationSource).toBe('default');
    expect(String(fetch.mock.calls[0][0])).toContain('latitude=10&longitude=20');
    delete process.env.WEATHER_LAT;
    delete process.env.WEATHER_LON;
    fetch.mockClear();
    const none = await get('/api/weather');
    expect(none.status).toBe(503);
    expect(none.body).toEqual({
      error: 'weather_location_missing',
      code: 'weather_location_missing',
      message: 'Set your location in Settings > Network to see the weather.',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends only coordinates rounded to 2 decimals, whatever the caller passed', async () => {
    process.env.BURROW_NETWORK_OPTIN = 'weather';
    const res = await get('/api/weather?lat=40.712776&lon=-74.005974');
    expect(res.status).toBe(200);
    expect(res.body.locationSource).toBe('query');
    expect(String(fetch.mock.calls[0][0])).toContain('latitude=40.71&longitude=-74.01&');
  });

  it('returns only current, daily and locationSource, never the coordinates or time zone Open-Meteo echoes', async () => {
    process.env.BURROW_NETWORK_OPTIN = 'weather';
    fetch.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        latitude: 40.71,
        longitude: -74.01,
        timezone: 'America/New_York',
        timezone_abbreviation: 'EDT',
        utc_offset_seconds: -14400,
        elevation: 10,
        generationtime_ms: 0.1,
        current_units: { temperature_2m: 'F' },
        daily_units: { temperature_2m_max: 'F' },
        current: { temperature_2m: 60 },
        daily: { time: ['2026-10-11'], temperature_2m_max: [70] },
      }),
    }));
    const res = await get('/api/weather?lat=40.71&lon=-74.01');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      current: { temperature_2m: 60 },
      daily: { time: ['2026-10-11'], temperature_2m_max: [70] },
      locationSource: 'query',
    });
  });

  it('makes no request while the Weather opt-in is off, even with a saved location', async () => {
    await setState(WEATHER_LOCATION_KEY, { lat: 48.86, lon: 2.35 });
    const res = await get('/api/weather');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('network_opt_in_required');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('ignores a malformed stored value (for example from an imported archive)', async () => {
    await setState(WEATHER_LOCATION_KEY, { lat: 'evil', lon: 500 });
    expect(await getSavedWeatherLocation()).toBeNull();
    expect(await resolveWeatherLocation({}, {})).toBeNull();
  });
});

describe('export, import and erase', () => {
  let src;
  let dest;
  beforeAll(() => {
    src = createTestDb();
    dest = createTestDb();
  });
  afterAll(() => {
    closeTestDb(src);
    closeTestDb(dest);
  });

  it('travels in the export ZIP and is imported (user data, not protected)', async () => {
    resetDb(src);
    resetDb(dest);
    seedDb(src, { app_state: [{ key: WEATHER_LOCATION_KEY, value: { lat: 1.5, lon: 2.5 } }] });
    const { zip } = await buildExportZip({ db: src });
    importZipBuffer(zip, { db: dest });
    const row = rowsOf(dest, 'app_state').find((r) => r.key === WEATHER_LOCATION_KEY);
    expect(row?.value).toEqual({ lat: 1.5, lon: 2.5 });
  });

  it('is not one of the rows Erase all my data keeps', async () => {
    const { KEPT_STATE_KEYS } = await import('../erase/eraseService.js');
    expect(KEPT_STATE_KEYS).not.toContain(WEATHER_LOCATION_KEY);
  });
});
