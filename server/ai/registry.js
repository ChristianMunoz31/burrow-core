// Picks the provider and model for a purpose and builds the AiClient. Every model call
// goes through the shared FIFO queue, the first-token and total timeouts, and context
// fitting, and is counted in client.stats.calls.
//
// Provider: openai_compat only when chosen in Settings AND the cloudAi opt-in is on AND a
// current consent record exists for the base URL host AND a key, a public https base URL and
// a model are set; otherwise local Ollama. There is no runtime fallback between models or
// providers (a broken cloud setup falls back to local at resolve time, never the reverse).
// Every cloud call passes enforceCloudScope() inside events() (see privacy.js).
import { isEnabled } from '../netPolicy.js';
import { recordNetworkCallCoalesced } from '../networkCall.js';
import { isLoopbackHost } from '../config.js';
import { getSecret } from '../secrets/index.js';
import {
  AI_REASONS,
  AiUnavailableError,
  HINT_AI_LAN,
  HINT_START_OLLAMA,
  HINT_WARMING_UP,
  MSG_AI_OFF,
  MSG_NO_EMBED_MODEL,
  MSG_NO_MODEL,
  MSG_NO_TOOL_MODEL,
  MSG_WARMING_UP,
  isAiEnabled,
  ollamaUnavailableMessage,
} from './gate.js';
import { getAiSettings, resolveOllamaHost, resolveTokenParam, validateCloudBaseUrl } from './settings.js';
import { getCloudCategories, getCloudConsent, isConsentCurrent, CLOUD_CONSENT_VERSION } from './consent.js';
import { CLOUD_CATEGORY_IDS, CloudScopeError, createAiPolicy, enforceCloudScope, resolveCloudCategories } from './privacy.js';
import { NO_CLOUD_HINT, getCloudHint } from './cloudHint.js';
import { recordLocalCall } from './localPerf.js';
import { createQueueFromEnv } from './queue.js';
import { fitMessages } from './contextFit.js';
import { MAX_CONTENT_CHARS } from './bodyCap.js';
import { isConnectionError } from './llmErrors.js';
import { ollamaChatStream, ollamaEmbed, ollamaPullStream, ollamaShow, ollamaTags, ollamaVersion } from './providers/ollama.js';
import { openaiCompatChatStream } from './providers/openaiCompat.js';

export const CLOUD_KEY_NAME = 'AI_CLOUD_API_KEY';
/** The local search model behind Folders questions (embeddings never go to a cloud provider). */
export const EMBED_MODEL = 'nomic-embed-text';
const EMBED_TIMEOUT_MS = 120_000;
export const CLOUD_NUM_CTX = 32768;
export const PROBE_TIMEOUT_MS = 3000;
const SHOW_TIMEOUT_MS = 5000;
const SHOW_CACHE_MAX = 64;
/** At most this many installed models are considered (and shown) per probe. */
export const MAX_PROBE_MODELS = 64;
/** /api/show calls run this many at a time, all under one deadline. */
const SHOW_CONCURRENCY = 4;
const SHOW_DEADLINE_MS = 8000;
/** Tool calls kept from one reply. */
const MAX_TOOL_CALLS = 32;
/** A cold first prompt on a CPU-only machine measured 95 to 150 s; leave headroom. */
export const DEFAULT_FIRST_TOKEN_MS = 300_000;

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Env-derived limits, read per call so tests and .env changes apply. */
export function aiEnvConfig(env = process.env) {
  return {
    numCtx: Math.floor(num(env.OLLAMA_NUM_CTX, 8192)),
    keepAlive: (env.OLLAMA_KEEP_ALIVE || '10m').trim() || '10m',
    autoMaxParamsB: num(env.BURROW_AI_AUTO_MAX_PARAMS_B, 14),
    firstTokenMs: num(env.BURROW_AI_FIRST_TOKEN_TIMEOUT_MS, DEFAULT_FIRST_TOKEN_MS),
    totalMs: num(env.BURROW_AI_TOTAL_TIMEOUT_MIN, 5) * 60_000,
    healthTtlMs: num(env.BURROW_AI_HEALTH_TTL_MS, 5000),
    healthFailTtlMs: 2000,
    probeMs: num(env.BURROW_AI_PROBE_TIMEOUT_MS, PROBE_TIMEOUT_MS),
    // A busy Ollama (loading a model) can miss the 3 s probe; a real request waits this long for it.
    warmupProbeMs: num(env.BURROW_AI_WARMUP_PROBE_MS, 30_000),
    // No first token after this long on a local model: tell the caller Javi is warming up.
    warmingAfterMs: num(env.BURROW_AI_WARMING_MS, 4000),
  };
}

// ---------------------------------------------------------------------------
// Model metadata
// ---------------------------------------------------------------------------

/**
 * "7.6B" -> 7.6e9, "500M" -> 5e8, "1.5T" -> 1.5e12; null when unparseable.
 * @param {unknown} size
 * @returns {number | null}
 */
export function parseParameterSize(size) {
  const m = /^\s*([\d.]+)\s*([KMBT])\s*$/i.exec(String(size ?? ''));
  if (!m) return null;
  const mult = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[m[2].toUpperCase()];
  const v = Number(m[1]) * mult;
  return Number.isFinite(v) && v > 0 ? v : null;
}

const caps = (m) => (Array.isArray(m?.capabilities) ? m.capabilities : []);
const params = (m) => m?.parameterCount ?? parseParameterSize(m?.parameterSize);

/** Models usable for text generation: completion-capable, not embeddings, not vision-only. */
export const isTextModel = (m) => {
  // The search model for Folders: never a chat model, even when its capabilities are unknown.
  if (String(m?.name ?? '').startsWith(EMBED_MODEL)) return false;
  const c = caps(m);
  if (c.includes('embedding')) return false;
  if (c.length && !c.includes('completion')) return false;
  if (c.includes('vision') && !c.includes('tools')) return false;
  return true;
};

/**
 * Automatic model choice.
 * tools: the largest tools-capable text model with at most `maxParamsB` billion parameters
 *   (ties broken by file size).
 * chat: a faster model distinct from the tool model (the smallest text model of at least
 *   2.5B parameters that is smaller than the tool model), else the tool model, else the
 *   largest text model within the cap.
 * @param {Array<{ name: string, capabilities: string[], parameterSize?: string|null, parameterCount?: number|null, sizeBytes?: number }>} models
 * @param {{ maxParamsB?: number }} [opts]
 * @returns {{ tools: string | null, chat: string | null }}
 */
