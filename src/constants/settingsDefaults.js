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
// index.css, and the pre-paint whitelist in the inline script in index.html. The 'founder' id is kept so
// settings saved earlier keep working; it is a normal choice for everyone.
export const BACKGROUND_PRESETS = [
  { id: 'aurora', label: 'Aurora', description: 'Warm amber, indigo and teal glow (default)' },
  { id: 'ocean', label: 'Ocean', description: 'Cool blues and cyan' },
  { id: 'sunset', label: 'Sunset', description: 'Coral, magenta and amber' },
  { id: 'forest', label: 'Forest', description: 'Greens and teal' },
  { id: 'graphite', label: 'Graphite', description: 'Neutral gray, no color' },
  { id: 'solid', label: 'Solid', description: 'Flat background, no gradient' },
  { id: 'founder', label: 'Purple and gold', description: 'Deep purple with gold accents' },
];

export const BACKGROUND_PRESET_IDS = BACKGROUND_PRESETS.map((p) => p.id);

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
export const normalizeBackground = pick(BACKGROUND_PRESET_IDS, SETTINGS_DEFAULTS.bgDark);
export const normalizeBudgetView = pick(BUDGET_VIEWS, SETTINGS_DEFAULTS.budgetView);
export const normalizeBudgetMonthMode = pick(BUDGET_MONTH_MODES, SETTINGS_DEFAULTS.budgetMonth);
