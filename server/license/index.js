// Public API of the licensing module (docs/LICENSING.md sections 4, 10, 11). Nothing outside server/license/
// imports the inner modules. The only network calls are in activateLicense and deactivateLicense, which run
// only on an explicit user click: no startup, timer, status read or getEntitlements() call ever reaches a store.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDbPath } from '../db/index.js';
import { isStoreDistribution } from '../distribution.js';
import { assertNetworkEnabled, setNetworkFeature } from '../netPolicy.js';
import { getDataDir } from '../paths.js';
import { envDir, getAppVersion } from '../runtime.js';
import { createActivationStore } from './activationStore.js';
import { loadBuildInfo } from './buildInfo.js';
import {
  STORE_ORIGINS,
  allowStoreTestPurchases,
  devToolsCompiledIn,
  rejectsTestRecords,
  storeBaseUrl,
} from './channelSeam.js';
import { createClockGuard } from './clockGuard.js';
import {
  MAX_KEY_INPUT_CHARS,
  ROLLBACK_TOLERANCE_MS,
  RETIRED_LICENSE_BACKUP,
  RETIRED_LICENSE_FILE,
  YEARLY_EDITIONS,
  formatLicenseDate,
  inDateRange,
  parseLicenseDate,
} from './constants.js';
import { combineEntitlements, evaluateLicense, evaluateTrial, toStatus } from './entitlements.js';
import { clearLicenseKey, loadLicenseKey, saveLicenseKey } from './licenseKeySecret.js';
import { STORE_ERROR_STATUS, storeErrorMessage } from './messages.js';
import * as defaultStoreConfig from './storeConfig.js';
import { STORES, detectStore, getStore } from './stores/index.js';
import { StoreError } from './stores/storeHttp.js';
import { computeTerms } from './terms.js';
import { TRIAL_NOTICE_NAMES, createTrialNoticeStore } from './trialNotices.js';
import { createTrialStore } from './trialStore.js';

const REPO_DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');

export class LicenseError extends Error {
  /**
   * @param {{ httpStatus: number, code: string, publicMessage: string, detail?: object }} info
   */
  constructor({ httpStatus, code, publicMessage, detail }) {
    super(code);
    this.name = 'LicenseError';
    this.httpStatus = httpStatus;
    this.code = code;
    this.publicMessage = publicMessage;
    if (detail !== undefined) this.detail = detail;
  }
}

/** @type {null | object} */
let ctx = null;

function defaultDataDir() {
  try {
    return path.dirname(resolveDbPath());
  } catch {
    return getDataDir();
  }
}

/** Builds a LicenseError from a code in STORE_ERROR_STATUS with its fixed copy. */
function fail(c, code, { store = null, op = 'activate', detail } = {}) {
  return new LicenseError({
    httpStatus: STORE_ERROR_STATUS[code] ?? 502,
    code,
    publicMessage: storeErrorMessage(code, { store: store?.label ?? null, support: c.storeConfig.SUPPORT_CONTACT, op }),
    detail,
  });
}

/** Moves a v1 license file aside (docs/LICENSING.md 5.6). Never throws and never reads the file. */
function retireLegacyFile(dataDir, log) {
  const from = path.join(dataDir, RETIRED_LICENSE_FILE);
  try {
    if (!fs.existsSync(from)) return;
    fs.renameSync(from, path.join(dataDir, RETIRED_LICENSE_BACKUP));
  } catch {
    // a failed rename is ignored: the file is never read
  }
  try {
    log('license: retired license file moved aside');
  } catch {
    // logging must never fail startup
  }
}

const purchaseMsOf = (activation) => (activation?.kind === 'active' ? parseLicenseDate(activation.record.purchaseDate) : null);

/**
 * Loads build info and the stored activation once and starts the clock guard. Never throws and never
 * contacts a store. Every argument is optional; tests inject providers.
 * @param {{
 *   dataDir?: string, distDir?: string, env?: Record<string, string | undefined>, now?: () => number,
 *   mono?: () => number, buildInfo?: object, getDb?: Function, loadKey?: Function,
 *   gatherEvidence?: () => number | null, throttleMs?: number, log?: (message: string) => void,
 *   fetchImpl?: Function, storeConfig?: object, allowTest?: boolean | (() => boolean), autoStartTrial?: boolean,
 * }} [opts] `autoStartTrial` (default true) starts the one 14-day trial of a data folder on its first
 *   launch; `false` is a test seam only (no env var, no user setting).
 */
