# Releasing Burrow

Releasing is one action: merge the release PR. Everything after that is automatic. The source stays in the private repo `ChristianMunoz31/burrow`. Downloads go to the public repo `ChristianMunoz31/burrow-releases`, which only ever receives the two Windows installers and `SHA256SUMS.txt`, plus, once the in-app updater is switched on (see "Updater signing key"), their two `.sig` signature files and `latest.json`, as release assets. Nothing else is published as a release asset. The one other thing in that repo is the generated privacy policy site on a separate `gh-pages` branch (see `scripts/privacy/README.md`), which `publishPublic.js` never touches.

## One-time setup (owner)

The workflow needs one secret, `RELEASES_TOKEN`: a fine-grained personal access token that can write releases to `burrow-releases` and nothing else.

1. Open https://github.com/settings/personal-access-tokens/new
2. Token name: `burrow-releases publish`.
3. Resource owner: `ChristianMunoz31`.
4. Expiration: pick a date. One year with a calendar reminder a few weeks before is a good choice. GitHub also lets you choose no expiration for a fine-grained token; that is less safe, so only pick it if you accept the risk.
5. Repository access: **Only select repositories**, then choose `burrow-releases` (and nothing else).
6. Repository permissions: **Contents: Read and write**. Metadata (read-only) is added automatically. Leave everything else at No access.
7. Click **Generate token** and copy it.
8. Store it as a secret of the private repo. In PowerShell run the command below and paste the token when asked. The token is never shown again and never goes in the repo.

   ```powershell
   gh secret set RELEASES_TOKEN -R ChristianMunoz31/burrow
   ```

If the secret is empty when a release runs, the `publish-public` job stops early with an error that explains these steps. Nothing is published, and the other assets are still built.

A second secret is needed for the installer builds, `BURROW_PRO_DEPLOY_KEY`: a deploy key (read-only is enough) of the private `burrow-pro` repo, which holds the Pro module. The workflows that build installers or sidecars check `burrow-pro` out into `pro/` with it (see "The Pro module in official builds" below). Create the key pair yourself, outside the repo, add the public half as a deploy key of `burrow-pro` and store the private half as the secret. Never paste it into a file, a command or a message.

## Updater signing key (owner, one time)

Burrow can install a newer version from inside the app (Settings > Updates, only after the user opts in and clicks Download and install). Every update is signed. The release pipeline treats this as **off** until you give it a real public key, so nothing changes (exactly the three public assets, no signing) until you do the steps below. The decision is one rule: `plugins.updater.pubkey` in `src-tauri/tauri.release.conf.json` is either the placeholder `BURROW_UPDATER_PUBKEY_PLACEHOLDER` (off) or a real minisign public key (on).

The private key never goes in a repo. Create it once, with a password, outside every repository (PowerShell 5.1; use `npx.cmd`, because the execution policy can block `npx.ps1`):

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.burrow-keys" | Out-Null
npx.cmd tauri signer generate -w "$env:USERPROFILE\.burrow-keys\burrow-updater.key"
```

Type a strong password when it asks (the pipeline refuses an empty one). It writes two files: `burrow-updater.key` (private, keep it secret) and `burrow-updater.key.pub` (public).

1. **Paste the public key.** Open `$env:USERPROFILE\.burrow-keys\burrow-updater.key.pub`, copy its single line, and replace the value of `plugins.updater.pubkey` in `src-tauri/tauri.release.conf.json` (the text `BURROW_UPDATER_PUBKEY_PLACEHOLDER`) with it. Commit that file in a normal PR. This is the switch: the next release is signed and publishes six files.
2. **Create the GitHub Environment `release` and put the two secrets in it** (not in the repository's plain secrets, so a branch build, a pull request or a dry run can never read them). In the private repo open Settings > Environments > New environment, name it `release`, and under "Deployment branches and tags" choose "Selected branches and tags". Add these rules: tag `v*`, and branch `main` (keep `main` protected: pull requests only). The automatic release (merging the release PR) runs on `main`, so a rule that allows only `v*` tags would stop it; a manual run on a tag, or a pushed `v*` tag, matches the tag rule. Do not add any other branch. Then add the secrets to that environment. The first command sends the key file's content, the second asks for the password (`--env release` is what puts them in the environment):

   ```powershell
   Get-Content -Raw "$env:USERPROFILE\.burrow-keys\burrow-updater.key" | gh secret set TAURI_SIGNING_PRIVATE_KEY --env release -R ChristianMunoz31/burrow
   gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --env release -R ChristianMunoz31/burrow
   ```

   Also add a tag ruleset (Settings > Rules > Rulesets, target tags, pattern `v*`) that restricts creating tags to repository admins, or add required reviewers to the `release` environment. Otherwise anyone who can push a tag can start a signing run.

   Known residual risk: the compile and the "Bundle and sign installer" steps share one job and runner, so code that runs during the compile (a dependency install script, a build tool) could tamper with the signing step. The full fix, a separate signing job on a fresh GitHub-hosted runner, is a follow-up. Do not sign on the persistent self-hosted runner.

   How CI uses them: `desktop-windows.yml` selects the `release` environment for its Windows build only on a real release (not on a dry run with a `source_ref`). The compile step ("Compile installer") sees no signing variable. Only the "Bundle and sign installer" step does, and `buildInstaller.js` hands them to the `tauri bundle` process alone. They are not passed down the workflow chain. If you ever see the job wait for approval or fail with "environment protection rules", the rules above do not match the ref the run used.

   Add the secrets BEFORE you merge the public key. Once the public key is real, a CI release without them stops at "Bundle and sign installer" with a clear message (nothing is published). A dry run (`source_ref`) has no access to the secrets, so with a real public key it stops there too; that is intended.
3. **Back up the key file and its password offline** (for example a USB stick in a drawer, or your password manager's file attachment). **If you lose the key, every installed Burrow loses its way to update by itself**: you would have to make a new key and ask people to install the new version by hand once. If it leaks, someone could sign updates (they still could not point the app anywhere but the pinned GitHub download address): replace the key the same way.
4. Never put the key, its password or a copy of it in the repo. `*.key` files are git-ignored, `npm run check:keys` and gitleaks refuse the key text, and `TAURI_SIGNING_PRIVATE_KEY_PATH` must point outside the repository.

**Releasing from your own PC (`release:local`).** With a real public key it signs the ARM64 build and needs the key in this shell only. Set it, release, then clear it:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY_PATH = "$env:USERPROFILE\.burrow-keys\burrow-updater.key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [System.Net.NetworkCredential]::new('', (Read-Host -AsSecureString 'Updater key password')).Password
npm.cmd run release:local -- --x64-from-ci <run-id>
Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PATH, Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

Until the owner has done this (key generated, `TAURI_SIGNING_PRIVATE_KEY_PATH` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` set before `npm.cmd run release:local`, the placeholder public key replaced), no copy of Burrow can install updates by itself. Settings > Updates then checks GitHub's public releases API and offers "Get the installer": Burrow saves a backup, shows the installer's SHA-256 from the release's `SHA256SUMS.txt` and the PowerShell command to check it, and the user's browser downloads the pinned installer. Once the key is in, Download and install replaces that. In both paths nothing blocks an update: since 2026-11-05 Burrow is free for everyone, so any version installs and runs fully (there is no update window). Never generate, print or commit a key from a script or an agent.

