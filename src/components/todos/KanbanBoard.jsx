import { useMemo, useRef, useState } from 'react';
import { Settings } from 'lucide-react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  closestCorners,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import KanbanColumn from './KanbanColumn';
import KanbanCard from './KanbanCard';
import ColumnSettings from './ColumnSettings';
import TodoForm from './TodoForm';
import Modal from '../shared/Modal';
import ConfirmDialog from '../shared/ConfirmDialog';
import AddButton from '../shared/AddButton';
import { btnSecondary } from '../shared/formStyles';
import { isTempId, useCrudDialogs } from '../../hooks/useCrudDialogs';
import { useToast } from '../../contexts/ToastContext';
import { groupByColumn, computeTodoReorder } from '../../utils/kanban';
import { userError } from '../../utils/apiError';

const ORPHAN_ID = '__orphan__';
// The server marks a todo done when its status is exactly this (server/dataRoutes.js).
const DONE_STATUS = 'Done';
const MOVE_ERROR = "Couldn't save that move. Your todos are back where they were. Try again.";
const MARK_DONE_ERROR = "Couldn't mark that todo done. Try again.";

const DRAG_INSTRUCTIONS =
  'To pick up a todo, press space or enter. Use the arrow keys to move it to another column or position. ' +
  'Press space or enter again to drop it, or escape to cancel.';

/**
 * `todos` is what the board shows; `allTodos` is the full list (a filtered page shows fewer), which
 * every reorder is computed against so hidden todos keep a consistent status and order.
 */
