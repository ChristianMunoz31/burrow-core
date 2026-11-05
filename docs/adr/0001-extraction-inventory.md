# ADR 0001 inventory: what moves to `pro/`, what stays core, in which order

Companion to [0001-open-core-split.md](0001-open-core-split.md) (the contract) and [0001-work-split.md](0001-work-split.md) (who does what). Status: Proposed, 2026-11-04. Line numbers are those of v1.4.0 on `feat/open-core-split`; re-locate by symbol name if a line moved. Planned work only: no public copy may claim open source or AGPL until the owner created the public repo.

## B0. Rules for every move

1. A moved file keeps its name unless this inventory gives a new one. Relative imports are rewritten to the core path (`pro/server/agents/x.js` importing `server/dataAccess.js` uses `../../../server/dataAccess.js`).
2. Every moved `.js`, `.jsx` or `.mjs` file gets the private header as its first line: `// burrow-pro: private source, never part of the public core.`
3. Runtime Pro code (`pro/server/**`, `pro/ui/**`, not tests) imports only what ADR 3.9 allows. If a moved file needs anything else, stop and report it (do not widen the allowlist in a move step).
4. Tests that move to `pro/` keep importing core helpers from core paths: `server/__tests__/helpers/pro.js`, `helpers/foldersEnv.js`, `helpers/fakeOllama.js`, `helpers/dialogHarness.js`, `helpers/modelCallScan.js`, `helpers/synthDocs.js`, `server/__tests__/fixtures/*`, `server/__tests__/license/helpers.js`, `src/test-utils/entitlements.js`, `src/test-utils/javiInbox.js`. Helpers are never copied into `pro/`.
5. A Pro server test that needs the real module calls `await installProModuleForTests()` in `beforeAll` and `uninstallProModuleForTests()` in `afterAll` (`server/__tests__/helpers/proModule.js`). A Pro UI test starts with `vi.mock('<relative path to>/src/extensions/proExtensions.js', async () => await import('<relative path to>/pro/ui/proExtensions.js'))`.
6. Split test files: the twin is `pro/server/__tests__/<name>.pro.test.js` or `pro/ui/__tests__/<name>.pro.test.jsx`. Move every `it`/`test` block whose body uses a Pro token (below), and every `describe` whose children all move; copy (do not move) the setup they need (`beforeAll`, `beforeEach`, `afterEach`, local helpers). Everything else stays. Pro tokens: the 6 `PRO_ROUTES` paths, `runJarvis`, `runBriefing`, `executeTool`, `historyToMessages`, `jarvisSystemPrompt`, `briefingSystemPrompt`, `JAVI_PERSONALITY`, `JAVI_VOICE`, `javiVoice`, `chunkText`, `encodeVector`, `decodeVector`, `topK`, `topKAsync`, `writeReport`, `askFolder`, `runScheduledFolderRescans`, `registerCrossInsightsRoutes` and the other `crossInsightsRoutes.js` exports, an enqueued `kind: 'report'` job with a client, a non-butler character id used as a Pro-on expectation, `useJarvis`, `toolLabel`, `JAVI_UNREACHABLE`, `ConfirmActionCard`, `BriefingMessage`, `explainInsights`, `FolderAskPanel`, the composer (`Message Javi` textbox).
7. Core tests stay deterministic in both modes: they never call `installProModuleForTests()` and never import from `pro/`.

## B1. The 8 used Pro features after the split

| Feature | Gate after the split (public core) | Pro code (`pro/`) | Core code that stays |
| --- | --- | --- | --- |
| `javi_tools` | `PRO_ROUTES` `jarvis.run`, `jarvis.action` (`requirePro` mounted by `server/proExtensions.js`) | agent loop, tools, guards, pending actions, routes, `useJarvis`, composer, ConfirmActionCard | `/api/jarvis` limiters, `GET /api/jarvis/status`, conversation routes (`server.js:552-580`, data access, ungated as today), `dataAccess` conversation and memory functions |
| `javi_conversation` | `server/javiAdvisorRoutes.js:42` `requireProWhen` and `:60-67` re-check (unchanged) | none | the whole multi-turn advice path (`javiAdvisorRoutes.js`, `javi/validateAdvice.js`, `advisorService.js`, `useJaviSession.js`) (ADR R8) |
| `javi_characters` | `server/javi/characters.js` `getCharacter` (`proAccess`, plus "text registered") | the valet, concierge and majordomo texts (`characters.js:37-75`) | butler, `CHARACTER_IDS`, `normalizeCharacter`, `characterText`, settings picker with "(Pro)" options |
| `briefings` | `PRO_ROUTES` `jarvis.briefingRefresh`; `server/scheduler.js:101` `assertPro`; `server/javi/inbox.js:106` | `runBriefing`, snapshot, prompt, refresh route, `useBriefingRefresh`, `BriefingMessage` | `GET /api/jarvis/briefing`, `useBriefing` read query, `isBriefingToday`, inbox briefing item, `buildBriefingContext` |
| `explain` | `PRO_ROUTES` `insights.explain` | `crossInsightsRoutes.js` (whole), `crossInsightsService.js`, `useInsightsExplain` | findings (`src/utils/crossInsights.js`), the card, the Explain button with ProPill, `/api/insights` limiter |
| `folder_qa` | `PRO_ROUTES` `folders.ask`; `jobs.js` indexPhase `proAccess('folder_qa')` | index phase body, `chunkText`, `vectors.js`, `ask.js`, ASK prompt, Ask panel, SearchModelPrompt | `store.js` chunk and vector functions (D5), `getEmbedClient`, `folder_index` audit row, `folder_not_indexed` copy |
| `folder_report` | `PRO_ROUTES` `folders.report`; `jobs.js` runReport `assertPro` | report job body, `writeReport`, REPORT prompt, report writer UI | report read view (free), job runner and error classification |
| `folder_auto_rescan` | `server/folderRoutes.js:229` `requireProWhen` (unchanged); `scheduler.js` folderJob `proAccess` (new) | `server/folders/scheduled.js` | the switch, PATCH route, `auto_rescan` column |

