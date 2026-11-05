// Allowlist of third-party API keys manageable from Settings. Anything not listed
// here can never be read, written or tested through /api/secrets. The `test` pings
// call the internet, so POST /api/secrets/:name/test is gated by the provider's
// network opt-in named by the def's `networkFeature` (server/netPolicy.js).

/** @typedef {{ name: string, label: string, provider: string, description: string,
 *   pattern: RegExp, maxLength: number,
 *   networkFeature?: string,
 *   test?: { url: string, headers: (value: string) => Record<string, string> } }} SecretDef */

const bearer = (value) => ({ Authorization: `Bearer ${value}` });

/** @type {ReadonlyArray<SecretDef>} */
export const SECRET_DEFS = Object.freeze([
  {
    name: 'AI_CLOUD_API_KEY',
    label: 'Cloud AI',
    provider: 'cloud_ai',
    description: 'Key for your own cloud AI. Only used after you turn on cloud AI.',
    // Printable ASCII, no spaces: cloud providers use many key formats.
    pattern: /^[\x21-\x7e]{8,512}$/,
    maxLength: 512,
  },
  {
    name: 'OURA_TOKEN',
    label: 'Oura Ring',
    provider: 'oura',
    description: 'Health card and Javi health data',
    pattern: /^[A-Za-z0-9_-]{20,128}$/,
    maxLength: 128,
    networkFeature: 'oura',
    test: { url: 'https://api.ouraring.com/v2/usercollection/personal_info', headers: bearer },
  },
]);

export const SECRET_NAMES = Object.freeze(SECRET_DEFS.map((d) => d.name));

const BY_NAME = new Map(SECRET_DEFS.map((d) => [d.name, d]));

/** @param {string} name @returns {SecretDef | undefined} case-sensitive lookup */
export const getSecretDef = (name) => (typeof name === 'string' ? BY_NAME.get(name) : undefined);

/**
 * @param {string} name allowlisted secret name
 * @param {unknown} raw
 * @returns {{ ok: true, value: string } | { ok: false }}
 */
export function validateSecretValue(name, raw) {
  const def = getSecretDef(name);
  if (!def || typeof raw !== 'string') return { ok: false };
  const value = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (!value || value.length > def.maxLength || /[\s\x00-\x1f\x7f]/.test(value)) return { ok: false };
  if (!def.pattern.test(value)) return { ok: false };
  return { ok: true, value };
}
