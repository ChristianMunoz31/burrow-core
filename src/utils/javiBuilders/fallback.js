import { clip } from '../javiContext';

/**
 * Generic context for a page without a dedicated builder: route name + page title.
 * @param {{ routeName?: string, title?: string }} input
 */
export function buildFallbackContext({ routeName, title } = {}) {
  return { route: clip(routeName, 60), title: clip(title, 80) };
}
