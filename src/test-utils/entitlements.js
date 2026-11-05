import { vi } from 'vitest';
import { PRO_UI_INCLUDED } from '../extensions/proExtensions.js';

// Shared Pro switch for component tests that render a Pro entry point without a QueryClient.
// A test file adds, at the top level (the path is relative to the test file):
//
//   vi.mock('../../../hooks/useEntitlements', async () => (await import('../../../test-utils/entitlements.js')).entitlementsModule());
//
// useEntitlements() then returns the state below (a known Pro user by default). Call
// setEntitlementsState(...) in a test to prove the free and loading cases, resetEntitlementsState() after.
export const PRO_STATE = Object.freeze({ known: true, pro: true, edition: 'standard', proSource: 'license', trial: null });
export const FREE_STATE = Object.freeze({
  known: true,
  pro: false,
  edition: null,
  proSource: null,
  trial: Object.freeze({ state: 'ended', startedAt: null, endsAt: null, daysLeft: 0, remindToday: false, notice: null }),
});
export const UNKNOWN_STATE = Object.freeze({ known: false, pro: false, edition: null, proSource: null, trial: null });

// Called by components that re-read the license after a pro_required; tests assert on it.
export const refreshEntitlementsMock = vi.fn();

let current = PRO_STATE;

export const setEntitlementsState = (next) => {
  current = next;
};
export const resetEntitlementsState = () => {
  current = PRO_STATE;
};

// Same rules as src/hooks/useEntitlements.js. PRO_UI_INCLUDED is the core module's false, or true in a Pro UI test
// that vi.mocks src/extensions/proExtensions.js with the Pro UI entry module (the mock applies to this import too).
const isKnownFree = (e, feature) => {
  if (!e.known || e.pro) return false;
  if (e.proScope !== 'features_until') return true;
  return feature === undefined ? false : !e.includedFeatures?.includes(feature);
};

export function entitlementsModule() {
  return {
    useEntitlements: () => current,
    useRefreshEntitlements: () => refreshEntitlementsMock,
    isKnownFree,
    isFreeUi: (e, feature) => !PRO_UI_INCLUDED || isKnownFree(e, feature),
    isProNotIncluded: (e) => !PRO_UI_INCLUDED && Boolean(e?.known) && (Boolean(e.pro) || e.proScope === 'features_until'),
  };
}
