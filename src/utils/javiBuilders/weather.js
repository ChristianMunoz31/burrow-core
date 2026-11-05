import { describeWeather } from '../weatherCodes';
import { round2 } from '../javiContext';
import { statusContext } from './_status';

const conditionOf = (code) => describeWeather(code)?.label ?? null;

/**
 * No coordinates are ever included.
 * @param {{ data?: object | null, locationSource?: string, loading?: boolean, error?: unknown }} input
 */
export function buildWeatherContext({ data, locationSource, loading, error } = {}) {
  const early = statusContext({ loading, error });
  if (early) return early;
  const cur = data?.current;
  const daily = data?.daily;
  const times = Array.isArray(daily?.time) ? daily.time : [];
  return {
    locationSource: locationSource ?? null,
    current: cur
      ? {
          tempF: round2(cur.temperature_2m),
          condition: conditionOf(cur.weather_code),
          windMph: round2(cur.wind_speed_10m),
        }
      : null,
    days: times.slice(0, 5).map((date, i) => ({
      date: String(date).slice(0, 10),
      highF: round2(daily.temperature_2m_max?.[i]),
      lowF: round2(daily.temperature_2m_min?.[i]),
      condition: conditionOf(daily.weather_code?.[i]),
    })),
  };
}
