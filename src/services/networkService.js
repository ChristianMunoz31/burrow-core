import { buildApiError } from '../utils/apiError';

const PROXY_URL = '/api';

async function req(path, options = {}) {
  const response = await fetch(`${PROXY_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw buildApiError(response, data);
  return data;
}

/**
 * @typedef {{ id: 'weather'|'oura'|'sheets'|'cloudAi'|'aiLan'|'updates', enabled: boolean, label: string,
 *   description: string, hosts: string[] }} NetworkFeature
 */

export const networkService = {
  /** @returns {Promise<{ features: NetworkFeature[] }>} */
  get: () => req('/settings/network'),
  /** @returns {Promise<{ features: NetworkFeature[] }>} */
  set: (id, enabled) =>
    req('/settings/network', { method: 'PUT', body: JSON.stringify({ id, enabled }) }),
};
