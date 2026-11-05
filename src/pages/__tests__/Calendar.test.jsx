import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../../contexts/ToastContext';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import Calendar from '../Calendar';
import { PageContextProvider, usePageContextReader } from '../../contexts/PageContextContext';

// Calendar is calendar only: the forecast moved to the Javi card on Home. The data hooks are stubbed.
const h = vi.hoisted(() => ({
  calendar: { events: [], loading: false, error: null },
  weather: vi.fn(),
  reader: null,
}));

vi.mock('../../hooks/useCalendar', () => ({
  useCalendar: () => ({
    ...h.calendar,
    add: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    importIcs: vi.fn(),
    refresh: vi.fn(),
  }),
}));
// Any weather read from the Calendar page would be a regression.
vi.mock('../../hooks/useWeather', () => ({ useWeather: h.weather }));

function Reader() {
  const reader = usePageContextReader();
  useEffect(() => {
    h.reader = reader;
  });
  return null;
}

function renderPage(entry = '/calendar') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }) => (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={[entry]}>
          <PageContextProvider>{children}</PageContextProvider>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
  return render(
    <>
      <Calendar />
      <Reader />
    </>,
    { wrapper },
  );
}

const pageData = () => JSON.parse(h.reader.readPageContext('calendar').context).data;

beforeEach(() => {
  h.calendar = { events: [], loading: false, error: null };
  h.weather.mockReset();
});
afterEach(() => cleanup());

describe('Calendar page', () => {
  it('shows the Calendar heading and no weather section', () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 2, name: 'Calendar' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Weather' })).not.toBeInTheDocument();
    expect(document.getElementById('weather')).toBeNull();
    expect(screen.queryByText('Weather now')).not.toBeInTheDocument();
    expect(h.weather).not.toHaveBeenCalled();
  });

  it('keeps the forecast out of the calendar page context', async () => {
    renderPage('/calendar#weather');
    await waitFor(() => expect(h.reader.readPageContext('calendar').registered).toBe(true));
    const data = pageData();
    expect(data.weather).toBeUndefined();
    expect(data['events today']).toBe(0);
    expect(JSON.stringify(data)).not.toMatch(/forecast|weather/i);
  });
});
