import { describe, it, expect } from 'vitest';
import { describeWeather } from '../weatherCodes';

describe('describeWeather', () => {
  it('maps clear sky (0)', () => {
    expect(describeWeather(0)).toEqual({ label: 'Clear', emoji: '☀️' });
  });

  it('maps mainly clear / partly cloudy / overcast (1, 2, 3)', () => {
    expect(describeWeather(1).label).toBe('Mainly clear');
    expect(describeWeather(2).label).toBe('Partly cloudy');
    expect(describeWeather(3).label).toBe('Overcast');
  });

  it('maps fog (45, 48)', () => {
    expect(describeWeather(45).label).toBe('Fog');
    expect(describeWeather(48).label).toBe('Fog');
  });

  it('maps drizzle (51, 53, 55, 56, 57)', () => {
    for (const code of [51, 53, 55, 56, 57]) {
      expect(describeWeather(code).label).toBe('Drizzle');
    }
  });

  it('maps rain (61-67)', () => {
    for (const code of [61, 63, 65, 66, 67]) {
      expect(describeWeather(code).label).toBe('Rain');
    }
  });

  it('maps snow (71-77)', () => {
    for (const code of [71, 73, 75, 77]) {
      expect(describeWeather(code).label).toBe('Snow');
    }
  });

  it('maps rain showers (80-82)', () => {
    for (const code of [80, 81, 82]) {
      expect(describeWeather(code).label).toBe('Showers');
    }
  });

  it('maps snow showers (85, 86)', () => {
    expect(describeWeather(85).label).toBe('Snow showers');
    expect(describeWeather(86).label).toBe('Snow showers');
  });

  it('maps thunderstorms (95+)', () => {
    expect(describeWeather(95).label).toBe('Thunderstorm');
    expect(describeWeather(99).label).toBe('Thunderstorm');
  });

  it('falls back on unknown code in gaps', () => {
    // 4-44, 46-47, 49-50, 58-60, 68-70, 78-79, 83-84, 87-94 are gaps
    for (const code of [4, 47, 60, 78, 87, 94]) {
      expect(describeWeather(code).label).toBe('Unknown');
    }
  });

  it('always returns an emoji string', () => {
    for (const code of [0, 1, 45, 51, 61, 71, 80, 85, 95, 12345]) {
      const result = describeWeather(code);
      expect(typeof result.emoji).toBe('string');
      expect(result.emoji.length).toBeGreaterThan(0);
    }
  });
});
