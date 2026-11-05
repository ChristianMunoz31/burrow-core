import { formatCell } from '../../utils/dataFormat';

const TONE = { pos: 'text-accent-green', neg: 'text-accent-red' };

/** Formats one cell. Long text/JSON is truncated with an Expand button that calls onExpand. */
export default function CellValue({ value, column, amountColumn, rowLabel, onExpand }) {
  const cell = formatCell(value, column, { amountColumn });

  if (cell.kind === 'null') return <span className="text-slate-slate500">{cell.text}</span>;
  if (cell.kind === 'redacted') {
    return (
      <span className="inline-flex rounded-full bg-slate-slate500/15 px-2 py-0.5 text-xs italic text-slate-slate300">
        {cell.text}
      </span>
    );
  }

  const tone = cell.tone ? TONE[cell.tone] : '';
  const mono = cell.kind === 'json' || cell.kind === 'uuid' ? 'font-mono text-xs' : '';
  const align = cell.kind === 'currency' ? 'tabular-nums' : '';

  return (
    <span className={`inline-flex max-w-md items-baseline gap-2 ${tone} ${mono} ${align}`}>
      <span title={cell.title} className={cell.full ? 'truncate' : 'whitespace-nowrap'}>
        {cell.text}
      </span>
      {cell.full && (
        <button
          type="button"
          onClick={(e) =>
            onExpand({ title: column.name, content: cell.full, trigger: e.currentTarget })
          }
          aria-label={`Expand ${column.name} value${rowLabel ? `, ${rowLabel}` : ''}`}
          className="shrink-0 rounded px-1 text-xs font-semibold text-slate-slate300 underline hover:text-slate-slate100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:[outline-color:var(--focus-ring)]"
        >
          Expand
        </button>
      )}
    </span>
  );
}