export function initLicense({
  dataDir = defaultDataDir(),
  distDir = envDir('BURROW_DIST_DIR') ?? REPO_DIST,
  env = process.env,
  now,
  mono,
  buildInfo = loadBuildInfo({ distDir }),
  getDb,
  loadKey,
  gatherEvidence,
  throttleMs,
  log = (message) => console.warn(message),
  fetchImpl,
  storeConfig = defaultStoreConfig,
  allowTest,
  autoStartTrial = true,
} = {}) {
  retireLegacyFile(dataDir, log);
  const shared = { dataDir, now, getDb, loadKey, log };
  const guardOpts = { ...shared, mono, gatherEvidence, throttleMs };
  for (const o of [guardOpts, shared]) for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  const guard = createClockGuard(guardOpts);
  const activationStore = createActivationStore(shared);
  const activation = activationStore.load();
  const trialStore = createTrialStore(shared);
  const trial = trialStore.load();
  ctx = {
    dataDir,
    env,
    buildInfo,
    guard,
    activationStore,
    activation,
    trialStore,
    trial,
    now: now ?? Date.now,
    getDb,
    loadKey,
    log,
    fetchImpl,
    storeConfig,
    allowTest: typeof allowTest === 'function' ? allowTest : () => (typeof allowTest === 'boolean' ? allowTest : allowStoreTestPurchases(env)),
    busy: false,
    autoStartTrial,
    noticeStore: createTrialNoticeStore({ getDb: shared.getDb, now: shared.now }),
    notices: null,
  };
  resetDevHook();
  try {
    guard.start({ buildDate: buildInfo.buildDate, issuedAt: purchaseMsOf(activation) });
  } catch {
    // The guard is best effort: a failure here must never block startup.
  }
  reconcileTrial(ctx);
}

function ensure() {
  if (!ctx) initLicense();
  return ctx;
}

function observeClock(c) {
  try {
    return c.guard.observe({ issuedAt: purchaseMsOf(c.activation) });
  } catch {
    const wall = c.now();
    return { now: wall, effective: wall, hwm: wall, rollback: false, persisted: false };
  }
}

/**
 * Tombstone time: never earlier than the activation it replaces (plus a second), so a forward-clock
 * activation cannot be revived by putting its old copy back (the later timestamp wins on load).
 */
function clearStampOf(c) {
  const effective = observeClock(c).effective;
  const activatedMs = c.activation.kind === 'active' ? parseLicenseDate(c.activation.record.activatedAt) : null;
  return activatedMs === null ? effective : Math.max(effective, activatedMs + 1000);
}

/**
 * Starts the one trial of this data folder when no record exists (reverse trial). Never throws. A stored
 * record of any kind (valid, ended, tampered or unreadable) is never replaced: trialStore.start refuses.
 * @returns {boolean} true when this call started the trial
 */
function ensureTrialStarted(c) {
  if (!c.autoStartTrial || c.trial.kind !== 'none') return false;
  try {
    const startedAt = Math.floor(observeClock(c).effective / 1000) * 1000;
    // A clock outside the supported range would store a record that reads back as used: wait for a sane clock.
    if (!inDateRange(startedAt)) return false;
    if (!c.trialStore.start(startedAt)) {
      // A copy that appeared since launch is picked up, so status reads stop retrying.
      c.trial = c.trialStore.load();
      return false;
    }
    c.trial = c.trialStore.load();
    return c.trial.kind === 'valid';
  } catch {
    return false;
  }
}

/**
 * Makes the one-time notice flags belong to the current trial. A trial started in this call has shown
 * nothing yet; a pre-existing (legacy manual) trial gets no welcome, and no "ended" notice when it is
 * already over. The flags are also kept in memory so a failed write still stops the notice.
 */
