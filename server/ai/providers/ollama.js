// Native Ollama transport. Only fixed paths are ever requested (/api/version, /api/tags,
// /api/show, /api/chat, /api/embed, /api/pull); user input never becomes part of a path. Redirects are refused.
// Chat always streams (NDJSON) so the first-token timeout works the same everywhere.
// Callers speak OpenAI-shaped messages; this module converts both ways.
import fetch from 'node-fetch';
import {
  BodyTooLargeError,
  MAX_ERROR_BODY_BYTES,
  MAX_JSON_BODY_BYTES,
  MAX_LINE_CHARS,
  readCappedJson,
  readCappedText,
} from '../bodyCap.js';

export const OLLAMA_PATHS = Object.freeze({
  version: '/api/version',
  tags: '/api/tags',
  show: '/api/show',
  chat: '/api/chat',
  embed: '/api/embed',
  pull: '/api/pull',
});

const MAX_ERROR_BODY_CHARS = 2000;

/** Tag a transport failure so llmErrors can classify it. Never copies a response body into message. */
function transportError(err) {
  if (err?.name === 'AbortError') return err;
  const out = new Error('Ollama request failed');
  out.name = 'OllamaTransportError';
  out.code = 'unavailable';
  out.cause = err;
  return out;
}

async function httpError(res) {
  let text = '';
  try {
    // Byte-capped read: a hostile server cannot make us buffer an endless error body.
    text = (await readCappedText(res, MAX_ERROR_BODY_BYTES, { truncate: true })).slice(0, MAX_ERROR_BODY_CHARS);
  } catch {
    /* ignore */
  }
  const err = new Error(`Ollama HTTP ${res.status}`);
  err.name = 'OllamaHttpError';
  err.httpStatus = res.status;
  // Kept for classification only (never logged or returned).
  err.body = text;
  if (/model\s+["']?[^"'\s]*["']?\s+not found|not found, try pulling/i.test(text)) err.code = 'model_missing';
  return err;
}

/**
 * One request to a fixed Ollama path.
 * @param {string} host Validated origin.
 * @param {keyof typeof OLLAMA_PATHS} which
 * @param {{ body?: object, signal?: AbortSignal }} [opts]
 */
