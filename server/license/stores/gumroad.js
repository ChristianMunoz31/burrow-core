// Gumroad adapter (docs/LICENSING.md 4.3): one POST to /v2/licenses/verify per activation, plus a second
// one to the hidden student and nonprofit product only after a plain 404 key_not_found (which counts no use).
// Store message text is only matched internally and never logged or returned.
import { parseStoreDate } from '../terms.js';
import { StoreError, postForm } from './storeHttp.js';
import { cleanEmail, isPlainObject } from './shared.js';

const ID = 'gumroad';
const KEY_RE = /^[0-9A-F]{8}(-[0-9A-F]{8}){3}$/;
const ORIGIN = 'https://api.gumroad.com';

const normalizeKey = (raw) => String(raw).replace(/\s+/g, '').toUpperCase();

/**
 * Edition from a Gumroad purchase: the version name looked up in the map of the product that answered.
 * @param {object} purchase the `purchase` object of a verify response
 * @param {Record<string, string>} versions version name (as typed in Gumroad) to edition for that product
 * @returns {string | null} null when unresolved (no version, or an unknown one)
 */
export function resolveGumroadEdition(purchase, versions) {
  const variants = purchase?.variants;
  if (typeof variants !== 'string') return null;
  const inner = variants.replace(/^\(/, '').replace(/\)$/, '');
  if (inner.trim() === '') return null;
  for (const name of inner.split(',').map((s) => s.trim())) {
    if (Object.hasOwn(versions ?? {}, name)) return versions[name];
  }
  return null;
}

/** A plain 404 (not the "disabled" one): the key is not on this product, so the next product may know it. */
const isPlainNotFound = ({ status, body }) =>
  status === 404 && !(isPlainObject(body) && typeof body.message === 'string' && /disabled/i.test(body.message));

function classifyFailure({ status, body }) {
  if (status === 429) return 'store_busy';
  if (status === 404) {
    return isPlainObject(body) && body.success === false && typeof body.message === 'string' && /disabled/i.test(body.message)
      ? 'license_disabled'
      : 'key_not_found';
  }
  return 'store_error';
}

export const gumroad = Object.freeze({
  id: ID,
  label: 'Gumroad',
  hosts: Object.freeze(['api.gumroad.com']),
  canDeactivate: false,
  retainKey: false,
  keyPattern: KEY_RE,
  normalizeKey,
  matchesKey: (normalized) => typeof normalized === 'string' && KEY_RE.test(normalized),
  isConfigured: (storeConfig) => typeof storeConfig?.GUMROAD?.productId === 'string' && storeConfig.GUMROAD.productId !== '',

  /**
   * @param {{ key: string, fetchImpl?: Function, config: object, allowTest: boolean, baseUrl?: string }} opts
   *   `config` is the whole store config (`GUMROAD`, `GUMROAD_MAX_USES`, ...)
   * @returns {Promise<object>} ActivationResult
   * @throws {StoreError}
   */
  async activate({ key, fetchImpl, config, allowTest, baseUrl = ORIGIN }) {
    const g = config.GUMROAD;
    const verify = (productId) =>
      postForm({
        url: `${baseUrl}/v2/licenses/verify`,
        form: { product_id: productId, license_key: key, increment_uses_count: 'true' },
        fetchImpl,
      });
    // The main product first. Only a plain 404 key_not_found (which counts no use)
    // tries the hidden student and nonprofit product; every other answer stops here.
    let productId = g.productId;
    let versions = g.variantEditions;
    let defaultEdition = null;
    let res = await verify(productId);
    if (isPlainNotFound(res) && typeof g.freeProductId === 'string' && g.freeProductId !== '') {
      productId = g.freeProductId;
      versions = g.freeVariantEditions;
      defaultEdition = g.freeDefaultEdition ?? null;
      res = await verify(productId);
    }
    if (res.status < 200 || res.status >= 300) throw new StoreError(classifyFailure(res));
    const { body } = res;
    if (!isPlainObject(body) || body.success !== true) throw new StoreError('store_error');
    const purchase = body.purchase;
    if (!isPlainObject(purchase)) throw new StoreError('store_error');
    if (purchase.product_id !== productId) throw new StoreError('unknown_product');
    if (purchase.refunded === true || purchase.chargebacked === true || (purchase.disputed === true && purchase.dispute_won !== true)) {
      throw new StoreError('purchase_refunded');
    }
    if (purchase.test === true && !allowTest) throw new StoreError('test_purchase_not_allowed');
    // The free-license product may have no versions at all: an empty `variants` then means the default
    // edition. An unknown non-empty version never falls back (unknown_product), and the Pro product has no default.
    const noVersion = typeof purchase.variants !== 'string' || purchase.variants.replace(/^\(/, '').replace(/\)$/, '').trim() === '';
    const edition = resolveGumroadEdition(purchase, versions) ?? (noVersion ? defaultEdition : null);
    if (edition === null || !Object.hasOwn(config.GUMROAD_MAX_USES ?? {}, edition)) throw new StoreError('unknown_product');
    if (!Number.isSafeInteger(body.uses) || body.uses < 1) throw new StoreError('store_error');
    if (body.uses > config.GUMROAD_MAX_USES[edition]) throw new StoreError('uses_exceeded');
    const purchaseDateMs = parseStoreDate(purchase.sale_timestamp) ?? parseStoreDate(purchase.created_at);
    if (purchaseDateMs === null) throw new StoreError('store_error');
    return {
      store: ID,
      productId,
      variantId: null,
      edition,
      purchaseDateMs,
      storeExpiresAtMs: null,
      email: cleanEmail(purchase.email),
      instanceId: null,
      test: purchase.test === true,
      retainKey: false,
    };
  },
});
