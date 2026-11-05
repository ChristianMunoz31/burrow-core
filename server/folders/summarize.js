// Map-reduce summaries over the shared AI client. Every call passes a literal `scope` (category `folders`), so a
// cloud client enforces the user's choice before anything is sent, and every result goes through sanitizeModelText.
// Errors are never turned into text here: they propagate as they are and the caller classifies them.
import { AiBusyError, contextBudgetChars, sanitizeModelText } from '../ai/index.js';
import { pickSummaryParts } from './chunk.js';
import { fileMapMessages, fileReduceMessages, fileSingleMessages, folderBatchMessages, folderFinalMessages } from './prompts.js';

const TEMPERATURE = 0.2;
const TIMEOUT_MS = 180_000;
const FILE_CLIP = 600;
const FOLDER_CLIP = 2000;
const MAX_REDUCE_LEVELS = 3;
const BATCH_CHARS = 6000;

let busyDelaysMs = [5000, 15000, 30000];

/**
 * Test seam: the waits before the three retries of a busy AI queue.
 * @param {number[] | null} delays
 */
export function __setBusyDelaysForTests(delays) {
  if (!process.env.VITEST) throw new Error('__setBusyDelaysForTests is a test seam');
  busyDelaysMs = Array.isArray(delays) ? delays : [5000, 15000, 30000];
}

/** An empty model reply. The caller counts the file or the folder as failed. */
export class EmptyOutputError extends Error {
  constructor() {
    super('The model returned no text');
    this.name = 'EmptyOutputError';
    this.code = 'folder_empty_output';
  }
}

const wait = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('Aborted'), { name: 'AbortError', aborted: true }));
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError', aborted: true }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** Clip at a sentence end when one is near the limit, else at a word. */
export function clipText(text, max) {
  const t = String(text ?? '').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (sentence >= max * 0.5) return cut.slice(0, sentence + 1).trim();
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.5 ? cut.slice(0, space) : cut).trim();
}

/**
 * Run `fn`, retrying it when the AI queue is full (after 5, 15 and 30 s, each wait stops when `signal` aborts).
 * After the third retry the busy error propagates.
 * @template T
 * @param {() => Promise<T>} fn
 * @param {AbortSignal} [signal]
 * @returns {Promise<T>}
 */
export async function retryWhenBusy(fn, signal) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof AiBusyError) || attempt >= busyDelaysMs.length) throw err;
      await wait(busyDelaysMs[attempt], signal);
    }
  }
}

/**
 * One model call with the busy-queue retry, the literal folders scope and the output clean-up.
 * @param {{ complete: Function }} client
 * @param {Array<{ role: string, content: string }>} messages
 * @param {{ maxTokens: number, clip: number, signal?: AbortSignal }} opts
 * @returns {Promise<string>}
 */
export async function askFolderModel(client, messages, { maxTokens, clip, signal }) {
  return retryWhenBusy(async () => {
    const out = await client.complete({
      messages,
      maxTokens,
      temperature: TEMPERATURE,
      signal,
      timeoutMs: TIMEOUT_MS,
      scope: { categories: ['folders'] },
    });
    const text = clipText(sanitizeModelText(out?.content ?? ''), clip);
    if (text === '') throw new EmptyOutputError();
    return text;
  }, signal);
}

/**
 * Summarize one file: one call for a short file, else up to 4 window notes plus one reduce.
 * @param {{ client: object, text: string, relPath: string, facts: Record<string, string>, signal?: AbortSignal }} args
 * @returns {Promise<string>}
 */
export async function summarizeFile({ client, text, relPath, facts, signal }) {
  const parts = pickSummaryParts(text);
  if (parts.length === 1) {
    return askFolderModel(client, fileSingleMessages({ relPath, facts, text: parts[0] }), { maxTokens: 200, clip: FILE_CLIP, signal });
  }
  const notes = [];
  for (let i = 0; i < parts.length; i += 1) {
    notes.push(await askFolderModel(client, fileMapMessages({ relPath, facts, text: parts[i], index: i, parts: parts.length }), { maxTokens: 160, clip: FILE_CLIP, signal }));
  }
  return askFolderModel(client, fileReduceMessages({ relPath, facts, notes }), { maxTokens: 200, clip: FILE_CLIP, signal });
}

/** Group lines into batches of at most `budget` characters (a longer line is clipped). */
function batches(lines, budget) {
  const out = [];
  let cur = [];
  let size = 0;
  for (const raw of lines) {
    const line = raw.length > budget ? raw.slice(0, budget) : raw;
    if (cur.length && size + line.length + 1 > budget) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(line);
    size += line.length + 1;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Condense `notes` until they fit one batch (at most 3 levels), then return that batch's lines. */
export async function reduceNotes(client, facts, notes, { signal }) {
  const budget = Math.min(BATCH_CHARS, contextBudgetChars(client, { maxTokens: 400, reserveChars: 1500 }));
  let lines = notes;
  for (let level = 0; level < MAX_REDUCE_LEVELS; level += 1) {
    const groups = batches(lines, budget);
    if (groups.length <= 1) return groups[0] ?? [];
    const next = [];
    for (let i = 0; i < groups.length; i += 1) {
      const note = await askFolderModel(client, folderBatchMessages({ facts, lines: groups[i] }), { maxTokens: 300, clip: 1200, signal });
      next.push(`- group ${i + 1}: ${note}`);
    }
    lines = next;
  }
  return batches(lines, budget)[0] ?? [];
}

/**
 * Describe a folder from the precomputed facts and the file notes (`"- path: summary"` lines).
 * @param {{ client: object, facts: Record<string, string>, notes: string[], signal?: AbortSignal }} args
 * @returns {Promise<string>}
 */
export async function summarizeFolder({ client, facts, notes, signal }) {
  const lines = await reduceNotes(client, facts, notes, { signal });
  return askFolderModel(client, folderFinalMessages({ facts, lines }), { maxTokens: 450, clip: FOLDER_CLIP, signal });
}
