// Shared Server-Sent-Events parsing for the SSE-streamed endpoints
// (/api/jarvis and /api/jarvis/advice) so they share one parser.

// Normalize CRLF / lone CR line endings to LF so the delimiter and line logic only deal with \n.
const normalize = (text) => text.replace(/\r\n?/g, '\n');

// Split a buffer into complete SSE events ("event: x\ndata: {…}\n\n").
// Returns [events, leftover].
export function splitSseChunks(input) {
  const buffer = normalize(input);
  const events = [];
  let cursor = 0;
  while (true) {
    const idx = buffer.indexOf('\n\n', cursor);
    if (idx === -1) break;
    events.push(buffer.slice(cursor, idx));
    cursor = idx + 2;
  }
  return [events, buffer.slice(cursor)];
}

// Parse one chunk into { event, payload } (payload is the JSON-decoded data),
// or null if there's no event line / the data isn't valid JSON. Multi-line data is joined
// with "\n"; only the single optional space after "data:" is stripped.
export function parseSseChunk(chunk) {
  let event = null;
  const dataLines = [];
  for (const line of normalize(chunk).split('\n')) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) {
      const value = line.slice(5);
      dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
    }
  }
  if (!event) return null;
  const data = dataLines.join('\n');
  try {
    return { event, payload: data.trim() ? JSON.parse(data) : {} };
  } catch {
    return null;
  }
}

// Read a fetch Response body as an SSE stream, invoking onEvent(event, payload)
// for each complete event. Resolves when the stream ends; a final event that was not
// terminated by a blank line is still delivered.
export async function readSse(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const drain = (final) => {
    const [chunks, rest] = splitSseChunks(buffer);
    buffer = rest;
    if (final && buffer.trim()) {
      chunks.push(buffer);
      buffer = '';
    }
    for (const chunk of chunks) {
      const parsed = parseSseChunk(chunk);
      if (parsed) onEvent(parsed.event, parsed.payload);
    }
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    drain(false);
  }
  buffer += decoder.decode();
  drain(true);
}
