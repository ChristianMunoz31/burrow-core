// Parser worker tests: they need document parsing on and start real parser workers, so they run only in `npm run test:parser`
// (vitest.parser.config.js, issue #67) and return to the default suite when the parser runs in its own process.
// PDF and DOCX text extraction for Folders: the pure parsers, the worker wrapper (timeout, abort, crash, memory),
// the embedded worker bundle the sidecar uses, and readTextFile's routing and safety checks. All documents are
// generated in code (helpers/synthDocs.js).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { strToU8, zipSync } from 'fflate';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildParserWorkerSource } from '../../scripts/desktop/workerBundle.js';
import { LIMITS } from '../folders/constants.js';
import { extractDocxText, extractPdfText, wordXmlToText } from '../folders/docParsers.js';
import { readTextFile } from '../folders/extract.js';
import { __setParserTimeoutForTests, __setParserWorkerFactoryForTests, activeParserWorkerCount, parseDocument } from '../folders/parseDocs.js';
import { makeTmp, rmTree } from './helpers/foldersEnv.js';
import { makeDocx, makePdf } from './helpers/synthDocs.js';

const PDF_LIMITS = { maxPages: 200, maxChars: 2_000_000 };
const DOCX_LIMITS = { maxChars: 2_000_000, maxEntries: 5000, maxEntryBytes: 20 * 1024 * 1024, maxTotalBytes: 40 * 1024 * 1024 };
const WIN = process.platform === 'win32';
const fold = (p) => (WIN ? p.toLowerCase() : p);

/** A worker that never answers (stays alive until terminated). */
const hangingFactory = (made) => () => {
  const w = new Worker("require('node:worker_threads').parentPort.postMessage({ ready: true }); setInterval(() => {}, 1000);", { eval: true });
  made.push(w);
  return w;
};

afterEach(() => {
  __setParserWorkerFactoryForTests(null);
  __setParserTimeoutForTests(null);
});

describe('extractPdfText', () => {
  it('reads the text of every page, in order', async () => {
    const out = await extractPdfText(new Uint8Array(makePdf([['Garden plan', 'Tomatoes and peppers'], ['Water every morning']])), PDF_LIMITS);
    expect(out.text).toContain('Garden plan');
    expect(out.text).toContain('Tomatoes and peppers');
    expect(out.text.indexOf('Tomatoes')).toBeLessThan(out.text.indexOf('Water every morning'));
    expect(out).toMatchObject({ pages: 2, totalPages: 2, truncated: false });
  });

  it('stops at the page cap and says so', async () => {
    const pages = Array.from({ length: 5 }, (_, i) => [`Page number ${i + 1}`]);
    const out = await extractPdfText(new Uint8Array(makePdf(pages)), { maxPages: 2, maxChars: 1000 });
    expect(out).toMatchObject({ pages: 2, totalPages: 5, truncated: true });
    expect(out.text).toContain('Page number 2');
    expect(out.text).not.toContain('Page number 3');
  });

  it('cuts the text at the output cap', async () => {
    const out = await extractPdfText(new Uint8Array(makePdf([['x'.repeat(300)], ['y'.repeat(300)]])), { maxPages: 200, maxChars: 100 });
    expect(out.text.length).toBeLessThanOrEqual(100);
    expect(out.truncated).toBe(true);
  });

  it('a PDF with no text gives an empty string', async () => {
    const out = await extractPdfText(new Uint8Array(makePdf([[]])), PDF_LIMITS);
    expect(out.text.trim()).toBe('');
  });

  it('an encrypted PDF is doc_encrypted', async () => {
    await expect(extractPdfText(new Uint8Array(makePdf([['secret']], { encrypted: true })), PDF_LIMITS)).rejects.toMatchObject({ code: 'doc_encrypted' });
  });

  it.each([
    ['random bytes', Buffer.from('this is not a pdf at all, just some words')],
    ['a truncated PDF', makePdf([['Hello']]).subarray(0, 120)],
    ['an empty buffer', Buffer.alloc(0)],
  ])('%s is doc_corrupt', async (_name, bytes) => {
    await expect(extractPdfText(new Uint8Array(bytes), PDF_LIMITS)).rejects.toMatchObject({ code: 'doc_corrupt' });
  });
});

