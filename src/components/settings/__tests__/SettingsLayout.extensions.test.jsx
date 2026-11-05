import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Wrench } from 'lucide-react';
import Settings from '../../../pages/Settings';
import SettingsLayout from '../SettingsLayout';
import { SETTINGS_SECTIONS, settingsSectionsFor } from '../settingsSections';
import { SETTINGS_EXTENSIONS } from '../../../extensions/settingsExtensions';
import { ThemeProvider } from '../../../contexts/ThemeContext';
import { ModeProvider } from '../../../contexts/ModeContext';
import { ToastProvider } from '../../../contexts/ToastContext';
import { useAppInfo } from '../../../hooks/useAppInfo';
import { installMatchMedia, resetDom } from '../../../test-utils/settingsHarness';
import { allowSlowSuite } from '../../../test-utils/slowSuite';

allowSlowSuite();

vi.mock('../../../hooks/useAppInfo', () => ({ useAppInfo: vi.fn() }));
vi.mock('../../../services/stateService', () => ({
  stateService: {
    getAll: vi.fn(async () => ({})),
    get: vi.fn(async () => undefined),
    put: vi.fn(async () => ({ ok: true })),
  },
}));
vi.mock('../../../hooks/useJarvisStatus', () => ({ useJarvisStatus: () => ({ status: null }) }));
vi.mock('../../../services/auditService', () => ({
  auditService: { list: vi.fn(async () => ({ entries: [], nextBefore: null, available: true })) },
}));
vi.mock('../../../services/secretsService', () => ({
  secretsService: {
    list: vi.fn(async () => ({ encryption: { enabled: true }, storage: { available: true }, writable: true, secrets: [] })),
    save: vi.fn(),
    remove: vi.fn(),
    test: vi.fn(),
  },
}));
vi.mock('../../../services/aiSettingsService', () => ({
  aiSettingsService: { get: vi.fn(() => new Promise(() => {})), models: vi.fn(() => new Promise(() => {})) },
}));

const CORE_LABELS = ['Appearance', 'Budget', 'General', 'AI', 'Data & storage', 'Privacy & activity', 'Network', 'Connected services', 'Updates'];
const origIO = globalThis.IntersectionObserver;

class FakeIO {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  resetDom();
  installMatchMedia(true);
  globalThis.IntersectionObserver = FakeIO;
  Element.prototype.scrollIntoView = vi.fn();
  useAppInfo.mockReturnValue({ info: { version: '1.0.0', channel: 'dev', devTools: true } });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  resetDom();
  globalThis.IntersectionObserver = origIO;
});

describe('Settings extensions in the core build', () => {
  it('the core list of extensions is empty and frozen', () => {
    expect(SETTINGS_EXTENSIONS).toEqual([]);
    expect(Object.isFrozen(SETTINGS_EXTENSIONS)).toBe(true);
  });

  it('settingsSectionsFor lists only the core sections, even when the server reports devTools', () => {
    expect(settingsSectionsFor({ devTools: true })).toEqual(SETTINGS_SECTIONS);
    expect(settingsSectionsFor(null)).toEqual(SETTINGS_SECTIONS);
  });

  it('settingsSectionsFor appends an injected extension only when its enabled() is exactly true', () => {
    const ext = (enabled) => [{ id: 'extra', label: 'Extra', icon: Wrench, Component: () => null, enabled }];
    expect(settingsSectionsFor({ flag: true }, ext((i) => i?.flag === true)).map((s) => s.id)).toEqual([...SETTINGS_SECTIONS.map((s) => s.id), 'extra']);
    expect(settingsSectionsFor({ flag: 'yes' }, ext((i) => i?.flag)).map((s) => s.id)).toEqual(SETTINGS_SECTIONS.map((s) => s.id));
    expect(settingsSectionsFor({ flag: false }, ext((i) => i?.flag === true))).toEqual(SETTINGS_SECTIONS);
  });

  it('SettingsLayout with info.devTools true shows exactly the nine core sections and no Developer', () => {
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <SettingsLayout>
          <div />
        </SettingsLayout>
      </MemoryRouter>,
    );
    const nav = within(screen.getAllByRole('navigation', { name: 'Settings sections' })[1]);
    const labels = nav
      .getAllByRole('link')
      .map((a) => a.textContent)
      .filter((t) => t !== 'Browse your data');
    expect(labels).toEqual(CORE_LABELS);
    expect(nav.queryByRole('link', { name: 'Developer' })).not.toBeInTheDocument();
  });

  it('the Settings page renders no Developer card with info.devTools true', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/settings']}>
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
    expect(document.getElementById('updates')).toBeInTheDocument();
    expect(document.getElementById('license')).toBeNull();
    expect(document.getElementById('developer')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Developer' })).not.toBeInTheDocument();
  });
});
