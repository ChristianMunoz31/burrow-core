import { CLOUD_CATEGORY_IDS, CLOUD_CATEGORY_LABELS } from '../constants/cloudAi';

/** "a", "a and b", "a, b and c". */
export function joinList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Display labels for category ids, in the fixed display order. Unknown ids are dropped, so a
 * newer server never puts raw ids on screen.
 * @param {unknown} ids
 * @returns {string[]}
 */
export function categoryLabels(ids) {
  const wanted = new Set(Array.isArray(ids) ? ids : []);
  return CLOUD_CATEGORY_IDS.filter((id) => wanted.has(id)).map((id) => CLOUD_CATEGORY_LABELS[id].label);
}
