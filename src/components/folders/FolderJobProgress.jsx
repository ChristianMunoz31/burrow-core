import { btnSecondary } from '../shared/formStyles';
import { phaseCounts, phaseLabel, phaseName } from '../../constants/folders';

/** The thin progress bar of a phase with a known size; nothing for the others. */
export function JobBar({ job }) {
  const counts = phaseCounts(job);
  if (!counts) return null;
  return (
    <div
      role="progressbar"
      aria-label={phaseLabel(job)}
      aria-valuemin={0}
      aria-valuemax={counts.total}
      aria-valuenow={Math.min(counts.done, counts.total)}
      className="mt-1.5 h-1 overflow-hidden rounded-full bg-slate-slate700/60"
    >
      <div
        className="h-full rounded-full bg-slate-slateBlue"
        style={{ width: `${Math.min(100, (counts.done / counts.total) * 100)}%` }}
      />
    </div>
  );
}

/**
 * Where a running folder job is: one line (the phase in words and Cancel) and a thin bar once the phase has a
 * known size.
 * The numbers are the server's own counts and live on the progress bar; the live region announces only the
 * phase name, so it does not chatter on every count.
 * @param {{ job: object, onCancel: () => void, cancelling?: boolean }} props
 */
export default function FolderJobProgress({ job, onCancel, cancelling = false }) {
  const seen = job.phase === 'inventory' ? job.progress?.filesSeen : null;
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 text-sm text-slate-slate100">
          <span role="status">{phaseName(job)}</span>
          {seen > 0 && (
            <span className="ml-2 text-xs tabular-nums text-slate-slate400">{seen.toLocaleString()} found</span>
          )}
        </div>
        <button
          type="button"
          aria-disabled={cancelling || undefined}
          onClick={() => {
            if (cancelling) return;
            onCancel();
          }}
          className={`${btnSecondary} aria-disabled:cursor-not-allowed aria-disabled:opacity-50`}
        >
          Cancel
        </button>
      </div>
      <JobBar job={job} />
    </div>
  );
}