describe('wordXmlToText', () => {
  it('reads runs, tabs, breaks and paragraphs and decodes the predefined entities', () => {
    const xml = '<w:body><w:p><w:r><w:t>Fish &amp; chips</w:t><w:tab/><w:t xml:space="preserve"> &lt;hot&gt; &#65;&#x42;</w:t></w:r></w:p><w:p><w:r><w:t>Line</w:t><w:br/><w:t>two</w:t><w:delText>gone</w:delText></w:r></w:p></w:body>';
    expect(wordXmlToText(xml, 1000)).toBe('Fish & chips\t <hot> AB\nLine\ntwo\n');
  });

  it('never expands a custom entity or reads a DOCTYPE', () => {
    const xml = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY boom "BOOM"><!ENTITY ext SYSTEM "file:///nope">]><w:p><w:t>a&boom;b&ext;c</w:t></w:p>';
    expect(wordXmlToText(xml, 1000)).toBe('a&boom;b&ext;c\n');
  });

  it('survives unterminated markup and respects the cap', () => {
    expect(wordXmlToText('<w:p><w:t>open', 100)).toBe('');
    expect(wordXmlToText('<w:p><w:t>abc', 100)).toBe('');
    expect(wordXmlToText(`<w:p>${'<w:t>word </w:t>'.repeat(10000)}</w:p>`, 50).length).toBeLessThan(80);
  });
});

describe('extractDocxText', () => {
  it('reads the body, header and footer', () => {
    const out = extractDocxText(new Uint8Array(makeDocx(['First paragraph', 'Second paragraph'], { header: 'Header words', footer: 'Footer words' })), DOCX_LIMITS);
    expect(out.text.startsWith('First paragraph\nSecond paragraph')).toBe(true);
    expect(out.text).toContain('Header words');
    expect(out.text).toContain('Footer words');
    expect(out).toMatchObject({ pages: null, truncated: false });
  });

  it('cuts at the output cap', () => {
    const out = extractDocxText(new Uint8Array(makeDocx(['a'.repeat(500), 'b'.repeat(500)])), { ...DOCX_LIMITS, maxChars: 100 });
    expect(out.text.length).toBeLessThanOrEqual(100);
    expect(out.truncated).toBe(true);
  });

  it('a zip that is not a DOCX, and plain garbage, are doc_corrupt', () => {
    const notDocx = zipSync({ 'xl/workbook.xml': strToU8('<x/>') });
    expect(() => extractDocxText(new Uint8Array(notDocx), DOCX_LIMITS)).toThrowError(expect.objectContaining({ code: 'doc_corrupt' }));
    expect(() => extractDocxText(new Uint8Array(Buffer.from('definitely not a zip file')), DOCX_LIMITS)).toThrowError(expect.objectContaining({ code: 'doc_corrupt' }));
  });

  it('too many entries is doc_zip_limits', () => {
    const extra = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`word/media/img${i}.bin`, strToU8('x')]));
    expect(() => extractDocxText(new Uint8Array(makeDocx(['hi'], { extraEntries: extra })), { ...DOCX_LIMITS, maxEntries: 10 })).toThrowError(
      expect.objectContaining({ code: 'doc_zip_limits' }),
    );
  });

  it('a declared uncompressed size over the cap is refused', () => {
    const big = zipSync({ 'word/document.xml': strToU8(`<w:p><w:t>${'a'.repeat(3_000_000)}</w:t></w:p>`) });
    expect(big.length).toBeLessThan(50_000); // a bomb: tiny on disk, 3 MB inflated
    expect(() => extractDocxText(big, { ...DOCX_LIMITS, maxEntryBytes: 1_000_000 })).toThrowError(expect.objectContaining({ code: 'doc_zip_limits' }));
  });

  it('counts the bytes that really inflate, not the size the header claims', () => {
    const big = Buffer.from(zipSync({ 'word/document.xml': strToU8(`<w:p><w:t>${'a'.repeat(3_000_000)}</w:t></w:p>`) }));
    expect(big.readUInt32LE(0)).toBe(0x04034b50);
    big.writeUInt32LE(10, 22); // the local header now claims 10 bytes
    expect(() => extractDocxText(new Uint8Array(big), { ...DOCX_LIMITS, maxEntryBytes: 1_000_000 })).toThrowError(expect.objectContaining({ code: 'doc_zip_limits' }));
  });

  it('the total across entries is capped too', () => {
    const part = strToU8(`<w:p><w:t>${'a'.repeat(400_000)}</w:t></w:p>`);
    const zip = zipSync({ 'word/document.xml': part, 'word/header1.xml': part, 'word/footer1.xml': part });
    expect(() => extractDocxText(zip, { ...DOCX_LIMITS, maxEntryBytes: 1_000_000, maxTotalBytes: 900_000 })).toThrowError(expect.objectContaining({ code: 'doc_zip_limits' }));
  });
});

