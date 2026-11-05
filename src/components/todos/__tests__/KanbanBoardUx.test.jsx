import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import KanbanBoard from '../KanbanBoard';
import ColumnSettings from '../ColumnSettings';
import { renderWithProviders } from '../../../test-utils/renderWithProviders';

const dnd = vi.hoisted(() => ({ props: null }));

// Capture the DndContext props so tests can drive the real board handlers
// (jsdom has no layout, so a pointer drag cannot hit-test).
vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    DndContext: (props) => {
      dnd.props = props;
      return <actual.DndContext {...props} />;
    },
  };
});

const h = vi.hoisted(() => ({ columnsState: null, remove: vi.fn() }));
vi.mock('../../../hooks/useTodoColumns', () => ({
  useTodoColumns: () => h.columnsState,
}));

const columns = [
  { id: 'c1', name: 'Backlog', color: 'gray', order: 0 },
  { id: 'c2', name: 'Done', color: 'green', order: 1 },
];
const todos = [
  { id: 't1', title: 'Write docs', status: 'Backlog', order: 0 },
  { id: 't2', title: 'Lost one', status: 'Mystery', order: 0 },
  { id: 't3', title: 'Shipped', status: 'Done', order: 0, done: true },
];

const active = { id: 't1', data: { current: { type: 'todo', status: 'Backlog' } } };
const overDone = { id: 'column:Done', data: { current: { type: 'column', columnName: 'Done' } } };

const renderBoard = (props) =>
  renderWithProviders(
    <KanbanBoard
      todos={todos}
      columns={columns}
      onReorder={vi.fn().mockResolvedValue({})}
      onUpdate={vi.fn()}
      onRemove={vi.fn()}
      onAdd={vi.fn()}
      defaultContext="work"
      {...props}
    />,
  );

const group = (name) => screen.getByRole('group', { name });

describe('KanbanBoard drag and drop', () => {
  afterEach(cleanup);

  it('moves the card locally while dragging and saves once on drop', async () => {
    const onReorder = vi.fn().mockResolvedValue({});
    renderBoard({ onReorder });

    act(() => dnd.props.onDragStart({ active }));
    act(() => dnd.props.onDragOver({ active, over: overDone }));
    act(() => dnd.props.onDragOver({ active, over: overDone }));
    expect(onReorder).not.toHaveBeenCalled();
    expect(within(group('Done')).getByText('Write docs')).toBeInTheDocument();

    await act(() => dnd.props.onDragEnd({ active, over: overDone }));
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder.mock.calls[0][0]).toContainEqual({ id: 't1', status: 'Done', order: 1 });
  });

  it('puts the card back and shows an error toast when saving fails', async () => {
    const onReorder = vi.fn().mockRejectedValue(new Error('boom'));
    renderBoard({ onReorder });

    act(() => dnd.props.onDragOver({ active, over: overDone }));
    await act(() => dnd.props.onDragEnd({ active, over: overDone }));

    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/Couldn't save that move/)).toBeInTheDocument();
    expect(screen.queryByText('boom')).not.toBeInTheDocument();
    expect(within(group('Backlog')).getByText('Write docs')).toBeInTheDocument();
  });

  it('cancelling a drag saves nothing and restores the card', () => {
    const onReorder = vi.fn();
    renderBoard({ onReorder });
    act(() => dnd.props.onDragOver({ active, over: overDone }));
    act(() => dnd.props.onDragCancel());
    expect(onReorder).not.toHaveBeenCalled();
    expect(within(group('Backlog')).getByText('Write docs')).toBeInTheDocument();
  });
});

