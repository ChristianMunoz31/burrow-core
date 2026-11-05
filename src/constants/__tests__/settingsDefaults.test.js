import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_PRESET_IDS,
  FOUNDER_BACKGROUND,
  normalizeBackground,
  resolveBackground,
} from '../settingsDefaults';

describe('founder background', () => {
  it('is not a regular preset but is a valid stored value', () => {
    expect(BACKGROUND_PRESET_IDS).not.toContain('founder');
    expect(FOUNDER_BACKGROUND.id).toBe('founder');
    expect(normalizeBackground('founder')).toBe('founder');
    expect(normalizeBackground('ocean')).toBe('ocean');
    expect(normalizeBackground('nope')).toBe('aurora');
  });

  it.each([
    ['founder', { known: true, founderBackground: true }, false, 'founder'],
    ['founder', { known: true, founderBackground: false }, false, 'aurora'],
    // The real flag wins over the cache once known.
    ['founder', { known: true, founderBackground: false }, true, 'aurora'],
    ['founder', { known: true, founderBackground: true }, false, 'founder'],
    // Unknown status: the cached last-known flag decides, no cache means the default.
    ['founder', { known: false, founderBackground: false }, false, 'aurora'],
    ['founder', { known: false, founderBackground: false }, true, 'founder'],
    ['ocean', { known: true, founderBackground: false }, false, 'ocean'],
    ['ocean', { known: false, founderBackground: false }, false, 'ocean'],
  ])('resolveBackground(%s, %o, cached=%s) = %s', (pref, flags, cached, expected) => {
    expect(resolveBackground(pref, flags, 'aurora', cached)).toBe(expected);
  });

  it('treats a missing cache argument as not cached', () => {
    expect(resolveBackground('founder', { known: false, founderBackground: false }, 'aurora')).toBe(
      'aurora',
    );
  });
});
