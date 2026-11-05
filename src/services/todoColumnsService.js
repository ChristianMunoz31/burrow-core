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

export const todoColumnsService = {
  // Returns { columns: [...], source: 'default' | 'server' }
  list: () => req('/todo-columns'),
  create: ({ name, order, color } = {}) =>
    req('/todo-columns', {
      method: 'POST',
      body: JSON.stringify(clean({ name, order, color })),
    }),
  update: (id, { name, order, color } = {}) =>
    req(`/todo-columns/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(clean({ name, order, color })),
    }),
  remove: (id) => req(`/todo-columns/${id}`, { method: 'DELETE' }),
};
