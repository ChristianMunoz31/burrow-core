// Lemon Squeezy adapter (docs/LICENSING.md 4.4): one POST to /v1/licenses/activate per activation and one
// to /v1/licenses/deactivate for "Move to another computer". /v1/licenses/validate is never called.
// Store message text is only matched internally and never logged or returned.
import { parseStoreDate } from '../terms.js';
import { StoreError, postForm } from './storeHttp.js';
import { cleanEmail, isPlainObject } from './shared.js';

const ID = 'lemonsqueezy';
const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANCE_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const ORIGIN = 'https://api.lemonsqueezy.com';

const normalizeKey = (raw) => String(raw).replace(/\s+/g, '').toLowerCase();

function classifyFailure({ status, body }) {
  if (status === 429) return 'store_busy';
  if (status >= 300 && status < 400) return 'store_error';
  if (!isPlainObject(body)) return 'store_error';
  const lk = isPlainObject(body.license_key) ? body.license_key : {};
  if (lk.status === 'disabled') return 'license_disabled';
  if (lk.status === 'expired') return 'license_expired_at_store';
  const limit = lk.activation_limit;
  const atLimit = Number.isSafeInteger(limit) && limit > 0 && Number.isSafeInteger(lk.activation_usage) && lk.activation_usage >= limit;
  if (atLimit || (typeof body.error === 'string' && /activation limit/i.test(body.error))) return 'activation_limit_reached';
  if (status === 404) return 'key_not_found';
  return 'store_error';
}

export const lemonSqueezy = Object.freeze({
  id: ID,
  label: 'Lemon Squeezy',
  hosts: Object.freeze(['api.lemonsqueezy.com']),
  canDeactivate: true,
  retainKey: true,
  keyPattern: KEY_RE,
  normalizeKey,
  matchesKey: (normalized) => typeof normalized === 'string' && KEY_RE.test(normalized),
  isConfigured: (storeConfig) => {
    const ls = storeConfig?.LEMON_SQUEEZY;
    return (
      typeof ls?.storeId === 'string' &&
      ls.storeId !== '' &&
      Array.isArray(ls.productIds) &&
      ls.productIds.length > 0 &&
      isPlainObject(ls.variantEditions) &&
      Object.keys(ls.variantEditions).length > 0
    );
  },

  /**
   * @param {{ key: string, fetchImpl?: Function, config: object, allowTest: boolean, baseUrl?: string }} opts
   *   `config` is the whole store config (`LEMON_SQUEEZY`, ...)
   * @returns {Promise<object>} ActivationResult
   * @throws {StoreError}
   */
  async activate({ key, fetchImpl, config, allowTest, baseUrl = ORIGIN }) {
    const ls = config.LEMON_SQUEEZY;
    const res = await postForm({
      url: `${baseUrl}/v1/licenses/activate`,
      form: { license_key: key, instance_name: 'Burrow' },
      fetchImpl,
    });
    const { body } = res;
    if (res.status === 429) throw new StoreError('store_busy');
    if (res.status >= 300 && res.status < 400) throw new StoreError('store_error');
    if (!isPlainObject(body)) throw new StoreError('store_error');
    if (body.activated !== true) throw new StoreError(classifyFailure(res));
    if (res.status < 200 || res.status >= 300) throw new StoreError('store_error');
    const { meta, license_key: lk, instance } = body;
    if (!isPlainObject(meta) || !isPlainObject(lk)) throw new StoreError('store_error');
    if (String(meta.store_id) !== ls.storeId) throw new StoreError('unknown_product');
    const productId = String(meta.product_id);
    const variantId = String(meta.variant_id);
    if (!ls.productIds.includes(productId) || !Object.hasOwn(ls.variantEditions, variantId)) throw new StoreError('unknown_product');
    if (lk.test_mode === true && !allowTest) throw new StoreError('test_purchase_not_allowed');
    if (!isPlainObject(instance) || typeof instance.id !== 'string' || !INSTANCE_ID_RE.test(instance.id)) throw new StoreError('store_error');
    const purchaseDateMs = parseStoreDate(lk.created_at);
    if (purchaseDateMs === null) throw new StoreError('store_error');
    const edition = ls.variantEditions[variantId];
    const storeExpiresAtMs = parseStoreDate(lk.expires_at);
    return {
      store: ID,
      productId,
      variantId,
      edition,
      purchaseDateMs,
      storeExpiresAtMs,
      email: cleanEmail(meta.customer_email),
      instanceId: instance.id,
      test: lk.test_mode === true,
      retainKey: true,
    };
  },

  /**
   * Releases this computer's activation. A 404 (already released elsewhere) counts as success.
   * @param {{ key: string, instanceId: string, fetchImpl?: Function, baseUrl?: string }} opts
   * @returns {Promise<void>}
   * @throws {StoreError}
   */
  async deactivate({ key, instanceId, fetchImpl, baseUrl = ORIGIN }) {
    const res = await postForm({
      url: `${baseUrl}/v1/licenses/deactivate`,
      form: { license_key: key, instance_id: instanceId },
      fetchImpl,
    });
    if (res.status === 429) throw new StoreError('store_busy');
    if (res.status === 404) return;
    if (res.status >= 200 && res.status < 300 && isPlainObject(res.body) && res.body.deactivated === true) return;
    throw new StoreError('store_error');
  },
});
