function countLabel(table) {
  if (table.count === null || table.count === undefined) return 'n/a';
  return table.count.toLocaleString();
}

function groupTables(tables) {
  const groups = new Map();
  for (const t of tables) {
    if (!groups.has(t.group)) groups.set(t.group, []);
    groups.get(t.group).push(t);
  }
  return [...groups.entries()];
}

export default function TablePicker({ tables, active, onSelect }) {
  return (
    <>
      <div className="sm:hidden">
        <label className="mb-1 block text-xs font-semibold text-slate-slate400" htmlFor="data-table-select">
          Table
        </label>
        <select
          id="data-table-select"
          value={active ?? ''}
          onChange={(e) => onSelect(e.target.value)}
          className="glass-input w-full rounded-md px-3 py-2 text-sm text-slate-slate100"
        >
          {groupTables(tables).map(([group, items]) => (
            <optgroup key={group} label={group}>
              {items.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label} ({countLabel(t)})
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      <nav aria-label="Tables" className="glass hidden rounded-2xl p-3 sm:block">
        {groupTables(tables).map(([group, items]) => (
          <div key={group} className="mb-3 last:mb-0">
            <p className="mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-slate-slate400">
              {group}
            </p>
            <ul role="list" className="space-y-0.5">
              {items.map((t) => {
                const current = t.id === active;
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(t.id)}
                      aria-current={current ? 'true' : undefined}
                      className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:[outline-color:var(--focus-ring)] ${
                        current
                          ? 'bg-slate-slateBlue font-semibold text-white'
                          : 'text-slate-slate300 hover:text-slate-slate100'
                      }`}
                    >
                      <span className="truncate">{t.label}</span>
                      <span className={`text-xs tabular-nums ${current ? '' : 'opacity-80'}`}>{countLabel(t)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </>
  );
}
