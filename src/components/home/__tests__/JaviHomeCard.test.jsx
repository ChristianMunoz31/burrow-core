import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../hooks/useEntitlements', async () => (await import('../../../test-utils/entitlements.js')).entitlementsModule());
vi.mock('../../../hooks/useLicense', () => ({ useLicense: () => ({ status: null }) }));
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import JaviHomeCard from '../JaviHomeCard';
import { PageContextProvider, usePageContext } from '../../../contexts/PageContextContext';
import { useCachedWeatherReader } from '../../../hooks/useWeather';
import { FREE_STATE, resetEntitlementsState, setEntitlementsState } from '../../../test-utils/entitlements.js';
import { jsonResponse, sseEvent, sseResponse } from '../../../test-utils/sseResponse';

// Synthetic data only.
const h = vi.hoisted(() => ({ briefing: null, weatherOn: false, advice: null, calls: [], forecast: null, weatherStatus: 200, profile: null }));

const FORECAST = {
  latitude: 1.23,
  longitude: 4.56,
  current: { temperature_2m: 70.4, weather_code: 0, wind_speed_10m: 5 },
  daily: {
    time: ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13'],
    temperature_2m_max: [72.4, 68, 66, 60],
    temperature_2m_min: [55.2, 50, 49, 45],
    weather_code: [0, 3, 61, 0],
  },
};

function route(url, init) {
  const path = String(url);
  h.calls.push(path);
  if (path === '/api/jarvis/briefing') return Promise.resolve(jsonResponse(h.briefing ?? { empty: true }));
  if (path === '/api/settings/network') {
    return Promise.resolve(
      jsonResponse({ features: [{ id: 'weather', enabled: h.weatherOn, label: 'Weather', description: '', hosts: [] }] }),
    );
  }
  if (path === '/api/profile') return Promise.resolve(jsonResponse(h.profile ?? { displayName: null, onboardedAt: null }));
  if (path.startsWith('/api/weather')) return Promise.resolve(jsonResponse(h.forecast ?? FORECAST, h.weatherStatus));
  if (path.startsWith('/api/jarvis/advice')) return h.advice(path, init);
  return Promise.resolve(jsonResponse({}, 404));
}

function HomeContext() {
  const readWeather = useCachedWeatherReader();
  usePageContext('home', () => ({ widgets: ['todos'], weather: readWeather() }));
  return null;
}

