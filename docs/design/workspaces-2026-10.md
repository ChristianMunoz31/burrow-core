# Budget and Journal workspaces (2026-10)

> Superseded 2026-10-10 by docs/design/nav-sections-2026-10.md: Burrow has no workspaces. The Todos-only Work / Home filter still stands.

**Implementation status:** implemented on `feat/workspaces`; see "Implementation outcome" at the end for what shipped. Two parts of this design did not ship in this PR and live on follow-up branches: the Budget summary card (section 1.2, `feat/home-budget-card`) and the shared calculator (section 6.5, `feat/calculator`). Read those sections as the design for the follow-ups, not as shipped behaviour.

Branch `feat/workspaces`, rebased onto `origin/main` 9ba27a5, which already contains PR #87 ("back button and minimalist UI pass"). Design of record: the owner answered every decision on 2026-10-09 (section 7) and the orchestrator ruled on the calculator (section 6.5). Coders implement it exactly.

Builds on `docs/design/minimalism-2026-10.md` (PR #87, merged). Its "Orchestrator decisions" are confirmed in the merged code: the top-bar clock is kept (`TopBar.jsx:104-111`), the per-section Resets are kept as quiet `ResetControl` triggers (`GeneralSection.jsx:80-82`, same in Appearance and Budget), and the Javi "Import transactions" chip is kept (`JaviPanel.jsx:386-401`). This design assumed all three and needs no change for them. Referenced by section, not restated: the `BackButton` contract and placement (its section 1; code `src/components/shell/BackButton.jsx`), `parentPath()` in `src/components/shell/routeKey.js:7-9`, the `history.state.idx` rule, Alt+Left / BrowserBack / mouse 4, and the rules (one primary action per view; one way to do a thing per screen; no new shared component unless it replaces a copy; quiet secondary controls).

This doc supersedes the minimalism doc's Owner decision 5 (its section 6: "`ModeSwitcher` in the top bar while Settings > General also sets the mode"): the top-bar `ModeSwitcher` becomes the `WorkspaceSwitcher`, and the Work/Home/All choice becomes a filter on the Todos page only; Settings > General no longer has it (section 4.3, owner decision 1).

Line numbers in this doc were re-verified against 9ba27a5 (PR #87 merged) in every file this design touches.

Summary (owner answers of 2026-10-09, orchestrator rulings on the calculator):

- Two workspaces, **Budget** and **Journal**. Budget: Budget (Dashboard, Planner, Subscriptions) and transaction import. Journal: Journal, Notes, Habits, Health, Todos, Focus. Shared (listed in both): Home, Calendar, Countdowns, Bookmarks, Weather, Folders, Settings, Browse your data, Javi, palette, bell.
- Workspace is view state only: no route prefix, no redirect, no DB schema change, no new API. The current workspace is the route's workspace when the page belongs to one, else the saved `app_state` key `workspace`.
- One header control: the existing `ModeSwitcher` becomes `WorkspaceSwitcher` (same WAI-ARIA menu button). The header Work/Home/All control is removed.
- Work/Home/All survives only as a filter on the Todos page (a quiet `SegmentedRadio` in the board toolbar, legend "Show todos", options All / Work / Home), stored in the existing `app_state` key `mode` (zero migration; the old global value is the filter's starting value). Every other hook and page stops filtering by tag, Settings > General loses the control, Home and the drawer lose the filter wording, and the tag field leaves every create/edit form except the todo form. Existing tags are kept: forms omit `context`, and every update route only writes keys that are present (section 4.3).
- One shared Home at `/`, filtered by workspace; the app launches on Home. Home in the Budget workspace gains a compact **Budget summary card** (Spent, Budgeted, Remaining for the current month, computed in code from the existing budget hooks; section 1.2).
- A shared **calculator** (WP-E, section 6.5): a small dialog opened from the palette (`Calculator`) or Alt+C in either workspace, exact decimal math in `src/utils/calc.js`, which becomes the one arithmetic engine (`evalAmount` wraps it and keeps today's results). Free, no Pro gate, no network, no AI, server untouched. No Copy button (the result is selectable); insert-into-field is a follow-up.
- Net JS <= 0.00 KiB against main 9ba27a5 (total 468.96 KB printed, budget 470), measured: the gate (section 5.1) covers the whole change including the Budget card and the calculator. Estimate: about +1,500 B gzip before cuts, so cuts are expected; one unified cut list for the whole PR (section 5.1) ends with moving WP-E to its own follow-up PR and then reporting to the owner. The budget is never raised.

## 0. Findings that shape the design

### The existing Work / Home / All mode (two features under one name)

| Part | Where | What it does |
| --- | --- | --- |
| Stored value | `src/contexts/ModeContext.jsx:10` `useSyncedSetting('mode', 'all')`; `src/constants/settingsDefaults.js:15, 28` | `app_state` key `mode`: `'all'`, `'work'` or `'home'` |
| Header control | `src/components/shell/ModeSwitcher.jsx` (aria-label `Workspace mode: <X>`, line 116; menu `aria-label="Workspace mode"`, line 136), mounted at `TopBar.jsx:72`, right after `<BackButton />` (line 69) | Sets `mode` |
| Settings control | `src/components/settings/GeneralSection.jsx:10-14, 17-18, 38-45` (`SegmentedRadio` "Workspace mode"); wired in `src/pages/Settings.jsx:3, 36, 58, 137-139`; reset by `resetGeneral` (`Settings.jsx:93-97`, `setMode` at line 94) | Sets `mode` |
| Palette | `src/components/palette/commands.js:70-95` (`Mode: All/Work/Home`, icons `Layers`, `Briefcase`, `Home`) | Sets `mode` |
| Axis 1: module visibility | `modes` on every nav item (`navItems.js:34-81`), on Home widgets (`Home.jsx:40-51`), on quick actions (`commands.js:97, 104-113`); `moduleVisibleInMode` (`ModeContext.jsx:45-48`) used by `BurgerMenu.jsx:83-90`, `Home.jsx:64`, `commands.js:15`, `CommandPalette.jsx:207`; `ModeGate` (`ModeGate.jsx:6-9`) wraps `/budget/*`, `/weather`, `/health` (`App.jsx:44-46`) and redirects to `/` | Work mode hides Budget, Subscriptions, Health, Weather and Import transactions |
| Axis 2: record filter | `matchesMode` (`ModeContext.jsx:35-39`) in `useTodos.js:98`, `useHabits.js:105`, `useJournal.js:79`, `useNotes.js:66`, `useCalendar.js:89`, `useBookmarks.js:66`, `useCountdowns.js:70`, `useFocus.js:44`; default tag for new items `TodosPage.jsx:49`, `EntryForm.jsx:16, 24-26`. The palette does no record filtering (its quick adds send no tag, `CommandPalette.jsx:160-166`); server search (`server/dataAccess.js`) never filtered by tag | Hides records tagged with the other context |
| Record tags | `context TEXT DEFAULT 'both'` on `todos`, `habits`, `journal`, `calendar_events`, `notes`, `bookmarks`, `focus_sessions`, `countdowns` (`server/db/migrations/001_init.sql:34, 45, 65, 80, 91, 101, 110, 120`); set in `TodoForm.jsx:11, 31, 54, 129-146`, `HabitForm.jsx:7, 14, 26, 36`, `EntryForm.jsx:9, 24-26, 96, 103, 196-212`, `EventForm.jsx:5, 56, 67, 81, 94, 202-218`, `NoteForm.jsx:6, 13, 29, 75-91`, `BookmarkForm.jsx:6, 13, 32, 81-97`, `CountdownForm.jsx:5, 11, 23, 57-73`, `FocusPage.jsx:12, 64, 77, 99, 116, 235-252`; also by Javi write tools `add_todo`, `add_note`, `add_journal_entry`, `add_countdown` (`server/agents/jarvisTools.js:71-101`) | Data, exported, imported |
| Tag shown (read only) | `HabitRow.jsx:44-49` (uppercase tag after the frequency); `EventDetails.jsx:24, 47-54` (accent bar and a tag chip); `EventButtons.jsx:38, 101` (accent dot and bar); colours from `eventLabels.js:9-15` (`ACCENT`, `accentClass`) | Display only |
| Update semantics | Every PATCH route writes only the keys present in the body: `server/dataRoutes.js:359` (todos), `426` (habits, through its `for (const k of [...]) if (k in req.body)` loop), `499` (journal), `561` (calendar), `662` (notes), `712` (bookmarks), `789` (countdowns), the others each `if ('context' in req.body)`. Services send the patch as given (`habitsService.js:20-21`, `notesService.js:20`, `bookmarksService.js:20`, `countdownsService.js:20`, `calendarService.js:24-25`; `journalService.js:32-36` drops undefined keys through `clean`). Hooks merge the patch over the cached row with `{ ...row, ...patch }`, verified in every hook that updates: `useTodos.js:55`, `useHabits.js:55`, `useJournal.js:57`, `useCalendar.js:56`, `useNotes.js:47`, `useBookmarks.js:47`, `useCountdowns.js:47` (`useFocus` has no update: sessions are create-only). Creates default a missing tag to `'both'` (`dataRoutes.js:314, 416, 545, 650, 700, 752, 778`; journal leaves it to the column default, line 486) | A form that omits `context` never changes a stored tag |
| Shown elsewhere | `BurgerMenu.jsx:239-246` ("Work mode" under the drawer title); `Home.jsx:112-116` subtitle; Javi Home context `mode` (`src/utils/javiBuilders/home.js:9`, validated by `server/ai/privacy.js:328-330, 344`); Settings Javi context (`Settings.jsx:56-63`, builder `src/utils/javiBuilders/settings.js:13`) | |
| Cross insights | `useCrossInsights.js:39-67` reads `useHabits`, `useJournal`, `useCalendar`, all record-filtered | Patterns follow the record filter today |
| e2e | `e2e/pages/nav.js:16-24` `setMode`; `e2e/flows/navigation.spec.js:11`, `e2e/first-run/firstRun.spec.js:78`, `e2e/flows/back.spec.js:19` (added by #87; its first test then opens Todos from the drawer on Home); `e2e/support/routes.js` `gated`; `server/__tests__/e2eRoutes.test.js:12-16, 33-36` | |
| Visual baselines | `e2e/visual/screens.spec.js:9-17`: 7 screens (home, budget, todos, journal, calendar, settings, settings-ai) x light/dark = 14 files in `e2e/__screenshots__/screens.spec.js/`; `e2e/visual/onboarding.spec.js`: 2 files in `e2e/__screenshots__/onboarding.spec.js/`. There is no habits or focus baseline | Section 6.2 WP-D |
| Demo data tags | `scripts/seedDemo.js`: todos and countdowns are written with `context: 'both'` (lines 185, 304); habits, events, journal, notes, bookmarks and focus sessions get the column default `'both'`. No demo record is tagged work or home | Removing the tag displays changes no baseline pixel except where a `both` chip is visible (the event details panel, not in any baseline) |

### Persistence facts

- `useSyncedSetting` (`src/hooks/useSyncedSetting.js:23-87`) persists to the DB through `PUT /api/state/:key` (`src/services/stateService.js:35-39`, `server/dataRoutes.js:816-820`) with a `localStorage` cache through `readLocal` / `writeLocal` (`src/utils/syncMode.js:12-35`), which name the browser key with `lsKey()` (`src/utils/storageKeys.js:6`, prefix `burrow.`). It returns `[value, set, { isFetched, isLoading }]` (line 87). The DB is the source of truth; the cache is per origin, and the desktop window's origin changes each launch, so the cache is empty at every desktop start and the DB value wins. `storage:*` keys are the only device-local keys (`settingsDefaults.js:6-7`); none is used here.
- `PUT /api/state/:key` has no key allowlist, only the deny list `isStateRouteDeniedKey` (protected and cloud keys). `PROTECTED_APP_STATE_KEYS` (`server/import/importExport.js:28`) does not apply to a view preference.
- `AUTO_STATE_KEYS` (`server/backup/directImport.js:121-138`, doc comment lines 107-119) lists the keys that do not make a database "used" for the Store direct import. The rule runs twice: when the user stages the import (`isPristineDb`; a used target answers `409 import_target_not_empty`) and again in `reconcileDirectImport()` at the next start, before the swap (`directImport.js:880-887`: `safePristine(...)` at line 881; a used target cancels the staged import, `target_has_data`). `mode`, `theme` and every other setting count as used today. `backupsShowUserData` allows `AUTO_STATE_KEYS.size` extra `app_state` rows (line 191).

### Routing facts

- `App.jsx:36` `<BrowserRouter>` has no `basename` on main. The remote-host branch adds it at build time with exact-once string edits (`scripts/build/remoteBase.js:27-43` in `feat/remote-host-mode`): the literal `<BrowserRouter>` in `src/App.jsx` and `window.location.replace('/')` in `EraseDataDialog.jsx:110` must each stay exactly once and unchanged, or that build fails.
- `ModeProvider` sits outside the router (`App.jsx:35-36`), so anything that needs `useLocation` cannot live in it.
- All page routes are lazy (`App.jsx:14-28`); Home's widgets are static imports of the Home chunk (`Home.jsx:17-26`), so Home widgets are not lazy one by one.
- Server and shell links are flat paths: bell alerts `/todos`, `/habits`, `/health`, `/countdowns`, `/budget` (`server/agents/jarvisAgent.js:777-793`); search results `/todos`, `/notes`, `/journal`, `/bookmarks`, `/countdowns`, `/budget` (`server/dataAccess.js:231-277`); the desktop shell navigates the whole window to `http://127.0.0.1:<port>/settings#updates`, `/settings#data-storage` and `/folders#add-folder` (`src-tauri/src/lib.rs:219-224, 595, 602, 606-608`). Native menu items have no accelerators (`src-tauri/src/menu.rs:66-96`).
- Javi's page key comes from the pathname (`src/constants/javiPages.js:91-101`, `AppShell.jsx:17`); Folders has no Javi page.

### Home, budget and patterns facts

- Home's widget registry is local to `src/pages/Home.jsx:40-51`. There is **no Budget widget** today (only weather, health, todos, habits, journal, notes, bookmarks, focus, countdowns, calendar). Widgets use the shared shell `WidgetCard` (`src/components/shared/WidgetCard.jsx:4-24`: the whole card is one `Link`) and `WidgetSkeleton`.
- A new widget key in an existing saved layout is appended at the end (`useHomeLayout.js:8-16`, `normalize`); a user with no saved layout gets the registry order.
- Budget numbers already computed in code: `useBudgetData()` (`src/hooks/useBudgetData.js:26-45`) shares the `['transactions']` React Query cache with `useRecords` and returns `categories` per month and `source` (`'transactions'`, `'sample'` when there are no transactions, `'error'` when the fetch failed). The month plan is `buildPlan(month, overrides, categories, resolved, defaults)` (`src/utils/budgetPlan.js:297-378`), whose `totals` hold `expenseBudgeted` and `expenseSpent` (lines 352-368); planned amounts default to 0 (`budgetConfig.js:53-62`, `fallbackBudget` starts at 0). The same five synced keys and the same plan memo are written out twice today: `BudgetDashboard.jsx:50-65` and `BudgetPlanner.jsx:74-90`. The Planner labels the columns Budgeted, Spent, Remaining (`BudgetPlanner.jsx:184-186`) and colours remaining red below 0, green above (`BudgetPlanner.jsx:125-126`). `planMonths(now)[0]` is the current month key (`budgetPlan.js:29, 35-39`).
- `useRecords` and `budgetAggregate.js` are already in the Home chunk through `useCrossInsights.js:5, 40` and `crossInsights.js:7`; `useBudgetData`, `budgetPlan.js`, `budgetConfig.js`, `budgetFromTransactions.js` and their JSON are in the Budget chunk only.
- "Patterns across your data" (`CrossInsightsCard.jsx`) shows pairs from `CROSS_INSIGHT_PAIRS` (`src/utils/crossInsights.js:26-33`; server labels and categories `server/crossInsightsRoutes.js:31-38`):

| Pair id | Crosses | Outcome (`y`) |
| --- | --- | --- |
| `sleep_dining` | health x budget | dining spend |
| `sleep_spend` | health x budget | total spend |
| `readiness_spend` | health x budget | total spend |
| `busyness_spend` | calendar x budget | total spend |
| `readiness_habits` | health x habits | habit rate |
| `sleep_mood` | health x journal | mood |

The Bonferroni correction runs across all 6 pairs before any filtering, so the card copy "Tested across 6 pairs" (`CrossInsightsCard.jsx:136-139`) stays true whatever subset is shown.

## 1. Workspace model

Rule of thumb (owner decision 3): Budget holds money. Journal holds your own day: what you write (journal, notes), how you are (habits, health) and what you do (todos, focus). Journal, notes and health are also the cloud categories `server/ai/privacy.js:24-36` keeps off by default. Everything that serves both and is not personal day-to-day tracking (calendar, countdowns, bookmarks, weather, files, settings) is Shared and listed in both workspaces. Folders is the fourth category that is off by default for cloud (`folders: false`), but it is off for a different reason (it holds the text of the user's own files) and it is a file inventory, so it is Shared.

| Module / surface | Route | Workspace | Why (PRODUCT.md: "private, local-first budget and journal tracker") |
| --- | --- | --- | --- |
| Home (Overview) | `/` | Shared, filtered by workspace | One launch page for both; widget registry filter only (section 1.1) |
| Budget: Dashboard | `/budget` | Budget | The budget half of the mission |
| Budget: Planner | `/budget/planner` | Budget | Same module, peer tab |
| Budget: Subscriptions | `/budget/subscriptions` | Budget | Recurring charges are spend |
| Transaction / CSV import | `/budget?import=1` (dialog on the Budget page) | Budget | Budget's primary action |
| Journal | `/journal` | Journal | The journal half of the mission |
| Notes | `/notes` | Journal | Private writing, same privacy class as journal (cloud default off) |
| Habits | `/habits` | Journal | Daily self-tracking; `readiness_habits` pattern lives here |
| Health (Oura) | `/health` | Journal | Sleep and readiness are "how I feel" data next to mood; cloud default off |
| Todos | `/todos` | Journal | Owner decision 3: day-to-day personal tasks, next to habits; the one page that keeps the Work/Home filter (section 4.3) |
| Focus | `/focus` | Journal | Owner decision 3: time spent on your own work, logged next to habits and todos |
| Calendar | `/calendar` | Shared | Planning across both; also feeds `busyness_spend` |
| Countdowns | `/countdowns` | Shared | Planning across both |
| Bookmarks | `/bookmarks` | Shared | General utility |
| Weather | `/weather` | Shared | General utility (opt-in network) |
| Folders | `/folders` | Shared | File inventory, neither money nor journal |
| Settings (all sections) | `/settings` | Shared | Must be reachable from both (section 5) |
| Browse your data | `/settings/data` | Shared | Under Settings |
| Javi panel | every page with a Javi key | Shared, follows the page | Page key unchanged (section 3) |
| Command palette | Ctrl K | Shared, lists every page | Search must find everything; picking a page of the other workspace switches by route |
| Notification bell | TopBar | Shared, all alerts | Alerts are cross-module; clicking one switches by route (a `/todos` alert now opens Journal) |
| Calculator (dialog, WP-E) | no route | Shared | Opened from the palette or Alt+C in either workspace; a dialog over the current page, so no nav item, Javi page key or `workspaceForPath` entry (section 6.5) |

### 1.1 Home

Decision (owner decisions 2 and 10): **one shared Home at `/`, filtered by the existing widget registry, and the app launches on it.** A widget with no `workspace` is shared; a widget with `workspace: 'budget'` or `'journal'` shows only in that workspace. Home keeps BackupHealthNotice, DataFolderWarning, DirectImportNotice and the briefing in both workspaces, which matter for data safety and first run.

| Workspace | Home widgets (registry order, before user hiding) | Patterns card shows |
| --- | --- | --- |
| Budget | budget (new, section 1.2), weather, bookmarks, countdowns, calendar | `sleep_dining`, `sleep_spend`, `readiness_spend`, `busyness_spend` |
| Journal | weather, health, todos, habits, journal, notes, bookmarks, focus, countdowns, calendar | `readiness_habits`, `sleep_mood` |

Registry order (`WIDGETS` in `Home.jsx`): `budget, weather, health, todos, habits, journal, notes, bookmarks, focus, countdowns, calendar`. `budget` is first so a user with no saved layout sees it first in Budget; a user with a saved `pos:homeLayout` gets it appended at the end (existing `normalize` rule) and can drag it.

Home's subtitle names the current workspace (critique; contract in section 6.1), because Home is the one page whose content changes with it. It no longer mentions any tag filter.

One layout across workspaces: the Home layout (`pos:homeLayout`, `useHomeLayout`) stays one shared value. Its card keys are the same 11 widget keys in both workspaces; each workspace shows a subset. Two rules keep that safe:

- Reorder keeps the slots of cards not shown. Today `reorder` (`src/hooks/useHomeLayout.js:58-64`) puts the dragged cards first and appends every other key (`[...newDisplayedOrder, ...rest]`), so a drag in Budget (5 cards) would push the 6 Journal-only cards to the end of the Journal order. The new `reorder` writes the new order only into the positions the shown cards already hold, and leaves every other key in its slot (contract in section 6.1). This also keeps the slot of a card the user hid, which today moves to the end on any drag.
- Reset resets the one shared layout (order and every card's size and hidden flag, in both workspaces). Accepted: Reset is inside Customize, behind its own button, and the result is the default layout everywhere, which is what "Reset" says. No per-workspace layout key (no new key, no migration).

### 1.2 Budget summary card (owner decision 2)

Not shipped in this PR (bundle cut 5): follow-up branch `feat/home-budget-card`. See "Implementation outcome".

A compact card on Home in the Budget workspace that answers "how is this month going" with numbers computed in code. No LLM is involved, and the numbers are not added to the Javi Home context (its shape is unchanged, section 3).

| Item | Spec |
| --- | --- |
| File | `src/components/budget/BudgetWidget.jsx` (new; same `<Module>Widget.jsx` pattern as `TodosWidget.jsx`) |
| Registry entry | `{ key: 'budget', Component: BudgetWidget, workspace: 'budget' }`, first in `WIDGETS` (`Home.jsx`) |
| Shell | Existing `WidgetCard` (`to="/budget"`, `title="Budget"`, `icon={PiggyBank}`, `accent="text-accent-green"`) and `WidgetSkeleton`. No new shared component. `PiggyBank` is already bundled (`navItems.js`) |
| Month | The current local calendar month, `planMonths(new Date())[0]` (`budgetPlan.js:35-39`), always; it does not follow the Budget page's month picker or the Settings "latest month" option. The copy says "this month" |
| Data | `useBudgetData()` (existing; same `['transactions']` cache as `useRecords`, no new fetch path) and the new `useBudgetPlan(month, categories)` hook (below), which reads the same five synced keys the Budget page reads. Only real transactions count: `categories` is passed as `[]` unless `source === 'transactions'`, so the bundled sample data never reaches the card |
| Figures (3) | Spent = `plan.totals.expenseSpent` (actual spend with the user's Spent edits, the Planner's Spent total); Budgeted = `plan.totals.expenseBudgeted` (the Planner's Budgeted total for expense groups); Remaining = Budgeted minus Spent. All formatted with the existing `formatCurrency` |
| Layout | Big figure: Spent (`text-3xl font-bold tabular-nums`, like the other widgets). Under it: `spent this month` (`text-xs text-slate-slate400`). Then one row `Budgeted <B>` and `Remaining <R>` (`text-xs`, `tabular-nums`; Remaining uses the Planner's colours: `text-accent-red` below 0, `text-accent-green` above 0, `text-slate-slate400` at 0) |
| No budget set | Budgeted is 0 and Spent is above 0: the row reads `No budget set for this month.` instead of Budgeted / Remaining |
| Empty state | Spent and Budgeted are both 0 (no transactions this month and no budget): `No budget or spending this month yet.` and a quiet second line `Import transactions or set a budget →` in `text-xs text-accent-indigo` (same pattern as FocusWidget's `Start focusing →`). The whole card links to `/budget`; there is no second link inside (the card is already a link) |
| Error | `source === 'error'`: `Couldn't load your transactions. Open Budget to try again.` (`text-xs text-slate-slate400`, as FocusWidget) |
| Loading | `WidgetSkeleton` while the transactions load or until all five budget settings have fetched once (`ready` from `useBudgetPlan`), so a desktop launch never flashes "No budget set" before the saved plan arrives |
| Accessible name | The `WidgetCard` link's name is its text in order, for example "Budget $412.50 spent this month Budgeted $1,200.00 Remaining $787.50". No extra ARIA |
| Lazy or not | Home widgets are static imports of the lazy Home chunk, so the card is static too (same as every other widget). It never enters the initial chunk (Home is lazy, `App.jsx:14`). Its data modules (`useBudgetData`, `budgetPlan.js`, `budgetConfig.js`, `budgetFromTransactions.js` and their JSON) move from the Budget chunk into a chunk shared by Home and Budget: module bytes move, they are not added. WP-B's report confirms none of them appears in an asset listed in `dist/index.html` |

`src/hooks/useBudgetPlan.js` (new; replaces the two copies in `BudgetDashboard.jsx:50-65` and `BudgetPlanner.jsx:74-90`, so the rule "no second way" holds and the Budget chunk shrinks):

```js
import { useMemo } from 'react';
import { useSyncedSetting } from './useSyncedSetting';
import { applySpentOverrides, buildPlan, payeeIncomeForMonth, resolveStructure, withDerivedIncome } from '../utils/budgetPlan';

// Stable fallbacks (a fresh literal each render would defeat the memos).
const EMPTY_OBJ = Object.freeze({});
const EMPTY_ARR = Object.freeze([]);

/**
 * The month plan the Budget Dashboard, the Budget Planner and the Home Budget card share.
 * @returns {{ plan, resolved, augCats, ready: boolean, targets, setTargets, payees, setPayees,
 *   spentOv, setSpentOv, structure, setStructure, defaults, setDefaults }}
 *   ready: every one of the five settings has been fetched once (meta.isFetched).
 */
export function useBudgetPlan(month, categories) {
  const [targets, setTargets, m1] = useSyncedSetting('budget:targets', EMPTY_OBJ);
  const [payees, setPayees, m2] = useSyncedSetting('budget:payees', EMPTY_ARR);
  const [spentOv, setSpentOv, m3] = useSyncedSetting('budget:spent', EMPTY_OBJ);
  const [structure, setStructure, m4] = useSyncedSetting('budget:structure', EMPTY_OBJ);
  const [defaults, setDefaults, m5] = useSyncedSetting('budget:defaults', EMPTY_OBJ);
  const resolved = useMemo(() => resolveStructure(structure), [structure]);
  const augCats = useMemo(
    () => applySpentOverrides(categories, month, spentOv, resolved.categories),
    [categories, month, spentOv, resolved],
  );
  const plan = useMemo(
    () => buildPlan(month, withDerivedIncome(targets, month, payeeIncomeForMonth(payees, month)), augCats, resolved, defaults),
    [month, targets, payees, augCats, resolved, defaults],
  );
  const ready = [m1, m2, m3, m4, m5].every((m) => m.isFetched);
  return { plan, resolved, augCats, ready, targets, setTargets, payees, setPayees, spentOv, setSpentOv, structure, setStructure, defaults, setDefaults };
}
```

`BudgetDashboard.jsx` replaces lines 50-65 with `const { plan, resolved, augCats, structure } = useBudgetPlan(month, categories);` (the rest unchanged). `BudgetPlanner.jsx` replaces lines 74-78 and 81-90 (keep `const [editing, setEditing] = useState(false);` at line 79) with `const { plan, targets, setTargets, payees, setPayees, spentOv, setSpentOv, structure, setStructure, defaults, setDefaults } = useBudgetPlan(month, categories);` (the rest unchanged; drop the `useSyncedSetting`, `applySpentOverrides`, `buildPlan`, `payeeIncomeForMonth`, `resolveStructure` and `withDerivedIncome` imports and `useMemo` if unused; `spentKey` and `targetKey` stay). The Planner's numbers are unchanged: it computed `augCats` inside the plan memo with the same arguments. Frozen fallbacks are safe for every consumer of the returned values (verified in 9ba27a5): the Planner's own setters spread `prev` (`BudgetPlanner.jsx:94-112`); `CategoryEditor` (props `structure, setStructure, defaults, setDefaults`, `CategoryEditor.jsx:108`) copies `prev` before every patch (`patchGroups` / `patchCats` at lines 137-160 clone `added`, `renamed`, `hidden`, `order`; `setDefault` / `clearDefault` at 249-250 spread `prev`); `IncomePayees` (props `month, payees, setPayees`, `IncomePayees.jsx:24`) builds new arrays (`[...list, ...]`, `map`, `filter`, lines 71-79). No prop of either component changes. `BudgetDashboard.jsx` keeps its own `EMPTY_OBJ` / `EMPTY_ARR` (lines 36-37) only if still used after the swap, else deletes them.

`BudgetWidget.jsx` contract:

```jsx
export default function BudgetWidget() {
  const { categories, source, loading } = useBudgetData();
  const month = planMonths(new Date())[0];
  const { plan, ready } = useBudgetPlan(month, source === 'transactions' ? categories : EMPTY);
  const spent = plan.totals.expenseSpent;
  const budgeted = plan.totals.expenseBudgeted;
  const remaining = budgeted - spent;
  // states, in order: loading || !ready -> skeleton; source 'error' -> error line;
  // spent === 0 && budgeted === 0 -> empty state; budgeted === 0 -> spent + "No budget set";
  // else spent + Budgeted / Remaining row. Strings in "UX copy".
}
```

Byte estimate (gzip, not measured): component and registry entry +400 B; wiring of the chunk shared by Home and Budget +150 B (Vite's existing `shared` group, `vite.config.js:51`, picks up `src/` modules imported by 2 or more chunks); `useBudgetPlan` replacing two copies -60 B. Card total about +490 B, inside the change's net (section 5.1). If the measured gate still fails after cuts 1 to 4, cut 5 drops the card (section 5.1).

## 2. Switcher UX

### Placement

TopBar left cluster in 9ba27a5: burger (fixed, `BurgerMenu.jsx:201-212`), `<BackButton />` (`TopBar.jsx:69`), **`WorkspaceSwitcher`** (replaces `<ModeSwitcher />` and its comment at `TopBar.jsx:71-72`, same position), greeting, `DevBuildBadge`, `TrialBadge`. On `/` the `BackButton` renders an `invisible` `aria-hidden="true"` placeholder with the same 36x36 footprint (`BackButton.jsx:73`, `data-testid="back-placeholder"`), so the switcher stays in the same place on every route; it is the first focusable control of the cluster on `/` only because the placeholder is not focusable. No second header dropdown.

### Form

Dropdown menu button (owner decision 8): the existing `ModeSwitcher` file is renamed and re-pointed, keeping its full WAI-ARIA pattern (trigger `aria-haspopup="menu"`, `role="menu"`, `menuitemradio` with `aria-checked`, ArrowUp/ArrowDown/Home/End, Tab parks on trigger, Escape restores focus, yields to the palette on Ctrl K and `palette:open`). Trigger shows the workspace icon and name at every width (critique: the name is the whole point of the control, so it is no longer hidden below `sm` as `ModeSwitcher.jsx:123` does today). On a narrow window the greeting `<h1>` and date give way instead: they already `truncate` inside a `min-w-0` block (`TopBar.jsx:74-79`), so the switcher never shrinks or wraps.

| Attribute | Value |
| --- | --- |
| Trigger `aria-label` | `Workspace: Budget` / `Workspace: Journal` (contains the visible name, WCAG 2.5.3); `Workspace` while not `ready` |
| Trigger `title` | `Switch workspace (Alt+1, Alt+2)` |
| Trigger `aria-keyshortcuts` | None: Alt+1 and Alt+2 switch, they do not focus or open the trigger, so the attribute belongs on the items only |
| Menu `aria-label` | `Workspace` |
| Items | `Budget` (icon `PiggyBank`, `aria-keyshortcuts="Alt+1"`), `Journal` (icon `Notebook`, `aria-keyshortcuts="Alt+2"`); icons already in `navItems.js`, so 0 new icon bytes. Each item shows its shortcut as a visible hint after the label, `<kbd aria-hidden="true">` styled like the Search hint (`TopBar.jsx:96`: `text-[10px] text-slate-slate400`), before the check slot, so a mouse user sees the shortcut every time they open the menu |

### Keyboard shortcut

Owner decision 7: **Alt+1 Budget, Alt+2 Journal**, matched on `e.code` (`Digit1`, `Digit2`) so non-US layouts work. Ctrl+Shift+1 / Ctrl+Shift+2 is the fallback if the desktop check (Open question 1) finds a problem; switching to it changes only `WORKSPACES[].keys`, the guard (`e.ctrlKey && e.shiftKey` instead of `e.altKey`) and the strings in "UX copy".

Collision check (all `keydown` listeners in `src/`, 9ba27a5): Ctrl/Cmd K (`useCommandPalette.js:14`, `LazyCommandPalette.jsx:33`, `ModeSwitcher.jsx:36`, `BurgerMenu.jsx:136`); Escape/Tab/arrows (`Modal.jsx:124`, `NotificationBell.jsx:25-31`, `FolderMoreMenu.jsx:73`, `useScrollSpy.js:132` scroll keys only); Alt+Left and BrowserBack (`BackButton.jsx:47-54`), mouse button 4 (`BackButton.jsx:57-61`). Native menu: no accelerators (`menu.rs:66-96`). Ctrl+1..8 is rejected: browsers take it for tab switching before the page sees it (web build). Alt+digit has no Chromium binding on Windows; on Linux Chrome it switches tabs (web build only, browser wins, harmless). WebView2: verify by hand (Open question 1).

Guards, same rules as Back: ignored when Ctrl, Meta or Shift is also held, when `e.defaultPrevented`, or when `e.repeat` (a held Alt+1 fires one switch, not a stream of navigations); `preventDefault()` always on a match that is not a repeat; no switch while a modal is open or focus is in an editable element, with exactly the definitions #87 shipped in `BackButton.jsx:6-9` (a `[aria-modal="true"]` element that is not inside an `[inert]` subtree, so a dialog playing its closing animation does not block; editable = text-like inputs, `textarea`, `select`, `contenteditable`, but not checkbox, radio, range or button inputs). WP-A moves those two definitions unchanged into `shortcutGuard.js` (section 6.1).

### What switching does

| Situation | Behaviour |
| --- | --- |
| Pick the other workspace | Save `workspace` to `app_state`, then `navigate(start)` as a PUSH: Budget -> `/budget` (BudgetPage's default view may then REPLACE it with `/budget/planner`, `BudgetPage.jsx:128-136, 211-216`), Journal -> `/journal` |
| Pick the current workspace | Close the menu, nothing else (same as today's ModeSwitcher) |
| On a Shared page when switching | Leaves it: always goes to the target's start page (owner decision 9) |
| Last page per workspace | Not remembered (owner decision 9). Back covers "go back to where I was" because the switch is a push |
| Back right after a switch | `navigate(-1)` (idx > 0) returns to the previous page; the header follows the route: an owned page of the other workspace switches it back and saves it; a Shared page keeps the newly saved workspace. One rule covers both: Back moves between pages, never between workspaces; the workspace changes only when the page you land on belongs to one. So Home, Calendar or Settings reached by Back show the new workspace (Home with the new widget set), while `/budget` or `/todos` reached by Back is their own workspace again |
| Back with no history | Minimalism `parentPath()` unchanged: `/settings/*` -> `/settings`, else `/`. Flat routes, so nothing workspace-specific (section 4) |
| Deep link to an owned page (`/habits`, `/todos`, `/budget?import=1`, a bell alert, a search result, Settings > Budget "Budget planner" link) | Header shows that page's workspace at once; the switcher saves it once the saved value has loaded |
| Deep link to a Shared page (`/settings#updates`, `/folders#add-folder`) | Saved workspace kept, URL untouched (hash and query intact) |
| "All" view | None (owner decision 4). Everything stays reachable through Shared Home, the palette and the switcher |
| App launch | Home `/` (owner decision 10; shell bootstrap redirects to `/`); header shows the saved workspace |

### First run

Owner decision 5: the onboarding welcome step gains one `SegmentedRadio` under the name field, legend "Where do you want to start?", options Budget (selected) and Journal, hint "Budget is for money. Journal is for writing, habits, health, todos and focus. You can switch any time at the top of the window." No new step; Skip for now still finishes in one click and keeps the choice. Choosing Journal skips the "Starter budget" step (the Javi step's button finishes the flow). Nothing is written for the default choice. A fresh install with no answer starts in Budget (owner decision 11).

### Persistence

| Key | Where | Shape | Written by |
| --- | --- | --- | --- |
| `workspace` (new) | `app_state` through `useSyncedSetting` (DB truth, `burrow.workspace` localStorage cache only) | JSON string `"budget"` or `"journal"`; anything else reads as unset | `switchTo`, the route sync in `WorkspaceSwitcher` (only when the saved value is loaded and differs), onboarding finish (only when not the default) |
| `mode` (existing, new meaning) | `app_state` through `ModeProvider` (`ModeContext.jsx:10`), unchanged storage | `"all"`, `"work"` or `"home"` | Only the Todos page filter (section 4.3). Read once by `useWorkspace` for the initial workspace |
| Last page per workspace | Not stored | | |

Read rule (pure, no write, this is the migration): `workspaceForPath(pathname) ?? normalizeWorkspace(stored) ?? (mode === 'work' ? 'journal' : 'budget')`. Seeding for existing users stays as it was: `mode = 'work'` (Budget was hidden for them) starts in Journal, `'home'` and `'all'` start in Budget. Reason it still holds with Todos and Focus in Journal: a Work user's pages (todos, habits, journal, notes, focus) are now all in Journal, so Journal is still where they were. The seed only matters until the first visit to an owned page, which saves `workspace` (route sync). `mode` itself is never rewritten by the workspace code; it is now the Todos filter (section 4.3).

No flash of the wrong workspace (critique): the desktop window's `localStorage` cache is empty at every launch (Persistence facts), so before the `GET /api/state/workspace` answer the rule above would paint Budget for a Journal user and then flip Home and the drawer. `useWorkspace` therefore also returns `ready` = `fromRoute !== null || meta.isFetched`. While not `ready`, the switcher trigger keeps its size with an empty, `invisible` label and `aria-busy="true"`, and Home renders its notices and the briefing but holds the widget grid and the Patterns card (the grid shows `WidgetSkeleton`s). On an owned page the route answers at once, so nothing waits there. In one line: the DB is the source of truth, and the `localStorage` cache never decides the workspace on a Shared page, because `ready` waits for the fetch (`meta.isFetched`), not for the cache.

`AUTO_STATE_KEYS` gains `['workspace', (v) => v === 'budget' || v === 'journal']`. Reason: the route sync writes `workspace` by itself on the first visit to an owned page (on a fresh install the saved value is unset, so opening `/budget`, `/journal`, `/todos`, a bell alert or a search result writes it), with no user data involved. Without the entry:

- a staged "Import from your existing Burrow" would be cancelled: the user stages the import, keeps using the app until the restart (any visit to an owned page writes the row), and `reconcileDirectImport()` re-checks pristine at the next start (`directImport.js:881`, `safePristine`), sees a used database and discards the stage (`target_has_data`);
- a fresh Store install would count as used as soon as the user opened an owned page once, so the import button would answer `409 import_target_not_empty`.

The import replaces `burrow.db`, so the value moves aside with it. An invalid value (for example `"other"`) counts as used, like every unknown key. `backupsShowUserData` gets its +1 allowance automatically through `AUTO_STATE_KEYS.size` (QA I2: this makes that check one `app_state` row looser for every backup, including a backup whose extra row is a user key rather than `workspace`; accepted, because the target's backups are moved aside to `import-aside/<stamp>/backups`, never deleted, so a wrong "unused" verdict loses nothing). `mode` is not added: it is written only by a user click on the Todos filter, so it still counts as used, as today.

The doc comment above `AUTO_STATE_KEYS` (`directImport.js:107-119`) gains the principle and the entry: "View-state keys with no user data that the app writes on navigation, not on a user edit: `workspace` (the route sync of `useWorkspace` saves the workspace of the owned page the user opens; only `"budget"` or `"journal"`, anything else counts as used)."

Import / export / restore: `workspace` is a normal `app_state` row: exported in the ZIP, written by an import, restored with a backup, cleared by Erase (Erase keeps only the license rows). Not added to `PROTECTED_APP_STATE_KEYS` or `HIDDEN_APP_STATE_KEYS` (a view preference, like `theme`). Settings "Reset all" and "Reset general settings" touch neither `workspace` nor `mode`.

## 3. Javi and patterns

| Item | Decision |
| --- | --- |
| Javi page key | Unchanged: derived from the pathname by `resolveJaviPageKey` (`javiPages.js:91-101`). Owned pages already carry their workspace (`budget`, `budget-planner`, `subscriptions`, `journal`, `habits`, `notes`, `health`, `todos`, `focus`). No new route, so no new page key |
| Javi on Home | Page key `home`; `buildHomeContext` (`javiBuilders/home.js`) unchanged in shape. `widgets` is already the filtered, workspace-specific list (it now includes `budget` in Budget), so the Home insight card follows the workspace with no server change. The Budget card's figures are not added to the context |
| `mode` in Javi contexts | Home: `Home.jsx` stops passing `mode`, so `buildHomeContext` sends its default `mode: 'all'` (`home.js:9`); server `HOME_KEYS` / `HOME_MODES` (`server/ai/privacy.js:328, 330, 344`) unchanged, so no server, prompt or `PROMPT_VERSION` change. Settings: `Settings.jsx` stops passing `mode`, so `buildSettingsContext` sends `mode: null` (`settings.js:13`). Todos: unchanged; `buildTodosContext` gets the shown (filtered) list, as today (`TodosPage.jsx:26-28`) |
| Javi write tools | `add_todo`, `add_note`, `add_journal_entry`, `add_countdown` keep their optional `context` argument (`server/agents/jarvisTools.js:71-101`) and compact rows keep a non-`both` tag (lines 175, 192, 213). Unchanged in this change: a tag Javi sets on a note, entry or countdown is stored and has no visible effect. Follow-up (Open question 3) |
| Allowlist | `src/constants/javiPages.js` and `server/javi/pages.js` unchanged; `javiPagesParity.test.js` and `cloudPolicy.test.js:67` unaffected |
| Cloud policy | No change to `applyPagePolicy`, `PAGE_CATEGORIES`, `HOME_KEYS`, `HOME_MODES` or cloud categories. Journal, notes, health, folders stay held back by default |
| Patterns card | Stays on Home only. Each workspace shows the pairs whose outcome (`y`) is in it: Budget = the 4 spend pairs, Journal = `readiness_habits`, `sleep_mood` (table in section 1.1). Rule: a cross-workspace pair belongs to the workspace of its outcome. The pairs are filtered by workspace **before** the `MAX_SHOWN = 4` cap (`src/utils/crossInsights.js:22`, `.slice(0, MAX_SHOWN)` at line 398): `computeCrossInsights` takes the workspace and evaluates only that workspace's pairs (contract in section 6.1). The significance gate does not change with the subset (`Z_GATE` is fixed for 6 pairs, line 15), so "Tested across 6 pairs" stays true. Explain sends only the shown pairs (server validates ids from `PAIR_META`, unchanged). Inputs now read every record: the hooks no longer filter by tag (section 4.3) |
| Free / Pro | No change: findings free, Explain Pro (`isKnownFree(entitlements, 'explain')`, `CrossInsightsCard.jsx:63`), briefing Pro, Free Javi one card per page. The workspace pair filter, the Budget card and the calculator read no entitlement and run the same for Free and Pro |
| Home thread | The `home` advice thread is not reset on a switch (default kept); the next auto-advice or Refresh uses the new context |

## 4. Routes and data

### 4.1 Decision: flat routes, workspace as view state

Owner decision 6. Prefixes (`/budget/...`, `/journal/...`) would move `/habits`, `/notes`, `/health`, `/todos`, `/focus` and Shared pages under prefixes, need a redirect for every server, shell and saved link listed in section 0, and gain nothing: the route already identifies the owning workspace. With flat routes **no route is added, renamed or redirected**, `App.jsx` loses only the three `ModeGate` wrappers, `parentPath()` stays as the minimalism doc wrote it, the Tauri shell and server links are untouched.

### 4.2 Entry points (no redirect is added; table proves each keeps working)

| Entry | Path | Result after this change |
| --- | --- | --- |
| Help > Check for updates (`lib.rs:606-608`) | `/settings#updates` | Settings, hash intact, workspace = saved |
| Help > Export my data (`lib.rs:602`) | `/settings#data-storage` | Same |
| File > Add a folder... (`lib.rs:595`) | `/folders#add-folder` | Folders; the page clears the hash itself (`FoldersPage.jsx:53`) |
| Desktop bootstrap (`server/desktop/auth.js`) | `/` | Home |
| Bell alerts (`jarvisAgent.js:777-793`) | `/countdowns` | Shared, workspace kept |
| | `/todos`, `/habits`, `/health` | Journal |
| | `/budget` | Budget |
| Palette search results (`dataAccess.js:231-277`) | `/todos`, `/notes`, `/journal` / `/budget` / `/bookmarks`, `/countdowns` | Journal / Budget / Shared |
| Palette Import transactions (`openTransactionImport.js:7`) | `/budget?import=1` | Budget, query intact (the page opens the dialog) |
| Palette quick actions `?new=1` (`commands.js:109-112`) | `/countdowns`, `/bookmarks`, `/calendar` / `/habits` | Shared / Journal, query intact |
| Palette inline quick adds (`CommandPalette.jsx:160-166`) | none (todo, note, journal entry created in place, no tag sent, so stored as `both`) | No navigation |
| Palette "Settings: <section>" (`commands.js:59`) | `/settings#<id>` | Shared |
| Settings > Budget "Budget planner" (`BudgetSection.jsx:50`) | `/budget/planner` | Budget |
| TrialNotice, TrialBadge, ProGateNotice, ProTrialPrompt | `/settings#license` | Shared |
| NetworkOptInNotice, AiUnavailable, WithheldNotice, CloudHint, CloudAiBlock, ApiKeyRow, AiSection, FolderCard, ImportTransactionsDialog, BackupHealthNotice, DirectImportNotice | `/settings#network`, `#ai`, `#data-storage` | Shared |
| Home widget cards | `/budget` / `/health`, `/habits`, `/journal`, `/notes`, `/todos`, `/focus` / `/weather`, `/bookmarks`, `/countdowns`, `/calendar` | Budget / Journal / Shared |
| BudgetPage default view (`BudgetPage.jsx:211-216`) | `/budget` -> `/budget/planner` (search kept, as today) | Budget |
| BudgetPage unknown tab (`BudgetPage.jsx:236-239`) | `/budget/x` -> `/budget` | Budget |
| Unknown path (`App.jsx:58`) | -> `/` | Home |
| Saved `mode = 'work'` hitting `/budget`, `/weather`, `/health` | Used to bounce to `/` (`ModeGate`) | Now opens the page (no page is ever blocked) |
| Saved `mode` | | Todos filter value and read-only input to the initial workspace (section 2) |

### 4.3 Data, and the Work/Home filter on Todos only (owner decision 1)

No DB schema change, no migration file, no API change. The `context` column of all 8 tables stays, with its data, export, import and restore exactly as today. Only the UI changes.

**The Todos filter.**

| Item | Spec |
| --- | --- |
| Where | `src/components/todos/KanbanBoard.jsx:239-258`, the board toolbar row (today `flex items-center justify-end` with Add todo and Columns). It becomes `flex flex-wrap items-center justify-between gap-2`; the filter sits at the start (left), Add todo and Columns stay at the end, in the same order. KanbanBoard gains one optional prop `toolbarStart` (a React node rendered first in that row); TodosPage passes the filter through it, so KanbanBoard knows nothing about tags |
| Control | The existing `SegmentedRadio` (`src/components/settings/SegmentedRadio.jsx`), not a new component. It gains one optional prop `hideLegend` (default false): when true the `<legend>` gets `sr-only` instead of its visible classes, so the toolbar stays one row and quiet. Options `All`, `Work`, `Home` (values `all`, `work`, `home`), `name="todos-filter"` |
| Accessible name | Native radios in a `fieldset` with the legend `Show todos` (visually hidden). A screen reader says "Show todos, group, All, radio button, checked, 1 of 3". Arrow keys move and select (native radio behaviour); the selected option also shows the check icon and the forced-colors outline (`SegmentedRadio.jsx:4-8, 36`); options keep the `min-h-9` touch target |
| Quiet | No hint text (minimalism rule 5: the labels say it). The filled selected pill is the existing SegmentedRadio look (same as the Budget view switcher); the primary action of the view stays Add todo |
| State and persistence | `const { mode: filter, setMode: setFilter } = useMode()` in `TodosPage.jsx`: the existing `app_state` key `mode`, DB-backed with the localStorage cache, written on each pick with no toast (same call shape as `ModeSwitcher.jsx:102`). Zero migration: whatever the old global control saved is the filter's first value. Chosen over a new key because a new key would need a copy step from `mode` and a second default, and over local component state because the choice should survive a restart like every other Burrow view setting |
| Filtering | Moves out of `useTodos.js:95-100` (which returns every todo) into `TodosPage.jsx`: `const shown = useMemo(() => todos.filter((t) => matchesMode(filter, t.context)), [todos, filter]);`. `shown` goes to `KanbanBoard` and to `buildTodosContext`. Records tagged `both` show under every option (`matchesMode`, `ModeContext.jsx:35-39`) |
| New todo default tag | `defaultContext={filter !== 'all' ? filter : 'work'}` (today's rule, `TodosPage.jsx:49`). `TodoForm` keeps its Context field (the only form that does) |
| Unchanged board behaviour | Drag reorder, Mark done and Clear column work on the shown todos only, as they did under the old global filter (`computeTodoReorder(todos, ...)` gets the shown list; "Clear column" deletes the shown cards it counts) |
| Home | The Todos widget (`TodosWidget.jsx:7`) now counts every todo, whatever the filter: the filter belongs to the Todos page only |

**Hooks that stop filtering.** Each drops `matchesMode` and `useMode` and returns every record (what `mode = 'all'` returns today):

| File | Lines |
| --- | --- |
| `src/hooks/useTodos.js` | 4, 10, 95-100 (filter moves to TodosPage; `todos = query.data ?? EMPTY` with a module-level `EMPTY`) |
| `src/hooks/useHabits.js` | 4, 10, 104-107 |
| `src/hooks/useJournal.js` | 4, 10, 78-81 |
| `src/hooks/useNotes.js` | 4, 10, 65-68 |
| `src/hooks/useCalendar.js` | 4, 10, 84-92: keep the sort by start but **add `.slice()` before `.sort(...)`**: today `.filter` makes the copy that `.sort` then sorts in place (lines 88-90); without it `.sort` would mutate the React Query cache array. Deps `[query.data]`; fix the comment at 84-85 |
| `src/hooks/useBookmarks.js` | 4, 10, 65-68 |
| `src/hooks/useCountdowns.js` | 4, 10, 67-73: drop only line 70 (`.filter`); keep `.slice()` (line 71) and the sort by `targetDate` (line 72), so the cache is never sorted in place; deps `[query.data]` |
| `src/hooks/useFocus.js` | 4, 20, 43-46 (`today` then counts every session) |

Every consumer follows: Home widgets, module pages, `useCrossInsights` (patterns now read every record). The palette and server search never filtered by tag, so nothing changes there.

**Tag field removed from every form except TodoForm.** Since tagging now matters only for Todos, these fields go. New records get `both` from the server (create routes in section 0, Update semantics). Default change, noted (QA cycle 3, I2): new non-Todos records now default to `both`, where the forms used to preselect `work` (notes `NoteForm.jsx:13`, bookmarks `BookmarkForm.jsx:13`, countdowns `CountdownForm.jsx:11`, focus sessions `FocusPage.jsx:77`) or the current mode (journal entries, `EntryForm.jsx:24-26`, `both` under All); habits and events already defaulted to `both`. No visible effect: nothing outside the Todos page filters by or shows the tag after this change.

| File | Remove |
| --- | --- |
| `src/components/habits/HabitForm.jsx` | `CONTEXTS` (line 7), `context` state (14), `context` in the payload (26), the `context` entry of `selects` (36) |
| `src/components/journal/EntryForm.jsx` | `useMode` import (4), `CONTEXTS` (9), `viewMode` (16), `context` state (24-26), `context` in both payloads (96, 103), the Context select block (196-212); the Mood select then sits alone in its grid row (`grid grid-cols-1 sm:grid-cols-2`, line 177: keep the grid so Mood keeps its half width). The free-text Tags field (215-247) stays: it is a different feature |
| `src/components/calendar/EventForm.jsx` | `CONTEXTS` (5), `context` in both `initialFields` branches (56, 67), `context` state (81), `context` in the payload (94), the Context block (202-218) |
| `src/components/notes/NoteForm.jsx` | `CONTEXTS` (6), `context` state (13), `context` in the payload (29), the Context block (75-91); Color keeps its `grid grid-cols-2` row at half width (line 57) |
| `src/components/bookmarks/BookmarkForm.jsx` | `CONTEXTS` (6), `context` state (13), `context` in the payload (32), the Context block (81-97) |
| `src/components/countdowns/CountdownForm.jsx` | `CONTEXTS` (5), `context` state (11), `context` in the payload (23), the Context block (57-73) |
| `src/components/focus/FocusPage.jsx` | `CONTEXTS` (12), `contextId` (64), `context` state (77), `context` in the `log` payload (99) and in the effect deps (116), the "Tag sessions as" label and select (235-252); `useId` import drops if unused |

**Existing tags are never dropped or overwritten on edit.** Proof, per layer: (1) the forms above build their payload without a `context` key; (2) the services send the patch as given (`JSON.stringify` drops nothing that is not there; `journalService.js:32-36` also drops undefined keys); (3) every PATCH route writes `context` only when the key is in the body (`dataRoutes.js:426` habits key loop; `499, 561, 662, 712, 789` `if ('context' in req.body)`), so the stored tag stays; (4) the hooks' optimistic update merges the patch over the cached row (`{ ...row, ...patch }`, verified per hook in section 0, Update semantics), so the cached tag stays too. No pass-through of the old value is needed and none is added. Focus sessions are create-only (no edit), so nothing to preserve there.

**Tag displays removed** (read only, they show a tag the user can no longer change): `HabitRow.jsx:44-49` (the uppercase tag after the frequency); `EventDetails.jsx:47-54` (the tag chip; the "Imported" chip stays, so the wrapper condition becomes `imported`); the work/home accent colours: delete `ACCENT` and `accentClass` (`eventLabels.js:9-15`) and use the default `bg-slate-slateBlueLight` at the three call sites (`EventDetails.jsx:24`, `EventButtons.jsx:38, 101`). Data unchanged.

**Removed from Settings and the shell.** `GeneralSection.jsx`: `MODE_OPTIONS` (10-14), the `mode` / `onModeChange` props (17-18) and the `SegmentedRadio` block (38-45); its `SegmentedRadio` import (line 5) goes, nothing else in the file uses it; card subtitle `Profile and Javi.` (line 33). The quiet `ResetControl` that #87 kept (lines 80-82) stays as it is. `Settings.jsx`: `useMode` import and call (3, 36), `mode` in `buildSettingsContext` (58), `setMode` in `resetGeneral` (94), the two props (138-139). Reset general and Reset all no longer write `mode`. `settingsDefaults.js:15, 28` keep the `mode` key and default (no other change; `ModeProvider` keeps its literal). Home and drawer subtitles lose their filter wording (section 6.1).

**`ModeContext.jsx` after this change** keeps `MODES`, `matchesMode`, `ModeProvider` and `useMode` (WP-B deletes `moduleVisibleInMode`, in the same WP that rewrites its last consumers `Home.jsx`, `commands.js` and `CommandPalette.jsx`; section 6.3, Symbol sequencing). Its consumers are exactly `TodosPage.jsx` (filter) and `useWorkspace.js` (initial workspace). The file's top comment says: "`mode` is the Todos page filter (All, Work, Home). Stored in app_state `mode`."

### 4.4 Subpath safety (`BURROW_WEB_BASE`, `import.meta.env.BASE_URL`)

- New code uses only `useLocation().pathname` (basename-relative) and `navigate()` / `<Link>`; no `window.location` path read, no `href="/..."`.
- Do not edit the `<BrowserRouter>` line in `App.jsx` or `EraseDataDialog.jsx:110` (remote build seam, exact-once match).
- Existing code that is not router-relative, for the record: `EraseDataDialog.jsx:110` `window.location.replace('/')` (handled by the remote seam), `CommandPalette.jsx:135` and every service's absolute `/api/...` fetch (handled by the remote fetch shim), `SettingsLayout.jsx:197` (hash-only `replaceState`, safe), the shell's absolute URLs in `lib.rs` (desktop always serves at `/`, safe).

## 5. Constraints

| Constraint | Path in Budget | Path in Journal | Guarded by |
| --- | --- | --- | --- |
| No Free/Pro change | No gating code touched (`server/pro.js`, `useEntitlements`, `ProGateNotice`) | same | existing `proTierMatrix.test.js`, CrossInsightsCard tier tests |
| AI summarizes, code calculates | Budget card figures from `buildPlan` totals; calculator results from `calc.js` | Calculator from `calc.js` | WP-B card test (figures equal `buildPlan` for the same inputs); WP-E `calc.test.js` |
| Calculator: Free, local, no AI | No Pro gate, no network call, no AI call, no server file, route, API, `app_state` key or `localStorage` key; history in memory only | same | WP-E: no server file in its file set; no-dynamic-code test and lint rules (section 6.5, E.3 and E.6) |
| Export my data | Burger > Settings > Data & storage; palette "Settings: Data & storage"; Help > Export my data | same | WP-A test: burger lists Settings in both |
| Import | Settings > Data & storage | same | same |
| Help > Report content... (Store 11.16) | Native menu, route-independent | same | untouched |
| Javi Report link | Under each reply on every page with a Javi key (Home, all module pages except Folders, Settings) | same | existing `ReportLink` tests |
| Privacy and network controls | Settings > Privacy & activity, Settings > Network | same | |
| Buy Burrow Pro / Activate a license | Settings > License; TrialNotice banner (AppShell, every route); TrialBadge | same | |
| Updates | Settings > Updates; Help > Check for updates... | same | e2e deep link test (WP-D) |
| Every page reachable | Palette lists every page in both workspaces; switcher reaches the other workspace; route decides | same | palette test (WP-B) |
| No data loss from removed tag fields | | | WP-F tests: editing an old tagged record keeps its tag (client payload and server row) |
| Amount fields keep their results | Budget Planner, Category editor, Income payees, onboarding starter budget (all through `evalAmount`) | | WP-E: `evalAmount.test.js` existing cases unchanged, plus the legacy and behaviour-change tables (section 6.5, E.3) |
| No DB schema change | | | none added |
| Net JS <= 0 B | section 5.1 | | Measured gate in section 5.1 |

### 5.1 Bundle expectations

Budget (`scripts/checks/bundle-budget.json`): totalJsGzipKb 470, initialJsGzipKb 146, largestJsGzipKb 125. Baseline: main 9ba27a5 prints total JS 468.96 KB (1.04 KB under the ceiling). `bundleBudget.js` only checks those ceilings, so it cannot see a change that adds bytes under them; net JS <= 0 is therefore a separate, measured and reported check (below). It covers the whole change, the Budget card and the calculator included. The budget file is never raised for this change.

Estimates in gzip bytes (not measured, no shell; the measured gate decides). The cut column refers to the unified cut list below:

| Change | Estimate | Chunk |
| --- | --- | --- |
| `useWorkspace` hook (new) | +260 | initial |
| `WORKSPACES`, `workspaceForPath`, `normalizeWorkspace` in `navItems.js`; `workspace` on 2 groups | +170 | initial |
| `WorkspaceSwitcher`: `switchTo` navigation and route sync effect | +110 | initial |
| `WorkspaceSwitcher`: Alt+1/Alt+2 listener with its guards (`e.repeat` included), item `aria-keyshortcuts`, `title` suffix | +100 | initial (cut 2) |
| `shortcutGuard.js` shared by BackButton and switcher (replaces BackButton's private copy) | +20 | initial |
| `workspace` on 6 pairs, pair filter inside `computeCrossInsights`, `useCrossInsights(workspace)` | +80 | Home |
| `useHomeLayout` `reorder` keeps the slots of cards not shown | +30 | Home |
| Palette "Switch to <workspace>" command | +90 | palette |
| Onboarding radio + journal skip | +200 | onboarding (cut 3) |
| Visible `Alt+1` / `Alt+2` `kbd` hints in the menu | +40 | initial (cut 1) |
| `ready` flag and its waiting states, workspace subtitle on Home | +70 | initial + Home |
| Todos filter: `SegmentedRadio` in the board toolbar, options, filter memo moved from `useTodos`, `toolbarStart` slot, `hideLegend` prop | +170 | Todos + shared |
| `SegmentedRadio` moves into the `shared` group (Settings and Todos import it; onboarding too unless cut 3) | +60 | shared |
| Budget summary card: `BudgetWidget` and its registry entry | +400 | Home (cut 5) |
| Chunk shared by Home and Budget for the budget data modules (module bytes move, only the chunk wiring is new) | +150 | shared (cut 5) |
| WP-E: `calc.js` engine (normalize, tokenizer, parser, BigInt rationals, rounding, limits, `amount` profile, locale display `formatDecimal` with its string-input probe and exact split fallback) | +1,030 | shared (cut 6) |
| WP-E offset: `evalAmount.js` parser replaced by the wrapper (keeps the old `$` / comma cleanup line) | -350 | shared (cut 6) |
| WP-E: `CalculatorDialog.jsx` (Modal usage, form, input, Calculate, live region, 5 error strings) | +520 | calculator, lazy (cut 6) |
| WP-E: history (module list, cap 10, recall rows) | +150 | calculator, lazy (cut 6) |
| WP-E: lazy chunk overhead (imports of Modal, formStyles, calc) | +60 | calculator, lazy (cut 6) |
| WP-E: `LazyCalculator.jsx` host and `openCalculator.js` (state, event, `Suspense`) | +150 | initial (moves to palette at cut 4; cut 6) |
| WP-E: Alt+C listener with guards | +80 | initial (cut 4) |
| WP-E: `AppShell.jsx` mount | +10 | initial (cut 4) |
| WP-E: palette command, hint, keywords, `CommandPalette` wiring | +80 | palette (cut 6) |
| WP-E: lucide `Calculator` icon | +120 | palette (cut 6) |
| Offset: lucide `Layers`, `Briefcase`, `Home` no longer imported (switcher and palette) | -420 | initial + palette |
| Offset: `ModeGate.jsx` deleted, 3 wrappers in `App.jsx` | -170 | initial |
| Offset: `moduleVisibleInMode` and its 4 call sites | -120 | mixed |
| Offset: `modes` arrays (16 nav items, 10 widgets, 8 quick actions, `EVERY_MODE`) | -260 | mixed |
| Offset: palette `MODE_OPTIONS` and the 2 Mode commands | -180 | palette |
| Offset: `MODE_ICONS`, `MODE_LABEL`, `MODES` import in the switcher | -60 | initial |
| Offset: `matchesMode` filter and `useMode` import in 7 hooks | -180 | module chunks |
| Offset: Settings > General Work/Home control, `MODE_OPTIONS`, Settings wiring and `setMode` in reset | -150 | Settings |
| Offset: tag field in 6 forms and the Focus "Tag sessions as" select | -560 | module chunks |
| Offset: tag displays (HabitRow label, EventDetails chip, calendar `ACCENT`) | -100 | module chunks |
| Offset: Home and drawer `mode` subtitle branches | -40 | Home + initial |
| Offset: `useBudgetPlan` replaces the copies in BudgetDashboard and BudgetPlanner | -60 | Budget / shared |
| Net (estimate) | about **+1,500 B** (+4,150, -2,650): workspaces part about -350 B, WP-E about +1,850 B | |

Initial chunk: about +190 B (the icon, gate and drawer removals, about -50 B, sit in it; the calculator host, Alt+C listener and mount add about +240 B; the Budget card and the Todos filter are not in it). After cut 4 the calculator adds nothing to initial (about -50 B).

Estimated running net after each cut (cumulative): cut 1 +1,460; cut 2 +1,360; cut 3 +1,160; cut 4 +980; cut 5 +430; cut 6 about -1,240 (WP-E's remaining +1,670 leaves the PR). By these estimates the gate passes only at cut 6, so the calculator is likely to ship as its own follow-up PR unless the measured numbers come in lower than estimated. The measured numbers decide.

**Measured gate (QA H1).** The measurement is taken at implementation and reported then; this doc carries estimates only.

1. Baseline. Main 9ba27a5 (PR #87 merged; the merge base of this branch) prints total JS 468.96 KB. At implementation start, before any WP commit, WP-A runs `npm run build; node scripts/checks/bundleBudget.js` on 9ba27a5, confirms that total and records `initialJsGzipKb` as printed; its report states both numbers and the commit.
2. Per WP. Every WP runs the same two commands at its end and reports total and initial, each as a delta against the baseline (cumulative, so WP-D's numbers are the change as a whole). The printed values are KiB rounded to 0.01 (`kb()` in `bundleBudget.js:13`), so the resolution is about 10 bytes. WP-E also reports, from `gzipBytes` of the exported `readAssets()` (exact bytes): (a) the gzip bytes of the `CalculatorDialog` lazy chunk (the asset that holds `CalculatorDialog.jsx`), against the owner's target **calculator lazy chunk <= 1.5 KB gzip** (1,536 B); (b) separately, `calc.js`'s contribution to the shared chunk, measured as the shared chunk's gzip delta between WP-E's base commit and WP-E's end (calc.js sits in the shared chunk because `evalAmount` and the dialog both import it, so it is not counted in (a)). Over the target is reported to the owner with the numbers; it is not a cut by itself and does not change the cut list.
3. Gate. At the end of WP-D the total delta must be <= 0.00 KiB as printed by `bundleBudget.js` against main 9ba27a5 (about 10 B resolution, since `kb()` rounds to 0.01 KiB; a WP that wants exact bytes sums `gzipBytes` from the exported `readAssets()`). The gate is on the total. The initial chunk delta is reported in every WP report (it is not gated), and any growth is explained item by item; by the estimates it grows about +190 B before cut 4 because of the calculator host, the Alt+C listener and the `AppShell` mount, and cut 4 is the step that removes that growth (about -50 B after it). This is a separate reported check; `bundleBudget.js` passing is not enough.
4. If over, apply the **unified cut list** (one list for the whole PR, orchestrator ruling), re-measuring after each step, and stop at the first step that passes:
   1. drop the `kbd` hints in the workspace menu (items keep `aria-keyshortcuts`; the trigger `title` still names the keys; the UX copy rows for the hints drop);
   2. drop Alt+1 / Alt+2: no listener, no item `aria-keyshortcuts`, trigger `title` `Switch workspace`; the fallback is the palette "Switch to <Other>" command only (and the switcher itself); the Store "What's new" and README drop their shortcut clause;
   3. drop the onboarding radio (every fresh install starts in Budget; WP-C keeps only the `AUTO_STATE_KEYS` entry);
   4. drop Alt+C and move the calculator host into the palette chunk: the Alt+C listener goes; `CommandPalette` (the outer component, which stays mounted once armed, `LazyCommandPalette.jsx:48-53`) owns the calculator `open` state, listens for `calculator:open` and renders the lazy `CalculatorDialog`; `LazyCalculator.jsx` and its `AppShell` mount are deleted; the palette hint `Alt+C` and every "Alt+C" string drop (section 6.5, E.5);
   5. drop the Budget summary card to the first follow-up (`BudgetWidget.jsx`, its registry entry and its tests; `useBudgetPlan` stays because it removes a copy and saves bytes). The card becomes a follow-up with its own byte offsets. The Store and README copy drop the card sentence;
   6. move WP-E out of this PR into its own follow-up PR with its own offsets and its measured total reported (the engine, the dialog and history are not cut piecemeal: they are the owner's request);
   7. still over: stop and report the measured numbers to the owner. Never raise `bundle-budget.json`.
5. Add back (orchestrator ruling). Once a step passes, re-add the earlier cuts in reverse order (5, then 4, 3, 2, 1), re-measuring after each, and keep every re-added item for which the gate still holds. So reaching step 6 does not by itself drop the Budget card: if moving WP-E out frees enough, the card stays. WP-E is built as its own commits so step 6 is a clean split. Accepted calculator engine behaviour changes beyond the ruling's list: `-0` shows as `0`, U+2212 is read as minus, and a huge literal or intermediate that used to overflow to Infinity (null) is now exact, so a final value that fits a Number is returned.

### 5.2 Copy and assets that change (owner)

| Item | Where | Change |
| --- | --- | --- |
| Store screenshots | Partner Center (not in the repo; `docs/MICROSOFT_STORE.md:75` asks for at least 1, recommended 4) | Retake: header shows the workspace switcher; Home widget set depends on workspace; Budget Home shows the Budget card |
| Store full description bullet 1 | `docs/MICROSOFT_STORE.md:281` | New bullet, old -> new in "UX copy" |
| Store features line 1 | `docs/MICROSOFT_STORE.md:296` | New line, old -> new in "UX copy" |
| Store "What's new" (next version) | `docs/MICROSOFT_STORE.md` section 5 | New entry, text in "UX copy" |
| Claude-in-Chrome listing prompts | `docs/store/chrome-prompts.md` | Regenerate from the listing if the listing changes (the listing wins) |
| Certification notes | `docs/MICROSOFT_STORE.md:219-227` | Optional one paragraph for testers, text in "UX copy" |
| Gumroad product copy and screenshots | Gumroad pages (copy not in the repo; `config/gumroad-sync.json` and `syncGumroad.mjs` only update the version and a What's new line) | Owner updates by hand |
| Release notes | `release-notes/<next tag>.md` | New "What's new" line, text in "UX copy"; plus the optional calculator line (section 6.5, E.5) unless cut 6 moves WP-E to its own PR |
| README modules list | `README.md:5-21` (the `## Modules` list starts at line 5) | One bullet about the two workspaces, text in "UX copy" |
| Published privacy page `pages/` | | No change (no network feature) |

## 6. Implementation plan

Six work packages: WP-A (shell, nav, hook), WP-B (Home, Budget card, patterns, palette), WP-C (onboarding, pristine rule), WP-E (shared calculator, section 6.5), WP-F (Todos-only filter, hooks, tag fields, Settings) and WP-D (e2e, baselines, docs). WP-A first (it defines the shared exports, `shortcutGuard.js` included); then WP-B, WP-C, WP-E and WP-F in parallel where their file sets do not overlap, with every overlapping pair serialized (section 6.3); WP-D last. Each WP: implement, update tests, `npm test`, `npm run lint`, `npm run check`, `npm run build; node scripts/checks/bundleBudget.js` with the total and initial deltas against the baseline reported (section 5.1, measured gate), light and dark look. No commits by the designer.

### 6.1 Contracts

`src/constants/settingsDefaults.js` (add):

```js
export const SETTINGS_KEYS = { /* ...existing */ workspace: 'workspace' };
// No SETTINGS_DEFAULTS entry: an unset workspace is derived (useWorkspace), never stored by default.
```

`src/components/shell/navItems.js` (replace `NAV_GROUPS`, add exports; `modes` removed everywhere; items stay alphabetical per group):

```js
import { matchPath } from 'react-router-dom';
// icons: same imports as today (LayoutDashboard, PiggyBank, CloudSun, CheckSquare, Calendar, Target, Notebook,
// StickyNote, Bookmark, Timer, FolderOpen, CalendarClock, HeartPulse, Repeat, Wallet, Leaf, Activity, Settings)

// A group with `workspace` is listed only in that workspace and makes its pages belong to it.
// A group without one is Shared: listed in both.
export const NAV_GROUPS = [
  { section: null, id: 'home', items: [{ to: '/', label: 'Home', icon: LayoutDashboard, end: true }] },
  {
    section: 'Budget', id: 'money', icon: Wallet, workspace: 'budget',
    items: [
      { to: '/budget', label: 'Budget', icon: PiggyBank, exclude: ['/budget/subscriptions'] },
      { to: '/budget/subscriptions', label: 'Subscriptions', icon: Repeat },
    ],
  },
  {
    section: 'Journal', id: 'journal', icon: Activity, workspace: 'journal',
    items: [
      { to: '/focus', label: 'Focus', icon: Timer },
      { to: '/habits', label: 'Habits', icon: Target },
      { to: '/health', label: 'Health', icon: HeartPulse },
      { to: '/journal', label: 'Journal', icon: Notebook },
      { to: '/notes', label: 'Notes', icon: StickyNote },
      { to: '/todos', label: 'Todos', icon: CheckSquare },
    ],
  },
  {
    section: 'Life', id: 'life', icon: Leaf,
    items: [
      { to: '/bookmarks', label: 'Bookmarks', icon: Bookmark },
      { to: '/calendar', label: 'Calendar', icon: Calendar },
      { to: '/countdowns', label: 'Countdowns', icon: CalendarClock },
      { to: '/folders', label: 'Folders', icon: FolderOpen },
      { to: '/weather', label: 'Weather', icon: CloudSun },
    ],
  },
  { section: null, id: 'settings', items: [{ to: '/settings', label: 'Settings', icon: Settings }] },
];

export const WORKSPACES = Object.freeze([
  { id: 'budget', label: 'Budget', icon: PiggyBank, start: '/budget', code: 'Digit1', keys: 'Alt+1' },
  { id: 'journal', label: 'Journal', icon: Notebook, start: '/journal', code: 'Digit2', keys: 'Alt+2' },
]);
export const DEFAULT_WORKSPACE = 'budget';

/** 'budget' | 'journal' for a known id, else null. */
export const normalizeWorkspace = (value) => (WORKSPACES.some((w) => w.id === value) ? value : null);

/** The workspace that owns a router pathname (basename-relative), or null for a Shared page. */
export function workspaceForPath(pathname) {
  for (const group of NAV_GROUPS) {
    if (group.workspace && group.items.some((item) => matchPath({ path: item.to, end: false }, pathname))) {
      return group.workspace;
    }
  }
  return null;
}
```

`src/components/shell/shortcutGuard.js` (new; the private `EDITABLE` and `modalOpen` of `BackButton.jsx:6-9` move here byte for byte, so Back's behaviour and `BackButton.test.jsx` are unchanged; `BackButton.jsx` imports them and its line 52 becomes `if (e.repeat || isModalOpen() || inEditable(e.target)) return;`, line 60 `if (e.type === 'mouseup' && !isModalOpen()) goBack();`):

```js
// Shared by Back, the workspace shortcuts and the calculator shortcut.
// Checkbox, radio, range and button inputs are not text fields, so shortcuts still work on them.
export const EDITABLE =
  'input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=button]):not([type=submit]):not([type=reset]), textarea, select, [contenteditable]:not([contenteditable=false])';
// A modal inside an inert subtree (a dialog playing its closing animation) does not count.
export const isModalOpen = () =>
  [...document.querySelectorAll('[aria-modal="true"]')].some((el) => !el.closest('[inert]'));
export const inEditable = (target) => Boolean(target?.closest?.(EDITABLE));
```

`src/hooks/useWorkspace.js` (new; no provider: React Query shares the setting between callers; must be called inside the router):

```js
import { useCallback, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSyncedSetting } from './useSyncedSetting';
import { useMode } from '../contexts/ModeContext';
import { SETTINGS_KEYS } from '../constants/settingsDefaults';
import { DEFAULT_WORKSPACE, WORKSPACES, normalizeWorkspace, workspaceForPath } from '../components/shell/navItems';

/**
 * @param {{ sync?: boolean }} [options] sync: save an owned route's workspace (WorkspaceSwitcher only)
 * @returns {{ workspace: 'budget' | 'journal', ready: boolean, switchTo: (id: string) => void }}
 *   ready: false only on a Shared page before the saved value has loaded (section 2, Persistence)
 */
export function useWorkspace({ sync = false } = {}) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { mode } = useMode(); // the Todos filter; read only, for the initial workspace of existing users
  const [stored, setStored, meta] = useSyncedSetting(SETTINGS_KEYS.workspace, null);
  const saved = normalizeWorkspace(stored);
  const fromRoute = workspaceForPath(pathname);
  const workspace = fromRoute ?? saved ?? (mode === 'work' ? 'journal' : DEFAULT_WORKSPACE);
  const ready = fromRoute !== null || meta.isFetched;

  useEffect(() => {
    if (sync && meta.isFetched && fromRoute && fromRoute !== saved) setStored(fromRoute);
  }, [sync, meta.isFetched, fromRoute, saved, setStored]);

  const switchTo = useCallback(
    (id) => {
      const target = WORKSPACES.find((w) => w.id === id);
      if (!target || id === workspace) return;
      setStored(id);
      navigate(target.start);
    },
    [workspace, setStored, navigate],
  );

  return { workspace, ready, switchTo };
}
```

`src/components/shell/WorkspaceSwitcher.jsx` (`git mv` of `ModeSwitcher.jsx`; keep every line of the menu-button logic; changes only):

```jsx
// Props: none. Mounted once, in TopBar, so it owns the route sync and the Alt+1/Alt+2 listener.
const { workspace, ready, switchTo } = useWorkspace({ sync: true });
const current = WORKSPACES.find((w) => w.id === workspace);
// pendingFocus index: WORKSPACES.findIndex((w) => w.id === workspace); items map over WORKSPACES.
// select(id): switchTo(id); closeAndRestore();
useEffect(() => {
  const onKey = (e) => {
    if (e.repeat || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.defaultPrevented) return;
    const target = WORKSPACES.find((w) => w.code === e.code);
    if (!target) return;
    e.preventDefault();
    if (isModalOpen() || inEditable(e.target)) return;
    switchTo(target.id);
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}, [switchTo]);
// Trigger: aria-label={`Workspace: ${current.label}`} title="Switch workspace (Alt+1, Alt+2)"; no aria-keyshortcuts;
//          icon <current.icon size={14} />; label span always visible (no `hidden sm:inline`);
//          while !ready: aria-busy="true", aria-label="Workspace", label span `invisible` (same width), icon hidden.
// Menu: aria-label="Workspace"; each item aria-keyshortcuts={w.keys} and, after the label,
//       <kbd aria-hidden="true" className="text-[10px] text-slate-slate400">{w.keys}</kbd> before the check slot.
// Imports dropped: Layers, Briefcase, Home, useMode, MODES.
```

`src/components/shell/BurgerMenu.jsx` (groups filter; `useMode` and `moduleVisibleInMode` imports go):

```js
const { workspace } = useWorkspace();
const groups = useMemo(() => NAV_GROUPS.filter((g) => !g.workspace || g.workspace === workspace), [workspace]);
// Drawer subtitle (lines 239-246): {displayName ? `${displayName} · ${label} workspace` : `${label} workspace`} (`Burrow` while !ready) where label = WORKSPACES[...].label.
// Replaces the 'Your workspace' fallback and the '<mode> mode' branch.
```

`src/contexts/ModeContext.jsx` (WP-B, not WP-A; QA cycle 3, M1): delete `moduleVisibleInMode` (lines 41-48) in the WP that rewrites its last consumers (`Home.jsx`, `commands.js`, `CommandPalette.jsx`). Keep `MODES`, `matchesMode`, `ModeProvider`, `useMode`; top comment per section 4.3. WP-A removes only its own call sites (`BurgerMenu.jsx`, and `ModeGate.jsx` with the file) and leaves `ModeContext.jsx` untouched (section 6.3, Symbol sequencing).

`src/App.jsx`: remove the `ModeGate` import and the three wrappers (lines 4, 44-46 become plain `element={<Budget />}` etc.). Do not touch the `<BrowserRouter>` line or the provider order (`ModeProvider` stays). Delete `src/components/shell/ModeGate.jsx`.

`src/pages/Home.jsx` (WP-B):

```js
// WIDGETS (order matters, section 1.1); `modes` dropped:
//   { key: 'budget', Component: BudgetWidget, workspace: 'budget' },
//   { key: 'weather', ... }, { key: 'health', ..., workspace: 'journal' }, { key: 'todos', ..., workspace: 'journal' },
//   { key: 'habits', ..., workspace: 'journal' }, { key: 'journal', ..., workspace: 'journal' },
//   { key: 'notes', ..., workspace: 'journal' }, { key: 'bookmarks', ... }, { key: 'focus', ..., workspace: 'journal' },
//   { key: 'countdowns', ... }, { key: 'calendar', ... }
const { workspace, ready } = useWorkspace();
const visibleKeys = WIDGETS.filter((w) => !w.workspace || w.workspace === workspace).map((w) => w.key);
// While !ready the grid renders WidgetSkeletons and CrossInsightsCard renders nothing (section 2, Persistence).
// Subtitle (lines 112-116): not editing and ready -> `${label} workspace. Everything important at a glance.`;
// not ready -> 'Everything important at a glance.'; editing text unchanged ("UX copy"). No tag-filter branch.
// useMode and moduleVisibleInMode imports go; buildHomeContext({ widgets: shown, briefing, alerts }) (no mode).
```

`src/hooks/useBudgetPlan.js`, `src/components/budget/BudgetWidget.jsx`, `BudgetDashboard.jsx`, `BudgetPlanner.jsx` (WP-B): section 1.2.

`src/utils/crossInsights.js` (WP-B): add `workspace` to each `CROSS_INSIGHT_PAIRS` entry: `'budget'` for `sleep_dining`, `sleep_spend`, `readiness_spend`, `busyness_spend`; `'journal'` for `readiness_habits`, `sleep_mood`. Ids and order unchanged (`crossInsightsParity.test.js`). `computeCrossInsights` gains an optional `workspace` and filters the pairs before evaluating, sorting and capping:

```js
export function computeCrossInsights({ transactions, ouraDays, ouraSource, habits, journal, events, workspace, now = new Date() } = {}) {
  const series = buildDailySeries({ transactions, ouraDays, ouraSource, habits, journal, events }, { now });
  // Filter BEFORE the MAX_SHOWN cap, so another workspace's stronger findings never take this workspace's slots.
  // No workspace (scripts/evalJavi.js, existing tests): every pair, as today.
  const pairs = workspace ? CROSS_INSIGHT_PAIRS.filter((p) => p.workspace === workspace) : CROSS_INSIGHT_PAIRS;
  const insights = pairs.map((p) => evaluatePair(p, series))
    .filter(Boolean)
    .sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho))
    .slice(0, MAX_SHOWN);
  // rest unchanged: `status` is per workspace ('insufficient' when this workspace has no finding); coverage and missing unchanged.
}
```

`src/hooks/useCrossInsights.js` (WP-B): `export function useCrossInsights(workspace)`; passes `workspace` to `computeCrossInsights` and adds it to the `useMemo` deps. No other change (its hooks stop filtering in WP-F, which needs no change here).

`src/components/home/CrossInsightsCard.jsx` (WP-B):

```js
// in the component (no PAIR_WORKSPACE map, no post-filter):
const { workspace, ready } = useWorkspace();
const { result, loading } = useCrossInsights(workspace);
if (!ready) return null; // the card owns its ready gate (QA N2); Home renders it unconditionally
// Everything else unchanged (summaryKey now changes on a switch, which clears a shown explanation).
```

`src/hooks/useHomeLayout.js` (WP-B): `reorder` keeps the slots of the keys that are not in the displayed list (cards of the other workspace and cards the user hid), section 1.1:

```js
const reorder = useCallback(
  (newDisplayedOrder) => {
    setRaw((prev) => {
      const n = normalize(prev, allKeys);
      const moved = new Set(newDisplayedOrder);
      let i = 0;
      // Each slot that held a displayed key takes the next key of the new displayed order; every other slot is kept.
      const order = n.order.map((k) => (moved.has(k) ? newDisplayedOrder[i++] : k));
      return { order, cards: n.cards };
    });
  },
  [setRaw, allKeys],
);
// `reset` unchanged: one shared layout for both workspaces (accepted, section 1.1).
```

`src/components/palette/commands.js` (WP-B):

```js
export function buildNavCommands({ navigate }) { /* same, without the mode filter */ }
export function buildWorkspaceCommands({ workspace, switchTo }) {
  return WORKSPACES.filter((w) => w.id !== workspace).map((w) => ({
    id: `workspace:${w.id}`,
    label: `Switch to ${w.label}`,
    keywords: 'workspace focus switch budget journal',
    icon: w.icon,
    group: 'Navigate',
    run: () => switchTo(w.id),
  }));
}
export function buildPreferenceCommands({ preference, setPreference }) { /* theme commands only */ }
// QUICK_ACTIONS: drop `modes`; delete EVERY_MODE and MODE_OPTIONS; icon import drops Layers, Briefcase, Home.
// SECTION_KEYWORDS.general: 'profile name javi button'
```

`CommandPalette.jsx` (WP-B): replace `useMode` (import line 19, call line 86) with `const { workspace, switchTo } = useWorkspace();`; drop the quick-action filter (line 207); `buildNavCommands({ navigate })` (line 225); add `...buildWorkspaceCommands({ workspace, switchTo })` to `more` (line 234), drop `mode, setMode` from `buildPreferenceCommands` (line 236); update the `useMemo` deps (line 262). WP-E later adds the calculator tools push after line 223 (section 6.5, E.3).

`src/components/todos/TodosPage.jsx` (WP-F):

```jsx
const TODO_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'work', label: 'Work' },
  { value: 'home', label: 'Home' },
];
// in the component:
const { mode: filter, setMode: setFilter } = useMode();
const shown = useMemo(() => todos.filter((t) => matchesMode(filter, t.context)), [todos, filter]);
usePageContext('todos', () => buildTodosContext({ todos: shown, loading: loading || columnsLoading, error: loadError, now: new Date() }));
<KanbanBoard
  todos={shown}
  /* columns, onReorder, onUpdate, onRemove, onAdd unchanged */
  defaultContext={filter !== 'all' ? filter : 'work'}
  toolbarStart={
    <SegmentedRadio legend="Show todos" hideLegend name="todos-filter" value={filter} onChange={setFilter} options={TODO_FILTERS} />
  }
/>
```

`src/components/todos/KanbanBoard.jsx` (WP-F): new optional prop `toolbarStart`; toolbar row (lines 239-258) becomes `<div className="flex flex-wrap items-center justify-between gap-2">{toolbarStart ?? <span />}<div className="flex items-center gap-2">{/* Add todo, Columns unchanged */}</div></div>`.

`src/components/settings/SegmentedRadio.jsx` (WP-F): new optional prop `hideLegend = false`; the legend's class (line 23) is `sr-only` when true, else today's `mb-1.5 text-sm font-semibold text-slate-slate100`. Doc comment (lines 10-17) lists the prop. Nothing else changes.

Hooks, forms, displays, `GeneralSection.jsx`, `Settings.jsx` (WP-F): section 4.3.

`OnboardingFlow.jsx` (WP-C):

```jsx
const [storedFocus, setStoredFocus] = useSyncedSetting(SETTINGS_KEYS.workspace, null);
const [focus, setFocus] = useState(() => normalizeWorkspace(storedFocus) ?? DEFAULT_WORKSPACE);
// finish(): before save(...):
if (focus !== (normalizeWorkspace(storedFocus) ?? DEFAULT_WORKSPACE)) setStoredFocus(focus);
// welcome form, after the name input:
<div className="mt-4">
  <SegmentedRadio
    legend="Where do you want to start?"
    name="onboarding-workspace"
    value={focus}
    onChange={setFocus}
    options={WORKSPACES.map((w) => ({ value: w.id, label: w.label }))}
    hint="Budget is for money. Journal is for writing, habits, health, todos and focus. You can switch any time at the top of the window."
  />
</div>
// welcome form = OnboardingFlow.jsx:97-135; the radio goes after the name input (lines 116-126), before the
// Skip for now / Continue row (127-134). finish() is lines 64-83.
// Javi step's forward button (line 165, currently onClick={() => setStep('budget')}):
onClick={() => (focus === 'journal' ? finish({ withName: true, withAmounts: false }) : setStep('budget'))}
```

`server/backup/directImport.js` (WP-C): add `['workspace', (value) => value === 'budget' || value === 'journal']` to `AUTO_STATE_KEYS` and add to the doc comment (lines 107-119) the principle and the entry worded in section 2 (Persistence).

### 6.2 Work packages

**WP-A: shell, nav config, hook (merge first)**

Files: `src/components/shell/navItems.js`, `src/hooks/useWorkspace.js` (new), `src/components/shell/shortcutGuard.js` (new), `src/components/shell/WorkspaceSwitcher.jsx` (git mv from `ModeSwitcher.jsx`), `src/components/shell/BackButton.jsx` (import the guards), `src/components/shell/TopBar.jsx`, `src/components/shell/BurgerMenu.jsx`, `src/components/shell/ModeGate.jsx` (delete), `src/App.jsx`, `src/constants/settingsDefaults.js`, `e2e/support/routes.js` (drop `gated` and its comment, lines 4, 7-9), `e2e/pages/nav.js` (`setMode` -> `setWorkspace(id)` using `/^Workspace:/` and `menuitemradio` Budget/Journal; no-op when already current; otherwise it clicks and waits for both the trigger name `Workspace: <W>` and the `PUT /api/state/workspace` response, so a following `page.goto` cannot race the save), `e2e/flows/navigation.spec.js` and `e2e/first-run/firstRun.spec.js` (delete the `setMode('all')` lines only: every route opens by URL), `e2e/flows/back.spec.js` (added by #87: its first test opens Todos from the drawer on `/`, and Todos is a Journal page that the Budget drawer no longer lists, so line 19 `await nav(page).setMode('all');` becomes `await nav(page).setWorkspace('journal'); await page.goto('/');`, which keeps `history.state.idx` at 0 on Home for the `toHaveCount(0)` assertion; the rest unchanged), `server/__tests__/e2eRoutes.test.js` (replace the gated case at lines 33-36 with "no route is wrapped in a gate").

WP-A does not touch `src/contexts/ModeContext.jsx`: `moduleVisibleInMode` still has consumers in WP-B's files when WP-A ends, so WP-B deletes it (QA cycle 3, M1). WP-A ends with `npm test`, `npm run lint` and `npm run build` green and no import of a symbol it deleted (section 6.3, Symbol sequencing).

Tests:
- `src/components/shell/__tests__/WorkspaceSwitcher.test.jsx` (git mv of `ModeSwitcher.test.jsx`): name `Workspace: Budget`; menu named `Workspace` with two `menuitemradio`, the current one `aria-checked`; ArrowDown/ArrowUp open and focus first/last; Home/End; Escape closes and returns focus; Tab parks on trigger; Ctrl K closes; picking Journal navigates to `/journal` (push: `window.history.length` grows or a location probe sees PUSH) and PUTs `workspace` `"journal"`; picking the current one does nothing; Alt+1/Alt+2 switch and are `defaultPrevented`; ignored in an input, with an `aria-modal="true"` element, with Ctrl or Shift held, and when already prevented; a `keydown` with `repeat: true` neither switches nor navigates nor is `defaultPrevented` (a first Alt+2 followed by repeats gives exactly one navigation and one PUT); label span has no `hidden` class (visible at every width); the trigger has no `aria-keyshortcuts`, each item has its own and a visible `Alt+1` / `Alt+2` hint; after Alt+2 the trigger's name is `Workspace: Journal`; on a Shared route before the saved value loads the trigger is `aria-busy` and shows no workspace name.
- `src/hooks/__tests__/useWorkspace.test.jsx` (new): route wins (`/habits`, `/todos`, `/focus` -> journal, `/budget/planner` -> budget, `/calendar` -> saved); saved value; invalid saved value falls back; migration (`mode` work -> journal, home -> budget, all -> budget; no PUT); `ready` is true at once on an owned route and false on a Shared route until the GET answers; route sync PUTs only after `isFetched`, only on an owned page, only when different; no PUT from a Shared page; under `MemoryRouter basename="/burrow" initialEntries={['/burrow/journal']}` the workspace is journal and `switchTo('budget')` lands on router pathname `/budget` with `useHref('/budget') === '/burrow/budget'` (a neutral base, not under `/api`). Every test that renders `useWorkspace` (this file, the switcher, BurgerMenu, Home, CrossInsightsCard, palette and router entry tests) wraps it in `ModeProvider` inside the router, since the hook calls `useMode()` for the migration.
- `src/components/shell/__tests__/navItems.test.js` (new): `workspaceForPath` table (`/` null, `/budget` and `/budget/subscriptions` budget, `/journal`, `/habits`, `/health`, `/notes`, `/todos`, `/focus` journal, `/calendar`, `/countdowns`, `/bookmarks`, `/weather`, `/folders`, `/settings/data` null, `/journalx` null); `normalizeWorkspace`.
- `src/components/shell/__tests__/BurgerMenu.test.jsx`: drop its `moduleVisibleInMode` import (line 8) and the mode-based helpers that use it and `item.modes` (lines 44-46, 344-345), and replace the group-id expectations that assume today's groups (for example line 285, the group holding `/todos`); then: Budget lists the Budget group (heading `Budget`, group id `money`) not Journal; Journal lists Journal (Focus, Habits, Health, Journal, Notes, Todos) not Budget; Home, Life (Bookmarks, Calendar, Countdowns, Folders, Weather) and Settings in both; alphabetical rule per group still passes; `mode` no longer hides items and no longer shows in the subtitle (`mode = 'work'` stored: subtitle is the display name or `Budget workspace`).
- `src/components/shell/__tests__/TopBar.test.jsx`: switcher present (after Back off Home, after the placeholder on Home); the #87 assertions (clock still shown, Back present off Home) unchanged.
- `src/components/shell/__tests__/BackButton.test.jsx`: green with no expectation change (the guards moved byte for byte).
- `src/components/shell/__tests__/AppShell.javiButtonOff.test.jsx`, `src/components/settings/__tests__/SettingsLayout.test.jsx`, `SettingsLayout.extensions.test.jsx`: they use `ModeContext` today (a `ModeProvider` wrapper, or, in `AppShell.javiButtonOff.test.jsx:15-18`, a `vi.mock` that spreads the original module and overrides `useMode`); keep that inside the router, since TopBar's switcher now calls `useWorkspace` (which calls `useMode`). The spread mocks keep working at every WP boundary because `ModeContext.jsx` keeps every export they spread until WP-B, and WP-B removes only `moduleVisibleInMode`, which none of them overrides.
- Router entry tests in `src/__tests__/workspaceRoutes.test.jsx` (new, renders `App` routes inside `MemoryRouter` with stubs): `/settings#updates` with saved journal keeps `location.hash === '#updates'` and workspace journal; `/folders#add-folder` keeps the hash until the page clears it; `/budget?import=1` gives budget and keeps `search`; `/health` with `mode = 'work'` renders Health (no bounce); `/todos` gives journal; unknown `/x` -> `/`; the same three hash/query cases under `basename="/burrow"`.

**WP-B: Home, Budget card, patterns, palette**

Files: `src/pages/Home.jsx`, `src/hooks/useHomeLayout.js`, `src/components/home/CrossInsightsCard.jsx`, `src/hooks/useCrossInsights.js`, `src/utils/crossInsights.js`, `src/components/palette/commands.js`, `src/components/palette/CommandPalette.jsx`, `src/hooks/useBudgetPlan.js` (new), `src/components/budget/BudgetWidget.jsx` (new), `src/components/budget/BudgetDashboard.jsx`, `src/components/budget/BudgetPlanner.jsx`, `src/contexts/ModeContext.jsx` (delete `moduleVisibleInMode` and update the top comment, section 6.1; moved here from WP-A, QA cycle 3, M1).

WP-B removes the last three consumers of `moduleVisibleInMode` (`Home.jsx:34, 64`, `commands.js:3, 15`, `CommandPalette.jsx:19, 207`) and the `modes` arrays on Home widgets and quick actions in the same WP, then deletes the function; it ends green with no remaining import of it (section 6.3, Symbol sequencing).

Tests:
- `src/pages/__tests__/Home.workspace.test.jsx` (new): Budget shows exactly budget, weather, bookmarks, countdowns, calendar; Journal shows weather, health, todos, habits, journal, notes, bookmarks, focus, countdowns, calendar and no budget card; the Javi Home context `widgets` differs accordingly and its `mode` is `'all'` even with `mode = 'work'` stored; Customize lists only visible widgets; the subtitle names the workspace and never mentions tags (`mode = 'work'` stored); before the saved workspace loads the grid shows skeletons, not the Budget set.
- `src/hooks/__tests__/useHomeLayout.test.js` (new or extended): from the default order `budget, weather, health, todos, habits, journal, notes, bookmarks, focus, countdowns, calendar`, a `reorder` of the 5 Budget keys (for example `calendar` moved first) leaves `health`, `todos`, `habits`, `journal`, `notes`, `focus` at indexes 2, 3, 4, 5, 6, 8 and only permutes slots 0, 1, 7, 9, 10; a hidden card keeps its slot after a drag of the shown cards; a saved layout without `budget` gets `budget` appended at the end; `reset` writes `{ order: allKeys, cards: {} }`.
- `src/components/budget/__tests__/BudgetWidget.test.jsx` (new; system time fixed with `vi.setSystemTime`; synthetic data only): (a) numbers computed in code: transactions of $40 and $60 in one expense category this month, $500 last month, and `budget:defaults` giving that category 250 show `$100.00`, `spent this month`, `Budgeted $250.00`, `Remaining $150.00`, and the three figures equal `buildPlan(...).totals` computed in the test from the same inputs; no request other than `GET /api/transactions` and `GET /api/state/*` is made (fetch spy; no Javi or AI endpoint); (b) over budget: Remaining shows `-$` and has `text-accent-red`; (c) spend and no budget: `No budget set for this month.`; (d) empty state: no transactions (source `sample`, sample data present in the hook) and no budget shows `No budget or spending this month yet.` and never a sample figure; (e) `source: 'error'` shows the error line; (f) skeleton while transactions load and while any of the five settings is not fetched; (g) the card is a link to `/budget`; (h) a month picked on the Budget page (`?month=`) or the Settings "latest month" option does not change the card's month.
- `src/hooks/__tests__/useBudgetPlan.test.jsx` (new): same `plan` as calling `buildPlan` with the same synced values; `ready` false until all five settings fetched. Existing `BudgetPage.test.jsx`, `BudgetPageSettings.test.jsx`, `BudgetSummaryCards.test.jsx` and the planner tests stay green with no expectation change (the hook extraction changes no number).
- `src/utils/__tests__/crossInsights.test.js` (extend): a synthetic dataset where more than 4 pairs qualify (precondition: the `workspace: 'budget'` and `workspace: 'journal'` results have more than 4 insights together, and the unfiltered result holds a Journal pair inside its 4). Then `workspace: 'budget'` returns all 4 qualifying spend pairs, `workspace: 'journal'` returns its qualifying pairs, no result holds a pair of the other workspace, and calling without `workspace` gives the same result as before this change.
- `src/components/home/__tests__/CrossInsightsCard.test.jsx`, `.explain.test.jsx`, `.busyness.test.jsx`: Budget shows only spend pairs, Journal only `readiness_habits`/`sleep_mood`; card hidden when the workspace has no finding; Explain body carries only shown ids; Free still gets the Pro notice, and Free and Pro see the same filtered findings for the same data and workspace.
- `src/components/palette/__tests__/CommandPalette.test.jsx`, `.import.test.jsx`, `.newIntent.test.jsx`, `LazyCommandPalette.test.jsx`: every "Go to" page listed in both workspaces; exactly one "Switch to <other>"; no "Mode:" commands (replaces the case at `CommandPalette.test.jsx:324-330`); Import transactions present in both (replaces "hides Import transactions in Work mode", lines 259-281, which stays green through WP-A because quick actions keep their `modes` until WP-B); the `modes` field in the `.newIntent` fixture (line 47) goes; mock `useWorkspace` instead of `useMode` where the mock is the palette's.
- `src/utils/__tests__/crossInsights*.test.js` (whichever asserts pair shape): `workspace` present and valid.

**WP-C: onboarding and pristine rule**

Files: `src/components/onboarding/OnboardingFlow.jsx`, `server/backup/directImport.js`, `e2e/pages/onboarding.js` (add `chooseFocus(label)`), `e2e/flows/onboarding.spec.js`.

Tests:
- `src/components/onboarding/__tests__/Onboarding.test.jsx`, `Onboarding.noLicense.test.jsx`: radio defaults to Budget; the hint text names todos and focus; default path unchanged and PUTs no `workspace`; Journal + Skip for now PUTs `workspace` `"journal"` and marks onboarded; Journal + Continue: the Javi step's button finishes (no "Starter budget" dialog); Escape still only hides.
- `server/__tests__/briefingPristine.test.js` or `directImport.test.js`: `isPristineDb` stays true with `workspace` `"journal"` (and with `profile` onboarded); an invalid value such as `workspace` `"other"` still counts as used (`isPristineDb` false); `mode` still counts as used; `backupsShowUserData` allowance follows `AUTO_STATE_KEYS.size`.
- Direct-import reconcile test (the existing `reconcileDirectImport` test file): stage an import into a pristine target, then write an `app_state` row `workspace` = `"budget"` into the target database (as the route sync would after staging), then run `reconcileDirectImport()`: the result is the swap, not `discarded` / `target_has_data`. Same setup with `workspace` = `"other"`: the stage is discarded with `target_has_data`.
- `e2e/flows/onboarding.spec.js`: choose Journal, pass the Javi step, no budget step, header shows `Workspace: Journal`.

**WP-E: shared calculator (section 6.5; parallel with WP-C and WP-F, serialized after WP-B on the palette files)**

Files and tests: section 6.5, E.9 and E.6.

**WP-F: Todos-only filter, hooks, tag fields, Settings (parallel with WP-B, WP-C and WP-E)**

Files: `src/components/todos/TodosPage.jsx`, `src/components/todos/KanbanBoard.jsx`, `src/components/settings/SegmentedRadio.jsx`, `src/hooks/useTodos.js`, `useHabits.js`, `useJournal.js`, `useNotes.js`, `useCalendar.js`, `useBookmarks.js`, `useCountdowns.js`, `useFocus.js`, `src/components/habits/HabitForm.jsx`, `HabitRow.jsx`, `src/components/journal/EntryForm.jsx`, `src/components/calendar/EventForm.jsx`, `EventDetails.jsx`, `EventButtons.jsx`, `eventLabels.js`, `src/components/notes/NoteForm.jsx`, `src/components/bookmarks/BookmarkForm.jsx`, `src/components/countdowns/CountdownForm.jsx`, `src/components/focus/FocusPage.jsx`, `src/components/calendar/CalendarPage.jsx` (comment only: refresh the stale comment at lines 183-185, which explains the close-on-vanish logic by "mode change" and a "mode-filtered list"; after this change the calendar list is not filtered by tag, so the part on lines 183-185 reads "The event vanished (refetch or another tab) while open and we're not the one deleting it (or saving it: the saving lock must hold)." and the rest of the comment from "From the day modal" stays; no code change), `src/components/settings/GeneralSection.jsx`, `src/pages/Settings.jsx`, `server/__tests__/contextPreserved.test.js` (new).

Tests:
- `src/components/todos/__tests__/TodosPage.filter.test.jsx` (new; replaces the `useMode` mock in `TodosAddColumn.test.jsx` with a stored `mode`): with `mode = 'work'` stored, the board shows work and both todos, not home ones, and the `Work` radio is checked; the group's accessible name is `Show todos` and the legend is visually hidden; picking `All` PUTs `mode` `"all"` and shows every todo; picking `Home` then adding a todo opens the form with Context `home`; with `All` a new todo defaults to `work`; the Javi todos context counts only the shown todos; Add todo is still the only primary button in the toolbar; keyboard: arrow keys move the selection.
- `src/components/todos/__tests__/TodosWidget.test.jsx` (new or extended): with `mode = 'work'` stored the widget counts todos of every tag.
- `src/components/settings/__tests__/SegmentedRadio.test.jsx` (extend): `hideLegend` gives the legend `sr-only` and keeps the group name; default unchanged.
- Hook tests (`src/hooks/__tests__/useHabits.test.jsx` drops its `matchesMode` mock; one test per hook, or one table test): `useTodos`, `useHabits`, `useJournal`, `useNotes`, `useCalendar`, `useBookmarks`, `useCountdowns`, `useFocus` return records of every `context` whatever `mode` holds, and render without `ModeProvider` (they no longer call `useMode`); `useCalendar` still sorts by start and `useCountdowns` by target date, and neither reorders the cached array (the `['calendar']` / `['countdowns']` query data keeps its server order after render: guards the `.slice()` rule in section 4.3); `useFocus().today` counts sessions of every tag.
- Tag kept on edit, client side (`HabitsPage.test.jsx`, `JournalPage.test.jsx` (drop its `useMode` mock), `CalendarPage.test.jsx`, `NotesPage.test.jsx`, `BookmarksPage.test.jsx`, `CountdownsPage.test.jsx`): open an existing record tagged `home`, change one other field, save: the service `update` receives a patch with no `context` key, and the cached row still has `context: 'home'` after the optimistic update; the forms render no Context field; new items are created with no `context` key. `FocusPage.test.jsx`: no "Tag sessions as" control; a finished block logs a session with no `context` key.
- Tag kept on edit, server side (`server/__tests__/contextPreserved.test.js`, real temp DB through the existing helper): for habits, journal, calendar events, notes, bookmarks and countdowns, create a row with `context: 'home'`, PATCH it with a body that has no `context` (title or body change only), read it back: `context` is still `'home'`; a create with no `context` stores `'both'`.
- Displays: `HabitRow` shows no tag after the frequency; `EventDetails.test.jsx`: no tag chip, the "Imported" chip still shows for an ICS event; event bars and dots use `bg-slate-slateBlueLight` for every tag.
- `src/components/settings/__tests__/GeneralSection.javi.test.jsx`, `src/pages/__tests__/Settings.test.jsx`, `Settings.javi.test.jsx`: no "Workspace mode" group; card subtitle `Profile and Javi.`; the quiet "Reset general settings" control is still there; Reset general and Reset all PUT no `mode`; the Javi settings context has `mode: null`.
- Forms keep #87's removals: no form touched here (habit, journal entry, note, bookmark, countdown, todo) gains a Cancel button; any #87 test that asserts the missing Cancel stays green unchanged.

**WP-D: e2e flow, baselines, docs (last)**

Files: `e2e/flows/workspaces.spec.js` (new), `e2e/support/visual.js` (`settleAndShoot` waits for the switcher trigger, when present in the page, to not be `aria-busy`; see below), `e2e/__screenshots__/**` (regenerated with `npm run test:visual:update`, Linux container), `docs/DESIGN.md`, `CLAUDE.md`, `README.md`, `docs/PRODUCT.md` (decision entry: workspaces, Todos-only Work/Home filter, Budget card).

- `workspaces.spec.js`: header switch to Journal lands on `/journal`; Alt+1 lands on `/budget`; Back after a switch returns to the previous page and the header follows (from `/budget`: Budget again; from `/calendar` or `/`: the new workspace stays); `/settings#updates` deep link keeps the hash; a bell or palette jump to `/todos` or `/habits` from Budget shows Journal; Budget Home shows the Budget card and Journal Home does not; the Todos filter survives a reload; axe clean on the open menu and on the Todos toolbar (light and dark).
- Baselines that change (inventory verified in 9ba27a5, section 0): all 14 of `e2e/__screenshots__/screens.spec.js/*` (7 screens x light/dark, from `e2e/visual/screens.spec.js`) for the header control (`All` becomes `Budget` or `Journal`); `home-*` also for the widget set and the Budget card; `todos-*` also for the filter in the board toolbar; `settings-*` also for the removed Workspace mode control if General is in frame; `budget-*`, `journal-*`, `calendar-*`, `settings-ai-*` for the header only (demo data tags are all `both`, so no accent colour, tag chip or habit tag changes on screen); both `e2e/__screenshots__/onboarding.spec.js/onboarding-*` (from `e2e/visual/onboarding.spec.js`) for the welcome step radio. There are no habits or focus baselines. The calculator adds no baseline (its dialog is in no visual spec). Before each screenshot the visual specs wait until the switcher trigger is not `aria-busy` (for example `await expect(page.getByRole('button', { name: /^Workspace/ })).not.toHaveAttribute('aria-busy', 'true')`), so no baseline captures the invisible label or the Home skeletons of the not-ready state.
- WP-D's report carries the final measured gate numbers (section 5.1): total and initial deltas against the baseline (initial growth explained, section 5.1 point 3), the `CalculatorDialog` lazy chunk gzip bytes against the 1.5 KB target and `calc.js`'s shared-chunk delta as WP-E measured them (unless cut 6 applied), and any cut applied.
- `docs/DESIGN.md` Components table: row "Header workspace switch: `WorkspaceSwitcher` (one header menu button; do not add a second header dropdown)"; note that `SegmentedRadio` takes `hideLegend` for a toolbar filter. `CLAUDE.md`: `AUTO_STATE_KEYS` list gains `workspace`; one sentence under the `src/` bullet: "Workspaces (Budget, Journal) are view state: nav groups carry `workspace`, `useWorkspace()` reads the route, else `app_state` `workspace`. The Work/Home tag filter exists only on the Todos page (`app_state` `mode`)." Unless cut 6 applied, a second sentence for WP-E (section 6.5, E.9).
- `docs/PRODUCT.md` decision entry and README also name the calculator unless cut 6 applied.

### 6.3 Merge order, file overlap and #87 behaviours to preserve

PR #87 is merged (9ba27a5 is this branch's base), so there are no merge conflicts with it any more. Order inside this PR:

1. WP-A first (shared exports: `navItems.js` workspace exports, `useWorkspace`, `shortcutGuard.js`).
2. Then WP-B, WP-C, WP-E and WP-F in parallel where their file sets do not overlap. An overlapping pair is serialized: the later WP rebases on the earlier one and merges after it (table below).
3. WP-D last (it carries the final measured gate, the baselines and the docs).

File-overlap table (every file touched by more than one WP, plus the shared files the orchestrator asked about):

| File | WPs | Rule |
| --- | --- | --- |
| `src/components/palette/commands.js` | B (workspace commands from A's `WORKSPACES`, mode removal), E (`buildToolCommands`, `Calculator` icon) | Serialize: **B before E** |
| `src/components/palette/CommandPalette.jsx` | B (`useWorkspace`, filters, `more`), E (tools push after line 223, `opener` in deps) | Serialize: **B before E** |
| `src/components/palette/__tests__/CommandPalette.test.jsx` | B (workspace mocks), E (calculator cases) | Serialize: **B before E** |
| `src/components/shell/shortcutGuard.js` | A (creates), E (imports only) | E after A (covered by step 1) |
| `src/components/shell/BackButton.jsx` | A only | |
| `src/components/shell/TopBar.jsx` | A only (switcher); E does not mount anything in TopBar | |
| `src/components/shell/AppShell.jsx` | E only (`<LazyCalculator />` after line 44; removed again at cut 4) | No overlap |
| `eslint.config.js` | E only | No overlap |
| `src/utils/evalAmount.js`, `src/utils/__tests__/evalAmount.test.js` | E only (callers `BudgetPlanner.jsx`, `CategoryEditor.jsx`, `IncomePayees.jsx`, `OnboardingFlow.jsx` are not edited by E) | No overlap; B edits `BudgetPlanner.jsx` and C edits `OnboardingFlow.jsx` in other hunks, and E's change does not touch them |
| `src/components/settings/SegmentedRadio.jsx` | F (`hideLegend`); C uses it with no edit | No overlap |
| `src/contexts/ModeContext.jsx` | B only (delete `moduleVisibleInMode` after rewriting its last consumers in the same WP; moved from A, QA cycle 3, M1); A removes only its own call sites (`BurgerMenu.jsx`, `ModeGate.jsx`) and does not edit the file; F only changes consumers of `matchesMode` and `useMode` | B owns the deletion; no ordering constraint with F (F neither uses nor removes `moduleVisibleInMode`) |
| `src/pages/Home.jsx`, `src/hooks/useCrossInsights.js` | B only (F changes the hooks they read, not these files) | No overlap |
| `e2e/pages/nav.js` | A (`setWorkspace`); D uses it | A first |
| `e2e/a11y/light.spec.js`, `e2e/a11y/dark.spec.js` | E only (D's axe checks live in its new `workspaces.spec.js`) | No overlap |
| `e2e/__screenshots__/**` | D only | Regenerated once, last |
| `CLAUDE.md`, `docs/DESIGN.md`, `README.md`, `docs/PRODUCT.md` | D only (E's sentences are written by D) | D last |

Every other file in section 6.2 belongs to exactly one WP.

**Symbol sequencing (QA cycle 3, M1).** Rule: a symbol is deleted only in the WP that removes its last consumer, so every WP ends with `npm test`, `npm run lint` and `npm run build` green and no dangling import, whatever order the parallel WPs merge in. Scanned against the 6.1 and 6.2 file sets and every consumer in 9ba27a5 (source and tests, including `vi.mock` factories):

| Symbol | Deleted in | Consumers and the WP that removes each | State between WPs |
| --- | --- | --- | --- |
| `moduleVisibleInMode` (`ModeContext.jsx:45-48`) | **B** | `BurgerMenu.jsx:4, 87`, `ModeGate.jsx:2, 8`, `BurgerMenu.test.jsx:8, 46, 345` (A); `Home.jsx:34, 64`, `commands.js:3, 15`, `CommandPalette.jsx:19, 207` (B) | After A, nav items have no `modes`, so the palette's nav filter (`commands.js:15`) calls it with `itemModes` undefined; its default `['work', 'home']` lists every page in every mode, which is the target behaviour. Quick actions and Home widgets keep their own `modes` until B, so the existing palette and Home tests stay green after A |
| `modes` on nav items | A | `BurgerMenu.jsx:87`, `BurgerMenu.test.jsx:46, 345` (A); `commands.js:15` (B, safe through the default above). `useDocumentTitle.js:3-6` reads only `to` and `label` from `NAV_GROUPS` items: unaffected by the regrouping | |
| `modes` on Home widgets, quick actions; `EVERY_MODE`, palette `MODE_OPTIONS`, `Mode:` commands | B | all inside `Home.jsx`, `commands.js`, `CommandPalette.jsx` and their tests (`CommandPalette.test.jsx:259-281, 324-330`, `.newIntent` fixture line 47) (B) | |
| `ModeGate` | A | `App.jsx:4, 44-46`, `server/__tests__/e2eRoutes.test.js:12-16, 33-36`, `e2e/support/routes.js` `gated` (no other reader) (A) | |
| `ModeSwitcher` (renamed `WorkspaceSwitcher`) | A | `TopBar.jsx:4, 72`, `ModeSwitcher.test.jsx` (git mv), `TopBar.test.jsx` `/^Workspace mode:/` (lines 87-186), `e2e/pages/nav.js` `setMode` and its three callers (A). No `vi.mock` of the module exists | |
| `MODES` | never | `ModeProvider` (kept); `ModeSwitcher.jsx:3` import dropped in A | |
| `matchesMode` | never | 8 hooks and the `useHabits.test.jsx:6-9` mock (F removes); `TodosPage.jsx` (F adds) | |
| `useMode` | never | `Settings.jsx`, `EntryForm.jsx`, `TodosPage.jsx`, the 8 hooks (F); `Home.jsx`, `CommandPalette.jsx` (B); `useWorkspace.js` (A adds). Spread `vi.mock` factories (`AppShell.javiButtonOff` (A), palette tests (B), `TodosAddColumn`, `JournalPage` (F)) keep working at every boundary | |
| `GeneralSection` `mode` / `onModeChange` props, `MODE_OPTIONS` | F | only `Settings.jsx:137-139` passes them; `Settings.test.jsx` "Workspace mode" assertions (F) | A leaves Settings > General working as today |
| `ACCENT`, `accentClass` (`eventLabels.js:9-15`) | F | `EventDetails.jsx:4, 24, 51`, `EventButtons.jsx:3, 38, 101` (F); `eventLabels.test.js` imports only `formatEventWhen` | |
| `CONTEXTS` in 7 forms | F | each local to its file | |
| `evalAmount` parser body | E | same export, callers unchanged | |

#87 behaviours to preserve (each WP checks its own files against this list):

| #87 behaviour | Where in 9ba27a5 | What this design does |
| --- | --- | --- |
| Back button rules: in-app history only (`history.state.idx > 0`), else `parentPath()` with `replace`; latch; Alt+Left, BrowserBack and mouse 4 always `preventDefault`; ignored while a modal is open or in a text field | `BackButton.jsx:35-70`, `routeKey.js:7-9` | Unchanged; the guard definitions move byte for byte into `shortcutGuard.js` (section 6.1). Workspace switches are pushes, so Back walks them like any page |
| Home placeholder: on `/` Back renders an `invisible` `aria-hidden` 36x36 spacer | `BackButton.jsx:73` | The switcher sits after it, so it never moves (section 2, Placement) |
| Modal form Cancel buttons removed (X, Escape and backdrop close; Calendar `EventForm` keeps its Cancel) | `HabitForm.jsx`, `EntryForm.jsx`, `NoteForm.jsx`, `BookmarkForm.jsx`, `CountdownForm.jsx`, `TodoForm.jsx` (no Cancel); `EventForm.jsx:251-253` (kept) | WP-F removes only the Context fields; no Cancel is added. The calculator dialog has no Cancel (section 6.5, E.1) |
| Quiet controls: secondary buttons use `btnSecondary`, no extra borders; per-section Resets are quiet `ResetControl` triggers | e.g. `Home.jsx:56`, `FocusPage.jsx:185-198`, `GeneralSection.jsx:80-82` | The Todos filter is the existing `SegmentedRadio` with a hidden legend; calculator history rows are quiet text buttons; no new bordered control |
| Clock kept, Javi Import chip kept, per-section Resets kept (minimalism Orchestrator decisions 1 to 3) | `TopBar.jsx:104-111`, `JaviPanel.jsx:386-401`, `GeneralSection.jsx:80-82` | Assumed by this design; no change |
| Copy rules: the AI model setting reads "Model for answers"; the word "chat" appears nowhere in the UI (`JaviPanel.jsx:276` "Start a new conversation with Javi", `:312` "Ask follow-up questions with Pro.") | `AiSection.jsx:159`, `JaviPanel.jsx` | No string in this design uses "chat" (UX copy and section 6.5, E.5 checked); no AI or model copy is added |
| Copy path removed in favour of selectable text | `BackupsControl.jsx` (no clipboard call remains) | Same precedent: no Copy button in the calculator |

`feat/remote-host-mode`: either order. Do not change the `<BrowserRouter>` literal in `App.jsx` or `EraseDataDialog.jsx:110`; run `npm run check:remote-base` (that branch's check) after the second of the two merges. No new absolute fetch or `window.location` use (the calculator has none).

### 6.4 Risks

| Risk | Mitigation |
| --- | --- |
| A user who had the global filter on Work or Home now sees every item on every page except Todos | Intended (owner decision 1). The Todos page opens with their old choice selected, so the one place the filter still exists behaves as before; the Store "What's new" says the filter moved to Todos and tags are kept |
| A removed tag field drops or rewrites a stored tag | Forms omit `context`; PATCH routes write only present keys; tests on both sides (WP-F) |
| Dropping the tag filter makes `useCalendar` sort the React Query cache in place | `.slice()` before `.sort` (section 4.3), test in WP-F |
| Stored tags still drive the Todos filter but are invisible elsewhere; Javi write tools can still set tags on notes, entries and countdowns | No effect outside Todos; follow-up for the tools (Open question 3) |
| Route sync writes `app_state` on navigation | Only on an owned page whose workspace differs from the saved one, only after the saved value loaded; key is in `AUTO_STATE_KEYS` |
| Budget card shows sample or half-loaded numbers | Sample data is never passed (`source === 'transactions'` only); skeleton until transactions and all five settings have fetched; tests (d) and (f) |
| Budget card numbers drift from the Budget page | Both read the same `useBudgetPlan` hook and `buildPlan` totals; the card uses the current month by rule and says so |
| Budget code makes the launch slower | It loads with the lazy Home chunk, never the initial chunk; the gate reports initial separately |
| Remote build seam fails on an edited literal | Section 4.4 rule; check after merge |
| WebView2 runs its own action for Alt+digit | Hand check in `npm run desktop:dev` (Open question 1); fallback Ctrl+Shift+1/2 (owner decision 7) |
| `e2e/flows/back.spec.js` (added by #87) opens Todos from the drawer on Home, which the Budget drawer no longer lists | WP-A switches that test to Journal first (section 6.2) |
| The change adds bytes under the ceilings, which `bundleBudget.js` cannot see | Measured gate against main 9ba27a5 (468.96 KB), reported per WP, one unified cut list ending with WP-E moved to its own PR, then a report to the owner (section 5.1) |
| The calculator does not fit the net <= 0 gate (estimate +1,850 B against about 1,070 B the other cuts free) | Cuts 4 and 6 in section 5.1; by the estimates the likely outcome is cut 6 (calculator in its own follow-up PR). Reported, never solved by raising the budget |
| One engine changes amount-field results | `evalAmount` pre-normalizes `$` and commas as today and runs the `amount` profile (no length, depth or range limits); every existing `evalAmount` test unchanged; legacy table and the listed behaviour changes tested (section 6.5, E.3) |
| `eval` or `Function` sneaks into the arithmetic path (desktop CSP has no `'unsafe-eval'`, web and Docker have no CSP) | ESLint `no-eval`, `no-implied-eval`, `no-new-func` on `src/**` and a raw-source test (section 6.5, E.3 and E.6) |
| Alt+C beeps or moves focus to the native menu bar in WebView2 | Hand check with Open question 1; fallback palette only (same change as cut 4) |
| Exact locale display: a lossy `Number` would round values beyond 2^53 (`123456789012.3456789012`) | `formatDecimal` (E.3) passes the exact string to `format` where the engine supports string input (one probe at load), else formats the integer part as a `BigInt` and appends the localized decimal separator and fraction digits; it never goes through `Number` for the value. Both paths tested for equality in `en-US` and `de-DE` (E.6) |
| A non-US user reads `0,3` but types `0.3` | Input keeps `.` as the decimal mark (E.2) and the field is refilled with the plain `value`, so a result can be reused as is; a decimal comma is `invalid`, never misread |
| A drag in one workspace scrambles the other workspace's Home order (shared `pos:homeLayout`) | `reorder` keeps the slots of cards not shown (sections 1.1 and 6.1, test in WP-B) |
| A user with a saved Home layout finds the Budget card last | Existing `normalize` rule appends new keys; Customize lets them drag it; accepted |
| Javi `home` thread survives a switch | Documented; Refresh regenerates |
| Visual baselines churn | One regeneration in WP-D only |
| Tests that render components using `useWorkspace` outside a router | The hook needs the router; tests wrap in `MemoryRouter` and `ModeProvider` |

### 6.5 Work package E: shared calculator

Not shipped in this PR (bundle cut 6): follow-up branch `feat/calculator`. See "Implementation outcome".

Owner request: one calculator reachable from both workspaces. Orchestrator rulings (final) are applied below: one engine with `evalAmount` keeping its results; no Copy button; insert-into-field deferred; shortcut Alt+C; unified cut list (section 5.1); Free, no Pro gate, no network, no AI, server untouched. Shared (no `workspace` field anywhere): it is a dialog, not a page, so it has no route, no nav item, no Javi page key and no `workspaceForPath` entry (row in section 1).

#### E.0 Findings that shape the design

| Finding | Where (9ba27a5) | Consequence |
| --- | --- | --- |
| Burrow already has an arithmetic parser: `evalAmount` (hand-written recursive descent, `+ - * /`, parentheses, unary sign; before parsing it removes one leading `$` and **every** comma, so `'1,2'` is 12; cents by `Math.round(x * 100) / 100`; `null` on any error) | `src/utils/evalAmount.js:16-102` (cleanup line 19); tests `src/utils/__tests__/evalAmount.test.js` | A second parser would be "a second way to do a thing". Ruling: `calc.js` is the single engine and `evalAmount` becomes a thin wrapper that keeps today's results for every input it accepts today (E.3) |
| Every amount field already accepts math through `evalAmount`: `type="text" inputMode="decimal"` inputs that evaluate on commit | `BudgetPlanner.jsx:25-71` (`AmountInput`, title "Accepts math, e.g. 50+25" at line 34, commits on blur 38-58), `CategoryEditor.jsx:64, 83`, `IncomePayees.jsx:53, 161, 169`, `OnboardingFlow.jsx:26, 197` | "Insert result into the focused amount field" duplicates what the field already does (rule 2), and opening a dialog from such a field blurs it, which commits or reverts the half-typed draft. Insert is deferred to a follow-up (Open question 4); the shortcut keeps the standard "not in an editable field" guard |
| Money elsewhere is float math rounded to cents (`round2`, `toCents`) and shown with a fixed `en-US` `Intl.NumberFormat` | `budgetAggregate.js:4-12`, `dataFormat.js:6-8`, `budgetPies.js:9`, `subscriptions.js:46-47` | No decimal utility exists to reuse. The engine uses BigInt exact rationals (dependency-free). The calculator's display uses the runtime locale (orchestrator ruling, QA cycle 3 H1; E.2); amount fields and `formatCurrency` keep the fixed `en-US` locale |
| `decimal.js-light` is in the build, but only inside the `charts` group | `vite.config.js:44` | Rejected: importing it from the calculator would pull the charts chunk group into the dialog |
| `Modal` already gives everything the dialog needs: `role="dialog"`, `aria-modal="true"`, `aria-labelledby` its title, Tab trap, Escape, backdrop, scroll lock, Close (X), focus restore to the opener or `finalFocusRef` | `Modal.jsx:42-54` (props), `:74` (opener), `:86-91` (initial focus), `:95-102` (Escape, `stopPropagation`), `:132-135` (restore), `:150-152`, `:162-170` | Reuse `Modal` as is. No new shared component |
| Lazy host pattern: a tiny main-chunk host that owns the trigger listener and mounts a `lazy()` component inside `Suspense fallback={null}`; open events are `CustomEvent`s fired by a one-function module | `LazyCommandPalette.jsx:3-4, 24-53`, mounted at `AppShell.jsx:44`; `openJavi.js:3-10` | Same pattern: `LazyCalculator.jsx` + `openCalculator.js` |
| The palette remembers the element focused before it opened, restores it on close unless focus moved on purpose, and shows a right-aligned `hint` on each row | `CommandPalette.jsx:101, 109-116, 440` | The palette command passes that element as the calculator's return target; `hint` shows `Alt+C` at zero new UI cost |
| Desktop CSP has no `'unsafe-eval'` (`script-src 'self'` plus hashes); it is set only in desktop mode | `server/desktop/csp.js:24-35`, `server.js:114-124` (not re-verified: server files are untouched) | `eval` / `Function` would throw in the desktop app, but the web and Docker builds have no CSP, so the "no dynamic code" rule is enforced by lint and a test (E.6), not by the CSP |
| ESLint uses `js.configs.recommended`, which does not include `no-eval`, `no-implied-eval` or `no-new-func`; the only dynamic-code use in `src/` is a test | `eslint.config.js:12`; `src/utils/__tests__/indexHtmlPrepaint.test.js:21` (`new Function(SCRIPT)()`) | Add the three rules for `src/**` minus `__tests__` (E.3) |
| `keydown` listeners in `src/`: Ctrl/Cmd K (`useCommandPalette.js:13-16`, `LazyCommandPalette.jsx:32-37`, `ModeSwitcher.jsx:36`, `BurgerMenu.jsx:136`); Escape/Tab/arrows (`Modal.jsx:93-123`, `NotificationBell.jsx:25-31`, `BurgerMenu.jsx:144-165`, `FolderMoreMenu.jsx:73`, `useScrollSpy.js:132` scroll keys); Alt+Left / BrowserBack (`BackButton.jsx:47-54`); Alt+1 / Alt+2 (section 2). Native menu: File, Edit (predefined clipboard items), Help, no custom accelerators and no `&` mnemonics (`src-tauri/src/menu.rs:66-96`) | | Alt+C is free (E.1) |
| Clipboard: before #87, `BackupsControl.jsx` copied the data folder path with `navigator.clipboard.writeText` | #87 removed that Copy path button in favour of selectable text (minimalism section 2); no clipboard call remains in `BackupsControl.jsx` | Same precedent: no Copy button (ruling); the result is selectable text |

#### E.1 Surface and entry points

| Item | Decision | Why |
| --- | --- | --- |
| Surface | Small dialog: `Modal size="sm"`, title `Calculator`. No page, no nav entry, no route | Owner preference; one dialog serves both workspaces with no workspace logic |
| Entry 1 | Command palette item `Calculator` (group `Actions`, hint `Alt+C`) | Search already reaches everything in both workspaces |
| Entry 2 | Keyboard shortcut **Alt+C** (ruling) | See collision check below |
| Header icon | **None** | Minimalism rules 1, 2 and 6: the header already holds burger, Back, workspace switcher, greeting, dev and trial badges, Search (Ctrl K), bell and clock; Search is one keystroke away and lists Calculator; a rarely used tool does not earn a permanent header control on a narrow title bar |
| Primary action | `Calculate` (submit, `btnPrimary`); Enter submits | One primary action per view |
| Secondary controls | History rows (quiet text buttons that recall a result) | Quiet, no fill, no border (#87 quiet controls) |
| Cancel | None. Close (X), Escape and the backdrop close (Modal) | Minimalism rule 3, as #87 applied to form dialogs |
| Copy result | None (ruling). The result is a `select-all` span and the field holds the plain value after success | Same precedent as #87's Copy path removal |

Shortcut: **Alt+C**, matched on `e.key` (`'c'` or `'C'`), not `e.code`. Reason: a letter shortcut is a mnemonic ("C for Calculator"), so it follows the printed letter on Dvorak or AZERTY; Alt+1 / Alt+2 match `e.code` because digits need Shift on AZERTY, which does not apply to letters. Minimalism already settles that Windows is the only shipped desktop target, so macOS Option+C (`ç`) is not a concern; the editable-field guard below also keeps it from ever being swallowed while typing.

Collision check:

| Combo | Taken by | Clash with Alt+C |
| --- | --- | --- |
| Alt+1, Alt+2 (fallback Ctrl+Shift+1/2) | Workspace switch (section 2) | No |
| Alt+Left, BrowserBack, mouse 4 | Back (#87) | No |
| Ctrl/Cmd K | Palette, burger, switcher | No |
| Escape, Tab, arrows, Home, End | Modal, menus, bell, scroll spy | No |
| Native menu | No accelerators, no `&` mnemonics; Win32 implicit first-letter access would be F, E, H only | No |
| Chromium / WebView2 browser accelerators | Ctrl+Shift+C/I/J (DevTools), F12, F5, Ctrl+R/F/G/P, Ctrl +/-/0, Alt+Left/Right, Alt+Home | No (Alt+C is unbound) |
| Firefox web build menu mnemonics | Alt+F/E/V/S/B/T/H | No |
| AltGr+C (= Ctrl+Alt+C on Windows layouts that print a character) | Text input | Excluded by the Ctrl guard |

WebView2 is checked by hand together with Alt+1 / Alt+2: Open question 1 covers Alt+C too ("no beep, no focus move to the native menu bar"). If Alt+C misbehaves, the fallback is the palette only (the same change as cut 4 in section 5.1), not another combo.

Guards (same rules as Back and Alt+1/Alt+2, via WP-A's `shortcutGuard.js`, which carries #87's exact definitions): ignored when `e.repeat`, when Ctrl, Meta or Shift is also held, or when `e.defaultPrevented`; `preventDefault()` on every non-repeat match; then no open while a modal is open (`isModalOpen()`: palette, drawer, onboarding, any Modal, the calculator itself; a dialog inside an `[inert]` subtree does not count) or while focus is in a text field (`inEditable`; checkbox, radio, range and button inputs do not count). Why not from an amount field: those fields already evaluate the same grammar (E.0), and opening a dialog would blur the field and commit or revert its draft (`BudgetPlanner.jsx:38-58`).

#### E.2 Behaviour

| Topic | Rule |
| --- | --- |
| Input | One text field. Enter (form submit) or `Calculate` evaluates |
| On success | The live region shows the result (`display`, grouped and formatted in the runtime locale, so `0,3` in German); the field is replaced by `value` (plain, no grouping, `.` decimal mark, which the input accepts) with the caret at the end, so the user can keep going (`*2`); the entry goes to history |
| On error | The field keeps the text, gets `aria-invalid="true"`, focus stays; the live region shows the message (E.5). The next edit clears the error |
| Empty input | Enter does nothing (no message, no history entry) |
| History | Last 10 successful results, newest first, text `<expr as typed, trimmed> = <display>` (`display` in the runtime locale). Clicking a row puts its `value` (plain, `.` decimal mark) in the field and focuses it. Kept in a module-level array in the lazy chunk: survives close and reopen, cleared on reload (and by Erase all my data, which reloads, `EraseDataDialog.jsx:110`). Never `app_state`, never `localStorage`, never in a Javi page context, never logged |
| Copy | No Copy button (ruling). The result is a `select-all` span and the field holds the plain value after success, so select plus Ctrl+C copies it |
| Insert into a field | Deferred to a follow-up (Open question 4) |
| Escape | Closes (Modal); focus returns to the element focused before the palette or the shortcut (E.4) |

Percent semantics (phone-calculator style, chosen because "price + tip %" and "price minus discount %" are the money cases):

| Rule | Example | Result |
| --- | --- | --- |
| `p%` on its own, or as a factor of `*` or `/`, is `p / 100` | `50%`, `200 * 10%`, `200 / 10%`, `10% + 5` | `0.5`, `20`, `2000`, `5.1` |
| A term that is exactly one percent operand (optionally signed) on the right of `+` or `-` is that percent **of the running total on its left** | `200 + 10%`, `200 - 10%`, `200 + 10% + 10%`, `200 + -10%` | `220`, `180`, `242`, `180` |
| The percent-of rule needs the `%` directly on the term; a percent inside parentheses or inside a product is plain `p / 100` | `200 + (10%)`, `200 + 10% * 2`, `(200 + 10)%` | `200.1`, `200.2`, `2.1` |
| One `%` per operand; `%` never starts an operand | `50%%`, `%5` | invalid |

Numbers and locale. The engine has two profiles (E.3): `calculator` (the dialog) and `amount` (only `evalAmount`). Rows marked "calculator" do not apply to amount fields.

| Topic | Rule |
| --- | --- |
| Decimal mark | `.` only. `.5` and `5.` are valid; `.` alone and `1.2.3` are invalid |
| Comma (calculator) | Thousands separator only, and only where it is one: after a digit and followed by exactly three digits then a non-digit or the end (`1,234`, `12,345,678.9`). Any other comma is invalid, so the calculator never reads `1,5` as 15 |
| Comma (amount fields) | Unchanged from today: `evalAmount` removes every comma before the engine runs, so `evalAmount('1,2')` stays 12 (E.3) |
| `$` | One leading `$` (after optional whitespace) is ignored, as `evalAmount` does today. In amount fields the wrapper removes it; in the calculator the engine does |
| Operators | `+`, `-` and the minus sign U+2212; `*`, `x`, `X`, `×`; `/`, `÷`; `(`, `)`; postfix `%` |
| Whitespace | The `/\s/` class (the same as `evalAmount` today), allowed between tokens, never inside a number (`1 2` is invalid) |
| Letters, exponents, implicit multiplication | Invalid (`abc`, `1e5`, `2(3)`) |
| Display (calculator: result, live region, history) | Runtime locale (orchestrator ruling, QA cycle 3 H1): `new Intl.NumberFormat(undefined, { maximumFractionDigits: 10 })`, fed the exact decimal `value` string through `formatDecimal` (E.3), never a lossy `Number`. Where the engine supports string input to `format` (Intl.NumberFormat v3: Chromium 106+, so evergreen WebView2, and Node 19+), `format(value)` is called with the string; elsewhere the dependency-free split path formats the integer part as a `BigInt` (exact at any size) and appends the locale's decimal separator and the fraction digits, each localized. `en-US` shows `1,234.5`, `de-DE` shows `1.234,5` and `0,3`. `value` keeps at most 10 fraction digits, so `maximumFractionDigits: 10` never rounds it again. Input is unchanged: `.` is the only decimal mark and a comma is only a true thousands separator (rows above), whatever the locale. Amount fields (`evalAmount`) and `formatCurrency` are unchanged: they stay fixed `en-US` |
| Precision | Results are exact rationals, rounded once at the end to `places` fraction digits (10 in the calculator, 2 for amounts), half away from zero (`2/3` is `0.6666666667`, `-2/3` is `-0.6666666667`), no trailing zeros, never `-0` |
| Too big (calculator) | Exact result with absolute value at or above 1e15 (1,000,000,000,000,000): `out_of_range` |
| Too small (calculator) | Exact non-zero result with absolute value under 1e-10 (0.0000000001): `out_of_range`, so a tiny value never shows as a misleading `0`. Exact zero is `0` |
| Intermediate values | Unbounded and exact (`10000000000 * 10000000000 / 10000000000` is valid); in the calculator the 200-character cap bounds them (worst case about 10^200, trivial for BigInt) |
| Length cap (calculator) | 200 characters of the trimmed input: `too_long`, checked before anything else |
| Nesting cap (calculator) | 20 levels of parentheses: `too_deep`. Unary chains are bounded by the length cap (150 minus signs recurse safely) |
| Amount profile limits | Length cap `AMOUNT_MAX_LENGTH = 1000` characters of the trimmed input, checked before lexing (`too_long`, so `evalAmount` returns `null`; the legacy 801-char `'9'*400 + '/' + '9'*400` row still passes). No depth or range limit. An intermediate size guard in `make()` (every profile): a numerator or denominator at or above `2n ** 4096n` fails `out_of_range`, a backstop: under the length cap an operand cannot exceed about 3322 bits, so the guard is defence in depth and not reachable through `evaluate`. A result that does not fit a JS Number is `null` from the wrapper. The amount profile skips `display`. Only the amount profile maps a `RangeError` to `invalid` (unreachable under the length cap, kept as a backstop) |
| Error order | `empty`, then `too_long`, then the first problem met reading left to right (`invalid`, `too_deep`, `divide_by_zero`), then `out_of_range` on the final value. So `1/0 + )` is `divide_by_zero` |

#### E.3 Contracts

`src/utils/calc.js` (new; pure; no imports; no `eval`, `Function`, `import()` or string timers; only `BigInt` and `Intl`):

```js
export const CALC_MAX_LENGTH = 200; // characters of the trimmed input (calculator profile)
export const CALC_MAX_DEPTH = 20;   // nested parentheses (calculator profile)
export const CALC_PLACES = 10;      // default fraction digits of `value`
// Calculator profile limits on the exact final value: |v| < 1e15, and v === 0 or |v| >= 1e-10.

/**
 * @typedef {{ ok: true, value: string, display: string }} CalcOk
 *   value: exact result rounded to `places` fraction digits, half away from zero; plain decimal
 *          ('-1234.5', '0.3', '0'): no exponent, no grouping, no trailing zeros, never '-0'.
 *   display: formatDecimal(value, locale): the runtime locale by default ('1,234.5' in en-US, '1.234,5' in de-DE).
 * @typedef {{ ok: false, error: 'empty' | 'invalid' | 'divide_by_zero' | 'too_long' | 'too_deep' | 'out_of_range' }} CalcErr
 * @param {string} expr Non-strings return { ok: false, error: 'invalid' }.
 * @param {{ places?: number, profile?: 'calculator' | 'amount', locale?: string }} [options]
 *   places: integer 0 to 10, default 10 (evalAmount passes 2).
 *   locale: BCP 47 tag for `display` only; default undefined = the runtime locale. The app never passes it;
 *     unit tests pass 'en-US' (or 'de-DE') to pin it. It never changes `value` or what the input accepts.
 *   profile 'calculator' (default): one leading '$' ignored, commas only as valid thousands separators,
 *     CALC_MAX_LENGTH, CALC_MAX_DEPTH and the value range apply.
 *   profile 'amount' (evalAmount only): the caller already removed the leading '$' and every comma, so
 *     '$' and ',' are invalid characters here; no length, depth or range limit (evalAmount never had one);
 *     a RangeError from extreme nesting is caught and returned as 'invalid'.
 * @returns {CalcOk | CalcErr}
 */
export function evaluate(expr, { places = CALC_PLACES, profile = 'calculator', locale } = {}) {}

// True when Intl.NumberFormat formats a numeric string exactly (Intl.NumberFormat v3). Probed once at load with a
// fixed locale and no grouping: an engine without string input converts to a Number and prints ...992.
const STRING_INPUT = new Intl.NumberFormat('en-US', { useGrouping: false }).format('9007199254740993') === '9007199254740993';

/**
 * Locale display of an exact plain decimal string in the `value` shape ('-1234.5', '0.3'; at most 10 fraction
 * digits, never '-0'). Never converts the value to a Number, so it is exact beyond 2^53.
 * @param {string} value
 * @param {string} [locale] default undefined = the runtime locale
 * @param {boolean} [stringInput] defaults to STRING_INPUT; tests pass false to run the split path
 * @returns {string}
 */
export function formatDecimal(value, locale = undefined, stringInput = STRING_INPUT) {
  const nf = new Intl.NumberFormat(locale, { maximumFractionDigits: 10 }); // built per call: no import-order trap in tests
  if (stringInput) return nf.format(value);
  // Split path: the integer part as a BigInt (exact at any size), then the locale's decimal separator and digits.
  const neg = value.startsWith('-');
  const [int, frac = ''] = (neg ? value.slice(1) : value).split('.');
  const n = BigInt(int);
  // BigInt has no negative zero, so '-0.5' borrows the sign layout of -1n and swaps in the localized zero.
  const parts = nf.formatToParts(neg ? (n === 0n ? -1n : -n) : n);
  if (neg && n === 0n) parts.find((p) => p.type === 'integer').value = nf.format(0);
  const out = parts.map((p) => p.value);
  if (frac) {
    const decimal = nf.formatToParts(1.5).find((p) => p.type === 'decimal').value;
    const digits = [...frac].map((d) => nf.format(Number(d))).join(''); // single digits: localized numerals
    const at = parts.findLastIndex((p) => p.type === 'integer' || p.type === 'group') + 1;
    out.splice(at, 0, decimal + digits);
  }
  return out.join('');
}
```

`formatDecimal` is the calculator's one display path (`display` in `evaluate`); `CalculatorDialog` shows `display` and never formats on its own. Dependency-free (only `Intl` and `BigInt`). The parts of the split path keep the locale's sign position and any bidi marks, because only the integer value and the inserted fraction differ from what `Intl` produced.

Grammar (hand-written recursive descent over a normalized token stream, eager left-to-right evaluation like `evalAmount` today):

```
expr    := term (('+' | '-') term)*            percent-of rule applies to a bare-percent right term
term    := signed (('*' | '/') signed)*
signed  := ('+' | '-') signed | postfix        a term that is one signed postfix with '%' is "bare percent"
postfix := primary '%'?
primary := number | '(' expr ')'               depth + 1 per '('; calculator: depth > 20 -> too_deep
number  := digits ('.' digits?)? | '.' digits  calculator: digits may contain valid thousands commas (E.2)
```

Arithmetic on `{ n: bigint, d: bigint }` with `d > 0`, reduced by gcd after each operation; a number literal is `n = digits without '.' and ','`, `d = 10n ** fractionLength`; division by a zero numerator returns `divide_by_zero` at once. Rounding: `q = |n| * 10n ** places`, `r = q / d`, `if (2n * (q % d) >= d) r += 1n`, sign applied only when `r !== 0n`, then the decimal point inserted and trailing zeros trimmed.

`src/utils/evalAmount.js` (replace the body; same export, same 4 callers, unchanged call sites):

```js
import { evaluate } from './calc';

// Money amount from a field: a plain number or a small calculation ("1,200.50", "$50", "200 + 10%").
// One arithmetic engine for the app (calc.js). The cleanup below is the one evalAmount always did:
// one leading "$" and every comma are removed first, so "1,2" is still 12.
// Returns a Number rounded to cents, or null.
export function evalAmount(input) {
  if (typeof input !== 'string') return null;
  const cleaned = input.replace(/^\s*\$/, '').replace(/,/g, '');
  const r = evaluate(cleaned, { places: 2, profile: 'amount' });
  if (!r.ok) return null;
  const n = Number(r.value);
  return Number.isFinite(n) ? n : null;
}
```

Amount fields keep today's results (each row is a test in `evalAmount.test.js`, E.6; every existing case in that file stays unchanged and green):

| Input | Today and after |
| --- | --- |
| `1,2` / `,5` / `1,,2` | `12` / `5` / `12` (every comma removed first) |
| `1,234.5`, `$1,200.50` | `1234.5`, `1200.5` |
| `$$5`, `5$`, `-$5` | `null` (only one leading `$` is removed) |
| `1000000000000000` (1e15) | `1000000000000000` (no range limit) |
| `0.00000000001` | `0` (no lower limit; rounds to cents) |
| `'1+'.repeat(100) + '1'` (201 characters) | `101` (no length limit) |
| 25 nested parentheses around `1` | `1` (no depth limit) |
| `'9'.repeat(400)` | `null` (does not fit a Number) |
| `.5`, `5.`, `.`, `1.2.3`, `1 2`, `1e5` | `0.5`, `5`, `null`, `null`, `null`, `null` |
| `1/3`, `2/3`, `0.1+0.2`, `5/0`, `0/0` | `0.33`, `0.67`, `0.3`, `null`, `null` |

Accepted behaviour changes for amount fields (orchestrator ruling: exact cents rounding, and newly accepted percent and x / ÷ glyphs). Each row is a test in `evalAmount.test.js` (E.6):

| Input | Today | After | Change |
| --- | --- | --- | --- |
| `1.005` | `1` (float `100.49999...`) | `1.01` | Exact cents rounding |
| `-1.005` | `-1` | `-1.01` | Exact cents rounding |
| `-0.125` | `-0.12` (`Math.round` rounds a negative half toward +infinity) | `-0.13` | Exact cents rounding, half away from zero |
| `-0.005` | `-0` | `-0.01` | Exact cents rounding |
| `-0.004`, `-0`, `0*-1` | `-0` | `0` | Exact cents rounding never returns `-0` (`Object.is(result, 0)`) |
| `'9'.repeat(400) + '/' + '9'.repeat(400)` | `null` (the literal itself parses to Infinity, so `parseFactor` returns null, `evalAmount.js:53-54`) | `1` | Exact arithmetic: literals and intermediates are exact; a final value that does not fit a Number is still `null` |
| `200+10%`, `200-10%`, `50%`, `10%*200` | `null` | `220`, `180`, `0.5`, `20` | Percent, newly accepted |
| `6x7`, `6X7`, `6×7` | `null` | `42` | Glyph, newly accepted |
| `8÷2` | `null` | `4` | Glyph, newly accepted |
| `5−2` (U+2212 minus sign) | `null` | `3` | Glyph, newly accepted |

`src/components/calculator/openCalculator.js` (new, main chunk; mirrors `openJavi.js`):

```js
export const CALCULATOR_OPEN_EVENT = 'calculator:open';
/** @param {Element | null} [returnTo] where focus goes back on close when the opener is gone */
export function openCalculator(returnTo = null) {
  window.dispatchEvent(new CustomEvent(CALCULATOR_OPEN_EVENT, { detail: { returnTo } }));
}
```

`src/components/calculator/LazyCalculator.jsx` (new, main chunk; props none; mounted once in `AppShell.jsx` right after `<LazyCommandPalette javiAvailable={javiAvailable} />` at line 44; it owns the Alt+C listener for the app's lifetime; deleted at cut 4):

```jsx
import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { CALCULATOR_OPEN_EVENT } from './openCalculator';
import { inEditable, isModalOpen } from '../shell/shortcutGuard';

const CalculatorDialog = lazy(() => import('./CalculatorDialog')); // no idle preload: loopback load is instant

export default function LazyCalculator() {
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const returnRef = useRef(null);
  useEffect(() => {
    const show = (returnTo) => {
      if (openRef.current) return; // keep the first return target while open
      openRef.current = true;
      returnRef.current = returnTo ?? null;
      setOpen(true);
    };
    const onOpen = (e) => show(e.detail?.returnTo);
    const onKey = (e) => {
      if (e.repeat || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.defaultPrevented) return;
      if (e.key !== 'c' && e.key !== 'C') return;
      e.preventDefault();
      if (isModalOpen() || inEditable(e.target)) return;
      show(document.activeElement);
    };
    window.addEventListener(CALCULATOR_OPEN_EVENT, onOpen);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener(CALCULATOR_OPEN_EVENT, onOpen);
      window.removeEventListener('keydown', onKey);
    };
  }, []);
  if (!open) return null;
  const close = () => { openRef.current = false; setOpen(false); };
  return (
    <Suspense fallback={null}>
      <CalculatorDialog onClose={close} finalFocusRef={returnRef} />
    </Suspense>
  );
}
```

`src/components/calculator/CalculatorDialog.jsx` (new, lazy chunk):

```jsx
// Props: { onClose: () => void, finalFocusRef: { current: Element | null } }
// Module scope: const HISTORY_MAX = 10; let session = []; // in memory only (E.2)
// const MESSAGES = { invalid, divide_by_zero, too_long, too_deep, out_of_range } // strings in E.5
// State: expr (string), out (null | { display } | { error }), history (initialised from `session`)
<Modal title="Calculator" size="sm" onClose={onClose} initialFocusRef={inputRef} finalFocusRef={finalFocusRef}>
  <form noValidate onSubmit={submit}>          {/* submit: evaluate(expr); 'empty' -> no-op; error -> out = { error };
                                                   ok -> session = [{ expr: expr.trim(), value, display }, ...session].slice(0, 10),
                                                         setHistory(session), out = { display }, expr = value */}
    <label htmlFor={inputId} className={labelClass}>Calculation</label>
    <div className="flex gap-2">
      <input id={inputId} ref={inputRef} type="text" value={expr} onChange={/* setExpr; clear an error */}
        autoComplete="off" spellCheck={false} placeholder="For example 200 + 10%"
        aria-invalid={out?.error ? true : undefined} aria-describedby={outId}
        className={`${inputClass} tabular-nums`} />
      <button type="submit" className={btnPrimary}>Calculate</button>
    </div>
    {/* One polite live region for results and errors; reserves one line of height (Tailwind scale) so nothing jumps */}
    <p id={outId} aria-live="polite" aria-atomic="true" className="mt-3 text-lg font-semibold tabular-nums text-slate-slate100">
      {out?.error && <span className={formErrorClass}>{out.error}</span>}
      {out?.display && (<><span className="sr-only">Result: </span><span className="select-all">{out.display}</span></>)}
    </p>
    {history.length > 0 && (
      <section aria-labelledby={historyId} className="mt-4">
        <h3 id={historyId} className="text-[10px] uppercase tracking-widest text-slate-slate400">Recent results</h3>
        <ol className="mt-1">
          {history.map((h, i) => (
            <li key={i}>
              <button type="button" onClick={/* setExpr(h.value); clear out; focus input */}
                className="w-full truncate rounded-md px-2 py-1 text-left text-sm tabular-nums text-slate-slate300 hover:bg-slate-slate700/60 hover:text-slate-slate100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-slateBlueLight">
                {h.expr} = {h.display}
              </button>
            </li>
          ))}
        </ol>
      </section>
    )}
  </form>
</Modal>
```

`src/components/palette/commands.js` (add; after WP-B's edits):

```js
import { Calculator } from 'lucide-react'; // joins the existing lucide import on line 1
import { openCalculator } from '../calculator/openCalculator';

// Tools that open over the current page. `returnTo` is the element focused before the palette opened.
export function buildToolCommands({ returnTo }) {
  return [{
    id: 'tool:calculator',
    label: 'Calculator',
    hint: 'Alt+C', // drops at cut 4
    keywords: 'calculate calculator math sum add subtract multiply divide percent tip split',
    icon: Calculator,
    group: 'Actions',
    run: () => openCalculator(returnTo),
  }];
}
```

`src/components/palette/CommandPalette.jsx` (in the `items` memo, directly after the quick actions push at line 223, so it renders under the same `Actions` header; add `opener` to the memo deps at line 262):

```js
const tools = buildToolCommands({ returnTo: opener }).map((c) => ({ ...c, onSelect: () => { c.run(); onClose(); } }));
list.push(...fuzzyFilter(q, tools, commandSearchText));
```

Focus sequence from the palette (why `finalFocusRef` is needed): `run()` fires the event, then `onClose()`; the palette stays mounted 220 ms for its fade (`CommandPalette.jsx:70-78`). If the dialog mounts first, the Modal records the palette input as its opener, which is gone at close, so `Modal` falls back to `finalFocusRef` (the palette's opener). If the palette unmounts first, its cleanup restores focus to its opener (`:109-116`) and the Modal records that as its opener. Either way Escape lands on the element focused before the palette. The palette's cleanup never steals focus from the calculator input (it only moves focus when focus is on `body` or inside the palette).

Cut 4 variant (section 5.1): no `LazyCalculator.jsx`, no `AppShell` mount, no Alt+C listener. The outer `CommandPalette` component (mounted once armed, `LazyCommandPalette.jsx:48-53`) holds `calcOpen` and `calcReturn`, listens for `calculator:open` and renders `lazy(() => import('../calculator/CalculatorDialog'))` inside `Suspense fallback={null}` with the same props. The palette hint and every "Alt+C" string drop.

`eslint.config.js` (add one block after the first config object, which ends at line 20):

```js
{
  files: ['src/**/*.{js,jsx}'],
  ignores: ['src/**/__tests__/**'], // indexHtmlPrepaint.test.js runs the pre-paint script with new Function
  rules: { 'no-eval': 'error', 'no-implied-eval': 'error', 'no-new-func': 'error' },
},
```

Untouched, stated: `server/pro.js`, the `PRO_FEATURES` registry, `server/license/proFeatureDates.js` and `useEntitlements` (Free, no gate); no server file, route, API, `app_state` key, `AUTO_STATE_KEYS` entry, network feature or Javi context; no `localStorage` key; no AI call.

#### E.4 Accessibility and theme

| Need | How |
| --- | --- |
| Dialog semantics | `Modal`: `role="dialog"`, `aria-modal="true"`, `aria-labelledby` the `Calculator` heading |
| Focus | Opens on the input (`initialFocusRef`); Tab trapped (Modal); Escape, X and backdrop close; focus returns to the opener, else `finalFocusRef` (palette's opener, or the element focused at Alt+C) |
| Input | Visible label `Calculation`; `aria-describedby` the live region; `aria-invalid` on error |
| Announcements | One `aria-live="polite" aria-atomic="true"` region: `Result: 0.3` (visually `0.3`, prefix `sr-only`; the number is the locale-formatted `display`, so `Result: 0,3` under `de-DE`) or the error text. A repeat of the identical text is not re-announced (accepted; the field value still changes) |
| Shortcut discoverability | Palette row hint `Alt+C` (`CommandPalette.jsx:440`). No `aria-keyshortcuts`: nothing persistent on screen opens it |
| Themes | Tokens only: `text-slate-slate100` result, `formErrorClass` (`text-accent-red`) errors, `slate300` / `slate100` history, `slate400` heading, `inputClass`, `btnPrimary`, `glass-flat` from Modal |
| Focus ring | `btnPrimary` and history rows: `focus-visible:ring-2 focus-visible:ring-slate-slateBlueLight`; input: `inputClass` (DESIGN.md "Focus") |
| Numbers | `tabular-nums` on input, result and history |
| Touch | Calculate is a full-size button; X from Modal |

#### E.5 UX strings

Checked against #87's copy rules: no string uses "chat"; no AI or model wording.

| Key / location | String | Notes |
| --- | --- | --- |
| Dialog title | `Calculator` | Accessible name of the dialog |
| Input label | `Calculation` | Visible |
| Input placeholder | `For example 200 + 10%` | Teaches the percent rule; no helper line (minimalism rule 5) |
| Submit button | `Calculate` | The one primary action |
| Live region, success | `Result: <display>` | `Result: ` is screen reader only; `<display>` is formatted in the runtime locale (E.2), for example `Result: 0,3` under `de-DE` |
| Error `invalid` | `Burrow can't read that calculation. Use numbers, + - × ÷, parentheses and %.` | Covers letters, bad commas (including a decimal comma such as `0,5`: the input uses `.` in every locale), two decimal points, trailing operator, unbalanced parentheses. String unchanged by the locale ruling |
| Error `divide_by_zero` | `You can't divide by zero. Change the number you divide by.` | |
| Error `too_long` | `That calculation is too long. Use 200 characters or fewer.` | |
| Error `too_deep` | `That calculation has too many parentheses inside each other. Use 20 levels or fewer.` | |
| Error `out_of_range` | `The result is too big or too small to show. Check the numbers and try again.` | At or above 1e15 in absolute value, or a non-zero value under 0.0000000001 |
| Error `empty` | none | Enter does nothing |
| History heading | `Recent results` | Hidden while empty (no empty-state copy) |
| History row | `<expression> = <display>` | Expression as typed, trimmed; `<display>` in the runtime locale; truncated visually |
| Palette label | `Calculator` | Group `Actions` |
| Palette hint | `Alt+C` | Drops at cut 4 (section 5.1) |
| Palette keywords | `calculate calculator math sum add subtract multiply divide percent tip split` | |
| Release notes / Store "What's new" (owner, optional) | `New: a calculator. Open it from search (Ctrl+K) or press Alt+C. Amount fields also understand percent, like 200 + 10%.` | Drop "or press Alt+C" after cut 4; drop the whole line after cut 6 (it ships with the follow-up PR) |
| README modules list (owner, optional) | `Calculator: from search or Alt+C, exact decimal math, in both workspaces.` | Same cut rules |

#### E.6 Tests

`src/utils/__tests__/calc.test.js` (new; table-driven, assert `value` and, where shown, `display`; calculator profile unless stated). Locale pinned: every `evaluate` call that asserts `display` passes `locale: 'en-US'`, so the table holds on any machine; the `de-DE` rows pass `locale: 'de-DE'`:

| Area | Cases |
| --- | --- |
| Precedence, associativity | `1 + 2 * 3` 7; `(1 + 2) * 3` 9; `10 - 4 - 3` 3; `64 / 4 / 2` 8; `2 * 3 / 4` 1.5 |
| Unary minus | `-2` -2; `--2` 2; `-(3)` -3; `+5` 5; `2 * -3` -6; `-2 * -3` 6; `1 - -1` 2; `'-'.repeat(150) + '1'` 1 (no stack overflow); `0 * -1` `0` (not `-0`) |
| Glyphs | `6 x 7`, `6 X 7`, `6 × 7` 42; `8 ÷ 2` 4; `5 − 2` 3 |
| Percent | every row of the E.2 percent table; `5 %` 0.05; `5 / 0%` divide_by_zero |
| Decimals | `0.1 + 0.2` value `0.3`, display `0.3`; `.5 + .5` 1; `5. + 1` 6; `1.2.3`, `.`, `1..2`, `1 2` invalid |
| Rounding | `1 / 3` `0.3333333333` (display same); `2 / 3` `0.6666666667`; `-2 / 3` `-0.6666666667`; `1 / 3 * 3` `1` (exact); `0.00000000015` `0.0000000002`; `-0.00000000015` `-0.0000000002`; `places: 2`: `1.005` `1.01`, `-0.005` `-0.01`, `0.001` `0` |
| Commas, `$` | `1,234.5 + 1` value `1235.5`, display `1,235.5`; `12,345,678` ok; `1,5`, `1,23`, `1,2345`, `,5` invalid; `$50 + 5` 55; `5 $` invalid |
| Large | `999999999999999` display `999,999,999,999,999`; `1000000000000000` out_of_range; `99999999 * 99999999` out_of_range; `10000000000 * 10000000000 / 10000000000` `10000000000`; `123456789012.3456789012` display `123,456,789,012.3456789012` (exact string formatting) |
| Small | `0.0000000001` ok; `1 / 10000000000 / 10` out_of_range |
| Divide by zero | `5 / 0`, `5 / (2 - 2)`, `0 / 0` divide_by_zero; `1/0 + )` divide_by_zero (left to right) |
| Malformed | `''`, `'   '` empty; `1 +`, `* 5`, `()`, `(1 + 2`, `1 + 2)`, `abc`, `1e5`, `2(3)`, `50%%`, `%5` invalid; non-string invalid |
| Caps | 201 characters `too_long` (also `'a'.repeat(201)`: too_long wins over invalid); `'1+'.repeat(99) + '1'` (199 chars) `100`; 21 nested parentheses too_deep; 20 nested parentheses ok |
| Amount profile | `profile: 'amount'`: `$5` and `1,2` invalid (the wrapper removes them first); 201 characters, 25 nested parentheses and `1000000000000000` ok; `0.00000000001` with `places: 2` `0`; 1001 characters `too_long`; 100,000 nested parentheses `too_long` |
| Locale display | `de-DE`: `0.1 + 0.2` value `0.3`, display `0,3`; `1,234.5 + 1` value `1235.5`, display `1.235,5` (input still uses `.` and the thousands comma). `formatDecimal` split path equals the string path (`formatDecimal(v, l, false) === formatDecimal(v, l, true)`) for `0`, `0.3`, `-0.5`, `-1234.5`, `999999999999999`, `123456789012.3456789012`, `0.0000000001` in `en-US` and `de-DE`; no locale given: equals `new Intl.NumberFormat(undefined, { maximumFractionDigits: 10 }).format(value)` for `0.3` |
| Shape | ok results have exactly `ok`, `value`, `display`; errors exactly `ok`, `error` |
| No dynamic code | `import src from '../calc.js?raw'` (and `../evalAmount.js?raw`): no match for `/\beval\s*\(/`, `/\bFunction\s*\(/`, `/\bimport\s*\(/`. The test reads the raw source, comments included, so comments in `calc.js` and `evalAmount.js` must not contain those literal patterns either: write "no eval" or "no dynamic code", never `eval(`, `Function(` or `import(` (QA cycle 3, I1) |

`src/utils/__tests__/evalAmount.test.js` (extend; every existing case stays unchanged): one `describe` for the "keep today's results" table (E.3) row by row, one `describe` for the accepted behaviour changes table row by row, including `Object.is(evalAmount('-0.004'), 0)`.

`src/components/calculator/__tests__/CalculatorDialog.test.jsx` (new; locale pinned: with `const RealNumberFormat = Intl.NumberFormat;` captured at the top of the file, a `beforeEach` wraps it with `vi.spyOn(Intl, 'NumberFormat').mockImplementation(function (locales, options) { return new RealNumberFormat(locales ?? 'en-US', options); })` (a regular function, not an arrow, because `formatDecimal` calls it with `new`), restored in `afterEach`; `formatDecimal` builds its formatter per call, so the spy applies without import-order tricks; one display case sets the default to `de-DE` instead): dialog named `Calculator`, `aria-modal="true"`, input `Calculation` focused; `0.1 + 0.2` Enter: live region text `Result: 0.3`, input value `0.3`, history button `0.1 + 0.2 = 0.3`; the Calculate button does the same; `1/3` gives `Result: 0.3333333333`; Enter on empty: no message, no history; `5 / 0`: divide-by-zero copy in the region, input `aria-invalid="true"` and `aria-describedby` the region, text kept, no history, typing clears `aria-invalid`; 11 results keep 10, newest first; clicking a row puts its value in the input and focuses it; history survives unmount and remount, and is empty after `vi.resetModules()` and a fresh import; no button named Cancel or Copy (only Close, Calculate and history rows); no request is made (fetch spy). `de-DE` display case: `0.1 + 0.2` Enter gives live region text `Result: 0,3`, history button `0.1 + 0.2 = 0,3`, and input value `0.3` (plain `value`, which the input accepts).

`src/components/calculator/__tests__/LazyCalculator.test.jsx` (new): Alt+C opens (`findByRole('dialog', { name: 'Calculator' })`) and is `defaultPrevented`; `e.key` `C` (Caps Lock) opens; Alt+Shift+C, Ctrl+Alt+C and Meta+Alt+C do nothing and are not prevented; `repeat: true` neither opens nor prevents; an already prevented event does nothing; focus in a text input or textarea: prevented, not opened; focus on a checkbox or radio: opens (the #87 editable definition); with an `aria-modal="true"` element present: prevented, not opened; with an `aria-modal="true"` element inside an `[inert]` wrapper: opens; Alt+C while open does not open a second dialog; `openCalculator(button)` opens; Escape closes and focus returns to the button focused before Alt+C; opened with `openCalculator(button)` while focus is on an element removed before close: focus lands on `button` (`finalFocusRef`).

`src/components/palette/__tests__/CommandPalette.test.jsx` (extend, after WP-B's version): typing `calc` lists `Calculator` under `Actions` with hint `Alt+C`; selecting it dispatches `calculator:open` with `detail.returnTo` equal to the element focused before the palette opened, and closes the palette; present in both workspaces (mocked `useWorkspace` `budget` and `journal`). One integration case rendering `LazyCommandPalette` and `LazyCalculator` together: Ctrl+K, `calc`, Enter gives the dialog with focus in `Calculation`; Escape returns focus to the pre-palette button.

e2e: `e2e/flows/calculator.spec.js` (new): in Budget and in Journal, open via the palette, `200 + 10%` Enter shows `220`; Alt+C opens from a non-field focus; Escape closes. `e2e/a11y/light.spec.js` and `dark.spec.js`: one case each running axe on the open dialog after one result and one error. No visual baseline changes (the dialog is in neither `e2e/visual/screens.spec.js` nor `e2e/visual/onboarding.spec.js`).

Hand check (`npm run desktop:dev`, part of Open question 1): Alt+C opens with no beep and no focus move to the native menu bar.

#### E.7 Bundle

WP-E's estimates are itemized in the section 5.1 table (about +1,850 B net: engine +1,030 (locale display and its exact split fallback included), wrapper offset -350, dialog +520, history +150, lazy overhead +60, host +150, Alt+C listener +80, mount +10, palette wiring +80, icon +120; lazy calculator chunk about 730 B, initial about +240 B). Not included (rulings): Copy result (would be about +130 B), insert into field (about +150 B). The cuts that touch WP-E are cut 4 (Alt+C and the main-chunk host, about -180 B) and cut 6 (WP-E to its own PR) of the unified list in section 5.1. By the estimates the change reaches the gate only at cut 6; the measured numbers decide, and nothing is solved by raising `bundle-budget.json`.

Owner target (QA cycle 3, M2): **calculator lazy chunk <= 1.5 KB gzip** (1,536 B). What is measured, from `gzipBytes` of `readAssets()` after `npm run build` at WP-E's end: (a) the target: the gzip bytes of the `CalculatorDialog` lazy chunk, the asset that holds `CalculatorDialog.jsx` (dialog, history and its lazy-chunk overhead; estimate about 730 B); (b) reported separately, not part of the target: `calc.js`'s contribution to the shared chunk, measured as the shared chunk's gzip delta between WP-E's base commit and WP-E's end (it lands in the shared chunk because `evalAmount` and the dialog both import it; estimate about +680 B, engine +1,030 minus the replaced `evalAmount` parser -350). WP-E's report states both numbers next to the total and initial deltas. Over the target is reported to the owner; it is not a cut by itself and does not reorder the unified cut list (section 5.1).

#### E.8 Decisions and notes (WP-E)

Closed by orchestrator ruling:

1. **One engine.** `calc.js` is the only parser; `evalAmount` is a thin wrapper that keeps today's results, including its comma handling (E.3). Accepted changes for amount fields: exact cents rounding, and percent and the x / × / ÷ / U+2212 glyphs (behaviour-change table).
2. **Copy result: not included.** The result is selectable text, as #87 did for Copy path.
3. **Insert into the focused amount field: deferred** to a follow-up (Open question 4).
4. **Shortcut Alt+C.** The WebView2 check joins Open question 1; fallback palette only.
5. **Cut order:** the unified list in section 5.1.
6. **Free, local, no AI:** no Pro gate, no network, no AI, server untouched.
7. **Locale-aware display adopted per owner answer 5** (orchestrator ruling, QA cycle 3 H1): the calculator's result, live region and history use the runtime locale through `formatDecimal` (E.2, E.3), exact on the decimal string. Input still takes `.` as the decimal mark and a comma only as a true thousands separator, so a decimal comma is rejected rather than misread. Amount fields (`evalAmount`) and `formatCurrency` stay fixed `en-US`. Tests pin `en-US`, plus `de-DE` display cases showing `0,3` (E.6).

Designer defaults kept (reversible, not escalated):

8. **Percent rule:** phone style (`200 + 10%` = 220). Plain style (`200 + 10%` = 200.1) is a one-branch change in `expr`; tests flip.
9. **Pre-existing, not fixed here:** Ctrl+K over any open `Modal` (calculator included) opens the palette above it, and the Modal's document-level Tab trap still runs under the palette because the palette is not in the Modal stack (`Modal.jsx:93-123`).

#### E.9 Files and docs

| File | Change |
| --- | --- |
| `src/utils/calc.js` | New (E.3) |
| `src/utils/evalAmount.js` | Body replaced by the wrapper (E.3) |
| `src/components/calculator/openCalculator.js` | New |
| `src/components/calculator/LazyCalculator.jsx` | New (deleted at cut 4) |
| `src/components/calculator/CalculatorDialog.jsx` | New |
| `src/components/shell/AppShell.jsx` | Mount `<LazyCalculator />` after `<LazyCommandPalette ... />` (line 44); removed at cut 4 |
| `src/components/palette/commands.js` | `buildToolCommands` (E.3), after WP-B |
| `src/components/palette/CommandPalette.jsx` | Tools pushed after quick actions (line 223); `opener` in memo deps (line 262); at cut 4 also the calculator host; after WP-B |
| `eslint.config.js` | `no-eval`, `no-implied-eval`, `no-new-func` for `src/**` minus tests |
| `src/utils/__tests__/calc.test.js` | New |
| `src/utils/__tests__/evalAmount.test.js` | Extended (existing cases unchanged) |
| `src/components/calculator/__tests__/CalculatorDialog.test.jsx`, `LazyCalculator.test.jsx` | New |
| `src/components/palette/__tests__/CommandPalette.test.jsx` | Extended, after WP-B |
| `e2e/flows/calculator.spec.js` | New |
| `e2e/a11y/light.spec.js`, `e2e/a11y/dark.spec.js` | One case each |

Merge order and overlaps: section 6.3 (after WP-A; serialized after WP-B on the three palette files; independent of WP-C and WP-F; before WP-D, so WP-D's final measured gate and docs include it). WP-E reports total and initial deltas like every WP, plus the `CalculatorDialog` lazy chunk gzip bytes against the 1.5 KB target and `calc.js`'s shared-chunk delta, reported separately (E.7; section 5.1 point 2). WP-D docs gain, unless cut 6 applied: `CLAUDE.md` one sentence under the `src/` bullet ("`src/utils/calc.js` is the one arithmetic engine: exact BigInt rationals, no `eval`; `evalAmount` wraps it and keeps its results, and the calculator dialog (palette or Alt+C) uses it"); `docs/DESIGN.md` needs no new component row (no shared component added).

## 7. Owner decisions (answered 2026-10-09)

1. **Work / Home / All.** Kept only as a filter on the Todos page (section 4.3): a quiet `SegmentedRadio` at the start of the board toolbar, legend "Show todos" (visually hidden), options All / Work / Home, stored in the existing `app_state` key `mode` (zero migration; the old global value is the starting value). The header control and the Settings > General control are removed; no other hook or page filters by tag; Home and drawer subtitles drop the filter wording; the tag field is removed from every create/edit form except the todo form, and existing tags are preserved on save. Javi: Home context `mode` is always `'all'`, Settings context `mode` is `null`, Todos context unchanged. Seeding: `mode = 'work'` still starts in Journal. The earlier options (A with the filter in Settings, A2, B combined menu, C two dropdowns) are closed.
2. **Home.** One shared Home filtered by workspace, plus a compact Budget summary card in the Budget workspace (section 1.2), numbers from code, inside the net <= 0 gate (cut 5 of the unified list in section 5.1 drops it if needed; it then becomes the first follow-up).
3. **Placement.** Budget: Budget (Dashboard, Planner, Subscriptions) and import. Journal: Journal, Notes, Habits, Health, Todos, Focus. Shared: Home, Calendar, Countdowns, Bookmarks, Weather, Folders, Settings, Browse your data, Javi, palette, bell (section 1).
4. **"All" view.** None.
5. **First-run question.** On the welcome step, Budget preselected, Journal skips the starter budget.
6. **Routes.** Flat, workspace as view state.
7. **Keyboard shortcut.** Alt+1 / Alt+2; Ctrl+Shift+1 / Ctrl+Shift+2 is the fallback if the desktop check fails (Open question 1).
8. **Switcher form.** The reused dropdown menu button.
9. **Switch target and memory.** Always the target's start page, no memory.
10. **Launch page.** Home.
11. **Default workspace for a fresh install.** Budget.
12. **Calculator (owner request; orchestrator rulings, final).** One shared calculator dialog from the palette or Alt+C (section 6.5); `calc.js` is the one engine and `evalAmount` keeps its results (accepted changes: exact cents rounding, percent and the x / ÷ glyphs); no Copy button; insert-into-field deferred; Free, no network, no AI, server untouched; the unified cut list of section 5.1.

## Critique and copy

### Design critique

Method: first impression, usability, hierarchy, consistency and accessibility, checked against PRODUCT.md principle 0 (mainstream users, it just works), DESIGN.md and the minimalism rules, and against the source (`ModeSwitcher.jsx`, `TopBar.jsx`, `Home.jsx`, `BurgerMenu.jsx`, `useSyncedSetting.js`).

What works and should stay: one header control in the place the old one held, reusing a menu button that already has the full WAI-ARIA keyboard model; flat routes with the workspace derived from the route, so every bell, search, shell and Settings link lands right with no redirect; the switch is a push, so Back keeps working; the shortcut guards are shared with Back; no schema or API change; the first-run question is one preselected radio on an existing step and Skip still finishes in one click.

Owner answers (2026-10-09): rows marked "superseded" were decided by the owner as noted.

| Finding | Severity | Recommendation | Status |
| --- | --- | --- | --- |
| The Budget workspace's Home has no money content (no Budget widget exists) and the app launches on Home, so the default workspace's first screen shows weather, todos and calendar under the name "Budget" | high | Ship the Budget summary widget with this change, or launch on the saved workspace's start page | superseded by owner answer 2: the Budget summary card ships in this change (section 1.2); launch stays on Home |
| Dropping the Work/Home header control leaves a working record filter whose only always-visible control is gone; for an existing Work or Home user, entries, widget contents and pattern inputs look like they vanished | high | Retire the filter, or name it wherever it applies | superseded by owner answer 1: the filter applies only on the Todos page, where its control is always visible (section 4.3) |
| The trigger hides the workspace name below `sm`, leaving a piggy bank or notebook icon as the only cue on a narrow window | medium | Show the name at every width; let the greeting and date truncate (they already do) | applied in section 2 (Form) and 6.1 |
| The desktop `localStorage` cache is empty at every launch, so a Journal user would see the Budget Home and drawer for a moment, then a flip | medium | `useWorkspace` returns `ready`; the trigger and the Home grid and Patterns card wait (skeletons) on Shared pages until the saved value loads | applied in section 2 (Persistence) and 6.1, tests in 6.2 |
| Home is the only page whose content changes with the workspace, yet nothing on it says which workspace it shows | medium | Subtitle names the workspace | applied in sections 1.1 and 6.1 (the tag-filter suffix is dropped per owner answer 1) |
| Back after a switch looks inconsistent: from `/budget` it flips the workspace back, from a Shared page it does not | medium | Keep the behaviour and state it as one rule: Back moves between pages, never between workspaces. Test both cases | applied in section 2 (What switching does) and WP-D test |
| Alt+1 / Alt+2 is only in a hover `title`, which keyboard and touch users never see | medium | Show the shortcut as a quiet `kbd` hint on each menu item, styled like the Search hint | applied in section 2 (Form) and 6.1 (first cut if over budget) |
| Alt+digit inside a Win32 window with a native menu can beep or move focus to the menu bar when Alt is released | medium | Hand check in the desktop app; fall back to Ctrl+Shift+1/2 if it misbehaves | Open question 1 |
| The drawer drops the other workspace's group entirely | medium | One quiet "Switch to Journal" row at the end of the drawer, or keep as is | owner answer (default): keep as specified; the switcher and palette reach the other workspace |
| The route sync saves the workspace of any owned page visited, so a bell or search jump is an implicit switch | medium | Keep, or save only on explicit choices | owner answer (default): keep |
| `aria-keyshortcuts="Alt+1 Alt+2"` on the trigger says the keys focus or open the trigger, which they do not | low | Keep the attribute on the items only | applied in section 2 (Form) and 6.1 |
| A Shared page such as Calendar shows "Budget" in the header, which could read as a page title | low | Keep: the control has a chevron and the name "Workspace: Budget", the page has its own heading | kept as specified (example updated: Todos is now a Journal page) |
| Picking the current workspace on a Shared page does nothing, though a user may expect to go to its start page | low | Keep the radio-menu behaviour; the drawer and Back reach the start page | kept as specified |
| After Alt+1 / Alt+2 focus stays where it was and nothing is announced except the new page; the trigger's name updates | low | No live region (no new component); test that the trigger name updates after a shortcut switch | test added in section 6.2 (WP-A) |
| The word "workspace" collides with the drawer fallback "Your workspace" | low | Reword in copy review | resolved in UX copy (drawer subtitle) |
| (Owner answers review) A tag shown on habits and events that the user can no longer change reads as a bug | low | Remove the read-only tag displays with the fields | applied in section 4.3 |
| (Owner answers review) The Todos filter's options could read as page names ("Home") | low | Visually hidden legend "Show todos" gives the group its name; the radios sit on the Todos board, so "Home" reads as home todos | kept; see Localization notes |

### UX copy

Method: the ux-copy pass (clear, concise, consistent, useful, human), DESIGN.md "Copy" (no em or en dashes, plain words, sentence case, second person, Burrow is "a desktop app with a built-in helper"), PRODUCT.md (store copy rule; no claim the source is public or open source) and the minimalism tone (rule 5: no copy that only explains an already labelled button). Current strings were read from `ModeSwitcher.jsx`, `BurgerMenu.jsx:239-246`, `Home.jsx:112-116`, `GeneralSection.jsx`, `OnboardingFlow.jsx`, `commands.js`, `KanbanBoard.jsx`, `BudgetPlanner.jsx`, `FocusWidget.jsx` and `docs/MICROSOFT_STORE.md` section 5.

**The noun: "workspace", kept almost out of sight.** What people see is the names, Budget and Journal; the noun appears only where a label needs a category word: the trigger's accessible name and tooltip, the menu name, the Home subtitle and the drawer subtitle. Why "workspace" and not something plainer:

- The alternatives collide with words Burrow already uses for something else: "view" (Budget's Dashboard and Planner are its views, `BudgetPage.jsx`), "section" (Settings sections), "mode" (the old Work and Home filter), "space" or "area" (vague, and "area" reads as a page region).
- "Workspace" is familiar from mainstream apps and short enough for a screen reader prefix ("Workspace: Budget, menu button").
- It is needed because the workspace names are also page names: "Budget" is both a workspace and the Budget page inside it, "Journal" both a workspace and the Journal page. On Home and in the drawer the bare word "Budget" would read as a page title, so those two places say "Budget workspace".
- The old uses go: "Workspace mode" disappears with the Settings control, and the drawer fallback "Your workspace" is replaced, so "workspace" now means one thing only.
- Visible first-run and help copy names the two choices instead of the noun ("switch between Budget and Journal").

#### String table

`<W>` is the workspace label, `Budget` or `Journal` (from `WORKSPACES[].label`). `<Other>` is the other one. Amounts are `formatCurrency` output. Nothing below is new copy for Javi or the server.

| Key / location | String | Notes |
| --- | --- | --- |
| `WorkspaceSwitcher` trigger, visible label | `<W>` | Visible at every width (critique). Was `MODE_LABEL[mode]` (All, Work, Home), hidden below `sm` |
| `WorkspaceSwitcher` trigger `aria-label` (ready) | `Workspace: <W>` | Contains the visible text (WCAG 2.5.3). Was `Workspace mode: <X>` |
| `WorkspaceSwitcher` trigger `aria-label` (not ready) | `Workspace` | With `aria-busy="true"` and the label span `invisible`. No loading text; never names a workspace before the saved value is known |
| `WorkspaceSwitcher` trigger `title` | `Switch workspace (Alt+1, Alt+2)` | Same pattern as `Back (Alt+Left)`. After cut 2: `Switch workspace`; if the Ctrl+Shift fallback applies: `Switch workspace (Ctrl+Shift+1, Ctrl+Shift+2)` |
| Menu `aria-label` | `Workspace` | Was `Workspace mode` |
| Menu item 1 label / hint | `Budget` / `Alt+1` | Hint is `<kbd aria-hidden="true">`; the item carries `aria-keyshortcuts="Alt+1"` |
| Menu item 2 label / hint | `Journal` / `Alt+2` | Same |
| Home subtitle, not editing | `<W> workspace. Everything important at a glance.` | Names the workspace (critique) and keeps today's line. Was `Everything important at a glance.` or `Showing your <mode> dashboard.` |
| Home subtitle, editing | `Drag to reorder, or use a card’s buttons to resize or hide it.` | Unchanged |
| Home subtitle, not ready | `Everything important at a glance.` | No workspace name until it is known (same rule as the trigger) |
| Drawer subtitle under "Burrow" | `<name> · <W> workspace` (middle dot) when a display name is set, else `<W> workspace`; `Burrow` while the saved workspace has not loaded | Replaces the fallback `Your workspace` and `<Mode> mode`. Tells the user why the drawer lists only one group |
| Palette command label | `Switch to <Other>` | Only the other workspace is listed; group `Navigate`. Replaces `Mode: All`, `Mode: Work`, `Mode: Home` |
| Palette command keywords | `workspace focus switch budget journal` | As specified in 6.1 |
| Palette Settings keywords (`SECTION_KEYWORDS.general`) | `profile name javi button` | Was `profile name workspace mode javi button` |
| Settings > General card subtitle | `Profile and Javi.` | Was `Profile, workspace and Javi.` |
| Settings > General Work/Home control | removed | Legend `Workspace mode`, its options and hint go |
| Todos filter legend (visually hidden) | `Show todos` | The group's accessible name. Visually hidden so the toolbar stays one quiet row |
| Todos filter options | `All`, `Work`, `Home` | Values `all`, `work`, `home`; same words as the todo form's Context choices (`work`, `home`), which stay |
| Todos filter hint | none | Rule 5: the labels say it |
| Budget card title | `Budget` | `WidgetCard` title (shown uppercase by its style) |
| Budget card big figure label | `spent this month` | Under the Spent amount |
| Budget card row | `Budgeted <amount>` and `Remaining <amount>` | Same words as the Planner columns (`BudgetPlanner.jsx:184-186`); Remaining can be negative (`-$12.00`, red) |
| Budget card, spend but no budget | `No budget set for this month.` | Replaces the row |
| Budget card empty state | `No budget or spending this month yet.` then `Import transactions or set a budget →` | Second line quiet (`text-accent-indigo`), as FocusWidget's `Start focusing →`; the card itself is the link |
| Budget card error | `Couldn't load your transactions. Open Budget to try again.` | Same pattern as FocusWidget's error line |
| Onboarding welcome, `SegmentedRadio` legend | `Where do you want to start?` | |
| Onboarding options | `Budget` (selected), `Journal` | From `WORKSPACES` |
| Onboarding hint | `Budget is for money. Journal is for writing, habits, health, todos and focus. You can switch any time at the top of the window.` | Covers todos and focus (owner answer 3). Step title `Welcome to Burrow`, `Skip for now` and `Continue` unchanged |
| Patterns card ("Patterns across your data") | Unchanged | Pairs are filtered by workspace; "Tested across 6 pairs" stays true (section 0) |
| Screen reader feedback after Alt+1 / Alt+2 | None (no live region) | The trigger name becomes `Workspace: <W>` and the new page's heading is reached as on any navigation |
| Removed form labels | `Context` (habit, journal entry, event, note, bookmark, countdown forms), `Tag sessions as` (Focus) | The todo form keeps `Context` |
| Empty states | None new besides the Budget card | A workspace with no pattern findings hides the Patterns card (no copy). Existing module empty states are unchanged |
| Calculator strings | Section 6.5, E.5 | Dialog, errors, history, palette label and hint |
| The word "chat" | Not used anywhere in this design | #87 copy rule: no "chat" in the UI; checked across this table and E.5 |

Localization notes: `<W> workspace` puts the name first; translators may need to reorder (`Espace <W>`). Keep `Alt+1` as a literal key name. The Todos filter's `Home` means home todos, not the Home page; translators should use the same word as the todo form's `home` choice, not the page name.

#### Store, Gumroad, README and release copy (owner)

None of these changes describe Javi as access to an AI, and none mention source availability.

| Where | Old | New |
| --- | --- | --- |
| Store full description, bullet 1 (`docs/MICROSOFT_STORE.md:281`) | `Budget and transactions, todos, calendar, habits, journal, notes, bookmarks, countdowns and focus sessions in one place.` | `Two workspaces, Budget and Journal, one click apart. Budget holds your transactions and subscriptions; Journal holds your journal, notes, habits, health, todos and focus sessions. Calendar, countdowns and bookmarks are in both.` |
| Store features, line 1 (`docs/MICROSOFT_STORE.md:296`) | `Budget and transactions, todos, calendar, habits, journal, notes, bookmarks, countdowns and focus in one app` | `Budget and Journal workspaces with todos, habits, notes, focus, calendar, countdowns and bookmarks, in one app` |
| Store short description (`docs/MICROSOFT_STORE.md:271`) | `A private budget and journal tracker that runs on your own computer. Zero subscriptions. Private by default.` | No change (already names budget and journal) |
| Store "What's new" (next version, new subsection after `### What's new (1.1.0)`) | none | `New: Budget and Journal workspaces. Pick one at the top of the window, or press Alt+1 or Alt+2, and Burrow shows the pages and Home cards that go with it. Home in Budget now shows what you spent this month. Every page is still in search. The Work and Home filter is now on the Todos page, and your tags are kept.` (drop "or press Alt+1 or Alt+2," after cut 2; drop the Home sentence after cut 5; the calculator line is in section 6.5, E.5) |
| Store certification notes (`docs/MICROSOFT_STORE.md:219-227`) | none | Optional new paragraph: `Burrow has two workspaces, Budget and Journal. The menu at the top left of the window switches between them; pages such as Habits, Health, Notes and Todos are in the Journal workspace. Every page can also be found with search (Ctrl+K).` |
| Store search terms | | No change |
| Claude-in-Chrome listing prompts (`docs/store/chrome-prompts.md:121, 134`) | the same two lines as the Store bullet and feature | Regenerate from the Store listing after the two edits above (the listing wins) |
| Gumroad product pages (copy not in the repo) | the module list line on each of the three pages, if present | Same sentence as the Store bullet 1. The What's new line that `release:gumroad` writes comes from the release notes below |
| Release notes (`release-notes/<next tag>.md`, under `## What's new`) | none | Same text as the Store "What's new" entry |
| README modules list (`README.md:5-21`, the `## Modules` list starts at line 5) | none | New first bullet: `Workspaces: Budget (budget, subscriptions and a this-month card on Home) and Journal (journal, notes, habits, health, todos, focus). Calendar, countdowns, bookmarks, weather and folders are in both. Switch with the menu at the top of the window, Alt+1 / Alt+2, or the "Switch to" command in search.` (drop "and a this-month card on Home" after cut 5) |
| Store and Gumroad screenshots | current shots show the All/Work/Home control | Retake after WP-D: (1) Home in the Budget workspace with the header showing `Budget` and the Budget card; (2) the Budget page; (3) the Journal page with the header showing `Journal`; (4) optional, the open workspace menu with the `Alt+1` / `Alt+2` hints. Use demo data only (`npm run seed:demo`) |

Left for the owner: the shortcut text depends on Open question 1 and cut 2; if a cut of section 5.1 applies, the `kbd` hint rows (cut 1), every Alt+1 / Alt+2 mention (cut 2), the onboarding rows (cut 3), every Alt+C mention (cut 4), the Budget card rows and sentences (cut 5) or every calculator string (cut 6, moved to the follow-up PR) drop; README line 3 and the Modules entry still call Javi "the AI assistant", which is fine for the private repo but must not be copied into store or site text.

### QA review

Cycle 1 (qa-lead): **NO-GO**. Findings H1, H2, H3, M1, M2, M3, L1 to L8, plus informational I1 and I2. Orchestrator rulings for H2 and H3 were applied as written. Resolution:

Owner answers (2026-10-09): H2 and H3 are superseded as noted; H1 now also covers the Budget card and its cut.

| ID | Finding | Resolution |
| --- | --- | --- |
| H1 | Zero net JS was an estimate only; `bundleBudget.js` checks only the 470 / 146 / 125 ceilings | Measured gate added: baseline on the merge base after PR #87, per-WP deltas, net <= 0 B at the end of WP-D, ordered cut list, then owner escalation, never a budget raise (section 5.1; also sections 5, 6, 6.2 WP-D, 6.4). Estimate table itemized so each cut has a number. Since superseded by the unified 7-step cut list with the calculator (orchestrator ruling) and the known baseline 468.96 KB on 9ba27a5 |
| H2 | Decisions 2 and 10 had no recommended default for the empty-of-money Budget Home | Superseded by owner answers 2 and 10: one shared Home, launch on Home, and the Budget summary card ships in this change (section 1.2). The launch-on-start-page alternative is closed and its spec removed |
| H3 | Decision 1 default vs critique preference was unresolved; A2 was not implementable | Superseded by owner answer 1: the filter lives only on the Todos page (section 4.3); the A2 delta is replaced by that spec |
| M1 | Pairs were filtered after the `MAX_SHOWN = 4` cap | Filter moved into `computeCrossInsights({ workspace })` before the cap; `useCrossInsights(workspace)`; test with more than 4 qualifying pairs; no Free/Pro difference confirmed (sections 3, 6.1, 6.2 WP-B) |
| M2 | Wrong reason for `workspace` in `AUTO_STATE_KEYS` | Reason corrected (route sync writes it on the first owned-page visit; reconcile re-checks pristine at `directImport.js:881`); doc comment principle reworded; tests for a `workspace` row written after staging and for `"other"`; I2 noted (sections 0, 2 Persistence, 6.1, 6.2 WP-C) |
| M3 | Shared `pos:homeLayout` across workspaces | `reorder` keeps the slots of cards not shown (contract and test); Reset resets the one shared layout, accepted (sections 1.1, 6.1, 6.2 WP-B, 6.4) |
| L1 | Held Alt+digit repeats | `e.repeat` in the guard, tests (sections 2 Keyboard shortcut, 6.1, 6.2 WP-A) |
| L2 | Placement on `/` | Reworded: minimalism keeps an `aria-hidden` 36x36 placeholder, so the switcher stays put (section 2 Placement) |
| L3 | Wrong citation for the cache | `lsKey()` in `src/utils/storageKeys.js`; `readLocal` / `writeLocal` in `syncMode.js:12-35` (section 0 Persistence facts) |
| L4 | Two README ranges | One range, `README.md:5-21`, module list starts at line 5 (sections 5.2 and UX copy) |
| L5 | Folders is also off by default for cloud | Stated, with why it is still Shared (section 1) |
| L6 | What's new wording | Superseded by owner answer 1: "The Work and Home filter is now on the Todos page, and your tags are kept." (UX copy, Store table) |
| L7 | Test base and wrappers | Neutral base `/burrow`; tests wrap `useWorkspace` in `ModeProvider`; visual specs wait for the trigger to not be `aria-busy` (section 6.2 WP-A and WP-D) |
| L8 | Supersedes minimalism Owner decision 5 | Sentence at the top of this doc, updated for owner answer 1 |
| I1 | Cache vs DB | One-liner added: the DB is the source of truth; the cache never decides the workspace on Shared pages because `ready` waits for the fetch (section 2 Persistence) |
| I2 | `backupsShowUserData` one row looser | Noted and accepted: target backups move aside, never deleted (section 2 Persistence) |

Cycle 2: GO (QA APPROVED). New LOW N1 (gate rounding wording) and N2 (owner of the Patterns card ready gate) were fixed by the orchestrator in sections 5.1 and 6.1; INFO N3 (the kbd hints are the first cut and may go) and N4 (Alt+1/Alt+2 may do nothing for a few hundred ms at launch on a Shared page) need no change.

Owner answers (2026-10-09) were applied after cycle 2; the new parts (Todos-only filter, tag field and display removal, Budget card, placement of Todos and Focus) have not had a QA cycle yet.

Refresh after the rebase onto 9ba27a5 (PR #87 merged), notes for QA:

- Renaming: the former WP-E (Todos-only filter, hooks, tag fields, Settings) is now **WP-F**; **WP-E** is the shared calculator (section 6.5). References in sections 5, 6.1, 6.2, 6.3 and 6.4 follow the new names.
- Calculator (WP-E) and the orchestrator rulings on it are new since cycle 2 and have not had a QA cycle.
- Line numbers re-verified against 9ba27a5 in every file this design touches; the "pre-#87" caveat is removed. Fixes from that pass: `TopBar.jsx` (switcher at 72, greeting block 74-79, Search hint 96), `NotificationBell.jsx` keydown 25-31, `TodoForm.jsx` context refs, `e2e/flows/back.spec.js` (new in #87, needs a WP-A edit), the shortcut guard definitions (now #87's exact ones), the visual baseline inventory (no habits or focus baselines; onboarding spec is under `e2e/visual/`), and the `.slice()` rule for `useCalendar`.
- Verified, no change needed: every hook merges updates as `{ ...row, ...patch }`; `useCountdowns` keeps `.slice().sort()` after the filter goes; `CategoryEditor` and `IncomePayees` props and their immutable updates under `useBudgetPlan`; demo data carries only `both` tags (`scripts/seedDemo.js`); #87's clock, per-section Resets and Javi Import chip are all kept in the merged code.

Cycle 3 (QA of the owner-answer parts and the calculator). Resolutions, with the orchestrator's final ruling on H1:

| ID | Finding | Resolution |
| --- | --- | --- |
| H1 | The calculator display was fixed `en-US` (designer default 8); ruled to follow the runtime locale | Orchestrator ruling, final, adopted per owner answer 5: result, live region and history use `new Intl.NumberFormat(undefined, { maximumFractionDigits: 10 })` on the exact decimal string through the new `formatDecimal` in `calc.js` (string `format` where supported, probed once at load; otherwise a dependency-free split path that formats the integer part as a `BigInt` and appends the locale's decimal separator and localized fraction digits, never a lossy `Number`). Input unchanged (`.` decimal mark, comma only as a true thousands separator); the field is refilled with the plain `value`. `evaluate` gains an optional `locale` used only by tests. Tests pin `en-US`, plus `de-DE` display cases (`0,3`) and split-path equality. `evalAmount` and `formatCurrency` unchanged (`en-US`). Engine estimate +940 to +1,030 B, so the net and the running cut figures move by +90 B (sections 5.1, 6.4; E.0, E.2, E.3, E.4, E.5, E.6, E.7, E.8: item 8 removed from the designer defaults and recorded as closed item 7) |
| M1 | `moduleVisibleInMode` was deleted in WP-A while WP-B's files still import it | Deletion and its overlap-table row moved to WP-B, which rewrites the last consumers (`Home.jsx`, `commands.js`, `CommandPalette.jsx`); WP-A removes only the BurgerMenu and ModeGate call sites and leaves `ModeContext.jsx` untouched. New "Symbol sequencing" table in section 6.3 checks every symbol deleted across the 6.1 and 6.2 file sets (`moduleVisibleInMode`, nav `modes`, widget and quick-action `modes`, `ModeGate`, `ModeSwitcher`, `MODES`, `matchesMode`, `useMode`, the GeneralSection props, `ACCENT` / `accentClass`, `CONTEXTS`): each is deleted in the WP that removes its last consumer, and the interim state after WP-A is green (the `itemModes` default keeps every nav page listed; quick actions keep `modes` until WP-B; spread `vi.mock` factories keep working). WP-A and WP-B test lists name the test lines that change (sections 4.3, 6.1, 6.2, 6.3) |
| M2 | Owner's calculator size target missing | "Calculator lazy chunk <= 1.5 KB gzip" added to E.7, section 5.1 point 2 and the WP-E and WP-D reports: the target is the `CalculatorDialog` lazy chunk gzip bytes; `calc.js` is reported separately as the shared-chunk gzip delta across WP-E. Over the target is reported, not a cut by itself |
| L1 | "The initial delta should not grow" | Section 5.1 point 3: the initial delta is reported in every WP and any growth is explained; by the estimates it grows about +190 B from the calculator host, Alt+C listener and mount, which cut 4 removes |
| L2 | Wrong reason in the behaviour-change row for `'9'.repeat(400) + '/' + '9'.repeat(400)` | Today the literal itself parses to Infinity and `parseFactor` returns null (`evalAmount.js:53-54`); row and the section 5.1 note reworded |
| L3 | Stale comment in `CalendarPage.jsx:183-185` ("mode change", "mode-filtered list") | Added to WP-F's file list as a comment-only refresh, with the new wording |
| I1 | The raw-source test also scans comments | E.6 note: `calc.js` and `evalAmount.js` comments must not contain `eval(`, `Function(` or `import(` |
| I2 | New non-Todos records change their default tag | Section 4.3 note: they now default to `both` (notes, bookmarks, countdowns and focus used to preselect `work`, journal entries the current mode); no visible effect |

Also corrected in passing: the E.5 note for `out_of_range` now states the real bound (at or above 1e15 in absolute value).

## Implementation outcome

Shipped on `feat/workspaces`, measured against main 9ba27a5 with `npm run build; node scripts/checks/bundleBudget.js`.

### Bundle gate (section 5.1)

| Step | Total JS (gzip) | Initial JS (gzip) | Result |
| --- | --- | --- | --- |
| Baseline, main 9ba27a5 | 480218 B (468.96 KiB) | 147886 B | Ceilings 470 / 146 / 125 KiB |
| Full design (all of WP-A to WP-F, estimate in 5.1: about +1,500 B) | over the gate | | Cut list applied in order |
| Cuts 1 to 6 applied, then add-back (rule in 5.1 point 5): cuts 1, 2 and 3 re-added one at a time, each re-measured and kept | | | Cuts 4, 5 and 6 stay |
| Final, shipped | **479803 B (468.56 KiB)** | **148085 B** | Total **-415 B**, initial **+199 B**, `bundleBudget` all ok |

The gate (total delta <= 0) holds. The per-step byte counts of the intermediate cuts are in the commit history, not repeated here (one commit per cut and per add-back: `perf(shell)`, `perf(onboarding)`, `perf(home)`, `perf(calc)` and their `feat(...)` undo commits). Initial grew by 199 B (reported, not gated): the switcher, `useWorkspace`, the workspace data in `navItems.js` and the Alt+1 / Alt+2 listener are in the initial chunk, and the offsets there (icon imports, `ModeGate`, the mode subtitles) are smaller.

### What shipped

- Workspace switcher in the header (Budget, Journal), visible at every width, with Alt+1 / Alt+2 and the `Alt+1` / `Alt+2` hints in the menu. The route owns the workspace on `/budget*` and the Journal pages; Shared pages keep the saved `app_state` `workspace`. A switch is a push, so Back walks it.
- Onboarding: the "Where do you want to start?" radio (Budget default). On the Journal path the Javi step button reads "Finish" and there is no starter budget step.
- Todos page: the Work / Home / All filter is a quiet, legend-hidden `SegmentedRadio` (`tone="quiet"`), with a filtered-empty line ("No <Work|Home> todos. Show All to see every todo."). It is the only place with a tag filter; the tag stays on stored rows but no other form has a Context field, and an edit never clears it.
- Home follows the workspace (widget set, Patterns card pairs, subtitle `<W> workspace. Everything important at a glance.`).
- Drawer: groups follow the workspace; the money group heading is now "Budget" (was "Money"; the group id stays `money`); the subtitle is `<name> · <W> workspace` or `<W> workspace`.
- Palette: one "Switch to <Other>" command; the `Mode:` commands are gone. Settings > General no longer has the Workspace mode control.

### Not shipped in this PR

| Item | Branch | Why |
| --- | --- | --- |
| Budget summary card on Home (section 1.2; `BudgetWidget`) | `feat/home-budget-card` | Adding it back was +502 B over the gate (bundle cut 5; the add-back rule in 5.1 point 5 could not keep it) |
| Shared calculator (section 6.5, WP-E) | `feat/calculator` | Cut 6: WP-E's net bytes could not fit the gate; it is its own PR with its own offsets. `useBudgetPlan` stays here because it removes a copy |

README, DESIGN.md and CLAUDE.md claim neither of the two. Owner copy for the store, Gumroad and release notes drops the card and calculator sentences.

### Review findings fixed

- `switchTo` works before the saved value has loaded (a pick of the fallback workspace still saves); the trigger is `aria-disabled` while not ready, and Home tells Javi it has no widgets until ready.
- The drawer waits for `ready` and always names the workspace; the group heading "Money" became "Budget".
- Alt+1 / Alt+2 close an open menu; palette "Switch to" rows show the shortcut.
- Home layout toggles compute from the latest saved layout; Todos filter reorders use the full list (not the filtered one).
- The Journal path's Javi step button reads "Finish".
- Tests: the server keeps a todo's tag when edited without a context; the bookmarks copy dropped its tag wording; the Pro gating tests mock `useWorkspace`.

e2e: `e2e/flows/workspaces.spec.js` (switcher by click and Alt keys, route-owned workspace, Shared pages, Back after a switch, persistence across reload, palette, drawer groups, Todos filter), `e2e/flows/onboardingJournal.spec.js` (Journal path), and `settleAndShoot` waits for the switcher before a screenshot. Baselines under `e2e/__screenshots__/**` are regenerated separately on Linux (`npm run test:visual:update`).

## Open questions

1. WebView2 (desktop check, owner decision 7 and the Alt+C ruling): confirm Alt+1, Alt+2 and Alt+C reach the page and trigger nothing in the shell (`npm run desktop:dev`). Check that Windows plays no "invalid menu key" beep (an Alt+key with no matching menu mnemonic beeps in a plain Win32 window, and the shell has a native File / Edit / Help menu) and that releasing Alt after Alt+1 or Alt+C does not move keyboard focus to the native menu bar. If Alt+1 / Alt+2 misbehave, switch to Ctrl+Shift+1 / Ctrl+Shift+2 (section 2, Keyboard shortcut). If Alt+C misbehaves, the calculator opens from the palette only (the change of cut 4, section 5.1); no second combo.
2. Store and Gumroad screenshots are not in the repo; the owner retakes them after WP-D.
3. Follow-up, not in this change: Javi's `add_note`, `add_journal_entry` and `add_countdown` tools still accept a `context` tag (`server/agents/jarvisTools.js:81-101`) that now has no visible effect. Drop the argument from those three (keep it on `add_todo`) in a Javi change with its own eval run (`npm run eval:javi`), since tool schemas change prompt size.
4. Follow-up, not in this change (orchestrator ruling): "Use result" to insert the calculator result into the focused amount field. Sketch for that PR: target = the return element when it is an enabled, writable `input` with `type="number"` or `inputMode="decimal"`; quiet `Use result` button; set the value through the native setter `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value)` then `el.dispatchEvent(new Event('input', { bubbles: true }))`; close; about +150 B. It also needs the shortcut to open from such a field, which changes the E.1 guard, and a decision on the blur commit of the half-typed draft.

Closed by the owner answers of 2026-10-09: the Budget Home follow-up (the card ships, section 1.2); the Javi `home` thread on a switch (kept, not reset); the drawer subtitle wording (UX copy); patterns reading filtered records (hooks no longer filter); Reset general changing the derived workspace (Reset no longer writes `mode`); the drawer "Switch to" row (not added); the route sync saving on any owned page (kept).

Closed by the orchestrator rulings on the calculator: one engine versus two parsers (one engine, `evalAmount` keeps its results); Copy result (not included); the shortcut (Alt+C, palette-only fallback); the cut order (unified list, section 5.1); Free, no network, no AI.