describe('parseDocument (worker thread)', () => {
  it('extracts a PDF and a DOCX in a real worker and leaves none running', async () => {
    const pdf = await parseDocument('pdf', makePdf([['Quarterly notes for the garden club']]));
    expect(pdf.text).toContain('Quarterly notes for the garden club');
    expect(pdf).toMatchObject({ pages: 1, totalPages: 1 });
    const docx = await parseDocument('docx', makeDocx(['Minutes of the meeting']));
    expect(docx.text).toContain('Minutes of the meeting');
    expect(activeParserWorkerCount()).toBe(0);
  }, 30_000);

  it('does not touch the caller buffer', async () => {
    const bytes = makePdf([['Keep me intact']]);
    const copy = Buffer.from(bytes);
    await parseDocument('pdf', bytes);
    expect(bytes.equals(copy)).toBe(true);
  }, 30_000);

  it.each([
    ['an encrypted PDF', 'pdf', () => makePdf([['x']], { encrypted: true }), 'doc_encrypted'],
    ['a corrupt PDF', 'pdf', () => Buffer.from('%PDF-1.4 garbage garbage'), 'doc_corrupt'],
    ['a corrupt DOCX', 'docx', () => Buffer.from('PK nothing here'), 'doc_corrupt'],
  ])('%s is a coded error', async (_n, kind, make, code) => {
    await expect(parseDocument(kind, make())).rejects.toMatchObject({ code });
    expect(activeParserWorkerCount()).toBe(0);
  }, 30_000);

  it('a worker that never answers is terminated at the timeout', async () => {
    const made = [];
    __setParserWorkerFactoryForTests(hangingFactory(made));
    const exited = new Promise((resolve) => setTimeout(resolve, 0)).then(() => new Promise((resolve) => made[0].once('exit', resolve)));
    await expect(parseDocument('pdf', makePdf([['x']]), { timeoutMs: 100 })).rejects.toMatchObject({ code: 'doc_timeout' });
    await exited.catch(() => {});
    expect(activeParserWorkerCount()).toBe(0);
    expect(made[0].threadId).toBe(-1); // terminated
  });

  it('the forced timeout seam applies to every call', async () => {
    __setParserWorkerFactoryForTests(hangingFactory([]));
    __setParserTimeoutForTests(50);
    await expect(parseDocument('docx', makeDocx(['x']))).rejects.toMatchObject({ code: 'doc_timeout' });
  });

  it('an abort terminates the running worker and rejects with an AbortError', async () => {
    const made = [];
    __setParserWorkerFactoryForTests(hangingFactory(made));
    const controller = new AbortController();
    const pending = parseDocument('pdf', makePdf([['x']]), { signal: controller.signal, timeoutMs: 60_000 });
    expect(activeParserWorkerCount()).toBe(1);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError', aborted: true });
    expect(activeParserWorkerCount()).toBe(0);
    expect(made[0].threadId).toBe(-1);
  });

  it('an already aborted signal never starts a worker', async () => {
    const made = [];
    __setParserWorkerFactoryForTests(hangingFactory(made));
    const controller = new AbortController();
    controller.abort();
    await expect(parseDocument('pdf', makePdf([['x']]), { signal: controller.signal })).rejects.toMatchObject({ aborted: true });
    expect(made).toHaveLength(0);
  });

  it('a worker that crashes, runs out of memory or cannot start gives a coded error', async () => {
    __setParserWorkerFactoryForTests(() => new Worker("throw new Error('boom');", { eval: true }));
    await expect(parseDocument('pdf', makePdf([['x']]))).rejects.toMatchObject({ code: 'doc_crashed' });
    __setParserWorkerFactoryForTests(
      () => new Worker('const keep = []; for (;;) keep.push(new Array(1e5).fill(1));', { eval: true, resourceLimits: { maxOldGenerationSizeMb: 16 } }),
    );
    await expect(parseDocument('pdf', makePdf([['x']]))).rejects.toMatchObject({ code: 'doc_oom' });
    __setParserWorkerFactoryForTests(() => {
      throw new Error('no threads');
    });
    await expect(parseDocument('pdf', makePdf([['x']]))).rejects.toMatchObject({ code: 'doc_unavailable' });
    expect(activeParserWorkerCount()).toBe(0);
  }, 30_000);

  it('hands the worker the document limits and nothing else', async () => {
    let seen;
    __setParserWorkerFactoryForTests(({ kind, bytes, limits }) => {
      seen = { kind, limits, keys: Object.keys({ kind, bytes, limits }) };
      return new Worker("require('node:worker_threads').parentPort.postMessage({ ready: true }); setInterval(() => {}, 1000);", { eval: true });
    });
    await expect(parseDocument('docx', makeDocx(['x']), { timeoutMs: 50 })).rejects.toMatchObject({ code: 'doc_timeout' });
    expect(seen.limits).toEqual({
      maxPages: LIMITS.maxDocPages,
      maxChars: LIMITS.maxFileBytes,
      maxEntries: LIMITS.docxMaxEntries,
      maxEntryBytes: LIMITS.docxMaxEntryBytes,
      maxTotalBytes: LIMITS.docxMaxTotalBytes,
    });
  });
});

