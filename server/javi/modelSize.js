// Model-size heuristic for the Javi advisor and Insights explain. The AI client does not carry the
// Ollama parameter size, so the size is read from the model tag (`llama3.2:1b`, `qwen2.5:0.5b`,
// `gemma2:2b-instruct-q4_K_M`). Pure: no I/O, no AI imports.

/** Largest parameter count, in billions, that still gets the small-model prompt variant. */
export const SMALL_MODEL_MAX_B = 2;

// A size token: digits (optionally with a fraction) then `b` or `m`, bounded by the start, `:`, `-`, `_` or `.` on
// the left and the end or one of `-`, `_`, `:`, `.` on the right. `llama3.2` has no `b` suffix, so it is not a size.
const SIZE_TOKEN_RE = /(?:^|[:_\-/])(\d+(?:\.\d+)?)([bm])(?=$|[-_:.])/gi;

/**
 * Parameter count in billions read from a model name, or null when the name carries no size.
 *
 * @param {unknown} name Model name, e.g. `llama3.2:1b`.
 * @returns {number | null} e.g. 1 for `llama3.2:1b`, 0.36 for `smollm2:360m`.
 */
export function modelSizeFromName(name) {
  const s = String(name ?? '').trim();
  let found = null;
  for (const m of s.matchAll(SIZE_TOKEN_RE)) {
    const v = Number(m[1]) / (m[2].toLowerCase() === 'm' ? 1000 : 1);
    if (Number.isFinite(v) && v > 0) found = v;
  }
  return found;
}

/**
 * True when a model name says it has at most {@link SMALL_MODEL_MAX_B} billion parameters.
 * Unknown sizes are not small (they keep the standard prompt).
 *
 * @param {unknown} name Model name.
 * @returns {boolean}
 */
export function isSmallModelName(name) {
  const b = modelSizeFromName(name);
  return b !== null && b <= SMALL_MODEL_MAX_B;
}
