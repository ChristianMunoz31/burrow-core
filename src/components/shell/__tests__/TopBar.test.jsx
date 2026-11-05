import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TopBar from '../TopBar';
import BurgerMenu from '../BurgerMenu';
import { ModeProvider } from '../../../contexts/ModeContext';
import { resetDom } from '../../../test-utils/settingsHarness';

// No server in tests: the synced-setting hook falls back to localStorage.
vi.mock('../../../services/stateService', () => ({
  stateService: {
    get: vi.fn(async () => undefined),
    put: vi.fn(async () => undefined),
  },
}));

// The bar itself no longer reads the profile; TrialBadge and the drawer test below still may.
const profile = vi.hoisted(() => ({ displayName: null }));
vi.mock('../../../hooks/useProfile', () => ({
  useProfile: () => ({ displayName: profile.displayName, onboarded: true, isLoading: false, save: vi.fn() }),
}));

vi.mock('../../../hooks/useBriefing', () => ({
  useBriefing: () => ({ alerts: [] }),
}));

const appInfo = vi.hoisted(() => ({ info: null }));
vi.mock('../../../hooks/useAppInfo', () => ({ useAppInfo: () => ({ info: appInfo.info }) }));

// Deliberately no ThemeProvider: TopBar must not depend on the theme context.
function renderTopBar(path = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <ModeProvider>
          <TopBar />
        </ModeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  profile.displayName = null;
  appInfo.info = null;
  resetDom();
});
afterEach(() => {
  cleanup();
  resetDom();
});

describe('TopBar', () => {
  it('has no greeting heading, date or clock (the bar is calm)', () => {
    profile.displayName = 'Sam';
    renderTopBar('/todos');
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
    const bar = screen.getByRole('banner');
    expect(bar.textContent).not.toMatch(/Good (morning|afternoon|evening|night)|Up late|Sam|local time/);
    expect(bar.textContent).not.toMatch(/\d{1,2}:\d{2}/);
    expect(bar.textContent).not.toMatch(/Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday/);
  });

  it('orders Back, the Burrow wordmark, search, bell and gear', () => {
    renderTopBar('/todos');
    const controls = [...screen.getByRole('banner').querySelectorAll('a[href], button')];
    expect(controls.map((el) => el.getAttribute('aria-label'))).toEqual([
      'Back',
      'Burrow, go to Home',
      'Search commands and your data',
      'Notifications',
      'Settings',
    ]);
    expect(screen.getByRole('link', { name: 'Burrow, go to Home' })).toHaveTextContent(/^Burrow$/);
    expect(screen.getByRole('link', { name: 'Burrow, go to Home' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
  });

  it('marks the wordmark as the current page on Home only', () => {
    renderTopBar('/');
    expect(screen.getByRole('link', { name: 'Burrow, go to Home' })).toHaveAttribute('aria-current', 'page');
    cleanup();
    renderTopBar('/todos');
    expect(screen.getByRole('link', { name: 'Burrow, go to Home' })).not.toHaveAttribute('aria-current');
  });

  it.each([
    ['/settings', true],
    ['/settings/data', true],
    ['/todos', false],
    ['/settingsx', false],
  ])('gear on %s is active: %s', (path, active) => {
    renderTopBar(path);
    const gear = screen.getByRole('link', { name: 'Settings' });
    if (active) {
      expect(gear).toHaveAttribute('aria-current', 'page');
      expect(gear).toHaveClass('bg-slate-slate700/60');
    } else {
      expect(gear).not.toHaveAttribute('aria-current');
      expect(gear).not.toHaveClass('bg-slate-slate700/60');
    }
  });

  it('shows the Dev build badge in the dev channel only', () => {
    appInfo.info = { version: '0.2.0-dev.1', channel: 'dev', desktop: true };
    renderTopBar();
    expect(screen.getByText('Dev build')).toBeInTheDocument();
    cleanup();
    appInfo.info = { version: '0.1.0', channel: 'stable', desktop: true };
    renderTopBar();
    expect(screen.queryByText('Dev build')).not.toBeInTheDocument();
  });

  it('has no theme toggle button (theme is controlled from Settings only)', () => {
    renderTopBar();
    expect(screen.queryByRole('button', { name: /\b(theme|light|dark)\b/i })).toBeNull();
  });

  it('still renders the search and notifications controls, and no workspace control', () => {
    renderTopBar();
    expect(screen.getByRole('button', { name: 'Search commands and your data' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Workspace|Budget|Journal/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Workspace' })).not.toBeInTheDocument();
  });

  describe('back button', () => {
    it('keeps a dimmed, disabled Back on Home and shows Back on other routes, before the wordmark', () => {
      renderTopBar('/');
      expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
      const slot = screen.getByTestId('back-placeholder');
      expect(slot).toBeDisabled();
      expect(slot.compareDocumentPosition(screen.getByRole('link', { name: 'Burrow, go to Home' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      cleanup();
      renderTopBar('/todos');
      const back = screen.getByRole('button', { name: 'Back' });
      const wordmark = screen.getByRole('link', { name: 'Burrow, go to Home' });
      expect(back.compareDocumentPosition(wordmark) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  describe('palette shortcut hint', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('puts Ctrl K in the search title on non-Mac platforms', () => {
      vi.stubGlobal('navigator', { ...window.navigator, userAgentData: undefined, platform: 'Win32' });
      renderTopBar();
      const search = screen.getByRole('button', { name: 'Search commands and your data' });
      expect(search).toHaveAttribute('title', 'Search (Ctrl K)');
      expect(search).toHaveAttribute('aria-keyshortcuts', 'Control+K Meta+K');
      // No visible label or kbd any more.
      expect(screen.queryByText('Ctrl K')).not.toBeInTheDocument();
      expect(screen.queryByText('Search')).not.toBeInTheDocument();
    });

    it('shows ⌘K on Mac', () => {
      vi.stubGlobal('navigator', { ...window.navigator, userAgentData: undefined, platform: 'MacIntel' });
      renderTopBar();
      expect(screen.getByRole('button', { name: 'Search commands and your data' })).toHaveAttribute('title', 'Search (⌘K)');
    });

    it('prefers userAgentData.platform when present', () => {
      vi.stubGlobal('navigator', { ...window.navigator, userAgentData: { platform: 'macOS' }, platform: 'Win32' });
      renderTopBar();
      expect(screen.getByRole('button', { name: 'Search commands and your data' })).toHaveAttribute('title', 'Search (⌘K)');
    });
  });

  describe('menu and shortcuts', () => {
    // Mirrors AppShell's structure: BurgerMenu is rendered before <main><TopBar/>.
    function renderShellOrder() {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      return render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={['/budget']}>
            <ModeProvider>
              <div>
                <BurgerMenu />
                <main>
                  <TopBar />
                </main>
              </div>
            </ModeProvider>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    }

    it('the burger is followed by Back in the header, and the open menu has no workspace switch', () => {
      renderShellOrder();
      const burger = screen.getByRole('button', { name: 'Navigation menu' });
      const buttons = [...document.querySelectorAll('button')];
      expect(buttons[buttons.indexOf(burger) + 1]).toBe(screen.getByRole('button', { name: 'Back' }));
      fireEvent.click(burger);
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.queryByRole('group', { name: 'Workspace' })).not.toBeInTheDocument();
    });

    it.each(['Digit1', 'Digit2'])('Alt+%s does nothing any more', (code) => {
      renderShellOrder();
      const e = new KeyboardEvent('keydown', { code, altKey: true, bubbles: true, cancelable: true });
      window.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(false);
    });
  });
});
