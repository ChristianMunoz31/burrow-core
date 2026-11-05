# One menu with sections, no workspaces (2026-10)

> Updated 2026-10-10 (section 10): the sections are dropdowns (the current page's section open by default, toggles remembered on this device) and Home shows a dimmed, disabled Back. That supersedes "never collapsible" below.

Base: `origin/main` 7d50829 (package 1.1.0; v1.2.0 not tagged, so workspaces never reached a released build). Merges IA proposals A (mental model), B (minimalism, drawer spec) and C (inventory, compatibility, split). Owner decisions are final and are not repeated as options. No Free or Pro change, no network call, no model call, no migration, no new route. Commit this file as `docs/design/nav-sections-2026-10.md` (design of record).

## 1. Menu

### 1.1 Rows (13 links, 3 headings, 1 divider)

| # | Kind | Label | Route | Icon (lucide, existing import) | Group id |
| --- | --- | --- | --- | --- | --- |
| 1 | row | Home | `/` (`end: true`) | `LayoutDashboard` | `home` |
| | heading | Budget | | none | `money` |
| 2 | row | Budget | `/budget` (`exclude: ['/budget/subscriptions']` kept) | `PiggyBank` | |
| 3 | row | Subscriptions | `/budget/subscriptions` | `Repeat` | |
| | heading | Productivity | | none | `productivity` |
| 4 | row | Todos | `/todos` | `CheckSquare` | |
| 5 | row | Notes | `/notes` | `StickyNote` | |
| 6 | row | Focus | `/focus` | `Timer` | |
| 7 | row | Countdowns | `/countdowns` | `CalendarClock` | |
| 8 | row | Bookmarks | `/bookmarks` | `Bookmark` | |
| 9 | row | Folders | `/folders` | `FolderOpen` | |
| | heading | Health | | none | `wellbeing` |
| 10 | row | Journal | `/journal` | `Notebook` | |
| 11 | row | Habits | `/habits` | `Target` | |
| 12 | row | Sleep & activity | `/health` (`keywords: 'health oura ring sleep readiness activity'`) | `HeartPulse` | |
| | divider | | | | |
| 13 | row | Calendar & Weather | `/calendar` | `Calendar` | `shared` |
| | (not in drawer) | Settings | `/settings` | `Settings` | `settings`, `drawer: false` |

`NAV_GROUPS` becomes `home` (no `drawer: false` any more), `money`, `productivity`, `wellbeing`, `shared`, `settings`; each `{ id, section, items }`, no `workspace` field. Group ids never equal a page key or cloud category (`navItems.test.js` asserts no id is in `JAVI_PAGE_KEYS`). Order is the table; the test asserts it exactly. "Browse your data" stays in Settings and the palette only. The Subscriptions tab inside the Budget page stays.

### 1.2 Drawer markup (B section 4, adjusted)

```
<aside role="dialog" aria-modal="true" aria-labelledby={headingId} data-nav-drawer
       class="absolute inset-y-0 left-0 w-72 max-w-[85vw] glass-strong border-y-0 border-l-0 flex flex-col">
  header h-14 pl-14 pr-4: <h2 id={headingId} class="text-lg font-bold tracking-tight text-slate-slate100">Burrow</h2>
  <nav aria-label="Main" class="flex-1 overflow-y-auto px-3 pt-1 pb-3">
    <div onKeyDown={onListKeyDown}>                       (one container: arrows cross sections)
      <MenuLink Home/>
      per section: <div role="group" aria-labelledby={sid} class="pt-3">
                     <h3 id={sid} class="px-3 pb-1 text-xs font-medium text-slate-slate400">{section}</h3>
                     <div class="space-y-0.5">{rows}</div>
                   </div>
      <hr class="mx-3 my-2 border-t border-slate-slate700/50" />
      <MenuLink Calendar & Weather/>
    </div>
  </nav>
  footer (unchanged): "Private, on this device" + FounderBadge
</aside>
```

| Aspect | Spec |
| --- | --- |
| Rows | `MenuLink` and `isItemActive` kept (Budget needs `exclude`). Class unchanged except height: `py-2 sm:py-1.5` (32px under 640px wide, 28px from `sm`; WCAG 2.5.8 needs 24). Rest `font-medium text-slate-slate400 hover:...`, active `bg-slate-slate700/60 font-semibold text-slate-slate100` + `aria-current="page"`, icon `size={16}` |
| Headings | `<h3>` (dialog title is the `<h2>`), sentence case, no uppercase, no tracking, no icon, no rule, no chevron, never collapsible, not focusable. slate400 is 5.7:1 dark, 6.0:1 light (same token as resting rows) |
| Keyboard | `onListKeyDown` queries `a[href], button:not([disabled])`, so ArrowUp/Down, Home, End walk Home, Budget ... Sleep & activity, Calendar & Weather and skip headings and `hr`. Focus on open: current row, else Home. Tab trap, Escape, scroll lock, palette yield, route-change close unchanged |
| Screen readers | Each section is a named group ("Budget, group" then "Budget, link"), which disambiguates the heading and the row of the same name; `h3` gives heading navigation inside the dialog |
| Themes, contrast | Only existing tokens (`glass-strong`, `glass-overlay`, `slate-slate100/400/700`, focus ring). Reduced transparency and more-contrast swaps apply unchanged. Forced colours: headings are system text, active row keeps `font-semibold` + `aria-current`, `hr` is a real border |
| Narrow web | `max-w-[85vw]` (306px at 360) fits "Calendar & Weather" with its icon; no truncation; list scrolls if needed |
| Motion | unchanged `animate-drawer-in/out`, `animate-overlay-in/out` |
| Removed | `WorkspaceSwitcher` block, `own`/`shared` split, `ready` gate, the "only when own rows rendered" divider rule |

### 1.3 Height at the 640px desktop minimum (`src-tauri/src/lib.rs:512`, 960 x 640 logical)

Root font 16px; `text-sm` line 16px, `text-xs` line 14px. From `sm` (the desktop window is always at least 960 wide):

| Part | px |
| --- | --- |
| Header `h-14` | 56 |
| Nav padding `pt-1 pb-3` | 16 |
| Home row | 28 |
| 3 sections x (`pt-3` 12 + heading 14 + `pb-1` 4) | 90 |
| 11 section rows x 28 + 8 gaps x 2 (`space-y-0.5`) | 324 |
| `hr` `my-2` + 1px | 17 |
| Calendar & Weather row | 28 |
| Footer `py-3` + one text line + border | 39 |
| Total | 598 (626 with the Founding member badge) |

Verdict: no scroll at 640px tall in the desktop app, with 14 to 42px to spare. `overflow-y-auto` stays for browser zoom and phone widths (rows 32px there, about 650px, scrolls; fine on a phone). Do not use B's 36px rows or `pt-4` (that totals about 670 and scrolls).

## 2. Rename: Health page shown as "Sleep & activity"

Route `/health`, page key `health`, Javi suggestions, data, `app_state`, cloud category and its "Health" label (`src/constants/cloudAi.js:50`), `storageMap.js:17` (a data source row) and the budget category "Health" are unchanged.

| File | String now | New | Owner |
| --- | --- | --- | --- |
| `src/components/shell/navItems.js:47` | `label: 'Health'` | `label: 'Sleep & activity'`, plus `keywords` (1.1). Drives the menu row, palette "Go to Sleep & activity" and tab title "Sleep & activity · Burrow" | A |
| `src/components/palette/commands.js` `buildNavCommands` | no keywords | pass `keywords: item.keywords`, so typing "health" or "oura" still finds the page | A |
| `src/pages/Health.jsx:7` | `<h2>Health</h2>` | `Sleep & activity` (subtitle "Readiness, sleep, and activity from your Oura Ring." unchanged) | A |
| `src/components/health/HealthPage.jsx:82` | `'Health'` / `'Health unavailable'` | `'Sleep & activity'` / `'Sleep & activity unavailable'` | A |
| `src/components/health/HealthWidget.jsx:30` | `title="Health"` | `title="Sleep & activity"` | B |
| `server/javi/pages.js:21` | `health: 'Health'` | `health: 'Sleep & activity'` | B |
| `src/constants/javiPages.js:65` | `label: 'Health'` | `label: 'Sleep & activity'` (parity test) | B |

Effects of the Javi label, all expected: panel "About Sleep & activity", greeting "Want a quick insight about Sleep & activity?", inbox row "Sleep & activity changed since your last insight", Jarvis hint "(I'm on the Sleep & activity page.)", advisor `Page:` header (`safeLabel` keeps `&`). The system prompt is unchanged, so no `PROMPT_VERSION` bump; the in-memory advice cache misses once for that page. Tests to update: `e2e/support/routes.js:12` (A), `CommandPalette.test.jsx:274` (A), `NetworkOptInNotice.test.jsx:40` (B), any `javiPages`/`JaviPanel` label assertion (B grep `'Health'`).

## 3. Home

| Item | Spec |
| --- | --- |
| Blocks | unchanged order: DataFolderWarning, DirectImportNotice, BackupHealthNotice, "Open today's briefing in Javi", Patterns, Overview header, one grid. No section headings on Home |
| `WIDGETS` | drop every `workspace` field; reorder to `budget, subscriptions, todos, journal, habits, calendar, notes, focus, countdowns, bookmarks, health, weather` (only affects a never-customized layout and Reset) |
| Defaults | `const DEFAULT_HIDDEN = ['notes', 'focus', 'countdowns', 'bookmarks', 'health', 'weather']` (module constant) passed as `useHomeLayout(WIDGET_KEYS, DEFAULT_HIDDEN)` |
| `useHomeLayout` | `normalize(layout, allKeys, defaultHidden)`: when no layout is stored (`raw` null or not an object), `cards` is seeded `{ [k]: { hidden: true } }` for each default-hidden key; a stored layout is used as is (its order, and cards without an entry stay shown, as in 1.1). `patchCard` and `reorder` already normalize `prev`, so the first toggle persists the seeded flags too. `reset()` writes `{ order: allKeys, cards: seed }`. Never write on mount: `pos:homeLayout` is user data for the direct import pristine check (`directImport.js:120`) |
| `visibleKeys` | all `WIDGET_KEYS`; `shown = editing ? ordered : ordered.filter(!hidden)` unchanged; edit mode shows hidden cards dimmed |
| Javi context | `buildHomeContext({ widgets: shown, ... })` at once (no `ready ? shown : []`) |
| Skeleton | delete the `!ready` branch, `SKELETON_COUNT`, `WidgetSkeleton` import, `WORKSPACES` and `useWorkspace` imports, `workspaceLabel` |
| Subtitle | at rest "Everything important at a glance." (A); edit mode unchanged. Why not B's none-at-rest: every page header in Burrow is an h2 plus one `text-sm` line, and edit mode swaps text into that same line, so keeping it avoids a layout jump on Customize and keeps the header height of the current baseline; it is existing copy, zero bytes |
| `useHomeLayout.js:58` comment | "every other slot (hidden cards) is kept" |

## 4. Removal inventory (origin/main line numbers)

### 4.1 Client (bundle)

| File:line | Item | Action | Builder |
| --- | --- | --- | --- |
| `src/components/shell/WorkspaceSwitcher.jsx` (whole) | switch + `WorkspaceKeys` (route sync, Alt+1/Alt+2) | delete (Alt keys not repurposed) | A |
| `src/components/shell/TopBar.jsx:5,49` | `WorkspaceKeys` import and mount | delete | A |
| `src/components/shell/BurgerMenu.jsx:4,8,54-80,228-231,236-243` | hook, switch, own/shared split, ready gate | simplify to 1.2 | A |
| `src/components/shell/navItems.js:19-27,33,42,59-76` | header comment, group `workspace`, `WORKSPACES`, `DEFAULT_WORKSPACE`, `normalizeWorkspace`, `workspaceForPath`, `matchPath` import | regroup (1.1); delete exports in A's final commit (section 8) | A |
| `src/hooks/useWorkspace.js` (whole) | route/saved workspace, `GET /api/state/workspace`, `switchTo` | delete (A, final commit) | A |
| `src/components/shell/shortcutGuard.js:1,6` | comments | reword ("Back and the calculator shortcut") | A |
| `src/components/palette/commands.js:2,9-11,70-81` | `WORKSPACES` import, comment, `buildWorkspaceCommands` | delete builder; hint = `group.section` omitted when it equals `item.label` (Budget row) | A |
| `src/components/palette/CommandPalette.jsx:20,28,112,272,299` | hook, builder, deps | delete | A |
| `src/components/onboarding/OnboardingFlow.jsx:8-10,44-45,84,133-141,182,188` | start radio, `storedFocus`, `SegmentedRadio` import, Journal branch | delete; the Javi step always continues to the starter budget step (1.1 behaviour); onboarding writes only `profile` and optional `budget:defaults` | A |
| `src/constants/settingsDefaults.js:6,17` | `workspace` key and comment | delete | A |
| `src/contexts/ModeContext.jsx:5` | comment about seeding | reword; `mode` stays the Todos filter | A |
| `src/pages/Home.jsx:36-37,45-59,70,75,80,85-86,132-136,159-167` | filter, label, skeleton | simplify (section 3) | B |
| `src/hooks/useHomeLayout.js` | defaults param, comment | add (section 3) | B |
| `src/components/home/CrossInsightsCard.jsx:4,27-28,107` | hook, `ready` gate | `useCrossInsights()`; gate on `loading` only | B |
| `src/hooks/useCrossInsights.js:39,58,60` | `workspace` arg and dep | delete | B |
| `src/utils/crossInsights.js:27-32,389-397` | pair `workspace` fields, filter | delete; all 6 pairs compete for `MAX_SHOWN` (4) by abs(rho), the pre-1.2 rule | B |
| `src/components/javi/JaviAdvisor.jsx:11,88-89` | hook | `useJaviInbox({ pageKey: visible ? pageKey : null })` | B |
| `src/hooks/useJaviInbox.js:13-22,69-70` | workspace filter, JSDoc | `rows = items.filter((i) => i.page !== pageKey)` | B |
| `src/components/budget/BudgetWidget.jsx:14`, `SubscriptionsWidget.jsx:31` | "Budget workspace" comments | reword | B |
| `useDocumentTitle.js`, `useMode`, `SegmentedRadio`, `routeKey.js` | | keep | |

### 4.2 Server (no bundle effect)

| File:line | Item | Action | Builder |
| --- | --- | --- | --- |
| `server/javi/inbox.js:41-46` | `PAGE_WORKSPACE` and comment | delete | B |
| `server/javi/inbox.js:127,139,156` | `workspace` on items | delete field; stored `javi.inbox` shape untouched | B |
| `server/backup/directImport.js:117-118,134` | `AUTO_STATE_KEYS` `workspace` | KEEP entry; comment becomes "legacy view state written by 1.2 pre-release and Dev builds (`budget` or `journal`); nothing writes it now" | B |
| `server/ai/privacy.js`, `crossInsightsRoutes.js` `PAIR_META` | categories by page and pair | unchanged; sections never map to a category | |

### 4.3 Stored state (no migration, nothing deleted)

| State | After | Why it is safe |
| --- | --- | --- |
| `app_state` `workspace` (Dev/source builds only) | orphan: never read or written | shows as a plain row in the data browser and export; import upserts it harmlessly; still an auto key, so a Dev-era database stays "unused" for "Import from your existing Burrow" |
| localStorage `burrow.workspace` | orphan | never read |
| `app_state` `mode` | Todos filter only, seeds nothing | unchanged reader |
| `pos:homeLayout` | same shape; all cards eligible | stored order and flags kept; never written without a user action |
| `javi.inbox` | same shape | items of the former other workspace now count once (Dev users only) |
| `profile` | onboarding no longer writes `workspace` | fewer auto writes |
| Backups and restores of older snapshots | may carry `workspace` | orphan, as above |

## 5. Copy and docs

### 5.1 UI copy

| Where | Before | After |
| --- | --- | --- |
| Drawer | Budget / Journal buttons, Alt+1 / Alt+2 hints, group "Workspace" | removed |
| Drawer | (none) | Home row; headings "Budget", "Productivity", "Health" |
| Menu, palette, tab, page heading, Home card, Javi label | "Health" | "Sleep & activity" |
| Health page error card | "Health" / "Health unavailable" | "Sleep & activity" / "Sleep & activity unavailable" |
| Home subtitle | "{Budget or Journal} workspace. Everything important at a glance." | "Everything important at a glance." |
| Onboarding | "Where do you want to start?" + hint | removed |
| Palette | "Switch to Budget" / "Switch to Journal" | removed |
| Palette hints | "Budget" / "Journal" | "Budget" (not on the Budget row itself), "Productivity", "Health"; none for Home, Calendar & Weather, Settings |

### 5.2 `release-notes/v1.2.0.md` (final text, line by line)

```
- New: one simple menu. Home is at the top, then your pages in three groups: Budget (Budget, Subscriptions), Productivity (Todos, Notes, Focus, Countdowns, Bookmarks, Folders) and Health (Journal, Habits, Sleep & activity), with Calendar & Weather at the bottom. Every page is still in search. The Work and Home filter is now on the Todos page, and your tags are kept.
- The Health page is now called Sleep & activity. It still shows the readiness, sleep and activity from your Oura Ring.
- Calendar and Weather are now one page: the forecast is shown under your calendar.
- Home shows a Budget card with what you spent this month, what you budgeted and what is left.
- Next to it, a Subscriptions card shows your next subscription charges in the coming 30 days and what they add up to.
- If you never customized Home, it now starts with six cards. Use Customize to show the others.
- New: a calculator. Press Ctrl+K and choose Calculator.
(Javi, briefing and top bar lines unchanged)
```

### 5.3 `docs/MICROSOFT_STORE.md` and `docs/store/chrome-prompts.md`

| Place | New text |
| --- | --- |
| MS `:331-333` "What's new (1.2.0)" and chrome `:152-154` | the 5.2 lines, each with the existing `> ` prefix (MS) or none (chrome), same order |
| MS `:340` | "The same text as `release-notes/v1.2.0.md`, the hand-written text for the other channels. If the Alt+J check in the desktop app fails before the release, change both together." |
| MS `:227` certification note | "> Menu (Burrow 1.2.0): every page is in the menu at the top left of the window: Home, then three groups, Budget (Budget, Subscriptions), Productivity (Todos, Notes, Focus, Countdowns, Bookmarks, Folders) and Health (Journal, Habits, Sleep & activity), then Calendar & Weather. Home also opens from the Burrow name at the top left and Settings from the gear at the top right. Every page can also be found with search (Ctrl+K)." |
| MS `:283`, chrome `:121` description bullet | "- One simple menu for your money and your days: transactions and subscriptions, todos, notes, focus sessions, countdowns, bookmarks and folders, your journal, habits, sleep and activity, and a calendar with the weather." |
| MS `:298` (item 1), chrome `:134` feature row | "Budget and journal with todos, habits, notes, focus, calendar, countdowns and bookmarks, in one app" |
| `README.md:7` | "- One menu: Home, then Budget (budget and subscriptions), Productivity (todos, notes, focus, countdowns, bookmarks and folders) and Health (journal, habits, sleep and activity), then Calendar & Weather. Settings is the gear; every page is also in search (Ctrl+K)." |

### 5.4 `docs/release-runbook-v1.2.0.md`

| Line | Change |
| --- | --- |
| after `:12` | add "- [ ] #<PR> feat: one menu with sections (replaces the workspaces of #91)" (keep #91 as history) |
| `:27` | "- [ ] The menu (top left) shows Home, then Budget (Budget, Subscriptions), Productivity (Todos, Notes, Focus, Countdowns, Bookmarks, Folders) and Health (Journal, Habits, Sleep & activity) under quiet headings, a divider and Calendar & Weather, with no Budget or Journal buttons. At the smallest window (960 x 640) every row shows without scrolling. The top bar shows only the menu button, Back, Burrow, search, the bell and the gear (plus the trial or Dev pill when they apply)." |
| `:28` | "- [ ] Arrow keys move through every menu row and skip the headings; Alt+1 and Alt+2 do nothing." |
| `:30` | delete (Alt+1/Alt+2 switch check) |
| `:33` "For each of the three" | "For Alt+J: Windows plays no beep, and releasing Alt does not move the keyboard focus to the native menu bar (File, Edit, Help)." |
| `:37` | delete (Ctrl+Shift+1/2 fallback) |
| `:153` | "(new Menu paragraph)" instead of "(new Workspaces paragraph)" |
| `:155` | "check the new one shows Home with its six default cards" and "The menu change also asks for the Budget page, the Journal page and optionally the open menu with its three sections." |
| `:159` | quote the new bullet ("One simple menu for your money and your days. ...") |

### 5.5 `docs/PRODUCT.md` decision log (append after `:104`)

"- 2026-10-10: **One menu with sections; workspaces removed; the Health page is shown as Sleep & activity.** Owner decisions: one menu, no workspace switching. The menu is Home, then Budget (Budget, Subscriptions), Productivity (Todos, Notes, Focus, Countdowns, Bookmarks, Folders) and Health (Journal, Habits, Sleep & activity) under quiet headings that never collapse, a divider and Calendar & Weather; the Burrow name also opens Home, Settings stays the gear, Browse your data stays in Settings and search. Removed: the Budget / Journal switch, Alt+1 / Alt+2 (not reused), the Switch to commands, the onboarding start question and every per-workspace filter (Home cards, Patterns pairs, the Javi count); the Javi count is every unread item except the current page's. The Health page is shown as Sleep & activity (route, page key, data and cloud category unchanged). Home is one grid: a Home never customized starts with Budget, Subscriptions, Todos, Journal, Habits and Calendar, the other six one Customize click away; saved layouts are kept. The `app_state` row `workspace` is no longer read or written (no migration; it stays an automatic key for the direct import check). No Free or Pro change, no network call. Supersedes the workspace parts of the 2026-10-09 entry and both 2026-10-10 navigation entries (history left as written). Design: docs/design/nav-sections-2026-10.md."

Append to each of the three superseded entries: " (Workspace parts superseded 2026-10-10: One menu with sections.)"

### 5.6 `CLAUDE.md` (`src/` entry, line 96)

Replace from "Workspaces (Budget, Journal) are view state" through "live in the headless `WorkspaceKeys` in `TopBar`." with:

"There are no workspaces. The nav is one menu: Home (also the top bar's Burrow wordmark), the sections Budget (Budget, Subscriptions), Productivity (Todos, Notes, Focus, Countdowns, Bookmarks, Folders) and Health (Journal, Habits, Sleep & activity, the `/health` page) under quiet headings that never collapse, a divider and Calendar & Weather; Settings is `drawer: false` and opens from the gear. Sections are nav only (`NAV_GROUPS` ids `money`, `productivity`, `wellbeing`), never a page key or cloud category, and nothing filters by section. The legacy `app_state` row `workspace` is no longer read or written; it stays in `AUTO_STATE_KEYS`." Keep the Weather and Todos-only filter sentences.

### 5.7 `docs/DESIGN.md`

- `:65` delete the `WorkspaceSwitcher` row.
- `:82` Navigation P1: "One source: `NAV_GROUPS` in `src/components/shell/navItems.js`, rendered by the drawer (`BurgerMenu`), the palette's "Go to" rows and the tab title. The menu is Home, then Budget (Budget, Subscriptions), Productivity (Todos, Notes, Focus, Countdowns, Bookmarks, Folders) and Health (Journal, Habits, Sleep & activity), a divider and Calendar & Weather, in that order (a test checks it). There are no workspaces: every page is always listed and nothing filters by section."
- `:84` P2: replace the last sentence with "Settings carries `drawer: false`: it stays in the data (palette row, tab title) and opens from the gear, one click away. Home is the first menu row and also the wordmark."
- `:86` P3: "The drawer has the "Burrow" heading, the Home row, then one `role="group"` per section named by a quiet `<h3>` (`text-xs font-medium text-slate-slate400`, sentence case, no icon, no rule, not focusable, never collapsible), a divider and Calendar & Weather. Icons are on rows only; the active row is a fill plus `font-semibold`; arrow keys walk every link across sections. Do not reintroduce workspaces, a section filter, collapsible sections or a header dropdown." Keep the merged-page sentence; design of record becomes this file.

### 5.8 Superseded notes (one blockquote under each title)

| Doc | Note |
| --- | --- |
| `docs/design/nav-two-workspaces-2026-10.md` | "> Superseded 2026-10-10 by docs/design/nav-sections-2026-10.md for the menu and workspaces: one menu with sections, no workspaces. Calendar & Weather as one page still stands." |
| `docs/design/minimal-shell-2026-10.md` | "> Section 3 (drawer, navigation data, Javi inbox rule, Home cards) and the drawer heading part of rule 1.3 are superseded 2026-10-10 by docs/design/nav-sections-2026-10.md. The top bar (section 2) and the Javi message bar (section 4) still stand." |
| `docs/design/workspaces-2026-10.md` (B) | "> Superseded 2026-10-10 by docs/design/nav-sections-2026-10.md: Burrow has no workspaces. The Todos-only Work / Home filter still stands." |
| `docs/design/javi-dm-2026-10.md` (B) | "> The other-workspace part of R16 is superseded 2026-10-10 (docs/design/nav-sections-2026-10.md): the count is every unread item except the current page's." |

## 6. Tests

### 6.1 Unit (vitest)

| File | Action | Builder |
| --- | --- | --- |
| `src/components/shell/__tests__/WorkspaceSwitcher.test.jsx` | delete | A |
| `src/hooks/__tests__/useWorkspace.test.jsx` | delete (final commit) | A |
| `src/__tests__/workspaceRoutes.test.jsx` | rename `routes.test.jsx`; keep hash, query, redirect, subpath, unknown-route cases; drop saved-workspace and "is Journal" assertions; `/health` renders "Sleep & activity" | A |
| `src/components/shell/__tests__/navItems.test.js` | rewrite: exact group and row order, Home in drawer, Settings `drawer: false`, no `workspace` field, no group id in `JAVI_PAGE_KEYS`, Sleep & activity keywords | A |
| `src/components/shell/__tests__/BurgerMenu.test.jsx` | rewrite: Home first; 3 groups named Budget, Productivity, Health with their rows; one separator; Calendar & Weather last; no Settings link; no switch; ArrowDown crosses groups and skips headings; Budget not active on `/budget/subscriptions`; makes no `/api/state/workspace` request | A |
| `CommandPalette{,.import,.newIntent}.test.jsx`, `LazyCommandPalette.test.jsx` | drop hook mock and Switch to cases; add hint omission and "health" finds Sleep & activity | A |
| `Onboarding.test.jsx` | drop radio and `workspace` write; Javi step continues to the budget step | A |
| `src/pages/__tests__/Home.workspace.test.jsx` | rename `Home.cards.test.jsx`: no stored layout shows exactly the 6 defaults in order; Customize shows all 12; a stored layout keeps its flags (an unlisted card shows); Reset restores defaults; no `pos:homeLayout` PUT on mount; subtitle; no skeleton; briefing block kept | B |
| `src/hooks/__tests__/useHomeLayout.test.js` | add default-hidden seed, toggle persists seed, reset | B |
| `CrossInsightsCard{,.explain,.busyness}.test.jsx`, `crossInsights.test.js:321-362` | drop hook mock and filter cases; add "all pairs compete for 4 slots" | B |
| Javi: `JaviAdvisor{,.dm}`, `JaviFreeGate`, `JaviPolish`, `JaviPanel.dm`, `AppShell.javi`, `AppShell.javiButtonOff`, `Budget.javiFocus`, `ProGating`, `ProRefresh`, `GeneralSection.javi`; `src/test-utils/javiInbox.js` | drop every `vi.mock('.../useWorkspace')` and `workspaceModule` / `inboxState.workspace`; count = all but active page | B |
| `server/__tests__/javiInbox.test.js:19,127-131,150,322,373` | drop `PAGE_WORKSPACE` and `workspace` expectations | B |
| `server/__tests__/javiPagesParity.test.js:5-6,31-34` | delete the workspace case and both imports | B |
| `server/__tests__/directImport.test.js:518,613` | keep; retitle as legacy key | B |
| `server/__tests__/e2eRoutes.test.js:33` | retitle ("in every workspace" goes) | A |
| `NetworkOptInNotice.test.jsx:40` | 'Sleep & activity' | B |

### 6.2 e2e (Playwright)

| File | Action | Builder |
| --- | --- | --- |
| `e2e/pages/nav.js` | delete `openWorkspaceSwitch`, `expectWorkspace`, `setWorkspace` (it waits on `PUT /api/state/workspace`, which never comes now: a hang); add `openDrawer()` (clicks "Navigation menu", returns the "Main" navigation once visible) and `drawerSection(name)` (`getByRole('group', { name })`); `closeDrawer()` waits for the dialog to be gone | A |
| `e2e/support/routes.js` | replace `workspace` with `section` (`Budget`, `Productivity`, `Health`, or none for Calendar); Health heading "Sleep & activity"; header comment | A |
| `e2e/flows/menu.spec.js` (new) | replaces `workspaces.spec.js` and `workspacesDrawer.spec.js` (delete both): exact menu, groups, separator; arrows skip headings; Alt+1/Alt+2 do nothing; no Switch to in the palette; `/weather` lands on the forecast; wordmark and gear; nothing requests `/api/state/workspace` | A |
| `navigation.spec.js` | one pass over `via: 'drawer'` routes, no loop | A |
| `back.spec.js:19`, `calculator.spec.js:9-12` | drop `setWorkspace`; calculator one run | A |
| `onboarding.spec.js:11-17` | no start choice; Home shows "Everything important at a glance."; `onboardingJournal.spec.js` delete | A |
| `todosFilter.spec.js:2` | comment only | A |
| `e2e/support/visual.js:35-38` | on `/` wait for "Everything important at a glance." and the six default card titles, and no `main [aria-busy="true"]` | A |
| `e2e/visual/screens.spec.js` | drop every `workspace` pin and `setWorkspace`; `drawer-open` over `/journal` (shows all rows, Journal active); delete the `drawer-open-journal` test | A |
| `e2e/a11y/{light,dark}.spec.js:35,50-78` | one drawer case per theme over `/journal`, asserting 3 groups and 1 separator; delete the second case; Javi case comment | A |
| `e2e/flows/javiDm.spec.js:51,87` | test 2 becomes "a Calendar & Weather row counts on every other page"; comment | B |
| `e2e/visual/javiDm.spec.js:7` | comment only | B |

### 6.3 Visual baselines (`e2e/__screenshots__`, regenerate once on the integrated branch with `npm run test:visual:update`, Linux container or CI)

| Action | Files |
| --- | --- |
| Regenerate | `screens.spec.js/home-{light,dark}.png` (6 cards), `screens.spec.js/drawer-open-{light,dark}.png` (Home, 3 sections, now over Journal), `onboarding.spec.js/onboarding-{light,dark}.png` (no radio) |
| Delete | `screens.spec.js/drawer-open-journal-{light,dark}.png` |
| Expected unchanged | budget, todos, journal, calendar, settings, settings-ai, all `javiDm.spec.js/*` (the badge shot on Bookmarks counts the one calendar row in both rules). Any diff there is a bug to explain before accepting |

Axe: drawer case above must have no serious or critical violations in both themes (heading order h2 then h3, named groups, contrast of slate400 headings). Contrast test unchanged (no new token).

## 7. Bundle gate

Gate: total JS gzip must stay at or below 467.95 KiB (current main; the 470 budget is never raised) and initial JS must not grow. Measure with `npm run build; npm run check:bundle` on the integrated branch.

| Change | Estimate (gzip, in bundle) |
| --- | --- |
| `WorkspaceSwitcher.jsx` (839 B standalone) | -0.45 KiB |
| `useWorkspace.js` (529 B standalone) | -0.30 KiB |
| `navItems` workspace exports, `matchPath` use | -0.17 KiB |
| BurgerMenu split and gate; palette builder; onboarding radio and hint | -0.30 KiB |
| Home filter, label, skeleton; Patterns and inbox filters | -0.25 KiB |
| Add: headings and groups in the drawer | +0.20 KiB |
| Add: Home defaults seed, palette keywords and hint rule | +0.10 KiB |
| Net | about -1.2 KiB (range -0.8 to -1.6), landing near 466.8 KiB |

If the measured total exceeds 467.95, stop and report; do not trim unrelated code.

## 8. Work split (two builders, separate worktrees from `origin/main`)

| | Builder A: shell, nav, palette, onboarding | Builder B: Home, Patterns, Javi, server, product docs |
| --- | --- | --- |
| Code | `navItems.js`, `BurgerMenu.jsx`, `TopBar.jsx`, `WorkspaceSwitcher.jsx` (delete), `shortcutGuard.js`, `palette/commands.js`, `CommandPalette.jsx`, `OnboardingFlow.jsx`, `settingsDefaults.js`, `ModeContext.jsx`, `pages/Health.jsx`, `health/HealthPage.jsx`; final commit: `useWorkspace.js` (delete), `navItems` workspace exports | `Home.jsx`, `useHomeLayout.js`, `CrossInsightsCard.jsx`, `useCrossInsights.js`, `crossInsights.js`, `JaviAdvisor.jsx`, `useJaviInbox.js`, `health/HealthWidget.jsx`, `BudgetWidget.jsx`, `SubscriptionsWidget.jsx` (comments), `constants/javiPages.js`, `server/javi/pages.js`, `server/javi/inbox.js`, `server/backup/directImport.js` (comment) |
| Tests | shell, palette, onboarding, routes, navItems unit tests; `e2eRoutes.test.js`; all e2e except javiDm; `useWorkspace.test.jsx` (final commit) | Home, layout, Patterns, Javi unit tests, `test-utils/javiInbox.js`, `NetworkOptInNotice.test.jsx`, server inbox, parity, directImport; `e2e/flows/javiDm.spec.js`, `e2e/visual/javiDm.spec.js` |
| Docs | `CLAUDE.md`, `docs/DESIGN.md`, this file as `docs/design/nav-sections-2026-10.md`, notes on `nav-two-workspaces` and `minimal-shell` | `docs/PRODUCT.md`, `release-notes/v1.2.0.md`, `docs/MICROSOFT_STORE.md`, `docs/store/chrome-prompts.md`, `docs/release-runbook-v1.2.0.md`, `README.md`, notes on `workspaces` and `javi-dm` |

Rules:
1. B must not delete `useWorkspace.js` or any `navItems` export. B removes every use of the hook and every `vi.mock` of it in B's files, and drops `workspaceForPath` from the parity test. B's branch passes the full gate on its own (the hook still serves A-owned files on main).
2. A keeps `useWorkspace.js`, `useWorkspace.test.jsx`, the group `workspace` fields and the four `navItems` workspace exports in its interim branch (A's drawer ignores them), so A's branch also passes the full gate alone. A deletes `WorkspaceSwitcher.jsx` and its test early (A-only consumers).
3. Integration: the parent creates `feat/nav-sections` from `origin/main`, merges B, then A rebases onto it and adds one final commit that deletes `useWorkspace.js`, its test, the group `workspace` fields, `WORKSPACES`, `DEFAULT_WORKSPACE`, `normalizeWorkspace`, `workspaceForPath`, and renames `workspaceRoutes.test.jsx`. Before that commit is accepted, on the merged tree: `git grep -n -i -E "useWorkspace|WORKSPACES|workspaceForPath|normalizeWorkspace|DEFAULT_WORKSPACE|PAGE_WORKSPACE|WorkspaceSwitcher|WorkspaceKeys|buildWorkspaceCommands|setWorkspace|openWorkspaceSwitch|expectWorkspace|SETTINGS_KEYS\.workspace" -- src server e2e` must be empty (the `directImport.js` key is the string `'workspace'`, not matched).
4. Then, once, on that branch: `npm test`, `npm run lint`, `npm run check`, `npm run build; npm run check:bundle`, `npm run test:e2e`, baseline regeneration (6.3), axe. One PR to main; neither half merges to main alone, and it lands before the 1.2.0 tag.
5. Only shared seam: `e2e/support/visual.js` (A) waits on Home copy owned by B; both use the section 3 text, so no coordination beyond this spec.

## 9. Risks

| Risk | Mitigation |
| --- | --- |
| A test still mocks the deleted hook path, vitest fails to resolve | rule 1 (B removes its mocks), grep gate in rule 3 |
| e2e waits on `PUT /api/state/workspace` and hangs | `setWorkspace` deleted; grep gate; menu spec asserts no workspace request |
| Main ships half, or 1.2.0 tags with workspace copy | one integration branch and PR; notes, store and runbook in the same PR |
| Removing the auto key would refuse a direct import into a Dev-era database | keep `workspace` in `AUTO_STATE_KEYS` and its tests |
| A 1.1 user who never customized Home now sees 6 cards instead of 12 | release-note line; Customize shows the rest dimmed; any stored layout is untouched |
| First paint on a device with no local cache shows the 6 defaults, then the server layout | localStorage cache paints the stored layout in the normal case; accepted, no skeleton |
| Seeding writes `pos:homeLayout` and makes an unused install look used | seed lives in memory only; unit test asserts no PUT on mount |
| "Budget" heading over a "Budget" row | headings are not targets; named groups; palette hint omitted on the Budget row |
| Users look for Journal under Productivity | Journal first in Health; sections never collapse; Journal card shown by default; Ctrl+K |
| Searching "health" no longer matches a page label | `keywords` on the Sleep & activity item |
| Drawer scrolls at 640px if rows or spacing drift | height table (1.3) in DESIGN.md terms; runbook step 1 check at 960 x 640 |
| Patterns: spend pairs may crowd mood and habit findings | pre-1.2 rule (abs(rho)); cloud explain still withholds per pair category |
| One-time Javi badge bump for Dev users | accepted; note in the PR |
| Visual diff on a page that should not change | expected list in 6.3; investigate any other diff |
| Bundle over 467.95 | measure on the integrated branch; stop and report |
| Em or en dashes in new copy | `npm run check:em-dash` |

## 10. Update 2026-10-10: sections as dropdowns, a dimmed Back on Home

Owner request (2026-10-10, verbatim): "for the nav, have subcategories show from category drop down. also in overview, have a placeholder because it doesnt have a back button."

This update supersedes "never collapsible" in 1.2 (Headings, Keyboard) and the "sections never collapse" mitigation in section 9, and the inert Back placeholder of `docs/design/minimal-shell-2026-10.md` 2.1 and 2.2. Everything else in this file stands. No new copy beyond the section names, no Free or Pro change, no network call, no migration, no server change.

### 10.1 Drawer markup

```
per section: <div role="group" aria-labelledby={sid} class="pt-1">
               <h3>
                 <button id={sid} type="button" aria-expanded={open} aria-controls={`${sid}-list`}
                         class="flex w-full items-center justify-between rounded-md px-3 py-2 sm:py-1.5
                                text-xs transition-colors font-medium text-slate-slate400
                                hover:bg-slate-slate700/50 hover:text-slate-slate100">
                   {section} <ChevronDown size={14} class={open ? 'rotate-180' : undefined} />
                 </button>
               </h3>
               <div id={`${sid}-list`} class="space-y-0.5">{open && rows}</div>
             </div>
```

| Aspect | Spec |
| --- | --- |
| Pattern | WAI-ARIA disclosure (a button inside the heading, as in the accordion pattern; no menu or tree roles). The group keeps its name from the header button ("Budget, group"), so the header and the Budget row stay distinct. The `h3` keeps heading navigation inside the dialog |
| Header | Full row width, sentence case, the section name only. Same type as the old heading (`text-xs font-medium text-slate-slate400`, 5.7:1 dark, 6.0:1 light), the row hover fill and the global `:focus-visible` ring. `ChevronDown` turns with `rotate-180` when open; no transition, so reduced motion needs nothing |
| Collapsed rows | Not rendered (the list element stays, empty, so `aria-controls` always resolves). The existing `FOCUSABLE` query of `onListKeyDown` and of the Tab trap therefore walks only what is visible, headers included, and skips collapsed rows with no extra code |
| Home, Calendar & Weather | plain rows, unchanged; the divider stays |
| Focus on open | the active row (`a[aria-current="page"]`) when visible, else Home. Because opening the menu expands the current page's section, the active row is visible unless the user collapses it while the menu is open |
| Unchanged | Tab trap, Escape, scroll lock, palette yield, route-change close, row classes, `isItemActive` |

### 10.2 State

| Rule | Spec |
| --- | --- |
| Storage | `localStorage[lsKey('nav:sections')]` (`burrow.nav:sections`), JSON map of group id (`money`, `productivity`, `wellbeing`) to boolean. Per device, never in `app_state`: not exported, not imported, not in backups, and not data for the direct import pristine check. Erase all my data clears it with every `burrow.` key |
| Reading | once, on mount, in `try`. Missing, not JSON, `null`, a number, a string, an array or a non-`true` value all read as closed. Blocked storage (private window, throwing accessor) gives the defaults and toggles still work for the session |
| Default | a section is open only when its value is `true`. With nothing stored, every section is closed except the current page's (below). On Home, Settings or Calendar & Weather nothing is open |
| Current page | each time the menu opens, the section containing the current route is set open (and saved) when it is not. Other entries are left as they are. A route change closes the menu (unchanged), so the next open shows the new page's section: navigating always opens its section and the active row is never hidden |
| Toggle | a header click (or Enter or Space) flips that one section and saves the map. The user may collapse the current page's section while the menu is open; it opens again the next time the menu opens |

### 10.3 Height at 960 x 640 (replaces the section line of 1.3)

`text-xs` line 14px, so a header is 14 + 12 = 26px from `sm` (30px on phones, WCAG 2.5.8 needs 24). Each section costs `pt-1` 4 + 26 = 30px, the same as the old `pt-3` + heading + `pb-1`, so the 1.3 total is unchanged with all three sections open: 598px, 626px with the Founding member badge. Collapsed sections take one header row each, so the default menu is shorter (on Home: 56 + 16 + 28 + 90 + 17 + 28 + 39 = 274px).

### 10.4 Back on Home

On `/` the Back slot shows the same `<button>` as on every other page, with (one spread object of Home-only props) `disabled`, `tabIndex={-1}`, `aria-hidden="true"`, `data-testid="back-placeholder"` and `${SHELL_ICON_BTN} pointer-events-none opacity-40`: same 36px box and `ChevronLeft` 18 as the real button, dimmed, no hover fill, no tooltip, not announced and not focusable (it has no action). One element for both states, so the wordmark never shifts. The Alt+Left and mouse button 4 listeners stay mounted on Home as before. Forced colours: the icon follows the system text colour at the reduced opacity; nothing depends on it.

### 10.5 Bytes

Measured with `npm run build; npm run check:bundle` in the same environment: total JS gzip +125 B over main 560d14b (478355 to 478480), initial JS +205 B (146120 to 146325), both under budget (470 and 146 KiB). `ChevronDown` already shipped in a shared lazy chunk; it now lives in the entry chunk. Chunk file names are content hashes that other chunks import, so any change (even a Tailwind class in a test file, which changes the CSS hash) moves the total by about 20 B either way. Integrated with the Javi current-page notice and its review fixes (branch feat/nav-dropdowns-javi, 2026-10-11): total 478919 B (+564 over main), initial 146615 B (+495), still under budget (143.18 of 146 KiB initial).

### 10.6 Tests and baselines

Unit: `BurgerMenu.test.jsx` (default open section, toggle, Enter and Space, persisted map, malformed and blocked storage, route change opens the target section, arrow keys and Tab skip collapsed rows, `aria-expanded` and `aria-controls`), `BackButton.test.jsx` and `TopBar.test.jsx` (visible, dimmed, disabled, hidden from assistive technology, same size and icon). e2e: `e2e/pages/nav.js` adds `sectionHeader`, `openSection` and `openAllSections`; `menu.spec.js`, `navigation.spec.js`, `back.spec.js` and both axe drawer cases expand sections first. Baselines to regenerate: `screens.spec.js/drawer-open-{light,dark}` (default state over /journal: Health open, Budget and Productivity collapsed), `home-{light,dark}` (dimmed Back); to add: `drawer-open-all-{light,dark}` (all three open).

## 11. Update 2026-10-15: hide subcategories setting

A setting, `nav:hideSubcategories` (`SETTINGS_KEYS.navHideSubcategories`, default false, normalized by `normalizeNavHideSubcategories`), turns the section dropdowns of section 10 into plain links. It is a switch in Settings > General, "Hide subcategories in the menu". The only other copy is the hint under it, "Shows each section as one link to its first page. Every page stays one search away.", no Free or Pro change, no network call, no migration, no server change.

When it is on, `BurgerMenu` renders each section (Financials, Health, Productivity) as one `Link` to the first item of the section (Budget, Journal, Todos) instead of the header button and nested rows:

| Aspect | Behavior |
| --- | --- |
| Row | the section icon (size 16) and the section name, with the normal row classes (not nested) |
| Disclosure | none: no button, no `aria-expanded`, no `aria-controls`, no chevron, no `role="group"` wrapper and no nested rows |
| Current page | the link is active, with `aria-current="page"`, when any page of its section is the current page (for example Subscriptions marks Financials). Focus on open finds it through the existing `a[aria-current="page"]` query |
| Stored state | the `nav:sections` map is not used for rendering while the setting is on (the code still loads it, and opening the menu still saves the current page's section as open), and it applies again when the setting is turned off |
| Other pages | every page of a section stays reachable through search (the command palette); Home, Calendar and Settings are unchanged |
| Keyboard | arrow keys, Tab trap, Escape, scroll lock and route-change close are unchanged; the list simply has fewer links |
