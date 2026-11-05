// Client for GET /api/app/info: the app version and which channel (stable or dev) this build is.
import { buildApiError } from '../utils/apiError';

/**
 * @returns {Promise<{ version: string, channel: 'stable'|'dev', desktop: boolean, commit?: string|null, buildDate?: string|null, devTools?: boolean }>}
 *   `devTools` is true only where the developer tier switcher is available (Burrow Dev, source checkouts)
 */
export async function getAppInfo() {
  const response = await fetch('/api/app/info', { cache: 'no-store' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw buildApiError(response, body);
  if (!body || typeof body.data !== 'object' || body.data === null) {
    throw new Error('The app info answer was not understood.');
  }
  return body.data;
}
