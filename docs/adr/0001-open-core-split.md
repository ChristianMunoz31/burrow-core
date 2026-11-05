# ADR 0001: Open-core split (AGPL core, private Pro module)

- Status: Proposed, 2026-11-04
- Scope: design only. No product code, test or config changes are made by this ADR.
- Companion docs: [0001-extraction-inventory.md](0001-extraction-inventory.md) (what moves where, in order), [0001-work-split.md](0001-work-split.md) (two teams, frozen interfaces, QA).

> **Copy rule (binding).** Everything below is a plan. Until the owner has created the public core repository, no README, in-app text, store page, Gumroad text or other public copy may say that Burrow is open source, AGPL, or buildable or self-hostable from public source. Internal docs (this ADR, CLAUDE.md, docs/OPEN_CORE.md) may describe the plan as planned.

## 1. Context

| Fact | Evidence |
| --- | --- |
| Pro is gated by capability, but the Pro code lives in core files | `server/pro.js:19-27` (8 used ids), gates in `server.js:427,446,511,613`, `server/crossInsightsRoutes.js:238,256`, `server/folderRoutes.js:229,419,430,438,454`, `server/folders/jobs.js:744,848`, `server/scheduler.js:101` |
| A working build seam already exists for `devtools/` | `server/devExtensions.js`, `server/devExtensionsLoader.js` (+ `.none.js`), `devtools/server/static.js`, `scripts/desktop/workerBundle.js:145-170` (`burrow-dev-tools`), `scripts/build/devToolsUi.js` (`burrow-dev-tools-ui`) |
| The sidecar is a CJS esbuild bundle in a Node SEA: no top-level await, no runtime file import | `scripts/desktop/buildSidecar.js:108-125`; hence the `static.js` swap |
| `startServer` already awaits an extension load before `listen` | `server.js:987` (`await loadDevExtensions()`), listen at `server.js:989-996`, scheduler at `server.js:1013` |
| The scheduler already accepts injected jobs | `server/scheduler.js:71-80` (`briefing`, `folderRescan`) |
| UI bundle is at its budget | `scripts/checks/bundle-budget.json`: total JS 469.83 of 470 KB gzip (0.17 headroom), initial 143.88 of 146 |
| `useJarvis` is in the initial graph | imported eagerly by `src/components/javi/JaviAdvisor.jsx:8`, mounted by `AppShell` |
| The release zip is source | `.github/workflows/release.yml:3-4,246-256`: `git archive` + `dist/`, runnable with `npm ci --omit=dev; npm start`, attached to the private release only |
| Docker runs unbundled source | `Dockerfile` runtime stage copies `server.js`, `server/` and runs `node server.js` |
| The private history contains Pro code and `devtools/` at every commit | `devtools/` is tracked (`.gitattributes:1` is `export-ignore` only, which affects `git archive`, not a push) |

## 2. Decision

| # | Decision (owner decisions 1-9 and design calls D1-D9, as refined here) |
| --- | --- |
| 1 | Core is AGPL-3.0-only (`LICENSE`, `package.json` `"license": "AGPL-3.0-only"`). Pro is proprietary, private, shipped only compiled inside official builds. Pro source never enters the core tree or its history. |
| 2 | Top-level `pro/` is a separate nested git repo (private remote `burrow-pro`, added by the owner), ignored by core (`/pro/` in `.gitignore`, `pro export-ignore` in `.gitattributes`). |
| 3 | `server/license/**`, `server/pro.js` (PRO_FEATURES, requirePro, assertPro, requireProWhen, proAccess) stay core. Every gate for a Pro capability is mounted or evaluated by core code (D1). |
| 4 | Pro plugs in through two seams: server `server/proExtensions.js` (loaded via `server/proExtensionsLoader.js`, the only runtime core file that names `pro/`) and client `src/extensions/proExtensions.js` (swapped for `pro/ui/proExtensions.js` by a Vite plugin). |
| 5 | Inverse of devtools: `pro/` present means included in every build kind; absent means a working Free build. Official release paths refuse to build without `pro/` (`check:pro-present` plus `BURROW_REQUIRE_PRO=1`). |
| 6 | "If Free uses it, core; if only Pro uses it, `pro/`." Exception (D5): code that touches stored data stays core even when only Pro calls it. |
| 7 | Pro reaches data, network and AI only through an explicit two-tier core allowlist (section 3.9). Decision 2's literal list was not enough: Pro code today also needs `integrations.js`, `secrets/index.js`, `weatherLocation.js`, `profile.js`, `todoStatus.js`, `dataGeneration.js`, `scheduledJobGate.js`, `javi/*`, `folders/*` helpers. This ADR refines decision 2 with named tiers. |
| 8 | Public core repo starts from a fresh root commit made by a one-way export; the private repo stays the working repo (section 3.14). |
| 9 | CLA required for the core (CLA Assistant Lite GitHub Action, text in `docs/CLA.md`). |
| 10 | $0: no new hosted service. Public CI runs Free mode; official builds run on the owner's PC or private CI with `pro/` checked out. |

## 3. Module boundary contract

### 3.1 Layout

```
pro/                               nested git repo, ignored by core
  LICENSE                          proprietary notice
  README.md                        private developer notes (how to run Pro tests and evals)
  server/index.js                  default export, section 3.2
  server/static.js                 bundler swap target, section 3.6
  server/agents/ routes/ insights/ folders/ javi/ __tests__/
  ui/proExtensions.js              client extension module, section 3.11
  ui/hooks/ ui/services/ ui/components/ ui/test-utils/ ui/__tests__/
  ui/lazy/pro-<Name>.jsx           lazily loaded Pro components (file name prefix is load-bearing, 3.13)
  e2e/  scripts/  evals/
```

Every Pro source file with extension `.js`, `.jsx` or `.mjs` starts with the private header line (JSON and Markdown files are exempt):

```
// burrow-pro: private source, never part of the public core.
```

`pro/` may import core. Core never imports `pro/` except `server/proExtensionsLoader.js` (runtime) and the build tooling listed in `PRO_PATH_HOLDERS` (section 3.9).

### 3.2 `pro/server/index.js` default export

