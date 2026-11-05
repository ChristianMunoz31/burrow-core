// Test helper for code that mounts JaviAdvisor: a fake Javi inbox and briefing behind fetch.
// Use `answerInbox(url, init)` at the top of a routed fetch: it returns a response for the inbox and briefing paths
// (so tests that count other calls are not affected) and null for anything else.
import { jsonResponse } from './sseResponse';

export const inboxState = { items: [], unseen: [], posts: [], gets: 0, briefing: null };

export function resetInbox() {
  inboxState.items = [];
  inboxState.unseen = [];
  inboxState.posts = [];
  inboxState.gets = 0;
  inboxState.briefing = null;
}

/** @returns {Promise<object> | null} */
export function answerInbox(url, init) {
  const path = String(url);
  if (path === '/api/jarvis/inbox') {
    inboxState.gets += 1;
    return Promise.resolve(jsonResponse({ data: { items: inboxState.items, unseen: inboxState.unseen } }));
  }
  if (path === '/api/jarvis/inbox/read') {
    const body = JSON.parse(init?.body ?? '{}');
    inboxState.posts.push(body);
    const ids = body.ids ?? [];
    inboxState.items = inboxState.items.filter((i) => !ids.includes(i.id));
    inboxState.unseen = inboxState.unseen.filter((k) => !ids.includes(`page:${k}`));
    return Promise.resolve(jsonResponse({ data: { items: inboxState.items, unseen: inboxState.unseen } }));
  }
  if (path === '/api/jarvis/briefing') return Promise.resolve(jsonResponse(inboxState.briefing ?? { empty: true }));
  return null;
}

