// Pure text extraction for PDF and DOCX bytes. Runs only inside the parser worker thread (parserWorker.js) in
// production; the tests also call it directly. Nothing here touches the file system or the network and nothing
// is evaluated: pdf.js runs with eval, font faces, XFA, workers and fetching switched off, and a DOCX is read as
// a zip whose only needed entries are inflated with hard size caps, then scanned for <w:t> text by a tiny
// tokenizer (no XML parser, so no entity expansion, DTD or external reference can ever be processed).
import { Unzip, UnzipInflate } from 'fflate';
import { getDocument } from 'unpdf/pdfjs';

/** Error with a stable code. The message is the code, never document text. */
export class DocParseError extends Error {
  /** @param {'doc_encrypted'|'doc_corrupt'|'doc_zip_limits'} code */
  constructor(code) {
    super(code);
    this.name = 'DocParseError';
    this.code = code;
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const cleanText = (s) => s.replace(CONTROL_RE, '');

/** Cut at `max` UTF-16 units without leaving half of a surrogate pair. */
function cut(text, max) {
  if (text.length <= max) return text;
  const end = text.charCodeAt(max - 1);
  return text.slice(0, end >= 0xd800 && end <= 0xdbff ? max - 1 : max);
}

/**
 * @typedef {object} ParsedDoc
 * @property {string} text
 * @property {number | null} pages Pages that were read (PDF), null for DOCX.
 * @property {number | null} totalPages Pages in the file (PDF), null for DOCX.
 * @property {boolean} truncated True when the page cap or the text cap cut the output.
 * @property {number[] | null} [pageLengths] PDF only: the length of each page's text in the order joined with one newline between pages
 *   (null when a page failed to read, so the numbering is unknown, and for DOCX). Used only to place page breaks in a preview.
 */

/**
 * Text of a PDF: the first `maxPages` pages, cut at `maxChars`.
 * @param {Uint8Array} bytes
 * @param {{ maxPages: number, maxChars: number }} limits
 * @returns {Promise<ParsedDoc>}
 * @throws {DocParseError} doc_encrypted (a password is needed), doc_corrupt
 */
export async function extractPdfText(bytes, { maxPages, maxChars }) {
  const task = getDocument({
    data: bytes,
    // No script, no network, no fonts or character maps loaded from anywhere: text only.
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    useWorkerFetch: false,
    disableAutoFetch: true,
    disableStream: true,
    disableRange: true,
    verbosity: 0,
  });
  try {
    let doc;
    try {
      doc = await task.promise;
    } catch (err) {
      throw new DocParseError(err?.name === 'PasswordException' ? 'doc_encrypted' : 'doc_corrupt');
    }
    const totalPages = doc.numPages;
    const limit = Math.min(totalPages, maxPages);
    const parts = [];
    let length = 0;
    let read = 0;
    let failed = 0;
    let truncated = totalPages > limit;
    for (let i = 1; i <= limit; i += 1) {
      let pageText = '';
      try {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        pageText = content.items.map((item) => (typeof item.str === 'string' ? item.str + (item.hasEOL ? '\n' : '') : '')).join('');
        page.cleanup();
      } catch {
        failed += 1;
        continue;
      }
      read += 1;
      const cleaned = cleanText(pageText);
      parts.push(cleaned);
      length += cleaned.length + 1;
      if (length > maxChars) {
        truncated = true;
        break;
      }
    }
    if (failed > 0 && read === 0) throw new DocParseError('doc_corrupt');
    return { text: cut(parts.join('\n'), maxChars), pages: read, totalPages, truncated, pageLengths: failed === 0 ? parts.map((part) => part.length) : null };
  } finally {
    await task.destroy().catch(() => {});
  }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Only the five predefined entities and numeric references; anything else stays as it is. */
function decodeEntities(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/g, (m, body) => {
    if (body[0] !== '#') return ENTITIES[body];
    const cp = body[1] === 'x' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
    if (!Number.isInteger(cp) || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) || cp === 0) return '';
    return String.fromCodePoint(cp);
  });
}

const nameEnd = (tag) => {
  for (let i = 0; i < tag.length; i += 1) {
    const c = tag.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 47) return i;
  }
  return tag.length;
};

/**
 * The text of a WordprocessingML part: `<w:t>` runs, tabs, breaks, and a line break after each paragraph.
 * Stops once `maxChars` is reached.
 * @param {string} xml
 * @param {number} maxChars
 * @returns {string}
 */
