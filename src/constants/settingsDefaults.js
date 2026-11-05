// Single source of truth for user-facing settings: storage keys, defaults, allowed
// values and normalizers. Every setting is persisted through useSyncedSetting
// (localStorage cache + the database's app_state table), so these keys are generic key/value.
// An unknown stored value always normalizes back to the default.
//
// storage:* keys are device-local bookkeeping (the pending-save list). Never
// pass them to useSyncedSetting; they are read/written via utils/syncMode.js only.

import { JAVI_CHARACTERS } from './javiCharacters.js';

export const SETTINGS_KEYS = {
  theme: 'theme',
  bgDark: 'appearance:bgDark',
  bgLight: 'appearance:bgLight',
  budgetView: 'budget:defaultView',
  budgetMonth: 'budget:defaultMonth',
  mode: 'mode',
  pendingSync: 'storage:pendingSync',
  javiAdvisorButton: 'javi:advisorButton',
  javiAutoAdvise: 'javi:autoAdvise',
  navHideSubcategories: 'nav:hideSubcategories',
  javiCharacter: 'javi:character',
};

export const SETTINGS_DEFAULTS = {
  theme: 'system',
  bgDark: 'aurora',
  bgLight: 'aurora',
  budgetView: 'dashboard',
  budgetMonth: 'current',
  mode: 'all',
  javiAdvisorButton: true,
  javiAutoAdvise: true,
  navHideSubcategories: false,
  javiCharacter: 'butler',
};

const THEME_PREFERENCES = ['system', 'light', 'dark'];
const BUDGET_VIEWS = ['dashboard', 'planner'];
const BUDGET_MONTH_MODES = ['current', 'latest'];

// Presets must match the --mesh-<id>-<theme>-<n> vars and swatch rules in
// index.css, and the pre-paint whitelist in the inline script in index.html.
export const BACKGROUND_PRESETS = [
  { id: 'aurora', label: 'Aurora', description: 'Warm amber, indigo and teal glow (default)' },
  { id: 'ocean', label: 'Ocean', description: 'Cool blues and cyan' },
  { id: 'sunset', label: 'Sunset', description: 'Coral, magenta and amber' },
  { id: 'forest', label: 'Forest', description: 'Greens and teal' },
  { id: 'graphite', label: 'Graphite', description: 'Neutral gray, no color' },
  { id: 'solid', label: 'Solid', description: 'Flat background, no gradient' },
];

export const BACKGROUND_PRESET_IDS = BACKGROUND_PRESETS.map((p) => p.id);

// Paid perk of a Founding license (docs/LICENSING.md section 11). Deliberately not in
// BACKGROUND_PRESETS: the picker only lists it while it is unlocked. It still needs the
// --mesh-founder-* vars in index.css and the pre-paint whitelist in index.html.
export const FOUNDER_BACKGROUND = {
  id: 'founder',
  label: 'Founder',
  description: 'Purple and gold, for founding members',
};

function pick(allowed, fallback) {
  return (value) => (allowed.includes(value) ? value : fallback);
}

const pickBoolean = (fallback) => (value) => (typeof value === 'boolean' ? value : fallback);

export const normalizeJaviAdvisorButton = pickBoolean(SETTINGS_DEFAULTS.javiAdvisorButton);
export const normalizeJaviAutoAdvise = pickBoolean(SETTINGS_DEFAULTS.javiAutoAdvise);
export const normalizeNavHideSubcategories = pickBoolean(SETTINGS_DEFAULTS.navHideSubcategories);

const JAVI_CHARACTER_IDS = JAVI_CHARACTERS.map((c) => c.id);
export const normalizeJaviCharacter = pick(JAVI_CHARACTER_IDS, SETTINGS_DEFAULTS.javiCharacter);

export const normalizeThemePreference = pick(THEME_PREFERENCES, SETTINGS_DEFAULTS.theme);
export const normalizeBackground = pick(
  [...BACKGROUND_PRESET_IDS, FOUNDER_BACKGROUND.id],
  SETTINGS_DEFAULTS.bgDark,
);

/**
 * The background to apply for a saved preference. A saved Founder background is applied
 * only when the founder perk is on. Once the license status is known, the real flag
 * decides. While it is unknown (loading, error, before login), `cachedFounder` (the last
 * known flag from utils/founderPerkCache.js, false when never cached) decides, so a
 * non-founder never sees Founder flash at load. Otherwise `fallback` is used.
 * The saved preference itself is never changed.
 */
export function resolveBackground(
  pref,
  { known, founderBackground },
  fallback,
  cachedFounder = false,
) {
  if (pref !== FOUNDER_BACKGROUND.id) return pref;
  const unlocked = known ? founderBackground : cachedFounder;
  return unlocked ? pref : fallback;
}
export const normalizeBudgetView = pick(BUDGET_VIEWS, SETTINGS_DEFAULTS.budgetView);
export const normalizeBudgetMonthMode = pick(BUDGET_MONTH_MODES, SETTINGS_DEFAULTS.budgetMonth);
