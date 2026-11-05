import { useMemo, useRef, useState } from 'react';
import { ArrowUp, ArrowDown, Eye, EyeOff, Trash2, Plus, Lock, RotateCcw } from 'lucide-react';
import budgetConfig from '../../data/budgetConfig.json';
import { resolveStructure } from '../../utils/budgetPlan';
import { evalAmount } from '../../utils/evalAmount';
import ConfirmDialog from '../shared/ConfirmDialog';
import { IconButton } from '../shared/ItemActions';
import { btnPrimary } from '../shared/formStyles';

const STEP = 1024;
const inputClass =
  'glass-input rounded-md px-2 py-1 text-xs text-slate-slate100 focus:border-slate-slateBlue focus:outline-none';
const DIS = 'disabled:cursor-not-allowed disabled:opacity-30';

// Inline rename field: commits the trimmed value on blur/Enter, reverts on Escape.
function NameInput({ value, onCommit, ariaLabel, disabled }) {
  const [draft, setDraft] = useState(null);
  // Set by Escape so the blur that follows discards the draft instead of committing it.
  const cancelled = useRef(false);
  const display = draft != null ? draft : value;
  return (
    <input
      type="text"
      value={display}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (cancelled.current) {
          cancelled.current = false;
          setDraft(null);
          return;
        }
        if (draft != null) {
          const v = draft.trim();
          if (v && v !== value) onCommit(v);
          setDraft(null);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') {
          cancelled.current = true;
          setDraft(null);
          e.currentTarget.blur();
        }
      }}
      className={`${inputClass} flex-1 min-w-0 disabled:opacity-60`}
      aria-label={ariaLabel}
    />
  );
}

// Per-category default budget field: commits on blur/Enter, reverts on Escape.
// Accepts math expressions (e.g. 50+25) via evalAmount. Empty clears the default;
// invalid input reverts (no commit, no clear); a real number (incl. a deliberate 0)
// sets it.
function DefaultInput({ value, onCommit, onClear, ariaLabel }) {
  const [draft, setDraft] = useState(null);
  const cancelled = useRef(false);
  const display = draft != null ? draft : (value ?? '');
  return (
    <input
      type="text"
      inputMode="decimal"
      title="Accepts math, e.g. 50+25"
      value={display}
      placeholder="-"
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={() => {
        if (cancelled.current) {
          cancelled.current = false;
          setDraft(null);
          return;
        }
        if (draft != null) {
          const trimmed = draft.trim();
          if (trimmed === '') {
            // Empty clears the default.
            onClear();
            setDraft(null);
          } else {
            const n = evalAmount(trimmed);
            // Invalid reverts (no commit, no clear); a real number (incl. 0) sets it.
            if (n == null) {
              setDraft(null);
            } else {
              onCommit(n);
              setDraft(null);
            }
          }
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') {
          cancelled.current = true;
          setDraft(null);
          e.currentTarget.blur();
        }
      }}
      className={`${inputClass} w-20 text-right tabular-nums`}
      aria-label={ariaLabel}
    />
  );
}

