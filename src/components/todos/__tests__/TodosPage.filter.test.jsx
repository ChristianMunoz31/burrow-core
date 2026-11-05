import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import TodosPage from '../TodosPage';
import { ModeProvider } from '../../../contexts/ModeContext';
import { renderWithProviders } from '../../../test-utils/renderWithProviders';
import { allowSlowSuite } from '../../../test-utils/slowSuite';
import { lsKey } from '../../../utils/storageKeys';
import { stateService } from '../../../services/stateService';

const TODOS = [
  { id: 't1', title: 'Work item', status: 'Backlog', context: 'work', priority: 'low', order: 0 },
  { id: 't2', title: 'Home item', status: 'Backlog', context: 'home', priority: 'low', order: 1 },
  { id: 't3', title: 'Both item', status: 'In Progress', context: 'both', priority: 'low', order: 0 },
];

const h = vi.hoisted(() => ({ add: vi.fn(), reorder: vi.fn(), builder: null }));
const TODOS_REF = vi.hoisted(() => ({ current: [] }));

vi.mock('../../../hooks/useTodos', () => ({
  useTodos: () => ({
    todos: TODOS_REF.current,
    loading: false,
    error: null,
    refresh: vi.fn(),
    add: h.add,
    update: vi.fn(),
    reorder: h.reorder,
    remove: vi.fn(),
  }),
}));

vi.mock('../../../hooks/useTodoColumns', () => ({
  useTodoColumns: () => ({
    columns: [
      { id: 'c1', name: 'Backlog', color: 'gray', order: 0 },
      { id: 'c2', name: 'In Progress', color: 'blue', order: 1 },
      { id: 'c3', name: 'Done', color: 'green', order: 2 },
    ],
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

vi.mock('../../../contexts/PageContextContext', () => ({
  usePageContext: (_key, builder) => {
    h.builder = builder;
  },
}));

vi.mock('../../../services/stateService', () => ({
  stateService: {
    get: vi.fn(async () => undefined),
    put: vi.fn(async () => ({ ok: true })),
  },
}));

allowSlowSuite();

const renderPage = () =>
  renderWithProviders(
    <ModeProvider>
      <TodosPage />
    </ModeProvider>,
  );
const store = (mode) => localStorage.setItem(lsKey('mode'), JSON.stringify(mode));
const filterGroup = () => screen.getByRole('group', { name: 'Show todos' });
const radio = (name) => within(filterGroup()).getByRole('radio', { name });

beforeEach(() => {
  localStorage.clear();
  h.add.mockReset().mockResolvedValue({});
  h.reorder.mockReset().mockResolvedValue({});
  h.builder = null;
  stateService.put.mockClear();
  TODOS_REF.current = TODOS;
});
afterEach(cleanup);

describe('Todos filter', () => {
  it('shows work and both todos, not home ones, when work is stored, with Work checked', () => {
    store('work');
    renderPage();
    expect(radio('Work')).toBeChecked();
    expect(screen.getByText('Work item')).toBeInTheDocument();
    expect(screen.getByText('Both item')).toBeInTheDocument();
    expect(screen.queryByText('Home item')).not.toBeInTheDocument();
  });

  it('names the group Show todos with a visually hidden legend and offers All, Work, Home', () => {
    renderPage();
    expect(screen.getByText('Show todos', { selector: 'legend' })).toHaveClass('sr-only');
    expect(within(filterGroup()).getAllByRole('radio').map((r) => r.value)).toEqual(['all', 'work', 'home']);
    expect(radio('All')).toBeChecked();
    expect(screen.getByText('Home item')).toBeInTheDocument();
  });

  it('picking All saves mode all and shows every todo', async () => {
    store('work');
    const user = userEvent.setup();
    renderPage();
    await user.click(radio('All'));
    expect(stateService.put).toHaveBeenCalledWith('mode', 'all');
    expect(screen.getByText('Home item')).toBeInTheDocument();
    expect(screen.getByText('Work item')).toBeInTheDocument();
  });

  it('picking Home then adding a todo opens the form with Context home', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(radio('Home'));
    expect(stateService.put).toHaveBeenCalledWith('mode', 'home');
    await user.click(screen.getByRole('button', { name: 'Add todo' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('combobox', { name: 'Context' })).toHaveValue('home');
  });

  it('with All a new todo defaults to work', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Add todo' }));
    expect(within(screen.getByRole('dialog')).getByRole('combobox', { name: 'Context' })).toHaveValue('work');
  });

  it('sends Javi a todos context that counts only the shown todos', async () => {
    store('home');
    renderPage();
    await waitFor(() => expect(h.builder).toBeTypeOf('function'));
    // Home plus both: 2 of the 3 todos.
    expect(h.builder().counts.total).toBe(2);
  });

  it('keeps Add todo as the only primary button in the toolbar', () => {
    renderPage();
    const toolbar = filterGroup().parentElement;
    const buttons = within(toolbar).getAllByRole('button');
    expect(buttons.map((b) => b.textContent.trim())).toEqual(['Add todo', 'Columns']);
  });

  it('moves the selection with the arrow keys', async () => {
    const user = userEvent.setup();
    renderPage();
    radio('All').focus();
    await user.keyboard('{ArrowRight}');
    expect(radio('Work')).toBeChecked();
    expect(stateService.put).toHaveBeenCalledWith('mode', 'work');
  });

  it('uses the quiet tone for the filter so Add todo stays the only filled control', () => {
    renderPage();
    const pill = filterGroup().querySelector('label span');
    expect(pill).toHaveClass('text-xs');
    expect(pill).not.toHaveClass('peer-checked:bg-slate-slateBlue');
  });

  it('marking a Work todo done restamps the hidden Home todos in the same column from the full list', async () => {
    store('work');
    const user = userEvent.setup();
    renderPage();
    expect(screen.queryByText('Home item')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Mark Work item done' }));
    expect(h.reorder).toHaveBeenCalledTimes(1);
    const items = h.reorder.mock.calls[0][0];
    expect(items).toContainEqual({ id: 't1', status: 'Done', order: 0 });
    // t2 (Home, hidden) is in Backlog with t1: it moves up so Backlog stays 0..n-1.
    expect(items).toContainEqual({ id: 't2', status: 'Backlog', order: 0 });
  });

  it('says so when the filter hides every todo, naming the filter, and not when All is shown', async () => {
    TODOS_REF.current = [TODOS[0]];
    store('home');
    const { unmount } = renderPage();
    expect(screen.queryByText('Work item')).not.toBeInTheDocument();
    expect(screen.getByText('No Home todos. Show All to see every todo.')).toHaveClass('text-sm', 'text-slate-slate400');
    unmount();
    store('all');
    renderPage();
    expect(screen.queryByText(/Show All to see every todo/)).not.toBeInTheDocument();
  });

  it('shows no filtered-empty line when there are no todos at all', () => {
    TODOS_REF.current = [];
    store('work');
    renderPage();
    expect(screen.queryByText(/Show All to see every todo/)).not.toBeInTheDocument();
  });
});
