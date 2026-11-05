import { buildApiError } from '../utils/apiError';

const PROXY_URL = '/api';

async function req(path, options = {}) {
  const response = await fetch(`${PROXY_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = buildApiError(response, data);
    if (!err.code) err.code = data.code;
    throw err;
  }
  return data;
}

const secretPath = (name) => `/secrets/${encodeURIComponent(name)}`;

/**
 * @typedef {{ name: string, label: string, provider: string, description: string,
 *   configured: boolean, source: 'settings'|'env'|'none', last4: string|null,
 *   updatedAt: string|null, envFallback: boolean, stale: boolean, testable: boolean }} SecretStatus
 */

export const secretsService = {
  /** @returns {Promise<{ encryption: object, storage: object, writable: boolean, secrets: SecretStatus[] }>} */
  list: () => req('/secrets'),
  /** The value goes straight into the request body; callers must not retain it. */
  save: (name, value) => req(secretPath(name), { method: 'PUT', body: JSON.stringify({ value }) }),
  remove: (name) => req(secretPath(name), { method: 'DELETE' }),
  test: (name) => req(`${secretPath(name)}/test`, { method: 'POST' }),
};
