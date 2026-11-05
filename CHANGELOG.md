# Changelog

## [2.0.0](https://github.com/ChristianMunoz31/burrow/compare/v1.4.0...v2.0.0) (2026-11-05)


### ⚠ BREAKING CHANGES

* /api/license*, 403 pro_required and 409 update_license_window no longer exist.

### Features

* Burrow is free for everyone (remove trial, licenses and upgrade prompts) ([#123](https://github.com/ChristianMunoz31/burrow/issues/123)) ([172c2ef](https://github.com/ChristianMunoz31/burrow/commit/172c2ef586a465e1b65574fa4265243d8bfa0afe))
* **core:** open-core split, AGPL core with a private Pro module ([#121](https://github.com/ChristianMunoz31/burrow/issues/121)) ([2fb33de](https://github.com/ChristianMunoz31/burrow/commit/2fb33def6ab403fc03903a09c0be0f4bb0f2220f))


### Bug Fixes

* **ci:** make the main checks green on Linux runners and Rust 1.99 ([#122](https://github.com/ChristianMunoz31/burrow/issues/122)) ([a053378](https://github.com/ChristianMunoz31/burrow/commit/a053378ecef8c1fd96d2cd1a11e89a556734c779))
* **store:** ship the userprofile data location after the 10.6.3 capability refusal ([#114](https://github.com/ChristianMunoz31/burrow/issues/114)) ([cb39fb1](https://github.com/ChristianMunoz31/burrow/commit/cb39fb1479ab57545e98e6255e63e6faec41016d))


### Documentation

* **release:** add v1.4.0 release notes ([b9402eb](https://github.com/ChristianMunoz31/burrow/commit/b9402eb07301ee477b6088d914d1927a00add5aa))

## [1.4.0](https://github.com/ChristianMunoz31/burrow/compare/v1.3.0...v1.4.0) (2026-10-15)


### Features

* **budget:** reorder and maximize the dashboard chart cards (saved as pos:budgetLayout) ([4ce4cff](https://github.com/ChristianMunoz31/burrow/commit/4ce4cff75f4b15a47d543703118d9c72bb0365c7))
* **javi,nav,budget:** Javi characters, hidden subcategories, larger launcher, budget chart layout ([#110](https://github.com/ChristianMunoz31/burrow/issues/110)) ([4ce4cff](https://github.com/ChristianMunoz31/burrow/commit/4ce4cff75f4b15a47d543703118d9c72bb0365c7))
* **javi:** butler voice and four selectable characters (Butler is free; Valet, Concierge and Majordomo are the Pro feature javi_characters) ([4ce4cff](https://github.com/ChristianMunoz31/burrow/commit/4ce4cff75f4b15a47d543703118d9c72bb0365c7))
* **javi:** larger launcher pill, action rows and category labels in replies ([4ce4cff](https://github.com/ChristianMunoz31/burrow/commit/4ce4cff75f4b15a47d543703118d9c72bb0365c7))
* **nav:** hide subcategories in the menu (Settings &gt; General) ([4ce4cff](https://github.com/ChristianMunoz31/burrow/commit/4ce4cff75f4b15a47d543703118d9c72bb0365c7))
* **release:** release:auto can merge the feature PR and the release PR on request ([#111](https://github.com/ChristianMunoz31/burrow/issues/111)) ([36157bd](https://github.com/ChristianMunoz31/burrow/commit/36157bd982e159f237506464299521f1a99ca50e))


### Performance

* **build:** stub d3-time-format and lazy-load drag and drop ([4ce4cff](https://github.com/ChristianMunoz31/burrow/commit/4ce4cff75f4b15a47d543703118d9c72bb0365c7))

## [1.3.0](https://github.com/ChristianMunoz31/burrow/compare/v1.2.0...v1.3.0) (2026-10-13)


### Features

* **release:** release:auto, one resumable command for the no-Actions release ([#105](https://github.com/ChristianMunoz31/burrow/issues/105)) ([b939c18](https://github.com/ChristianMunoz31/burrow/commit/b939c183c69accc393db82960c034fbff81e5964))
* **shell,javi:** navigation hierarchy, two-tier icons, and single greeting area in Javi overview insight ([#108](https://github.com/ChristianMunoz31/burrow/issues/108)) ([f4554b0](https://github.com/ChristianMunoz31/burrow/commit/f4554b08f25fb9eb7fa9672d5e13a08e154800e7))

## [1.2.0](https://github.com/ChristianMunoz31/burrow/compare/v1.1.0...v1.2.0) (2026-10-11)


### Features

* back button and minimalist UI pass ([#87](https://github.com/ChristianMunoz31/burrow/issues/87)) ([9ba27a5](https://github.com/ChristianMunoz31/burrow/commit/9ba27a599116f6337c2b60139959f2a697d65cb0))
* Budget and Journal workspaces ([#91](https://github.com/ChristianMunoz31/burrow/issues/91)) ([2db9483](https://github.com/ChristianMunoz31/burrow/commit/2db94838cfc1e684d17796501612c283585b017d))
* **home,javi:** Javi card on Home, Calendar without weather, desktop:dev normal UI by default ([#100](https://github.com/ChristianMunoz31/burrow/issues/100)) ([fa2e77f](https://github.com/ChristianMunoz31/burrow/commit/fa2e77f56d7b9b5037ed8482640190f9500c544b))
* **javi:** DM-style helper with code-only insight notifications ([#93](https://github.com/ChristianMunoz31/burrow/issues/93)) ([f1464a7](https://github.com/ChristianMunoz31/burrow/commit/f1464a71175eeb39d3a6f11b758f26d73fa346ba))
* shared calculator and Home Budget card, with a parse-only GFM bundle saving ([#92](https://github.com/ChristianMunoz31/burrow/issues/92)) ([8b4e0a2](https://github.com/ChristianMunoz31/burrow/commit/8b4e0a2506e8d64bbe1ced345dad41ea9f923cd0))
* **shell,javi:** menu section dropdowns, dimmed Back on Home, Javi notice for the current page ([#99](https://github.com/ChristianMunoz31/burrow/issues/99)) ([ea4baa5](https://github.com/ChristianMunoz31/burrow/commit/ea4baa5a2ae69a5a247df309b50f4389d15797ba))
* **shell:** calm top bar, one-workspace menu, Calendar & Weather in both, Javi message bar ([#97](https://github.com/ChristianMunoz31/burrow/issues/97)) ([7d50829](https://github.com/ChristianMunoz31/burrow/commit/7d50829a77cde97b4685d1861bf74c92bfb22904))
* **shell:** one menu with Budget, Productivity and Health sections; workspaces removed ([#98](https://github.com/ChristianMunoz31/burrow/issues/98)) ([560d14b](https://github.com/ChristianMunoz31/burrow/commit/560d14be9e71c39b836d377f1aabe4f750658991))
* **shell:** workspace switch in the menu, Journal takes over Life, Calendar & Weather, Budget Home Subscriptions card ([#96](https://github.com/ChristianMunoz31/burrow/issues/96)) ([118c3b8](https://github.com/ChristianMunoz31/burrow/commit/118c3b8936eac148314ca1ea40bfc836d6ed8216))
* **weather:** typed location in Settings, device location only on click ([#101](https://github.com/ChristianMunoz31/burrow/issues/101)) ([7caea4a](https://github.com/ChristianMunoz31/burrow/commit/7caea4a91fb57d953f620f7f49498f7b29f7cb05))


### Performance

* **bundle:** native structuredClone replaces the [@ungap](https://github.com/ungap) polyfill in the MarkdownImpl chunk (build-only plugin). Total JS 479,913 -&gt; 479,804 B gzip, under the design's delta &lt;= 0 gate. ([f1464a7](https://github.com/ChristianMunoz31/burrow/commit/f1464a71175eeb39d3a6f11b758f26d73fa346ba))


### Documentation

* **release:** runbook for [#96](https://github.com/ChristianMunoz31/burrow/issues/96) to [#101](https://github.com/ChristianMunoz31/burrow/issues/101), privacy policy 1.2 ([#102](https://github.com/ChristianMunoz31/burrow/issues/102)) ([cbc27b9](https://github.com/ChristianMunoz31/burrow/commit/cbc27b9e0f17ca8c7a8e914ff297b40f217ff596))
* **release:** v1.2.0 notes, store copy and owner runbook ([#94](https://github.com/ChristianMunoz31/burrow/issues/94)) ([dde1430](https://github.com/ChristianMunoz31/burrow/commit/dde1430f3dd651929950c508a0384a3081522f56))

## [1.1.0](https://github.com/ChristianMunoz31/burrow/compare/v1.0.0...v1.1.0) (2026-10-09)


### Features

* **folders:** local folder inventory, summaries, exports and Pro ask/report; PDF/DOCX support coming later ([#61](https://github.com/ChristianMunoz31/burrow/issues/61)) ([3e511fe](https://github.com/ChristianMunoz31/burrow/commit/3e511feed5b44211446ea4ed8e562ad53857528f))
* **updates:** Settings &gt; Updates, Check for updates menu item and manual download ([#64](https://github.com/ChristianMunoz31/burrow/issues/64)) ([f62c698](https://github.com/ChristianMunoz31/burrow/commit/f62c6985435e2ceca19aee414908f66f60d44436))


### Bug Fixes

* **folders:** Re-scan no longer sticks after a fast scan, and files are checked before they are read ([#82](https://github.com/ChristianMunoz31/burrow/issues/82)) ([525de41](https://github.com/ChristianMunoz31/burrow/commit/525de41ba49b8960ce81f73ba651f1448a1f3275))


### Performance

* **javi:** faster, better-grounded Javi on small local models ([#66](https://github.com/ChristianMunoz31/burrow/issues/66)) ([c2a0563](https://github.com/ChristianMunoz31/burrow/commit/c2a0563b65590f35d849ba0a4de0037502f904cb))

## [1.0.0](https://github.com/ChristianMunoz31/burrow/compare/v0.4.1...v1.0.0) (2026-10-08)


### chore

* release 1.0.0 ([c032b06](https://github.com/ChristianMunoz31/burrow/commit/c032b06edb7d22eea7936b7cbf7c4c065105de4d))


### Features

* **desktop:** add desktop:install to keep this PC's Burrow up to date ([#46](https://github.com/ChristianMunoz31/burrow/issues/46)) ([59b4f5d](https://github.com/ChristianMunoz31/burrow/commit/59b4f5d3367713df81a5e1211c2b3f95b434545d))
* **desktop:** brand the Burrow and Burrow Dev installers ([#55](https://github.com/ChristianMunoz31/burrow/issues/55)) ([2b4e275](https://github.com/ChristianMunoz31/burrow/commit/2b4e2751eec10d78808656cbf381bccf04fd7ab3))
* **desktop:** opt-in in-app updates with signed installers ([#47](https://github.com/ChristianMunoz31/burrow/issues/47)) ([5da9de0](https://github.com/ChristianMunoz31/burrow/commit/5da9de0925c10c8693786e96ec7bdfab7ebe8fc7))
* **javi:** Free gets one read-only insight per page; conversational Javi is Pro ([#53](https://github.com/ChristianMunoz31/burrow/issues/53)) ([7fc0bed](https://github.com/ChristianMunoz31/burrow/commit/7fc0bed1115061ce5eccbf672ff0b61af1dc2017))
* **license:** developer tier switcher for dev builds ([#48](https://github.com/ChristianMunoz31/burrow/issues/48)) ([53a8662](https://github.com/ChristianMunoz31/burrow/commit/53a86629fe63e467de5385dadc58f570a0261351))
* **settings:** show version, channel, commit and build date ([#39](https://github.com/ChristianMunoz31/burrow/issues/39)) ([07413e7](https://github.com/ChristianMunoz31/burrow/commit/07413e783aa9c99b0b2ecf731ef2a597643b7a7e))
* **store:** Microsoft Store (MSIX) edition with userprofile fallback and per-feature Store Pro ([#58](https://github.com/ChristianMunoz31/burrow/issues/58)) ([ed882a1](https://github.com/ChristianMunoz31/burrow/commit/ed882a104a3214a63426a5692f0e0b7c3926ca76))
* **ux:** streamline interactions, states and copy across the app ([#52](https://github.com/ChristianMunoz31/burrow/issues/52)) ([8694da3](https://github.com/ChristianMunoz31/burrow/commit/8694da3c1d9847dd4b69a577bde8089f3aa79e6b))


### Bug Fixes

* **license:** audit and tighten Free/Pro/trial tier gates ([#50](https://github.com/ChristianMunoz31/burrow/issues/50)) ([dc37c24](https://github.com/ChristianMunoz31/burrow/commit/dc37c2445c47581bcd03da6c3d191fbfef91dafd))
* **test:** preload the DataBrowser overview chunk before its tests ([#57](https://github.com/ChristianMunoz31/burrow/issues/57)) ([26fe24f](https://github.com/ChristianMunoz31/burrow/commit/26fe24f2effee2d1b736d15b75937ba11c31f8cb))
* **todos:** put status-less todos in the first column after a rename ([#56](https://github.com/ChristianMunoz31/burrow/issues/56)) ([29ddd28](https://github.com/ChristianMunoz31/burrow/commit/29ddd28670374d7da4e245684d5b8fdacd55aacc)), refs [#54](https://github.com/ChristianMunoz31/burrow/issues/54)


### Performance

* statement cache, indexes, lazy node-ical, deduped mime-db, lazy chart widgets ([#51](https://github.com/ChristianMunoz31/burrow/issues/51)) ([52a37ba](https://github.com/ChristianMunoz31/burrow/commit/52a37baead9c36d63124ee0196283b10419dc14f))


### Documentation

* **release:** document releasing without GitHub Actions ([#45](https://github.com/ChristianMunoz31/burrow/issues/45)) ([a425728](https://github.com/ChristianMunoz31/burrow/commit/a425728944565ac93d718e6c745c265e731f7d11))

## [0.4.1](https://github.com/ChristianMunoz31/burrow/compare/v0.4.0...v0.4.1) (2026-10-07)


### Features

* **license:** add a Buy Burrow Pro button that opens the store page ([#43](https://github.com/ChristianMunoz31/burrow/issues/43)) ([5da840e](https://github.com/ChristianMunoz31/burrow/commit/5da840ecc408892b73015d0750fd670ab8761e72))

## [0.4.0](https://github.com/ChristianMunoz31/burrow/compare/v0.3.0...v0.4.0) (2026-10-07)


### Features

* **data:** erase all my data with typed confirmation and a two-step server token ([#35](https://github.com/ChristianMunoz31/burrow/issues/35)) ([2a33ef9](https://github.com/ChristianMunoz31/burrow/commit/2a33ef9ab69dce6b7e3a1302d409cf987e21d5a7))
* **licensing:** reverse trial with automatic 14-day Pro on first launch ([#41](https://github.com/ChristianMunoz31/burrow/issues/41)) ([244ccb9](https://github.com/ChristianMunoz31/burrow/commit/244ccb9e20f16795221d8b3ec470e0d3385aea14))
* **release:** release:local, self-hosted ARM64 runner prep, design guide and Gumroad sync ([#34](https://github.com/ChristianMunoz31/burrow/issues/34)) ([1acf4b7](https://github.com/ChristianMunoz31/burrow/commit/1acf4b79cd02f5ad16de7f9bcb2a9ff473d1c8a4))


### Documentation

* **product:** drop v0.3 version promise for the public core ([#33](https://github.com/ChristianMunoz31/burrow/issues/33)) ([a0029e2](https://github.com/ChristianMunoz31/burrow/commit/a0029e27b28a977d37590df90ada15e75e567571))

## [0.3.0](https://github.com/ChristianMunoz31/burrow/compare/v0.2.0...v0.3.0) (2026-10-06)


### Features

* **privacy:** network activity view and verify-it-yourself guide ([#31](https://github.com/ChristianMunoz31/burrow/issues/31)) ([b27de73](https://github.com/ChristianMunoz31/burrow/commit/b27de73e5bc5de132a1dabd41fd94ff669e64aac))


### Bug Fixes

* **deps:** patch prod advisories, harden Pro gating and fix docs ([#25](https://github.com/ChristianMunoz31/burrow/issues/25)) ([850b8f6](https://github.com/ChristianMunoz31/burrow/commit/850b8f694c380226bc88d260ffbad21144d528a3))
* **javi:** show the cloud message when the final pass is refused ([#30](https://github.com/ChristianMunoz31/burrow/issues/30)) ([b1101e9](https://github.com/ChristianMunoz31/burrow/commit/b1101e95aeb189c58f094a482b32c0bbd8593949))
* post-launch batch 2 (cold model load, public update check, user-facing release notes, advice figures) ([#32](https://github.com/ChristianMunoz31/burrow/issues/32)) ([44dab90](https://github.com/ChristianMunoz31/burrow/commit/44dab9084e2fda03cf1ddff515bffc7c4b91fa15))
* post-launch issues (journal dates, cloud-off order, request validation, contrast) ([#26](https://github.com/ChristianMunoz31/burrow/issues/26)) ([bec5408](https://github.com/ChristianMunoz31/burrow/commit/bec54085474aa71b30e2658a172ebb8a05a644ac))


### Documentation

* **product:** log the multi-product strategy decision ([#29](https://github.com/ChristianMunoz31/burrow/issues/29)) ([7f693ac](https://github.com/ChristianMunoz31/burrow/commit/7f693acb96e1468a817a7aedf17f16e35ada6c79))

## [0.2.0](https://github.com/ChristianMunoz31/burrow/compare/burrow-v0.1.0...burrow-v0.2.0) (2026-10-05)


### ⚠ BREAKING CHANGES

* **javi:** /assistant and /api/assistant/* are removed.
* /ui-builder, /surveys, /github and /agents routes and their APIs, /api/storage/status, /api/insights and the github and keyTest network features are gone.

### refactor

* **javi:** make the Javi panel the only way to talk to the AI ([f20a68f](https://github.com/ChristianMunoz31/burrow/commit/f20a68f034814e03bd4b4104524230b6ea2c0fd4))
* remove developer and builder tools from the product ([eedfb5f](https://github.com/ChristianMunoz31/burrow/commit/eedfb5ff42ac902b1d7b204abc5da4688e593c52))


### Features

* **ai:** add cloud AI consent, per-category limits and SSRF guard ([596a80b](https://github.com/ChristianMunoz31/burrow/commit/596a80bd0bbd3c79aac4befad786aa6eb53676b4))
* **ai:** add Ollama setup status, RAM-based model recommendation and local model pull ([3ca098b](https://github.com/ChristianMunoz31/burrow/commit/3ca098bacf64d0f76860bda7cd069a329ffadbed))
* **ai:** local AI via Ollama behind a single server/ai module ([a81436f](https://github.com/ChristianMunoz31/burrow/commit/a81436f3dd525596377282d5baf1b515b3a23a61))
* **appearance:** add the Founder background for founding licenses ([a9c2fef](https://github.com/ChristianMunoz31/burrow/commit/a9c2fef328d14450f4702839bbb6fa38b09288b2))
* **backup:** add an automatic backups switch with a gentle reminder when off ([9dd76b2](https://github.com/ChristianMunoz31/burrow/commit/9dd76b29382733ba0c00a6f50296d61fb5dadcc9))
* **backup:** add automatic daily local backups with verified restore ([b9d8ca9](https://github.com/ChristianMunoz31/burrow/commit/b9d8ca9472538f11d80b7fa8ff9a3b693a0b2665))
* **budget:** import transactions from a CSV file ([21394b2](https://github.com/ChristianMunoz31/burrow/commit/21394b27b71ee5efa255624e086e7076a6bf325b))
* **desktop:** add Tauri v2 desktop app with Node SEA sidecar and NSIS installer ([613471f](https://github.com/ChristianMunoz31/burrow/commit/613471f65f4131905cd470bbb43abee816ecde6c))
* **desktop:** build Burrow Dev as a separate side-by-side app with npm run desktop:build:dev ([4f48a74](https://github.com/ChristianMunoz31/burrow/commit/4f48a74b072e72f2c3b9a1823cc58fa1e4e8efe4))
* **dev:** add demo-data sandbox and local branch previews ([945d746](https://github.com/ChristianMunoz31/burrow/commit/945d746af3fc4f9e7f5461d0611d7fadd4d2bf10))
* **license:** activate Gumroad and Lemon Squeezy license keys ([cfc01d5](https://github.com/ChristianMunoz31/burrow/commit/cfc01d5ec39214694efe67129c28c81d14817e7c))
* **license:** add a local 7-day Pro trial with HMAC-protected state ([7c1ee09](https://github.com/ChristianMunoz31/burrow/commit/7c1ee093055e0e681f81aa6e0619f9c0d0db5236))
* **license:** add ProTrialPrompt and the day-6 trial reminder ([8801d0e](https://github.com/ChristianMunoz31/burrow/commit/8801d0e0dbaef85828bc62fd497b059f5db31378))
* **license:** configure the Gumroad Burrow Pro and student products ([692bf25](https://github.com/ChristianMunoz31/burrow/commit/692bf25f6b8aeab5f29be13da58e2ee2db4e4429))
* **license:** default yearly student/nonprofit and two-year founding licenses in mint ([0d06f93](https://github.com/ChristianMunoz31/burrow/commit/0d06f9392e63591a792dfde0a8939c7b32a1d780))
* **license:** read store product ids from config/store.json and map the hidden Gumroad student product ([67ae2ea](https://github.com/ChristianMunoz31/burrow/commit/67ae2ea5fb8f4928633e0f1388dc62d6060c1ee8))
* **license:** set the owner support contact for license help ([ea4ecdf](https://github.com/ChristianMunoz31/burrow/commit/ea4ecdfbafd57204234458cd945a837ad1f2e596))
* **license:** strip developer keys from release artifacts ([9b059ec](https://github.com/ChristianMunoz31/burrow/commit/9b059ec9754c291d0cfd581b262d967e9a988014))
* **license:** verify signed license files offline with build-date and clock-guard checks ([db82e72](https://github.com/ChristianMunoz31/burrow/commit/db82e729f1eb6981bb05250c31318f771d88e52d))
* **onboarding:** add guided Javi setup step with Get Ollama, model download and skip ([185357e](https://github.com/ChristianMunoz31/burrow/commit/185357e915a9ecbfd2b27448404863c33850cbb8))
* **pro:** gate Javi tools, briefings and insights behind Pro by capability ([a81c8d7](https://github.com/ChristianMunoz31/burrow/commit/a81c8d7136f0950b1bbcdf0ab8932176631b97c2))
* **server:** add desktop sidecar mode with per-launch secret, cookie gate and CSP ([628dca8](https://github.com/ChristianMunoz31/burrow/commit/628dca8d6b035fbbe619782d8f5f8ccd88bcfbd8))
* **server:** add the Burrow Dev channel with its own data, dev keys, update source and a one-way copy from Burrow ([603c606](https://github.com/ChristianMunoz31/burrow/commit/603c6066296e70f5db7734d4f4f836a8d6e79772))
* **settings:** activate store license keys in Settings &gt; License ([d31a38d](https://github.com/ChristianMunoz31/burrow/commit/d31a38dc33c3a71eae9a3be828b314945eec3da5))
* **settings:** add Backups section and a Home backup reminder ([250ef2d](https://github.com/ChristianMunoz31/burrow/commit/250ef2dece73087f1366c68d62cab3910c953dc3))
* **settings:** add cloud AI opt-in, category consent and Javi cloud badge ([8fc59b8](https://github.com/ChristianMunoz31/burrow/commit/8fc59b83e73dd8a5c5e45076ccf3c525b347159c))
* **settings:** add License section to import, view and remove a license ([a72edb7](https://github.com/ChristianMunoz31/burrow/commit/a72edb7485702ce82a1605f1a3c20bf4bb0cd604))
* **settings:** add opt-in update check against GitHub releases ([b05970e](https://github.com/ChristianMunoz31/burrow/commit/b05970e7fc610004defc747a3088f46eaf51e099))
* **settings:** add the Pro trial controls, renewal date and Founding member badge to License ([80e9441](https://github.com/ChristianMunoz31/burrow/commit/80e944135282a872a6e0db17290532e1e56dfd15))
* **settings:** lazy-load the License section and link activation from the Pro prompt ([04d4c75](https://github.com/ChristianMunoz31/burrow/commit/04d4c75e4679f53ceef476865f2d5dab9b10245c))
* **settings:** show a Dev build badge and a Copy my data from Burrow control in Burrow Dev ([dbbcd9f](https://github.com/ChristianMunoz31/burrow/commit/dbbcd9f0ed7c4cfc19929c6eeb16957fc5606ae8))
* **shell:** show the Founding member badge in the side menu footer ([aaeeef7](https://github.com/ChristianMunoz31/burrow/commit/aaeeef7f5937539c13d8984e7a0434eb56ae38f0))
* **theme:** make the Founder background bold with a gold-lit burrow motif ([a783b16](https://github.com/ChristianMunoz31/burrow/commit/a783b16415502ab5509f97cfa00feb3c6b49bc96))


### Bug Fixes

* **ai:** keep cloud consent across backup restore and fall back to local on cloud setup errors ([c86c974](https://github.com/ChristianMunoz31/burrow/commit/c86c9745a3bcf34f705f93acb47167aba2d62700))
* **backup:** keep import-protected app state, such as the license clock, across a restore ([60b2419](https://github.com/ChristianMunoz31/burrow/commit/60b241979f9abd67f0e535c5ac2c5d90e5dcd6da))
* **budget:** fall back to actual spend when no expense plan exists ([428a766](https://github.com/ChristianMunoz31/burrow/commit/428a7662cf311994a23bd7f5fa6630d4298be743))
* **checks:** harden the dev key and trial store edge cases ([a225986](https://github.com/ChristianMunoz31/burrow/commit/a225986b17a27230996726b7f3b07aebde9be982))
* **copy:** remove em and en dashes from user-facing UI copy ([5cf1ed2](https://github.com/ChristianMunoz31/burrow/commit/5cf1ed2de241c1f1909f57ab744f1d876236362a))
* **desktop:** explain a failed restore recovery and other server exits in a native dialog ([c30e74e](https://github.com/ChristianMunoz31/burrow/commit/c30e74e3a382b65cc94b8a79eb749efdc148acf2)), closes [#8](https://github.com/ChristianMunoz31/burrow/issues/8)
* **desktop:** pin sidecar PATH on macOS and Linux and make desktop tests host-independent ([9ec0863](https://github.com/ChristianMunoz31/burrow/commit/9ec08632041cd3a63340b2cb17f2998e68def44e))
* **docker:** pin the base image by tag and digest so Dependabot tracks node:24-bookworm-slim ([#16](https://github.com/ChristianMunoz31/burrow/issues/16)) ([67f0875](https://github.com/ChristianMunoz31/burrow/commit/67f0875e5e7c18dda5bb48c9fbb562f25812343d))
* **javi:** hiding the Javi button only hides the launcher ([09dfdef](https://github.com/ChristianMunoz31/burrow/commit/09dfdefdc94b7fba794ed0f6c486172eee1c7a92))
* **javi:** precompute habit history and briefing counts for the model ([4282c09](https://github.com/ChristianMunoz31/burrow/commit/4282c09624376b0e7f53b34c4ed8e8a8fdf355e7))
* **license:** fail closed on clock rollback for trials and yearly licenses ([59c13d3](https://github.com/ChristianMunoz31/burrow/commit/59c13d338c02a8a5cf9095360e97f7c0719f4927))
* **license:** harden activation timestamps, test hooks and the desktop build date ([c1a919c](https://github.com/ChristianMunoz31/burrow/commit/c1a919c020157ec74cda6202e573169ca37df152))
* **license:** stop re-reading clock evidence once a valid record exists and harden key checks ([c1f5afd](https://github.com/ChristianMunoz31/burrow/commit/c1f5afd402e179a6e4aaa455f1f2f9652ff0e4c0))
* **release:** move installers through private release assets and emit standard SHA256SUMS lines ([#24](https://github.com/ChristianMunoz31/burrow/issues/24)) ([2b7b3ff](https://github.com/ChristianMunoz31/burrow/commit/2b7b3ffcf1946fe7c7e92f08c88f92721fb0ac94))
* **release:** pass BURROW_SHELL_CHANNEL in the sidecar smoke test ([55f70ad](https://github.com/ChristianMunoz31/burrow/commit/55f70ad659b50a8cd21f97bcbdba595ea23e768c))
* **seed:** never write demo timestamps later than now ([fc0555e](https://github.com/ChristianMunoz31/burrow/commit/fc0555e98e5624c1e2692785518d60f49476c7f0))
* **seed:** require an ISO, non-future --now and harden the clock test ([8a35abf](https://github.com/ChristianMunoz31/burrow/commit/8a35abf6ffd570d75da0a6c42ab67880a7eb13e5))
* **server:** centralize Dev channel detection and tighten isolation checks ([93d72eb](https://github.com/ChristianMunoz31/burrow/commit/93d72ebbae5ec4f62143269c8ba8d275fb783073))
* **settings:** avoid a second add-license prompt after the trial ends ([28c1481](https://github.com/ChristianMunoz31/burrow/commit/28c14810c810c0c9f80328ba383b3592623a2ba3))
* **settings:** make the License section readable in the light theme ([8fdb1f3](https://github.com/ChristianMunoz31/burrow/commit/8fdb1f3bf8253ea9d6e9b5c722c635a047dd8d49))
* **settings:** refresh trial state on conflict, keep focus and align copy with license state ([2f42573](https://github.com/ChristianMunoz31/burrow/commit/2f42573888fea20a8f3790cf904177d10dc38d93))
* **test:** make javi advisor auth test hermetic and block real network in tests ([af769b5](https://github.com/ChristianMunoz31/burrow/commit/af769b530e93c582387593d55c5eb22d914e9ee9))
* **theme:** apply the Founder background only with a known or cached founding perk ([64f415e](https://github.com/ChristianMunoz31/burrow/commit/64f415ec15449c8fdcda8cb134944aefad296f2f))


### Performance

* **backup:** run snapshot, checks and the backup export in a worker thread ([fc701de](https://github.com/ChristianMunoz31/burrow/commit/fc701de5198bd713f8c27a172a29c2cf58b9b1f4)), closes [#7](https://github.com/ChristianMunoz31/burrow/issues/7)
* **settings:** drop redundant License controls and dead code to fit the bundle budget ([d3fdcb9](https://github.com/ChristianMunoz31/burrow/commit/d3fdcb9a53ffa6e6edcf747a86142c7202a9d897))
* **settings:** trim the License section bundle ([aa4ba53](https://github.com/ChristianMunoz31/burrow/commit/aa4ba5375f738dd32addf6480adc84439e30dc1c))


### Documentation

* add contributing guide, eval guide and development workflow ([005ad9a](https://github.com/ChristianMunoz31/burrow/commit/005ad9aeb1047e5d78225b8de34f536083ef1bc5))
* add desktop install guide and document the desktop app ([25fc5ef](https://github.com/ChristianMunoz31/burrow/commit/25fc5eff0b409d300e02dda9c16aa78af4bc29ed))
* add product strategy (docs/PRODUCT.md) and link from CLAUDE.md ([38c6808](https://github.com/ChristianMunoz31/burrow/commit/38c68086ca779d688d136973d67e0b2880a62ad4))
* document backups and restore ([c0e47b9](https://github.com/ChristianMunoz31/burrow/commit/c0e47b91743d263d380ef9f8064c83337a2e9772))
* document local AI setup with Ollama ([46f0a86](https://github.com/ChristianMunoz31/burrow/commit/46f0a86f4653915f9ecd61022b3eba49d5e8add3))
* document Pro gating by capability ([f55c220](https://github.com/ChristianMunoz31/burrow/commit/f55c220abcf7b054b0707a637df4ee0ae932db20))
* document store license keys, config/store.json and the Gumroad launch decisions ([4ceb27b](https://github.com/ChristianMunoz31/burrow/commit/4ceb27b1ec8f9f0d3130a2e33e61b57046823b80))
* document the Burrow Dev channel ([b5bbd8a](https://github.com/ChristianMunoz31/burrow/commit/b5bbd8abb6fb58385a6f84fdd90173b7a1a3b771))
* **license:** add offline licensing spec and switch merchant of record to Lemon Squeezy ([613f258](https://github.com/ChristianMunoz31/burrow/commit/613f2586c1f7abe934d73cad0eba5a86cdddc2b9))
* **license:** align rollback wording with expired-past-end behaviour ([cd02a13](https://github.com/ChristianMunoz31/burrow/commit/cd02a13b3234a23018debfd10bf4056aab701222))
* **license:** document licensing modules, key checks and release build info ([9d14398](https://github.com/ChristianMunoz31/burrow/commit/9d14398a328bf418a9521486535796017e40f9c6))
* **license:** document the local trial, yearly licenses and dev key stripping ([8474e91](https://github.com/ChristianMunoz31/burrow/commit/8474e911aa7456301f7bab099669d372b7a8e9e1))
* **licensing:** align the threat model with the private-source launch ([d9cb24b](https://github.com/ChristianMunoz31/burrow/commit/d9cb24baba4d6995b3790ea30411a10b82a4a789))
* **licensing:** Founding is on sale through 2027-01-05 ([6e414b7](https://github.com/ChristianMunoz31/burrow/commit/6e414b76d9b1f9d3dc75670c732aa993b985caec))
* **licensing:** record clock rollback and founding hand-mint decisions ([f61d74b](https://github.com/ChristianMunoz31/burrow/commit/f61d74b53a24562f9ac7e4fe9150096a93a59b96))
* **licensing:** specify store license keys (Gumroad, Lemon Squeezy) and record the owner decisions ([4940b22](https://github.com/ChristianMunoz31/burrow/commit/4940b2214986816f7cb235d024d90b9f1713e667))
* **licensing:** the License section is no longer lazy-loaded ([26d042c](https://github.com/ChristianMunoz31/burrow/commit/26d042cf1d2f4ebda5f36b9aa15e291258e31aa9))
* **product:** add the 'it just worked' north-star principle ([2a304c6](https://github.com/ChristianMunoz31/burrow/commit/2a304c6377c3fdbe675776a6cea57dfb876ecd23))
* **product:** align mission line with opt-in cloud AI decision ([ae0dab0](https://github.com/ChristianMunoz31/burrow/commit/ae0dab0e3de030535e4fb9c9a84ea59162bb6baa))
* **product:** keep the Founding edition on sale for 3 months ([b20c5be](https://github.com/ChristianMunoz31/burrow/commit/b20c5be1c03838d5e06882e36cf9cc1767f63251))
* **product:** record pricing, sync, Paddle and roadmap decisions ([2c74c93](https://github.com/ChristianMunoz31/burrow/commit/2c74c939082314e466f455051d82045fc67804de))
* **product:** record the public-core, private-Pro trust model ([a233597](https://github.com/ChristianMunoz31/burrow/commit/a2335975158c8b30be1832e23aa51f3d1e68f444))
* record the backup decisions and document the switch, worker and exit dialogs ([22e90ef](https://github.com/ChristianMunoz31/burrow/commit/22e90efe064ba111df8ff87df4fc31db2f308715))
* record the cloud AI decision and safeguards ([22d5277](https://github.com/ChristianMunoz31/burrow/commit/22d5277583e768bc5a27166ec06f4d44463e50b8))
* **release:** add the one-line Get-FileHash check to the public release notes ([8afa785](https://github.com/ChristianMunoz31/burrow/commit/8afa7856e4b76e61ca146adfb35a779e4b3f736a))
