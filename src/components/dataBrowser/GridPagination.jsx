import { PAGE_SIZES, lastPageOf, rowRange } from '../../utils/dataFormat';
import { BTN } from '../settings/pillStyles';

export default function GridPagination({ page, pageSize, total, onPage, onPageSize }) {
  const pages = lastPageOf(total, pageSize);
  const { from, to } = rowRange(page, pageSize, total);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 px-4 py-3 text-sm text-slate-slate300">
      <p>
        Rows {from.toLocaleString()} to {to.toLocaleString()} of {total.toLocaleString()}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs text-slate-slate400">
          Rows per page
          <select
            value={pageSize}
            onChange={(e) => onPageSize(Number(e.target.value))}
            className="glass-input rounded-md px-2 py-1 text-sm text-slate-slate100"
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => onPage(page - 1)}
          disabled={page <= 1}
          aria-label="Previous page"
          className={BTN}
        >
          Prev
        </button>
        <span className="text-xs text-slate-slate400">
          Page {page} of {pages}
        </span>
        <button
          type="button"
          onClick={() => onPage(page + 1)}
          disabled={page >= pages}
          aria-label="Next page"
          className={BTN}
        >
          Next
        </button>
      </div>
    </div>
  );
}
