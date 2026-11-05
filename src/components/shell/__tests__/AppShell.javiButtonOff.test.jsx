import '@testing-library/jest-dom/vitest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import AppShell from '../AppShell';
import { openCommandPalette } from '../../../hooks/useCommandPalette';
import { openJavi } from '../../javi/openJavi';
import { renderWithProviders } from '../../../test-utils/renderWithProviders';
import { jsonResponse } from '../../../test-utils/sseResponse';

// Real AppShell, command palette and Javi panel; only the shell chrome, settings and network are faked.
vi.mock('../BurgerMenu', () => ({ default: () => null }));
vi.mock('../TopBar', () => ({ default: () => null }));
vi.mock('../../../contexts/ModeContext', async (orig) => ({
  ...(await orig()),
  useMode: () => ({ mode: 'all' }),
}));

const themeApi = vi.hoisted(() => ({ setPreference: () => {} }));

vi.mock('../../../contexts/ThemeContext', async (orig) => ({
  ...(await orig()),
  useTheme: () => ({ preference: 'system', setPreference: themeApi.setPreference }),
}));

const settings = vi.hoisted(() => ({ value: { showButton: false, autoAdvise: false } }));
vi.mock('../../../hooks/useJaviSettings', () => ({ useJaviSettings: () => settings.value }));

const BAR = 'Javi, AI helper';
const jarvisFetch = vi.fn();

const INBOX_ITEM = { id: 'page:notes', kind: 'page', page: 'notes', to: '/notes', label: 'Notes changed since your last insight', at: '2026-10-09T10:00:00.000Z' };

function routedFetch(url, init) {
  const path = String(url);
  if (path.startsWith('/api/jarvis/inbox')) return Promise.resolve(jsonResponse({ data: { items: [INBOX_ITEM] } }));
  if (path === '/api/jarvis/conversations') return Promise.resolve(jsonResponse({ id: 'conv-1' }));
  if (path === '/api/jarvis') return jarvisFetch(url, init);
  // Typed questions run Javi's tools, a Pro capability, so this user has Pro.
  if (path === '/api/license') return Promise.resolve(jsonResponse({ pro: true, state: 'pro', edition: 'standard', proSource: 'license', trial: null }));
  return Promise.resolve(jsonResponse({ results: [] }));
}

function mount(path = '/todos') {
  return renderWithProviders(
    <MemoryRouter initialEntries={[path]}>
      <AppShell>
        <button type="button">page control</button>
      </AppShell>
    </MemoryRouter>,
  );
}

beforeAll(async () => {
  await import('../../javi/JaviPanel');
}, 30000);

beforeEach(() => {
  settings.value = { showButton: false, autoAdvise: false };
  jarvisFetch.mockReset();
  vi.stubGlobal('fetch', routedFetch);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Javi bar setting off', () => {
  it('draws no Javi bar and no bottom padding', () => {
    const { container } = mount();
    expect(screen.queryByRole('button', { name: BAR })).not.toBeInTheDocument();
    expect(container.querySelector('.animate-page-in').className).not.toMatch(/\bpb-\d+\b/);
    expect(document.documentElement.style.getPropertyValue('--javi-toast-offset')).toBe('');
  });

  it('shows no count and mounts no new-items status, but the strip still lists the item in the panel', async () => {
    const user = userEvent.setup();
    mount();
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText(/new for you/)).not.toBeInTheDocument();
    expect(screen.queryAllByRole('status')).toHaveLength(0);
    act(() => openCommandPalette());
    await user.click(await screen.findByRole('option', { name: /Open Javi/ }));
    expect(await screen.findByRole('button', { name: 'Notes changed since your last insight' })).toBeInTheDocument();
  });

  it('the palette still offers Open Javi and choosing it opens the panel', async () => {
    const user = userEvent.setup();
    mount();
    act(() => openCommandPalette());
    await user.click(await screen.findByRole('option', { name: /Open Javi/ }));
    expect(await screen.findByRole('dialog', { name: 'Javi' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: BAR })).not.toBeInTheDocument();
  });

  it('closing returns focus to the element focused before opening', async () => {
    const user = userEvent.setup();
    mount();
    const control = screen.getByRole('button', { name: 'page control' });
    control.focus();
    act(() => openJavi());
    await screen.findByRole('dialog', { name: 'Javi' });
    // With the bar hidden by the setting the window closes (X), it does not collapse into a bar.
    expect(screen.queryByRole('button', { name: 'Collapse Javi' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close Javi' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Javi' })).not.toBeInTheDocument());
    expect(control).toHaveFocus();
  });

  it('closing falls back to the main content when the opener is gone, without throwing', async () => {
    const user = userEvent.setup();
    mount();
    const control = screen.getByRole('button', { name: 'page control' });
    control.focus();
    act(() => openJavi());
    await screen.findByRole('dialog', { name: 'Javi' });
    control.remove();
    await user.click(screen.getByRole('button', { name: 'Close Javi' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Javi' })).not.toBeInTheDocument());
    expect(document.querySelector('main')).toHaveFocus();
  });

  it('Javi is unavailable on a path with no Javi page', async () => {
    mount('/nowhere');
    act(() => openJavi());
    await act(async () => {});
    expect(screen.queryByRole('dialog', { name: 'Javi' })).not.toBeInTheDocument();
  });
});
