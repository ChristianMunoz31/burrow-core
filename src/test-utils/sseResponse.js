// Test helper: a fake fetch Response whose body is an SSE stream delivered in the given
// string chunks, so tests can split events across reads.
export function sseResponse(chunks, { status = 200 } = {}) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: stream,
  };
}

export const sseEvent = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  };
}

/**
 * A fetch stand-in for useJarvis tests: answers the lazy `POST /api/jarvis/conversations`
 * itself (so it never consumes a queued `mock` response) and hands every other request to
 * `mock`. `convCalls` records each conversation creation.
 */
export function withConversations(mock, makeId = (n) => `conv-${n}`) {
  const convCalls = [];
  const fn = (url, init) => {
    if (String(url) === '/api/jarvis/conversations' && init?.method === 'POST') {
      convCalls.push({ url, init });
      return Promise.resolve(jsonResponse({ id: makeId(convCalls.length) }));
    }
    return mock(url, init);
  };
  fn.convCalls = convCalls;
  return fn;
}