export default function KanbanBoard({
  todos = [],
  allTodos = todos,
  columns = [],
  onReorder,
  onRemove,
  onUpdate,
  onAdd,
  defaultContext,
  toolbarStart,
  emptyNote = null,
}) {
  const [activeTodo, setActiveTodo] = useState(null);
  // Local-only card positions while a drag is in flight: Map of id -> { id, status, order }.
  // Nothing is saved until the drag ends.
  const [preview, setPreview] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Column awaiting "Clear column" confirmation: { column, todos }.
  const [pendingClear, setPendingClear] = useState(null);
  const crud = useCrudDialogs();
  const toast = useToast();
  const addRef = useRef(null);
  // Todo ids whose Mark done save is in flight, so a double click saves once.
  const markingRef = useRef(new Set());

  // Mouse: a 5px drag threshold keeps the delete button + form inputs clickable.
  // Touch: a press-and-hold (delay) starts a drag so a quick swipe still scrolls
  // the board on phones, the standard dnd-kit pattern for scrollable touch UIs.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    // Keyboard: Space/Enter picks a card up, arrows move it, Space/Enter drops it.
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const displayTodos = useMemo(
    () => (preview ? todos.map((t) => (preview.has(t.id) ? { ...t, ...preview.get(t.id) } : t)) : todos),
    [todos, preview],
  );
  const grouped = useMemo(() => groupByColumn(displayTodos, columns), [displayTodos, columns]);
  const orphanTodos = grouped.get(ORPHAN_ID) || [];
  const doneColumn = columns.find((c) => c.name === DONE_STATUS);
  const columnNames = useMemo(() => new Set(columns.map((c) => c.name)), [columns]);

  const todoIndex = useMemo(() => {
    const idx = new Map();
    for (const t of todos) idx.set(t.id, t);
    return idx;
  }, [todos]);

  const handleDragStart = (event) => {
    const id = event?.active?.id;
    if (!id) return;
    setActiveTodo(todoIndex.get(id) || null);
  };

  // Normalize the dnd-kit `over` (another sortable card or a droppable column)
  // into the descriptor computeTodoReorder expects. The "No column" bucket is
  // not a real status, so it is never a drop target.
  const describeOver = (over) => {
    const data = over?.data?.current;
    if (!data) return null;
    if (data.type === 'column' && data.columnName !== ORPHAN_ID) {
      return { type: 'column', columnName: data.columnName };
    }
    // A card in the "No column" bucket is not a drop target either.
    if (data.type === 'todo' && columnNames.has(data.status)) {
      return { type: 'todo', id: over.id, status: data.status };
    }
    return null;
  };

  // Plain-language screen reader announcements: todo and column names, never ids.
  const todoTitle = (item) => item?.data?.current?.todo?.title || 'Todo';
  const overName = (over) => {
    const data = over?.data?.current;
    if (data?.type === 'column') return data.columnName === ORPHAN_ID ? 'No column' : data.columnName;
    if (data?.type === 'todo') return columnNames.has(data.status) ? data.status : 'No column';
    return null;
  };
  const announcements = {
    onDragStart: ({ active }) => `Picked up ${todoTitle(active)}.`,
    onDragOver: ({ active, over }) => {
      const name = overName(over);
      return name ? `${todoTitle(active)} is over ${name}.` : undefined;
    },
    onDragEnd: ({ active, over }) => {
      const name = overName(over);
      return name ? `Dropped ${todoTitle(active)} in ${name}.` : `${todoTitle(active)} was dropped where it started.`;
    },
    onDragCancel: ({ active }) => `Move cancelled. ${todoTitle(active)} is back where it was.`,
  };

  // Saves a reorder once. On failure the optimistic cache is rolled back by the
  // hook; here we only tell the user. Returns true when saved.
  const persist = async (items, errorMessage = MOVE_ERROR) => {
    try {
      await onReorder?.(items);
      return true;
    } catch {
      toast({ message: errorMessage, type: 'error' });
      return false;
    }
  };

  // During a drag, when the pointer enters a different column, move the card in
  // local state only so the UI shows it there (standard dnd-kit multi-container
  // pattern). Nothing is sent to the server until the drag ends.
  const handleDragOver = (event) => {
    const { active, over } = event;
    if (!active || !over) return;
    const overDesc = describeOver(over);
    if (!overDesc) return;
    if (overDesc.type === 'todo' && overDesc.id === active.id) return;

    const activeData = active.data?.current;
    if (!activeData || activeData.type !== 'todo') return;

    const targetCol = overDesc.type === 'column' ? overDesc.columnName : overDesc.status;
    // Only act on cross-column moves
    if (activeData.status === targetCol) return;

    const items = computeTodoReorder(allTodos, columns, active.id, overDesc);
    setPreview(items.length ? new Map(items.map((it) => [it.id, it])) : null);
  };

  const handleDragEnd = async (event) => {
    const { active, over } = event;
    setActiveTodo(null);
    const overDesc = active && over ? describeOver(over) : null;
    if (!overDesc) {
      setPreview(null);
      return;
    }
    // Compute against the saved data in one shot. When the pointer ends over the
    // dragged card itself (it already sits in the new column), keep the preview.
    const fresh = computeTodoReorder(allTodos, columns, active.id, overDesc);
    // Drop entries for todos that no longer exist so a stale preview never writes.
    const items = fresh.length
      ? fresh
      : [...(preview?.values() ?? [])].filter((it) => todoIndex.has(it.id));
    // Keep the preview until the save settles, then drop it: on success the
    // cache already shows the move, on failure this is the visual rollback. Only
    // clear it if no newer drag has replaced it in the meantime.
    const mine = preview;
    if (items.length) await persist(items);
    setPreview((p) => (p === mine ? null : p));
  };

  const handleDragCancel = () => {
    setActiveTodo(null);
    setPreview(null);
  };

  const markDone = async (todo) => {
    if (markingRef.current.has(todo.id)) return;
    markingRef.current.add(todo.id);
    try {
      const items = computeTodoReorder(allTodos, columns, todo.id, {
        type: 'column',
        columnName: DONE_STATUS,
      });
      if (items.length && (await persist(items, MARK_DONE_ERROR))) {
        toast({ message: 'Marked done', type: 'success' });
      }
    } finally {
      markingRef.current.delete(todo.id);
    }
  };

  const submitTodo = async (values, dialog) => {
    if (dialog.mode === 'edit') {
      await onUpdate(dialog.item.id, values);
      toast({ message: 'Todo updated', type: 'success' });
    } else {
      await onAdd(values);
      toast({ message: 'Todo added', type: 'success' });
    }
  };

  const confirmRemove = async () => {
    await onRemove(crud.pendingRemove.id);
    crud.cancelRemove();
    toast({ message: 'Todo removed', type: 'success' });
  };

  const confirmClear = async () => {
    // Optimistic (temp-id) cards have no server row yet, so they can't be removed.
    const targets = pendingClear.todos.filter((t) => !isTempId(t.id));
    const results = await Promise.allSettled(targets.map((t) => onRemove(t.id)));
    const failedTodos = targets.filter((_, i) => results[i].status === 'rejected');
    if (failedTodos.length > 0) {
      // Retry targets only the cards that are still present.
      setPendingClear({ column: pendingClear.column, todos: failedTodos });
      throw userError(`${failedTodos.length} of ${targets.length} could not be removed`);
    }
    setPendingClear(null);
    toast({ message: `Cleared ${pendingClear.column.name}`, type: 'success' });
  };

  const canAdd = Boolean(onAdd) && columns.length > 0;
  const clearCount = pendingClear?.todos.length ?? 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {toolbarStart ?? <span />}
        <div className="flex items-center gap-2">
          {canAdd && (
            <AddButton
              ref={addRef}
              label="Add todo"
              onClick={() => crud.openAdd({ status: columns[0].name })}
            />
          )}
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            aria-haspopup="dialog"
            className={`${btnSecondary} inline-flex items-center gap-1.5`}
          >
            <Settings size={14} />
            Columns
          </button>
        </div>
      </div>

      {emptyNote}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
        accessibility={{ announcements, screenReaderInstructions: { draggable: DRAG_INSTRUCTIONS } }}
      >
        <div className="flex gap-4 sm:gap-6 overflow-x-auto pb-4 min-h-[calc(100vh-120px)] items-stretch snap-x snap-mandatory sm:snap-none scroll-smooth">
          {columns.map((col) => (
            <KanbanColumn
              key={col.id || col.name}
              column={col}
              todos={grouped.get(col.name) || []}
              onEdit={onUpdate ? crud.openEdit : undefined}
              onRequestRemove={onRemove ? crud.askRemove : undefined}
              onMarkDone={
                onReorder && doneColumn && col.name !== DONE_STATUS ? markDone : undefined
              }
              onAddClick={onAdd ? (status) => crud.openAdd({ status }) : undefined}
              onClearClick={
                onRemove ? (column, colTodos) => setPendingClear({ column, todos: colTodos.filter((t) => !isTempId(t.id)) }) : undefined
              }
            />
          ))}
          {orphanTodos.length > 0 && (
            <KanbanColumn
              column={{ name: ORPHAN_ID, color: 'gray' }}
              todos={orphanTodos}
              onMarkDone={onReorder && doneColumn ? markDone : undefined}
              onEdit={onUpdate ? crud.openEdit : undefined}
              onRequestRemove={onRemove ? crud.askRemove : undefined}
              isOrphan
            />
          )}
        </div>

        <DragOverlay>
          {activeTodo ? <KanbanCard todo={activeTodo} isOverlay /> : null}
        </DragOverlay>
      </DndContext>

      {/* Dialogs live at board level, outside the DndContext, so React events
          from the portal never bubble through a drag node. */}
      {crud.dialog && (
        <Modal
          title={crud.dialog.mode === 'edit' ? 'Edit todo' : 'Add todo'}
          onClose={crud.close}
          dismissible={!crud.submitting}
          finalFocusRef={addRef}
        >
          <TodoForm
            mode={crud.dialog.mode}
            initialValues={crud.dialog.mode === 'edit' ? crud.dialog.item : crud.dialog.defaults}
            columns={columns}
            defaultContext={defaultContext}
            onSubmit={crud.runSubmit(submitTodo)}
          />
        </Modal>
      )}
      {crud.pendingRemove && (
        <ConfirmDialog
          title="Remove todo?"
          message={`"${crud.pendingRemove.title}" will be permanently deleted.`}
          onConfirm={confirmRemove}
          onCancel={crud.cancelRemove}
          finalFocusRef={addRef}
        />
      )}
      {pendingClear && (
        <ConfirmDialog
          title="Clear column?"
          message={`Delete all ${clearCount} todo${clearCount === 1 ? '' : 's'} in "${pendingClear.column.name}"? This cannot be undone.`}
          confirmLabel="Delete all"
          onConfirm={confirmClear}
          onCancel={() => setPendingClear(null)}
          finalFocusRef={addRef}
        />
      )}

      {settingsOpen && (
        <ColumnSettings onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  );
}
