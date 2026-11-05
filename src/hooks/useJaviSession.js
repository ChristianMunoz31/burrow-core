import { useCallback, useEffect, useReducer, useRef } from 'react';
import {
  JAVI_MAX_MESSAGES,
  JAVI_MAX_MESSAGE_CHARS,
  JAVI_MAX_TOTAL_MESSAGE_CHARS,
} from '../constants/javiPages';
import { requestJaviAdvice } from '../services/javiService';
import { newId } from '../utils/ids';

/** @typedef {import('../services/javiService').JaviMessage} JaviMessage */
/** @typedef {import('../services/javiService').WireMessage} WireMessage */
/** @typedef {{ messages: JaviMessage[], status: 'idle'|'loading'|'error',
 *   error: { message: string, code: string, reason?: string | null, retryAfterMs: number | null, at: number } | null,
 *   lastRequestMessages: WireMessage[] | null, partial: string }} JaviThread */

/** @type {JaviThread} */
export const EMPTY_THREAD = Object.freeze({
  messages: Object.freeze([]),
  status: 'idle',
  error: null,
  lastRequestMessages: null,
  partial: '',
});

const patch = (state, pageKey, fn) => ({
  ...state,
  [pageKey]: fn(state[pageKey] ?? EMPTY_THREAD),
});

function reducer(state, action) {
  const { pageKey } = action;
  switch (action.type) {
    case 'advice_start':
      return patch(state, pageKey, () => ({
        messages: [],
        status: 'loading',
        error: null,
        lastRequestMessages: action.wire,
        partial: '',
      }));
    case 'send_start':
      return patch(state, pageKey, (t) => {
        // An unanswered user message (failed/stopped turn) is replaced, so roles alternate.
        const base = t.messages[t.messages.length - 1]?.role === 'user' ? t.messages.slice(0, -1) : t.messages;
        return {
          messages: [...base, action.message],
          status: 'loading',
          error: null,
          lastRequestMessages: action.wire,
          partial: '',
        };
      });
    case 'retry_start':
      return patch(state, pageKey, (t) => ({ ...t, status: 'loading', error: null, partial: '' }));
    case 'delta':
      return patch(state, pageKey, (t) => ({ ...t, partial: action.text }));
    case 'success':
      return patch(state, pageKey, (t) => ({
        ...t,
        messages: [...t.messages, action.message],
        status: 'idle',
        error: null,
        partial: '',
      }));
    case 'failure':
      return patch(state, pageKey, (t) => ({ ...t, status: 'error', error: action.error, partial: '' }));
    case 'aborted':
      return patch(state, pageKey, (t) => ({
        ...t,
        status: action.error ? 'error' : 'idle',
        error: action.error,
        partial: '',
      }));
    case 'reset':
      return {};
    default:
      return state;
  }
}

// A stopped follow-up keeps the user message and offers Retry; a stopped auto-advice is silent.
const stoppedError = (wire) =>
  wire.length > 0 ? { message: 'Stopped. Retry to resend your message.', code: 'aborted', retryAfterMs: null } : null;

export const RATE_LIMIT_CODES = Object.freeze(['rate_limited', 'provider_rate_limited']);
const DEFAULT_RATE_LIMIT_WAIT_MS = 30000;

/**
 * Milliseconds still to wait before the failed request may be retried. Uses the server's
 * retryAfterMs; for a rate-limit error without one, `fallbackMs` (default 0 = no wait).
 * @param {{ code?: string, retryAfterMs?: number | null, at?: number } | null | undefined} error
 * @param {number} now
 * @param {number} [fallbackMs]
 * @returns {number}
 */
export function retryWaitMs(error, now, fallbackMs = 0) {
  if (!error || typeof error.at !== 'number') return 0;
  const wait =
    typeof error.retryAfterMs === 'number'
      ? error.retryAfterMs
      : RATE_LIMIT_CODES.includes(error.code)
        ? fallbackMs
        : 0;
  return Math.max(0, error.at + wait - now);
}

/** Wait applied to auto-advice after a rate-limit error that carried no retryAfterMs. */
export const AUTO_ADVICE_RATE_LIMIT_WAIT_MS = DEFAULT_RATE_LIMIT_WAIT_MS;

/**
 * Drops the oldest messages while the combined content exceeds the server's total cap.
 * The newest (user) message is always kept.
 * @param {WireMessage[]} wire
 * @returns {WireMessage[]}
 */
export function trimWire(wire) {
  const out = [...wire];
  let total = out.reduce((n, m) => n + m.content.length, 0);
  while (out.length > 1 && total > JAVI_MAX_TOTAL_MESSAGE_CHARS) {
    total -= out.shift().content.length;
  }
  return out;
}

const aiKindOf = (ai) => ai?.kind ?? 'local';
const aiKeyOf = (ai) => (ai ? `${ai.kind}:${ai.host ?? ''}` : null);

/**
 * Keeps only the earlier turns the current model may see. An assistant reply written under a
 * different kind of model (local, lan, cloud) may quote data that model must not receive, so it is
 * dropped together with the question it answered (the wire needs alternating roles).
 * @param {JaviMessage[]} messages
 * @param {{ kind?: string } | null | undefined} ai The status the next request will run under.
 */
export function dropForeignTurns(messages, ai) {
  const kind = aiKindOf(ai);
  const out = [];
  for (const m of messages) {
    if (m.role === 'assistant' && aiKindOf(m.ai) !== kind) {
      if (out[out.length - 1]?.role === 'user') out.pop();
      continue;
    }
    out.push(m);
  }
  return out;
}

