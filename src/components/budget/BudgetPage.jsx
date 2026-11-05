import { useMemo, useState } from 'react';
import {
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
  useMatch,
  useNavigationType,
  useSearchParams,
} from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import SectionCard from '../shared/SectionCard';
import LoadError from '../shared/LoadError';
import { IconButton } from '../shared/ItemActions';
import { Skeleton } from '../shared/Skeleton';
import { useBudgetData } from '../../hooks/useBudgetData';
import { formatMonthLong, listMonths } from '../../utils/budgetAggregate';
import BudgetDashboard from './BudgetDashboard';
import BudgetPlanner from './BudgetPlanner';
import SubscriptionsView from './SubscriptionsView';
import { budgetMonths, latestDataMonth, selectMonth } from '../../utils/budgetPlan';
import { useSyncedSetting } from '../../hooks/useSyncedSetting';
import {
  SETTINGS_DEFAULTS,
  SETTINGS_KEYS,
  normalizeBudgetMonthMode,
  normalizeBudgetView,
} from '../../constants/settingsDefaults';

function MonthSelector({ months, options, value, onChange }) {
  const idx = months.indexOf(value);
  const canPrev = idx > 0;
  const canNext = idx >= 0 && idx < months.length - 1;
  const btn = 'aria-disabled:cursor-not-allowed aria-disabled:opacity-30';
  return (
    <div className="flex items-center justify-center gap-3 mb-5">
      <IconButton
        label="Previous month"
        icon={ChevronLeft}
        className={btn}
        aria-disabled={!canPrev}
        onClick={() => canPrev && onChange(months[idx - 1])}
      />
      <select
        aria-label="Budget month"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="glass-input min-w-44 cursor-pointer rounded-md px-2 py-1 text-base font-bold text-slate-slate100 tabular-nums focus-visible:outline focus-visible:outline-2 focus-visible:outline-slate-slateBlueLight"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <IconButton
        label="Next month"
        icon={ChevronRight}
        className={btn}
        aria-disabled={!canNext}
        onClick={() => canNext && onChange(months[idx + 1])}
      />
    </div>
  );
}

const VIEW_LINK =
  'rounded px-3 py-1 text-sm font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-slateBlueLight';

function ViewSwitcher({ search }) {
  const cls = ({ isActive }) =>
    `${VIEW_LINK} ${
      isActive
        ? 'bg-slate-slateBlue text-white'
        : 'text-slate-slate300 hover:text-slate-slate100'
    }`;
  return (
    <nav aria-label="Budget views" className="mb-4 flex justify-center">
      <div className="glass-subtle inline-flex rounded-lg p-0.5">
        <NavLink to={{ pathname: '/budget', search }} end className={cls}>
          Dashboard
        </NavLink>
        <NavLink to={{ pathname: '/budget/planner', search }} className={cls}>
          Planner
        </NavLink>
        <NavLink to={{ pathname: '/budget/subscriptions', search }} className={cls}>
          Subscriptions
        </NavLink>
      </div>
    </nav>
  );
}

