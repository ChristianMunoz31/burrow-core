import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider, useTheme } from '../ThemeContext';
import AppearanceSection from '../../components/settings/AppearanceSection';
import { installMatchMedia, resetDom } from '../../test-utils/settingsHarness';
import { lsKey } from '../../utils/storageKeys';
import { LICENSE_QUERY_KEY } from '../../hooks/useLicense';

// Fake server so background refetches return what the test "stored".
const server = vi.hoisted(() => ({ map: new Map() }));

vi.mock('../../services/stateService', () => ({
  stateService: {
    get: vi.fn(async (key) => server.map.get(key)),
    put: vi.fn(async () => ({})),
  },
}));

vi.mock('../../services/licenseService', () => ({
  licenseService: { get: vi.fn(async () => { throw new Error('offline'); }) },
}));
import { licenseService } from '../../services/licenseService';
import { stateService } from '../../services/stateService';
import { allowSlowSuite } from '../../test-utils/slowSuite';

const html = document.documentElement;
let media;

beforeEach(() => {
  server.map.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  resetDom();
  media = installMatchMedia(false);
});

afterEach(() => {
  cleanup();
  resetDom();
});

let client;

function wrapper({ children }) {
  return (
    <QueryClientProvider client={client}>
      <ThemeProvider>{children}</ThemeProvider>
    </QueryClientProvider>
  );
}

