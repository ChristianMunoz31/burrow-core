import { useEffect, useMemo, useState } from 'react';
import { Repeat } from 'lucide-react';
import WidgetCard from '../shared/WidgetCard';
import { WidgetSkeleton } from '../shared/Skeleton';
import { useRecords } from '../../hooks/useRecords';
import { detectSubscriptions, upcomingCharges } from '../../utils/subscriptions';
import { formatCurrency } from '../../utils/budgetAggregate';

const WINDOW_DAYS = 30;
const SHOWN = 3;

const whenLabel = (daysAway) =>
  daysAway === 0 ? 'today' : daysAway === 1 ? 'tomorrow' : `in ${daysAway} days`;

// The local day as a key, refreshed when the window comes back (Home can stay open past midnight).
const dayKey = () => new Date().toDateString();
function useLocalDay() {
  const [day, setDay] = useState(dayKey);
  useEffect(() => {
    const check = () => setDay(dayKey());
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, []);
  return day;
}

// Subscriptions card on Home: the next subscription charges, found by the same detector
// as the Subscriptions page. Every date and the total are computed here in code; no model is involved.
export default function SubscriptionsWidget() {
  const { records, loading, fetchFailed } = useRecords();
  const day = useLocalDay();
  // One "now" per local day for both steps, so labels and the total never mix two days.
  const now = useMemo(() => new Date(), [day]); // eslint-disable-line react-hooks/exhaustive-deps
  const result = useMemo(() => detectSubscriptions(records, { now }), [records, now]);
  const { charges, total } = useMemo(() => upcomingCharges(result, { now, days: WINDOW_DAYS }), [result, now]);

  let body;
  if (loading) {
    body = <WidgetSkeleton />;
  } else if (fetchFailed) {
    body = (
      <p className="text-xs text-slate-slate400">
        Couldn't load your transactions. Open Subscriptions to try again.
      </p>
    );
  } else if (!result.items.some((i) => i.kind === 'subscription')) {
    body = (
      <>
        <p className="text-xs text-slate-slate400">No subscriptions found in your transactions yet.</p>
        <div className="mt-3 text-xs text-accent-indigo">Open Subscriptions →</div>
      </>
    );
  } else if (charges.length === 0) {
    body = <p className="text-xs text-slate-slate400">Nothing due in the next {WINDOW_DAYS} days.</p>;
  } else {
    body = (
      <>
        <ul className="space-y-2">
          {charges.slice(0, SHOWN).map((c) => (
            <li key={c.id} className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0">
                <span className="block truncate text-slate-slate100">{c.merchant}</span>
                <span className="block text-xs text-slate-slate400">{whenLabel(c.daysAway)}</span>
              </span>
              <span className="shrink-0 tabular-nums text-slate-slate200">{formatCurrency(c.amount)}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-slate-slate300 tabular-nums">
          Due in the next {WINDOW_DAYS} days: {formatCurrency(total)}
        </p>
      </>
    );
  }

  return (
    <WidgetCard busy={loading} to="/budget/subscriptions" title="Subscriptions" icon={Repeat} accent="text-accent-indigo">
      {body}
    </WidgetCard>
  );
}
