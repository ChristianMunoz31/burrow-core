// The public list of every Burrow Pro route (docs/adr/0001-open-core-split.md 3.4). Plain data, frozen. The Pro module
// can add a handler only for an id listed here, and core mounts it with the folder
// `pre` helpers, then the module's own validators, then requireAi when `ai` is set, then the module's handlers.
// Without the module every path here answers 501 pro_not_included.

/**
 * @typedef {{ id: string, slot: 'jarvis' | 'insights' | 'folders', method: 'post', path: string, feature: string,
 *   pre: readonly ('aiLimiter' | 'requireJson')[], ai: null | Readonly<{ purpose: 'chat' | 'tools', enabledOnly?: boolean }> }} ProRoute
 */

/** @type {Readonly<Record<string, ProRoute>>} */
export const PRO_ROUTES = Object.freeze({
  'jarvis.run': Object.freeze({ id: 'jarvis.run', slot: 'jarvis', method: 'post', path: '/api/jarvis', feature: 'javi_tools', pre: Object.freeze([]), ai: Object.freeze({ purpose: 'tools' }) }),
  'jarvis.action': Object.freeze({ id: 'jarvis.action', slot: 'jarvis', method: 'post', path: '/api/jarvis/actions/:token', feature: 'javi_tools', pre: Object.freeze([]), ai: Object.freeze({ purpose: 'tools', enabledOnly: true }) }),
  'jarvis.briefingRefresh': Object.freeze({ id: 'jarvis.briefingRefresh', slot: 'jarvis', method: 'post', path: '/api/jarvis/briefing/refresh', feature: 'briefings', pre: Object.freeze([]), ai: Object.freeze({ purpose: 'chat' }) }),
  'insights.explain': Object.freeze({ id: 'insights.explain', slot: 'insights', method: 'post', path: '/api/insights/explain', feature: 'explain', pre: Object.freeze([]), ai: null }),
  'folders.report': Object.freeze({ id: 'folders.report', slot: 'folders', method: 'post', path: '/api/folders/:id/report', feature: 'folder_report', pre: Object.freeze(['aiLimiter']), ai: null }),
  'folders.ask': Object.freeze({ id: 'folders.ask', slot: 'folders', method: 'post', path: '/api/folders/:id/ask', feature: 'folder_qa', pre: Object.freeze(['aiLimiter', 'requireJson']), ai: null }),
});

/** The slots core mounts, in no particular order. */
export const PRO_SLOTS = Object.freeze(['jarvis', 'insights', 'folders']);
