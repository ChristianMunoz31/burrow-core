# Design guide

A short style guide for Burrow's UI, taken from the code as it is. Read it before you add or change a screen, and send it to the `react-tailwind-reviewer` agent with the diff. The bar is [PRODUCT.md](PRODUCT.md) principle 0: "I downloaded the app, I opened it, and it just worked." So a new screen has friendly empty states, no setup wall and an error that says what to do next. For new visual design, also apply the `frontend-design` skill, but inside the tokens and components below: Burrow is a calm, warm, glassy app, not a place for a second visual language.

Where a rule is enforced, the check is named.

## Tokens

Everything is in `src/index.css` (CSS variables) and `tailwind.config.cjs` (names). Never hard-code a color in a component; use a token so both themes work. The dark theme is `:root`, the light theme is `:root.light` (class on `<html>`; `darkMode: 'class'`).

### Surface and text scale (`--slate-*`, class `slate-slateNNN`)

The scale is semantic and flips with the theme, so the same class reads well in both. Low numbers are strong text, high numbers are surfaces. Do not use Tailwind's own `gray`, `slate` or `zinc` classes.

| Token | Dark | Light | Use |
| --- | --- | --- | --- |
| `slate100` | 236 228 214 | 31 41 55 | Headings, body text on cards (11.8:1 dark, 14.4:1 light) |
| `slate300` | 214 203 186 | 75 85 99 | Secondary buttons, labels (9.3:1, 7.4:1) |
| `slate400` | 171 158 140 | 90 98 112 | Captions, helper text, placeholders (5.7:1, 6.0:1) |
| `slate500` | 168 155 138 | 107 114 128 | Quietest allowed text, icons (5.5:1, 4.7:1) |
| `slate600` to `slate800` | warm darks | near whites | Fills and dividers, never text |

Ratios are the token over the plain page and default glass card. The worst case (the strongest background preset under a card) is what the comments in `index.css` and the tests use. Do not go quieter than `slate500` for text.

### Accent text (`text-accent-<name>`, `--acc-*`)

Colored TEXT uses the adaptive accent tokens: pale in dark, saturated in light. Decorative fills keep the fixed `*Light1` color classes (`red-redLight1`). Names: green, red, yellow, orange, cyan, purple, teal, blue, fuchsia, amber, indigo.

| Token | Dark | Light | Meaning |
| --- | --- | --- | --- |
| `accent-green` | 154 224 149 | 4 108 78 | OK, running, saved (9.5:1, 6.3:1) |
| `accent-red` | 255 166 193 | 185 28 28 | Error, destructive (8.1:1, 6.3:1) |
| `accent-amber` | 251 191 36 | 180 83 9 | Warning, needs a look (8.9:1, 4.9:1) |
| `accent-indigo` | 165 180 252 | 67 56 202 | Links, Javi, focus (7.4:1, 7.8:1) |

Every text color must reach 4.5:1 (WCAG AA, normal text) on its real background, in both themes, including the strongest background preset. A status chip is the accent text on a 15 percent tint of itself, which is the harder case, so it has its own test: `src/utils/__tests__/pillContrast.test.js` computes the chip ratio from `index.css` for the worst light and dark backdrops. Change an `--acc-*` value and that test tells you if a chip stopped passing. Non-text parts (input borders, focus ring) need 3:1; the comments next to `--glass-input-border` and `--focus-ring` record the ratios. Never rely on color alone: pair it with words or an icon.

### Surfaces (glass)

`glass` (cards), `glass-dense`, `glass-strong`, `glass-flat` (inside a blurred overlay), `glass-subtle` (a tile inside a card), `glass-input` (fields), `glass-overlay` (modal scrim), `glass-javi*` (the Javi bar and window). They are token backgrounds with a 1px token border and a soft shadow; radius is added by the component. Never nest one blurred class in another blurred element; inner tiles use `glass-subtle` or `glass-input`.

### Focus

Every control has a visible focus ring: `focus-visible:ring-2` with the slate-blue ring for buttons, `--focus-ring` (indigo, 5.7:1 or better) for inputs and links. Never remove an outline without a replacement.

### Spacing, radius, type

