import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import WeatherLocationControl from '../WeatherLocationControl';
import { validateLocationInput } from '../../../utils/weatherLocation';
import { latestCachedWeather } from '../../../hooks/useWeather';

vi.mock('../../../services/weatherService', () => ({
  weatherService: { getLocation: vi.fn(), saveLocation: vi.fn(), clearLocation: vi.fn(), fetch: vi.fn() },
}));
import { weatherService } from '../../../services/weatherService';

const getCurrentPosition = vi.fn();

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <WeatherLocationControl />
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  Object.defineProperty(globalThis.navigator, 'geolocation', { value: { getCurrentPosition }, configurable: true });
  weatherService.getLocation.mockResolvedValue(null);
  weatherService.saveLocation.mockImplementation(async ({ lat, lon }) => ({
    lat: Math.round(lat * 100) / 100,
    lon: Math.round(lon * 100) / 100,
  }));
  weatherService.clearLocation.mockResolvedValue(null);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('validateLocationInput', () => {
  it('accepts coordinates in range with up to 4 decimals', () => {
    expect(validateLocationInput('40.7128', '-74.006')).toEqual({ lat: 40.7128, lon: -74.006 });
    expect(validateLocationInput(' -90 ', '180')).toEqual({ lat: -90, lon: 180 });
  });
  it.each([
    ['91', '0', 'lat'],
    ['', '0', 'lat'],
    ['1.23456', '0', 'lat'],
    ['abc', '0', 'lat'],
    ['0', '-181', 'lon'],
    ['0', '1e2', 'lon'],
  ])('refuses %s, %s', (lat, lon, field) => {
    expect(validateLocationInput(lat, lon)).toMatchObject({ field, error: expect.any(String) });
  });
});

describe('WeatherLocationControl', () => {
  it('never asks for the device location on mount', async () => {
    mount();
    await screen.findByRole('button', { name: 'Use my location' });
    await new Promise((r) => setTimeout(r, 30));
    expect(getCurrentPosition).not.toHaveBeenCalled();
  });

  it('shows a field error and saves nothing for an out-of-range latitude', async () => {
    const user = userEvent.setup();
    mount();
    await waitFor(() => expect(screen.getByLabelText('Latitude')).toBeEnabled());
    await user.type(screen.getByLabelText('Latitude'), '95');
    await user.type(screen.getByLabelText('Longitude'), '10');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Latitude must be a number from -90 to 90');
    expect(status).toHaveClass('text-xs', 'text-accent-red');
    const latInput = screen.getByLabelText('Latitude');
    expect(latInput).toHaveAttribute('aria-invalid', 'true');
    expect(latInput).toHaveAttribute('aria-describedby', status.id);
    expect(latInput).toHaveFocus();
    expect(weatherService.saveLocation).not.toHaveBeenCalled();
  });

  it('moves focus to the longitude when only the longitude is invalid', async () => {
    const user = userEvent.setup();
    mount();
    await waitFor(() => expect(screen.getByLabelText('Latitude')).toBeEnabled());
    await user.type(screen.getByLabelText('Latitude'), '40');
    await user.type(screen.getByLabelText('Longitude'), '200');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByLabelText('Longitude')).toHaveFocus();
    expect(screen.getByLabelText('Longitude')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Latitude')).not.toHaveAttribute('aria-invalid');
  });

  it('when the saved location cannot load, says so, keeps Save off and retries on click', async () => {
    weatherService.getLocation.mockRejectedValueOnce(Object.assign(new Error('x'), { status: 500 }));
    weatherService.getLocation.mockResolvedValueOnce({ lat: 48.86, lon: 2.35 });
    const user = userEvent.setup();
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent("Burrow couldn't load your saved location. Try again.");
    expect(screen.getByRole('alert')).toHaveClass('text-xs', 'text-accent-red');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Use my location' })).toBeDisabled();
    expect(screen.getByLabelText('Latitude')).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByLabelText('Latitude')).toHaveValue('48.86'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(weatherService.saveLocation).not.toHaveBeenCalled();
  });

  it('saves valid coordinates and refreshes the forecast', async () => {
    const user = userEvent.setup();
    const client = mount();
    const reset = vi.spyOn(client, 'resetQueries');
    await waitFor(() => expect(screen.getByLabelText('Latitude')).toBeEnabled());
    await user.type(screen.getByLabelText('Latitude'), '40.7128');
    await user.type(screen.getByLabelText('Longitude'), '-74.006');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(weatherService.saveLocation).toHaveBeenCalledWith({ lat: 40.7128, lon: -74.006 }));
    expect(await screen.findByText('Saved. The forecast on Home uses this location.')).toBeInTheDocument();
    expect(screen.getByLabelText('Latitude')).toHaveValue('40.71');
    expect(reset).toHaveBeenCalledWith({ queryKey: ['weather'] });
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument();
  });

  it('Use my location asks only on click and fills rounded values without saving', async () => {
    getCurrentPosition.mockImplementation((ok) => ok({ coords: { latitude: 51.50735, longitude: -0.12776 } }));
    const user = userEvent.setup();
    mount();
    const btn = await screen.findByRole('button', { name: 'Use my location' });
    await waitFor(() => expect(btn).toBeEnabled());
    expect(getCurrentPosition).not.toHaveBeenCalled();
    await user.click(btn);
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Location found. Click Save to use it.')).toBeInTheDocument();
    expect(screen.getByLabelText('Latitude')).toHaveValue('51.51');
    expect(screen.getByLabelText('Longitude')).toHaveValue('-0.13');
    expect(weatherService.saveLocation).not.toHaveBeenCalled();
  });

  it('when the location is declined, says to type the coordinates', async () => {
    getCurrentPosition.mockImplementation((_ok, fail) => fail(new Error('denied')));
    const user = userEvent.setup();
    mount();
    const btn = await screen.findByRole('button', { name: 'Use my location' });
    await waitFor(() => expect(btn).toBeEnabled());
    await user.click(btn);
    expect(await screen.findByText(/couldn't get this computer's location\. Type your latitude and longitude/)).toBeInTheDocument();
  });

  it('shows a saved location and clears it', async () => {
    weatherService.getLocation.mockResolvedValue({ lat: 48.86, lon: 2.35 });
    const user = userEvent.setup();
    const client = mount();
    client.setQueryData(['weather'], { current: { temperature_2m: 60 }, locationSource: 'saved' });
    expect(latestCachedWeather(client)).not.toBeNull();
    await waitFor(() => expect(screen.getByLabelText('Latitude')).toHaveValue('48.86'));
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(weatherService.clearLocation).toHaveBeenCalled());
    expect(await screen.findByText('Location cleared.')).toBeInTheDocument();
    expect(screen.getByLabelText('Latitude')).toHaveValue('');
    // The forecast for the cleared place is dropped, not only marked stale: nothing can read it any more.
    expect(latestCachedWeather(client)).toBeNull();
  });
});
