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

export const calendarService = {
  list: () => req('/calendar'),
  create: ({ summary, description, location, start, end, allDay, context } = {}) =>
    req('/calendar/events', {
      method: 'POST',
      body: JSON.stringify({ summary, description, location, start, end, allDay, context }),
    }),
  update: (id, patch = {}) =>
    req(`/calendar/events/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  remove: (id) => req(`/calendar/events/${id}`, { method: 'DELETE' }),
  importIcs: (ics, context) =>
    req('/calendar/import', { method: 'POST', body: JSON.stringify({ ics, context }) }),
};