describe.each([{ minify: false }, { minify: true }])('embedded parser worker bundle (minify: $minify)', ({ minify }) => {
  let src;
  beforeAll(async () => {
    src = await buildParserWorkerSource({ minify });
  }, 60_000);

  it('is one source string that requires only node: built-ins and no URL loading', () => {
    expect(src.length).toBeGreaterThan(100_000);
    const required = [...src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
    for (const name of required) expect(name.startsWith('node:'), name).toBe(true);
    expect(src).not.toMatch(/\bimport\.meta\.url\b(?!\s*:)/);
  });

  it('extracts a PDF and a DOCX through the eval worker, like the sidecar does', async () => {
    __setParserWorkerFactoryForTests(({ kind, bytes, limits }) => new Worker(src, { eval: true, env: {}, workerData: { kind, bytes, limits }, transferList: [bytes.buffer] }));
    const pdf = await parseDocument('pdf', makePdf([['Bundled worker reads this']]));
    expect(pdf.text).toContain('Bundled worker reads this');
    const docx = await parseDocument('docx', makeDocx(['Bundled docx paragraph']));
    expect(docx.text).toContain('Bundled docx paragraph');
    await expect(parseDocument('pdf', makePdf([['x']], { encrypted: true }))).rejects.toMatchObject({ code: 'doc_encrypted' });
  }, 60_000);

  it('posts { ready: true } as its first message, before any result', async () => {
    const messages = [];
    const worker = new Worker(src, {
      eval: true,
      env: {},
      workerData: { kind: 'pdf', bytes: new Uint8Array(makePdf([['Ready first']])), limits: { maxPages: 200, maxChars: 2_000_000 } },
    });
    try {
      await new Promise((resolve, reject) => {
        worker.on('error', reject);
        worker.on('message', (msg) => {
          messages.push(msg);
          if (msg.ok !== undefined) resolve();
        });
      });
    } finally {
      await worker.terminate();
    }
    expect(messages[0]).toEqual({ ready: true });
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ ok: true });
    expect(messages[1].text).toContain('Ready first');
  }, 60_000);
});

