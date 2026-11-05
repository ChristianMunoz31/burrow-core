// Desktop sidecar handshake: the shell writes a per-launch secret to our stdin as the first line
// (64 lowercase hex chars + "\n"). The secret is never logged or echoed.
const SECRET_HEX_RE = /^[0-9a-f]{64}$/;
// A valid line is 65 bytes; anything much longer without a newline is malformed, so stop buffering.
const MAX_LINE_BYTES = 256;

const ignoreStreamError = () => {};

export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Read the first stdin line and return it as the 32 secret bytes.
 * Rejects (with a generic error) on a malformed line, EOF before the newline, a stream error or timeout.
 * Bytes after the first newline are discarded.
 * @param {import('node:stream').Readable} stream
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<Buffer>}
 */
export function readSecretLine(stream, { timeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    let settled = false;
    let timer = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('close', onEnd);
      stream.off('error', onError);
      // Keep an error listener so a stream error between the handshake and the caller's own listeners
      // is not an uncaught exception.
      stream.on('error', ignoreStreamError);
      stream.pause();
    };
    const fail = (reason) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(Object.assign(new Error(`Desktop handshake failed: ${reason}`), { code: 'desktop_handshake' }));
    };
    const onEnd = () => fail('closed before the secret line');
    const onError = () => fail('stream error');
    const onData = (chunk) => {
      if (settled) return;
      buffered = Buffer.concat([buffered, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      const nl = buffered.indexOf(0x0a);
      if (nl < 0) {
        if (buffered.length > MAX_LINE_BYTES) fail('malformed secret line');
        return;
      }
      const line = buffered.subarray(0, nl).toString('latin1');
      if (!SECRET_HEX_RE.test(line)) return fail('malformed secret line');
      settled = true;
      cleanup();
      resolve(Buffer.from(line, 'hex'));
    };

    timer = setTimeout(() => fail('timed out'), timeoutMs);
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('close', onEnd);
    stream.on('error', onError);
  });
}
