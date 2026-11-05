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

// Strip undefined keys so partial patches don't clobber unset fields server-side.
function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export const todosService = {
  list: () => req('/todos'),
  create: ({ title, description, due, priority, status, context } = {}) =>
    req('/todos', {
      method: 'POST',
      body: JSON.stringify(clean({ title, description, due, priority, status, context })),
    }),
  update: (id, { title, description, done, due, priority, status, order, context } = {}) =>
    req(`/todos/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(clean({ title, description, done, due, priority, status, order, context })),
    }),
  // Bulk reorder: items is [{ id, status, order }].
  reorder: (items = []) =>
    req('/todos/reorder', {
      method: 'PATCH',
      body: JSON.stringify({ items }),
    }),
  remove: (id) => req(`/todos/${id}`, { method: 'DELETE' }),
};
