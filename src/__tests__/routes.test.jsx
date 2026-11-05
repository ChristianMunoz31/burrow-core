import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import App from '../App';
import { resetDom } from '../test-utils/settingsHarness';

// The real App route table, with the browser router swapped for a memory router and every
// page and provider outside the routing question stubbed.
const entry = vi.hoisted(() => ({ path: '/', basename: undefined, rows: {} }));

vi.mock('react-router-dom', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    BrowserRouter: ({ children }) => (
      <actual.MemoryRouter initialEntries={[entry.path]} basename={entry.basename}>
        {children}
      </actual.MemoryRouter>
    ),
  };
});

vi.mock('../services/stateService', () => ({
  stateService: {
    get: vi.fn(async (key) => entry.rows[key]),
    put: vi.fn(async (key, value) => {
      entry.rows[key] = value;
    }),
  },
}));

vi.mock('../contexts/ThemeContext', () => ({ ThemeProvider: ({ children }) => children }));
vi.mock('../auth/useAuth', () => ({ AuthProvider: ({ children }) => children }));
vi.mock('../auth/AuthGate', () => ({ default: ({ children }) => children }));
vi.mock('../contexts/ToastContext', () => ({ ToastProvider: ({ children }) => children }));
vi.mock('../components/PendingSyncFlush', () => ({ default: () => null }));
vi.mock('../components/onboarding/Onboarding', () => ({ default: () => null }));

// The shell chrome is reduced to one probe that shows where the router is.
vi.mock('../components/shell/AppShell', () => ({
  default: function ShellStub({ children }) {
    const { pathname, search, hash } = useLocation();
    return (
      <div>
        <div data-testid="where">{`${pathname}${search}${hash}`}</div>
        {children}
      </div>
    );
  },
}));

// The real Health page header (shown as Sleep & activity), without its Oura data.
vi.mock('../components/health/HealthPage', () => ({ default: () => null }));

for (const [file, name] of [
  ['Home', 'Overview'],
  ['Budget', 'Budget page'],
  ['Todos', 'Todos page'],
  ['Habits', 'Habits page'],
  ['Journal', 'Journal page'],
  ['Notes', 'Notes page'],
  ['Bookmarks', 'Bookmarks page'],
  ['Focus', 'Focus page'],
  ['Folders', 'Folders page'],
  ['Countdowns', 'Countdowns page'],
  ['Calendar', 'Calendar page'],
  ['Settings', 'Settings page'],
  ['DataBrowser', 'Data page'],
]) {
  vi.doMock(`../pages/${file}`, () => ({ default: () => <h2>{name}</h2> }));
}

function renderApp(path, { basename, rows = {} } = {}) {
  entry.path = path;
  entry.basename = basename;
  entry.rows = rows;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

const where = () => screen.getByTestId('where').textContent;

beforeEach(() => resetDom());
afterEach(() => {
  cleanup();
  resetDom();
});

describe('routing (flat routes)', () => {
  it('keeps the hash of /settings#updates', async () => {
    renderApp('/settings#updates');
    await screen.findByRole('heading', { name: 'Settings page' });
    expect(where()).toBe('/settings#updates');
  });

  it('keeps the hash of /folders#add-folder', async () => {
    renderApp('/folders#add-folder');
    await screen.findByRole('heading', { name: 'Folders page' });
    expect(where()).toBe('/folders#add-folder');
  });

  it('/budget?import=1 keeps the query', async () => {
    renderApp('/budget?import=1');
    await screen.findByRole('heading', { name: 'Budget page' });
    expect(where()).toBe('/budget?import=1');
  });

  it('/health renders Sleep & activity even with mode work (no bounce)', async () => {
    renderApp('/health', { rows: { mode: 'work' } });
    await screen.findByRole('heading', { name: 'Sleep & activity' });
    expect(where()).toBe('/health');
  });

  it('/weather redirects to Home, where the Javi card shows the weather', async () => {
    renderApp('/weather');
    await screen.findByRole('heading', { name: 'Overview' });
    expect(where()).toBe('/');
  });

  it('/weather redirects inside a basename (Vite base subpath)', async () => {
    renderApp('/app/weather', { basename: '/app' });
    await screen.findByRole('heading', { name: 'Overview' });
    expect(where()).toBe('/');
  });

  it('/calendar and /budget/planner render under mode work', async () => {
    renderApp('/calendar', { rows: { mode: 'work' } });
    await screen.findByRole('heading', { name: 'Calendar page' });
    cleanup();
    renderApp('/budget/planner', { rows: { mode: 'work' } });
    await screen.findByRole('heading', { name: 'Budget page' });
    expect(where()).toBe('/budget/planner');
  });

  it('/todos renders Todos', async () => {
    renderApp('/todos');
    await screen.findByRole('heading', { name: 'Todos page' });
    expect(where()).toBe('/todos');
  });

  it('an unknown route goes to Home', async () => {
    renderApp('/x');
    await screen.findByRole('heading', { name: 'Overview' });
    expect(where()).toBe('/');
  });

  describe('under a subpath base', () => {
    it('keeps /settings#updates', async () => {
      renderApp('/burrow/settings#updates', { basename: '/burrow' });
      await screen.findByRole('heading', { name: 'Settings page' });
      expect(where()).toBe('/settings#updates');
    });

    it('keeps /folders#add-folder', async () => {
      renderApp('/burrow/folders#add-folder', { basename: '/burrow' });
      await screen.findByRole('heading', { name: 'Folders page' });
      expect(where()).toBe('/folders#add-folder');
    });

    it('keeps /budget?import=1', async () => {
      renderApp('/burrow/budget?import=1', { basename: '/burrow' });
      await screen.findByRole('heading', { name: 'Budget page' });
      expect(where()).toBe('/budget?import=1');
    });
  });
});
