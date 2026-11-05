// Client side of the saved weather location: input validation that mirrors server/weatherLocation.js, and the one
// place that asks the browser for the device location, only when the user clicks Use my location.

const NUMBER_RE = /^-?\d{1,3}(\.\d{1,4})?$/;
const round2 = (n) => {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
};

/**
 * Validates typed coordinates. Returns `{ lat, lon }` (numbers, up to 4 decimals) or `{ error }` with fixed copy.
 * @param {string} latText
 * @param {string} lonText
 */
export function validateLocationInput(latText, lonText) {
  const latS = String(latText ?? '').trim();
  const lonS = String(lonText ?? '').trim();
  const lat = NUMBER_RE.test(latS) ? Number(latS) : NaN;
  const lon = NUMBER_RE.test(lonS) ? Number(lonS) : NaN;
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    return { error: 'Latitude must be a number from -90 to 90, with up to 4 decimals.', field: 'lat' };
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    return { error: 'Longitude must be a number from -180 to 180, with up to 4 decimals.', field: 'lon' };
  }
  return { lat, lon };
}

const GEO_TIMEOUT_MS = 15_000;

/**
 * Asks the browser (the system permission in the desktop app) for the approximate device location, rounded to
 * 2 decimals. Call it only from a click. Rejects when it is unavailable, declined or does not answer in time.
 * @returns {Promise<{ lat: number, lon: number }>}
 */
export function requestDeviceLocation() {
  return new Promise((resolve, reject) => {
    const geo = typeof navigator === 'undefined' ? null : navigator.geolocation;
    if (!geo) {
      reject(new Error('unavailable'));
      return;
    }
    let done = false;
    // Some shells never answer an unanswered prompt: stop waiting.
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error('timeout'));
    }, GEO_TIMEOUT_MS + 1000);
    geo.getCurrentPosition(
      (pos) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ lat: round2(pos.coords.latitude), lon: round2(pos.coords.longitude) });
      },
      () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(new Error('denied'));
      },
      { enableHighAccuracy: false, timeout: GEO_TIMEOUT_MS, maximumAge: 10 * 60 * 1000 },
    );
  });
}
