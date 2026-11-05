import { Suspense, lazy, useCallback, useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { JAVI_MAX_INPUT_CHARS, JAVI_PAGES, resolveJaviBarPageKey } from '../../constants/javiPages';
import { usePageContextReader, usePageData } from '../../contexts/PageContextContext';
import { useJaviSession } from '../../hooks/useJaviSession';
import { useCachedJarvisAi } from '../../hooks/useCachedJarvisAi';
import { PRO_UI_INCLUDED, useJaviAgent } from '../../extensions/proExtensions';
import { useJaviInbox } from '../../hooks/useJaviInbox';
import { inEditable, isModalOpen } from '../shell/shortcutGuard';
import JaviBar from './JaviBar';
import { errorWaitMs } from './retryWait';
import { JAVI_OPEN_EVENT } from './openJavi';

// Panel chunk loads on first open only.
const JaviPanel = lazy(() => import('./JaviPanel'));

// While the page's data is still loading, re-check this often (up to the cap) before
// giving up and leaving the "Get insight" button.
const READY_POLL_MS = 400;
const READY_POLL_MAX_MS = 20000;

// The toast offset above the bar and the open window is a CSS rule (index.css, `:root:has(...)`).

// Where focus goes when the window closes without the bar: the element that had focus
// before Javi opened if it is still on the page and can take focus, else the main content. The Back button is
// the same node as the disabled, aria-hidden placeholder on Home, so an opener can turn unfocusable meanwhile.
function canRefocus(el) {
  return (
    el instanceof HTMLElement &&
    el.isConnected &&
    typeof el.focus === 'function' &&
    !el.matches(':disabled') &&
    !el.closest('[aria-hidden="true"]')
  );
}
function focusFallback(opener) {
  if (canRefocus(opener)) {
    opener.focus();
    return;
  }
  const main = document.querySelector('main');
  if (!main) return;
  if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
  main.focus({ preventScroll: true });
}

// While the panel chunk loads: a status that holds focus, because the bar that was clicked is hidden while the
// window is open (focus would otherwise fall to <body>). The panel focuses its own control once it mounts.
function JaviPanelFallback() {
  const ref = useRef(null);
  useEffect(() => ref.current?.focus({ preventScroll: true }), []);
  return (
    <p ref={ref} tabIndex={-1} role="status" className="sr-only">
      Loading Javi
    </p>
  );
}

/**
 * Always-mounted host (AppShell). Owns the per-page advice history, the free-form Javi chat
 * (useJaviAgent), the open state and the "auto-advice exactly once per open" rule. Navigation
 * alone never calls the LLM. Advice follow-ups work in every build; typed questions and change requests come from
 * the private module and exist only when it is compiled in (`PRO_UI_INCLUDED`). Also opens the
 * panel on the 'javi:open' event (command palette), sending the question straight away unless
 * Javi is busy; without the module nothing is sent and the panel shows the not-included notice instead.
 * `visible` means Javi is available on this page (the panel can open); `showLauncher` only
 * controls whether the docked Javi bar is drawn, so hiding it never disables Javi (the window's
 * header button then says Close instead of Collapse).
 * Also hosts Javi's "new for you" inbox (useJaviInbox): the bar count (other pages' items plus the current page
 * while it has data and was not opened in Javi since it last changed), a status that speaks a rise in the count,
 * the read marks (the page the panel is open on, `javi:inbox-read` from the Folders page and the Javi card on Home),
 * a fresh insight on open when the page changed elsewhere (auto-advice on, no user message), strip rows that open
 * Javi on another page (or go to Home or Folders, which have no Javi window), and Alt+J.
 * @param {{ pageKey: string | null, visible: boolean, showLauncher?: boolean, autoAdvise: boolean }} props
 */
export default function JaviAdvisor({ pageKey, visible, showLauncher = true, autoAdvise }) {
  const { readPageContext } = usePageContextReader();
  const { ai: statusAi } = useCachedJarvisAi();
  const navigate = useNavigate();
  const inboxPage = visible ? pageKey : null;
  const pageData = usePageData(inboxPage);
  const inbox = useJaviInbox({ pageKey: inboxPage, pageData });
  // Whether the current page counts as having data. It turns on a render or two after a navigation (a lazy page
  // registers late, then its query may still load), so the status below takes a new baseline when it flips.
  const pageHasData = Boolean(pageData);
  const { markRead, count } = inbox;
  const session = useJaviSession({ readPageContext, ai: statusAi });
  const { threadFor, requestAdvice, sendMessage, retry, abortAll } = session;
  const agent = useJaviAgent();
  const { stop: stopAgent, reset: resetAgent, respond: respondAgent, send: sendAgent } = agent;
  const [open, setOpen] = useState(false);
  const [prefill, setPrefill] = useState(null);
  const [askBlocked, setAskBlocked] = useState(false);
  // A blocked palette question belongs to the page it was asked on (reset while rendering, on a page change).
  const [askPage, setAskPage] = useState(pageKey);
  if (askPage !== pageKey) {
    setAskPage(pageKey);
    setAskBlocked(false);
  }
  const [openSeq, setOpenSeq] = useState(0);
  const [focusSeq, setFocusSeq] = useState(0);
  const [newsText, setNewsText] = useState('');
  const pendingOpenRef = useRef(null);
  const staleRef = useRef({ seq: -1, stale: false });
  const newsRef = useRef({ known: null, page: null, hasData: false, last: 0, timer: 0, clear: 0 });
  const barRef = useRef(null);
  const firedSeqRef = useRef(0);
  const restoreFocusRef = useRef(false);
  const openerRef = useRef(null);
  const openPageKeyRef = useRef(null);
  const sessionFnsRef = useRef({ threadFor, requestAdvice });
  const suppressAutoRef = useRef(false);
  const prefillSeqRef = useRef(0);
  const liveRef = useRef({ open: false, shown: false, pageKey: null, busy: false, agentRunning: false });
  const panelId = useId();
  const available = visible && Boolean(pageKey);
  const barShown = available && showLauncher;

  // Hidden (the setting turned off, or a path with no Javi page) while open: close without
  // moving focus. Adjusting state during render is the sanctioned pattern for derived resets.
  if (open && !visible) {
    setOpen(false);
    setPrefill(null);
  }

  useEffect(() => {
    if (!visible) {
      abortAll();
      stopAgent();
    }
  }, [visible, abortAll, stopAgent]);

  // Auto-advice: once per open, only for an empty thread, only when the setting is on, and
  // not while the page's data is still loading (re-checked until ready, so the open is not
  // wasted on an empty snapshot) nor right after a rate-limit error. Keyed on the open
  // sequence so StrictMode's double effect and navigating while the panel is open never
  // fire a second request.
  useEffect(() => {
    sessionFnsRef.current = { threadFor, requestAdvice };
    liveRef.current = {
      open,
      available,
      pageKey,
      busy: agent.running || threadFor(pageKey ?? '').status === 'loading',
      agentRunning: agent.running,
      items: inbox.items,
    };
  });

  // New-items status: speaks only a rise above a count already known this session, at most once per 2 s (the last
  // rise wins), never while the panel is open or the bar is hidden, and clears after 5 s. A page change, and the
  // current page gaining or losing data, take a new baseline: the current-page notice joining the count is not news.
  useEffect(() => {
    const n = newsRef.current;
    if (!inbox.ready) return;
    const rebase = n.page !== inboxPage || n.hasData !== pageHasData;
    n.page = inboxPage;
    n.hasData = pageHasData;
    const prev = rebase ? null : n.known;
    n.known = count;
    if (prev === null || count <= prev || open || !barShown) return;
    clearTimeout(n.timer);
    n.timer = setTimeout(
      () => {
        n.last = Date.now();
        setNewsText(`Javi: ${count} new for you`);
        clearTimeout(n.clear);
        n.clear = setTimeout(() => setNewsText(''), 5000);
      },
      Math.max(0, n.last + 2000 - Date.now()),
    );
  }, [count, inbox.ready, open, barShown, inboxPage, pageHasData]);
  useEffect(() => {
    const n = newsRef.current;
    return () => {
      clearTimeout(n.timer);
      clearTimeout(n.clear);
    };
  }, []);

  // The page the panel is open on is read, also when it was never seen; ids that are
  // neither listed nor an unseen page are dropped, so this runs again once the first inbox answer lands (opened
  // before it, the unseen list was still empty).
  const inboxReady = inbox.ready;
  useEffect(() => {
    if (open && visible && pageKey) markRead([`page:${pageKey}`]);
  }, [open, visible, pageKey, markRead, inboxReady]);

  // The Folders page marks its summaries read where they render (sent even when not in the cached list).
  useEffect(() => {
    const onRead = (e) => {
      if (Array.isArray(e.detail)) markRead(e.detail, { unfiltered: true });
    };
    window.addEventListener('javi:inbox-read', onRead);
    return () => window.removeEventListener('javi:inbox-read', onRead);
  }, [markRead]);

  useEffect(() => {
    if (!open || !visible || !pageKey) return undefined;
    if (firedSeqRef.current === openSeq) return undefined;
    // Navigated away before the pending auto-advice fired: drop it for this open.
    if (openPageKeyRef.current !== pageKey) {
      firedSeqRef.current = openSeq;
      suppressAutoRef.current = false;
      return undefined;
    }
    // Whether this page changed elsewhere since its last insight, taken once per open, before the read mark lands.
    if (staleRef.current.seq !== openSeq) {
      staleRef.current = { seq: openSeq, stale: liveRef.current.items.some((i) => i.id === `page:${pageKey}`) };
    }
    const attempt = () => {
      if (firedSeqRef.current === openSeq) return true;
      // Opened with a question: the answer to that, not page advice, is what the user wants.
      if (suppressAutoRef.current) {
        suppressAutoRef.current = false;
        firedSeqRef.current = openSeq;
        return true;
      }
      if (autoAdvise && readPageContext(pageKey).loading) return false;
      firedSeqRef.current = openSeq;
      const t = sessionFnsRef.current.threadFor(pageKey);
      const waiting = errorWaitMs(t.error, Date.now()) > 0;
      if (!autoAdvise || t.status === 'loading' || waiting || liveRef.current.agentRunning) return true;
      if (staleRef.current.stale && !t.messages.some((m) => m.role === 'user')) {
        sessionFnsRef.current.requestAdvice(pageKey, true);
      } else if (t.messages.length === 0) {
        sessionFnsRef.current.requestAdvice(pageKey);
      }
      return true;
    };
    if (attempt()) return undefined;
    const startedAt = Date.now();
    const id = setInterval(() => {
      if (attempt() || Date.now() - startedAt > READY_POLL_MAX_MS) clearInterval(id);
    }, READY_POLL_MS);
    return () => clearInterval(id);
  }, [open, openSeq, visible, pageKey, autoAdvise, readPageContext]);

  // Focus returns to the bar after it re-renders shown (it is hidden while the window is open,
  // and a hidden element cannot take focus). With no bar it returns to the element focused
  // before opening, else the main content.
  useEffect(() => {
    if (!open && restoreFocusRef.current) {
      restoreFocusRef.current = false;
      const opener = openerRef.current;
      openerRef.current = null;
      if (barRef.current) barRef.current.focus();
      else focusFallback(opener);
    }
  }, [open]);

  // `close({ restoreFocus: false })` is for a caller that moves focus elsewhere itself (the
  // import dialog); anything else (click and key events included) restores focus as usual.
  const close = useCallback(
    (options) => {
      abortAll();
      stopAgent();
      const restore = options?.restoreFocus !== false;
      restoreFocusRef.current = restore;
      if (!restore) openerRef.current = null;
      setPrefill(null);
      setAskBlocked(false);
      setOpen(false);
    },
    [abortAll, stopAgent],
  );

  // 'javi:open' (command palette): open the panel and, with a question, send it at once.
  // While a request is already running the question fills the composer instead, so the
  // panel never has two AI requests in flight.
  useEffect(() => {
    const onOpen = (e) => {
      const live = liveRef.current;
      if (!live.available || !live.pageKey) return;
      const prompt =
        typeof e.detail?.prompt === 'string' ? e.detail.prompt.trim().slice(0, JAVI_MAX_INPUT_CHARS) : '';
      if (!live.open) {
        openerRef.current = document.activeElement;
        openPageKeyRef.current = live.pageKey;
        // Without the module there are no typed questions, so the page's advice still loads on open.
        suppressAutoRef.current = Boolean(prompt) && PRO_UI_INCLUDED;
        setAskBlocked(false);
        setOpenSeq((n) => n + 1);
        setOpen(true);
      }
      if (!prompt) return;
      // Typed questions come from the private module: without it nothing is sent and the panel says so.
      if (!PRO_UI_INCLUDED) {
        setAskBlocked(true);
      } else if (live.busy) {
        prefillSeqRef.current += 1;
        setPrefill({ id: prefillSeqRef.current, text: prompt });
      } else {
        sendAgent(prompt, { page: live.pageKey });
      }
    };
    window.addEventListener(JAVI_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(JAVI_OPEN_EVENT, onOpen);
  }, [sendAgent]);

  const respond = useCallback(
    async (token, approve) => {
      await respondAgent(token, approve);
    },
    [respondAgent],
  );

  const openPanel = useCallback(() => {
    suppressAutoRef.current = false;
    setAskBlocked(false);
    openerRef.current = document.activeElement;
    openPageKeyRef.current = liveRef.current.pageKey;
    setOpenSeq((n) => n + 1);
    setOpen(true);
  }, []);

  const toggle = () => {
    if (open) close();
    else openPanel();
  };

  // Alt+J: opens like a bar click; with the panel open and focus outside it, moves focus in. Layout independent
  // (e.code), AltGr rejected, never in a text field or under a modal; works with the bar hidden too.
  useEffect(() => {
    const onKey = (e) => {
      if (e.code !== 'KeyJ' || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.repeat) return;
      if (e.getModifierState?.('AltGraph') || isModalOpen() || inEditable(e.target)) return;
      const live = liveRef.current;
      if (!live.available) return;
      e.preventDefault();
      if (!live.open) openPanel();
      else if (!document.getElementById(panelId)?.contains(document.activeElement)) setFocusSeq((n) => n + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openPanel, panelId]);

  // A strip row opened Javi on another page: once that page is current, run the open rule there and move focus into
  // the panel (composer, else Close) so it never falls to the body.
  useEffect(() => {
    if (pendingOpenRef.current && pendingOpenRef.current === pageKey) {
      pendingOpenRef.current = null;
      openPageKeyRef.current = pageKey;
      setOpenSeq((n) => n + 1);
      setFocusSeq((n) => n + 1);
    }
  }, [pageKey]);

  const onOpenItem = (item) => {
    if (item.page === null || resolveJaviBarPageKey(item.to) === null) {
      // Folders has no Javi page, and Home shows the briefing in its Javi card: close, go there and focus the
      // main content. Opening the briefing row reads it here, since a hidden Javi card on Home never marks it.
      if (item.id === 'briefing') markRead(['briefing'], { unfiltered: true });
      close({ restoreFocus: false });
      navigate(item.to);
      focusFallback(null);
      return;
    }
    pendingOpenRef.current = item.page;
    navigate(item.to);
  };

  if (!visible || !pageKey) return null;
  const page = JAVI_PAGES[pageKey];
  const pageLabel = page?.label ?? 'this page';

  return (
    <>
      {showLauncher && (
        <>
          <JaviBar ref={barRef} open={open} onToggle={toggle} controlsId={panelId} count={count} />
          <p role="status" className="sr-only">
            {newsText}
          </p>
        </>
      )}
      {open && (
        <Suspense fallback={<JaviPanelFallback />}>
          <JaviPanel
            id={panelId}
            pageKey={pageKey}
            pageLabel={pageLabel}
            thread={threadFor(pageKey)}
            suggestions={page?.suggestions ?? []}
            agent={agent}
            askBlocked={askBlocked}
            prefill={prefill}
            onSend={(text) => sendAgent(text, { page: pageKey })}
            onSuggestion={(text) => sendMessage(pageKey, text)}
            onNewAdvice={() => requestAdvice(pageKey, threadFor(pageKey).messages.length > 0)}
            onRetry={() => retry(pageKey)}
            onRespond={respond}
            onNewChat={resetAgent}
            onClose={close}
            barShown={barShown}
            rows={inbox.rows}
            onOpenItem={onOpenItem}
            focusSeq={focusSeq}
          />
        </Suspense>
      )}
    </>
  );
}
