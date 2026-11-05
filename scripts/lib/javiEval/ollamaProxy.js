// Passive recording proxy between Burrow and Ollama, for the Javi eval only.
//
// Burrow's Ollama provider uses node-fetch, not globalThis.fetch, so a fetch wrapper would see
// nothing. Instead the eval points the app's own Ollama host setting (ai.settings in the temp
// database) at this loopback proxy. Every request is forwarded unchanged; for /api/chat the proxy
// keeps a copy of the request (options, keep_alive, format, tools, messages) and tees the NDJSON
// stream to time the first token and read Ollama's final `done` chunk (prompt_eval_count,
// eval_count, durations). No product code changes.
//
// Guards: binds 127.0.0.1 only, forwards only the paths Burrow's Ollama provider uses (FORWARD_PATHS;
// everything else, /api/pull and /api/generate included, gets 403, so the eval never downloads a
// model) and refuses any generation request for a model other than the one under test, so a
// fallback can never load a bigger model. The harness's own unload (/api/generate, keep_alive 0)
// talks to Ollama directly, not through this proxy.
import http from 'node:http';
import { performance } from 'node:perf_hooks';

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const GENERATION_PATHS = new Set(['/api/chat', '/api/generate', '/api/embed', '/api/embeddings']);
/** The only upstream paths the proxy forwards; anything else is refused with 403. */
const FORWARD_PATHS = new Set(['/api/chat', '/api/tags', '/api/show', '/api/version', '/api/ps']);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const sendJson = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

/**
 * Start the proxy.
 * @param {{ upstream: string, allowModel: string, onCall: (record: object) => void }} opts
 *   `upstream` is the real Ollama origin; `onCall` receives every request's record as soon as the
 *   request arrives (so it is attributed to the run that made it); the record is filled in while the
 *   response streams and gets `endedAt` when it is complete. The app can finish on Ollama's `done`
 *   frame before the upstream socket ends, so callers wait for `endedAt` before reading a record.
 * @returns {Promise<{ url: string, close: () => Promise<void>, setAllowModel: (m: string) => void }>}
 */