```js
export default {
  name: 'burrow-pro',          // string, required
  apiVersion: 1,               // must equal PRO_API_VERSION in server/proExtensions.js, else the module is refused
  available(env) { return true; },  // must return exactly true
  install(ctx) { /* synchronous; registers everything through ctx; returns undefined */ },
};
```

A thenable returned by `install` counts as an install failure. Pro modules must not register anything at import time (for example `server/agents/pendingActions.js:113` `onDataReset(...)` becomes `ctx.onDataReset(clearPendingActions)` inside `install`).

### 3.3 `ctx` shape (frozen; every method throws `Error('pro registration closed')` once `install` returned)

```js
ctx = {
  apiVersion: 1,
  env,                      // the env passed to loadProExtensions (process.env by default)
  log,                      // (message: string) => void; codes only, never user data, paths or text
  routes: {
    add({ id, validate = [], handlers }),   // id: a key of PRO_ROUTES (3.4); handlers: non-empty array of functions
  },
  folders: {
    routeHelpers(),         // => { handle(fn), send(res, code), folderOr404(req, res), isPlainBody(body) } (delegating facade)
    setJobHooks({ index = null, report = null }),   // IndexHook, ReportHook (3.7)
  },
  scheduler: {
    register(name, job),    // name: 'briefing' | 'folderRescan'
  },
  javi: {
    registerCharacters(texts),   // { valet?, concierge?, majordomo? }, each with the 8 string fields of the butler entry
  },
  onDataReset(fn),          // () => void; forwarded to server/dataGeneration.js onDataReset, ignored after a rollback
};
```

No prompt registration: no Free code path needs a Pro prompt, and Free prompt scaffolding stays core (`server/javi/advisorPrompt.js`, `server/javi/userName.js`, `server/folders/prompts.js` core part).

Every registration passes a core gate in public code:

| Registration | Core gate (public) | Behaviour when no module is installed |
| --- | --- | --- |
| `routes.add` | `requirePro(feature)` is the first layer, mounted by core (3.4) | fallback route: `requirePro(feature)` then `501 pro_not_included` |
| `folders.setJobHooks.index` | `server/folders/jobs.js` indexPhase: `proAccess('folder_qa')` | `indexSkipped = 'not_pro'` (unchanged semantics, `server/folders/stats.js:81`) |
| `folders.setJobHooks.report` | `server/folders/jobs.js` runReport: `assertPro('folder_report')` | job fails `folder_failed` (the route is a fallback anyway) |
| `scheduler.register('briefing')` | `server/scheduler.js` briefingJob: `assertPro('briefings')` + `aiConfigured()` (unchanged) | job returns silently |
| `scheduler.register('folderRescan')` | `server/scheduler.js` folderJob: `proAccess('folder_auto_rescan')` (new core check; the Pro module keeps its own) | job returns silently |
| `javi.registerCharacters` | `server/javi/characters.js` getCharacter: `proAccess('javi_characters')` and text registered | butler |

### 3.4 Route table and registrar (D1, D2)

`server/proRoutes.js` (core, plain data, frozen) is the public list of every Pro route. Pro cannot add a route outside it and cannot choose the gate.

| id | slot | method | path | feature | pre (folder helpers) | ai |
| --- | --- | --- | --- | --- | --- | --- |
| `jarvis.run` | jarvis | post | `/api/jarvis` | javi_tools | none | `{ purpose: 'tools' }` |
| `jarvis.action` | jarvis | post | `/api/jarvis/actions/:token` | javi_tools | none | `{ purpose: 'tools', enabledOnly: true }` |
| `jarvis.briefingRefresh` | jarvis | post | `/api/jarvis/briefing/refresh` | briefings | none | `{ purpose: 'chat' }` |
| `insights.explain` | insights | post | `/api/insights/explain` | explain | none | null |
| `folders.report` | folders | post | `/api/folders/:id/report` | folder_report | `['aiLimiter']` | null |
| `folders.ask` | folders | post | `/api/folders/:id/ask` | folder_qa | `['aiLimiter', 'requireJson']` | null |

Layer order core mounts for `add({ id, validate, handlers })`: `requirePro(feature)`, then `pre` (resolved per request from the latest folder helpers), then `validate`, then `requireAi(purpose, enabledOnly ? { enabledOnly: true } : undefined)` when `ai` is set, then `handlers`. This reproduces today's order exactly (`server.js:427,511,613`, `crossInsightsRoutes.js:238`, `folderRoutes.js:417-440`). Each gate function core mounts carries a non-enumerable symbol `PRO_GATE` = feature so a test can inspect the stack. `add` throws on an unknown id, a second `add` of the same id, empty `handlers` or a non-function entry.

Slots are routers mounted synchronously by core at today's positions:

| Slot | Mount | Position |
| --- | --- | --- |
| `jarvis` | `app.use(proSlotRouter('jarvis'))` in `server.js` | replaces `server.js:408-549`, right after `GET /api/jarvis/status` (404-406); after the `/api/jarvis` limiters (234-236); before the `/api` 404 (851) |
| `insights` | `app.use(proSlotRouter('insights'))` in `server.js` | replaces `registerCrossInsightsRoutes(app)` at `server.js:396` |
| `folders` | `setFolderRouteHelpers({ handle, send, folderOr404, aiLimiter, requireJson, isPlainBody }); app.use(proSlotRouter('folders'))` inside `registerFolderRoutes` | replaces `server/folderRoutes.js:417-497`, before the `/api/folders` error handler (499-506) |

Each slot router is `outer.use(proRouter); outer.use(fallbackRouter)`. `fallbackRouter` is filled at module load from `PRO_ROUTES` with `requirePro(feature), sendProNotIncluded(feature)`, so Vitest importing `app` gets Free behaviour (403 for Free entitlements, 501 for Pro entitlements) unless a test installs the module.

### 3.5 `server/proExtensions.js` API

```js
export const PRO_API_VERSION = 1;
export const PRO_GATE;                                   // Symbol('burrow.proGate')
export function proSlotRouter(slot)                      // 'jarvis' | 'insights' | 'folders' -> express.Router (singleton per slot)
export function setFolderRouteHelpers(helpers)           // called by registerFolderRoutes; latest call wins
export async function loadProExtensions({ env = process.env, log = console.warn, importer = importProExtension } = {}) // -> Promise<boolean>
export function proModuleActive()                        // true only after a successful install
export function resetProExtensionsForTests()             // empties pro routers, all registries; active=false
```