## B2. Server files

| Current path | Destination | Detail and seam |
| --- | --- | --- |
| `server.js` | split | Remove imports l13, l15-18, l81 and any import made unused (lint). l396 `registerCrossInsightsRoutes(app)` becomes `app.use(proSlotRouter('insights'))`. l408-549 (`validateJarvis`, `POST /api/jarvis`, `POST /api/jarvis/actions/:token`) become `app.use(proSlotRouter('jarvis'))`. l613-634 (`POST /api/jarvis/briefing/refresh`) removed. l245-251 `abortOnClose` removed (only user was the refresh route). Keep l404-406, l551-580, l604-611, l224-236. In `startServer` add `await loadProExtensions();` after l987. |
| `server/agents/jarvisAgent.js` | `pro/server/agents/jarvisAgent.js` | whole; `JAVI_PERSONALITY` users switch to `characterText(DEFAULT_CHARACTER)` |
| `server/agents/jarvisTools.js` | `pro/server/agents/jarvisTools.js` | whole |
| `server/agents/jarvisGuards.js`, `toolCalls.js`, `smallAnswer.js`, `briefingSnapshot.js`, `runLock.js` | `pro/server/agents/` same names | whole |
| `server/agents/pendingActions.js` | `pro/server/agents/pendingActions.js` | remove l6 import and l113 `onDataReset(clearPendingActions)`; `install` calls `ctx.onDataReset(clearPendingActions)` |
| `server/agents/prompts.js` | split | `userNameLine` (l23-34) to new `server/javi/userName.js` (core, Tier B); `server/javi/advisorPrompt.js:15` imports it from `./userName.js`. Rest to `pro/server/agents/prompts.js`; l2 becomes `import { DEFAULT_CHARACTER, characterText } from '../../../server/javi/characters.js'`; l6 becomes `characterText(DEFAULT_CHARACTER).personality`. `server/agents/` no longer exists in core. |
| (new) `pro/server/routes/jarvis.js` | new | `installJarvisRoutes(ctx)`: `validateJarvis` (from `server.js:408-424`) as `validate` of `jarvis.run`; handler bodies from `server.js:428-504` (`jarvis.run`), `512-548` (`jarvis.action`), `614-633` (`jarvis.briefingRefresh`, with a local copy of `abortOnClose` from `server.js:245-251`). No `requirePro`/`requireAi` in Pro code (core mounts them); the `assertPro` re-checks stay. |
| `server/crossInsightsRoutes.js` | `pro/server/insights/explain.js` + `pro/server/routes/insights.js` | every export except `registerCrossInsightsRoutes` moves to `insights/explain.js` unchanged; the handler body (l239 to the end of the route) goes into `installInsightsRoutes(ctx)` as `insights.explain` handlers, without `requirePro('explain')` |
| `server/javiAdvisorRoutes.js` | core, unchanged | multi-turn stays core (B1) |
| `server/javi/characters.js` | split | l37-75 (valet, concierge, majordomo) to `pro/server/javi/characters.js` `export const PRO_CHARACTER_TEXTS`; core per ADR 3.7 |
| `server/javi/inbox.js`, `advisorPrompt.js` (except the import), `advisorService.js`, `validateAdvice.js`, `pages.js`, `groundedNumbers.js` | core, unchanged | |
| `server/scheduler.js` | core, edited | ADR 3.7; remove l10, l12 imports |
| `server/folderRoutes.js` | split | Remove from imports: `getAiClient`, `getEmbedClient`, `classifyAiError`, `aiAuditMeta` (l11) if unused after the cut, `assertPro`, `requirePro` (l26, keep `requireProWhen`), `askFolder` (l29). Replace l417-497 with `setFolderRouteHelpers({ handle, send, folderOr404, aiLimiter, requireJson, isPlainBody }); app.use(proSlotRouter('folders'));`. l229 PATCH gate unchanged. |
| (new) `pro/server/routes/folders.js` | new | `installFolderRoutes(ctx)`: handlers of `folders.report` (from l421-433, wrapped in `helpers.handle`) and `folders.ask` (from l441-496) using `ctx.folders.routeHelpers()` |
| `server/folders/ask.js` | `pro/server/folders/ask.js` | whole; `askMessages` from `./prompts.js` (Pro), `topKAsync` from `./vectors.js` (Pro) |
| `server/folders/vectors.js` | `pro/server/folders/vectors.js` | whole |
| `server/folders/scheduled.js` | `pro/server/folders/scheduled.js` | whole; registered with `ctx.scheduler.register('folderRescan', runScheduledFolderRescans)` |
| `server/folders/chunk.js` | split | `BREAK_WINDOW` (l5) and `chunkText` (l7-59) to `pro/server/folders/chunk.js` (imports `LIMITS` from core `constants.js`); core keeps `pickSummaryParts` (l61-79) and drops the `LIMITS` import |
| `server/folders/prompts.js` | split | `REPORT_SYSTEM` (l36-44), `ASK_SYSTEM` (l46-53), `reportMessages` (l109-114), `askMessages` (l116-122) to `pro/server/folders/prompts.js`. Core adds `export` to `NUMBER_RULE`, `PLAIN`, `defence` and adds `export { facts as factsBlock, msgs as chatMessages };` (internal names unchanged) |
| `server/folders/summarize.js` | split | `REPORT_CLIP` (l12) and `writeReport` (l167-175) to `pro/server/folders/summarize.js`; core renames private `ask` (l81-102) to exported `askFolderModel` (update its 6 internal callers), exports `reduceNotes` (l140-155), drops `reportMessages` from the l6 import |
| `server/folders/jobs.js` | split | `EMBED_DOC_PREFIX` (l58), `estimateChunks` (l738) and indexPhase l748-804 to `pro/server/folders/indexPhase.js` `runIndexPhase(api)`; runReport l849-888 to `pro/server/folders/report.js` `runFolderReport(api)`; core wrappers per ADR 3.7; `auditScan` (l811-838) and `runJob` (l353-379) stay; drop imports made unused (`getEmbedClient`, `withheldMessage`, `chunkText`, `quotePath`, `countAllChunks`, `countIndex`, `replaceFileChunks`, `writeReport`, `encodeVector`, `duplicateGroups`, `buildFolderFacts` if unused) |
| `server/folders/store.js` | core, unchanged | D5 |
| `server/folders/exportReport.js`, `stats.js`, `views.js`, `constants.js`, other folder modules | core, unchanged | |
| `server/dataAccess.js`, `server/ai/**` | core, unchanged | D5; `getEmbedClient` stays |
| `server/pro.js` | core, edited | add `MSG_PRO_NOT_INCLUDED`, `sendProNotIncluded(feature)` (ADR 3.8) |
| `server/license/channelSeam.js` | core, edited | `proCompiledIn()` |
| `server/appInfoRoutes.js` | core, edited | `proModule` |
| (new) `server/proRoutes.js`, `server/proExtensions.js`, `server/proExtensionsLoader.js`, `server/proExtensionsLoader.none.js` | core | ADR 3.4-3.6 |
| (new) `pro/server/index.js`, `pro/server/static.js` | Pro | ADR 3.2, 3.6; `install` calls `installJarvisRoutes`, `installInsightsRoutes`, `installFolderRoutes`, `ctx.folders.setJobHooks({ index: runIndexPhase, report: runFolderReport })`, `ctx.scheduler.register('briefing', (opts) => runBriefing(opts))`, `ctx.scheduler.register('folderRescan', runScheduledFolderRescans)`, `ctx.javi.registerCharacters(PRO_CHARACTER_TEXTS)`, `ctx.onDataReset(clearPendingActions)` |
| (new) `server/__tests__/helpers/proModule.js` | core | `installProModuleForTests()` (`loadProExtensions({ importer: importProExtension })`, throws `pro/ module missing` on false), `uninstallProModuleForTests()` (`resetProExtensionsForTests()`) |
| `devtools/server/__tests__/proTierMatrix.test.js` | stays in devtools, edited | Pro-on rows call `installProModuleForTests()` and are wrapped in `describe.skipIf(!fs.existsSync('pro/server/index.js'))` |

