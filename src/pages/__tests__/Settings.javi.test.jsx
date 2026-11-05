import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Settings from '../Settings';
import { ThemeProvider } from '../../contexts/ThemeContext';
import { ModeProvider } from '../../contexts/ModeContext';
import { ToastProvider } from '../../contexts/ToastContext';
import { installMatchMedia, resetDom } from '../../test-utils/settingsHarness';
import { useJaviSettings } from '../../hooks/useJaviSettings';
import { SETTINGS_DEFAULTS, SETTINGS_KEYS } from '../../constants/settingsDefaults';

const server = vi.hoisted(() => ({ map: new Map() }));

vi.mock('../../services/stateService', () => ({
  stateService: {
    getAll: vi.fn(async () => Object.fromEntries(server.map)),
    get: vi.fn(async (key) => server.map.get(key)),
    put: vi.fn(async (key, value) => {
      server.map.set(key, value);
      return { ok: true };
    }),
  },
}));
vi.mock('../../hooks/useJarvisStatus', () => ({
  useJarvisStatus: () => ({ status: null, loading: false }),
}));
vi.mock('../../services/secretsService', () => ({
  secretsService: {
    list: vi.fn(async () => ({
      encryption: { enabled: true },
      storage: { available: true },
      writable: true,
      secrets: [],
    })),
    save: vi.fn(),
    remove: vi.fn(),
    test: vi.fn(),
  },
}));

import { stateService } from '../../services/stateService';
import { lsKey } from '../../utils/storageKeys';
import { allowSlowSuite } from '../../test-utils/slowSuite';

allowSlowSuite();

const wrapper = ({ children }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

async function mountSettings() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ToastProvider>
          <ThemeProvider>
            <ModeProvider>
              <Settings />
            </ModeProvider>
          </ThemeProvider>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  await waitFor(() => expect(stateService.get).toHaveBeenCalled());
  await act(async () => {});
}

const buttonSwitch = () => screen.getByRole('switch', { name: 'Show the Javi bar' });
const autoSwitch = () => screen.getByRole('switch', { name: 'Get an insight when Javi opens' });
const localJson = (key) => JSON.parse(localStorage.getItem(lsKey(key)));

beforeEach(() => {
  server.map.clear();
  stateService.get.mockClear();
  stateService.put.mockClear();
  resetDom();
  installMatchMedia(false);
});
afterEach(() => {
  cleanup();
  resetDom();
});

describe('Javi settings on the Settings page', () => {
  it('both toggles default to On and nothing is written on load', async () => {
    await mountSettings();
    expect(buttonSwitch()).toBeChecked();
    expect(autoSwitch()).toBeChecked();
    expect(stateService.put).not.toHaveBeenCalled();
  });

  it('turning the button Off persists it and leaves auto-advise enabled', async () => {
    const user = userEvent.setup();
    await mountSettings();
    await user.click(buttonSwitch());
    expect(buttonSwitch()).not.toBeChecked();
    expect(localJson('javi:advisorButton')).toBe(false);
    expect(stateService.put).toHaveBeenCalledWith('javi:advisorButton', false);
    expect(autoSwitch()).not.toHaveAttribute('aria-disabled');
  });

  it('turning auto-advise Off persists it', async () => {
    const user = userEvent.setup();
    await mountSettings();
    await user.click(autoSwitch());
    expect(localJson('javi:autoAdvise')).toBe(false);
    expect(stateService.put).toHaveBeenCalledWith('javi:autoAdvise', false);
  });

  it('Reset General restores both toggles to On', async () => {
    const user = userEvent.setup();
    await mountSettings();
    await user.click(buttonSwitch());
    await user.click(autoSwitch());
    await user.click(screen.getByRole('button', { name: 'Reset general settings' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(buttonSwitch()).toBeChecked();
    expect(autoSwitch()).toBeChecked();
    expect(localJson('javi:advisorButton')).toBe(true);
    expect(localJson('javi:autoAdvise')).toBe(true);
  });

  it('Reset all to defaults restores both toggles to On', async () => {
    const user = userEvent.setup();
    await mountSettings();
    await user.click(buttonSwitch());
    await user.click(autoSwitch());
    await user.click(screen.getByRole('button', { name: 'Reset all to defaults' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(buttonSwitch()).toBeChecked();
    expect(autoSwitch()).toBeChecked();
    expect(stateService.put).toHaveBeenCalledWith('javi:advisorButton', true);
    expect(stateService.put).toHaveBeenCalledWith('javi:autoAdvise', true);
  });

  it('an unknown stored value falls back to On', async () => {
    localStorage.setItem(lsKey('javi:advisorButton'), JSON.stringify('banana'));
    localStorage.setItem(lsKey('javi:autoAdvise'), JSON.stringify(7));
    await mountSettings();
    expect(buttonSwitch()).toBeChecked();
    expect(autoSwitch()).toBeChecked();
  });
});

describe('useJaviSettings', () => {
  it('defaults to showButton + autoAdvise on', () => {
    expect(SETTINGS_DEFAULTS.javiAdvisorButton).toBe(true);
    expect(SETTINGS_DEFAULTS.javiAutoAdvise).toBe(true);
    const { result } = renderHook(() => useJaviSettings(), { wrapper });
    expect(result.current).toEqual({ showButton: true, autoAdvise: true });
  });

  it('reads stored Off values', () => {
    localStorage.setItem(lsKey(SETTINGS_KEYS.javiAdvisorButton), JSON.stringify(false));
    localStorage.setItem(lsKey(SETTINGS_KEYS.javiAutoAdvise), JSON.stringify(false));
    const { result } = renderHook(() => useJaviSettings(), { wrapper });
    expect(result.current).toEqual({ showButton: false, autoAdvise: false });
  });
});