function reconcileTrial(c) {
  const started = ensureTrialStarted(c);
  if (c.trial.kind !== 'valid') return;
  if (c.notices?.startedAt === c.trial.startedAt) return;
  const stored = c.noticeStore.load();
  if (stored && stored.startedAt === c.trial.startedAt) {
    c.notices = stored;
    return;
  }
  // The real end time, not evaluateTrial: a rollback reads an active trial as ended (clock_issue) without it being over.
  const clock = observeClock(c);
  const ended = c.trial.endsAt <= Math.max(clock.effective, c.trial.startedAt);
  const flags = started ? { welcome: false, endingSoon: false, ended: false } : { welcome: true, endingSoon: false, ended };
  c.notices = { startedAt: c.trial.startedAt, flags };
  c.noticeStore.save(c.trial.startedAt, flags);
}

/** Today's evaluation of the real activation, trial record and guarded clock. */
function evaluateReal(c) {
  const clock = observeClock(c);
  const license = evaluateLicense({
    activation: c.activation,
    buildInfo: c.buildInfo,
    clock,
    rejectTestRecords: rejectsTestRecords(c.env),
    distribution: isStoreDistribution(c.env) ? 'store' : 'direct',
  });
  return { clock, evaluation: combineEntitlements(license, evaluateTrial({ record: c.trial, clock })) };
}

/**
 * The developer hook's synthetic inputs, or null (no hook, no override, or the hook threw). The hook is the one
 * entry point of the developer tier switcher; it exists only when a dev extension installed it (installLicenseDevHook).
 */
function devInputs(c) {
  if (!devHook) return null;
  try {
    return devHook.inputs({ env: c.env, now: c.now, getDb: c.getDb, log: c.log, buildDate: c.buildInfo.buildDate }) ?? null;
  } catch {
    return null;
  }
}

function evaluate() {
  const c = ensure();
  const o = devInputs(c);
  if (o) {
    // Same evaluators, synthetic inputs: no clock observation and no write to any real record.
    // A preset can ask for the stable rule (a test record reads Free), the way evaluateReal does in a stable build.
    const license = evaluateLicense({ activation: o.activation, buildInfo: c.buildInfo, clock: o.clock, rejectTestRecords: o.rejectTestRecords === true });
    const evaluation = combineEntitlements(license, evaluateTrial({ record: o.trial, clock: o.clock }));
    return { c, clock: o.clock, evaluation, noticeFlags: o.notices };
  }
  const { clock, evaluation } = evaluateReal(c);
  return { c, clock, evaluation, noticeFlags: c.notices?.flags ?? null };
}

/**
 * `proScope` is 'features_until' only in a Store build for a perpetual license past its update window: `pro` is
 * false, and `proFeatures` lists the Pro feature ids that license still includes and the ones it does not
 * (docs/LICENSING.md 6.1). Otherwise both keys are absent.
 * @returns {{ pro: boolean, edition: string | null, reasons: string[], proScope?: 'features_until',
 *   proFeatures?: { included: string[], locked: string[] } }}
 */
export function getEntitlements() {
  const { evaluation } = evaluate();
  const base = { pro: evaluation.pro, edition: evaluation.edition, reasons: evaluation.reasons };
  // The two extra keys exist only for the Store per-feature case, so every other result keeps its exact shape.
  return evaluation.proScope === 'features_until'
    ? { ...base, proScope: evaluation.proScope, proFeatures: evaluation.proFeatures }
    : base;
}

/** First configured store's validated product page (Gumroad first), or null. No network call. */
function statusPurchaseUrl(c) {
  const urls = { gumroad: c.storeConfig.GUMROAD_PURCHASE_URL, lemonsqueezy: c.storeConfig.LEMON_SQUEEZY_PURCHASE_URL };
  for (const s of STORES) {
    const url = urls[s.id];
    if (typeof url === 'string' && url !== '' && s.isConfigured(c.storeConfig)) return url;
  }
  return null;
}

/** The LicenseStatus body for one evaluation and the notice flags that belong to it. */
function statusBody(c, evaluation, noticeFlags) {
  const support = c.storeConfig.SUPPORT_CONTACT;
  return {
    ...toStatus(evaluation, { buildInfo: c.buildInfo, version: getAppVersion(), noticeFlags }),
    stores: STORES.map((s) => ({ id: s.id, label: s.label, configured: s.isConfigured(c.storeConfig) })),
    purchaseUrl: statusPurchaseUrl(c),
    supportContact: typeof support === 'string' && support.trim() !== '' ? support.trim() : null,
  };
}