`loadProExtensions` is idempotent (`active` short-circuit, shared in-flight promise) and does, in order:

1. `if (!proCompiledIn()) return false` (`server/license/channelSeam.js`, 3.10).
2. `ext = await importer()`; a throw logs `pro extensions: failed to load (<code>)` and returns false; `null` returns false without a log.
3. Shape check (`name` string, `apiVersion === PRO_API_VERSION`, `available` and `install` functions), else log `pro extensions: incompatible module`, false.
4. `available(env) === true`, else false.
5. `install(ctx)`; a throw (or thenable) logs `pro extensions: install failed (<code>)`, rolls back every registry (pro routers emptied, scheduler jobs, folder hooks, character texts, data-reset callbacks disabled) and returns false.
6. Close registration, `active = true`, return true.

`startServer` calls `await loadProExtensions()` directly after `await loadDevExtensions()` (`server.js:987`), so before `app.listen` and before `startScheduler`.

### 3.6 Loader trio

| File | Content |
| --- | --- |
| `server/proExtensionsLoader.js` | `isProExtensionNotFound(err)`: `err.code === 'ERR_MODULE_NOT_FOUND'` and `String(err.url ?? err.message)` with `\` replaced by `/` includes `pro/server/index.js`. `importProExtension()`: `(await import('../pro/server/index.js')).default ?? null`, returns null for that not-found error, rethrows anything else. |
| `server/proExtensionsLoader.none.js` | `export async function importProExtension() { return null; }` |
| `pro/server/static.js` | `import ext from './index.js'; export async function importProExtension() { return ext; }` |

### 3.7 Core host registries (exact exports)

| Module | New exports | Change |
| --- | --- | --- |
| `server/scheduler.js` | `registerProScheduledJob(name, job)`, `resetProScheduledJobsForTests()` | `startScheduler` params `briefing` and `folderRescan` default to `undefined`; at run time `run = briefing ?? proJobs.briefing`; no run means return. Imports of `runBriefing` and `runScheduledFolderRescans` removed. folderJob adds `if (!proAccess('folder_auto_rescan').allowed) return;`. |
| `server/folders/jobs.js` | `setFolderProHooks({ index = null, report = null })`, `resetFolderProHooksForTests()` | indexPhase: `setPhase; checkpoint; if (!hooks.index \|\| !proAccess('folder_qa').allowed) { ctx.indexSkipped = 'not_pro'; return; } await hooks.index(indexApi(ctx));`. runReport: `setPhase(job, 'reporting'); assertPro('folder_report'); if (!hooks.report) throw new FolderError('folder_failed'); await hooks.report(reportApi(job));`. `auditScan` (incl. the `folder_index` row) and `runJob` error classification stay core. |
| `server/javi/characters.js` | `registerCharacterTexts(texts)`, `resetCharacterTextsForTests()`, `BUTLER_CHARACTER` | `CHARACTER_IDS` becomes the literal `['butler', 'valet', 'concierge', 'majordomo']` (parity with `src/constants/javiCharacters.js`); `CHARACTERS` export removed; `characterText(id)` returns the registered text or the butler; `getCharacter` returns a non-butler id only when its text is registered and `proAccess('javi_characters').allowed`. |

`IndexHook = (api) => Promise<void>`, `api = { folderId, signal, limits, progress, embed, checkpoint(), readRow(row), isControl(err), addNotice(code, message), skip(reason), limitHit(code) }` where `progress` is `job.progress` (`chunksTotal`, `chunksDone`), `embed` is the mutable `ctx.embed` record (`client`, `ms`, `chunks`, `failed`), `skip` sets `ctx.indexSkipped` (`'no_embed_model' | 'ollama_unavailable' | 'limit'`), `limitHit('index_limit')` adds to `ctx.limitsHit`.

`ReportHook = (api) => Promise<void>`, `api = { folderId, client, signal, limits, auditAllowed(), checkpoint(), addNotice(code, message) }` where `auditAllowed()` is `Boolean(job.dataGen) && !job.dataGen.isStale()`.

These registration functions may be called only by `server/proExtensions.js` and by tests (boundary test, 3.12).

### 3.8 Error contract and `/api/app/info`

| Item | Value |
| --- | --- |
| New error | `501 { error: 'pro_not_included', code: 'pro_not_included', feature, message }`, `Cache-Control: no-store` |
| Copy | `MSG_PRO_NOT_INCLUDED = 'This build of Burrow does not include Burrow Pro features. Your data and everything in Burrow Free keep working.'` (`server/pro.js`; client mirror `PRO_NOT_INCLUDED_COPY` in `src/constants/proFeatures.js`) |
| Server helper | `export function sendProNotIncluded(feature)` in `server/pro.js` returns the middleware |
| Client | `PRO_NOT_INCLUDED = 'pro_not_included'`, `isProNotIncludedError(err)` in `src/utils/apiError.js` |
| Order | Free entitlements always get the existing 403 `pro_required` first (incl. `newer_license_required`); only a request that passes `requirePro` reaches the 501 |
| Fallback paths | exactly the 6 `PRO_ROUTES` paths |
| `/api/app/info` | adds `proModule: boolean` (`proModuleActive()`); `registerAppInfoRoutes(app, { devTools, proModule = proModuleActive })` |
| Docs | add the code to `docs/LICENSING.md` 10.7 error list and `docs/OPEN_CORE.md` |

### 3.9 Pro import allowlist (refinement of owner decision 2)

Single source: `scripts/build/proBoundary.js` exports `PRO_SERVER_CORE_ALLOWLIST`, `PRO_SERVER_PURE`, `PRO_SERVER_BUILTINS`, `PRO_SERVER_BANNED_SOURCE`, `PRO_UI_BANNED_SOURCE`, `PRO_PATH_HOLDERS`. Used by the boundary test (3.12) and the `burrow-pro` esbuild plugin (3.10). Rules apply to non-test files under `pro/server/**` and `pro/ui/**`; `pro/**/__tests__/**`, `pro/scripts/**` and `pro/e2e/**` may import any core file.

Tier A, capability APIs (I/O only through audited core paths). Named imports only from the listed names; `*` means any export (namespace import allowed only for `server/dataAccess.js`).

| Module | Allowed names | Why it is equivalent to the owner's list |
| --- | --- | --- |
| `server/dataAccess.js` | `*` | owner list |
| `server/ai/index.js` | `*` | owner list (AI boundary, consent, scope) |
| `server/netPolicy.js` | `NetworkOptInError`, `assertNetworkEnabled` | owner list |
| `server/networkCall.js` | `recordNetworkCall`, `statusFromHttp` | owner list |
| `server/pro.js` | `*` | owner list |
| `server/license/index.js` | `getEntitlements` | owner list |
| `server/auditHook.js` | `recordAudit` | audit write, owner list ("audit") |
| `server/integrations.js` | `fetchWeather`, `fetchOura` | each call runs `assertNetworkEnabled` then `recordNetworkCall` (`integrations.js:27,38,41,86,144,147`): a netPolicy-gated, audited wrapper |
| `server/secrets/index.js` | `peekSecret` | reads a locally saved key to hand it to `fetchOura`; no transport |
| `server/profile.js` | `getDisplayName` | reads `app_state` through `dataAccess.js` |
| `server/weatherLocation.js` | `resolveWeatherLocation` | reads the saved location through `dataAccess.js` |
| `server/todoStatus.js` | `defaultTodoStatus` | reads todo columns through `db/index.js` select |
| `server/dataGeneration.js` | `captureDataGeneration`, `currentDataGeneration` | reset coordination; `onDataReset` only via `ctx.onDataReset` |
| `server/scheduledJobGate.js` | `isPaused`, `dataBusy` | pause gate |
| `server/javi/inbox.js` | `markRead` | read markers |
| `server/javi/advisorService.js` | `*` | advice service; model calls only through the client passed in |
| `server/javi/characters.js` | `getCharacter`, `characterText`, `normalizeCharacter`, `DEFAULT_CHARACTER`, `CHARACTER_IDS`, `BUTLER_CHARACTER` | text and saved choice |
| `server/folders/store.js` | `*` | the only folder DB access (D5) |
| `server/folders/jobs.js` | `enqueueFolderJob`, `waitForFolderJob`, `cancelFolderJob`, `getFolderJob` | the folder job queue |
| `server/folders/summarize.js` | `askFolderModel`, `reduceNotes`, `retryWhenBusy`, `clipText`, `EmptyOutputError` | model calls through a passed client with a literal `folders` scope |

Tier B, pure helpers (no I/O; each may import only Tier B modules and `node:crypto`, checked by the test): `server/relativeDay.js`, `server/db/errors.js`, `server/javi/pages.js`, `server/javi/groundedNumbers.js`, `server/javi/userName.js` (new), `server/folders/constants.js`, `server/folders/stats.js`, `server/folders/prompts.js`.

`pro/server` everything else is refused:
- `PRO_SERVER_BUILTINS = ['node:crypto']`. Any other bare specifier is refused: every Node built-in with or without `node:` (incl. `net`, `http`, `https`, `http2`, `dns`, `tls`, `dgram`, `child_process`, `worker_threads`, `cluster`, `fs`, `fs/promises`, `vm`, `inspector`, `module`) and every npm package (incl. `express`, `node-fetch`, `undici`, `ws`).
- Any relative import that resolves into `server/` or `server.js` outside Tier A/B, into `src/`, `scripts/` or `devtools/`, or to `server/proExtensions.js` and the registries.
- `PRO_SERVER_BANNED_SOURCE` (checked after stripping comments): `fetch(`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `import(` (dynamic import), `require(`, `globalThis`, `eval(`, `new Function`, `process.` other than `process.env.`.

`pro/ui` rules: imports only relative inside `pro/ui`, `src/**` (never `src/extensions/proExtensions.js`), and npm packages already imported somewhere in `src/`. `PRO_UI_BANNED_SOURCE`: `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, string or template literals starting `http://` or `https://`, `fetch(` whose first argument is not a string or template literal starting `/api/`, `import(` with a non-relative argument.

`PRO_PATH_HOLDERS` (core files allowed to name `pro/`): `server/proExtensionsLoader.js` (the only runtime file), `scripts/build/proBoundary.js`, `scripts/build/proUi.js`, `scripts/desktop/workerBundle.js`, `scripts/desktop/buildSidecar.js`, `scripts/desktop/devDist.js`, `scripts/checks/proPresent.js`, `scripts/checks/coreTreeGuard.js`, `scripts/checks/gitFiles.js`, `scripts/checks/precommit.js`, `scripts/ci/runUnitTests.js`, `scripts/release/exportCore.mjs`, `scripts/release/releaseAuto.mjs`, `scripts/release/releaseLocal.mjs`, `vite.config.js`, `vitest.config.js`, `eslint.config.js`, `tailwind.config.cjs`, `playwright.config.js`, `Dockerfile`, `.dockerignore`, `.gitignore`, `.gitattributes`, `.github/workflows/*.yml`, plus `server/__tests__/**`, `src/**/__tests__/**`, `e2e/**` and Markdown docs.

What this proves and what it does not: see risk R1.

### 3.10 Build seams

| Item | Specification |
| --- | --- |
| Define | `bundleDefine(version, { ..., pro = false })` adds `__BURROW_PRO__: pro ? 'true' : 'false'` (every sidecar and worker bundle) |
| Seam helper | `server/license/channelSeam.js`: `export function proCompiledIn() { return typeof __BURROW_PRO__ !== 'boolean' \|\| __BURROW_PRO__; }` (unbundled true; bundles as baked) |
| Banner | second banner line `/*! BURROW_PRO=on */` or `/*! BURROW_PRO=off */` (after the channel line, which stays first) |
| esbuild plugin | `proPlugin({ requirePro = false, root, exists })`, name `burrow-pro`, in `scripts/desktop/workerBundle.js`, used next to `devToolsPlugin` in `buildSidecar.js` and `buildWorkerSource`. `present = exists(pro/server/static.js)`. `requirePro && !present` throws `An official build needs the Pro module but pro/server/static.js is missing`. `onResolve` of `server/proExtensionsLoader.js` (same samePath check as devtools) returns `pro/server/static.js` when present, else `server/proExtensionsLoader.none.js`. When present, every resolve whose importer is under `pro/server` is checked against 3.9 and fails the build on a violation. When absent, any load under `pro/` fails. |
| requirePro | `buildSidecar.js`: `--require-pro` flag, or `BURROW_REQUIRE_PRO=1`, or `--distribution store`. Without it and without `pro/` the build succeeds as Free with the warning `Building without the Pro module: Free build (BURROW_PRO=off)`. |
| Dist match | `copyToTauri()` calls `checkDistPro(distDir, pro ? 'present' : 'absent')` (new in `scripts/checks/channelMarker.js`) and refuses a server/UI mismatch |
| channelMarker | new flag `--expect-pro present\|absent`, with `--bundle` (banner) and `--dist-dir` (presence of `assets/pro-*.js`) |
| Vite plugin | `scripts/build/proUi.js`: `proUiEnabled({ env = process.env, exists, root } = {})` returns `exists(pro/ui/proExtensions.js)`, throws when `env.BURROW_REQUIRE_PRO === '1'` and it is missing (same rule for `serve` and `build`, every mode). `proUiPlugin(include, { root, platform })`, name `burrow-pro-ui`, `enforce: 'pre'`: `resolveId` swaps the exact `src/extensions/proExtensions.js` for `pro/ui/proExtensions.js` (case-insensitive on win32, like `devToolsUiPlugin`); `load` throws for any id under `pro/` when `!include`; `generateBundle` (include) fails when a chunk containing any `pro/ui` module id has a file name not matching `^assets/pro-`. |
| vite.config.js | plugins add `proUiPlugin(proUiEnabled())`; `codeSplitting.groups` adds `{ name: 'pro', test: /\/pro\/ui\/(?!lazy\/)/, priority: 4, includeDependenciesRecursively: false }` |
| Vitest | `vitest.config.js` has no Vite plugins, so tests always see the core `src/extensions/proExtensions.js`; Pro UI tests `vi.mock` it (work split, frozen interfaces) |
| check:pro-present | `scripts/checks/proPresent.js`, `npm run check:pro-present`; `assertProPresent({ root, distDir, bundle })` requires `pro/server/index.js`, `pro/server/static.js`, `pro/ui/proExtensions.js`, `pro/LICENSE`; with `--dist-dir` also `assets/pro-*.js`; with `--bundle` also the `BURROW_PRO=on` banner. Exit 1 with a fixed message. |
| Release insertion | `scripts/release/buildInstaller.js` `buildInstaller()` after `assertStableBuildEnv` (l97); `scripts/release/buildStore.mjs` `main()` (l449) and `assertWebBuild` (l239, `--expect-pro present`); `scripts/release/releaseLocal.mjs` `checkEnv` (~l656); `scripts/release/releaseAuto.mjs` preflight (l558-570); `.github/workflows/release.yml` desktop job before l821; `.github/workflows/desktop-windows.yml` before l422; `.github/workflows/dev-build.yml` before l169. Each sets `BURROW_REQUIRE_PRO=1` for its builds. `scripts/release/smokeSidecar.js` gains `--expect-pro present\|absent` (checks `/api/app/info` `proModule` and that `POST /api/insights/explain` with `{}` answers 400 when present, 501 when absent, on a fresh trial data dir). |
| Worktrees | `releaseAuto.mjs` records `git -C pro rev-parse HEAD` in `auto-state.json`, refuses a dirty `pro/`, tags the pro repo with the release tag, and adds a pro worktree (`git -C pro worktree add --detach <wt>/pro <proCommit>`) inside every core worktree it creates. `previewBranch.js` worktrees run Free mode (documented). |
| Dev stamp | `scripts/desktop/devDist.js` stamp gains `pro: 'present' \| 'absent'` and the pro HEAD, so `desktop:dev` rebuilds `dist/` when they change |
| Docker | build stage keeps `COPY . .`; adds `RUN mkdir -p /app/.pro-runtime && if [ -d pro/server ]; then cp -r pro/server /app/.pro-runtime/server; fi`; runtime stage `COPY --from=build /app/.pro-runtime/ ./pro/` and `RUN test ! -e pro/ui`. `.dockerignore` adds `pro/.git`, `pro/e2e`, `pro/evals`, `pro/scripts` (`**/__tests__` already excluded). |
| Tailwind | `tailwind.config.cjs` content adds `'./pro/ui/**/*.{js,jsx}'` |
| Checks | `scripts/checks/gitFiles.js` adds `git -C pro ls-files` when `pro/` exists, so `npm run check` (em dash, personal data, keys) covers Pro copy. The pre-commit hook refuses staged paths under `pro/` and staged files containing the private header. |

### 3.11 Client contract

`src/extensions/proDefaults.js` (core) defines the defaults and `PRO_EXTENSION_NAMES` (frozen array of the 10 names below). `src/extensions/proExtensions.js` (core) re-exports the defaults under those names. `pro/ui/proExtensions.js` exports the same 10 names (it may re-export a default from `../../src/extensions/proDefaults.js`). Hooks are static (hook order is stable because the module is a build-time constant); components are `React.lazy(() => import('./lazy/pro-<Name>.jsx'))` rendered by hosts inside `<Suspense fallback={null}>`.

| Export | Kind | Props / return | Core host | Core default and host fallback |
| --- | --- | --- | --- | --- |
| `PRO_UI_INCLUDED` | constant | `boolean` | `src/hooks/useEntitlements.js` (`isFreeUi`, `isProNotIncluded`), `ProGateNotice`, `TrialNotice` | `false` |
| `useJaviAgent` | hook | `() => { messages, tools, actions, pendingCount, running, error, errorCode, errorReason, send(text, { page }), stop(), reset(), respond(token, approve) }` (the `useJarvis` return, `respond` also invalidates the write query keys) | `JaviAdvisor.jsx` | `useNoJaviAgent`: returns frozen `NO_JAVI_AGENT` (`EMPTY_AGENT` fields, `pendingCount: 0`, no-op functions, `respond` resolves `{ status: 'error', name: null }`) |
| `agentToolLabel` | function | `(name: string) => string` | `JaviPanel.jsx` tool chips | `() => ''` |
| `AGENT_UNREACHABLE_MESSAGE` | constant | `string \| null` | `JaviPanel.jsx` agent error row | `null` |
| `JaviComposer` | lazy component | `{ inputRef, prefill: { id, text } \| null, loading: boolean, focusSeq: number, onSend(text) }` | `JaviPanel.jsx` dock | `null`: no dock |
| `ConfirmActionCard` | lazy component | `{ action, onRespond(token, approve) }` | `JaviPanel.jsx` timeline | `null`: `action` items are not rendered |
| `BriefingMessage` | lazy component | `{ announce(text) }` | `JaviHomeCard.jsx` | `null`: `showBriefing` is false |
| `useInsightsExplain` | hook | `({ result, summaryKey }) => { explaining, explanation, error, unavailable, unavailableReason, unavailableMessage, proAttempted, explain() }` | `CrossInsightsCard.jsx` | `useNoInsightsExplain`: `explain()` sets `proAttempted` (shows the existing upsell); other fields empty |
| `FolderAskPanel` | lazy component | `{ folder }` (calls the Pro service itself) | `FolderCard.jsx` | `null`: host renders `<ProGateNotice capability="folder_qa" />` |
| `FolderReportWriter` | lazy component | `{ folder, busy }` (button, errors, Pro service, invalidates folder queries) | `FolderReportCard.jsx` (keeps the free read view of an existing report) | `null`: host renders `<ProGateNotice capability="folder_report" />` |

Upsell parity (D4): disabled controls, `ProPill`, `BuyProLink`, the "Ask follow-up questions with Pro" hint, the character picker with "(Pro)" options and the auto re-scan switch stay core. Hosts compute Free as `isFreeUi(e, feature) = !PRO_UI_INCLUDED || isKnownFree(e, feature)`. `ProGateNotice` shows `PRO_NOT_INCLUDED_COPY` (no buy link) when `isProNotIncluded(e) = !PRO_UI_INCLUDED && e.known && (e.pro \|\| e.proScope === 'features_until')`, else today's behaviour. `TrialNotice` renders nothing when `!PRO_UI_INCLUDED`. Settings > License shows "Burrow Pro features: not included in this build" when `/api/app/info` `proModule` is false.

### 3.12 Boundary tests to add (all core unless marked)

| Test file | Asserts |
| --- | --- |
| `server/__tests__/proExtensions.test.js` | loader with injected importer (null, throw, bad shape, apiVersion mismatch, `available` not true, install throw and thenable with full rollback); idempotent; registration closed after install; `PRO_ROUTES` validation; every route added by a fake module has a `PRO_GATE` first layer with the table feature; Free 403, Pro reaches the sentinel, AI off answers 503 before it; with no module every `PRO_ROUTES` path answers 403 (Free) and 501 (Pro); folder slot sits before the folder error handler; `/api/app/info` `proModule`; scheduler, folder hooks and characters honour their core gates |
| `server/__tests__/proExtensionsCloud.test.js` | `configureCloud()`; a fake route with `ai: { purpose: 'chat' }` gets the cloud client in `res.locals.ai` (makes `server/proExtensions.js` an allowlisted AI consumer) |
| `server/__tests__/proBoundary.test.js` (`// ci:always-run`) | runtime core never imports `pro/` and names it only in `server/proExtensionsLoader.js`; only `PRO_PATH_HOLDERS` name `pro/`; Tier B purity; registries called only from `server/proExtensions.js`; only `pro/**` imports `server/__tests__/helpers/proModule.js`; `.gitignore` has `/pro/`, `.gitattributes` has `pro export-ignore`, `.dockerignore` and `Dockerfile` rules; no core file carries the private header. When `pro/` exists also: Tier A names, Tier B, builtins, banned source for `pro/server`; `pro/ui` rules; every Pro source file carries the header |
| `server/__tests__/proBuild.test.js` (`// ci:always-run`) | `proPlugin` resolves the loader to `.none.js` or `static.js` (fixture root); `requirePro` refuses; banned imports from a fixture `pro/server` fail the bundle; real esbuild bundle of `server.js` without `pro/` has `BURROW_PRO=off` and no Pro route handler text; define table; `channelMarker --expect-pro`; `proUiEnabled`/`proUiPlugin` swap, refusal and chunk-name check on a fixture; `check:pro-present` pass and fail |
| `server/__tests__/proReleaseGuard.test.js` (`// ci:always-run`) | text assertions, like `devToolsStableGuard.test.js`: every release path in 3.10 calls `assertProPresent` or `check:pro-present` and sets `BURROW_REQUIRE_PRO=1`; `ci.yml` and the `release.yml` assets job assert `--expect-pro absent`; `smokeSidecar.js` has `--expect-pro` |
| `server/__tests__/coreTreeGuard.test.js` | `checkCoreTree()` on fixture trees (3.14) |
| updated: `aiBoundary.test.js`, `devToolsBuild.test.js`, `proFeatureRegistry.test.js`, `eraseBoundary.test.js` | see inventory B3 |
| `src/extensions/__tests__/proExtensions.test.js` | core module exports exactly `PRO_EXTENSION_NAMES`, `PRO_UI_INCLUDED === false`, defaults have the documented shapes |
| Pro: `pro/server/__tests__/proModuleContract.test.js` | install registers all 6 routes, both scheduler jobs, both folder hooks, the three characters; scans `pro/server` with the aiBoundary consumer rule (each consumer mapped to a Pro cloud test) |
| Pro: `pro/ui/__tests__/proExtensions.contract.test.js` | the real module exports exactly `PRO_EXTENSION_NAMES`, `PRO_UI_INCLUDED === true`, components are lazy |

