import { buildApiError } from '../utils/apiError';

const PROXY_URL = '/api';

/**
 * One page of outbound connections, newest first (host only, never payloads).
 * @param {{ before?: string | null, limit?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ entries: object[], nextBefore: string | null }>}
 */
async function list({ before, limit = 50, signal } = {}) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (before) params.set('before', before);
  const response = await fetch(`${PROXY_URL}/privacy/network-activity?${params.toString()}`, { cache: 'no-store', signal });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw buildApiError(response, body);
  }
  const data = body?.data;
  if (!data || !Array.isArray(data.entries)) throw new Error('Unexpected response from network activity');
  return data;
}

export const networkActivityService = { list };
