// Error codes, HTTP statuses and fixed copy for licensing errors (docs/LICENSING.md 10.7).
// Messages are built from these templates only: store text is never echoed.

export const STORE_ERROR_STATUS = Object.freeze({
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

const FALLBACK_SUPPORT = 'the seller (the contact address is on your receipt)';

/** @param {string | null | undefined} contact SUPPORT_CONTACT @returns {string} */
export const supportText = (contact) => (typeof contact === 'string' && contact.trim() !== '' ? contact.trim() : FALLBACK_SUPPORT);

const TEMPLATES = Object.freeze({
  invalid_request: () => "Burrow couldn't read that request. Reload the page and try again.",
  activation_in_progress: () => 'Burrow is already contacting the store. Wait for it to finish.',
  key_not_found: ({ store }) =>
    `${store} doesn't recognize this key for Burrow Pro. Check that you copied the whole key from your Burrow Pro receipt and picked the store you bought from. If you downloaded the free version of Burrow, you don't need a key: Pro keys come from Burrow Pro.`,
  license_disabled: ({ support }) => `This license key has been turned off by the seller. Email ${support} to sort it out.`,
  license_expired_at_store: ({ store, support }) =>
    `${store} says this license key has ended. If you think that's a mistake, email ${support}.`,
  license_expired: () =>
    "This license has already ended, so it can't turn Pro on. If you have a newer key, paste it here and click Activate.",
  purchase_refunded: ({ support }) =>
    `This purchase was refunded or disputed, so its key can't be activated. If you think that's a mistake, email ${support}.`,
  uses_exceeded: ({ support }) =>
    `This key has already been activated as many times as it allows. Email ${support} and ask them to reset your activations, then click Activate again.`,
  activation_limit_reached: ({ support }) =>
    `This key is already active on as many computers as it allows. On a computer you no longer use, open Settings > License and click Move to another computer, then try again here. If you can't reach that computer, email ${support}.`,
  unknown_product: ({ support }) => `This key isn't for Burrow Pro. Check your receipt for the Burrow key, or email ${support}.`,
  test_purchase_not_allowed: () =>
    'This is a test purchase key. Test keys only work in developer builds of Burrow. Use the key from your real purchase.',
  key_mismatch: () => "That key doesn't match the license on this computer. Paste the same key you activated with.",
  nothing_to_deactivate: () => "There's no license on this computer to move.",
  deactivate_unsupported: ({ support }) =>
    `Gumroad licenses can't be moved from inside Burrow. Click Remove from this computer, then email ${support} to reset your activations so you can activate on your new computer.`,
  license_key_needed: () =>
    'Burrow needs your license key to release this computer. Paste the key from your receipt, then click Move to another computer again.',
  rate_limited: () => 'Too many activation attempts. Wait 15 minutes, then try again.',
  activation_write_failed: () =>
    "Burrow couldn't save your license on this computer. Check that the data folder can be written to, then click Activate again.",
  store_error: ({ store, support }) =>
    `${store} sent an answer Burrow couldn't use. Try again in a few minutes. If it keeps happening, email ${support}.`,
  store_busy: ({ store }) => `${store} is busy right now. Wait a minute, then try again.`,
  store_not_configured: ({ store, support }) =>
    `This version of Burrow can't activate ${store} licenses yet. Update Burrow, or email ${support} for help.`,
});

/**
 * @param {string} code a key of STORE_ERROR_STATUS
 * @param {{ store?: string | null, support?: string | null, op?: 'activate' | 'deactivate' }} [ctx]
 *   `store` is the store label (absent for a generic invalid_key_format); `support` is SUPPORT_CONTACT
 * @returns {string}
 */
export function storeErrorMessage(code, { store = null, support = null, op = 'activate' } = {}) {
  const fill = { store: store ?? 'The store', support: supportText(support) };
  if (code === 'invalid_key_format') {
    return store
      ? `That doesn't look like a ${store} license key. Check that you picked the store you bought from, then paste the key from your receipt.`
      : "That doesn't look like a license key. Copy the key from your purchase email or receipt and paste it here.";
  }
  if (code === 'store_unreachable') {
    return op === 'deactivate'
      ? `Burrow couldn't reach ${fill.store}, so your license is still active here. Check your internet connection, then try again.`
      : `Burrow couldn't reach ${fill.store}. Check your internet connection, then click Activate again. Nothing was changed on this computer.`;
  }
  const template = TEMPLATES[code] ?? TEMPLATES.store_error;
  return template(fill);
}