/** @returns {object} the GET /api/license body (LicenseStatus, docs/LICENSING.md 10.1) */
export function getLicenseStatus() {
  const c0 = ensure();
  // Retries a trial start that failed at launch (and keeps the notice flags in step with the trial).
  reconcileTrial(c0);
  const { c, evaluation, noticeFlags } = evaluate();
  return statusBody(c, evaluation, noticeFlags);
}

/** One activation or deactivation at a time per process. The flag is set before any await. */
async function exclusive(c, work) {
  if (c.busy) throw fail(c, 'activation_in_progress');
  c.busy = true;
  try {
    return await work();
  } finally {
    c.busy = false;
  }
}

/** Turns the `license` network feature on (the click is the opt-in) and asserts it. */
async function openNetwork(c) {
  try {
    await setNetworkFeature('license', true);
    await assertNetworkEnabled('license');
  } catch {
    throw fail(c, 'activation_write_failed');
  }
}

function wrapStoreError(c, err, store, op) {
  const code = err instanceof StoreError && STORE_ERROR_STATUS[err.code] ? err.code : 'store_error';
  c.log(op === 'activate' ? `license: activation failed (${code})` : `license: deactivation failed (${code})`);
  return fail(c, code, { store, op });
}

function pickStore(c, licenseKey, storeId) {
  if (typeof licenseKey !== 'string' || (storeId !== undefined && storeId !== null && !getStore(storeId))) {
    throw fail(c, 'invalid_request');
  }
  if (storeId !== undefined && storeId !== null) {
    const named = getStore(storeId);
    const key = licenseKey.length > MAX_KEY_INPUT_CHARS ? '' : named.normalizeKey(licenseKey);
    if (!named.matchesKey(key)) throw fail(c, 'invalid_key_format', { store: named });
    return { store: named, key };
  }
  const id = detectStore(licenseKey);
  if (id === null) throw fail(c, 'invalid_key_format');
  const store = getStore(id);
  return { store, key: store.normalizeKey(licenseKey) };
}

/**
 * Activates a store license key (docs/LICENSING.md 4.1). The only function that asks a store to verify a key.
 * @param {{ licenseKey: unknown, store?: string }} input
 * @returns {Promise<object>} LicenseStatus
 * @throws {LicenseError}
 */
export async function activateLicense({ licenseKey, store: storeId } = {}) {
  const c = ensure();
  return exclusive(c, async () => {
    const { store, key } = pickStore(c, licenseKey, storeId);
    if (!store.isConfigured(c.storeConfig)) throw fail(c, 'store_not_configured', { store });
    if (!c.activationStore.hasKey()) throw fail(c, 'activation_write_failed');

    const hash = c.activationStore.keyHash(store.id, key);
    if (c.activation.kind === 'active' && c.activation.record.store === store.id && c.activation.record.keyHash === hash) {
      return getLicenseStatus();
    }

    await openNetwork(c);
    const baseUrl = storeBaseUrl(store.id, c.env, { log: c.log });
    const overridden = baseUrl !== STORE_ORIGINS[store.id];
    let result;
    try {
      result = await store.activate({
        key,
        fetchImpl: c.fetchImpl,
        config: c.storeConfig,
        allowTest: c.allowTest(),
        baseUrl,
      });
    } catch (err) {
      throw wrapStoreError(c, err, store, 'activate');
    }

    const clock = observeClock(c);
    const { updatesUntilMs, expiresAtMs } = computeTerms(result);
    if (YEARLY_EDITIONS.includes(result.edition)) {
      if (expiresAtMs <= clock.effective) {
        throw fail(c, 'license_expired', { store, detail: { endedAt: formatLicenseDate(expiresAtMs) } });
      }
      if (expiresAtMs <= result.purchaseDateMs) throw fail(c, 'store_error', { store });
    }

    const record = c.activationStore.save({
      store: store.id,
      productId: result.productId,
      variantId: result.variantId,
      edition: result.edition,
      purchaseDate: formatLicenseDate(result.purchaseDateMs),
      updatesUntil: formatLicenseDate(updatesUntilMs),
      expiresAt: expiresAtMs === null ? null : formatLicenseDate(expiresAtMs),
      // Bounded: a wall clock far in the future must not make this record outrank a later tombstone.
      activatedAt: formatLicenseDate(Math.min(clock.effective, clock.hwm + ROLLBACK_TOLERANCE_MS)),
      keyHash: hash,
      keyLast4: key.slice(-4),
      email: result.email,
      instanceId: result.instanceId,
      test: result.test === true || overridden,
    });
    if (!record) throw fail(c, 'activation_write_failed');

    // A stale key secret must never outlive the activation it belonged to.
    const secretOpts = { dataDir: c.dataDir, env: c.env, getDb: c.getDb };
    await clearLicenseKey(secretOpts);
    if (result.retainKey) await saveLicenseKey({ ...secretOpts, key, last4: record.keyLast4, now: c.now });

    c.activation = { kind: 'active', record };
    observeClock(c);
    return getLicenseStatus();
  });
}