export async function startRecordingProxy({ upstream, allowModel, onCall }) {
  const up = new URL(upstream);
  let allowed = allowModel;

  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url || '/', 'http://proxy.invalid').pathname;
    const startedAt = performance.now();
    let raw;
    try {
      raw = await readBody(req);
    } catch {
      return sendJson(res, 413, { error: 'eval proxy: body too large' });
    }
    let body = null;
    if (raw.length) {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        body = null;
      }
    }
    if (path === '/api/pull') {
      onCall({ path, refused: 'pull', startedAt, endedAt: performance.now() });
      return sendJson(res, 403, { error: 'eval proxy: pulling models is disabled' });
    }
    if (!FORWARD_PATHS.has(path)) {
      onCall({ path: path.slice(0, 80), refused: 'path', startedAt, endedAt: performance.now() });
      return sendJson(res, 403, { error: 'eval proxy: this path is not forwarded' });
    }
    if (GENERATION_PATHS.has(path) && (body === null || typeof body !== 'object' || Array.isArray(body))) {
      onCall({ path, refused: 'body', startedAt, endedAt: performance.now() });
      return sendJson(res, 403, { error: 'eval proxy: the request body is not valid JSON' });
    }
    if (GENERATION_PATHS.has(path) && body.model !== allowed) {
      onCall({ path, refused: 'model', model: String(body.model).slice(0, 80), startedAt, endedAt: performance.now() });
      return sendJson(res, 403, { error: `eval proxy: model ${String(body.model).slice(0, 80)} is not the model under test` });
    }

    const isChat = path === '/api/chat';
    const record = isChat
      ? {
          path,
          startedAt,
          request: {
            model: body?.model ?? null,
            stream: body?.stream ?? null,
            options: body?.options ?? null,
            keep_alive: body?.keep_alive ?? null,
            format: body?.format ?? null,
            tools: Array.isArray(body?.tools) ? body.tools : [],
            messages: Array.isArray(body?.messages) ? body.messages : [],
          },
          firstByteAt: null,
          firstContentAt: null,
          firstToolCallAt: null,
          content: '',
          toolCalls: [],
          done: null,
          status: null,
          error: null,
          endedAt: null,
        }
      : { path, startedAt, endedAt: null, status: null };
    if (isChat) record.doneAt = null;
    onCall(record);
    const finish = () => {
      if (record.endedAt === null) record.endedAt = performance.now();
    };

    const headers = { ...req.headers, host: up.host };
    delete headers['content-length'];
    if (raw.length) headers['content-length'] = String(raw.length);
    const upstreamReq = http.request(
      { protocol: up.protocol, hostname: up.hostname, port: up.port, method: req.method, path: req.url, headers },
      (upRes) => {
        record.status = upRes.statusCode;
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        let buf = '';
        upRes.on('data', (chunk) => {
          res.write(chunk);
          if (!isChat) return;
          const now = performance.now();
          if (record.firstByteAt === null) record.firstByteAt = now;
          buf += chunk.toString('utf8');
          let nl;
          while ((nl = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line) parseLine(line, now);
          }
        });
        upRes.on('end', () => {
          if (isChat && buf.trim()) parseLine(buf.trim(), performance.now());
          res.end();
          finish();
        });
        upRes.on('error', () => {
          record.error = 'upstream_stream_error';
          finish();
          res.destroy();
        });
      },
    );
    upstreamReq.on('error', () => {
      if (record.endedAt === null && record.status === null) record.error = 'upstream_unreachable';
      finish();
      if (!res.headersSent) sendJson(res, 502, { error: 'eval proxy: upstream unreachable' });
      else res.destroy();
    });
    upstreamReq.on('close', finish);
    // The app aborted (timeout or client gone): stop the upstream call too.
    res.on('close', () => {
      if (!res.writableFinished) upstreamReq.destroy();
    });
    upstreamReq.end(raw.length ? raw : undefined);

    function parseLine(line, now) {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof obj?.error === 'string') record.error = obj.error.slice(0, 200);
      const msg = obj?.message;
      if (msg && typeof msg.content === 'string' && msg.content) {
        if (record.firstContentAt === null) record.firstContentAt = now;
        record.content += msg.content;
      }
      if (msg && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        if (record.firstToolCallAt === null) record.firstToolCallAt = now;
        record.toolCalls.push(...msg.tool_calls);
      }
      if (obj?.done) {
        record.doneAt = now;
        record.done = {
          done_reason: obj.done_reason ?? null,
          total_duration: obj.total_duration ?? null,
          load_duration: obj.load_duration ?? null,
          prompt_eval_count: obj.prompt_eval_count ?? null,
          prompt_eval_duration: obj.prompt_eval_duration ?? null,
          eval_count: obj.eval_count ?? null,
          eval_duration: obj.eval_duration ?? null,
        };
      }
    }
    return undefined;
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    setAllowModel: (m) => {
      allowed = m;
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

/**
 * Unload a model from the real Ollama (keep_alive 0) and wait until /api/ps no longer lists it.
 * Talks to Ollama directly, not through the proxy, so it is never counted as an app call.
 * @param {string} upstream
 * @param {string} model
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<boolean>} true when the model is no longer loaded.
 */
export async function unloadModel(upstream, model, { timeoutMs = 30_000 } = {}) {
  try {
    await fetch(`${upstream}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: 0 }),
    }).then((r) => r.arrayBuffer());
  } catch {
    return false;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const loaded = await loadedModels(upstream);
    if (loaded === null) return false;
    if (!loaded.includes(model)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * Names of the models Ollama has in memory, or null when /api/ps is unavailable.
 * @param {string} upstream
 * @returns {Promise<string[] | null>}
 */
export async function loadedModels(upstream) {
  try {
    const r = await fetch(`${upstream}/api/ps`);
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j?.models) ? j.models.map((m) => m.name || m.model) : [];
  } catch {
    return null;
  }
}
