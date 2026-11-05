// Client mirror of server/license/stores/*.js (docs/LICENSING.md section 3).
// A test imports both sides and asserts they agree.

export const GUMROAD = 'gumroad';
export const LEMON_SQUEEZY = 'lemonsqueezy';

/** Longest key input the server accepts, counted before whitespace is stripped. */
export const MAX_KEY_INPUT_CHARS = 128;

/** Ordered: Gumroad first. `host` is shown in the disclosure note. */
export const LICENSE_STORES = Object.freeze([
  Object.freeze({
    id: GUMROAD,
    label: 'Gumroad',
    host: 'api.gumroad.com',
    pattern: /^[0-9A-F]{8}(-[0-9A-F]{8}){3}$/,
    normalize: (raw) => raw.replace(/\s+/g, '').toUpperCase(),
  }),
  Object.freeze({
    id: LEMON_SQUEEZY,
    label: 'Lemon Squeezy',
    host: 'api.lemonsqueezy.com',
    pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    normalize: (raw) => raw.replace(/\s+/g, '').toLowerCase(),
  }),
]);

/** @param {string} id @returns {typeof LICENSE_STORES[number] | null} */
export const getLicenseStore = (id) => LICENSE_STORES.find((s) => s.id === id) ?? null;

/** Store label for an id, or the id itself when unknown. */
export const storeLabel = (id) => getLicenseStore(id)?.label ?? String(id ?? '');

/**
 * The one store whose key format the whole input matches (after that store's own normalization), else null.
 * Partial input never matches, so typing never switches the picker early.
 * @param {unknown} raw
 * @returns {string | null}
 */
export function detectStore(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_KEY_INPUT_CHARS) return null;
  for (const store of LICENSE_STORES) {
    if (store.pattern.test(store.normalize(raw))) return store.id;
  }
  return null;
}
