// Small pure helpers shared by the Javi eval path runners (scripts/evalJavi.js and the Pro runners). No I/O.

/**
 * Escape a string for use inside a RegExp.
 * @param {string} s
 * @returns {string}
 */
export const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Regex for a money amount as a model may write it ($1,234.50, 1234.5 and so on).
 * @param {number} n
 * @returns {RegExp}
 */
export const amountRe = (n) => {
  const fixed = Math.abs(n).toFixed(2);
  const [int, cents] = fixed.split('.');
  const withSep = Number(int).toLocaleString('en-US');
  return new RegExp(`\\$?\\s?(?:${esc(withSep)}|${esc(int)})(?:\\.${cents})${cents === '00' ? '?' : ''}(?!\\d)`);
};

/**
 * Local calendar date as YYYY-MM-DD.
 * @param {Date} d
 * @returns {string}
 */
export function localDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
