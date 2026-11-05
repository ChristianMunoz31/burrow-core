import { describe, expect, it } from 'vitest';
import { formatBuildIdentity } from '../buildIdentity';

const FULL = { version: '0.1.0', channel: 'stable', commit: 'abc1234', buildDate: '2026-10-05T12:00:00Z' };
const SEP = ' · ';

describe('formatBuildIdentity', () => {
  it('formats every part', () => {
    expect(formatBuildIdentity(FULL)).toBe(['Version 0.1.0', 'stable', 'abc1234', 'built 2026-10-05'].join(SEP));
  });

  it('names the Microsoft Store build after the channel and adds nothing for a direct build', () => {
    expect(formatBuildIdentity({ ...FULL, distribution: 'store' })).toBe(
      ['Version 0.1.0', 'stable', 'Microsoft Store', 'abc1234', 'built 2026-10-05'].join(SEP),
    );
    expect(formatBuildIdentity({ ...FULL, distribution: 'direct' })).toBe(formatBuildIdentity(FULL));
    expect(formatBuildIdentity({ ...FULL, distribution: 'other' })).toBe(formatBuildIdentity(FULL));
  });

  it('uses the UTC calendar day of the build date', () => {
    expect(formatBuildIdentity({ buildDate: '2026-10-05T23:59:59Z' })).toBe('built 2026-10-05');
  });

  it.each([
    ['version', ['stable', 'abc1234', 'built 2026-10-05']],
    ['channel', ['Version 0.1.0', 'abc1234', 'built 2026-10-05']],
    ['commit', ['Version 0.1.0', 'stable', 'built 2026-10-05']],
    ['buildDate', ['Version 0.1.0', 'stable', 'abc1234']],
  ])('omits a missing %s', (key, expected) => {
    expect(formatBuildIdentity({ ...FULL, [key]: undefined })).toBe(expected.join(SEP));
    expect(formatBuildIdentity({ ...FULL, [key]: null })).toBe(expected.join(SEP));
    expect(formatBuildIdentity({ ...FULL, [key]: '   ' })).toBe(expected.join(SEP));
  });

  it('treats a version of "unknown" (any case, trimmed) as missing', () => {
    const rest = ['stable', 'abc1234', 'built 2026-10-05'].join(SEP);
    for (const version of ['unknown', 'Unknown', ' UNKNOWN ']) {
      expect(formatBuildIdentity({ ...FULL, version })).toBe(rest);
    }
    expect(formatBuildIdentity({ version: 'unknown' })).toBeNull();
  });

  it('omits an invalid build date', () => {
    expect(formatBuildIdentity({ ...FULL, buildDate: 'not-a-date' })).toBe(['Version 0.1.0', 'stable', 'abc1234'].join(SEP));
    expect(formatBuildIdentity({ ...FULL, buildDate: 12345 })).not.toContain('built');
  });

  it('trims whitespace around parts', () => {
    expect(formatBuildIdentity({ version: ' 1.2.3 ', channel: ' dev ' })).toBe(`Version 1.2.3${SEP}dev`);
  });

  it('returns null when nothing is usable', () => {
    expect(formatBuildIdentity({})).toBeNull();
    expect(formatBuildIdentity({ version: null, channel: '', commit: ' ', buildDate: 'garbage' })).toBeNull();
    expect(formatBuildIdentity(null)).toBeNull();
    expect(formatBuildIdentity(undefined)).toBeNull();
    expect(formatBuildIdentity('string')).toBeNull();
  });

  it('never renders "unknown", "null" or "undefined"', () => {
    const inputs = [{}, { version: null }, { commit: null, buildDate: null }, { ...FULL, commit: null }, { buildDate: 'x' }];
    for (const input of inputs) {
      const out = formatBuildIdentity(input);
      if (out !== null) expect(out).not.toMatch(/unknown|null|undefined|NaN|Invalid/i);
    }
  });

  it('contains no em dash', () => {
    expect(formatBuildIdentity(FULL)).not.toContain('—');
  });
  it('names the developer tools after the channel only when asked', () => {
    expect(formatBuildIdentity(FULL, { devTools: true })).toBe(['Version 0.1.0', 'stable', 'developer tools', 'abc1234', 'built 2026-10-05'].join(SEP));
    expect(formatBuildIdentity(FULL, { devTools: false })).not.toContain('developer tools');
    expect(formatBuildIdentity({ ...FULL, devTools: true })).not.toContain('developer tools');
  });
});
