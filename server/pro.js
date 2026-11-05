// The registry of capabilities that the private module provides, and the fixed answer for a build
// that lacks it (ADR 0002). There are no tiers: with the module compiled in, every capability is on.
// Without it, the Pro route paths answer 501 pro_not_included (server/proExtensions.js).

/** Capabilities that the private module provides. Mirrored by SHIPPED_PRO_FEATURES in src/constants/proFeatures.js. */
export const PRO_FEATURES = Object.freeze({
  javi_tools: Object.freeze({ label: 'Javi tools and actions' }),
  javi_conversation: Object.freeze({ label: 'Javi follow-ups and conversations' }),
  javi_characters: Object.freeze({ label: 'Javi characters' }),
  briefings: Object.freeze({ label: 'Daily briefings' }),
  explain: Object.freeze({ label: 'Explain patterns' }),
  folder_qa: Object.freeze({ label: 'Ask your folders' }),
  folder_report: Object.freeze({ label: 'Folder cross-file reports' }),
  folder_auto_rescan: Object.freeze({ label: 'Scheduled folder re-scan' }),
});

/** The build has no private module. Fixed copy, mirrored by PRO_NOT_INCLUDED_COPY in src/constants/proFeatures.js. */
export const MSG_PRO_NOT_INCLUDED =
  'This build of Burrow does not include this feature. The official Burrow app includes it at no cost.';

/**
 * Express middleware for a module route whose handler is not in this build: 501
 * { error: 'pro_not_included', code: 'pro_not_included', feature, message } (no-store).
 * @param {string} feature A PRO_FEATURES id.
 * @returns {import('express').RequestHandler}
 */
export function sendProNotIncluded(feature) {
  if (!Object.hasOwn(PRO_FEATURES, feature)) throw new Error(`Unknown Pro feature: ${String(feature)}`);
  return (_req, res) => {
    res.set('Cache-Control', 'no-store');
    return res.status(501).json({ error: 'pro_not_included', code: 'pro_not_included', feature, message: MSG_PRO_NOT_INCLUDED });
  };
}