- Spacing is Tailwind's default 4px scale, no custom values. Cards use `p-5`; a card body stacks with `space-y-3` or `space-y-5`; a page is a column of `SectionCard`s with `space-y-5`.
- Radius: `rounded-md` (0.375rem) for buttons and inputs, `rounded-2xl` for cards and dialogs, `rounded-full` for chips. The config overrides `sm`, `md` and `lg`, so check `tailwind.config.cjs` before you use them.
- Type is Inter with a compact scale (the config overrides Tailwind's sizes): `xs` 9px, `sm` 11px, `base` 13px, `lg` 15px, `xl` 17px, `2xl` 21px, `3xl` 23px, `4xl` 27px. Body text is `text-sm`; helper text `text-xs`; card titles `text-sm font-bold tracking-tight`; small caps labels `text-[10px] uppercase tracking-widest`. Weights are 400, 500, 600 and 700. Numbers that line up use `tabular-nums`. Do not put body text in `text-xs` over a busy background.
- Touch targets: icon buttons are `w-9 h-9` on narrow screens and `sm:w-7 sm:h-7` on wide ones. Keep that.

## Components: reuse, do not rebuild

| Need | Use | Path |
| --- | --- | --- |
| Primary, secondary, danger buttons, labels, inputs, field error | `btnPrimary`, `btnSecondary`, `btnDanger`, `labelClass`, `inputClass`, `formErrorClass` | `src/components/shared/formStyles.js` |
| "Add" button that opens a dialog | `AddButton` | `src/components/shared/AddButton.jsx` |
| Small icon buttons (edit, delete) | `IconButton`, `ItemActions` | `src/components/shared/ItemActions.jsx` |
| Card with a title, subtitle, icon and action | `SectionCard` | `src/components/shared/SectionCard.jsx` |
| Home dashboard tile (`WidgetTile` also serves the Budget dashboard's reorder only chart cards: `children` replaces `Component`, `className` is the span class, and the width, height and hide controls show only when `onCycleWidth` is passed, and `dragLabel` names the handle per card, "Move {title}") | `WidgetCard`, `WidgetTile` | `src/components/shared/WidgetCard.jsx`, `src/components/home/WidgetTile.jsx` |
| Javi reply parts (bubble with source badge, Report link and notices, thinking skeleton, advice error row with Retry, briefing message), shared by the Javi window and the Javi card on Home | `TimelineMessage`, `ThinkingSkeleton`, `AdviceErrorRow`, `BriefingMessage` | `src/components/javi/adviceParts.jsx` |
| Dialog (focus trap, Escape, scroll lock, `aria-modal`; sizes `sm`, `md`, `lg`, `full`, where `full` is a chart maximized to almost the whole window) | `Modal` | `src/components/shared/Modal.jsx` |
| Confirm a destructive action | `ConfirmDialog` (`role="alertdialog"`) | `src/components/shared/ConfirmDialog.jsx` |
| Status chip | `PILL` with `TONE_CLASS.ok / warn / muted`; settings button `BTN` | `src/components/settings/pillStyles.js` |
| Switch, segmented choice | `SwitchToggle`, `SegmentedRadio` (takes `hideLegend` to keep the legend as the group name but visually hidden, and `tone="quiet"` for a tinted selected pill, both for a toolbar filter such as the Todos Work/Home/All filter; the default `filled` tone is for settings) | `src/components/settings/` |
| Loading | `Skeleton`, `ListSkeleton`, `WidgetSkeleton`, `PageSkeleton` | `src/components/shared/Skeleton.jsx` |
| Feature the build does not include (core-only build, `PRO_UI_INCLUDED` false) | `NotIncludedNotice`: plain text "This build of Burrow does not include this feature. The official Burrow app includes it at no cost." It never offers to buy, upgrade or start a trial (ADR 0002) | `src/components/shared/NotIncludedNotice.jsx` |
| Feature off until the user opts in to the network | `NetworkOptInNotice` | `src/components/shared/NetworkOptInNotice.jsx` |
| Javi or Ollama not available | `AiUnavailable`, `OllamaSetup`, `WithheldNotice`, `CloudHint` | `src/components/shared/`, `src/components/javi/` |
| Freshness label | `LastUpdated` | `src/components/shared/LastUpdated.jsx` |
| Markdown | `Markdown` (lazy) | `src/components/shared/Markdown.jsx` |
| Go back one page (every route but Home, where the same button shows dimmed and disabled, hidden from assistive technology and out of the tab order, so the header never shifts; Alt+Left and mouse button 4 do the same, ignored in a text field or while a dialog is open) | `BackButton`, `parentPath` | `src/components/shell/BackButton.jsx`, `src/components/shell/routeKey.js` |
| Quiet icon button in the top bar (burger, Back, search, bell, gear: no box at rest, fill on hover, 36x36; `SHELL_ICON_BTN_ACTIVE` for the current place) | `SHELL_ICON_BTN`, `SHELL_ICON_BTN_ACTIVE` | `src/components/shell/shellStyles.js` |
| Icons | `lucide-react`, `size` 14 to 16 | |

Icon-only buttons need an accessible name (`IconButton` takes `label`). Dialogs name themselves with `aria-labelledby`. A new shared component goes in `src/components/shared/` with a test, and replaces a copy, it does not add a second way to do the same thing.

Budget dashboard charts: the three chart cards sit in one `lg:grid-cols-3` grid in a flat, reorderable order (Customize, Done, Reset, saved as `pos:budgetLayout`). Spending by category group always spans the full row. Budget vs. actual (two thirds) and Income vs. expenses (one third) share a row only when they are next to each other, otherwise each takes the full row, and on phones every card is full width. Each card has a Maximize button (hidden while customizing) that opens `Modal` size `full` with the same chart larger. This is the full-window modal, not the browser Fullscreen API.

## Navigation

One source: `NAV_GROUPS` in `src/components/shell/navItems.js`, rendered by the drawer (`BurgerMenu`), the palette's "Go to" rows and the tab title. The menu is Home, Calendar, then Financials (Budget, Subscriptions), Health (Journal, Habits, Sleep & activity) and Productivity (Todos, Notes, Focus, Countdowns, Bookmarks, Folders), in that order (a test checks it). There are no workspaces: every page is always listed and nothing filters by section.

The top bar (`TopBar`) is one calm surface: the burger, Back, the "Burrow" wordmark (a link to Home, `aria-current` on Home), the Dev pill when it applies, then search, the bell and a gear that opens Settings (`aria-current` and a resting fill on `/settings*`). Its controls share `SHELL_ICON_BTN` and have no box of their own; no greeting, date or clock. Settings carries `drawer: false`: it stays in the data (palette row, tab title) and opens from the gear, one click away. Home is the first menu row and also the wordmark.

The drawer has the "Burrow" heading, the Home row, Calendar, then one `role="group"` per section labelled by its dropdown header. The header is a full-width `<button>` inside an `<h3>` with a category icon (`Wallet`, `Heart`, `Layers`, size 16) and a trailing `ChevronDown` (disclosure pattern: `aria-expanded`, `aria-controls` to the section's list; `text-xs font-medium text-slate-slate400`, sentence case, the row hover fill and the global focus ring, turning with `rotate-180` when open); the section's rows are rendered only while it is expanded, with nested indentation (`pl-6 pr-3`) and compact subcategory icons (size 14). The current page's section is open by default and opening the menu always expands it, so the active row is never hidden; other toggles are remembered on this device (`lsKey('nav:sections')`, a map of group id to boolean; anything unreadable means the defaults). The setting `nav:hideSubcategories` (Settings > General, "Hide subcategories in the menu", default off, `app_state`, read through `normalizeNavHideSubcategories`) replaces the dropdowns: each section (Financials, Health, Productivity) renders as one plain link to its first page (Budget, Journal, Todos) with the section icon (size 16, not nested) and the section name, with no disclosure button, no chevron and no nested rows. The link is active, with `aria-current="page"` and the active fill, when any page of its section is the current page, so the menu opens with focus on it. The stored `nav:sections` map is not used for rendering while the setting is on (opening the menu still marks the current page's section open in it) and applies again when the setting is turned off. Every page stays reachable through search (the command palette). The active row is a fill plus `font-semibold`; arrow keys walk the visible links and headers across sections, focus on open is the active row, else Home. Rows and headers are `py-2 sm:py-1.5` (rows 32px on phones and 28px from `sm`, headers 30px and 26px) and sections `pt-1`, so the menu with every section open fits the 960 x 640 desktop window without scrolling (height table in the design of record). Do not reintroduce workspaces, a section filter or a header dropdown in the top bar. A page reaches its parts by hash (`/settings#network`); an old route redirects inside the router (`<Navigate replace>`, `/weather` to Home), never with a hard-coded URL. Design of record: `docs/design/nav-sections-2026-10.md`.

## Copy

- No em dashes or en dashes anywhere (UI, docs, PR text). `npm run check:em-dash` fails the build. Use a period, a comma or a colon.
- Plain words, short sentences, second person ("Check that the data folder can be written to"). No jargon a mainstream user would not know: say "your data folder", not "the data directory"; say "computer", not "host".
- Sentence case for headings, buttons and labels: "Add your first bookmark", not "Add Your First Bookmark". Proper names keep their capitals: Burrow, Javi, Ollama.
- Burrow is "a desktop app with a built-in helper". In store pages, the website and release text, never write "AI service", "access to AI", "AI tools" or "chatbot" (the store copy rule, [PRODUCT.md](PRODUCT.md)). Inside the app the helper is called Javi.
- Say what is true about privacy and cost plainly: "Your data stays on your computer." Burrow is free for everyone ([ADR 0002](adr/0002-free-for-everyone.md)): user-facing copy never says "Pro", "trial", "license key", "Buy", "upgrade", "Founding", an edition name or a price.
- Javi characters: Settings > General has a segmented radio "Javi's character" under the Javi switches (setting `javi:character`, default Butler; Butler, Valet, Concierge, Majordomo, listed in `src/constants/javiCharacters.js`). A character changes only the flavor of Javi's humor, never the name: the assistant is always Javi. The hint under the radio is the character's description plus "Same manners, different humor. Applies to the next insight." Every character keeps the same manners: polite, one quip at most, no math, no emoji, no dashes. All four are selectable in every official build; a build without the module has the Butler text only, and the server uses Butler for a saved value whose text is not registered. The wording the model sees lives in `server/javi/characters.js`.
- Do not blame the user, and do not show raw errors, stack traces, status codes or provider text. Errors come from fixed copy (`src/utils/apiError.js`, `withheldMessage()`).

## Empty states

A list with nothing in it explains itself and offers the next step in one click. Pattern: one plain sentence in `text-sm text-slate-slate400`, then the same button the page uses to add one, labelled for the first time.

```jsx
// src/components/bookmarks/BookmarksPage.jsx
<div className="space-y-3">
  <p className="text-sm text-slate-slate400">No bookmarks yet.</p>
  <AddButton label="Add your first bookmark" onClick={() => crud.openAdd()} />
</div>
```

Other real ones: "No habits yet. Add one to start a streak." (`HabitsPage.jsx`), "No briefing yet. Want me to write one now?" (`BriefingMessage` in `adviceParts.jsx`), "No recurring charges found yet. Subscriptions show up after 4 weekly, 3 monthly, or 2 ..." (`SubscriptionsView.jsx`: an empty state also says when it will fill). A feature that needs an opt-in, or that a core-only build does not include, is not an error: show `NetworkOptInNotice` or `NotIncludedNotice` in the same place, never a blank card or a spinner that never ends. A fresh data folder must show these, never an error wall (`e2e/first-run`).

Loading uses a skeleton, not a spinner with no text.

## Errors

Principle 0: every error says what happened in plain words and exactly what to do next. Pattern: what happened (without blame), then the action, with the place to do it named like the menu path ("Settings > Network").

Real examples from the code:

- `cloud_disabled` (CLAUDE.md, error contracts): "Cloud AI was turned off, so nothing was sent. Try again to use the AI on this computer."
- `AI_BUSY_MESSAGE` (`src/utils/apiError.js`): "Javi is busy with another request. Try again in a moment."
- Javi card on Home (`JaviHomeCard.jsx`, first card, design of record `docs/design/javi-home-card-2026-10.md`): today's briefing when one exists (no model call on load), otherwise Javi greets the user in random humorous, time-appropriate ways (good morning, good night) and always provides an overall insight without prompting, inside a bounded scrollable container that does not expand as text comes in. Weather shows only while the Weather opt-in is on, else one quiet "Show weather" link; with no saved location it is one muted link, "Set your location in Settings to see the weather." (the location is typed in Settings > Network, and the device is asked only on a Use my location click). Home and Settings have no Javi bar.
- Javi panel (`JaviPanel.jsx`): the greeting "Want a quick insight about {pageLabel}?" with Get insight. Follow-ups and chips are core and work in every build; the composer comes from the module and is on in every official build; in a core-only build `NotIncludedNotice` shows where a module feature is missing, with no upgrade hint or link (ADR 0002). The DM strings (header "Javi" with the AI helper tag and "About {pageLabel}", the "New for you" strip, the briefing copy) are in the string table of `docs/design/javi-dm-2026-10.md`; the Javi bar (docked bottom-right, name "Javi, AI helper" or "Javi, AI helper, {n} new for you", "Collapse Javi" in the window) is in section 6 of `docs/design/minimal-shell-2026-10.md`.

Rules: one next step is better than three; a retry that will not help is not offered; a field error uses `formErrorClass` and sits next to its field, with `aria-describedby` or `role="alert"`; a destructive action asks first through `ConfirmDialog`. Never leave the user at a dead end: a failure always keeps their data and says so when it matters ("Your data and everything in Burrow Free keep working.").

## Checklist for a UI change

1. Tokens and shared components only. No new color, no new button style.
2. Light and dark both look right and pass 4.5:1 for text.
3. Keyboard: reachable, visible focus, Escape closes dialogs, names on icon buttons.
4. Empty, loading and error states exist and follow the patterns above.
5. Copy follows the rules above.
6. A modal form has no Cancel: the dialog X, Escape and the backdrop cancel. Confirmations of destructive or consent actions keep their Cancel.
7. `react-tailwind-reviewer` ran on the changed `.jsx`; axe and the contrast test are green; screenshots (light and dark, demo data only) are described in the PR. The steps are in `.claude/commands/ship-feature.md`.
