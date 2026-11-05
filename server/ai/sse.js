// Server-Sent Events helper for AI routes. Call only after requireAi (or getAiClient)
// succeeded, so a 503 is always sent as JSON before any stream opens. A comment
// heartbeat keeps proxies and the browser from timing out while a model loads.

export const HEARTBEAT_MS = 15_000;

/**
 * Open an SSE stream on `res`.
 * @param {import('express').Response} res
 * @param {{ heartbeatMs?: number }} [opts]
 * @returns {{ send: (event: string, data: unknown) => void, sendEvent: (event: { type: string }) => void, close: () => void, stopHeartbeat: () => void }}
 */
export function openSse(res, { heartbeatMs = HEARTBEAT_MS } = {}) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const writable = () => !res.writableEnded && !res.destroyed;
  let timer = null;
  if (heartbeatMs > 0) {
    timer = setInterval(() => {
      if (writable()) res.write(': ping\n\n');
    }, heartbeatMs);
    timer.unref?.();
  }
  const stopHeartbeat = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const send = (event, data) => {
    if (!writable()) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
  };
  return {
    send,
    /** Writes `{ type, ... }` as event `type` (the agents/Jarvis event shape). */
    sendEvent: (event) => send(event.type, event),
    close() {
      stopHeartbeat();
      if (writable()) res.end();
    },
    stopHeartbeat,
  };
}
