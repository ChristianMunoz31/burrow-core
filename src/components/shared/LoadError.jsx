import { btnSecondary } from './formStyles';

/**
 * Fixed-copy state for a list that failed to load (any error that is not the 503
 * "data file unavailable" case). `thing` is the plural noun ("habits"). The copy never
 * includes server text; the user's data is untouched by a failed read. `retrying` disables
 * the button and shows "Retrying…" while a retry is in flight.
 */
export default function LoadError({ thing, onRetry, retrying = false }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-3">
      <p className="text-sm text-slate-slate300">
        Burrow couldn&apos;t load your {thing}. Your data is safe.
      </p>
      <button type="button" onClick={onRetry} disabled={retrying} className={btnSecondary}>
        {retrying ? 'Retrying…' : 'Retry'}
      </button>
    </div>
  );
}