function mount(props = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <PageContextProvider>
          <HomeContext />
          <JaviHomeCard {...props} />
        </PageContextProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const adviceCalls = () => h.calls.filter((p) => p.startsWith('/api/jarvis/advice'));
const reply = (content) =>
  Promise.resolve(
    sseResponse([sseEvent('meta', { ai: { kind: 'local', host: null } }), sseEvent('delta', { content }), sseEvent('done', { content })]),
  );

let geo;
beforeEach(() => {
  h.briefing = null;
  h.weatherOn = false;
  h.forecast = null;
  h.weatherStatus = 200;
  h.profile = null;
  localStorage.clear();
  h.calls = [];
  h.advice = vi.fn(() => reply('Two todos are due today.'));
  vi.stubGlobal('fetch', vi.fn(route));
  geo = { getCurrentPosition: vi.fn((ok) => ok({ coords: { latitude: 1.23, longitude: 4.56 } })) };
  Object.defineProperty(navigator, 'geolocation', { value: geo, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetEntitlementsState();
});

describe('JaviHomeCard', () => {
  it('Free automatically provides overall Home insight without prompting, then shows it with its source, Report and Refresh', async () => {
    setEntitlementsState(FREE_STATE);
    h.briefing = { generatedAt: new Date().toISOString(), digest: 'Trial briefing.', alerts: [], ai: null, withheld: [] };
    const user = userEvent.setup();
    mount();
    expect(await screen.findByText('Two todos are due today.')).toBeInTheDocument();
    expect(screen.queryByText('Trial briefing.')).not.toBeInTheDocument();
    expect(adviceCalls()).toEqual(['/api/jarvis/advice']);
    const body = JSON.parse(h.advice.mock.calls[0][1].body);
    expect(body).toMatchObject({ page: 'home', messages: [] });
    expect(JSON.parse(body.context).data.widgets).toEqual(['todos']);
    expect(screen.getByText('On this computer')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Report this Javi reply by email' })).toBeInTheDocument();

    h.advice.mockImplementation(() => reply('Fresh look at today.'));
    const refreshBtn = screen.getByRole('button', { name: 'Refresh insight' });
    expect(refreshBtn).toHaveAttribute('title', 'Refresh insight');
    expect(refreshBtn.textContent).toBe('');
    await user.click(refreshBtn);
    expect(await screen.findByText('Fresh look at today.')).toBeInTheDocument();
    expect(adviceCalls()).toEqual(['/api/jarvis/advice', '/api/jarvis/advice?fresh=1']);
  });

  it('shows the cut-short notice that came with the insight', async () => {
    setEntitlementsState(FREE_STATE);
    h.advice.mockImplementation(() =>
      Promise.resolve(sseResponse([sseEvent('delta', { content: 'Partial' }), sseEvent('done', { content: 'Partial', notice: 'Javi stopped early.' })])),
    );
    mount();
    expect(await screen.findByText('Javi stopped early.')).toBeInTheDocument();
    expect(adviceCalls()).toEqual(['/api/jarvis/advice']);
  });

  it('shows the AI setup copy when Javi cannot run, and Retry', async () => {
    setEntitlementsState(FREE_STATE);
    h.advice.mockImplementation(() =>
      Promise.resolve(jsonResponse({ error: 'ai_not_configured', reason: 'no_model', message: 'Javi needs a model.' }, 503)),
    );
    mount();
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText('Two todos are due today.')).not.toBeInTheDocument();
    expect(adviceCalls()).toEqual(['/api/jarvis/advice']);
  });

  it('with Weather off: no weather request, no location prompt, only a quiet Show weather link', async () => {
    setEntitlementsState(FREE_STATE);
    mount();
    const link = await screen.findByRole('link', { name: 'Show weather' });
    expect(link).toHaveAttribute('href', '/settings#network');
    await new Promise((r) => setTimeout(r, 30));
    expect(h.calls.some((p) => p.startsWith('/api/weather'))).toBe(false);
    expect(geo.getCurrentPosition).not.toHaveBeenCalled();
    expect(screen.queryByText(/°/)).not.toBeInTheDocument();
  });

  it('with Weather on integrates weather into Javi generated insight', async () => {
    setEntitlementsState(FREE_STATE);
    h.weatherOn = true;
    h.advice.mockImplementation((_path, init) => {
      const body = JSON.parse(init.body);
      const ctx = JSON.parse(body.context);
      const w = ctx.data?.weather;
      const text = w ? '70°, clear. Today 72° / 55°. Two todos are due today.' : 'Two todos are due today.';
      return reply(text);
    });
    mount();
    expect(await screen.findByText('70°, clear. Today 72° / 55°. Two todos are due today.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Show weather' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Weather' })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('1.23');
    expect(geo.getCurrentPosition).not.toHaveBeenCalled();
    expect(h.calls.find((p) => p.startsWith('/api/weather'))).toBe('/api/weather');
    expect(adviceCalls()).toEqual(['/api/jarvis/advice']);
  });

  it('renders a greeting solely within Javi overview insight reply with no duplicate header', async () => {
    h.advice = vi.fn(() => reply('Good morning, Demo. Two todos are due today, and your budget is on track.'));
    mount();
    expect(await screen.findByText('Good morning, Demo. Two todos are due today, and your budget is on track.')).toBeInTheDocument();
    // Exactly one area for greeting across the card (no duplicate greeting header)
    expect(screen.getAllByText(/Good morning/i)).toHaveLength(1);
    expect(screen.getByRole('status', { hidden: true })).toHaveTextContent('Javi replied.');
  });

  it('displays personalized greeting in overview insight when user has a display name', async () => {
    h.profile = { displayName: 'Sam', onboardedAt: '2026-01-01' };
    h.advice = vi.fn(() => reply('Good morning, Sam. Your schedule is clear today.'));
    mount();
    expect(await screen.findByText('Good morning, Sam. Your schedule is clear today.')).toBeInTheDocument();
    expect(screen.getAllByText(/Good morning, Sam/i)).toHaveLength(1);
  });

  it('constrains insight container so the card does not expand as text comes in', async () => {
    const { container } = mount();
    const scrollContainer = container.querySelector('.max-h-52');
    expect(scrollContainer).toBeInTheDocument();
    expect(scrollContainer).toHaveClass('overflow-y-auto', 'min-h-[8.5rem]');
  });

  it('with no saved location: never asks the browser, one muted line links to Settings', async () => {
    setEntitlementsState(FREE_STATE);
    h.weatherOn = true;
    h.weatherStatus = 503;
    h.forecast = { error: 'weather_location_missing', code: 'weather_location_missing', message: 'x' };
    mount();
    const link = await screen.findByRole('link', { name: 'Set your location in Settings to see the weather.' }, { timeout: 4000 });
    expect(link).toHaveAttribute('href', '/settings#network');
    expect(link.closest('[role="status"]')).not.toBeNull();
    expect(geo.getCurrentPosition).not.toHaveBeenCalled();
    expect(screen.queryByText(/Allow location/)).not.toBeInTheDocument();
  });

  it('another 503 (for example a restore in progress) is the generic line, not the Settings link', async () => {
    setEntitlementsState(FREE_STATE);
    h.weatherOn = true;
    h.weatherStatus = 503;
    h.forecast = { error: 'db_restoring', code: 'db_restoring', message: 'x' };
    mount();
    expect(await screen.findByText(/couldn't load the weather/, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Set your location/ })).not.toBeInTheDocument();
  });

  it('a weather error is a muted status line', async () => {
    setEntitlementsState(FREE_STATE);
    h.weatherOn = true;
    h.weatherStatus = 500;
    h.forecast = { error: 'upstream_failed', message: 'x' };
    mount();
    const line = await screen.findByText(/couldn't load the weather/, {}, { timeout: 4000 });
    expect(line).toHaveAttribute('role', 'status');
  });
});
