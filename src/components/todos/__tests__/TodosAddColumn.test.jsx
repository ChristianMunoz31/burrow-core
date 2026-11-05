import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import TodosPage from '../TodosPage';
import { ModeProvider } from '../../../contexts/ModeContext';
import { renderWithProviders } from '../../../test-utils/renderWithProviders';
import { lsKey } from '../../../utils/storageKeys';
import { userError } from '../../../utils/apiError';
import { allowSlowSuite } from '../../../test-utils/slowSuite';

const BASE_TODOS = [
  { id: 't1', title: 'Write docs', description: 'Draft', due: '2026-05-01', status: 'Backlog', context: 'work', priority: 'low', order: 0 },
  { id: 't2', title: 'Ship it', status: 'In Progress', context: 'work', priority: 'high', order: 0 },
  { id: 't3', title: 'Lost one', status: 'Mystery', context: 'work', priority: 'medium', order: 0 },
];

const h = vi.hoisted(() => ({
  add: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  todos: [],
}));

vi.mock('../../../hooks/useTodos', () => ({
  useTodos: () => ({
    todos: h.todos,
    loading: false,
    error: null,
    add: h.add,
    update: h.update,
    reorder: vi.fn(),
    remove: h.remove,
  }),
}));

const columns = [
  { id: 'c1', name: 'Backlog', color: 'gray', order: 0 },
  { id: 'c2', name: 'In Progress', color: 'blue', order: 1 },
  { id: 'c3', name: 'Done', color: 'green', order: 2 },
];
vi.mock('../../../hooks/useTodoColumns', () => ({
  useTodoColumns: () => ({ columns, loading: false, error: null, refresh: vi.fn() }),
}));

vi.mock('../../../services/stateService', () => ({
  stateService: {
    get: vi.fn(async () => undefined),
    put: vi.fn(async () => ({ ok: true })),
  },
}));

// The Todos filter is the stored `mode` setting, read through the real ModeProvider.
const renderPage = () =>
  renderWithProviders(
    <ModeProvider>
      <TodosPage />
    </ModeProvider>,
  );

const plus = (name) => screen.getByRole('button', { name: `Add todo to ${name}` });
const headerAdd = () => screen.getByRole('button', { name: 'Add todo' });
const dialog = () => screen.getByRole('dialog');
const titleInput = () => within(dialog()).getByRole('textbox', { name: 'Title' });
const submitAdd = () => within(dialog()).getByRole('button', { name: 'Add todo' });

// Heavy render-and-wait suite: raise the time limits so a busy machine does not trip them.
allowSlowSuite();

