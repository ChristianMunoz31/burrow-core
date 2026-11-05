// Pieces shared by the Javi window (JaviPanel) and the Javi card on Home (JaviHomeCard): reply bubbles with their
// source badge, Report link and notices, the thinking skeleton, and the advice error row. Kept
// out of JaviPanel so Home does not load the whole window.
import { useEffect, useState } from 'react';
import { Skeleton } from '../shared/Skeleton';
import AiUnavailable from '../shared/AiUnavailable';
import JaviMessage from './JaviMessage';
import ReportLink from './ReportLink';
import AiSourceBadge from './AiSourceBadge';
import WithheldNotice from './WithheldNotice';
import { errorWaitMs } from './retryWait';
import { isAiUnavailableError } from '../../utils/apiError';

// Shared by the strip rows, the suggestion chips and the Import transactions button.
export const SUGGEST_BTN =
  'glass-javi-suggest rounded-full px-3 py-1.5 text-sm text-slate-slate300 hover:text-slate-slate100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:[outline-color:var(--focus-ring)]';

export const RETRY_BTN =
  'shrink-0 rounded-md px-3 py-1.5 text-slate-slate200 hover:bg-slate-slate700/60 hover:text-slate-slate100 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:[outline-color:var(--focus-ring)]';

export const ERROR_ROW = 'glass-javi-chip flex items-center gap-2 rounded-xl px-3 py-2 text-xs text-accent-red';

// The Get insight button in the greeting (the Javi window and the Javi card on Home).
export const INSIGHT_BTN =
  'rounded-md border border-accent-purple/40 bg-accent-purple/10 px-3 py-1.5 text-sm text-accent-purple hover:bg-accent-purple/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:[outline-color:var(--focus-ring)]';

// Code text in Javi's panel (greeting, no briefing yet): no tail, no Report link, never announced as a reply.
export const GREETING = 'glass-javi-chip rounded-2xl px-3.5 py-2.5 text-sm text-slate-slate200';

export function ThinkingSkeleton() {
  return (
    <div aria-hidden="true" className="glass-javi-inner w-5/6 space-y-2 rounded-lg px-3 py-3">
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-5/6" />
      <Skeleton className="h-3 w-2/3" />
    </div>
  );
}

// The notice is a string on advice replies and { message, categories } on chat replies.
const noticeText = (notice) => (typeof notice === 'string' ? notice : notice?.message || null);

// One reply or question. A blocked advice reply is a notice (nothing was sent anywhere), never
// an error. A cloud reply carries a small badge so the user can see where it was computed.
// `showSource` (the Javi card on Home, which has no header badge) labels every reply with where it was computed.
// `action` (the Home card's icon-only Refresh) sits at the end of the source and Report row.
// `actions` false (the briefing) renders bullets as plain observations, not action rows.
export function TimelineMessage({ message, reportLabel, showSource = false, action = null, actions = true }) {
  const isAssistant = message.role === 'assistant';
  const notice = isAssistant ? noticeText(message.notice) : null;
  if (isAssistant && message.blocked) {
    return (
      <div>
        <WithheldNotice message={notice ?? message.content} />
        {action && <div className="mt-1 flex justify-end">{action}</div>}
      </div>
    );
  }
  return (
    <div>
      <JaviMessage role={message.role} content={message.content} actions={actions} />
      {isAssistant && (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {(showSource || message.ai?.kind === 'cloud') && <AiSourceBadge ai={message.ai} />}
          <ReportLink label={reportLabel} />
          {action && <span className="ml-auto flex">{action}</span>}
        </div>
      )}
      {notice && <WithheldNotice message={notice} className="mt-1.5" />}
    </div>
  );
}

// Ticks once a second only while a retry-after window is open so the Retry button re-enables.
function useRetryWait(error) {
  const [now, setNow] = useState(() => Date.now());
  // `now` can predate the error (state is only refreshed by the tick), so clamp it.
  const waitMs = error ? errorWaitMs(error, Math.max(now, error.at ?? 0)) : 0;
  const waiting = waitMs > 0;
  useEffect(() => {
    if (!error || !waiting) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [error, waiting]);
  return waitMs;
}

/**
 * The error row under a page insight: the AI setup notice when Javi cannot run, else the fixed message, and Retry
 * while the last request can be resent (counting down a rate-limit wait).
 * @param {{ error: { message: string, code: string, reason?: string | null, at?: number }, canRetry: boolean,
 *   onRetry: () => void, busy?: boolean, unavailable?: boolean }} props
 */
export function AdviceErrorRow({ error, canRetry, onRetry, busy = false, unavailable = isAiUnavailableError(error) }) {
  const waitMs = useRetryWait(error);
  return (
    <div className={ERROR_ROW}>
      {unavailable ? (
        <AiUnavailable message={error.message} code={error.code} reason={error.reason} className="min-w-0 flex-1 text-xs text-slate-slate300" />
      ) : (
        <span role="alert" className="min-w-0 flex-1">
          {error.message}
        </span>
      )}
      {canRetry && (
        <button type="button" onClick={onRetry} disabled={busy || waitMs > 0} className={RETRY_BTN}>
          {waitMs > 0 ? `Try again in ${Math.ceil(waitMs / 1000)}s` : 'Retry'}
        </button>
      )}
    </div>
  );
}
