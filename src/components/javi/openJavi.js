// Fire from anywhere (command palette) to open the Javi panel, optionally with a question
// that is sent straight away. JaviAdvisor listens for it. Mirrors openCommandPalette().
export const JAVI_OPEN_EVENT = 'javi:open';

/**
 * @param {{ prompt?: string }} [options]
 */
export function openJavi({ prompt } = {}) {
  window.dispatchEvent(new CustomEvent(JAVI_OPEN_EVENT, { detail: { prompt } }));
}
