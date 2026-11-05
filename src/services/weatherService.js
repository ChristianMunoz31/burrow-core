import { buildApiError } from '../utils/apiError';
const PROXY_URL = '/api';
const LOCATION_URL = `${PROXY_URL}/settings/weather-location`;

export const WEATHER_LOCATION_MISSING = 'weather_location_missing';

async function parse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = buildApiError(response, data);
    // No saved location and no server default: the UI points to Settings instead of a generic error.
    if (data?.error === WEATHER_LOCATION_MISSING) err.locationMissing = true;
    throw err;
  }
  return data;
}

export const weatherService = {
  // The server picks the location: the one saved in Settings > Network, else its own default. The answer is
  // no-store, so after a location change the next fetch always reaches the server.
  async fetch() {
    return parse(await fetch(`${PROXY_URL}/weather`));
  },
  /** @returns {Promise<{ lat: number, lon: number } | null>} */
  async getLocation() {
    return (await parse(await fetch(LOCATION_URL))).location ?? null;
  },
  async saveLocation({ lat, lon }) {
    const response = await fetch(LOCATION_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat, lon }),
    });
    return (await parse(response)).location ?? null;
  },
  async clearLocation() {
    await parse(await fetch(LOCATION_URL, { method: 'DELETE' }));
    return null;
  },
};
