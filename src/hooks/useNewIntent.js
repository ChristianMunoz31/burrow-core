import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

// "Start a new item" intent for module pages, used by the command palette quick actions.
// Navigate to newItemPath('/countdowns'): the page calls its openAdd once when `new=1` is
// present, then the param is removed (history replaced) so reload or Back does not reopen it.
// Mirrors the Budget page's `import=1` entry (budget/openTransactionImport.js).
export const NEW_QUERY_PARAM = 'new';

export const newItemPath = (path) => `${path}?${NEW_QUERY_PARAM}=1`;

export function useNewIntent(openAdd) {
  const [searchParams, setSearchParams] = useSearchParams();
  const openRef = useRef(openAdd);
  useEffect(() => {
    openRef.current = openAdd;
  }, [openAdd]);
  const wantsNew = searchParams.get(NEW_QUERY_PARAM) === '1';

  useEffect(() => {
    if (!wantsNew) return;
    openRef.current();
    const next = new URLSearchParams(searchParams);
    next.delete(NEW_QUERY_PARAM);
    setSearchParams(next, { replace: true });
  }, [wantsNew, searchParams, setSearchParams]);
}
