# ADR 0001 work split: two teams, no shared files

> **Note (2026-11-05):** the tiering parts (Free and Pro tiers, entitlement gates, trial and upsell UI) are superseded by [ADR 0002](0002-free-for-everyone.md). Burrow is free for everyone. The split mechanics stay. Kept as written history.

Companion to [0001-open-core-split.md](0001-open-core-split.md) (contract, "ADR") and [0001-extraction-inventory.md](0001-extraction-inventory.md) (moves, "B"). Status: Proposed, 2026-11-04. Planned work only: no public copy may claim open source, AGPL or self-hosting until the owner created the public repo.

## 1. Ownership rules

- Team SERVER+BUILD (S) and Team CLIENT+DOCS (C) run in parallel and never edit the same file. A team that needs a change in the other team's file sends a one-line request; it does not edit.
- `pro/` is one nested git repo. S creates it (step S2, day 1) and owns `pro/server/**`, `pro/scripts/**`, `pro/evals/**`. C owns `pro/ui/**`, `pro/e2e/**`, `pro/LICENSE`, `pro/README.md`. Both teams commit to branch `feat/open-core-split` in the core repo and in the pro repo, each only its own paths.
- `.github/`: S owns `.github/workflows/**` (incl. the new `cla.yml`); C owns every other file under `.github/` (`pull_request_template.md`; `CODEOWNERS` and `dependabot.yml` need no change). The CLA text lives at `docs/CLA.md` (C), so no `.github` file is shared.
- Docs: C owns every Markdown file outside `docs/adr/` and `evals/` (one exception: `THIRD_PARTY_NOTICES.md` is S, because `buildSidecar.js` ships it and the license audit is S work), including `docs/RELEASING.md` and `docs/EVALS.md`. S sends C a list of release and eval command changes in its PR description.

## 2. Team SERVER+BUILD file list

| Action | Files |
| --- | --- |
| Create (core) | `server/proRoutes.js`, `server/proExtensions.js`, `server/proExtensionsLoader.js`, `server/proExtensionsLoader.none.js`, `server/javi/userName.js`, `server/__tests__/helpers/proModule.js`, `server/__tests__/proExtensions.test.js`, `server/__tests__/proExtensionsCloud.test.js`, `server/__tests__/proBoundary.test.js`, `server/__tests__/proBuild.test.js`, `server/__tests__/proReleaseGuard.test.js`, `server/__tests__/coreTreeGuard.test.js`, `scripts/build/proBoundary.js`, `scripts/build/proUi.js`, `scripts/checks/proPresent.js`, `scripts/checks/coreTreeGuard.js`, `scripts/release/exportCore.mjs`, `.github/workflows/cla.yml` |
| Create (pro) | `pro/server/index.js`, `pro/server/static.js`, `pro/server/agents/*` (9 moved files incl. split `prompts.js`), `pro/server/routes/jarvis.js`, `pro/server/routes/insights.js`, `pro/server/routes/folders.js`, `pro/server/insights/explain.js`, `pro/server/folders/{ask,vectors,scheduled,chunk,prompts,summarize,indexPhase,report}.js`, `pro/server/javi/characters.js`, `pro/server/__tests__/*` (B3 moves, twins, `proModuleContract.test.js`, `eraseBoundary.pro.test.js`), `pro/scripts/evalAi.js`, `pro/scripts/evalJaviPro.js`, `pro/scripts/javiEvalProPaths.js`, `pro/evals/*` |
| Edit (core) | `server.js`, `server/pro.js`, `server/license/channelSeam.js`, `server/appInfoRoutes.js`, `server/scheduler.js`, `server/folderRoutes.js`, `server/folders/jobs.js`, `server/folders/chunk.js`, `server/folders/prompts.js`, `server/folders/summarize.js`, `server/javi/characters.js`, `server/javi/advisorPrompt.js`, `server/__tests__/*` per B3, `scripts/desktop/workerBundle.js`, `scripts/desktop/buildSidecar.js`, `scripts/desktop/devDist.js`, `scripts/checks/channelMarker.js`, `scripts/checks/bundleBudget.js`, `scripts/checks/bundle-budget.json`, `scripts/checks/gitFiles.js`, `scripts/checks/precommit.js`, `scripts/release/buildInstaller.js`, `scripts/release/buildStore.mjs`, `scripts/release/releaseLocal.mjs`, `scripts/release/releaseAuto.mjs`, `scripts/release/smokeSidecar.js`, `scripts/ci/runUnitTests.js`, `scripts/evalJavi.js`, `package.json`, `vite.config.js`, `vitest.config.js`, `eslint.config.js`, `tailwind.config.cjs`, `.gitattributes`, `.gitignore`, `.dockerignore`, `Dockerfile`, `.github/workflows/ci.yml`, `release.yml`, `desktop-windows.yml`, `dev-build.yml`, `evals/*` and `evals/README.md`, `THIRD_PARTY_NOTICES.md` (only if the license audit finds a gap), `devtools/server/__tests__/proTierMatrix.test.js` |
| Delete (core, moved) | `server/agents/` (all 9 files), `server/crossInsightsRoutes.js`, `server/folders/ask.js`, `server/folders/vectors.js`, `server/folders/scheduled.js`, `scripts/evalAi.js`, the B3 whole-file test moves |

