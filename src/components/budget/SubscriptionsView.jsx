import { useEffect, useMemo, useState } from 'react';
import { Repeat } from 'lucide-react';
import SectionCard from '../shared/SectionCard';
import { Skeleton } from '../shared/Skeleton';
import { useRecords } from '../../hooks/useRecords';
import { usePageContext } from '../../contexts/PageContextContext';
import { detectSubscriptions } from '../../utils/subscriptions';
import { formatCurrency } from '../../utils/budgetAggregate';
import { buildSubscriptionsContext } from '../../utils/javiBuilders/subscriptions';

const CADENCE_LABEL = {
  weekly: 'Weekly',
  monthly: 'Monthly',
  yearly: 'Yearly',
};
const FOCUS =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-slate-slateBlueLight';
const TH = 'px-2 py-2 text-xs font-semibold text-slate-slate400';
const TH_L = `${TH} text-left`;
const TH_R = `${TH} text-right`;
const TD = 'px-2 py-2 align-top text-sm text-slate-slate200 tabular-nums';
// Shared by every table so the columns line up across sections (percentages sum to 100).
const COL_WIDTHS = ['w-[32%]', 'w-[12%]', 'w-[12%]', 'w-[14%]', 'w-[15%]', 'w-[15%]'];
// Tailwind's `sm` breakpoint: below it the rows render as a stacked list.
const NARROW_QUERY = '(max-width: 639px)';
const DOT = '·';

const readNarrow = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia(NARROW_QUERY).matches;

function useIsNarrow() {
  const [narrow, setNarrow] = useState(readNarrow);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const mql = window.matchMedia(NARROW_QUERY);
    const update = () => setNarrow(mql.matches);
    update();
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', update);
      return () => mql.removeEventListener('change', update);
    }
    mql.addListener?.(update);
    return () => mql.removeListener?.(update);
  }, []);
  return narrow;
}

function dateLabel(iso, { withYear = true } = {}) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
  });
}

const localIso = (now) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

/** What the "Next expected" column shows: a date, "Overdue", or "Stopped" for cancelled. */
function nextInfo(item, { cancelled }) {
  if (cancelled) return { text: 'Stopped', overdue: false };
  if (item.overdue) return { text: 'Overdue', overdue: true };
  return {
    text: dateLabel(item.nextExpected),
    overdue: false,
    iso: item.nextExpected,
  };
}

/** Secondary line: category, plus the typical amount when another row shares the name. */
const detailLine = (item, dupes) =>
  dupes.has(item.merchant)
    ? `${item.category} ${DOT} ${formatCurrency(item.typicalAmount)}`
    : item.category;

function Stat({ label, value }) {
  return (
    <div className="glass-subtle rounded-lg px-4 py-3">
      <p className="text-xs text-slate-slate400">{label}</p>
      <p className="mt-0.5 text-lg font-bold text-slate-slate100 tabular-nums">{value}</p>
    </div>
  );
}

function PriceBadge({ increase }) {
  if (!increase) return null;
  return (
    <span className="ml-2 inline-block whitespace-nowrap rounded-full bg-accent-yellow/15 px-2 py-0.5 text-xs font-semibold text-accent-yellow">
      Up {increase.pct}% ({formatCurrency(increase.from)} to {formatCurrency(increase.to)})
    </span>
  );
}

function NextCell({ info }) {
  return info.overdue ? (
    <span className="text-xs font-semibold text-accent-amber">{info.text}</span>
  ) : (
    info.text
  );
}

