import { describe, expect, it } from 'vitest';
import { isFreeUi, isProNotIncluded } from '../useEntitlements';

// The core build (src/extensions/proExtensions.js, PRO_UI_INCLUDED false). The Pro-included half of the rule is
// in useEntitlements.freeUiPro.test.js.
const UNKNOWN = { known: false, pro: false };
const FREE = { known: true, pro: false, proScope: null };
const PRO = { known: true, pro: true, proScope: null };
const STORE_PARTIAL = { known: true, pro: false, proScope: 'features_until', includedFeatures: ['explain'] };

describe('isFreeUi without the Pro UI', () => {
  it('is true for every entitlement state, Pro included', () => {
    for (const e of [UNKNOWN, FREE, PRO, STORE_PARTIAL]) {
      expect(isFreeUi(e, 'explain')).toBe(true);
      expect(isFreeUi(e, 'javi_tools')).toBe(true);
    }
  });
});

describe('isProNotIncluded without the Pro UI', () => {
  it('is true for a known Pro or a Store license with included features', () => {
    expect(isProNotIncluded(PRO)).toBe(true);
    expect(isProNotIncluded(STORE_PARTIAL)).toBe(true);
  });

  it('is false while unknown and for Free', () => {
    expect(isProNotIncluded(UNKNOWN)).toBe(false);
    expect(isProNotIncluded(FREE)).toBe(false);
  });
});