## 3. Team CLIENT+DOCS file list

| Action | Files |
| --- | --- |
| Create (core) | `src/extensions/proDefaults.js`, `src/extensions/proExtensions.js`, `src/extensions/__tests__/proExtensions.test.js`, `src/components/home/__tests__/CrossInsightsCard.states.test.jsx`, `docs/OPEN_CORE.md`, `docs/PUBLISHING_CORE.md`, `docs/CLA.md` |
| Create (pro) | `pro/ui/proExtensions.js`, `pro/ui/hooks/{useJarvis,useBriefingRefresh,useInsightsExplain}.js`, `pro/ui/services/{crossInsightsService,foldersProService}.js`, `pro/ui/lazy/{pro-ConfirmActionCard,pro-JaviComposer,pro-BriefingMessage,pro-FolderAskPanel,pro-FolderReportWriter}.jsx`, `pro/ui/components/SearchModelPrompt.jsx`, `pro/ui/test-utils/sseResponse.js`, `pro/ui/__tests__/*` (B5 moves, twins, `proExtensions.contract.test.js`), `pro/e2e/flows/{javi,javiDmBriefing,javiDm.pro}.spec.js`, `pro/e2e/pages/javiPro.js`, `pro/LICENSE`, `pro/README.md` |
| Edit (core) | `src/components/javi/JaviPanel.jsx`, `JaviAdvisor.jsx`, `adviceParts.jsx`, `src/hooks/useBriefing.js`, `src/hooks/useEntitlements.js`, `src/hooks/useFolders.js`, `src/services/foldersService.js`, `src/components/shell/NotificationBell.jsx`, `src/components/home/JaviHomeCard.jsx`, `CrossInsightsCard.jsx`, `src/components/folders/FolderCard.jsx`, `FolderReportCard.jsx`, `FoldersPage.jsx`, `src/components/settings/GeneralSection.jsx` (only if `isFreeUi` is applied there), `LicenseSection.jsx`, `src/pages/Settings.jsx`, `src/components/license/ProGateNotice.jsx`, `TrialNotice.jsx`, `src/utils/apiError.js`, `src/constants/proFeatures.js`, `src/**/__tests__/*` per B5, `e2e/**` per B6, `e2e/__screenshots__/**` (regenerated), `playwright.config.js`, `LICENSE`, `README.md`, `CONTRIBUTING.md`, `CLAUDE.md`, `docs/PRODUCT.md`, `docs/LICENSING.md`, `docs/RELEASING.md`, `docs/EVALS.md`, `.github/pull_request_template.md` |
| Delete (core, moved) | `src/hooks/useJarvis.js`, `src/components/javi/ConfirmActionCard.jsx`, `src/services/crossInsightsService.js`, `src/components/folders/FolderAskPanel.jsx`, `src/components/folders/SearchModelPrompt.jsx`, `src/test-utils/sseResponse.js` (if unused by core), the B5 whole-file test moves |
| Request to S | "In `package.json` set `"license"` to `"AGPL-3.0-only"`." (S applies it in S9) |

