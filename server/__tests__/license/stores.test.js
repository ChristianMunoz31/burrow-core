// Key formats, store detection, store dates, terms, the channel seam and the error copy
// (docs/LICENSING.md 3, 4.5, 4.7, 10.7). All pure: no network, no database.
import { describe, expect, it, vi } from 'vitest';
import { LICENSE_STORES, detectStore as clientDetectStore, storeLabel } from '../../../src/constants/licenseStores.js';
import { allowStoreTestPurchases, storeBaseUrl } from '../../license/channelSeam.js';
import { DAY_MS, MAX_KEY_INPUT_CHARS, UPDATE_DAYS } from '../../license/constants.js';
import { STORE_ERROR_STATUS, storeErrorMessage, supportText } from '../../license/messages.js';
import { STORES, detectStore, getStore } from '../../license/stores/index.js';
import { computeTerms, parseStoreDate } from '../../license/terms.js';
import { GUMROAD_KEY, LS_KEY } from './fixtures/storeResponses.js';

const ms = (iso) => Date.parse(iso);

describe('key formats', () => {
  const gumroad = getStore('gumroad');
  const ls = getStore('lemonsqueezy');

  it('lists Gumroad first', () => {
    expect(STORES.map((s) => s.id)).toEqual(['gumroad', 'lemonsqueezy']);
    expect(getStore('nope')).toBeNull();
  });

  it('normalizes with each store rule: all whitespace stripped, then upper or lower case', () => {
    expect(gumroad.normalizeKey(' 0000aaaa -11111111\t-22222222\n-33333333 ')).toBe('0000AAAA-11111111-22222222-33333333');
    expect(ls.normalizeKey(' 0000AAAA-1111 -2222-3333-44444444AAAA\n')).toBe('0000aaaa-1111-2222-3333-44444444aaaa');
  });

  it('detects each format, also from pasted whitespace and the other case', () => {
    expect(detectStore(GUMROAD_KEY)).toBe('gumroad');
    expect(detectStore(`  ${GUMROAD_KEY.toLowerCase()}\n`)).toBe('gumroad');
    expect(detectStore(LS_KEY)).toBe('lemonsqueezy');
    expect(detectStore(` ${LS_KEY.toUpperCase()} `)).toBe('lemonsqueezy');
  });

  it.each([
    [''],
    ['hello world'],
    ['0000000-11111111-22222222-33333333'],
    ['G0000000-11111111-22222222-33333333'],
    ['00000000-1111-2222-3333-44444444444'],
    ['00000000-1111-2222-3333-44444444444g'],
    [`${LS_KEY}-extra`],
    [42],
    [null],
    [undefined],
    [{}],
  ])('detects nothing for %j', (value) => {
    expect(detectStore(value)).toBeNull();
  });

  it('refuses input over 128 characters before stripping whitespace', () => {
    expect(MAX_KEY_INPUT_CHARS).toBe(128);
    expect(detectStore(`${GUMROAD_KEY}${' '.repeat(128 - GUMROAD_KEY.length)}`)).toBe('gumroad');
    expect(detectStore(`${GUMROAD_KEY}${' '.repeat(129 - GUMROAD_KEY.length)}`)).toBeNull();
  });

  it('the two formats cannot both match', () => {
    for (const key of [GUMROAD_KEY, LS_KEY]) {
      const matches = STORES.filter((s) => s.matchesKey(s.normalizeKey(key)));
      expect(matches).toHaveLength(1);
    }
  });

  it('the client mirror equals the server: ids, labels, hosts, patterns, normalization and detection', () => {
    expect(LICENSE_STORES.map((s) => s.id)).toEqual(STORES.map((s) => s.id));
    for (const server of STORES) {
      const client = LICENSE_STORES.find((s) => s.id === server.id);
      expect(client.label).toBe(server.label);
      expect(storeLabel(server.id)).toBe(server.label);
      expect([client.host]).toEqual(server.hosts);
      expect(client.pattern.source).toBe(server.keyPattern.source);
      expect(client.pattern.flags).toBe(server.keyPattern.flags);
    }
    const samples = [GUMROAD_KEY, LS_KEY, ` ${GUMROAD_KEY.toLowerCase()} `, LS_KEY.toUpperCase(), 'junk', '', 'a b c', `${LS_KEY}\n`];
    for (const sample of samples) {
      expect(clientDetectStore(sample)).toBe(detectStore(sample));
      for (const server of STORES) {
        const client = LICENSE_STORES.find((s) => s.id === server.id);
        expect(client.normalize(sample)).toBe(server.normalizeKey(sample));
      }
    }
  });
});

