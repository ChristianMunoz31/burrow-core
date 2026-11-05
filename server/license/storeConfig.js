// Store configuration loader (docs/LICENSING.md sections 11 and 18). The owner edits ONE file,
// config/store.json, at the repo root; esbuild bakes it into the desktop sidecar and the release zip
// carries it. This module validates it strictly and exports the frozen config the adapters read.
// A placeholder (empty) or malformed value never throws: that store is simply "not configured", and
// one line names the offending field (never its value).
import storeJson from '../../config/store.json' with { type: 'json' };

const PRO_EDITIONS = Object.freeze(['standard', 'founding', 'family']);
const FREE_EDITIONS = Object.freeze(['student', 'nonprofit']);
const ALL_EDITIONS = Object.freeze([...PRO_EDITIONS, ...FREE_EDITIONS]);

const GUMROAD_ID_RE = /^[A-Za-z0-9_=-]{1,64}$/;
const DECIMAL_ID_RE = /^[0-9]{1,20}$/;
// eslint-disable-next-line no-control-regex
const VERSION_NAME_RE = /^[^(),\u0000-\u001f]{1,64}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const MAX_SUPPORT_CONTACT = 200;
const MAX_USES_CEILING = 1000;

const DEFAULT_PRO_VERSIONS = Object.freeze({ Standard: 'standard', Founding: 'founding', Family: 'family' });
const DEFAULT_FREE_VERSIONS = Object.freeze({ Student: 'student', Nonprofit: 'nonprofit' });
const DEFAULT_MAX_USES = Object.freeze({ standard: 3, founding: 3, family: 10, student: 3, nonprofit: 3 });

const MAX_PURCHASE_URL = 200;
// Reserved seam: Lemon Squeezy has no product page host pinned yet, so `lemonSqueezy.proPurchaseUrl` is
// read but always empty until the owner approves a host here. Gumroad is the launch store.
const PURCHASE_HOSTS = Object.freeze({ gumroad: 'gumroad.com', lemonSqueezy: null });

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

class ConfigProblem extends Error {}
const bad = (field) => {
  throw new ConfigProblem(field);
};

function supportContactOf(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return s !== '' && s.length <= MAX_SUPPORT_CONTACT && !CONTROL_RE.test(s) ? s : null;
}

/**
 * The public product page the in-app Buy button opens in the browser. An absolute https URL with no
 * credentials, query or fragment, on `host` or a subdomain of it; anything else is empty (button hidden).
 * @param {unknown} raw
 * @param {string | null} host
 * @returns {string | null}
 */
export function purchaseUrlOf(raw, host) {
  if (host === null || typeof raw !== 'string') return null;
  const s = raw.trim();
  if (s === '' || s.length > MAX_PURCHASE_URL || CONTROL_RE.test(s) || /\s/.test(s)) return null;
  let url;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
  if (url.search !== '' || url.hash !== '' || s.includes('?') || s.includes('#')) return null;
  if (url.port !== '') return null;
  const name = url.hostname.toLowerCase();
  if (name !== host && !name.endsWith(`.${host}`)) return null;
  return url.href;
}

/** A version-name to edition map: at least one entry, names plain, editions from `allowed`. */
function versionMap(raw, fallback, allowed, field) {
  if (raw === undefined) return fallback;
  if (!isObject(raw)) bad(field);
  const entries = Object.entries(raw);
  if (entries.length === 0) bad(field);
  const out = Object.create(null);
  for (const [name, edition] of entries) {
    if (name === '__proto__' || !VERSION_NAME_RE.test(name) || typeof edition !== 'string' || !allowed.includes(edition)) bad(`${field}.${name}`);
    out[name] = edition;
  }
  return Object.freeze(out);
}

function maxUsesOf(raw) {
  if (raw === undefined) return DEFAULT_MAX_USES;
  if (!isObject(raw)) bad('gumroad.maxUses');
  const out = { ...DEFAULT_MAX_USES };
  for (const [edition, n] of Object.entries(raw)) {
    if (!ALL_EDITIONS.includes(edition) || !Number.isSafeInteger(n) || n < 1 || n > MAX_USES_CEILING) bad(`gumroad.maxUses.${edition}`);
    out[edition] = n;
  }
  return Object.freeze(out);
}

const EMPTY_GUMROAD = Object.freeze({
  productId: null,
  variantEditions: DEFAULT_PRO_VERSIONS,
  freeProductId: null,
  freeVariantEditions: DEFAULT_FREE_VERSIONS,
  freeDefaultEdition: null,
});

function gumroadOf(raw) {
  if (raw === undefined || raw === null) return { gumroad: EMPTY_GUMROAD, maxUses: DEFAULT_MAX_USES };
  if (!isObject(raw)) bad('gumroad');
  if (isBlank(raw.proProductId)) return { gumroad: EMPTY_GUMROAD, maxUses: DEFAULT_MAX_USES };
  if (typeof raw.proProductId !== 'string' || !GUMROAD_ID_RE.test(raw.proProductId.trim())) bad('gumroad.proProductId');
  const productId = raw.proProductId.trim();
  const variantEditions = versionMap(raw.proVersions, DEFAULT_PRO_VERSIONS, PRO_EDITIONS, 'gumroad.proVersions');
  const maxUses = maxUsesOf(raw.maxUses);
  let freeProductId = null;
  let freeVariantEditions = DEFAULT_FREE_VERSIONS;
  let freeDefaultEdition = null;
  if (!isBlank(raw.freeLicenseProductId)) {
    const id = typeof raw.freeLicenseProductId === 'string' ? raw.freeLicenseProductId.trim() : '';
    if (!GUMROAD_ID_RE.test(id) || id === productId) bad('gumroad.freeLicenseProductId');
    freeVariantEditions = versionMap(raw.freeLicenseVersions, DEFAULT_FREE_VERSIONS, FREE_EDITIONS, 'gumroad.freeLicenseVersions');
    if (!isBlank(raw.freeLicenseDefaultEdition)) {
      if (typeof raw.freeLicenseDefaultEdition !== 'string' || !FREE_EDITIONS.includes(raw.freeLicenseDefaultEdition)) bad('gumroad.freeLicenseDefaultEdition');
      freeDefaultEdition = raw.freeLicenseDefaultEdition;
    }
    freeProductId = id;
  }
  return {
    gumroad: Object.freeze({ productId, variantEditions, freeProductId, freeVariantEditions, freeDefaultEdition }),
    maxUses,
  };
}