Doc content C must deliver (copy rule applies: planned wording only, no "open source"/"AGPL" claim in README, in-app text or store copy until the public repo exists):
- `LICENSE`: the canonical AGPL-3.0 text (verbatim from the FSF, check it with `npm run check:em-dash`) preceded by `Burrow core. Copyright (C) 2026 the Burrow authors. Licensed under AGPL-3.0-only. The Pro module (pro/) is not part of this repository and is not covered by this license.` The LICENSE file is not public copy while the repo is private.
- `pro/LICENSE`: proprietary notice (all rights reserved, no redistribution, shipped only inside official builds).
- `docs/OPEN_CORE.md`: the module boundary in plain words (ADR 3.2-3.11), the allowlist tiers, the error code `pro_not_included`, the provenance rule for the Starter Kit (ADR R14), how to work with and without `pro/`.
- `docs/PUBLISHING_CORE.md`: owner runbook for ADR 3.14: run `npm run export:core`, create the public repo, first commit, enable `cla.yml` (repo variable `BURROW_PUBLIC_CORE=true`, `cla-signatures` branch), copy flip list (README, `docs/PRODUCT.md`, CONTRIBUTING, in-app About and Settings, Gumroad pages), sync procedure, contribution intake (merge public PR, apply patch privately with `Co-authored-by`).
- `docs/CLA.md`: individual CLA granting the owner a perpetual copyright and patent license with the right to sublicense and relicense, including in proprietary products and separately sold kits (legal review by the owner, ADR R15).
- `docs/LICENSING.md`: add `pro_not_included` (501) to 10.7; section 15 points to `server/proRoutes.js` and `docs/OPEN_CORE.md`.
- `CLAUDE.md`, `CONTRIBUTING.md`: `pro/` workflow, new commands (`check:pro-present`, `export:core`), `eval:ai` now `node pro/scripts/evalAi.js`, QA in both modes.

## 4. Shared-file resolutions

| File | Owner | Other team's dependency | Resolution |
| --- | --- | --- | --- |
| `src/constants/javiCharacters.js`, `src/constants/javiPages.js` | C | S parity tests import them | frozen: unchanged in this split |
| `src/extensions/proExtensions.js` (path) | C | S's `burrow-pro-ui` plugin swaps this exact path | path frozen (section 5) |
| `scripts/build/proUi.js`, `vite.config.js` | S | C relies on the `pro` group and `pro-` lazy file names | frozen (section 5); S lands them in S2 before C2 |
| `scripts/build/proBoundary.js` | S | C's `pro/ui` code must pass the UI rules | rules frozen in ADR 3.9; changes only on C's request |
| `server/__tests__/proBoundary.test.js` | S | scans `pro/ui` | C runs it before every merge |
| `e2e/support/burrowServer.js` | C | S's QA uses `distDir` | C adds `startBurrow({ distDir })` and `BURROW_E2E_DIST_DIR` in C7 |
| `scripts/ci/runUnitTests.js` | S | `pro/ui` tests need selection | S adds `pro` in S2 |
| `vitest.config.js` | S | `pro/ui` test globs | S adds `pro/ui/**/__tests__/**/*.test.{js,jsx}` (frontend) and `pro/server/**/__tests__/**/*.test.js` (backend) in S2 |
| `tailwind.config.cjs` | S | `pro/ui` classes | S adds `./pro/ui/**/*.{js,jsx}` in S2 |
| `.gitignore`, `.gitattributes` | S | none | S2 |
| `package.json` | S | C's license field request | S9 |
| `devtools/server/**` / `devtools/ui/**` | S / C | none expected for `devtools/ui` | S edits only `proTierMatrix.test.js` |
| `CLAUDE.md`, `docs/RELEASING.md`, `docs/EVALS.md` | C | describe S's tooling | S lists the changes in its PR descriptions |
| `server/__tests__/helpers/*` | S | Pro server tests import them | unchanged except new `proModule.js` |