## B3. Server tests

Whole-file moves to `pro/server/__tests__/` (same file name): `jarvisEarlyStop`, `jarvisEarlyStopRegistry`, `jarvisGuards`, `jarvisGuardsFlow`, `jarvisLocal`, `jarvisModelMatrix`, `jarvisSmallCap`, `jarvisSmallEcho`, `jarvisSmallRound1`, `jarvisSmallRoute`, `jarvisToolErrors`, `jarvisToolRecovery`, `jarvisTools`, `jarvisToolsCompact`, `jarvisToolsWhen`, `toolCalls`, `earlyToolEchoUnclosed`, `smallAnswerProps`, `pendingActions`, `reviewHardening`, `briefingSnapshot`, `briefingSnapshotBuild`, `briefingPristine`, `auditBriefing`, `cloudBriefing`, `cloudJarvis`, `crossInsightsExplain`, `crossInsightsExplainGuards`, `crossInsightsParity`, `crossInsightsRoutes`, `crossInsightsAuth`, `cloudCrossInsights`, `proDirectCalls`, `proStoreDirectCalls`, `proRace`, `proGateVariants`, `proRoutesBoundary` (rewrite paths), `proToolsBoundary` (rewrite `TOOL_MODULES` l50, `PROMPT_IMPORTERS` l62-64, the `free` regex l127 to `pro/server/agents/`), `javiCharacterWiring` (use `PRO_CHARACTER_TEXTS`), `foldersVectors`, `foldersScheduled` (all `.test.js`).