export function wordXmlToText(xml, maxChars) {
  const out = [];
  let length = 0;
  let i = 0;
  const push = (s) => {
    out.push(s);
    length += s.length;
  };
  while (i < xml.length && length <= maxChars) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) break;
    const gt = xml.indexOf('>', lt + 1);
    if (gt === -1) break;
    const tag = xml.slice(lt + 1, gt);
    i = gt + 1;
    const first = tag.charCodeAt(0);
    if (first === 33 || first === 63) continue; // <! (comment, CDATA marker, DOCTYPE) and <? (declaration): ignored
    const closing = first === 47;
    const name = closing ? tag.slice(1, nameEnd(tag.slice(1)) + 1) : tag.slice(0, nameEnd(tag));
    const selfClosing = tag.charCodeAt(tag.length - 1) === 47;
    if (closing) {
      if (name === 'w:p') push('\n');
    } else if (name === 'w:t') {
      if (selfClosing) continue;
      const end = xml.indexOf('</w:t>', i);
      if (end === -1) break;
      push(decodeEntities(xml.slice(i, end)));
      i = end + 6;
    } else if (name === 'w:tab') push('\t');
    else if (name === 'w:br' || name === 'w:cr') push('\n');
  }
  return out.join('');
}

const WANTED_PART = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;
const SLICE = 16 * 1024;

/** document.xml first (so a text cap keeps the body), then the other parts by name. */
const partOrder = (a, b) => (a === 'word/document.xml' ? -1 : b === 'word/document.xml' ? 1 : a < b ? -1 : a > b ? 1 : 0);

/**
 * Text of a DOCX: the body, headers, footers, footnotes and endnotes. Zip-bomb guards: at most `maxEntries`
 * entries, a declared size over the cap is refused before inflating, and the bytes that are actually inflated are
 * counted per entry and in total (the declared size is never trusted). Unneeded entries (images, fonts, embedded
 * files) are never inflated. The input is fed in small slices so one inflate burst stays small.
 * @param {Uint8Array} bytes
 * @param {{ maxChars: number, maxEntries: number, maxEntryBytes: number, maxTotalBytes: number }} limits
 * @returns {ParsedDoc}
 * @throws {DocParseError} doc_corrupt, doc_zip_limits
 */
export function extractDocxText(bytes, { maxChars, maxEntries, maxEntryBytes, maxTotalBytes }) {
  const parts = new Map();
  let entries = 0;
  let total = 0;
  let violation = null;
  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.onfile = (file) => {
    entries += 1;
    if (entries > maxEntries) violation ??= 'doc_zip_limits';
    if (violation || !WANTED_PART.test(file.name)) return;
    if (typeof file.originalSize === 'number' && file.originalSize > maxEntryBytes) {
      violation = 'doc_zip_limits';
      return;
    }
    const chunks = [];
    let size = 0;
    file.ondata = (err, chunk, final) => {
      if (violation) return;
      if (err) {
        violation = 'doc_corrupt';
        return;
      }
      size += chunk.length;
      total += chunk.length;
      if (size > maxEntryBytes || total > maxTotalBytes) {
        violation = 'doc_zip_limits';
        file.terminate();
        return;
      }
      chunks.push(chunk);
      if (final) parts.set(file.name, Buffer.concat(chunks));
    };
    file.start();
  };
  try {
    for (let at = 0; at < bytes.length && !violation; at += SLICE) {
      unzip.push(bytes.subarray(at, Math.min(bytes.length, at + SLICE)), at + SLICE >= bytes.length);
    }
  } catch {
    throw new DocParseError(violation ?? 'doc_corrupt');
  }
  if (violation) throw new DocParseError(violation);
  if (!parts.has('word/document.xml')) throw new DocParseError('doc_corrupt');
  const decoder = new TextDecoder('utf-8');
  const texts = [];
  let length = 0;
  let truncated = false;
  for (const name of [...parts.keys()].sort(partOrder)) {
    const text = wordXmlToText(decoder.decode(parts.get(name)), maxChars - length + 1);
    if (text.trim() === '') continue;
    texts.push(text);
    length += text.length + 1;
    if (length > maxChars) {
      truncated = true;
      break;
    }
  }
  return { text: cut(cleanText(texts.join('\n')).replace(/\n{3,}/g, '\n\n'), maxChars), pages: null, totalPages: null, truncated };
}