## 5. Frozen cross-team interfaces (copied from the ADR; changing one needs both teams)

| Interface | Exact value |
| --- | --- |
| Server loader seam | `server/proExtensionsLoader.js` `importProExtension(): Promise<object \| null>`, `isProExtensionNotFound(err)`; `.none.js` returns null; `pro/server/static.js` returns the bundled default export |
| Module shape | `{ name: string, apiVersion: 1, available(env) => true, install(ctx) => undefined }` |
| `ctx` | `{ apiVersion, env, log, routes: { add({ id, validate = [], handlers }) }, folders: { routeHelpers(), setJobHooks({ index, report }) }, scheduler: { register('briefing' \| 'folderRescan', job) }, javi: { registerCharacters(texts) }, onDataReset(fn) }` |
| Route ids and slots | `jarvis.run`, `jarvis.action`, `jarvis.briefingRefresh` (slot `jarvis`); `insights.explain` (slot `insights`); `folders.report`, `folders.ask` (slot `folders`); table in ADR 3.4 |
| Core API | `proSlotRouter(slot)`, `setFolderRouteHelpers(helpers)`, `loadProExtensions({ env, log, importer })`, `proModuleActive()`, `resetProExtensionsForTests()`, `PRO_API_VERSION = 1`, `PRO_GATE` |
| Hooks | `IndexHook(api)`, `ReportHook(api)` with the api fields of ADR 3.7 |
| Error | `501 { error: 'pro_not_included', code: 'pro_not_included', feature, message }`; copy `MSG_PRO_NOT_INCLUDED` / `PRO_NOT_INCLUDED_COPY` (identical text, ADR 3.8) |
| `/api/app/info` | `data.proModule: boolean` |
| esbuild plugin | `proPlugin({ requirePro, root, exists })`, name `burrow-pro`; define `__BURROW_PRO__`; banner `/*! BURROW_PRO=on */` or `off`; `proCompiledIn()` |
| Vite plugin | `proUiEnabled({ env, exists, root })`, `proUiPlugin(include, { root, platform })`, name `burrow-pro-ui`; swaps `src/extensions/proExtensions.js` for `pro/ui/proExtensions.js` |
| Pro UI entry | `pro/ui/proExtensions.js` |
| Chunk naming | statically imported Pro UI modules: `pro` group chunk `assets/pro-<hash>.js`; lazy components live in `pro/ui/lazy/pro-<Name>.jsx`, chunks `assets/pro-<Name>-<hash>.js` |
| Client extension points | `PRO_UI_INCLUDED`, `useJaviAgent`, `agentToolLabel`, `AGENT_UNREACHABLE_MESSAGE`, `JaviComposer`, `ConfirmActionCard`, `BriefingMessage`, `useInsightsExplain`, `FolderAskPanel`, `FolderReportWriter` (props and defaults: ADR 3.11); `PRO_EXTENSION_NAMES` in `src/extensions/proDefaults.js` |
| Client helpers | `isFreeUi(e, feature)`, `isProNotIncluded(e)` (`src/hooks/useEntitlements.js`); `PRO_NOT_INCLUDED`, `isProNotIncludedError(err)` (`src/utils/apiError.js`) |
| Test utils | server: `installProModuleForTests()`, `uninstallProModuleForTests()` in `server/__tests__/helpers/proModule.js`; UI: `vi.mock('<rel>/src/extensions/proExtensions.js', async () => await import('<rel>/pro/ui/proExtensions.js'))` |
| Header | first line of every Pro `.js`/`.jsx`/`.mjs`: `// burrow-pro: private source, never part of the public core.` |
| Check commands | `npm run check:pro-present`, `npm run export:core -- --out <dir>`, `node scripts/checks/channelMarker.js --expect-pro present\|absent`, `node scripts/release/smokeSidecar.js --expect-pro present\|absent`, env `BURROW_REQUIRE_PRO=1` |

