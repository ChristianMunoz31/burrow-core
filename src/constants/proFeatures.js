// Client mirror of the Pro features that have shipped (server/pro.js PRO_FEATURES with used: true), with the
// labels shown when a Store license past its update window keeps only some of them (docs/LICENSING.md 6.1).
// A test locks the ids and labels to the server registry. Reserved ids are not listed: the UI never offers them.
export const SHIPPED_PRO_FEATURES = Object.freeze({
  javi_tools: 'Javi tools and actions',
  javi_conversation: 'Javi follow-ups and conversations',
  javi_characters: 'Javi characters',
  briefings: 'Daily briefings',
  explain: 'Explain patterns',
  folder_qa: 'Ask your folders',
  folder_report: 'Folder cross-file reports',
  folder_auto_rescan: 'Scheduled folder re-scan',
});

/** Fixed copy for a feature the license's updates did not cover (same text as the server's 403). */
export const NEWER_LICENSE_COPY =
  "This feature came out after your license's updates ended. It is included in a newer Burrow Pro license.";

/**
 * Fixed copy for a Pro entitlement in a build without the Pro module. Same text as the server's
 * MSG_PRO_NOT_INCLUDED (server/pro.js, 501 pro_not_included).
 */
export const PRO_NOT_INCLUDED_COPY =
  'This build of Burrow does not include Burrow Pro features. Your data and everything in Burrow Free keep working.';

/** Labels of the shipped features in `ids`, in registry order. */
export const labelsOf = (ids) =>
  Object.entries(SHIPPED_PRO_FEATURES)
    .filter(([id]) => Array.isArray(ids) && ids.includes(id))
    .map(([, label]) => label);
