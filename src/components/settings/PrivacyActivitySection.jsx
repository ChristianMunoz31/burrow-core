import { Suspense, lazy, useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ShieldCheck } from 'lucide-react';
import SectionCard from '../shared/SectionCard';
import { ListSkeleton } from '../shared/Skeleton';
import { SHOW_NETWORK_ACTIVITY_EVENT, sectionProps } from './settingsSections';
import { BTN, PILL, TONE_CLASS } from './pillStyles';
import { useAuditLog } from '../../hooks/useAuditLog';
import { featureLabel } from '../../constants/auditFeatures';
import { categoryLabels, joinList } from '../../utils/cloudLabels';

const NetworkActivityPanel = lazy(() => import('./NetworkActivityPanel'));
const VerifyYourself = lazy(() => import('./VerifyYourself'));

const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:[outline-color:var(--focus-ring)]';
const DIVIDER_COLOR = 'border-[color:var(--glass-border)]';
const NOTICE_BOX = 'rounded-lg bg-accent-amber/15 p-3 text-sm text-accent-amber';

// Mirror AUDIT_RETENTION_DAYS and AUDIT_MAX_ROWS in server/audit.js; keep them in sync.
const RETENTION_DAYS = 90;
const MAX_ROWS = 5000;

const UNAVAILABLE_TEXT = {
  not_configured: "Burrow can't open your data file. Try restarting Burrow.",
};

/** Local time for a row; the year is added when it is not the current year. Null when invalid. */
const formatTime = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const options = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  if (d.getFullYear() !== new Date().getFullYear()) options.year = 'numeric';
  return { short: d.toLocaleString([], options), full: d.toLocaleString() };
};

/** "Sent to host. Shared: a and b. Not shared: c." for a row whose request went to cloud AI. */
function cloudSummary(meta) {
  if (meta?.ai_kind !== 'cloud') return null;
  const host = typeof meta.ai_host === 'string' && meta.ai_host ? meta.ai_host : 'your cloud provider';
  const shared = categoryLabels(meta.shared);
  const withheld = categoryLabels(meta.withheld);
  return `Sent to ${host}. Shared: ${shared.length ? joinList(shared) : 'nothing'}. Not shared: ${withheld.length ? joinList(withheld) : 'nothing'}.`;
}