The variables `release:local` and `buildInstaller.js` read: `TAURI_SIGNING_PRIVATE_KEY_PATH` (a path to the key file; it must exist and lie outside the repo) **or** `TAURI_SIGNING_PRIVATE_KEY` (the key text or a path, the name CI uses; set only one of the two), and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (required). Only the `tauri bundle` step sees them (the compile runs without them, as two phases of `buildInstaller.js`): `npm ci`, the other build steps, `gh` and `git` run without them. If they are missing the script stops before it builds anything and says so.

## The Pro module in official builds

The private module lives in `pro/`, a separate private repo (`burrow-pro`) nested in the checkout (see [OPEN_CORE.md](OPEN_CORE.md)). Official builds include it, at no cost, and every feature in it is on for every install (ADR 0002); a build without it is a core-only build that no publish path accepts.

- **Every official release path refuses to build without `pro/`.** `release:auto`, `release:local`, `release:installer`, `release:store` and the release workflows run `npm run check:pro-present` (it needs `pro/server/index.js`, `pro/server/static.js`, `pro/ui/proExtensions.js` and `pro/LICENSE`, and exits 1 with a fixed message otherwise) and set `BURROW_REQUIRE_PRO=1` for their builds. `buildSidecar.js` also takes `--require-pro` (implied by `--distribution store`). Without it and without `pro/`, a local `npm run desktop:sidecar` still builds, as a core-only build with a warning that it builds without the Pro module (`BURROW_PRO=off`); that build is never publishable (owner decision O6).
- **Check what you built.** `node scripts/checks/channelMarker.js --expect stable --expect-pro present --dist-dir dist` (add `--bundle <file>` for the `/*! BURROW_PRO=on */` banner) and `node scripts/release/smokeSidecar.js --expect-pro present|absent` (it reads `/api/app/info` `proModule` and checks that `POST /api/insights/explain` with `{}` answers 400 when present and 501 when absent, on a fresh data dir). `copyToTauri()` refuses a sidecar and a `dist/` that disagree about Pro.
- **`release:auto` pins the Pro commit.** It records `git -C pro rev-parse HEAD` in `auto-state.json`, refuses a dirty `pro/`, tags the pro repo with the release tag, and adds a pro worktree (`git -C pro worktree add --detach <wt>/pro <proCommit>`) inside every core worktree it creates, so the x64 and arm64 builds use the same Pro source. Commit and push `pro/` before you start.
- **CI.** The workflows that build installers or sidecars (`release.yml` desktop job, `desktop-windows.yml`, `dev-build.yml`) check out `burrow-pro` into `pro/` with the deploy key secret `BURROW_PRO_DEPLOY_KEY`, run `npm run check:pro-present`, and set `BURROW_REQUIRE_PRO=1`. `ci.yml` and the `release.yml` assets job never check it out and assert `--expect-pro absent`.
- **Release zip.** Core-only source, attached to the private release only (owner decision O1).
- **Preview branch worktrees** (`npm run preview:branch`) have no `pro/` and run in core-only mode.
- **Docker.** An image built while `pro/` exists contains the Pro server source. It is internal only and is never pushed to any registry (owner decision O7).

## Cut a release

1. Open the release PR that `release-please.yml` keeps up to date (title like `chore(main): release 0.2.0`). It carries the `hold` label and a full CI run (`ci.yml`, `mode=full`, hygiene steps included) is started on its branch.
2. Read the `CHANGELOG.md` text in it. The public release notes are made from it, so fix a confusing line before you merge. Only the Features, Bug Fixes and Performance sections are used, and entries about internals (ci, test, docs, chore, refactor, build, deps and release, or words such as docker, workflow, worker or lockfile) are dropped. For a release that needs a proper write-up, add `release-notes/vX.Y.Z.md` (see below) in the same PR.
3. Merge it.

## What happens automatically

1. release-please creates the tag `vX.Y.Z` and the release in the private repo.
2. `release.yml` builds and tests the source zip and attaches it with `SHA256SUMS.txt` to the private release (private only). The zip is core-only source (core source plus the core-only `dist/`, owner decision O1): the assets job never checks out `pro/` and asserts `node scripts/checks/channelMarker.js --expect-pro absent`.
3. `desktop-windows.yml` builds the Windows installers natively on two runners at the same time. Each one:
   - builds the server sidecar and runs a smoke test against it (starts it like the app does, checks the sign-in handshake, the API and the web page, then a clean exit). A failure here stops the release before anything is published;
   - builds the NSIS installer and renames it to `Burrow-Setup-x64.exe` or `Burrow-Setup-arm64.exe`;
   - tries a silent install, launch and uninstall of that installer. This step is non-blocking (it only warns), because a headless runner does not always give a desktop app a usable window. Test the installer by hand before you announce a release.
4. The installers and per-architecture checksums are attached to the private release. With the updater on, each installer is built by `scripts/release/buildInstaller.js` with the signing secrets (that one step only), its `Burrow-Setup-<arch>.exe.sig` is checked against the public key and attached too, and the per-architecture checksums list it.
5. `publish-public` creates `SHA256SUMS.txt` for both installers, checks them, and publishes a release with the same tag in `burrow-releases`: the two installers, `SHA256SUMS.txt`, plain-language notes (the hand-written `release-notes/vX.Y.Z.md` when it exists, else the filtered changelog), the SmartScreen note and checksum instructions. It marks the release latest.

With the updater on, `publish-public` also runs `scripts/release/updaterManifest.js` (it writes `latest.json`: the version, plain-text notes, the time, and for `windows-x86_64` and `windows-aarch64` the pinned download URL plus the exact contents of the `.sig` file), lists the two `.sig` files and `latest.json` in `SHA256SUMS.txt` (order: x64 exe, ARM64 exe, x64 sig, ARM64 sig, `latest.json`), and `publishPublic.js` publishes exactly those six files and nothing else. Before it uploads anything it verifies every signature against the public key and the installer bytes, and that `latest.json` matches the tag, the URLs and the `.sig` files. With the updater off it publishes exactly the three files it always did.

These links then always point to the newest release:

- https://github.com/ChristianMunoz31/burrow-releases/releases/latest/download/Burrow-Setup-x64.exe
- https://github.com/ChristianMunoz31/burrow-releases/releases/latest/download/Burrow-Setup-arm64.exe

## Hand-written release notes

`scripts/release/publishPublic.js` writes the public notes from the changelog. To replace that list with your own text, add `release-notes/vX.Y.Z.md` to the repo before the release. Two forms are used verbatim:

- A short "What's new" text: it replaces the changelog list, and the download links, the SmartScreen note and the checksum steps are still added.
- A complete document that has its own `## Download` section (like `release-notes/v0.2.0.md`): it is the whole release body, so it must carry its own SmartScreen note and checksum steps.

The script refuses text with an em dash or a link to the private repo. Write plain words: a desktop app with a built-in helper, never "AI service".

## After the release: update the Gumroad pages (optional)

**Not a required release step since 2026-11-05.** Burrow is free for everyone ([ADR 0002](adr/0002-free-for-everyone.md)), so a release does not depend on Gumroad. `npm run release:gumroad` stays in the repo, unused, until the owner decides what to do with the Gumroad listing; run it only if the pages are still kept up to date, and skip any release-script prompt about it. The rest of this section is kept as reference for that optional step.

