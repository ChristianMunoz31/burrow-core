import { useEffect, useId, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { weatherService } from '../../services/weatherService';
import { requestDeviceLocation, validateLocationInput } from '../../utils/weatherLocation';
import { formErrorClass } from '../shared/formStyles';
import { BTN } from './pillStyles';

const INPUT =
  'glass-input min-h-9 w-28 rounded-md px-3 py-1.5 text-sm tabular-nums text-slate-slate100 placeholder-slate-slate500 sm:min-h-0';
const HELP = 'Type your latitude and longitude, or click Use my location. Burrow rounds them to 2 decimals.';
const GEO_FAILED =
  "Burrow couldn't get this computer's location. Type your latitude and longitude instead, then click Save.";
const SAVE_FAILED = "Couldn't save your location. Try again.";
const LOAD_FAILED = "Burrow couldn't load your saved location. Try again.";

/** The location the forecast is for, in the Weather row of Settings > Network (shown only while Weather is on). */
export default function WeatherLocationControl() {
  const queryClient = useQueryClient();
  const id = useId();
  const latId = `${id}-lat`;
  const lonId = `${id}-lon`;
  const statusId = `${id}-status`;
  const latRef = useRef(null);
  const lonRef = useRef(null);
  const loadErrorId = `${id}-load-error`;
  // Until the saved value has loaded, Save, Clear and Use my location stay off, so a Save never overwrites a value
  // this form never showed.
  const {
    data: saved,
    isSuccess: loaded,
    isError: loadFailed,
    isFetching: reloading,
    refetch,
  } = useQuery({
    queryKey: ['weatherLocation'],
    queryFn: () => weatherService.getLocation(),
    staleTime: Infinity,
  });
  const [lat, setLat] = useState('');
  const [lon, setLon] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null); // { tone: 'ok' | 'error' | 'muted', text, field? }

  useEffect(() => {
    if (!saved) return;
    /* eslint-disable react-hooks/set-state-in-effect */
    setLat(String(saved.lat));
    setLon(String(saved.lon));
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [saved]);

  // Reset, not invalidate: the old forecast is dropped at once (latestCachedWeather returns null, so Javi never
  // reads the previous place) and an open forecast refetches for the new location.
  const applied = (location) => {
    queryClient.setQueryData(['weatherLocation'], location);
    queryClient.resetQueries({ queryKey: ['weather'] });
  };

  const save = async () => {
    if (busy || !loaded) return;
    const parsed = validateLocationInput(lat, lon);
    if (parsed.error) {
      setStatus({ tone: 'error', text: parsed.error, field: parsed.field });
      (parsed.field === 'lon' ? lonRef : latRef).current?.focus();
      return;
    }
    setBusy(true);
    try {
      const location = await weatherService.saveLocation(parsed);
      applied(location);
      setLat(String(location.lat));
      setLon(String(location.lon));
      setStatus({ tone: 'ok', text: 'Saved. The forecast on Home uses this location.' });
    } catch {
      setStatus({ tone: 'error', text: SAVE_FAILED });
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await weatherService.clearLocation();
      applied(null);
      setLat('');
      setLon('');
      setStatus({ tone: 'muted', text: 'Location cleared.' });
    } catch {
      setStatus({ tone: 'error', text: SAVE_FAILED });
    } finally {
      setBusy(false);
    }
  };

  const useMine = async () => {
    if (busy || !loaded) return;
    setBusy(true);
    setStatus({ tone: 'muted', text: 'Finding your location...' });
    try {
      const found = await requestDeviceLocation();
      setLat(String(found.lat));
      setLon(String(found.lon));
      setStatus({ tone: 'muted', text: 'Location found. Click Save to use it.' });
    } catch {
      setStatus({ tone: 'error', text: GEO_FAILED });
    } finally {
      setBusy(false);
    }
  };

  const statusClass =
    status?.tone === 'error'
      ? formErrorClass
      : `text-xs ${status?.tone === 'ok' ? 'text-accent-green' : 'text-slate-slate400'}`;
  const locked = !loaded;
  const invalid = (field) => (status?.tone === 'error' && status.field === field ? true : undefined);

  return (
    <form
      aria-label="Weather location"
      className="mt-2"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <p className="mb-1 text-xs font-medium text-slate-slate300">Location</p>
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor={latId} className="block text-xs text-slate-slate400">
            Latitude
          </label>
          <input
            id={latId}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            placeholder="40.71"
            value={lat}
            ref={latRef}
            disabled={locked}
            aria-invalid={invalid('lat')}
            aria-describedby={loadFailed ? loadErrorId : statusId}
            onChange={(e) => {
              setLat(e.target.value);
              setStatus(null);
            }}
            className={INPUT}
          />
        </div>
        <div>
          <label htmlFor={lonId} className="block text-xs text-slate-slate400">
            Longitude
          </label>
          <input
            id={lonId}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            placeholder="-74.01"
            value={lon}
            ref={lonRef}
            disabled={locked}
            aria-invalid={invalid('lon')}
            aria-describedby={loadFailed ? loadErrorId : statusId}
            onChange={(e) => {
              setLon(e.target.value);
              setStatus(null);
            }}
            className={INPUT}
          />
        </div>
        <button type="submit" disabled={busy || locked} className={BTN}>
          Save
        </button>
        <button type="button" disabled={busy || locked} onClick={useMine} className={BTN}>
          Use my location
        </button>
        {saved && (
          <button type="button" disabled={busy} onClick={clear} className={BTN}>
            Clear
          </button>
        )}
      </div>
      {loadFailed ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <p id={loadErrorId} role="alert" className={formErrorClass}>
            {LOAD_FAILED}
          </p>
          <button type="button" disabled={reloading} onClick={() => refetch()} className={BTN}>
            Retry
          </button>
        </div>
      ) : (
        <p id={statusId} role="status" className={`mt-1.5 ${statusClass}`}>
          {status?.text ?? HELP}
        </p>
      )}
    </form>
  );
}
