// Synthetic store responses and keys for the licensing tests (docs/LICENSING.md 14, 20). Nothing here
// comes from a real store: ids, keys and emails are made up. No test ever calls a real store API.

export const GUMROAD_KEY = '00000000-11111111-22222222-33333333';
export const GUMROAD_KEY_2 = 'AAAAAAAA-BBBBBBBB-CCCCCCCC-DDDDDDDD';
export const LS_KEY = '00000000-1111-2222-3333-444444444444';
export const LS_KEY_2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
export const GUMROAD_PRODUCT_ID = 'prod_test_123';
export const GUMROAD_FREE_PRODUCT_ID = 'prod_free_456';
export const LS_STORE_ID = '12345';
export const LS_PRODUCT_ID = '67890';
export const LS_INSTANCE_ID = 'a1b2c3d4-0000-1111-2222-333344445555';
export const SALE = '2026-09-30T14:02:11Z';
export const LS_CREATED = '2026-09-30T14:02:11.000000Z';

/** A fetch Response stand-in: status, JSON body (or raw text) and headers. */
export function reply(status, body, { raw, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map(Object.entries(headers)),
    text: async () => raw ?? JSON.stringify(body),
  };
}

export function gumroadPurchase(overrides = {}) {
  return {
    product_id: GUMROAD_PRODUCT_ID,
    product_name: 'Burrow Pro',
    email: 'buyer@example.com',
    sale_timestamp: SALE,
    created_at: SALE,
    variants: '(Standard)',
    refunded: false,
    chargebacked: false,
    disputed: false,
    dispute_won: false,
    license_key: GUMROAD_KEY,
    ...overrides,
  };
}

/** @returns {object} a Gumroad verify success body */
export function gumroadVerify({ uses = 1, purchase = {} } = {}) {
  return { success: true, uses, purchase: gumroadPurchase(purchase) };
}

/** Gumroad's 404 for a key that belongs to a different product. */
export const WRONG_PRODUCT = { success: false, message: 'That license does not exist for the provided product.' };

/**
 * Queues the fetch answers for one activation. A purchase of the hidden free product first gets the
 * main product's wrong-product 404, as Gumroad does.
 */
export function queueGumroad(fetchMock, { uses = 1, purchase = {} } = {}) {
  if (purchase.product_id === GUMROAD_FREE_PRODUCT_ID) fetchMock.mockResolvedValueOnce(reply(404, WRONG_PRODUCT));
  fetchMock.mockResolvedValueOnce(reply(200, gumroadVerify({ uses, purchase })));
}

/** @returns {object} an LS activate success body; each nested section is merged over the default */
export function lsActivate({ license_key = {}, instance = {}, meta = {}, ...top } = {}) {
  return {
    activated: true,
    error: null,
    license_key: {
      id: 1,
      status: 'active',
      key: LS_KEY,
      activation_limit: 3,
      activation_usage: 1,
      created_at: LS_CREATED,
      expires_at: null,
      test_mode: false,
      ...license_key,
    },
    instance: { id: LS_INSTANCE_ID, name: 'Burrow', created_at: LS_CREATED, ...instance },
    meta: {
      store_id: Number(LS_STORE_ID),
      order_id: 1,
      product_id: Number(LS_PRODUCT_ID),
      product_name: 'Burrow Pro',
      variant_id: 1001,
      variant_name: 'Standard',
      customer_name: 'Test Buyer',
      customer_email: 'buyer@example.com',
      ...meta,
    },
    ...top,
  };
}

/** The config the tests inject: every owner placeholder filled with fake ids. */
export const TEST_STORE_CONFIG = Object.freeze({
  SUPPORT_CONTACT: 'support@example.com',
  GUMROAD: Object.freeze({
    productId: GUMROAD_PRODUCT_ID,
    variantEditions: Object.freeze({ Standard: 'standard', Founding: 'founding', Family: 'family' }),
    freeProductId: GUMROAD_FREE_PRODUCT_ID,
    freeVariantEditions: Object.freeze({ Student: 'student', Nonprofit: 'nonprofit' }),
    freeDefaultEdition: 'student',
  }),
  GUMROAD_MAX_USES: Object.freeze({ standard: 3, founding: 3, family: 10, student: 3, nonprofit: 3 }),
  LEMON_SQUEEZY: Object.freeze({
    storeId: LS_STORE_ID,
    productIds: Object.freeze([LS_PRODUCT_ID]),
    variantEditions: Object.freeze({ 1001: 'standard', 1002: 'founding', 1003: 'family', 1004: 'student', 1005: 'nonprofit' }),
  }),
});