CI never touches Gumroad (no Gumroad token is in CI). The version number is written in one place only, the release tag, which is `package.json`; you never edit version text by hand on Gumroad, with one exception: before the very first sync, add one paragraph that starts with `Latest version:` (for example `Latest version: 0.1.0`) by hand to each of the three pages, where you want it to appear. The script refuses a page that has none, and never adds one itself.

- `npm run release:local -- ... --publish` runs this step only when you add `--gumroad`: a dry run of `release:gumroad`, then the write with its own confirmation prompt. If it fails (the release stays published), fix the cause and run the command below.
- After a release built by CI, run the single command `npm run release:gumroad -- --publish` on your own computer once the public release is live.
- To update the Burrow installed on your own PC after a release, see "Keep this PC's Burrow up to date (developers)" in [CONTRIBUTING.md](../CONTRIBUTING.md) (`npm run desktop:install`).

Run on your own computer, it puts the new version and a short "What's new" line on the three Gumroad pages: Burrow Pro, the hidden student and nonprofit product and the free Burrow download (their ids are in `config/gumroad-sync.json`, which the app never reads).

```powershell
# 1. Look first. This is the default: it reads the three pages and prints a before and after. Nothing is written.
npm run release:gumroad

# 2. Write (saves a backup of each page first, then asks you to confirm; add --yes to skip the question).
npm run release:gumroad -- --publish
```

It uses the Gumroad CLI that is already signed in (`%LOCALAPPDATA%\gumroad\gumroad.exe`; sign in once with `gumroad auth login`; `--cli <path>` points to another copy). Only this local help was used to design it: `gumroad products view <id> --json` reads a product, and `gumroad products update <id> --description <html>` replaces its description. The CLI has no way to patch part of a description, so the script keeps one paragraph that starts with `Latest version:` and rewrites only that paragraph (in place on later runs; each page must already have exactly one such paragraph, placed where you want it in the Gumroad editor, so the first sync needs that one hand-added paragraph per page).

Version guard (dry run and publish): before anything is written, the script reads each product's description, custom receipt and rich content (`gumroad products content get <id> --json`, read only) and stops with a clear message, writing nothing, if a version-like string (`1.2.3`, `v1.2.3`) appears anywhere outside that one "Latest version:" paragraph, or if a description has zero or two or more such paragraphs. Short forms (`0.2`, `v0.3`) count too; sizes, ranges such as "1.3 to 4.7 GB", and prices do not. Word the rest of the pages without a version ("the latest Burrow").

Manual check, the storefront profile page: the Gumroad CLI can publish, preview and clear the custom profile HTML (`gumroad user page ...`) but has no command that reads the current HTML back, so the script cannot guard it. The storefront HTML is kept outside the repo (your `burrow-gumroad` folder). Before you publish it, search that file for a version number (`0.2`, `v0.3`, `1.2.3`) and write "Burrow for Windows" instead; the version lives only in each product's "Latest version:" line. The rest of the description is sent back exactly as it was read. Gumroad's own editor may reformat the HTML a little when you save there; the script only needs the paragraph to still start with `Latest version:`.

- What's new comes from `release-notes/vX.Y.Z.md` when that file exists (plain lines or bullets, written for customers), otherwise from the user-facing items (New, Fixed, Faster) of the `CHANGELOG.md` section, at most three, with developer wording left out. The dry run shows the exact text, so write a `release-notes` file when the changelog reads badly. Nothing is written until you pass `--publish`.
- Store copy rule (docs/PRODUCT.md): Burrow is a desktop app with a built-in helper. The text is refused if it says "AI service", "access to AI", "AI tools" or "chatbot", or contains a long dash.
- Before the first write, the script saves each current description as a timestamped JSON file in `%LOCALAPPDATA%\burrow-release\gumroad-backups\` (outside the repo; `--backup-dir` changes it). To undo a page, copy the `description` from its backup and run `gumroad products update <id> --description "<html>"`.
- Pages that already show the new version are left alone, so running it twice is safe. After each update it reads the page back and warns if the version line is missing.
- The CLI's JSON shape for `products view` could not be checked without a real call, so the first dry run is also the check: if it says the CLI returned no description text, run `gumroad products view <id> --json` yourself and tell the maintainers what it prints.

## How long it takes

Wall time is about 25 to 30 minutes, because the two Windows builds and the source job run at the same time. Billed minutes (the repo is private, so Windows counts double):

| Job | Runner minutes | Billed |
| --- | --- | --- |
| Windows x64 | 15 to 20 | 30 to 40 |
| Windows ARM64 | 20 to 25 | 40 to 50 |
| Source zip and tests (`assets`) | about 6 | about 6 |
| Publish and small jobs | about 1 each | a few |

A release is roughly 80 to 100 billed minutes. These are estimates until a few real runs exist.

## When CI is slow: release:local

CI is the default and needs nothing from you. When the GitHub runners are slow or down (the ARM64 runner is a public preview and can queue for a long time), you can release from your own ARM64 PC with the same result: the two installers under their stable names, one `SHA256SUMS.txt`, the same notes, published to `burrow-releases`. The script (`scripts/release/releaseLocal.mjs`) imports `publishPublic.js` for the notes, the asset allowlist and the `gh` calls, so there is one publisher, not two.

Before you start: merge the release PR, so release-please has made the tag `vX.Y.Z`, and check that tag out in a clean worktree (`git checkout vX.Y.Z`, then `npm ci`). The x64 installer comes from CI (the x64 runner is usually fine), so let the CI release run as usual until its Windows x64 job has succeeded, then:

1. Cancel that CI run first (Actions page, Cancel workflow, or `gh run cancel <run-id> -R ChristianMunoz31/burrow`), so the queued ARM64 job and `publish-public` cannot start while you release from this PC. The script wants a run that is `completed`, and a cancelled run counts: its `assets` job (the `npm test` run) and its Windows x64 job must still have succeeded.
2. Find the run id from the URL, or with `gh run list -R ChristianMunoz31/burrow -w release-please.yml` (the release PR merge starts `release-please.yml`, which calls `release.yml`; a run started by hand or by a tag push shows under `-w release.yml`). The run must be of one of those two workflows, or the script refuses it.

Do not re-run the failed or cancelled jobs of that CI run after a local release. A re-run of `publish-public` would download the installers from the private release again and publish them over what you released from this PC, and a re-run of the ARM64 job would replace the ARM64 asset on the private release.

```powershell
# 1. Rehearse. This is the default: checks, builds ARM64, downloads x64, prints the plan. Nothing is uploaded.
npm run release:local -- --x64-from-ci <run-id>

