import { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { JAVI_PAGES } from '../constants/javiPages';
import { serializeJaviContext } from '../utils/javiContext';
import { buildFallbackContext } from '../utils/javiBuilders/fallback';

// Registry of lazy page-context builders for the Javi advisor. Pages register a
// builder closure; nothing is called until the advisor reads it (panel open / send).
// Registration never causes a re-render: the registry is a ref and the context value
// is a stable object. The one exception is each page's data signal (see usePageContext): it lives in a
// second context that only the Javi host reads, so a change re-renders the host and never the page tree.

const PageContext = createContext(null);
const PageDataContext = createContext(null);

export function PageContextProvider({ children }) {
  const registry = useRef(new Map());
  const [pageData, setPageData] = useState({});

  const api = useMemo(
    () => ({
      register(key, id, builderRef) {
        registry.current.set(key, { id, builderRef });
      },
      unregister(key, id) {
        const entry = registry.current.get(key);
        if (entry && entry.id === id) registry.current.delete(key);
      },
      setData(key, value) {
        setPageData((d) => ({ ...d, [key]: value }));
      },
      readPageContext(key) {
        const entry = registry.current.get(key);
        const now = new Date();
        let data;
        if (!entry) {
          data = buildFallbackContext({ routeName: key, title: JAVI_PAGES[key]?.label });
        } else {
          try {
            data = entry.builderRef.current?.() ?? null;
          } catch {
            data = { error: 'context unavailable' };
          }
        }
        const { context, truncated } = serializeJaviContext({ pageKey: key, data, now });
        const loading = data?.status === 'loading';
        return { context, truncated, registered: !!entry, loading };
      },
    }),
    [],
  );

  return (
    <PageContext.Provider value={api}>
      <PageDataContext.Provider value={pageData}>{children}</PageDataContext.Provider>
    </PageContext.Provider>
  );
}

/**
 * Registers `builder` as the context source for page `key`. A silent no-op without a
 * provider. Call it unconditionally at the top of the component (before early returns).
 * `data` (optional) is the page's data signal for Javi's current-page notice: falsy while the page
 * has no user records (or is loading), else a value whose identity changes when that data changes
 * (pass a react-query array or a memoized value, never a fresh literal), e.g. `todos.length > 0 && todos`;
 * the budget pages use `hasBudget` (javiBuilders/budget.js).
 * @param {string} key
 * @param {() => object | null} builder
 * @param {unknown} [data]
 */
// eslint-disable-next-line react-refresh/only-export-components
export function usePageContext(key, builder, data) {
  const api = useContext(PageContext);
  const ref = useRef(builder);
  const id = useId();

  // Always point at the latest closure; ref writes are not allowed during render.
  useEffect(() => {
    ref.current = builder;
  });

  useEffect(() => {
    if (!api) return undefined;
    api.register(key, id, ref);
    return () => api.unregister(key, id);
  }, [api, key, id]);

  // `false` = registered with no records (or still loading), `null` = no page registered (only in cleanup). The
  // inbox hook tells them apart: a lazy page registers one render after the route changes (null, then its value),
  // which is not a data change, while empty -> first record is.
  const signal = data || false;
  useEffect(() => {
    if (!api) return undefined;
    api.setData(key, signal);
    return () => api.setData(key, null);
  }, [api, key, signal]);
}

/**
 * The data signal page `key` registered: `false` while the registered page has no records, null when no page
 * registered it (or without a provider).
 * @param {string | null} key
 */
// eslint-disable-next-line react-refresh/only-export-components
export const usePageData = (key) => useContext(PageDataContext)?.[key] ?? null;

/**
 * @returns {{ readPageContext: (key: string) => { context: string, truncated: boolean, registered: boolean, loading: boolean } }}
 */
// eslint-disable-next-line react-refresh/only-export-components
export function usePageContextReader() {
  const api = useContext(PageContext);
  return useMemo(
    () => ({
      readPageContext: (key) =>
        api
          ? api.readPageContext(key)
          : {
              ...serializeJaviContext({
                pageKey: key,
                data: buildFallbackContext({ routeName: key, title: JAVI_PAGES[key]?.label }),
              }),
              registered: false,
              loading: false,
            },
    }),
    [api],
  );
}
