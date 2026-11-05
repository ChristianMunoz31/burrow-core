// The location the forecast is for. The user types a latitude and longitude in Settings > Network (or fills them
// from a "Use my location" click and saves them); it is stored on this computer in app_state `weather.location` as
// { lat, lon }, rounded to 2 decimals (about 1 km). It is ordinary user data: exported, imported (validated again on
// every read), erased by Erase all my data and restored with a backup. Only PUT/DELETE /api/settings/weather-location
// write it (ROUTE_OWNED_STATE_KEYS keeps PUT /api/state from bypassing the validation). Saving makes no network call:
// the forecast request itself stays behind requireNetwork('weather') / assertNetworkEnabled('weather').
import { getState, setState } from './dataAccess.js';
import { remove } from './db/index.js';

export const WEATHER_LOCATION_KEY = 'weather.location';
const MAX_INPUT_DECIMALS = 4;
/** Fixed copy for a refused location, shared by the settings route and GET /api/weather. */
export const INVALID_LOCATION_MESSAGE =
  'Enter a latitude from -90 to 90 and a longitude from -180 to 180, with up to 4 decimals.';

/** Round to 2 decimals, never returning -0. */
const round2 = (n) => {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
};

function decimalsOf(raw) {
  const s = String(raw).trim();
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

/** A plain decimal number (number or numeric string) inside [min, max] with at most 4 decimals, else null. */
function coordinate(raw, min, max) {
  if (typeof raw === 'number') {
    // A number that prints with an exponent (1e-7, 1e+21) is refused like the string form '1e2'.
    if (!Number.isFinite(raw) || /e/i.test(String(raw))) return null;
  } else if (typeof raw !== 'string' || !/^\s*-?\d{1,3}(\.\d+)?\s*$/.test(raw)) {
    return null;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  if (decimalsOf(typeof raw === 'number' ? String(n) : raw) > MAX_INPUT_DECIMALS) return null;
  return n;
}

/**
 * Validates a location typed by the user. Returns the rounded { lat, lon } or null when invalid.
 * @param {unknown} body
 * @returns {{ lat: number, lon: number } | null}
 */
export function parseWeatherLocation(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 2 || !keys.includes('lat') || !keys.includes('lon')) return null;
  const lat = coordinate(body.lat, -90, 90);
  const lon = coordinate(body.lon, -180, 180);
  if (lat === null || lon === null) return null;
  return { lat: round2(lat), lon: round2(lon) };
}

/** A stored value (it may come from an import): only a well-formed one is used, else null. */
function fromStored(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const lat = typeof raw.lat === 'number' ? raw.lat : NaN;
  const lon = typeof raw.lon === 'number' ? raw.lon : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat: round2(lat), lon: round2(lon) };
}

/** @returns {Promise<{ lat: number, lon: number } | null>} */
export async function getSavedWeatherLocation() {
  return fromStored(await getState(WEATHER_LOCATION_KEY, null));
}

/** @param {{ lat: number, lon: number }} location already validated by parseWeatherLocation */
export async function saveWeatherLocation(location) {
  await setState(WEATHER_LOCATION_KEY, { lat: location.lat, lon: location.lon });
  return { lat: location.lat, lon: location.lon };
}

export async function clearWeatherLocation() {
  remove('app_state', { where: { key: WEATHER_LOCATION_KEY } });
}

const present = (v) => v !== undefined && v !== null && v !== '';

/**
 * Where the forecast is for: explicit coordinates (an API caller), then the saved location, then the server's
 * WEATHER_LAT / WEATHER_LON. Null when there is none. Makes no network call.
 * @param {{ lat?: unknown, lon?: unknown }} [explicit]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ lat: unknown, lon: unknown, source: 'query' | 'saved' | 'default' } | null>}
 */
export async function resolveWeatherLocation(explicit = {}, env = process.env) {
  if (present(explicit.lat) && present(explicit.lon)) return { lat: explicit.lat, lon: explicit.lon, source: 'query' };
  // Storage unavailable: fall through to the server default.
  const saved = await getSavedWeatherLocation().catch(() => null);
  if (saved) return { ...saved, source: 'saved' };
  if (present(env.WEATHER_LAT) && present(env.WEATHER_LON)) {
    return { lat: env.WEATHER_LAT, lon: env.WEATHER_LON, source: 'default' };
  }
  return null;
}