function AuditRow({ entry }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const label = featureLabel(entry.feature);
  const time = formatTime(entry.createdAt);
  const rowName = `${label}, ${time?.short ?? 'unknown time'}`;
  const cloudNote = cloudSummary(entry.meta);
  const model = [entry.provider, entry.model].filter(Boolean).join(' / ');
  const isOk = entry.status === 'ok';
  const isSignIn = entry.kind === 'auth' && entry.feature === 'sign_in';
  const attempts = Number(isOk ? entry.meta?.failed_attempts_before : entry.meta?.attempts);
  const plural = attempts === 1 ? 'attempt' : 'attempts';
  let attemptsNote = null;
  if (isSignIn && Number.isInteger(attempts) && attempts > 0) {
    attemptsNote = isOk ? `after ${attempts} failed ${plural}` : `${attempts} ${plural}`;
  }
  return (
    <li className={`border-t ${DIVIDER_COLOR} py-2`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {time && (
          <time dateTime={entry.createdAt} title={time.full} className="text-xs text-slate-slate400">
            {time.short}
          </time>
        )}
        <span className="min-w-0 break-words text-sm font-semibold text-slate-slate100">{label}</span>
        <span className={`${PILL} ${TONE_CLASS.muted} max-w-full self-center break-all`}>{entry.feature === 'network_call' ? 'network' : entry.kind}</span>
        {model && <span className="min-w-0 break-all text-xs text-slate-slate400">{model}</span>}
        <span className={`${PILL} ${isOk ? TONE_CLASS.ok : TONE_CLASS.warn} self-center`}>{isOk ? 'ok' : 'error'}</span>
        {attemptsNote && <span className="text-xs text-slate-slate400">{attemptsNote}</span>}
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={rowName}
          onClick={() => setOpen((prev) => !prev)}
          className={`ml-auto inline-flex min-h-9 min-w-9 items-center justify-center rounded-md text-slate-slate400 hover:text-slate-slate100 ${FOCUS_RING}`}
        >
          <ChevronDown
            size={16}
            aria-hidden="true"
            className={`motion-safe:transition-transform ${open ? '' : '-rotate-90'}`}
          />
        </button>
      </div>
      {cloudNote && <p className="mt-1 break-words text-xs text-slate-slate300">{cloudNote}</p>}
      <div id={panelId} hidden={!open}>
        {open && (
          <pre
            tabIndex={0}
            role="region"
            aria-label={`Context for ${rowName}`}
            className="glass-subtle mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md p-2 text-xs text-slate-slate300"
          >
            {entry.context ?? 'No context stored'}
          </pre>
        )}
      </div>
    </li>
  );
}

/** Two disclosure buttons; the panels load on first open so Settings stays light. */
function TrustPanels() {
  const [open, setOpen] = useState(null);
  const networkId = useId();
  const verifyId = useId();
  const networkButtonRef = useRef(null);
  const toggle = (name) => setOpen((prev) => (prev === name ? null : name));

  // "See network activity" in the Network section opens this panel, scrolls to it and focuses its button.
  useEffect(() => {
    const show = () => {
      setOpen('network');
      requestAnimationFrame(() => {
        networkButtonRef.current?.scrollIntoView?.({ block: 'center' });
        networkButtonRef.current?.focus();
      });
    };
    window.addEventListener(SHOW_NETWORK_ACTIVITY_EVENT, show);
    return () => window.removeEventListener(SHOW_NETWORK_ACTIVITY_EVENT, show);
  }, []);

  const button = (name, label, panelId, ref) => (
    <button
      ref={ref}
      type="button"
      aria-expanded={open === name}
      aria-controls={panelId}
      onClick={() => toggle(name)}
      className={BTN}
    >
      {label}
    </button>
  );
  return (
    <div className="mb-4">
      <div className="flex flex-wrap gap-2">
        {button('network', 'Network activity', networkId, networkButtonRef)}
        {button('verify', 'Verify it yourself', verifyId)}
      </div>
      <div id={networkId} hidden={open !== 'network'} className="mt-3">
        {open === 'network' && (
          <Suspense fallback={<ListSkeleton rows={3} />}>
            <NetworkActivityPanel />
          </Suspense>
        )}
      </div>
      <div id={verifyId} hidden={open !== 'verify'} className="mt-3">
        {open === 'verify' && (
          <Suspense fallback={<ListSkeleton rows={3} />}>
            <VerifyYourself />
          </Suspense>
        )}
      </div>
    </div>
  );
}

/** Screen-reader announcement for completed refreshes and next-page loads (never the first load). */
function useAnnouncement({ dataUpdatedAt, count, firstId }) {
  const [message, setMessage] = useState('');
  const seen = useRef(null);
  useEffect(() => {
    if (!dataUpdatedAt) return;
    const prev = seen.current;
    seen.current = { dataUpdatedAt, count, firstId };
    if (prev === null || prev.dataUpdatedAt === dataUpdatedAt) return;
    const added = count - prev.count;
    if (added > 0 && firstId === prev.firstId) {
      setMessage(`Loaded ${added} more ${added === 1 ? 'entry' : 'entries'}`);
    } else {
      setMessage('Activity refreshed');
    }
  }, [dataUpdatedAt, count, firstId]);
  return message;
}

export default function PrivacyActivitySection() {
  const {
    entries,
    available,
    reason,
    isLoading,
    isFetching,
    isFetchingNextPage,
    isFetchNextPageError,
    dataUpdatedAt,
    hasNextPage,
    error,
    fetchNextPage,
    refresh,
  } = useAuditLog();
  const announcement = useAnnouncement({ dataUpdatedAt, count: entries.length, firstId: entries[0]?.id ?? null });

  const refreshButton = (
    <button
      type="button"
      onClick={() => {
        if (!isFetching) refresh();
      }}
      aria-disabled={isFetching}
      aria-busy={isFetching}
      className={BTN}
    >
      {isFetching && !isFetchingNextPage ? 'Refreshing…' : 'Refresh'}
    </button>
  );

  let body;
  if (isLoading) {
    body = (
      <ListSkeleton rows={4} label="Loading activity" />
    );
  } else if (error && entries.length === 0) {
    body = (
      <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-accent-amber">
        <span>Couldn&apos;t load activity.</span>
        <button type="button" onClick={() => refresh()} className={BTN}>
          Retry
        </button>
      </div>
    );
  } else if (available === false) {
    body = (
      <div role="status" className={NOTICE_BOX}>
        <p className="font-semibold">{UNAVAILABLE_TEXT[reason] ?? "Activity log isn't available right now."}</p>
      </div>
    );
  } else if (entries.length === 0) {
    body = <p className="text-sm text-slate-slate400">No activity recorded yet.</p>;
  } else {
    body = (
      <>
        <ul role="list" aria-label="Recent activity">
          {entries.map((entry) => (
            <AuditRow key={entry.id} entry={entry} />
          ))}
        </ul>
        {error && (
          <div role="alert" className="mt-3 flex flex-wrap items-center gap-3 text-sm text-accent-amber">
            <span>Couldn&apos;t load activity.</span>
            <button
              type="button"
              onClick={() => (isFetchNextPageError ? fetchNextPage() : refresh())}
              className={BTN}
            >
              Retry
            </button>
          </div>
        )}
        {hasNextPage && (
          <div className="mt-3 flex justify-center">
            <button
              type="button"
              onClick={() => {
                if (!isFetchingNextPage) fetchNextPage();
              }}
              aria-disabled={isFetchingNextPage}
              aria-busy={isFetchingNextPage}
              className={BTN}
            >
              {isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </>
    );
  }

  return (
    <SectionCard
      {...sectionProps('privacy')}
      title="Privacy & activity"
      subtitle={`AI requests, exports, sign-ins and internet connections from the last ${RETENTION_DAYS} days (max ${MAX_ROWS.toLocaleString('en-US')}). Known key and token formats are removed before storage.`}
      icon={ShieldCheck}
      action={refreshButton}
    >
      <p role="status" className="sr-only">
        {announcement}
      </p>
      <TrustPanels />
      {body}
    </SectionCard>
  );
}
