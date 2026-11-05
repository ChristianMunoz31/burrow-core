import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AppShell from '../AppShell';
import { usePageContext } from '../../../contexts/PageContextContext';
import { ToastProvider } from '../../../contexts/ToastContext';
import { answerInbox, inboxState, resetInbox } from '../../../test-utils/javiInbox.js';

// Shell chrome is irrelevant here; only the Javi bar wiring (settings + route) is under test.
vi.mock('../BurgerMenu', () => ({ default: () => null }));
vi.mock('../TopBar', () => ({ default: () => null }));
vi.mock('../../palette/CommandPalette', () => ({ default: () => null }));

const settings = vi.hoisted(() => ({ value: { showButton: true, autoAdvise: true } }));
vi.mock('../../../hooks/useJaviSettings', () => ({ useJaviSettings: () => settings.value }));

const NAME = 'Javi, AI helper';

const queryClient = new QueryClient();

const TODOS = [{ id: 't1', title: 'Synthetic todo' }];

// A page that registers its data signal the way TodosPage does.
function TodosWithData({ data }) {
  usePageContext('todos', () => ({ todos: data }), data);
  return <p>page body</p>;
}

function mount(path, body = <p>page body</p>) {
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <AppShell>{body}</AppShell>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  settings.value = { showButton: true, autoAdvise: true };
  resetInbox();
  queryClient.clear();
  vi.stubGlobal('fetch', vi.fn((url, init) => answerInbox(url, init) ?? Promise.resolve({ ok: false, status: 404, json: async () => ({}) })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AppShell Javi bar wiring', () => {
  it('shows the Javi bar on a normal page', () => {
    mount('/todos');
    expect(screen.getByRole('button', { name: NAME })).toBeInTheDocument();
  });

  it('hides the Javi bar on a path with no Javi page', () => {
    mount('/nowhere');
    expect(screen.queryByRole('button', { name: NAME })).not.toBeInTheDocument();
    expect(screen.getByText('page body')).toBeInTheDocument();
  });

  it.each(['/', '/settings', '/settings/x', '/settings/data'])('shows no Javi bar or window on %s', (path) => {
    mount(path);
    expect(screen.queryByRole('button', { name: NAME })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('page body')).toBeInTheDocument();
  });

  it('hides the Javi bar when the setting is off', () => {
    settings.value = { showButton: false, autoAdvise: true };
    mount('/todos');
    expect(screen.queryByRole('button', { name: NAME })).not.toBeInTheDocument();
  });

  // The exact padding value is the shell's (its own test); this checks it follows the bar.
  it('reserves bottom padding only while the Javi bar is shown', () => {
    const { container, unmount } = mount('/todos');
    expect(container.querySelector('.animate-page-in').className).toMatch(/\bpb-\d+\b/);
    unmount();
    settings.value = { showButton: false, autoAdvise: true };
    const off = mount('/todos');
    expect(off.container.querySelector('.animate-page-in').className).not.toMatch(/\bpb-\d+\b/);
  });

  it('makes no AI request just by rendering: only the inbox read and its page report', async () => {
    mount('/todos');
    await waitFor(() => expect(inboxState.posts).toEqual([{ ids: [] }]));
    const paths = fetch.mock.calls.map(([url]) => String(url));
    expect(paths.every((p) => p.startsWith('/api/jarvis/inbox') || p === '/api/jarvis/briefing')).toBe(true);
  });

  it('counts every new item except the current page', async () => {
    inboxState.items = [
      { id: 'page:todos', kind: 'page', page: 'todos', to: '/todos', label: 'Todos changed since your last insight', at: '2026-10-09T10:00:00.000Z' },
      { id: 'page:notes', kind: 'page', page: 'notes', to: '/notes', label: 'Notes changed since your last insight', at: '2026-10-09T09:00:00.000Z' },
      { id: 'page:budget', kind: 'page', page: 'budget', to: '/budget', label: 'Budget changed since your last insight', at: '2026-10-09T08:00:00.000Z' },
    ];
    mount('/todos');
    expect(await screen.findByRole('button', { name: `${NAME}, 2 new for you` })).toBeInTheDocument();
  });

  it('counts the current page too while it has data and is unseen; opening Javi there clears it', async () => {
    inboxState.unseen = ['todos'];
    inboxState.items = [
      { id: 'page:notes', kind: 'page', page: 'notes', to: '/notes', label: 'Notes changed since your last insight', at: '2026-10-09T09:00:00.000Z' },
    ];
    mount('/todos', <TodosWithData data={TODOS} />);
    const bar = await screen.findByRole('button', { name: `${NAME}, 2 new for you` });
    bar.click();
    await waitFor(() => expect(inboxState.posts).toContainEqual({ ids: ['page:todos'] }));
    await waitFor(() => expect(inboxState.unseen).toEqual([]));
  });

  it('a page with no data adds nothing even when unseen', async () => {
    inboxState.unseen = ['todos'];
    mount('/todos', <TodosWithData data={null} />);
    await waitFor(() => expect(inboxState.posts).toHaveLength(1));
    expect(screen.getByRole('button', { name: NAME })).toBeInTheDocument();
  });
});