export default function BudgetPage() {
  const { summary, categories, trend, source, loading, refresh } = useBudgetData();
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    setRetrying(true);
    try {
      await refresh?.();
    } finally {
      setRetrying(false);
    }
  };
  const location = useLocation();
  const onPlanner = useMatch('/budget/planner') !== null;
  const onSubscriptions = useMatch('/budget/subscriptions') !== null;
  const [searchParams, setSearchParams] = useSearchParams();
  const navigationType = useNavigationType();
  const [storedView, , viewMeta] = useSyncedSetting(
    SETTINGS_KEYS.budgetView,
    SETTINGS_DEFAULTS.budgetView,
  );
  const [storedMonthMode] = useSyncedSetting(
    SETTINGS_KEYS.budgetMonth,
    SETTINGS_DEFAULTS.budgetMonth,
  );
  const defaultView = normalizeBudgetView(storedView);
  const monthMode = normalizeBudgetMonthMode(storedMonthMode);

  // Default view applies once, on entering the module at /budget. The entry
  // location key is captured on mount: this component stays mounted across the
  // Dashboard/Planner tabs, and every later navigation gets a new key, so tab
  // clicks (or a server value that arrives late) are never redirected. A POP
  // entry with a non-initial key is browser Back/Forward into /budget, which
  // must not bounce the user away from the Dashboard they navigated back to.
  const [entry] = useState(() => ({
    key: location.key,
    skip: navigationType === 'POP' && location.key !== 'default',
  }));
  // Wait for the synced value so a fresh device honors the server setting. A
  // missing meta (older callers, test mocks) counts as already fetched.
  const viewKnown = viewMeta?.isFetched ?? true;
  const redirectToPlanner =
    viewKnown && !entry.skip && location.key === entry.key && defaultView === 'planner';

  // Months with actual data set where the selectable range starts. The default
  // selection is the current month (see selectMonth).
  const dataMonths = useMemo(
    () => listMonths(summary, categories, trend),
    [summary, categories, trend],
  );
  // Contiguous range from the earliest data month (or now) through current + 12,
  // so every month is selectable and plannable even without transactions.
  const months = useMemo(() => budgetMonths(dataMonths), [dataMonths]);
  const monthOptions = useMemo(
    () => months.map((m) => ({ value: m, label: formatMonthLong(m) })),
    [months],
  );
  // The user's pick lives in the URL (?month=YYYY-MM) so both views share it and
  // it survives reloads; when unset or no longer in range, show the current
  // month (else the first month in range).
  // Derived rather than stored to avoid setState-in-effect.
  const picked = searchParams.get('month') ?? '';
  const preferredMonth = monthMode === 'latest' ? latestDataMonth(dataMonths, months) : '';
  const month = selectMonth(months, picked, new Date(), preferredMonth);
  const setPicked = (value) => {
    const next = new URLSearchParams(searchParams);
    next.set('month', value);
    setSearchParams(next, { replace: true });
  };

  // The Subscriptions view owns its loading/error states and reads its own data.
  const budgetChrome = !onSubscriptions;

  if (loading && budgetChrome) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48 mx-auto" />
        <Skeleton className="h-28 w-full" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Skeleton className="h-80 lg:col-span-2" />
          <Skeleton className="h-80" />
        </div>
      </div>
    );
  }

  return (
    <div>
      {budgetChrome && source === 'error' ? (
        <div className="mb-4">
          <LoadError thing="transactions" onRetry={retry} retrying={retrying} />
        </div>
      ) : (
        budgetChrome &&
        source === 'sample' && (
          <p className="mb-4 text-xs text-accent-yellow">
            Showing sample data until you import transactions. Click Import transactions above to
            see your real budget numbers here.
          </p>
        )
      )}

      {/* Focus stays on the activated link; announce the view change instead. */}
      <p className="sr-only" aria-live="polite">
        {onSubscriptions ? 'Subscriptions view' : onPlanner ? 'Planner view' : 'Dashboard view'}
      </p>

      <ViewSwitcher search={location.search} />

      {!onSubscriptions && (
        <MonthSelector months={months} options={monthOptions} value={month} onChange={setPicked} />
      )}

      <Routes>
        <Route
          index
          element={
            redirectToPlanner ? (
              // Rendered in place of the Dashboard so it doesn't commit first when
              // the setting is already known (cached). A server value that lands
              // later, before any navigation, can still redirect from the Dashboard.
              <Navigate to={{ pathname: '/budget/planner', search: location.search }} replace />
            ) : (
              <BudgetDashboard
                month={month}
                summary={summary}
                categories={categories}
                trend={trend}
                source={source}
              />
            )
          }
        />
        <Route
          path="planner"
          element={
            <SectionCard title="Budget planner" variant="dense">
              <BudgetPlanner month={month} categories={categories} source={source} />
            </SectionCard>
          }
        />
        <Route path="subscriptions" element={<SubscriptionsView />} />
        <Route
          path="*"
          element={<Navigate to={{ pathname: '/budget', search: location.search }} replace />}
        />
      </Routes>
    </div>
  );
}
