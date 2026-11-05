import { describe, expect, it } from 'vitest';
import * as defaults from '../settingsDefaults';
import { BACKGROUND_PRESET_IDS, BACKGROUND_PRESETS, normalizeBackground } from '../settingsDefaults';

describe('purple and gold background (id founder)', () => {
  it('is a regular preset for everyone, with no founding wording', () => {
    expect(BACKGROUND_PRESET_IDS).toContain('founder');
    const preset = BACKGROUND_PRESETS.find((p) => p.id === 'founder');
    expect(preset.label).toBe('Purple and gold');
    expect(`${preset.label} ${preset.description}`).not.toMatch(/founding|member|licen[sc]e|pro\b/i);
  });

  it('keeps a saved founder value valid and normalizes the rest as before', () => {
    expect(normalizeBackground('founder')).toBe('founder');
    expect(normalizeBackground('ocean')).toBe('ocean');
    expect(normalizeBackground('nope')).toBe('aurora');
  });

  it('has no perk gate left', () => {
    expect(defaults.resolveBackground).toBeUndefined();
    expect(defaults.FOUNDER_BACKGROUND).toBeUndefined();
  });
});
