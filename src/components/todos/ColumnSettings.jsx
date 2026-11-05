import { useRef, useState } from 'react';
import { ArrowUp, ArrowDown, Trash2, Plus } from 'lucide-react';
import Modal from '../shared/Modal';
import ConfirmDialog from '../shared/ConfirmDialog';
import { IconButton } from '../shared/ItemActions';
import { ListSkeleton } from '../shared/Skeleton';
import { btnPrimary, formErrorClass, inputClass } from '../shared/formStyles';
import { useTodoColumns } from '../../hooks/useTodoColumns';
import { nextOrder, reorderColumns } from '../../utils/kanban';
import { userError, userMessage } from '../../utils/apiError';

const COLOR_OPTIONS = [
  'gray',
  'blue',
  'green',
  'red',
  'yellow',
  'orange',
  'purple',
  'teal',
  'cyan',
  'pink',
];

const colorLabel = (c) => c.charAt(0).toUpperCase() + c.slice(1);

const SAVE_ERROR = "Couldn't save that change. Check your connection and try again.";
const DELETE_ERROR = "Couldn't delete that column. Try again.";
const LOAD_ERROR = "Couldn't load your columns. Close this and try again.";

// Color pickers sit in a fixed-width cell so the full-width input style fits a row.
const COLOR_CELL = 'w-24 shrink-0';

export default function ColumnSettings({ onClose }) {
  const { columns, writable, loading, error, add, update, remove } = useTodoColumns();
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState(null);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState('blue');
  // Column awaiting delete confirmation.
  const [pendingDelete, setPendingDelete] = useState(null);
  const newNameRef = useRef(null);
  // Synchronous in-flight guard: controls stay enabled (so focus is not lost) and
  // handlers ignore input while a save runs.
  const busyRef = useRef(false);

  // Runs one save. The shared query cache refreshes itself after each mutation,
  // so the board and this dialog stay in sync. Resolves true when it saved.
  const wrap = async (fn) => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setLocalError(null);
    try {
      await fn();
      return true;
    } catch (err) {
      setLocalError(userMessage(err, SAVE_ERROR));
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  // A non-writable backend (no storage configured) means mutations would 503.
  // Show that upfront instead of letting users click into errors.
  const isReadOnly = !writable;

  const moveBy = async (idx, delta) => {
    const target = idx + delta;
    if (target < 0 || target >= columns.length) return;
    const next = reorderColumns(columns, idx, target);
    // Persist new order for every shifted column; backend will accept order
    // updates and we re-fetch.
    await wrap(async () => {
      for (const col of next) {
        const before = columns.find((c) => c.id === col.id);
        if (!before || before.order === col.order) continue;
        await update(col.id, { order: col.order });
      }
    });
  };

  const confirmDelete = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      await remove(pendingDelete.id);
    } catch {
      throw userError(DELETE_ERROR);
    } finally {
      busyRef.current = false;
    }
    setPendingDelete(null);
  };

  // Only read-only mode disables a control. Disabling during a save would drop the
  // focused control to the page, so saves are guarded in the handlers instead.
  const disabled = isReadOnly;

  return (
    <>
      <Modal title="Columns" onClose={onClose} dismissible={!pendingDelete}>
        <div className="space-y-3">
          {isReadOnly && !loading && (
            <p className="text-xs text-accent-amber">
              Columns are read-only because Burrow can&apos;t open your data file. Current columns
              come from defaults.
            </p>
          )}
          {loading && <ListSkeleton rows={3} />}
          {error && (
            <p role="alert" className={formErrorClass}>
              {LOAD_ERROR}
            </p>
          )}
          {localError && (
            <p role="alert" className={formErrorClass}>
              {localError}
            </p>
          )}

          <ul className="space-y-2" aria-busy={busy}>
            {columns.map((col, idx) => (
              <li key={col.id} className="glass-subtle flex flex-wrap items-center gap-2 p-2 rounded-md">
                <input
                  type="text"
                  defaultValue={col.name}
                  aria-label={`Name of column ${col.name}`}
                  onBlur={async (e) => {
                    const input = e.target;
                    const next = input.value.trim();
                    if (!next || next === col.name) return;
                    const saved = await wrap(() => update(col.id, { name: next }));
                    // The input is uncontrolled, so put the saved name back on failure.
                    if (!saved) input.value = col.name;
                  }}
                  className={`${inputClass} flex-1 min-w-32`}
                  disabled={disabled}
                />
                <div className={COLOR_CELL}>
                  <select
                    value={col.color || 'gray'}
                    onChange={(e) => wrap(() => update(col.id, { color: e.target.value }))}
                    className={inputClass}
                    disabled={disabled}
                    aria-label={`Color of column ${col.name}`}
                  >
                    {COLOR_OPTIONS.map((c) => (
                      <option key={c} value={c}>
                        {colorLabel(c)}
                      </option>
                    ))}
                  </select>
                </div>
                <IconButton
                  label={`Move ${col.name} up`}
                  icon={ArrowUp}
                  onClick={() => moveBy(idx, -1)}
                  disabled={disabled}
                  aria-disabled={idx === 0 || undefined}
                  className="disabled:opacity-30 aria-disabled:opacity-30"
                />
                <IconButton
                  label={`Move ${col.name} down`}
                  icon={ArrowDown}
                  onClick={() => moveBy(idx, 1)}
                  disabled={disabled}
                  aria-disabled={idx === columns.length - 1 || undefined}
                  className="disabled:opacity-30 aria-disabled:opacity-30"
                />
                <IconButton
                  label={`Delete column ${col.name}`}
                  icon={Trash2}
                  tone="danger"
                  onClick={() => setPendingDelete(col)}
                  disabled={disabled}
                  aria-haspopup="dialog"
                  className="disabled:opacity-30"
                />
              </li>
            ))}
          </ul>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              const name = newName.trim();
              if (!name) return;
              wrap(async () => {
                await add({ name, color: newColor, order: nextOrder(columns) });
                setNewName('');
                setNewColor('blue');
              });
            }}
            className="flex flex-wrap items-center gap-2 pt-3 border-t border-slate-slate700/60"
          >
            <input
              ref={newNameRef}
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New column name"
              aria-label="New column name"
              className={`${inputClass} flex-1 min-w-32`}
              disabled={disabled}
            />
            <div className={COLOR_CELL}>
              <select
                value={newColor}
                onChange={(e) => setNewColor(e.target.value)}
                className={inputClass}
                disabled={disabled}
                aria-label="New column color"
              >
                {COLOR_OPTIONS.map((c) => (
                  <option key={c} value={c}>
                    {colorLabel(c)}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" disabled={disabled || !newName.trim()} className={btnPrimary}>
              <Plus size={14} /> Add column
            </button>
          </form>
        </div>
      </Modal>

      {pendingDelete && (
        <ConfirmDialog
          title="Delete column?"
          message={`Delete the column "${pendingDelete.name}"? Its todos are kept and show under "No column".`}
          confirmLabel="Delete"
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
          finalFocusRef={newNameRef}
        />
      )}
    </>
  );
}
