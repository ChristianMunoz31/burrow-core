# Publishing the Burrow core (owner runbook)

Owner-only runbook for [ADR 0001](adr/0001-open-core-split.md) section 3.14. It covers the first publication of the core, the copy flip, later syncs and contribution intake. Contract and module boundary: [OPEN_CORE.md](OPEN_CORE.md).

**Status: sections 2 and 3 are done (2026-11-04): the core is published at https://github.com/ChristianMunoz31/burrow-core, and the copy flip (5.1) is applied in the private repo. Section 4 (the CLA check) is not done: the CLA is still a draft pending legal review.** Public copy may say the core is open source under AGPL-3.0-only. It must never say that the private module is open source or that its source is public (since 2026-11-05 Burrow is free for everyone, see [adr/0002-free-for-everyone.md](adr/0002-free-for-everyone.md)), and Docker self-hosting is not offered, so never claim "self-host".

Run every command from the root of the private core checkout, in PowerShell, unless it says otherwise. Use `npm.cmd` if `npm` is blocked by the execution policy.

## 1. Preconditions

Do not start until all of these are true.

- [ ] QA 7.1 (with the module) and QA 7.2 (core-only mode) of [adr/0001-work-split.md](adr/0001-work-split.md) section 7 are green. They include `npm run check`, the boundary tests and `npm run export:core -- --out "$env:TEMP\burrow-core-export"`. Not recorded here; confirm before the next sync.
- [ ] The dependency license audit is clean (ADR R13): review `THIRD_PARTY_NOTICES.md` and `npm ls --omit=dev --all` for any GPL, AGPL or LGPL package in the shipped bundles. Any hit blocks the first export. Team S runs this audit. Not recorded here; confirm before the next sync.
- [ ] You have had [CLA.md](CLA.md) reviewed by a lawyer (ADR R15). It is a draft until then. Deferred (2026-11-04): still a draft; the CLA check (section 4) stays off until the review is done.
- [ ] You have had [EULA.md](EULA.md) reviewed (ADR O5). It is a draft until then, and it is the notice for official builds that combine the AGPL core with the proprietary Pro module. Deferred (2026-11-04): still a draft.
- [x] `package.json` has `"license": "AGPL-3.0-only"` and `LICENSE` is the AGPL text with the Burrow header (a Team S and Team C deliverable). Checked 2026-11-04.
- [ ] The private working tree is clean (`git status --porcelain` prints nothing). `export:core` refuses a dirty tree. Not recorded here; confirm before the next sync.
- [x] You decided the public repo name (O4): `ChristianMunoz31/burrow-core`, see section 3.1.

## 2. Export the core

Done 2026-11-04.

```powershell
npm run export:core -- --out "$env:USERPROFILE\burrow-core-export"
```

`--out` must be a new folder OUTSIDE the private repo. What the script does (`scripts/release/exportCore.mjs`):

1. `git archive --format=tar HEAD`, which honours `export-ignore` from `.gitattributes`. `pro/` is untracked, so it is never in the archive.
2. Extracts the archive into `--out`.
3. Runs `checkCoreTree(<out>)` (`scripts/checks/coreTreeGuard.js`). It refuses when: any path is under `pro/` or `devtools/`; a non-Markdown file contains the private header; a runtime core file other than the loader names `pro/`; `BURROW_DEV_TOOLS=on` or `BURROW_PRO=on` appears outside their allowlisted holders; or an owner-chosen export-ignore path is present.

It also refuses: an `--out` inside the private repo; an `--out` whose `.git` has a remote URL equal to the private repo's `origin` URL or containing `burrow-pro`; and a dirty working tree.

Per owner decision O3, the export leaves out `.claude/`, `.github/workflows/release.yml`, `desktop-windows.yml`, `dev-build.yml` and `release-please.yml`, `scripts/runner/`, `docs/release-runbook-*.md`, `docs/SELF_HOSTED_RUNNER.md` and `config/msstore.json`, on top of `pro/` and `devtools/`.