### 3.13 Bundle budget (D8)

| Key | Measured over | Budget |
| --- | --- | --- |
| `totalJsGzipKb`, `largestJsGzipKb`, `totalCssGzipKb`, `initialJsGzipKb` | assets not named `pro-*` (core), both modes | unchanged: 470, 125, 31.9, 146 |
| `proTotalJsGzipKb`, `proInitialJsGzipKb` | `assets/pro-*.js` (`pro` group chunk plus `pro-<Name>` lazy chunks) | checked only when Pro assets exist; set from the first measured Pro build rounded up to the next 0.5 KB plus 10 percent, recorded with the owner's OK |
| `combinedTotalJsGzipKb`, `combinedInitialJsGzipKb` | all assets | printed in the table, not enforced (risk R6) |

Free build shrinks: `useJarvis`, the composer, `ConfirmActionCard`, `BriefingMessage` (leaves the `javi-parts` group), explain logic and the folder Ask/Report writer leave core chunks in both modes. `pro/ui/lazy/pro-<Name>.jsx` file names make the lazy chunk names start with `pro-`; the `pro` group keeps statically imported Pro modules out of core chunks; the `burrow-pro-ui` `generateBundle` check fails any build where a `pro/ui` module lands in a non-`pro-` chunk.

### 3.14 Public repository and history (D7)