Split files (twin per B0.6; known blocks listed, the rule decides the rest):

| File | Moves to the Pro twin | Stays core |
| --- | --- | --- |
| `advisorPrompt.test.js` | describes `jarvisSystemPrompt (Javi)` l17, `briefingSystemPrompt` l56 | rest; import of `userNameLine` (if any) from `../javi/userName.js` |
| `aiNoMath.test.js` | prompt table rows l43-44; `executeTool` blocks around l156, l169, l194, l211; `runBriefing`/`runJarvis` blocks l313-345 | advisor prompt checks |
| `aiLoopbackOnly.test.js` | table rows l140-143; block at l161 (`runBriefing`) | advice rows |
| `aiAuditLocal.test.js` | cases l98, l107, l112-115; blocks l149, l161-182 | advice cases |
| `aiAndNetworkGates.test.js` | rows l51-52, l54-55, `ACTIONS_ROUTE` l58 and the describes using them (l60, l91) | advice rows |
| `auditIntegration.test.js` | `vi.mock` of `jarvisAgent` l13, import l19, Jarvis cases l137-271 | advice cases (mock only `advisorService`) |
| `cloudAudit.test.js` | `jarvis` block (helper l60, block ~l117) | `advice` l70 |
| `cloudGateMatrix.test.js` | matrix entries `jarvis` l56, `briefing` l61, explain l64 | advice entries |
| `cloudLeaks.test.js` | helper l85 and its users (H1, H2, H3, L2), describe `historyToMessages` l265, its l661, l679 | advice leak cases |
| `cloudMatrix.test.js` | block using l76 | rest |
| `cloudPolicy.test.js` | block at l87 (reads `runBriefing` source) | rest |
| `cloudScope.test.js` | block at l245 | rest |
| `cloudFolders.test.js` | ask block l100, scheduled block l130 | summary cases (still the cloud test for `server/folders/jobs.js`; keeps `configureCloud(`) |
| `foldersCloud.test.js` | ask blocks l175, l197 | rest |
| `degradation.test.js` | blocks l44, l52 | rest |
| `eraseInFlightJobs.test.js` | `runBriefing`/`runJarvis` blocks l81-161 | rest |
| `foldersBodyParser.test.js` | row l39 (`/ask`) | rest |
| `foldersAuth.test.js` | nothing | rows l49-50 stay: the auth gate is core and answers before the slot |
| `foldersArchive.test.js` | l366-367 (report and ask `folder_needs_confirm`), block l391 | rest |
| `foldersRoutes.test.js` | block containing l826; describes `POST /api/folders/:id/report` l884 and `POST /api/folders/:id/ask` l956; limiter block l1186-1198 | autoRescan cases (core gate) and the rest |
| `foldersRoutes.smoke.test.js` | l140-151 | rest |
| `foldersSecurityFixes.test.js` | vector blocks l326-351, scheduled block l555 | rest |
| `foldersStore.test.js` | nothing | whole file stays (store is core); replace `encodeVector([seq, 1])` (l26, l38) with a fixed base64 literal of two little-endian float32 values |
| `foldersChunk.test.js` | describe `chunkText` l8 | `pickSummaryParts` |
| `foldersJobs.test.js` | `the report job` cases l656 and l668; `folder_index` assertions in `audit rows of a scan` l680 and any indexing assertion | l647 (no client gives `folder_failed`, works without the hook) and everything else |
| `foldersProStore.test.js` | describes l70, l83 | describe `what stays free on every tier` l129 |
| `backupFolderIndex.test.js` | the ask call l129 | seed `folder_chunks` with core `replaceFileChunks` instead of a scan plus ask |
| `groundedNumbersEdge.test.js` | describe `notices are fixed copy` l125 and import l9 | rest |
| `javiAdvisorRoutes.test.js` | block using l275 (`POST /api/jarvis`) | multi-turn cases (core) |
| `javiInboxRoutes.test.js` | `vi.mock` l12, import l16, `briefing refresh marks the briefing read` l168-205 | rest |
| `javiCharacters.test.js` | per-id text checks for non-butler ids (l87-170), prompt tests (l118-119, l257-261, l274-296), Pro-on `getCharacter` cases (l199-200, l221-231) | id parity l53-54, butler golden l75-81 (use `BUTLER_CHARACTER`), `normalizeCharacter`, fallbacks l203-208, `adviceCacheKey` l309 |
| `javiReviewFixes.test.js` | import l23 and blocks l66, l101-109, l179 | rest |
| `reviewHardeningRoutes.test.js` | M7 l101-175, M1 and L2 from l176 | M2 l58-100 |
| `securityHardening.test.js` | `executeTool` blocks l148-161, l393 | rest |
| `secretsServer.test.js` | explain blocks l105-113 | rest |
| `validation.test.js` | `/api/jarvis` 400 cases l52-66 | rest |
| `proGating.test.js` | rows l26-29 and block l118 | `pro.js` unit cases |
| `proStoreFeatures.test.js` | rows l35-39 and l94-109 | `pro.js` unit cases |
| `scheduler.test.js` | nothing | stays: it injects `briefing` (l39) |
| `backupAutoSwitch.test.js`, `sandboxAi.test.js`, `desktopAuth.test.js`, `aiCallSites.test.js`, `javiAdviceCacheRoutes.test.js`, `javiInbox.test.js` | nothing expected | verify with the B0.6 rule only |

