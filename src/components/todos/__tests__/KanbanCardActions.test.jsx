import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { DndContext, MouseSensor, TouchSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';
import KanbanCard from '../KanbanCard';
import KanbanBoard from '../KanbanBoard';
import { renderWithProviders } from '../../../test-utils/renderWithProviders';

const todo = { id: 't1', title: 'Write docs', status: 'Backlog', priority: 'low' };
const tempTodo = { id: 'temp-abc', title: 'Pending one', status: 'Backlog', priority: 'low' };
const columns = [{ id: 'c1', name: 'Backlog', color: 'gray', order: 0 }];

const renderCard = (t, props) =>
  render(
    <DndContext>
      <SortableContext items={[t.id]}>
        <KanbanCard todo={t} {...props} />
      </SortableContext>
    </DndContext>,
  );

describe('KanbanCard actions', () => {
  afterEach(cleanup);

  it('renders Edit and Remove when callbacks are passed and calls them with the todo', async () => {
    const onEdit = vi.fn();
    const onRequestRemove = vi.fn();
    const user = userEvent.setup();
    renderCard(todo, { onEdit, onRequestRemove });
    await user.click(screen.getByRole('button', { name: 'Edit Write docs' }));
    await user.click(screen.getByRole('button', { name: 'Remove Write docs' }));
    expect(onEdit).toHaveBeenCalledWith(todo);
    expect(onRequestRemove).toHaveBeenCalledWith(todo);
  });

  it('does not render actions without callbacks (DragOverlay card)', () => {
    renderCard(todo, { isOverlay: true });
    expect(screen.queryByRole('button', { name: /Edit|Remove/ })).not.toBeInTheDocument();
    expect(screen.getByText('Write docs')).toBeInTheDocument();
  });

  it('does not render actions for optimistic temp ids', () => {
    renderCard(tempTodo, { onEdit: vi.fn(), onRequestRemove: vi.fn() });
    expect(screen.queryByRole('button', { name: /Edit|Remove/ })).not.toBeInTheDocument();
  });

  describe('drag activation (board sensors)', () => {
    // Mirrors KanbanBoard's sensor config so the test exercises the real activation rules.
    function Harness({ onDragStart, onEdit, onRequestRemove }) {
      const sensors = useSensors(
        useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
        useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
      );
      return (
        <DndContext sensors={sensors} onDragStart={onDragStart}>
          <SortableContext items={[todo.id]}>
            <KanbanCard todo={todo} onEdit={onEdit} onRequestRemove={onRequestRemove} />
          </SortableContext>
        </DndContext>
      );
    }

    const pressAndMove = (user, target) =>
      user.pointer([
        { keys: '[MouseLeft>]', target, coords: { x: 0, y: 0 } },
        { coords: { x: 40, y: 40 } },
        { coords: { x: 80, y: 80 } },
        { keys: '[/MouseLeft]' },
      ]);

    it('positive control: press and move on the card body starts a drag', async () => {
      const onDragStart = vi.fn();
      const user = userEvent.setup();
      render(<Harness onDragStart={onDragStart} onEdit={vi.fn()} onRequestRemove={vi.fn()} />);
      await pressAndMove(user, screen.getByText('Write docs'));
      await waitFor(() => expect(onDragStart).toHaveBeenCalledTimes(1));
    });

    it.each(['Edit Write docs', 'Remove Write docs'])(
      'press and move on "%s" does not start a drag',
      async (name) => {
        const onDragStart = vi.fn();
        const user = userEvent.setup();
        render(<Harness onDragStart={onDragStart} onEdit={vi.fn()} onRequestRemove={vi.fn()} />);
        await pressAndMove(user, screen.getByRole('button', { name }));
        // Give any (wrongly) activated drag a chance to surface before asserting its absence.
        await new Promise((r) => setTimeout(r, 50));
        expect(onDragStart).not.toHaveBeenCalled();
      },
    );

    it('touchstart on the buttons never reaches the card listener, but does from the card body', () => {
      const onTouchStart = vi.fn();
      render(
        <div onTouchStart={onTouchStart}>
          <DndContext>
            <SortableContext items={[todo.id]}>
              <KanbanCard todo={todo} onEdit={vi.fn()} onRequestRemove={vi.fn()} />
            </SortableContext>
          </DndContext>
        </div>,
      );
      fireEvent.touchStart(screen.getByText('Write docs'));
      expect(onTouchStart).toHaveBeenCalledTimes(1);
      fireEvent.touchStart(screen.getByRole('button', { name: 'Edit Write docs' }));
      fireEvent.touchStart(screen.getByRole('button', { name: 'Remove Write docs' }));
      expect(onTouchStart).toHaveBeenCalledTimes(1);
    });

    it('clicking Edit still calls onEdit', async () => {
      const onEdit = vi.fn();
      const user = userEvent.setup();
      render(<Harness onDragStart={vi.fn()} onEdit={onEdit} onRequestRemove={vi.fn()} />);
      await user.click(screen.getByRole('button', { name: 'Edit Write docs' }));
      expect(onEdit).toHaveBeenCalledWith(todo);
    });
  });

  it('keeps no dialog inside the card and has no inline edit form', async () => {
    const user = userEvent.setup();
    renderCard(todo, { onEdit: vi.fn(), onRequestRemove: vi.fn() });
    await user.click(screen.getByRole('button', { name: 'Edit Write docs' }));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('KanbanBoard dialogs', () => {
  afterEach(cleanup);

  it('mounts the dialog outside the dnd card and does not delete on Edit click', async () => {
    const onUpdate = vi.fn().mockResolvedValue({});
    const onRemove = vi.fn().mockResolvedValue({});
    const onReorder = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <KanbanBoard
        todos={[todo, tempTodo]}
        columns={columns}
        onUpdate={onUpdate}
        onRemove={onRemove}
        onAdd={vi.fn()}
        onReorder={onReorder}
        defaultContext="work"
      />,
    );
    expect(screen.queryByRole('button', { name: 'Edit Pending one' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit Write docs' }));
    const dlg = screen.getByRole('dialog');
    // The dialog is portaled out of every card, so no card can contain it.
    for (const card of screen.getAllByRole('button', { name: /Write docs|Pending one/ })) {
      expect(card.contains(dlg)).toBe(false);
    }
    // Typing and clicking inside the dialog must not reach the board's drag handlers.
    await user.click(within(dlg).getByRole('textbox', { name: 'Title' }));
    await user.type(within(dlg).getByRole('textbox', { name: 'Title' }), 'x');
    await user.click(within(dlg).getByRole('button', { name: 'Close' }));
    expect(onReorder).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onRemove).not.toHaveBeenCalled();
  });
});
