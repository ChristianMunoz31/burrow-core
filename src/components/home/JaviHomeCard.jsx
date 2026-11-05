import { Suspense, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, Sparkles } from 'lucide-react';
import { WidgetSkeleton } from '../shared/Skeleton';
import JaviMessage from '../javi/JaviMessage';
import {
  AdviceErrorRow,
  ThinkingSkeleton,
  TimelineMessage,
} from '../javi/adviceParts';
import { BriefingMessage } from '../../extensions/proExtensions';
import { usePageContextReader } from '../../contexts/PageContextContext';
import { useJaviSession } from '../../hooks/useJaviSession';
import { useJarvisStatus } from '../../hooks/useJarvisStatus';
import { isBriefingToday, useBriefing } from '../../hooks/useBriefing';
import { useNetworkFeature } from '../../hooks/useNetworkFeature';
import { useWeather } from '../../hooks/useWeather';
import { isAiUnavailableError } from '../../utils/apiError';

const PAGE = 'home';
const LINK_CLASS =
  'text-xs text-slate-slate400 underline underline-offset-2 hover:text-slate-slate100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:[outline-color:var(--focus-ring)]';
const REFRESH_BTN =
  'flex h-6 w-6 items-center justify-center rounded-full text-slate-slate400 hover:bg-slate-slate700/50 hover:text-slate-slate100 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:[outline-color:var(--focus-ring)]';

function ShowWeatherLink() {
  return (
    <Link to={{ pathname: '/settings', hash: '#network' }} className={LINK_CLASS}>
      Show weather
    </Link>
  );
}

// When Weather is on and loaded, the weather update is integrated directly into Javi's generated daily insight.
// This slot shows only when weather is off (quiet opt-in link) or has a location/network error.
function WeatherSlot() {
  const { settingsLoading, offError } = useNetworkFeature('weather');
  const { loading, error } = useWeather();
  if (settingsLoading) return null;
  if (offError) {
    return (
      <section aria-label="Weather" className="mt-2.5 pt-2 border-t border-slate-slate700/50">
        <ShowWeatherLink />
      </section>
    );
  }
  if (loading) return null;
  if (error?.locationMissing) {
    return (
      <section aria-label="Weather" className="mt-2.5 pt-2 border-t border-slate-slate700/50">
        <p role="status" className="text-xs text-slate-slate400">
          <Link to={{ pathname: '/settings', hash: '#network' }} className={LINK_CLASS}>
            Set your location in Settings to see the weather.
          </Link>
        </p>
      </section>
    );
  }
  if (error) {
    return (
      <section aria-label="Weather" className="mt-2.5 pt-2 border-t border-slate-slate700/50">
        <p role="status" className="text-xs text-slate-slate400">
          Burrow couldn&apos;t load the weather. It tries again the next time you open Home.
        </p>
      </section>
    );
  }
  return null;
}

/** One page insight for Home, provided automatically on load without prompting, through the advice session. */
function HomeInsight({ thread, retry, loading, unavailable }) {
  if (unavailable) {
    return (
      <AdviceErrorRow
        error={{ message: unavailable.message, code: unavailable.code, reason: unavailable.reason }}
        canRetry={false}
        onRetry={() => {}}
      />
    );
  }
  const reply = thread.messages.findLast((m) => m.role === 'assistant') ?? null;

  return (
    <div className="space-y-2">
      {loading && (thread.partial ? <JaviMessage role="assistant" content={thread.partial} /> : <ThinkingSkeleton />)}
      {!loading && reply && (
        <TimelineMessage
          message={reply}
          showSource
        />
      )}
      {!loading && !reply && !thread.error && <ThinkingSkeleton />}
      {thread.error && (
        <AdviceErrorRow
          error={thread.error}
          canRetry={Boolean(thread.lastRequestMessages)}
          onRetry={() => retry(PAGE)}
          busy={loading}
        />
      )}
    </div>
  );
}

