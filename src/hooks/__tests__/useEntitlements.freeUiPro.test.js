import { describe, expect, it, vi } from 'vitest';

// A build with the Pro UI: only PRO_UI_INCLUDED differs from the core module, which is all these helpers read.
vi.mock('../../extensions/proExtensions', async (importOriginal) => ({
  ...(await importOriginal()),
  PRO_UI_INCLUDED: true,
}));

const { isFreeUi, isKnownFree, isProNotIncluded } = await import('../useEntitlements');

const STATES = [
  { known: false, pro: false },
  { known: true, pro: false, proScope: null },
  { known: true, pro: true, proScope: null },
  { known: true, pro: false, proScope: 'features_until', includedFeatures: ['explain'] },
];

describe('with the Pro UI included', () => {
  it('isFreeUi is exactly isKnownFree', () => {
    for (const e of STATES) {
      for (const feature of ['explain', 'javi_tools', undefined]) {
        expect(isFreeUi(e, feature)).toBe(isKnownFree(e, feature));
      }
    }
  });

  it('isProNotIncluded is always false', () => {
    for (const e of STATES) expect(isProNotIncluded(e)).toBe(false);
  });
});