Before you publish anything, look at the export yourself: open the folder, check that `pro/` and `devtools/` are absent, and search it for your personal data and secrets (`npm run check` inside the export is a good start: `npm ci` is not needed, only Node).

## 3. Create the public repo and make the first commit

Done 2026-11-04.

### 3.1 Naming (owner decision O4)

**Decision (2026-11-04): the alternative below was chosen.** The private working repo stays `ChristianMunoz31/burrow`, the public repo is `ChristianMunoz31/burrow-core`, and Pro is `ChristianMunoz31/burrow-pro`. No rename happened and no code changes were needed. The table and the rename notes that follow are kept as context for the default that was not chosen.

The recommended default (not chosen) was:

| Repo | Visibility | Role |
| --- | --- | --- |
| `ChristianMunoz31/burrow-dev` | private | The renamed private working repo (today `ChristianMunoz31/burrow`) |
| `ChristianMunoz31/burrow` | public | The published core |
| `ChristianMunoz31/burrow-pro` | private | The Pro module (`pro/`) |
| `ChristianMunoz31/burrow-releases` | public | Installers and checksums (unchanged) |

**Check before you rename.** The name `ChristianMunoz31/burrow` for the private repo is hard-coded in the release tooling and its tests. A rename needs a dedicated change first, in at least: `server/updateCheck.js` (the Burrow Dev update query), `scripts/release/releaseLocal.mjs`, `scripts/release/releaseAuto.mjs`, `scripts/release/lib/releaseAutoPlan.mjs`, `.github/workflows/release.yml`, `scripts/runner/setup-runner.ps1`, `scripts/runner/job-started.ps1`, the docs `docs/RELEASING.md`, `docs/SELF_HOSTED_RUNNER.md`, `docs/PIPELINE.md`, `CONTRIBUTING.md`, the release-please config and the tests that pin the name (`server/__tests__/releaseLocal.test.js`, `releaseAuto.test.js`, `releaseRunner.test.js`, `publishPublic.test.js` and others). Find them with:

```powershell
git grep -n "ChristianMunoz31/burrow" -- . ":(exclude)CHANGELOG.md"
```

The alternative, which was chosen, keeps the private repo as `ChristianMunoz31/burrow` and gives the public repo a different name, `ChristianMunoz31/burrow-core`. Then no code changes. The rest of this runbook uses `ChristianMunoz31/burrow-core` for the public repo.

| Repo | Visibility | Role (as chosen) |
| --- | --- | --- |
| `ChristianMunoz31/burrow` | private | The private working repo (name unchanged) |
| `ChristianMunoz31/burrow-core` | public | The published core |
| `ChristianMunoz31/burrow-pro` | private | The Pro module (`pro/`) |
| `ChristianMunoz31/burrow-releases` | public | Installers and checksums (unchanged) |

### 3.2 Create the repo and push a fresh root commit

The public history is its own. Never push the private repo to a public remote.

```powershell
# 1. SKIPPED under the chosen naming (the private repo keeps the name burrow).
#    Default naming only: rename the private repo, then fix the local remote
# gh repo rename burrow-dev -R ChristianMunoz31/burrow
# git remote set-url origin https://github.com/ChristianMunoz31/burrow-dev.git

# 2. Create the empty public repo (no README, no license, no .gitignore from GitHub)
gh repo create ChristianMunoz31/burrow-core --public

# 3. First commit: fresh root commit from the export
cd "$env:USERPROFILE\burrow-core-export"
git init -b main
git add -A
git commit -m "chore(core): initial public export"
git remote add origin https://github.com/ChristianMunoz31/burrow-core.git
git push -u origin main
```

The first commit message is a conventional commit. Later syncs use `chore(core): sync from vX.Y.Z` (section 6). In the public repo settings, turn on branch protection for `main` as you prefer, and keep the `cla-signatures` branch unprotected (section 4), because the CLA action has to write to it.

