# Burrow licensing (spec v2: store license keys)

Status: binding spec for branch `feat/store-licensing`. It replaces spec v1 (offline Ed25519 `.burrowlicense` files signed by a Cloudflare Worker). "MUST", "MUST NOT" and "SHOULD" have their usual meaning. Read [PRODUCT.md](PRODUCT.md) first.

Owner: Christian Munoz. Spec date: 2026-10-05.

Scope: activate a store license key, store the activation, compute entitlements, show it in Settings. Pro gating by capability (`requirePro`) comes from a parallel branch (section 15).

---

## 1. Owner decisions this spec implements

- **Sold on Gumroad first; Lemon Squeezy (LS) follows.** Both are Merchant of Record (checkout, tax, refunds). Gumroad launches first (2026-10-05); the LS adapter exists but its store setup follows after launch. Both sit behind one adapter interface (section 4).
- **One committed config file.** Every owner-specific store value lives in `config/store.json` (section 11 and 18).
- **The stores' own license keys are the license.** No Burrow-signed files. The Ed25519 signer and the `burrow-license-worker` Cloudflare Worker are retired (the Worker repo is kept for reference, marked deprecated).
- **Network: only on an explicit click.** Burrow contacts a store only when the user clicks Activate, or Move to another computer (LS only). The call is gated by the netPolicy feature `license` (section 4.2); the click itself turns that opt-in on. After activation Burrow is offline forever for licensing: no re-validation, no background call, zero calls at startup. Promise wording (used verbatim in the UI and docs): **"Burrow contacts your store only when you activate or move your license, and never otherwise."** The "Buy Burrow Pro" button (O4, section 12) does not break this promise: it is a plain link the desktop shell opens in the user's default browser. Burrow itself makes no network request for it.
- **Editions:**
  | edition | price | activations | updates until | expires |
  | --- | --- | --- | --- | --- |
  | `standard` | $49 | 3 | purchase + 365 days | never |
  | `founding` | $99, on sale through 2027-01-05 | 3 | purchase + 730 days | never |
  | `family` | about $79, up to 5 people | 10 | purchase + 365 days | never |
  | `student` | free (100% code) | 3 | = expires | purchase + 365 days |
  | `nonprofit` | free (100% code) | 3 | = expires | purchase + 365 days |
  Days are `DAY_MS` multiples, never calendar years. Renewal of a yearly edition is a new free purchase with a new key.
- **Founding perk:** the founder background and "Founding member" badge follow the stored edition `founding`, whatever the update window says.
- **The 14-day local trial is a reverse trial** (section 8): it starts by itself on first launch, with no click, card, account or network.
- **A lapsed license stops updates only.** Pro stays on in every version whose build date is on or before `updatesUntil` (section 6). Yearly expiry and the trial use the rollback-guarded clock (section 7).
- **North star (PRODUCT.md principle 0).** The app is fully usable with no license. Activation is one paste and one click. Every error says exactly what to do. Nothing about licensing appears in first-run onboarding (`OnboardingFlow.jsx` stays untouched).
- **Never lock users out of their data.** Only Pro features turn off, in any state.

## 2. Constants

| Name | Value |
| --- | --- |
| `ACTIVATION_FILE_NAME` | `license-activation.json` (data dir) |
| `ACTIVATION_STATE_KEY` | `license.activation` (`app_state`) |
| `ACTIVATION_HKDF_INFO` / `ACTIVATION_MAC_PREFIX` | `burrow-license-activation-v1` / `burrow-license-activation-v1\n` |
| `KEYHASH_HKDF_INFO` / `KEYHASH_PREFIX` | `burrow-license-keyhash-v1` / `burrow-license-keyhash-v1\n` |
| `LICENSE_KEY_SECRET_NAME` | `LICENSE_STORE_KEY` (`app_secrets` row, LS only) |
| `MAX_ACTIVATION_FILE_BYTES` | `2048` |
| `MAX_KEY_INPUT_CHARS` | `128` (before whitespace stripping) |
| `STORE_TIMEOUT_MS` / `STORE_MAX_BODY_BYTES` | `10000` / `65536` |
| `UPDATE_DAYS` | `{ standard: 365, founding: 730, family: 365, student: 365, nonprofit: 365 }` |
| `YEARLY_EDITIONS` | `student`, `nonprofit` |
| `RETIRED_LICENSE_FILE` / `RETIRED_LICENSE_BACKUP` | `license.burrowlicense` / `license.burrowlicense.retired.bak` |
| Kept from v1 | `CLOCK_*`, `ROLLBACK_TOLERANCE_MS` (48 h), `STARTUP_STEP_MS` (72 h), `CLOCK_WRITE_THROTTLE_MS` (10 min), `DAY_MS`, `TRIAL_*`, `BUILD_INFO_FILE`, `MIN_DATE_MS` / `MAX_DATE_MS`, `EDITIONS`, `parseLicenseDate`, `formatLicenseDate`, `inDateRange` |
| Removed | `FORMAT_VERSION`, `SIGN_PREFIX`, `MAX_LICENSE_BYTES`, `LICENSE_FILE_NAME` (kept only as `RETIRED_LICENSE_FILE`), `DEV_KEYS_FILE` |

Dates in the record and the API are `YYYY-MM-DDTHH:MM:SSZ` (second precision, `parseLicenseDate` rules).

---

## 3. Keys and store detection

| store id | label | key format (after normalization) | normalization | hosts |
| --- | --- | --- | --- | --- |
| `gumroad` | Gumroad | `^[0-9A-F]{8}(-[0-9A-F]{8}){3}$` (35 chars) | strip all whitespace, upper-case | `api.gumroad.com` |
| `lemonsqueezy` | Lemon Squeezy | `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` (36 chars) | strip all whitespace, lower-case | `api.lemonsqueezy.com` |

- The Gumroad format is shared by both Gumroad products (Burrow Pro and the hidden student and nonprofit product, section 4.3), so the key alone does not say which product issued it. Activation finds out by asking Gumroad (at most two requests).
- Input over `MAX_KEY_INPUT_CHARS` or not a string: `invalid_key_format`.
- **Detection:** `detectStore(normalizedCandidate)` returns the one store whose pattern matches (the two formats cannot both match), else `null`. Each adapter normalizes with its own rule before matching.
- **Explicit store (UI picker) wins.** If the request names a store and the key does not match that store's format: `invalid_key_format` (store-specific copy). If no store is named and nothing matches: `invalid_key_format` (generic copy).
- The UI mirrors both patterns in `src/constants/licenseStores.js`; a test imports both sides and asserts they are equal.

---

## 4. Activation

### 4.1 Common flow (`activateLicense` in `server/license/index.js`)

Steps run in this order. Nothing reaches the network before step 6.