const decimalOf = (v) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? String(v) : typeof v === 'string' ? v.trim() : '');

const EMPTY_LEMON_SQUEEZY = Object.freeze({ storeId: null, productIds: Object.freeze([]), variantEditions: Object.freeze({}) });

function lemonSqueezyOf(raw) {
  if (raw === undefined || raw === null) return EMPTY_LEMON_SQUEEZY;
  if (!isObject(raw)) bad('lemonSqueezy');
  if (raw.productIds !== undefined && !Array.isArray(raw.productIds)) bad('lemonSqueezy.productIds');
  if (raw.variantEditions !== undefined && !isObject(raw.variantEditions)) bad('lemonSqueezy.variantEditions');
  const ids = raw.productIds ?? [];
  const variants = raw.variantEditions ?? {};
  if (isBlank(raw.storeId) && ids.length === 0 && Object.keys(variants).length === 0) return EMPTY_LEMON_SQUEEZY;
  const storeId = decimalOf(raw.storeId);
  if (!DECIMAL_ID_RE.test(storeId)) bad('lemonSqueezy.storeId');
  if (ids.length === 0) bad('lemonSqueezy.productIds');
  const productIds = ids.map((id) => {
    const s = decimalOf(id);
    if (!DECIMAL_ID_RE.test(s)) bad('lemonSqueezy.productIds');
    return s;
  });
  const entries = Object.entries(variants);
  if (entries.length === 0) bad('lemonSqueezy.variantEditions');
  const variantEditions = {};
  for (const [variantId, edition] of entries) {
    if (!DECIMAL_ID_RE.test(variantId) || typeof edition !== 'string' || !ALL_EDITIONS.includes(edition)) {
      bad('lemonSqueezy.variantEditions');
    }
    variantEditions[variantId] = edition;
  }
  return Object.freeze({
    storeId,
    productIds: Object.freeze([...new Set(productIds)]),
    variantEditions: Object.freeze(variantEditions),
  });
}

/**
 * Validates the owner file and builds the frozen config the adapters read. Never throws.
 * @param {unknown} raw the parsed JSON
 * @param {(message: string) => void} [log] gets one line per store whose values could not be read
 * @returns {{ SUPPORT_CONTACT: string | null, GUMROAD_PURCHASE_URL: string | null, LEMON_SQUEEZY_PURCHASE_URL: string | null, GUMROAD: object, GUMROAD_MAX_USES: object, LEMON_SQUEEZY: object }}
 */
export function buildStoreConfig(raw, log = () => {}) {
  const root = isObject(raw) ? raw : {};
  const attempt = (name, build, fallback) => {
    try {
      return build();
    } catch (err) {
      try {
        log(`license: config/store.json ${err instanceof ConfigProblem ? err.message : name} is not usable, so that store is off`);
      } catch {
        // logging must never fail startup
      }
      return fallback;
    }
  };
  const g = attempt('gumroad', () => gumroadOf(root.gumroad), { gumroad: EMPTY_GUMROAD, maxUses: DEFAULT_MAX_USES });
  return Object.freeze({
    SUPPORT_CONTACT: supportContactOf(root.supportContact),
    GUMROAD_PURCHASE_URL: purchaseUrlOf(isObject(root.gumroad) ? root.gumroad.proPurchaseUrl : null, PURCHASE_HOSTS.gumroad),
    LEMON_SQUEEZY_PURCHASE_URL: purchaseUrlOf(isObject(root.lemonSqueezy) ? root.lemonSqueezy.proPurchaseUrl : null, PURCHASE_HOSTS.lemonSqueezy),
    GUMROAD: g.gumroad,
    GUMROAD_MAX_USES: g.maxUses,
    LEMON_SQUEEZY: attempt('lemonSqueezy', () => lemonSqueezyOf(root.lemonSqueezy), EMPTY_LEMON_SQUEEZY),
  });
}

const loaded = buildStoreConfig(storeJson, (message) => console.warn(message));

/** The seller contact shown in error copy; null while empty. */
export const SUPPORT_CONTACT = loaded.SUPPORT_CONTACT;
/** Public Gumroad product page for the Buy button; null hides it. Never contacted by the server. */
export const GUMROAD_PURCHASE_URL = loaded.GUMROAD_PURCHASE_URL;
/** Reserved: always null until a Lemon Squeezy host is approved in PURCHASE_HOSTS. */
export const LEMON_SQUEEZY_PURCHASE_URL = loaded.LEMON_SQUEEZY_PURCHASE_URL;
export const GUMROAD = loaded.GUMROAD;
/** Maximum `uses` per edition, with slack for reinstalls (section 4.3). */
export const GUMROAD_MAX_USES = loaded.GUMROAD_MAX_USES;
export const LEMON_SQUEEZY = loaded.LEMON_SQUEEZY;