Core test edits:

| File | Edit |
| --- | --- |
| `aiBoundary.test.js` | l172-179 list becomes `server.js`, `server/javiAdvisorRoutes.js`, `server/javi/advisorService.js`, `server/scheduler.js`, `server/proExtensions.js`; l185-192 becomes: `PRO_ROUTES` entries `jarvis.run`, `jarvis.action`, `jarvis.briefingRefresh` have `ai` set and `server/proExtensions.js` mounts `requireAi(`; l194-198 keeps only `server/javiAdvisorRoutes.js`; `CONSUMERS` l205-213 becomes `server/javi/advisorService.js` and `server/javiAdvisorRoutes.js` to `cloudAdvice`, `server/folders/jobs.js` to `cloudFolders`, `server/proExtensions.js` to `proExtensionsCloud` |
| `devToolsBuild.test.js` | its loader-trio and naming tests ignore the new Pro loader files; the stable bundle tests also expect `BURROW_PRO=off` on line 2 |
| `proFeatureRegistry.test.js` | the gated-id scan (l73) also reads `feature: '<id>'` from `server/proRoutes.js`, and `pro/server/**` when present; l102 expectation unchanged (8 ids, true in both modes) |
| `eraseBoundary.test.js` | core keeps the server/javi, server/ai and Javi UI parts; `JARVIS_TOOLS` import l8, `server/agents/*` paths l207 and the tool list l213 move to `pro/server/__tests__/eraseBoundary.pro.test.js`, which scans `pro/server` and `pro/ui` with the same rules |

## B4. Client files

