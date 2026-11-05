import { Pencil, Trash2 } from 'lucide-react';

const BASE =
  'inline-flex items-center justify-center w-9 h-9 sm:w-7 sm:h-7 rounded-md text-slate-slate500 hover:bg-slate-slate700/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-slateBlueLight';
const TONES = {
  default: 'hover:text-slate-slate100',
  danger: 'hover:text-accent-red',
};

/** Small square icon button. `label` becomes the accessible name. */
export function IconButton({ label, icon: Icon, tone = 'default', onClick, className = '', ...rest }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.(e);
      }}
      className={`${BASE} ${TONES[tone] ?? TONES.default} ${className}`.trim()}
      {...rest}
    >
      <Icon size={14} />
    </button>
  );
}

const stop = (e) => e.stopPropagation();

/**
 * Edit/Remove icon pair for a list item. Pointer/key events are stopped so the
 * buttons stay usable inside drag-and-drop nodes. Hidden until hover on fine pointers.
 */
export default function ItemActions({ name, onEdit, onRemove, children, className = '' }) {
  return (
    <div
      className={`reveal-on-hover flex items-center gap-0.5 shrink-0 ${className}`.trim()}
      onPointerDown={stop}
      onMouseDown={stop}
      onTouchStart={stop}
      onKeyDown={stop}
    >
      {children}
      {onEdit && <IconButton label={`Edit ${name}`} icon={Pencil} onClick={onEdit} />}
      {onRemove && <IconButton label={`Remove ${name}`} icon={Trash2} tone="danger" onClick={onRemove} />}
    </div>
  );
}
