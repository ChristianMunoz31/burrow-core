import { useCallback } from 'react';
import { useSyncedSetting } from './useSyncedSetting';

const DEFAULT_CARD = { w: 1, h: 1, hidden: false };
const NO_KEYS = [];
const NO_OPTIONS = {};

// The cards a Home never customized starts with hidden, as a fresh `cards` object.
function seedCards(defaultHidden) {
  return Object.fromEntries(defaultHidden.map((k) => [k, { hidden: true }]));
}

// Merge a saved layout with the canonical key list: keep saved ordering for keys
// that still exist, append any new keys (in their declared order), drop removed ones (an old
// `weather` card, for one). A new key listed in `firstKeys` goes in front instead of at the end
// (the Javi card); once the layout is saved with it, the user's order for it is kept.
// With no saved layout the default-hidden cards are seeded in memory only (never written on
// mount: `pos:homeLayout` is user data for the direct import's unused-database check).
function normalize(layout, allKeys, defaultHidden, firstKeys = NO_KEYS) {
  if (!layout || typeof layout !== 'object') return { order: [...allKeys], cards: seedCards(defaultHidden) };
  const savedOrder = Array.isArray(layout?.order) ? layout.order : [];
  const added = allKeys.filter((k) => !savedOrder.includes(k));
  const order = [
    ...added.filter((k) => firstKeys.includes(k)),
    ...savedOrder.filter((k) => allKeys.includes(k)),
    ...added.filter((k) => !firstKeys.includes(k)),
  ];
  const cards = typeof layout.cards === 'object' && layout.cards ? layout.cards : {};
  return { order, cards };
}

/**
 * Home dashboard layout (order + per-card width/height/hidden), persisted to
 * the database via the synced app_state store with a localStorage cache.
 * `allKeys`, `defaultHidden` and `options` must be stable references (module-level constants).
 * `defaultHidden` lists the cards hidden while no layout is stored; a stored layout is used as is.
 * `options.firstKeys`: cards a saved layout without them gets at the top; `options.cardDefaults`: per-card
 * defaults over `{ w: 1, h: 1, hidden: false }` (a saved entry still wins); `options.storageKey`: the synced
 * setting that holds the layout (default `pos:homeLayout`).
 */
export function useHomeLayout(allKeys, defaultHidden = NO_KEYS, options = NO_OPTIONS) {
  const { firstKeys = NO_KEYS, cardDefaults = NO_OPTIONS, storageKey = 'pos:homeLayout' } = options;
  const [raw, setSynced, meta] = useSyncedSetting(storageKey, null);
  // No edit before the stored layout has been fetched: with no local cache the updater would start from
  // the fallback null (seeded defaults) and the PUT would replace the user's saved layout.
  const ready = meta?.isFetched === true;
  const setRaw = useCallback((next) => (ready ? setSynced(next) : undefined), [ready, setSynced]);
  const { order, cards } = normalize(raw, allKeys, defaultHidden, firstKeys);

  const cardFor = useCallback(
    (key) => ({ ...DEFAULT_CARD, ...(cardDefaults[key] || {}), ...(cards[key] || {}) }),
    [cards, cardDefaults],
  );

  const orderKeys = useCallback(
    (visibleKeys) => order.filter((k) => visibleKeys.includes(k)),
    [order],
  );

  // `change(cur)` returns the patch for one card. It runs inside the updater on the latest saved layout,
  // so two quick activations compound instead of both reading the same render's card.
  const patchCard = useCallback(
    (key, change) => {
      setRaw((prev) => {
        const n = normalize(prev, allKeys, defaultHidden, firstKeys);
        const cur = { ...DEFAULT_CARD, ...(cardDefaults[key] || {}), ...(n.cards[key] || {}) };
        return { order: n.order, cards: { ...n.cards, [key]: { ...cur, ...change(cur) } } };
      });
    },
    [setRaw, allKeys, defaultHidden, firstKeys, cardDefaults],
  );

  const cycleWidth = useCallback((key) => patchCard(key, (cur) => ({ w: (cur.w % 3) + 1 })), [patchCard]);
  const toggleHeight = useCallback((key) => patchCard(key, (cur) => ({ h: cur.h === 2 ? 1 : 2 })), [patchCard]);
  const toggleHidden = useCallback((key) => patchCard(key, (cur) => ({ hidden: !cur.hidden })), [patchCard]);

  const reorder = useCallback(
    (newDisplayedOrder) => {
      setRaw((prev) => {
        const n = normalize(prev, allKeys, defaultHidden, firstKeys);
        const moved = new Set(newDisplayedOrder);
        let i = 0;
        // Each slot that held a displayed key takes the next key of the new order; every other
        // slot (hidden cards) is kept.
        const order = n.order.map((k) => (moved.has(k) ? newDisplayedOrder[i++] : k));
        return { order, cards: n.cards };
      });
    },
    [setRaw, allKeys, defaultHidden, firstKeys],
  );

  const reset = useCallback(
    () => setRaw({ order: [...allKeys], cards: seedCards(defaultHidden) }),
    [setRaw, allKeys, defaultHidden],
  );

  return { ready, order, cardFor, orderKeys, cycleWidth, toggleHeight, toggleHidden, reorder, reset };
}