export default function CategoryEditor({ structure, setStructure, defaults, setDefaults }) {
  const [showHidden, setShowHidden] = useState(false);
  const [newGroup, setNewGroup] = useState('');
  const [newGroupIncome, setNewGroupIncome] = useState(false);
  // {kind: 'group' | 'category', item} waiting for the user to confirm a delete.
  const [pendingDelete, setPendingDelete] = useState(null);
  // Focus lands here after a delete confirms, since the deleted row's button is gone.
  const newGroupRef = useRef(null);

  const full = useMemo(
    () => resolveStructure(structure, { includeHidden: true }),
    [structure],
  );
  const groupsSorted = useMemo(
    () => full.groups.slice().sort((a, b) => a.sortOrder - b.sortOrder),
    [full],
  );
  const catsByGroup = useMemo(() => {
    const m = new Map();
    for (const g of groupsSorted) m.set(g.id, []);
    for (const c of full.categories) {
      if (!m.has(c.groupId)) m.set(c.groupId, []);
      m.get(c.groupId).push(c);
    }
    for (const [, arr] of m) arr.sort((a, b) => a.sortOrder - b.sortOrder);
    return m;
  }, [groupsSorted, full]);

  // --- immutable overlay patchers -------------------------------------------
  const patchGroups = (fn) =>
    setStructure((prev) => {
      const p = prev || {};
      const src = p.groups || {};
      const g = {
        added: [...(src.added || [])],
        renamed: { ...(src.renamed || {}) },
        hidden: [...(src.hidden || [])],
        order: { ...(src.order || {}) },
      };
      fn(g);
      return { ...p, groups: g };
    });
  const patchCats = (fn) =>
    setStructure((prev) => {
      const p = prev || {};
      const src = p.categories || {};
      const c = {
        added: [...(src.added || [])],
        renamed: { ...(src.renamed || {}) },
        hidden: [...(src.hidden || [])],
        order: { ...(src.order || {}) },
        moved: { ...(src.moved || {}) },
      };
      fn(c);
      return { ...p, categories: c };
    });

  // --- group ops ------------------------------------------------------------
  const addGroup = () => {
    const name = newGroup.trim();
    if (!name) return;
    const sortOrder = Math.max(0, ...groupsSorted.map((g) => g.sortOrder)) + STEP;
    patchGroups((g) => g.added.push({ id: crypto.randomUUID(), name, isIncome: newGroupIncome, sortOrder }));
    setNewGroup('');
    setNewGroupIncome(false);
  };
  const renameGroup = (item, name) =>
    item.custom
      ? patchGroups((g) => { g.added = g.added.map((x) => (x.id === item.id ? { ...x, name } : x)); })
      : patchGroups((g) => { g.renamed[item.id] = name; });
  const toggleHideGroup = (item) =>
    patchGroups((g) => {
      g.hidden = g.hidden.includes(item.id) ? g.hidden.filter((x) => x !== item.id) : [...g.hidden, item.id];
    });
  const deleteGroup = (item) => {
    // Custom-only. Cascade: drop its custom cats, revert synced cats moved into it.
    const childCustomIds = (catsByGroup.get(item.id) || []).filter((c) => c.custom).map((c) => c.id);
    patchGroups((g) => {
      g.added = g.added.filter((x) => x.id !== item.id);
      delete g.renamed[item.id];
      delete g.order[item.id];
      g.hidden = g.hidden.filter((x) => x !== item.id);
    });
    patchCats((c) => {
      c.added = c.added.filter((x) => x.id !== item.id && !childCustomIds.includes(x.id));
      for (const [catId, gid] of Object.entries(c.moved)) if (gid === item.id) delete c.moved[catId];
    });
  };
  const moveGroup = (idx, delta) => {
    const to = idx + delta;
    if (to < 0 || to >= groupsSorted.length) return;
    const arr = groupsSorted.slice();
    const [m] = arr.splice(idx, 1);
    arr.splice(to, 0, m);
    patchGroups((g) => arr.forEach((grp, i) => { g.order[grp.id] = i * STEP; }));
  };

  // --- category ops ---------------------------------------------------------
  const addCat = (groupId, name) => {
    const v = (name || '').trim();
    if (!v) return;
    const sibs = catsByGroup.get(groupId) || [];
    const sortOrder = Math.max(0, ...sibs.map((c) => c.sortOrder)) + STEP;
    patchCats((c) => c.added.push({ id: crypto.randomUUID(), name: v, groupId, sortOrder }));
  };
  const renameCat = (item, name) =>
    item.custom
      ? patchCats((c) => { c.added = c.added.map((x) => (x.id === item.id ? { ...x, name } : x)); })
      : patchCats((c) => { c.renamed[item.id] = name; });
  const toggleHideCat = (item) =>
    patchCats((c) => {
      c.hidden = c.hidden.includes(item.id) ? c.hidden.filter((x) => x !== item.id) : [...c.hidden, item.id];
    });
  const deleteCat = (item) =>
    patchCats((c) => {
      c.added = c.added.filter((x) => x.id !== item.id);
      delete c.renamed[item.id];
      delete c.order[item.id];
      delete c.moved[item.id];
      c.hidden = c.hidden.filter((x) => x !== item.id);
    });
  const moveCatToGroup = (item, groupId) => {
    if (groupId === item.groupId) return;
    if (item.custom) {
      patchCats((c) => { c.added = c.added.map((x) => (x.id === item.id ? { ...x, groupId } : x)); });
    } else {
      const origGroupId = budgetConfig.categories.find((c) => c.id === item.id)?.groupId;
      patchCats((c) => { if (groupId === origGroupId) delete c.moved[item.id]; else c.moved[item.id] = groupId; });
    }
  };
  const moveCat = (groupId, idx, delta) => {
    const sibs = catsByGroup.get(groupId) || [];
    const to = idx + delta;
    if (to < 0 || to >= sibs.length) return;
    const arr = sibs.slice();
    const [m] = arr.splice(idx, 1);
    arr.splice(to, 0, m);
    patchCats((c) => arr.forEach((cat, i) => { c.order[cat.id] = i * STEP; }));
  };

  // --- per-category default budget ------------------------------------------
  const setDefault = (catId, amount) => setDefaults((prev) => ({ ...(prev || {}), [catId]: amount }));
  const clearDefault = (catId) => setDefaults((prev) => { const n = { ...(prev || {}) }; delete n[catId]; return n; });

  const confirmDelete = () => {
    if (pendingDelete.kind === 'group') deleteGroup(pendingDelete.item);
    else deleteCat(pendingDelete.item);
    setPendingDelete(null);
  };
  const deleteMessage = () => {
    const { kind, item } = pendingDelete;
    if (kind === 'category') return `"${item.name}" will be permanently deleted.`;
    const customCount = (catsByGroup.get(item.id) || []).filter((c) => c.custom).length;
    if (customCount === 0) return `"${item.name}" will be permanently deleted.`;
    return `"${item.name}" and its ${customCount} custom ${
      customCount === 1 ? 'category' : 'categories'
    } will be permanently deleted.`;
  };

  const visibleGroups = showHidden ? groupsSorted : groupsSorted.filter((g) => !g.hidden);

  return (
    <div className="space-y-3 glass-subtle rounded-lg p-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wide text-slate-slate500">New group</span>
            <input
              ref={newGroupRef}
              type="text"
              value={newGroup}
              onChange={(e) => setNewGroup(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addGroup(); }}
              placeholder="e.g. Goals"
              className={`${inputClass} w-40`}
              aria-label="New group name"
            />
          </label>
          <label className="flex items-center gap-1 pb-1.5 text-[11px] text-slate-slate300">
            <input
              type="checkbox"
              checked={newGroupIncome}
              onChange={(e) => setNewGroupIncome(e.target.checked)}
              aria-label="New group is income"
            />
            Income
          </label>
          <button
            type="button"
            onClick={addGroup}
            disabled={!newGroup.trim()}
            className={btnPrimary}
          >
            <Plus size={12} /> Add group
          </button>
        </div>
        <button
          type="button"
          onClick={() => setShowHidden((v) => !v)}
          className="rounded-md px-1 text-[11px] text-slate-slate400 underline-offset-2 hover:text-slate-slate200 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-slateBlueLight"
        >
          {showHidden ? 'Hide hidden' : 'Show hidden'}
        </button>
      </div>

      <div className="space-y-3">
        {visibleGroups.map((g) => (
          <GroupBlock
            key={g.id}
            group={g}
            idx={groupsSorted.indexOf(g)}
            total={groupsSorted.length}
            cats={(catsByGroup.get(g.id) || []).filter((c) => showHidden || !c.hidden)}
            allCats={catsByGroup.get(g.id) || []}
            groups={groupsSorted}
            onRenameGroup={renameGroup}
            onHideGroup={toggleHideGroup}
            onDeleteGroup={(item) => setPendingDelete({ kind: 'group', item })}
            onMoveGroup={moveGroup}
            onAddCat={addCat}
            onRenameCat={renameCat}
            onHideCat={toggleHideCat}
            onDeleteCat={(item) => setPendingDelete({ kind: 'category', item })}
            onMoveCatToGroup={moveCatToGroup}
            onMoveCat={moveCat}
            defaults={defaults}
            onSetDefault={setDefault}
            onClearDefault={clearDefault}
          />
        ))}
      </div>
      <p className="text-[10px] text-slate-slate500">
        Changes save automatically. Built-in items can be hidden (reversible); custom items can be
        deleted. The Income category is pinned. A subcategory's default seeds its budget every month
        unless you edit that month directly.
      </p>
      {pendingDelete && (
        <ConfirmDialog
          title={pendingDelete.kind === 'group' ? 'Delete group?' : 'Delete category?'}
          message={deleteMessage()}
          confirmLabel="Delete"
          finalFocusRef={newGroupRef}
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

function GroupBlock({
  group, idx, total, cats, allCats, groups,
  onRenameGroup, onHideGroup, onDeleteGroup, onMoveGroup,
  onAddCat, onRenameCat, onHideCat, onDeleteCat, onMoveCatToGroup, onMoveCat,
  defaults, onSetDefault, onClearDefault,
}) {
  const [newCat, setNewCat] = useState('');
  const submitCat = () => { onAddCat(group.id, newCat); setNewCat(''); };

  return (
    <div className={`rounded-md border border-slate-slate700/60 ${group.hidden ? 'opacity-50' : ''}`}>
      <div className="flex items-center gap-1.5 bg-slate-slate800/40 px-2 py-1.5">
        <IconButton label={`Move ${group.name} up`} icon={ArrowUp} className={DIS} disabled={idx <= 0} onClick={() => onMoveGroup(idx, -1)} />
        <IconButton label={`Move ${group.name} down`} icon={ArrowDown} className={DIS} disabled={idx >= total - 1} onClick={() => onMoveGroup(idx, 1)} />
        <NameInput value={group.name} onCommit={(name) => onRenameGroup(group, name)} ariaLabel={`Group name ${group.name}`} />
        {group.isIncome && <span className="text-[9px] uppercase tracking-wide text-accent-green">income</span>}
        <IconButton label={`${group.hidden ? 'Show' : 'Hide'} group ${group.name}`} icon={group.hidden ? EyeOff : Eye} onClick={() => onHideGroup(group)} />
        {group.custom && (
          <IconButton label={`Delete group ${group.name}`} icon={Trash2} tone="danger" onClick={() => onDeleteGroup(group)} />
        )}
      </div>

      <div className="space-y-1 px-2 py-1.5">
        {cats.map((c, i) => {
          const hasDefault = (defaults || {})[c.id] != null && (defaults || {})[c.id] !== '';
          return (
          <div key={c.id} className={`flex flex-wrap items-center gap-1.5 ${c.hidden ? 'opacity-50' : ''}`}>
            <IconButton label={`Move ${c.name} up`} icon={ArrowUp} className={DIS} disabled={i <= 0} onClick={() => onMoveCat(group.id, allCats.indexOf(c), -1)} />
            <IconButton label={`Move ${c.name} down`} icon={ArrowDown} className={DIS} disabled={i >= cats.length - 1} onClick={() => onMoveCat(group.id, allCats.indexOf(c), 1)} />
            <NameInput value={c.name} onCommit={(name) => onRenameCat(c, name)} ariaLabel={`Subcategory name ${c.name}`} disabled={c.pinned} />
            {c.pinned ? (
              <span className="flex items-center gap-1 text-[9px] uppercase tracking-wide text-slate-slate500"><Lock size={11} /> pinned</span>
            ) : (
              <>
                <select
                  value={c.groupId}
                  onChange={(e) => onMoveCatToGroup(c, e.target.value)}
                  className={`${inputClass} max-w-[120px]`}
                  aria-label={`Move ${c.name} to group`}
                >
                  {groups.map((gr) => (
                    <option key={gr.id} value={gr.id}>{gr.name}</option>
                  ))}
                </select>
                {!group.isIncome && (
                  <>
                    <DefaultInput
                      value={(defaults || {})[c.id]}
                      onCommit={(amt) => onSetDefault(c.id, amt)}
                      onClear={() => onClearDefault(c.id)}
                      ariaLabel={`Default budget for ${c.name}`}
                    />
                    {hasDefault && (
                      <IconButton label={`Clear default budget for ${c.name}`} icon={RotateCcw} title="Clear default budget" onClick={() => onClearDefault(c.id)} />
                    )}
                  </>
                )}
                <IconButton label={`${c.hidden ? 'Show' : 'Hide'} ${c.name}`} icon={c.hidden ? EyeOff : Eye} onClick={() => onHideCat(c)} />
                {c.custom && (
                  <IconButton label={`Delete ${c.name}`} icon={Trash2} tone="danger" onClick={() => onDeleteCat(c)} />
                )}
              </>
            )}
          </div>
          );
        })}

        <div className="flex items-center gap-1.5 pt-1">
          <input
            type="text"
            value={newCat}
            onChange={(e) => setNewCat(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submitCat(); }}
            placeholder="Add subcategory…"
            className={`${inputClass} flex-1 min-w-0`}
            aria-label={`Add subcategory to ${group.name}`}
          />
          <IconButton label={`Add subcategory to ${group.name}`} icon={Plus} className={DIS} onClick={submitCat} disabled={!newCat.trim()} />
        </div>
      </div>
    </div>
  );
}