# 2. Publish for real (asks you to confirm; add --yes to skip the question).
npm run release:local -- --x64-from-ci <run-id> --publish
```

Flags:

| Flag | Meaning |
| --- | --- |
| `--dry-run` | The default. Builds and checks, prints the plan and the `gh release` commands, makes no network writes (it only reads the tag, the CI run and the x64 asset). |
| `--publish` | Really publishes, and only when CI passed on the tag commit itself: the script reads the check runs of that commit (`gh api repos/ChristianMunoz31/burrow/commits/<sha>/check-runs`) and needs the newest `assets` job (release.yml), `verify` job (ci.yml), or all three `main-unit` shards (ci.yml main run) to have succeeded. This applies to every `--publish`, including `--x64-file`, but the x64 channel itself is not checked on the `--x64-file` path (prefer `--x64-from-ci`). Dry runs skip this check. Uses `RELEASES_TOKEN` from the environment when it is set (handed to `gh` only through the environment), otherwise your `gh` sign-in (`gh auth token`), and asks first unless `--yes`. `--yes` skips only the question about publishing: the optional Gumroad step that follows (not required since ADR 0002) still asks its own question before it writes, even with `--yes` (the sync is always started with `yes` off, so a release can never change the store pages unattended). Prefer a `RELEASES_TOKEN` limited to `burrow-releases` (see One-time setup): your `gh` sign-in can usually write to every repo you own. |
| `--x64-from-ci <run-id>` | Downloads `Burrow-Setup-x64.exe` (and, with the updater on, `Burrow-Setup-x64.exe.sig`, in the same stability check) from the private release assets (not workflow artifacts) by asset id, and checks it three ways: against the `SHA256SUMS-desktop-windows-x64.txt` the build job attached, against the sha256 line the x64 job printed in its own log (`gh run view <run-id> --log --job <job id>`), and by reading the release again to see that the asset id and `updated_at` did not change during the download. The run must be `completed` (cancel it first, see above), of `release-please.yml` or `release.yml`, built the release commit, its `assets` job (`npm test`) and Windows x64 job must have succeeded, and the asset must have been uploaded inside that run's time window. |
| `--x64-file <path>` | A hand-built x64 installer (see "x64 without CI"). With the updater on, `<path>.sig` (the signature tauri wrote beside it) must exist too. The file must be named exactly `Burrow_<version>_x64-setup.exe`, start with `MZ`, not be older than the release commit, and, when Windows can read it, carry that version in its PE version resource. Not combinable with `--x64-from-ci`. |
| `--skip-build` | Reuse the installers already in `<out-dir>/public` instead of building ARM64. For rehearsals. With `--publish` it is refused unless `<out-dir>/build-manifest.json` (see below) matches `HEAD`, `package.json` and the hash of each staged file. |
| `--out-dir <dir>` | Staging folder. Default `%LOCALAPPDATA%\burrow-release\<tag>`. |
| `--tag vX.Y.Z` | Default is `v<package.json version>`. Stable tags only, no prerelease. |

What it checks, and refuses to go on without:

- the tag matches `^v[0-9]+\.[0-9]+\.[0-9]+$` (no prerelease, no `-dev`), and `package.json` has the same version;
- `BURROW_CHANNEL` is unset or `stable`, and `BURROW_DISPLAY_VERSION` is unset;
- the worktree is clean, the tag exists in `ChristianMunoz31/burrow`, and `HEAD` is the tag commit (checked again after the build);
- the build has the same steps as `desktop-windows.yml`, after a clean `npm ci`: web build, sidecar, build date check, `channelMarker.js --expect stable` on the bundle, the UI and every sidecar binary, the blocking sidecar smoke test, then `scripts/release/buildInstaller.js` (`tauri build --bundles nsis`, signed and self-verified when the updater is on). The host must be ARM64 (Rust host `aarch64-pc-windows-msvc`, node `arm64`);
- both installers start with `MZ`, no name contains `dev`, only the two stable names are staged (plus the two `.sig` files with the updater on), and neither installer is older than the release commit;
- with the updater on: the signing variables are present before anything is built (see "Updater signing key"), both `.sig` files verify against the public key and the exact staged installer (all three x64 sources: CI, `--x64-file`, `--skip-build`), `latest.json` is written before the sums, and `SHA256SUMS.txt` lists five files. With the updater off nothing about this changes;
- `git status --porcelain` is empty again after the build (the build changed no tracked file);
- `SHA256SUMS.txt` is written in the standard `<hash>  <name>` format and checked against the files;
- a real publish needs build artifacts to check the channel against, so `--skip-build` can rehearse, but it can publish only while the artifacts of an earlier build are still there;
- when the script builds, it writes `<out-dir>/build-manifest.json`: the commit, the version, and for each of x64 and ARM64 the original installer name, the sha256 and (updater on) the sha256 of its `.sig`. `--skip-build --publish` reads it back and refuses unless the commit is `HEAD`, the version is `package.json`'s, and every staged file still has the recorded hash (the x64 file is exempt when you pass `--x64-from-ci` or `--x64-file`, because those are verified on their own). Installers that were not built by this script for this tag can therefore not be published by copying them into the folder.

The script resolves the tag with `gh api repos/ChristianMunoz31/burrow/git/ref/tags/<tag>`, and follows an annotated tag to its commit.

The first real `--dry-run` you run is also the check of the parts that could not be tried without a real call: the download by asset id (`gh api -H "Accept: application/octet-stream"`), the job log lookup and, for `release:gumroad`, the Gumroad CLI flags and the JSON it returns. If one of them fails, the message names it and nothing was written; tell the maintainers what it said.

A local build does not run the installer smoke test that CI runs (it is non-blocking in CI as well). Install the ARM64 installer on this PC by hand before you announce a release, and the x64 one on an Intel or AMD PC if you have one.

### x64 without CI (manual fallback)

The x64 installer cannot be built natively on an ARM64 PC. `buildSidecar.js` has the flags a cross-build needs (`--node-binary`, `--out-triple`), but `desktop:build` refuses a non-host `--target` on purpose, the cross-built x64 sidecar and installer could not be verified on this machine, and the result needs the MSVC x64 build tools next to the ARM64 ones. So it is not part of `desktop:build` or `release:local`. `npm run release:auto` (see "One command: release:auto" below) runs exactly these steps as its `x64` stage, including the node.exe download and check; by hand, in a clean checkout of the tag:

1. Download the official `node-v<version>-win-x64.zip` for your Node version from nodejs.org and check it against the matching line of `SHASUMS256.txt` from the same folder (`Get-FileHash -Algorithm SHA256`). Unzip `node.exe`.
2. `rustup target add x86_64-pc-windows-msvc`, and install the Visual Studio Build Tools x64 component.
3. `npm run build`, then `node scripts/desktop/buildSidecar.js --minify --channel stable --node-binary <path to the x64 node.exe> --out-triple x86_64-pc-windows-msvc`.
4. `node scripts/release/buildInstaller.js --target x86_64-pc-windows-msvc` (`desktop:build` refuses a non-host target, so use this script; also available as `npm run release:installer -- --target x86_64-pc-windows-msvc`). With the updater on, set the signing variables first (see "Updater signing key"); it then writes `Burrow_<version>_x64-setup.exe.sig` beside the installer and verifies it. Keep that `.sig` next to the file: `release:local --x64-file` needs it.
5. Keep the file under its original name, `Burrow_<version>_x64-setup.exe`, and run `npm run release:local -- --x64-file <path to it>` (add `--publish` for the real thing). The script refuses another name, a file without the `MZ` header and, when Windows can read it, a different PE version. Do not copy it into `<out-dir>/public` yourself: a hand-copied file is not tied to the tag and `--publish` will not accept it.

Prefer `--x64-from-ci`: it is the only path where the x64 build channel is checked (its CI job must have succeeded). On the `--x64-file` path nothing proves how the file was built, so the script only checks its name, header, age and PE version. It reuses the installer that CI built and smoke-tested natively.

## Releasing without GitHub Actions

Use this when Actions jobs will not start at all, for example because of an account billing block. (With the optional self-hosted runner in whole-release mode, the runner builds everything and only the publish is manual: see "Publishing in whole-release mode" in [SELF_HOSTED_RUNNER.md](SELF_HOSTED_RUNNER.md), which uses the same `publishPublic.js` call as step 4.) It was used for v0.4.1 on 2026-10-07. Nothing here needs a runner: release-please runs from its CLI, and both installers are built on the owner's ARM64 PC. With the updater on, the signing key is already on that PC (see "Updater signing key"), so no secret is needed in GitHub for this path: the staged folder holds both installers, both `.sig` files and `latest.json` (the `release:local` rehearsal in step 3 creates them), and `publishPublic.js` in step 4 checks all of it, including the signatures, before it uploads.

One difference from the normal path comes first. Every `--publish` of `release:local`, including `--x64-file`, runs `checkCommitCi`, which reads the check runs of the tag commit and refuses unless CI passed there (`assets`, `verify` or all three `main-unit` shards). While Actions jobs cannot start, the tag commit has no such check run, so `release:local --publish` stops with "No CI run for the release commit ... Publishing is refused." Step 4 therefore publishes with `scripts/release/publishPublic.js` directly, which is the script `release:local` calls, and the local checks in step 1 and step 3 stand in for the CI evidence. Dry runs of `release:local` skip the CI check, so steps 1 to 3 work as usual.

### One command: release:auto

`scripts/release/releaseAuto.mjs` runs the numbered steps below as one resumable command on the ARM64 PC. It calls the same scripts (release-please 17, `buildSidecar.js`, `channelMarker.js`, `smokeSidecar.js`, `buildInstaller.js`, `release:local`, `publishPublic.js`, `release:gumroad`) and repeats none of their checks, so every guard of those scripts still applies. Run it from the root of a clean `main` checkout in PowerShell:

```powershell
npm.cmd run release:auto                                   # preflight, checks, release PR; stops for your review
npm.cmd run release:auto -- --tag vX.Y.Z --from tag        # after you merged the release PR: tag, x64, arm64, after
npm.cmd run release:auto -- --tag vX.Y.Z --from checks --publish   # after the merge: checks on the tag commit, tag, builds, publish (asks you to type the tag)
npm.cmd run release:auto -- --merge-pr 111 --merge-release-pr   # merge feature PR #111 first, then the release PR, and go straight on to the tag
npm.cmd run release:auto -- --tag vX.Y.Z --status          # the stage table
npm.cmd run release:auto -- --tag vX.Y.Z --from x64 --dry-plan  # the plan and every command, nothing runs (any computer)
```

| Stage | What it does |
| --- | --- |
| `preflight` | Always runs. Windows ARM64 and a supported Node, a clean `main` equal to `origin/main`, `gh auth status`, the Rust targets `aarch64-pc-windows-msvc` and `x86_64-pc-windows-msvc` (a missing one stops the run and prints the `rustup target add` command; nothing is installed for you), the Visual Studio Build Tools ARM64 and x64 compilers through `vswhere` (best effort, guidance only), gitleaks and its version (warning only), and the signing variables when the updater is on. The host, Node, `gh` and Rust checks run on every run, whatever `--from` says. |
| `merge-pr` (only with `--merge-pr N`) | Runs after `preflight` and before `checks`, once per listed PR. Reads the PR with `gh pr view` and refuses (nothing is merged, the run stops) unless it is OPEN, not a draft, based on `main` and `MERGEABLE`. Prints its title and head branch, then asks "Merge PR #N '<title>' into main? Type the number N to confirm" (anything else cancels; without a terminal it needs `--yes`). Then `gh pr merge N --squash --delete-branch` with the PR title plus ` (#N)` as subject and the PR body as body (release-please reads the conventional lines from that commit; `--match-head-commit` makes gh refuse if the branch moved), `git pull --ff-only origin main`, and the same clean-main check as `preflight`. The merged commit is recorded in `auto-state.json`, so a re-run does not merge it again. It is not a stage of its own in the table above (`--from` cannot name it). |
| `checks` | Step 1: `npm ci`, lint, check, test, build, `check:bundle`, the Playwright flows, first-run and a11y projects, and gitleaks 8.30.1 over `<last tag>..HEAD`. Without gitleaks it warns and names the install command; there is no flag to skip the checks. With `--tag vX.Y.Z` and an existing tag they run in the release worktree `<out>\wt-arm64` at the tag commit (gitleaks over `<previous tag>..HEAD`) and are recorded for that commit, which is what `publish` looks for. A new checks record never drops the build records after it. |
| `release-pr` | Step 2: release-please `release-pr --dry-run`, prints the version and a changelog summary, then opens or updates the release PR. By default it STOPS with "Review and merge PR #N, then re-run with --from tag" and merges nothing. With `--merge-release-pr` the merge happens here, after that dry-run summary is printed: the same checks and the same typed confirmation (the PR number, or `--yes`) as `merge-pr`, and the PR title must be exactly `chore(main): release X.Y.Z` for the version release-please reported. The PR is squash-merged with its title (plus ` (#N)`) as subject, local `main` is fast-forwarded, and the run goes on to `tag` instead of stopping. A merged, untagged release PR (merged by you or by an earlier run) always lets the run go on to `tag`. |
| `tag` | `release-please github-release` (dry run first), then checks that `vX.Y.Z` exists and points at main's HEAD. "would tag 0 releases" means the release PR is not merged yet. A tag that already exists (on main) is accepted as it is. |
| `x64` | Step 3, x64 half: a clean worktree of the tag in `<out>\wt-x64`, `npm ci`, the x64 `node.exe` (below), web build, `buildSidecar.js --minify --channel stable --node-binary <x64 node> --out-triple x86_64-pc-windows-msvc`, `channelMarker.js` and `smokeSidecar.js` exactly as above, then `buildInstaller.js --target x86_64-pc-windows-msvc`. The installer (and its `.sig` with the updater on) is copied to `<out>\x64\Burrow_X.Y.Z_x64-setup.exe` and its sha256 recorded. |
| `arm64` | Step 3, the other half: a clean worktree in `<out>\wt-arm64`, `npm ci`, then `release:local --x64-file <that installer> --dry-run` (builds arm64, stages both, prints the plan and the notes, uploads nothing). Then it checks that `<out>\public` holds exactly 3 files (6 with the updater on), that `SHA256SUMS.txt` matches them and that the staged x64 installer is the one the `x64` stage built. |
| `publish` | Only with `--publish`. Step 4 with `publishPublic.js` directly, always with `--notes-from <release worktree>\CHANGELOG.md`. It first refuses unless the release worktree is still clean and at the tag commit, the `arm64` record is for that commit, and a `checks` record exists for the tag commit (in the tag's state or `burrow-release\next`); `--checks-done-manually` replaces that record when you ran the step 1 checks on the tag commit by hand, and the prompt then says the checks were not recorded. The dry run's output must contain the first line of `release-notes/vX.Y.Z.md` when that file exists and must not be the "no listed changes" fallback, otherwise it stops before the question. Then you type the tag (for example `v1.2.0`; anything else cancels), the staged hashes are checked again, and the real publish runs with `GH_TOKEN` (`RELEASES_TOKEN` when set, else `gh auth token`) for that one child. Without a terminal it needs both `--yes` and `BURROW_RELEASE_CONFIRM=vX.Y.Z`; either alone publishes nothing. |
| `after` | Always runs. Once the tag is published (by this run or recorded earlier) it prints the remaining owner steps with exact commands (download and hash check, the optional `release:gumroad`, the privacy page when `config/privacy.json` changed since the previous tag, `release:store`, screenshots, worktree removal), and `--gumroad` also runs the `release:gumroad` dry run (read only). Before the publish it prints only the next command (`--from publish --publish`) and says not to run Gumroad or remove the worktrees yet. |

**Resume.** Each finished stage is written to `%LOCALAPPDATA%\burrow-release\<tag>\auto-state.json` (before the version is known, `burrow-release\next\auto-state.json`) with its inputs (the commit, the tag, the Node version, the x64 installer hash) and outputs (paths and sha256 of what it produced). A later run skips a stage whose inputs are the same and whose outputs still match their recorded hashes, and runs it again otherwise; a stage whose result changed drops the records of the stages after it. `--from <stage>` always runs that stage. From `tag` on, `--tag vX.Y.Z` is required, so an older release is never rebuilt or published by mistake. Worktrees are reused only when they are clean and at the tag commit, otherwise recreated. The state file never holds a token. `--out-dir <dir>` moves the whole release folder (it is passed to `release:local` as well); it must lie outside the repository, also when reached through a link or junction. A real run needs `LOCALAPPDATA`. The release folder holds `auto.lock` while a run works in it, so a second run at the same time is refused; a lock older than 6 hours (a crashed run) is taken over with a message. The x64 record also keeps the sha256 of the x64 node.exe, which is hashed again on resume.

**The x64 node.exe.** The x64 stage downloads `https://nodejs.org/dist/<version>/win-x64/node.exe` for exactly the running Node version (the SEA blob must match) with `scripts/release/storeNode.mjs`, the code the Store build uses: no redirects, an https answer from `nodejs.org/dist` only, a size cap, and the sha256 must equal the `win-x64/node.exe` line of `SHASUMS256.txt` from the same folder, plus the pin in `config/store-node.json` when that version has one. `SHASUMS256.txt` lists `win-x64/node.exe` itself, so there is no zip to unpack. The copy is cached in `%LOCALAPPDATA%\burrow-release\cache` and checked again on every use. `--x64-node <file>` uses your own x64 node.exe instead (it must report the same version).

**Tokens.** Every token comes from `gh auth token` (or `RELEASES_TOKEN` for the publish) and goes to exactly one child through its environment: release-please gets it as `BURROW_RP_TOKEN`, which `scripts/release/lib/releasePleaseShim.mjs` moves into release-please's parser in memory, so it is never a command-line argument, never printed (output of that child is also redacted) and never written to disk. `gh` itself must be signed in with `gh auth login`: its children (including the `gh` calls of the script) do not get a `GH_TOKEN` from your shell. Builds, tests and checks run with every token variable removed (`GH_TOKEN`, `GITHUB_TOKEN`, `RELEASES_TOKEN`) and with every other variable whose name ends in `TOKEN`, `PAT`, `SECRET`, `PASSWORD` or `API_KEY` (no build step needs one), and only the installer step sees the updater signing variables. release-please 17 is installed once with `npm install --ignore-scripts` into `%LOCALAPPDATA%\burrow-release\tools\release-please-17`, outside the repo, instead of `npx`, so its path is known to the shim.

**Network.** GitHub through `gh` and release-please (`github.com`, `api.github.com`), `nodejs.org` for the x64 node.exe, and the npm registry for `npm ci` and the release-please install. This is owner tooling on the release PC, not the app, so the app's netPolicy registry does not apply to it, and it adds no hosted service.

**Merging with the script.** Both merges are opt-ins: `--merge-pr <N>` (repeatable or comma-separated, for example `--merge-pr 111,112`) and `--merge-release-pr`. `--yes` answers their questions when there is no terminal; it never answers the publish question, which still needs `BURROW_RELEASE_CONFIRM=<tag>`. `--merge-pr` cannot go with a `--from` later than `checks`, and `--merge-release-pr` not with one later than `release-pr`. Only `main` is ever the target, nothing is forced, only the merged head branch is deleted (by `gh pr merge --delete-branch`), and no token is passed around: `gh` uses its own sign-in. A PR the script merged is listed by `--status`.

**What it does not do.** It merges a pull request only when you ask for it with `--merge-pr` or `--merge-release-pr` (never a PR you did not name, and never one that is a draft, closed, not based on `main` or not mergeable), never publishes without your typed tag (or `--yes` plus `BURROW_RELEASE_CONFIRM`), never calls `release:local --publish` (that would stop at `checkCommitCi` while Actions cannot run; publishing goes through `publishPublic.js` directly as step 4 documents, with the same approval needed), and never updates Gumroad or the Store by itself. It refuses to run anywhere but Windows ARM64; `--dry-plan` and `--status` work on any computer.

### 1. Merge the feature PR and check locally

Merge the feature PR normally. If CI cannot run, check locally first:

```powershell
npm.cmd run lint
npm.cmd run check
npm.cmd test
npm.cmd run build
npm.cmd run check:bundle
npx.cmd playwright test --project=flows --project=first-run --project=a11y
gitleaks git --config .gitleaks.toml --log-opts="origin/main..HEAD" --redact .
```

- Visual baselines are Linux only, so do not run the visual project on Windows.
- Use the same gitleaks version that CI pins, 8.30.1. The command above scans the branch commits (`origin/main..HEAD`) with it.
- To force a patch version, put `Release-As: X.Y.Z` as a footer in the squash commit body. Without it, release-please bumps the minor on a `feat`.

### 2. Run release-please from its CLI

`release-please-action` v5 bundles release-please 17, so use the same version. Install `release-please@17` in a scratch folder outside the repo. Then, from a clean checkout of main, put the token in a variable inside the same command. Never paste it.

```powershell
$T = gh auth token
release-please release-pr --token=$T --repo-url=ChristianMunoz31/burrow --target-branch=main --config-file=release-please-config.json --manifest-file=.release-please-manifest.json --dry-run
Remove-Variable T
```

Check the version and the changelog in the output. Then run the same command without `--dry-run`. It opens the release PR with the label `autorelease: pending`. The workflow's `hold` label and the CI dispatch do not happen.

Read the PR and squash-merge it. Then create the tag and the private release, dry run first:

```powershell
$T = gh auth token
release-please github-release --token=$T --repo-url=ChristianMunoz31/burrow --target-branch=main --config-file=release-please-config.json --manifest-file=.release-please-manifest.json --dry-run
release-please github-release --token=$T --repo-url=ChristianMunoz31/burrow --target-branch=main --config-file=release-please-config.json --manifest-file=.release-please-manifest.json
Remove-Variable T
```

This creates the tag `vX.Y.Z` and the private release.

### 3. Build both installers on the ARM64 PC

Use two clean worktrees of the tag: one for x64, one for `release:local`.

In the x64 worktree, follow "x64 without CI (manual fallback)" above, which works as written. Points that matter:

- Use the x64 `node.exe` of the same version as the local Node (`node --version`), checked against `SHASUMS256.txt` from nodejs.org.
- Add the `x86_64-pc-windows-msvc` Rust target.
- Install Visual Studio Build Tools with the ARM64-hosted x64 compiler. VS Build Tools 2026 with MSVC 14.50 has it.
- postject prints "The signature seems corrupted!" when it injects the sidecar. That is expected for a Node single executable. The arm64 path prints it too.

Check the x64 sidecar before you use it. The smoke test runs under x64 emulation on Windows on ARM.

```powershell
node scripts/checks/channelMarker.js --expect stable --bundle .sidecar-build/server.cjs --dist-dir src-tauri/resources/dist --binary src-tauri/binaries/burrow-server-x86_64-pc-windows-msvc.exe
node scripts/release/smokeSidecar.js --sidecar src-tauri/binaries/burrow-server-x86_64-pc-windows-msvc.exe --resources src-tauri/resources --expect-version X.Y.Z
```

In the other worktree, install and rehearse. This builds arm64, runs the checks and prints the plan and the notes. Nothing is uploaded.

```powershell
npm.cmd ci
npm.cmd run release:local -- --x64-file <path to Burrow_X.Y.Z_x64-setup.exe>
```

Use `npm.cmd`, because PowerShell's execution policy can block `npm.ps1`.

### 4. Publish (owner, in their own terminal)

This is what was used for v0.4.1 on 2026-10-07, with the owner's approval for that one release.

**What this skips.** It bypasses the `checkCommitCi` gate that `release:local --publish` enforces. It needs explicit owner approval each time, and it is only for when Actions jobs cannot start. Do not use it when CI can run.

**What replaces the CI evidence.**

- On the feature branch: local `npm run lint`, `npm run check`, `npm test`, `npm run build` plus `npm run check:bundle`, the Playwright flows, first-run and a11y projects, and gitleaks 8.30.1 (the version CI pins) on the branch commits (step 1).
- On the tag build: the channel check and the sidecar smoke test for both the x64 sidecar (under emulation) and the arm64 sidecar (step 3). Both also refuse developer tools in a stable build: the channel check fails on the text `BURROW_DEV_TOOLS=on` or the developer routes path, and the smoke test needs `/api/dev/status` to answer 404. The developer tools live in `devtools/`, which is never in a stable build, the Store build or the release zip.

**What is not covered.** CI's changed-file coverage gate, the Linux visual baselines, and CI's own x64 build channel.

Publish with `scripts/release/publishPublic.js` on the staged folder you rehearsed in step 3, from the release worktree, in the owner's own terminal. Always pass `--notes-from CHANGELOG.md` (the worktree's changelog at the tag): without it `publishPublic.js` ignores `release-notes/vX.Y.Z.md` and the public release, and the in-app update notes, say "This release has no listed changes." Run it first with `--dry-run` and check that the printed notes show your curated text. A dry run needs no token and makes no network call. Check that the plan and the installer hashes match the rehearsal (with the updater on, the plan lists six files and the log says the signatures and `latest.json` were verified).

```powershell
cd $env:LOCALAPPDATA\burrow-release\wt-vX.Y.Z
node scripts/release/publishPublic.js --tag vX.Y.Z --assets-dir $env:LOCALAPPDATA\burrow-release\vX.Y.Z\public --notes-from CHANGELOG.md --dry-run
```

If it matches, run the real publish. The token is read from `gh` into a variable for this one command and removed right after. Never paste it.

```powershell
cd $env:LOCALAPPDATA\burrow-release\wt-vX.Y.Z; $env:GH_TOKEN = (gh auth token); node scripts/release/publishPublic.js --tag vX.Y.Z --assets-dir $env:LOCALAPPDATA\burrow-release\vX.Y.Z\public --notes-from CHANGELOG.md; Remove-Item Env:GH_TOKEN
```

Optional (not required since ADR 0002): update the Gumroad pages. Run the dry run first, then publish and answer `y`:

```powershell
npm.cmd run release:gumroad
npm.cmd run release:gumroad -- --publish
```

**When billing works.** Option A is the normal path: fix billing, run `gh run rerun <CI run id>` on the tag commit so CI passes there, then publish with the gate in place:

```powershell
npm.cmd run release:local -- --x64-file <path to Burrow_X.Y.Z_x64-setup.exe> --skip-build --publish
```

`--skip-build` is accepted only when `build-manifest.json` matches the tag and every hash. Answer `y` to "Publish vX.Y.Z to ... now?". If the optional Gumroad step that follows asks "Update 3 Gumroad page(s) now?", answer `n` unless you still keep those pages up to date.

### 5. Afterwards

- Check both `releases/latest/download/` links, and check the files against `SHA256SUMS.txt` with `Get-FileHash -Algorithm SHA256`.
- Optional: run `npm.cmd run release:gumroad` (dry run) to confirm the Gumroad pages are up to date. It should report 0 of 3 pages would change.
- Remove the release worktrees with `git worktree remove <path>`.

### The Release workflow still fires

The push trigger of the Release workflow still fires on merge, but its jobs do not start while billing is blocked. That is harmless. If billing is fixed later, release-please finds that the tag already exists and makes nothing new. Do not re-run those jobs after a local release (see "When CI is slow: release:local").

## Manual dry run

Use this before the first real release, or after changing the workflow. It builds both installers and runs both smoke tests, and publishes only a draft in the public repo.

```powershell
gh workflow run release.yml -R ChristianMunoz31/burrow --ref main -f tag=v0.1.0-dryrun.1 -f source_ref=main -f desktop=true -f desktop_platforms=windows -f publish=draft
```

- Before this branch is merged, dispatch from the branch instead: `--ref feat/release-autopilot` (the workflow file is read from `--ref`, the code that gets built from `source_ref`).
- `source_ref=main` makes the build use `main`; the public release gets the name `v0.1.0-dryrun.1`. Nothing is written to the private repo. A run with `source_ref` can not publish a full release.
- `publish=draft` creates a draft release in `burrow-releases` that only you can see. Use `publish=none` to dry-run the publish script without needing the token (it prints the plan and the notes in the log).
- Watch it with `gh run list -R ChristianMunoz31/burrow -w release.yml` and `gh run watch`.

Delete the draft afterwards:

```powershell
gh release delete v0.1.0-dryrun.1 -R ChristianMunoz31/burrow-releases --cleanup-tag --yes
```

Re-running a release for the same tag is safe: the files are replaced (`--clobber`) and the notes are updated.

## If something fails

- **`windows-11-arm` is unavailable.** The ARM64 runner is a GitHub public preview, so it can be missing or queue for long. The ARM64 build then fails or never starts, and `publish-public` does not run (it needs both installers). Options: wait and re-run the failed jobs from the Actions page (once you have started a local release instead, cancel the CI run and never re-run its jobs, see "When CI is slow: release:local"), build ARM64 on your own PC (an optional self-hosted runner, [SELF_HOSTED_RUNNER.md](SELF_HOSTED_RUNNER.md), which the workflow prefers when it is online and otherwise falls back to the hosted one, or `npm run release:local` above), or cross-compile ARM64 on an x64 runner. Cross-compiling is not wired up: the sidecar is a Node single executable made from a `node.exe`, so it needs the official `node-v<version>-win-arm64` binary (checked against `SHASUMS256.txt`, as the macOS universal build does) passed with `--node-binary` and `--out-triple aarch64-pc-windows-msvc` to `scripts/desktop/buildSidecar.js`, plus `rustup target add aarch64-pc-windows-msvc` and `tauri build --target aarch64-pc-windows-msvc`. The ARM64 sidecar could not be smoke-tested on an x64 runner, so test that installer on an ARM PC by hand.
- **"Updater signing is on ... are not both set".** A real public key is in `src-tauri/tauri.release.conf.json` but the build has no key or password. In CI add the two secrets to the `release` environment (see "Updater signing key") and re-run; locally set the variables in that shell. To switch the updater off again, put the placeholder text back into `plugins.updater.pubkey`.
- **"does not verify against the public key" (`buildInstaller.js`, `release:local` or `publishPublic.js`).** The `.sig` was made with a different key than the committed public key, or the installer changed after it was signed. Nothing is uploaded. Rebuild with the right key, or fix the public key in the overlay. Never edit a `.sig` or `latest.json` by hand.
- **The sidecar smoke test fails.** Open the failed job. The message names the check (ready line, 401 gate, bootstrap, API, HTML or exit code). Nothing was published.
- **Publish fails with `RELEASES_TOKEN`.** Create or renew the token (see One-time setup) and re-run the failed `publish-public` job. A token that expired shows up as an authentication error from `gh`. This applies to a CI release only: after a release from this PC, a re-run of `publish-public` would publish the CI installers over the local ones.
- **`release:local` stops with an error.** Read the message: it names the check (for example "not tied to vX.Y.Z", "does not match the sha256 the x64 job printed in its own log", "is of the workflow ...", or "changed while it was being downloaded"). Nothing was uploaded. Fix the cause and run the same command again; do not work around a hash or manifest check by copying files in by hand.
- **Wrong or broken release already public.** Delete it in `burrow-releases` (or edit it to a draft) and re-run the `publish-public` job (CI release), or run `npm run release:local` again (local release).

## Microsoft Store build (MSIX)

`npm run release:store` builds the Microsoft Store flavor on this PC: one `.msix` per architecture and one `Burrow_<version>.msixbundle`, with `SHA256SUMS.txt` and `build-summary.txt`, in `%LOCALAPPDATA%\burrow-release\store\<version>\`. It publishes and uploads nothing; you upload the bundle by hand in Partner Center. It is separate from `release:local` and does not touch the installers. The Store build has no in-app updater (the Store delivers updates). The Partner Center identity is filled in `config/msstore.json`; while any of its three owner values is empty or says PLACEHOLDER the build refuses. `--local-test` builds a sideload test package with the real identity (`--sign-local-test` self-signs it with a certificate whose subject equals the Publisher), or a made-up one while placeholders remain. `npm run release:store -- --check` reports the state, the app version and the Store package version. Every build starts by deleting the packages, bundle, sums, summary and test certificate of an earlier build in its output folder, checks that the web build is a stable build of the current version, and smoke tests each staged sidecar (`--skip-smoke` is the documented escape hatch, flagged in `build-summary.txt`). The x64 `node.exe` is accepted only when it matches the hash pinned in `config/store-node.json`, or comes from `--x64-node`. `--data-location userprofile` (or `"dataLocation": "userprofile"` in `config/msstore.json`) builds the fallback package for when Partner Center refuses `rescap:unvirtualizedResources`: no `unvirtualizedResources` and no `desktop6:FileSystemWriteVirtualization` in the manifest, the app keeps its data in `%USERPROFILE%\Burrow Data`, and the output folder (`<version>-userprofile`) and file names carry `userprofile`; the runbook is "If Partner Center refuses unvirtualizedResources" in [MICROSOFT_STORE.md](MICROSOFT_STORE.md). Full guide, flags, sideload commands and the data-folder and Windows 10 notes: [MICROSOFT_STORE.md](MICROSOFT_STORE.md).

**Store package version.** The Store package version is the app version with a fourth part of 0: `X.Y.Z` ships as `X.Y.Z.0` (1.0.0 is 1.0.0.0). Microsoft: the fourth section is reserved for the Store and must be 0, and the first section cannot be 0 ("The other sections must be set to an integer between 0 and 65535 (except for the first section, which cannot be 0)", source: https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-package-requirements). So `release:store` (and `release:store -- --check`) refuses a 0.x app version with a clear message; only `--local-test` may build one, for sideload testing, and that package is never uploaded. Each part must be at most 65535. File names keep the app version; `build-summary.txt` prints both. The old `(major+1).minor.patch.0` mapping was removed on 2026-10-08.

**Minimum Windows version.** The manifest `MinVersion` is `10.0.18362.0` (Windows 10 version 1903, the first release with `desktop6:FileSystemWriteVirtualization` and `unvirtualizedResources`; sources and the certification risk in [MICROSOFT_STORE.md](MICROSOFT_STORE.md), blocking item 4).

### Releasing 1.0.0 with Release-As (history)

This is how Burrow 1.0.0 was released, kept as the record of the step. Burrow 1.0.0 went out on every channel (Gumroad, the direct download and the Store), because the Store cannot take a 0.x version. The package.json and the manifest were not edited by hand and nothing was tagged by hand. Instead, one commit landed on `main` whose body carried a `Release-As` footer, so the release PR that release-please opened was 1.0.0. The footer must be the last paragraph of the commit message, after a blank line. For a squash merge, put it in the squash commit body:

```text
chore: release 1.0.0

Release-As: 1.0.0
```

That commit was an empty commit on a branch that was then merged: `git commit --allow-empty -m "chore: release 1.0.0" -m "Release-As: 1.0.0"`. After the merge, release-please updated its release PR to 1.0.0, the PR title (`chore(main): release 1.0.0`) was checked before merging it, and the release then followed "Cut a release" above as usual. Later releases need no `Release-As` footer. The Store bundle is built with `npm run release:store` (see [MICROSOFT_STORE.md](MICROSOFT_STORE.md)).

`--local-test` builds of 0.4.1 (the sideload test, `scripts/store/sideload-test.ps1`) worked before 1.0.0: `npm run release:store -- --local-test --sign-local-test --arch arm64` gave package version `0.4.1.0`. Without `--local-test`, `release:store` refuses a 0.x app version.

**No feature dates.** There are no per-feature release dates to maintain any more: the Store per-feature rule and `server/license/proFeatureDates.js` were removed when Burrow became free for everyone ([ADR 0002](adr/0002-free-for-everyone.md)).

**Store sidecars never ship directly.** `release:store` builds sidecars with the `store` distribution marker into `src-tauri/binaries` (and the Store bundle and SEA exe into `.sidecar-build`) and removes them again when it ends, only if they carry the `store` marker. Run `npm run desktop:sidecar` after a Store build before direct dev work. `BURROW_DISTRIBUTION` is removed from the environment of `desktop:build` and `buildInstaller.js`, `buildSidecar.js` reads the distribution only from `--distribution`, `src-tauri/build.rs` stops on any value but `direct` or `store`, and `buildInstaller.js` checks the compiled shell for `burrow-distribution=direct`. The direct paths (`desktop:build`, `buildInstaller.js`, `release:local`, and the CI steps that run `channelMarker.js`) pass `--expect-distribution direct` and refuse a store-marked sidecar.

## Code signing

The installers are unsigned (no Authenticode certificate), so Windows SmartScreen warns on first run. This is stated in the public release notes and in `docs/INSTALL.md`. Signing is a planned step: `desktop-windows.yml` has a marked placeholder step where it would go. The updater signature described above is a different thing: it is made with your own key and only lets the installed app check that an update really comes from you.
