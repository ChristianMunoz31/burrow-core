import {
  Cpu,
  Database,
  Globe,
  KeyRound,
  Palette,
  PiggyBank,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
} from 'lucide-react';
import { SETTINGS_EXTENSIONS } from '../../extensions/settingsExtensions';

// Page order. Icons match the SectionCard header of each section component.
export const SETTINGS_SECTIONS = [
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'budget', label: 'Budget', icon: PiggyBank },
  { id: 'general', label: 'General', icon: SlidersHorizontal },
  { id: 'ai', label: 'AI', icon: Cpu },
  { id: 'data-storage', label: 'Data & storage', icon: Database },
  { id: 'privacy', label: 'Privacy & activity', icon: ShieldCheck },
  { id: 'network', label: 'Network', icon: Globe },
  { id: 'api-keys', label: 'Connected services', icon: KeyRound },
  { id: 'updates', label: 'Updates', icon: RefreshCw },
];

// NetworkSection fires this; the Privacy section opens its Network activity panel and scrolls to it.
export const SHOW_NETWORK_ACTIVITY_EVENT = 'settings:show-network-activity';

/**
 * The sections to list: the core ones, then every extension (src/extensions/settingsExtensions.js) that is enabled
 * for the app info. None in the core.
 * @param {object | null | undefined} info GET /api/app/info data
 * @param {typeof SETTINGS_EXTENSIONS} [extensions]
 */
export const settingsSectionsFor = (info, extensions = SETTINGS_EXTENSIONS) => [
  ...SETTINGS_SECTIONS,
  ...extensions.filter((e) => e.enabled(info) === true).map(({ id, label, icon }) => ({ id, label, icon })),
];

export const sectionHeadingId = (id) => `${id}-heading`;

// Props spread onto SectionCard: anchor id, focusable heading id, and a scroll margin that
// clears the sticky top bar (--topbar-h) plus, below md, the ~60px sticky section pill bar and
// an 8px gap. Keep in sync with the spy rootMargin in SettingsLayout.jsx: a clicked section lands
// at topbar + scroll-margin (md+: 1.5rem) while sections are 1rem apart, so the previous section's
// bottom sits at topbar + 0.5rem. The desktop spy band therefore starts at topbar + 1rem, which
// excludes that sliver and keeps the clicked section the topmost visible one.
export const sectionProps = (id) => ({
  id,
  headingId: sectionHeadingId(id),
  className:
    'scroll-mt-[calc(var(--topbar-h)_+_68px)] md:scroll-mt-[calc(var(--topbar-h)_+_1.5rem)]',
});