async function request(host, which, { body, signal } = {}) {
  const path = OLLAMA_PATHS[which];
  if (!path) throw new Error('Unknown Ollama path');
  let res;
  try {
    res = await fetch(`${host}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : { Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal,
      redirect: 'error',
    });
  } catch (err) {
    throw transportError(err);
  }
  if (!res || typeof res !== 'object') throw transportError(new Error('empty response'));
  if (!res.ok) throw await httpError(res);
  return res;
}

async function requestJson(host, which, opts) {
  const res = await request(host, which, opts);
  try {
    return await readCappedJson(res, MAX_JSON_BODY_BYTES);
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    const e = new Error('Ollama returned invalid JSON');
    e.code = 'not_ollama';
    throw e;
  }
}

const withTimeout = (signal, timeoutMs) => {
  if (!(timeoutMs > 0)) return signal;
  const t = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, t]) : t;
};

/**
 * GET /api/version.
 * @param {string} host
 * @param {{ signal?: AbortSignal, timeoutMs?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function ollamaVersion(host, { signal, timeoutMs } = {}) {
  const data = await requestJson(host, 'version', { signal: withTimeout(signal, timeoutMs) });
  if (!data || typeof data.version !== 'string') {
    throw Object.assign(new Error('Not an Ollama server'), { code: 'not_ollama' });
  }
  return data.version.slice(0, 40);
}

/**
 * GET /api/tags.
 * @param {string} host
 * @param {{ signal?: AbortSignal, timeoutMs?: number }} [opts]
 * @returns {Promise<Array<object>>} Raw model entries.
 */
export async function ollamaTags(host, { signal, timeoutMs } = {}) {
  const data = await requestJson(host, 'tags', { signal: withTimeout(signal, timeoutMs) });
  if (!data || !Array.isArray(data.models)) {
    throw Object.assign(new Error('Not an Ollama server'), { code: 'not_ollama' });
  }
  return data.models;
}

/**
 * POST /api/show for one model: capabilities, context length, parameter count.
 * @param {string} host
 * @param {string} model
 * @param {{ signal?: AbortSignal, timeoutMs?: number }} [opts]
 * @returns {Promise<{ capabilities: string[], contextLength: number|null, parameterCount: number|null }>}
 */
export async function ollamaShow(host, model, { signal, timeoutMs } = {}) {
  const data = await requestJson(host, 'show', { body: { model }, signal: withTimeout(signal, timeoutMs) });
  const info = data?.model_info && typeof data.model_info === 'object' ? data.model_info : {};
  let contextLength = null;
  let parameterCount = null;
  for (const [k, v] of Object.entries(info)) {
    if (k.endsWith('.context_length') && Number.isFinite(v)) contextLength = v;
    if (k === 'general.parameter_count' && Number.isFinite(v)) parameterCount = v;
  }
  const capabilities = Array.isArray(data?.capabilities) ? data.capabilities.filter((c) => typeof c === 'string') : [];
  return { capabilities, contextLength, parameterCount };
}

// Keys that would reach an object's prototype if copied with plain assignment.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_ARG_DEPTH = 20;

/**
 * Deep copy of parsed JSON without __proto__ / constructor / prototype keys (at any depth).
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export function stripUnsafeKeys(value, depth = 0) {
  if (depth > MAX_ARG_DEPTH) return null;
  if (Array.isArray(value)) return value.map((v) => stripUnsafeKeys(v, depth + 1));
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(k)) continue;
    out[k] = stripUnsafeKeys(v, depth + 1);
  }
  return out;
}

const parseArgs = (raw) => {
  let v = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return {};
    try {
      v = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? stripUnsafeKeys(v) : {};
};

/**
 * OpenAI-shaped messages -> Ollama /api/chat messages. Assistant tool_calls get object
 * arguments; tool results carry tool_name (looked up from the nearest preceding call).
 * @param {Array<object>} messages
 * @returns {Array<object>}
 */
export function toOllamaMessages(messages) {
  const out = [];
  const callNames = new Map();
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== 'object') continue;
    const content = typeof m.content === 'string' ? m.content : '';
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const tool_calls = m.tool_calls.map((tc) => {
        const name = tc?.function?.name || '';
        if (tc?.id) callNames.set(tc.id, name);
        return { function: { name, arguments: parseArgs(tc?.function?.arguments) } };
      });
      out.push({ role: 'assistant', content, tool_calls });
    } else if (m.role === 'tool') {
      const msg = { role: 'tool', content };
      const name = m.tool_name || callNames.get(m.tool_call_id);
      if (name) msg.tool_name = name;
      out.push(msg);
    } else if (m.role === 'system' || m.role === 'user' || m.role === 'assistant') {
      out.push({ role: m.role, content });
    }
  }
  return out;
}

const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Ollama tool calls -> OpenAI shape (string arguments, an id per call).
 * @param {Array<object>} calls
 * @param {number} offset Index of the first call within this reply.
 * @returns {Array<{ id: string, type: 'function', function: { name: string, arguments: string } }>}
 */
export function fromOllamaToolCalls(calls, offset = 0) {
  return (Array.isArray(calls) ? calls : []).map((c, i) => {
    const fn = c?.function || {};
    const args = fn.arguments;
    let argText;
    if (typeof args === 'string') argText = args;
    else {
      try {
        argText = JSON.stringify(args ?? {});
      } catch {
        argText = '{}';
      }
    }
    return {
      id: typeof c?.id === 'string' && SAFE_ID_RE.test(c.id) ? c.id : `call_${offset + i}`,
      type: 'function',
      function: { name: typeof fn.name === 'string' ? fn.name : '', arguments: argText },
    };
  });
}

async function* readLines(res) {
  const body = res.body;
  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of body) {
      buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) yield line;
      }
      // A real NDJSON frame is small; a line that never ends is not Ollama.
      if (buf.length > MAX_LINE_CHARS) throw new BodyTooLargeError('stream line');
    }
    buf += decoder.decode();
    if (buf.length > MAX_LINE_CHARS) throw new BodyTooLargeError('stream line');
    if (buf.trim()) yield buf.trim();
    return;
  }
  if (typeof res.text === 'function') {
    const text = await readCappedText(res, MAX_JSON_BODY_BYTES);
    for (const line of text.split('\n')) {
      if (line.length > MAX_LINE_CHARS) throw new BodyTooLargeError('stream line');
      if (line.trim()) yield line.trim();
    }
    return;
  }
  if (typeof res.json === 'function') yield JSON.stringify(await res.json());
}

/**
 * Streamed POST /api/chat. Yields
 *   { type: 'token', text } | { type: 'tool_calls', calls } | { type: 'done', usage, finishReason }.
 * @param {{ host: string, model: string, messages: object[], tools?: object[], numCtx: number,
 *   numPredict?: number, temperature?: number, keepAlive?: string, format?: 'json', signal?: AbortSignal }} opts
 */
export async function* ollamaChatStream({
  host,
  model,
  messages,
  tools,
  numCtx,
  numPredict,
  temperature,
  keepAlive,
  format,
  signal,
}) {
  const body = {
    model,
    messages: toOllamaMessages(messages),
    stream: true,
    options: { num_ctx: numCtx },
  };
  if (Number.isFinite(numPredict) && numPredict > 0) body.options.num_predict = numPredict;
  if (Number.isFinite(temperature)) body.options.temperature = temperature;
  if (keepAlive) body.keep_alive = keepAlive;
  if (format === 'json') body.format = 'json';
  if (Array.isArray(tools) && tools.length) body.tools = tools;

  const res = await request(host, 'chat', { body, signal });
  let toolCount = 0;
  let sawDone = false;
  try {
    for await (const line of readLines(res)) {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj && typeof obj.error === 'string') {
        const err = new Error('Ollama stream error');
        err.name = 'OllamaStreamError';
        err.body = obj.error.slice(0, MAX_ERROR_BODY_CHARS);
        if (/not found/i.test(obj.error)) err.code = 'model_missing';
        throw err;
      }
      const msg = obj?.message;
      if (msg && typeof msg.content === 'string' && msg.content) yield { type: 'token', text: msg.content };
      if (msg && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        const calls = fromOllamaToolCalls(msg.tool_calls, toolCount);
        toolCount += calls.length;
        yield { type: 'tool_calls', calls };
      }
      if (obj?.done) {
        sawDone = true;
        const input = Number(obj.prompt_eval_count) || 0;
        const output = Number(obj.eval_count) || 0;
        yield {
          type: 'done',
          usage: { input_tokens: input, output_tokens: output, total_tokens: input + output },
          finishReason: toolCount > 0 ? 'tool_calls' : obj.done_reason === 'length' ? 'length' : 'stop',
        };
        return;
      }
    }
  } catch (err) {
    if (err?.name === 'AbortError' || err?.name === 'OllamaStreamError' || err instanceof BodyTooLargeError) throw err;
    throw transportError(err);
  } finally {
    // Consumer stopped early (or an error): release the connection.
    if (!sawDone) {
      try {
        res.body?.destroy?.();
      } catch {
        /* ignore */
      }
    }
  }
  if (!sawDone) {
    yield { type: 'done', usage: null, finishReason: toolCount > 0 ? 'tool_calls' : 'stop' };
  }
}

/** Most vector dimensions accepted from /api/embed (nomic-embed-text has 768). */
export const MAX_EMBED_DIMS = 4096;

const notOllama = () => Object.assign(new Error('Not an Ollama server'), { code: 'not_ollama' });

/**
 * POST /api/embed: one vector per input. The reply is validated: as many vectors as inputs, every
 * value finite, one consistent dimension count of at most MAX_EMBED_DIMS; anything else is
 * `not_ollama`.
 * @param {string} host Validated origin.
 * @param {string} model
 * @param {string[]} inputs
 * @param {{ signal?: AbortSignal, timeoutMs?: number, keepAlive?: string }} [opts]
 * @returns {Promise<Float32Array[]>}
 */
export async function ollamaEmbed(host, model, inputs, { signal, timeoutMs, keepAlive } = {}) {
  const body = { model, input: inputs, truncate: true };
  if (keepAlive) body.keep_alive = keepAlive;
  const data = await requestJson(host, 'embed', { body, signal: withTimeout(signal, timeoutMs) });
  const rows = data?.embeddings;
  if (!Array.isArray(rows) || rows.length !== inputs.length) throw notOllama();
  let dims = -1;
  const out = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length === 0 || row.length > MAX_EMBED_DIMS) throw notOllama();
    if (dims === -1) dims = row.length;
    else if (row.length !== dims) throw notOllama();
    const vec = new Float32Array(row.length);
    for (let i = 0; i < row.length; i += 1) {
      const v = row[i];
      if (typeof v !== 'number' || !Number.isFinite(v)) throw notOllama();
      vec[i] = v;
      if (!Number.isFinite(vec[i])) throw notOllama();
    }
    out.push(vec);
  }
  return out;
}

const MAX_PULL_FIELD_CHARS = 200;
const finiteNum = (v) => (Number.isFinite(v) && v >= 0 ? v : undefined);

/**
 * Streamed POST /api/pull. Yields parsed NDJSON frames
 *   { status, digest?, total?, completed?, error? }
 * (only these fields, strings clipped). Unparseable lines are skipped. Frame text is for the
 * caller to classify; it must never be forwarded to a client.
 * @param {string} host Validated origin.
 * @param {string} model
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {AsyncGenerator<{ status: string, digest?: string, total?: number, completed?: number, error?: string }>}
 */
export async function* ollamaPullStream(host, model, { signal } = {}) {
  const res = await request(host, 'pull', { body: { model, stream: true }, signal });
  try {
    for await (const line of readLines(res)) {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (!obj || typeof obj !== 'object') continue;
      const frame = { status: typeof obj.status === 'string' ? obj.status.slice(0, MAX_PULL_FIELD_CHARS) : '' };
      if (typeof obj.digest === 'string') frame.digest = obj.digest.slice(0, MAX_PULL_FIELD_CHARS);
      if (finiteNum(obj.total) !== undefined) frame.total = obj.total;
      if (finiteNum(obj.completed) !== undefined) frame.completed = obj.completed;
      if (typeof obj.error === 'string') frame.error = obj.error.slice(0, MAX_ERROR_BODY_CHARS);
      yield frame;
    }
  } catch (err) {
    if (err?.name === 'AbortError' || err instanceof BodyTooLargeError) throw err;
    throw transportError(err);
  } finally {
    try {
      res.body?.destroy?.();
    } catch {
      /* ignore */
    }
  }
}