## 6. Sequencing

| When | Team S | Team C |
| --- | --- | --- |
| Day 1 | S1 (core seams, no behaviour change), S2 (pro repo, globs, guards, Vite plugin and `pro` group, `loadProExtensions` in `startServer`). Push the pro repo's first commit before noon so C can branch it. | C1 (`proDefaults.js`, empty `proExtensions.js`, helpers, ProGateNotice/TrialNotice/LicenseSection, contract tests) against the frozen names; drafts of `docs/OPEN_CORE.md`, `docs/PUBLISHING_CORE.md`, `docs/CLA.md` |
| Day 2 onward | S3 Jarvis, S4 Explain, S5 Characters, S6 Folders (each one PR, code plus its tests) | C2 Javi agent UI, C3 Briefing UI, C4 Explain UI, C5 Folders UI, C6 `isFreeUi` sweep (each one PR, code plus its tests) |
| After S3-S6 and C2-C6 | S7 build and release, S8 boundary and export guards, S9 evals, `package.json`, `cla.yml` | C7 e2e and visual baselines (needs S3-S6 for Pro routes), C8 docs and licences |
| Merge order | S1, S2, C1, then S3-S6 and C2-C6 interleaved in any order, then S7, S8, S9, C7, C8, then QA (section 7) | |

Each PR must leave both modes green for the parts it touches: run `npm test` with `pro/` present and the core suites with `pro/` moved aside (section 7.2) before asking for review.

## 7. QA verification (PowerShell 5.1, from the core repo root)

Safety: never run `server.js` against the real data folder; always a fresh temp `BURROW_DATA_DIR`. Never move `pro/` to another name inside the repo (it would show as untracked core files); move it outside. PowerShell 5.1 corrupts binary data in native pipes, so tar output goes through a file.

### 7.1 Pro mode (`pro/` present)

```powershell
git -C pro status --short                     # expect no output
npm ci
npm run lint
npm test                                      # core + pro suites
npx vitest run server/__tests__ src          # core suites only; note the pass count for 7.2
npm run test:parser                           # server/folders/jobs.js changed
$env:BURROW_REQUIRE_PRO = '1'; npm run build; Remove-Item Env:BURROW_REQUIRE_PRO
npm run check:bundle                          # core keys within 470 / 125 / 31.9 / 146, pro keys reported
node scripts/checks/channelMarker.js --expect stable --expect-pro present --dist-dir dist
npm run check:pro-present                     # expect exit 0
npm run check                                 # em dash, personal data, keys (core + pro files)
npx vitest run server/__tests__/proExtensions.test.js server/__tests__/proExtensionsCloud.test.js server/__tests__/proBoundary.test.js server/__tests__/proBuild.test.js server/__tests__/proReleaseGuard.test.js server/__tests__/coreTreeGuard.test.js server/__tests__/aiBoundary.test.js server/__tests__/devToolsBuild.test.js pro/server/__tests__/proModuleContract.test.js
```

`npm start` smoke (fresh data dir, unreachable Ollama so no model runs):

