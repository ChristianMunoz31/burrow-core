// The config/store.json loader (docs/LICENSING.md 11, 18): placeholders leave a store unconfigured, valid
// values configure it, junk never throws and only turns that store off.
import { describe, expect, it } from 'vitest';
import storeJson from '../../../config/store.json' with { type: 'json' };
import { buildStoreConfig } from '../../license/storeConfig.js';
import { gumroad } from '../../license/stores/gumroad.js';
import { lemonSqueezy } from '../../license/stores/lemonSqueezy.js';

const valid = () => ({
  supportContact: ' help@example.com ',
  gumroad: {
    proProductId: 'AbC123_=-xyz',
    proVersions: { Standard: 'standard', Founding: 'founding', Family: 'family' },
    freeLicenseProductId: 'FreeProd9==',
    freeLicenseVersions: { Student: 'student', Nonprofit: 'nonprofit' },
    freeLicenseDefaultEdition: 'student',
    maxUses: { standard: 5, family: 12 },
  },
  lemonSqueezy: { storeId: '123', productIds: ['456', 789], variantEditions: { 1001: 'standard', 1004: 'student' } },
});
const load = (raw) => {
  const logs = [];
  return { config: buildStoreConfig(raw, (m) => logs.push(m)), logs };
};
const configured = (c) => ({ gumroad: gumroad.isConfigured(c), lemonsqueezy: lemonSqueezy.isConfigured(c) });

describe('buildStoreConfig', () => {
  it('the committed file configures Gumroad (Pro and student products), Lemon Squeezy stays off, no log lines', () => {
    const { config, logs } = load(storeJson);
    expect(configured(config)).toEqual({ gumroad: true, lemonsqueezy: false });
    expect(config.GUMROAD.productId).toBe('00SAHmplkC29OhrGdw3jcw==');
    expect(config.GUMROAD.freeProductId).toBe('Jk2_BESpm1imDp_OPLJ9PA==');
    expect(config.GUMROAD.freeDefaultEdition).toBe('student');
    expect(config.GUMROAD.variantEditions).toEqual({ Standard: 'standard', Founding: 'founding', Family: 'family' });
    expect(logs).toEqual([]);
    expect(typeof storeJson._help).toBe('string');
  });

  it('valid values configure both stores and the result is frozen', () => {
    const { config, logs } = load(valid());
    expect(logs).toEqual([]);
    expect(configured(config)).toEqual({ gumroad: true, lemonsqueezy: true });
    expect(config.SUPPORT_CONTACT).toBe('help@example.com');
    expect(config.GUMROAD).toMatchObject({ productId: 'AbC123_=-xyz', freeProductId: 'FreeProd9==', freeDefaultEdition: 'student' });
    expect(config.GUMROAD_MAX_USES).toEqual({ standard: 5, founding: 3, family: 12, student: 3, nonprofit: 3 });
    expect(config.LEMON_SQUEEZY).toEqual({ storeId: '123', productIds: ['456', '789'], variantEditions: { 1001: 'standard', 1004: 'student' } });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.GUMROAD)).toBe(true);
    expect(Object.isFrozen(config.GUMROAD_MAX_USES)).toBe(true);
    expect(Object.isFrozen(config.LEMON_SQUEEZY.productIds)).toBe(true);
  });

  it('a Gumroad id alone configures Gumroad with the default versions, and the free product stays off', () => {
    const { config } = load({ gumroad: { proProductId: 'abc' } });
    expect(gumroad.isConfigured(config)).toBe(true);
    expect(config.GUMROAD.freeProductId).toBeNull();
    expect(config.GUMROAD.freeDefaultEdition).toBeNull();
    expect(config.GUMROAD.variantEditions).toEqual({ Standard: 'standard', Founding: 'founding', Family: 'family' });
  });

  it.each([
    ['not an object', 'nope'],
    ['an array', []],
    ['null', null],
    ['undefined', undefined],
    ['a number', 7],
  ])('a root that is %s leaves everything off without throwing', (_n, raw) => {
    const { config } = load(raw);
    expect(configured(config)).toEqual({ gumroad: false, lemonsqueezy: false });
    expect(config.SUPPORT_CONTACT).toBeNull();
  });

  it.each([
    ['spaces in the id', { proProductId: 'a b' }],
    ['a too long id', { proProductId: 'a'.repeat(65) }],
    ['a non-string id', { proProductId: 12 }],
    ['a URL as the id', { proProductId: 'https://x.gumroad.com/l/abc' }],
    ['an unknown edition in proVersions', { proProductId: 'abc', proVersions: { Standard: 'platinum' } }],
    ['a free edition in proVersions', { proProductId: 'abc', proVersions: { Student: 'student' } }],
    ['empty proVersions', { proProductId: 'abc', proVersions: {} }],
    ['proVersions as an array', { proProductId: 'abc', proVersions: ['Standard'] }],
    ['a version name with parentheses', { proProductId: 'abc', proVersions: { '(Standard)': 'standard' } }],
    ['maxUses of zero', { proProductId: 'abc', maxUses: { standard: 0 } }],
    ['maxUses fractional', { proProductId: 'abc', maxUses: { standard: 1.5 } }],
    ['maxUses as a string', { proProductId: 'abc', maxUses: { standard: '3' } }],
    ['maxUses for an unknown edition', { proProductId: 'abc', maxUses: { gold: 3 } }],
    ['a bad free product id', { proProductId: 'abc', freeLicenseProductId: 'bad id' }],
    ['the free id equal to the main id', { proProductId: 'abc', freeLicenseProductId: 'abc' }],
    ['a pro edition in freeLicenseVersions', { proProductId: 'abc', freeLicenseProductId: 'def', freeLicenseVersions: { Student: 'standard' } }],
    ['a pro edition as the free default', { proProductId: 'abc', freeLicenseProductId: 'def', freeLicenseDefaultEdition: 'family' }],
    ['a non-string free default', { proProductId: 'abc', freeLicenseProductId: 'def', freeLicenseDefaultEdition: 5 }],
    ['gumroad as a string', 'abc'],
  ])('junk in gumroad (%s) turns Gumroad off, logs one line and never throws', (_n, g) => {
    const { config, logs } = load({ ...valid(), gumroad: g });
    expect(gumroad.isConfigured(config)).toBe(false);
    expect(lemonSqueezy.isConfigured(config)).toBe(true);
    expect(config.GUMROAD.productId).toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^license: config\/store\.json gumroad/);
  });

  it.each([
    ['a non-decimal store id', { storeId: 'abc', productIds: ['1'], variantEditions: { 1: 'standard' } }],
    ['a missing store id', { storeId: '', productIds: ['1'], variantEditions: { 1: 'standard' } }],
    ['no product ids', { storeId: '1', productIds: [], variantEditions: { 1: 'standard' } }],
    ['a bad product id', { storeId: '1', productIds: ['x'], variantEditions: { 1: 'standard' } }],
    ['no variants', { storeId: '1', productIds: ['1'], variantEditions: {} }],
    ['an unknown variant edition', { storeId: '1', productIds: ['1'], variantEditions: { 1: 'gold' } }],
    ['a non-decimal variant id', { storeId: '1', productIds: ['1'], variantEditions: { one: 'standard' } }],
    ['productIds as a string', { storeId: '1', productIds: '1', variantEditions: { 1: 'standard' } }],
  ])('junk in lemonSqueezy (%s) turns Lemon Squeezy off only', (_n, ls) => {
    const { config, logs } = load({ ...valid(), lemonSqueezy: ls });
    expect(lemonSqueezy.isConfigured(config)).toBe(false);
    expect(gumroad.isConfigured(config)).toBe(true);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/lemonSqueezy/);
  });

  it.each([
    ['empty', '', null],
    ['blank', '   ', null],
    ['a number', 5, null],
    ['too long', 'a'.repeat(201), null],
    ['a control character', 'a\nb', null],
    ['an email', 'me@example.com', 'me@example.com'],
  ])('supportContact %s', (_n, value, expected) => {
    expect(load({ supportContact: value }).config.SUPPORT_CONTACT).toBe(expected);
  });

  it('a throwing logger never breaks loading', () => {
    expect(() =>
      buildStoreConfig({ gumroad: { proProductId: '!!' } }, () => {
        throw new Error('log down');
      }),
    ).not.toThrow();
  });
});