export function pickAutoModels(models, { maxParamsB = 14 } = {}) {
  const eligible = (Array.isArray(models) ? models : []).filter(isTextModel);
  const withinMax = (m) => {
    const p = params(m);
    return p == null || p <= maxParamsB * 1e9;
  };
  const bigFirst = (a, b) => (params(b) ?? 0) - (params(a) ?? 0) || (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0);
  const toolModel = eligible.filter((m) => caps(m).includes('tools') && withinMax(m)).sort(bigFirst)[0] || null;
  const toolP = toolModel ? params(toolModel) : null;
  const fast = eligible
    .filter((m) => {
      const p = params(m);
      return m !== toolModel && withinMax(m) && p != null && p >= 2.5e9 && (toolP == null || p < toolP);
    })
    .sort((a, b) => params(a) - params(b) || (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0))[0];
  const chatModel = fast || toolModel || eligible.filter(withinMax).sort(bigFirst)[0] || null;
  return { tools: toolModel?.name ?? null, chat: chatModel?.name ?? null };
}

// ---------------------------------------------------------------------------
// Health + model list (lazy; nothing runs at startup)
// ---------------------------------------------------------------------------

const healthCache = new Map(); // host -> { until, value }
const lastGoodHealth = new Map(); // host -> { value, at } of the last probe that found Ollama running
const healthInflight = new Map(); // host -> Promise
const patientInflight = new Map(); // host -> the one patient probe in flight, shared by every waiting request
/** A probe that found Ollama running is trusted for a busy probe only this long. */
export const LAST_GOOD_MAX_AGE_MS = 10 * 60_000;
const showCache = new Map(); // `${host}|${name}|${digest}` -> info

async function showCached(host, entry, signal) {
  const key = `${host}|${entry.name}|${entry.digest || entry.modified_at || ''}`;
  if (showCache.has(key)) return showCache.get(key);
  let info = { capabilities: [], contextLength: null, parameterCount: null };
  try {
    info = await ollamaShow(host, entry.name, { timeoutMs: SHOW_TIMEOUT_MS, signal });
  } catch {
    return info; // not cached: retried next time
  }
  if (showCache.size >= SHOW_CACHE_MAX) showCache.delete(showCache.keys().next().value);
  showCache.set(key, info);
  return info;
}

/**
 * Tag entry -> the public model shape (section 7 of the design).
 * @param {string} host
 * @param {object} entry Raw /api/tags entry.
 */
async function normalizeModel(host, entry, signal) {
  const d = entry?.details && typeof entry.details === 'object' ? entry.details : {};
  let capabilities = Array.isArray(entry?.capabilities) ? entry.capabilities.filter((c) => typeof c === 'string') : null;
  let contextLength = Number.isFinite(d.context_length) ? d.context_length : null;
  let parameterCount = null;
  if (!capabilities || contextLength == null) {
    const info = await showCached(host, entry, signal);
    capabilities = capabilities || info.capabilities;
    contextLength = contextLength ?? info.contextLength;
    parameterCount = info.parameterCount;
  }
  const parameterSize = typeof d.parameter_size === 'string' ? d.parameter_size.slice(0, 20) : null;
  return {
    name: String(entry.name || entry.model || '').slice(0, 200),
    sizeBytes: Number.isFinite(entry.size) ? entry.size : 0,
    parameterSize,
    parameterCount: parameterCount ?? parseParameterSize(parameterSize),
    family: typeof d.family === 'string' ? d.family.slice(0, 60) : null,
    quantization: typeof d.quantization_level === 'string' ? d.quantization_level.slice(0, 40) : null,
    capabilities,
    contextLength,
    modifiedAt: typeof entry.modified_at === 'string' ? entry.modified_at : null,
  };
}

const PROBE_HINTS = Object.freeze({
  connection_refused: 'Open the Ollama app or run "ollama serve".',
  timeout: 'Ollama did not answer in time. It may be busy loading a model; try again shortly.',
  not_ollama: 'Something answered at this address, but it is not Ollama. Check the host and port.',
  no_models: 'Run "ollama pull qwen2.5:7b" in a terminal, then reload.',
  opt_in_required: HINT_AI_LAN,
});

const probeError = (code) => ({ code, hint: PROBE_HINTS[code] });

/**
 * Map with at most `limit` calls in flight; results keep input order.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapBounded(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** The last good probe for `host`, only while it is fresh enough to trust. */
function freshLastGood(host) {
  const entry = lastGoodHealth.get(host);
  if (!entry) return null;
  if (Date.now() - entry.at > LAST_GOOD_MAX_AGE_MS) {
    lastGoodHealth.delete(host);
    return null;
  }
  return entry.value;
}

/** `signal` is an optional overall deadline for the whole probe (version, tags and show). */
async function probe(host, timeoutMs = PROBE_TIMEOUT_MS, signal) {
  try {
    const version = await ollamaVersion(host, { timeoutMs, signal });
    const raw = await ollamaTags(host, { timeoutMs, signal });
    const entries = raw.filter((e) => e && (e.name || e.model)).slice(0, MAX_PROBE_MODELS);
    // /api/show runs in parallel (bounded) under one deadline, so a slow server or a long
    // model list cannot stretch the probe to N times the per-call timeout.
    const showDeadline = AbortSignal.timeout(SHOW_DEADLINE_MS);
    const deadline = signal ? AbortSignal.any([signal, showDeadline]) : showDeadline;
    const models = await mapBounded(entries, SHOW_CONCURRENCY, (entry) => normalizeModel(host, entry, deadline));
    const usable = models.filter(isTextModel);
    const value = { running: true, version, models, error: usable.length ? null : probeError('no_models') };
    lastGoodHealth.set(host, { value, at: Date.now() });
    return value;
  } catch (err) {
    let code = 'connection_refused';
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') code = 'timeout';
    else if (err?.code === 'not_ollama' || Number.isFinite(err?.httpStatus)) code = 'not_ollama';
    return { running: false, version: null, models: [], error: probeError(code) };
  }
}

/**
 * Ollama health and installed models for `host`, cached (5 s when up, 2 s when down).
 * `loopback` says whether `host` is on this computer: only then is a probe that merely timed out
 * (a busy Ollama loading a model) softened to the last good answer. A remote host that does not
 * answer in time is simply unreachable.
 * @param {string} host
 * @param {{ fresh?: boolean, loopback?: boolean }} [opts]
 * @returns {Promise<{ running: boolean, version: string|null, models: object[], error: null | { code: string, hint: string } }>}
 */
