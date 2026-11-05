/**
 * Generic only. Never API-key status, last4 or app_state rows.
 * @param {{ mode?: string, themePreference?: string,
 *   advisorButton?: boolean, autoAdvise?: boolean }} input
 */
export function buildSettingsContext({
  mode,
  themePreference,
  advisorButton,
  autoAdvise,
} = {}) {
  return {
    mode: mode ?? null,
    themePreference: themePreference ?? null,
    advisorButton: !!advisorButton,
    autoAdvise: !!autoAdvise,
  };
}