const toWire = (messages, ai) =>
  trimWire(
    dropForeignTurns(messages, ai)
      .map(({ role, content }) => ({
        role,
        content: String(content).slice(0, JAVI_MAX_MESSAGE_CHARS),
      }))
      .slice(-JAVI_MAX_MESSAGES),
  );

/**
 * Per-page, in-memory advisor history for the panel session. Never calls the LLM on its
 * own: only requestAdvice / sendMessage / retry do. Page context is read at call time.
 * `ai` is the live status ({ kind, host }): threads reset when it changes (a thread written under
 * one model is not carried to another) and earlier replies from a different kind are never resent.
 * Follow-ups (sendMessage) and retry work in every build.
 * @param {{ readPageContext: (key: string) => { context: string }, ai?: { kind?: string, host?: string | null } | null }} deps
 */
export function useJaviSession({ readPageContext, ai = null }) {
  const [threads, dispatch] = useReducer(reducer, {});
  const threadsRef = useRef(threads);
  const controllers = useRef(new Map());
  const readRef = useRef(readPageContext);
  const aiRef = useRef(ai);

  useEffect(() => {
    threadsRef.current = threads;
    readRef.current = readPageContext;
    aiRef.current = ai;
  });

  const run = useCallback(async (pageKey, wire, fresh = false) => {
    const controller = new AbortController();
    const entry = { controller, wire };
    controllers.current.set(pageKey, entry);
    // False once abortAll() replaced/cleared this request (it already reset the thread).
    const isCurrent = () => controllers.current.get(pageKey) === entry;
    try {
      const { context } = readRef.current(pageKey);
      const out = await requestJaviAdvice({
        page: pageKey,
        context,
        messages: wire,
        signal: controller.signal,
        fresh,
        onDelta: (text) => {
          if (isCurrent()) dispatch({ type: 'delta', pageKey, text });
        },
        // "Javi is warming up": shown in the reply bubble until the first real text replaces it.
        onStatus: (text) => {
          if (isCurrent()) dispatch({ type: 'delta', pageKey, text });
        },
      });
      if (!isCurrent()) return;
      dispatch({
        type: 'success',
        pageKey,
        message: {
          id: newId(),
          role: 'assistant',
          content: out.content,
          auto: wire.length === 0,
          at: Date.now(),
          ai: out.ai ?? null,
          withheld: out.withheld ?? [],
          notice: out.notice ?? null,
          blocked: out.blocked === true,
        },
      });
    } catch (err) {
      if (!isCurrent()) return;
      if (err?.name === 'AbortError') {
        dispatch({ type: 'aborted', pageKey, error: stoppedError(wire) });
      } else {
        dispatch({
          type: 'failure',
          pageKey,
          error: {
            message:
              err?.status === 401
                ? 'Session expired. Please sign in again.'
                : err?.message || "Javi couldn't answer. Try again.",
            code: err?.status === 401 ? 'unauthorized' : err?.code || 'unknown',
            reason: err?.reason ?? null,
            retryAfterMs: err?.retryAfterMs ?? null,
            at: Date.now(),
          },
        });
      }
    } finally {
      if (isCurrent()) controllers.current.delete(pageKey);
    }
  }, []);

  const threadFor = useCallback((pageKey) => threads[pageKey] ?? EMPTY_THREAD, [threads]);

  const requestAdvice = useCallback(
    (pageKey, fresh = false) => {
      if (!pageKey || controllers.current.has(pageKey)) return;
      dispatch({ type: 'advice_start', pageKey, wire: [] });
      run(pageKey, [], fresh);
    },
    [run],
  );

  const sendMessage = useCallback(
    (pageKey, text) => {
      const content = String(text ?? '').trim();
      if (!pageKey || !content || controllers.current.has(pageKey)) return;
      const existing = (threadsRef.current[pageKey] ?? EMPTY_THREAD).messages;
      const base = existing[existing.length - 1]?.role === 'user' ? existing.slice(0, -1) : existing;
      const message = { id: newId(), role: 'user', content, at: Date.now() };
      const wire = toWire([...base, message], aiRef.current);
      dispatch({ type: 'send_start', pageKey, message, wire });
      run(pageKey, wire);
    },
    [run],
  );

  const retry = useCallback(
    (pageKey) => {
      if (!pageKey || controllers.current.has(pageKey)) return;
      const last = threadsRef.current[pageKey]?.lastRequestMessages;
      if (!last) return;
      const wire = trimWire(last);
      dispatch({ type: 'retry_start', pageKey });
      run(pageKey, wire);
    },
    [run],
  );

  const abortAll = useCallback(() => {
    for (const [pageKey, { controller, wire }] of controllers.current) {
      controller.abort();
      dispatch({ type: 'aborted', pageKey, error: stoppedError(wire) });
    }
    controllers.current.clear();
  }, []);

  // The model behind Javi changed (local to cloud, another host): stop in-flight requests and
  // start every page thread over. The first status load (no earlier value) is not a change.
  const aiKey = aiKeyOf(ai);
  const prevAiKey = useRef(aiKey);
  useEffect(() => {
    if (prevAiKey.current !== null && aiKey !== null && prevAiKey.current !== aiKey) {
      for (const { controller } of controllers.current.values()) controller.abort();
      controllers.current.clear();
      dispatch({ type: 'reset' });
    }
    if (aiKey !== null) prevAiKey.current = aiKey;
  }, [aiKey]);

  useEffect(() => {
    const map = controllers.current;
    return () => {
      for (const { controller } of map.values()) controller.abort();
      map.clear();
    };
  }, []);

  return { threadFor, requestAdvice, sendMessage, retry, abortAll };
}
