import { useLicenseFlags, useRefreshEntitlements } from './useLicense';
import { PRO_UI_INCLUDED } from '../extensions/proExtensions';

/**
 * What the user may use, from the shared license query. `known` is false while the status is
 * loading or failed to load: callers must not show a Pro prompt then (the server still enforces
 * Pro, and a 403 pro_required is handled where the call is made).
 */
export const useEntitlements = useLicenseFlags;

/** Re-read the license status after a 403 pro_required, so a stale Pro cache cannot keep the gate hidden. */
export { useRefreshEntitlements };

/**
 * True when the user is known not to have Pro (never while the status is unknown). With a `feature` id it is
 * per feature: a Store license past its update window (`proScope` 'features_until') still has the features it
 * includes. Without one, such a license is not counted as free, because it has some Pro; the server answers
 * `403 pro_required` with reason `newer_license_required` for a locked feature.
 */
export const isKnownFree = (e, feature) => {
  if (!e.known || e.pro) return false;
  if (e.proScope !== 'features_until') return true;
  return feature === undefined ? false : !e.includedFeatures?.includes(feature);
};

/**
 * True when a host must show its Free UI for `feature`: always in a build without the Pro UI (`PRO_UI_INCLUDED`
 * false, even with a trial or license, since the Pro controls are not compiled in), else when the user is known
 * not to have the feature (isKnownFree). The upsell parts (ProPill, BuyProLink, disabled controls) stay core.
 */
export const isFreeUi = (e, feature) => !PRO_UI_INCLUDED || isKnownFree(e, feature);

/**
 * True when the user has Pro (a trial, a license, or a Store license's included features) but this build does not
 * include the Pro module, so ProGateNotice says "not included in this build" instead of offering to buy Pro.
 */
export const isProNotIncluded = (e) =>
  !PRO_UI_INCLUDED && Boolean(e?.known) && (Boolean(e.pro) || e.proScope === 'features_until');
