// Javi page advisor: one model call on the local chat model (server/ai), either as a
// single JSON answer (generateAdvice) or streamed token by token (streamAdvice).
// There is no fallback to another model or provider.
//
// Cloud AI: under a cloud client the page is first filtered by applyPagePolicy (categories the
// user did not share never reach the prompt; a page whose own category is withheld makes no
// model call at all). cross insights pass their own `scope` and filter before calling.
//
// Logging contract: only the error class and scope are ever logged. Never err.message
// (it may echo provider text), messages, or context.
import {
  AiBusyError,
  AiUnavailableError,
  CloudScopeError,
  MSG_CLOUD_DISABLED,
  applyPagePolicy,
  classifyAiError,
  contextBudgetChars,
  createStreamSanitizer,
  createAiPolicy,
  getAiClient,
  sanitizeModelText,
  withheldMessage,
} from '../ai/index.js';
import { buildAdvisorMessages, promptVersionFor } from './advisorPrompt.js';
import { isSmallModelName } from './modelSize.js';
import { adviceCacheKey, getCachedAdvice, putCachedAdvice } from './adviceCache.js';
import { checkGroundedNumbers } from './groundedNumbers.js';
import { currentDataGeneration } from '../dataGeneration.js';
import { getDisplayName } from '../profile.js';
import { getCharacter } from './characters.js';

/** Local and LAN models: the prompt asks for 150 words (about 200 tokens); this bounds a model that rambles past it. */
export const ADVICE_MAX_TOKENS = 450;
/** Local and LAN models: low on purpose, the answer should copy figures from the data, not invent them. */
export const ADVICE_TEMPERATURE = 0.2;
/** Cloud keeps the caps it always had; the tighter local caps are tuned for small models. */
export const CLOUD_ADVICE_MAX_TOKENS = 1200;
export const CLOUD_ADVICE_TEMPERATURE = 0.4;
/** Provider kinds (`client.ai.kind`) that get the local caps and may use the insight card cache. Anything else is treated like cloud. */
const LOCAL_KINDS = Object.freeze(['local', 'lan']);
/** Fixed copy shown when an answer holds a figure that is not in the data it was given. Never echoes the figure. */
export const MSG_UNGROUNDED = 'Javi mentioned a figure that is not in your data. Check the numbers on this page.';
/** Fixed copy appended when a local model stopped at the token cap. Never contains model text. */
export const MSG_CUT_SHORT = "Javi's answer was cut short. Ask again for the rest.";
/** Upper bound for the retry hint surfaced to the client. */
export const RETRY_AFTER_MAX_MS = 60000;
/** Rough size of the advisor system prompt plus fence, reserved before clipping the page context. */
const PROMPT_RESERVE_CHARS = 3500;

const MSG_TIMEOUT = 'Javi took too long to answer. Try again.';
const MSG_EMPTY = 'Javi came back empty. Try again.';

/**
 * Build a user-safe error the route can pass straight through.
 * @param {number} httpStatus HTTP status for the response.
 * @param {string} code Machine-readable error code.
 * @param {string} publicMessage Fixed, user-safe message.
 * @param {number|null} [retryAfterMs] Optional retry hint in ms, clamped to [0, RETRY_AFTER_MAX_MS].
 * @returns {Error & { httpStatus: number, code: string, publicMessage: string, retryAfterMs?: number }}
 */
function adviceError(httpStatus, code, publicMessage, retryAfterMs) {
  const err = new Error(publicMessage);
  err.name = 'JaviAdviceError';
  err.httpStatus = httpStatus;
  err.code = code;
  err.publicMessage = publicMessage;
  const retry = Number(retryAfterMs);
  if (retryAfterMs != null && Number.isFinite(retry)) {
    err.retryAfterMs = Math.min(RETRY_AFTER_MAX_MS, Math.max(0, Math.round(retry)));
  }
  return err;
}

/**
 * Map a failed model call to a user-safe error. AI availability errors pass through.
 * @param {unknown} err
 * @returns {Error}
 */
