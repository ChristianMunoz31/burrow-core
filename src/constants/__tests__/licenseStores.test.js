import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { cwd } from 'node:process';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectStore, getLicenseStore, LICENSE_STORES, MAX_KEY_INPUT_CHARS, storeLabel } from '../licenseStores';

const GUMROAD_KEY = '0A1B2C3D-11111111-22222222-FFFFFFFF';
const LS_KEY = '00000000-1111-2222-3333-444444444444';

describe('licenseStores', () => {
  it('lists Gumroad first, then Lemon Squeezy, with labels and hosts', () => {
    expect(LICENSE_STORES.map((s) => [s.id, s.label, s.host])).toEqual([
      ['gumroad', 'Gumroad', 'api.gumroad.com'],
      ['lemonsqueezy', 'Lemon Squeezy', 'api.lemonsqueezy.com'],
    ]);
    expect(storeLabel('lemonsqueezy')).toBe('Lemon Squeezy');
    expect(getLicenseStore('nope')).toBeNull();
  });

  it('detects each store from a full key, ignoring case and whitespace', () => {
    expect(detectStore(GUMROAD_KEY)).toBe('gumroad');
    expect(detectStore(` ${GUMROAD_KEY.toLowerCase()}\n`)).toBe('gumroad');
    expect(detectStore('0A1B2C3D 11111111 22222222 FFFFFFFF')).toBeNull();
    expect(detectStore(LS_KEY)).toBe('lemonsqueezy');
    expect(detectStore(LS_KEY.toUpperCase())).toBe('lemonsqueezy');
    expect(detectStore(`${LS_KEY.slice(0, 18)} ${LS_KEY.slice(18)}`)).toBe('lemonsqueezy');
  });

  it('returns null for partial, empty, oversized or non-string input', () => {
    expect(detectStore('0A1B2C3D-11111111')).toBeNull();
    expect(detectStore(LS_KEY.slice(0, -1))).toBeNull();
    expect(detectStore('')).toBeNull();
    expect(detectStore(`${GUMROAD_KEY}${' '.repeat(MAX_KEY_INPUT_CHARS)}`)).toBeNull();
    expect(detectStore(null)).toBeNull();
    expect(detectStore(42)).toBeNull();
  });
});

// Vitest runs from the repo root.
const SERVER_DIR = resolve(cwd(), 'server/license/stores');
const hasServerStores =
  ['gumroad.js', 'lemonSqueezy.js'].every((f) => existsSync(resolve(SERVER_DIR, f)));

const CORPUS = [
  GUMROAD_KEY,
  GUMROAD_KEY.toLowerCase(),
  `  ${GUMROAD_KEY}  `,
  '0A1B2C3D 11111111 22222222 FFFFFFFF',
  '0A1B2C3D-11111111-22222222',
  '0A1B2C3D-11111111-22222222-FFFFFFFG',
  LS_KEY,
  LS_KEY.toUpperCase(),
  ` ${LS_KEY}\t`,
  LS_KEY.slice(0, -1),
  `${LS_KEY}0`,
  'ABCDEF0123',
  '',
  'not a key',
];

// The server modules are imported lazily so this file still loads while the backend files are in flight.
describe.skipIf(!hasServerStores)('client mirror equals the server adapters', () => {
  it.each([
    ['gumroad', 'gumroad.js', 'gumroad'],
    ['lemonsqueezy', 'lemonSqueezy.js', 'lemonSqueezy'],
  ])('%s normalization and format match for every sample', async (id, file, exportName) => {
    const server = (await import(/* @vite-ignore */ pathToFileURL(resolve(SERVER_DIR, file)).href))[exportName];
    const client = getLicenseStore(id);
    expect(server.id).toBe(id);
    expect(server.label).toBe(client.label);
    expect(server.hosts).toContain(client.host);
    for (const sample of CORPUS) {
      const serverNormalized = server.normalizeKey(sample);
      expect(client.normalize(sample), `normalize ${JSON.stringify(sample)}`).toBe(serverNormalized);
      expect(client.pattern.test(client.normalize(sample)), `match ${JSON.stringify(sample)}`).toBe(
        server.matchesKey(serverNormalized),
      );
    }
  });
});
