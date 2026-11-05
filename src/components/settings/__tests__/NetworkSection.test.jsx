import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import NetworkSection, { STORE_UPDATES_COPY } from '../NetworkSection';
import { SHOW_NETWORK_ACTIVITY_EVENT } from '../settingsSections';

vi.mock('../../../hooks/useAppInfo', () => ({ useAppInfo: vi.fn() }));
import { useAppInfo } from '../../../hooks/useAppInfo';

vi.mock('../../../services/networkService', () => ({
  networkService: { get: vi.fn(), set: vi.fn() },
}));
import { networkService } from '../../../services/networkService';

vi.mock('../../../services/weatherService', () => ({
  weatherService: { getLocation: vi.fn(async () => null), saveLocation: vi.fn(), clearLocation: vi.fn(), fetch: vi.fn() },
}));

const features = (enabledId = null) => ({
  features: [
    { id: 'weather', enabled: enabledId === 'weather', label: 'Weather', description: 'Local forecast.', hosts: ['api.open-meteo.com'] },
    { id: 'oura', enabled: enabledId === 'oura', label: 'Oura', description: 'Sleep and readiness.', hosts: ['api.ouraring.com'] },
  ],
});

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NetworkSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useAppInfo.mockReturnValue({ info: { version: '0.1.0', channel: 'stable', distribution: 'direct' } });
  networkService.get.mockResolvedValue(features());
  networkService.set.mockImplementation(async (id, enabled) => features(enabled ? id : null));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('NetworkSection', () => {
  it('lists every feature with its hosts, all off by default', async () => {
    renderSection();
    const list = await screen.findByRole('list', { name: 'Network features' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    for (const sw of within(list).getAllByRole('switch')) expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(items[0]).toHaveTextContent('This calls the internet: api.open-meteo.com');
    expect(items[1]).toHaveTextContent('api.ouraring.com');
  });

  it('says on the Weather row where the forecast shows (the Javi card on Home) and that it uses the location set there', async () => {
    renderSection();
    const list = await screen.findByRole('list', { name: 'Network features' });
    const [weather, oura] = within(list).getAllByRole('listitem');
    expect(weather).toHaveTextContent('The forecast shows in the Javi card on Home. Turn it on to set your location.');
    expect(oura).not.toHaveTextContent('Javi card');
  });

  it('shows the Location form in the Weather row only while Weather is on', async () => {
    renderSection();
    await screen.findByRole('list', { name: 'Network features' });
    expect(screen.queryByRole('form', { name: 'Weather location' })).not.toBeInTheDocument();
    cleanup();
    networkService.get.mockResolvedValue(features('weather'));
    renderSection();
    const form = await screen.findByRole('form', { name: 'Weather location' });
    expect(screen.getByText('The forecast shows in the Javi card on Home, for the location you set below.')).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'Use my location' })).toBeInTheDocument();
  });

  it('toggles a feature on through the API and reflects the saved state', async () => {
    const user = userEvent.setup();
    renderSection();
    const sw = await screen.findByRole('switch', { name: 'Weather' });
    await user.click(sw);
    await waitFor(() => expect(networkService.set).toHaveBeenCalledWith('weather', true));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Weather' })).toHaveAttribute('aria-checked', 'true'));
  });

  it('shows an error and keeps the toggle off when saving fails', async () => {
    networkService.set.mockRejectedValue(new Error('nope'));
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole('switch', { name: 'Oura' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save that change");
    expect(screen.getByRole('switch', { name: 'Oura' })).toHaveAttribute('aria-checked', 'false');
  });

  it('keeps focus on the toggle while saving (aria-disabled, not disabled)', async () => {
    let release;
    networkService.set.mockImplementation(
      () => new Promise((resolve) => { release = () => resolve(features('weather')); }),
    );
    const user = userEvent.setup();
    renderSection();
    const sw = await screen.findByRole('switch', { name: 'Weather' });
    await user.click(sw);
    await waitFor(() => expect(sw).toHaveAttribute('aria-disabled', 'true'));
    expect(sw).not.toBeDisabled();
    expect(sw).toHaveFocus();
    await user.click(sw);
    expect(networkService.set).toHaveBeenCalledTimes(1);
    release();
    await waitFor(() => expect(sw).not.toHaveAttribute('aria-disabled'));
  });

  it('in the Microsoft Store build the update check is replaced by a note with no switch', async () => {
    useAppInfo.mockReturnValue({ info: { version: '0.1.0', channel: 'stable', distribution: 'store' } });
    networkService.get.mockResolvedValue({
      features: [
        { id: 'weather', enabled: false, label: 'Weather', description: 'Local forecast.', hosts: ['api.open-meteo.com'] },
        { id: 'updates', enabled: false, label: 'Update check', description: 'Checks GitHub.', hosts: ['github.com'] },
      ],
    });
    renderSection();
    const row = await screen.findByTestId('store-updates-row');
    expect(row).toHaveTextContent(STORE_UPDATES_COPY);
    expect(row).not.toHaveTextContent('github.com');
    expect(within(row).queryByRole('switch')).toBeNull();
    expect(screen.getAllByRole('switch')).toHaveLength(1);
  });

  it('offers a retry when the settings cannot be loaded', async () => {
    networkService.get.mockRejectedValueOnce(new Error('down'));
    const user = userEvent.setup();
    renderSection();
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load network settings");
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('switch', { name: 'Weather' })).toBeInTheDocument();
  });

  it('has a See network activity button that asks the Privacy section to open its panel', async () => {
    const user = userEvent.setup();
    const seen = vi.fn();
    window.addEventListener(SHOW_NETWORK_ACTIVITY_EVENT, seen);
    renderSection();
    await user.click(await screen.findByRole('button', { name: 'See network activity' }));
    expect(seen).toHaveBeenCalledTimes(1);
    window.removeEventListener(SHOW_NETWORK_ACTIVITY_EVENT, seen);
  });
});