| Current path | Destination | Detail |
| --- | --- | --- |
| `src/hooks/useJarvis.js` | `pro/ui/hooks/useJarvis.js` | whole; `pro/ui/proExtensions.js` exports `useJaviAgent` (wraps `useJarvis`, `respond` invalidates the keys from `JaviAdvisor.jsx:28-35`), `agentToolLabel = toolLabel`, `AGENT_UNREACHABLE_MESSAGE = JAVI_UNREACHABLE` |
| `src/components/javi/ConfirmActionCard.jsx` | `pro/ui/lazy/pro-ConfirmActionCard.jsx` | `toolLabel` from `../hooks/useJarvis.js` |
| `src/components/javi/JaviPanel.jsx` | split | draft state l114-120, `submit` l195-205, `onInputKeyDown` l214-219 and the dock l405-430 to `pro/ui/lazy/pro-JaviComposer.jsx` (props per ADR 3.11; focuses its textarea on mount and on `focusSeq`). Host: l5 and l18 imports become extension imports; l302 renders `ConfirmActionCard` only when not null; l325 `agentToolLabel`; l355 `AGENT_UNREACHABLE_MESSAGE`; `free` (l92) and `proBlocked` (l95) use `isFreeUi`; the chips (l383-401), strip and Free hint stay core |
| `src/components/javi/JaviAdvisor.jsx` | core, edited | l8 `useJarvis` becomes `useJaviAgent` (extension); `WRITE_QUERY_KEYS` l28-35 and the invalidation move into `useJaviAgent`; `free` uses `isFreeUi(e, 'javi_conversation')`; rest stays |
| `src/components/javi/adviceParts.jsx` | split | `BriefingMessage` (l92-168) and `withheldMessage` (l80-85, if no other user) to `pro/ui/lazy/pro-BriefingMessage.jsx`; drop now-unused imports (l12, l13, l15) |
| `src/hooks/useBriefing.js` | split | refresh mutation l28-43 and fields l54-60 to `pro/ui/hooks/useBriefingRefresh.js` `useBriefingRefresh()`; core exports `BRIEFING_QUERY_KEY` (the `KEY` at l6) and returns `{ briefing, alerts, loading, error, refetch }` |
| `src/components/shell/NotificationBell.jsx` | core, edited | stop reading `refreshing` (l12): the mutation is per hook instance and was never pending there; read the component to confirm before removing |
| `src/components/home/JaviHomeCard.jsx` | core, edited | l109 `showBriefing` adds `BriefingMessage !== null &&`; l171 renders the extension component in `Suspense` |
| `src/components/home/CrossInsightsCard.jsx` | split | state and logic l31-103 (except `proHintId`) to `pro/ui/hooks/useInsightsExplain.js`; host calls `useInsightsExplain({ result, summaryKey })`; l106 `free` uses `isFreeUi(e, 'explain')` |
| `src/services/crossInsightsService.js` | `pro/ui/services/crossInsightsService.js` | whole |
| `src/components/folders/FolderAskPanel.jsx` | `pro/ui/lazy/pro-FolderAskPanel.jsx` | props become `{ folder }`; calls `askFolder` from the Pro service |
| `src/components/folders/SearchModelPrompt.jsx` | `pro/ui/components/SearchModelPrompt.jsx` | only importer is FolderAskPanel (`FolderAskPanel.jsx:12`); a plain helper, not a lazy entry, so it is not under `lazy/` and lands in the `pro` group or the `pro-FolderAskPanel` chunk |
| `src/components/folders/FolderReportCard.jsx` | split | writer state and button l16-45, l57-90 to `pro/ui/lazy/pro-FolderReportWriter.jsx` (calls `writeFolderReport`, invalidates folder queries with core `folderKeys`); host keeps the section, the read view l47-56 and renders `FolderReportWriter` or `<ProGateNotice capability="folder_report" />` |
| `src/components/folders/FolderCard.jsx` | core, edited | drop `onAsk`/`onWriteReport` (l95-96, l104); l342 renders `FolderAskPanel` or `<ProGateNotice capability="folder_qa" />`; l345 `FolderReportCard folder busy`; auto re-scan (l149-165, l273) uses `isFreeUi(e, 'folder_auto_rescan')` |
| `src/components/folders/FoldersPage.jsx` | core, edited | drop the `onAsk`/`onWriteReport` pass-through (~l135-136) |
| `src/hooks/useFolders.js` | core, edited | drop `reportMutation` (l69-70), `writeReport` (l119), `ask` (l125) |
| `src/services/foldersService.js` | split | `report` (l66), `ask` (l68) to `pro/ui/services/foldersProService.js` as `writeFolderReport(id)` and `askFolder(id, question, signal)` |
| `src/components/settings/GeneralSection.jsx`, `src/pages/Settings.jsx` | core | `charactersLocked` uses `isFreeUi(e, 'javi_characters')` |
| `src/test-utils/sseResponse.js` | `pro/ui/test-utils/sseResponse.js` | only if no core test imports it after the moves (check with Grep) |
| (new) `src/extensions/proDefaults.js`, `src/extensions/proExtensions.js` | core | ADR 3.11 |
| `src/hooks/useEntitlements.js`, `src/utils/apiError.js`, `src/constants/proFeatures.js`, `src/components/license/ProGateNotice.jsx`, `TrialNotice.jsx`, `src/components/settings/LicenseSection.jsx` | core, edited | ADR 3.8, 3.11 |
| (new) `pro/ui/proExtensions.js`, `pro/ui/hooks/useInsightsExplain.js` | Pro | |
| `src/constants/javiCharacters.js`, `src/constants/javiPages.js`, `src/utils/crossInsights.js`, `src/components/javi/timeline.js`, `useJaviSession.js` | core, unchanged | server parity tests import the first two |

## B5. Client tests

Whole-file moves to `pro/ui/__tests__/` (keep subfolder name as prefix where names collide): `javi/__tests__/BriefingMessage.test.jsx`, `ConfirmActionCard.test.jsx`; `hooks/__tests__/useJarvis.test.js`, `useJarvis.actions.test.js`, `useJarvis.cloud.test.js`, `toolLabel.test.js`; `home/__tests__/CrossInsightsCard.explain.test.jsx` (its `empty and list states` l49-83 stays core in a new `CrossInsightsCard.states.test.jsx`).