## 4. Enable the CLA check

`.github/workflows/cla.yml` is part of the export and active only when the repository variable `BURROW_PUBLIC_CORE` is `true`. It uses CLA Assistant Lite (a GitHub Action).

1. Create the signatures branch (an empty orphan branch):

   ```powershell
   cd "$env:USERPROFILE\burrow-core-export"
   git checkout --orphan cla-signatures
   git rm -rf .
   git commit --allow-empty -m "chore: create cla-signatures branch"
   git push origin cla-signatures
   git checkout main
   ```

2. Check that `.github/workflows/cla.yml` points the action at `docs/CLA.md` (the document input) and at the `cla-signatures` branch (the branch input). Fix it with a normal change in the private repo and re-export if not.
3. Turn the check on:

   ```powershell
   gh variable set BURROW_PUBLIC_CORE --body true -R ChristianMunoz31/burrow-core
   ```

4. Open a test pull request from a second GitHub account (or a throwaway fork) and confirm the bot comments, that replying `I have read the CLA Document and I hereby sign the CLA` records the signature on `cla-signatures`, and that the check turns green.

Do not enable `cla.yml` before [CLA.md](CLA.md) has had its legal review.

## 5. Copy flip list

Sections 2 and 3 are done (2026-11-04) and the copy flip below is applied in the private repo. Keep this list as the record of what changed. Find lines by their text, because line numbers move. The binding rule stays after the flip: say only what is true, and keep the Pro module described as a private module.

### 5.1 Files to change

| File | What to change |
| --- | --- |
| `README.md` | The Roadmap bullet "Paid tier ... Burrow is open-core" (now a statement of fact). Add a short "Source" paragraph that links to the public repo and says the core is licensed under AGPL-3.0-only and that Pro features are a private module. The "License" section ("See LICENSE.") can then say AGPL-3.0-only for the core. |
| `docs/PRODUCT.md` | Monetization: the bullet that starts "Open core (planned for a future release)" becomes a statement of fact (core published under AGPL, Pro in a private module). Principle 6 ("Trust through transparency"): drop "will be public ... (planned for a future release; the source is private today)" and the "Until the core is published" sentence. Go to market item 1: drop "publishing the core code is planned for a future release, so do not promise public source before then". Open decision 1: drop "still depends on publishing the core". Roadmap Phase 4: drop "is planned for a future release". Add a dated decision log entry for the publication (date, public repo URL). The 2026-10-05 trust-model entry stays as history. |
| `CONTRIBUTING.md` | The "Contributions and the CLA" section: change "once the core is published" to the present tense and link the public repo. |
| `docs/CLA.md` and `docs/EULA.md` | Remove the "Draft" banner only after the legal review. |
| `CLAUDE.md` | The product-rule sentence "so the source is private and no copy may call it public or open source until then" and the open-core paragraph. Internal doc, but keep it accurate. |
| `package.json` | `"license": "AGPL-3.0-only"` (already applied by the split). |
| `src-tauri/src/menu.rs` | `about_comments` (the Help > About Burrow text, "Private, local-first budget and journal tracker."). Optional: add one short sentence about the core source. A Rust test in the same file pins the text, so update it with the string. |
| `src/components/settings/VerifyYourself.jsx` | Settings > Network "verify it yourself" section. Today it has no source wording. Optional: one sentence and a link to the public repo. |
| `src/components/settings/__tests__/NetworkActivity.test.jsx` | The test "has no em dashes and makes no claims about public source" fails on `open source`, `AGPL`, `self-host` and `public source` wording. Update it in the same change as any copy that uses those words. |
| `pages/` (privacy site, generated) | Currently has no source wording. If you add any, change `scripts/privacy/renderPrivacy.mjs` (or the registry it renders) and run `npm run privacy:render`, then re-publish the page to the `gh-pages` branch of `burrow-releases` as in `docs/RELEASING.md`. |
| `docs/INSTALL.md` | Optional: a "Source" line for people who want to read the code. |
| `docs/MICROSOFT_STORE.md` and `docs/store/chrome-prompts.md` | The Store listing copy (section 5 "Draft store listing" and prompt 4). Add the source sentence only if you want it in the listing; the Store copy rules in [DESIGN.md](DESIGN.md) still apply. |
| Gumroad pages (outside the repo) | Obsolete since 2026-11-05 (Burrow is free for everyone, ADR 0002): what happens to the Gumroad listing is an owner decision outside the code. The section 8 drafts are removed. |
| `burrow-releases` release notes | `release-notes/vX.Y.Z.md` for the first release that mentions it. No link to the private repo (the publish script refuses one). |

