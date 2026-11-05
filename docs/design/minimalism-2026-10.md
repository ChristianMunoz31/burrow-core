# Minimalism pass and back button (2026-10)

> Note 2026-11-05: the trial pill, License section and Pro gating described below were removed by [ADR 0002](../adr/0002-free-for-everyone.md) (Burrow is free for everyone). Kept as design history.

Branch `feat/back-button-minimal` (from `origin/main`, v1.1.0). Design only; coders implement it exactly.

Pattern source: commit 224017f "feat(folders): minimalist pass". The design tool had no shell, so the commit diff itself was not read; the pattern is taken from the code that commit left behind: `src/components/folders/FolderMoreMenu.jsx` (one "⋯" text-glyph trigger, `.glass-menu`, `role="menu"`, Arrow/Home/End/Tab/Escape keyboard model, focus back to the trigger on every choice), `src/components/folders/folderStyles.js` (`ICON_BTN`, quiet `TOGGLE`, `MENU_ITEM`) and `FolderCard.jsx` (one visible primary action, Re-scan; everything else in the More menu or behind quiet toggles; no boxes around toggles).

Rules applied to every surface below:

1. One primary action per view. Secondary actions are quiet (no fill, no border) or live in a "⋯" menu.
2. One way to do a thing per screen. A control that duplicates another control on the same screen goes.
3. A modal form has no Cancel button: the dialog's own Close (X) button, Escape and the backdrop already cancel. Confirmations of destructive or consent actions keep their explicit Cancel (`ConfirmDialog`, Erase, Restore, cloud consent, inline confirm groups). One form keeps its Cancel: the Calendar `EventForm`, whose Cancel steps back to the event details or the day list (it is dialog-internal navigation; Escape and X still close everything, as before).
4. Fewer borders, badges and pills: drop `border border-slate-slate600/700` add-ons on `btnSecondary`, drop pills that repeat nearby text.
5. Copy that only explains a button that is already labelled goes.
6. No new shared component unless it replaces a copy. `FolderMoreMenu` is NOT generalized: no second surface needs a menu after this audit (see "More menu decision"), so generalizing would only add bytes.

## 1. Back button

### Where the shell is

`src/App.jsx` uses `BrowserRouter` (react-router-dom 7.18). `AppShell` (`src/components/shell/AppShell.jsx`) renders the fixed burger (`BurgerMenu`, `fixed top-3 left-4`), then `<main>` with `TopBar` (`src/components/shell/TopBar.jsx`, sticky, `pl-16` to clear the burger). TopBar's left cluster is `ModeSwitcher`, the greeting `<h1>` and date, `DevBuildBadge`, `TrialBadge`. Page titles are `<h2>`s inside each page.

### Placement

A new `BackButton` is the first child of TopBar's left cluster, before `<ModeSwitcher />` (TopBar.jsx line 69). Visually: burger, Back, mode switcher, greeting. Same height as the mode switcher (`h-9`). It is quiet (no `glass-subtle` box), so the bar does not gain a fourth boxed control.

### Contract: `src/components/shell/BackButton.jsx` (new)

```jsx
import { useCallback, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { parentPath } from './routeKey';

const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
const modalOpen = () => document.querySelector('[aria-modal="true"]') !== null;

export default function BackButton() {
  const { pathname } = useLocation();
  const navigate = useNavigate();

  const goBack = useCallback(() => {
    // React Router's BrowserRouter writes { usr, key, idx } into history.state; idx 0 is the first
    // entry of this document load. Anything before it is the splash page or the single-use
    // /desktop/bootstrap URL, so never go below idx 0.
    if (window.history.state?.idx > 0) navigate(-1);
    else if (pathname !== '/') navigate(parentPath(pathname), { replace: true });
  }, [navigate, pathname]);

  useEffect(() => {
    const onKey = (e) => {
      const altLeft = e.key === 'ArrowLeft' && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
      if ((!altLeft && e.key !== 'BrowserBack') || e.defaultPrevented) return;
      e.preventDefault(); // always: stops WebView2's own history back
      if (modalOpen() || e.target?.closest?.(EDITABLE)) return;
      goBack();
    };
    // Mouse button 4 (XButton1). Chromium reports it as mouseup; some builds fire auxclick instead,
    // so both are handled, and the preventDefault on either stops the webview's own navigation.
    const onMouse = (e) => {
      if (e.button !== 3) return;
      e.preventDefault();
      if (e.type === 'mouseup' && !modalOpen()) goBack();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mouseup', onMouse);
    window.addEventListener('auxclick', onMouse);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mouseup', onMouse);
      window.removeEventListener('auxclick', onMouse);
    };
  }, [goBack]);

  // On "/" an inert placeholder is rendered instead of the button (see "Home placeholder and guards").
  return (
    <button
      type="button"
      onClick={goBack}
      aria-label="Back"
      title="Back (Alt+Left)"
      aria-keyshortcuts="Alt+ArrowLeft"
      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-slate-slate300 transition-colors hover:bg-slate-slate700/50 hover:text-slate-slate100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-slateBlueLight"
    >
      <ChevronLeft size={18} aria-hidden="true" />
    </button>
  );
}
```

The listeners live in the component, and TopBar mounts it on every route, so the shortcuts work on Home too (where the button itself is replaced by a placeholder).

#### Home placeholder and guards

- The button is shown on all routes except `/`. On `/` the component renders an inert placeholder with `aria-hidden="true"` and the same 36x36 footprint, so the header does not shift between Home and other pages (the earlier `return null` is replaced).
- The button has `title="Back (Alt+Left)"` besides its `aria-label`.
- Key auto-repeat is ignored: a held Alt+Left (`e.repeat`) does nothing, so it cannot walk through the whole history.
- A latch blocks double navigation: after one Back (click, key or mouse) further Back requests are ignored until the route changes.

### Contract: `src/components/shell/routeKey.js` (add one export)

```js
// The page Back falls back to when there is no in-app history: /settings for its sub-pages, else Home.
export function parentPath(pathname) {
  return /^\/settings\/./.test(pathname) ? '/settings' : '/';
}
```

Why not "strip the last segment": `/budget/planner` -> `/budget` redirects back to `/budget/planner` when the Budget default view is Planner (`BudgetPage.jsx` lines 128 to 136, a `REPLACE` navigation is not skipped), so Back would do nothing. Budget's three tabs are peers, not parent and child.

### Show and hide rules (by route, from `App.jsx`)

