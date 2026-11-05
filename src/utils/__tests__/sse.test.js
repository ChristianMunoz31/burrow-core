import { describe, it, expect } from 'vitest';
import { splitSseChunks, parseSseChunk, readSse } from '../sse';
import { sseResponse } from '../../test-utils/sseResponse';

describe('splitSseChunks', () => {
  it('splits complete events and returns the trailing partial as leftover', () => {
    const buf = 'event: a\ndata: {"x":1}\n\nevent: b\ndata: {"y":2}\n\nevent: c\ndata: {"z"';
    const [events, leftover] = splitSseChunks(buf);
    expect(events).toHaveLength(2);
    expect(leftover).toBe('event: c\ndata: {"z"');
  });

  it('returns no events when there is no complete delimiter', () => {
    const [events, leftover] = splitSseChunks('event: a\ndata: {');
    expect(events).toHaveLength(0);
    expect(leftover).toBe('event: a\ndata: {');
  });
});

describe('parseSseChunk', () => {
  it('parses event + JSON payload', () => {
    expect(parseSseChunk('event: tool.start\ndata: {"name":"list_todos"}')).toEqual({
      event: 'tool.start',
      payload: { name: 'list_todos' },
    });
  });

  it('returns null on missing event line or bad JSON', () => {
    expect(parseSseChunk('data: {"x":1}')).toBeNull();
    expect(parseSseChunk('event: x\ndata: {not json')).toBeNull();
  });
});

describe('SSE edge cases', () => {
  it('normalizes CRLF line endings', () => {
    const [events, leftover] = splitSseChunks('event: a\r\ndata: {"x":1}\r\n\r\n');
    expect(events).toEqual(['event: a\ndata: {"x":1}']);
    expect(leftover).toBe('');
    expect(parseSseChunk('event: a\r\ndata: {"x":1}')).toEqual({ event: 'a', payload: { x: 1 } });
  });

  it('joins multi-line data with a newline and keeps interior whitespace', () => {
    expect(parseSseChunk('event: a\ndata: {"t":\ndata:  "x  y"}')).toEqual({
      event: 'a',
      payload: { t: 'x  y' },
    });
  });

  it('parses a final event that has no terminating blank line', async () => {
    const seen = [];
    await readSse(
      sseResponse(['event: a\ndata: {"x":1}\n\nevent: done\ndata: {"ok":true}']),
      (e, p) => seen.push([e, p]),
    );
    expect(seen).toEqual([
      ['a', { x: 1 }],
      ['done', { ok: true }],
    ]);
  });

  it('decodes a multibyte character split across reads', async () => {
    const bytes = new TextEncoder().encode('event: a\ndata: {"t":"é"}\n\n');
    const cut = bytes.indexOf(0xc3) + 1;
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(bytes.slice(0, cut));
        c.enqueue(bytes.slice(cut));
        c.close();
      },
    });
    const seen = [];
    await readSse({ body: stream }, (e, p) => seen.push(p));
    expect(seen).toEqual([{ t: 'é' }]);
  });
});
