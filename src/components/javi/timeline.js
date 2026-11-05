// Merges the two things the Javi panel shows in one scroll: page-advice messages (per page,
// from useJaviSession) and free-form agent turns plus their change requests (useJarvis).
// Pure so it can be tested without rendering.

/** Idle agent state, so the panel renders without the free-form chat wired up. */
export const EMPTY_AGENT = Object.freeze({
  messages: Object.freeze([]),
  tools: Object.freeze([]),
  actions: Object.freeze([]),
  running: false,
  error: null,
  errorCode: null,
  errorReason: null,
});

/**
 * @param {{ messages?: ReadonlyArray<object> } | null | undefined} thread advice thread for the current page
 * @param {{ messages?: ReadonlyArray<object>, actions?: ReadonlyArray<object> } | null | undefined} agent
 * @returns {Array<{ key: string, at: number, kind: 'message', message: object } | { key: string, at: number, kind: 'action', action: object }>}
 *   Ordered by `at` (missing counts as 0); ties keep advice, then agent messages, then actions.
 */
export function buildTimeline(thread, agent) {
  const items = [];
  for (const message of thread?.messages ?? []) {
    items.push({ key: `advice:${message.id}`, kind: 'message', message, at: message.at ?? 0 });
  }
  for (const message of agent?.messages ?? []) {
    // An assistant bubble with no text yet is a placeholder for the in-flight turn.
    if (message.role === 'assistant' && !message.content) continue;
    items.push({ key: `agent:${message.id}`, kind: 'message', message, at: message.at ?? 0 });
  }
  for (const action of agent?.actions ?? []) {
    items.push({ key: `a:${action.token}`, kind: 'action', action, at: action.at ?? 0 });
  }
  // Array.prototype.sort is stable, so equal timestamps keep the push order above.
  return items.sort((a, b) => a.at - b.at);
}
