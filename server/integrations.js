// External read-only integrations (Open-Meteo weather, Oura health) extracted so
// both the Express routes in server.js AND the Javi tools / daily briefing can
// call them without an HTTP round-trip. They fetch + shape data and throw tagged
// errors; the caller decides how to respond. Each network call is gated by the
// user's opt-in (server/netPolicy.js): a gated-off call throws NetworkOptInError
// before any request is made.
import fetch from 'node-fetch';
import { assertNetworkEnabled } from './netPolicy.js';
import { recordNetworkCall, statusFromHttp } from './networkCall.js';

export function ymd(d) {
  return d.toISOString().slice(0, 10);
}

// --- Weather (Open-Meteo, no API key) ---
// Returns the raw Open-Meteo forecast payload. Throws on invalid coords or a
// non-2xx upstream (tagged with `.status` + `.body`).
export async function fetchWeather({ lat, lon }) {
  const nlat = Number(lat);
  const nlon = Number(lon);
  if (
    !Number.isFinite(nlat) || !Number.isFinite(nlon) ||
    nlat < -90 || nlat > 90 || nlon < -180 || nlon > 180
  ) {
    throw Object.assign(new Error('Invalid lat/lon'), { status: 400 });
  }
  await assertNetworkEnabled('weather');
  // Only rounded coordinates leave the computer (2 decimals, about 1 km), whatever the caller passed.
  const r2 = (n) => {
    const r = Math.round(n * 100) / 100;
    return Object.is(r, -0) ? 0 : r;
  };
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${r2(nlat)}&longitude=${r2(nlon)}&current=temperature_2m,weather_code,wind_speed_10m,wind_direction_10m&daily=temperature_2m_max,temperature_2m_min,weather_code&forecast_days=7&timezone=auto&temperature_unit=fahrenheit&wind_speed_unit=mph`;
  let response;
  try {
    response = await fetch(url);
  } catch (err) {
    await recordNetworkCall('weather', url, 'error');
    throw err;
  }
  await recordNetworkCall('weather', url, statusFromHttp(response.status));
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(`Open-Meteo ${response.status}`), { status: response.status, body: data });
  }
  return data;
}

// --- Health (Oura Ring v2, Personal Access Token) ---
// Returns { days, source }. With no saved token it throws a `not_configured` error
// (status 503); callers treat that as "no health data".
const OURA_TIMEOUT_MS = 8000;
const OURA_MAX_PAGES = 5;
const OURA_DEADLINE_MS = 15000; // one overall budget per fetchOura call

const isAbortError = (err) => err?.name === 'TimeoutError' || err?.name === 'AbortError';
const timeoutError = (name) =>
  Object.assign(new Error(`Oura ${name} timed out`), { name: 'TimeoutError', code: 'timeout' });

// Aborts when any of the signals does. AbortSignal.any where available, else a manual controller.
function anySignal(signals) {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

// Never trust the caller: NaN, floats and out-of-range values fall back or clamp to 1..90.
function clampDays(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n === 0) return 14;
  return Math.min(90, Math.max(1, n));
}

export async function fetchOura(token, { days: requestedDays = 14 } = {}) {
  const windowDays = clampDays(requestedDays);
  if (!token) {
    throw Object.assign(new Error('Oura token not configured'), { code: 'not_configured', status: 503 });
  }
  await assertNetworkEnabled('oura');

  const end = new Date();
  const start = new Date(end.getTime() - (windowDays - 1) * 24 * 60 * 60 * 1000);
  const qs = `?start_date=${ymd(start)}&end_date=${ymd(end)}`;
  const base = 'https://api.ouraring.com/v2/usercollection';
  const headers = { Authorization: `Bearer ${token}` };
  const deadline = AbortSignal.timeout(OURA_DEADLINE_MS);
  const fetchPage = async (name, nextToken) => {
    const url = `${base}/${name}${qs}${nextToken ? `&next_token=${encodeURIComponent(nextToken)}` : ''}`;
    let r;
    try {
      r = await fetch(url, { headers, signal: anySignal([deadline, AbortSignal.timeout(OURA_TIMEOUT_MS)]) });
    } catch (err) {
      if (isAbortError(err)) throw timeoutError(name);
      throw err;
    }
    let body;
    try {
      body = await r.json();
    } catch (err) {
      // An abort mid-body on a 2xx is a timeout, not an empty page; non-ok bodies may be junk.
      if (r.ok && isAbortError(err)) throw timeoutError(name);
      body = {};
    }
    if (!r.ok) {
      throw Object.assign(new Error(body.detail || body.message || `Oura ${name} ${r.status}`), {
        status: r.status,
      });
    }
    return body;
  };
  const fetchCollection = async (name) => {
    const rows = [];
    let nextToken = null;
    for (let page = 0; page < OURA_MAX_PAGES; page += 1) {
      const body = await fetchPage(name, nextToken);
      if (Array.isArray(body.data)) rows.push(...body.data);
      nextToken = typeof body.next_token === 'string' && body.next_token ? body.next_token : null;
      if (!nextToken) break;
    }
    return rows;
  };

  // One row means one feature use: the four collections (and their pages) are a single Oura fetch.
  // fetchPage throws on any non-2xx/3xx answer, so reaching the success row means every request was ok.
  let readiness;
  let sleepDaily;
  let activity;
  let sleep;
  try {
    [readiness, sleepDaily, activity, sleep] = await Promise.all([
      fetchCollection('daily_readiness'),
      fetchCollection('daily_sleep'),
      fetchCollection('daily_activity'),
      fetchCollection('sleep'),
    ]);
  } catch (err) {
    await recordNetworkCall('oura', base, 'error');
    throw err;
  }
  await recordNetworkCall('oura', base, 'ok');

  // Pick one sleep record per day (the main long sleep, else the longest).
  const sleepByDay = new Map();
  for (const s of sleep) {
    if (!s.day) continue;
    const cur = sleepByDay.get(s.day);
    const isLong = s.type === 'long_sleep';
    if (
      !cur ||
      (isLong && cur.type !== 'long_sleep') ||
      (isLong === (cur.type === 'long_sleep') &&
        (s.total_sleep_duration || 0) > (cur.total_sleep_duration || 0))
    ) {
      sleepByDay.set(s.day, s);
    }
  }

  const byDay = new Map();
  const ensure = (day) => {
    if (!byDay.has(day)) {
      byDay.set(day, {
        day,
        readiness: null,
        sleep: null,
        activity: null,
        steps: null,
        activeCalories: null,
        restingHr: null,
        hrv: null,
        sleepHours: null,
      });
    }
    return byDay.get(day);
  };
  for (const r of readiness) if (r.day) ensure(r.day).readiness = r.score ?? null;
  for (const s of sleepDaily) if (s.day) ensure(s.day).sleep = s.score ?? null;
  for (const a of activity) {
    if (!a.day) continue;
    const row = ensure(a.day);
    row.activity = a.score ?? null;
    row.steps = a.steps ?? null;
    row.activeCalories = a.active_calories ?? null;
  }
  for (const [day, s] of sleepByDay) {
    const row = ensure(day);
    row.restingHr = s.lowest_heart_rate ?? null;
    row.hrv = s.average_hrv ?? null;
    row.sleepHours =
      typeof s.total_sleep_duration === 'number'
        ? Math.round((s.total_sleep_duration / 3600) * 10) / 10
        : null;
  }

  const days = [...byDay.values()].sort((x, y) => x.day.localeCompare(y.day));
  return { days, source: 'oura' };
}
