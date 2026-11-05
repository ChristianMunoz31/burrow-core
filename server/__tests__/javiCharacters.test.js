// Javi characters: the server map matches the client list (src/constants/javiCharacters.js), the allow-list
// and the stored-setting reader, and each character reaches the advisor (both variants), Javi and briefing prompts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A character whose text is not registered (no module, or an unknown id) falls back to the butler.

const h = vi.hoisted(() => ({ mode: 'real' }));
vi.mock('../dataAccess.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    getState: vi.fn((...args) => {
      if (h.mode === 'throw') return Promise.reject(new Error('storage down'));
      if (h.mode === 'hang') return new Promise(() => {});
      return real.getState(...args);
    }),
  };
});

import { JAVI_CHARACTERS } from '../../src/constants/javiCharacters.js';
import { SETTINGS_KEYS, normalizeJaviCharacter } from '../../src/constants/settingsDefaults.js';
import { setState } from '../dataAccess.js';
import { BUTLER_CHARACTER, CHARACTER_IDS, CHARACTER_STATE_KEY, DEFAULT_CHARACTER, getCharacter, normalizeCharacter } from '../javi/characters.js';
import { adviceCacheKey } from '../javi/adviceCache.js';
import { advisorSystemPrompt, buildAdvisorMessages } from '../javi/advisorPrompt.js';
import { closeTestDb, createTestDb } from './helpers/testDb.js';
import { BUTLER_ADVISOR_SMALL, BUTLER_ADVISOR_STANDARD, BUTLER_BRIEFING, BUTLER_JARVIS } from './fixtures/javiButlerGolden.js';

() => ''
const DASH_OR_EMOJI_RE = /[‒-―−]|\p{Extended_Pictographic}/u;
const IDS = ['butler', 'valet', 'concierge', 'majordomo'];

// Literals taken from the butler text before the per-character brevity, greeting style and quip fields existed.
const BUTLER_PERSONALITY = [
  '- Witty, discreet, and subtly humorous, with the dignified professionalism of an exceptional personal butler.',
  '- Polite, courteous, and composed; delivers dry humor and tasteful comedic observations without ever sacrificing efficiency or respect.',
  '- Keep it natural, an entertaining, devoted butler with impeccable timing, not a stand-up comedian.',
  '- If something is overdue, neglected, or messy, deliver a dry, refined quip or gentle dignified roast (one line max), then attend to business.',
].join('\n');
const BUTLER_LINE_SMALL =
  'witty, dryly humorous and impeccably polite, like a devoted professional butler with sharp wit. At most one light quip, never at the cost of being helpful.';
describe('client and server character lists', () => {
  it('have exactly the same ids, in the same order', () => {
    expect(CHARACTER_IDS).toEqual(JAVI_CHARACTERS.map((c) => c.id));
    expect(CHARACTER_IDS).toEqual(IDS);
  });

  it('agree on the setting key and the default', () => {
    expect(SETTINGS_KEYS.javiCharacter).toBe(CHARACTER_STATE_KEY);
    expect(normalizeJaviCharacter(undefined)).toBe(DEFAULT_CHARACTER);
    expect(DEFAULT_CHARACTER).toBe('butler');
  });

  it('every id is accepted by both allow-lists and unknown ids by neither', () => {
    for (const id of CHARACTER_IDS) {
      expect(normalizeCharacter(id)).toBe(id);
      expect(normalizeJaviCharacter(id)).toBe(id);
    }
    expect(normalizeCharacter('pirate')).toBe(DEFAULT_CHARACTER);
    expect(normalizeJaviCharacter('pirate')).toBe(DEFAULT_CHARACTER);
  });
});

describe('character text', () => {
  it('keeps the butler wording verbatim', () => {
    expect(BUTLER_CHARACTER.personality).toBe(BUTLER_PERSONALITY);
    expect(BUTLER_CHARACTER.lineSmall).toBe(BUTLER_LINE_SMALL);
    expect(BUTLER_CHARACTER.line).toBe(
      'witty, dryly humorous, and impeccably polite, like a devoted professional butler. At most one light quip, never at the cost of being helpful.',
    );
    expect(BUTLER_CHARACTER.signOff).toBe('a dry, humorous butler-esque quip or courteous sign-off');
  });

  it('the butler text is plain: 4 line personality, no dashes and no emoji', () => {
    const c = BUTLER_CHARACTER;
    expect(c.personality.split('\n')).toHaveLength(4);
    for (const text of [c.personality, c.line, c.lineSmall, c.signOff, c.brevity, c.greetingStyle, c.quip, c.quipExample]) {
      expect(text).not.toMatch(DASH_OR_EMOJI_RE);
      expect(text.trim()).not.toBe('');
    }
  });
});