export async function getOllamaHealth(host, { fresh = false, loopback = false } = {}) {
  const cached = healthCache.get(host);
  if (!fresh && cached && Date.now() < cached.until) return cached.value;
  if (healthInflight.has(host)) return healthInflight.get(host);
  const cfg = aiEnvConfig();
  const p = probe(host, cfg.probeMs)
    .then(async (probed) => {
      // A probe of another computer is an outbound call: audit it, at most once per host per 15 minutes.
      // Loopback is never audited. Any host that cannot be parsed is skipped.
      try {
        const { hostname } = new URL(host);
        if (!isLoopbackHost(hostname.replace(/^\[|\]$/g, ''))) {
          await recordNetworkCallCoalesced('aiLan', hostname, probed.running ? 'ok' : 'error');
        }
      } catch {
        /* an unparseable host is not audited */
      }
      // A local probe that merely timed out (Ollama is up but busy, typically loading a model) is not
      // "unreachable": keep using what a recent good probe saw. A refused connection is not softened.
      const good = loopback && probed.error?.code === 'timeout' ? freshLastGood(host) : null;
      const value = good ? { ...good, busy: true } : probed;
      healthCache.set(host, { value, until: Date.now() + (value.running ? cfg.healthTtlMs : cfg.healthFailTtlMs) });
      return value;
    })
    .finally(() => healthInflight.delete(host));
  healthInflight.set(host, p);
  return p;
}

