import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Settings from '../Settings';
import Home from '../Home';
import CrossInsightsCard from '../../components/home/CrossInsightsCard';
import FolderReportCard from '../../components/folders/FolderReportCard';
import { ThemeProvider } from '../../contexts/ThemeContext';
import { ModeProvider } from '../../contexts/ModeContext';
import { ToastProvider } from '../../contexts/ToastContext';
import { PRO_UI_INCLUDED } from '../../extensions/proExtensions';
import { PRO_NOT_INCLUDED_COPY } from '../../constants/proFeatures';
import { installMatchMedia, resetDom } from '../../test-utils/settingsHarness';
import { jsonResponse } from '../../test-utils/sseResponse';

// Burrow is free for everyone (docs/adr/0002-free-for-everyone.md). This is the core build: the private module's
// UI is not compiled in (PRO_UI_INCLUDED is false), and no screen may mention a price, a trial, a license key,
// an upgrade or founding members, or offer a License section.

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
vi.mock('../../hooks/useJarvisStatus', () => ({ useJarvisStatus: () => ({ status: null, loading: false }) }));
vi.mock('../../hooks/useCrossInsights', () => ({
  useCrossInsights: () => ({
    loading: false,
    result: {
      status: 'ok',
      windowDays: 60,
      coverage: {},
      missing: [],
      insights: [
        {
          id: 'sleep_dining',
          n: 24,
          rho: -0.42,
          r: -0.4,
          groupA: { label: 'under 7h', days: 9, mean: 18.5 },
          groupB: { label: '7h or more', days: 15, mean: 13.4 },
          effectPct: 38,
          effectAbs: 5.1,
          unit: 'usd',
          text: 'Synthetic insight text.',
        },
      ],
    },
  }),
}));
// Home's data cards fetch their own data; stubs keep this test about the words on screen.
vi.mock('../../components/budget/BudgetWidget', () => ({ default: () => null }));
vi.mock('../../components/budget/SubscriptionsWidget', () => ({ default: () => null }));
vi.mock('../../components/health/HealthWidget', () => ({ default: () => null }));
vi.mock('../../components/todos/TodosWidget', () => ({ default: () => null }));
vi.mock('../../components/calendar/CalendarWidget', () => ({ default: () => null }));
vi.mock('../../components/habits/HabitsWidget', () => ({ default: () => null }));
vi.mock('../../components/journal/JournalWidget', () => ({ default: () => null }));
vi.mock('../../components/notes/NotesWidget', () => ({ default: () => null }));
vi.mock('../../components/bookmarks/BookmarksWidget', () => ({ default: () => null }));
vi.mock('../../components/focus/FocusWidget', () => ({ default: () => null }));
vi.mock('../../components/countdowns/CountdownsWidget', () => ({ default: () => null }));
vi.mock('../../components/home/BackupHealthNotice', () => ({ default: () => null }));
vi.mock('../../components/settings/DataFolderWarning', () => ({ default: () => null }));
vi.mock('../../components/home/DirectImportNotice', () => ({ default: () => null }));

const FORBIDDEN = /buy|license key|trial|upgrade|founding/i;

beforeEach(() => {
  server.map.clear();
  resetDom();
  installMatchMedia(false);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse({ error: 'ai_not_configured', reason: 'no_model', message: 'Javi needs a model.' }, 503)),
  );
});
afterEach(() => {
  cleanup();
  resetDom();
  vi.unstubAllGlobals();
});

function wrap(ui) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ToastProvider>
          <ThemeProvider>
            <ModeProvider>{ui}</ModeProvider>
          </ThemeProvider>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {});
};

describe('free for everyone (core build)', () => {
  it('is a build without the private module UI', () => {
    expect(PRO_UI_INCLUDED).toBe(false);
  });

  it('Settings has no License section, nav entry or purchase, trial, upgrade or founding wording', async () => {
    const { container } = wrap(<Settings />);
    await settle();
    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^License$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^License$/ })).not.toBeInTheDocument();
    expect(document.getElementById('license')).toBeNull();
    expect(container.textContent).not.toMatch(FORBIDDEN);
    expect(screen.queryByRole('textbox', { name: /license/i })).not.toBeInTheDocument();
  });

  it('Home has no purchase, trial, upgrade or founding wording, and no trial banner or badge', async () => {
    const { container } = wrap(<Home />);
    await settle();
    expect(screen.getByRole('heading', { name: 'Javi' })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(FORBIDDEN);
    expect(container.textContent).not.toMatch(/\bpro\b/i);
    expect(screen.queryByText(/days? left/i)).not.toBeInTheDocument();
  });

  it('offers the purple and gold background in both pickers with no license, and applies it', async () => {
    const user = userEvent.setup();
    wrap(<Settings />);
    await settle();
    const radios = screen.getAllByRole('radio', { name: /^Purple and gold/ });
    expect(radios).toHaveLength(2);
    await user.click(radios[0]);
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-bg-dark', 'founder'));
    expect(server.map.get('appearance:bgDark')).toBe('founder');
  });

  it('keeps a saved purple and gold background without any perk check', async () => {
    server.map.set('appearance:bgDark', 'founder');
    server.map.set('appearance:bgLight', 'founder');
    localStorage.setItem('burrow.appearance:bgDark', JSON.stringify('founder'));
    localStorage.setItem('burrow.appearance:bgLight', JSON.stringify('founder'));
    wrap(<Settings />);
    await settle();
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-bg-dark', 'founder'));
    expect(document.documentElement).toHaveAttribute('data-bg-light', 'founder');
  });

  it('offers only Butler as a Javi character, with no tier label', async () => {
    wrap(<Settings />);
    await settle();
    const group = screen.getByRole('group', { name: "Javi's character" });
    expect(within(group).getAllByRole('radio')).toHaveLength(1);
    expect(group.textContent).not.toMatch(/\bpro\b/i);
  });

  it('Explain on Home shows the not-included notice, never an upgrade prompt', async () => {
    const user = userEvent.setup();
    const { container } = wrap(<CrossInsightsCard />);
    await user.click(screen.getByRole('button', { name: 'Explain' }));
    expect(await screen.findByText(PRO_NOT_INCLUDED_COPY)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(FORBIDDEN);
  });

  it('the folder report host shows the not-included notice, never an upgrade prompt', () => {
    const { container } = wrap(<FolderReportCard folder={{ id: 'f1', name: 'Project notes', report: null }} busy={false} />);
    expect(screen.getByText(PRO_NOT_INCLUDED_COPY)).toBeInTheDocument();
    expect(document.querySelector('[data-capability="folder_report"][data-reason="pro_not_included"]')).not.toBeNull();
    expect(container.textContent).not.toMatch(FORBIDDEN);
    expect(screen.queryByRole('button', { name: 'Write report' })).not.toBeInTheDocument();
  });
});