describe('NetworkSection update row', () => {
  const rows = (enabled) => ({
    features: [
      { id: 'weather', enabled: false, label: 'Weather', description: 'Local forecast.', hosts: ['api.open-meteo.com'] },
      { id: 'updates', enabled, label: 'Update check', description: 'Asks GitHub for a newer Burrow.', hosts: ['api.github.com'] },
    ],
  });

  it('holds the updates row back until the app info has loaded, then shows the switch', async () => {
    networkService.get.mockResolvedValue(rows(false));
    useAppInfo.mockReturnValue({ info: null, isLoading: true });
    const { rerender } = renderSection();
    await screen.findByRole('switch', { name: 'Weather' });
    expect(screen.queryByRole('switch', { name: 'Update check' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('store-updates-row')).not.toBeInTheDocument();
    useAppInfo.mockReturnValue({ info: { version: '1.0.0', channel: 'stable', distribution: 'direct' }, isLoading: false });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rerender(
      <QueryClientProvider client={client}>
        <NetworkSection />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('switch', { name: 'Update check' })).toBeInTheDocument();
  });

  it('shows the Store row, never the switch, once the app info says store', async () => {
    networkService.get.mockResolvedValue(rows(true));
    useAppInfo.mockReturnValue({ info: { version: '1.0.0', channel: 'stable', distribution: 'store' }, isLoading: false });
    renderSection();
    expect(await screen.findByTestId('store-updates-row')).toHaveTextContent(STORE_UPDATES_COPY);
    expect(screen.queryByRole('switch', { name: 'Update check' })).not.toBeInTheDocument();
  });

  it('shows no update status line with the feature on or off: the Updates section owns the check', async () => {
    networkService.get.mockResolvedValue(rows(true));
    useAppInfo.mockReturnValue({ info: { version: '1.0.0', channel: 'stable', distribution: 'direct' }, isLoading: false });
    renderSection();
    expect(await screen.findByRole('switch', { name: 'Update check' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('api.github.com')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText(/latest version|Checking for updates/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Check now|Check again/ })).not.toBeInTheDocument();
  });
});
