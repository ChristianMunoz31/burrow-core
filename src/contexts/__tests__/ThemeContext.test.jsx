import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider, useTheme } from '../ThemeContext';
import AppearanceSection from '../../components/settings/AppearanceSection';
import { installMatchMedia, resetDom } from '../../test-utils/settingsHarness';
import { lsKey } from '../../utils/storageKeys';

// Fake server so background refetches return what the test "stored".
const server = vi.hoisted(() => ({ map: new Map() }));

vi.mock('../../services/stateService', () => ({
  stateService: {
    get: vi.fn(async (key) => server.map.get(key)),
    put: vi.fn(async () => ({})),
  },
}));


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

describe('Purple and gold background (id founder)', () => {
  function storeFounder() {
    for (const k of ['appearance:bgDark', 'appearance:bgLight']) {
      localStorage.setItem(lsKey(k), JSON.stringify('founder'));
      server.map.set(k, 'founder');
    }
  }

  it('applies a saved founder background with no license of any kind', async () => {
    storeFounder();
    const { result } = await setup();
    expect(result.current.bgDark).toBe('founder');
    expect(result.current.bgLight).toBe('founder');
    expect(html).toHaveAttribute('data-bg-dark', 'founder');
    expect(html).toHaveAttribute('data-bg-light', 'founder');
    expect(localStorage.getItem(lsKey('appearance:bgDark'))).toBe(JSON.stringify('founder'));
  });

  it('exposes no founder perk state', async () => {
    storeFounder();
    const { result } = await setup();
    expect(result.current).not.toHaveProperty('founderUnlocked');
    expect(result.current).not.toHaveProperty('founderSaved');
  });
});

describe('Purple and gold background in the real Appearance picker', () => {
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
  const goldRadios = () => screen.queryAllByRole('radio', { name: /^Purple and gold/ });

  it('is offered in both pickers without any license and applies when picked', async () => {
    render(<Appearance />, { wrapper });
    await settled();
    expect(goldRadios()).toHaveLength(2);
    expect(html).toHaveAttribute('data-bg-dark', 'aurora');
    await userEvent.setup().click(goldRadios()[0]);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(html).toHaveAttribute('data-bg-dark', 'founder');
  });

  it('shows a saved founder choice as selected, with no note about founding or licenses', async () => {
    for (const k of ['appearance:bgDark', 'appearance:bgLight']) {
      localStorage.setItem(lsKey(k), JSON.stringify('founder'));
      server.map.set(k, 'founder');
    }
    const { container } = render(<Appearance />, { wrapper });
    await settled();
    goldRadios().forEach((r) => expect(r).toBeChecked());
    expect(container.textContent).not.toMatch(/founding|founder|licen[sc]e/i);
  });
});
