// Streaming version of sanitizeModelText. Text is buffered and released only up to the
// last "safe cut", a point where cleaning the two halves separately gives the same result
// as cleaning the whole. Invariant (for any split of a string s into pushes):
//   concat(push(...)) + flush() === sanitizeModelText(s)
// A safe cut is a whitespace character such that:
//   - the next character is a letter (\p{L});
//   - the previous non-space character is not a dash (or hyphen) or a digit;
//   - an even number of ``` fences precede it, and every backtick before it sits inside a
//     closed code span (so no span can still open or close across the cut).
// If no safe cut appears within FORCE_RELEASE_CHARS, the buffer is released anyway.
import { CODE_SPAN_RE, sanitizeModelText } from './textSanitize.js';

export const FORCE_RELEASE_CHARS = 512;

const LETTER_RE = /\p{L}/u;
const SPACE_RE = /\s/;
const DASH_OR_DIGIT_RE = /[-‐-―−⸺⸻︱︲﹘﹣－0-9]/;

/** Whether every backtick in `prefix` is inside a closed span, with an even fence count. */
function codeBalanced(prefix) {
  if (!prefix.includes('`')) return true;
  const fences = (prefix.match(/```/g) || []).length;
  if (fences % 2 !== 0) return false;
  const parts = prefix.split(CODE_SPAN_RE);
  for (let i = 0; i < parts.length; i += 2) {
    if (parts[i].includes('`')) return false;
  }
  return true;
}

/**
 * Index of the last safe cut in `text` (the whitespace char to include), or -1.
 * @param {string} text
 * @returns {number}
 */
export function lastSafeCut(text) {
  for (let i = text.length - 2; i >= 0; i -= 1) {
    if (!SPACE_RE.test(text[i]) || !LETTER_RE.test(text[i + 1])) continue;
    let j = i - 1;
    while (j >= 0 && SPACE_RE.test(text[j])) j -= 1;
    if (j >= 0 && DASH_OR_DIGIT_RE.test(text[j])) continue;
    if (!codeBalanced(text.slice(0, i + 1))) continue;
    return i;
  }
  return -1;
}

/**
 * @param {{ enabled?: boolean }} [opts] enabled=false passes text through untouched.
 * @returns {{ push: (text: string) => string, flush: () => string }}
 */
export function createStreamSanitizer({ enabled = true } = {}) {
  let pending = '';
  if (!enabled) {
    return { push: (text) => (typeof text === 'string' ? text : ''), flush: () => '' };
  }
  return {
    push(text) {
      if (typeof text !== 'string' || text === '') return '';
      pending += text;
      const cut = lastSafeCut(pending);
      if (cut === -1) {
        if (pending.length <= FORCE_RELEASE_CHARS) return '';
        const out = sanitizeModelText(pending);
        pending = '';
        return out;
      }
      const head = pending.slice(0, cut + 1);
      pending = pending.slice(cut + 1);
      return sanitizeModelText(head);
    },
    flush() {
      const out = sanitizeModelText(pending);
      pending = '';
      return out;
    },
  };
}
