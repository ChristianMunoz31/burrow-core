import { describe, expect, it } from 'vitest';
import { buildWeatherBrief, weatherAside } from '../weatherBrief';

const day = (highF, lowF, condition = 'Clear') => ({ date: '2026-10-10', highF, lowF, condition });

describe('buildWeatherBrief', () => {
  it('is one short line: now, then today', () => {
    expect(buildWeatherBrief({ current: { tempF: 71.6, condition: 'Partly cloudy' }, days: [day(78.4, 61.2)] })).toBe(
      '72°, partly cloudy. Today 78° / 61°.',
    );
  });

  it('returns null with no data', () => {
    expect(buildWeatherBrief(null)).toBeNull();
    expect(buildWeatherBrief({ current: null, days: [] })).toBeNull();
    expect(buildWeatherBrief({ current: { tempF: null, condition: 'Unknown' }, days: [day(null, 50)] })).toBeNull();
  });

  it('handles a missing current reading or condition', () => {
    expect(buildWeatherBrief({ current: null, days: [day(72, 55)] })).toBe('Today 72° / 55°.');
    expect(buildWeatherBrief({ current: { tempF: 70, condition: null }, days: [] })).toBe('70°.');
    expect(buildWeatherBrief({ current: { tempF: null, condition: 'Clear' }, days: [] })).toBe('Clear.');
  });

  it('falls back to tomorrow when today has no high or low, and never to later days', () => {
    expect(buildWeatherBrief({ current: null, days: [day(null, 55), day(68, 50)] })).toBe('Tomorrow 68° / 50°.');
    expect(buildWeatherBrief({ current: null, days: [day(null, 55), day(68, null), day(66, 49)] })).toBeNull();
  });

  it('never shows a question mark or a placeholder', () => {
    const line = buildWeatherBrief({ current: { tempF: undefined, condition: 'Clear' }, days: [day(72, 55)] });
    expect(line).not.toMatch(/\?|--|NaN|undefined/);
  });

  it('adds a dry aside', () => {
    expect(buildWeatherBrief({ current: { tempF: 60, condition: 'Rain' }, days: [day(66, 49, 'Rain')] })).toBe(
      '60°, rain. Today 66° / 49°. Umbrella weather.',
    );
    expect(buildWeatherBrief({ current: { tempF: 50, condition: 'Clear' }, days: [day(58, 38)] })).toBe(
      '50°, clear. Today 58° / 38°. Bring a jacket.',
    );
  });
});

describe('weatherAside', () => {
  it('picks wet, then snow, then cold, then hot', () => {
    expect(weatherAside({ conditions: ['drizzle'], lowF: 30 })).toBe('Umbrella weather.');
    expect(weatherAside({ conditions: [null, 'thunderstorm'] })).toBe('Umbrella weather.');
    expect(weatherAside({ conditions: ['snow showers'], lowF: 20 })).toBe('Umbrella weather.');
    expect(weatherAside({ conditions: ['snow'], lowF: 20 })).toBe('Boots, probably.');
    expect(weatherAside({ conditions: ['clear'], lowF: 44 })).toBe('Bring a jacket.');
    expect(weatherAside({ conditions: ['clear'], lowF: 70, highF: 92 })).toBe('Hot one. Hydrate.');
  });

  it('says nothing on a mild day or without data', () => {
    expect(weatherAside({ conditions: ['clear'], lowF: 55, highF: 72 })).toBeNull();
    expect(weatherAside()).toBeNull();
  });
});