| Location | Back shown | Click with history (`history.state.idx > 0`) | Click without history (fallback, `replace`) |
| --- | --- | --- | --- |
| `/` (Home), any unknown path (redirects to `/`) | No (inert, aria-hidden placeholder keeps the header from shifting) | (Alt+Left / mouse 4 still go back) | nothing |
| `/budget`, `/budget/planner`, `/budget/subscriptions` | Yes | previous entry | `/` |
| `/weather`, `/health`, `/todos`, `/habits`, `/focus`, `/folders`, `/countdowns`, `/calendar`, `/journal`, `/notes`, `/bookmarks` | Yes | previous entry | `/` |
| `/settings`, including any hash such as `/settings#updates`, `/settings#ai` | Yes | previous entry | `/` |
| `/settings/data` (Browse your data, any `?table=&view=&page=` state) | Yes | previous entry (the data browser pushes its table, sort, page and view into the URL, so Back steps back through them, like a browser) | `/settings` |

In-page view state is NOT handled by the header Back button:

- Settings sections: the section nav uses `history.replaceState` (`SettingsLayout.jsx` line 197), so scrolling between sections never adds history. A link from elsewhere (`/settings#network`) is a push, so Back returns to where the user came from. The Help menu's "Check for updates..." navigates the whole window to `/settings#updates`: a new document, `idx` is 0, so Back falls back to `/`.
- Folders split view: the selected file is component state inside one `FolderFilesTable`, one per folder card, and several cards can have a file open at once, so "Back closes the preview" has no single target. The split view keeps its own Close preview (X) and the Files toggle. Header Back leaves the Folders page. File > Add a folder... (`/folders#add-folder`, full navigation, idx 0) falls back to `/`.
- Dialogs, the burger drawer, the command palette and onboarding are `aria-modal="true"`: Alt+Left and mouse 4 do nothing while one is open (default still prevented, so WebView2 cannot navigate away under an open dialog and lose typed data). Escape behaviour is unchanged everywhere; Back adds no Escape handling.
- In-dialog "Back" buttons (Calendar event details back to the day list, transaction import wizard steps, onboarding steps, command palette sub-list) are dialog navigation and stay.

### Keyboard and mouse

- Alt+Left and the keyboard BrowserBack key: same as a click. Ignored (default prevented, no navigation) when focus is in an `input`, `textarea`, `select` or contenteditable element, so a half-typed inline edit (Budget planner amounts, category names, Javi composer) is never thrown away by a stray shortcut. Decision: swallow rather than pass through, because WebView2 would otherwise run its own history back from inside a field. Windows is the only shipped desktop target, so the macOS Option+Left word jump is not a concern.
- Mouse button 4 (`mouseup` or `auxclick`, `e.button === 3`; both default-prevented, navigation on `mouseup` only): same as a click, also from inside a field (a mouse click is deliberate); blocked only while a modal is open. Mouse button 5 and Alt+Right are not touched (forward entries are always in-app router entries).
- Listeners are on `window` in the bubble phase and respect `e.defaultPrevented`, so any component that handles the key first wins.

### Accessibility and theme

- Accessible name "Back" (`aria-label`), tooltip `title="Back (Alt+Left)"`, `aria-keyshortcuts="Alt+ArrowLeft"`. Visible focus: `focus-visible:ring-2 ring-slate-slateBlueLight`, the same ring as `NotificationBell` and `ItemActions`. Colors are `slate-slate300` / `slate-slate100` tokens, which flip with the theme (DESIGN.md: 9.3:1 dark, 7.4:1 light). Hit area 36x36 on every width.
- No focus management is added after navigation (same as burger links today).

### WebView2 note (verify by hand)

WebView2 has browser accelerator keys on by default, so today Alt+Left and mouse 4 already run the browser's own history back, which can land on the splash page or the single-use bootstrap URL (a dead window). The listeners above call `preventDefault()` first to stop that. Chromium honours `preventDefault` on `keydown` for Alt+Left and on `mouseup` for the back button, but this must be checked in the desktop app (`npm run desktop:dev`). If WebView2 still navigates, the fix is in the Rust shell (turn off browser accelerator keys on the webview builder in `src-tauri/src/lib.rs`); that is a separate change and out of scope here.

### Ad-hoc back links made redundant

| File:line | Control | Decision |
| --- | --- | --- |
| `src/pages/DataBrowser.jsx:174-179` | "← Settings" link | Remove (header Back goes to `/settings`; the Settings nav item is also on the same screen) |
| `src/components/calendar/EventDetails.jsx:98-100` | "Close" in the event details dialog | Remove (rule 3; the dialog X and Escape remain) |
| `src/components/calendar/EventDetails.jsx:82-92` | "Back" to the day list | Keep (dialog-internal navigation) |
| `src/components/calendar/EventForm.jsx:251-253` | "Cancel" in the event form | Keep (steps back to the details or the day list; Escape and X close everything, as before) |
| `src/components/budget/ImportTransactionsDialog.jsx:672, 842` | "Back" between wizard steps | Keep (dialog-internal) |
| `src/components/onboarding/OnboardingFlow.jsx:154, 218` | "Back" between steps | Keep (dialog-internal) |
| `src/components/palette/CommandPalette.jsx:344` | "Back" in the palette | Keep (dialog-internal) |

The modal-form "Cancel" buttons removed under rule 3 are listed in the module tables.

## 2. Button audit

Legend for Decision: Keep, Remove, Merge (into a More menu), Convert (to a quieter control). Rows that are the same control repeated per item (for example Edit and Remove on every list row) are one row.

### More menu decision

After this audit no surface other than Folders has two or more rarely used secondary actions that are not already safety-gated or hard constraints. License actions (Move, Remove, Use a different key) stay visible because `server/license/messages.js` tells users to "click Move to another computer" by name and each runs an inline confirm. So `FolderMoreMenu` stays folder-specific and no shared `MoreMenu` is created.

### Shell (TopBar, burger, bell, trial)

| Surface | Control | Decision | Reason | New location |
| --- | --- | --- | --- | --- |
| TopBar | Back (new) | Keep (new) | Section 1 | TopBar left |
| BurgerMenu | Navigation menu toggle, nav links | Keep | Primary navigation | |
| TopBar | ModeSwitcher | Keep | Daily-use quick switch | |
| TopBar | Search (Ctrl K) | Keep | Palette entry | |
| TopBar | NotificationBell trigger | Keep | Alerts | |
| TopBar `TopBar.jsx:101-108` | Clock and "local time" block (with `border-l` divider) | Keep | Owner decision. It is a display, not a button, so it is outside this button audit | |
| NotificationBell `NotificationBell.jsx:93-103` | Refresh briefing icon in the popover | Remove | Duplicates the briefing card's Refresh on Home; also drops the `refreshFailure` state and its alert (lines 19-20, 53-63, 105-109) and `REFRESH_FAILED` (line 8) | Home briefing card |
| NotificationBell | Alert rows (navigate) | Keep | Content | |
| TopBar | TrialBadge ("Pro trial: N days left") | Keep | Owner decision | |
| TopBar | DevBuildBadge | Keep | Dev build only | |
| TrialNotice banner | Buy Burrow Pro, Activate a license, Dismiss | Keep | Owner decision; license constraint | |
| BurgerMenu footer | FounderBadge | Keep | Owner decision | |