/**
 * Releases this computer's Lemon Squeezy activation ("Move to another computer", docs/LICENSING.md 10.3).
 * @param {{ licenseKey?: unknown }} [input]
 * @returns {Promise<object>} LicenseStatus
 * @throws {LicenseError}
 */
export async function deactivateLicense({ licenseKey } = {}) {
  const c = ensure();
  return exclusive(c, async () => {
    if (licenseKey !== undefined && licenseKey !== null && typeof licenseKey !== 'string') throw fail(c, 'invalid_request');
    if (c.activation.kind !== 'active') throw fail(c, 'nothing_to_deactivate');
    const { record } = c.activation;
    const store = getStore(record.store);
    if (!store?.canDeactivate) throw fail(c, 'deactivate_unsupported', { store });

    const secretOpts = { dataDir: c.dataDir, env: c.env, getDb: c.getDb };
    let key = await loadLicenseKey(secretOpts);
    // A saved key that no longer matches the record (a failed secret write after a different key) is not trusted.
    if (key !== null && c.activationStore.keyHash(store.id, key) !== record.keyHash) key = null;
    if (key === null) {
      if (typeof licenseKey !== 'string' || licenseKey === '') throw fail(c, 'license_key_needed', { store });
      const typed = licenseKey.length > MAX_KEY_INPUT_CHARS ? '' : store.normalizeKey(licenseKey);
      if (c.activationStore.keyHash(store.id, typed) !== record.keyHash) throw fail(c, 'key_mismatch', { store });
      key = typed;
    }

    await openNetwork(c);
    try {
      await store.deactivate({
        key,
        instanceId: record.instanceId,
        fetchImpl: c.fetchImpl,
        baseUrl: storeBaseUrl(store.id, c.env, { log: c.log }),
      });
    } catch (err) {
      throw wrapStoreError(c, err, store, 'deactivate');
    }

    const cleared = c.activationStore.clear(clearStampOf(c));
    // The store already released this computer: Pro must not stay on in memory when the local clear failed.
    c.activation = { kind: 'none' };
    if (!cleared) {
      c.log('license: deactivated at the store but the local record could not be cleared');
      throw fail(c, 'activation_write_failed', { store });
    }
    await clearLicenseKey(secretOpts);
    return getLicenseStatus();
  });
}

/**
 * "Remove from this computer": no network, idempotent. Keeps the clock and trial records.
 * @returns {Promise<object>} LicenseStatus
 * @throws {LicenseError} 409 activation_in_progress, 500 activation_write_failed when no copy could be written
 */
export async function removeLicense() {
  const c = ensure();
  return exclusive(c, async () => {
    if (c.activation.kind !== 'none') {
      if (!c.activationStore.clear(clearStampOf(c))) throw fail(c, 'activation_write_failed');
      c.activation = { kind: 'none' };
    }
    await clearLicenseKey({ dataDir: c.dataDir, env: c.env, getDb: c.getDb });
    return getLicenseStatus();
  });
}

/**
 * Marks one trial notice as shown and dismissed for the current trial (ending_soon also marks welcome,
 * ended marks all three). No valid trial: nothing to mark. No network.
 * @param {unknown} notice 'welcome' | 'ending_soon' | 'ended'
 * @returns {object} LicenseStatus
 * @throws {LicenseError} 400 invalid_request
 */
