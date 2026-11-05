// Size limits for bodies read from a model server (local Ollama or a cloud endpoint). A
// misbehaving or hostile server must not be able to make Burrow buffer without bound.

/** Error bodies are only kept for classification; a few KB is plenty. */
export const MAX_ERROR_BODY_BYTES = 8 * 1024;
/** JSON bodies (/api/tags, /api/show, a non-streaming chat completion). */
export const MAX_JSON_BODY_BYTES = 5 * 1024 * 1024;
/** One NDJSON or SSE line. A real frame is a few hundred bytes. */
export const MAX_LINE_CHARS = 1024 * 1024;
/** Text accumulated from one model call (complete() / chatWithTools()). */
export const MAX_CONTENT_CHARS = 512 * 1024;

/** The body was larger than allowed. Never carries any of the body. */
export class BodyTooLargeError extends Error {
  constructor(what = 'response') {
    super(`The model server sent a ${what} that is too large`);
    this.name = 'BodyTooLargeError';
    this.code = 'not_ollama';
  }
}

const destroy = (res) => {
  try {
    res?.body?.destroy?.();
  } catch {
    /* ignore */
  }
};

/**
 * Read a response body as text with a byte cap. Never buffers more than the cap plus one chunk.
 * @param {{ body?: AsyncIterable<Uint8Array|string> & { destroy?: () => void }, text?: () => Promise<string>,
 *   headers?: { get?: (name: string) => string | null } }} res
 * @param {number} maxBytes
 * @param {{ truncate?: boolean }} [opts] truncate: return the first `maxBytes` instead of throwing.
 * @returns {Promise<string>}
 * @throws {BodyTooLargeError} When over the cap and `truncate` is false.
 */
export async function readCappedText(res, maxBytes, { truncate = false } = {}) {
  const declared = Number(res?.headers?.get?.('content-length'));
  if (!truncate && Number.isFinite(declared) && declared > maxBytes) {
    destroy(res);
    throw new BodyTooLargeError();
  }
  const body = res?.body;
  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    let total = 0;
    for await (const chunk of body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (total + buf.length > maxBytes) {
        destroy(res);
        if (!truncate) throw new BodyTooLargeError();
        chunks.push(buf.subarray(0, maxBytes - total));
        break;
      }
      chunks.push(buf);
      total += buf.length;
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  if (typeof res?.text === 'function') {
    const text = String(await res.text());
    if (Buffer.byteLength(text) <= maxBytes) return text;
    if (!truncate) throw new BodyTooLargeError();
    return Buffer.from(text).subarray(0, maxBytes).toString('utf8');
  }
  return '';
}

/**
 * Read and parse a JSON body with a byte cap. Falls back to res.json() for bodies that are
 * not streams (test doubles).
 * @param {object} res
 * @param {number} [maxBytes]
 * @returns {Promise<unknown>}
 * @throws {BodyTooLargeError | SyntaxError}
 */
export async function readCappedJson(res, maxBytes = MAX_JSON_BODY_BYTES) {
  const body = res?.body;
  if (body && typeof body[Symbol.asyncIterator] === 'function') return JSON.parse(await readCappedText(res, maxBytes));
  const declared = Number(res?.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLargeError();
  if (typeof res?.json === 'function') return res.json();
  return JSON.parse(await readCappedText(res, maxBytes));
}
