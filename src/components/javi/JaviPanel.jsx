import { Suspense, useEffect, useId, useMemo, useRef, useState } from 'react';
import { CheckSquare, ChevronUp, Loader2, MessageSquarePlus, RefreshCw, Sparkles, X } from 'lucide-react';
import JaviMessage from './JaviMessage';
import AiSourceBadge from './AiSourceBadge';
import CloudHint from './CloudHint';
import {
  AdviceErrorRow,
  ERROR_ROW,
  GREETING,
  INSIGHT_BTN,
  SUGGEST_BTN,
  ThinkingSkeleton,
  TimelineMessage,
} from './adviceParts';
import { EMPTY_AGENT, buildTimeline } from './timeline';
import {
  AGENT_UNREACHABLE_MESSAGE,
  ConfirmActionCard,
  JaviComposer,
  PRO_UI_INCLUDED,
  agentToolLabel,
} from '../../extensions/proExtensions';
import { useJarvisStatus } from '../../hooks/useJarvisStatus';
import AiUnavailable from '../shared/AiUnavailable';
import { isAiUnavailableError } from '../../utils/apiError';
import NotIncludedNotice from '../shared/NotIncludedNotice';
import { stripDashes } from '../../utils/javiDashes';
import { openTransactionImport } from '../budget/openTransactionImport';

// The message window: docked to the bottom edge at the Javi bar's right edge, so the bar seems to grow upward. Fixed
// height on sm and up (streaming text never makes it jump), its top at least 1rem under the top bar; the full-width
// bottom sheet on narrow screens.
const PANEL_CLASS =
  'glass-javi fixed z-40 inset-x-0 bottom-0 flex max-h-[85dvh] flex-col overflow-hidden rounded-t-2xl border-b-0 pb-[env(safe-area-inset-bottom)] motion-safe:animate-overlay-in sm:inset-x-auto sm:right-[max(1rem,env(safe-area-inset-right))] sm:w-[24rem] sm:h-[min(36rem,calc(100dvh-var(--topbar-h)-1rem))] sm:max-h-none';

// Quiet header buttons: no box at rest, a fill on hover only.
const ICON_BTN =
  'flex h-8 w-8 max-sm:h-11 max-sm:w-11 items-center justify-center rounded-full text-slate-slate400 hover:bg-slate-slate700/50 hover:text-slate-slate100 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:[outline-color:var(--focus-ring)]';

const noop = () => {};

/**
 * Non-modal dialog: no overlay, no scroll lock, no focus trap. Escape is handled on the
 * panel itself so it cannot fight Modal's document-level handling.
 *
 * One scroll holds both page advice (`thread`, from useJaviSession) and free-form turns with
 * their change requests (`agent`, from useJaviAgent). Typed questions go to `onSend`; the
 * suggestion chips go to `onSuggestion` (advice follow-ups, core code in every build). The composer and the
 * New conversation button come from the private module and show only when it is compiled in (`PRO_UI_INCLUDED`);
 * without it `askBlocked` (a palette question) shows the not-included notice.
 * `rows` are the "New for you" items (useJaviInbox), shown in a strip outside the scroll: between the header and the
 * body when the module is included, at the bottom edge otherwise (so the insight comes first in tab order). A `focusSeq` bump moves focus
 * to the composer, else Close (a strip row opened the panel on another page). `barShown` (the Javi bar is drawn) makes the header button "Collapse Javi" with a
 * chevron; without the bar it is "Close Javi" with an X.
 * @param {{ id: string, pageKey: string, pageLabel: string, thread: object, suggestions: readonly string[],
 *   agent?: object, askBlocked?: boolean, prefill?: { id: number, text: string } | null,
 *   onSend: (text: string) => void, onSuggestion?: (text: string) => void, onNewAdvice: () => void,
 *   onRetry: () => void, onRespond?: (token: string, approve: boolean) => void, onNewChat?: () => void,
 *   onClose: (options?: { restoreFocus?: boolean }) => void, rows?: object[], onOpenItem?: (item: object) => void,
 *   focusSeq?: number, barShown?: boolean }} props
 */