```powershell
$env:BURROW_DATA_DIR = Join-Path $env:TEMP ("burrow-qa-" + [guid]::NewGuid().ToString('N'))
$env:BURROW_PORT = '4398'; $env:BURROW_SCHEDULER = '0'; $env:OLLAMA_HOST = 'http://127.0.0.1:9'
$srv = Start-Process -FilePath node -ArgumentList 'server.js' -PassThru -NoNewWindow
Start-Sleep -Seconds 5
(Invoke-RestMethod http://127.0.0.1:4398/api/app/info).data.proModule      # expect True
$id = '00000000-0000-4000-8000-000000000000'
$paths = @('/api/jarvis', '/api/jarvis/actions/00000000000000000000000000000000', '/api/jarvis/briefing/refresh', '/api/insights/explain', "/api/folders/$id/report", "/api/folders/$id/ask")
foreach ($p in $paths) { curl.exe -s -o NUL -w "$p %{http_code}`n" -X POST -H "Content-Type: application/json" -d "{}" "http://127.0.0.1:4398$p" }
# expect: /api/jarvis 400, actions 400, briefing/refresh 503, insights/explain 400, report 404, ask 400 (no 501, no 404 on the jarvis or insights paths)
Stop-Process -Id $srv.Id; Remove-Item -Recurse -Force $env:BURROW_DATA_DIR
Remove-Item Env:BURROW_DATA_DIR, Env:BURROW_PORT, Env:BURROW_SCHEDULER, Env:OLLAMA_HOST
```

Desktop, store, e2e, git:

```powershell
npm run desktop:sidecar
node scripts/release/smokeSidecar.js --expect-pro present
npm run release:store -- --check                                  # expect the pro check to pass
npm run test:e2e -- --project=flows --project=first-run --project=a11y --project=pro-flows
git check-ignore -q pro; "pro ignored: $($LASTEXITCODE -eq 0)"   # expect True
git ls-files pro                                                  # expect no output
git archive --format=tar -o "$env:TEMP\burrow-core.tar" HEAD
tar -tf "$env:TEMP\burrow-core.tar" | Select-String -Pattern '^(pro|devtools)/'   # expect no output
npm run export:core -- --out "$env:TEMP\burrow-core-export"       # expect success (guard passes)
```

Visual baselines are Linux only (`npm run test:visual:update` through Docker or CI); not part of Windows QA.

License audit (ADR R13): review `THIRD_PARTY_NOTICES.md` and `npm ls --omit=dev --all` for any GPL, AGPL or LGPL package in the shipped bundles; any hit blocks the first export.

### 7.2 Free mode (`pro/` moved outside the repo)

```powershell
Move-Item pro "$env:TEMP\burrow-pro-aside"
git status --porcelain                                            # must not list anything under pro
npm ci
npm run lint
npm test                                                          # core only; same pass count as the 7.1 core-only run
npm run test:parser
npm run build
npm run check:bundle                                              # core keys within budget, total and initial below the 7.1 core values or equal
node scripts/checks/channelMarker.js --expect stable --expect-pro absent --dist-dir dist
npm run check:pro-present; "exit $LASTEXITCODE"                   # expect exit 1
$env:BURROW_REQUIRE_PRO = '1'; npm run build; "exit $LASTEXITCODE"; Remove-Item Env:BURROW_REQUIRE_PRO   # expect failure
npm run check
npx vitest run server/__tests__/proExtensions.test.js server/__tests__/proExtensionsCloud.test.js server/__tests__/proBoundary.test.js server/__tests__/proBuild.test.js server/__tests__/proReleaseGuard.test.js server/__tests__/coreTreeGuard.test.js server/__tests__/aiBoundary.test.js server/__tests__/devToolsBuild.test.js
```

Smoke: run the same `npm start` block as 7.1 (rebuild `dist/` first, already done above). Expect `proModule` False and every one of the 6 paths answers `501 pro_not_included`; any other code is a failure.

```powershell
npm run desktop:sidecar                                           # expect success with the "Building without the Pro module" warning
node scripts/release/smokeSidecar.js --expect-pro absent
npm run desktop:sidecar -- --require-pro; "exit $LASTEXITCODE"    # expect failure
npm run release:store -- --check; "exit $LASTEXITCODE"            # expect failure at the pro check
npm run test:e2e -- --project=flows --project=first-run --project=a11y
Move-Item "$env:TEMP\burrow-pro-aside" pro
git -C pro status --short                                         # expect no output
```