// React Query notifies observers on a macrotask, so flush one after each set.
async function call(fn) {
  await act(async () => {
    fn();
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function settled() {
  await waitFor(() =>
    expect(client.getQueryState(['state', 'theme'])?.dataUpdateCount ?? 0).toBeGreaterThan(0),
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function setup(stored) {
  if (stored) {
    localStorage.setItem(lsKey('theme'), JSON.stringify(stored));
    server.map.set('theme', stored);
  }
  const hook = renderHook(() => useTheme(), { wrapper });
  // Let the initial background fetch settle so it cannot clobber a later change.
  await settled();
  return hook;
}

// Heavy render-and-wait suite: raise the time limits so a busy machine does not trip them.
allowSlowSuite();

describe('ThemeProvider system mode', () => {
  it('defaults to preference "system" and resolves dark when the OS is not light', async () => {
    const { result } = await setup();
    expect(result.current.preference).toBe('system');
    expect(result.current.theme).toBe('dark');
    expect(html).not.toHaveClass('light');
  });

  it('system + OS light puts .light on <html>', async () => {
    media.setMatches(true);
    const { result } = await setup();
    expect(result.current.theme).toBe('light');
    expect(html).toHaveClass('light');
  });

  it('follows prefers-color-scheme changes live', async () => {
    media.setMatches(true);
    const { result } = await setup();
    expect(html).toHaveClass('light');
    act(() => media.setMatches(false));
    expect(result.current.theme).toBe('dark');
    expect(html).not.toHaveClass('light');
    act(() => media.setMatches(true));
    expect(result.current.theme).toBe('light');
    expect(html).toHaveClass('light');
  });

  it('explicit Light ignores OS changes', async () => {
    const { result } = await setup('light');
    expect(html).toHaveClass('light');
    act(() => media.setMatches(true));
    act(() => media.setMatches(false));
    expect(result.current.theme).toBe('light');
    expect(html).toHaveClass('light');
  });

  it('explicit Dark ignores OS changes', async () => {
    media.setMatches(true);
    const { result } = await setup('dark');
    expect(result.current.theme).toBe('dark');
    expect(html).not.toHaveClass('light');
    act(() => media.setMatches(false));
    act(() => media.setMatches(true));
    expect(html).not.toHaveClass('light');
  });

  it('unsubscribes from the media query on unmount', async () => {
    const { unmount } = await setup();
    expect(media.listenerCount).toBeGreaterThan(0);
    unmount();
    expect(media.listenerCount).toBe(0);
  });

  it('falls back to dark when matchMedia is unavailable', async () => {
    delete window.matchMedia;
    const { result } = await setup();
    expect(result.current.theme).toBe('dark');
    expect(html).not.toHaveClass('light');
  });

  it('an unknown stored preference normalizes to system', async () => {
    const { result } = await setup('purple');
    expect(result.current.preference).toBe('system');
  });
});

describe('ThemeProvider actions', () => {
  it('setPreference saves the preference', async () => {
    const { result } = await setup();
    expect(result.current.setTheme).toBeUndefined();
    await call(() => result.current.setPreference('light'));
    expect(result.current.preference).toBe('light');
    expect(localStorage.getItem(lsKey('theme'))).toBe(JSON.stringify('light'));
  });

  it('exposes backgrounds, writes data attributes, and keeps light/dark independent', async () => {
    const { result } = await setup();
    expect(result.current.bgDark).toBe('aurora');
    expect(result.current.bgLight).toBe('aurora');
    expect(html).toHaveAttribute('data-bg-dark', 'aurora');
    await call(() => result.current.setBgDark('ocean'));
    expect(html).toHaveAttribute('data-bg-dark', 'ocean');
    expect(html).toHaveAttribute('data-bg-light', 'aurora');
    await call(() => result.current.setBgLight('forest'));
    expect(html).toHaveAttribute('data-bg-light', 'forest');
    expect(html).toHaveAttribute('data-bg-dark', 'ocean');
  });

  it('an invalid stored background normalizes to aurora', async () => {
    localStorage.setItem(lsKey('appearance:bgLight'), JSON.stringify('nonexistent'));
    server.map.set('appearance:bgLight', 'nonexistent');
    const { result } = await setup();
    expect(result.current.bgLight).toBe('aurora');
    expect(html).toHaveAttribute('data-bg-light', 'aurora');
  });

  it('useTheme throws outside a ThemeProvider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    function Probe() {
      useTheme();
      return null;
    }
    expect(() => render(<Probe />)).toThrow(/ThemeProvider/);
    spy.mockRestore();
  });

  it('re-renders consumers when the theme changes via UI', async () => {
    const user = userEvent.setup();
    function Probe() {
      const { theme, setPreference } = useTheme();
      return (
        <button type="button" onClick={() => setPreference('light')}>
          {theme}
        </button>
      );
    }
    render(<Probe />, { wrapper });
    await waitFor(() => expect(screen.getByRole('button')).toHaveTextContent('dark'));
    await user.click(screen.getByRole('button'));
    expect(screen.getByRole('button')).toHaveTextContent('light');
  });
});

describe('local cache vs empty server', () => {
  it('keeps a locally cached preference when the server has no value', async () => {
    localStorage.setItem(lsKey('theme'), JSON.stringify('light'));
    const { result } = renderHook(() => useTheme(), { wrapper });
    await settled();
    expect(result.current.preference).toBe('light');
  });

  it('prefers the synced server value over a stale local cache', async () => {
    localStorage.setItem(lsKey('theme'), JSON.stringify('light'));
    server.map.set('theme', 'dark');
    const { result } = renderHook(() => useTheme(), { wrapper });
    await waitFor(() => expect(result.current.preference).toBe('dark'));
  });
});

describe('Founder background gating', () => {
  const FOUNDING = { perks: { founderBackground: true }, pro: true };
  const STANDARD = { perks: { founderBackground: false }, pro: true };

  function storeFounder() {
    localStorage.setItem(lsKey('appearance:bgDark'), JSON.stringify('founder'));
    localStorage.setItem(lsKey('appearance:bgLight'), JSON.stringify('founder'));
    server.map.set('appearance:bgDark', 'founder');
    server.map.set('appearance:bgLight', 'founder');
  }

  it('applies the founder background for a founding license', async () => {
    storeFounder();
    client.setQueryData(LICENSE_QUERY_KEY, FOUNDING);
    const { result } = await setup();
    expect(html).toHaveAttribute('data-bg-dark', 'founder');
    expect(html).toHaveAttribute('data-bg-light', 'founder');
    expect(result.current.founderUnlocked).toBe(true);
    expect(result.current.founderSaved).toBe(false);
  });

  it('falls back to aurora without the perk but keeps the saved preference', async () => {
    storeFounder();
    client.setQueryData(LICENSE_QUERY_KEY, STANDARD);
    const { result } = await setup();
    expect(html).toHaveAttribute('data-bg-dark', 'aurora');
    expect(result.current.bgDark).toBe('aurora');
    expect(result.current.founderUnlocked).toBe(false);
    expect(result.current.founderSaved).toBe(true);
    expect(localStorage.getItem(lsKey('appearance:bgDark'))).toBe(JSON.stringify('founder'));
  });

  const PERK_KEY = lsKey('license:founderPerk');

  it('pending status with no cached entitlement applies the default, keeping the preference', async () => {
    storeFounder();
    licenseService.get.mockReturnValueOnce(new Promise(() => {}));
    const { result } = await setup();
    expect(html).toHaveAttribute('data-bg-dark', 'aurora');
    expect(html).toHaveAttribute('data-bg-light', 'aurora');
    expect(result.current.founderSaved).toBe(false);
    expect(localStorage.getItem(lsKey('appearance:bgDark'))).toBe(JSON.stringify('founder'));
    expect(localStorage.getItem(PERK_KEY)).toBeNull();
  });

  it('pending status with a cached entitlement applies the saved founder background', async () => {
    storeFounder();
    localStorage.setItem(PERK_KEY, '1');
    licenseService.get.mockReturnValueOnce(new Promise(() => {}));
    const { result } = await setup();
    expect(html).toHaveAttribute('data-bg-dark', 'founder');
    expect(html).toHaveAttribute('data-bg-light', 'founder');
    expect(result.current.founderSaved).toBe(false);
  });

  it('failed status load follows the cache: default without it, founder with it', async () => {
    storeFounder();
    const { result } = await setup();
    await waitFor(() => expect(client.getQueryState(LICENSE_QUERY_KEY)?.status).toBe('error'));
    expect(html).toHaveAttribute('data-bg-dark', 'aurora');
    expect(result.current.founderUnlocked).toBe(false);
    cleanup();

    localStorage.setItem(PERK_KEY, '1');
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await setup();
    await waitFor(() => expect(client.getQueryState(LICENSE_QUERY_KEY)?.status).toBe('error'));
    expect(html).toHaveAttribute('data-bg-dark', 'founder');
  });

  it('a known status without the perk clears the cached entitlement', async () => {
    storeFounder();
    localStorage.setItem(PERK_KEY, '1');
    client.setQueryData(LICENSE_QUERY_KEY, STANDARD);
    await setup();
    expect(localStorage.getItem(PERK_KEY)).toBeNull();
    expect(html).toHaveAttribute('data-bg-dark', 'aurora');
    expect(localStorage.getItem(lsKey('appearance:bgDark'))).toBe(JSON.stringify('founder'));
  });

  it('a known status with the perk sets the cached entitlement', async () => {
    storeFounder();
    client.setQueryData(LICENSE_QUERY_KEY, FOUNDING);
    await setup();
    expect(localStorage.getItem(PERK_KEY)).toBe('1');
  });

  it('the real flag wins over a stale cache once known and updates it live', async () => {
    storeFounder();
    localStorage.setItem(PERK_KEY, '1');
    client.setQueryData(LICENSE_QUERY_KEY, FOUNDING);
    await setup();
    await call(() => client.setQueryData(LICENSE_QUERY_KEY, STANDARD));
    expect(html).toHaveAttribute('data-bg-dark', 'aurora');
    expect(localStorage.getItem(PERK_KEY)).toBeNull();
    await call(() => client.setQueryData(LICENSE_QUERY_KEY, FOUNDING));
    expect(html).toHaveAttribute('data-bg-dark', 'founder');
    expect(localStorage.getItem(PERK_KEY)).toBe('1');
  });

  it('losing the license (known true to known false) clears the cache without rewriting or syncing the preference', async () => {
    storeFounder();
    client.setQueryData(LICENSE_QUERY_KEY, FOUNDING);
    await setup();
    expect(localStorage.getItem(PERK_KEY)).toBe('1');
    stateService.put.mockClear();
    await call(() => client.setQueryData(LICENSE_QUERY_KEY, STANDARD));
    expect(localStorage.getItem(PERK_KEY)).toBeNull();
    expect(html).toHaveAttribute('data-bg-dark', 'aurora');
    expect(html).toHaveAttribute('data-bg-light', 'aurora');
    expect(localStorage.getItem(lsKey('appearance:bgDark'))).toBe(JSON.stringify('founder'));
    expect(localStorage.getItem(lsKey('appearance:bgLight'))).toBe(JSON.stringify('founder'));
    const synced = stateService.put.mock.calls.filter(([k]) => String(k).startsWith('appearance:'));
    expect(synced).toEqual([]);
  });

  it('a founder preference saved for light only behaves the same, leaving dark untouched', async () => {
    localStorage.setItem(lsKey('appearance:bgLight'), JSON.stringify('founder'));
    server.map.set('appearance:bgLight', 'founder');
    localStorage.setItem(lsKey('appearance:bgDark'), JSON.stringify('ocean'));
    server.map.set('appearance:bgDark', 'ocean');
    client.setQueryData(LICENSE_QUERY_KEY, STANDARD);
    const { result } = await setup();
    expect(html).toHaveAttribute('data-bg-light', 'aurora');
    expect(html).toHaveAttribute('data-bg-dark', 'ocean');
    expect(result.current.founderSaved).toBe(true);
    await call(() => client.setQueryData(LICENSE_QUERY_KEY, FOUNDING));
    expect(html).toHaveAttribute('data-bg-light', 'founder');
    expect(html).toHaveAttribute('data-bg-dark', 'ocean');
    expect(result.current.founderSaved).toBe(false);
  });

  it('founderSaved stays false while status is unknown and the cache is empty', async () => {
    localStorage.setItem(lsKey('appearance:bgDark'), JSON.stringify('founder'));
    server.map.set('appearance:bgDark', 'founder');
    licenseService.get.mockReturnValueOnce(new Promise(() => {}));
    const { result } = await setup();
    expect(html).toHaveAttribute('data-bg-dark', 'aurora');
    expect(result.current.founderSaved).toBe(false);
  });

  it('follows the license live: free mid-session falls back, founding restores', async () => {
    storeFounder();
    client.setQueryData(LICENSE_QUERY_KEY, FOUNDING);
    await setup();
    expect(html).toHaveAttribute('data-bg-light', 'founder');
    await call(() => client.setQueryData(LICENSE_QUERY_KEY, { perks: { founderBackground: false }, pro: false }));
    expect(html).toHaveAttribute('data-bg-light', 'aurora');
    expect(html).toHaveAttribute('data-bg-dark', 'aurora');
    await call(() => client.setQueryData(LICENSE_QUERY_KEY, FOUNDING));
    expect(html).toHaveAttribute('data-bg-light', 'founder');
    expect(html).toHaveAttribute('data-bg-dark', 'founder');
  });
});

describe('Founder background in the real Appearance picker', () => {
  // A real ThemeProvider feeding the real AppearanceSection, as Settings does.
  function Appearance() {
    const t = useTheme();
    return (
      <AppearanceSection
        preference={t.preference}
        resolvedTheme={t.theme}
        onPreferenceChange={t.setPreference}
        bgDark={t.bgDark}
        bgLight={t.bgLight}
        onBgDarkChange={t.setBgDark}
        onBgLightChange={t.setBgLight}
        onReset={() => {}}
      />
    );
  }
  const founderRadios = () => screen.queryAllByRole('radio', { name: /^Founder/ });
  const NOTE = /Your Founder background comes back when a Founding license is active/;

  function storeFounder() {
    for (const k of ['appearance:bgDark', 'appearance:bgLight']) {
      localStorage.setItem(lsKey(k), JSON.stringify('founder'));
      server.map.set(k, 'founder');
    }
  }

  it('unlocks and locks with the license query data, never deleting the saved choice', async () => {
    storeFounder();
    client.setQueryData(LICENSE_QUERY_KEY, { perks: { founderBackground: true }, pro: true });
    render(<Appearance />, { wrapper });
    await settled();

    // Unlocked: offered in both pickers, selected, applied, no note.
    expect(founderRadios()).toHaveLength(2);
    founderRadios().forEach((r) => expect(r).toBeChecked());
    expect(html).toHaveAttribute('data-bg-dark', 'founder');
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();

    // Locked: hidden, default applied and shown as selected, note visible, preference kept.
    await call(() => client.setQueryData(LICENSE_QUERY_KEY, { perks: { founderBackground: false }, pro: false }));
    expect(founderRadios()).toHaveLength(0);
    expect(html).toHaveAttribute('data-bg-dark', 'aurora');
    expect(html).toHaveAttribute('data-bg-light', 'aurora');
    screen.getAllByRole('radio', { name: /^Aurora/ }).forEach((r) => expect(r).toBeChecked());
    expect(screen.getByText(NOTE)).toBeInTheDocument();
    expect(localStorage.getItem(lsKey('appearance:bgDark'))).toBe(JSON.stringify('founder'));

    // Unlocked again: restored.
    await call(() => client.setQueryData(LICENSE_QUERY_KEY, { perks: { founderBackground: true }, pro: true }));
    expect(founderRadios()).toHaveLength(2);
    founderRadios().forEach((r) => expect(r).toBeChecked());
    expect(html).toHaveAttribute('data-bg-light', 'founder');
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
  });

  it('a founding member can pick Founder from the picker and it applies', async () => {
    client.setQueryData(LICENSE_QUERY_KEY, { perks: { founderBackground: true }, pro: false });
    render(<Appearance />, { wrapper });
    await settled();
    expect(html).toHaveAttribute('data-bg-dark', 'aurora');
    await userEvent.setup().click(founderRadios()[0]);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(html).toHaveAttribute('data-bg-dark', 'founder');
  });

  it('offers no Founder background to a standard license', async () => {
    client.setQueryData(LICENSE_QUERY_KEY, { perks: { founderBackground: false }, pro: true });
    render(<Appearance />, { wrapper });
    await settled();
    expect(founderRadios()).toHaveLength(0);
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
  });
});