Split (twin `*.pro.test.jsx` in `pro/ui/__tests__/`):

| File | Pro twin | Core |
| --- | --- | --- |
| `javi/__tests__/JaviPanel.agent.test.jsx` | `JaviPanel free-form chat` l74-180; Pro halves of l208-232 | `Free` l234-368; Free halves of l208-232 |
| `javi/__tests__/JaviAdvisor.test.jsx` | `follow-ups` l315-361, `typed questions` l427-504, Pro `javi:open` l505-588 except l549, `Free to Pro shows composer` l883, `active trial keeps full UI` l904 | l139-314, l362-386, `401`, `markdown safety`, `Free: one insight card per page` l589-784, l549 |
| `javi/__tests__/JaviAdvisor.dm.test.jsx` | `a briefing row closes Javi, goes to Home` l214 and composer-focus assertions | rest |
| `javi/__tests__/JaviFreeGate.test.jsx` | l110-150, l151-167 | `Free upsell` l168-199 |
| `javi/__tests__/JaviPanel.dm.test.jsx` | Pro half of l132 | rest, Free half of l132 |
| `javi/__tests__/JaviPanel.cloud.test.jsx` | l144 | rest |
| `home/__tests__/JaviHomeCard.test.jsx` | briefing tests l92-131 | rest |
| `home/__tests__/CrossInsightsCard.test.jsx` | l111, l125 | rest |
| `folders/__tests__/FoldersPage.test.jsx` | l513, l524-576 except l566, l577-806 except l578 and l598, ask and report parts of l958 | rest, l566, l578, l598 |
| `license/__tests__/ProGating.test.jsx` | Pro halves of l131-218, l219-247, l248-286 | l110, l287, upsell halves |
| `license/__tests__/ProRefresh.test.jsx` | l95-160 | l161-214 |
| `settings/__tests__/GeneralSection.menuCharacter.test.jsx` | nothing | stays (picker is core) |
| `services/__tests__/foldersService.test.js` | ask and report cases | rest |
| `pages/__tests__/Home.cards.test.jsx` | `Home briefing (shown in the Javi card)` l208 | rest |

Every remaining core UI test that asserts Free behaviour must pass with `PRO_UI_INCLUDED === false` (the core module); tests that asserted Pro UI under the trial move by the rule.

## B6. e2e and visual baselines

| Path | Destination | Detail |
| --- | --- | --- |
| `e2e/flows/javi.spec.js` | `pro/e2e/flows/javi.spec.js` | whole |
| `e2e/flows/javiDmBriefing.spec.js` | `pro/e2e/flows/javiDmBriefing.spec.js` | whole |
| `e2e/flows/javiDm.spec.js` | split | composer focus assertions (l20, l121, l132, l141, l149, l154) to `pro/e2e/flows/javiDm.pro.spec.js`; core spec preseeds `{ trialEnded: true }` |
| `e2e/pages/javi.js` | split | `ask`, `composer`, `confirmCard`, `approve` helpers to `pro/e2e/pages/javiPro.js` |
| `e2e/support/burrowServer.js` | core | `startBurrow({ distDir })`, default `<repo>/dist`, env `BURROW_E2E_DIST_DIR` overrides; passes `BURROW_DIST_DIR` |
| `e2e/a11y/dark.spec.js`, `light.spec.js` (test at l32) | core | preseed `{ trialEnded: true }` |
| other core specs that open Javi or a Pro-capable surface | core | preseed `{ trialEnded: true }` so they match in both modes |
| `e2e/__screenshots__/javiDm.spec.js/*` (6), `screens.spec.js/home-*`, `settings-*` | core, regenerated | regenerate with `npm run test:visual:update` after the trial-ended preseeds; Pro screenshots later under `pro/e2e/__screenshots__/` |
| `playwright.config.js` | core | add project `pro-flows` (`testDir: 'pro/e2e/flows'`) only when `fs.existsSync('pro/e2e')` |

## B7. Evals and scripts

| Path | Destination | Detail |
| --- | --- | --- |
| `scripts/evalAi.js` | `pro/scripts/evalAi.js` | whole; `package.json` `eval:ai` removed; run with `node pro/scripts/evalAi.js` |
| `scripts/evalJavi.js` | split | refactor `runEval` (l236) into `PATH_RUNNERS` keyed by path id; `PATH_IDS` (l32) core keeps `advice_free`, `advice_free_cached`, `advice_conversation`; export `runJaviEval({ argv, extraRunners })`; runners `jarvis_tools`, `briefing`, `insights_explain` and the l243, l245-246 imports go to `pro/scripts/javiEvalProPaths.js`; `pro/scripts/evalJaviPro.js` first awaits `loadProExtensions()` from `server/proExtensions.js` (so routes, jobs and character texts are registered), then calls `runJaviEval` with them |
| `scripts/lib/evalTrial.js`, `scripts/lib/javiEval/*` | core | shared |
| `evals/*.json` | rule | a file containing any of `jarvis_tools`, `briefing`, `insights_explain`, `valet`, `concierge`, `majordomo` moves to `pro/evals/`; others stay. `evals/README` drops the Pro paths |

