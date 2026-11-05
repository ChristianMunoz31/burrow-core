import { NETWORK_OPT_IN_REQUIRED } from '../utils/apiError';
import { useNetworkSettings } from './useNetworkSettings';

// Same shape the server's 403 produces, so widgets render NetworkOptInNotice without a request.
function optInError(feature) {
  return Object.assign(new Error(`${feature} is off.`), {
    status: 403,
    code: NETWORK_OPT_IN_REQUIRED,
    feature,
  });
}
const OFF_ERRORS = new Map();
function offErrorFor(feature) {
  if (!OFF_ERRORS.has(feature)) OFF_ERRORS.set(feature, optInError(feature));
  return OFF_ERRORS.get(feature);
}

/**
 * Gate for a network feature's queries. `enabled` is true only once settings loaded and the
 * feature is on; if settings failed to load it stays true so the server's 403 remains the
 * fallback. `offError` is a stable opt-in error while the feature is known to be off.
 */
export function useNetworkFeature(id) {
  const { features, isLoading } = useNetworkSettings();
  const known = !isLoading && features != null;
  const on = known ? features.find((f) => f.id === id)?.enabled === true : true;
  return {
    settingsLoading: isLoading,
    enabled: !isLoading && on,
    offError: known && !on ? offErrorFor(id) : null,
  };
}
