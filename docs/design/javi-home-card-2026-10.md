# Javi card on Home; Calendar without the weather (2026-10)

Owner request: "javi dm pill shouldnt show in overview and settings. javi should have its own card for summarized insight in overview." Then: "separate calendar from weather. weather should only be shown via javi card in overview". Base: `origin/main` ea4baa5. No Free or Pro change, no new route, no new network feature or host, no migration, no new model call path.

## 1. Where Javi shows

| Route | Javi bar and window | Javi card |
| --- | --- | --- |
| `/` (Home) | none | yes, first card |
| `/settings`, `/settings/*` (Browse your data included) | none | no |
| `/folders` | none (as before) | no |
| every other page | as before | no |

`resolveJaviBarPageKey(pathname)` (`src/constants/javiPages.js`) returns null for Home and Settings, the same mechanism as Folders (no page key): no bar, no window, no Alt+J, no palette Ask, no `pb-16`. `resolveJaviPageKey` and the server allowlist are unchanged (`home`, `settings` and `data-browser` stay valid page keys; the card uses `home`).

Inbox: Home and Settings were never inbox pages, so `INBOX_PAGES` is unchanged. The briefing item still points at `/`: its strip row now closes the window and goes to Home (like the Folders row), and the card marks the briefing read where it renders it (`javi:inbox-read`, which the always-mounted `JaviAdvisor` already handles), but not while it is shown dimmed as a hidden card in Customize. Opening the briefing row in the Javi window also marks it read, so a hidden card never leaves it unread.

## 2. The Javi card

- A Home widget with key `javi`, first in the list and 2 columns wide by default. A layout saved before the card existed gets it at the top once (`useHomeLayout` option `firstKeys`); after the next save the user's order wins. It can be resized or hidden like any card. Javi is not told about the card itself in the Home context.
- Known Pro with today's briefing (never while entitlements are still unknown, as in the old Javi window on Home): the stored briefing (`BriefingMessage`: time line, text, source badge for cloud, withheld note, Report, Write a new briefing). No model call on load.
- Otherwise (Free, Pro without today's briefing, entitlements unknown): Javi greets the user in random humorous, time-appropriate ways (good morning, good night) and automatically requests and provides an overall Home insight without prompting, rendered inside a bounded scrollable container that does not expand as text comes in. A single-shot advice for page `home` runs through its own `useJaviSession({ conversation: false })` (free tier, no earlier messages). The reply shows with where it was computed (also on this computer, since the card has no header badge), Report, the fixed cut-short or ungrounded notice, and an icon-only Refresh insight reload button (`?fresh=1`). Warming, AI setup (`AiUnavailable`) and other errors use the same copy and error row as the Javi window (`AdviceErrorRow`).
- The old "Open today's briefing in Javi" button is gone.
- Shared parts live in `src/components/javi/adviceParts.jsx` and are used by both the window and the card, in their own lazy chunk (`javi-parts` in `vite.config.js`) so Home does not grow the initial load.

## 3. Weather

- Calendar is calendar only: no Weather section, heading "Calendar", nav and palette label "Calendar", Javi page label "Calendar". Its page context has no forecast.
- `/weather` redirects to Home. The Weather Home card, `WeatherPage` and `WeatherWidget` are removed; `useWeather`, `weatherService` and `weatherCodes` stay. An old saved layout that names `weather` is tolerated (the key is dropped).
- While the `weather` opt-in is on, brief weather information (conditions and temperatures) is woven directly into Javi's generated daily insight overview message on Home. With the opt-in off there is no request and no location prompt, only one quiet "Show weather" link to Settings > Network. Location errors and other errors are one muted status line (`role="status"`). Missing days or readings are handled gracefully without placeholders.
- Setup stays in Settings > Network: the Weather row now says "The forecast shows in the Javi card on Home. Burrow uses your location if you allow it when asked." There was no location picker to move: the location comes from the browser's location permission, or the server's configured default. *Updated 2026-10-11: the row now has a Location form and Burrow never asks for the device location by itself, see [weather-location-2026-10.md](weather-location-2026-10.md).*
- Home advice: when a forecast is loaded, the Home context adds it as code-computed facts (no coordinates). The server's Home allowlist (`HOME_KEYS` in `server/ai/privacy.js`) drops it for cloud AI, so only a local or LAN model sees it.

## 4. Visual baselines to regenerate

`home-*`, `calendar-*`, `drawer-open-*`, `drawer-open-all-*`, `settings-*`, `settings-ai-*`, `javi-bar-open-*` (strip row text), `onboarding-*` (Home behind the dialog).
