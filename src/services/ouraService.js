import { buildApiError } from '../utils/apiError';
const PROXY_URL = '/api';

async function get(path) {
  const response = await fetch(`${PROXY_URL}${path}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw buildApiError(response, data);
  }
  return data;
}

export const ouraService = {
  summary: () => get('/oura'),
  history: (days) => get(`/oura?days=${days}`),
};
