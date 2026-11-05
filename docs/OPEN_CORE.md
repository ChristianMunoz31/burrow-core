# Open core: the module boundary

Internal developer document. It describes the open-core split of [ADR 0001](adr/0001-open-core-split.md) in plain words: what lives in core, what lives in the private `pro/` module, and the exact contract between them.

**Status: planned.** The split is implemented in the private repo. The core has not been published. Until the owner has created the public core repository (runbook: [PUBLISHING_CORE.md](PUBLISHING_CORE.md)), no README, in-app text, store page, Gumroad text or other public copy may say that Burrow is open source, AGPL, or buildable or self-hostable from public source. This document may describe the plan as planned.

## 1. The idea in one paragraph

Burrow core is planned to be published under AGPL-3.0-only. Pro features live in `pro/`, a separate private git repo that is nested inside the core checkout and ignored by it. Core owns every gate: a Pro capability is always checked by public core code (`server/pro.js`, `server/license/**`), and the Pro module can only plug into a fixed list of places. It reaches data, the network and AI only through a named list of audited core APIs (section 5). With `pro/` present, every build includes Pro. With `pro/` absent you get a working Free build.

Rule for placing code: if Free uses it, it is core. If only Pro uses it, it goes in `pro/`. Exception: code that touches stored data stays core even when only Pro calls it (for example `server/folders/store.js`).

