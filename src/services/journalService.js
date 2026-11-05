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

function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export const journalService = {
  list: () => req('/journal'),
  create: ({ title, body, mood, tags, context, date } = {}) =>
    req('/journal', {
      method: 'POST',
      body: JSON.stringify(clean({ title, body, mood, tags, context, date })),
    }),
  update: (id, { title, body, mood, tags, context, date } = {}) =>
    req(`/journal/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(clean({ title, body, mood, tags, context, date })),
    }),
  remove: (id) => req(`/journal/${id}`, { method: 'DELETE' }),
};
