# Two workspaces in the menu, Calendar and Weather on one page (2026-10)

> Superseded 2026-10-10 by docs/design/nav-sections-2026-10.md for the menu and workspaces: one menu with sections, no workspaces. Calendar & Weather as one page still stands.

Owner request (2026-10-10, verbatim): "move journal/budget drop-down to hamburger nav button. merge weather and calendar into one page. rest of nav should only have budget and journal where journal takes over the rest of life pages."

Builds on `docs/design/workspaces-2026-10.md` (Budget and Journal workspaces, shipped in #91). Everything not named here keeps that design: the route owns the workspace on an owned page, Shared pages keep the saved `app_state` `workspace`, a switch is a push so Back walks it, Alt+1 / Alt+2, the palette "Switch to ..." row, the `ready` gate. Lands before the 1.2.0 tag. No Free or Pro change, no new network call, no migration.

## Decisions

### 1. The switcher moves into the menu

- The header menu button (`WorkspaceSwitcher` in `TopBar.jsx`) is removed. The menu (`BurgerMenu.jsx`) gets a compact two-option control at the top of the drawer, under the Burrow heading and above the page list: `Budget  Alt+1` and `Journal  Alt+2`, each with its workspace icon.
- Form: a `role="group"` named "Workspace" holding two buttons with `aria-pressed` (the current one is pressed) and `aria-keyshortcuts`. Not a radio group: arrow keys on a radio group change the selection at once, and here a selection navigates and closes the drawer, so a keyboard user would leave the menu while moving through it. Two buttons are reached with Tab like every other control in the drawer and take part in its focus trap. The shortcut hint is `<kbd aria-hidden="true">` in `text-[10px] text-slate-slate400`, as the old menu had it.
- Picking the other workspace saves `workspace` and pushes its start page (`/budget` or `/journal`); the route change closes the drawer and puts focus back on the menu button (existing safety net). Picking the current one just closes the drawer (the old menu closed too).
- While the saved workspace is unknown (a Shared page before `GET /api/state/workspace` answers) the group is `aria-busy="true"`, no button is pressed, both buttons are `aria-disabled` and a click does nothing, as the old trigger did. Alt+1 / Alt+2 keep working then (unchanged `switchTo` rule).
- The route sync and the Alt+1 / Alt+2 listener used to live in the header switcher because it was always mounted. The drawer is unmounted while closed, so both move into a headless `WorkspaceKeys` component (same file) that `TopBar` mounts where the switcher was. Behaviour is identical; only the menu-button code is gone.
- Header label: none is added. With Life gone, the only Shared pages are Home and Settings. Every other page belongs to one workspace and says which by itself (its own name, its own nav group), Home's subtitle already names the workspace ("Budget workspace. Everything important at a glance."), and Settings does not change with it. The drawer subtitle keeps "<name> · <W> workspace" and the pressed button shows it too. DESIGN.md asks for no new chrome and quiet secondary controls, and a label would cost initial-chunk bytes for information the page already gives.

### 2. Navigation data

`NAV_GROUPS` (`src/components/shell/navItems.js`) becomes: Home (direct link), Budget group, Journal group, Settings (direct link). The `life` group is deleted and its items join the Journal group (`workspace: 'journal'`), kept alphabetical:

Bookmarks, Calendar & Weather, Countdowns, Focus, Folders, Habits, Health, Journal, Notes, Todos.

Consequences, all from the existing owned-route rule (`workspaceForPath`):

- `/bookmarks`, `/calendar`, `/countdowns` and `/folders` now belong to Journal: opening one (a link, a bell alert, a search result, File > Add a folder..., a Home card) shows and saves Journal.
- Home and Settings stay Shared, so Settings (export, import, privacy, network, license, updates) is reachable from both workspaces through the drawer, the palette and the native Help menu.
- The `Leaf` and `CloudSun` icons leave `navItems.js`.
- Onboarding: the start hint said "You can switch any time at the top of the window", which is no longer true. It now reads "Budget is for money. Journal is for everything else: writing, habits, todos, your calendar and more. You can switch any time in the menu."

### 3. Calendar and Weather on one page

- One page at `/calendar`, heading and nav label "Calendar & Weather", subtitle "Your events and the local forecast. Add events or import an .ics file." Icon: the existing `Calendar` icon (no new icon bytes; the page is still mainly the calendar).
- The calendar comes first; the forecast follows as a `<section id="weather" aria-label="Weather">` that reuses `WeatherPage` unchanged except for the first card title ("Right now" becomes "Weather now", so the section reads well without a second heading). Weather stays behind the `weather` network opt-in with its off-state copy (`NetworkOptInNotice`); the page asks the local server for the forecast and the server refuses without the opt-in, exactly as the old Weather page and the Home card already do. The forecast is placed below the calendar because the opt-in is off by default, and an opt-in card above the calendar would push the main content down for most users.
- `/weather` stays as a route that redirects to `/calendar#weather` (`<Navigate replace>` with a router-relative `{ pathname, hash }`, so it works under a Vite base subpath). The page scrolls the section into view when the hash is `#weather`, and once more when the calendar has loaded (its height changes). The section has `scroll-margin-top` of the measured top bar height.
- Links that pointed to `/weather` now point to `/calendar#weather`: the Home Weather card. There are no alerts, search results or palette rows with `/weather` (checked); the palette's nav row is "Go to Calendar & Weather", which a "weather" query finds by its label.
- The separate Weather nav item, page route (`src/pages/Weather.jsx`) and lazy chunk are removed. Tab title: "Calendar & Weather · Burrow".

### 4. Javi page keys

- The `weather` page key is removed from `server/javi/pages.js` and `src/constants/javiPages.js` (parity test). `calendar` keeps its key; its label becomes "Calendar & Weather" on both sides. `resolveJaviPageKey('/weather')` returns `calendar`, so a Javi panel opened during the redirect asks about the right page.
- Weather context: the calendar page context gains a `weather` entry built by the existing `buildWeatherContext` (no coordinates, the same status shape when it is loading, off or failing). It is a small change: the merged page builds both and registers one `calendar` builder. Cloud policy: the page is in the `calendar` category, so a withheld calendar withholds the forecast too (stricter than before, when Weather had no category). No prompt wording changes, so `PROMPT_VERSION` stays.
- Inbox (`server/javi/inbox.js`): `weather` was never an inbox page, so `INBOX_PAGES` keeps 11 entries. `normalizeInbox` rebuilds pages over the allowlist only, so an old stored `weather` marker is dropped on read and never breaks the row (new test). `PAGE_WORKSPACE` gains `calendar`, `countdowns` and `bookmarks` as `journal` (the parity test checks it against `workspaceForPath`), and the folder summaries item gets `workspace: 'journal'`, since Folders is now a Journal page.
- `AUTO_STATE_KEYS` is unchanged (`workspace` keeps its two values). Cross insights pair data, not pages, and are unchanged.

### 5. Home

Home cards follow page ownership. Weather, Bookmarks, Countdowns and Calendar become Journal cards (`workspace: 'journal'`). Budget Home then shows the Budget card, plus the Patterns card (Pro) and the data-safety notices.

Owner question (not decided here): Budget Home has a single card. It still works (the card has its own empty state and a link to the Budget page), but it reads sparse next to Journal's ten. Recommendation: keep it for 1.2.0 and pick one follow-up: (a) show Calendar and Countdowns on Budget Home too (bills and paydays are planned there), keeping their pages in Journal, or (b) add a second budget card (for example upcoming subscriptions), which needs its own bytes under the 470 KB budget.

Owner decision (2026-10-10): (b). Budget Home gets a Subscriptions card after the Budget card (`SubscriptionsWidget.jsx`, widget key `subscriptions`): the next 3 subscription charges in the coming 30 days with a relative date, and their total, all from `detectSubscriptions` plus `upcomingCharges` in `src/utils/subscriptions.js` (bills are left out). The detector moved into the lazy `budget-plan` chunk, so the initial load does not grow.

## What moved

| Thing | Before | After |
| --- | --- | --- |
| Workspace switch | Header menu button | Two buttons at the top of the menu |
| Route sync, Alt+1 / Alt+2 | Inside the header switcher | `WorkspaceKeys` in `TopBar` (headless) |
| Life group (Bookmarks, Calendar, Countdowns, Folders, Weather) | Shared, both workspaces | Journal group |
| Weather page `/weather` | Own page and nav item | Section of `/calendar`; `/weather` redirects to `/calendar#weather` |
| Javi `weather` page | Own key | Folded into `calendar` |
| Home Weather, Bookmarks, Countdowns, Calendar cards | Shared | Journal |

## Bundle

The total JS gate is 470 KiB and must not grow against main (468.56 KiB at the start). Removing the menu-button code, the Weather page chunk and two icons pays for the drawer buttons, the redirect and the hash scroll. Measured with `npm run build; npm run check:bundle`: total JS 468.56 KiB on main, 467.72 KiB on this branch (about -860 B gzip); initial JS 144.43 KiB to 143.77 KiB. The 470 KiB budget is unchanged.

## Test plan

- Unit: `navItems` (groups, alphabetical, Journal owns the moved routes, no Life), `BurgerMenu` (switch buttons at the top, pressed state, busy state, click switches and closes, current closes, Tab order), `WorkspaceSwitcher` (drawer control and `WorkspaceKeys`: route sync, Alt keys, guards), `TopBar` (no switcher button), router redirect `/weather` to `/calendar#weather` and the section scroll, Javi page parity and `resolveJaviPageKey('/weather')`, inbox old `weather` key tolerance and the folders item workspace, Home widget filtering per workspace, palette nav rows (one Calendar & Weather row, found by "weather"), the calendar page context with weather.
- e2e (updated, not run here; the QA pass runs them and the visual baselines): `e2e/pages/nav.js` `setWorkspace` uses the drawer; `workspaces.spec.js`, `onboarding.spec.js`, `onboardingJournal.spec.js`, `back.spec.js` and `navigation` routes (`e2e/support/routes.js`) follow the new places.
- Full vitest suite, `npm run lint`, `npm run check`, `npm run build` plus `npm run check:bundle`.
