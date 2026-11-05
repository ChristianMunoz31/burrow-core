// Small helpers shared by the store adapters.

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * A store email is stored only when it is a usable string; anything else becomes null.
 * @param {unknown} value
 * @returns {string | null}
 */
export function cleanEmail(value) {
  if (typeof value !== 'string' || value.length < 3 || value.length > 254) return null;
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(value) ? null : value;
}
