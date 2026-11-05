import { SETTINGS_KEYS } from '../constants/settingsDefaults';
import { stateService } from '../services/stateService';
import { lsKey } from './storageKeys';

// Device-local cache helpers and the list of keys whose save to the data file has not
// completed yet. Plain module (no React) so useSyncedSetting and the app-load flush share
// it. Tolerates legacy raw (non-JSON) values so existing `theme`/`mode` strings survive.

const MAX_FLUSH_ATTEMPTS = 3;
const MAX_FLUSH_PASSES = 3;

export function readLocal(key) {
  try {
    const raw = localStorage.getItem(lsKey(key));
    if (raw == null) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  } catch {
    return undefined;
  }
}

/** Returns true when the value was persisted, false on quota/unavailable storage. */
export function writeLocal(key, value) {
  try {
    localStorage.setItem(lsKey(key), JSON.stringify(value));
    return true;
  } catch {
    /* quota or unavailable — the database still holds the durable copy */
    return false;
  }
}

/** Raw localStorage string for a key; `undefined` when storage itself throws. */
export function readRaw(key) {
  try {
    return localStorage.getItem(lsKey(key));
  } catch {
    return undefined;
  }
}

export function getPendingKeys() {
  try {
    const parsed = JSON.parse(localStorage.getItem(lsKey(SETTINGS_KEYS.pendingSync)));
    return Array.isArray(parsed) ? parsed.filter((k) => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

function savePendingKeys(keys) {
  try {
    localStorage.setItem(lsKey(SETTINGS_KEYS.pendingSync), JSON.stringify(keys));
  } catch {
    /* storage unavailable */
  }
}

export function markDirty(key) {
  const keys = getPendingKeys();
  if (!keys.includes(key)) savePendingKeys([...keys, key]);
}

export function clearDirty(key) {
  const keys = getPendingKeys();
  if (keys.includes(key)) savePendingKeys(keys.filter((k) => k !== key));
}

export function isDirty(key) {
  return getPendingKeys().includes(key);
}

let inflightFlush = null;

// Pushes one key. Resolves 'pushed' | 'skipped' | 'failed'.
async function flushKey(key, put) {
  for (let attempt = 0; attempt < MAX_FLUSH_ATTEMPTS; attempt += 1) {
    const raw = readRaw(key);
    if (raw === undefined) return 'failed';
    if (raw === null) {
      // Nothing stored locally (e.g. a quota-failed write): never PUT null over the stored copy.
      clearDirty(key);
      return 'skipped';
    }
    try {
      await put(key, readLocal(key));
    } catch {
      return 'failed';
    }
    // Local wins: only clear once the value did not change while the PUT ran.
    if (readRaw(key) === raw) {
      clearDirty(key);
      return 'pushed';
    }
  }
  return 'failed';
}

async function runFlush(queryClient, put) {
  let pushed = 0;
  let failed = 0;
  const attempted = new Set();
  // Bounded extra passes pick up keys dirtied after the first snapshot.
  for (let pass = 0; pass < MAX_FLUSH_PASSES; pass += 1) {
    const keys = getPendingKeys().filter((k) => !attempted.has(k));
    if (keys.length === 0) break;
    for (const key of keys) {
      attempted.add(key);
      const outcome = await flushKey(key, put);
      if (outcome === 'pushed') pushed += 1;
      else if (outcome === 'failed') failed += 1;
    }
  }
  void queryClient.invalidateQueries({ queryKey: ['state'] });
  return { pushed, failed };
}

/**
 * Pushes every key whose save did not complete up to the data file (local wins), then
 * invalidates the state queries so untouched keys re-download. Concurrent calls
 * share one in-flight run. Resolves `{ pushed, failed }`; failed keys stay dirty.
 */
export function flushPendingSync(queryClient, { put = stateService.put } = {}) {
  if (!inflightFlush) {
    inflightFlush = runFlush(queryClient, put).finally(() => {
      inflightFlush = null;
    });
  }
  return inflightFlush;
}
