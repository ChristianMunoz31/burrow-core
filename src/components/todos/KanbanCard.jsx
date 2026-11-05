import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Check } from 'lucide-react';
import ItemActions, { IconButton } from '../shared/ItemActions';
import { isTempId } from '../../hooks/useCrudDialogs';

function priorityClass(p) {
  if (p === 'high') return 'bg-transparent text-accent-red border-red-redLight1/40';
  if (p === 'medium')
    return 'bg-transparent text-accent-yellow border-yellow-yellowLight1/40';
  return 'bg-transparent text-slate-slate400 border-slate-slate600/40';
}

// Edit/Remove/Mark done are requested via callbacks; the board owns the dialogs so no
// modal is ever rendered inside this drag node. The DragOverlay copy receives
// no callbacks and therefore renders no actions.
export default function KanbanCard({
  todo,
  onEdit,
  onRequestRemove,
  onMarkDone,
  isOverlay = false,
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: todo.id,
    data: { type: 'todo', status: todo.status, todo },
  });

  // The card's name carries the same details the visible badges show.
  const cardLabel = [
    todo.title,
    todo.priority ? `${todo.priority} priority` : null,
    todo.due ? `due ${todo.due}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging && !isOverlay ? 0.4 : 1,
  };

  // Optimistic cards have no server id yet, so they can't be patched or deleted.
  const canMarkDone = Boolean(onMarkDone) && !todo.done;
  const showActions = !isTempId(todo.id) && Boolean(onEdit || onRequestRemove || canMarkDone);

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      aria-roledescription="sortable card"
      aria-label={cardLabel}
      className={`group rounded-lg p-3 glass-subtle hover:border-slate-slate600 cursor-grab active:cursor-grabbing ${
        isOverlay ? 'bg-[var(--surface-solid-strong)] shadow-2xl ring-1 ring-slate-slateBlueLight/40' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-slate100 leading-snug break-words">
            {todo.title}
          </p>
          {todo.description && (
            <p
              className="text-xs text-slate-slate400 leading-snug mt-1 break-words max-h-16 overflow-y-auto scrollbar-thin whitespace-pre-line"
              onPointerDown={(e) => e.stopPropagation()}
            >
              {todo.description}
            </p>
          )}
        </div>
        {showActions && (
          <ItemActions
            name={todo.title}
            onEdit={onEdit ? () => onEdit(todo) : undefined}
            onRemove={onRequestRemove ? () => onRequestRemove(todo) : undefined}
          >
            {canMarkDone && (
              <IconButton
                label={`Mark ${todo.title} done`}
                icon={Check}
                onClick={() => onMarkDone(todo)}
              />
            )}
          </ItemActions>
        )}
      </div>
      <div className="flex items-center gap-2 mt-2 text-xs">
        {todo.priority && (
          <span
            className={`px-1.5 py-0.5 rounded uppercase tracking-wider border ${priorityClass(
              todo.priority,
            )}`}
          >
            {todo.priority}
          </span>
        )}
        {todo.due && <span className="text-slate-slate500">due {todo.due}</span>}
      </div>
    </div>
  );
}