### Home (`src/pages/Home.jsx`, `src/components/home/`)

| Surface | Control | Decision | Reason | New location |
| --- | --- | --- | --- | --- |
| Home header `Home.jsx:125-135` | Customize / Done | Convert | Rarely used; `BTN` (glass box) -> `btnSecondary` (quiet), keep icon and text | same place |
| Home header `Home.jsx:120-124` | Reset (edit mode only) | Convert | Same quiet style; only visible while customizing | same place |
| WidgetTile (edit mode) | Drag, width, height, hide/show | Keep | Only in edit mode | |
| WidgetCard | Whole-card link to module | Keep | Navigation | |
| BriefingCard `BriefingCard.jsx:92-102` | Refresh briefing icon | Keep, but hide while there is no briefing | With no briefing the body's Generate button is the one action; two buttons did the same thing | header (only when a briefing exists) |
| BriefingCard `:103-112` | Collapse / expand | Keep | | |
| BriefingCard `:144-151` | Generate | Keep | Primary when empty | |
| BriefingCard `:66-72` | Try again (load error) | Keep | Error recovery | |
| BriefingCard | Pro pill + description (Free) | Keep | Owner decision | |
| CrossInsightsCard `:140-153` | Explain (+ Pro pill on Free) | Keep | Primary of the card; pill is an owner decision | |
| BackupHealthNotice `:62, 67` | Open backup settings link, Dismiss | Keep | Backup safety | |
| DirectImportNotice `:47, 60, 64` | Dismiss, Open Data & storage | Keep | One-time notice | |
| DataFolderWarning | Dismiss | Keep | Data safety | |

### Budget (Dashboard, Planner, Subscriptions)

| Surface | Control | Decision | Reason | New location |
| --- | --- | --- | --- | --- |
| Budget header `pages/Budget.jsx:45-53` | Import transactions | Keep | Primary action of the module | |
| Budget header `pages/Budget.jsx:40-43` | Subtitle "Open the Planner tab to change your budget." | Remove (copy) | Explains a visible tab | |
| BudgetPage `:81-89` | Dashboard / Planner / Subscriptions tabs | Keep | Navigation | |
| BudgetPage `:38-63` | Previous / next month, month select | Keep | | |
| BudgetPage | LoadError Retry | Keep | | |
| BudgetPlanner `:131-137` | Manage categories / Done | Convert | Drop `border border-slate-slate600` | same place |
| BudgetPlanner `:257-259` | "default" badge on every unedited row | Remove | Noise; "edited" stays and explains the reset button | none |
| BudgetPlanner `:281, 292` | Reset budgeted / Reset spent (only when edited) | Keep | Conditional, labelled | |
| BudgetPlanner `:210-215` | Help paragraph | Trim | Drop "Use the reset button on a row to go back to the original number." (the buttons are labelled) | |
| IncomePayees `:93-100` | Add payee | Convert | Drop the border | same place |
| IncomePayees `:130-136` | Edit / Remove payee | Keep | | |
| IncomePayees `:214-229` | Save / Cancel (inline, not a modal) | Keep; Convert Cancel | Inline form needs its own cancel; drop Cancel's border (`:226`) | |
| CategoryEditor `:295-310, 370-435` | Add group, Show hidden, move up/down, hide, delete, clear default, add subcategory | Keep | Only inside Manage categories | |
| ImportTransactionsDialog `:563-565` | Cancel on the first step | Remove | Rule 3 | dialog X |
| ImportTransactionsDialog `:543, 686, 850` | Load sheet, Check, Import | Keep | Wizard primaries | |
| ImportTransactionsDialog `:672, 842` | Back | Keep | Wizard | |
| ImportTransactionsDialog `:735` | Close (done step, primary) | Keep | It is the done step's only action | |
| ImportTransactionsDialog `:111` | Settings > Network link | Keep | | |
| SubscriptionsView | (no buttons besides shared LoadError) | Keep | | |

### Todos

| Surface | Control | Decision | Reason | New location |
| --- | --- | --- | --- | --- |
| KanbanBoard `:242-246` | Add todo | Keep | Primary | |
| KanbanBoard `:248-256` | Columns | Keep | Already quiet `btnSecondary` | |
| KanbanColumn `:62-79` | Add to column (+), Clear column | Keep | Per-column targets; Clear is confirmed | |
| KanbanCard `:75-87` | Mark done, Edit, Remove (hover reveal) | Keep | | |
| TodoForm `:174-176` | Cancel | Remove | Rule 3 | dialog X |
| TodoForm `:177` | Add / Save | Keep | | |
| ColumnSettings `:157-226` | Move up/down, Delete column, Add column | Keep | Inside the Columns dialog | |

### Habits, Journal, Notes, Bookmarks, Countdowns

| Surface | Control | Decision | Reason | New location |
| --- | --- | --- | --- | --- |
| HabitsPage `:70, 91` | Add habit / Add your first habit | Keep | Primary, empty state | |
| HabitRow `:60, 94` | Done today toggle, Edit / Remove | Keep | | |
| HabitForm `:79-81` | Cancel | Remove | Rule 3 | dialog X |
| JournalPage `:76` | Add entry | Keep | | |
| EntryList `:91` | Edit / Remove | Keep | | |
| EntryForm `:156, 226` | Mic, remove tag | Keep | | |
| EntryForm `:256-258` | Cancel | Remove | Rule 3 | dialog X |
| NotesPage `:79, 89` | Add note / first note | Keep | | |
| NotesPage `:101-112` | Pin / unpin, Edit / Remove | Keep | | |
| NoteForm `:99-101` | Cancel | Remove | Rule 3 | dialog X |
| BookmarksPage `:73, 84, 104` | Add, first, Edit / Remove | Keep | | |
| BookmarkForm `:104-106` | Cancel | Remove | Rule 3 | dialog X |
| CountdownsPage `:65, 76, 89` | Add, first, Edit / Remove | Keep | | |
| CountdownForm `:80-82` | Cancel | Remove | Rule 3 | dialog X |
| All forms | Submit (Add / Save changes) | Keep | | |

### Calendar