/**
 * The Javi card, first on Home. Javi provides an overall daily insight opening with a time-appropriate greeting
 * addressed to the user without prompting. Sized with a scrollable container so the card does not expand as text streams in.
 * Brief weather is integrated directly into Javi's overview insight message while the Weather opt-in is on.
 * Home has no Javi bar, so this card marks today's briefing read where it renders, but not while it is shown
 * dimmed as a hidden card in Customize (`dimmed`).
 */
export default function JaviHomeCard({ dimmed = false }) {
  const titleId = useId();
  const [live, setLive] = useState('');
  const { briefing, loading: briefingLoading } = useBriefing();
  const showBriefing = BriefingMessage !== null && isBriefingToday(briefing);
  const briefingAt = showBriefing && !dimmed ? briefing.generatedAt : null;
  useEffect(() => {
    if (briefingAt) window.dispatchEvent(new CustomEvent('javi:inbox-read', { detail: ['briefing'] }));
  }, [briefingAt]);

  const { readPageContext } = usePageContextReader();
  // The insight is automatic, so it must not call POST /api/jarvis/advice before AI can answer: the server
  // refuses with a 503 and the browser logs every non-2xx fetch as a console error. GET /api/jarvis/status
  // always answers 200 and says whether Javi can run; a status that cannot be read lets the request go ahead.
  const { status: aiStatus, loading: aiStatusLoading } = useJarvisStatus();
  const ai = aiStatus?.ai ?? null;
  const aiUnavailable = aiStatus?.available === false && isAiUnavailableError(aiStatus);
  const { threadFor, requestAdvice, retry } = useJaviSession({ readPageContext, ai });
  const thread = threadFor(PAGE);
  const loading = thread.status === 'loading';
  const reply = thread.messages.findLast((m) => m.role === 'assistant') ?? null;
  const { loading: weatherLoading } = useWeather();

  const requestedRef = useRef(false);
  useEffect(() => {
    if (dimmed || requestedRef.current || showBriefing || briefingLoading) return;
    if (aiStatusLoading || aiUnavailable) return;
    if (thread.status !== 'idle' || thread.messages.length > 0 || thread.error) return;
    if (weatherLoading) return;
    requestedRef.current = true;
    requestAdvice(PAGE);
  }, [dimmed, requestAdvice, aiStatusLoading, aiUnavailable, thread.status, thread.messages.length, thread.error, showBriefing, briefingLoading, weatherLoading]);

  const liveText = showBriefing
    ? live
    : loading
      ? 'Javi is thinking'
      : reply && !reply.blocked
        ? 'Javi replied.'
        : '';

  const showRefresh = !showBriefing && !briefingLoading;

  return (
    <section aria-labelledby={titleId} className="glass rounded-2xl p-5 h-full min-h-[150px] flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles size={14} className="text-accent-indigo" aria-hidden="true" />
          <h3 id={titleId} className="text-[10px] font-semibold uppercase tracking-widest text-slate-slate400">
            Javi
          </h3>
        </div>
        {showRefresh && (
          <button
            type="button"
            onClick={() => requestAdvice(PAGE, true)}
            disabled={loading || dimmed || aiUnavailable}
            aria-label="Refresh insight"
            title="Refresh insight"
            className={REFRESH_BTN}
          >
            <RefreshCw size={13} aria-hidden="true" />
          </button>
        )}
      </div>
      <p role="status" className="sr-only">
        {liveText}
      </p>
      <div className="flex-1 min-h-[8.5rem] max-h-52 overflow-y-auto pr-1">
        {briefingLoading ? (
          <WidgetSkeleton />
        ) : showBriefing ? (
          <Suspense fallback={null}>
            <BriefingMessage announce={setLive} />
          </Suspense>
        ) : (
          <HomeInsight thread={thread} retry={retry} loading={loading} unavailable={aiUnavailable ? aiStatus : null} />
        )}
      </div>
      <WeatherSlot />
    </section>
  );
}
