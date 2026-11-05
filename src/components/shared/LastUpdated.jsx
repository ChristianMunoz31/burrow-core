const TIME_FMT = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
const FULL_FMT = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });

// Small "Updated 3:24 PM" freshness label for data-fetched cards. `at` is a ms
// timestamp (e.g. React Query's dataUpdatedAt); renders nothing until first load.
export default function LastUpdated({ at }) {
  if (!at) return null;
  const d = new Date(at);
  return (
    <span
      className="text-xs text-slate-slate400 tabular-nums"
      title={`Last updated ${FULL_FMT.format(d)}`}
    >
      Updated {TIME_FMT.format(d)}
    </span>
  );
}
