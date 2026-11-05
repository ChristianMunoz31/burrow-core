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

export const habitsService = {
  list: () => req('/habits'),
  create: (habit) => req('/habits', { method: 'POST', body: JSON.stringify(habit) }),
  update: (id, patch) =>
    req(`/habits/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  remove: (id) => req(`/habits/${id}`, { method: 'DELETE' }),
  markDone: (id, date) =>
    req(`/habits/${id}/completions`, {
      method: 'POST',
      body: JSON.stringify(date ? { date } : {}),
    }),
  unmarkDone: (id, date) =>
    req(`/habits/${id}/completions?date=${encodeURIComponent(date)}`, {
      method: 'DELETE',
    }),
};
