// Fixed copy for Settings > License (docs/LICENSING.md sections 9.2, 10.7 and 12).
// The server message wins whenever it is present; these are the fallbacks.

import { GUMROAD, LEMON_SQUEEZY, getLicenseStore, storeLabel } from '../../constants/licenseStores';

export const PROMISE =
  'Burrow contacts your store only when you activate or move your license, and never otherwise.';

export const NO_STORE_COPY = "This version of Burrow can't activate licenses yet.";

export const SUPPORT_FALLBACK = 'the seller (the contact address is on your receipt)';

const SENDS = {
  [GUMROAD]: "your license key, Burrow's product id and a request to count one activation",
  [LEMON_SQUEEZY]: 'your license key and the name "Burrow" for this computer',
};

/** What Burrow sends, and to whom, for the store that is picked. Shown under the Activate button. */
export function disclosureFor(storeId) {
  const { label, host } = getLicenseStore(storeId) ?? getLicenseStore(GUMROAD);
  const extra = storeId === LEMON_SQUEEZY ? '' : ' Student and nonprofit keys may need a second check with Gumroad.';
  return `Burrow sends ${SENDS[storeId] ?? SENDS[GUMROAD]} to ${label} (${host}). ${label} also sees your IP address, like any website.${extra} ${PROMISE}`;
}

export const activateLabel = (storeId) => `Activate (contacts ${storeLabel(storeId)} once)`;

const GENERIC_ERROR = 'Something went wrong. Try again, or contact the seller.';

/** The server's vetted message when the error came from the API, else one generic line. */
export function errorMessageFor(e) {
  return e && (e.code || e.status) && e.message ? e.message : GENERIC_ERROR;
}