| Surface | Control | Decision | Reason | New location |
| --- | --- | --- | --- | --- |
| CalendarPage `:377-399` | Previous month, Today, Next month | Keep | | |
| CalendarPage `:401-407` | Import .ics | Convert | Rarely used: drop the fill (`bg-slate-slate700/60 ... hover:bg-slate-slate700`) for `text-slate-slate300 hover:bg-slate-slate700/60 hover:text-slate-slate100`; stays visible because it is the only import path | same place |
| CalendarPage `:415-420` | Add event | Keep | Primary | |
| CalendarPage `:505, 540` | Day cell, "+N more" | Keep | | |
| CalendarPage `:596` | Add event (day dialog) | Keep | | |
| CalendarPage `:350` | Remove (day list rows) | Keep | | |
| EventButtons `:26, 87` | Event chips | Keep | | |
| EventDetails `:82-92` | Back to day | Keep | Dialog navigation | |
| EventDetails `:93-96` | Remove | Keep | Confirmed | |
| EventDetails `:98-100` | Close | Remove | Rule 3 | dialog X |
| EventDetails `:101` | Edit | Keep | Primary | |
| EventForm `:251-253` | Cancel | Keep | Steps back to the event details (editing) or the day list; Escape and X close everything, as before | |

### Focus, Health, Weather

| Surface | Control | Decision | Reason | New location |
| --- | --- | --- | --- | --- |
| FocusPage `:177-184` | Start / Pause | Keep | Primary | |
| FocusPage `:185-198` | Reset, Skip | Convert | Drop `border border-slate-slate700` | same place |
| FocusPage | LoadError Retry | Keep | | |
| HealthPage, WeatherPage | LastUpdated, NetworkOptInNotice turn-on, LoadError Retry | Keep | Network switches are a hard constraint | |

### Folders

