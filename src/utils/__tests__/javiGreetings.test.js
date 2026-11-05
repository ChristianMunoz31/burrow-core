import { describe, expect, it } from 'vitest';
import {
  AFTERNOON_GREETINGS,
  EVENING_GREETINGS,
  MORNING_GREETINGS,
  NIGHT_GREETINGS,
  getRandomGreeting,
  getTimeOfDay,
  personalizeGreeting,
} from '../javiGreetings';

describe('javiGreetings', () => {
  it('correctly categorizes hours of the day', () => {
    // Night (late night / evening)
    expect(getTimeOfDay(0)).toBe('night');
    expect(getTimeOfDay(4)).toBe('night');
    expect(getTimeOfDay(21)).toBe('night');
    expect(getTimeOfDay(23)).toBe('night');

    // Morning
    expect(getTimeOfDay(5)).toBe('morning');
    expect(getTimeOfDay(8)).toBe('morning');
    expect(getTimeOfDay(11)).toBe('morning');

    // Afternoon
    expect(getTimeOfDay(12)).toBe('afternoon');
    expect(getTimeOfDay(14)).toBe('afternoon');
    expect(getTimeOfDay(16)).toBe('afternoon');

    // Evening
    expect(getTimeOfDay(17)).toBe('evening');
    expect(getTimeOfDay(19)).toBe('evening');
    expect(getTimeOfDay(20)).toBe('evening');
  });

  it('selects time-appropriate greetings', () => {
    const morningDate = new Date(2026, 9, 12, 8, 30);
    const morning = getRandomGreeting(morningDate);
    expect(morning).toMatch(/^Good morning\./);
    expect(MORNING_GREETINGS).toContain(morning);

    const nightDate = new Date(2026, 9, 12, 23, 15);
    const night = getRandomGreeting(nightDate);
    expect(night).toMatch(/^Good night\./);
    expect(NIGHT_GREETINGS).toContain(night);

    const afternoonDate = new Date(2026, 9, 12, 13, 0);
    const afternoon = getRandomGreeting(afternoonDate);
    expect(afternoon).toMatch(/^Good afternoon\./);
    expect(AFTERNOON_GREETINGS).toContain(afternoon);

    const eveningDate = new Date(2026, 9, 12, 18, 0);
    const evening = getRandomGreeting(eveningDate);
    expect(evening).toMatch(/^Good evening\./);
    expect(EVENING_GREETINGS).toContain(evening);
  });

  it('uses randomFn to pick index within bounds', () => {
    const morningDate = new Date(2026, 9, 12, 9, 0);
    expect(getRandomGreeting(morningDate, () => 0)).toBe(MORNING_GREETINGS[0]);
    expect(getRandomGreeting(morningDate, () => 0.999)).toBe(
      MORNING_GREETINGS[MORNING_GREETINGS.length - 1],
    );
  });

  it('contains no em dashes, en dashes, or emoji across all greetings', () => {
    const all = [
      ...MORNING_GREETINGS,
      ...AFTERNOON_GREETINGS,
      ...EVENING_GREETINGS,
      ...NIGHT_GREETINGS,
    ];
    for (const g of all) {
      expect(g).not.toMatch(/[—–]/);
      expect(g).not.toMatch(/\p{Emoji_Presentation}/u);
    }
  });

  describe('personalizeGreeting', () => {
    it('injects user name after the time greeting', () => {
      expect(personalizeGreeting('Good morning. I have laid out your schedule, though I cannot vouch for its mercy.', 'Sam')).toBe(
        'Good morning, Sam. I have laid out your schedule, though I cannot vouch for its mercy.',
      );
      expect(personalizeGreeting('Good afternoon. Half the day has elapsed, and catastrophe remains remarkably well contained.', 'Alex')).toBe(
        'Good afternoon, Alex. Half the day has elapsed, and catastrophe remains remarkably well contained.',
      );
      expect(personalizeGreeting('Good evening. I recommend stepping away from the keyboard; tomorrow\'s tasks will wait patiently.', 'Jordan')).toBe(
        'Good evening, Jordan. I recommend stepping away from the keyboard; tomorrow\'s tasks will wait patiently.',
      );
      expect(personalizeGreeting('Good night. Do retire to bed; the database will faithfully keep vigil until dawn.', 'Morgan')).toBe(
        'Good night, Morgan. Do retire to bed; the database will faithfully keep vigil until dawn.',
      );
    });

    it('trims whitespace around name', () => {
      expect(personalizeGreeting('Good morning. Burrow is at your service, prepared to bring order to the inevitable chaos.', '  Sam  ')).toBe(
        'Good morning, Sam. Burrow is at your service, prepared to bring order to the inevitable chaos.',
      );
    });

    it('returns base greeting unchanged if name is null, undefined, empty, or whitespace', () => {
      const g = 'Good morning. Coffee is strongly advised before we confront your itinerary.';
      expect(personalizeGreeting(g, null)).toBe(g);
      expect(personalizeGreeting(g, undefined)).toBe(g);
      expect(personalizeGreeting(g, '')).toBe(g);
      expect(personalizeGreeting(g, '   ')).toBe(g);
    });
  });

  describe('getRandomGreeting with name', () => {
    it('personalizes greeting with name when provided', () => {
      const morningDate = new Date(2026, 9, 12, 8, 30);
      const greeting = getRandomGreeting(morningDate, () => 0, 'Sam');
      expect(greeting).toBe('Good morning, Sam. I have laid out your schedule, though I cannot vouch for its mercy.');
    });

    it('falls back to standard greeting when name is omitted or empty', () => {
      const morningDate = new Date(2026, 9, 12, 8, 30);
      expect(getRandomGreeting(morningDate, () => 0)).toBe('Good morning. I have laid out your schedule, though I cannot vouch for its mercy.');
      expect(getRandomGreeting(morningDate, () => 0, '')).toBe('Good morning. I have laid out your schedule, though I cannot vouch for its mercy.');
    });
  });
});
