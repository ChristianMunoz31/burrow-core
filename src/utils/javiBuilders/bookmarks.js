import { clip } from '../javiContext';
import { statusContext } from './_status';

const domainOf = (url) => {
  try {
    const u = String(url ?? '');
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : `https://${u}`).hostname;
  } catch {
    return '';
  }
};

/**
 * @param {{ bookmarks?: Array<{title?:string,url?:string,category?:string}>,
 *   loading?: boolean, error?: unknown }} input
 */
export function buildBookmarksContext({ bookmarks, loading, error } = {}) {
  const early = statusContext({ loading, error });
  if (early) return early;
  const list = Array.isArray(bookmarks) ? bookmarks : [];
  const byCategory = {};
  for (const b of list) {
    const k = clip(b?.category || 'Ungrouped', 40);
    byCategory[k] = (byCategory[k] ?? 0) + 1;
  }
  return {
    total: list.length,
    byCategory,
    recent: list.slice(0, 10).map((b) => ({ title: clip(b?.title, 80), domain: domainOf(b?.url) })),
  };
}