Do not touch: `docs/adr/*` (history), `CHANGELOG.md`.

### 5.2 After the flip

Run `npm run check` (em dash, personal data, keys). Sync the change to the public repo with a normal sync (section 6). Remove the "Draft" banners from `docs/CLA.md` and `docs/EULA.md` only when the reviewed text is in.

## 6. Sync procedure (every later release)

The private repo stays the working repo. The public repo gets one commit per sync, replacing the whole tree.

```powershell
# in the private repo, on the release commit, with a clean tree
npm run export:core -- --out "$env:USERPROFILE\burrow-core-export-vX.Y.Z"

# in the public clone: replace the tree with the export, keep .git
robocopy "$env:USERPROFILE\burrow-core-export-vX.Y.Z" "<path of the public clone>" /MIR /XD .git
cd "<path of the public clone>"
git status                       # review the diff
git add -A
git commit -m "chore(core): sync from vX.Y.Z"
git push origin main
```

`robocopy` exit codes 0 to 7 are success. Use a new, empty `--out` folder for each export. After the push, check that CI on the public repo is green (it runs core-only mode and asserts `--expect-pro absent`).

## 7. Contribution intake

1. A contributor opens a pull request on the public repo. The CLA check must be green.
2. Review it on the public repo. **Merge it there**, so the contributor is credited in the public history.
3. Apply the same patch to the private repo as its own commit, with a trailer naming the contributor:

   ```
   feat(scope): the same message

   Co-authored-by: <contributor name> <the contributor's GitHub no-reply address>
   ```

4. At the next release, export and sync (section 6). The sync must show **no diff** for that contribution: the exported tree already contains it, byte for byte. If it does show a diff, the patch was applied differently. Fix the private copy to match the merged version, and do not sync until it matches.
5. Never merge a public pull request that touches anything the export would leave out (for example `pro/` or `devtools/`): ask the contributor to drop it.

## 8. Gumroad copy draft (obsolete)

**Obsolete since 2026-11-05.** Burrow is free for everyone ([ADR 0002](adr/0002-free-for-everyone.md)), so the Free page and Pro page drafts that lived here are removed. What the owner decides about the Gumroad listing is outside the code. If any listing text is kept, the binding rules still apply: Burrow is a desktop app with a built-in helper, never "AI service", "access to AI", "AI tools" or a chatbot; no version number in the paragraph; no dashes; it may say the core source is on GitHub under AGPL, never that the private module is open source or that its source is public (ADR R1).

## 9. If something goes wrong

- `export:core` refuses: read its message. The usual causes are a dirty tree, an `--out` inside the repo, or a file that holds the private header. Fix the cause in the private repo, never edit the export by hand.
- You pushed the wrong thing to the public repo: make the repo private again at once (`gh repo edit ChristianMunoz31/burrow-core --visibility private --accept-visibility-change-consequences`), then tell the person in charge of the legal review. Pushed history cannot be un-published from forks or clones, so check the export before every push.
- You committed `pro/` into core: this should be stopped by the pre-commit hook (`pro/` paths and files with the private header). If it happens anyway, do not export until `git ls-files pro` prints nothing.
