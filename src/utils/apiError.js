// Shared handling for the two structured error bodies the Burrow server sends:
//   403 { error: 'network_opt_in_required', feature, message }  (gated outbound feature is off)
//   503 { error: 'ai_not_configured', reason, message }        (AI is off or no model installed)
//   503 { error: 'ollama_unavailable', reason, message, hint } (Ollama is not reachable)
// `reason` is the finer cause: ai_disabled, no_model, no_tool_model, network_opt_in_required,
// ollama_unavailable. The UI keys "AI is turned off" off reason ai_disabled, never the text.
//   429 { error: 'ai_busy', message }                          (too many queued AI requests)
//   409 { error: 'conversation_busy', message }                (another Javi run is active in this chat)
//   501 { error: 'pro_not_included', code, feature, message }  (this build does not include the private module)
// `message` is the human text. A bare `error` string is only shown when it is a known code with
// friendly copy below; raw `error` strings are never rendered.

export const NETWORK_OPT_IN_REQUIRED = 'network_opt_in_required';
export const AI_NOT_CONFIGURED = 'ai_not_configured';
export const OLLAMA_UNAVAILABLE = 'ollama_unavailable';
export const AI_BUSY = 'ai_busy';
/** 501 { error: 'pro_not_included', code, feature, message }: this build does not include the private module. */
export const PRO_NOT_INCLUDED = 'pro_not_included';
/** Status/503 reason when the server runs with BURROW_AI=0. */
export const AI_DISABLED = 'ai_disabled';
export const AI_BUSY_MESSAGE = 'Javi is busy with another request. Try again in a moment.';

const STRUCTURED_CODES = new Set([
  NETWORK_OPT_IN_REQUIRED,
  AI_NOT_CONFIGURED,
  OLLAMA_UNAVAILABLE,
  AI_BUSY,
  PRO_NOT_INCLUDED,
]);

// Known bare error codes and the copy to show for them.
const FRIENDLY_CODES = {
  action_not_found: 'That request expired or was already handled. Ask Javi again.',
  write_cap_reached: 'Javi has reached its limit for changes in this conversation. Start a new conversation to continue.',
  invalid_body: 'That request was not valid. Check what you entered and try again.',
  conversation_busy: 'Javi is still answering in this conversation. Wait for it to finish, then ask again.',
};

/** Generic copy for a failure that has no deliberate user-facing text. */
export const GENERIC_ERROR = "Burrow couldn't finish that. Try again.";

/** Human text from an error response body, or null when the body carries none. */
function bodyText(body) {
  if (body && typeof body === 'object') {
    if (body.error === AI_BUSY) return AI_BUSY_MESSAGE;
    if (typeof body.message === 'string' && body.message) return body.message;
    if (typeof body.error === 'string' && Object.hasOwn(FRIENDLY_CODES, body.error)) {
      return FRIENDLY_CODES[body.error];
    }
  }
  return null;
}

/** Human-readable text for an error response body, with a fallback for unknown shapes. */
export function errorText(body, fallback) {
  return bodyText(body) ?? fallback;
}

/** Error whose message is deliberate copy that is safe to show as is (`userFacing`). */
export function userError(message) {
  const err = new Error(message);
  err.userFacing = true;
  return err;
}

/**
 * The text to show for a caught error: its message only when it is deliberate copy
 * (`userFacing`), else the fallback. Raw statusText, network or runtime messages never render.
 */
export function userMessage(err, fallback = GENERIC_ERROR) {
  return err?.userFacing === true && err.message ? err.message : fallback;
}

/**
 * Error carrying `status`, plus `code`/`feature` for the structured bodies above.
 * `userFacing` is set only when the text came from the server's human copy, not the fallback.
 */
export function buildApiError(response, body) {
  const text = bodyText(body);
  const err = new Error(text ?? GENERIC_ERROR);
  if (text !== null) err.userFacing = true;
  err.status = response.status;
  if (body && STRUCTURED_CODES.has(body.error)) err.code = body.error;
  if (body && typeof body.feature === 'string') err.feature = body.feature;
  if (body && typeof body.hint === 'string') err.hint = body.hint;
  if (body && typeof body.reason === 'string') err.reason = body.reason;
  return err;
}

export const isNetworkOptInError = (err) => err?.code === NETWORK_OPT_IN_REQUIRED;

/** True when Javi cannot run because AI is off, has no model, or Ollama is unreachable. */
export const isAiUnavailableError = (err) =>
  err?.code === AI_NOT_CONFIGURED || err?.code === OLLAMA_UNAVAILABLE;

/** True when the server answered 501 pro_not_included: the build does not include the private module. */
export const isProNotIncludedError = (err) => err?.code === PRO_NOT_INCLUDED;
