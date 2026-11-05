import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Settings from '../Settings';
import { LICENSE_QUERY_KEY } from '../../hooks/useLicense';
import { ThemeProvider } from '../../contexts/ThemeContext';
import { ModeProvider } from '../../contexts/ModeContext';
import { ToastProvider } from '../../contexts/ToastContext';
import { installMatchMedia, resetDom } from '../../test-utils/settingsHarness';

// Fake server: put() persists into `server`, get() reads it back.
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
  useJarvisStatus: () => ({ status: null }),
}));

vi.mock('../../services/aiSettingsService', () => ({
  aiSettingsService: {
    get: vi.fn(() => new Promise(() => {})),
    models: vi.fn(() => new Promise(() => {})),
  },
}));
vi.mock('../../services/secretsService', () => ({
  secretsService: {
    list: vi.fn(async () => ({
      encryption: { enabled: true },
      storage: { available: true },
      writable: true,
      secrets: [
        {
          name: 'GROQ_API_KEY',
          label: 'Groq',
          provider: 'groq',
          description: 'Fallback AI provider',
          configured: true,
          source: 'settings',
          last4: '1234',
          updatedAt: '2026-01-01T00:00:00.000Z',
          envFallback: false,
          stale: false,
          testable: true,
        },
      ],
    })),
    save: vi.fn(),
    remove: vi.fn(),
    test: vi.fn(),
  },
}));

import { stateService } from '../../services/stateService';
import { secretsService } from '../../services/secretsService';
import { lsKey } from '../../utils/storageKeys';
import { allowSlowSuite } from '../../test-utils/slowSuite';

let media;

beforeEach(() => {
  server.map.clear();
  stateService.get.mockClear();
  stateService.put.mockReset();
  stateService.put.mockImplementation(async (key, value) => {
    server.map.set(key, value);
    return { ok: true };
  });
  stateService.getAll.mockClear();
  resetDom();
  media = installMatchMedia(false);
});

afterEach(() => {
  cleanup();
  resetDom();
});

function renderSettings(licenseStatus) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (licenseStatus) client.setQueryData(LICENSE_QUERY_KEY, licenseStatus);
  const utils = render(
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
  return utils;
}

// Let the initial background fetch settle so it cannot clobber a user change.
async function mountSettings(licenseStatus) {
  const utils = renderSettings(licenseStatus);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  await waitFor(() => expect(stateService.get).toHaveBeenCalled());
  await act(async () => {});
  return utils;
}

const group = (name) => screen.getByRole('group', { name });
const radio = (legend, label) =>
  within(group(legend)).getByRole('radio', { name: new RegExp(`^${label}`) });
const html = document.documentElement;
const localJson = (key) => JSON.parse(localStorage.getItem(lsKey(key)));
const putCalls = () => stateService.put.mock.calls.map(([k, v]) => [k, v]);

// Heavy render-and-wait suite: raise the time limits so a busy machine does not trip them.
allowSlowSuite();

describe('Settings defaults', () => {
  it('shows System / Aurora / Aurora / Dashboard / Current month checked and no Workspace mode group', async () => {
    await mountSettings();
    expect(radio('Theme', 'System')).toBeChecked();
    expect(radio('Dark mode background', 'Aurora')).toBeChecked();
    expect(radio('Light mode background', 'Aurora')).toBeChecked();
    expect(radio('Default view', 'Dashboard')).toBeChecked();
    expect(radio('Default month', 'Current month')).toBeChecked();
    expect(screen.queryByRole('group', { name: 'Workspace mode' })).not.toBeInTheDocument();
    expect(screen.getByText('Profile, Javi and the menu.')).toBeInTheDocument();
    expect(html).toHaveAttribute('data-bg-dark', 'aurora');
    expect(html).toHaveAttribute('data-bg-light', 'aurora');
    expect(stateService.put).not.toHaveBeenCalled();
  });

  it('renders the page heading and a global reset trigger', async () => {
    await mountSettings();
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset all to defaults' })).toBeInTheDocument();
  });

  it('falls back to defaults for unknown stored values', async () => {
    localStorage.setItem(lsKey('theme'), JSON.stringify('neon'));
    localStorage.setItem(lsKey('appearance:bgDark'), JSON.stringify('nope'));
    localStorage.setItem(lsKey('budget:defaultView'), JSON.stringify('wat'));
    localStorage.setItem(lsKey('budget:defaultMonth'), JSON.stringify('wat'));
    await mountSettings();
    expect(radio('Theme', 'System')).toBeChecked();
    expect(radio('Dark mode background', 'Aurora')).toBeChecked();
    expect(radio('Default view', 'Dashboard')).toBeChecked();
    expect(radio('Default month', 'Current month')).toBeChecked();
  });

  it('tolerates legacy raw (non-JSON) localStorage values', async () => {
    localStorage.setItem(lsKey('theme'), 'light');
    renderSettings();
    expect(radio('Theme', 'Light')).toBeChecked();
    await act(async () => {});
  });
});

