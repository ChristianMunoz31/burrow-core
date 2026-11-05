// The stdin side of the shell channel: line splitting, the size cap, UTF-8 and prefix handling.
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../loadEnv.js', () => ({}));

import { MAX_INBOX_LINE_BYTES, attachShellInbox } from '../desktop/shellInbox.js';

const PREFIX = 'BURROW_DIALOG_REPLY ';

function setup() {
  const stream = new PassThrough();
  const seen = [];
  const detach = attachShellInbox(stream, { onReply: (payload) => seen.push(payload) });
  return { stream, seen, detach };
}

describe('attachShellInbox', () => {
  it('dispatches one payload per reply line', () => {
    const { stream, seen } = setup();
    stream.write(`${PREFIX}{"a":1}\n${PREFIX}{"b":2}\n`);
    expect(seen).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('joins a line split across chunks, even inside a multi-byte character', () => {
    const { stream, seen } = setup();
    const bytes = Buffer.from(`${PREFIX}{"p":"Exämple ✓"}\n`, 'utf8');
    for (let i = 0; i < bytes.length; i += 3) stream.write(bytes.subarray(i, i + 3));
    expect(seen).toEqual(['{"p":"Exämple ✓"}']);
  });

  it('strips a trailing CR', () => {
    const { stream, seen } = setup();
    stream.write(`${PREFIX}{"a":1}\r\n`);
    expect(seen).toEqual(['{"a":1}']);
  });

  it('waits for the newline before dispatching', () => {
    const { stream, seen } = setup();
    stream.write(`${PREFIX}{"a":1}`);
    expect(seen).toEqual([]);
    stream.write('\n');
    expect(seen).toEqual(['{"a":1}']);
  });

  it('drops a 20 KB line with no newline and still reads the next line', () => {
    const { stream, seen } = setup();
    stream.write(Buffer.alloc(20 * 1024, 0x61));
    stream.write(Buffer.alloc(100, 0x62));
    stream.write(`\n${PREFIX}{"ok":1}\n`);
    expect(seen).toEqual(['{"ok":1}']);
  });

  it('drops a complete line over the cap in one chunk', () => {
    const { stream, seen } = setup();
    stream.write(`${PREFIX}${'x'.repeat(MAX_INBOX_LINE_BYTES)}\n${PREFIX}{"ok":1}\n`);
    expect(seen).toEqual(['{"ok":1}']);
  });

  it('drops a line with invalid UTF-8', () => {
    const { stream, seen } = setup();
    stream.write(Buffer.concat([Buffer.from(PREFIX), Buffer.from([0xff, 0xfe]), Buffer.from('\n')]));
    stream.write(`${PREFIX}{"ok":1}\n`);
    expect(seen).toEqual(['{"ok":1}']);
  });

  it('ignores lines with another prefix, no prefix, or a changed prefix', () => {
    const { stream, seen } = setup();
    stream.write('hello\nBURROW_UPDATE_REQUEST {}\n BURROW_DIALOG_REPLY {}\nBURROW_DIALOG_REPLY{}\n\n');
    expect(seen).toEqual([]);
  });

  it('keeps going after a handler that throws', () => {
    const stream = new PassThrough();
    const seen = [];
    attachShellInbox(stream, {
      onReply: (payload) => {
        seen.push(payload);
        throw new Error('boom');
      },
    });
    stream.write(`${PREFIX}1\n${PREFIX}2\n`);
    expect(seen).toEqual(['1', '2']);
  });

  it('stops after detach and leaves the end listeners alone', () => {
    const { stream, seen, detach } = setup();
    const onEnd = vi.fn();
    stream.on('end', onEnd);
    detach();
    stream.write(`${PREFIX}1\n`);
    expect(seen).toEqual([]);
    expect(stream.listenerCount('end')).toBe(1);
  });
});