/** Wait for `promise`, but stop waiting (rejecting with an AbortError) when `signal` aborts. */
function untilAborted(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/**
 * One patient probe per host, shared by every request waiting on it. It runs under a single overall
 * deadline (`warmupProbeMs`, default 30 s) covering version, tags and show together, and does not
 * stop when one waiter goes away.
 */
function sharedPatientProbe(host, cfg) {
  if (patientInflight.has(host)) return patientInflight.get(host);
  const p = probe(host, cfg.warmupProbeMs, AbortSignal.timeout(cfg.warmupProbeMs))
    .then((waited) => {
      if (waited.running || waited.error?.code !== 'timeout') {
        healthCache.set(host, { value: waited, until: Date.now() + (waited.running ? cfg.healthTtlMs : cfg.healthFailTtlMs) });
      }
      return waited;
    })
    .finally(() => patientInflight.delete(host));
  patientInflight.set(host, p);
  return p;
}

/**
 * Health for a real request. When the quick probe of a local Ollama timed out (it is busy, not
 * refused) and nothing recent is known, wait once, patiently, for it to answer; if it still does
 * not, the answer is "warming up", never "can't reach Ollama". A non-loopback host that times out
 * stays unreachable (an offline LAN machine must not look like a model loading). `signal` stops the
 * wait when the request goes away.
 */
async function healthForRequest(host, { patient, loopback, signal }) {
  const health = await untilAborted(getOllamaHealth(host, { loopback }), signal);
  if (health.running || health.error?.code !== 'timeout' || !loopback) return health;
  if (patient) {
    const cfg = aiEnvConfig();
    const waited = await untilAborted(sharedPatientProbe(host, cfg), signal);
    if (waited.running || waited.error?.code !== 'timeout') return waited;
  }
  throw new AiUnavailableError('ai_warming_up', MSG_WARMING_UP, HINT_WARMING_UP, AI_REASONS.warmingUp);
}

/**
 * Drop cached health (after a failed call, or a settings change). With a host it also forgets what
 * the last good probe of that host saw, so a model that went away is not reported as running.
 */
export function invalidateAiHealth(host) {
  if (host) {
    healthCache.delete(host);
    lastGoodHealth.delete(host);
  } else healthCache.clear();
}

/** Forget every remembered probe (the Ollama host setting changed: nothing known about the old host applies). */
export function forgetAiHealth() {
  healthCache.clear();
  lastGoodHealth.clear();
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

const findInstalled = (models, name) => {
  if (typeof name !== 'string' || !name.trim()) return null;
  const n = name.trim();
  return models.find((m) => m.name === n) || models.find((m) => m.name === `${n}:latest`) || null;
};

/**
 * Pick the model for a purpose: explicit (if installed) > saved setting > env > auto.
 * @returns {{ model: object | null, source: 'request'|'settings'|'env'|'auto', selected: string | null }}
 */
export function resolveModelChoice({ purpose, models, settings, env = process.env, explicit, maxParamsB }) {
  const text = models.filter(isTextModel);
  const needTools = purpose === 'tools';
  const fits = (m) => m && (!needTools || caps(m).includes('tools'));
  const selected = (needTools ? settings?.toolModel : settings?.chatModel) || null;
  const fromRequest = findInstalled(text, explicit);
  if (fits(fromRequest)) return { model: fromRequest, source: 'request', selected };
  const fromSettings = findInstalled(text, selected);
  if (fits(fromSettings)) return { model: fromSettings, source: 'settings', selected };
  const fromEnv = findInstalled(text, needTools ? env.BURROW_AI_TOOL_MODEL : env.BURROW_AI_CHAT_MODEL);
  if (fits(fromEnv)) return { model: fromEnv, source: 'env', selected };
  const auto = pickAutoModels(text, { maxParamsB });
  const name = needTools ? auto.tools : auto.chat;
  return { model: name ? findInstalled(text, name) : null, source: 'auto', selected };
}

/** Effective num_ctx: min(OLLAMA_NUM_CTX, the model's context length). */
export const effectiveNumCtx = (model, cfg = aiEnvConfig()) =>
  Math.max(512, Math.min(cfg.numCtx, Number(model?.contextLength) > 0 ? Number(model.contextLength) : Infinity));

async function resolveHostChecked(settings) {
  const resolved = resolveOllamaHost(settings);
  // Re-checked on every resolve, env-sourced hosts included.
  const allowed = resolved.loopback || (await isEnabled('aiLan'));
  return { ...resolved, allowed };
}

const lanOptInError = (host) =>
  new AiUnavailableError(
    'ollama_unavailable',
    `Using Ollama at ${host} needs the "Ollama on another computer" switch in Settings > Network.`,
    HINT_AI_LAN,
    AI_REASONS.optInRequired,
  );

/**
 * Right before a send to a non-loopback Ollama: the aiLan opt-in must still be on and the saved host must still be
 * the one this client was built for (a call can wait in the queue long after the client was made).
 * @param {string} capturedHost
 * @returns {Promise<void>}
 * @throws {AiUnavailableError} opt-in required
 */
async function assertLanStillAllowed(capturedHost) {
  const current = resolveOllamaHost(await getAiSettings());
  if (current.host !== capturedHost || current.loopback) throw lanOptInError(capturedHost);
  if (!(await isEnabled('aiLan'))) throw lanOptInError(capturedHost);
}

// Cloud is used only when every gate holds: provider chosen, opt-in on, a valid public https
// base URL, a model, a saved key, and a consent record that is current for this very host.
// Any failure (including unreadable storage) means local, never the reverse.
async function cloudConfig(settings) {
  if (settings.provider !== 'openai_compat') return null;
  const { baseUrl, model, tokenParam } = settings.cloud || {};
  if (!baseUrl || !model) return null;
  const url = validateCloudBaseUrl(baseUrl);
  if (!url.ok) return null;
  if (!(await isEnabled('cloudAi'))) return null;
  let consent;
  try {
    consent = await getCloudConsent();
  } catch {
    return null;
  }
  if (!isConsentCurrent(consent, url.hostname, url.url)) return null;
  const apiKey = await getSecret(CLOUD_KEY_NAME);
  if (!apiKey) return null;
  return { baseURL: baseUrl, model, apiKey, tokenParam: resolveTokenParam(baseUrl, tokenParam), host: url.hostname };
}

/**
 * Whether the saved setup still allows a cloud call right now (provider, opt-in, consent, key).
 * Long runs call this again before each model round. Any failure counts as no.
 * @returns {Promise<boolean>}
 */
export async function isCloudStillAllowed() {
  return (await getCurrentCloudConfig()) !== null;
}

/**
 * The cloud setup as it stands right now (same gates as a new client), or null. Never throws.
 * Includes the saved key, so it never leaves the AI module.
 * @returns {Promise<{ baseURL: string, model: string, apiKey: string, tokenParam: string, host: string } | null>}
 */
export async function getCurrentCloudConfig() {
  try {
    return await cloudConfig(await getAiSettings());
  } catch {
    return null;
  }
}

/**
 * Whether a cloud target captured when a client was built is still exactly what the user has
 * allowed now: same base URL, host and model, with a current consent for that URL.
 * @param {{ baseURL: string, host: string, model: string } | null | undefined} target
 * @returns {Promise<boolean>}
 */
export async function isCloudTargetCurrent(target) {
  const fresh = await getCurrentCloudConfig();
  return fresh !== null && sameCloudTarget(fresh, target);
}

function sameCloudTarget(fresh, target) {
  return !!target && fresh.baseURL === target.baseURL && fresh.host === target.host && fresh.model === target.model;
}

const NO_CATEGORIES = Object.freeze(Object.fromEntries(CLOUD_CATEGORY_IDS.map((id) => [id, false])));

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

let queue = null;
const getQueue = () => (queue ??= createQueueFromEnv());

/** True when every slot is busy and the wait list is full (a new call would get AiBusyError). */
export function isAiQueueFull() {
  const q = getQueue();
  return q.active >= q.concurrency && q.size >= q.max;
}

const abortError = () => Object.assign(new Error('Aborted'), { name: 'AbortError', aborted: true });

function timeoutError(kind) {
  const err = new Error(kind === 'first_token' ? 'No first token before the timeout' : 'Model call timed out');
  err.name = 'AiTimeoutError';
  err.code = 'timeout';
  err.isTimeout = true;
  err.httpStatus = 504;
  err.timeoutKind = kind;
  return err;
}

/**
 * Build an AiClient around a transport.
 * @param {{ provider: 'ollama'|'openai_compat', model: string, purpose: string, numCtx: number, host?: string,
 *   kind?: 'local'|'lan'|'cloud', aiHost?: string | null, policy?: import('./privacy.js').AiPolicy,
 *   transport: (opts: object) => AsyncIterable<object>, firstTokenApplies?: (opts: { tools?: object[] }) => boolean }} opts
 *   `firstTokenApplies` is false for calls whose transport does not stream (the cloud tool
 *   round answers all at once), so only the total timeout applies to them.
 *   `kind` defaults from the provider; `aiHost` is the cloud or LAN hostname (null for this
 *   computer); `policy` decides which data categories may be sent (cloud only).
 *   `authorizeSend(shared)` (required for a cloud client, else this throws) runs after the call
 *   left the queue and right before the request, with the category ids the call shares;
 *   it throws to stop the call (nothing sent) or returns the target handed to the transport as
 *   `opts.target`. Categories count as shared only once it passed. `cloudTarget` is the
 *   non-secret identity ({ baseURL, host, model }) the client was built for.
 *   Calls to a cloud client must pass `scope: { categories, withheld? }`; without it they throw
 *   a CloudScopeError before the transport is reached.
 */
export function createAiClient({ provider, model, purpose, numCtx, host, kind, aiHost, policy, transport, authorizeSend, cloudTarget, firstTokenApplies = () => true }) {
  const stats = { calls: 0 };
  const isCloud = provider === 'openai_compat';
  // A cloud client without the pre-send re-check could send on stale settings: never build one.
  if (isCloud && typeof authorizeSend !== 'function') throw new Error('A cloud AI client needs authorizeSend');
  const aiInfo = Object.freeze({ kind: kind ?? (isCloud ? 'cloud' : 'local'), host: aiHost ?? null });
  const activePolicy = policy ?? createAiPolicy({ isCloud, categories: null });
  const report = { shared: new Set(), withheld: new Set() };

  async function* events({ messages: rawMessages, tools: rawTools, scope, maxTokens = 1024, temperature, format, signal, timeoutMs, onWarming }) {
    // The choke point: nothing reaches the queue or the transport before the scope check.
    const enforced = enforceCloudScope({ messages: rawMessages, tools: rawTools, scope, policy: activePolicy });
    const { messages, tools } = enforced;
    if (isCloud) for (const c of enforced.withheld) report.withheld.add(c);
    const cfg = aiEnvConfig();
    if (signal?.aborted) throw abortError();
    const release = await getQueue().acquire({ signal });
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort();
    signal?.addEventListener?.('abort', onCallerAbort, { once: true });
    let timedOut = null;
    const firstTimer = firstTokenApplies({ tools })
      ? setTimeout(() => {
          timedOut = 'first_token';
          controller.abort();
        }, cfg.firstTokenMs)
      : null;
    const totalLimit = Number(timeoutMs) > 0 ? Math.min(Number(timeoutMs), cfg.totalMs) : cfg.totalMs;
    const totalTimer = setTimeout(() => {
      timedOut = timedOut || 'total';
      controller.abort();
    }, totalLimit);
    // A local model that has not produced a token yet is most likely loading: say so once, so a
    // slow first answer on a CPU-only machine looks like progress, not a hang. Never for cloud.
    const warmTimer =
      provider === 'ollama' && typeof onWarming === 'function' && cfg.warmingAfterMs < cfg.firstTokenMs
        ? setTimeout(() => {
            try {
              onWarming();
            } catch {
              /* a failing callback must not break the call */
            }
          }, cfg.warmingAfterMs)
        : null;
    firstTimer?.unref?.();
    totalTimer.unref?.();
    warmTimer?.unref?.();
    let first = true;
    let perfRecorded = false;
    const startedAt = Date.now();
    const recordPerf = (sample) => {
      if (provider !== 'ollama' || perfRecorded) return;
      perfRecorded = true;
      recordLocalCall(sample);
    };
    try {
      const target = authorizeSend ? await authorizeSend(enforced.shared) : undefined;
      const fitted = fitMessages(messages, { numCtx, maxTokens });
      // From here the request goes out, so only now do the call and its categories count.
      stats.calls += 1;
      if (isCloud) for (const c of enforced.shared) report.shared.add(c);
      for await (const ev of transport({ messages: fitted, tools, maxTokens, temperature, format, signal: controller.signal, target })) {
        if (first) {
          first = false;
          clearTimeout(firstTimer);
          clearTimeout(warmTimer);
          recordPerf({ firstTokenMs: Date.now() - startedAt, timedOut: false });
        }
        yield ev;
      }
    } catch (err) {
      if (timedOut) {
        recordPerf({ firstTokenMs: null, timedOut: true });
        // A local model that never produced a token may be gone or wedged: do not vouch for it from memory.
        if (provider === 'ollama' && timedOut === 'first_token') invalidateAiHealth(host);
        throw Object.assign(timeoutError(timedOut), { provider });
      }
      if (signal?.aborted) throw abortError();
      if (err instanceof AiUnavailableError) throw err;
      if (provider === 'ollama' && (err?.code === 'unavailable' || isConnectionError(err))) {
        invalidateAiHealth(host);
        throw new AiUnavailableError('ollama_unavailable', ollamaUnavailableMessage(host), HINT_START_OLLAMA, AI_REASONS.ollamaDown);
      }
      // Cloud connection failures classify as 'unavailable' with copy that names the endpoint.
      if (provider === 'openai_compat' && err && typeof err === 'object' && (err.code === 'unavailable' || isConnectionError(err))) {
        err.provider = 'openai_compat';
      }
      if (provider === 'ollama' && err?.code === 'model_missing') invalidateAiHealth(host);
      throw err;
    } finally {
      clearTimeout(firstTimer);
      clearTimeout(warmTimer);
      clearTimeout(totalTimer);
      signal?.removeEventListener?.('abort', onCallerAbort);
      release();
    }
  }

  return {
    provider,
    model,
    purpose,
    numCtx,
    stats,
    isCloud,
    cloudTarget: cloudTarget ? Object.freeze({ ...cloudTarget }) : null,
    /** Where this client sends data: { kind: 'local'|'lan'|'cloud', host: string|null }. */
    ai: aiInfo,
    policy: activePolicy,
    /** Record categories a caller withheld before building a call (no call may follow), names only. */
    noteWithheld: (ids) => {
      if (!isCloud) return;
      for (const id of Array.isArray(ids) ? ids : []) if (CLOUD_CATEGORY_IDS.includes(id)) report.withheld.add(id);
    },
    /** Category names sent and withheld across this client's calls so far (names only). */
    dataReport: () => ({
      shared: CLOUD_CATEGORY_IDS.filter((id) => report.shared.has(id)),
      withheld: CLOUD_CATEGORY_IDS.filter((id) => report.withheld.has(id)),
    }),

    /** One full completion. @returns {Promise<{ content: string, usage: object|null, finishReason: string|null, model: string }>} */
    async complete({ messages, maxTokens, temperature, format, signal, timeoutMs, scope, onWarming } = {}) {
      let content = '';
      let usage = null;
      let finishReason = null;
      for await (const ev of events({ messages, maxTokens, temperature, format, signal, timeoutMs, scope, onWarming })) {
        if (ev.type === 'token') {
          content += ev.text;
          // Bounded no matter what the server streams; leaving the loop releases the call.
          if (content.length >= MAX_CONTENT_CHARS) {
            content = content.slice(0, MAX_CONTENT_CHARS);
            finishReason = 'length';
            break;
          }
        } else if (ev.type === 'done') {
          usage = ev.usage;
          finishReason = ev.finishReason ?? null;
        }
      }
      return { content, usage, finishReason, model };
    },

    /** Token stream. Yields { type: 'token', text } then { type: 'done', usage, finishReason }. */
    async *stream({ messages, maxTokens, temperature, signal, timeoutMs, scope, onWarming } = {}) {
      for await (const ev of events({ messages, maxTokens, temperature, signal, timeoutMs, scope, onWarming })) {
        if (ev.type === 'token' || ev.type === 'done') yield ev;
      }
    },

    /**
     * One tool-calling turn. `onToken` (optional) receives content tokens as they stream.
     * @returns {Promise<{ message: { role: 'assistant', content: string, tool_calls?: object[] }, finishReason: string, usage: object|null, model: string }>}
     */
    async chatWithTools({ messages, tools, maxTokens, temperature, signal, timeoutMs, onToken, onToolCalls, scope, onWarming } = {}) {
      let content = '';
      const toolCalls = [];
      let usage = null;
      let finishReason = 'stop';
      for await (const ev of events({ messages, tools, maxTokens, temperature, signal, timeoutMs, scope, onWarming })) {
        if (ev.type === 'token') {
          content += ev.text;
          onToken?.(ev.text);
          if (content.length >= MAX_CONTENT_CHARS) {
            content = content.slice(0, MAX_CONTENT_CHARS);
            finishReason = 'length';
            break;
          }
        } else if (ev.type === 'tool_calls') {
          toolCalls.push(...ev.calls.slice(0, Math.max(0, MAX_TOOL_CALLS - toolCalls.length)));
          // Lets the caller stop a local round that keeps echoing the tool list after a parsed call.
          onToolCalls?.(ev.calls);
        } else if (ev.type === 'done') {
          usage = ev.usage;
          finishReason = ev.finishReason || finishReason;
        }
      }
      const message = { role: 'assistant', content };
      if (toolCalls.length) {
        message.tool_calls = toolCalls;
        finishReason = 'tool_calls';
      }
      return { message, finishReason, usage, model };
    },
  };
}

/**
 * Resolve and build the client for a purpose. Throws AiUnavailableError when AI is off,
 * Ollama is unreachable (or a remote host lacks the aiLan opt-in), or no model fits.
 * `allowCloud: false` never uses the cloud provider (used by the scheduled briefing).
 * A busy Ollama (a cold model load) is waited for once when `patient` (the default); status checks
 * pass `patient: false` so they never block. Either way it throws `ai_warming_up`, not `ollama_unavailable`.
 * The patient wait is one shared probe under a 30 s deadline and stops when `signal` aborts (the request closed).
 * @param {{ purpose?: 'chat'|'tools', model?: string, allowCloud?: boolean, patient?: boolean, signal?: AbortSignal }} [opts]
 */
export async function getAiClient({ purpose = 'chat', model: explicit, allowCloud = true, patient = true, signal } = {}) {
  if (!isAiEnabled()) throw new AiUnavailableError('ai_not_configured', MSG_AI_OFF, undefined, AI_REASONS.disabled);
  const settings = await getAiSettings();
  const cfg = aiEnvConfig();

  // A broken cloud setup (storage or secrets error) falls back to local, never the reverse.
  const cloud = allowCloud ? await cloudConfig(settings).catch(() => null) : null;
  if (cloud) {
    const categories = await getCloudCategories().catch(() => NO_CATEGORIES);
    return createAiClient({
      provider: 'openai_compat',
      kind: 'cloud',
      aiHost: cloud.host,
      policy: createAiPolicy({ isCloud: true, categories }),
      model: cloud.model,
      purpose,
      numCtx: CLOUD_NUM_CTX,
      cloudTarget: { baseURL: cloud.baseURL, host: cloud.host, model: cloud.model },
      // A call can wait minutes for its queue slot, and this client was built from the settings
      // of an earlier moment. Right before the request, read the current setup: it must still be
      // the same base URL, host and model with a current consent, else nothing is sent (a call
      // never goes to a destination the user has since left). The fresh key is the one used.
      authorizeSend: async (shared = []) => {
        const fresh = await getCurrentCloudConfig();
        if (!fresh || !sameCloudTarget(fresh, cloud)) throw new CloudScopeError('cloud_disabled');
        // The categories were enforced against the policy built with this client, possibly minutes
        // ago. Read the current choices now; an unreadable setting is a refusal, never a send.
        const current = await getCloudCategories().catch(() => null);
        if (!current) throw new CloudScopeError('cloud_scope_denied', [...shared]);
        const denied = shared.filter((c) => !current[c]);
        if (denied.length) throw new CloudScopeError('cloud_scope_denied', denied);
        return fresh;
      },
      transport: (o) => {
        const { target, ...rest } = o;
        return openaiCompatChatStream({ ...rest, baseURL: target.baseURL, apiKey: target.apiKey, model: target.model, tokenParam: target.tokenParam });
      },
      // Tool rounds use a non-streaming request: only the total timeout applies.
      firstTokenApplies: ({ tools }) => !(Array.isArray(tools) && tools.length),
    });
  }

  const { host, allowed, loopback } = await resolveHostChecked(settings);
  if (!allowed) {
    throw new AiUnavailableError(
      'ollama_unavailable',
      `Using Ollama at ${host} needs the "Ollama on another computer" switch in Settings > Network.`,
      HINT_AI_LAN,
      AI_REASONS.optInRequired,
    );
  }
  const health = await healthForRequest(host, { patient, loopback, signal });
  if (!health.running) {
    throw new AiUnavailableError('ollama_unavailable', ollamaUnavailableMessage(host), health.error?.hint || HINT_START_OLLAMA, AI_REASONS.ollamaDown);
  }
  const choice = resolveModelChoice({ purpose, models: health.models, settings, explicit, maxParamsB: cfg.autoMaxParamsB });
  if (!choice.model) {
    const noTools = purpose === 'tools' && health.models.some(isTextModel);
    throw new AiUnavailableError(
      'ai_not_configured',
      noTools ? MSG_NO_TOOL_MODEL : MSG_NO_MODEL,
      undefined,
      noTools ? AI_REASONS.noToolModel : AI_REASONS.noModel,
    );
  }
  const numCtx = effectiveNumCtx(choice.model, cfg);
  const modelName = choice.model.name;
  return createAiClient({
    provider: 'ollama',
    kind: loopback ? 'local' : 'lan',
    aiHost: loopback ? null : new URL(host).hostname,
    model: modelName,
    purpose,
    numCtx,
    host,
    // Another computer: re-check the opt-in and the host right before each send. This computer needs neither.
    authorizeSend: loopback ? undefined : () => assertLanStillAllowed(host),
    transport: (o) =>
      ollamaChatStream({
        host,
        model: modelName,
        messages: o.messages,
        tools: o.tools,
        numCtx,
        numPredict: Math.min(Number(o.maxTokens) > 0 ? Number(o.maxTokens) : 1024, Math.floor(numCtx / 2)),
        temperature: o.temperature,
        keepAlive: cfg.keepAlive,
        format: o.format,
        signal: o.signal,
      }),
  });
}

/**
 * Client for the Folders search model (nomic-embed-text). It ONLY ever talks to Ollama, on this computer or
 * (with the aiLan opt-in) another one, and never to a cloud provider, whatever the chat provider is.
 * Each embed() call takes a slot in the shared AI queue, so global AI concurrency stays 1.
 * Throws AiUnavailableError: ai_not_configured with reason `no_embed_model` when the model is not installed,
 * `ollama_unavailable` / `ai_warming_up` as for chat.
 * @param {{ signal?: AbortSignal, patient?: boolean }} [opts]
 * @returns {Promise<{ model: string, host: string, ai: { kind: 'local'|'lan', host: string|null },
 *   stats: { calls: number }, embed: (opts: { inputs: string[], signal?: AbortSignal }) => Promise<Float32Array[]> }>}
 */
export async function getEmbedClient({ signal, patient = true } = {}) {
  if (!isAiEnabled()) throw new AiUnavailableError('ai_not_configured', MSG_AI_OFF, undefined, AI_REASONS.disabled);
  const settings = await getAiSettings();
  const cfg = aiEnvConfig();
  const { host, allowed, loopback } = await resolveHostChecked(settings);
  if (!allowed) throw lanOptInError(host);
  const health = await healthForRequest(host, { patient, loopback, signal });
  if (!health.running) {
    throw new AiUnavailableError('ollama_unavailable', ollamaUnavailableMessage(host), health.error?.hint || HINT_START_OLLAMA, AI_REASONS.ollamaDown);
  }
  // Matched against every installed model, not only the text ones.
  const installed = findInstalled(health.models, EMBED_MODEL);
  if (!installed) throw new AiUnavailableError('ai_not_configured', MSG_NO_EMBED_MODEL, undefined, AI_REASONS.noEmbedModel);
  const modelName = installed.name;
  const stats = { calls: 0 };
  const ai = Object.freeze({ kind: loopback ? 'local' : 'lan', host: loopback ? null : new URL(host).hostname });
  return {
    model: modelName,
    host,
    ai,
    stats,
    async embed({ inputs, signal: callSignal } = {}) {
      if (!Array.isArray(inputs) || inputs.length === 0) return [];
      if (callSignal?.aborted) throw abortError();
      const release = await getQueue().acquire({ signal: callSignal });
      try {
        if (!loopback) await assertLanStillAllowed(host);
        stats.calls += 1;
        return await ollamaEmbed(host, modelName, inputs, { signal: callSignal, timeoutMs: EMBED_TIMEOUT_MS, keepAlive: cfg.keepAlive });
      } catch (err) {
        if (callSignal?.aborted) throw abortError();
        if (err instanceof AiUnavailableError) throw err;
        if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw Object.assign(timeoutError('total'), { provider: 'ollama' });
        if (err?.code === 'model_missing') {
          invalidateAiHealth(host);
          throw new AiUnavailableError('ai_not_configured', MSG_NO_EMBED_MODEL, undefined, AI_REASONS.noEmbedModel);
        }
        if (err?.code === 'unavailable' || isConnectionError(err)) {
          invalidateAiHealth(host);
          throw new AiUnavailableError('ollama_unavailable', ollamaUnavailableMessage(host), HINT_START_OLLAMA, AI_REASONS.ollamaDown);
        }
        throw err;
      } finally {
        release();
      }
    },
  };
}

/**
 * Availability summary for status endpoints. Never throws.
 * @param {'chat'|'tools'} [purpose]
 * `code` is the 503 error code; `reason` the finer cause (ai_disabled, no_model,
 * no_tool_model, network_opt_in_required, ollama_unavailable).
 * Adds `ai` ({ kind, host }) and `cloudHint` ({ show, reason }).
 * @returns {Promise<{ available: boolean, provider: string, effectiveProvider: string, model: string|null, ai: { kind: string, host: string|null }, cloudHint: { show: boolean, reason: string|null }, code?: string, reason?: string, message?: string }>}
 */
export async function describeAi(purpose = 'chat') {
  try {
    const client = await getAiClient({ purpose, patient: false });
    const ai = client.ai ?? { kind: 'local', host: null };
    const cloudHint = await getCloudHint({ ai, available: true }).catch(() => ({ ...NO_CLOUD_HINT }));
    return { available: true, provider: client.provider, effectiveProvider: client.provider, model: client.model, ai, cloudHint };
  } catch (err) {
    const unavailable = err instanceof AiUnavailableError;
    return {
      available: false,
      provider: 'ollama',
      effectiveProvider: 'ollama',
      model: null,
      ai: { kind: 'local', host: null },
      cloudHint: { ...NO_CLOUD_HINT },
      code: unavailable ? err.code : 'ai_not_configured',
      reason: unavailable ? err.reason : AI_REASONS.noModel,
      ...(typeof err?.publicMessage === 'string' ? { message: err.publicMessage } : {}),
    };
  }
}

/**
 * Installed models (fresh probe). Throws AiUnavailableError when Ollama is unreachable.
 * @returns {Promise<object[]>}
 */
export async function listInstalledModels() {
  const settings = await getAiSettings();
  const { host, allowed, loopback } = await resolveHostChecked(settings);
  if (!allowed) {
    throw new AiUnavailableError(
      'ollama_unavailable',
      `Using Ollama at ${host} needs the "Ollama on another computer" switch in Settings > Network.`,
      HINT_AI_LAN,
      AI_REASONS.optInRequired,
    );
  }
  const health = await getOllamaHealth(host, { fresh: true, loopback });
  if (!health.running) {
    throw new AiUnavailableError('ollama_unavailable', ollamaUnavailableMessage(host), health.error?.hint || HINT_START_OLLAMA, AI_REASONS.ollamaDown);
  }
  return health.models;
}

/**
 * The GET /api/settings/ai payload (fresh probe, 3 s timeout).
 * @param {{ fresh?: boolean }} [opts]
 */
export async function getAiStatus({ fresh = true } = {}) {
  const settings = await getAiSettings();
  const cfg = aiEnvConfig();
  const { host, hostSource, loopback, allowed } = await resolveHostChecked(settings);
  const enabled = isAiEnabled();
  let health = { running: false, version: null, models: [], error: probeError('opt_in_required') };
  // BURROW_AI=0: report the settings only; nothing is probed.
  if (!enabled) health = { running: false, version: null, models: [], error: null };
  else if (allowed) health = await getOllamaHealth(host, { fresh, loopback });
  const describe = (purpose) => {
    const choice = resolveModelChoice({ purpose, models: health.models, settings, maxParamsB: cfg.autoMaxParamsB });
    return {
      selected: choice.selected,
      effective: choice.model?.name ?? null,
      source: choice.source === 'request' ? 'auto' : choice.source,
    };
  };
  const optIn = await isEnabled('cloudAi').catch(() => false);
  const keySaved = await getSecret(CLOUD_KEY_NAME).then(
    (v) => !!v,
    () => false,
  );
  // What a call would use right now: the cloud only when it is fully set up and allowed.
  const effectiveProvider = (await cloudConfig(settings).catch(() => null)) ? 'openai_compat' : 'ollama';
  let consent = null;
  try {
    consent = await getCloudConsent();
  } catch {
    /* unreadable consent counts as none */
  }
  const cloudCheck = settings.cloud.baseUrl ? validateCloudBaseUrl(settings.cloud.baseUrl) : null;
  const cloudHost = cloudCheck?.ok ? cloudCheck.hostname : null;
  const categories = await getCloudCategories().catch(() => resolveCloudCategories(null));
  return {
    enabled,
    provider: settings.provider,
    effectiveProvider,
    ollama: {
      host,
      hostSource,
      loopback,
      running: health.running,
      version: health.version,
      numCtx: cfg.numCtx,
      error: health.error,
    },
    models: { chat: describe('chat'), tools: describe('tools') },
    cloud: {
      optIn,
      keySaved,
      baseUrl: settings.cloud.baseUrl,
      host: cloudHost,
      model: settings.cloud.model,
      tokenParam: resolveTokenParam(settings.cloud.baseUrl, settings.cloud.tokenParam),
      ready: !!(settings.cloud.baseUrl && settings.cloud.model && keySaved),
      consent: {
        current: isConsentCurrent(consent, cloudHost, cloudCheck?.ok ? cloudCheck.url : null),
        acceptedAt: consent?.acceptedAt || null,
        host: consent?.host ?? null,
        version: consent?.version ?? null,
      },
      consentVersion: CLOUD_CONSENT_VERSION,
      categories,
      active: effectiveProvider === 'openai_compat',
    },
  };
}

// ---------------------------------------------------------------------------
// First-run setup: status snapshot and model download
// ---------------------------------------------------------------------------

/** Idle limit between upstream pull frames. Override with BURROW_AI_PULL_IDLE_MS (tests). */
export const DEFAULT_PULL_IDLE_MS = 60_000;
/** Wall-clock cap for one download. Override with BURROW_AI_PULL_MAX_MS (tests). */
export const DEFAULT_PULL_MAX_MS = 2 * 60 * 60 * 1000;

/** A failed or stalled model download. `code` is the public code; the message is fixed copy. */
export class PullError extends Error {
  /** @param {'pull_failed'|'timeout'|'pull_requires_local_ollama'} code */
  constructor(code) {
    super(code);
    this.name = 'PullError';
    this.code = code;
  }
}

/**
 * Where a download would go: the configured Ollama host and whether it is on this machine.
 * @returns {Promise<{ host: string, loopback: boolean }>}
 */
export async function getPullTarget() {
  const { host, loopback } = resolveOllamaHost(await getAiSettings());
  return { host, loopback };
}

/**
 * Everything the first-run setup endpoint needs, from one (fresh) probe. Never throws on an
 * unreachable Ollama.
 * @returns {Promise<{ enabled: boolean, effectiveProvider: string, host: string, loopback: boolean,
 *   running: boolean, version: string | null, errorCode: string | null,
 *   models: Array<{ name: string, sizeBytes?: number }>, chatModel: string | null }>}
 */
export async function getAiSetupSnapshot() {
  const settings = await getAiSettings();
  const cfg = aiEnvConfig();
  const { host, loopback, allowed } = await resolveHostChecked(settings);
  const enabled = isAiEnabled();
  let health = { running: false, version: null, models: [], error: null };
  if (enabled && allowed) health = await getOllamaHealth(host, { fresh: true, loopback });
  const choice = resolveModelChoice({ purpose: 'chat', models: health.models, settings, maxParamsB: cfg.autoMaxParamsB });
  const effectiveProvider = (await cloudConfig(settings).catch(() => null)) ? 'openai_compat' : 'ollama';
  return {
    enabled,
    effectiveProvider,
    host,
    loopback,
    running: health.running,
    version: health.version,
    errorCode: health.error?.code ?? null,
    models: health.models.map((m) => ({ name: m.name, ...(Number.isFinite(m.sizeBytes) ? { sizeBytes: m.sizeBytes } : {}) })),
    chatModel: choice.model?.name ?? null,
  };
}

/** Map an upstream pull status line to a public phase (null: not worth reporting). */
function pullPhase(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'pulling manifest') return 'manifest';
  if (s.startsWith('pulling')) return 'downloading';
  if (s.startsWith('verifying')) return 'verifying';
  if (s === 'writing manifest' || s.startsWith('removing')) return 'finalizing';
  return null;
}

/**
 * Download `model` into the local Ollama. Yields { phase, completed, total } (phase is
 * 'manifest' | 'downloading' | 'verifying' | 'finalizing'; the numbers are summed across all
 * layers seen so far and never decrease); returns when Ollama reports
 * success. Upstream text is never passed on. Throws AbortError when `signal` aborts, and
 * PullError ('timeout' after `idleMs` without progress or `maxMs` overall, 'pull_failed'
 * otherwise, or 'pull_requires_local_ollama' for a non-loopback host). Only frames that make
 * progress (completed grows, the phase changes, a new layer starts) re-arm the idle timer.
 * Invalidates the health cache when done.
 * @param {{ model: string, signal?: AbortSignal, idleMs?: number, maxMs?: number }} opts
 * @returns {AsyncGenerator<{ phase: string, completed: number, total: number }, void>}
 */
export async function* pullModel({ model, signal, idleMs, maxMs }) {
  const { host, loopback } = await getPullTarget();
  if (!loopback) throw new PullError('pull_requires_local_ollama');
  const idle = idleMs > 0 ? idleMs : num(process.env.BURROW_AI_PULL_IDLE_MS, DEFAULT_PULL_IDLE_MS);
  const cap = maxMs > 0 ? maxMs : num(process.env.BURROW_AI_PULL_MAX_MS, DEFAULT_PULL_MAX_MS);
  const ctl = new AbortController();
  let timedOut = false;
  let timer = null;
  let armedAt = 0;
  let idleLeft = idle;
  const disarm = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const arm = (ms) => {
    disarm();
    idleLeft = ms;
    armedAt = Date.now();
    timer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, ms);
    timer.unref?.();
  };
  // Wall clock for the whole download; never re-armed.
  const wall = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, cap);
  wall.unref?.();
  let lastPhase = null;
  let lastCompleted = -1;
  const relay = () => ctl.abort();
  if (signal?.aborted) ctl.abort();
  else signal?.addEventListener('abort', relay, { once: true });
  // Rejects on abort so a stalled body that ignores the signal cannot hold the loop.
  const aborted = new Promise((_resolve, reject) => {
    const fire = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (ctl.signal.aborted) fire();
    else ctl.signal.addEventListener('abort', fire, { once: true });
  });
  aborted.catch(() => {});
  const it = ollamaPullStream(host, model, { signal: ctl.signal })[Symbol.asyncIterator]();
  let success = false;
  // Ollama reports one progress stream per layer. Sum them so the overall numbers only grow.
  const layers = new Map();
  const overall = () => {
    let completed = 0;
    let total = 0;
    for (const layer of layers.values()) {
      completed += layer.completed;
      total += layer.total;
    }
    return { completed, total };
  };
  try {
    arm(idle);
    while (true) {
      const r = await Promise.race([it.next(), aborted]);
      if (r.done) break;
      const frame = r.value;
      if (typeof frame.error === 'string') throw new PullError('pull_failed');
      if (frame.status === 'success') {
        success = true;
        break;
      }
      const phase = pullPhase(frame.status);
      // Unknown statuses never count as progress, so a silent squatter cannot hold the lock.
      if (!phase) continue;
      let progressed = phase !== lastPhase;
      if (phase === 'downloading') {
        const key = typeof frame.digest === 'string' && frame.digest ? frame.digest : String(frame.status);
        if (!layers.has(key)) progressed = true;
        const prev = layers.get(key) ?? { completed: 0, total: 0 };
        const total = Math.max(prev.total, Number(frame.total) || 0);
        const completed = Math.min(total || Infinity, Math.max(prev.completed, Number(frame.completed) || 0));
        layers.set(key, { completed, total });
      }
      const now = overall();
      if (now.completed > lastCompleted && phase === 'downloading') progressed = true;
      lastPhase = phase;
      if (phase === 'downloading') lastCompleted = now.completed;
      // The consumer may be slow; only upstream silence counts toward the idle limit.
      const left = progressed ? idle : Math.max(1, idleLeft - (Date.now() - armedAt));
      disarm();
      yield { phase, ...now };
      arm(left);
    }
  } catch (err) {
    if (timedOut) throw new PullError('timeout');
    if (err instanceof PullError || signal?.aborted) throw err;
    throw new PullError('pull_failed');
  } finally {
    disarm();
    clearTimeout(wall);
    signal?.removeEventListener('abort', relay);
    ctl.abort();
    Promise.resolve(it.return?.()).catch(() => {});
    invalidateAiHealth(host);
  }
  if (!success) throw new PullError('pull_failed');
}

/** Test hook: drop caches and the queue. */
export function __resetAiForTests() {
  healthCache.clear();
  healthInflight.clear();
  patientInflight.clear();
  lastGoodHealth.clear();
  showCache.clear();
  queue = null;
}
