import { buildApiError } from '../utils/apiError';

const PROXY_URL = '/api';

async function req(path) {
  const response = await fetch(`${PROXY_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = buildApiError(response, data);
    if (typeof data.code === 'string') err.code = data.code;
    throw err;
  }
  return data;
}

export const dataBrowserService = {
  listTables: () => req('/data/tables'),
  /** params: { page, pageSize, sort, order, q }; empty values are omitted. */
  getRows: (table, params = {}) => {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') qs.set(key, String(value));
    }
    const suffix = qs.toString();
    return req(`/data/tables/${encodeURIComponent(table)}${suffix ? `?${suffix}` : ''}`);
  },
  getOverview: (table) => req(`/data/tables/${encodeURIComponent(table)}/overview`),
};