export function dismissTrialNotice(notice) {
  const c = ensure();
  if (typeof notice !== 'string' || !TRIAL_NOTICE_NAMES.includes(notice)) throw fail(c, 'invalid_request');
  reconcileTrial(c);
  const o = devInputs(c);
  if (o) {
    // A developer override has its own notice flags; the real trial notice row is never touched.
    try {
      o.saveNotices(applyDismiss(o.notices, notice));
    } catch {
      // best effort, like the real notice flags
    }
  } else if (c.trial.kind === 'valid' && c.notices?.startedAt === c.trial.startedAt) {
    const flags = applyDismiss(c.notices.flags, notice);
    c.notices = { startedAt: c.trial.startedAt, flags };
    c.noticeStore.save(c.trial.startedAt, flags);
  }
  return getLicenseStatus();
}

/** Pure: the flags after dismissing one notice (ending_soon also marks welcome, ended marks all three). */
function applyDismiss(flags, notice) {
  const next = { ...flags };
  if (notice === 'welcome') next.welcome = true;
  if (notice === 'ending_soon') Object.assign(next, { welcome: true, endingSoon: true });
  if (notice === 'ended') Object.assign(next, { welcome: true, endingSoon: true, ended: true });
  return next;
}

/**
 * @typedef {object} LicenseDevHook
 * @property {(ctx: { env: object, now: () => number, getDb?: Function, log: (m: string) => void, buildDate: number | null }) => null | {
 *   activation: object, trial: object, clock: object, rejectTestRecords?: boolean,
 *   notices: { welcome: boolean, endingSoon: boolean, ended: boolean }, saveNotices: (flags: object) => void, override?: object,
 * }} inputs synthetic evaluator inputs, or null for "no override"
 * @property {() => void} [reset] called by initLicense() and resetLicenseForTests()
 */

/** @type {null | LicenseDevHook} */
let devHook = null;

function resetDevHook() {
  try {
    devHook?.reset?.();
  } catch {
    // a hook must never fail startup
  }
}

// The facade a dev extension gets back from installLicenseDevHook: the minimum it needs to read and (for the trial
// utilities only) change the real records, without exposing the context object.
const devAccess = Object.freeze({
  /** Non-secret facts and seams of the running license context. */
  context() {
    const c = ensure();
    return { dataDir: c.dataDir, env: c.env, now: c.now, getDb: c.getDb, loadKey: c.loadKey, log: c.log, buildInfo: c.buildInfo, autoStartTrial: c.autoStartTrial };
  },
  /** The effective LicenseStatus (what GET /api/license answers). */
  status: () => getLicenseStatus(),
  /** The real status (no override) and the clock it was evaluated with. */
  realStatus() {
    const c = ensure();
    const { clock, evaluation } = evaluateReal(c);
    return { status: statusBody(c, evaluation, c.notices?.flags ?? null), clock };
  },
  /** The stored activation, trial record and trial notices as the context holds them. */
  records() {
    const c = ensure();
    return { activation: c.activation, trial: c.trial, notices: c.notices };
  },
  /** The active override as the hook reports it, or null. */
  override: () => devInputs(ensure())?.override ?? null,
  observeClock: () => observeClock(ensure()),
  reconcileTrial: () => reconcileTrial(ensure()),
  /** Replaces the real trial notice flags of a valid trial. @returns {boolean} false when there is no valid trial */
  setRealTrialNotices(flags) {
    const c = ensure();
    if (c.trial.kind !== 'valid') return false;
    c.notices = { startedAt: c.trial.startedAt, flags: { ...flags } };
    c.noticeStore.save(c.trial.startedAt, c.notices.flags);
    return true;
  },
  /** Drops the in-memory trial record and notices (after the stored copies were deleted). */
  forgetTrial() {
    const c = ensure();
    c.trial = { kind: 'none' };
    c.notices = null;
  },
  /** Reads the trial record back from its stores. @returns {object} the trial record */
  reloadTrial() {
    const c = ensure();
    c.trial = c.trialStore.load();
    return c.trial;
  },
  fail: (code) => fail(ensure(), code),
});

/**
 * The only entry point of the developer tier switcher. A hook feeds preset inputs to the same pure evaluators.
 * @param {LicenseDevHook | null} hook `null` uninstalls; a new hook replaces an earlier one
 * @returns {typeof devAccess | null} null (and nothing is installed) when the developer tools are compiled out
 */
export function installLicenseDevHook(hook) {
  if (!devToolsCompiledIn()) return null;
  devHook = hook ?? null;
  return devHook ? devAccess : null;
}

export function resetLicenseForTests() {
  ctx = null;
  resetDevHook();
}
