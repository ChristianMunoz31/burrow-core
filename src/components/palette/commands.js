import { Calculator, Database, Moon, Sun, Monitor } from 'lucide-react';
import { NAV_GROUPS } from '../shell/navItems';
import { IMPORT_TRANSACTIONS_PATH } from '../budget/openTransactionImport';
import { newItemPath } from '../../hooks/useNewIntent';
import { SETTINGS_SECTIONS } from '../settings/settingsSections';
import { openCalculator } from '../calculator/openCalculator';

// Build "Go to {module}" navigation commands from the single nav source of truth, so search finds
// every page. The hint is the item's menu section, left out when it repeats the label (the Budget
// row) and absent for unsectioned rows (Home, Calendar, Settings). An item's `keywords`
// widen the match ("health" finds Sleep & activity).
export function buildNavCommands({ navigate }) {
  return NAV_GROUPS.flatMap((group) =>
    group.items.map((item) => ({
      id: `nav:${item.to}`,
      label: `Go to ${item.label}`,
      hint: group.section && group.section !== item.label ? group.section : undefined,
      keywords: item.keywords,
      icon: item.icon,
      group: 'Navigate',
      run: () => navigate(item.to),
    })),
  );
}

// Extra search words per Settings section, so "backup" or "dark" finds the right place.
const SECTION_KEYWORDS = {
  appearance: 'theme dark light background colors',
  budget: 'budget defaults view month',
  general: 'profile name javi button bar',
  ai: 'javi model ollama address cloud',
  'data-storage': 'backups backup export import restore erase storage',
  privacy: 'privacy activity audit log',
  network: 'network internet updates weather opt in',
  'api-keys': 'api keys connected services oura sheets',
};

// Text the palette searches for a command: its label plus any keywords.
export const commandSearchText = (command) => `${command.label} ${command.keywords ?? ''}`;

// "Browse your data" plus one command per Settings section, generated from SETTINGS_SECTIONS.
export function buildSettingsCommands({ navigate }) {
  return [
    {
      id: 'settings:data',
      label: 'Browse your data',
      keywords: 'data browser tables read only everything saved',
      icon: Database,
      group: 'Settings',
      run: () => navigate('/settings/data'),
    },
    ...SETTINGS_SECTIONS.map((section) => ({
      id: `settings:${section.id}`,
      label: `Settings: ${section.label}`,
      keywords: SECTION_KEYWORDS[section.id] ?? '',
      icon: section.icon,
      group: 'Settings',
      run: () => navigate({ pathname: '/settings', hash: `#${section.id}` }),
    })),
  ];
}

const THEME_OPTIONS = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

// Theme switches. The option that is already active is left out.
export function buildPreferenceCommands({ preference, setPreference }) {
  return THEME_OPTIONS.filter((o) => o.value !== preference).map((o) => ({
    id: `theme:${o.value}`,
    label: `Theme: ${o.label}`,
    keywords: 'appearance dark mode light color scheme',
    icon: o.icon,
    group: 'Preferences',
    run: () => setPreference(o.value),
  }));
}

// Quick-action metadata. Single-field actions add inline via a data hook;
// multi-field ones navigate to their module with `?new=1`, which opens its Add dialog
// (useNewIntent). Icons are resolved in the
// palette component (kept as lucide names here to avoid importing icons twice).
export const QUICK_ACTIONS = [
  { id: 'qa:todo', label: 'Add a todo', icon: 'CheckSquare', kind: 'todo', placeholder: 'Todo title…' },
  { id: 'qa:note', label: 'New note', icon: 'StickyNote', kind: 'note', placeholder: 'Note…' },
  { id: 'qa:journal', label: 'New journal entry', icon: 'Notebook', kind: 'journal', placeholder: 'What happened…' },
  { id: 'qa:import', label: 'Import transactions', icon: 'Upload', kind: 'nav', to: IMPORT_TRANSACTIONS_PATH },
  { id: 'qa:countdown', label: 'New countdown', icon: 'CalendarClock', kind: 'nav', to: newItemPath('/countdowns') },
  { id: 'qa:bookmark', label: 'New bookmark', icon: 'Bookmark', kind: 'nav', to: newItemPath('/bookmarks') },
  { id: 'qa:habit', label: 'New habit', icon: 'Target', kind: 'nav', to: newItemPath('/habits') },
  { id: 'qa:event', label: 'New calendar event', icon: 'Calendar', kind: 'nav', to: newItemPath('/calendar') },
];

// Tools that open over the current page. `returnTo` is the element focused before the palette opened.
export function buildToolCommands({ returnTo }) {
  return [
    {
      id: 'tool:calculator',
      label: 'Calculator',
      keywords: 'calculate calculator math sum add subtract multiply divide percent tip split',
      icon: Calculator,
      group: 'Actions',
      run: () => openCalculator(returnTo),
    },
  ];
}