1. One activation or deactivation at a time per process: a second call while one runs gets `409 activation_in_progress`.
2. Validate input, normalize the key, pick the adapter (section 3).
3. Adapter not configured (that store's values in `config/store.json` are still empty, loaded by `server/license/storeConfig.js`): `503 store_not_configured`.
4. MAC key unavailable (`secrets.key` cannot be loaded): `500 activation_write_failed`. This is checked before the network so a store use is never spent on an activation Burrow cannot save.
5. **Same key, no call:** if the stored activation is valid (MAC ok), has the same `store`, and its `keyHash` equals `keyHash(store, normalizedKey)`, return the current status. No network call, no use counted.
6. `await setNetworkFeature('license', true)` then `await assertNetworkEnabled('license')`. A storage failure here is `500 activation_write_failed`.
7. `adapter.activate(...)` (4.3, 4.4). It returns an `ActivationResult` or throws `StoreError(code)`.
8. Terms (4.5). A yearly edition whose `expiresAt <= clock.effective` is refused: `422 license_expired` (nothing stored).
9. Persist (section 5): record to both copies; for LS also the key secret. `activatedAt` is `min(clock.effective, clock.hwm + 48 h)`. Then replace the in-memory activation, run an in-session clock observation (the new `purchaseDate` becomes `L`), return the status.

A failure at any step stores nothing and keeps any previous activation. A successful activation of a different key replaces the previous one (no call is made to release the old one; the UI says so).

### 4.2 netPolicy feature `license`

Appended last to `NETWORK_FEATURES`:

```js
{ id: 'license', label: 'License activation',
  description: 'Contacts Gumroad or Lemon Squeezy only when you click Activate or Move to another computer in Settings > License. Your license key goes to the store you bought from. Clicking one of those buttons turns this on.',
  hosts: ['api.gumroad.com', 'api.lemonsqueezy.com'] }
```

- Only `activateLicense` and `deactivateLicense` call `setNetworkFeature('license', true)`. Nothing else in the codebase may call it, and no code path calls a store from startup, a timer, a status read or `getEntitlements()`.
- `server/__tests__/noNetworkOnStartup.test.js` is extended: startup with a stored activation and with `BURROW_NETWORK_OPTIN=license` makes zero outbound connections, and `GET /api/license` makes none either.
- `networkService.js` id union and every test that enumerates features (count becomes 7) are updated.

### 4.3 Gumroad adapter (`stores/gumroad.js`)

**Owner setup decision: two Gumroad products.**

- **"Burrow Pro"** (`gumroad.proProductId`), with versions `Standard`, `Founding`, `Family` sharing one license key setup. Gumroad requires `product_id`, so Burrow verifies by it. Separate products per paid edition were rejected: Burrow would have to try each product id in turn.
- **A hidden "Students & Nonprofits" product** (`gumroad.freeLicenseProductId`), with no versions (default edition `student`, see Edition resolution), sold only with single-use 100% codes. Its keys are valid yearly from purchase. The old offer-code prefix mapping (`STUDENT-...`, `NONPROFIT-...`, `FOUNDER-...`) is removed: the product, not the code name, decides the edition.

**Request order.** Activation tries the Burrow Pro product first. Only when Gumroad answers **404** for that product does it try the free-license product (and only if `freeLicenseProductId` is set). So a paid key costs one request and a student or nonprofit key may cost two; at most two requests per click. A 404 does not count a use, so the first request of a student key spends nothing. Any other failure on the first request (429, 5xx, timeout, refunded, unknown product, and so on) is final: no second request.

Each request:

```
POST https://api.gumroad.com/v2/licenses/verify
Content-Type: application/x-www-form-urlencoded
product_id=<product id tried>&license_key=<normalized key>&increment_uses_count=true
```

Classification of one request (first match wins):

| response | result |
| --- | --- |
| timeout / network error | `store_unreachable` |
| HTTP 429 | `store_busy` |
| HTTP 404, `success:false`, message matches `/disabled/i` | `license_disabled` |
| HTTP 404 otherwise | `key_not_found` (on the Pro product, with a free-license product configured: try that product instead) |
| any other non-2xx, 3xx, body not a JSON object, `success !== true` | `store_error` |
| no `purchase` object (for example `imported_customer`) | `store_error` |
| `purchase.product_id` not the product id tried | `unknown_product` |
| `refunded === true` or `chargebacked === true` or (`disputed === true` and `dispute_won !== true`) | `purchase_refunded` |
| `test === true` and not `allowStoreTestPurchases()` | `test_purchase_not_allowed` |
| edition unresolved (below) | `unknown_product` |
| `uses` not a safe integer >= 1 | `store_error` |
| `uses > gumroad.maxUses[edition]` | `uses_exceeded` |
| purchase date unparseable (4.5) | `store_error` |
| otherwise | `ActivationResult` |

If the free-license product also answers 404, the 404 rows apply to that answer. Store message text is only matched internally (the `/disabled/i` test) and never logged or returned.

**Edition resolution** (pure, `resolveGumroadEdition`): the version name decides. `purchase.variants` is a string such as `"(Founding)"` or `"(Founding, Blue)"`. Strip one leading `(` and trailing `)`, split on `,`, trim; the first name found in the map for the product that answered wins (exact, case-sensitive): `gumroad.proVersions` (`Standard`, `Founding`, `Family`) for the Pro product, `gumroad.freeLicenseVersions` (`Student`, `Nonprofit`) for the free-license product. Empty, absent or unknown versions are unresolved (`unknown_product`), with one exception: the free-license product as configured has no versions (buyers fill a required custom field, "School or nonprofit name"), so an empty `variants` there resolves to `gumroad.freeLicenseDefaultEdition` (`student`, yearly from purchase). A non-empty unknown version on that product stays `unknown_product`, and the Pro product never uses a default. Offer codes are not read.

The free "Burrow" product (`cPgrMauJJZfyTfGRMgRdcQ==`) has no license keys. It is not mapped to any edition and is never requested: there is no third request. A key that neither product knows gets the `key_not_found` copy, which tells the buyer that free downloads need no key.

Fields used: `purchase.product_id`, `sale_timestamp` (fallback `created_at`), `email`, `variants`, `refunded`, `chargebacked`, `disputed`, `dispute_won`, `test`, `uses`. `test` is absent for real purchases; only `=== true` counts.

**Uses.** `uses` is the count after this request's increment. Every successful verify counts one use, including a request that Burrow then refuses (refunded, test, unknown product, expired, over the limit) and a request whose answer was lost to a timeout. The limits (`gumroad.maxUses`: standard 3, founding 3, family 10, student 3, nonprofit 3) carry slack for reinstalls for that reason; Family is one key for up to 5 people and the 10 activations are that slack. Gumroad has no in-app way to lower the count: decrementing or resetting needs the seller's OAuth token, which MUST NEVER ship in the app. The seller resets uses in the Gumroad dashboard (Sales, open the sale, License key, Uses).

`ActivationResult` for Gumroad: `productId` = the product id that answered, `variantId = null`, `instanceId = null`, `retainKey = false`.

### 4.4 Lemon Squeezy adapter (`stores/lemonSqueezy.js`)

One request:

```
POST https://api.lemonsqueezy.com/v1/licenses/activate
Accept: application/json; Content-Type: application/x-www-form-urlencoded
license_key=<normalized key>&instance_name=Burrow
```

`instance_name` is always the fixed string `Burrow`: never a hostname, user name or anything machine-identifying.

| response | result |
| --- | --- |
| timeout / network error | `store_unreachable` |
| HTTP 429 | `store_busy` |
| `activated !== true` and `license_key.status === 'disabled'` | `license_disabled` |
| `activated !== true` and `license_key.status === 'expired'` | `license_expired_at_store` |
| `activated !== true` and (`license_key.activation_limit` is a positive integer and `activation_usage >= activation_limit`, or `error` matches `/activation limit/i`) | `activation_limit_reached` |
| `activated !== true` and HTTP 404 | `key_not_found` |
| any other failure, 3xx, non-JSON body | `store_error` |
| `String(meta.store_id) !== lemonSqueezy.storeId` | `unknown_product` |
| `String(meta.product_id)` not in `lemonSqueezy.productIds`, or `String(meta.variant_id)` not in `lemonSqueezy.variantEditions` | `unknown_product` |
| `license_key.test_mode === true` and not `allowStoreTestPurchases()` | `test_purchase_not_allowed` |
| `instance.id` not a string of 1 to 64 chars `[A-Za-z0-9-]` | `store_error` |
| `license_key.created_at` unparseable (4.5) | `store_error` |
| otherwise | `ActivationResult` |

- Edition = `lemonSqueezy.variantEditions[String(meta.variant_id)]`. LS discount codes are not visible in the License API, so student and nonprofit MUST be their own variants (section 17).
- `purchaseDate` = `license_key.created_at` (the License API has no order date; the key is created with the order). Open decision O1.
- `storeExpiresAt` = `license_key.expires_at` when it parses, else `null`.
- `email` = `meta.customer_email`. `instanceId` = `instance.id`. `productId = String(meta.product_id)`, `variantId = String(meta.variant_id)`. `retainKey = true`.
- LS enforces the activation limit itself. If Burrow refuses a key after LS accepted it (unknown product, test key, already ended), that LS activation stays used. Burrow does not send a second request to undo it, so the click stays one request; this is accepted and documented (O3).
- `/v1/licenses/validate` is never called.

**Deactivate** (`adapter.deactivate({ key, instanceId, fetchImpl, baseUrl })`), only from "Move to another computer":

```
POST https://api.lemonsqueezy.com/v1/licenses/deactivate
license_key=<key>&instance_id=<instanceId>
```

| response | result |
| --- | --- |
| `deactivated === true` | success |
| HTTP 404 (key or instance unknown: already released elsewhere) | success (nothing is held at LS) |
| timeout / network | `store_unreachable` |
| HTTP 429 | `store_busy` |
| anything else | `store_error` |

### 4.5 Dates and terms (`terms.js`, pure)

- `parseStoreDate(value)`: accepts `YYYY-MM-DDTHH:MM:SS` + optional fraction (1 to 9 digits) + `Z` or `+HH:MM`/`-HH:MM`; floors to the whole second; MUST pass `inDateRange`. Else `null`. Gumroad `2026-09-30T14:02:11Z` and LS `2021-01-24T14:15:07.000000Z` both parse.
- `computeTerms({ edition, purchaseDateMs, storeExpiresAtMs })`:
  - paid editions: `updatesUntil = purchase + UPDATE_DAYS[edition] * DAY_MS`, `expiresAt = null` (a store expiry on a paid edition is ignored; Burrow never re-checks anyway).
  - yearly editions: `expiresAt = min(purchase + 365 * DAY_MS, storeExpiresAtMs ?? Infinity)`, `updatesUntil = expiresAt`.

### 4.6 HTTP helper (`storeHttp.js`)

`postForm({ url, form, fetchImpl, timeoutMs = STORE_TIMEOUT_MS }) -> Promise<{ status: number, body: object | null }>`; throws `StoreError('store_unreachable')` on timeout or network failure.

- `node-fetch` default import (as `updateCheck.js`), injectable `fetchImpl`. Body `URLSearchParams`. Headers `Accept: application/json`, `Content-Type: application/x-www-form-urlencoded`, `User-Agent: Burrow`. `redirect: 'manual'`, `size: STORE_MAX_BODY_BYTES`, `signal: AbortSignal.timeout(timeoutMs)`.
- Body read capped (content-length check, then text length), parsed as a JSON object or `null`.
- **Never log** the key, the request body, the response body or the store message. Allowed log lines: `license: activation failed (<code>)` and `license: deactivation failed (<code>)`.

### 4.7 Base URLs, test purchases and the dev channel (`channelSeam.js`)

```js
export function isReleaseBuild() // typeof __BURROW_RELEASE_BUILD__ === 'boolean' && __BURROW_RELEASE_BUILD__
export function isSourceCheckout() // a `.git` entry (file or folder) at the repo root; no env var counts (tests inject `checkout: true`)
export function allowStoreTestPurchases(env = process.env, { release = isReleaseBuild(), devChannel = isDevChannel(env), checkout = isSourceCheckout() } = {})
// -> devChannel || (env.BURROW_LICENSE_STORE_TEST === '1' && !isDesktopMode(env) && !release && checkout)
export function rejectsTestRecords(env = process.env, opts) // (isDesktopMode(env) || release) && !devChannel
export function storeBaseUrl(storeId, env = process.env, { release = isReleaseBuild(), checkout = isSourceCheckout() } = {})
// -> 'https://api.gumroad.com' | 'https://api.lemonsqueezy.com', or the override below
```

- **Test purchases** (Gumroad `test: true`, LS `test_mode: true`) are accepted only when `allowStoreTestPurchases()` is true; the record then has `test: true` (also for any record minted while the base URL override was active, whatever the store said), the status adds the advisory reason `test_purchase` and the UI shows a "Test purchase" badge.
- **Dev channel hook.** `devChannel` defaults to `isDevChannel(env)` from `server/channel.js` (Burrow Dev, `getChannel()`). Burrow Dev accepts store TEST purchases (Gumroad `test: true`, Lemon Squeezy `test_mode`); stable builds do not. Dev builds accept no license keys of their own. A `test: true` record never gives Pro in a desktop or release build that is not the Dev channel (`rejectsTestRecords`, state `free`, reason `test_purchase`), so a record minted from a checkout cannot unlock the stable desktop app.
- **Mock base URL** (screenshots, manual testing, RTL against a fake): `BURROW_LICENSE_STORE_BASE_URL` replaces the origin of both stores (paths unchanged: `/v2/licenses/verify`, `/v1/licenses/activate`, `/v1/licenses/deactivate`) only when all hold: it parses as a URL, protocol `http:`, hostname `127.0.0.1`, `localhost` or `[::1]`, no username or password, `!isDesktopMode(env)`, `!isReleaseBuild()`, and a source checkout (`isSourceCheckout()`: a `.git` entry at the repo root, nothing else, not even `VITEST`; the release zip is a `git archive` without `.git`, so `npm start` from it fails closed). `BURROW_LICENSE_STORE_TEST` needs the same checkout. Otherwise it is ignored with one log line `license: store base URL override ignored`. netPolicy still applies with an override. `scripts/sandbox.js` passes `BURROW_LICENSE_STORE_BASE_URL` and `BURROW_LICENSE_STORE_TEST` through to the child only when set (the sandbox is a source checkout, never a desktop or release build).
- `__BURROW_RELEASE_BUILD__` stays defined `true` by `scripts/desktop/workerBundle.js` (its only consumer becomes `channelSeam.js`).

---

## 5. The stored activation

### 5.1 Record

```json
{"v":1,"state":"active","store":"gumroad","productId":"...","variantId":null,"edition":"standard",
 "purchaseDate":"2026-09-30T14:02:11Z","updatesUntil":"2027-09-30T14:02:11Z","expiresAt":null,
 "activatedAt":"2026-10-05T12:00:00Z","keyHash":"<43>","keyLast4":"ABCD","email":"buyer@example.com",
 "instanceId":null,"test":false,"mac":"<43>"}
```

| field | rule |
| --- | --- |
| `v` | `1` |
| `state` | `'active'` |
| `store` | `'gumroad'` or `'lemonsqueezy'` |
| `productId` | string, 1 to 64 chars |
| `variantId` | string (LS, 1 to 64 chars) or `null` (Gumroad) |
| `edition` | `standard`, `founding`, `family`, `student`, `nonprofit` |
| `purchaseDate`, `updatesUntil`, `activatedAt` | license dates; `updatesUntil >= purchaseDate` |
| `expiresAt` | license date `> purchaseDate` for yearly editions, `null` for paid editions |
| `keyHash` | `^[A-Za-z0-9_-]{43}$` |
| `keyLast4` | last 4 chars of the normalized key, `^[0-9A-Za-z]{4}$` |
| `email` | string 3 to 254 chars without control characters, or `null` (an unusable store email is stored as `null`) |
| `instanceId` | LS: string per 4.4; Gumroad: `null` |
| `test` | boolean |
| `mac` | `^[A-Za-z0-9_-]{43}$` |

**Tombstone** (written by deactivate and by remove): `{"v":1,"state":"cleared","clearedAt":"<date>","mac":"<43>"}`.

Exact key sets (`Object.keys` length plus `Object.hasOwn`, never `in`) for both shapes; any extra, missing or mistyped field makes the copy invalid. File copy over `MAX_ACTIVATION_FILE_BYTES` is invalid.

### 5.2 MAC and key hash

- `ikm` = `loadOrCreateKeyFile({ dir: dataDir }).key` (`secrets.key`), as the clock and trial records.
- `activationKey = hkdfSync('sha256', ikm, Buffer.alloc(0), 'burrow-license-activation-v1', 32)`.
- `mac = base64url(HMAC-SHA256(activationKey, UTF-8(ACTIVATION_MAC_PREFIX + JSON.stringify(fields))))` where `fields` is the array of every other member in the fixed order of the 5.1 table (`[v, state, store, productId, variantId, edition, purchaseDate, updatesUntil, expiresAt, activatedAt, keyHash, keyLast4, email, instanceId, test]`, tombstone `[v, state, clearedAt]`). The MAC covers the whole record, so any edit fails. Compare with `timingSafeEqual`.
- `keyHashKey = hkdfSync('sha256', ikm, Buffer.alloc(0), 'burrow-license-keyhash-v1', 32)`; `keyHash = base64url(HMAC-SHA256(keyHashKey, UTF-8(KEYHASH_PREFIX + store + '\n' + normalizedKey)))`. Never plain SHA-256: a keyed hash cannot be matched against a list of leaked keys and is useless off this machine.
- Because both keys derive from `secrets.key`, a record copied from another machine, or kept after `secrets.key` is replaced, fails verification.

### 5.3 Two copies (`activationStore.js`, same pattern as `trialStore.js`)

- Copy 1: `<dataDir>/license-activation.json`, `mkdir` 0700, `atomicWriteFile` (temp `wx` 0600, rename). Copy 2: `app_state` row `license.activation` via `upsert`. No migration.
- `createActivationStore({ dataDir, getDb, loadKey, now, log }) -> { load(), save(record fields), clear(clearedAtMs), keyHash(store, key), hasKey() }`.
- `load()` never throws and returns `{ kind: 'none' } | { kind: 'active', record } | { kind: 'invalid', reason: 'tampered' | 'no_key' }`:

| situation | result |
| --- | --- |
| both copies absent | `none` |
| no MAC key and any copy present | `invalid` / `no_key` |
| present copies, none valid | `invalid` / `tampered`; log `license: activation record ignored (invalid)` (no values) |
| one valid, the other missing or invalid | the valid one; repair the other (log the line above if one was invalid) |
| both valid and equal | that one |
| both valid and different | the copy with the **later timestamp** wins (`activatedAt`, or `clearedAt` for a tombstone); on a tie the DB copy wins; repair the other |
| winner is a tombstone | `none` |

Why "later wins" with tombstones: activations only move forward through the app. Putting back an old file copy after "Move to another computer" (the seat was released at LS) loses to the newer tombstone in the DB row. Deleting both copies and restoring an old file is not stopped (deterrence, section 16).

- `save` writes both copies; it succeeds if at least one copy was written, else `activation_write_failed`. `clear` writes the tombstone to both copies (the effective time, floored to the second, and never earlier than the replaced activation's `activatedAt` plus 1 s).

### 5.4 LS key secret

LS needs the full key later to deactivate. Gumroad keys are never kept.

- After a successful LS activation: `encryptSecret(normalizedKey, 'LICENSE_STORE_KEY', key)` with `key` from `resolveEncryptionKey(process.env, { dir: dataDir })`, written with `createSqliteSecretsStore().upsert({ name: 'LICENSE_STORE_KEY', ciphertext, iv, auth_tag, last4: keyLast4, updated_at })`. A secret write failure does not fail the activation (deactivate then asks for the key, 9.4).
- `LICENSE_STORE_KEY` is **not** added to `SECRET_DEFS`: `/api/secrets` can never list, read, write or test it, and `getSecret` skips it. Read and delete go through `licenseKeySecret.js` (`saveLicenseKey`, `loadLicenseKey -> string | null`, `clearLicenseKey`).
- `app_secrets` is never exported, emptied in every backup snapshot, and carried from the live database across a restore, so it follows the same lifecycle as `license.activation`.
- Activating a Gumroad key, deactivating, and removing all clear the secret.

### 5.5 Import, export, restore

- `license.activation` joins `PROTECTED_APP_STATE_KEYS`: import never writes it, `PUT /api/state/license.activation` answers 403, and backup restore carries the live row (`RESTORE_CARRY_KEYS` already includes every protected key; `backupHardening.test.js` asserts it).
- **Import from the direct Burrow (Microsoft Store build, `userprofile` data location only):** the user-clicked copy (`server/backup/directImport.js`, docs/MICROSOFT_STORE.md) brings `license-activation.json`, `license-trial.json`, `license-clock.json`, `secrets.key` and the database (with the `license.*` rows) over unchanged and unread. It never calls `activateLicense`, makes no network request and leaves the source untouched, so the activation keeps its stored `instanceId` and the seat at the store is not used a second time. The records verify in the new folder only because `secrets.key` is copied with them (their MAC key); without it they would count as invalid or used, which is why the import refuses a source without `secrets.key`. The swap happens at the next start, replaces only an unused database of the new folder, and moves the replaced files to `import-aside/`.
- **Export:** `buildArchive.js` skips the `app_state` row `license.activation` (it holds the email and is useless on another machine). `license.clock` and `license.trial` keep being exported as today (harmless, MAC-bound).
- Javi never sees activation data; it MUST NOT be added to `buildSettingsContext`.

### 5.6 Migration from v1

At `initLicense`, if `<dataDir>/license.burrowlicense` exists, rename it to `license.burrowlicense.retired.bak` (replace an existing backup; keep the file mode), log `license: retired license file moved aside`, and continue as free. Never throws (a failed rename is logged the same way and ignored; the file is never read). v1 kept nothing in the database. No production v1 key was ever published, so no paying user is affected.

---

## 6. Update window vs build date (unchanged from v1)

```
pro-eligible by version  <=>  buildDate <= updatesUntil      (epoch ms, inclusive)
```

- `buildDate` is the commit time baked into the artifact (`dist/burrow-build-info.json`, written by `postbuild` via `scripts/license/writeBuildInfo.js`; precedence `BURROW_BUILD_DATE` env > `git log -1 --format=%ct` > now). `--check` exits 1 unless the file is valid with `source` `env` or `git`; `release.yml` runs it for the zip and for `src-tauri/resources/dist` in the desktop job. The file has no leading dot and is served statically (harmless). It also carries `channel` (`stable` or `dev`, from `BURROW_CHANNEL`; Dev builds need `BURROW_DISPLAY_VERSION`); the runtime never reads it, only `scripts/checks/channelMarker.js` does.
- The sidecar bundler (`scripts/desktop/workerBundle.js` `readBundledBuildDate`) reads the file at bundle time, fails the bundle when it is missing or invalid, and bakes the date in as the esbuild define `__BURROW_BUILD_DATE__`; `loadBuildInfo` prefers it (`source: 'bundled'`) over the file.
- `loadBuildInfo({ distDir })` reads it once; over 1 KiB, bad JSON or a bad date counts as missing. Missing build info: `buildDate := clock.effective`, reason `no_build_info`.
- Both sides are fixed before the user runs the app (`updatesUntil` is in the MAC'd record, `buildDate` ships in the artifact), so the clock cannot unlock a newer version, and a version built inside the window keeps Pro forever.
- Copy for `update_window_passed` (dates via `Intl.DateTimeFormat`, `timeZone: 'UTC'`): "This version (1.4.0) was released on 12 Nov 2027, after your updates ended on 5 Oct 2027. Pro is off in this version only; your data is untouched. Every Burrow version released on or before 5 Oct 2027 keeps Pro forever."
- In-app updates enforce the same rule on the server. A user whose Pro comes from a license (`proSource === 'license'`) is refused `409 update_license_window` by `POST /api/settings/updates/install` and `POST /api/settings/updates/manual` when the release was published after `updatesUntil` (the release date is the published date, which is on or after the build date, so the check can over-block but never under-block), or when a date or the license state cannot be read; Settings > Updates then shows the reason and offers no download. A release published on or before `updatesUntil` is allowed. The free core, the trial, a lapsed or expired license and no license are never blocked, and neither is the Microsoft Store edition (the Store updates itself). The free core always updates, and the GitHub release page stays reachable for everyone (a guard against losing Pro by accident, not DRM). This replaces the earlier warn-and-allow note on the update card (owner decision 2026-10-09).
- The Microsoft Store edition keeps this rule only for yearly licenses and the trial; perpetual licenses use the per-feature rule in 6.1 (decided 2026-10-08), because Store installs auto-update without any warning and a Store package cannot be downgraded.

### 6.1 Store builds: Pro per feature after the update window (decided 2026-10-08)

Owner rule: **"Standard buyers always have Pro, just not the version a year after purchase."** The Store build (`distribution === 'store'`, `server/distribution.js`) cannot be downgraded and updates itself, so a license whose window has ended would lose all of Pro by the build-date cutoff alone. Instead, a Store build gates by feature.

- **Registry.** `server/license/proFeatureDates.js` gives every id in `PRO_FEATURES` (`server/pro.js`) an `introducedAt`: the build date of the first released version that shipped the feature (the same unit as `buildDate` and `updatesUntil`, a `YYYY-MM-DDTHH:MM:SSZ` license date). Reserved or not-yet-shipped ids have `null`, which counts as newer than any window. `server/__tests__/proFeatureRegistry.test.js` fails when a feature gated by `requirePro`, `requireProWhen` or `assertPro` anywhere in `server/` has no date, so a new Pro feature cannot ship without its date. Current dates (source: git history; `v0.2.0` tag commit `a438b53`, 2026-10-05T18:10:21-04:00): `javi_tools`, `briefings`, `explain` = `2026-10-05T22:10:21Z`; `javi_characters` (Valet, Concierge and Majordomo; Butler is free) = `2026-10-15T00:00:00Z`, the date the feature was written, same precedent as the three folder ids. `javi_conversation` (follow-ups and conversations; Free until the "Free gets one insight per page" change) is new since v0.4.1 and first ships in 1.0.0, whose build date is not known yet, so it is dated at the merge of the main commit that introduced the gate, `7fc0bed` (2026-10-08T11:44:40-04:00) = `2026-10-08T15:44:40Z`. That is a conservative approximation of the 1.0.0 build date: a slightly earlier date can only help a buyer, and every real license has `updatesUntil` on or after 2027-10-05, so nobody is affected; it may be replaced with the 1.0.0 tag commit time after release (`docs/RELEASING.md`). Every other id is `null`. Because `javi_conversation` is dated after `javi_tools`, a license that includes conversations always includes tools, and the Javi panel keys its one-insight mode on `javi_conversation`.
- **Rule.** The license is perpetual (no `expiresAt`: Standard, Founding, Family and any record of those editions, whichever store issued it) and `buildDate > updatesUntil` (today's `update_window_passed`). Pro stays on for every feature with `introducedAt <= updatesUntil` (inclusive; same second-precision UTC comparison as `buildDate <= updatesUntil`). Features introduced after `updatesUntil`, and `null` ones, are locked.
- **What the evaluation returns.** The state stays `update_window_passed` and `pro` stays `false`, so anything that asks for plain Pro fails closed. `getEntitlements()` and `GET /api/license` add `proScope: 'features_until'` and `proFeatures: { included: string[], locked: string[] }` (all registry ids), and the status `message` is the fixed text "Your license's updates have ended. Every Pro feature released during your update period stays on for good. Pro features released later need a newer Burrow Pro license. Your data is untouched." These keys are absent in every other case, so direct builds and every other state keep their exact status body. `requirePro(feature)` and `assertPro(feature)` check the feature against `proFeatures.included`.
- **Locked feature.** `403 { error: 'pro_required', feature, reason: 'newer_license_required', message }` before any SSE header, with the fixed message "This feature came out after your license's updates ended. It is included in a newer Burrow Pro license." (`ProRequiredError.reason`, also in the Jarvis SSE `error` event and the scheduler's silent skip). Without the reason (free, trial ended, expired) the body is unchanged.
- **Unchanged.** Direct builds (the plain 9.1 rule). An active trial (full Pro, no scope); an ended trial (no Pro). Yearly Student and Nonprofit licenses: an active term is Pro, an expired one is `expired`, rollback gives `clock_issue`, as before (an expiry is not an update window). Free features, bug fixes, data, export, import and backups are never gated. Startup, status reads and `getEntitlements()` stay network-free.
- **Clock.** Perpetual editions compare dates only (`introducedAt`, `updatesUntil`, the baked-in build date). The wall clock never enters the decision, so rolling it back, or forward, unlocks nothing; the `clock_rollback` advisory still appears and the yearly and trial guards still apply.
- **Client.** `useEntitlements()` exposes `proScope` and `includedFeatures`; `isKnownFree(e, feature)` is per feature. `ProGateNotice` shows a distinct notice (the locked-feature text, which features the license still includes, a Settings > License link and the Buy button) instead of the plain Pro upsell. Settings > License shows the title "Updates ended: earlier Pro features kept", the pill "Some Pro features on", each shipped feature as included or needing a newer license, and the Buy button (`purchaseUrl`).
- **Example.** Standard bought 2026-09-30T14:02:11Z has `updatesUntil` 2027-09-30T14:02:11Z. A Store build dated 2027-12-01 is past the window. `javi_tools`, `briefings` and `explain` (introduced 2026-10-05) are included and keep working forever. A feature first released in a build dated 2027-10-15 is locked for this license, and one with `introducedAt` exactly 2027-09-30T14:02:11Z would be included. A Standard license bought on 2027-11-01 has `updatesUntil` 2028-11-01 and includes that feature.
- **Direct builds.** Not changed: the plain build-date rule of section 6 and 9.1 applies, and the status has no `proScope`.

---

## 7. Clock guard (unchanged algorithm; one input changed)

Storage, MAC, algorithm, evidence and failure modes are exactly as implemented in `server/license/clockGuard.js` (v1 sections 7.1 to 7.7), summarised here:

- Record `{"v":1,"hwm":<ms>,"mac":"<43>"}` in `<dataDir>/license-clock.json` and `app_state` `license.clock` (protected), MAC key `hkdf(secrets.key, 'burrow-license-clock-v1')`.
- Startup: `floor = maxN(S, B, L)`, `cap = (floor ?? now) + 72 h`, evidence `E` seeds only when no valid copy exists, `rollback = now < prior - 48 h`, `effective = max(now, prior)`, `H` moves at most 72 h past what is known per launch. In session: `H` advances by monotonic elapsed time only; writes throttled to 10 min.
- **Changed input:** `L` is the stored activation's `purchaseDate` (was the license file `issuedAt`), or `null` with no valid activation. The trial `startedAt` is still not an input.
- **Changed evidence:** the data dir mtime list replaces `license.burrowlicense` with `license-activation.json`.
- Only yearly editions and the trial consult the clock for their state. Perpetual editions only get the `clock_rollback` advisory.

Residual risks are unchanged (section 16).

---

## 8. Local trial (reverse trial)

Every data folder gets full Pro for 14 days (`TRIAL_DAYS` in `server/license/constants.js`; `TRIAL_MS` follows), started automatically on first launch, then drops to Free. There is no start button and no route to start it. No click, no card, no account, no network. A license activated at any time keeps Pro, because the license always wins. Data and export are never locked: only Pro actions stop.

**Auto-start.** `initLicense({ ..., autoStartTrial = true })` calls an internal `ensureTrialStarted(c)` right after the clock guard starts. When the trial record kind is `none`, it writes `startedAt = floor(clock.effective / 1000) * 1000` (the guarded clock, whole seconds) through `trialStore.start`, then reloads the record. It never throws. It runs whatever the license state is: one trial per data folder, used up on first launch. A licensed user never sees it, because the license wins and notices are suppressed. `getLicenseStatus()` calls `ensureTrialStarted(c)` again when the record is still `none` (a retry after a failed startup write); `getEntitlements()` does not (hot path). `autoStartTrial: false` is a test seam only: no env var, no setting.

**Record and legacy 7-day trials.** `{"v":1,"startedAt","endsAt","mac"}` in `license-trial.json` and `app_state` `license.trial` (protected), MAC key `hkdf(secrets.key, 'burrow-license-trial-v1')`. Earliest valid `startedAt` wins; a present but unverifiable record counts as used. The trial keeps its own floor (`trialEffective = max(clock.effective, startedAt)`, `trialRollback = clock.rollback || now < startedAt - 48 h`); under rollback an unexpired trial reads `clock_issue`. A `valid` or `used` record is never overwritten. Deleting both copies resets it (accepted).

`checkTrialRecord` accepts a record whose `endsAt` is `startedAt` + 14 days (`TRIAL_MS`, new records) or `startedAt` + 7 days (`LEGACY_TRIAL_MS`, records written before the 14-day change). The MAC covers `endsAt`, so the 7-day case cannot be forged. A legacy record keeps its own 7-day end and is never extended; an `endsAt` of any other duration is rejected as unverifiable (`used`). The reminder stays at 2 days left (`TRIAL_REMIND_DAYS_LEFT`). The client mirror `TRIAL_DAYS` lives in `src/constants/trial.js`; UI copy derives days from the status where it can instead of hardcoding them.

**Existing installs.** A data folder that already has a trial record (active, ended or unreadable) keeps it and gets no fresh trial. A folder with no trial record gets the reverse trial on the first launch of this version. A removed license never brings a fresh trial.

**Notices (`trialNotices.js`).** Three one-time, in-app notices: `welcome`, `ending_soon` and `ended`. The flags live in `app_state` `license.trialNotices` as `{ v: 1, startedAt, welcome, endingSoon, ended }` (`true` means shown and dismissed), on the server and not in the browser, because the desktop window's origin changes each launch. They are cosmetic: not MAC-protected, they never affect Pro. Reads and writes are best effort and never throw; the flags are also kept in memory, so a failed write still stops the notice for this process. After `ensureTrialStarted`, when the record is `valid` and the stored notices are missing or belong to another `startedAt`, they are reset: a trial auto-started in this init gets all flags false; a pre-existing trial gets `welcome: true`, `endingSoon: false` and `ended` set to whether it has already ended, so an older manual trial gets no welcome and an already ended one gets no "ended" notice.

`trial.notice` in the status (pure `trialNoticeFor` in `entitlements.js`):
- `null` when a license record is present (`license` not null, even one whose Pro lapsed: `update_window_passed`, `expired`), `proSource` is `license`, the combined state is `clock_issue`, the flags are missing or `startedAt` is null.
- `ending_soon` when the trial is active, 2 days or fewer are left (`TRIAL_REMIND_DAYS_LEFT`) and `endingSoon` is not set.
- `welcome` when the trial is active, more than 2 days are left and `welcome` is not set.
- `ended` when the trial has ended, there is no clock issue and `ended` is not set.
- Otherwise `null`. At most one notice at a time. `trial.remindToday` stays for compatibility.

`dismissTrialNotice(notice)` (`POST /api/license/trial/notice`, section 10.5) sets the flag for the current trial: `ending_soon` also sets `welcome`; `ended` sets all three. With no valid trial it does nothing. It makes no network call.

**Switching editions (Microsoft Store build with the `userprofile` data location).** That build keeps its data in `%USERPROFILE%\Burrow Data` (a folder that carries Burrow's `.burrow-data.json` ownership marker; an existing unmarked folder is never used), not in the `%APPDATA%\Burrow` of the direct edition, and never reads, writes or clears the trial, clock or activation records in `%APPDATA%\Burrow` (it only reads that folder when the user clicks the import). So moving from the direct edition to that Store build WITHOUT importing starts a new trial in the new folder (a new `secrets.key`, no records, so `ensureTrialStarted` writes a fresh 14-day trial) and shows no activation; this is the same as wiping the data folder, which is accepted above (deterrence, not DRM), and it opens no new way around the trial: the direct folder's trial is still used up there. Importing carries the trial record over unchanged (the same `startedAt`, so no reset) together with the activation; a copy of the files is useless without the matching `secrets.key`, and the import copies that too. With the default `appdata` data location the two editions share one folder and the records, as before. Tests: `server/__tests__/directImportLicense.test.js` and `directImport.test.js`.

**Erase and import.** **Erase all my data** never touches `license.trial`, `license.clock`, `license.trialNotices`, their files or `secrets.key` (their MAC key), even when the user also removes the license, so erasing cannot reset the trial or show a notice again; the activation is kept unless the user ticks "Also remove my license from this computer" (the same `removeLicense()` as the Remove button, no network, no store use spent). `license.trialNotices` is in `PROTECTED_APP_STATE_KEYS`: import, the state API and restore never write it.

---

## 9. Entitlements and states

### 9.1 `evaluateLicense({ activation, buildInfo, clock })` (pure, `entitlements.js`)

`activation` is the `activationStore.load()` result. First match wins:

1. `none`: **`free`** (reason `no_license`).
2. `invalid`: **`invalid`** (reason and `invalidReason` = `tampered` or `no_key`).
2a. A `test: true` record in a desktop or release build that is not the Dev channel (`rejectTestRecords`): **`free`** (reason `test_purchase`).
3. `expiresAt` set (yearly): `clock.rollback && clock.now < expiresAt` gives **`clock_issue`**; else `expiresAt <= clock.effective` gives **`expired`**.
4. `(buildInfo.buildDate ?? clock.effective) > updatesUntil`: **`update_window_passed`**. In a Store build with `expiresAt` null the result also carries `proScope: 'features_until'` and `proFeatures` (section 6.1); `pro` stays false.
5. Otherwise **`pro`**.

Advisories after the state's own code, deduplicated: `clock_rollback`, `no_build_info`, `test_purchase`. The `dev_key` advisory and the `trial` license state for a signed trial are gone (the local trial still yields combined state `trial`).

`combineEntitlements` (local trial overlay, `proSource`, `licenseState`) and `getEntitlements() -> { pro, edition, reasons }` keep their v1 behaviour and shape. `edition` is the stored edition whenever the record is valid (also when `expired` or `update_window_passed`), `'trial'` during an active local trial without license Pro, else `null`.

`perks.founderBackground = activation.kind === 'active' && record.edition === 'founding'`, whatever `pro` says.

### 9.2 State copy (`STATE_MESSAGES`)

| state | pro | message |
| --- | --- | --- |
| `free` | false | "You're using Burrow Free. Everything you need to track your money and journal is included. If you bought Burrow Pro, paste your license key below and click Activate." |
| `pro` | true | "Burrow Pro is active. Thank you for supporting Burrow." |
| `trial` | true | "Your Pro trial is active: {n} days left." |
| `update_window_passed` | false | "This version of Burrow was released after your updates ended, so Pro is off in this version. Your data is untouched, and every version released on or before your update date keeps Pro forever." |
| `expired` | false | "Your license has ended, so Pro features are off. Your data is safe and everything in Burrow Free keeps working. If you have a new license key, paste it below and click Activate." |
| `clock_issue` | false | "Your computer's clock seems to be set earlier than the last time Burrow ran, so Burrow can't confirm your license yet. Check that the date and time are correct. This clears on its own once the clock is right, and your data is safe." |
| `invalid` | false | "Burrow couldn't confirm the license saved on this computer, so Pro features are off. Your data is safe. Paste your license key below and click Activate to set it up again." |

No state blocks any route, page, export, import, backup or data read.

---

## 10. API

Routes in `server/licenseRoutes.js` (`registerLicenseRoutes(app)`), behind the auth and desktop gates, `no-store` (existing `/api/license` entry in the early no-store list plus the router). Plain JSON bodies (no `{ data }` wrapper, matching this repo's license, AI and network routes). Errors: `{ error: <code>, message }`, plus `detail` only where listed. Store error text is never echoed.

### 10.1 Status body (`GET /api/license` -> 200; also the success body of every other route)

```js
/** @typedef {{
 *   state: 'free'|'pro'|'trial'|'update_window_passed'|'expired'|'clock_issue'|'invalid',
 *   pro: boolean,
 *   edition: 'standard'|'founding'|'family'|'student'|'nonprofit'|'trial'|null,
 *   reasons: string[],
 *   message: string,
 *   invalidReason: 'tampered'|'no_key'|null,
 *   license: null | {                   // the stored activation view; null unless the record is valid
 *     store: 'gumroad'|'lemonsqueezy', storeLabel: 'Gumroad'|'Lemon Squeezy',
 *     edition: 'standard'|'founding'|'family'|'student'|'nonprofit',
 *     purchaseDate: string, updatesUntil: string, expiresAt: string|null, activatedAt: string,
 *     email: string|null, keyLast4: string, test: boolean,
 *     canDeactivate: boolean,           // store === 'lemonsqueezy'
 *   },
 *   trialDaysLeft: number|null,
 *   build: { date: string|null, source: 'bundled'|'env'|'git'|'clock'|'missing', version: string },
 *   clock: { rollbackDetected: boolean },
 *   licenseState: 'free'|'pro'|'update_window_passed'|'expired'|'clock_issue'|'invalid',
 *   proSource: 'license'|'local_trial'|null,
 *   proScope?: 'features_until',        // only a Store build's perpetual license past its update window (6.1); absent otherwise
 *   proFeatures?: { included: string[], locked: string[] }, // with proScope: registry ids the license still includes / does not
 *   trial: { state: 'available'|'active'|'ended', startedAt: string|null, endsAt: string|null,
 *            daysLeft: number|null, remindToday: boolean,
 *            notice: 'welcome'|'ending_soon'|'ended'|null },  // 'available' only means no record yet
 *   perks: { founderBackground: boolean },
 *   stores: Array<{ id: 'gumroad'|'lemonsqueezy', label: string, configured: boolean }>, // Gumroad first
 *   supportContact: string|null,        // config/store.json supportContact, null while empty
 *   purchaseUrl: string|null,           // config/store.json gumroad.proPurchaseUrl, null while empty or invalid (hides the Buy button)
 * }} LicenseStatus */
```

`keyHash`, `instanceId`, `productId`, `variantId`, `mac` and the key are never returned. The email is shown in full (the user's own data, local, `no-store`).

### 10.2 `POST /api/license/activate` -> 200 `LicenseStatus`

- Body `application/json` `{ licenseKey: string, store?: 'gumroad'|'lemonsqueezy' }`. Body not an object, `licenseKey` not a string, `store` present but not a known id, or a JSON parse error on this route: `400 invalid_request`.
- Rate limit: `licenseNetworkLimiter` (express-rate-limit, 10 per 15 min, shared with `/deactivate`, body `{ error: 'rate_limited', code: 'rate_limited', message }`), mounted in `server.js` with the other limiters.
- Flow: section 4.1. Already active with the same key: 200 with no network call.

### 10.3 `POST /api/license/deactivate` -> 200 `LicenseStatus` (LS only)

- Body optional `{ licenseKey?: string }`; same `invalid_request` rules. Same limiter and in-flight lock as activate.
- No valid activation: `409 nothing_to_deactivate`. Gumroad activation: `409 deactivate_unsupported`.
- Key: `loadLicenseKey()`; if `null`, use `licenseKey` from the body, which MUST hash to the stored `keyHash` (`422 key_mismatch`); if neither: `409 license_key_needed`.
- `setNetworkFeature('license', true)`, `assertNetworkEnabled('license')`, `adapter.deactivate`. On success: `clear()` (tombstone), `clearLicenseKey()`, return the status (free, or trial). If the store call succeeds but the local `clear()` fails, the in-memory activation is set to none, `license: deactivated at the store but the local record could not be cleared` is logged and the route answers `500 activation_write_failed`. On a store failure nothing changes locally.

### 10.4 `DELETE /api/license` -> 200 `LicenseStatus`

"Remove from this computer": no network, idempotent, takes the same in-flight lock (`409 activation_in_progress`). Writes the tombstone, clears the key secret, keeps the clock and trial records. If neither copy can be written: `500 activation_write_failed`.

### 10.5 `POST /api/license/trial/notice` -> 200 `LicenseStatus`

Body `application/json` `{ notice: 'welcome' | 'ending_soon' | 'ended' }`. Body not an object, `notice` not one of the three, or a JSON parse error on this route: `400 invalid_request`. No network. `no-store`. The old `POST /api/license/trial` (manual start) is removed and falls through to the `/api` 404, along with the `already_pro`, `trial_used` and `trial_write_failed` messages.

### 10.6 Removed

`POST /api/license` (file install) is removed and falls through to the `/api` 404. The `413 license_too_large` special case in the `server.js` error handler is removed.

### 10.7 Error codes and copy

`{store}` is the store label. `{support}` is `supportContact` from `config/store.json` or, while that is empty, "the seller (the contact address is on your receipt)". Messages are built in `server/license/messages.js` from fixed templates only.

| HTTP | `error` | message |
| --- | --- | --- |
| 400 | `invalid_request` | "Burrow couldn't read that request. Reload the page and try again." |
| 400 | `invalid_key_format` (store named) | "That doesn't look like a {store} license key. Check that you picked the store you bought from, then paste the key from your receipt." |
| 400 | `invalid_key_format` (no store) | "That doesn't look like a license key. Copy the key from your purchase email or receipt and paste it here." |
| 409 | `activation_in_progress` | "Burrow is already contacting the store. Wait for it to finish." |
| 422 | `key_not_found` | "{store} doesn't recognize this key for Burrow Pro. Check that you copied the whole key from your Burrow Pro receipt and picked the store you bought from. If you downloaded the free version of Burrow, you don't need a key: Pro keys come from Burrow Pro." |
| 422 | `license_disabled` | "This license key has been turned off by the seller. Email {support} to sort it out." |
| 422 | `license_expired_at_store` | "{store} says this license key has ended. If you think that's a mistake, email {support}." |
| 422 | `license_expired` | "This license has already ended, so it can't turn Pro on. If you have a newer key, paste it here and click Activate." (`detail: { endedAt }`) |
| 422 | `purchase_refunded` | "This purchase was refunded or disputed, so its key can't be activated. If you think that's a mistake, email {support}." |
| 422 | `uses_exceeded` | "This key has already been activated as many times as it allows. Email {support} and ask them to reset your activations, then click Activate again." |
| 422 | `activation_limit_reached` | "This key is already active on as many computers as it allows. On a computer you no longer use, open Settings > License and click Move to another computer, then try again here. If you can't reach that computer, email {support}." |
| 422 | `unknown_product` | "This key isn't for Burrow Pro. Check your receipt for the Burrow key, or email {support}." |
| 422 | `test_purchase_not_allowed` | "This is a test purchase key. Test keys only work in developer builds of Burrow. Use the key from your real purchase." |
| 422 | `key_mismatch` | "That key doesn't match the license on this computer. Paste the same key you activated with." |
| 409 | `nothing_to_deactivate` | "There's no license on this computer to move." |
| 409 | `deactivate_unsupported` | "Gumroad licenses can't be moved from inside Burrow. Click Remove from this computer, then email {support} to reset your activations so you can activate on your new computer." |
| 409 | `license_key_needed` | "Burrow needs your license key to release this computer. Paste the key from your receipt, then click Move to another computer again." |
| 429 | `rate_limited` | "Too many activation attempts. Wait 15 minutes, then try again." |
| 500 | `activation_write_failed` | "Burrow couldn't save your license on this computer. Check that the data folder can be written to, then click Activate again." |
| 502 | `store_error` | "{store} sent an answer Burrow couldn't use. Try again in a few minutes. If it keeps happening, email {support}." |
| 503 | `store_unreachable` (activate) | "Burrow couldn't reach {store}. Check your internet connection, then click Activate again. Nothing was changed on this computer." |
| 503 | `store_unreachable` (deactivate) | "Burrow couldn't reach {store}, so your license is still active here. Check your internet connection, then try again." |
| 503 | `store_busy` | "{store} is busy right now. Wait a minute, then try again." |
| 503 | `store_not_configured` | "This version of Burrow can't activate {store} licenses yet. Update Burrow, or email {support} for help." |

One more code belongs with the Pro gate, not with the license routes above: `501 { error: 'pro_not_included', code: 'pro_not_included', feature, message }` (`Cache-Control: no-store`) with the fixed copy "This build of Burrow does not include Burrow Pro features. Your data and everything in Burrow Free keep working." (`MSG_PRO_NOT_INCLUDED` in `server/pro.js`, mirrored by `PRO_NOT_INCLUDED_COPY` in `src/constants/proFeatures.js`). It is sent only by the fallback of a Pro route in a build without the Pro module, and only after `requirePro` has passed: a Free entitlement still gets `403 pro_required` first (including `newer_license_required`). See `docs/OPEN_CORE.md`.

---

## 11. Module layout

| Path | Responsibility |
| --- | --- |
| `server/license/index.js` | Public API (the only module imported from outside): `initLicense({ dataDir, distDir, env, now, mono, buildInfo, getDb, loadKey, gatherEvidence, throttleMs, log, fetchImpl, storeConfig, allowTest })` never throws; `getEntitlements()`; `getLicenseStatus()`; `async activateLicense({ licenseKey, store })`; `async deactivateLicense({ licenseKey })`; `removeLicense()`; `dismissTrialNotice(notice)`; `LicenseError { httpStatus, code, publicMessage, detail? }`; `resetLicenseForTests()`. |
| `server/license/stores/index.js` | `STORES` (ordered: gumroad, lemonsqueezy), `getStore(id)`, `detectStore(rawKey) -> id | null`. |
| `server/license/stores/gumroad.js`, `stores/lemonSqueezy.js` | Adapter: `{ id, label, hosts, normalizeKey(raw) -> string, matchesKey(normalized) -> boolean, isConfigured(config) -> boolean, canDeactivate, retainKey, activate({ key, fetchImpl, config, allowTest, baseUrl }) -> Promise<ActivationResult>, deactivate?({ key, instanceId, fetchImpl, baseUrl }) -> Promise<void> }`. Gumroad also exports `resolveGumroadEdition` and implements the Pro-then-free-license request order (4.3). |
| `server/license/stores/storeHttp.js` | `postForm` (4.6), `StoreError { code }`. |
| `config/store.json` | The one committed file with every owner-specific store value (placeholders until the owner fills them; shape below). Baked into the desktop sidecar and the release zip at build time. |
| `server/license/storeConfig.js` | Loader and validator for `config/store.json`. `npm run check:store-config` prints which stores are configured. |
| `server/license/terms.js` | `parseStoreDate`, `computeTerms` (4.5). Pure. |
| `server/license/channelSeam.js` | `isReleaseBuild`, `allowStoreTestPurchases`, `storeBaseUrl` (4.7). |
| `server/license/activationStore.js` | Section 5.1 to 5.3. |
| `server/license/licenseKeySecret.js` | Section 5.4. |
| `server/license/messages.js` | `STORE_ERROR_STATUS` (code -> HTTP), `storeErrorMessage(code, { store, support, op })`. |
| `server/license/entitlements.js`, `clockGuard.js`, `trialStore.js`, `buildInfo.js`, `constants.js`, `store.js` (`atomicWriteFile` only) | Kept; edited as sections 7, 8 and 9 say. |
| `server/license/trialNotices.js` | Load and save the `license.trialNotices` flags (section 8). Best effort, never throws. |
| `server/licenseRoutes.js` | Section 10. |
| `src/services/licenseService.js` | `get()`, `activate({ licenseKey, store })`, `deactivate({ licenseKey })`, `remove()`, `dismissTrialNotice(notice)`. |
| `src/hooks/useLicense.js` | Unchanged pattern; mutations invalidate `LICENSE_QUERY_KEY`. |
| `src/constants/licenseStores.js` | Client mirror of ids, labels, patterns, normalization (test-locked to the server). |
| `src/components/settings/LicenseSection.jsx` | Section 12. |

`ActivationResult = { store, productId, variantId, edition, purchaseDateMs, storeExpiresAtMs, email, instanceId, test, retainKey }`.

`config/store.json` fields (the values are placeholders the owner fills, section 18; nothing is hardcoded per real product elsewhere). **An empty value means that store is off.**

| field | meaning |
| --- | --- |
| `supportContact` | Seller contact shown in error copy (for example an email address) |
| `gumroad.proProductId` | `product_id` of "Burrow Pro" |
| `gumroad.proPurchaseUrl` | Product page the "Buy Burrow Pro" button opens (owner value: `https://cdmunoz98.gumroad.com/l/burrow`). Must be https, on the `gumroad.com` host or a subdomain, with no credentials, query or fragment. Anything else, or empty, hides the button. Exposed as `purchaseUrl` in the status (section 10.1) |
| `gumroad.proVersions` | `{ "Standard": "standard", "Founding": "founding", "Family": "family" }`; keys MUST equal the Gumroad version names |
| `gumroad.freeLicenseProductId` | `product_id` of the hidden student and nonprofit product |
| `gumroad.freeLicenseVersions` | `{ "Student": "student", "Nonprofit": "nonprofit" }`; used only if the product has versions |
| `gumroad.freeLicenseDefaultEdition` | `student` or `nonprofit` (committed: `student`); the edition when the free-license product answers with empty `variants`. Never applies to the Pro product. Optional |
| `gumroad.maxUses` | `{ "standard": 3, "founding": 3, "family": 10, "student": 3, "nonprofit": 3 }` |
| `lemonSqueezy.storeId` | store id, decimal string |
| `lemonSqueezy.productIds` | list of product ids, decimal strings |
| `lemonSqueezy.variantEditions` | `{ "<variant id>": "<edition>" }`, where edition is one of standard, founding, family, student, nonprofit |

The file is read at build time and baked into the desktop sidecar and the release zip.

Files removed: `verify.js`, `keys.js`, `canonicalize.js`, `devKeys.json`, the license-file functions of `store.js`, `scripts/license/genKeys.js`, `scripts/license/mintLicense.js`, `scripts/checks/noDevKeys.js`, their tests, `check:devkeys` in `package.json` and the `check` chain, the dev-key steps in `release.yml` (`check:devkeys`, both `noDevKeys --scan` steps) and `hygiene.yml`, the `devKeys` lines in `.gitattributes` and `.dockerignore`, the two Ed25519 rules in `.gitleaks.toml`, and the Ed25519-specific patterns 2 and 3 of `noPrivateKeys.js` (the PEM private-key pattern, `check:keys`, its pre-commit hook and gitleaks' default rules stay). `writeBuildInfo.js`, the `postbuild` hook and the release build-date checks stay. `CLAUDE.md` and `CONTRIBUTING.md` references are updated to match.

---

## 12. Settings UI (`LicenseSection.jsx`)

Same section id, position and `SectionCard` as today. The section is imported statically: the bundle budget sums every JS chunk, so a lazy split only adds chunk overhead.

**No valid activation (free, trial, invalid):**
- Store picker (segmented control, only `configured` stores, Gumroad first and default; hidden when only one is configured). Typing or pasting a key that fully matches the other store's format switches the picker; a manual pick after that is respected.
- Key input (label "License key", `autocomplete="off"`, `spellCheck={false}`), Activate button: **"Activate (contacts Gumroad once)"** or **"Activate (contacts Lemon Squeezy once)"**; "Activating..." and disabled while in flight; disabled when the input is empty.
- Note under the button, exact copy:
  - Gumroad: "Burrow sends your license key, Burrow's product id and a request to count one activation to Gumroad (api.gumroad.com). Gumroad also sees your IP address, like any website. Burrow contacts your store only when you activate or move your license, and never otherwise."
  - LS: "Burrow sends your license key and the name "Burrow" for this computer to Lemon Squeezy (api.lemonsqueezy.com). Lemon Squeezy also sees your IP address, like any website. Burrow contacts your store only when you activate or move your license, and never otherwise."
- Errors inline (`role="alert"`) with the API `message`. Success toast "License activated."
- No store configured: no form; the line "This version of Burrow can't activate licenses yet." The trial block still shows when a trial is running or has ended.

**Active (pro, update_window_passed, expired, clock_issue):** state title and server `message`; edition label (Standard, Founding, Family (up to 5 people), Student, Nonprofit); "Bought from {storeLabel}"; Purchase date; Updates until; "Ends" for yearly; "Key ending in {keyLast4}"; email; "Test purchase" badge when `test`; "Founding member" pill when `perks.founderBackground`; the section 6 date sentence for `update_window_passed`; yearly: "Renews yearly: get a new key before {date}" and, once expired, "Get a new key to turn Pro back on."
- LS: **"Move to another computer"**. Confirm dialog: "This frees this computer's activation at Lemon Squeezy so you can activate Burrow on another computer, and turns Pro off here. Burrow contacts Lemon Squeezy once." Buttons "Move license" / "Cancel". On `license_key_needed` the dialog shows the key input. Success toast "License released. You can activate it on your other computer now."
- Both stores: **"Remove from this computer"** (no network), confirm dialog. Gumroad copy: "This removes the license from this computer only. Gumroad still counts this activation." LS copy adds: "To free the activation at Lemon Squeezy, use Move to another computer instead." Toast "License removed from this computer."
- Gumroad always shows: "To use Burrow on a new computer beyond your limit, email {support} to reset your activations."
- Store build, perpetual license past its update window (`proScope: 'features_until'`, section 6.1): title "Updates ended: earlier Pro features kept", pill "Some Pro features on" (not "Pro off"), the server `message`, a "Pro features on your license" list with each shipped feature as "included" or "needs a newer Burrow Pro license", and the Buy Burrow Pro button (shown even though a license is stored).
- "Use a different key" reveals the activation form, with the hint "Activating a different key replaces this one on this computer."

**Trial block (`TrialBlock`).** There is no start button. Active: "Your Pro trial ends on {date}. After that Burrow switches to Free and keeps all your data." Ended: the earlier copy is kept. No trial record yet (`available`): nothing is rendered.

**Trial notice and badge.** `TrialNotice.jsx` replaces the old localStorage `TrialReminder` toast and is mounted in the app shell, never inside onboarding. It is a light, dismissible banner (`role="status"`), at most one at a time, driven by `status.trial.notice`:
- `welcome`: "Burrow Pro is on for 14 days. Javi's follow-ups and chat, actions, briefings and Explain are unlocked. No card, no account, nothing leaves this computer. After that you move to Burrow Free and keep all your data." Button "Got it".
- `ending_soon`: "Your Pro trial ends on {date}. Your data stays right here either way. Keep Pro any time with a Burrow Pro license." Link "Activate a license" (to `/settings#license`) and "Dismiss".
- `ended`: title "Your Pro trial ended. You're on Burrow Free." Body "All your data, export, import, backups and one Javi insight per page stay free. Pro features like Javi's follow-ups and chat, actions, briefings and Explain are off until you activate a license." Link "Activate a license" and "OK".

Any button or the link dismisses once through `POST /api/license/trial/notice`; a failure is silent and the status is refetched. While `proSource` is `local_trial`, the shell header shows a small pill "Pro trial: N days left" (singular for 1 day) that links to `/settings#license`. Licensed and Free users see no pill.

**Founder background and its `burrow.license:founderPerk` cache:** unchanged from v1.

The Gumroad disclosure note under the Activate button also says that student and nonprofit keys may need a second check with Gumroad (section 4.3). `ProTrialPrompt` is the plain upsell shown when a Pro action is used while Pro is off, with no start button: "This is a Burrow Pro feature.", then after an ended trial "Your Pro trial ended. Your data is all here.", then "Have a license? Activate it in Settings > License".

**Buy Burrow Pro button (O4, decided 2026-10-07).** A "Buy Burrow Pro" button opens the Gumroad Burrow Pro product page in the user's default browser. The URL is `purchaseUrl` from the status (`gumroad.proPurchaseUrl` in `config/store.json`); with no valid URL the button is hidden. It shows next to "Activate a license" in the `ended` notice, the `ending_soon` notice, Settings > License when not licensed, and `ProTrialPrompt`. It is never shown to licensed users. The `welcome` notice stays light and has no button. It is a plain link: the desktop shell opens it in the default browser (`src-tauri` `nav.rs` and the existing `tauri-plugin-opener`), the same way other external links open. Burrow makes no network request for it: no netPolicy feature, no tracking or query parameters, and nothing in the network activity log. Gumroad sees a normal browser visit.

No em dashes. Onboarding is not touched.

### Buyer activation steps

1. Buy Burrow Pro on Gumroad.
2. Copy the license key from the receipt email or from the Gumroad library.
3. Open Burrow and go to Settings > License.
4. Paste the key.
5. Click "Activate (contacts Gumroad once)".

The free download is a separate $0 Gumroad product, "Burrow", that needs no key. Student and nonprofit keys are activated the same way.

---

## 13. Logging

Allowed lines only: `license: activation failed (<code>)`, `license: deactivation failed (<code>)`, `license: activation record ignored (invalid)`, `license: retired license file moved aside`, `license: store base URL override ignored`, `license: developer override <preset|cleared> (BURROW_DEV_TOOLS=on)` and `license: BURROW_DEV_TIER ignored (invalid)` (developer builds only, 14.1), plus the existing clock and trial lines. Never the key, `keyLast4`, email, instance id, request or response bodies, or store messages. Audit log: none.

---

## 14. Dev and test hooks (summary)

| Hook | Effect | Never in |
| --- | --- | --- |
| Dev channel: `channelSeam.allowStoreTestPurchases(env, { devChannel })`; `devChannel` defaults to `isDevChannel(env)` | accepts store test purchases | stable builds |
| `BURROW_LICENSE_STORE_TEST=1` | accepts store test purchases | desktop mode, release builds, a tree without `.git` (the release zip) |
| `BURROW_LICENSE_STORE_BASE_URL=http://127.0.0.1:<port>` | points both adapters at a loopback fake; the record is stored `test: true` | desktop mode, release builds, a tree without `.git`, non-loopback or https URLs |
| `initLicense({ fetchImpl, storeConfig, allowTest })` | test injection | production callers |
| Developer tier switcher (14.1): `allowDevTools` in `devtools/server/policy.js`, Settings > Developer, `BURROW_DEV_TIER` | evaluates a preset license state instead of the real one | stable bundles (the code is absent), the release zip, Docker |

Tests never call real store APIs: they inject `fetchImpl` stubs and `vi.mock('node-fetch')` to throw (the network guard blocks non-loopback sockets anyway). Fixtures are synthetic (keys like `00000000-11111111-22222222-33333333`, emails `@example.com`).

### 14.1 Developer tier switcher

Lets a developer see Free, trial, licensed and problem states without a real key. It only feeds synthetic inputs (an activation, a trial record and a clock observation) into the same pure evaluators as a real install (`evaluateLicense`, `evaluateTrial`, `combineEntitlements`); the HMAC checks and the clock guard are not changed, and the override path never observes the clock or writes an activation, clock or trial record.

**Where it lives:** all of it is in the top-level `devtools/` folder (`devtools/server/**` for Node, `devtools/ui/**` for React), which is never part of the public core and never in any stable, Microsoft Store or Docker build or in the release zip. The core holds only inert seams: `server/devExtensions.js` (`devExtensionRouter()`, `loadDevExtensions()`, `devToolsActive()`), the loader trio `server/devExtensionsLoader.js` (the only core file that names `devtools/`), `devExtensionsLoader.none.js` and, in `devtools/`, `static.js`; `installLicenseDevHook(hook)` in `server/license/index.js` (the only entry point into licensing; it returns null when the tools are compiled out); and the UI list `src/extensions/settingsExtensions.js` (empty in the core). The core keeps two literal key names (`dev.licenseOverride` in `PROTECTED_APP_STATE_KEYS` and `HIDDEN_APP_STATE_KEYS`) as data hygiene, not as override code.

**When it is allowed** (`allowDevTools` in `devtools/server/policy.js`): never when compiled out; in a bundled sidecar (`isReleaseBuild()`) only when the baked channel is `dev` (the environment cannot grant it); unbundled only in a source checkout (`.git` present). The dev extension asks this once at install (`available(env)`). So `npm start`, `npm run dev` and `desktop:dev` from a checkout have it (the server side; the Settings section also needs the tools UI, see How to use), Burrow Dev has it, and the stable app, the Store build, the release zip and Docker do not. The UI reads `devTools` from `GET /api/app/info`, which is `devToolsActive()` (true only after a successful install).

**Presets** (`devtools/server/license/devOverride.js`, `buildOverrideInputs`): `free`, `trial_day1`, `trial_ending_soon`, `trial_ended`, `trial` (with `trialDaysLeft` 0 to 14), `pro_standard`, `pro_founding`, `pro_family`, `pro_student`, `pro_nonprofit`, `update_window_passed`, `expired`, `clock_issue`, `invalid`, `test_purchase_refused` (a store test record evaluated by the stable rule: Free, reason `test_purchase`, no license) and `lapsed_after_trial` (a license past its update window with the trial over and the ended notice still due, which must show none). Days count down in real time from the moment the preset was applied (`anchorAt`); applying again resets it. Trial presets show their notice once; the other presets show none (`lapsed_after_trial` starts with its notices due to prove that).

**Storage and precedence:** the override is `app_state` key `dev.licenseOverride` (`{ v: 1, preset, trialDaysLeft, anchorAt, notices }`, strict parse: anything else is no override), read on every evaluation while developer tools are allowed. It is in `PROTECTED_APP_STATE_KEYS` and `HIDDEN_APP_STATE_KEYS`. `BURROW_DEV_TIER=<preset>` (plus `BURROW_DEV_TRIAL_DAYS=<0..14>` for `trial`) pins a preset for the process, wins over the stored row, and makes `PUT` and `DELETE` answer `409 dev_override_env_pinned`; an invalid value is ignored with one log line.

**Routes** (`devtools/server/devLicenseRoutes.js`, registered on `devExtensionRouter()` only when the extension installed, otherwise the generic `404 { error: 'not_found' }`; `no-store`; errors `{ error, code, message }`): `GET /api/dev/license`, `PUT /api/dev/license` (`{ preset, trialDaysLeft? }`), `DELETE /api/dev/license`, `POST /api/dev/license/reset-notices`, `POST /api/dev/license/reset-trial` (`{}` or `{ daysLeft }`). The two POST utilities need an explicit JSON object body (missing or non-object is `400 invalid_request`). Only `reset-trial` and `reset-notices` change real trial or notice records (the trial record, and `license.trialNotices`). Success is `{ data: DevLicenseState }` with `identity`, `presets`, `override`, `effective` (exactly `GET /api/license`), `real` (the status without the override) and `raw` (records without keyHash, mac, instance id, key or email). Codes: `400 invalid_request`, `404 dev_tools_unavailable`, `409 dev_override_env_pinned`, `500 dev_override_write_failed | dev_trial_write_failed`. `GET /api/app/info` adds `devTools` (boolean) for the UI.

**Compile-out and checks:** `bundleDefine` sets `__BURROW_DEV_TOOLS__` (`true` only for `dev`). `devToolsPlugin(channel)` (esbuild, both sidecar passes) rewrites the one import of `server/devExtensionsLoader.js`: stable and Store bundles get `devExtensionsLoader.none.js` (finds nothing), a dev bundle gets `devtools/server/static.js` (bundles the extension statically and fails loud when `devtools/` is missing), and a stable bundle fails if anything under `devtools/` is still loaded, so the code is absent rather than switched off. For the UI, the Vite `devToolsUiPlugin` (`scripts/build/devToolsUi.js`) swaps `src/extensions/settingsExtensions.js` for `devtools/ui/settingsExtensions.js` only for `npm run dev`, `npm run build:devtools` and `BURROW_CHANNEL=dev` builds; every other build (`npm run build` stable, Store, zip, Docker, CI) excludes `devtools/ui` and fails if it is loaded. The text `BURROW_DEV_TOOLS=on` exists only in `devtools/server/license/devOverride.js` and `devtools/ui/DeveloperSection.jsx`, and the route path `/dev/license` is forbidden in core `server/` and `src/`. `channelMarker.js` fails a stable bundle or executable that contains either marker (`checkBundleText`, `checkBinaryChannel`) and scans a built UI folder (`--dist-dir`; `--expect-dev-tools absent|present`, default from `--expect`, so a stable dist must carry none and a dev dist must carry the UI marker). `buildSidecar.js` runs the bundle check (also with `--bundle-only`) and refuses to copy a dist whose developer-tools state does not match the channel; `buildStore.mjs --reuse-web` refuses a dist with the tools; `smokeSidecar.js` asserts `GET /api/dev/license` is 404 and `devTools` is false in the real stable sidecar; CI scans the stable dist after the build. The release zip never contains `devtools/` (`.gitattributes` `devtools export-ignore`; `scripts/release/disableDevTools.mjs` removes it if present, fails on a stale `server/license/devOverride.js` and fails when a marker is still in `server.js`, `server/`, `src/` or `dist/`; tests, docs and `scripts/` are not scanned: they mention the text on purpose and never run). The Docker image does not copy `devtools/` (`.dockerignore`), asserts it is absent and greps the runtime code and `dist/` for both markers. `build:devtools` writes a stable-channel build info, so later stable packaging rejects its dist.

**How to use:** Settings > Developer (or `/settings#developer`; it shows only when `devTools` is true) needs a build that contains the tools UI: `npm run dev`, `npm run desktop:dev -- --devtools`, `npm run build:devtools; npm start` or a Burrow Dev build. Plain `npm run desktop:dev` builds the normal UI and shows no Developer section; the build identity line at the bottom of Settings reads `stable · developer tools` only while the section shows. A plain `npm run build; npm start` serves the stable UI without it (the server routes still mount in a checkout). Pick a tier and click Apply, or click Clear override to use the real state. Or start the server with `BURROW_DEV_TIER=pro_founding` in a source checkout. The Reset trial notices, Restart trial, End trial now and Seed trial buttons change the real trial or notice records of that data folder (Restart, End and Seed ask for a confirmation first; End trial now is Seed with 0 days left, so it rewrites the trial record and the trial notices show again).

---

## 15. Plugging into the AI gate (Phase 4)

Pro gating is by capability through `server/pro.js` (`requirePro(feature)` middleware, `assertPro(feature)` for non-route callers, `isProEnabled()`, and the `PRO_FEATURES` registry, which also reserves `semantic_search`, `automations`, `smart_importers`, `scheduled_external_backups`, `weekly_reviews` and a `model_pack` hook for a future Pro model pack). Gated today: `POST /api/jarvis` and `POST /api/jarvis/actions/:token` (`javi_tools`), `POST /api/jarvis/advice` only when it carries earlier messages or another multi-turn key (`javi_conversation`; `requireProWhen` with `isMultiTurnAdvice`, re-checked after the AI client is resolved), `POST /api/jarvis/briefing/refresh` and the scheduled briefing (`briefings`; the scheduler skips silently when Pro is off), and `POST /api/insights/explain` (`explain`), the Javi characters (`javi_characters`: Butler is free, Valet, Concierge and Majordomo need Pro; `getCharacter()` in `server/javi/characters.js` reads the saved `javi:character` through `proAccess('javi_characters')` and returns Butler without Pro, never an error), plus the Folders features: `POST /api/folders/:id/ask` and building the local question index during a scan (`folder_qa`), `POST /api/folders/:id/report` (`folder_report`), and turning on the daily re-scan with `PATCH /api/folders/:id` `{ autoRescan: true }` together with the scheduled re-scan job (`folder_auto_rescan`; the scheduler skips silently when Pro is off, and turning the switch off stays free). Adding, scanning, summarizing and exporting folders is Free. When Pro is off a gated route answers `403 { error: 'pro_required', feature, message }` before any SSE headers; in a Store build, a lapsed perpetual license gets this decision per feature and a locked one answers with `reason: 'newer_license_required'` (section 6.1, every gated id needs a date in `server/license/proFeatureDates.js`, including `javi_conversation`, `javi_characters` and the three folder ids). The client uses the `useEntitlements()` hook with `ProGateNotice` and `ProTrialPrompt`. Free: all data, export and import, backups, privacy, provider settings, model pull and one read-only Javi insight per page (single-shot advice; no follow-ups, threads or typed questions) with the Butler character.

The gates stay in public core code; the Pro handlers behind them live in the private Pro module. `server/proRoutes.js` is the public list of every Pro route (id, path, feature, folder helpers, AI purpose): the module can add a handler only for an id in that list, and core mounts `requirePro(feature)` as the first layer. A build without the module answers those paths with `501 pro_not_included` after the gate passes (section 10.7). The boundary between core and the module is described in `docs/OPEN_CORE.md`.

Never gate data, export, import, backups or privacy controls. `isAiEnabled()` stays the AI on/off seam and is not a licence check.

---

## 16. Threat model

**Stance:** deterrence, not DRM. The app runs on the user's machine (and the core will be public), so a determined user can patch any check. Goals: keep honest people honest, limit casual key sharing, never punish honest users, never lock data.

| Actor | What they try | Stopped? |
| --- | --- | --- |
| Honest user | Reinstalls, new computer, travel, DST, dead CMOS battery | Never punished: activation limits have slack, LS users self-serve "Move", Gumroad users get a clear email path, 48 h clock tolerance, data never locked. |
| Key sharer | Posts a key | **Limited** by Gumroad uses (3, family 10) and the LS activation limit. Beyond that, deterred socially (the email shows in Settings). |
| Buyer who refunds after activating | Keeps Pro | **Not stopped.** Refunds and chargebacks are caught only at activation time; Burrow never re-checks (the network promise). Accepted. |
| Record editor | Edits edition, dates or `test` in `license-activation.json` or the DB row | **Yes:** HMAC over every field; one bad copy is repaired from the other, none valid reads `invalid`. |
| Record copier | Copies the record to another machine | **Yes:** the MAC and key hash are bound to that machine's `secrets.key`. Copying `secrets.key` too is a determined patcher. |
| Seat recycler | Clicks Move (seat freed at LS), then restores the old file copy; or activates under a far-future wall clock so the old record would outrank a later tombstone | **Mostly:** the newer tombstone wins. `activatedAt` is bounded to the clock guard's high-water mark plus 48 h, and a tombstone is never earlier than the activation it replaces plus 1 s. Deleting both copies and restoring an old file is not stopped (accepted). |
| Importer | Imports an archive containing `license.activation` | **Yes:** protected key; exports do not contain it. `license.trialNotices` is protected too, but it is cosmetic and never grants Pro. |
| Clock changer | Rolls the clock back to extend a yearly license or the trial | **Yes** (v1 guard, `L` = purchase date). Perpetual editions never use the clock. |
| Test-purchase abuser | Uses a seller test key in a stable build | **Yes:** refused unless dev channel, or the env switch in a source checkout (not desktop, not release, not the release zip). A `test: true` record also gives no Pro in a stable desktop or release build. |
| Mock-server abuser | Points the app at a fake store | **Yes in the desktop app, release builds and the release zip** (override ignored; the record is `test: true` and inert there). From a checkout anyone can patch; out of scope. |
| Build-date editor | Edits `dist/burrow-build-info.json` in the desktop app to move the build date | **Yes in the desktop app:** the sidecar bundler bakes the date in (`__BURROW_BUILD_DATE__`, preferred over the file). The Docker image and source runs still read the file (patcher, out of scope). |
| Seller token thief | Wants Gumroad admin access from the app | **Nothing to steal:** no seller token, API key or secret ships. Store license APIs need none. |
| Determined patcher | Edits the JS or the build-info file | **Not stopped**, out of scope. |

**Residual risks (accepted):** `H` lags after a long absence; whole-data-dir restore rolls back clock copies and `secrets.key` together; repeated sub-48 h rollbacks stall `H`; trial reset by deleting both trial copies; a trial started under a badly wrong clock is lost; a refused or timed-out activation may still use one store activation (O3); LS key secret is only as safe as `secrets.key`.

## 17. Privacy

- **Gumroad receives**, on Activate only: the license key, Burrow's product id (a student or nonprofit key may send a second request with the hidden product's id), `increment_uses_count=true`, the user's IP address and the `User-Agent: Burrow` header. Gumroad already holds the purchase (email, name, payment) as Merchant of Record.
- **Lemon Squeezy receives**, on Activate: the license key and the instance name `Burrow`; on Move to another computer: the license key and the instance id it issued. Plus IP address and `User-Agent: Burrow`.
- Nothing about the user's data, device, OS, hostname or user name is ever sent. No call at startup, in the background, on status reads, on update checks, on the automatic trial start or on a trial notice.
- **Stored locally:** the activation record (store, edition, dates, product and variant ids, key hash, last 4 of the key, the email the store returned, LS instance id, test flag), in the data folder and `app_state`, never exported, never logged, never in the audit log or Javi's context. The full LS key is kept encrypted in `app_secrets` (never exported, not in backups). Gumroad keys are never kept.
- `GET /api/license` returns the email to the local UI only, `no-store`.
- Gumroad privacy: https://gumroad.com/privacy . Lemon Squeezy privacy: https://www.lemonsqueezy.com/privacy .

## 18. Owner setup

**Gumroad launch checklist** (needed before release; every value goes in `config/store.json`):
1. Create the product **"Burrow Pro"** at $49 with the license key option on ("Generate a unique license key per sale"). Add versions named exactly `Standard` (+$0), `Founding` (+$50, so $99; remove after the sale ends on 2027-01-05) and `Family` (+$30, so $79). Never rename a version: editions map by name.
2. Create the hidden product **"Students & Nonprofits"** with the license key option on and a required custom field "School or nonprofit name". It has no versions, so its keys resolve to `gumroad.freeLicenseDefaultEdition` (`student`); if you later add versions named exactly `Student` and `Nonprofit`, those win. The free **"Burrow"** download is a separate product with no license key and is not in `config/store.json`. Keep it unlisted (not on your profile or discover).
3. Copy each product id into `config/store.json`: open the product, Content tab, the license key section shows the `product_id`. Burrow Pro goes in `gumroad.proProductId`; the hidden product goes in `gumroad.freeLicenseProductId`. Leave `gumroad.proVersions`, `gumroad.freeLicenseVersions` and `gumroad.maxUses` as committed unless you change the versions.
4. Set `supportContact` (for example an email address). Set `gumroad.proPurchaseUrl` to the Burrow Pro product page (`https://cdmunoz98.gumroad.com/l/burrow`); leave it empty to hide the Buy button. Make the refund policy say a refunded key is no longer valid.
5. Run `npm run check:store-config`. It prints which stores are configured; Gumroad must show as configured.
6. Test with a Gumroad test purchase, in a Dev build only: a stable build refuses test keys with `test_purchase_not_allowed` (4.7). From a source checkout you can also set `BURROW_LICENSE_STORE_TEST=1` outside desktop mode.
7. Student and nonprofit keys: after you verify eligibility (O6), create single-use (quantity 1) 100% offer codes on the hidden product, one per person, and send the code. The buyer checks out for $0 and receives a key. Founding giveaways: a 100% single-use code on the `Founding` version of Burrow Pro.
8. Free download: a separate $0 (pay what you want) product "Burrow" that only delivers the download from the public `burrow-releases` repo. It has no license key.
9. Reset a buyer's uses: Gumroad dashboard, Sales, open the sale, License key, Uses, reset it. There is no way to do this from the app.
10. Store copy: describe Burrow as a desktop app with a built-in helper. Gumroad prohibits selling "AI services: access to AI tools, chatbots", so never describe it as access to an AI.

**Lemon Squeezy** (after launch; leave its fields in `config/store.json` empty until then):
1. One product "Burrow Pro" with variants Standard, Founding, Family, Student, Nonprofit; license keys on per variant with activation limits 3, 3, 10, 3, 3; length unlimited for Standard, Founding, Family and 1 year for Student and Nonprofit.
2. Student and nonprofit: 100% discount codes limited to their variant (LS does not expose discount codes in the License API, so the variant decides the edition).
3. Copy the store id, product id and each variant id into the `lemonSqueezy` fields of `config/store.json`.
4. Test mode purchases work only in Dev builds.

## 19. Open decisions

- **O1:** LS purchase date is `license_key.created_at` (no order date in the License API). Fine unless LS ever creates keys later than the order.
- **O2 (decided 2026-10-05):** two Gumroad products. A paid key is one request; a student or nonprofit key is two (Burrow Pro first, then the hidden product only on a 404, which spends no use). The Activate disclosure says student and nonprofit keys may need a second check with Gumroad. More products would need more requests and new copy.
- **O3 (accepted):** a refused or timed-out activation may still count one store activation; limits carry slack and the seller can reset.
- **O4 (decided 2026-10-07):** purchase link and support contact (was D5). Decided: Burrow shows a "Buy Burrow Pro" button that opens the Gumroad Burrow Pro product page (`https://cdmunoz98.gumroad.com/l/burrow`) in the user's default browser (section 12). The URL is the owner store value `gumroad.proPurchaseUrl` in `config/store.json`, exposed as `purchaseUrl` in the status. The link is opened by the desktop shell, not by Burrow, so it is not an app network request. `supportContact` in `config/store.json` still falls back, while empty, to "the seller (the contact address is on your receipt)".
- **O5:** LS long-term: Stripe acquired LS and is steering sellers toward Stripe Managed Payments. The adapter interface is the seam for a future store; no action now.
- **O6:** how student and nonprofit eligibility is verified before a code is issued (owner process, outside the app).
- **O7 (follow-up):** a deep link `burrow://activate?key=...` (a Gumroad content page can include `__license_key__`). The desktop shell does not register a URL scheme yet, so this is not built.
- **O8:** Lemon Squeezy store setup, and the site, follow after the Gumroad launch. The adapter already exists.

Resolved and carried from v1: D2 (local trial), D3 (founding 730 days plus perk), D6 (rollback turns Pro off for yearly editions and the trial). Retired with v1: D4 (dev keys), D7 (hand-minting; replaced by 100% single-use store codes).

## 20. Test plan

Backend in `server/__tests__/license/`, frontend in `src/components/settings/__tests__/`. Every store response is a synthetic fixture (`fixtures/storeResponses.js`); `fetchImpl` is a stub; time is injected.

| Area | Required tests |
| --- | --- |
| Key formats | normalization (whitespace, case); `detectStore` for both formats and garbage; explicit store wins; mismatched explicit store gives store-specific `invalid_key_format`; over 128 chars; client mirror equals server patterns. |
| Gumroad verify | success: one request, exact form fields, headers, `redirect: 'manual'`, URL; record fields; refunded, chargebacked, disputed (and disputed with `dispute_won` accepted); `test: true` refused on stable, accepted with `allowTest`; product id mismatch and unresolved edition give `unknown_product`; `imported_customer` gives `store_error`; 404 not found vs disabled; 429; 500; non-JSON; oversized body; redirect; timeout and network error give `store_unreachable` with nothing stored; uses at limit accepted, limit + 1 refused per edition; same key re-activated makes no request (stub call count 0) and returns status; different key replaces; the key and bodies never appear in logs (spy on `console`). |
| Gumroad edition | `"(Founding)"` and `"(Founding, Blue)"` resolve through `proVersions`; `"(Student)"` and `"(Nonprofit)"` through `freeLicenseVersions` only for the hidden product; empty, absent or unknown version gives `unknown_product`; offer codes never change the edition. |
| Gumroad two products | Pro product 200: one request. Pro 404 then free-license 200: two requests, edition student or nonprofit, the 404 spent no use. Pro 404 and no `freeLicenseProductId`: one request, `key_not_found`. Pro 404 and free 404: two requests, `key_not_found`. A non-404 failure on the Pro request (429, 500, timeout, refunded) never triggers the second request. Student and nonprofit use limit per `maxUses`. |
| Store config | `config/store.json` loads and validates (`storeConfig.js`); empty values turn the store off (`store_not_configured`); bad shapes are rejected; `npm run check:store-config` reports configured stores. |
| LS activate | success: `instance_name=Burrow`, instance id stored, key secret saved encrypted (not in `SECRET_DEFS`, absent from `/api/secrets`); activation limit by numbers and by error text; disabled; expired at store; 404; store id, product id and variant mismatches; `test_mode` stable vs dev; `expires_at` shortens a yearly edition and is ignored for paid ones; `created_at` with 6 decimals; `/validate` never called. |
| LS deactivate | success clears both copies (tombstone) and the secret; 404 treated as success; network failure keeps everything; Gumroad gives `deactivate_unsupported`; none gives `nothing_to_deactivate`; missing secret gives `license_key_needed`, body key accepted when it matches, `key_mismatch` otherwise. |
| Terms | `computeTerms` per edition: standard and family +365 d, founding +730 d, yearly `expiresAt = updatesUntil = +365 d`; `parseStoreDate` accepts Z, offsets and fractions, floors, rejects out-of-range and junk. |
| Update window vs build date | per edition: build at `updatesUntil` is Pro, +1 s is `update_window_passed`; founding build +729 d Pro, +731 d `update_window_passed` with the founder perk kept; moving the clock never changes a perpetual edition. |
| Yearly expiry and clock | student Pro at +364 d, `expired` at exactly +365 d; activation of an already-ended yearly key refused `license_expired`; rollback before expiry gives `clock_issue` and clears; `L` = purchase date feeds the guard; evidence lists `license-activation.json`. |
| Activation store | MAC round trip; each field edit invalid; extra or missing key invalid; tombstone shape; one copy deleted is repaired; one tampered is ignored and repaired (log has no values); both tampered `invalid`/`tampered`; no key `no_key` and activate refuses before any request; both valid and different: later timestamp wins, tie goes to the DB; tombstone newer than an old restored file wins; record from another `secrets.key` is invalid; file over 2 KiB invalid. |
| Import, export, restore | `license.activation` in `PROTECTED_APP_STATE_KEYS`; import never writes it; `PUT /api/state/license.activation` 403; restore carries the live row and the live `LICENSE_STORE_KEY`; export archive has no `license.activation` row; backup snapshot has no `app_secrets` rows. |
| Migration | `license.burrowlicense` renamed to `.retired.bak` (existing backup replaced), one log line, state `free`, never read; rename failure never throws. |
| netPolicy | `license` feature listed last with both hosts; activate turns it on then asserts; a malformed key, an unconfigured store, a missing MAC key and a same-key re-activation never turn it on; startup with an activation and `BURROW_NETWORK_OPTIN=license` makes zero outbound connections; `GET /api/license` makes none. |
| Channel seam | `allowStoreTestPurchases` truth table (env unset, `1`, desktop, release, devChannel); base URL override accepted for loopback http only, ignored for https, LAN hosts, credentials, desktop and release builds. |
| API | GET shape in every state (no `keyHash`, `instanceId`, `mac`, key); `stores` and `supportContact`; activate 200, each error code with its HTTP status and exact copy, no store text echoed; `invalid_request` for bad bodies and parse errors; 409 in-flight; 429 after 10; DELETE idempotent, tombstone written, secret cleared, trial kept; old `POST /api/license` is 404; auth gate 401 and desktop gate 401; `no-store`. |
| Entitlements | 9.1 precedence per branch; `test_purchase` advisory; `getEntitlements()` shape; combination with the local trial (unchanged cases); founder perk from the record. |
| Reverse trial | First init auto-starts (state `trial`, 14 days, `proSource` `local_trial`, notice `welcome`); restart does not restart or extend; a valid legacy 7-day record still loads as valid with its own 7-day end (no extension) and an `endsAt` of any other duration is rejected; an ended record gives no new trial; a tampered (`used`) record gives no new trial; an older active trial gets no welcome and `ending_soon` later; an older ended trial gets no `ended` notice; expiry at day 14 gives Free and notice `ended` once, and the dismissal survives re-init; `ending_soon` at 2 days or fewer; rollback over 48 h during the trial gives `clock_issue`, no notice, data untouched; a forward clock past the end gives ended; a license activated during the trial gives Pro through the license, notice `null`, trial record kept; a removed license after the trial ended gives Free with no fresh trial; `autoStartTrial: false` keeps `available`; a failed startup write is retried by `getLicenseStatus()`; Erase keeps `license.trialNotices`; import cannot write it; `POST /api/license/trial` is 404; the notice route answers 200 and 400. No network in any of them. |
| Pro gating | `requirePro(feature)` answers `403 pro_required` with `feature` for each Pro route before any SSE headers; free routes (data, export, import, backups, privacy, provider settings, single-shot page advice) never gated; multi-turn advice (`javi_conversation`) is Pro; `useEntitlements()` reflects the license state. (Owned by the gating branch.) |
| Store per-feature Pro (6.1) | registry checks (`proFeatureRegistry.test.js`: ids equal `PRO_FEATURES`, every gated id dated, client mirror equal); boundary dates (`introducedAt == updatesUntil` included, one second later locked, `null` locked, non-license-format dates locked); Standard, Founding, Family, a Lemon Squeezy record, active and expired Student and Nonprofit, trial active and ended; clock rolled back or forward changes nothing; store versus direct (direct unchanged, no `proScope` key); the status body; every gated route (`/api/jarvis`, `/api/jarvis/actions/:token`, briefing refresh and scheduled briefing, `/api/insights/explain`) per feature in `license/storeFeatureGating.test.js`, `proStoreFeatures.test.js`, `proStoreDirectCalls.test.js`; the conditional `javi_conversation` gate on `POST /api/jarvis/advice` is covered with the same per-feature rules. |
| UI (RTL) | `StoreFeatureNotice.test.jsx`: the newer-license notice, the Settings > License feature list and Buy button, per-feature `isKnownFree`. `ProTrialPrompt` shows "This is a Burrow Pro feature." and "Have a license? Activate it in Settings > License", with no start button; `TrialNotice` per notice, one dismiss post, nothing when the notice is `null`; the days-left pill; `TrialBlock` per trial state; Gumroad disclosure mentions the possible second check for student and nonprofit keys; picker default and auto-switch; button label per store; disclosure note per store; empty input disables; in-flight label; error inline with `role="alert"`; success toast and refetch; active details per edition and store; Test purchase badge; LS Move dialog, `license_key_needed` path; Remove dialog copy per store; Gumroad support line with and without `supportContact`; no store configured state; invalid state shows the form; no em dash in rendered copy; onboarding has no licensing content. |
| Hygiene | `npm run check` passes without `check:devkeys`; `noPrivateKeys` still catches PEM; gitleaks config has no Ed25519 rules; no file references `devKeys.json`, `mintLicense` or `verifyLicense`. |
