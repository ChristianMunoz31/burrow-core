// A bundled fake Ollama for sandboxes, previews, Playwright and manual use. It speaks just enough
// of the Ollama HTTP API for Burrow (version, tags, show, chat, pull) with deterministic canned
// replies, so the UI says "Ollama is running" and Javi works with zero setup and no real model.
//
// Safety: it binds loopback only, refuses port 11434 (the real Ollama's), answers everything else
// with 404 and never makes an outbound connection of its own (a pull is simulated from canned
// frames, nothing is downloaded). Replies are fixed copy: it never computes or echoes a number.
import http from 'node:http';

export const REAL_OLLAMA_PORT = 11434;
export const FAKE_OLLAMA_VERSION = '0.0.0-burrow-fake';
export const FAKE_MODEL_NAME = 'llama3.2:3b';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const MAX_BODY_BYTES = 1024 * 1024;

/** The one small tool-capable model the fake reports as installed by default. */
export const DEFAULT_MODELS = Object.freeze([
  Object.freeze({
    name: FAKE_MODEL_NAME,
    model: FAKE_MODEL_NAME,
    size: 2019393189,
    digest: 'fake3b',
    modified_at: '2026-01-01T00:00:00Z',
    details: { family: 'llama', parameter_size: '3.2B', quantization_level: 'Q4_K_M', context_length: 131072 },
    capabilities: ['completion', 'tools'],
  }),
]);

export const PLAIN_REPLY = 'This is a canned reply from the built-in fake AI, so no real model is running. Pick another AI mode to talk to a real one.';
export const TOOL_DONE_REPLY = 'That is ready for you to confirm. I have not changed anything yet.';
const DEFAULT_TODO_TITLE = 'Try the sandbox';
const WRITE_RE = /\b(add|create|make|new|remind)\b[\s\S]*\b(to-?do|task|reminder)\b/i;

/**
 * Whether a user message asks for a write (adding a todo).
 * @param {string} text
 * @returns {boolean}
 */
export const isWriteRequest = (text) => typeof text === 'string' && WRITE_RE.test(text);

/** The todo title to propose: quoted text, else text after a colon, else a fixed default. */
function todoTitleFrom(text) {
  const quoted = /["“']([^"”']{1,80})["”']/.exec(text);
  if (quoted) return quoted[1].trim();
  const afterColon = /:\s*([^\n]{1,80})$/.exec(text);
  if (afterColon) return afterColon[1].trim();
  return DEFAULT_TODO_TITLE;
}

const lastOf = (messages, role) => {
  for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i]?.role === role) return messages[i];
  return null;
};

function timeGreeting(hour, name) {
  const g = hour < 5 || hour >= 21 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  return name ? `${g}, ${name}.` : `${g}.`;
}

export function homeWeatherAdvice(text, messages) {
  try {
    const fenceMatch = /<page_context_[0-9a-f]+\s+page="Home">([\s\S]*?)<\/page_context_[0-9a-f]+>/i.exec(text);
    if (!fenceMatch) return null;
    const data = JSON.parse(fenceMatch[1]);
    const w = data?.data?.weather ?? data?.weather;

    const sys = messages?.find((m) => m?.role === 'system')?.content || '';
    const nameMatch = /The user's name is ([^.\n]+)\./.exec(sys);
    const name = nameMatch ? nameMatch[1].trim() : null;

    const timeMatch = /Local time:\s*(\d{2}):\d{2}/i.exec(text);
    const hour = timeMatch ? parseInt(timeMatch[1], 10) : new Date().getHours();
    const greeting = timeGreeting(hour, name);

    if (w?.current) {
      const tempF = Math.round(w.current.tempF ?? 61);
      const cond = (w.current.condition || 'mainly clear').toLowerCase();
      const today = w.days?.[0];
      const highF = Math.round(today?.highF ?? 71);
      const lowF = Math.round(today?.lowF ?? 54);
      return `${greeting} ${tempF}°, ${cond}. Today ${highF}° / ${lowF}°. Umbrella weather. Two todos are due today, and your budget is on track.`;
    }

    return `${greeting} Two todos are due today, and your budget is on track.`;
  } catch {
    return null;
  }
}

/**
 * The default canned reply for a chat body: a tool call for a write-ish question when
 * `add_todo` is offered, a fixed confirmation line after a tool result, plain text otherwise.
 * @param {{ messages?: Array<{ role?: string, content?: unknown }>, tools?: Array<{ function?: { name?: string } }> }} body
 * @returns {{ content: string, tool_calls?: Array<{ function: { name: string, arguments: object } }> }}
 */
export function defaultChatReply(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const last = messages[messages.length - 1];
  if (last?.role === 'tool') return { content: TOOL_DONE_REPLY };
  const user = lastOf(messages, 'user');
  const text = typeof user?.content === 'string' ? user.content : '';
  const offered = Array.isArray(body?.tools) && body.tools.some((t) => t?.function?.name === 'add_todo');
  if (offered && isWriteRequest(text)) {
    return { content: '', tool_calls: [{ function: { name: 'add_todo', arguments: { title: todoTitleFrom(text) } } }] };
  }
  const weatherReply = homeWeatherAdvice(text, messages);
  if (weatherReply) return { content: weatherReply };
  return { content: PLAIN_REPLY };
}

const normalizeReply = (out) => {
  if (typeof out === 'string') return { content: out };
  if (out && typeof out === 'object') return { content: typeof out.content === 'string' ? out.content : '', tool_calls: out.tool_calls };
  return null;
};

const tokensOf = (text) => text.match(/\S+\s*|\s+/g) || [''];