## B8. Ordered steps (the tree builds and `npm test` passes after each)

Team SERVER+BUILD (S) and Team CLIENT+DOCS (C). Merge order: S1, S2, C1, then S3-S6 and C2-C6 in any order, then S7, S8, S9, C7, C8.

| Step | Team | Content |
| --- | --- | --- |
| S1 | S | Core seams without behaviour change: `server/proRoutes.js`, `server/proExtensions.js`, loader trio, `server/pro.js` additions, `proCompiledIn`, `/api/app/info` `proModule`, registries in `scheduler.js` (defaults still fall back to the in-core `runBriefing`/`runScheduledFolderRescans` until S3/S6), `jobs.js` (hooks unset, in-core phases still used until S6), `characters.js` (all four texts still core until S5), `server/javi/userName.js`, `helpers/proModule.js`, `proExtensions.test.js`, `proExtensionsCloud.test.js`. Slots not mounted yet. |
| S2 | S | `git init pro`; `pro/server/index.js` (install registers nothing), `pro/server/static.js`; `.gitignore` `/pro/`; `.gitattributes` `pro export-ignore`; `vitest.config.js`, `eslint.config.js`, `scripts/ci/runUnitTests.js`, `tailwind.config.cjs` globs; `scripts/checks/gitFiles.js` and pre-commit guard; `scripts/build/proBoundary.js`, `scripts/build/proUi.js` plus `vite.config.js` plugin and `pro` group; `startServer` awaits `loadProExtensions()`. |
| C1 | C | `src/extensions/proDefaults.js`, `src/extensions/proExtensions.js`, `isFreeUi`, `isProNotIncluded`, `apiError` and copy additions, `ProGateNotice`, `TrialNotice`, `LicenseSection`; `pro/ui/proExtensions.js` exporting the defaults with `PRO_UI_INCLUDED = true`; core and Pro contract tests. |
| S3 | S | Jarvis: B2 rows for `server.js`, `server/agents/*`, `pro/server/routes/jarvis.js`; scheduler briefing from the registry only; install registers the three Jarvis routes, the briefing job and `onDataReset`; B3 Jarvis and briefing test moves and splits. |
| S4 | S | Explain: `crossInsightsRoutes.js` move, insights slot; its tests. |
| S5 | S | Characters: non-butler texts move; `registerCharacters` in install; character tests. |
| S6 | S | Folders: `prompts.js`, `summarize.js`, `chunk.js`, `jobs.js` splits; `ask.js`, `vectors.js`, `scheduled.js` moves; `pro/server/routes/folders.js`; folder slot; scheduler folderRescan from the registry only; folder tests. |
| C2 | C | Javi agent UI: `useJarvis`, ConfirmActionCard, composer, JaviPanel and JaviAdvisor hosts; tests. |
| C3 | C | Briefing UI: `useBriefing` split, `BriefingMessage`, JaviHomeCard, NotificationBell; tests. |
| C4 | C | Explain UI: `useInsightsExplain`, service move, card host; tests. |
| C5 | C | Folders UI: Ask panel, SearchModelPrompt, report writer split, FolderCard, FoldersPage, `useFolders`, `foldersService`; tests. |
| C6 | C | `isFreeUi` in Settings (characters) and FolderCard auto re-scan; tests. |
| S7 | S | Build and release: `workerBundle.js` (`proPlugin`, define, banner), `buildSidecar.js` (requirePro, `checkDistPro`), `channelMarker.js` (`--expect-pro`), `proPresent.js`, `bundleBudget.js` plus `bundle-budget.json` keys, `smokeSidecar.js`, release scripts, `devDist.js`, `releaseAuto.mjs` pro worktree and pin, workflows (pro checkout, `--expect-pro absent` in `ci.yml` and the zip job), `Dockerfile`, `.dockerignore`, `devtools/server/__tests__/proTierMatrix.test.js`. |
| S8 | S | `proBoundary.test.js`, `proBuild.test.js`, `proReleaseGuard.test.js`, `coreTreeGuard.test.js`, `scripts/checks/coreTreeGuard.js`, `scripts/release/exportCore.mjs`; the B3 core test edits; Pro `proModuleContract.test.js`, `eraseBoundary.pro.test.js`. |
| S9 | S | B7 evals and scripts; `package.json` (`check:pro-present`, `export:core`, remove `eval:ai`, `"license": "AGPL-3.0-only"`); `.github/workflows/cla.yml`. |
| C7 | C | B6 e2e, Playwright project, visual baselines. |
| C8 | C | Docs and licences (work split C list). |