- The private repo `burrow` stays the owner's working repo with its full history. It is never pushed to a public remote.
- The public repo starts from a fresh root commit made from the output of `npm run export:core -- --out <dir>` (`scripts/release/exportCore.mjs`): `git archive --format=tar HEAD` (honours `export-ignore`; `pro/` is untracked anyway) extracted into `<dir>`, then `checkCoreTree(<dir>)` from `scripts/checks/coreTreeGuard.js`.
- `checkCoreTree` refuses when: any path is under `pro/` or `devtools/`; a non-Markdown file contains the private header; a runtime core file names `pro/` other than the loader; `BURROW_DEV_TOOLS=on` or `BURROW_PRO=on` appears outside their allowlisted holders; any owner-chosen export-ignore path is present (open question O3).
- `exportCore.mjs` also refuses: an `--out` inside the private repo; an `--out` whose `.git` has a remote URL equal to the private repo's `origin` URL or containing `burrow-pro`; a dirty working tree.
- Each later sync is one commit in the public repo, `chore(core): sync from vX.Y.Z`, replacing the whole tree. The public history is its own.
- Contributions: PRs on the public repo, CLA check (`.github/workflows/cla.yml`, active only when the repo variable `BURROW_PUBLIC_CORE` is `true`), owner review. The owner merges the PR on the public repo (contributor credit) and applies the same patch to the private repo with a `Co-authored-by` trailer; the next export must show no diff for it.
- Owner runbook: `docs/PUBLISHING_CORE.md` (Team CLIENT+DOCS): first export, repo creation, CLA enable, copy flip (README, PRODUCT.md, CONTRIBUTING, in-app About, Gumroad pages), sync, contribution intake.

