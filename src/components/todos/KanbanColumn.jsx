import { Plus, Trash2 } from 'lucide-react';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useDroppable } from '@dnd-kit/core';
import KanbanCard from './KanbanCard';
import { IconButton } from '../shared/ItemActions';

// Map of colorName -> tailwind class for the column accent dot. Keys cover
// what server.js seeds for defaults plus a few extras users might pick.
const DOT_COLORS = {
  gray: 'bg-slate-slate500',
  blue: 'bg-blue-blueLight1',
  green: 'bg-green-greenLight1',
  red: 'bg-red-redLight1',
  yellow: 'bg-yellow-yellowLight1',
  orange: 'bg-orange-orangeLight1',
  purple: 'bg-purple-purpleLight1',
  teal: 'bg-teal-tealLight1',
  cyan: 'bg-cyan-cyanLight1',
  pink: 'bg-pink-pinkLight1',
};

export default function KanbanColumn({
  column,
  todos = [],
  onEdit,
  onRequestRemove,
  onMarkDone,
  onAddClick,
  onClearClick,
  isOrphan = false,
}) {
  // Make the whole column body droppable so cards can land in an empty column.
  // The drop id is the column name to mirror what we send as `status`.
  const { setNodeRef, isOver } = useDroppable({
    id: `column:${column.name}`,
    data: { type: 'column', columnName: column.name },
    // The "No column" bucket is not a real status, so nothing can be dropped on it.
    disabled: isOrphan,
  });

  // The internal id stays '__orphan__'; people see "No column".
  const label = isOrphan ? 'No column' : column.name;
  const dotClass = DOT_COLORS[column.color] || 'bg-slate-slate500';
  const ids = todos.map((t) => t.id);

  return (
    <div
      role="group"
      aria-label={label}
      className="flex flex-col flex-1 min-w-72 sm:min-w-80 min-h-[600px] glass rounded-2xl snap-start"
    >
      <div className="flex items-center justify-between p-4 border-b border-slate-slate700/60">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`w-2.5 h-2.5 rounded-full ${dotClass}`} />
          <h3 className="text-sm font-bold text-slate-slate100 tracking-tight truncate">
            {label}
          </h3>
          <span className="text-xs text-slate-slate500 tabular-nums">{todos.length}</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {!isOrphan && onAddClick && (
            <IconButton
              label={`Add todo to ${column.name}`}
              icon={Plus}
              onClick={() => onAddClick(column.name)}
              aria-haspopup="dialog"
              title={`Add todo to ${column.name}`}
            />
          )}
          {!isOrphan && todos.length > 0 && onClearClick && (
            <IconButton
              label={`Clear all todos in ${column.name}`}
              icon={Trash2}
              tone="danger"
              onClick={() => onClearClick(column, todos)}
              aria-haspopup="dialog"
              title="Clear column"
            />
          )}
        </div>
      </div>

      <div
        ref={setNodeRef}
        className={`flex-1 min-h-[450px] p-3 space-y-3 transition-colors ${
          isOver && !isOrphan ? 'bg-slate-slateBlue/10' : ''
        }`}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {todos.map((todo) => (
            <KanbanCard
              key={todo.id}
              todo={todo}
              onEdit={onEdit}
              onRequestRemove={onRequestRemove}
              onMarkDone={onMarkDone}
            />
          ))}
        </SortableContext>
        {todos.length === 0 && (
          <p className="text-xs text-slate-slate500 text-center py-6">
            {isOrphan ? 'Todos whose column was deleted' : 'Drop here'}
          </p>
        )}
      </div>
    </div>
  );
}