describe('gumroad.proPurchaseUrl', () => {
  const GOOD = 'https://cdmunoz98.gumroad.com/l/burrow';
  const AT = String.fromCharCode(64);
  const url = (value) => load({ gumroad: { proPurchaseUrl: value } }).config.GUMROAD_PURCHASE_URL;

  it('the committed file carries the canonical product page', () => {
    expect(load(storeJson).config.GUMROAD_PURCHASE_URL).toBe(GOOD);
  });

  it.each([
    ['a subdomain page', GOOD, GOOD],
    ['the bare host', 'https://gumroad.com/l/burrow', 'https://gumroad.com/l/burrow'],
    ['padding', `  ${GOOD}  `, GOOD],
    ['a different case host', 'https://CdMunoz98.Gumroad.com/l/burrow', GOOD],
    ['http', 'http://cdmunoz98.gumroad.com/l/burrow', null],
    ['a wrong host', 'https://example.com/l/burrow', null],
    ['a lookalike host', 'https://evilgumroad.com/l/burrow', null],
    ['gumroad as a subdomain of another host', 'https://gumroad.com.example.com/l/burrow', null],
    ['a query string', `${GOOD}?wanted=true`, null],
    ['an empty query marker', `${GOOD}?`, null],
    ['a fragment', `${GOOD}#top`, null],
    ['credentials', `https://user:pw${AT}cdmunoz98.gumroad.com/l/burrow`, null],
    ['a username only', `https://user${AT}cdmunoz98.gumroad.com/l/burrow`, null],
    ['a port', 'https://cdmunoz98.gumroad.com:8443/l/burrow', null],
    ['a relative path', '/l/burrow', null],
    ['a javascript url', 'javascript:alert(1)', null],
    ['whitespace inside', 'https://cdmunoz98.gumroad.com/l/bur row', null],
    ['empty', '', null],
    ['blank', '   ', null],
    ['not a string', 42, null],
    ['too long', `https://gumroad.com/${'a'.repeat(300)}`, null],
  ])('%s', (_n, value, expected) => {
    expect(url(value)).toBe(expected);
  });

  it('is null when absent, never throws, and never logs a store problem for it', () => {
    expect(load({}).config.GUMROAD_PURCHASE_URL).toBeNull();
    const { config, logs } = load({ gumroad: 'junk' });
    expect(config.GUMROAD_PURCHASE_URL).toBeNull();
    expect(logs.join(' ')).not.toContain('proPurchaseUrl');
  });

  it('works while the store ids are still empty, and the Lemon Squeezy seam stays empty', () => {
    expect(load({ gumroad: { proProductId: '', proPurchaseUrl: GOOD } }).config.GUMROAD_PURCHASE_URL).toBe(GOOD);
    expect(load({ lemonSqueezy: { proPurchaseUrl: 'https://store.lemonsqueezy.com/x' } }).config.LEMON_SQUEEZY_PURCHASE_URL).toBeNull();
  });
});
