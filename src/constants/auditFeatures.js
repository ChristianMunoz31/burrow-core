// Features that were removed (`insights`, `agents`, `assistant`, `ui_builder`) still have rows in the
// activity log until they age out (90 days); they all render as "Removed feature".
const REMOVED_LABEL = 'Removed feature';

const FEATURE_LABELS = {
  insights: REMOVED_LABEL,
  agents: REMOVED_LABEL,
  assistant: REMOVED_LABEL,
  ui_builder: REMOVED_LABEL,
  jarvis: 'Javi',
  briefing: 'Daily briefing',
  javi_advice: 'Javi advice',
  cross_insights_explain: 'Insight explanations',
  data_export: 'Data export',
  data_import: 'Data import',
  backup_create: 'Backup',
  backup_restore: 'Restore from backup',
  transactions_import: 'Transaction import',
  sign_in: 'Sign-in',
  cloud_ai_consent: 'Cloud AI settings',
  network_call: 'Internet connection',
  folder_summary: 'Folder summaries',
  folder_index: 'Folder question index',
  folder_report: 'Folder reports',
  folder_ask: 'Folder questions',
  folder_export: 'Folder export',
};

/** Human label for a feature id; unknown ids fall back to the raw id. */
export const featureLabel = (feature) =>
  Object.hasOwn(FEATURE_LABELS, feature) ? FEATURE_LABELS[feature] : feature;
