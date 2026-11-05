import { ProRequiredError } from '../pro.js';
// The single definition of "can AI run right now", plus the user-facing error bodies.
// isAiEnabled() is the license seam: every AI entry point goes through it.

export const MSG_AI_OFF = 'AI is turned off.';
export const MSG_NO_MODEL =
  'No AI model is installed. Run "ollama pull qwen2.5:7b", then pick it in Settings > AI.';
export const MSG_NO_TOOL_MODEL =
  'No installed model supports tools. Run "ollama pull qwen2.5:7b", then pick it in Settings > AI.';
export const MSG_WARMING_UP =
  'Javi is warming up. Ollama is still loading the model, which can take a minute on this computer. Wait a moment, then try again.';
export const HINT_WARMING_UP = 'You do not need to change anything. The first answer after starting can take a minute.';
/** SSE `status` copy while a local model has not produced its first token yet. */
export const MSG_WARMING_STATUS = 'Javi is thinking. On this computer the first answer can take a minute.';
export const MSG_NO_EMBED_MODEL =
  'Questions need the nomic-embed-text model. Download it on the Folders page, then click Re-scan.';
export const MSG_AI_BUSY = 'Javi is busy with another request. Try again in a moment.';
export const HINT_START_OLLAMA = 'Install Ollama from ollama.com, open it, then reload this page.';
export const HINT_AI_LAN =
  'This Ollama is on another computer. Turn on "Ollama on another computer" in Settings > Network.';

/**
 * Message shown when Ollama cannot be reached.
 * @param {string} host Ollama origin, e.g. http://127.0.0.1:11434.
 * @returns {string}
 */
export const ollamaUnavailableMessage = (host) =>
  `Javi can't reach Ollama at ${host}. Open the Ollama app or run "ollama serve", then try again.`;

// isAiEnabled() answers only "can AI run". Pro gating is a separate, capability-based check in
// server/pro.js (requirePro / assertPro): Javi's read-only page advice stays free, while Javi
// tools, briefings and Explain also need Pro. Order a route as requirePro, then requireAi.
/**
 * Whether AI features may run at all. Synchronous; BURROW_AI=0 turns every AI route off.
 * @returns {boolean}
 */
export function isAiEnabled() {
  return (process.env.BURROW_AI ?? '').trim() !== '0';
}

/**
 * Why AI cannot run, finer than the 503 `error` code (which stays ai_not_configured or
 * ollama_unavailable for compatibility). The UI keys its copy off this, not the message text.
 */
export const AI_REASONS = Object.freeze({
  disabled: 'ai_disabled', // BURROW_AI=0
  noModel: 'no_model', // nothing installed that can chat
  noToolModel: 'no_tool_model', // nothing installed that supports tools
  optInRequired: 'network_opt_in_required', // non-loopback Ollama host without the aiLan opt-in
  ollamaDown: 'ollama_unavailable', // Ollama did not answer
  warmingUp: 'ai_warming_up', // Ollama answered nothing in time while busy (a cold model load), not refused
  noEmbedModel: 'no_embed_model', // the search model for Folders questions is not installed
});

const DEFAULT_REASON = {
  ai_not_configured: AI_REASONS.noModel,
  ollama_unavailable: AI_REASONS.ollamaDown,
  ai_warming_up: AI_REASONS.warmingUp,
};

/** AI cannot run: turned off, no model, Ollama unreachable, or Ollama still warming up. Always a 503. */
export class AiUnavailableError extends Error {
  /**
   * @param {'ai_not_configured'|'ollama_unavailable'|'ai_warming_up'} code
   * @param {string} publicMessage Fixed, user-safe text.
   * @param {string} [hint] Optional next step.
   * @param {string} [reason] One of AI_REASONS; defaults from `code`.
   */
  constructor(code, publicMessage, hint, reason) {
    super(publicMessage);
    this.name = 'AiUnavailableError';
    this.code = code;
    this.reason = reason || DEFAULT_REASON[code] || AI_REASONS.noModel;
    this.httpStatus = 503;
    this.publicMessage = publicMessage;
    if (hint) this.hint = hint;
  }
}

/** The AI queue is full or the wait timed out. Always a 429. */
export class AiBusyError extends Error {
  constructor() {
    super(MSG_AI_BUSY);
    this.name = 'AiBusyError';
    this.code = 'ai_busy';
    this.httpStatus = 429;
    this.publicMessage = MSG_AI_BUSY;
  }
}

/** @param {unknown} err @returns {boolean} */
export const isAiUnavailableError = (err) => err instanceof AiUnavailableError;

/**
 * JSON body for an AiUnavailableError, AiBusyError or ProRequiredError (Pro ended after the route
 * gate), or null for anything else.
 * @param {unknown} err
 * @returns {{ error: string, reason?: string, feature?: string, message: string, hint?: string } | null}
 */
export function aiErrorBody(err) {
  if (err instanceof ProRequiredError) {
    return { error: 'pro_required', feature: err.feature, ...(err.reason ? { reason: err.reason } : {}), message: err.publicMessage };
  }
  if (err instanceof AiUnavailableError) {
    return { error: err.code, reason: err.reason, message: err.publicMessage, ...(err.hint ? { hint: err.hint } : {}) };
  }
  if (err instanceof AiBusyError) return { error: 'ai_busy', message: err.publicMessage };
  return null;
}

/**
 * Send a structured AI error. Call before any SSE headers are written.
 * Returns null (and sends nothing) when `err` is not an AI availability error, so the
 * caller can fall through to its own handling.
 * @param {import('express').Response} res
 * @param {unknown} err
 * @returns {import('express').Response | null}
 */
export function sendAiError(res, err) {
  const body = aiErrorBody(err);
  if (!body) return null;
  res.set('Cache-Control', 'no-store');
  return res.status(err.httpStatus).json(body);
}
