# Minimal shell: calm top bar, one-workspace drawer, Javi message bar (2026-10)

> Note 2026-11-05: the trial pill and the Free versus Pro behaviour described below were removed by [ADR 0002](../adr/0002-free-for-everyone.md) (Burrow is free for everyone). Kept as design history.

> Section 3 (drawer, navigation data, Javi inbox rule, Home cards) and the drawer heading part of rule 1.3 are superseded 2026-10-10 by docs/design/nav-sections-2026-10.md. The top bar (section 2) and the Javi message bar (section 4) still stand, except the inert Back placeholder on Home (2.1 row 2, 2.2), which is a dimmed, disabled Back since 2026-10-10 (Update in docs/design/nav-sections-2026-10.md).

Owner request (2026-10-10, verbatim): "many ui changes needed. nav bar shouldnt have 'life' category anymore. it'll only be budget or journal and then calendar with weather. javi should be a direct message bar as if it were social media. every other item from life category go to journal. when budget mode, only budget items. when journal mode, only journal items. ... aim for minimalism, modern design."

Owner decisions (2026-10-10):

1. Home and Settings leave the nav list. Top bar: hamburger, "Burrow" wordmark (link to Home), search, bell, a gear that opens Settings. Back keeps its behaviour; this spec places it.
2. Drawer: the Budget | Journal switch at the top, then only the current workspace's pages, then a divider, then "Calendar & Weather", which is Shared (shown in both workspaces; visiting it never switches the workspace). This reverses #96 for that one item.
3. Javi becomes a docked message bar (LinkedIn or Facebook style): a slim bar bottom-right (sparkle avatar, "Javi", "AI helper" tag, unread badge, chevron). A click expands it upward into a message window; collapse returns to the bar. It replaces the round launcher and the current panel chrome; every existing behaviour is kept or re-specified below.