function SubscriptionTable({ items, label, cancelled, dupes }) {
  return (
    <div className={`overflow-x-auto ${FOCUS}`} tabIndex={0} role="region" aria-label={label}>
      <table className="w-full min-w-[640px] table-fixed border-collapse">
        <caption className="sr-only">{label}</caption>
        <colgroup>
          {COL_WIDTHS.map((w, i) => (
            // Widths repeat, so the column position is the stable key.
            <col key={i} className={w} />
          ))}
        </colgroup>
        <thead>
          <tr className="border-b border-slate-slate700">
            <th scope="col" className={TH_L}>
              Merchant
            </th>
            <th scope="col" className={TH_L}>
              Cadence
            </th>
            <th scope="col" className={TH_R}>
              Typical
            </th>
            <th scope="col" className={TH_R}>
              Monthly equiv.
            </th>
            <th scope="col" className={`${TH_L} pl-6`}>
              Last charge
            </th>
            <th scope="col" className={TH_L}>
              Next expected
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} className="border-b border-slate-slate800 last:border-0">
              <th
                scope="row"
                className="px-2 py-2 text-left align-top text-sm font-normal text-slate-slate100"
              >
                <span className="font-semibold">{item.merchant}</span>
                <PriceBadge increase={item.priceIncrease} />
                <span className="block text-xs text-slate-slate400">{detailLine(item, dupes)}</span>
              </th>
              <td className={TD}>
                <span className="inline-block rounded-full bg-slate-slate800 px-2 py-0.5 text-xs font-semibold text-slate-slate300">
                  {CADENCE_LABEL[item.cadence]}
                </span>
              </td>
              <td className={`${TD} text-right`}>{formatCurrency(item.typicalAmount)}</td>
              <td className={`${TD} text-right`}>{formatCurrency(item.monthlyEquivalent)}</td>
              <td className={`${TD} pl-6`}>{dateLabel(item.lastCharge)}</td>
              <td className={TD}>
                <NextCell info={nextInfo(item, { cancelled })} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Below sm the six columns do not fit: one stacked, labelled list item per charge.
function SubscriptionList({ items, label, cancelled, todayIso, dupes }) {
  const thisYear = todayIso.slice(0, 4);
  return (
    <ul aria-label={label} className="divide-y divide-slate-slate800">
      {items.map((item) => {
        const info = nextInfo(item, { cancelled });
        const nextText = info.iso
          ? `next ${dateLabel(info.iso, { withYear: info.iso.slice(0, 4) !== thisYear })}`
          : info.text;
        return (
          <li key={item.id} className="py-2">
            <p className="text-sm text-slate-slate100">
              <span className="font-semibold">{item.merchant}</span>
              <PriceBadge increase={item.priceIncrease} />
            </p>
            <p className="mt-0.5 text-xs text-slate-slate300 tabular-nums">
              {`${CADENCE_LABEL[item.cadence]} ${DOT} ${formatCurrency(item.typicalAmount)} ${DOT} `}
              <span className={info.overdue ? 'font-semibold text-accent-amber' : undefined}>
                {nextText}
              </span>
            </p>
            <p className="text-xs text-slate-slate400">{detailLine(item, dupes)}</p>
          </li>
        );
      })}
    </ul>
  );
}

function ItemsView({ narrow, ...props }) {
  return narrow ? <SubscriptionList {...props} /> : <SubscriptionTable {...props} />;
}

export default function SubscriptionsView() {
  const { records, loading, fetchFailed } = useRecords();
  const result = useMemo(() => detectSubscriptions(records), [records]);
  const narrow = useIsNarrow();
  usePageContext('subscriptions', () =>
    buildSubscriptionsContext({ result, loading, error: fetchFailed }),
    result.items.length > 0 && result,
  );

  if (loading) {
    return (
      <div className="space-y-4" role="status" aria-busy="true" aria-label="Loading subscriptions">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const todayIso = localIso(new Date());
  const isBill = (i) => i.kind === 'bill';
  const subscriptions = result.items.filter((i) => !isBill(i));
  const activeSubs = subscriptions.filter((i) => i.active);
  const activeBills = result.items.filter((i) => isBill(i) && i.active);
  const inactive = result.items.filter((i) => !i.active);
  const counts = new Map();
  for (const i of result.items) counts.set(i.merchant, (counts.get(i.merchant) ?? 0) + 1);
  const dupes = new Set([...counts].filter(([, n]) => n > 1).map(([name]) => name));
  const shared = { narrow, todayIso, dupes };

  return (
    <SectionCard title="Subscriptions" variant="dense" icon={Repeat}>
      {fetchFailed ? (
        <p role="alert" className="text-sm text-accent-red">
          Couldn't load transactions.
        </p>
      ) : result.items.length === 0 ? (
        <p className="text-sm text-slate-slate400">
          No recurring charges found yet. Subscriptions show up after 4 weekly, 3 monthly, or 2
          yearly charges from the same merchant.
        </p>
      ) : (
        <div className="space-y-4">
          {subscriptions.length === 0 ? (
            <p className="text-sm text-slate-slate400">
              No subscriptions found yet. Only recurring bills were detected, listed below.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Stat label="Monthly total" value={formatCurrency(result.monthlyTotal)} />
                <Stat label="Yearly total" value={formatCurrency(result.yearlyTotal)} />
                <Stat label="Active subscriptions" value={result.activeCount} />
              </div>
              {activeSubs.length > 0 ? (
                <section className="space-y-2" aria-labelledby="active-subscriptions-heading">
                  <h3
                    id="active-subscriptions-heading"
                    className="text-sm font-semibold text-slate-slate200"
                  >
                    Subscriptions
                  </h3>
                  <ItemsView {...shared} items={activeSubs} label="Active subscriptions" />
                </section>
              ) : (
                <p className="text-sm text-slate-slate400">No active subscriptions</p>
              )}
            </>
          )}
          {activeBills.length > 0 && (
            <section className="space-y-2" aria-labelledby="recurring-bills-heading">
              <h3
                id="recurring-bills-heading"
                className="text-sm font-semibold text-slate-slate200"
              >
                Recurring bills
              </h3>
              <p className="text-sm text-slate-slate300 tabular-nums">
                Bills: {formatCurrency(result.billsMonthlyTotal)}/mo
              </p>
              <ItemsView {...shared} items={activeBills} label="Active recurring bills" />
            </section>
          )}
          {inactive.length > 0 && (
            <details>
              <summary
                className={`cursor-pointer rounded text-sm font-semibold text-slate-slate300 hover:text-slate-slate100 ${FOCUS}`}
              >
                Possibly cancelled ({inactive.length})
              </summary>
              <div className="mt-2">
                <ItemsView
                  {...shared}
                  items={inactive}
                  cancelled
                  label="Possibly cancelled recurring charges"
                />
              </div>
            </details>
          )}
        </div>
      )}
    </SectionCard>
  );
}