describe('Settings persistence round-trip', () => {
  it('writes localStorage + stateService.put and restores on a fresh tree', async () => {
    const user = userEvent.setup();
    const first = await mountSettings();

    await user.click(radio('Theme', 'Dark'));
    await user.click(radio('Dark mode background', 'Ocean'));
    await user.click(radio('Light mode background', 'Sunset'));
    await user.click(radio('Default view', 'Planner'));
    await user.click(radio('Default month', 'Latest month with data'));

    expect(localJson('theme')).toBe('dark');
    expect(localJson('appearance:bgDark')).toBe('ocean');
    expect(localJson('appearance:bgLight')).toBe('sunset');
    expect(localJson('budget:defaultView')).toBe('planner');
    expect(localJson('budget:defaultMonth')).toBe('latest');
    expect(localJson('mode')).toBeNull();

    const puts = putCalls();
    expect(puts).toContainEqual(['theme', 'dark']);
    expect(puts).toContainEqual(['appearance:bgDark', 'ocean']);
    expect(puts).toContainEqual(['appearance:bgLight', 'sunset']);
    expect(puts).toContainEqual(['budget:defaultView', 'planner']);
    expect(puts).toContainEqual(['budget:defaultMonth', 'latest']);
    expect(puts.map(([k]) => k)).not.toContain('mode');

    first.unmount();
    resetDom(); // wipe local cache so restoration must come from the "server"

    await mountSettings();
    await waitFor(() => expect(radio('Theme', 'Dark')).toBeChecked());
    expect(radio('Dark mode background', 'Ocean')).toBeChecked();
    expect(radio('Light mode background', 'Sunset')).toBeChecked();
    expect(radio('Default view', 'Planner')).toBeChecked();
    expect(radio('Default month', 'Latest month with data')).toBeChecked();
  });

  it('restores from the localStorage cache synchronously on first render', async () => {
    localStorage.setItem(lsKey('appearance:bgDark'), JSON.stringify('forest'));
    localStorage.setItem(lsKey('budget:defaultView'), JSON.stringify('planner'));
    server.map.set('appearance:bgDark', 'forest');
    server.map.set('budget:defaultView', 'planner');
    renderSettings();
    expect(radio('Dark mode background', 'Forest')).toBeChecked();
    expect(radio('Default view', 'Planner')).toBeChecked();
    expect(html).toHaveAttribute('data-bg-dark', 'forest');
    await act(async () => {});
  });

  it('a failed server PUT does not break the local update', async () => {
    stateService.put.mockRejectedValueOnce(new Error('offline'));
    const user = userEvent.setup();
    await mountSettings();
    await user.click(radio('Dark mode background', 'Forest'));
    expect(radio('Dark mode background', 'Forest')).toBeChecked();
    expect(localJson('appearance:bgDark')).toBe('forest');
  });
});

describe('Independent light/dark backgrounds', () => {
  it('picking Ocean for dark does not change light, and updates <html> instantly', async () => {
    const user = userEvent.setup();
    await mountSettings();
    await user.click(radio('Dark mode background', 'Ocean'));
    expect(html).toHaveAttribute('data-bg-dark', 'ocean');
    expect(html).toHaveAttribute('data-bg-light', 'aurora');
    expect(radio('Light mode background', 'Aurora')).toBeChecked();
    expect(radio('Dark mode background', 'Ocean')).toBeChecked();
    expect(stateService.put).toHaveBeenCalledTimes(1);
    expect(putCalls()[0]).toEqual(['appearance:bgDark', 'ocean']);
  });

  it('picking a light background does not change dark', async () => {
    const user = userEvent.setup();
    await mountSettings();
    await user.click(radio('Light mode background', 'Graphite'));
    expect(html).toHaveAttribute('data-bg-light', 'graphite');
    expect(html).toHaveAttribute('data-bg-dark', 'aurora');
    expect(radio('Dark mode background', 'Aurora')).toBeChecked();
  });

  it('the two pickers use distinct radio group names', async () => {
    await mountSettings();
    expect(radio('Dark mode background', 'Aurora').name).not.toBe(
      radio('Light mode background', 'Aurora').name,
    );
  });
});

