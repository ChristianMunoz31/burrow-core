// Outbound-network opt-in. Every feature that calls a third-party host (other than an
// local Ollama on this machine) is OFF until the user turns it on in
// Settings → Network, or pre-enables it with BURROW_NETWORK_OPTIN=weather,oura,...
//
// State is persisted in app_state under `network.optIn` as { [featureId]: boolean }.
// A stored value wins over the env default; when storage is unavailable only the env
// default applies.
import { getState, setState } from './dataAccess.js';
import { NETWORK_FEATURES } from './netFeatures.js';

export { NETWORK_FEATURES };

export const NETWORK_STATE_KEY = 'network.optIn';
const CACHE_TTL_MS = 30_000;
const FAILURE_TTL_MS = 5_000;

const BY_ID = new Map(NETWORK_FEATURES.map((f) => [f.id, f]));

/** @param {unknown} id */
export const isFeatureId = (id) => typeof id === 'string' && BY_ID.has(id);

const envDefaults = (env = process.env) =>
  new Set(
    (env.BURROW_NETWORK_OPTIN || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => BY_ID.has(s)),
  );

let cache = null; // { stored: Record<string, boolean>, until: number }

const sanitizeStored = (raw) => {
  const out = {};
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const f of NETWORK_FEATURES) if (typeof raw[f.id] === 'boolean') out[f.id] = raw[f.id];
  }
  return out;
};

async function loadStored() {
  if (cache && Date.now() < cache.until) return cache.stored;
  try {
    const stored = sanitizeStored(await getState(NETWORK_STATE_KEY, null));
    cache = { stored, until: Date.now() + CACHE_TTL_MS };
    return stored;
  } catch {
    // Storage unavailable: fall back to the env default, retry shortly.
    cache = { stored: {}, until: Date.now() + FAILURE_TTL_MS };
    return {};
  }
}

/**
 * Whether a feature may call the internet right now. Never throws.
 * @param {string} id one of the NETWORK_FEATURES ids
 * @returns {Promise<boolean>}
 */
export async function isEnabled(id) {
  if (!BY_ID.has(id)) return false;
  const stored = await loadStored();
  return id in stored ? stored[id] : envDefaults().has(id);
}

/**
 * The settings payload: every feature with its effective state, in fixed order.
 * @returns {Promise<{ features: Array<{ id: string, enabled: boolean, label: string, description: string, hosts: string[] }> }>}
 */
export async function listNetworkFeatures() {
  const stored = await loadStored();
  const defaults = envDefaults();
  return {
    features: NETWORK_FEATURES.map((f) => ({
      id: f.id,
      enabled: f.id in stored ? stored[f.id] : defaults.has(f.id),
      label: f.label,
      description: f.description,
      hosts: [...f.hosts],
    })),
  };
}

/**
 * Persist one feature's opt-in. Throws when storage is unavailable.
 * @param {string} id
 * @param {boolean} enabled
 */
export async function setNetworkFeature(id, enabled) {
  if (!BY_ID.has(id)) throw new Error('Unknown network feature');
  const current = sanitizeStored(await getState(NETWORK_STATE_KEY, null));
  const next = { ...current, [id]: enabled };
  await setState(NETWORK_STATE_KEY, next);
  cache = { stored: next, until: Date.now() + CACHE_TTL_MS };
}

/** The 403 body returned when a gated-off feature is called. */
export function networkRequiredBody(id) {
  const feature = BY_ID.get(id);
  return {
    error: 'network_opt_in_required',
    feature: id,
    message: `${feature ? feature.label : id} is turned off. Enable it in Settings → Network (this calls the internet).`,
  };
}

/** Thrown by library code (not routes) when a gated-off feature is invoked. */
export class NetworkOptInError extends Error {
  /** @param {string} id */
  constructor(id) {
    super(networkRequiredBody(id).message);
    this.name = 'NetworkOptInError';
    this.status = 403;
    this.feature = id;
  }
}

/**
 * Throws NetworkOptInError unless the feature is enabled.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function assertNetworkEnabled(id) {
  if (!(await isEnabled(id))) throw new NetworkOptInError(id);
}

/**
 * Express middleware: 403 network_opt_in_required while the feature is off.
 * @param {string} id
 * @returns {import('express').RequestHandler}
 */
export function requireNetwork(id) {
  return async (req, res, next) => {
    try {
      if (await isEnabled(id)) return next();
      res.set('Cache-Control', 'no-store');
      return res.status(403).json(networkRequiredBody(id));
    } catch (err) {
      return next(err);
    }
  };
}

/** Drops the cached opt-in state (after the erase-all-data service emptied app_state). */
export function invalidateNetPolicyCache() {
  cache = null;
}

/** Test hook: drop the cached opt-in state. */
export function __resetNetPolicyForTests() {
  cache = null;
}
