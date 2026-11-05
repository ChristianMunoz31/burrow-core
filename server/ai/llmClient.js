// OpenAI-compatible Chat Completions client (cloud AI, opt-in only). The caller passes the
// full endpoint URL (built in providers/openaiCompat.js from the configured base URL); the
// key is sent only there, redirects are refused, and response bodies are never put in
// error messages or logs (they are kept on err.body for classification only).
import fetch from 'node-fetch';
import { resolveTokenParam } from './settings.js';
import { cloudHttpsAgent } from './cloudGuard.js';
import {
  BodyTooLargeError,
  MAX_ERROR_BODY_BYTES,
  MAX_JSON_BODY_BYTES,
  MAX_LINE_CHARS,
  readCappedJson,
  readCappedText,
} from './bodyCap.js';

const MAX_ERROR_BODY_CHARS = 2000;

const toUsage = (u) =>
  u
    ? {
        input_tokens: Number(u.prompt_tokens) || 0,
        output_tokens: Number(u.completion_tokens) || 0,
        total_tokens: Number(u.total_tokens) || 0,
      }
    : null;

async function postChat({ url, apiKey, payload, signal }) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      signal,
      redirect: 'error',
      // Connect-time SSRF guard: refuses any address that is not public (ECLOUDPRIVATE).
      agent: cloudHttpsAgent(),
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    // A refused private address and any other connection failure are both just "unavailable";
    // the cause stays on err.cause and is never shown.
    throw Object.assign(new Error('Cloud AI request failed'), { code: 'unavailable', provider: 'openai_compat', cause: err });
  }
  if (!res.ok) {
    const body = await readCappedText(res, MAX_ERROR_BODY_BYTES, { truncate: true }).catch(() => '');
    const err = new Error(`Cloud AI HTTP ${res.status}`);
    err.httpStatus = res.status;
    err.provider = 'openai_compat';
    err.body = String(body).slice(0, MAX_ERROR_BODY_CHARS);
    const retryAfter = res.headers?.get?.('retry-after');
    if (retryAfter) {
      const secs = Number(retryAfter);
      if (Number.isFinite(secs)) err.retryAfterMs = secs * 1000;
    }
    throw err;
  }
  return res;
}

/**
 * Build the request payload. The token limit goes in max_tokens unless the endpoint
 * needs max_completion_tokens (saved choice, or auto for api.openai.com).
 * @param {{ baseURL: string, model: string, messages: object[], tools?: object[], maxTokens?: number,
 *   temperature?: number, tokenParam?: string|null, format?: 'json', stream: boolean }} opts
 * @returns {object}
 */
export function buildPayload({ baseURL, model, messages, tools, maxTokens, temperature, tokenParam, format, stream }) {
  const payload = { model, messages, stream };
  if (Number.isFinite(temperature)) payload.temperature = temperature;
  if (Number.isFinite(maxTokens) && maxTokens > 0) payload[resolveTokenParam(baseURL, tokenParam)] = maxTokens;
  if (Array.isArray(tools) && tools.length) {
    payload.tools = tools;
    payload.tool_choice = 'auto';
  }
  if (format === 'json') payload.response_format = { type: 'json_object' };
  return payload;
}

/**
 * Non-streaming chat (used for tool calls). Returns the whole assistant message.
 * @returns {Promise<{ message: object, finishReason: string, usage: object|null }>}
 */
export async function chatWithTools({ url, baseURL, apiKey, signal, ...rest }) {
  const res = await postChat({ url, apiKey, signal, payload: buildPayload({ baseURL, ...rest, stream: false }) });
  let data;
  try {
    data = await readCappedJson(res, MAX_JSON_BODY_BYTES);
  } catch (err) {
    if (err?.name === 'AbortError' || err instanceof BodyTooLargeError) throw err;
    throw Object.assign(new Error('Cloud AI returned invalid JSON'), { code: 'bad_response', provider: 'openai_compat' });
  }
  const choice = data?.choices?.[0];
  const src = choice?.message || {};
  const message = { role: 'assistant', content: typeof src.content === 'string' ? src.content : '' };
  if (Array.isArray(src.tool_calls) && src.tool_calls.length) message.tool_calls = src.tool_calls;
  return { message, finishReason: choice?.finish_reason || 'stop', usage: toUsage(data?.usage) };
}

/**
 * Streaming chat via SSE. Yields { type: 'token', text } then { type: 'done', usage, finishReason }.
 */
export async function* streamChat({ url, baseURL, apiKey, signal, ...rest }) {
  const res = await postChat({ url, apiKey, signal, payload: buildPayload({ baseURL, ...rest, stream: true }) });
  let finishReason = 'stop';
  let usage = null;
  const body = res.body;
  if (!body || typeof body[Symbol.asyncIterator] !== 'function') {
    const text = typeof res.text === 'function' ? await readCappedText(res, MAX_JSON_BODY_BYTES) : '';
    yield* parseSseText(text);
    return;
  }
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      const ev = parseSseLine(line);
      if (!ev) continue;
      if (ev.done) {
        yield { type: 'done', usage, finishReason };
        return;
      }
      if (ev.text) yield { type: 'token', text: ev.text };
      if (ev.finishReason) finishReason = ev.finishReason;
      if (ev.usage) usage = ev.usage;
    }
    // An SSE line that never ends is not a Chat Completions stream.
    if (buf.length > MAX_LINE_CHARS) {
      try {
        body.destroy?.();
      } catch {
        /* ignore */
      }
      throw new BodyTooLargeError('stream line');
    }
  }
  yield { type: 'done', usage, finishReason };
}

function parseSseLine(line) {
  if (!line.startsWith('data:')) return null;
  const data = line.slice(5).trim();
  if (data === '[DONE]') return { done: true };
  try {
    const obj = JSON.parse(data);
    const choice = obj?.choices?.[0];
    return {
      text: typeof choice?.delta?.content === 'string' ? choice.delta.content : '',
      finishReason: choice?.finish_reason || null,
      usage: toUsage(obj?.usage),
    };
  } catch {
    return null;
  }
}

function* parseSseText(text) {
  let finishReason = 'stop';
  let usage = null;
  for (const raw of text.split('\n')) {
    const ev = parseSseLine(raw.trim());
    if (!ev) continue;
    if (ev.done) break;
    if (ev.text) yield { type: 'token', text: ev.text };
    if (ev.finishReason) finishReason = ev.finishReason;
    if (ev.usage) usage = ev.usage;
  }
  yield { type: 'done', usage, finishReason };
}
