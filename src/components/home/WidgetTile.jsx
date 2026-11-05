import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Maximize2, Minimize2, Eye, EyeOff } from 'lucide-react';

// Static class maps so Tailwind's JIT keeps these (no dynamic class strings).
const W_CLASS = { 1: '', 2: 'md:col-span-2 lg:col-span-2', 3: 'md:col-span-2 lg:col-span-3 xl:col-span-4' };
const H_CLASS = { 1: '', 2: 'row-span-2' };
const DEFAULT_CARD = { w: 1, h: 1 };

export default function WidgetTile({
  id,
  Component,
  card = DEFAULT_CARD,
  children,
  className = '',
  dragLabel = 'Drag to reorder',
  editing,
  onCycleWidth,
  onToggleHeight,
  onToggleHidden,
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: !editing,
  });

  const spanClass = `${W_CLASS[card.w] || ''} ${H_CLASS[card.h] || ''} ${className}`;

  if (!editing) {
    return (
      <div className={`rounded-2xl ${spanClass}`}>
        {children ?? <Component />}
      </div>
    );
  }

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  const ring = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-slateBlueLight';
  const ctrlBtn = `p-1 rounded text-slate-slate300 hover:text-slate-slate100 hover:bg-slate-slate700/60 ${ring}`;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`relative h-full rounded-2xl ring-1 ring-slate-slate700/60 ${spanClass} ${card.hidden ? 'opacity-40' : ''}`}
    >
      <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-1 rounded-t-2xl bg-slate-slate900 px-2 py-1">
        <button
          type="button"
          className={`cursor-grab active:cursor-grabbing p-1 rounded text-slate-slate400 hover:text-slate-slate100 ${ring}`}
          aria-label={dragLabel}
          {...attributes}
          {...listeners}
        >
          <GripVertical size={14} />
        </button>
        {onCycleWidth && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onCycleWidth}
              className={`px-1.5 py-1 text-[10px] font-semibold tabular-nums rounded text-slate-slate300 hover:text-slate-slate100 hover:bg-slate-slate700/60 ${ring}`}
              aria-label="Cycle width"
            >
              {card.w}/3
            </button>
            <button type="button" onClick={onToggleHeight} className={ctrlBtn} aria-label="Toggle height">
              {card.h === 2 ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
            <button
              type="button"
              onClick={onToggleHidden}
              className={ctrlBtn}
              aria-label={card.hidden ? 'Show card' : 'Hide card'}
            >
              {card.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        )}
      </div>
      <div className="pointer-events-none select-none h-full pt-8">
        {children ?? <Component dimmed={Boolean(card.hidden)} />}
      </div>
    </div>
  );
}
