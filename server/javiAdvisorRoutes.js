import { isMultiTurnAdvice, validateAdviceRequest } from './javi/validateAdvice.js';
import { generateAdvice, streamAdvice } from './javi/advisorService.js';
import { recordAudit } from './auditHook.js';
import { captureDataGeneration } from './dataGeneration.js';
import { markPageSeen } from './javi/inbox.js';
import { AiBusyError, MSG_WARMING_STATUS, aiAuditMeta, getAiClient, isAiQueueFull, openSse, sendAiError, signalOnClose } from './ai/index.js';

const wantsStream = (req) => /\btext\/event-stream\b/i.test(String(req.get('accept') || ''));

/** Error body for a service error that carries a publicMessage. */
function errorBody(err) {
  return {
    error: err.publicMessage,
    code: typeof err.code === 'string' && err.code ? err.code : 'server_error',
    ...(typeof err.reason === 'string' ? { reason: err.reason } : {}),
    ...(Number.isFinite(err.retryAfterMs) ? { retryAfterMs: Math.min(Math.max(err.retryAfterMs, 0), 60000) } : {}),
  };
}

/**
 * POST /api/jarvis/advice: page advice from Javi. JSON { data } by default; with
 * `Accept: text/event-stream` it streams `delta` { content }, then `done` { content, model,
 * provider, ai, withheld, notice, blocked } (content is the full, sanitized answer) or `error`
 * { error, code, retryAfterMs? }. A `meta` { ai } event comes first. A `status` { code: 'warming_up', message }
 * event is sent once when a local model has not produced a token after a few seconds (a cold load). When a cloud client may not see
 * the page, `blocked` is true, no model is called, no deltas are sent and content is the notice.
 * `notice` also carries a fixed note when the answer holds a figure that is not in the data it was given, or
 * (local and LAN models) when the answer stopped at the token cap.
 * A single-shot insight on a local model is cached for a few minutes (adviceCache.js): a hit replays the same
 * events from the stored text with no model call and no audit row. `?fresh=1` (the Refresh button) skips the
 * lookup. It is a query param, not a body key, so it cannot read as a multi-turn request.
 * AI that cannot run answers 503 JSON before any stream opens. Never echoes err.message or
 * request content.
 * @param {import('express').Express} app
 */
export function registerJaviAdvisorRoutes(app) {
  app.post('/api/jarvis/advice', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const v = validateAdviceRequest(req.body);
    if (!v.ok) return res.status(v.status).json({ error: v.error, code: v.code });
    // A run whose client left can outlive a whole-data reset: it then writes no audit row either.
    const dataGen = captureDataGeneration();

    let client;
    try {
      // When streaming, a full queue answers 429 now, before the stream opens.
      if (wantsStream(req) && isAiQueueFull()) throw new AiBusyError();
      client = await getAiClient({ purpose: 'chat', signal: signalOnClose(res) });
    } catch (err) {
      if (sendAiError(res, err)) return undefined;
      console.error('Javi advice error:', err?.name || 'unknown');
      return res.status(500).json({ error: 'Failed to get advice', code: 'server_error' });
    }

    // Only the last user turn is logged next to the (already sanitized) page context.
    const lastUser = [...v.value.messages].reverse().find((m) => m.role === 'user');
    const question = lastUser ? lastUser.content : null;
    const started = Date.now();
    // Under cloud the audit row holds only what was actually sent (the filtered context),
    // never the unfiltered page snapshot.
    const audit = (status, sentContext) => {
      if (dataGen.isStale()) return undefined;
      return recordAudit({
        kind: 'llm',
        feature: 'javi_advice',
        page: v.value.page,
        provider: client.provider,
        model: client.model,
        status,
        context: { context: client.isCloud ? (sentContext ?? '') : v.value.context, question },
        meta: { calls: client.stats.calls, ms: Date.now() - started, ...aiAuditMeta(client) },
      });
    };
    // A single-shot insight that reached the user clears the page's inbox item (cache hits included).
    const markSeen = (out) => {
      if (isMultiTurnAdvice(req) || v.value.messages.length > 0 || out.blocked || dataGen.isStale()) return;
      try {
        markPageSeen(v.value.page);
      } catch (e) {
        console.error('Javi inbox update failed:', e?.code ?? 'unknown');
      }
    };
    const final = (out) => ({
      content: out.content,
      model: out.model,
      provider: out.provider,
      ai: out.ai,
      withheld: out.withheld,
      notice: out.notice,
      blocked: out.blocked,
    });

    if (wantsStream(req)) {
      const controller = new AbortController();
      let closed = false;
      res.on('close', () => {
        if (!res.writableFinished) {
          closed = true;
          controller.abort();
        }
      });
      const sse = openSse(res);
      sse.send('meta', { ai: client.ai });
      try {
        const out = await streamAdvice(v.value, {
          client,
          signal: controller.signal,
          cache: !isMultiTurnAdvice(req) && v.value.messages.length === 0,
          fresh: req.query?.fresh === '1',
          onDelta: (content) => sse.send('delta', { content }),
          onWarming: () => sse.send('status', { code: 'warming_up', message: MSG_WARMING_STATUS }),
        });
        // A cache hit made no model call, so it leaves no audit row that claims one.
        if (!out.cached) await audit('ok', out.sentContext);
        sse.send('done', final(out));
        markSeen(out);
      } catch (err) {
        await audit('error', err?.sentContext);
        if (!closed) {
          const body =
            typeof err?.publicMessage === 'string'
              ? errorBody(err)
              : { error: 'Failed to get advice', code: 'server_error' };
          sse.send('error', body);
        }
      } finally {
        sse.close();
      }
      return undefined;
    }

    // JSON mode: a client that goes away stops the model call and frees its queue slot.
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    try {
      const out = await generateAdvice(v.value, { client, signal: controller.signal });
      await audit('ok', out.sentContext);
      markSeen(out);
      return res.json({ data: final(out) });
    } catch (err) {
      await audit('error', err?.sentContext);
      if (controller.signal.aborted) return undefined;
      if (sendAiError(res, err)) return undefined;
      // Only errors deliberately built by the service (they carry a publicMessage) are trusted.
      if (typeof err?.publicMessage !== 'string') {
        console.error('Javi advice error:', err?.name || 'unknown');
        return res.status(500).json({ error: 'Failed to get advice', code: 'server_error' });
      }
      const status = Number.isInteger(err.httpStatus) && err.httpStatus >= 400 && err.httpStatus <= 599 ? err.httpStatus : 500;
      return res.status(status).json(errorBody(err));
    }
  });
}
