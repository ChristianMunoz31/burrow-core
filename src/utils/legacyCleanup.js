import { lsKey } from './storageKeys';

// Browser-storage cleanup of data written by features that no longer exist. It is versioned:
// each version's removals run once, then the completed version is stored so later startups
// skip the work. To retire more keys, add a new version below and raise CURRENT_VERSION.
const VERSION_KEY = 'legacyCleanup.version';
const CURRENT_VERSION = 2;

// v1: agent team, UI/Interface builders, survey builder, device-only sync mode, unused keys.
const V1_KEYS = ['agents.runs', 'builder.theme', 'builder.custombase', 'survey-builder', 'storage:syncMode', 'settings', 'focus'];

// v2: the removed Chat page. `burrow.gpts` (personas), `burrow.conv-index`, `burrow.conv:<id>`
// (conversation bodies) and `burrow.pos:gpts` (cache of the saved personas).
const V2_KEYS = ['gpts', 'conv-index', 'pos:gpts'];
const V2_PREFIXES = ['conv:'];

function readVersion() {
  try {
    const n = Number(localStorage.getItem(lsKey(VERSION_KEY)));
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function removeKeys(keys) {
  for (const key of keys) {
    try {
      localStorage.removeItem(lsKey(key));
    } catch {
      /* storage unavailable: nothing to clean */
    }
  }
}

function removePrefixed(prefixes) {
  const doomed = [];
  try {
    const wanted = prefixes.map((p) => lsKey(p));
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (typeof key === 'string' && wanted.some((p) => key.startsWith(p))) doomed.push(key);
    }
  } catch {
    return;
  }
  for (const key of doomed) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }
}

/** Best-effort, once-per-version removal of retired localStorage keys. Never throws. */
export function removeLegacyStorage() {
  try {
    if (readVersion() >= CURRENT_VERSION) return;
    removeKeys(V1_KEYS);
    removeKeys(V2_KEYS);
    removePrefixed(V2_PREFIXES);
    localStorage.setItem(lsKey(VERSION_KEY), String(CURRENT_VERSION));
  } catch {
    /* storage unavailable: try again next start */
  }
}
