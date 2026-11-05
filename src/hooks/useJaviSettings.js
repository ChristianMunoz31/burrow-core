import { useSyncedSetting } from './useSyncedSetting';
import {
  SETTINGS_DEFAULTS,
  SETTINGS_KEYS,
  normalizeJaviAdvisorButton,
  normalizeJaviAutoAdvise,
} from '../constants/settingsDefaults';

/** @returns {{ showButton: boolean, autoAdvise: boolean }} */
export function useJaviSettings() {
  const [button] = useSyncedSetting(SETTINGS_KEYS.javiAdvisorButton, SETTINGS_DEFAULTS.javiAdvisorButton);
  const [auto] = useSyncedSetting(SETTINGS_KEYS.javiAutoAdvise, SETTINGS_DEFAULTS.javiAutoAdvise);
  return {
    showButton: normalizeJaviAdvisorButton(button),
    autoAdvise: normalizeJaviAutoAdvise(auto),
  };
}