describe('parseStoreDate', () => {
  it('accepts Z, offsets and fractions of 1 to 9 digits, flooring to the second', () => {
    expect(parseStoreDate('2026-09-30T14:02:11Z')).toBe(ms('2026-09-30T14:02:11Z'));
    expect(parseStoreDate('2026-09-30T14:02:11.999Z')).toBe(ms('2026-09-30T14:02:11Z'));
    expect(parseStoreDate('2026-09-30T14:02:11.123456789Z')).toBe(ms('2026-09-30T14:02:11Z'));
    expect(parseStoreDate('2026-09-30T14:02:11.5Z')).toBe(ms('2026-09-30T14:02:11Z'));
    expect(parseStoreDate('2026-09-30T16:02:11+02:00')).toBe(ms('2026-09-30T14:02:11Z'));
    expect(parseStoreDate('2026-09-30T09:32:11.250-04:30')).toBe(ms('2026-09-30T14:02:11Z'));
  });

  it.each([
    ['too early', '2023-12-31T23:59:59Z'],
    ['too late', '3000-01-01T00:00:00Z'],
    ['a fraction of 10 digits', '2026-09-30T14:02:11.1234567890Z'],
    ['an empty fraction', '2026-09-30T14:02:11.Z'],
    ['no zone', '2026-09-30T14:02:11'],
    ['a space instead of T', '2026-09-30 14:02:11Z'],
    ['an impossible day', '2026-02-30T00:00:00Z'],
    ['an impossible hour', '2026-09-30T25:00:00Z'],
    ['an offset of 24 hours', '2026-09-30T14:02:11+24:00'],
    ['an offset of 60 minutes', '2026-09-30T14:02:11+01:60'],
    ['a date only', '2026-09-30'],
    ['junk', 'soon'],
    ['a number', 1_790_000_000_000],
    ['null', null],
    ['an offset pushing out of range', '2024-01-01T00:00:00+01:00'],
  ])('rejects %s', (_name, value) => {
    expect(parseStoreDate(value)).toBeNull();
  });

  it('parses the Lemon Squeezy 6-decimal timestamp', () => {
    expect(parseStoreDate('2026-01-24T14:15:07.000000Z')).toBe(ms('2026-01-24T14:15:07Z'));
  });
});

