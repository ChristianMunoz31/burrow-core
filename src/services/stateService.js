import { buildApiError } from '../utils/apiError';

const PROXY_URL = '/api';

async function req(path, options = {}) {
  const response = await fetch(`${PROXY_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw buildApiError(response, data);
  }
  return data;
}

// Several settings mount at once on first paint; share a single in-flight GET so
// they collapse into one request. Cleared once settled so later refetches re-hit.
let inflight = null;
function getAll() {
  if (!inflight) {
    inflight = req('/state').finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

export const stateService = {
  getAll,
  get: async (key) => {
    const map = await getAll();
    return map ? map[key] : undefined;
  },
  put: (key, value) =>
    req(`/state/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    }),
};