const pullFrames = (model) => [
  { status: 'pulling manifest' },
  { status: `pulling ${model}`, digest: 'sha256:fake', total: 1000, completed: 500 },
  { status: `pulling ${model}`, digest: 'sha256:fake', total: 1000, completed: 1000 },
  { status: 'verifying sha256 digest' },
  { status: 'writing manifest' },
  { status: 'success' },
];

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= MAX_BODY_BYTES) chunks.push(c);
    });
    req.on('error', () => resolve(null));
    req.on('end', () => {
      if (size > MAX_BODY_BYTES || size === 0) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
  });
}

const sendJson = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

const sendNdjson = (res, frames) => {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
  for (const f of frames) res.write(`${JSON.stringify(f)}\n`);
  res.end();
};

/**
 * Starts the fake Ollama.
 * @param {{
 *   host?: string,
 *   port?: number,
 *   models?: object[],
 *   chat?: (body: object) => (string | { content?: string, tool_calls?: object[] } | undefined | Promise<unknown>),
 *   pull?: 'simulate' | 'refuse',
 * }} [opts] `chat` may override the default reply (return undefined to fall back to it).
 *   `pull` is `simulate` (default: tiny canned progress, the model then shows as installed) or `refuse`.
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void>, requests: Array<{ method: string, path: string, body: unknown }> }>}
 */
export async function startFakeOllama({ host = '127.0.0.1', port = 0, models, chat, pull = 'simulate' } = {}) {
  if (!LOOPBACK_HOSTS.has(String(host).toLowerCase())) throw new Error('The fake Ollama only binds loopback (127.0.0.1, ::1 or localhost).');
  const wanted = Number(port);
  if (!Number.isInteger(wanted) || wanted < 0 || wanted > 65535) throw new Error('The fake Ollama port must be an integer between 0 and 65535.');
  if (wanted === REAL_OLLAMA_PORT) throw new Error(`The fake Ollama refuses port ${REAL_OLLAMA_PORT}: that is the real Ollama's port.`);

  const installed = (Array.isArray(models) ? models : DEFAULT_MODELS).map((m) => ({ ...m }));
  /** @type {Array<{ method: string, path: string, body: unknown }>} */
  const requests = [];

  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method || 'GET';
      const pathname = new URL(req.url || '/', 'http://fake.invalid').pathname;
      const body = method === 'POST' ? await readJsonBody(req) : null;
      requests.push({ method, path: pathname, body });

      if (method === 'GET' && pathname === '/api/version') return sendJson(res, 200, { version: FAKE_OLLAMA_VERSION });
      if (method === 'GET' && pathname === '/api/tags') return sendJson(res, 200, { models: installed });
      if (method === 'POST' && pathname === '/api/show') {
        const name = typeof body?.model === 'string' ? body.model : typeof body?.name === 'string' ? body.name : '';
        const found = installed.find((m) => m.name === name || m.model === name);
        if (!found) return sendJson(res, 404, { error: `model '${name.slice(0, 80)}' not found` });
        return sendJson(res, 200, {
          capabilities: found.capabilities || ['completion'],
          model_info: { 'general.parameter_count': 3200000000, 'llama.context_length': found.details?.context_length ?? 8192 },
          details: found.details || {},
        });
      }
      if (method === 'POST' && pathname === '/api/chat') return await handleChat(res, body);
      if (method === 'POST' && pathname === '/api/pull') return handlePull(res, body);
      return sendJson(res, 404, { error: 'not found' });
    } catch {
      if (!res.headersSent) return sendJson(res, 500, { error: 'fake ollama failure' });
      res.end();
      return undefined;
    }
  });

  async function handleChat(res, body) {
    const chatBody = body && typeof body === 'object' ? body : {};
    const model = typeof chatBody.model === 'string' ? chatBody.model : FAKE_MODEL_NAME;
    const reply = normalizeReply(chat ? await chat(chatBody) : undefined) || defaultChatReply(chatBody);
    const created_at = '2026-01-01T00:00:00Z';
    const tool_calls = Array.isArray(reply.tool_calls) && reply.tool_calls.length ? reply.tool_calls : undefined;
    const tail = { model, created_at, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 };
    if (chatBody.stream === false) {
      return sendJson(res, 200, { ...tail, message: { role: 'assistant', content: reply.content, ...(tool_calls ? { tool_calls } : {}) } });
    }
    const frames = [];
    if (tool_calls) frames.push({ model, created_at, message: { role: 'assistant', content: '', tool_calls }, done: false });
    if (reply.content) for (const t of tokensOf(reply.content)) frames.push({ model, created_at, message: { role: 'assistant', content: t }, done: false });
    frames.push(tail);
    return sendNdjson(res, frames);
  }

  function handlePull(res, body) {
    const name = typeof body?.model === 'string' ? body.model : typeof body?.name === 'string' ? body.name : '';
    if (pull === 'refuse' || !name) {
      return sendJson(res, 400, { error: 'the fake Ollama does not download models' });
    }
    if (!installed.some((m) => m.name === name || m.model === name)) {
      installed.push({
        name,
        model: name,
        size: 1,
        digest: 'fakepull',
        modified_at: '2026-01-01T00:00:00Z',
        details: { family: 'llama', parameter_size: '1B', quantization_level: 'Q4_K_M', context_length: 8192 },
        capabilities: ['completion', 'tools'],
      });
    }
    return sendNdjson(res, pullFrames(name));
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(wanted, host, resolve);
  });
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : wanted;
  if (boundPort === REAL_OLLAMA_PORT) {
    await new Promise((resolve) => server.close(resolve));
    throw new Error(`The fake Ollama refuses port ${REAL_OLLAMA_PORT}.`);
  }
  const hostPart = String(host).includes(':') ? `[${host}]` : host;

  return {
    url: `http://${hostPart}:${boundPort}`,
    port: boundPort,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
