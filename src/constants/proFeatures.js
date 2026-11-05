// Client mirror of the features the private module provides (server/pro.js PRO_FEATURES). A test locks the
// ids and labels to the server registry. Reserved ids are not listed: the UI never offers them.
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

/**
 * Fixed copy for a feature this build lacks (the private module is not compiled in). Same text as the
 * server's MSG_PRO_NOT_INCLUDED (server/pro.js, 501 pro_not_included).
 */
export const PRO_NOT_INCLUDED_COPY =
  'This build of Burrow does not include this feature. The official Burrow app includes it at no cost.';