export default function JaviPanel({
  id,
  pageKey,
  pageLabel,
  thread,
  suggestions,
  agent = EMPTY_AGENT,
  askBlocked = false,
  prefill = null,
  onSend,
  onSuggestion = onSend,
  onNewAdvice,
  onRetry,
  onRespond = noop,
  onNewChat = noop,
  onClose,
  rows = [],
  onOpenItem = noop,
  focusSeq = 0,
  barShown = true,
}) {
  const titleId = useId();
  const aboutId = useId();
  const sourceId = useId();
  const newId = useId();
  const { status } = useJarvisStatus();
  // The hint is latched when it first appears so it stays for this panel session even after the
  // status query learns it was shown.
  const [hint, setHint] = useState('idle');
  if (hint === 'idle' && status?.cloudHint?.show === true) setHint('visible');
  const inputRef = useRef(null);
  const closeRef = useRef(null);
  const panelRef = useRef(null);
  const endRef = useRef(null);
  const advising = thread.status === 'loading';
  const loading = advising || agent.running;
  const timeline = useMemo(() => buildTimeline(thread, agent), [thread, agent]);
  const pendingAction = agent.actions.some((a) => a.status === 'pending');
  const hasUserMessage = timeline.some((i) => i.kind === 'message' && i.message.role === 'user');
  // While AI cannot run, the chips would only fail again; Retry is the one action offered.
  const agentUnavailable = isAiUnavailableError({ code: agent.errorCode });
  const aiUnavailable = isAiUnavailableError(thread.error) || agentUnavailable;
  const lastItem = timeline[timeline.length - 1];
  const lastAssistant = lastItem?.kind === 'message' && lastItem.message.role === 'assistant' ? lastItem.message : null;
  const lastAgentAssistant = [...agent.messages].reverse().find((m) => m.role === 'assistant');
  const agentReplyLength = lastAgentAssistant?.content?.length ?? 0;
  const agentWaiting = agent.running && !lastAgentAssistant?.content;
  // Last assistant message already on screen (seeded, and re-seeded when the page changes), so
  // only a reply that arrives afterwards is read out, never another page's old reply.
  const [announced, setAnnounced] = useState({ pageKey, id: lastAssistant?.id ?? null });
  if (announced.pageKey !== pageKey) setAnnounced({ pageKey, id: lastAssistant?.id ?? null });
  const freshReply =
    !loading && lastAssistant && !lastAssistant.blocked && announced.pageKey === pageKey && lastAssistant.id !== announced.id
      ? lastAssistant.content
      : null;
  const replyAnnouncement = useMemo(() => {
    if (freshReply === null) return '';
    const plain = stripDashes(freshReply)
      .replace(/^[ \t]*- /gm, '')
      .replace(/[*_#>|`]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    // A long reply is not read out in full: the user reads it in the panel.
    return plain && plain.length <= 300 ? `Javi said: ${plain}` : 'Javi replied.';
  }, [freshReply]);
  // Single live region: announces only Javi (thinking, then a new reply), never the user's own message.
  const announcement = loading
    ? 'Javi is thinking'
    : pendingAction
      ? 'Javi wants to make a change. Approve or decline.'
      : replyAnnouncement;

  const prefillId = prefill?.id ?? null;
  useEffect(() => {
    const raf = requestAnimationFrame(() => (inputRef.current ?? closeRef.current)?.focus());
    return () => cancelAnimationFrame(raf);
  }, [prefillId, focusSeq]);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [
    timeline.length,
    thread.status,
    thread.partial,
    agent.tools.length,
    agent.running,
    agent.error,
    agentReplyLength,
  ]);

  const onKeyDown = (e) => {
    if (e.key === 'Escape' && !e.nativeEvent?.isComposing) {
      e.stopPropagation();
      onClose();
    }
  };

  // "New for you": every counted row is a real button in one short scroll area; no disclosure.
  const strip = rows.length > 0 && (
    <div className="shrink-0 space-y-1 border-t border-[var(--javi-edge)] px-4 py-2">
      <h3 id={newId} className="text-[11px] font-semibold text-slate-slate300">
        New for you
      </h3>
      <ul aria-labelledby={newId} className="max-h-32 space-y-1 overflow-y-auto">
        {rows.map((item) => (
          <li key={item.id}>
            <button type="button" onClick={() => onOpenItem(item)} className={`${SUGGEST_BTN} w-full text-left max-sm:min-h-11`}>
              {item.label}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );

  return (
    <div
      ref={panelRef}
      id={id}
      role="dialog"
      aria-labelledby={titleId}
      aria-describedby={`${aboutId} ${sourceId}`}
      onKeyDown={onKeyDown}
      className={PANEL_CLASS}
    >
      <div className="glass-javi-head flex items-center gap-2 px-3 py-2">
        <span aria-hidden="true" className="glass-javi-send flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-transparent">
          <Sparkles size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <h2 id={titleId} className="text-base font-semibold leading-tight text-slate-slate100">
              Javi
            </h2>
            <span className="glass-javi-chip shrink-0 whitespace-nowrap rounded-full px-1.5 text-sm text-slate-slate300">AI helper</span>
          </div>
          <div className="flex min-w-0 items-center gap-1.5">
            <p id={aboutId} className="min-w-0 truncate text-[11px] text-slate-slate300">
              About {pageLabel}
            </p>
            <AiSourceBadge id={sourceId} ai={status?.ai} className="min-w-0" />
          </div>
        </div>
        {PRO_UI_INCLUDED && (
          <button
            type="button"
            onClick={onNewChat}
            disabled={loading || (agent.messages.length === 0 && agent.actions.length === 0)}
            aria-label="Start a new conversation with Javi"
            className={ICON_BTN}
          >
            <MessageSquarePlus size={15} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          onClick={onNewAdvice}
          disabled={loading}
          aria-label="Get a new insight for this page"
          className={ICON_BTN}
        >
          <RefreshCw size={15} aria-hidden="true" />
        </button>
        <button ref={closeRef} type="button" onClick={onClose} aria-label={barShown ? 'Collapse Javi' : 'Close Javi'} className={ICON_BTN}>
          {barShown ? <ChevronUp size={16} aria-hidden="true" className="rotate-180" /> : <X size={16} aria-hidden="true" />}
        </button>
      </div>

      {PRO_UI_INCLUDED && strip}

      <div className="glass-javi-body min-h-[10rem] flex-1 space-y-3 overflow-y-auto px-4 py-4">
        <p role="status" className="sr-only">
          {announcement}
        </p>
        {hint === 'visible' && <CloudHint onDismiss={() => setHint('dismissed')} />}
        <div className="space-y-3">
          {timeline.map((item) =>
            item.kind === 'action' ? (
              ConfirmActionCard !== null && (
                <Suspense key={item.key} fallback={null}>
                  <ConfirmActionCard action={item.action} onRespond={onRespond} />
                </Suspense>
              )
            ) : (
              <TimelineMessage key={item.key} message={item.message} />
            ),
          )}
        </div>
        {agent.running && agent.tools.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {agent.tools.map((t) => (
              <span
                key={t.id}
                className="glass-javi-chip inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] text-slate-slate300"
              >
                {t.status === 'running' ? (
                  <Loader2 size={10} className="animate-spin" aria-hidden="true" />
                ) : (
                  <CheckSquare size={10} className="text-accent-green" aria-hidden="true" />
                )}
                {agentToolLabel(t.name)}
              </span>
            ))}
          </div>
        )}
        {agentWaiting && agent.tools.length === 0 && <ThinkingSkeleton />}
        {advising && thread.partial && <JaviMessage role="assistant" content={thread.partial} />}
        {advising && !thread.partial && <ThinkingSkeleton />}
        {!loading && timeline.length === 0 && !thread.error && !agent.error && (
          <div className={GREETING}>
            Want a quick insight about {pageLabel}?{' '}
            <button type="button" onClick={onNewAdvice} className={INSIGHT_BTN}>
              Get insight
            </button>
          </div>
        )}
        {thread.error && (
          <AdviceErrorRow
            error={thread.error}
            unavailable={aiUnavailable}
            canRetry={Boolean(thread.lastRequestMessages)}
            onRetry={onRetry}
            busy={loading}
          />
        )}
        {!PRO_UI_INCLUDED && askBlocked && <NotIncludedNotice capability="javi_tools" />}
        {agent.error && (
          <div className={ERROR_ROW}>
            {agentUnavailable ? (
              <AiUnavailable message={agent.error === AGENT_UNREACHABLE_MESSAGE ? null : agent.error} code={agent.errorCode} reason={agent.errorReason} className="min-w-0 flex-1 text-xs text-slate-slate300" />
            ) : (
              <span role="alert" className="min-w-0 flex-1">
                {agent.error}
              </span>
            )}
          </div>
        )}
        <div ref={endRef} />
      </div>

      {pageKey === 'budget' && (
        <div className="px-4 pb-2.5">
          <button
            type="button"
            onClick={() => {
              // Close the panel first so the import dialog is the only dialog holding focus,
              // and do not pull focus back to the Javi bar behind the dialog.
              onClose({ restoreFocus: false });
              openTransactionImport();
            }}
            className={SUGGEST_BTN}
          >
            Import transactions
          </button>
        </div>
      )}

      {!hasUserMessage && suggestions.length > 0 && (
        <div className="flex flex-wrap gap-2 px-4 pb-2.5">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              disabled={loading}
              aria-disabled={aiUnavailable || undefined}
              onClick={() => {
                if (aiUnavailable) return;
                onSuggestion(s);
              }}
              className={`${SUGGEST_BTN} disabled:opacity-40 aria-disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:hover:text-slate-slate300`}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {!PRO_UI_INCLUDED && strip}

      {PRO_UI_INCLUDED && JaviComposer !== null && (
        <Suspense fallback={null}>
          <JaviComposer inputRef={inputRef} prefill={prefill} loading={loading} focusSeq={focusSeq} onSend={onSend} />
        </Suspense>
      )}
    </div>
  );
}
