// Pure text splitting: the evenly spaced parts a long file is summarized from. The question-index chunker is part of Burrow Pro.
/**
 * Up to `maxParts` windows of `partChars` characters spaced evenly over the text, first and last included. A text
 * that fits in one window is returned whole.
 * @param {string} text
 * @param {{ partChars?: number, maxParts?: number }} [opts]
 * @returns {string[]}
 */
export function pickSummaryParts(text, { partChars = 3000, maxParts = 4 } = {}) {
  const src = String(text ?? '');
  if (src.length <= partChars) return [src];
  const n = Math.max(1, Math.min(maxParts, Math.ceil(src.length / partChars)));
  if (n === 1) return [src.slice(0, partChars)];
  const parts = [];
  for (let i = 0; i < n; i += 1) {
    const start = Math.round((i * (src.length - partChars)) / (n - 1));
    parts.push(src.slice(start, start + partChars));
  }
  return parts;
}