describe('computeTerms', () => {
  const purchaseDateMs = ms('2026-09-30T14:02:11Z');
  it.each([
    ['standard', 365],
    ['family', 365],
    ['founding', 730],
  ])('%s: updates for %i days, never expires', (edition, days) => {
    expect(UPDATE_DAYS[edition]).toBe(days);
    expect(computeTerms({ edition, purchaseDateMs })).toEqual({ updatesUntilMs: purchaseDateMs + days * DAY_MS, expiresAtMs: null });
  });

  it('ignores a store expiry on paid editions', () => {
    expect(computeTerms({ edition: 'standard', purchaseDateMs, storeExpiresAtMs: purchaseDateMs + DAY_MS })).toEqual({
      updatesUntilMs: purchaseDateMs + 365 * DAY_MS,
      expiresAtMs: null,
    });
  });

  it.each(['student', 'nonprofit'])('%s: expiresAt = updatesUntil = +365 days', (edition) => {
    const end = purchaseDateMs + 365 * DAY_MS;
    expect(computeTerms({ edition, purchaseDateMs })).toEqual({ updatesUntilMs: end, expiresAtMs: end });
    expect(computeTerms({ edition, purchaseDateMs, storeExpiresAtMs: null })).toEqual({ updatesUntilMs: end, expiresAtMs: end });
  });

  it('a store expiry shortens a yearly edition and never lengthens it', () => {
    const early = purchaseDateMs + 30 * DAY_MS;
    expect(computeTerms({ edition: 'student', purchaseDateMs, storeExpiresAtMs: early })).toEqual({ updatesUntilMs: early, expiresAtMs: early });
    const late = purchaseDateMs + 900 * DAY_MS;
    expect(computeTerms({ edition: 'student', purchaseDateMs, storeExpiresAtMs: late }).expiresAtMs).toBe(purchaseDateMs + 365 * DAY_MS);
  });
});

describe('channel seam', () => {
  const stable = { release: false, devChannel: false };

  it('allowStoreTestPurchases truth table', () => {
    expect(allowStoreTestPurchases({}, stable)).toBe(false);
    expect(allowStoreTestPurchases({ BURROW_LICENSE_STORE_TEST: '1' }, stable)).toBe(true);
    expect(allowStoreTestPurchases({ BURROW_LICENSE_STORE_TEST: 'true' }, stable)).toBe(false);
    expect(allowStoreTestPurchases({ BURROW_LICENSE_STORE_TEST: '1', BURROW_DESKTOP: '1' }, stable)).toBe(false);
    expect(allowStoreTestPurchases({ BURROW_LICENSE_STORE_TEST: '1' }, { release: true, devChannel: false })).toBe(false);
    expect(allowStoreTestPurchases({}, { release: false, devChannel: true })).toBe(true);
    expect(allowStoreTestPurchases({ BURROW_DESKTOP: '1' }, { release: true, devChannel: true })).toBe(true);
  });

  it('the defaults read the real environment: a source run, not a release', () => {
    expect(allowStoreTestPurchases({})).toBe(false);
    expect(allowStoreTestPurchases({ BURROW_LICENSE_STORE_TEST: '1' })).toBe(true);
  });

  describe('storeBaseUrl', () => {
    const log = vi.fn();
    const base = (id, url, opts = {}, env = {}) => storeBaseUrl(id, { BURROW_LICENSE_STORE_BASE_URL: url, ...env }, { release: false, log, ...opts });

    it('uses the real origins without an override', () => {
      expect(storeBaseUrl('gumroad', {}, { release: false })).toBe('https://api.gumroad.com');
      expect(storeBaseUrl('lemonsqueezy', {}, { release: false })).toBe('https://api.lemonsqueezy.com');
    });

    it.each([
      ['http://127.0.0.1:4555', 'http://127.0.0.1:4555'],
      ['http://localhost:4555/ignored/path', 'http://localhost:4555'],
      ['http://[::1]:4555', 'http://[::1]:4555'],
    ])('accepts the loopback http URL %s for both stores', (url, origin) => {
      expect(base('gumroad', url)).toBe(origin);
      expect(base('lemonsqueezy', url)).toBe(origin);
    });

    it.each([
      ['https on loopback', 'https://127.0.0.1:4555'],
      ['a LAN host', 'http://192.168.1.5:4555'],
      ['a public host', 'http://example.com'],
      ['credentials', 'http://user:pass@127.0.0.1:4555'],
      ['a username only', 'http://user@127.0.0.1:4555'],
      ['not a URL', 'not a url'],
      ['a lookalike host', 'http://127.0.0.1.example.com'],
    ])('ignores %s with one log line', (_name, url) => {
      log.mockClear();
      expect(base('gumroad', url)).toBe('https://api.gumroad.com');
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith('license: store base URL override ignored');
    });

    it('ignores the override in desktop mode and in release builds', () => {
      log.mockClear();
      expect(base('lemonsqueezy', 'http://127.0.0.1:4555', {}, { BURROW_DESKTOP: '1' })).toBe('https://api.lemonsqueezy.com');
      expect(base('lemonsqueezy', 'http://127.0.0.1:4555', { release: true })).toBe('https://api.lemonsqueezy.com');
      expect(log).toHaveBeenCalledTimes(2);
    });
  });
});