export function mapAdviceFailure(err) {
  if (err instanceof AiUnavailableError || err instanceof AiBusyError) return err;
  if (err instanceof CloudScopeError) {
    return adviceError(403, err.code, err.code === 'cloud_disabled' ? MSG_CLOUD_DISABLED : withheldMessage(err.categories));
  }
  if (err?.code === 'empty_response') return adviceError(502, 'empty_response', MSG_EMPTY);
  const c = classifyAiError(err);
  console.error('Javi advice failed:', err?.name || 'unknown', c.code);
  if (c.code === 'minute' || c.code === 'day') return adviceError(429, 'provider_rate_limited', c.message, c.retryMs);
  if (c.code === 'timeout') return adviceError(504, 'timeout', MSG_TIMEOUT);
  if (c.code === 'first_token_timeout') return adviceError(504, 'first_token_timeout', c.message);
  if (c.code === 'model_missing') return adviceError(502, 'model_missing', c.message);
  return adviceError(502, 'upstream_error', c.message);
}

/**
 * The client snapshot's trailing `"localTime":"HH:MM"` member (src/utils/javiContext.js). It is lifted out of the
 * snapshot into its own line after the fence, so the fenced text (and the cache key) does not change every minute
 * and the clock survives clipping of a long snapshot.
 */
const CLOCK_FIELD_RE = /,"localTime":"(\d{2}:\d{2})"(\}\s*)$/;

const LOCAL_AI = Object.freeze({ kind: 'local', host: null });

/** True when the call goes to a local or LAN model (the tuned caps, the insight card cache and the cut-short note apply). */
export const isLocalLike = (ai) => !ai.isCloud && !ai.policy?.isCloud && LOCAL_KINDS.includes((ai.ai ?? LOCAL_AI).kind);

/**
 * Prompt variant for a client: `small` for a local or LAN model whose name says it has at most 2B parameters,
 * else `standard`. Cloud is never small, so cloud keeps the standard prompt. Fixed per model, so each model's
 * system prompt stays byte-identical across requests (its prompt cache keeps working).
 *
 * @param {{ model?: string, isCloud?: boolean, policy?: { isCloud?: boolean }, ai?: { kind: string } }} ai The AI client.
 * @returns {'standard' | 'small'}
 */
export function promptVariantFor(ai) {
  return ai && isLocalLike(ai) && isSmallModelName(ai.model) ? 'small' : 'standard';
}

/** Token cap and temperature for this client. */
const callParams = (ai) =>
  isLocalLike(ai)
    ? { maxTokens: ADVICE_MAX_TOKENS, temperature: ADVICE_TEMPERATURE }
    : { maxTokens: CLOUD_ADVICE_MAX_TOKENS, temperature: CLOUD_ADVICE_TEMPERATURE };

/**
 * Resolve the client, apply the page policy and build the prompt. `options.scope` (cross
 * insights) means the caller already filtered the context, so the page policy is skipped.
 * @returns {Promise<{ ai: object, messages?: object[], scope: object, withheld: string[], blocked: boolean, sentContext: string,
 *   factsText?: string, displayName?: string | null, character?: string, params?: { maxTokens: number, temperature: number } }>}
 */
