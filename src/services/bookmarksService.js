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

export const bookmarksService = {
  list: () => req('/bookmarks'),
  create: (bookmark) => req('/bookmarks', { method: 'POST', body: JSON.stringify(bookmark) }),
  update: (id, patch) => req(`/bookmarks/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  remove: (id) => req(`/bookmarks/${id}`, { method: 'DELETE' }),
};
