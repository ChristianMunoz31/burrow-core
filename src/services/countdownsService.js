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

export const countdownsService = {
  list: () => req('/countdowns'),
  create: (countdown) => req('/countdowns', { method: 'POST', body: JSON.stringify(countdown) }),
  update: (id, patch) => req(`/countdowns/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  remove: (id) => req(`/countdowns/${id}`, { method: 'DELETE' }),
};