### 3.15 CI (D9)

- `ci.yml` (both repos) runs Free mode only and asserts `channelMarker --expect-pro absent --dist-dir dist`.
- Workflows that build installers or sidecars (`release.yml` desktop job, `desktop-windows.yml`, `dev-build.yml`) check out `burrow-pro` into `pro/` with an owner-provided deploy key secret `BURROW_PRO_DEPLOY_KEY` and run `check:pro-present`. These workflows are export-ignored from the public repo (proposed, O3).
- `npm test` with `pro/` present runs core plus Pro suites; core suites never install the module and pass identically in both modes. QA commands: work split, section 7.

## 4. Build matrix

| Build | `pro/` present | `pro/` absent |
| --- | --- | --- |
| `npm run dev` (Vite) | Pro UI swapped in | core empty module, Free UI |
| `npm start` (unbundled) | loader imports `pro/server/index.js`, `proModule: true` | loader returns null, Pro paths 403/501, `proModule: false` |
| `npm run build` | `dist/` with `assets/pro-*` | Free `dist/`; fails only with `BURROW_REQUIRE_PRO=1` |
| `npm run desktop:sidecar` (stable, direct) | `static.js` bundled, `BURROW_PRO=on`, dist must have Pro chunks | Free sidecar, `BURROW_PRO=off`, warning; fails with `--require-pro` |
| `npm run desktop:sidecar -- --channel dev` | as stable (devtools rules unchanged) | as stable |
| `npm run release:store` (store distribution) | builds | refuses (`check:pro-present`, requirePro implied) |
| Official release (`release:auto`, `release:local`, `release:installer`, release workflows) | builds | refuses |
| Docker (internal) | image holds `pro/server` source and Pro UI in `dist/` | Free image |
| Release zip (`release.yml` assets) | Free only: job never checks out `pro/`, asserts absent (risk R3) | Free |
| Public CI (`ci.yml`) | n/a (never checked out) | Free, asserts absent |
| Vitest | core suites (Free behaviour) plus Pro suites | core suites |
| Playwright | core projects plus `pro-flows` | core projects |
| `npm run desktop:dev` | includes Pro; stamp tracks it | Free |
| `npm run export:core` | output never contains `pro/` or `devtools/` | same |

