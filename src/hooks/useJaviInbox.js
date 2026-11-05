import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

export const JAVI_INBOX_KEY = ['jarvis-inbox'];
const NONE = [];
// After the page's data changed, wait this long before asking the server again: its own save may still be in
// flight (a setting is saved after the screen updates), and a burst of changes becomes one request.
const DATA_REFRESH_MS = 1000;

/** `{ items, unseen }` from either inbox route. */
async function readAnswer(res) {
  if (!res.ok) throw new Error('inbox');
  return (await res.json()).data ?? {};
}

/**
 * Javi's "new for you" items (code-derived, server/javi/inbox.js). `rows` are the items listed: every unread item
 * except the current page's own. `count` is `rows.length` plus 1 when the current page has data (`pageData`, the
 * page's signal from usePageContext) and the server lists it as unseen (never opened in Javi, or changed since;
 * owner decision 2026-10-10). Every page change sends one JSON read POST `{ ids: [] }` and the answer replaces the
 * cached list, so a page change never also runs a GET; a change of the current page's data asks again (debounced)
 * while that page is seen. `markRead` drops ids that are neither listed nor an unseen page, unless
 * `{ unfiltered: true }` (a summary that landed after the last fetch; the server ignores a marker with no item).
 * @param {{ pageKey: string | null, pageData?: unknown }} opts
 */
export function useJaviInbox({ pageKey, pageData = null }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: JAVI_INBOX_KEY,
    queryFn: async () => readAnswer(await fetch('/api/jarvis/inbox')),
    staleTime: 60_000,
    retry: false,
  });
  const items = data?.items ?? NONE;
  const unseen = data?.unseen ?? NONE;
  const pageUnseen = unseen.includes(pageKey);
  const known = useRef({ items, unseen });
  useEffect(() => {
    known.current = { items, unseen };
  });

  // Answers can land out of order (two quick page changes, or a focus GET still in flight): only the newest POST may
  // write the cache, and an in-flight GET is cancelled so it cannot bring back an item that was just read.
  const seqRef = useRef(0);
  const send = useCallback(
    async (ids) => {
      const seq = ++seqRef.current;
      try {
        await qc.cancelQueries({ queryKey: JAVI_INBOX_KEY });
        const next = await readAnswer(
          await fetch('/api/jarvis/inbox/read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids }),
          }),
        );
        if (seq === seqRef.current) qc.setQueryData(JAVI_INBOX_KEY, next);
      } catch {
        // No UI for an inbox failure; the next page change or focus tries again.
      }
    },
    [qc],
  );

  useEffect(() => {
    send([]);
  }, [pageKey, send]);

  // The current page's data changed while it counts as seen: the write may have flagged it on the server. A first
  // registration (null, then the page's value one render after a lazy page mounts) is not a change.
  const lastData = useRef({ pageKey, pageData });
  useEffect(() => {
    const prev = lastData.current;
    lastData.current = { pageKey, pageData };
    if (prev.pageKey !== pageKey || prev.pageData === null || prev.pageData === pageData || !pageData || pageUnseen) {
      return undefined;
    }
    const t = setTimeout(() => send([]), DATA_REFRESH_MS);
    return () => clearTimeout(t);
  }, [pageKey, pageData, pageUnseen, send]);

  const markRead = useCallback(
    (ids, opts) => {
      const { items: listed, unseen: open } = known.current;
      const list = opts?.unfiltered
        ? ids
        : // 'briefing' and 'folders' sliced are never a page key.
          ids.filter((id) => listed.some((i) => i.id === id) || open.includes(id.slice(5)));
      if (list.length > 0) send(list);
    },
    [send],
  );

  const rows = useMemo(() => items.filter((i) => i.page !== pageKey), [items, pageKey]);
  return {
    items,
    rows,
    count: rows.length + (pageData && pageUnseen ? 1 : 0),
    markRead,
    ready: data !== undefined,
  };
}