describe('readTextFile with documents', () => {
  let dir;
  let key;
  const put = (name, content) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    return file;
  };
  const read = (file, opts = {}) => readTextFile(file, { rootKey: key, ...opts });

  beforeAll(() => {
    dir = fs.realpathSync.native(makeTmp('burrow-folders-docs-'));
    key = fold(dir);
  });
  afterAll(() => rmTree(dir));

  it('reads a PDF and a DOCX as text with counts and the hash of the raw bytes', async () => {
    const pdfBytes = makePdf([['Alpha beta gamma', 'delta']]);
    const pdf = await read(put('a.pdf', pdfBytes));
    expect(pdf).toMatchObject({ status: 'ok', pages: 1, words: 4, lines: 2, sizeBytes: pdfBytes.length });
    expect(pdf.sha256).toMatch(/^[0-9a-f]{64}$/);
    const docx = await read(put('a.docx', makeDocx(['One two three'])));
    expect(docx).toMatchObject({ status: 'ok', words: 3 });
    expect(docx.text).toContain('One two three');
  }, 30_000);

  it('uses the document byte cap, not the 2 MB text cap', async () => {
    const filler = { 'word/media/big.bin': new Uint8Array(crypto.randomBytes(3 * 1024 * 1024)) };
    const big = makeDocx(['Small text in a big file'], { extraEntries: filler });
    expect(big.length).toBeGreaterThan(LIMITS.maxFileBytes);
    expect(await read(put('big.docx', big))).toMatchObject({ status: 'ok' });
    expect(await read(put('big.docx', big), { maxBytes: 1024 })).toMatchObject({ status: 'too_large' });
    const text = Buffer.alloc(LIMITS.maxFileBytes + 10, 97);
    expect(await read(put('big.txt', text))).toMatchObject({ status: 'too_large' });
  }, 30_000);

  it('encrypted, corrupt and non-document bytes are unreadable, never a throw', async () => {
    const enc = await read(put('enc.pdf', makePdf([['x']], { encrypted: true })));
    expect(enc.status).toBe('unreadable');
    expect(enc.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await read(put('bad.pdf', Buffer.from('not a pdf')))).status).toBe('unreadable');
    expect((await read(put('bad.docx', Buffer.from('not a zip')))).status).toBe('unreadable');
    expect((await read(put('empty.pdf', Buffer.alloc(0)))).status).toBe('empty');
  }, 30_000);

  it('a scanned-style PDF with no text is empty', async () => {
    expect(await read(put('blank.pdf', makePdf([[]])))).toMatchObject({ status: 'empty', words: 0 });
  }, 30_000);

  it('a timeout or crash is unreadable', async () => {
    __setParserWorkerFactoryForTests(hangingFactory([]));
    __setParserTimeoutForTests(100);
    expect((await read(put('slow.pdf', makePdf([['x']])))).status).toBe('unreadable');
    expect(activeParserWorkerCount()).toBe(0);
  });

  it('an abort rejects instead of being swallowed as unreadable', async () => {
    __setParserWorkerFactoryForTests(hangingFactory([]));
    const controller = new AbortController();
    const pending = read(put('abort.pdf', makePdf([['x']])), { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ aborted: true });
    expect(activeParserWorkerCount()).toBe(0);
  });

  it('a file outside the root never reaches the worker', async () => {
    let started = 0;
    __setParserWorkerFactoryForTests(() => {
      started += 1;
      return new Worker("require('node:worker_threads').parentPort.postMessage({ ready: true }); setInterval(() => {}, 1000);", { eval: true });
    });
    const other = fs.realpathSync.native(makeTmp('burrow-folders-docs-other-'));
    try {
      const file = path.join(other, 'outside.pdf');
      fs.writeFileSync(file, makePdf([['x']]));
      expect((await read(file)).status).toBe('outside_root');
      expect(started).toBe(0);
    } finally {
      rmTree(other);
    }
  });

  it('reading a document never changes it', async () => {
    const file = put('same.docx', makeDocx(['unchanged']));
    const before = fs.readFileSync(file);
    const mtime = fs.statSync(file).mtimeMs;
    await read(file);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
  }, 30_000);
});
