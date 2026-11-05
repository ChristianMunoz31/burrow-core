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

export const notesService = {
  list: () => req('/notes'),
  create: (note) => req('/notes', { method: 'POST', body: JSON.stringify(note) }),
  update: (id, patch) => req(`/notes/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  remove: (id) => req(`/notes/${id}`, { method: 'DELETE' }),
};
