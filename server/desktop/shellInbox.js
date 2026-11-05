// Shell -> server lines on stdin (desktop sidecar only), read after the one-line secret handshake. The only line the
// server understands is an authenticated dialog reply:
//   BURROW_DIALOG_REPLY {"v":1,"id":"<32 hex>","status":"...","path":"...","mac":"<64 hex>"}
// Only Burrow.exe holds the other end of this pipe, so the line cannot come from a web page or another local program;
// the MAC (server/desktop/auth.js) is a second check. Everything else is dropped without a log line, because a reply
// may carry a folder path.
import { handleDialogReplyPayload } from './dialogBroker.js';

export const DIALOG_REPLY_PREFIX = 'BURROW_DIALOG_REPLY ';
/** Longest line kept (bytes). A longer line is dropped up to its newline. */
export const MAX_INBOX_LINE_BYTES = 16384;

const NEWLINE = 0x0a;

/**
 * Listen for reply lines on `stdin`. Adds a `data` listener only; the existing end, close and error handling of the
 * server is untouched. Buffers at most MAX_INBOX_LINE_BYTES.
 * @param {import('node:stream').Readable} stdin
 * @param {{ onReply?: (payload: string) => void }} [opts] `onReply` receives the text after the prefix
 * @returns {() => void} detach function
 */
export function attachShellInbox(stdin, { onReply = handleDialogReplyPayload } = {}) {
  // ignoreBOM: a leading BOM must stay in the text so the exact-prefix check refuses it.
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let pending = Buffer.alloc(0);
  let dropping = false;

  const handleLine = (bytes) => {
    let end = bytes.length;
    if (end > 0 && bytes[end - 1] === 0x0d) end -= 1;
    let text;
    try {
      text = decoder.decode(bytes.subarray(0, end));
    } catch {
      return;
    }
    if (!text.startsWith(DIALOG_REPLY_PREFIX)) return;
    try {
      onReply(text.slice(DIALOG_REPLY_PREFIX.length));
    } catch {
      // A handler failure must never stop the inbox or the shutdown listeners.
    }
  };

  const onData = (chunk) => {
    let data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    while (data.length > 0) {
      const nl = data.indexOf(NEWLINE);
      if (nl < 0) {
        if (!dropping) {
          if (pending.length + data.length > MAX_INBOX_LINE_BYTES) {
            dropping = true;
            pending = Buffer.alloc(0);
          } else {
            pending = Buffer.concat([pending, data]);
          }
        }
        return;
      }
      const head = data.subarray(0, nl);
      data = data.subarray(nl + 1);
      if (dropping) {
        dropping = false;
        pending = Buffer.alloc(0);
        continue;
      }
      if (pending.length + head.length > MAX_INBOX_LINE_BYTES) {
        pending = Buffer.alloc(0);
        continue;
      }
      const line = pending.length > 0 ? Buffer.concat([pending, head]) : head;
      pending = Buffer.alloc(0);
      handleLine(line);
    }
  };

  stdin.on('data', onData);
  return () => stdin.off('data', onData);
}
