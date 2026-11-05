// Worker-thread entry for PDF and DOCX text extraction (one worker per file, terminated by parseDocs.js).
// Input arrives as workerData { kind, bytes, limits }. The FIRST message is always { ready: true }, posted once all static
// imports have loaded and before any result: parseDocs.js terminates a worker (on answer, timeout, doc_oom, error or abort)
// only after it, because terminating a worker that is still loading can crash the process natively on some Node builds.
// Then the answer is { ok: true, text, pages, totalPages, truncated }
// or { ok: false, code }. Errors carry a code only: no message text, no paths, no document content.
import { parentPort, workerData } from 'node:worker_threads';
import { DocParseError, extractDocxText, extractPdfText } from './docParsers.js';

// The parser never needs the network: any attempt to fetch fails at once.
globalThis.fetch = () => Promise.reject(new Error('network disabled'));

async function run({ kind, bytes, limits }) {
  if (kind === 'pdf') return extractPdfText(bytes, { maxPages: limits.maxPages, maxChars: limits.maxChars });
  if (kind === 'docx') return extractDocxText(bytes, limits);
  throw new DocParseError('doc_corrupt');
}

if (parentPort) {
  const port = parentPort;
  // All static imports (unpdf/pdfjs is several MB) have loaded: parseDocs.js only terminates a worker after this message.
  port.postMessage({ ready: true });
  run(workerData).then(
    (result) => port.postMessage({ ok: true, ...result }),
    (err) => port.postMessage({ ok: false, code: err instanceof DocParseError ? err.code : 'doc_corrupt' }),
  );
}
