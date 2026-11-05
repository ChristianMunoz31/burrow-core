import { afterEach, describe, expect, it, vi } from 'vitest';
import { weatherService } from '../weatherService';

const ok = (body) => ({ ok: true, status: 200, json: async () => body });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('weatherService', () => {
  it('sends no coordinates and no fetch options (the server answers no-store)', async () => {
    const fetchMock = vi.fn(async () => ok({ current: {} }));
    vi.stubGlobal('fetch', fetchMock);
    await weatherService.fetch();
    await weatherService.fetch();
    expect(fetchMock.mock.calls).toEqual([['/api/weather'], ['/api/weather']]);
    expect(weatherService).not.toHaveProperty('locationChanged');
  });

  it('marks a missing location so the UI can point to Settings', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ error: 'weather_location_missing', message: 'x' }) })));
    await expect(weatherService.fetch()).rejects.toMatchObject({ status: 503, locationMissing: true });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ error: 'db_restoring' }) })));
    const err = await weatherService.fetch().catch((e) => e);
    expect(err.locationMissing).toBeUndefined();
  });

  it('saves and clears through the settings route', async () => {
    const fetchMock = vi.fn(async (url, init) => ok(init?.method === 'PUT' ? { location: { lat: 1.23, lon: 4.56 } } : { location: null }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await weatherService.saveLocation({ lat: 1.234, lon: 4.56 })).toEqual({ lat: 1.23, lon: 4.56 });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/settings/weather-location');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ lat: 1.234, lon: 4.56 });
    expect(await weatherService.clearLocation()).toBeNull();
    expect(fetchMock.mock.calls[1][1]).toEqual({ method: 'DELETE' });
  });
});