| Surface | Control | Decision | Reason | New location |
| --- | --- | --- | --- | --- |
| FoldersPage `:89, 94` | Add folder / first folder | Keep | Primary | |
| FolderCard `:212-238` | Re-scan / Choose or Confirm folder | Keep | The one primary per card | |
| FolderCard | More menu (exports, daily re-scan, Remove) | Keep | Established pattern | |
| FolderCard `:313-330` | Files, Details, Ask, Report toggles | Keep | Quiet toggles | |
| FolderCard `:45-53` JobNotice `ai_unavailable` | Inline "Summaries need Javi." + Open Settings > AI link | Convert | Render through `AiUnavailable` (one copy of the Ollama notice; issue #78) | same place |
| FolderJobProgress `:43` | Cancel job | Keep | | |
| PickStatus `:19, 30` | Stop waiting, Choose another folder | Keep | | |
| FolderMoreMenu `:239, 248` | Download instead, Stop waiting | Keep | Recovery only | |
| FolderFilesTable `:40, 54, 234, 264, 275, 191` | File row, summary expander, sort headers, previous / next page, Retry | Keep | | |
| FolderSplitView `:51-71` | Previous file, Next file, Close preview | Keep | In-card view state (section 1) | |
| FilePreviewPane `:92, 105` | Re-scan, Try again | Keep | Recovery | |
| FolderAskPanel `:131` | Ask | Keep | | |
| SearchModelPrompt `:58` | Download the search model | Keep | | |
| FolderReportCard `:58-68` | Write report | Keep, plus a notice before the click (issue #77) | | |
| AddFolderDialog `:122-124` | Cancel | Remove | Rule 3 | dialog X |

### Settings (`src/pages/Settings.jsx`, `src/components/settings/`)

| Surface | Control | Decision | Reason | New location |
| --- | --- | --- | --- | --- |
| SettingsLayout | Section nav links, Browse your data nav item | Keep | | |
| AppearanceSection `:71` | Reset appearance (ResetControl) | Convert | Kept, not removed: Reset all is not equivalent (it cannot reset one section alone). The `ResetControl` trigger now uses `btnSecondary` (quiet), with its inline confirm unchanged. Dropping the section Resets is an Owner decision | same place |
| BudgetSection `:59` | Reset budget settings | Convert | Same | same place |
| GeneralSection `:81` | Reset general settings | Convert | Same | same place |
| Settings.jsx `:159` | Reset all to defaults (confirmed) | Convert | Same `ResetControl`, so it gets the same quiet trigger; the confirm stays | same place |
| Appearance, General, Budget | Theme, background, mode, Javi switches, budget view | Keep | Settings themselves | |
| BudgetSection `:49` | Budget planner link | Keep | | |
| AiSection `:63, 340` | Retry | Keep | Error recovery | |
| AiSection `:48-50` | "local" pill next to the status pill | Remove | Default case, repeats the status; "another computer" pill stays (privacy relevant) | none |
| AiSection `:261-286` | Advanced (BTN toggle with state) | Convert | Native `<details>` with a quiet summary, same as CloudAiBlock "Advanced options" (`CloudAiBlock.jsx:165-168`); drops `useState`/`useId` | same place |
| AiSection `:235` | Save address | Keep | | |
| AiSection `:238-245` | Use default address | Remove | Duplicate: the hint below says "Leave empty to use ...", and an empty Save does exactly that (`submit(null)`) | Save address with an empty field |
| AiSection | Source radio, model selects, OllamaSetup (Check again, Download model, Cancel download) | Keep | | |
| CloudAiBlock `:98, 185, 204, 218` | Review and turn on, Save provider, Turn off, Turn on cloud AI | Keep | Privacy controls; fix #80 disabled look | |
| CloudKey / ApiKeyRow `:210-341` | Set/Change, Test, Remove (+ inline Save, Cancel, show key, confirm Remove/Cancel) | Keep | Inline forms, not modals; secrets | |
| ApiKeysSection `:47, 58` | Retry | Keep | | |
| CloudAiConsentDialog `:137-140` | Cancel, Turn on | Keep | Consent dialog: explicit decline | |
| DataStorageSection `:41-69` | Storage group expanders | Keep | | |
| DataStorageSection `:56-58` | "N items" count pill in each group header | Remove | Fewer pills; the expander shows the items | none |
| DataStorageSection `:112-129` | "Browse your data" link card | Remove | Same screen has the Browse your data nav item (sidebar and pill bar), plus the palette command | Settings nav |
| BackupsControl `:273` | Back up now | Keep | | |
| BackupAutoSwitch `:117-147` | Automatic backups switch, confirm off / Cancel | Keep | Backup safety | |
| BackupsControl `:301, 349` | Try again, Restore (per backup) | Keep | Restore is confirmed (hard constraint) | |
| BackupRestoreConfirm `:113-150` | Restore / Cancel / Reload | Keep | Safety confirmation | |
| BackupRetentionForm | Save | Keep | | |
| BackupsControl `:400-419` | File input, Cancel upload | Keep | | |
| BackupsControl `:452-460` | Restore this file | Keep | | |
| BackupsControl `:461-463` | Choose a different file | Remove | The file input above stays enabled and picking again replaces the file | file input |
| BackupsControl `:477-479` | Copy path | Remove | The path is `select-all` code already; Help > Open data folder in the desktop app; drops `copyPath` and the `copyMessage` status line (`:481-483`) | select the path |
| ImportFromDirectControl | Import controls | Keep | Store build only | |
| CopyFromStableControl | Copy controls | Keep | Dev build only | |
| DataExportControl | Export my data | Keep | Hard constraint | |
| ImportControl `:172, 180` | Import, Cancel, Importing | Keep | Hard constraint | |
| DangerZone, EraseDataDialog `:173-232` | Erase all data, Cancel, Review and erase, Go back, Erase my data, Reload | Keep | Hard constraint, safety | |
| PrivacyActivitySection `:74-262` | Row expanders, Refresh, Retry, Load more | Keep | Privacy controls | |
| NetworkSection | Feature switches, Retry, See network activity | Keep | Network switches; activity is a privacy control | |
| NetworkActivityPanel `:43-75` | Load more, Retry | Keep | | |
| LicenseSection `:294` | Retry | Keep | | |
| LicenseSection `:333, 418` | Buy Burrow Pro | Keep | Hard constraint | |
| LicenseSection `:348-368` | Move to another computer, Remove from this computer (inline confirm) | Keep | Named in store error copy; confirmed | |
| LicenseSection `:370-378` | Use a different key | Keep | Opens Activate a license when licensed | |
| ActivateLicenseForm `:100` | Activate | Keep | Hard constraint | |
| UpdatesSection, UpdateInstallPanel | Switch, Check now, Download and install, Check again, Go back to the update, Get the installer, Download, links, Retry | Keep | Hard constraint | |
| BuildIdentityLine | (text) | Keep | | |
| Settings extensions | Developer tools | Keep | Dev builds only | |

### Browse your data (`src/pages/DataBrowser.jsx`, `src/components/dataBrowser/`)

| Surface | Control | Decision | Reason | New location |
| --- | --- | --- | --- | --- |
| DataBrowser `:174-179` | "← Settings" | Remove | Header Back | TopBar Back |
| DataBrowser `:182` | "Read-only" pill | Remove | The subtitle right below says "Nothing here can be edited." | none |
| DataBrowser `:202` | Retry | Keep | | |
| TablePicker, view tabs, DataGrid sort, GridPagination, CellValue, ValueViewer, search clear, reset view | Keep | Data navigation | | |

### Javi panel (`src/components/javi/`)

| Surface | Control | Decision | Reason | New location |
| --- | --- | --- | --- | --- |
| JaviLauncher | Launcher | Keep | | |
| JaviPanel `:271-281` | New chat (Pro) | Keep | | |
| JaviPanel `:282-290` | Get new advice (refresh) | Keep | | |
| JaviPanel `:291` / JaviAdvisor `:100` | Close Javi | Keep | | |
| JaviPanel `:340-346` | Get advice (empty state) | Keep | Primary when empty | |
| JaviPanel `:359-366` | Retry | Convert | Drop `border border-slate-slate700` | same place |
| JaviPanel `:386-401` | "Import transactions" chip on the Budget page | Keep | Owner decision. It sits in a separate surface (the Javi panel) and has dedicated tests | |
| JaviPanel `:403-421` | Question chips (Pro) | Keep | Fix #80 faintness | |
| JaviPanel `:437-445` | Send | Keep | | |
| JaviPanel `:59` (ReportLink) | Report under each reply | Keep | Hard constraint (policy 11.16) | |
| JaviPanel `:312` | Buy Burrow Pro hint (Free) | Keep | Owner decision | |
| ConfirmActionCard `:65, 73` | Approve, Decline | Keep | Write safety | |
| CloudHint `:49-67` | Keep it local, Open Settings, Dismiss | Keep | | |
| WithheldNotice `:35` | Change what cloud AI can see | Keep | Privacy | |

### Onboarding and shared dialogs

| Surface | Control | Decision | Reason | New location |
| --- | --- | --- | --- | --- |
| OnboardingFlow `:128-133` | Skip for now, Continue | Keep | | |
| OnboardingFlow `:154-171` | Back, Continue / Skip for now | Keep | Wizard | |
| OnboardingFlow `:218-236` | Back, Finish | Keep | | |
| OnboardingFlow `:226-233` | "Set this later in the Budget planner" | Convert (copy) | Label -> "Skip"; the intro line above already says the planner can change it | same place |
| OllamaSetup `:61, 101, 188` | Check again, Download model, Cancel download | Keep | | |
| Modal `:162` | Close (X) | Keep | The one cancel for every dialog | |
| ConfirmDialog `:73-79` | Cancel, confirm | Keep | Safety | |
| NetworkOptInNotice, LoadError, ProGateNotice, ProTrialPrompt | Turn on, Retry, license links, Buy | Keep | | |
| CommandPalette | Back, items | Keep | | |
| LoginScreen (web sign-in only) | Sign in | Keep | | |

### Counts

| Decision | Count |
| --- | --- |
| Remove | 15 controls and 4 pills (7 modal-form Cancels: Todo, Habit, Entry, Note, Bookmark, Countdown, AddFolder; ImportTransactions step-1 Cancel; EventDetails Close; DataBrowser "← Settings"; Use default address; Copy path; Choose a different file; Browse your data card; Bell refresh. Pills: planner "default", AI "local", storage count, data browser "Read-only") |
| Merge into a More menu | 0 (see "More menu decision") |
| Convert to a quieter control | 17 (the 13 originals: Home Customize, Home Reset, Planner Manage categories, Add payee, payee Cancel, Calendar Import .ics, Focus Reset, Focus Skip, AI Advanced -> details, Javi Retry, Folders AI notice -> AiUnavailable, Briefing refresh hidden when empty, onboarding "Skip" label; plus the 3 section Resets and Reset all, converted through the `ResetControl` trigger) |
| Keep | about 150 control types across all surfaces (every row marked Keep above), including three Owner-decision keeps: the top-bar clock, the per-section Resets (as converted), the Javi "Import transactions" chip; and the Calendar EventForm Cancel (steps back) |
| New | 1 (Back) |

## 3. Per-page before -> after (for the PR body)

| Page | Before | After |
| --- | --- | --- |
| Every page but Home | No way back except the burger menu; Alt+Left / mouse 4 could leave the app for the splash or a dead bootstrap page | Back button left of the mode switcher; Alt+Left and mouse 4 go back inside Burrow only; Home keeps an inert placeholder so the header does not shift |
| Notifications | Refresh button in the popover | Removed; refresh lives on the Home briefing card |
| Home | Boxed Customize; empty briefing showed Refresh and Generate | Quiet Customize; empty briefing shows only Generate |
| Budget | Bordered Manage categories and Add payee; "default" tag on every row; extra explaining copy | Quiet buttons, only "edited" tags, shorter copy |
| Todos, Habits, Journal, Notes, Bookmarks, Countdowns forms | Cancel next to Save plus the dialog X | Save plus the dialog X (Escape still cancels) |
| Calendar | Filled Import .ics; event details had Close and X; event form Cancel | Quiet Import .ics; event details X only; event form keeps Cancel (steps back to details or the day list) |
| Focus | Bordered Reset and Skip | Quiet Reset and Skip |
| Folders | Add dialog had Cancel; Report showed only a ghost Write report without Ollama; raw Ollama address in notices; "file list below" copy while collapsed | X only; Report says it needs Javi with an Open Settings > AI link before the click; address behind Details; corrected copy, "on <date>" for one day |
| Settings | Boxed Reset buttons in three sections plus Reset all; Use default address; boxed Advanced; Copy path; Choose a different file; Browse your data card plus nav item; count and "local" pills | Quiet Reset buttons (sections and Reset all, same confirm); empty Save uses the default; Advanced as a disclosure; select the path; pick again with the file input; nav item only; fewer pills |
| Browse your data | "← Settings" link and Read-only pill | Header Back; subtitle says read-only |
| Javi panel | Bordered Retry; faint chips in light theme | Quiet Retry; visible chip edges (new `--javi-suggest-border`); the Import transactions chip on Budget stays |
| Onboarding | "Set this later in the Budget planner" | "Skip" |

## 4. Hard-constraint checklist

| Constraint | Status after this pass | Guarded by |
| --- | --- | --- |
| Free export and import discoverable in Settings > Data & storage | Untouched: `DataExportControl`, `ImportControl` stay in `DataStorageSection` | WP-C adds a DataStorageSection test asserting both render |
| Help > Report content... | Native menu, untouched | |
| Report link under each Javi reply | Untouched (`JaviPanel.jsx:59`) | existing `ReportLink` tests |
| Privacy and activity controls, Network switches | Untouched | |
| Buy Burrow Pro and Activate a license in Settings > License | Untouched | WP-C adds LicenseSection tests (issue #81 item) asserting both for Free and trial |
| Updates section | Untouched | |
| Erase all data, Remove folder, Restore backup confirmations | Untouched | existing tests |
| Every feature reachable | Each removal names its remaining path in the audit "New location" column | |
| No Free/Pro tier change | No gating code changes | |

## 5. Open UX issues

| Issue | Decision | Parts folded in |
| --- | --- | --- |
| #77 Folders Report needs Ollama/Pro before the click | Fold in (WP-C) | `FolderReportCard`: when not gated and `folder.summary?.status === 'ai_unavailable'` (the last scan could not reach Javi), render above the button `<p className="text-sm text-slate-slate300">{REPORT_NEEDS_AI}{' '}<Link to={{ pathname: '/settings', hash: '#ai' }} className={LINK_CLASS}>Open Settings &gt; AI</Link></p>`; the button stays so a user who just started Ollama can try. New constant in `src/constants/folders.js`: `REPORT_NEEDS_AI = 'Reports need Javi, which runs on this computer through Ollama.'`. The Pro requirement already shows before the click (`ProGateNotice` when `isKnownFree`). No new request. |
| #78 raw `http://127.0.0.1:11434` in user copy | Fold in, client only (WP-C) | In `AiUnavailable.jsx` add a private `splitHost(message)`: match `/ at (https?:\/\/[^\s]+?)(?=[.,]?(\s|$))/`, return the message without " at <host>" and the host. Render the trimmed message, then, when a host was found, `<details className="mt-1"><summary className="cursor-pointer">Details</summary>Ollama address: <span className="font-mono">{host}</span></details>`. FolderCard's JobNotice `ai_unavailable` branch renders `<AiUnavailable message={notice.message} />`, so the Folders card, Javi panel, briefing and Explain all get it. The server copy is not changed. Settings > AI keeps showing the address (it is the settings page for it). |
| #79 Folders copy | Fold in (WP-C) | `SUMMARY_AI_UNAVAILABLE` -> `'No summary yet. Open Files to see what is inside.'` (used by `FolderCard`); `FileSummaryPane.jsx:49` uses `SUMMARY_NONE` instead. `FolderStats.jsx`: when both dates format the same, the line reads `Files changed on {date}.`, else `Files changed {a} to {b}.` |
| #80 a11y light theme | Fold in (WP-C) | `aiFormStyles.js` `PRIMARY_BTN`: replace `aria-disabled:opacity-60` with `aria-disabled:cursor-not-allowed aria-disabled:bg-slate-slate700/60 aria-disabled:text-slate-slate300 aria-disabled:hover:opacity-100` so a disabled "Turn on cloud AI" loses the purple fill in both themes. `index.css`: `.glass-javi-suggest` border uses a new `--javi-suggest-border` token: light `rgb(var(--slate-500))`, dark `rgba(255, 240, 220, 0.3)`, and under `prefers-contrast` `rgb(var(--slate-400))`. The existing `--javi-border` was not used because it measured 1.6:1; text color unchanged. Check light and dark. |
| #81 copy follow-ups | Fold in (WP-C), server part copy-only | `server/ai/gate.js:20` HINT_AI_LAN -> `'This Ollama is on another computer. Turn on "Ollama on another computer" in Settings > Network.'`; `server/ai/registry.js:420, 782, 928` -> `` `Using Ollama at ${host} needs the "Ollama on another computer" switch in Settings > Network.` ``; `aiFormParts.jsx:39-40` OPT_IN_FEATURE -> `aiLan: 'Ollama on another computer'`, `cloudAi: 'Cloud AI provider'` (the real switch labels in `server/netFeatures.js`); `CloudAiBlock.jsx:121` and `CloudAiConsentDialog.jsx:128` quote `"Cloud AI provider"`; `AiUnavailable.jsx:40` "machine" -> "computer"; LicenseSection test additions (see section 4). Also folded in (L6, FolderCard stale job): `src/components/folders/FolderCard.jsx` (line 130) derives the displayed job as `const job = active && polled && (polled.id === folder.job?.id || isJobActive(polled)) ? polled : folder.job;`, where `active = isJobActive(folder.job)` (the list is the source of truth for whether a job is active; the polled job only refines an active one), so a stale polled job of an earlier scan is never shown. |

## 6. Owner decisions (kept as is, listed for review)

1. TopBar `TrialBadge` ("Pro trial: N days left") and the `TrialNotice` banner with Buy Burrow Pro.
2. Pro pills on the Home briefing card and on Explain (Free).
3. "Ask follow-ups and chat with Javi with Pro" hint with the Buy link in the Free Javi panel.
4. `FounderBadge` in the burger footer.
5. `ModeSwitcher` in the top bar while Settings > General also sets the mode (two places, but the top bar one is a daily switch).
6. The top-level Import transactions button stays outlined (it is Budget's primary action; making it a filled primary is a visual call for the owner).
7. The top-bar clock and "local time" block stays (a display, not a button).
8. The per-section Reset buttons (Appearance, Budget, General) stay, converted to the quiet `btnSecondary` trigger; Reset all does not reset one section alone.
9. The Javi "Import transactions" chip on the Budget page stays.

## 7. Bundle expectations

Budget (`scripts/checks/bundle-budget.json`): totalJsGzipKb 470 (every chunk counts), initialJsGzipKb 146. Estimates in gzip bytes:

| Change | Estimate |
| --- | --- |
| BackButton.jsx + `parentPath` + TopBar import | +550 |
| `ChevronLeft` | about 0 (already in lazy chunks; moves to the shared chunk) |
| #77 notice + constant | +90 |
| #78 `splitHost` and details | +130 |
| #79, #81 copy | +40 |
| NotificationBell refresh, failure state, imports | -350 |
| 9 dialog Cancel/Close buttons (7 forms, Import step 1, EventDetails Close) and their `onCancel`/`onClose` props | -410 |
| DataBrowser link and pill | -110 |
| DataStorageSection card, count pill, `ArrowRight` import | -200 |
| Copy path, copy message, Choose a different file | -250 |
| Use default address, Advanced state -> details, "local" pill | -190 |
| FolderCard JobNotice -> AiUnavailable | -60 |
| Planner badge, help sentence, Budget subtitle, onboarding label | -120 |
| Net | about -0.9 KB |

The top-bar clock, the three section Resets and the Javi chip are kept, so they contribute no savings. Only BackButton grows the initial chunk; the bell refresh removal in the same chunk offsets most of it, so initialJsGzipKb should not rise noticeably. Each WP must run `npm run build; node scripts/checks/bundleBudget.js` and report totals; WP-A alone is about +90 bytes net (BackButton +550, bell refresh -350, DataBrowser link and pill -110) and must not push total past 470. If any WP measures growth, it reports the number instead of raising the budget.

## 8. Implementation plan

Three independent work packages. File sets are disjoint; any order of merge works. Each WP: implement, update its tests, `npm test`, `npm run lint`, `npm run check`, build plus bundle check, light and dark manual look. No commits by the designer.

### WP-A: shell, back button, Home, data browser

Files:
- `src/components/shell/BackButton.jsx` (new, contract in section 1)
- `src/components/shell/routeKey.js` (add `parentPath`)
- `src/components/shell/TopBar.jsx` (mount `<BackButton />` first in the left cluster; the clock block and `TIME_FMT` stay, Owner decision)
- `src/components/shell/NotificationBell.jsx` (remove refresh button, `onRefresh`, `refreshFailure`, `REFRESH_FAILED`, `RefreshCw`, `isProRequiredError`, `userMessage`, `useRefreshEntitlements`, and `free`/`isKnownFree` if then unused; keep `refreshing` for the "Refreshing…" text)
- `src/pages/Home.jsx` (Customize and Reset use `btnSecondary` from `shared/formStyles` with `inline-flex items-center gap-1.5`; drop the `BTN` import)
- `src/components/home/BriefingCard.jsx` (render the header refresh button only when `briefing` is truthy)
- `src/pages/DataBrowser.jsx` (remove lines 174-179 and the pill at 182; drop `Link`, `PILL`, `TONE_CLASS` imports if unused)
- `docs/DESIGN.md` (Components table: Back button row; Checklist: "A modal form has no Cancel; the dialog X, Escape and the backdrop cancel. Confirmations keep Cancel.")

Tests:
- `src/components/shell/__tests__/BackButton.test.jsx` (new): render inside `BrowserRouter` with `Routes` for `/`, `/budget`, `/settings`, `/settings/data`; hidden on `/`; name "Back"; with history (click a Link `/` -> `/budget`, then Back) returns to `/`; without history (`window.history.replaceState(null, '', '/settings/data')` before render) falls back to `/settings`, and from `/budget` to `/`; Alt+Left calls back and `defaultPrevented` is true; Alt+Left in an input does not navigate but is prevented; Alt+Left with an `aria-modal="true"` element present does not navigate; `mouseup` with `button: 3` navigates; `parentPath` cases; on `/` an aria-hidden placeholder and no Back button; `title` is "Back (Alt+Left)"; a repeated keydown (`repeat: true`) does not navigate; a second Back before the route changes is ignored.
- `src/components/shell/__tests__/TopBar.test.jsx` (clock still shown, Back present off Home)
- `src/components/shell/__tests__/NotificationBell.test.jsx` (no refresh button; Free and Pro both)
- `src/components/shell/__tests__/AppShell.javi.test.jsx`, `AppShell.javiButtonOff.test.jsx` (only if they query the top bar)
- `src/pages/__tests__/DataBrowser.test.jsx` (line 125 "← Settings" assertion removed; Read-only pill)
- `src/components/home/__tests__/BriefingCard.test.jsx`, `BriefingCard.tiers.test.jsx`, `BriefingCard.cloud.test.jsx` (refresh button absent with no briefing)
- `e2e/` specs that reference "← Settings" (grep and update)

### WP-B: modules (Budget, Calendar, Todos, Habits, Journal, Notes, Bookmarks, Countdowns, Focus)

Files:
- `src/pages/Budget.jsx` (subtitle sentence; leave the `TRANSACTION_IMPORT_EVENT` listener, it is harmless and removing it would couple to WP-C)
- `src/components/budget/BudgetPlanner.jsx`, `IncomePayees.jsx`, `ImportTransactionsDialog.jsx`
- `src/components/calendar/CalendarPage.jsx`, `EventDetails.jsx` (remove Close and the `onClose` prop; CalendarPage stops passing it), `EventForm.jsx` (Cancel stays; it steps back to the details or the day list)
- `src/components/todos/TodoForm.jsx`, `KanbanBoard.jsx`
- `src/components/habits/HabitForm.jsx`, `HabitsPage.jsx`
- `src/components/journal/EntryForm.jsx`, `JournalPage.jsx`
- `src/components/notes/NoteForm.jsx`, `NotesPage.jsx`
- `src/components/bookmarks/BookmarkForm.jsx`, `BookmarksPage.jsx`
- `src/components/countdowns/CountdownForm.jsx`, `CountdownsPage.jsx`
- `src/components/focus/FocusPage.jsx`

For each form except the Calendar `EventForm`: delete the Cancel button and the `onCancel` prop; the action row becomes `flex justify-end` with the submit button only; callers stop passing `onCancel`. The Modal keeps `onClose={crud.close}`.

Tests (update "Cancel"/"Close" queries to the dialog's "Close" X or Escape):
- `src/components/budget/__tests__/BudgetPage.test.jsx`, `BudgetPageSettings.test.jsx`, `ImportTransactionsDialog.test.jsx`, `ImportTransactionsDialog.flow.test.jsx`, `IncomePayees.test.jsx`, `CategoryEditor.test.jsx`
- `src/pages/__tests__/Budget.import.test.jsx`, `Budget.javiFocus.test.jsx` (only if they assert the subtitle)
- `src/components/calendar/__tests__/CalendarPage.test.jsx`, `EventDetails.test.jsx`, `EventForm.test.jsx`
- `src/components/todos/__tests__/KanbanBoardUx.test.jsx`, `KanbanCardActions.test.jsx`, `TodosAddColumn.test.jsx`, `ColumnSettings.test.jsx`
- `src/components/habits/__tests__/HabitsPage.test.jsx`
- `src/components/journal/__tests__/JournalPage.test.jsx`, `EntryList.test.jsx`
- `src/components/notes/__tests__/NotesPage.test.jsx`
- `src/components/bookmarks/__tests__/BookmarksPage.test.jsx`
- `src/components/countdowns/__tests__/CountdownsPage.test.jsx`
- `src/components/focus/__tests__/FocusPage.test.jsx`
- `e2e/flows/*` that click a form Cancel (grep)

### WP-C: Settings, Javi, Folders, onboarding, AI copy (issues #77 to #81)

Files:
- `src/pages/Settings.jsx` (no change to the section Resets; they and Reset all stay)
- `src/components/settings/ResetControl.jsx` (trigger uses `btnSecondary` with `inline-flex items-center gap-1.5`)
- `src/components/settings/AppearanceSection.jsx`, `BudgetSection.jsx`, `GeneralSection.jsx` (keep `ResetControl` and `onReset`)
- `src/components/settings/DataStorageSection.jsx` (remove the Browse card and the count pill; drop `Link`, `ArrowRight`, ids if unused)
- `src/components/settings/BackupsControl.jsx` (remove Copy path, `copyPath`, `copyMessage`; remove Choose a different file)
- `src/components/settings/AiSection.jsx` (remove Use default address; Advanced -> `<details>`; remove the "local" pill)
- `src/components/settings/aiFormParts.jsx`, `aiFormStyles.js`, `CloudAiBlock.jsx`, `CloudAiConsentDialog.jsx` (#80, #81)
- `src/components/javi/JaviPanel.jsx` (Retry without border; the Import chip and `openTransactionImport` stay)
- `src/index.css` (#80 chip border: `--javi-suggest-border`)
- `src/components/shared/AiUnavailable.jsx` (#78, #81)
- `src/components/folders/FolderCard.jsx` (also #81 L6, the stale job line), `FolderReportCard.jsx`, `FolderStats.jsx`, `FileSummaryPane.jsx`, `AddFolderDialog.jsx` (Cancel removed; `onClose` stays for the Modal)
- `src/constants/folders.js` (`REPORT_NEEDS_AI`, new `SUMMARY_AI_UNAVAILABLE`; delete `AI_NOTICE_PREFIX` once unused)
- `src/components/onboarding/OnboardingFlow.jsx` ("Skip")
- `server/ai/gate.js`, `server/ai/registry.js` (copy only)

Tests:
- `src/pages/__tests__/Settings.test.jsx`, `Settings.javi.test.jsx`
- `src/components/settings/__tests__/ResetControl.test.jsx` (component stays; only callers change), `DataStorageSection.test.jsx` (Export and Import present, no Browse card), `BackupsControl.test.jsx`, `AiSection.test.jsx`, `AiSection.cloud.test.jsx`, `CloudAiConsentDialog.test.jsx`, `SettingsLayout*.test.jsx` (Browse your data nav still present)
- `src/components/settings/__tests__/LicenseSection*.test.jsx`: add Buy Burrow Pro and Activate a license visible for Free and for the trial
- `src/components/shared/__tests__/AiUnavailable.test.jsx` (host moves into Details; "computer" copy)
- `src/components/javi/__tests__/JaviPanel.import.test.jsx` (unchanged: the chip stays), `JaviPanel.agent.test.jsx`, `JaviPolish.test.jsx`
- `src/components/folders/__tests__/FoldersPage.test.jsx`, `FolderSplitView.test.jsx`, `FoldersShell.test.jsx` (#77, #78, #79, AddFolderDialog Cancel)
- `src/components/onboarding/__tests__/Onboarding.test.jsx`, `Onboarding.noLicense.test.jsx`
- `src/utils/__tests__/pillContrast.test.js` only if a token changes (none planned)

## Open questions

1. WebView2 `preventDefault` behaviour for Alt+Left and mouse 4 must be confirmed in the desktop app; if it fails, a shell change (browser accelerator keys off) is needed.

Resolved by the Orchestrator decisions below: the per-section Resets stay (converted), and the #81 FolderCard stale job is folded in.

## Follow-ups (tracked, not in this PR)

- Cross-module primary-action placement (critique D4).
- A per-column "⋯" menu for Todos "Clear column" (D6).
- License block primary action (D8).
- Month-stepper glyph versus Back (D3).
- A discard-unsaved-changes guard on the dialog backdrop (D9).
- AiUnavailable details polish (R7, R8).
- Migrate Back to the `--focus-ring` token (R13).
- macOS Option+Left note (R5); Windows is the only shipped desktop target today.

## Orchestrator decisions (applied to the body above; listed for the record)

1. **Top-bar clock: kept.** It is a display, not a button, so it is outside this button audit. Removing it is an owner call (Owner decision). Back's bytes are offset by the other removals instead.
2. **Per-section Reset buttons (Appearance, Budget, General): kept, converted to the quiet style.** "Reset all" is not equivalent: resetting one section without touching the others would no longer be possible. Whether to drop them is an Owner decision.
3. **Javi "Import transactions" chip on Budget: kept.** It sits in a separate surface (the Javi panel) and has dedicated tests, which suggests it is intentional. Owner decision.
4. **#81 FolderCard stale job: folded in (WP-C)** using the line the issue gives: `const job = active && polled && (polled.id === folder.job?.id || isJobActive(polled)) ? polled : folder.job;` (verify `isJobActive` exists or use the equivalent helper).
5. Confirmation dialogs for destructive actions (Erase all data, Remove folder, Restore backup, Reset all, any delete confirm) keep both their confirm and their Cancel. Only the Cancel in *form* dialogs that also have an X and Escape is removed.
