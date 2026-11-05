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

/** @typedef {{ displayName: string|null, onboardedAt: string|null }} Profile */

export const profileService = {
  /** @returns {Promise<Profile>} */
  get: () => req('/profile'),
  /**
   * @param {{ displayName?: string|null, onboarded?: true }} patch
   * @returns {Promise<Profile>}
   */
  update: (patch) => req('/profile', { method: 'PUT', body: JSON.stringify(patch) }),
};
