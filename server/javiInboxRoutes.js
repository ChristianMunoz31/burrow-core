// Javi inbox routes: the launcher count and the "New for you" list. Code only, no model, no Pro gate (the
// item list is filtered by tier), no audit row. Own limiter and no-store in server.js. Both answers are
// `{ items, unseen }` (unseen: page keys for the current-page notice). The read POST still accepts the old
// `active` key (validated, then ignored) so an open tab from before the update keeps working; neither the
// ids nor a page key are ever logged. Every error message is fixed copy and never shown in the UI.
import { isJaviPage } from './javi/pages.js';
import { INBOX_PAGE_SET, markRead, readInboxView } from './javi/inbox.js';

const MESSAGE = 'Something went wrong. Try again.';
const MAX_IDS = 20;
const BODY_KEYS = new Set(['ids', 'active']);

const fail = (res, status, code) => res.status(status).json({ error: code, code, message: MESSAGE });

const isInboxId = (id) =>
  id === 'briefing' || id === 'folders' || (id.startsWith('page:') && INBOX_PAGE_SET.has(id.slice(5)));

/**
 * @param {unknown} body
 * @returns {{ ok: true, ids: string[], hasActive: boolean, active: string | null } | { ok: false }}
 */
export function validateInboxRead(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false };
  for (const k of Object.keys(body)) if (!BODY_KEYS.has(k)) return { ok: false };
  let ids = [];
  if (Object.hasOwn(body, 'ids')) {
    if (!Array.isArray(body.ids) || body.ids.length > MAX_IDS) return { ok: false };
    for (const id of body.ids) if (typeof id !== 'string' || !isInboxId(id)) return { ok: false };
    ids = [...new Set(body.ids)];
  }
  const hasActive = Object.hasOwn(body, 'active');
  let active = null;
  if (hasActive && body.active !== null && body.active !== '') {
    if (!isJaviPage(body.active)) return { ok: false };
    active = body.active;
  }
  return { ok: true, ids, hasActive, active };
}

function serverError(res, err) {
  // Error code only: never the body, the ids or the page on screen.
  console.error('Javi inbox failed:', err?.code ?? err?.name ?? 'unknown');
  return fail(res, 500, 'inbox_failed');
}

/** @param {import('express').Express} app */
export function registerJaviInboxRoutes(app) {
  // No parameters and no side effect: never writes.
  app.get('/api/jarvis/inbox', (req, res) => {
    try {
      res.json({ data: readInboxView() });
    } catch (err) {
      serverError(res, err);
    }
  });

  app.post('/api/jarvis/inbox/read', (req, res) => {
    if (!req.is('application/json')) return fail(res, 415, 'unsupported_media_type');
    const v = validateInboxRead(req.body);
    if (!v.ok) return fail(res, 400, 'invalid_request');
    try {
      markRead(v.ids);
      return res.json({ data: readInboxView() });
    } catch (err) {
      return serverError(res, err);
    }
  });
}
