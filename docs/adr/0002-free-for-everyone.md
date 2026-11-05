# ADR 0002: Burrow is free for everyone

- Status: Accepted, 2026-11-05 (owner decision)
- Supersedes: the paid tier, trial and license parts of [docs/LICENSING.md](../LICENSING.md) and the "Free / Pro" tiering in [0001-open-core-split.md](0001-open-core-split.md). The open-core split itself (decisions 1, 2, 4, 5, 8, 9 and 10 of ADR 0001) stays.

## 1. Context

Until now Burrow had a free tier, a 14-day local trial and a one-time Burrow Pro purchase (Standard, Founding and Family editions, plus Student and Nonprofit keys), verified offline after a Gumroad or Lemon Squeezy activation. Every Pro capability (`server/pro.js` `PRO_FEATURES`) was checked by core gates (`requirePro`, `requireProWhen`, `assertPro`, `proAccess`) that read `getEntitlements()` from `server/license/`. The UI read `/api/license` for the trial countdown, the License settings section, the Buy button, Pro pills, upgrade prompts and the Founding member badge.

The owner decided that Burrow is free of charge for everyone, with no trial and no time limit. The private `pro/` module stays closed source and is still compiled into every official build.

## 2. Decision

| # | Decision |
| --- | --- |
| 1 | No tiers. Every capability that was Pro (Javi questions and approved changes, characters, daily briefings, Explain, folder questions, folder reports, scheduled folder re-scan, the founder theme) is available to every install of an official build. |
| 2 | The only remaining condition is technical: is the private module compiled into this build. `proModuleActive()` (server) and `PRO_UI_INCLUDED` (client) answer it. There is no entitlement, license, trial or clock state any more. |
| 3 | The licensing subsystem is removed, not stubbed: license activation and deactivation, the Gumroad and Lemon Squeezy verify calls, the activation store, the trial store and notices, the clock guard, editions and terms, the Store per-feature rule, `/api/license*`, `config/store.json` and its check. A resolver that always answered "Pro" would have left about 2,000 lines of unreachable code and a network path to a store that no longer sells anything. |
| 4 | The gate helpers that read entitlements (`requirePro`, `requireProWhen`, `assertPro`, `proAccess`, `isProEnabled`, `ProRequiredError`, `403 pro_required`) are removed. `PRO_FEATURES` stays as the registry of capabilities that the private module provides, so `server/proRoutes.js`, the `501 pro_not_included` fallback and the module contract are unchanged. |
| 5 | The seam stays exactly as ADR 0001 built it: `pro/` nested repo, `server/proExtensions.js` and its loader, `src/extensions/proExtensions.js` and the `burrow-pro-ui` Vite plugin, `BURROW_PRO=on/off`, `BURROW_REQUIRE_PRO=1`, `check:pro-present`, `check:licenses`, `export:core`, and every publish path refusing a build without `pro/`. |
| 6 | A core-only build (`BURROW_PRO=off`, or the public core repo) answers every module route with `501 pro_not_included`. The UI shows "not included in this build" for those features. It never offers to buy, upgrade or start a trial, because there is nothing to buy. |
| 7 | Data left by older versions is kept harmless: the legacy file names (`license-activation.json`, `license-clock.json`, `license-trial.json`, `license.burrowlicense*`) and the `LICENSE_STORE_KEY` secret stay listed so Erase still removes them and backup import still skips them. Nothing reads them. |
| 8 | Build-channel facts that happened to live under `server/license/` (`buildInfo.js`, `channelSeam.js` and the build constants) stay where they are to avoid churn in the release scripts. They are not licensing code. Renaming the folder is an optional follow-up. |
| 9 | Javi characters (Butler, Valet, Concierge, Majordomo) are all selectable; the purple-and-gold founder theme is a normal theme choice. The "Founding member" badge is removed. |
| 10a | Erase all my data no longer keeps anything license related: the legacy `license.*` rows, files and the `LICENSE_STORE_KEY` secret are erased with everything else, and the `removeLicense` option is gone. The direct-Burrow import no longer copies license files (`secrets.key` is still copied, it encrypts saved API keys). |
| 10b | The support address moves from `config/store.json` to `config/support.json` (`supportContact`), which the privacy page generator, the About menu and the Report content draft read. `config/store.json` and `npm run check:store-config` are removed. |
| 10c | The developer tier switcher in `devtools/` is removed. The devtools seam stays (loader, Vite plugin, channel markers, release guards) with a minimal placeholder: `GET /api/dev/status` and a Settings > Developer card that says developer tools are on. Its route marker replaces `/dev/license` in the build guards. |
| 10d | Fixed copy for a feature the build lacks (server `MSG_PRO_NOT_INCLUDED`, client `PRO_NOT_INCLUDED_COPY`): "This build of Burrow does not include this feature. The official Burrow app includes it at no cost." User-facing copy never says "Pro". |
| 10e | The network feature `license` (Gumroad, Lemon Squeezy) is removed from `server/netFeatures.js` and from the published privacy page. |
| 10 | `scripts/release/syncGumroad.mjs` (`npm run release:gumroad`) is no longer a required release step. It stays in the repo, unused, until the owner decides about the Gumroad listing. |

## 3. Consequences

- Updates are never blocked by an "update window": any version installs and runs fully.
- Fewer moving parts at startup: no clock guard write, no trial file, no license file read.
- The two existing buyers keep a working app with every feature; refunds are an owner decision outside the code.
- The public core alone still builds and runs; it simply lacks the private module's features and says so.
- Store listing text, Partner Center fields and the public core repo are updated by the owner (see the PR description).