Public wording about the isolation (risk R1): "Pro can only use the public, audited core APIs; this rule is enforced in our build." Never write "you can verify Pro's source". Pro runs in the same Node process as core, and the allowlist is enforced by a public test and a public esbuild plugin, but only where the Pro source exists (the owner's builds).

## 2. Layout of `pro/`

```
pro/                               nested git repo, ignored by core (/pro/ in .gitignore)
  LICENSE                          proprietary notice
  README.md                        private developer notes
  server/index.js                  default export (section 3)
  server/static.js                 bundler swap target (section 4)
  server/agents/ routes/ insights/ folders/ javi/ __tests__/
  ui/proExtensions.js              client extension module (section 6)
  ui/hooks/ ui/services/ ui/components/ ui/test-utils/ ui/__tests__/
  ui/lazy/pro-<Name>.jsx           lazily loaded Pro components (the pro- prefix is load-bearing)
  e2e/  scripts/  evals/
```

Every Pro source file with extension `.js`, `.jsx` or `.mjs` starts with this private header line. JSON and Markdown files are exempt.

```
// burrow-pro: private source, never part of the public core.
```

`pro/` may import core. Core never imports `pro/`, except `server/proExtensionsLoader.js` (the only runtime file) and the build tooling listed in `PRO_PATH_HOLDERS` (section 5).

## 3. The server module

`pro/server/index.js` default-exports:

```js
export default {
  name: 'burrow-pro',               // string, required
  apiVersion: 1,                    // must equal PRO_API_VERSION in server/proExtensions.js, else the module is refused
  available(env) { return true; },  // must return exactly true
  install(ctx) { /* synchronous; registers everything through ctx; returns undefined */ },
};
```

A thenable returned by `install` counts as an install failure. A Pro module must not register anything at import time: call `ctx.onDataReset(...)` inside `install`, never at module top level.

### 3.1 `ctx`

`ctx` is frozen in shape. Every method throws `Error('pro registration closed')` once `install` has returned.

| Member | Meaning |
| --- | --- |
| `apiVersion` | `1` |
| `env` | The env passed to `loadProExtensions` (`process.env` by default) |
| `log(message)` | Codes only. Never user data, paths or text |
| `routes.add({ id, validate = [], handlers })` | `id` is a key of `PRO_ROUTES`; `handlers` is a non-empty array of functions |
| `folders.routeHelpers()` | `{ handle(fn), send(res, code), folderOr404(req, res), isPlainBody(body) }` |
| `folders.setJobHooks({ index = null, report = null })` | The `IndexHook` and `ReportHook` of the folder job queue |
| `scheduler.register(name, job)` | `name` is `'briefing'` or `'folderRescan'` |
| `javi.registerCharacters(texts)` | `{ valet?, concierge?, majordomo? }`, each with the 8 string fields of the butler entry |
| `onDataReset(fn)` | Forwarded to `server/dataGeneration.js` `onDataReset`; ignored after a rollback |

There is no prompt registration. Free prompt scaffolding stays core (`server/javi/advisorPrompt.js`, `server/javi/userName.js`, the core part of `server/folders/prompts.js`).

### 3.2 Every registration passes a core gate

| Registration | Core gate (public) | Behaviour when no module is installed |
| --- | --- | --- |
| `routes.add` | `requirePro(feature)` is the first layer, mounted by core | Fallback route: `requirePro(feature)` then `501 pro_not_included` |
| `folders.setJobHooks.index` | `server/folders/jobs.js` index phase: `proAccess('folder_qa')` | `indexSkipped = 'not_pro'` |
| `folders.setJobHooks.report` | `server/folders/jobs.js` report run: `assertPro('folder_report')` | The job fails with `folder_failed` (the route is a fallback anyway) |
| `scheduler.register('briefing')` | `server/scheduler.js` briefing job: `assertPro('briefings')` plus `aiConfigured()` | The job returns silently |
| `scheduler.register('folderRescan')` | `server/scheduler.js` folder job: `proAccess('folder_auto_rescan')` (the Pro module keeps its own check too) | The job returns silently |
| `javi.registerCharacters` | `server/javi/characters.js` `getCharacter`: `proAccess('javi_characters')` and a registered text | Butler |

### 3.3 The 6 Pro routes (`server/proRoutes.js`)

`server/proRoutes.js` is plain frozen data and the public list of every Pro route. Pro cannot add a route outside it and cannot choose the gate.

| id | slot | method | path | feature | pre (folder helpers) | ai |
| --- | --- | --- | --- | --- | --- | --- |
| `jarvis.run` | jarvis | post | `/api/jarvis` | `javi_tools` | none | `{ purpose: 'tools' }` |
| `jarvis.action` | jarvis | post | `/api/jarvis/actions/:token` | `javi_tools` | none | `{ purpose: 'tools', enabledOnly: true }` |
| `jarvis.briefingRefresh` | jarvis | post | `/api/jarvis/briefing/refresh` | `briefings` | none | `{ purpose: 'chat' }` |
| `insights.explain` | insights | post | `/api/insights/explain` | `explain` | none | null |
| `folders.report` | folders | post | `/api/folders/:id/report` | `folder_report` | `['aiLimiter']` | null |
| `folders.ask` | folders | post | `/api/folders/:id/ask` | `folder_qa` | `['aiLimiter', 'requireJson']` | null |

For `add({ id, validate, handlers })` core mounts these layers in this order: `requirePro(feature)`, then `pre` (resolved per request from the latest folder helpers), then `validate`, then `requireAi(purpose, enabledOnly ? { enabledOnly: true } : undefined)` when `ai` is set, then `handlers`. Each gate function core mounts carries a non-enumerable symbol `PRO_GATE` equal to the feature, so a test can inspect the stack. `add` throws on an unknown id, a second `add` of the same id, empty `handlers` or a non-function entry.

Slots are routers that core mounts synchronously: `jarvis` in `server.js` (after `GET /api/jarvis/status`, before the `/api` 404), `insights` in `server.js`, and `folders` inside `registerFolderRoutes` (before the `/api/folders` error handler). Each slot router is the Pro router followed by a fallback router that core fills at module load from `PRO_ROUTES`. So a test that imports `app` sees Free behaviour (403 for Free entitlements, 501 for Pro entitlements) unless it installs the module.

### 3.4 `server/proExtensions.js`

| Export | Meaning |
| --- | --- |
| `PRO_API_VERSION` | `1` |
| `PRO_GATE` | `Symbol('burrow.proGate')` |
| `proSlotRouter(slot)` | `'jarvis'`, `'insights'` or `'folders'`; one `express.Router` per slot |
| `setFolderRouteHelpers(helpers)` | Called by `registerFolderRoutes`; the latest call wins |
| `loadProExtensions({ env, log, importer })` | `Promise<boolean>` |
| `proModuleActive()` | True only after a successful install |
| `resetProExtensionsForTests()` | Empties the Pro routers and all registries; `active = false` |

`loadProExtensions` is idempotent and does, in order:

1. `if (!proCompiledIn()) return false` (`server/license/channelSeam.js`).
2. `ext = await importer()`. A throw logs `pro extensions: failed to load (<code>)` and returns false. `null` returns false without a log.
3. Shape check (`name` string, `apiVersion === PRO_API_VERSION`, `available` and `install` functions). Otherwise it logs `pro extensions: incompatible module` and returns false.
4. `available(env) === true`, else false.
5. `install(ctx)`. A throw (or a thenable) logs `pro extensions: install failed (<code>)`, rolls back every registry (Pro routers emptied, scheduler jobs, folder hooks, character texts, data-reset callbacks disabled) and returns false.
6. Close registration, `active = true`, return true.

`startServer` calls `await loadProExtensions()` right after `await loadDevExtensions()`, so before `app.listen` and before `startScheduler`.

### 3.5 The loader trio

| File | Content |
| --- | --- |
| `server/proExtensionsLoader.js` | `isProExtensionNotFound(err)` and `importProExtension()`: imports `../pro/server/index.js`, returns null when that file is not found, rethrows anything else |
| `server/proExtensionsLoader.none.js` | `export async function importProExtension() { return null; }` |
| `pro/server/static.js` | `import ext from './index.js'; export async function importProExtension() { return ext; }` |

The sidecar is a CJS esbuild bundle in a Node SEA, with no top-level await and no runtime file import, so the build swaps the loader for `static.js` (Pro present) or `.none.js` (Pro absent). See section 8.

### 3.6 Host registries in core

Pro registers into these. They may be called only by `server/proExtensions.js` and by tests (the boundary test checks it).

| Module | Exports |
| --- | --- |
| `server/scheduler.js` | `registerProScheduledJob(name, job)`, `resetProScheduledJobsForTests()` |
| `server/folders/jobs.js` | `setFolderProHooks({ index, report })`, `resetFolderProHooksForTests()` |
| `server/javi/characters.js` | `registerCharacterTexts(texts)`, `resetCharacterTextsForTests()`, `BUTLER_CHARACTER` |

`IndexHook = (api) => Promise<void>` with `api = { folderId, signal, limits, progress, embed, checkpoint(), readRow(row), isControl(err), addNotice(code, message), skip(reason), limitHit(code) }`. `ReportHook = (api) => Promise<void>` with `api = { folderId, client, signal, limits, auditAllowed(), checkpoint(), addNotice(code, message) }`. The field meanings are in ADR 3.7.

## 4. The error `501 pro_not_included`

| Item | Value |
| --- | --- |
| Status and body | `501 { error: 'pro_not_included', code: 'pro_not_included', feature, message }`, header `Cache-Control: no-store` |
| Fixed copy | `MSG_PRO_NOT_INCLUDED` = "This build of Burrow does not include Burrow Pro features. Your data and everything in Burrow Free keep working." (`server/pro.js`; the client mirror is `PRO_NOT_INCLUDED_COPY` in `src/constants/proFeatures.js`, identical text) |
| Server helper | `sendProNotIncluded(feature)` in `server/pro.js` returns the middleware |
| Client | `PRO_NOT_INCLUDED = 'pro_not_included'` and `isProNotIncludedError(err)` in `src/utils/apiError.js` |
| Order | A Free entitlement always gets the existing `403 pro_required` first (including `newer_license_required`). Only a request that passes `requirePro` reaches the 501 |
| Where | Exactly the 6 `PRO_ROUTES` paths, when no module is installed |
| `/api/app/info` | Adds `proModule: boolean` (`proModuleActive()`) |

The error is also listed in [LICENSING.md](LICENSING.md) section 10.7.

## 5. The import allowlist (two tiers)

Single source: `scripts/build/proBoundary.js` exports `PRO_SERVER_CORE_ALLOWLIST`, `PRO_SERVER_PURE`, `PRO_SERVER_BUILTINS`, `PRO_SERVER_BANNED_SOURCE`, `PRO_UI_BANNED_SOURCE` and `PRO_PATH_HOLDERS`. It is used by the boundary test (`server/__tests__/proBoundary.test.js`) and by the `burrow-pro` esbuild plugin. The rules apply to non-test files under `pro/server/**` and `pro/ui/**`. `pro/**/__tests__/**`, `pro/scripts/**` and `pro/e2e/**` may import any core file.

### 5.1 Tier A: capability APIs (I/O only through audited core paths)

Named imports only from the listed names. `*` means any export (a namespace import is allowed only for `server/dataAccess.js`).

| Module | Allowed names |
| --- | --- |
| `server/dataAccess.js` | `*` |
| `server/ai/index.js` | `*` |
| `server/netPolicy.js` | `NetworkOptInError`, `assertNetworkEnabled` |
| `server/networkCall.js` | `recordNetworkCall`, `statusFromHttp` |
| `server/pro.js` | `*` |
| `server/license/index.js` | `getEntitlements` |
| `server/auditHook.js` | `recordAudit` |
| `server/integrations.js` | `fetchWeather`, `fetchOura` (each runs `assertNetworkEnabled` then `recordNetworkCall`) |
| `server/secrets/index.js` | `peekSecret` |
| `server/profile.js` | `getDisplayName` |
| `server/weatherLocation.js` | `resolveWeatherLocation` |
| `server/todoStatus.js` | `defaultTodoStatus` |
| `server/dataGeneration.js` | `captureDataGeneration`, `currentDataGeneration` (`onDataReset` only through `ctx.onDataReset`) |
| `server/scheduledJobGate.js` | `isPaused`, `dataBusy` |
| `server/javi/inbox.js` | `markRead` |
| `server/javi/advisorService.js` | `*` |
| `server/javi/characters.js` | `getCharacter`, `characterText`, `normalizeCharacter`, `DEFAULT_CHARACTER`, `CHARACTER_IDS`, `BUTLER_CHARACTER` |
| `server/folders/store.js` | `*` |
| `server/folders/jobs.js` | `enqueueFolderJob`, `waitForFolderJob`, `cancelFolderJob`, `getFolderJob` |
| `server/folders/summarize.js` | `askFolderModel`, `reduceNotes`, `retryWhenBusy`, `clipText`, `EmptyOutputError` |

### 5.2 Tier B: pure helpers

No I/O. Each may import only Tier B modules and `node:crypto` (the test checks it): `server/relativeDay.js`, `server/db/errors.js`, `server/javi/pages.js`, `server/javi/groundedNumbers.js`, `server/javi/userName.js`, `server/folders/constants.js`, `server/folders/stats.js`, `server/folders/prompts.js`.

### 5.3 What is refused in `pro/server`

- Builtins: `PRO_SERVER_BUILTINS = ['node:crypto']`. Any other bare specifier is refused: every Node built-in with or without the `node:` prefix (including `net`, `http`, `https`, `http2`, `dns`, `tls`, `dgram`, `child_process`, `worker_threads`, `cluster`, `fs`, `fs/promises`, `vm`, `inspector`, `module`) and every npm package (including `express`, `node-fetch`, `undici`, `ws`).
- Any relative import that resolves into `server/` or `server.js` outside Tier A and Tier B, into `src/`, `scripts/` or `devtools/`, or to `server/proExtensions.js` and the registries.
- Banned source (`PRO_SERVER_BANNED_SOURCE`, checked after stripping comments): `fetch(`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `import(` (dynamic import), `require(`, `globalThis`, `eval(`, `new Function`, and `process.` other than `process.env.`.

### 5.4 `pro/ui` rules

- Imports only: relative inside `pro/ui`, `src/**` (never `src/extensions/proExtensions.js`), and npm packages that are already imported somewhere in `src/`.
- `PRO_UI_BANNED_SOURCE`: `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, string or template literals starting `http://` or `https://`, `fetch(` whose first argument is not a string or template literal starting `/api/`, and `import(` with a non-relative argument.

### 5.5 `PRO_PATH_HOLDERS`

The core files that may name `pro/`: `server/proExtensionsLoader.js` (the only runtime file), `scripts/build/proBoundary.js`, `scripts/build/proUi.js`, `scripts/desktop/workerBundle.js`, `scripts/desktop/buildSidecar.js`, `scripts/desktop/devDist.js`, `scripts/checks/proPresent.js`, `scripts/checks/coreTreeGuard.js`, `scripts/checks/gitFiles.js`, `scripts/checks/precommit.js`, `scripts/ci/runUnitTests.js`, `scripts/release/exportCore.mjs`, `scripts/release/releaseAuto.mjs`, `scripts/release/releaseLocal.mjs`, `vite.config.js`, `vitest.config.js`, `eslint.config.js`, `tailwind.config.cjs`, `playwright.config.js`, `Dockerfile`, `.dockerignore`, `.gitignore`, `.gitattributes`, `.github/workflows/*.yml`, plus `server/__tests__/**`, `src/**/__tests__/**`, `e2e/**` and Markdown docs. Build tooling has to name the swap targets, exactly as it already does for `devtools/`.

What this proves and what it does not: see the R1 wording in section 1.

## 6. The client extension points

`src/extensions/proDefaults.js` (core) defines the defaults and `PRO_EXTENSION_NAMES` (a frozen array of the 10 names below). `src/extensions/proExtensions.js` (core) re-exports the defaults under those names. `pro/ui/proExtensions.js` exports the same 10 names (it may re-export a default from `../../src/extensions/proDefaults.js`). The Vite plugin `burrow-pro-ui` swaps the exact path `src/extensions/proExtensions.js` for `pro/ui/proExtensions.js` when the Pro file exists.

Hooks are static, because the module is a build-time constant. Components are `React.lazy(() => import('./lazy/pro-<Name>.jsx'))` and are rendered by the core hosts inside `<Suspense fallback={null}>`.

| Export | Kind | Props or return | Core host | Core default and host fallback |
| --- | --- | --- | --- | --- |
| `PRO_UI_INCLUDED` | constant | `boolean` | `src/hooks/useEntitlements.js` (`isFreeUi`, `isProNotIncluded`), `ProGateNotice`, `TrialNotice` | `false` |
| `useJaviAgent` | hook | `() => { messages, tools, actions, pendingCount, running, error, errorCode, errorReason, send(text, { page }), stop(), reset(), respond(token, approve) }` | `JaviAdvisor.jsx` | `useNoJaviAgent`: a frozen `NO_JAVI_AGENT` with empty fields, `pendingCount: 0`, no-op functions, and `respond` resolving `{ status: 'error', name: null }` |
| `agentToolLabel` | function | `(name: string) => string` | `JaviPanel.jsx` tool chips | `() => ''` |
| `AGENT_UNREACHABLE_MESSAGE` | constant | `string \| null` | `JaviPanel.jsx` agent error row | `null` |
| `JaviComposer` | lazy component | `{ inputRef, prefill: { id, text } \| null, loading, focusSeq, onSend(text) }` | `JaviPanel.jsx` dock | `null`: no dock |
| `ConfirmActionCard` | lazy component | `{ action, onRespond(token, approve) }` | `JaviPanel.jsx` timeline | `null`: `action` items are not rendered |
| `BriefingMessage` | lazy component | `{ announce(text) }` | `JaviHomeCard.jsx` | `null`: `showBriefing` is false |
| `useInsightsExplain` | hook | `({ result, summaryKey }) => { explaining, explanation, error, unavailable, unavailableReason, unavailableMessage, proAttempted, explain() }` | `CrossInsightsCard.jsx` | `useNoInsightsExplain`: `explain()` sets `proAttempted` (shows the existing upsell), other fields empty |
| `FolderAskPanel` | lazy component | `{ folder }` (calls the Pro service itself) | `FolderCard.jsx` | `null`: the host renders `<ProGateNotice capability="folder_qa" />` |
| `FolderReportWriter` | lazy component | `{ folder, busy }` | `FolderReportCard.jsx` (keeps the free read view of an existing report) | `null`: the host renders `<ProGateNotice capability="folder_report" />` |

### 6.1 `isFreeUi` and `isProNotIncluded`

Upsell parity: disabled controls, `ProPill`, `BuyProLink`, the "(Pro)" options of the character picker and the auto re-scan switch stay in core.

- `isFreeUi(e, feature) = !PRO_UI_INCLUDED || isKnownFree(e, feature)` (`src/hooks/useEntitlements.js`). Core hosts use it so a build without the Pro UI never shows a control it cannot serve.
- `isProNotIncluded(e) = !PRO_UI_INCLUDED && e.known && (e.pro || e.proScope === 'features_until')`. When it is true, `ProGateNotice` shows `PRO_NOT_INCLUDED_COPY` with no buy link. Otherwise it behaves as before.
- `TrialNotice` renders nothing when `!PRO_UI_INCLUDED`.
- Settings > License shows "Burrow Pro features: not included in this build" when `/api/app/info` `proModule` is false.

## 7. Bundle budget

Core budget keys are measured over assets not named `pro-*`, in both modes, and are unchanged: total JS 470, largest JS 125, total CSS 31.9, initial JS 146 (KB gzip). `proTotalJsGzipKb` and `proInitialJsGzipKb` measure `assets/pro-*.js` and are checked only when Pro assets exist. Combined totals are printed, not enforced. The `burrow-pro-ui` plugin fails the build when a `pro/ui` module lands in a chunk whose file name does not match `^assets/pro-`, which is why lazy files are named `pro/ui/lazy/pro-<Name>.jsx`.

## 8. Build matrix

| Build | `pro/` present | `pro/` absent |
| --- | --- | --- |
| `npm run dev` (Vite) | Pro UI swapped in | Core empty module, Free UI |
| `npm start` (unbundled) | Loader imports `pro/server/index.js`, `proModule: true` | Loader returns null, Pro paths answer 403 or 501, `proModule: false` |
| `npm run build` | `dist/` with `assets/pro-*` | Free `dist/`; fails only with `BURROW_REQUIRE_PRO=1` |
| `npm run desktop:sidecar` (stable, direct) | `static.js` bundled, `BURROW_PRO=on`, `dist/` must have Pro chunks | Free sidecar, `BURROW_PRO=off`, warning; fails with `--require-pro` |
| `npm run desktop:sidecar -- --channel dev` | As stable (devtools rules unchanged) | As stable |
| `npm run release:store` | Builds | Refuses (`check:pro-present`, require-pro implied) |
| Official release (`release:auto`, `release:local`, `release:installer`, release workflows) | Builds | Refuses |
| Docker (internal) | Image holds `pro/server` source and the Pro UI in `dist/` | Free image |
| Release zip (`release.yml` assets) | Free only: the job never checks out `pro/` and asserts absent | Free |
| Public CI (`ci.yml`) | Not applicable (never checked out) | Free, asserts absent |
| Vitest | Core suites (Free behaviour) plus Pro suites | Core suites |
| Playwright | Core projects plus `pro-flows` | Core projects |
| `npm run desktop:dev` | Includes Pro; the stamp tracks it | Free |
| `npm run export:core` | Output never contains `pro/` or `devtools/` | Same |

Build seams (ADR 3.10):

- esbuild plugin `burrow-pro` (`proPlugin` in `scripts/desktop/workerBundle.js`, used next to `devToolsPlugin`) swaps `server/proExtensionsLoader.js` for `pro/server/static.js` or for `server/proExtensionsLoader.none.js`, checks every import under `pro/server` against section 5, and with `requirePro` fails with "An official build needs the Pro module but pro/server/static.js is missing".
- The define `__BURROW_PRO__` and the banner line `/*! BURROW_PRO=on */` or `/*! BURROW_PRO=off */` (second banner line, after the channel line). `proCompiledIn()` in `server/license/channelSeam.js` reads the define.
- Require-pro is on with `--require-pro`, `BURROW_REQUIRE_PRO=1` or `--distribution store`. Without it and without `pro/`, `buildSidecar.js` succeeds as Free with the warning `Building without the Pro module: Free build (BURROW_PRO=off)`.
- `node scripts/checks/channelMarker.js --expect-pro present|absent` (with `--bundle` for the banner and `--dist-dir` for `assets/pro-*.js`) and `node scripts/release/smokeSidecar.js --expect-pro present|absent` verify what was built.
- `npm run check:pro-present` (`scripts/checks/proPresent.js`) requires `pro/server/index.js`, `pro/server/static.js`, `pro/ui/proExtensions.js` and `pro/LICENSE`, and exits 1 with a fixed message when one is missing.

## 9. Working with and without `pro/`

### With `pro/` (the owner)

`pro/` is its own git repo with its own remote, the private `burrow-pro`. Clone it as a nested repo inside the core checkout:

```powershell
git clone <burrow-pro remote URL> pro
npm run check:pro-present     # exit 0 when the module is complete
```

Core ignores it (`/pro/` in `.gitignore`, `pro export-ignore` in `.gitattributes`), so core `git status` never lists it. Commit Pro changes with `git -C pro ...` and push them to `burrow-pro`. Never commit anything under `pro/` to the core repo: the pre-commit hook refuses staged paths under `pro/` and staged files that contain the private header line.

`npm test` runs the core suites plus the Pro suites when `pro/` is present. To run only the Pro suites: `npx vitest run pro/ui pro/server`.

Tests that need the Pro UI mock the core seam with the real module:

```js
// burrow-pro: private source, never part of the public core.
const pro = vi.hoisted(() => ({ real: null }));
vi.mock('../../../src/extensions/proExtensions.js', async () =>
  (await import('../test-utils/proExtensionsMock.js')).proExtensionsMockFactory(pro));
// ...the test's imports...
pro.real = await import('../proExtensions.js');
```

The ADR's literal form `vi.mock('<rel>/src/extensions/proExtensions.js', async () => await import('<rel>/pro/ui/proExtensions.js'))` deadlocks Vitest: the Pro module's hooks import `src/hooks/useEntitlements.js`, which imports the mocked module while its factory is still pending. `pro/ui/test-utils/proExtensionsMock.js` returns one getter per `PRO_EXTENSION_NAMES` entry that reads the real module at render time, so the effect is the same: the real Pro module replaces the core one.

Vitest has no Vite plugins, so tests always see the core `src/extensions/proExtensions.js` (Free behaviour) unless they mock it like this. Server tests that need the Pro module call `installProModuleForTests()` and `uninstallProModuleForTests()` from `server/__tests__/helpers/proModule.js`. Only files under `pro/` may import that helper. Core suites never install the module and pass identically in both modes.

### Without `pro/` (Free mode, and QA)

To test Free mode, move `pro/` OUTSIDE the repo, run the core checks, and move it back:

```powershell
Move-Item pro "$env:TEMP\burrow-pro-aside"
git status --porcelain          # must not list anything under pro
# ... core checks ...
Move-Item "$env:TEMP\burrow-pro-aside" pro
git -C pro status --short       # expect no output
```

Never rename `pro/` to another name inside the repo. It would show up as untracked core files and a later `git add -A` could commit a nested repo into core (risk R10). The full QA command lists for both modes are in [adr/0001-work-split.md](adr/0001-work-split.md) section 7.

Preview branch worktrees (`npm run preview:branch`) have no `pro/` and run in Free mode.

## 10. Provenance rule for the Tauri Local-AI Starter Kit (risk R14)

The Tauri Local-AI Starter Kit is a separately sold product. Any kit code that is copied from Burrow core must come from owner-authored commits or from commits covered by a signed CLA ([CLA.md](CLA.md)), and the CLA must allow sublicensing in separately sold products (it does).

Before each kit release:

1. List the Burrow core files copied into the kit.
2. For each file, list the commit authors (`git log --format='%an <%ae>' -- <file>`; after publication also check the public repo history).
3. Check every author who is not the owner against the CLA signatures (the `cla-signatures` branch of the public repo).
4. If any author is not covered, do not ship that file. Rewrite it or get a signed CLA first.

## 11. Owner decisions (2026-11-04)

These answer the open questions O1 to O7 of the ADR.

| # | Decision |
| --- | --- |
| O1 | The release zip is Free-only source (core source plus the Free `dist/`), attached to the private release only. The assets job never checks out `pro/` and asserts `--expect-pro absent`. |
| O2 | The 14-day trial is unchanged in Free builds. The UI says Pro features are not included in this build. |
| O3 | The public export excludes `.claude/`, `.github/workflows/release.yml`, `desktop-windows.yml`, `dev-build.yml` and `release-please.yml`, `scripts/runner/`, release runbooks (`docs/release-runbook-*.md`, `docs/SELF_HOSTED_RUNNER.md`) and `config/msstore.json`, in addition to `pro/` and `devtools/`, which are always excluded. |
| O4 | The public repo name is the owner's call. Recommended default in [PUBLISHING_CORE.md](PUBLISHING_CORE.md): rename the private repo to `ChristianMunoz31/burrow-dev`, create the public `ChristianMunoz31/burrow`, and keep `burrow-pro` private for the Pro module. CLA: CLA Assistant Lite GitHub Action, signatures in a `cla-signatures` branch. |
| O5 | [EULA.md](EULA.md) is the draft end-user license notice for official builds that combine the AGPL core with the proprietary Pro module. Draft, needs legal review. |
| O6 | Local stable builds without `pro/` are allowed as Free builds (`BURROW_PRO=off`) and are never publishable. |
| O7 | Docker images built with `pro/` are internal only and are never published to any registry. |

## 12. Related documents

- [adr/0001-open-core-split.md](adr/0001-open-core-split.md): the contract this document summarizes.
- [PUBLISHING_CORE.md](PUBLISHING_CORE.md): owner runbook for the first publication, sync and contribution intake.
- [CLA.md](CLA.md) and [EULA.md](EULA.md): drafts, need legal review.
- [LICENSING.md](LICENSING.md) sections 10.7 and 15: the error code and the gated features.
- [RELEASING.md](RELEASING.md): which release paths need `pro/`.