describe('error codes and copy (10.7)', () => {
  it('every code maps to the documented HTTP status', () => {
    expect(STORE_ERROR_STATUS).toEqual({
      invalid_request: 400,
      invalid_key_format: 400,
      activation_in_progress: 409,
      nothing_to_deactivate: 409,
      deactivate_unsupported: 409,
      license_key_needed: 409,
      key_not_found: 422,
      license_disabled: 422,
      license_expired_at_store: 422,
      license_expired: 422,
      purchase_refunded: 422,
      uses_exceeded: 422,
      activation_limit_reached: 422,
      unknown_product: 422,
      test_purchase_not_allowed: 422,
      key_mismatch: 422,
      rate_limited: 429,
      activation_write_failed: 500,
      store_error: 502,
      store_unreachable: 503,
      store_busy: 503,
      store_not_configured: 503,
    });
  });

  it('builds fixed copy with the store label and support contact', () => {
    const ctx = { store: 'Gumroad', support: 'help@example.com' };
    expect(storeErrorMessage('key_not_found', ctx)).toBe(
      "Gumroad doesn't recognize this key for Burrow Pro. Check that you copied the whole key from your Burrow Pro receipt and picked the store you bought from. If you downloaded the free version of Burrow, you don't need a key: Pro keys come from Burrow Pro.",
    );
    expect(storeErrorMessage('license_disabled', ctx)).toBe('This license key has been turned off by the seller. Email help@example.com to sort it out.');
    expect(storeErrorMessage('uses_exceeded', ctx)).toContain('Email help@example.com and ask them to reset your activations');
    expect(storeErrorMessage('store_busy', ctx)).toBe('Gumroad is busy right now. Wait a minute, then try again.');
    expect(storeErrorMessage('invalid_key_format', ctx)).toBe(
      "That doesn't look like a Gumroad license key. Check that you picked the store you bought from, then paste the key from your receipt.",
    );
    expect(storeErrorMessage('invalid_key_format')).toBe(
      "That doesn't look like a license key. Copy the key from your purchase email or receipt and paste it here.",
    );
    expect(storeErrorMessage('store_unreachable', { store: 'Lemon Squeezy', op: 'deactivate' })).toBe(
      "Burrow couldn't reach Lemon Squeezy, so your license is still active here. Check your internet connection, then try again.",
    );
    expect(storeErrorMessage('store_unreachable', ctx)).toBe(
      "Burrow couldn't reach Gumroad. Check your internet connection, then click Activate again. Nothing was changed on this computer.",
    );
  });

  it('falls back to the seller wording while the contact is a placeholder', () => {
    for (const contact of [null, undefined, '', '   ']) {
      expect(supportText(contact)).toBe('the seller (the contact address is on your receipt)');
    }
    expect(storeErrorMessage('purchase_refunded', { store: 'Gumroad', support: null })).toContain(
      'email the seller (the contact address is on your receipt).',
    );
  });

  it('has copy for every code, never an em dash, never an unfilled placeholder', () => {
    for (const code of Object.keys(STORE_ERROR_STATUS)) {
      const message = storeErrorMessage(code, { store: 'Lemon Squeezy', support: 'help@example.com' });
      expect(message.length).toBeGreaterThan(10);
      expect(message).not.toContain('—');
      expect(message).not.toMatch(/[{}]/);
    }
    expect(storeErrorMessage('made_up_code', { store: 'Gumroad' })).toContain("couldn't use");
  });
});
