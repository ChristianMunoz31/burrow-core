// Keep prompts inside the model's context window. Token counts are estimated
// (about 3 characters per token, deliberately pessimistic for small local models).

export const CHARS_PER_TOKEN = 3;
export const SAFETY_TOKENS = 256;
const PER_MESSAGE_TOKENS = 4;

const contentChars = (m) => {
  let n = typeof m?.content === 'string' ? m.content.length : 0;
  if (Array.isArray(m?.tool_calls) && m.tool_calls.length) {
    try {
      n += JSON.stringify(m.tool_calls).length;
    } catch {
      /* ignore */
    }
  }
  return n;
};

/**
 * Estimated token count of a string or a message list.
 * @param {string | Array<{ content?: string, tool_calls?: unknown[] }>} input
 * @returns {number}
 */
export function estimateTokens(input) {
  if (typeof input === 'string') return Math.ceil(input.length / CHARS_PER_TOKEN);
  if (!Array.isArray(input)) return 0;
  return input.reduce((sum, m) => sum + Math.ceil(contentChars(m) / CHARS_PER_TOKEN) + PER_MESSAGE_TOKENS, 0);
}

/**
 * Token budget for the prompt: numCtx minus the reply and a safety margin.
 * @param {number} numCtx
 * @param {number} maxTokens
 * @returns {number}
 */
export const promptBudgetTokens = (numCtx, maxTokens) =>
  Math.max(0, Math.floor(numCtx) - Math.floor(maxTokens || 0) - SAFETY_TOKENS);

/**
 * Characters available for a block of untrusted context (page snapshot, briefing JSON)
 * after the reply, the margin and `reserveChars` (system prompt, history) are set aside.
 * @param {{ numCtx?: number } | null | undefined} client
 * @param {{ maxTokens?: number, reserveChars?: number, minChars?: number }} [opts]
 * @returns {number}
 */
export function contextBudgetChars(client, { maxTokens = 1024, reserveChars = 0, minChars = 1000 } = {}) {
  const numCtx = Number(client?.numCtx) > 0 ? Number(client.numCtx) : 8192;
  const chars = promptBudgetTokens(numCtx, Math.min(maxTokens, Math.floor(numCtx / 2))) * CHARS_PER_TOKEN - reserveChars;
  return Math.max(minChars, chars);
}

/**
 * Drop the oldest history until the estimate fits `numCtx - maxTokens - 256`.
 * Never drops system messages or the last user message (and everything after it, i.e.
 * the current turn's tool rounds). An assistant tool_calls message and its tool results
 * are dropped together, and no orphan tool message is left at the front.
 * @template {{ role: string, content?: string, tool_calls?: unknown[] }} M
 * @param {M[]} messages
 * @param {{ numCtx: number, maxTokens: number }} opts
 * @returns {M[]}
 */
export function fitMessages(messages, { numCtx, maxTokens }) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const budget = promptBudgetTokens(numCtx, maxTokens);
  if (estimateTokens(messages) <= budget) return messages.slice();

  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      lastUser = i;
      break;
    }
  }
  const protectedFrom = lastUser === -1 ? messages.length : lastUser;

  // Group droppable history (before the last user turn) into units.
  const groups = [];
  for (let i = 0; i < protectedFrom; i += 1) {
    const m = messages[i];
    if (m?.role === 'system') continue;
    if (m?.role === 'tool' && groups.length && groups[groups.length - 1].toolGroup) {
      groups[groups.length - 1].idx.push(i);
      continue;
    }
    groups.push({ idx: [i], toolGroup: m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0 });
  }

  const dropped = new Set();
  let total = estimateTokens(messages);
  for (const g of groups) {
    if (total <= budget) break;
    for (const i of g.idx) {
      dropped.add(i);
      total -= Math.ceil(contentChars(messages[i]) / CHARS_PER_TOKEN) + PER_MESSAGE_TOKENS;
    }
  }
  const kept = messages.filter((_m, i) => !dropped.has(i));
  // A history that now starts with tool results (their call was dropped) is invalid.
  const out = [];
  let seenNonSystem = false;
  for (const m of kept) {
    if (!seenNonSystem && m.role === 'tool') continue;
    if (m.role !== 'system') seenNonSystem = true;
    out.push(m);
  }
  return out;
}
