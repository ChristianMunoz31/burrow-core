import { clip } from '../javiContext';
import { buildWeatherContext } from './weather';

/**
 * `weather` (the forecast the Javi card loaded, only while Weather is on) adds code-computed facts: temperatures
 * and condition words, no coordinates. The server drops it for cloud AI (it is not in the Home allowlist).
 * @param {{ mode?: string, widgets?: string[], briefing?: { digest?: string, generatedAt?: string } | null,
 *   alerts?: Array<{ kind?: string, severity?: string, text?: string }>,
 *   weather?: { data?: object | null, locationSource?: string } | null }} input
 */
export function buildHomeContext({ mode, widgets, briefing, alerts, weather } = {}) {
  return {
    mode: mode ?? 'all',
    widgets: Array.isArray(widgets) ? widgets.slice(0, 20) : [],
    briefing: briefing?.digest ? clip(briefing.digest, 800) : null,
    briefingAt: briefing?.generatedAt ? clip(briefing.generatedAt, 30) : null,
    // `kind` (todo, habit, health, countdown, budget) lets the server drop alerts for data kinds
    // that must not go to a cloud provider.
    alerts: (Array.isArray(alerts) ? alerts : []).slice(0, 8).map((a) => ({
      kind: clip(a?.kind ?? '', 20),
      severity: clip(a?.severity ?? '', 20),
      text: clip(a?.text ?? '', 160),
    })),
    ...(weather?.data ? { weather: buildWeatherContext(weather) } : {}),
  };
}