async function prepare(input, client, { scope } = {}) {
  const ai = client || (await getAiClient({ purpose: 'chat' }));
  const policy = ai.policy ?? createAiPolicy({ isCloud: false });
  let context = String(input.context || '');
  let history = input.messages || [];
  let callScope = scope ?? { categories: [] };
  let withheld = scope?.withheld ? [...scope.withheld] : [];
  if (!scope && policy.isCloud) {
    const applied = applyPagePolicy({ page: input.page, context, messages: history }, policy);
    ai.noteWithheld?.(applied.withheld);
    if (!applied.allowed) return { ai, scope: callScope, withheld: applied.withheld, blocked: true, sentContext: '' };
    context = applied.context;
    history = applied.messages;
    withheld = applied.withheld;
    callScope = { categories: applied.categories, withheld: applied.withheld };
  }
  const params = callParams(ai);
  const clock = CLOCK_FIELD_RE.exec(context);
  const localTime = clock ? clock[1] : null;
  if (clock) context = context.replace(CLOCK_FIELD_RE, '$2');
  const historyChars = history.reduce((n, m) => n + String(m.content || '').length, 0);
  const budget = contextBudgetChars(ai, { maxTokens: params.maxTokens, reserveChars: PROMPT_RESERVE_CHARS + historyChars, minChars: 500 });
  const sentContext = context.slice(0, budget);
  const [displayName, character] = await Promise.all([getDisplayName(), getCharacter()]);
  const variant = promptVariantFor(ai);
  const messages = buildAdvisorMessages({
    pageLabel: input.pageLabel,
    context: sentContext,
    messages: history,
    displayName,
    character,
    localTime,
    variant,
  });
  // Everything the model may quote: the page data, the clock line and the user's own turns (never an earlier model reply).
  const factsText = [sentContext, localTime ?? '', ...history.filter((m) => m.role === 'user').map((m) => String(m.content || ''))].join('\n');
  return { ai, messages, scope: callScope, withheld, blocked: false, sentContext, factsText, displayName, character, params, localTime, variant };
}

/** Result for a page whose own category is withheld: fixed copy, no model call. */
function blockedResult(prep) {
  const content = withheldMessage(prep.withheld);
  return {
    content,
    model: prep.ai.model,
    provider: prep.ai.provider,
    calls: 0,
    ai: prep.ai.ai ?? LOCAL_AI,
    withheld: prep.withheld,
    notice: content,
    groundingNote: null,
    cutShort: false,
    blocked: true,
    cached: false,
    sentContext: '',
  };
}

/** MSG_UNGROUNDED when the answer holds a number that is not in the facts sent to the model, else null. */
function groundingNoteFor(content, prep) {
  return checkGroundedNumbers(content, prep.factsText).ungrounded.length > 0 ? MSG_UNGROUNDED : null;
}

/**
 * @param {object} prep
 * @param {string} content The full sanitized answer.
 * @param {{ groundingNote?: string | null, cached?: boolean, cutShort?: boolean }} [extra] A cache hit passes the stored note.
 *   `cutShort` is honoured for local and LAN models only (cloud keeps its larger cap and its old behaviour).
 */
const okResult = (prep, content, { groundingNote = groundingNoteFor(content, prep), cached = false, cutShort = false } = {}) => ({
  content,
  model: prep.ai.model,
  provider: prep.ai.provider,
  calls: cached ? 0 : (prep.ai.stats?.calls ?? 1),
  ai: prep.ai.ai ?? LOCAL_AI,
  withheld: prep.withheld,
  notice: [prep.withheld.length ? withheldMessage(prep.withheld) : null, groundingNote, cutShort && isLocalLike(prep.ai) ? MSG_CUT_SHORT : null].filter(Boolean).join(' ') || null,
  groundingNote,
  cutShort: cutShort && isLocalLike(prep.ai),
  blocked: false,
  cached,
  sentContext: prep.sentContext,
});

/** Map a failure and tell the route which context was actually sent (for the audit row). */
function failure(err, prep) {
  const mapped = mapAdviceFailure(err);
  if (mapped !== null && typeof mapped === 'object') mapped.sentContext = prep.sentContext;
  return mapped;
}

/**
 * Generate page advice (or a follow-up answer) as one JSON reply.
 * @param {{ page: string, pageLabel: string, context: string, messages: Array<{ role: 'user'|'assistant', content: string }> }} input
 *   The validated request value from `validateAdviceRequest`.
 * @param {{ client?: object, signal?: AbortSignal, scope?: { categories: string[], withheld?: string[] } }} [options]
 *   `client` is a chat AiClient (resolved when omitted). `scope` skips the page policy (the caller filtered).
 * @returns {Promise<{ content: string, model: string, provider: string, calls: number, ai: { kind: string, host: string|null },
 *   withheld: string[], notice: string|null, groundingNote: string|null, cutShort: boolean, blocked: boolean, cached: boolean, sentContext: string }>}
 * @throws {AiUnavailableError | AiBusyError | Error & { httpStatus: number, code: string, publicMessage: string }}
 */
