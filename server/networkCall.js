// Names-only audit row for one outbound call: the netPolicy feature id and the host, nothing else.
// The URL (path, query), headers, bodies, keys and prompts are never passed on. This file imports
// only the audit hook at load time, so any module can use it. The feature list from netPolicy is loaded on first use.
// The reader is server/networkAudit.js.
//
// One row means one feature use, not one HTTP request. A feature that needs several requests
// (for example the Oura fetch of four collections, each with pages) writes a single row.
//
// Result rule, the same for every writer: `ok` means the server answered with a 2xx or 3xx status.
// `error` (shown as "failed") means an HTTP 4xx or 5xx status, a thrown error or a timeout.
// Use statusFromHttp(code) for a response and pass 'error' yourself when nothing came back.
import { recordAudit } from './auditHook.js';

export const NETWORK_CALL_FEATURE = 'network_call';
export const HOST_RE = /^[A-Za-z0-9.-]{1,100}(?::\d{1,5})?$/;
export const NETWORK_COALESCE_MS = 15 * 60 * 1000;
export const MODEL_PULL_FEATURE = 'model_pull';

let featureIdCheck = null;
/** Loads netPolicy's isFeatureId on first use (netPolicy reaches the database, which this file must not load eagerly). */
async function loadFeatureIdCheck() {
  if (!featureIdCheck) featureIdCheck = (await import('./netPolicy.js')).isFeatureId;
  return featureIdCheck;
}

/** True for a feature id the activity list can show: a netPolicy feature, or `model_pull`. */
async function isAuditableFeature(feature) {
  return feature === MODEL_PULL_FEATURE || (await loadFeatureIdCheck())(feature);
}

/**
 * The shared result rule: 2xx and 3xx are `ok`, everything else (4xx, 5xx, no number) is `error`.
 * @param {unknown} httpStatus
 * @returns {'ok' | 'error'}
 */
export function statusFromHttp(httpStatus) {
  const code = Number(httpStatus);
  return Number.isInteger(code) && code >= 200 && code < 400 ? 'ok' : 'error';
}

/** Host only: no scheme, path, query or credentials. Null when the input has no usable host. */
function hostOnly(input) {
  try {
    const raw = String(input);
    const { hostname } = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return HOST_RE.test(hostname) ? hostname : null;
  } catch {
    return null;
  }
}

/**
 * Record one outbound call. Never throws. Anything that is not a netPolicy feature id (or
 * `model_pull`) is dropped.
 * @param {string} feature a netPolicy feature id (for example `weather`)
 * @param {string} url the address that was called; only its host is stored
 * @param {'ok' | 'error'} status
 * @param {{ result?: 'started', by?: 'app' }} [extra] the only two optional markers, allowlisted values only:
 *   `result: 'started'` (a handoff whose outcome the server cannot see) and `by: 'app'` (the call is made by the
 *   Burrow app itself, not by the local server). Anything else is dropped.
 * @returns {Promise<void>}
 */
export async function recordNetworkCall(feature, url, status, extra = {}) {
  try {
    const host = hostOnly(url);
    if (!host || !(await isAuditableFeature(feature))) return;
    const meta = { net_feature: feature, net_host: host };
    if (extra?.result === 'started') meta.net_result = 'started';
    if (extra?.by === 'app') meta.net_by = 'app';
    await recordAudit({
      kind: 'export',
      feature: NETWORK_CALL_FEATURE,
      status: status === 'error' ? 'error' : 'ok',
      meta,
    });
  } catch {
    // best-effort: auditing must never break the caller
  }
}

const lastCoalesced = new Map();

/**
 * Like recordNetworkCall, but writes at most one row per feature and host every
 * NETWORK_COALESCE_MS in this process. For repeated background probes.
 * @param {string} feature
 * @param {string} url
 * @param {'ok' | 'error'} status
 * @param {{ now?: number }} [opts]
 * @returns {Promise<void>}
 */
export async function recordNetworkCallCoalesced(feature, url, status, { now = Date.now() } = {}) {
  try {
    const host = hostOnly(url);
    if (!host || !(await isAuditableFeature(feature))) return;
    const key = `${feature}|${host}`;
    const last = lastCoalesced.get(key);
    if (last !== undefined && now - last < NETWORK_COALESCE_MS) return;
    lastCoalesced.set(key, now);
    await recordNetworkCall(feature, host, status);
  } catch {
    // best-effort: auditing must never break the caller
  }
}

/** Tests only: forget the coalescing clock. */
export function __resetNetworkCoalesceForTests() {
  lastCoalesced.clear();
}