describe('KanbanBoard with a filtered list', () => {
  afterEach(cleanup);

  it('computes drops against allTodos so hidden todos keep a consistent order', async () => {
    const all = [
      { id: 't1', title: 'Write docs', status: 'Backlog', order: 0 },
      { id: 'h1', title: 'Hidden', status: 'Backlog', order: 1 },
      { id: 't3', title: 'Shipped', status: 'Done', order: 0 },
      { id: 'h2', title: 'Hidden done', status: 'Done', order: 1 },
    ];
    const shown = all.filter((t) => !t.title.startsWith('Hidden'));
    const onReorder = vi.fn().mockResolvedValue({});
    renderBoard({ todos: shown, allTodos: all, onReorder });
    act(() => dnd.props.onDragStart({ active }));
    await act(() => dnd.props.onDragEnd({ active, over: overDone }));
    const items = onReorder.mock.calls[0][0];
    // Appended after the hidden done todo, and the hidden backlog todo moves up.
    expect(items).toContainEqual({ id: 't1', status: 'Done', order: 2 });
    expect(items).toContainEqual({ id: 'h1', status: 'Backlog', order: 0 });
    expect(screen.queryByText('Hidden')).not.toBeInTheDocument();
  });
});

describe('KanbanBoard chrome and Mark done', () => {
  afterEach(cleanup);

  it('Mark done moves the todo to Done once and is hidden for done cards', async () => {
    const onReorder = vi.fn().mockResolvedValue({});
    const user = userEvent.setup();
    renderBoard({ onReorder });
    // Backlog card and the unmapped card get it; the card already in Done does not.
    expect(screen.getAllByRole('button', { name: /^Mark .* done$/ })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Mark Write docs done' })).toBeInTheDocument();
    expect(
      within(group('Done')).queryByRole('button', { name: /^Mark .* done$/ }),
    ).not.toBeInTheDocument();

    await user.click(within(group('Backlog')).getByRole('button', { name: 'Mark Write docs done' }));
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder.mock.calls[0][0]).toContainEqual(
      expect.objectContaining({ id: 't1', status: 'Done' }),
    );
    expect(await screen.findByText('Marked done')).toBeInTheDocument();
  });

  it('Mark done saves once on a double click and uses its own error copy', async () => {
    let reject;
    const onReorder = vi.fn(() => new Promise((_, r) => { reject = r; }));
    const user = userEvent.setup();
    renderBoard({ onReorder });
    const btn = screen.getByRole('button', { name: 'Mark Write docs done' });
    await user.dblClick(btn);
    expect(onReorder).toHaveBeenCalledTimes(1);
    await act(async () => reject(new Error('boom')));
    expect(await screen.findByText("Couldn't mark that todo done. Try again.")).toBeInTheDocument();
  });

  it('a card name includes priority and due date, and the Columns button announces a dialog', () => {
    renderBoard({
      todos: [{ id: 't1', title: 'Write docs', status: 'Backlog', order: 0, priority: 'high', due: '2026-05-01' }],
    });
    expect(
      screen.getByRole('button', { name: 'Write docs, high priority, due 2026-05-01' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Columns' })).toHaveAttribute('aria-haspopup', 'dialog');
  });

  it('the "No column" bucket is not a drop target and explains itself', async () => {
    const onReorder = vi.fn().mockResolvedValue({});
    renderBoard({ onReorder });
    const overLost = { id: 't2', data: { current: { type: 'todo', status: 'Mystery' } } };
    act(() => dnd.props.onDragOver({ active, over: overLost }));
    await act(() => dnd.props.onDragEnd({ active, over: overLost }));
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('announces drags with todo and column names, never ids', () => {
    renderBoard();
    const a = dnd.props.accessibility.announcements;
    const withTodo = { ...active, data: { current: { ...active.data.current, todo: todos[0] } } };
    expect(a.onDragStart({ active: withTodo })).toBe('Picked up Write docs.');
    expect(a.onDragOver({ active: withTodo, over: overDone })).toBe('Write docs is over Done.');
    expect(a.onDragEnd({ active: withTodo, over: overDone })).toBe('Dropped Write docs in Done.');
    expect(dnd.props.accessibility.screenReaderInstructions.draggable).toMatch(/space or enter/);
  });

  it('shows "No column" for unmapped todos, never the internal id', () => {
    renderBoard();
    expect(screen.getByRole('heading', { name: 'No column' })).toBeInTheDocument();
    expect(screen.queryByText('__orphan__')).not.toBeInTheDocument();
  });

  it('puts a status-less open todo in the first column after a rename, not in "No column"', () => {
    const renamed = [
      { id: 'c1', name: 'Inbox', color: 'gray', order: 0 },
      { id: 'c2', name: 'Done', color: 'green', order: 1 },
    ];
    renderBoard({
      columns: renamed,
      todos: [
        { id: 'l1', title: 'Legacy open', status: null, order: 0 },
        { id: 'l2', title: 'Legacy blank', status: '', order: 1 },
      ],
    });
    expect(within(group('Inbox')).getByText('Legacy open')).toBeInTheDocument();
    expect(within(group('Inbox')).getByText('Legacy blank')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'No column' })).not.toBeInTheDocument();
  });

  it('has one Columns button, no Board heading, and no per-column settings button', () => {
    renderBoard();
    expect(screen.getAllByRole('button', { name: 'Columns' })).toHaveLength(1);
    expect(screen.queryByRole('heading', { name: 'Board' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Column settings' })).not.toBeInTheDocument();
  });
});

describe('ColumnSettings', () => {
  beforeEach(() => {
    h.remove.mockReset().mockResolvedValue({});
    h.columnsState = {
      columns,
      writable: true,
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
      add: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      remove: h.remove,
    };
  });
  afterEach(cleanup);

  it('confirms a delete in a ConfirmDialog, not window.confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const user = userEvent.setup();
    renderWithProviders(<ColumnSettings onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Delete column Backlog' }));
    const d = screen.getByRole('alertdialog');
    expect(d).toHaveTextContent('"Backlog"');
    expect(h.remove).not.toHaveBeenCalled();
    await user.click(within(d).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(h.remove).toHaveBeenCalledWith('c1'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('Escape closes only the confirm first, and the dialog is a real modal', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<ColumnSettings onClose={onClose} />);
    expect(screen.getByRole('dialog', { name: 'Columns' })).toHaveAttribute('aria-modal', 'true');
    await user.click(screen.getByRole('button', { name: 'Delete column Backlog' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
  });

  it('shows the fixed delete copy, not the raw error, when a delete fails', async () => {
    h.remove.mockRejectedValueOnce(new Error('SQLITE_CONSTRAINT secret'));
    const user = userEvent.setup();
    renderWithProviders(<ColumnSettings onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Delete column Backlog' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    const alert = await within(screen.getByRole('alertdialog')).findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't delete that column. Try again.");
    expect(alert).not.toHaveTextContent('SQLITE');
  });

  it('keeps focus on the control after an action and reverts a failed rename', async () => {
    h.columnsState.update.mockRejectedValueOnce(new Error('nope'));
    const user = userEvent.setup();
    renderWithProviders(<ColumnSettings onClose={vi.fn()} />);
    const input = screen.getByLabelText('Name of column Backlog');
    await user.clear(input);
    await user.type(input, 'Renamed');
    await user.tab();
    expect(await screen.findByText(/Couldn't save that change/)).toBeInTheDocument();
    expect(input).toHaveValue('Backlog');
    expect(input).not.toBeDisabled();

    const down = screen.getByRole('button', { name: 'Move Backlog down' });
    down.focus();
    h.columnsState.update.mockResolvedValue({});
    await user.click(down);
    expect(down).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Backlog up' })).toHaveAttribute('aria-disabled', 'true');
    expect(within(screen.getByLabelText('Color of column Backlog')).getByRole('option', { name: 'Gray' })).toBeInTheDocument();
  });

  it('moves focus to the new column name field after a confirmed delete', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ColumnSettings onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Delete column Backlog' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    // The mocked columns list is static, so the opener button is still connected here.
    expect(h.remove).toHaveBeenCalledWith('c1');
  });

  it('shows a skeleton while loading and fixed copy on a load error', () => {
    h.columnsState = { ...h.columnsState, columns: [], loading: true };
    const { unmount } = renderWithProviders(<ColumnSettings onClose={vi.fn()} />);
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(screen.queryByText(/Loading…/)).not.toBeInTheDocument();
    unmount();
    h.columnsState = { ...h.columnsState, loading: false, error: new Error('raw server text') };
    renderWithProviders(<ColumnSettings onClose={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load your columns");
    expect(screen.queryByText(/raw server text/)).not.toBeInTheDocument();
  });
});