Builds on `docs/design/nav-two-workspaces-2026-10.md` (#96), `docs/design/javi-dm-2026-10.md` (#93), `docs/design/minimalism-2026-10.md` (#87). Everything not named here keeps those designs. No Free or Pro change, no new network call, no migration, no new server route, no model call added.

## 0. Findings (origin/main 118c3b8)

| # | Fact | Where |
| --- | --- | --- |
| F1 | Burger is a fixed `glass-subtle` button `top-3 left-4 z-[60]`, outside `<main>`; it stays above the open drawer and shows X | `src/components/shell/BurgerMenu.jsx` |
| F2 | TopBar: sticky `z-30` `glass-strong`, `pl-16`, `py-3`; left: Back, headless `WorkspaceKeys`, greeting `<h1>` plus date, `DevBuildBadge`, `TrialBadge`; right: boxed search with "Search" label and kbd, boxed bell, clock with "local time". Publishes `--topbar-h` (default 71px in `index.css`) | `TopBar.jsx`, `src/index.css:291` |
| F3 | Drawer header: gradient avatar tile, `<h2>Burrow</h2>`, subtitle "<name> · <W> workspace"; list renders section headings (uppercase, group icon) and an `ActiveBar`; footer "Private, on this device" plus `FounderBadge` | `BurgerMenu.jsx` |
| F4 | `NAV_GROUPS`: Home (direct), Budget group (`workspace: 'budget'`, icon `Wallet`), Journal group (`workspace: 'journal'`, icon `Activity`, 10 items alphabetical, Calendar & Weather among them), Settings (direct). Consumers: drawer, palette "Go to" rows (`buildNavCommands`, hint = `group.section`), tab title (`titleForPath`), `workspaceForPath` | `navItems.js`, `palette/commands.js`, `hooks/useDocumentTitle.js`, `hooks/useWorkspace.js` |
| F5 | `PAGE_WORKSPACE.calendar = 'journal'`, parity-tested against `workspaceForPath` | `server/javi/inbox.js:41-46`, `server/__tests__/javiPagesParity.test.js:33`, `javiInbox.test.js:127` |
| F6 | Home `WIDGETS`: calendar and weather are `workspace: 'journal'`; Patterns (`CrossInsightsCard`) already filters its pairs by workspace | `src/pages/Home.jsx:47-60`, `src/hooks/useCrossInsights.js:39` |
| F7 | Launcher: fixed `z-40` round `glass-javi-fab` `h-12 w-12`, bottom-right at `max(1rem, safe-area)`, name "Ask Javi about this page[, {n} new for you]", `aria-description="AI helper"`, `aria-keyshortcuts="Alt+J"`, badge `glass-javi-send` capped "9+", `max-sm:invisible` while open | `src/components/javi/JaviLauncher.jsx` |
| F8 | Panel: non-modal `role="dialog"` named "Javi", `PANEL_CLASS` bottom sheet on narrow, `sm:right-4 sm:bottom-20 sm:w-[24rem]`; header with avatar, "Javi", "AI helper" tag, "About {pageLabel}", source badge, icon buttons (New conversation on Pro, Get a new insight, Close "Close Javi"); strip, body, chips, dock | `JaviPanel.jsx` |
| F9 | `close()` aborts advice and stops the agent; focus returns to the launcher, else the opener, else `<main>` | `JaviAdvisor.jsx` |
| F10 | Toast offset is CSS: `:root:has(.glass-javi-fab, .glass-javi)` sets `--javi-toast-offset: 5rem`, sm+ open `--javi-toast-right: 26rem`, narrow open `calc(85dvh + 0.5rem)` | `index.css:248-260`, `src/contexts/ToastContext.jsx:31` |
| F11 | AppShell gives content `pb-24` while the launcher shows; no Javi on `/folders` (`resolveJaviPageKey` null) | `AppShell.jsx` |
| F12 | Desktop window minimum is 960 x 640 (`min_inner_size`), so the desktop app is always at or above `sm` (640px); phone width exists only in the web build | `src-tauri/src/lib.rs:512` |
| F13 | Axe runs `wcag2a`, `wcag2aa`, `wcag21aa` only (no best-practice `page-has-heading-one`) | `e2e/support/axe.js:6` |
| F14 | Bundle: total JS 468.46 KiB of a hard 470 KiB (`scripts/checks/bundle-budget.json`), initial 146, CSS 31.9 | caller, `bundle-budget.json` |
| F15 | `Wallet` and `LayoutDashboard` are used only in `navItems.js`; `Activity` also by Health; `ChevronUp` is used nowhere; `ChevronDown` only in lazy chunks | `git grep` |

## 1. Visual language: minimal and modern

Rules, applied to the top bar, the drawer and the Javi bar only (pages are out of scope):

1. One surface per region. The bar, the drawer and the Javi window each keep their one glass surface; the controls inside them lose their own boxes.
2. Quiet controls. Icon buttons have no fill and no border at rest; a fill appears on hover only. One shared class string (below).
3. No label noise. Text that repeats what the screen already says goes: greeting, date, clock and "local time", the "Search" label and its kbd, the drawer avatar tile and subtitle, the drawer's group headings and their icons.
4. No new tokens, colours, keyframes or shadows. Existing tokens and classes only (DESIGN.md checklist 1).

### 1.1 What is removed or quieted

| Item | Before | After |
| --- | --- | --- |
| Top bar shadow | `glass-strong` shadow | `glass-strong border-x-0 border-t-0 shadow-none` (bottom hairline only; the utility beats the component layer) |
| Burger, search, bell | `glass-subtle` boxes | `SHELL_ICON_BTN` (quiet) |
| Greeting `<h1>`, date, clock, "local time" | in the bar | removed (open question Q1) |
| Search label "Search" and kbd hint | md and up | removed; the shortcut lives in `title` and `aria-keyshortcuts` |
| Drawer avatar tile, subtitle | header | removed; the header is the wordmark only |
| Drawer section headings "Budget" / "Journal" with icons | list | removed; the pressed switch names the workspace |
| Drawer `ActiveBar` and `shadow-sm` on the active row | list | removed; the active row is fill plus `font-semibold` (a non-colour cue that survives forced colours) |
| Javi header icon buttons | `glass-javi-chip` circles | quiet round buttons (no chip fill or border) |
| Round launcher | `glass-javi-fab` FAB | message bar (section 4) |

### 1.2 Shared class string

New module `src/components/shell/shellStyles.js` (SHELL builder):

```js
// Quiet icon button for the top bar and the burger: no box at rest, fill on hover, 36x36 at every width.
export const SHELL_ICON_BTN =
  'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-slate-slate300 transition-colors hover:bg-slate-slate700/50 hover:text-slate-slate100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-slateBlueLight';
// Current place (gear on /settings*, burger never): adds the resting fill.
export const SHELL_ICON_BTN_ACTIVE = 'bg-slate-slate700/60 text-slate-slate100';
```

This is exactly the class `BackButton` already uses (#87), so Back, burger, search, bell and gear match. 36px meets the DESIGN.md touch rule (`w-9 h-9` narrow) on every width.

### 1.3 Spacing and type (existing scale)

| Region | Spec |
| --- | --- |
| Top bar | `h-14` (56px), `pl-14 pr-3 sm:pr-4`, `gap-1` between controls, `gap-2` around the wordmark; icons `size={18}` (bell keeps 16) |
| Wordmark | `text-lg font-bold tracking-tight text-slate-slate100` (15px), `px-1.5 py-1 rounded-md` hit area |
| Burger | fixed `top-2.5 left-3 z-[60]`, `SHELL_ICON_BTN` (centred in the 56px bar: (56 - 36) / 2 = 10px) |
| Drawer | `w-72 max-w-[85vw]` (unchanged); header `h-14 pl-14 pr-4 flex items-center` with the wordmark as `<h2>`; switch `px-3 pt-1`; list `px-3 py-3 space-y-0.5`; rows `px-3 py-2 gap-3 text-sm rounded-md`, icons `size={16}`; divider `my-2 mx-3 border-t border-slate-slate700/50` |
| Javi bar | `h-12` (48px) plus bottom safe area; `pl-2 pr-3 gap-2`; avatar 32px; "Javi" `text-sm font-semibold`; tag `text-[10px]`; badge `text-[11px]` |
| Javi window | `sm:w-[24rem]`, `sm:h-[min(36rem,calc(100dvh-var(--topbar-h)-1rem))]`; header `px-3 py-2` |

### 1.4 Themes, transparency, contrast, forced colours

- Light and dark: every colour is a semantic token (`slate-slate100/300/400`, `accent-*`, `--javi-*`, `--focus-ring`), so both themes follow with no new value. Wordmark `slate100` (11.8:1 dark, 14.4:1 light); icons `slate300` (9.3:1, 7.4:1).
- Reduced transparency and more contrast: the existing blocks (`index.css:812`, `:853`) already swap `--glass-*` and `--javi-*` to solid surfaces and stronger edges; the renamed bar class (4.1) reads the same tokens as the FAB did, so no new rule is needed.
- Forced colours: the top bar keeps its 1px bottom border (system colour); quiet buttons have no border at rest, so focus is the outline ring (unchanged rule) and the active gear and drawer row also carry `aria-current` and, for the drawer row, `font-semibold`. The Javi bar keeps its 1px glass border on three sides (`border-b-0` at the window edge); the badge and avatar keep `border border-transparent` (visible system border).

### 1.5 Motion

No new keyframes. The drawer keeps `animate-drawer-in/out` and the scrim `animate-overlay-in/out`; the Javi window keeps `motion-safe:animate-overlay-in` (fade) on expand and unmounts on collapse (no exit animation, as today). The chevron is one `ChevronUp` icon, rotated with `rotate-180` in the window header (no transition). The badge never animates. The global reduced-motion block (`index.css:1079`) is unchanged.

### 1.6 Narrow windows

| Width | Top bar | Drawer | Javi |
| --- | --- | --- | --- |
| Desktop app (always 960px or wider, F12) | full layout | `w-72` | bar `w-72` bottom-right; window 24rem wide, docked to the bottom edge |
| Web, 640 to 959px | full layout; `TrialBadge` already hides below `sm` only | `w-72` | as desktop |
| Web, below 640px (phone) | burger, Back, wordmark, search, bell, gear all fit at 360px: 12 + 36 + 4 + 36 + 8 + ~62 + auto gap + 3 x 36 + 2 x 4 + 12 = ~286px; `DevBuildBadge` shows "Dev" | `max-w-[85vw]` | bar compact, auto width (avatar, "Javi", tag, badge, chevron, about 200px) at `right-3`; window is the full-width bottom sheet `max-h-[85dvh]` (today's narrow geometry); the bar is hidden while it is open |

## 2. Top bar

### 2.1 Structure (left to right, DOM order)

| # | Element | Markup | Notes |
| --- | --- | --- | --- |
| 1 | Burger | `BurgerMenu` trigger, fixed, `SHELL_ICON_BTN`, `Menu`/`X` 18 | Outside `<main>`, first in tab order (unchanged). Name "Navigation menu" (unchanged; e2e uses it). |
| 2 | Back | `BackButton`, unchanged behaviour and listeners | Sits right of the burger. On `/` the inert 36px placeholder stays, so the wordmark never shifts between Home and other pages. Chosen over placing Back on the right (far from the reading start) or inside the wordmark slot (moving target). |
| 3 | Wordmark | `<Link to="/" aria-label="Burrow, go to Home" aria-current={pathname === '/' ? 'page' : undefined} className="rounded-md px-1.5 py-1 text-lg font-bold tracking-tight text-slate-slate100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-slateBlueLight">Burrow</Link>` | Not a heading (the bar has no `<h1>`, Q6). Accessible name starts with the visible text (WCAG 2.5.3). |
| 4 | `DevBuildBadge`, `TrialBadge` | unchanged components | Dev channel safety and trial days stay visible; both conditional. |
| 5 | Spacer | `ml-auto` on the right cluster | |
| 6 | Search | `<button aria-label="Search commands and your data" aria-keyshortcuts="Control+K Meta+K" title={`Search (${shortcutHint()})`} className={SHELL_ICON_BTN}><Search size={18} aria-hidden="true" /></button>` | Opens the palette (unchanged). `shortcutHint()` stays. |
| 7 | Bell | `NotificationBell`, trigger class becomes `relative ${SHELL_ICON_BTN}` | Popover, count badge and behaviour unchanged. |
| 8 | Gear | `<Link to="/settings" aria-label="Settings" title="Settings" aria-current={settings ? 'page' : undefined} className={`${SHELL_ICON_BTN} ${settings ? SHELL_ICON_BTN_ACTIVE : ''}`}><Settings size={18} aria-hidden="true" /></Link>` with `settings = pathname === '/settings' \|\| pathname.startsWith('/settings/')` | A link, not a button (it navigates). Icon `Settings` from lucide (already in the bundle via `navItems.js`). |

`WorkspaceKeys` (headless) stays mounted in TopBar. The `--topbar-h` publisher stays (the Javi window height and `/calendar#weather` scroll margin read it). `index.css` default `--topbar-h: 71px` becomes `56px` (one-line edit, SHELL builder).

Removed from TopBar: `greeting()`, `DATE_FMT`, `TIME_FMT`, the 30 s clock interval, `useProfile`, the `<h1>`, the date line, the clock block.

### 2.2 States

| State | Shows |
| --- | --- |
| Home (`/`) | Back placeholder (inert); wordmark `aria-current="page"` |
| Any page | Back button |
| `/settings`, `/settings#…`, `/settings/data` | gear active (fill, `aria-current="page"`) |
| Dev channel | "Dev build" pill ("Dev" below `sm`) after the wordmark |
| Local Pro trial, onboarded, `sm` and up | trial pill after the wordmark |
| Bell with alerts | red count on the bell (unchanged) |

## 3. Drawer

### 3.1 Structure

```
<aside role="dialog" aria-modal="true" aria-labelledby={headingId} data-nav-drawer>
  header  h-14 pl-14: <h2 id={headingId} class="text-lg font-bold tracking-tight text-slate-slate100">Burrow</h2>
  <div class="px-3 pt-1"><WorkspaceSwitcher onDone={close} /></div>     (unchanged component)
  <nav aria-label="Main" class="flex-1 overflow-y-auto px-3 py-3">
    <div onKeyDown={onListKeyDown} class="space-y-0.5">
      workspace links (only the current workspace's group, only when ready)
      <hr class="my-2 mx-3 border-t border-slate-slate700/50" />   (only when the workspace list rendered)
      shared links (Calendar & Weather)
    </div>
  </nav>
  footer  "Private, on this device" + FounderBadge (unchanged)
</aside>
```

- Lists, by workspace:

| Workspace | Rows (in this order) |
| --- | --- |
| Budget | Budget, Subscriptions, divider, Calendar & Weather |
| Journal | Journal, Notes, Habits, Health, Todos, Focus, Bookmarks, Countdowns, Folders, divider, Calendar & Weather |
| Not ready (Shared page before `GET /api/state/workspace`) | Calendar & Weather only (switch `aria-busy`, unchanged rule) |

- Order follows the owner's list (Journal first as the namesake, then writing, routines, planning, saving), not alphabetical (Q2). `navItems.test.js` asserts the exact order instead of alphabetical.
- Rows: `MenuLink` unchanged in behaviour (`exclude`, `aria-current`); class `relative flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors` plus active `bg-slate-slate700/60 font-semibold text-slate-slate100` or rest `font-medium text-slate-slate400 hover:bg-slate-slate700/50 hover:text-slate-slate100`. `ActiveBar` is deleted.
- The `<hr>` sits inside the list container and is skipped by `onListKeyDown` (it queries `a[href], button:not([disabled])`), so ArrowDown moves from the last workspace row straight to Calendar & Weather. An `<hr>` has the implicit separator role; no label is added (minimalism pass rule 5: no copy that only explains).
- Focus on open: the current page's link, else the first control (the first switch button); unchanged code.
- Escape, Tab trap, scroll lock, palette yielding, route-change close: unchanged.
- Opening Calendar & Weather from the drawer closes the drawer (route change) and keeps the workspace (3.2).

### 3.2 Navigation data (`src/components/shell/navItems.js`)

```js
export const NAV_GROUPS = [
  { id: 'home', section: null, drawer: false, items: [{ to: '/', label: 'Home', icon: LayoutDashboard, end: true }] },
  {
    id: 'money', section: 'Budget', workspace: 'budget',
    items: [
      { to: '/budget', label: 'Budget', icon: PiggyBank, exclude: ['/budget/subscriptions'] },
      { to: '/budget/subscriptions', label: 'Subscriptions', icon: Repeat },
    ],
  },
  {
    id: 'journal', section: 'Journal', workspace: 'journal',
    items: [
      { to: '/journal', label: 'Journal', icon: Notebook },
      { to: '/notes', label: 'Notes', icon: StickyNote },
      { to: '/habits', label: 'Habits', icon: Target },
      { to: '/health', label: 'Health', icon: HeartPulse },
      { to: '/todos', label: 'Todos', icon: CheckSquare },
      { to: '/focus', label: 'Focus', icon: Timer },
      { to: '/bookmarks', label: 'Bookmarks', icon: Bookmark },
      { to: '/countdowns', label: 'Countdowns', icon: CalendarClock },
      { to: '/folders', label: 'Folders', icon: FolderOpen },
    ],
  },
  { id: 'shared', section: null, items: [{ to: '/calendar', label: 'Calendar & Weather', icon: Calendar }] },
  { id: 'settings', section: null, drawer: false, items: [{ to: '/settings', label: 'Settings', icon: Settings }] },
];
```

- `drawer: false` keeps Home and Settings in the data, so the palette "Go to Home" / "Go to Settings" rows and the tab titles do not change. The drawer filters `g.drawer !== false`.
- Group `icon` fields go (no heading renders them): `Wallet` and `Activity` leave this file.
- `workspaceForPath('/calendar')` is now null (Shared): the route sync saves nothing, so the saved workspace stays. Opening `/calendar` from a link, a bell alert, a search result, a Home card or a Javi row keeps the current workspace. `/weather` still redirects to `/calendar#weather`.
- Shared pages are now Home, Settings and Calendar & Weather. Update the file's header comment and `DESIGN.md` "Navigation".
- Palette: rows and labels unchanged (Go to Home, Budget, Subscriptions, the nine Journal pages, Calendar & Weather, Settings); only the Calendar row loses its "Journal" hint (shared group has no `section`). The palette order follows the new list order.

### 3.3 Javi inbox

`server/javi/inbox.js` `PAGE_WORKSPACE` drops `calendar` (Shared, null); `countdowns` and `bookmarks` stay `journal`; comment becomes "Only Home, Settings and Calendar & Weather are Shared." `javiPagesParity.test.js` then passes unchanged; `javiInbox.test.js:127` changes to `toBeUndefined()`. A "Calendar & Weather changed since your last insight" row counts in both workspaces (as in the original DM matrix, 2.7). No other server change.

### 3.4 Home cards

"Only budget items / only journal items" plus the Shared page. Recommendation (applied):

| Card | Budget Home | Journal Home | Change |
| --- | --- | --- | --- |
| Budget, Subscriptions | yes | no | none |
| Journal, Notes, Habits, Health, Todos, Focus, Bookmarks, Countdowns | no | yes | none |
| Calendar, Weather (both open Calendar & Weather) | yes | yes | `workspace` removed (Shared) |
| Patterns (Pro) | its Budget pairs | its Journal pairs | none (already filters by workspace) |
| Data folder warning, direct-import notice, backup notice, "Open today's briefing in Javi" | yes | yes | none |

Budget Home becomes Budget, Subscriptions, Weather, Calendar (in the user's saved order); Journal Home keeps ten cards. Two existing widgets are kept rather than merged into one "Calendar & Weather" card (zero bytes; a merge is Q4). A user can hide either with Customize (unchanged).

## 4. Javi message bar

### 4.1 Anatomy

Collapsed (`JaviBar.jsx`, new, replaces `JaviLauncher.jsx`):

```
[ (sparkle) Javi  [AI helper]          (3)  ^ ]
```

| Part | Markup and classes |
| --- | --- |
| Bar (one button) | `<button ref type="button" onClick={onToggle} aria-label={label} aria-keyshortcuts="Alt+J" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? controlsId : undefined} className={`glass-javi-bar ${open ? 'hidden' : 'flex'} fixed z-40 bottom-0 right-3 sm:right-[max(1rem,env(safe-area-inset-right))] min-h-12 items-center gap-2 rounded-t-2xl border-b-0 pl-2 pr-3 pb-[env(safe-area-inset-bottom)] text-left sm:w-72 hover:text-slate-slate100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:[outline-color:var(--focus-ring)]`}>` |
| Avatar | `<span aria-hidden="true" className="glass-javi-send flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-transparent"><Sparkles size={15} /></span>` (same as the window header) |
| Name | `<span aria-hidden="true" className="text-sm font-semibold text-slate-slate100">Javi</span>` |
| AI tag | `<span aria-hidden="true" className="glass-javi-chip shrink-0 whitespace-nowrap rounded-full px-1.5 text-[10px] text-slate-slate300">AI helper</span>` (the window header's tag class, visible at every width) |
| Badge | when `count > 0`: `<span aria-hidden="true" className="glass-javi-send ml-auto flex h-5 min-w-[1.25rem] items-center justify-center rounded-full border border-transparent px-1 text-[11px] font-semibold">{count > 9 ? '9+' : count}</span>` (inline, no ring: it no longer overlaps a round edge) |
| Chevron | `<ChevronUp size={16} aria-hidden="true" className={`${count > 0 ? '' : 'ml-auto'} text-slate-slate400`} />` |

- Accessible name: `count > 0 ? `Javi, AI helper, ${count} new for you` : 'Javi, AI helper'` (real number, not capped). It starts with the visible text "Javi" and "AI helper" (WCAG 2.5.3); `aria-description` is dropped because the label is now visible. Children are `aria-hidden` so the name is exactly the label.
- `hidden` class while open (a utility, not the `hidden` attribute: Tailwind's `flex` utility would beat the preflight `[hidden]` rule): the bar is not shown and is not a tab stop; the window header takes its place. On collapse it shows again first, then the existing focus effect focuses it (same order as today's `max-sm:invisible` handling).
- CSS (JAVI builder, `index.css`): `.glass-javi-fab` and `.glass-javi-fab:hover` are renamed `.glass-javi-bar` with the same declarations; the reduced-motion rule and the toast `:has()` rule use the new name. Tokens `--javi-fab-bg` and `--javi-fab-ring` keep their names (no churn in the contrast blocks).

Expanded (`JaviPanel.jsx`, same component, new geometry and header):

| Part | Spec |
| --- | --- |
| Window | `PANEL_CLASS = 'glass-javi fixed z-40 inset-x-0 bottom-0 flex max-h-[85dvh] flex-col overflow-hidden rounded-t-2xl border-b-0 pb-[env(safe-area-inset-bottom)] motion-safe:animate-overlay-in sm:inset-x-auto sm:right-[max(1rem,env(safe-area-inset-right))] sm:w-[24rem] sm:h-[min(36rem,calc(100dvh-var(--topbar-h)-1rem))] sm:max-h-none'`. Docked to the bottom edge at the bar's right edge, so the bar appears to grow upward. Fixed height on `sm` and up, so streaming text never makes the window jump. |
| Header | Unchanged content (avatar, `<h2>Javi</h2>`, AI helper tag, "About {pageLabel}", `AiSourceBadge`), `px-3 py-2`. Icon buttons in order: New conversation (Pro), Get a new insight, Collapse. `ICON_BTN` becomes quiet: `flex h-8 w-8 max-sm:h-11 max-sm:w-11 items-center justify-center rounded-full text-slate-slate400 hover:bg-slate-slate700/50 hover:text-slate-slate100 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:[outline-color:var(--focus-ring)]` |
| Collapse button | `ref={closeRef}`, `onClick={onClose}`; with the bar shown: `ChevronUp` with `rotate-180`, `aria-label="Collapse Javi"`; with the bar hidden by the setting: `X`, `aria-label="Close Javi"` (new prop `barShown` from `JaviAdvisor`, true when `showLauncher`) |
| Strip, body, briefing, thread, chips, Import transactions, dock | Unchanged (order, tiers, classes, behaviour) |

### 4.2 States

| State | Collapsed bar | Window |
| --- | --- | --- |
| Nothing new | "Javi", tag, chevron; name "Javi, AI helper" | n/a |
| Unread (current workspace or shared, not this page) | badge `n` or "9+"; name "…, {n} new for you"; announcer speaks a rise (unchanged rules) | strip lists the same rows |
| Unread only in the other workspace | no badge | no strip (unchanged) |
| Expanded, Free | hidden | greeting "Want a quick insight about {pageLabel}?" with Get insight, or the one insight; the inline hint "Ask follow-up questions with Pro." plus Buy Burrow Pro; strip at the bottom edge; no chips, no composer, no New conversation |
| Expanded, Pro | hidden | strip under the header, thread, chips, composer "Ask Javi anything…" |
| Panel chunk loading | hidden | sr-only "Loading Javi" only (unchanged fallback) |
| Thinking, warming, streaming | hidden | `ThinkingSkeleton`, then the warming `status` note when the server sends it, then partial text (unchanged; no typing indicator) |
| Cut short, ungrounded, withheld, cloud | hidden | notices and Cloud badge per reply (unchanged) |
| Error, AI unavailable, rate wait | hidden | error row with Retry or "Try again in Ns", `AiUnavailable` (unchanged) |
| Home, Pro, today's briefing | hidden | briefing as the first message, Report link "Report this briefing by email", no auto-insight (unchanged) |
| Write confirmation (Pro) | hidden | `ConfirmActionCard` in the thread; live region "Javi wants to make a change. Approve or decline." (unchanged) |
| Palette question on Free | hidden | `ProGateNotice` (unchanged) |
| Collapse while a request runs | returns to the bar | the request is aborted (unchanged `close()` rule, F9; Q3) |
| `/folders`, unknown route | no bar | no window (unchanged, DM decision 2) |
| Setting "Show the Javi bar" off | no bar, no badge, no announcer | opens from the palette or Alt+J; the header button is X "Close Javi" |

### 4.3 Placement and z-order

| Layer | z | Note |
| --- | --- | --- |
| Page content | `z-[1]` | content bottom padding `pb-16` while the bar shows (was `pb-24`), so the bar never covers a page's last row or action |
| TopBar (Back, wordmark, search, bell, gear) | `z-30` | sticky top; never overlaps the bar |
| Javi bar and window | `z-40` | bottom-right; the window's top stays at least 1rem below the top bar on `sm`+ (height formula) |
| Drawer and its scrim, Modal (calculator, import, confirms), bell popover | `z-50` | scrims cover the bar and window; Alt+J is ignored while a modal is open (unchanged guard) |
| Burger, command palette | `z-[60]` | |
| Toasts | `z-[200]` | above the bar: `--javi-toast-offset: 3.5rem` when only the bar shows; `--javi-toast-right: 26rem` on `sm`+ with the window open; `calc(85dvh + 0.5rem)` on narrow with the window open |

Toast CSS (JAVI builder) becomes:

```css
:root:has(.glass-javi-bar:not(:where(.hidden)), .glass-javi) { --javi-toast-offset: 3.5rem; }
@media (min-width: 640px) { :root:has(.glass-javi) { --javi-toast-offset: 1rem; --javi-toast-right: 26rem; } }
@media (max-width: 639.98px) { :root:has(.glass-javi) { --javi-toast-offset: calc(85dvh + 0.5rem); } }
```

Accepted (as DM decision 14): on `sm`+ the open window can cover right-aligned page content in its own 24rem column; it is non-modal and collapses with Escape or the chevron.

### 4.4 Keyboard and focus

| Input | Behaviour |
| --- | --- |
| Tab order | burger, Back, wordmark, trial pill (when shown), search, bell, gear, trial banner, page content, Javi bar (DOM after the content, unchanged mount point). Expanded: header buttons, strip (Pro), body controls, chips, composer, strip (Free) |
| Click bar, Enter or Space on it | expand; focus moves to the composer (Pro) or the Collapse button (Free) via the existing rAF focus effect |
| Escape inside the window | collapse (existing panel `onKeyDown`); focus returns to the bar, else the opener, else `<main>` |
| Collapse button | same as Escape |
| Alt+J | unchanged guard (`e.code === 'KeyJ'`, no Ctrl, Meta, Shift, repeat or AltGraph, not in a field, no modal). Collapsed: expand (opener remembered). Expanded, focus outside: move focus in. Expanded, focus inside: nothing. Works with the bar hidden |
| Strip row | unchanged (navigate, reopen on the target page, focus composer or Collapse; folders row closes and focuses `<main>`) |
| Back (Alt+Left, mouse 4) while expanded | navigates (non-modal window, unchanged); the window stays open on the new page with that page's thread (unchanged) |

### 4.5 Screen readers

- Bar: button "Javi, AI helper" or "Javi, AI helper, {n} new for you", collapsed or expanded state, shortcut Alt+J.
- Window: `role="dialog"` without `aria-modal`, name "Javi", description "About {pageLabel}" plus the source badge (unchanged).
- Live regions: the one sr-only status inside the window (thinking, change request, reply or "Javi replied.", briefing writing and ready) and the new-items announcer next to the bar ("Javi: {n} new for you", only while the bar shows and the window is closed). Both unchanged.
- AI labelling: the visible "AI helper" tag is now on the collapsed bar and in the window header, so the label is visible before and after opening (stronger than #93, where the closed launcher only had `aria-description`).

## 5. Integration seam

`AppShell.jsx` is owned by SHELL. The contract between the builders:

```jsx
// AppShell (SHELL): unchanged mount point and props; only the padding value changes.
<div key={routeKey(location.pathname)} className={`flex-1 min-w-0 animate-page-in ${launcherShown ? 'pb-16' : ''}`}>
...
<JaviAdvisor pageKey={javiPageKey} visible={javiAvailable} showLauncher={showButton} autoAdvise={autoAdvise} />
```

- JAVI keeps the `JaviAdvisor` prop names (`showLauncher` included) so AppShell needs no change from the JAVI side.
- JAVI guarantees the collapsed bar is at most `3rem` plus the bottom safe area tall; SHELL's `pb-16` (4rem) relies on it.
- SHELL guarantees the TopBar keeps publishing `--topbar-h`; JAVI's window height reads it.
- `index.css`: SHELL edits only the `--topbar-h` default line (`:291`); JAVI edits only the Javi block (`:163-260`). Separate hunks merge cleanly.

## 6. Copy

| Where | String | Status |
| --- | --- | --- |
| Top bar wordmark | "Burrow" (visible), aria-label "Burrow, go to Home" | new |
| Top bar search | title "Search (Ctrl K)" or "Search (⌘K)"; aria-label "Search commands and your data" (unchanged) | changed (visible "Search" label and kbd removed) |
| Top bar gear | aria-label and title "Settings" | new |
| Top bar | "Good morning", "Good afternoon", "Good evening", "Good night", "Up late", the date, the time, "local time" | removed |
| Drawer heading | "Burrow" | unchanged text, avatar and subtitle removed |
| Drawer | group headings "Budget", "Journal" | removed (the switch keeps "Budget" and "Journal") |
| Drawer | "Home", "Settings" rows | removed from the drawer (palette keeps "Go to Home", "Go to Settings") |
| Javi bar (visible) | "Javi", "AI helper" | new on the bar |
| Javi bar (name) | "Javi, AI helper" / "Javi, AI helper, {n} new for you" | replaces "Ask Javi about this page" / "Ask Javi about this page, {n} new for you" |
| Javi window | "Collapse Javi" (bar shown), "Close Javi" (bar hidden) | new / kept |
| Settings > General | "Show the Javi bar" | replaces "Show the Javi button" |
| Settings > General hint | "Shows the Javi bar in the bottom-right corner, with a count when something is new. You can still open Javi from search or with Alt+J." | replaces "Shows the round Javi button…" |
| Onboarding workspace hint | "Budget is for money. Journal is for everything else: writing, habits, todos and more. Calendar & Weather is in both. You can switch any time in the menu." | replaces "…todos, your calendar and more…" |

Release and store lines that become false (SHELL builder edits all of them together, same text in each):

| File | Line now | New text |
| --- | --- | --- |
| `release-notes/v1.2.0.md`, `docs/MICROSOFT_STORE.md` "What's new (1.2.0)", `docs/store/chrome-prompts.md` What's new block | "New: Budget and Journal workspaces. Pick one at the top of the menu, or press Alt+1 or Alt+2, and Burrow shows the pages and Home cards that go with it. Budget is for your money; Journal has everything else. Every page is still in search. …" | "New: Budget and Journal workspaces. Pick one at the top of the menu, or press Alt+1 or Alt+2, and Burrow shows only the pages and Home cards that go with it. Budget is for your money; Journal has everything else. Calendar & Weather is in both. Every page is still in search. The Work and Home filter is now on the Todos page, and your tags are kept." |
| same three | "Javi has a new look: its insight about the page now reads like a message from Javi. When something changed since your last insight, a small count on the Javi button lets you know. Press Alt+J to open Javi." | "Javi has a new look: a message bar at the bottom right that opens into a conversation, where its insight about the page reads like a message from Javi. When something changed since your last insight, a small count on the bar lets you know. Press Alt+J to open Javi." |
| same three | "A Back button at the top of the window takes you back to where you were, and pages have fewer extra buttons." | "A calmer top bar: Burrow takes you Home, the gear opens Settings, and a Back button takes you back to where you were. Pages have fewer extra buttons." |
| `docs/MICROSOFT_STORE.md` certification note (line 227) | "…Budget has the budget pages and every other page, such as Calendar & Weather, Habits, Health, Notes and Todos, is in the Journal workspace. Every page can also be found with search (Ctrl+K)." | "…Budget has the budget pages, Journal has every other page, such as Habits, Health, Notes and Todos, and Calendar & Weather is in both. Home opens from the Burrow name at the top left and Settings from the gear at the top right. Every page can also be found with search (Ctrl+K)." |
| `docs/release-runbook-v1.2.0.md` step 1, first check | "The menu (top left) shows the Budget and Journal buttons at its top … and the header has no workspace switch." | "The menu (top left) shows the Budget and Journal buttons at its top with the Alt+1 / Alt+2 hints, then only that workspace's pages, a divider and Calendar & Weather; clicking the other workspace opens its first page and closes the menu. The top bar shows only the menu button, Back, Burrow, search, the bell and the gear." |
| runbook step 1 (add) | | "Opening Calendar & Weather from either workspace keeps that workspace." and "The Javi bar at the bottom right opens upward on a click and on Alt+J, and Escape or the chevron collapses it back to the bar." |
| runbook (add, before the Store upload step) | | "Regenerate the six Store screenshots (`scripts/store/screenshots.mjs`): the top bar and Javi changed." |
| `CLAUDE.md` Architecture "Javi UI" | "the floating launcher and panel" | "the Javi bar (docked bottom-right) and its message window" |
| `docs/DESIGN.md` Navigation, components table, Errors paragraph | Home and Settings in the nav, launcher name | rewritten per sections 2 to 4 and this table |
| `scripts/store/screenshotLib.mjs` comment | "clear of the Javi launcher" | "clear of the Javi bar" (code unchanged: the caption band ends at x = 1580, the bar starts at x = 1616 at 1920 wide) |

## 7. Bundle

Gate: total JS stays at or under 468.46 KiB (net delta <= 0, hard budget 470 unchanged), initial <= 146, CSS <= 31.9. Estimates in gzip bytes; the measured gate decides.

| Change | Builder | Estimate |
| --- | --- | --- |
| TopBar: greeting, date and time formatters, clock interval, `useProfile`, clock markup, "Search" label and kbd | SHELL | -330 |
| Drawer: avatar tile, subtitle logic (`useProfile`, `WORKSPACES` lookup), section-heading branch, `ActiveBar` | SHELL | -260 |
| `Wallet` icon (only user), group `icon` fields | SHELL | -130 |
| Repeated `glass-subtle …` class strings collapse into `SHELL_ICON_BTN` | SHELL | -20 |
| Wordmark link, gear link, `aria-current` logic | SHELL | +140 |
| `drawer: false` filter, shared group, divider | SHELL | +70 |
| Home widget, onboarding copy, palette | SHELL | +5 |
| **SHELL net** | | **about -525** |
| `JaviBar` (text, tag, inline badge, layout) replacing `JaviLauncher` classes and `aria-description` | JAVI | +150 |
| `ChevronUp` icon into the main chunk | JAVI | +130 |
| Window geometry, quiet header buttons, Collapse or Close label and icon switch | JAVI | +50 |
| Settings copy | JAVI | +10 |
| **JAVI net** | | **about +340** |
| **Total** | | **about -185 B JS**; CSS about +0 (rename, three offset values) |

Deleted code: `src/components/javi/JaviLauncher.jsx` (replaced), the panel's `bottom-20` geometry and chip-boxed icon buttons, Home and Settings rows in the drawer render path, every Life remnant (`Wallet` and `Activity` group icons, section headings, the "Life" wording in comments of `navItems.js`, `BurgerMenu.jsx`, `inbox.js` and the e2e headers).

Merge order: SHELL first, then JAVI rebased on it, measured combined. JAVI alone stays under the hard 470 (about 468.80) but must not merge before SHELL if that would leave main above 468.46.

Fallback cuts if the combined measurement is above 468.46 (no owner approval needed, apply in order, re-measure after each): (1) one icon and one label for the window button ("Collapse Javi" with the chevron in both cases, about -30); (2) drop `title` on search and gear (about -25); (3) drop `TrialBadge` from the bar (the trial banner and Settings > License carry the same fact, about -120, needs an owner nod in the PR since it removes a visible element).

## 8. Test plan

### 8.1 Unit (vitest)

| File | Owner | Asserts |
| --- | --- | --- |
| `src/components/shell/__tests__/navItems.test.js` | SHELL | no `life`; Journal exact order (section 3.2); Home and Settings have `drawer: false`; `workspaceForPath('/calendar')` and `('/calendar#weather')` null; Budget and Journal routes unchanged |
| `src/components/shell/__tests__/BurgerMenu.test.jsx` | SHELL | header is the `<h2>` "Burrow" only (no avatar, no subtitle); switch first; Budget lists exactly Budget, Subscriptions, separator, Calendar & Weather; Journal lists the nine plus separator plus Calendar & Weather; no Home or Settings link; not ready lists only Calendar & Weather and no separator; active row `aria-current="page"` and `font-semibold`; ArrowDown crosses the separator; clicking Calendar & Weather does not PUT `workspace` |
| `src/components/shell/__tests__/TopBar.test.jsx` | SHELL | DOM order Back, "Burrow, go to Home", search, bell, gear; no `<h1>`, date or time; wordmark `aria-current` on `/` only; gear `aria-current` on `/settings` and `/settings/data`; search title has the platform hint |
| `src/components/shell/__tests__/BackButton.test.jsx`, `NotificationBell.test.jsx` | SHELL | unchanged behaviour; class change only |
| `AppShell` padding (new case in an existing shell test) | SHELL | `pb-16` with the bar shown; none on `/folders` or with the setting off |
| `src/pages/__tests__` Home widgets | SHELL | Budget: budget, subscriptions, weather, calendar; Journal: the ten |
| `src/components/palette/__tests__` commands | SHELL | Go to Home and Go to Settings still present; Calendar & Weather row has no hint |
| `src/hooks/__tests__` document title | SHELL | titles unchanged |
| `src/components/onboarding/__tests__/Onboarding.test.jsx` | SHELL | new hint copy |
| `server/__tests__/javiInbox.test.js`, `javiPagesParity.test.js` | SHELL | `PAGE_WORKSPACE.calendar` undefined; parity green |
| `src/components/javi/__tests__/JaviBar.test.jsx` (new, replaces launcher cases) | JAVI | name with and without count (real number), visible "Javi" and "AI helper", badge "9+" over 9 and absent at 0, no animate or transition class on the badge, `aria-expanded`, `hidden` class while open, `aria-keyshortcuts` |
| `JaviAdvisor.test.jsx`, `JaviAdvisor.dm.test.jsx`, `JaviFreeGate.test.jsx`, `JaviPolish.test.jsx`, `JaviPanel.*.test.jsx`, `AppShell.javi.test.jsx`, `AppShell.javiButtonOff.test.jsx`, `src/pages/__tests__/Budget.javiFocus.test.jsx` | JAVI | new names; focus returns to the bar after Escape and Collapse; "Collapse Javi" vs "Close Javi" by setting; Alt+J paths; announcer only while the bar shows; Free has no composer; no `/chat/i` |
| `src/components/settings/__tests__/GeneralSection.javi.test.jsx` | JAVI | "Show the Javi bar" and the hint |
| `src/utils/__tests__/pillContrast.test.js` | both run | unchanged values, stays green |

### 8.2 e2e (Playwright)

| Spec | Owner | Change |
| --- | --- | --- |
| `e2e/pages/nav.js` | SHELL | add `goHome()` (wordmark) and `openSettings()` (gear); drawer helpers unchanged |
| `e2e/flows/workspacesDrawer.spec.js` | SHELL | lists per section 3.1; Calendar & Weather present in both; no Home or Settings rows |
| `e2e/flows/workspaces.spec.js` | SHELL | Calendar & Weather keeps Budget and keeps Journal; Shared pages now Home, Settings, Calendar & Weather; Home via wordmark, Settings via gear |
| `e2e/flows/back.spec.js`, `e2e/flows/navigation.spec.js`, `e2e/support/routes.js` | SHELL | Back position unchanged in behaviour; routes reached through wordmark, gear and drawer |
| `e2e/pages/javi.js` | JAVI | `launcher` becomes `bar` = `getByRole('button', { name: /^Javi, AI helper/ })`; `closeButton` = "Collapse Javi"; `badge` unchanged locator (`span` with digits) |
| `e2e/flows/javi.spec.js`, `javiDm.spec.js`, `javiDmBriefing.spec.js`, `javiDmFree.spec.js` | JAVI | new names; expand and collapse; calendar row visible in both workspaces |
| `scripts/store/screenshots.mjs` | JAVI (via `e2e/pages/javi.js`) | follows the page object; run once to check |

### 8.3 Visual baselines (Linux, regenerate with `npm run test:visual:update`)

| Baseline | Owner | Action |
| --- | --- | --- |
| `screens.spec.js`: `home`, `budget`, `todos`, `journal`, `calendar`, `settings`, `settings-ai` (light, dark) | SHELL | regenerate (top bar changed) |
| `drawer-open-{light,dark}` | SHELL | regenerate (Budget: switch, Budget, Subscriptions, divider, Calendar & Weather) |
| `drawer-open-journal-{light,dark}` | SHELL | add (over `/journal`) |
| `onboarding-{light,dark}` | SHELL | regenerate only if the diff shows the bar |
| `javiDm.spec.js` `javi-dm-closed-badge-*` | JAVI | rename to `javi-bar-collapsed-badge-{light,dark}` and regenerate |
| `javi-dm-open-{light,dark}`, `javi-dm-open-forced` | JAVI | rename to `javi-bar-open-{light,dark}`, `javi-bar-open-forced`; regenerate |
| `javi-bar-narrow-light` | JAVI | add (390 x 844, collapsed bar with badge) |

Delete the old `javi-dm-*` PNGs in the same commit as the rename.

### 8.4 Axe and contrast

- `e2e/a11y/light.spec.js`, `dark.spec.js` run every route with the new bar (unchanged harness).
- Add one case per theme with the Javi window expanded on `/journal` (JAVI) and one with the drawer open in Journal (SHELL).
- Full suite, `npm run lint`, `npm run check` (em dash), `npm run build`, `npm run check:bundle` on each branch and on the combined result.

## 9. Work split

| | SHELL builder | JAVI builder |
| --- | --- | --- |
| Source | `src/components/shell/TopBar.jsx`, `BurgerMenu.jsx`, `navItems.js`, `AppShell.jsx`, `BackButton.jsx` (class only), `NotificationBell.jsx` (class only), `shellStyles.js` (new); `src/pages/Home.jsx`; `src/components/onboarding/OnboardingFlow.jsx`; `server/javi/inbox.js`; `src/index.css` line `--topbar-h` only | `src/components/javi/JaviBar.jsx` (new), `JaviLauncher.jsx` (delete), `JaviAdvisor.jsx`, `JaviPanel.jsx`; `src/components/settings/GeneralSection.jsx`; `src/index.css` Javi block only (`.glass-javi-bar`, toast offsets) |
| Tests | `src/components/shell/__tests__/*` except the two `AppShell.javi*` files; Home, palette, document title, onboarding tests; `server/__tests__/javiInbox.test.js`, `javiPagesParity.test.js` | `src/components/javi/__tests__/*`, `src/components/shell/__tests__/AppShell.javi.test.jsx`, `AppShell.javiButtonOff.test.jsx`, `src/pages/__tests__/Budget.javiFocus.test.jsx`, `src/components/settings/__tests__/GeneralSection.javi.test.jsx` |
| e2e | `e2e/pages/nav.js`, `e2e/support/routes.js`, `e2e/flows/{workspaces,workspacesDrawer,back,navigation,onboarding,onboardingJournal}.spec.js`, `e2e/visual/screens.spec.js` and `e2e/__screenshots__/screens.spec.js/*`, a11y drawer case | `e2e/pages/javi.js`, `e2e/flows/javi*.spec.js`, `e2e/visual/javiDm.spec.js` and `e2e/__screenshots__/javiDm.spec.js/*`, a11y Javi case |
| Docs | this spec, `docs/DESIGN.md`, `CLAUDE.md`, `release-notes/v1.2.0.md`, `docs/MICROSOFT_STORE.md`, `docs/store/chrome-prompts.md`, `docs/release-runbook-v1.2.0.md` (all copy from section 6) | `scripts/store/screenshotLib.mjs` comment only |

The one seam is section 5 (AppShell mount point and `pb-16`, `--topbar-h`). The only shared file is `src/index.css`, in separate hunks. Both builders work in their own worktree from `origin/main`; SHELL merges first.

## 10. Open questions (recommendation applied, not blocking)

| # | Question | Recommendation |
| --- | --- | --- |
| Q1 | Greeting, date and clock leave the bar. Move the greeting to Home? | No. Drop them: the OS shows the time, Calendar shows the date, and Home keeps "Overview". Saves bytes. |
| Q2 | Journal order: the owner's list or alphabetical? | The owner's list (section 3.2); it reads by importance and matches the workspace design order. |
| Q3 | Collapsing aborts a running answer (today's close rule). Keep it streaming in the background like a real messenger? | Keep the abort for this change (no hidden model work on CPU-only machines, unchanged rule). Follow-up option: keep the request when collapsed and show "Javi replied." on the bar. |
| Q4 | One merged "Calendar & Weather" Home card instead of two? | Keep two shared cards (zero bytes; each already has its own empty and opt-in states). Revisit if Budget Home feels busy. |
| Q5 | Keep the trial pill in the bar? | Keep it (conditional, hidden below `sm`); it is fallback cut 3 only. |
| Q6 | The bar no longer has an `<h1>`; pages start at `<h2>`. | Accept for now (axe tags pass, F13). Follow-up: promote each page title to `<h1>` in one change with the e2e locators. |
| Q7 | Clicking the window header (not just the chevron) collapses, as in LinkedIn? | No: the header holds other buttons, and a header-wide button would nest controls. The chevron and Escape are enough. |

## 11. Deviations recorded during the SHELL build

| # | Spec | Built | Why |
| --- | --- | --- | --- |
| D1 | `index.css` `--topbar-h` is the only default to change | also `TOPBAR_FALLBACK_PX` 71 to 56 in `src/components/settings/SettingsLayout.jsx` | the same default, read when the CSS variable is missing; leaving 71 would offset the Settings scroll spy by 15px before the first measure |
| D2 | AppShell padding case "in an existing shell test" | new `src/components/shell/__tests__/AppShell.padding.test.jsx` (JaviAdvisor mocked) | both existing AppShell tests are JAVI-owned (section 9); `AppShell.javi.test.jsx` still asserts `pb-24` and is the JAVI builder's to update |
| D3 | `e2e/support/routes.js`: routes reached through wordmark, gear and drawer | each route gains `via` (`wordmark`, `gear`, `drawer`, `url`) and, for drawer rows, `workspace` (`budget`, `journal`, `both`); `navigation.spec.js` walks them | one table drives the reachability check; `e2eRoutes.test.js` allows the extra fields |
| D4 | visual `calendar` shot unchanged | pinned to the Journal workspace | Calendar & Weather is Shared now, so without a pin the shot would depend on the workspace the previous test left |
| D5 | CLAUDE.md: only the "Javi UI" line | also the `src/` paragraph that said only Home and Settings are Shared | it became false with section 3.2 |
| D6 | `scripts/store/screenshotLib.mjs` comment (section 6 table) | left to the JAVI builder | section 9 assigns that comment to JAVI |
