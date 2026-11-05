// Javi's characters: selectable flavors of the same polite, dry humor. The assistant is always
// named Javi; a character only changes the style of the humor. This is the single source of truth
// for the server prompts. The ids must match src/constants/javiCharacters.js (checked by
// server/__tests__/javiCharacters.test.js). The choice is the synced setting `javi:character`.
//
// Per character:
//   personality  the 4 line block of the free-form Javi prompt (the Pro module prompts)
//   line         the advisor "Personality:" sentence (standard variant)
//   lineSmall    the same sentence for the small-model advisor variant
//   signOff      the closing-line phrase of the Javi voice block and the briefing prompt
//   brevity      the noun phrase after "Lead with the answer with" in the Javi voice block
//   greetingStyle the style of the briefing greeting line
//   quip         the adjectives before "quip" in the advisor Home overview rule (both variants)
//   quipExample  the example greeting plus quip in that rule (synthetic name, no figures)
// Every text stays polite, allows one quip at most, is never cruel, and has no dashes or emoji.
// No static import of the data layer: the prompt builders import this file for text only, so the database
// is loaded on demand by getCharacter().

export const CHARACTER_STATE_KEY = 'javi:character';
export const DEFAULT_CHARACTER = 'butler';
const CHARACTER_TIMEOUT_MS = 1500;

export const BUTLER_CHARACTER = Object.freeze({
  personality: `- Witty, discreet, and subtly humorous, with the dignified professionalism of an exceptional personal butler.
- Polite, courteous, and composed; delivers dry humor and tasteful comedic observations without ever sacrificing efficiency or respect.
- Keep it natural, an entertaining, devoted butler with impeccable timing, not a stand-up comedian.
- If something is overdue, neglected, or messy, deliver a dry, refined quip or gentle dignified roast (one line max), then attend to business.`,
  line: 'witty, dryly humorous, and impeccably polite, like a devoted professional butler. At most one light quip, never at the cost of being helpful.',
  lineSmall: 'witty, dryly humorous and impeccably polite, like a devoted professional butler with sharp wit. At most one light quip, never at the cost of being helpful.',
  signOff: 'a dry, humorous butler-esque quip or courteous sign-off',
  brevity: 'courteous butler brevity',
  greetingStyle: 'witty, warm, courteous butler style',
  quip: 'dry, specific',
  quipExample: 'Good morning, Sam. Your overdue list has begun to take it personally.',
});

/** The valid character ids, in display order (parity with src/constants/javiCharacters.js). */
export const CHARACTER_IDS = Object.freeze(['butler', 'valet', 'concierge', 'majordomo']);
const ID_SET = new Set(CHARACTER_IDS);
const TEXT_KEYS = Object.freeze(Object.keys(BUTLER_CHARACTER));

/** @type {Record<string, object>} texts the Pro module registered (ctx.javi.registerCharacters) */
let registered = {};

/**
 * Registers the non-butler character texts. Called only by server/proExtensions.js and tests.
 * @param {{ valet?: object, concierge?: object, majordomo?: object }} texts each with the 8 string fields of the butler entry
 */
export function registerCharacterTexts(texts) {
  if (texts === null || typeof texts !== 'object') throw new Error('character texts must be an object');
  const next = { ...registered };
  for (const [id, text] of Object.entries(texts)) {
    if (!ID_SET.has(id) || id === DEFAULT_CHARACTER) throw new Error(`Unknown character id: ${id}`);
    if (text === null || typeof text !== 'object' || !TEXT_KEYS.every((k) => typeof text[k] === 'string' && text[k].length > 0)) {
      throw new Error(`Character text for ${id} is incomplete`);
    }
    next[id] = Object.freeze(Object.fromEntries(TEXT_KEYS.map((k) => [k, text[k]])));
  }
  registered = next;
}

/** Forgets every registered character text. For tests and the install rollback. */
export function resetCharacterTextsForTests() {
  registered = {};
}

const textFor = (id) => (id === DEFAULT_CHARACTER ? BUTLER_CHARACTER : (registered[id] ?? null));

/**
 * Allow-list a character id.
 *
 * @param {unknown} value Any stored or requested value.
 * @returns {string} A known character id, else {@link DEFAULT_CHARACTER}.
 */
export function normalizeCharacter(value) {
  return typeof value === 'string' && ID_SET.has(value) ? value : DEFAULT_CHARACTER;
}

/**
 * The character text for an id. Unknown, missing or not registered (a build without the Pro module) falls back to the butler.
 *
 * @param {unknown} [value]
 * @returns {{ personality: string, line: string, lineSmall: string, signOff: string, brevity: string, greetingStyle: string, quip: string, quipExample: string }}
 */
export const characterText = (value) => textFor(normalizeCharacter(value)) ?? BUTLER_CHARACTER;

/**
 * The saved character for prompts. `app_state.value` is a jsonb column: `useSyncedSetting` PUTs the bare id
 * and it reads back as a plain string; a JSON-quoted string is tolerated too. Never throws and never waits
 * long: any failure gives the default. A character whose text is not registered (a build without the private
 * module) reads as the butler, never an error.
 *
 * @returns {Promise<string>} A known character id.
 */
export async function getCharacter() {
  let timer;
  try {
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), CHARACTER_TIMEOUT_MS);
      timer.unref?.();
    });
    const raw = await Promise.race([import('../dataAccess.js').then(({ getState }) => getState(CHARACTER_STATE_KEY, null)), timeout]);
    let id;
    if (typeof raw === 'string' && raw.startsWith('"')) {
      try {
        id = normalizeCharacter(JSON.parse(raw));
      } catch {
        return DEFAULT_CHARACTER;
      }
    } else {
      id = normalizeCharacter(raw);
    }
    if (id === DEFAULT_CHARACTER) return id;
    // A character whose text is not in this build reads as the butler.
    if (textFor(id) === null) return DEFAULT_CHARACTER;
    return id;
  } catch {
    return DEFAULT_CHARACTER;
  } finally {
    clearTimeout(timer);
  }
}