export async function generateAdvice(input, { client, signal, scope } = {}) {
  const prep = await prepare(input, client, { scope });
  if (prep.blocked) return blockedResult(prep);
  try {
    const result = await prep.ai.complete({
      messages: prep.messages,
      ...prep.params,
      signal,
      scope: prep.scope,
    });
    const content = sanitizeModelText(typeof result?.content === 'string' ? result.content : '').trim();
    if (!content) throw Object.assign(new Error('empty response'), { code: 'empty_response' });
    return okResult(prep, content, { cutShort: result?.finishReason === 'length' });
  } catch (err) {
    throw failure(err, prep);
  }
}

/**
 * Stream page advice. `onDelta` receives sanitized text as it becomes safe to show; the
 * resolved content is the full sanitized answer (authoritative).
 * @param {Parameters<typeof generateAdvice>[0]} input
 * @param {{ client?: object, signal?: AbortSignal, onDelta?: (text: string) => void, onWarming?: () => void, scope?: { categories: string[], withheld?: string[] },
 *   cache?: boolean, fresh?: boolean }} [options]
 *   `onWarming` fires once when a local model has produced nothing after a few seconds (a cold load).
 *   `cache` lets a single-shot answer on a local model be served from, and stored in, the insight card cache
 *   (a hit calls `onDelta` once with the whole text and makes no model call); `fresh` skips the lookup but still stores.
 * @returns {Promise<Awaited<ReturnType<typeof generateAdvice>>>} A blocked page resolves at once with no deltas.
 */
export async function streamAdvice(input, { client, signal, onDelta, onWarming, scope, cache = false, fresh = false } = {}) {
  const prep = await prepare(input, client, { scope });
  if (prep.blocked) return blockedResult(prep);
  const cacheable = cache && !scope && isLocalLike(prep.ai) && (input.messages?.length ?? 0) === 0;
  const cacheKey = cacheable
    ? adviceCacheKey({
        model: String(prep.ai.model ?? ''),
        kind: String((prep.ai.ai ?? LOCAL_AI).kind),
        host: String((prep.ai.ai ?? LOCAL_AI).host ?? ''),
        page: input.page,
        // The clock was lifted out of the snapshot: it changes every minute, so only its hour keys the card
        // (a card never replays across an hour boundary).
        context: prep.sentContext,
        hourBucket: prep.localTime ? prep.localTime.slice(0, 2) : 'none',
        promptVersion: promptVersionFor(prep.variant),
        displayName: prep.displayName,
        character: prep.character,
      })
    : null;
  if (cacheKey && !fresh) {
    const hit = getCachedAdvice(cacheKey);
    if (hit) {
      onDelta?.(hit.content);
      return okResult(prep, hit.content, { groundingNote: hit.groundingNote, cached: true });
    }
  }
  const generation = currentDataGeneration();
  const sanitizer = createStreamSanitizer();
  let raw = '';
  let finishReason = null;
  const emit = (text) => {
    if (text) onDelta?.(text);
  };
  try {
    for await (const ev of prep.ai.stream({
      messages: prep.messages,
      ...prep.params,
      signal,
      scope: prep.scope,
      onWarming,
    })) {
      if (ev.type === 'done') finishReason = ev.finishReason ?? null;
      if (ev.type !== 'token') continue;
      raw += ev.text;
      emit(sanitizer.push(ev.text));
    }
    emit(sanitizer.flush());
    const content = sanitizeModelText(raw).trim();
    if (!content) throw Object.assign(new Error('empty response'), { code: 'empty_response' });
    const out = okResult(prep, content, { cutShort: finishReason === 'length' });
    // An answer that needed a notice (unverified figure, cut short) is not worth replaying.
    if (cacheKey && !out.groundingNote && !out.cutShort) putCachedAdvice(cacheKey, { content, groundingNote: out.groundingNote }, generation);
    return out;
  } catch (err) {
    throw failure(err, prep);
  }
}
