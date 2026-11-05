import {
  LayoutDashboard,
  Wallet,
  Layers,
  Heart,
  PiggyBank,
  CheckSquare,
  Calendar,
  Target,
  Notebook,
  StickyNote,
  Bookmark,
  Timer,
  FolderOpen,
  CalendarClock,
  HeartPulse,
  Repeat,
  Settings,
} from 'lucide-react';

// Single source of truth for the app's navigation, in display order. Consumed by BurgerMenu (the
// drawer), the command palette's "Go to" rows and the tab title. The drawer is one menu: Home, then
// one quiet heading per sectioned group (Financials, Health, Productivity). Settings carries `drawer: false`
// (the top bar's gear opens it). Sections are nav only: a group id is never a page key or cloud category,
// and nothing filters by section. An optional `exclude` list of paths keeps an item inactive when one of
// them matches (Budget vs. its sibling Subscriptions); `keywords` widen the palette match (the Health page
// is shown as Sleep & activity). Weather has no page: it shows in the Javi card on Home (/weather redirects
// to Home, see App.jsx). The order is the owner's list, not alphabetical; navItems.test.js asserts it.
export const NAV_GROUPS = [
  { id: 'home', section: null, items: [{ to: '/', label: 'Home', icon: LayoutDashboard, end: true, keywords: 'overview javi briefing weather' }] },
  { id: 'shared', section: null, items: [{ to: '/calendar', label: 'Calendar', icon: Calendar }] },
  {
    id: 'money',
    section: 'Financials',
    icon: Wallet,
    items: [
      { to: '/budget', label: 'Budget', icon: PiggyBank, exclude: ['/budget/subscriptions'] },
      { to: '/budget/subscriptions', label: 'Subscriptions', icon: Repeat },
    ],
  },
  {
    id: 'wellbeing',
    section: 'Health',
    icon: Heart,
    items: [
      { to: '/journal', label: 'Journal', icon: Notebook },
      { to: '/habits', label: 'Habits', icon: Target },
      {
        to: '/health',
        label: 'Sleep & activity',
        icon: HeartPulse,
        keywords: 'health oura ring sleep readiness activity',
      },
    ],
  },
  {
    id: 'productivity',
    section: 'Productivity',
    icon: Layers,
    items: [
      { to: '/todos', label: 'Todos', icon: CheckSquare },
      { to: '/notes', label: 'Notes', icon: StickyNote },
      { to: '/focus', label: 'Focus', icon: Timer },
      { to: '/countdowns', label: 'Countdowns', icon: CalendarClock },
      { to: '/bookmarks', label: 'Bookmarks', icon: Bookmark },
      { to: '/folders', label: 'Folders', icon: FolderOpen },
    ],
  },
  { id: 'settings', section: null, drawer: false, items: [{ to: '/settings', label: 'Settings', icon: Settings }] },
];