describe('Todos CRUD dialogs', () => {
  beforeEach(() => {
    h.add.mockReset().mockResolvedValue({});
    h.update.mockReset().mockResolvedValue({});
    h.remove.mockReset().mockResolvedValue({});
    localStorage.clear();
    h.todos = BASE_TODOS;
  });
  afterEach(cleanup);

  it('renders nothing inline or modal on load, with header Add and a + on every column', () => {
    renderPage();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('What needs doing?')).not.toBeInTheDocument();
    expect(headerAdd()).toHaveAttribute('aria-haspopup', 'dialog');
    for (const n of ['Backlog', 'In Progress', 'Done']) {
      expect(plus(n)).toHaveAttribute('aria-haspopup', 'dialog');
      expect(plus(n)).not.toHaveAttribute('aria-expanded');
    }
  });

  it('header Add opens the dialog with the first column as status and creates', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(headerAdd());
    expect(titleInput()).toHaveFocus();
    expect(within(dialog()).getByRole('combobox', { name: 'Status' })).toHaveValue('Backlog');
    await user.type(titleInput(), '  New task ');
    await user.click(submitAdd());
    await waitFor(() => expect(h.add).toHaveBeenCalledTimes(1));
    expect(h.add).toHaveBeenCalledWith({
      title: 'New task',
      description: '',
      due: null,
      priority: 'medium',
      context: 'work',
      status: 'Backlog',
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('Todo added')).toBeInTheDocument();
    expect(headerAdd()).toHaveFocus();
  });

  it('column + opens the dialog with that column preset (empty Done column)', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(plus('Done'));
    expect(within(dialog()).getByRole('combobox', { name: 'Status' })).toHaveValue('Done');
    await user.type(titleInput(), 'Finished{Enter}');
    await waitFor(() => expect(h.add).toHaveBeenCalledTimes(1));
    expect(h.add.mock.calls[0][0]).toMatchObject({ title: 'Finished', status: 'Done', priority: 'medium' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('uses the active mode as default context', async () => {
    localStorage.setItem(lsKey('mode'), JSON.stringify('home'));
    const user = userEvent.setup();
    renderPage();
    await user.click(plus('Backlog'));
    await user.type(titleInput(), 'Laundry');
    await user.click(submitAdd());
    await waitFor(() => expect(h.add).toHaveBeenCalled());
    expect(h.add.mock.calls[0][0]).toMatchObject({ context: 'home', status: 'Backlog' });
  });

  it('Escape closes without adding', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(plus('In Progress'));
    await user.type(titleInput(), 'abc');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(h.add).not.toHaveBeenCalled();
  });

  it('Escape inside a select does not close the dialog', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(plus('In Progress'));
    await user.type(titleInput(), 'abc');
    within(dialog()).getByRole('combobox', { name: 'Priority' }).focus();
    await user.keyboard('{Escape}');
    expect(titleInput()).toHaveValue('abc');
  });

  it('the X closes without adding', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(plus('Done'));
    await user.type(titleInput(), 'abc');
    await user.click(within(dialog()).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(h.add).not.toHaveBeenCalled();
  });

  it('blocks submit with empty or whitespace-only title', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(plus('Done'));
    expect(submitAdd()).toBeDisabled();
    await user.type(titleInput(), '   {Enter}');
    expect(submitAdd()).toBeDisabled();
    expect(h.add).not.toHaveBeenCalled();
    expect(dialog()).toBeInTheDocument();
  });

  it('shows the error and keeps the dialog open when add rejects', async () => {
    h.add.mockRejectedValueOnce(new Error('Server exploded'));
    const user = userEvent.setup();
    renderPage();
    await user.click(plus('In Progress'));
    await user.type(titleInput(), 'Doomed');
    await user.click(submitAdd());
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent("Couldn't save the todo. Try again.");
    expect(within(dialog()).getByRole('alert')).not.toHaveTextContent('Server exploded');
    expect(titleInput()).toHaveValue('Doomed');
    expect(submitAdd()).toBeEnabled();
  });

  it('shows deliberate (userFacing) error copy as is', async () => {
    h.add.mockRejectedValueOnce(userError('That column is full.'));
    const user = userEvent.setup();
    renderPage();
    await user.click(plus('In Progress'));
    await user.type(titleInput(), 'Doomed');
    await user.click(submitAdd());
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent('That column is full.');
  });

  it('Edit prefills the card values and sends the patch to update', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Edit Write docs' }));
    const d = dialog();
    expect(within(d).getByRole('heading', { name: 'Edit todo' })).toBeInTheDocument();
    expect(titleInput()).toHaveValue('Write docs');
    expect(within(d).getByRole('textbox', { name: 'Description' })).toHaveValue('Draft');
    expect(within(d).getByLabelText('Due date')).toHaveValue('2026-05-01');
    expect(within(d).getByRole('combobox', { name: 'Priority' })).toHaveValue('low');
    expect(within(d).getByRole('combobox', { name: 'Status' })).toHaveValue('Backlog');
    await user.clear(titleInput());
    await user.type(titleInput(), 'Write better docs');
    await user.selectOptions(within(d).getByRole('combobox', { name: 'Status' }), 'Done');
    await user.click(within(d).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(h.update).toHaveBeenCalledTimes(1));
    expect(h.update).toHaveBeenCalledWith('t1', {
      title: 'Write better docs',
      description: 'Draft',
      due: '2026-05-01',
      priority: 'low',
      context: 'work',
      status: 'Done',
    });
    expect(h.add).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('Todo updated')).toBeInTheDocument();
  });

  it('shows the error and stays open when update rejects', async () => {
    h.update.mockRejectedValueOnce(new Error('Nope'));
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Edit Ship it' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Save changes' }));
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent("Couldn't save the todo. Try again.");
    expect(within(dialog()).getByRole('alert')).not.toHaveTextContent('Nope');
  });

  it('orphan-column todos can be edited and removed', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Edit Lost one' }));
    expect(within(dialog()).getByRole('combobox', { name: 'Status' })).toHaveValue('Mystery');
    await user.click(within(dialog()).getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('button', { name: 'Remove Lost one' })).toBeInTheDocument();
  });

  it('Remove opens a confirm with Cancel focused; Cancel makes no call', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Remove Ship it' }));
    const d = screen.getByRole('alertdialog');
    expect(within(d).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(d).toHaveTextContent('"Ship it"');
    await user.click(within(d).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(h.remove).not.toHaveBeenCalled();
  });

  it('Confirm removes the todo and toasts', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Remove Ship it' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(h.remove).toHaveBeenCalledWith('t2'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(await screen.findByText('Todo removed')).toBeInTheDocument();
  });

  it('rejected remove shows the error and keeps the confirm open', async () => {
    h.remove.mockRejectedValueOnce(new Error('Cannot delete'));
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Remove Ship it' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove' }));
    expect(await within(screen.getByRole('alertdialog')).findByRole('alert')).toHaveTextContent("Burrow couldn't finish that");
  });

  it('Escape closes the remove confirm without deleting', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Remove Ship it' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(h.remove).not.toHaveBeenCalled();
  });

  it('Clear column uses a ConfirmDialog (not window.confirm) and removes every card', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Clear all todos in Backlog' }));
    const d = screen.getByRole('alertdialog');
    expect(d).toHaveTextContent('Delete all 1 todo in "Backlog"');
    expect(h.remove).not.toHaveBeenCalled();
    await user.click(within(d).getByRole('button', { name: 'Delete all' }));
    await waitFor(() => expect(h.remove).toHaveBeenCalledWith('t1'));
    expect(confirmSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    confirmSpy.mockRestore();
  });

  it('Clear column Cancel removes nothing', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Clear all todos in Backlog' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(h.remove).not.toHaveBeenCalled();
  });

  describe('Clear column with several cards', () => {
    const backlog = (id, title, extra = {}) => ({
      id, title, status: 'Backlog', context: 'work', priority: 'low', order: 0, ...extra,
    });

    it('partial failure shows the count, stays open, and Retry removes only the failed card', async () => {
      h.todos = [backlog('a1', 'One'), backlog('a2', 'Two'), backlog('a3', 'Three')];
      h.remove.mockImplementation((id) => (id === 'a2' ? Promise.reject(new Error('x')) : Promise.resolve({})));
      const user = userEvent.setup();
      renderPage();
      await user.click(screen.getByRole('button', { name: 'Clear all todos in Backlog' }));
      const d = screen.getByRole('alertdialog');
      expect(d).toHaveTextContent('Delete all 3 todos');
      await user.click(within(d).getByRole('button', { name: 'Delete all' }));
      expect(await within(d).findByRole('alert')).toHaveTextContent("1 of 3 could not be removed");
      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
      expect(h.remove).toHaveBeenCalledTimes(3);

      h.remove.mockReset().mockResolvedValue({});
      await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete all' }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
      expect(h.remove).toHaveBeenCalledTimes(1);
      expect(h.remove).toHaveBeenCalledWith('a2');
      expect(await screen.findByText('Cleared Backlog')).toBeInTheDocument();
    });

    it('excludes optimistic temp-id cards from the count and the removal', async () => {
      h.todos = [backlog('a1', 'One'), backlog('temp-9', 'Pending'), backlog('a3', 'Three')];
      const user = userEvent.setup();
      renderPage();
      await user.click(screen.getByRole('button', { name: 'Clear all todos in Backlog' }));
      const d = screen.getByRole('alertdialog');
      expect(d).toHaveTextContent('Delete all 2 todos');
      await user.click(within(d).getByRole('button', { name: 'Delete all' }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
      expect(h.remove).toHaveBeenCalledTimes(2);
      expect(h.remove).not.toHaveBeenCalledWith('temp-9');
    });
  });
});