## 5. Consequences and risks

| # | Risk or consequence | Evidence | Handling |
| --- | --- | --- | --- |
| R1 | "Pro can't phone home" is only partly verifiable by third parties. Pro runs in the same Node process (and the same SEA bundle) as core; the import allowlist is enforced by a public test and a public esbuild plugin, but only where the Pro source exists (the owner's builds). Outsiders can verify the rules, the core network paths, the Network activity page and audit rows, not the Pro source. | same-process ESM; `buildSidecar.js:108-125` single bundle | Public copy must say "Pro can only use the public, audited core APIs; this rule is enforced in our build", never "you can verify Pro's source". Owner decision 2 is feasible only in this weaker sense. |
| R2 | Owner decision 4 ("only one core file may name `pro/`") is infeasible for build tooling, which must name the swap targets, exactly as devtools does today | `scripts/build/devToolsUi.js:16`, `scripts/desktop/workerBundle.js:149`, `vitest.config.js:38,50`, `tailwind.config.cjs:7`, `Dockerfile` (`test ! -e devtools`) | Refined: one runtime file; tooling limited to `PRO_PATH_HOLDERS`, enforced by `proBoundary.test.js` |
| R3 | Owner decision 5 says Pro is included in the release zip, but the zip is source (`git archive` plus `dist/`, run with `npm start`); including Pro means shipping Pro source or adding a new compiled-Pro step | `release.yml:3-4,246-256` | Resolved here: the zip is Free-only (core source plus Free `dist/`) with a statement in its README section; it is attached to the private release only. Alternatives in O1. |
| R4 | Docker with `pro/` contains Pro source (runtime is unbundled) | `Dockerfile` runtime stage | Docker stays internal (CLAUDE.md); an image built with `pro/` must never be pushed to any registry. Confirm (O7). |
| R5 | Owner decision 5 "stable builds must refuse without `pro/`" conflicts with decision 6 (public tree fully functional, desktop is the consumer delivery) if read literally | `package.json` `desktop:sidecar`, `desktop:build` default to stable | Refined: official release paths refuse; a local stable build without `pro/` is a Free build marked `BURROW_PRO=off` that no publish path accepts (O6) |
| R6 | Bundle headroom is 0.17 KB; splitting Pro modules into own chunks adds cross-chunk overhead, so the combined Pro build total may pass 470 by a few hundred bytes | `bundle-budget.json` | Core keys measured on core chunks (they shrink); Pro keys separate; combined printed only |
| R7 | The local trial still starts in a Free build, so a self-built copy shows "Pro" entitlements without Pro UI and uses up the data folder's trial | `docs/PRODUCT.md` 2026-10-07 reverse trial | UI shows "not included in this build"; changing trial start is O2 |
| R8 | `javi_conversation` (multi-turn advice) stays core code behind the core gate, so a public build with a trial or license serves follow-ups. The same holds for the gate logic of `javi_characters` (texts are Pro) | `server/javiAdvisorRoutes.js:42,60-67`, `server/javi/validateAdvice.js:97,121` | Accepted: the code is advice plumbing Free already uses; moving it would duplicate the advisor and its cloud rules. The Free UI has no entry point for it (chips render only when `!isFreeUi`). |
| R9 | Worktrees and `git clean -x` lose `pro/` | `scripts/release/releaseAuto.mjs` worktrees (`releaseAuto.test.js:801`), `docs/SELF_HOSTED_RUNNER.md:196` | pro worktree per core worktree, pinned commit in `auto-state.json`; CI checks out `pro/` after the clean |
| R10 | A nested repo can be committed into core by mistake (`git add -A` after moving `pro/` aside inside the repo) | `.gitignore` covers only `/pro/` | pre-commit refusal; QA moves `pro/` outside the repo |
| R11 | Many core tests reach Pro routes today and rely on the fresh-data-dir trial for Pro | inventory B3 (about 80 test files touch Pro surface) | moved or split in the same step as the code they cover; core gates stay core so gate tests stay core |
| R12 | Rolldown group naming and `includeDependenciesRecursively` behaviour are assumptions | `vite.config.js:97-148` | the `burrow-pro-ui` `generateBundle` check fails the build if wrong |
| R13 | Licensing: official builds combine AGPL core with proprietary Pro. Lawful only because the owner holds copyright in all core code and the CLA grants the owner the right to relicense contributions (including in proprietary builds). Any copyleft third-party dependency (GPL, AGPL, or LGPL bundled statically) in the shipped bundles would block this. | `THIRD_PARTY_NOTICES.md` | QA verifies dependency licenses before the first export; official builds need their own license notice (O5) |
| R14 | Tauri Local-AI Starter Kit: kit code derived from Burrow core must come from owner-authored or CLA-covered commits; the CLA must allow sublicensing in separately sold products | `docs/PRODUCT.md` 2026-10-05 multi-product strategy | `docs/CLA.md` grants it; `docs/OPEN_CORE.md` lists the provenance check (commit authors of copied files vs. CLA signatures) |
| R15 | The CLA text is legal text | n/a | owner legal review before enabling `cla.yml` |

Other consequences: about 1,200 client and 3,500 server source lines move to `pro/`; `server/agents/` leaves core; `npm run eval:ai` leaves `package.json` (Pro script); `server/__tests__/helpers/*` stay core and are imported by Pro tests.

## 6. Alternatives considered

- **Work directly in the public repo, move `devtools/` into the Pro repo.** No export step, contributor PRs merge directly, authentic public history. But `devtools/` would need a second seam into another repo, every private-only file (release automation, runner scripts, owner docs, store identity config) would have to move out or be published, release worktrees would pin two repos for every build, and the only protection against committing private code publicly would be a hook. Rejected for the first publication; revisit after two releases on the export model.
- **Pro as an npm package or git submodule.** A submodule records the private repo URL and commit in the public tree; a package needs a private registry (hosted service, decision 9). Rejected.
- **Pro mounts its own Express routes (devtools model).** Simpler, but "every Pro route is gated" would no longer be checkable from public code (D1). Rejected.
- **Runtime sandbox for Pro (worker thread or child process with no network).** Would make R1 stronger, but needs an IPC layer over every core API, breaks the SEA single-bundle model and slows Javi. Rejected for now; noted as the only path to outsider-verifiable isolation.
- **Release zip with compiled Pro** (esbuild bundle of `pro/server` with core imports external, Pro UI only in `dist/`). Feasible but a new build path for an artifact only attached privately. Kept as option O1(b).

## 7. Open questions for the owner

| # | Question | Proposed default |
| --- | --- | --- |
| O1 | Release zip: (a) Free-only core source plus Free `dist/`; (b) compiled Pro inside; (c) drop the zip | (a) |
| O2 | Should the automatic 14-day trial start in builds without the Pro module? | keep as is now (no license-code change in this split); revisit |
| O3 | Export-ignore beyond `pro/` and `devtools/` | `.claude/`, `.github/workflows/release.yml`, `desktop-windows.yml`, `dev-build.yml`, `release-please.yml`, `scripts/runner/`, `docs/release-runbook-*.md`, `docs/SELF_HOSTED_RUNNER.md`, `config/msstore.json` |
| O4 | Public repo name and account; CLA flavour | CLA Assistant Lite action, signatures in a `cla-signatures` branch of the public repo |
| O5 | License notice or EULA for official (combined) builds | owner to provide before the first public export |
| O6 | Accept local stable desktop builds without `pro/` as Free builds (`BURROW_PRO=off`) | yes |
| O7 | Confirm Docker images built with `pro/` stay internal and unpublished | yes |