describe('Reset to defaults', () => {
  async function dirty(user) {
    await user.click(radio('Theme', 'Dark'));
    await user.click(radio('Dark mode background', 'Ocean'));
    await user.click(radio('Light mode background', 'Sunset'));
    await user.click(radio('Default view', 'Planner'));
    await user.click(radio('Default month', 'Latest month with data'));
    await user.click(screen.getByRole('switch', { name: 'Show the Javi bar' }));
  }

  it('Cancel leaves values unchanged and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    await mountSettings();
    await dirty(user);
    await user.click(screen.getByRole('button', { name: 'Reset appearance settings' }));
    expect(screen.getByRole('group', { name: 'Confirm reset of appearance settings' })).toBeInTheDocument();
    const confirmGroup = screen.getByRole('group', { name: 'Confirm reset of appearance settings' });
    expect(within(confirmGroup).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.click(within(confirmGroup).getByRole('button', { name: 'Cancel' }));
    expect(radio('Theme', 'Dark')).toBeChecked();
    expect(radio('Dark mode background', 'Ocean')).toBeChecked();
    expect(screen.getByRole('button', { name: 'Reset appearance settings' })).toHaveFocus();
    expect(screen.queryByText('Appearance reset to defaults.')).not.toBeInTheDocument();
  });

  it('Escape leaves values unchanged and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    await mountSettings();
    await dirty(user);
    await user.click(screen.getByRole('button', { name: 'Reset budget settings' }));
    await user.keyboard('{Escape}');
    expect(radio('Default view', 'Planner')).toBeChecked();
    expect(radio('Default month', 'Latest month with data')).toBeChecked();
    expect(screen.getByRole('button', { name: 'Reset budget settings' })).toHaveFocus();
  });

  it('Confirm on Appearance restores appearance only and shows a toast', async () => {
    const user = userEvent.setup();
    await mountSettings();
    await dirty(user);
    await user.click(screen.getByRole('button', { name: 'Reset appearance settings' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(radio('Theme', 'System')).toBeChecked();
    expect(radio('Dark mode background', 'Aurora')).toBeChecked();
    expect(radio('Light mode background', 'Aurora')).toBeChecked();
    expect(html).toHaveAttribute('data-bg-dark', 'aurora');
    expect(html).toHaveAttribute('data-bg-light', 'aurora');
    // Other sections untouched.
    expect(radio('Default view', 'Planner')).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Show the Javi bar' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Appearance reset to defaults.')).toBeInTheDocument();
    expect(putCalls()).toContainEqual(['theme', 'system']);
    expect(putCalls()).toContainEqual(['appearance:bgDark', 'aurora']);
    expect(putCalls()).toContainEqual(['appearance:bgLight', 'aurora']);
  });

  it('Confirm on Budget restores budget only and shows a toast', async () => {
    const user = userEvent.setup();
    await mountSettings();
    await dirty(user);
    await user.click(screen.getByRole('button', { name: 'Reset budget settings' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(radio('Default view', 'Dashboard')).toBeChecked();
    expect(radio('Default month', 'Current month')).toBeChecked();
    expect(radio('Theme', 'Dark')).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Show the Javi bar' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Budget reset to defaults.')).toBeInTheDocument();
  });

  it('Confirm on General restores the Javi switches only, writes no mode, and shows a toast', async () => {
    const user = userEvent.setup();
    await mountSettings();
    await dirty(user);
    await user.click(screen.getByRole('button', { name: 'Reset general settings' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(screen.getByRole('switch', { name: 'Show the Javi bar' })).toHaveAttribute('aria-checked', 'true');
    expect(radio('Default view', 'Planner')).toBeChecked();
    expect(screen.getByText('General reset to defaults.')).toBeInTheDocument();
    expect(putCalls().map(([k]) => k)).not.toContain('mode');
  });

  it('global reset restores everything', async () => {
    const user = userEvent.setup();
    await mountSettings();
    await dirty(user);
    await user.click(screen.getByRole('button', { name: 'Reset all to defaults' }));
    expect(screen.getByRole('group', { name: 'Confirm reset of all settings' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(radio('Theme', 'System')).toBeChecked();
    expect(radio('Dark mode background', 'Aurora')).toBeChecked();
    expect(radio('Light mode background', 'Aurora')).toBeChecked();
    expect(radio('Default view', 'Dashboard')).toBeChecked();
    expect(radio('Default month', 'Current month')).toBeChecked();
    expect(screen.getByText('All settings reset to defaults.')).toBeInTheDocument();
    expect(localJson('mode')).toBeNull();
    expect(putCalls().map(([k]) => k)).not.toContain('mode');
    expect(localJson('budget:defaultView')).toBe('dashboard');
  });

  it('global reset Cancel changes nothing', async () => {
    const user = userEvent.setup();
    await mountSettings();
    await dirty(user);
    await user.click(screen.getByRole('button', { name: 'Reset all to defaults' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(radio('Theme', 'Dark')).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Show the Javi bar' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('button', { name: 'Reset all to defaults' })).toHaveFocus();
  });
});

describe('Save failure feedback', () => {
  const ERROR_TOAST = "Couldn't save settings. Changes are kept on this device only.";

  afterEach(() => {
    stateService.put.mockImplementation(async (key, value) => {
      server.map.set(key, value);
      return { ok: true };
    });
  });

  it('shows the error toast when a change fails to save, keeping the local value', async () => {
    stateService.put.mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    await mountSettings();
    await user.click(radio('Default view', 'Planner'));
    expect(await screen.findByText(ERROR_TOAST)).toBeInTheDocument();
    expect(radio('Default view', 'Planner')).toBeChecked();
    expect(localJson('budget:defaultView')).toBe('planner');
  });

  it('shows no error toast when saves succeed', async () => {
    const user = userEvent.setup();
    await mountSettings();
    await user.click(radio('Default view', 'Planner'));
    await act(async () => {});
    expect(screen.queryByText(ERROR_TOAST)).not.toBeInTheDocument();
  });

  it('shows the error toast once for a multi-key reset', async () => {
    const user = userEvent.setup();
    await mountSettings();
    await user.click(radio('Theme', 'Dark'));
    await user.click(radio('Default view', 'Planner'));
    await user.click(screen.getByRole('switch', { name: 'Show the Javi bar' }));
    stateService.put.mockClear();
    stateService.put.mockRejectedValue(new Error('offline'));

    await user.click(screen.getByRole('button', { name: 'Reset all to defaults' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(screen.getAllByText(ERROR_TOAST)).toHaveLength(1));
    expect(stateService.put.mock.calls.length).toBeGreaterThan(1);
    await act(async () => {});
    expect(screen.getAllByText(ERROR_TOAST)).toHaveLength(1);
    expect(screen.getByText('All settings reset to defaults.')).toBeInTheDocument();
    expect(radio('Default view', 'Dashboard')).toBeChecked();
  });

  it('shows the error toast once for a section reset (Appearance, three keys)', async () => {
    const user = userEvent.setup();
    await mountSettings();
    await user.click(radio('Theme', 'Dark'));
    await user.click(radio('Dark mode background', 'Ocean'));
    stateService.put.mockRejectedValue(new Error('offline'));
    await user.click(screen.getByRole('button', { name: 'Reset appearance settings' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(screen.getAllByText(ERROR_TOAST)).toHaveLength(1));
    await act(async () => {});
    expect(screen.getAllByText(ERROR_TOAST)).toHaveLength(1);
  });

  it('shows a fresh error toast for each separate failing action', async () => {
    stateService.put.mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    await mountSettings();
    await user.click(radio('Default view', 'Planner'));
    await user.click(screen.getByRole('switch', { name: 'Show the Javi bar' }));
    await waitFor(() => expect(screen.getAllByText(ERROR_TOAST)).toHaveLength(2));
  });
});

describe('Connected services section', () => {
  it('renders the section and Reset all never touches secrets', async () => {
    const user = userEvent.setup();
    await mountSettings();
    expect(screen.getByRole('heading', { name: 'Connected services' })).toBeInTheDocument();
    expect(await screen.findByText('Saved in settings')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reset all to defaults' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await act(async () => {});
    expect(secretsService.save).not.toHaveBeenCalled();
    expect(secretsService.remove).not.toHaveBeenCalled();
    expect(secretsService.test).not.toHaveBeenCalled();
  });
});

describe('Settings page static hints', () => {
  it('shows the global reset hint about AI models and connected services', async () => {
    await mountSettings();
    expect(
      screen.getByText('Does not change your AI model choices or connected services.'),
    ).toBeInTheDocument();
  });

  it('says settings are saved on this computer', async () => {
    await mountSettings();
    expect(screen.getByText(/Saved on this computer\./)).toBeInTheDocument();
  });

  it('GeneralSection no longer repeats the AI model choice from Settings > AI', async () => {
    await mountSettings();
    expect(screen.queryByText("Javi's AI model")).not.toBeInTheDocument();
  });
});

describe('Theme radio applies the theme to <html>', () => {
  it('Light adds the `light` class and Dark removes it', async () => {
    const user = userEvent.setup();
    await mountSettings();
    expect(html).not.toHaveClass('light');
    await user.click(radio('Theme', 'Light'));
    expect(html).toHaveClass('light');
    await user.click(radio('Theme', 'Dark'));
    expect(html).not.toHaveClass('light');
  });
});

describe('Data & storage', () => {
  const RESET_DEFAULTS = {
    theme: 'system',
    'appearance:bgDark': 'aurora',
    'appearance:bgLight': 'aurora',
    'budget:defaultView': 'dashboard',
    'budget:defaultMonth': 'current',
    'javi:advisorButton': true,
    'javi:autoAdvise': true,
    'javi:character': 'butler',
    'nav:hideSubcategories': false,
  };

  it('renders the section without sync-mode or connection controls', async () => {
    await mountSettings();
    expect(screen.getByRole('heading', { name: 'Data & storage' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Settings sync' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reset Data & storage' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Recheck' })).not.toBeInTheDocument();
  });

  it('Reset all in account mode: PUTs resolving out of order still end at the defaults', async () => {
    const user = userEvent.setup();
    await mountSettings();
    await user.click(radio('Theme', 'Dark'));
    await user.click(radio('Default view', 'Planner'));
    await act(async () => {});
    stateService.put.mockClear();
    const releasers = [];
    stateService.put.mockImplementation(
      (key, value) =>
        new Promise((resolve) => {
          releasers.push(() => {
            server.map.set(key, value);
            resolve({ ok: true });
          });
        }),
    );
    await user.click(screen.getByRole('button', { name: 'Reset all to defaults' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await act(async () => {});
    releasers.splice(0).reverse().forEach((release) => release());
    await act(async () => {});
    expect(putCalls().map(([k]) => k).sort()).toEqual(Object.keys(RESET_DEFAULTS).sort());
    for (const [key, def] of Object.entries(RESET_DEFAULTS)) expect(server.map.get(key)).toBe(def);
    expect(localJson('storage:pendingSync')).toBeNull();
    expect(screen.getAllByText('All settings reset to defaults.')).toHaveLength(1);
  });
});

describe('General: menu and Javi character', () => {
  it('Reset on General restores the character and shows every menu subcategory again', async () => {
    const user = userEvent.setup();
    await mountSettings();
    const hide = () => screen.getByRole('switch', { name: 'Hide subcategories in the menu' });
    await user.click(radio("Javi's character", 'Majordomo'));
    await user.click(hide());
    expect(hide()).toHaveAttribute('aria-checked', 'true');
    stateService.put.mockClear();
    await user.click(screen.getByRole('button', { name: 'Reset general settings' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await act(async () => {});
    expect(radio("Javi's character", 'Butler')).toBeChecked();
    expect(hide()).toHaveAttribute('aria-checked', 'false');
    expect(putCalls()).toContainEqual(['javi:character', 'butler']);
    expect(putCalls()).toContainEqual(['nav:hideSubcategories', false]);
  });
});

describe('General: Javi characters are a Pro perk', () => {
  it('known Free: a stale Pro value shows Butler, picking Valet saves nothing and shows the Pro notice', async () => {
    server.map.set('javi:character', 'majordomo');
    const user = userEvent.setup();
    await mountSettings({ pro: false });
    expect(radio("Javi's character", 'Butler')).toBeChecked();
    expect(radio("Javi's character", 'Valet')).not.toBeChecked();
    stateService.put.mockClear();
    await user.click(radio("Javi's character", 'Valet'));
    expect(putCalls()).not.toContainEqual(['javi:character', 'valet']);
    expect(document.querySelector('[data-capability="javi_characters"]')).not.toBeNull();
  });
});

describe('Theme hint', () => {
  it('describes the resolved system theme only while on System', async () => {
    const user = userEvent.setup();
    await mountSettings();
    expect(screen.getByText(/currently dark/)).toBeInTheDocument();
    await user.click(radio('Theme', 'Light'));
    expect(screen.queryByText(/Follows your device/)).not.toBeInTheDocument();
    act(() => media.setMatches(true));
    await user.click(radio('Theme', 'System'));
    expect(screen.getByText(/currently light/)).toBeInTheDocument();
  });
});
