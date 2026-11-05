import { useRef, useState } from 'react';
import { Plus, Pencil, Trash2, X, Check } from 'lucide-react';
import { formatCurrency } from '../../utils/budgetAggregate';
import { payeeOccurrencesInMonth } from '../../utils/budgetPlan';
import { evalAmount } from '../../utils/evalAmount';
import ConfirmDialog from '../shared/ConfirmDialog';
import { IconButton } from '../shared/ItemActions';
import { btnPrimary, btnSecondary } from '../shared/formStyles';

const UNITS = [
  { value: 'day', label: 'day(s)' },
  { value: 'week', label: 'week(s)' },
  { value: 'month', label: 'month(s)' },
];

const inputClass =
  'glass-input rounded-md px-2 py-1 text-xs text-slate-slate100 focus:border-slate-slateBlue focus:outline-none';

const emptyDraft = { name: '', amount: '', every: '1', unit: 'month', anchorDate: '' };

// Manage the recurring income deposits ("payees") that make up planned income.
// Each payee deposits `amount` every `every` `unit`s from `anchorDate`; the sum
// of occurrences in the selected month is what flows into the budget as income.
export default function IncomePayees({ month, payees, setPayees }) {
  const list = Array.isArray(payees) ? payees : [];
  const [editingId, setEditingId] = useState(null); // 'new' while adding
  const [draft, setDraft] = useState(emptyDraft);
  const [pendingRemove, setPendingRemove] = useState(null);
  // Focus returns here after a payee is removed, since its row (and button) is gone.
  const addRef = useRef(null);

  const startAdd = () => {
    setDraft(emptyDraft);
    setEditingId('new');
  };
  const startEdit = (p) => {
    setDraft({
      name: p.name ?? '',
      amount: String(p.amount ?? ''),
      every: String(p.every ?? 1),
      unit: p.unit ?? 'month',
      anchorDate: p.anchorDate ?? '',
    });
    setEditingId(p.id);
  };
  const cancel = () => {
    setEditingId(null);
    setDraft(emptyDraft);
  };

  // Resolve the amount through evalAmount so an expression (e.g. "1000+500")
  // gates and saves correctly even if the field hasn't blurred to normalize yet.
  const amountValue = evalAmount(draft.amount) ?? 0;

  const valid =
    draft.name.trim() !== '' &&
    amountValue > 0 &&
    Math.floor(Number(draft.every)) >= 1 &&
    draft.anchorDate !== '';

  const save = () => {
    if (!valid) return;
    const entry = {
      name: draft.name.trim(),
      amount: amountValue,
      every: Math.max(1, Math.floor(Number(draft.every) || 1)),
      unit: draft.unit,
      anchorDate: draft.anchorDate,
    };
    if (editingId === 'new') {
      setPayees([...list, { id: crypto.randomUUID(), ...entry }]);
    } else {
      setPayees(list.map((p) => (p.id === editingId ? { ...p, ...entry } : p)));
    }
    cancel();
  };

  const confirmRemove = () => {
    setPayees(list.filter((p) => p.id !== pendingRemove.id));
    setPendingRemove(null);
  };

  const submit = (e) => {
    e.preventDefault();
    save();
  };

  return (
    <div className="space-y-2 glass-subtle rounded-lg p-3">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold text-slate-slate200">Income payees</h4>
        {editingId == null && (
          <button
            ref={addRef}
            type="button"
            onClick={startAdd}
            className={`${btnSecondary} inline-flex items-center gap-1`}
          >
            <Plus size={12} /> Add payee
          </button>
        )}
      </div>

      {list.length === 0 && editingId == null && (
        <p className="text-[11px] text-slate-slate500">
          Add a recurring deposit (paycheck, side gig) to build this month&apos;s planned income.
        </p>
      )}

      {list.length > 0 && (
        <ul className="space-y-1">
          {list.map((p) => {
            const occ = payeeOccurrencesInMonth(p, month);
            const unitLabel = UNITS.find((u) => u.value === p.unit)?.label || p.unit;
            return (
              <li
                key={p.id}
                className="flex items-center justify-between gap-2 rounded-md bg-slate-slate800/40 px-2 py-1.5 text-xs"
              >
                <div className="min-w-0">
                  <span className="font-medium text-slate-slate100">{p.name}</span>
                  <span className="ml-2 text-slate-slate400">
                    {formatCurrency(p.amount)} · every {p.every} {unitLabel}
                  </span>
                </div>
                <div className="flex items-center gap-2 whitespace-nowrap">
                  <span className="tabular-nums text-accent-green">
                    {occ > 0 ? `${formatCurrency(p.amount * occ)} (${occ}×)` : 'None this month'}
                  </span>
                  <IconButton label={`Edit ${p.name}`} icon={Pencil} onClick={() => startEdit(p)} />
                  <IconButton
                    label={`Remove ${p.name}`}
                    icon={Trash2}
                    tone="danger"
                    onClick={() => setPendingRemove(p)}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {editingId != null && (
        <form onSubmit={submit} className="flex flex-wrap items-end gap-2 glass-subtle rounded-lg p-2">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wide text-slate-slate500">Name</span>
            <input
              type="text"
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder="Paycheck"
              className={`${inputClass} w-32`}
              aria-label="Payee name"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wide text-slate-slate500">Amount</span>
            <input
              type="text"
              inputMode="decimal"
              title="Accepts math, e.g. 1000+500"
              value={draft.amount}
              placeholder="0.00"
              onChange={(e) => setDraft((d) => ({ ...d, amount: e.target.value }))}
              onFocus={(e) => e.target.select()}
              onBlur={() =>
                setDraft((d) => {
                  const n = evalAmount(d.amount);
                  return n == null ? d : { ...d, amount: String(n) };
                })
              }
              className={`${inputClass} w-24 text-right tabular-nums`}
              aria-label="Deposit amount"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wide text-slate-slate500">Every</span>
            <input
              type="number"
              inputMode="numeric"
              min="1"
              step="1"
              value={draft.every}
              onChange={(e) => setDraft((d) => ({ ...d, every: e.target.value }))}
              className={`${inputClass} w-16 text-right tabular-nums`}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wide text-slate-slate500">Unit</span>
            <select
              value={draft.unit}
              onChange={(e) => setDraft((d) => ({ ...d, unit: e.target.value }))}
              className={`${inputClass} w-24`}
              aria-label="Interval unit"
            >
              {UNITS.map((u) => (
                <option key={u.value} value={u.value}>
                  {u.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wide text-slate-slate500">Starting</span>
            <input
              type="date"
              value={draft.anchorDate}
              onChange={(e) => setDraft((d) => ({ ...d, anchorDate: e.target.value }))}
              className={`${inputClass} w-36`}
            />
          </label>
          <div className="flex items-center gap-1 pb-0.5">
            <button
              type="submit"
              disabled={!valid}
              aria-label="Save payee"
              className={btnPrimary}
            >
              <Check size={12} /> Save
            </button>
            <button
              type="button"
              onClick={cancel}
              aria-label="Cancel"
              className={`${btnSecondary} inline-flex items-center gap-1`}
            >
              <X size={12} />
            </button>
          </div>
        </form>
      )}
      {pendingRemove && (
        <ConfirmDialog
          title="Remove payee?"
          message={`"${pendingRemove.name}" will be removed from your planned income.`}
          finalFocusRef={addRef}
          onConfirm={confirmRemove}
          onCancel={() => setPendingRemove(null)}
        />
      )}
    </div>
  );
}
