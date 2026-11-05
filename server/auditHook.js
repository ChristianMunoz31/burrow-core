// Late-bound audit sink. server/audit.js registers the real logger at import time
// (setAuditSink); until then recordAudit is a silent no-op. recordAudit never
// throws and never rejects, so callers can always `await` it safely.
//
// AuditEvent:
//   kind: 'llm' | 'export' | 'auth'
//   feature: string (lowercase snake_case, e.g. 'javi_advice')
//   page?: string | null
//   provider?: string | null
//   model?: string | null
//   status?: 'ok' | 'error'
//   context?: unknown (redacted and size-capped by the sink; never pass keys or tokens)
//   meta?: Record<string, number | boolean | string> (small counts only)

let sink = null;

/** @param {((event: object) => unknown) | null} fn */
export function setAuditSink(fn) {
  sink = typeof fn === 'function' ? fn : null;
}

/**
 * @param {object} event
 * @returns {Promise<void>}
 */
export async function recordAudit(event) {
  if (!sink) return;
  try {
    await sink(event);
  } catch {
    // best-effort: auditing must never break the caller
  }
}
