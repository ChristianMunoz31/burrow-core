import { buildApiError } from '../utils/apiError';

const PROXY_URL = '/api';

/**
 * One page of audit entries, newest first.
 * @param {{ before?: string | null, limit?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ entries: object[], nextBefore: string | null, available: boolean, reason?: string }>}
 */
async function list({ before, limit = 50, signal } = {}) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (before) params.set('before', before);
  const response = await fetch(`${PROXY_URL}/audit?${params.toString()}`, { cache: 'no-store', signal });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const err = buildApiError(response, body);
    err.code = body?.code ?? err.code;
    throw err;
  }
  const data = body?.data;
  if (!data || !Array.isArray(data.entries)) {
    throw new Error('Unexpected response from the activity log');
  }
  return data;
}

export const auditService = { list };