describe('butler output is byte-identical to the golden snapshots', () => {
  it('the default and an explicit butler give the golden advisor prompts (both variants, with a name)', () => {
    for (const character of [undefined, 'butler']) {
      expect(advisorSystemPrompt({ displayName: 'Sam', character })).toBe(BUTLER_ADVISOR_STANDARD);
      expect(advisorSystemPrompt({ displayName: 'Sam', variant: 'small', character })).toBe(BUTLER_ADVISOR_SMALL);
    }
  });

  it('the golden prompts hold the butler wording the shared text used to hard-code', () => {
    expect(BUTLER_JARVIS).toContain('Lead with the answer with courteous butler brevity.');
    expect(BUTLER_BRIEFING).toContain('in a witty, warm, courteous butler style.');
    for (const golden of [BUTLER_ADVISOR_STANDARD, BUTLER_ADVISOR_SMALL]) {
      expect(golden).toContain('one dry, specific quip about');
      expect(golden).toContain('(e.g. "Good morning, Sam. Your overdue list has begun to take it personally.")');
    }
  });
});

describe('getCharacter', () => {
  let db;
  beforeEach(() => {
    h.mode = 'real';
    db = createTestDb();
  });
  afterEach(() => {
    vi.useRealTimers();
    h.mode = 'real';
    closeTestDb(db);
  });

  it('defaults to the butler when nothing is stored', async () => {
    expect(await getCharacter()).toBe('butler');
  });

  it.each([['pirate'], [''], [42], [{ id: 'valet' }], ['"pirate"'], ['"unterminated']])('falls back to the butler for the stored value %j', async (value) => {
    await setState('javi:character', value);
    expect(await getCharacter()).toBe('butler');
  });

  it('returns the stored butler (the plain string the client saves)', async () => {
    await setState('javi:character', 'butler');
    expect(await getCharacter()).toBe('butler');
  });

  it.each(['valet', 'concierge', 'majordomo'])('a saved %s reads as the butler when no module registered its text', async (id) => {
    await setState('javi:character', id);
    expect(await getCharacter()).toBe('butler');
  });

  it('falls back to the butler when storage throws', async () => {
    h.mode = 'throw';
    expect(await getCharacter()).toBe('butler');
  });

  it('falls back to the butler when storage does not answer in time', async () => {
    vi.useFakeTimers();
    h.mode = 'hang';
    const pending = getCharacter();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toBe('butler');
  });
});

describe('advisor prompts per character (butler, the only text in core)', () => {
  const pageA = { pageLabel: 'Todos', context: '{"a":1}', messages: [] };
  const pageB = { pageLabel: 'Budget', context: '{"b":2}', messages: [] };

  it('no character, or an unknown or unregistered one, gives the butler text, byte for byte', () => {
    for (const variant of ['standard', 'small']) {
      expect(advisorSystemPrompt({ variant })).toBe(advisorSystemPrompt({ variant, character: 'butler' }));
      expect(advisorSystemPrompt({ variant, character: 'pirate' })).toBe(advisorSystemPrompt({ variant }));
      expect(advisorSystemPrompt({ variant, character: 'valet' })).toBe(advisorSystemPrompt({ variant }));
    }
  });

  it('the butler reaches the advisor prompt in both variants', () => {
    const standard = advisorSystemPrompt({ character: 'butler' });
    const small = advisorSystemPrompt({ variant: 'small', character: 'butler' });
    expect(standard).toContain(`Personality: ${BUTLER_CHARACTER.line}\n`);
    expect(small).toContain(`Personality: ${BUTLER_CHARACTER.lineSmall}\n`);
    expect(standard).not.toMatch(DASH_OR_EMOJI_RE);
    expect(small).not.toMatch(DASH_OR_EMOJI_RE);
  });

  it('the butler advisor system prompt is byte-identical across pages', () => {
    for (const variant of ['standard', 'small']) {
      const a = buildAdvisorMessages({ ...pageA, variant, character: 'butler' });
      const b = buildAdvisorMessages({ ...pageB, variant, character: 'butler' });
      expect(a[0].content).toBe(b[0].content);
      expect(a[0].content).toBe(advisorSystemPrompt({ variant, character: 'butler' }));
    }
  });
});

describe('adviceCacheKey', () => {
  const parts = { model: 'm', kind: 'local', page: 'budget', context: '{}', promptVersion: 'advice-v6', displayName: 'Sam', hourBucket: '10' };

  it('changes with the character, so a card is never replayed under another one', () => {
    const keys = IDS.map((character) => adviceCacheKey({ ...parts, character }));
    expect(new Set(keys).size).toBe(IDS.length);
    expect(adviceCacheKey({ ...parts, character: 'valet' })).toBe(adviceCacheKey({ ...parts, character: 'valet' }));
  });
});
