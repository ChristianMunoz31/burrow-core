# Contributing to Burrow

Burrow is a local-first personal data OS. Read [docs/PRODUCT.md](docs/PRODUCT.md) before planning any work: it is the source of truth for what Burrow is for. If a change conflicts with it, stop and raise it instead of guessing.

## Setup

Requires Node `^22.13.0 || >=23.4.0` (Burrow uses the built-in `node:sqlite`).

```powershell
npm ci
npm start      # API on http://127.0.0.1:4321
npm run dev    # Vite UI on http://localhost:5174 (second terminal; proxies /api to the API)
```

`npm ci` also runs the `prepare` script, which installs the git pre-commit hook (see [Checks and the pre-commit hook](#checks-and-the-pre-commit-hook)).

Other commands: `npm test`, `npm run lint`, `npm run build` (then `npm start` serves `dist/` as one process). Configuration is in `.env` (copy `.env.example`); see the README.

## Branches and commits

- Branch prefixes: `feat/`, `fix/`, `chore/`, `docs/`.
- Conventional commits with a scope: `feat(budget): add category rollover`. The PR title must follow the same format. Release notes are generated from these (see [Releases](#releases)); only `feat`, `fix`, `perf` and `docs` appear in the changelog.
- Explain the root cause before fixing a bug. Do not add features beyond the task.

## Product rules checklist

Every change must respect these (the PR template repeats them). Details are in [docs/PRODUCT.md](docs/PRODUCT.md).

- [ ] AI summarizes, code calculates: numbers are computed in SQL or JS and only results go to the model, with a test proving the model is not asked to do math.
- [ ] No outbound call without a `server/netPolicy.js` feature that is off by default. The one exception is the user-clicked model download (`POST /api/settings/ai/pull`), which only talks to a loopback Ollama. Never add an automatic or background pull.
- [ ] No personal data in the repo, fixtures, prompts or tests.
- [ ] A schema change is a new migration (never an edit to a shipped one) and the migration safety test passes.
- [ ] Export, import, backups and privacy controls are never paywalled or weakened.
- [ ] No em dashes in user-facing copy.
- [ ] Targets ordinary CPU-only hardware; $0 marginal cost (no new hosted services or per-user APIs without owner approval).
- [ ] No private-module code in core: code that only the private module uses lives in `pro/` ([docs/OPEN_CORE.md](docs/OPEN_CORE.md)), and core never imports `pro/`.
- [ ] Burrow is free for everyone ([docs/adr/0002-free-for-everyone.md](docs/adr/0002-free-for-everyone.md)): no paid tier, trial, license key, Buy button or upgrade prompt, and no copy that says "Pro", "trial" or a price.
- [ ] Public copy may say the Burrow core is open source under AGPL-3.0-only (https://github.com/ChristianMunoz31/burrow-core). It must never say that the private module is open source or that its source is public, and never offer Docker self-hosting ([docs/PUBLISHING_CORE.md](docs/PUBLISHING_CORE.md)).

## Development workflow

### Sandbox

Run a throwaway Burrow with generic demo data, without touching your real data or your dev servers:

```powershell
npm run sandbox                       # fresh demo data, free port, Ctrl+C to stop
npm run sandbox -- --keep             # reuse the sandbox data dir between runs (seeds only if empty)
npm run sandbox -- --port 4400        # choose the port
npm run sandbox -- --name checkout    # separate data dir per name (letters, digits, . _ -)
npm run sandbox -- --reset            # remove all sandbox data (same as npm run sandbox:reset)
```

Other flags: `--build` (rebuild `dist/` first; it is built automatically if missing), `--no-seed` (start empty), `--app-dir <dir>` (run another checkout).

What it guarantees (enforced in `scripts/lib/sandboxSafety.js`):

- The data dir is always under the OS temp folder (`burrow-sandbox/<name>`), and the script refuses any path that is, contains or sits inside the real Burrow data directory. It never touches the real data dir.
- The port can be any integer from 1024 to 65535 except 4321 and 5174. Without `--port` a free port is picked.
- The server runs on `127.0.0.1` with `.env` loading skipped (`BURROW_NO_DOTENV=1`), the scheduler off and no network opt-ins. It gets a minimal env (`PATH`, `SystemRoot`, `ComSpec`, `PATHEXT`, `TEMP`, `TMP` and the explicit `BURROW_*` sandbox vars; no tokens, cloud keys, `OLLAMA_HOST` or `NODE_OPTIONS`), and `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA` and `XDG_DATA_HOME` point at `burrow-sandbox/<name>/home`, so even a branch that ignores `BURROW_DATA_DIR` stays in temp. npm runs through node with no shell. Before printing the URL it checks that the server reports the sandbox port and database path.

Demo data comes from `scripts/seedDemo.js`: generic, fictional and deterministic (about six months of transactions with recurring subscriptions, a budget plan, todos, habits, events, journal, notes, bookmarks, countdowns and focus sessions). It never contains personal data. You can also run it directly: `node scripts/seedDemo.js --data-dir <dir> [--app-dir <dir>] [--force] [--now <iso>]` (`--now` is a test seam that fixes the clock and must not be in the future); the directory must be under the OS temp folder and it refuses a database that already has data unless you pass `--force`.

### Branch and PR previews

Run any branch or pull request in an isolated git worktree with demo data. This is local only: there are no hosted previews.

```powershell
npm run preview:branch -- feat/my-branch
npm run preview:branch -- "#42"           # or 42; quote the # in PowerShell
npm run preview:branch -- 42 --dry-run    # print the plan, change nothing
npm run preview:branch -- 42 --yes        # a PR number needs --yes (or a y/N answer at a terminal)
npm run preview:branch -- 42 --port 4401 --no-install --yes
npm run preview:clean                     # remove worktrees, preview/pr-* branches and their sandbox data
```

It fetches the branch (or `pull/N/head`) from `origin`, creates a worktree under the OS temp folder (`burrow-previews/<slug>`), runs `npm ci --ignore-scripts` and `npm run build` there (no shell, minimal env, fake home), then starts it with this checkout's `scripts/sandbox.js`, so the sandbox safety rules always apply. If the fetch fails for a branch name, it falls back to the local branch. A preview runs that branch's code, so it prints a warning, and a PR number asks for confirmation before anything beyond the fetch. Needs `git` and an `origin` remote. Run `preview:clean` when you are done.

### Tests

`npm test` runs Vitest with two projects: `frontend` (jsdom, `src/**/__tests__/`) and `backend` (node, `server/__tests__/`). Use `npm run test:watch` while developing, and `npx vitest run --project backend` to run one project.

- Backend tests use the real temp SQLite helper `server/__tests__/helpers/testDb.js`, not DB mocks. Fixtures are synthetic.
- Never depend on a real Ollama. Mock it with `server/__tests__/helpers/fakeOllama.js`.
- Backup event-loop lag is measured by hand, not in `npm test`: `node scripts/bench/backupLag.js [--no-worker] [--tx N] [--journal N]` seeds synthetic data in a temp dir (removed afterwards); `--no-worker` forces the main-thread path, `--tx` and `--journal` set the row counts (defaults 200000 and 5000).
- **Network guard.** `server/__tests__/setup/networkGuard.js` runs in both projects. It blocks every non-loopback connection and any loopback connection to the fixed ports 11434 (Ollama), 4321 and 5174 (your live servers), so a test behaves the same on your machine and in CI. A blocked call fails with code `ENETBLOCKED`, and an `afterEach` hook fails the test even if the test swallowed the error. Servers on ephemeral loopback ports (supertest, `listen(0)`) are fine. If a test really needs a real fake server on a fixed blocked port, call `allowLoopbackPort(port)` from that setup file; it resets after each test.

### Migrations

Migrations are forward-only SQL files in `server/db/migrations/` named `NNN_name.sql` (lowercase letters, digits, underscores). Never edit a shipped migration: add a new numbered file instead.

`server/db/migrations.lock.json` records a SHA-256 of every shipped migration (content with `\r\n` normalized to `\n`). `server/__tests__/migrationSafety.test.js` fails if a migration file is missing from the lock, if a locked file is missing, or if a locked file changed ("shipped migrations are immutable; add a new NNN file"). The same test builds a database at every older schema version with a row in every table, upgrades it to the latest, and checks that no row is lost, a `burrow.db.pre-vN.bak` backup is written and restores, and that a failing migration leaves the live database untouched.

To add a migration:

1. Create `server/db/migrations/004_your_change.sql` (next number).
2. Compute its hash and add one line to `server/db/migrations.lock.json` (keep the file list in order):

   ```powershell
   node -e "const c=require('crypto'),fs=require('fs');console.log(c.createHash('sha256').update(fs.readFileSync('server/db/migrations/004_your_change.sql','utf8').replace(/\r\n/g,'\n')).digest('hex'))"
   ```

   ```json
   "004_your_change.sql": "<the hash printed above>"
   ```

3. Run `npm test`. If you add a table or column, also update `server/db/tables.js` so the safety test covers it.

### Checks and the pre-commit hook

```powershell
npm run check            # em dash, personal-data and private-key checks
npm run check:em-dash    # no em dashes in user-facing JSX (comments and tests are ignored)
npm run check:personal   # emails, phones, SSNs, card numbers, home paths, public IPs, private denylist
npm run check:keys       # no PEM private keys in tracked or staged text files
npm run check:bundle     # gzip size of dist/ against scripts/checks/bundle-budget.json (run npm run build first)
```

The personal-data check also reads an optional gitignored `.personal-denylist` file (one term per line) and the `PERSONAL_DENYLIST` environment variable; it never prints a denylist term. Intentional exceptions go in `scripts/checks/personal-data.allow.json`.

CI runs gitleaks over full history (the `hygiene:` steps of `ci.yml`), so a committed private key fails CI even if the hook was bypassed.

`npm install` / `npm ci` runs `scripts/installHooks.js`, which sets the repo-local `core.hooksPath` to `.githooks` (it does nothing outside a git checkout and never changes global config). The hook runs ESLint on staged `.js`/`.jsx` files, then the em dash and personal-data checks on staged content. Bypass it only in an emergency with `git commit --no-verify`; CI runs the same checks.

### Licensing

Burrow is free for everyone: there is no license key, trial, activation or paid tier, and the app contacts no store. The core is AGPL-3.0-only; the private module is proprietary and included at no cost in official builds. See [docs/LICENSING.md](docs/LICENSING.md) and [ADR 0002](docs/adr/0002-free-for-everyone.md). `npm run check:licenses` audits dependency licenses.

- **Support address.** The one owner-specific value left, `supportContact`, lives in `config/support.json`. The privacy page generator, the About menu and the Report content draft read it. `config/store.json` and `npm run check:store-config` no longer exist.
- **Legacy data.** Older versions stored license, trial and clock files. Nothing reads them; their names stay listed so Erase removes them and an import skips them.
- **Build info.** `npm run build` runs `postbuild`, which writes `dist/burrow-build-info.json` (build date from `BURROW_BUILD_DATE`, else the HEAD commit time, else the clock). Without it the app treats the build date as "now".

### Continuous integration

| Workflow | When | What |
| --- | --- | --- |
| `ci.yml` | every PR (the required `verify` job; a docs-only PR still runs it and skips the heavy steps inside), push to `main` (not for docs-only changes: `*.md`, `docs/`, `LICENSE`), and by hand (`workflow_dispatch`, which `release-please.yml` uses on the release PR) | PR `verify`: `hygiene:` steps (gitleaks over full history with the config in `.gitleaks.toml`, em dash, keys, personal data), tests-required, lint, affected unit tests (`vitest --changed <base sha>`; the whole suite when config or shared files change), coverage of changed files, build, bundle budget, Playwright. Push to `main`: the whole suite in 3 shards plus lint and build, no Playwright. Manual `mode=full`: hygiene, lint, full suite, build, bundle budget, all Playwright projects |
| `hygiene.yml` | (gone) | merged into `ci.yml`, not removed: its checks are the `hygiene:` steps of `ci.yml` |
| `release-please.yml` | push to `main`, daily | opens or updates the release PR, labels it `hold` and starts `ci.yml` (`mode=full`, which includes the hygiene steps) on its branch (PRs made with `GITHUB_TOKEN` trigger no workflows); after the release PR is merged, calls `release.yml` with `desktop: true` and `publish: release` |
| `desktop-check.yml` | push to `main` and PRs that change `src-tauri/**` (or this workflow) only | Ubuntu 22.04: `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`. About 12 to 15 min on a cold cache, 3 to 5 with a warm cache |
| `release.yml` | called by release-please, tag push `v*`, or manual | builds the release zip and checksums (private release); with `desktop` (always on from release-please) builds the Windows x64 and ARM64 installers through `desktop-windows.yml`, smoke-tests them and publishes them to the public `burrow-releases` repo; a manual run can also build macOS and Linux installers |
| `desktop-windows.yml` | called by `release.yml` only | native `windows-latest` (x64) and `windows-11-arm` (ARM64) builds: sidecar smoke test (blocking), NSIS installer under a stable name, installer smoke test (non-blocking) |
| `dev-build.yml` | manual only | builds an unsigned Burrow Dev installer and publishes it as a dev pre-release (see Dev channel). Windows is billed 2x, macOS 10x |
| `flaky.yml` | weekly (Sundays), and by hand | repeats the test suite 3 times on `main` (skipped when `main` is unchanged), files one "Flaky tests on main" issue, and runs every Playwright project once; a manual run can pick runs, project and runner |

**Minutes budget.** The repo is private, so Actions minutes are multiplied by runner OS: Linux 1x, Windows 2x, macOS 10x. The main gate and `desktop-check.yml` run on Linux only. Windows and macOS runs are manual only (Windows through `flaky.yml`, the desktop builds in `release.yml`, and `dev-build.yml`), so use them deliberately. A Windows desktop build costs about 30 to 40 billed minutes for x64 and 40 to 50 for ARM64, macOS about 200 and Linux about 15, plus a few minutes for the test job. A full release (assets, both Windows installers, publish) is about 80 to 100 billed minutes. Build one platform while you iterate. All actions are pinned to commit SHAs.

The owner can optionally register a self-hosted Windows ARM64 runner on their own PC to save the ARM64 minutes (`scripts/runner/setup-runner.ps1`, see [docs/SELF_HOSTED_RUNNER.md](docs/SELF_HOSTED_RUNNER.md)). It is for the release workflows of this private repo only: pull request and fork code never runs on it, and no other workflow may use the `self-hosted` label. Contributors need to do nothing; without it the ARM64 build runs on the hosted `windows-11-arm` runner.

### Releases

The owner's whole job is step 3. The one-time setup, the manual dry run and the fallbacks are in [docs/RELEASING.md](docs/RELEASING.md).

1. Merge work to `main` using conventional commits.
2. `release-please.yml` keeps a release PR open with the next version (`package.json` plus `CHANGELOG.md`). While the version is below 1.0, `feat` bumps the minor version. Every time it creates or updates that PR it labels it `hold` and starts `ci.yml` (`mode=full`) on the release branch. The branch is `release-please--branches--main--components--burrow` and the tag is plain `vX.Y.Z` (`include-component-in-tag: false`). The PR bot never merges a release PR.
3. Merging the release PR creates the `vX.Y.Z` tag and GitHub release in the private repo. Because tags created with `GITHUB_TOKEN` do not trigger other workflows, `release-please.yml` calls `release.yml` directly with `desktop: true` and `publish: release`.
4. `release.yml` runs `npm ci`, `npm test` and `npm run build`, checks that the build wrote a real build date (`node scripts/license/writeBuildInfo.js --check`, which fails unless the date came from `BURROW_BUILD_DATE` or git), then attaches `burrow-<version>.zip` (the source plus the built `dist/`, runnable with `npm ci --omit=dev; npm start`) and `SHA256SUMS.txt` to the private release. The zip and its checksums stay in the private repo only. The zip is core-only source: the job never checks out `pro/` and asserts `--expect-pro absent`. The installer jobs check out the private `burrow-pro` repo (see [docs/RELEASING.md](docs/RELEASING.md)).
5. In parallel, `desktop-windows.yml` builds the unsigned Windows installers natively (x64 on `windows-latest`, ARM64 on `windows-11-arm`). Each build smoke-tests the sidecar (`scripts/release/smokeSidecar.js`, blocking) and the installer (`scripts/release/smokeInstaller.js`, non-blocking), then renames the installer to `Burrow-Setup-x64.exe` or `Burrow-Setup-arm64.exe`.
6. The installers and per-arch checksums are also attached to the private release. Then `publish-public` builds `SHA256SUMS.txt` and runs `scripts/release/publishPublic.js`, which publishes a release with the same tag in the PUBLIC repo `ChristianMunoz31/burrow-releases` (the two installers and `SHA256SUMS.txt` only, with plain-language notes from `CHANGELOG.md`) and marks it latest. It authenticates with the `RELEASES_TOKEN` secret and fails early with instructions when it is empty. So `https://github.com/ChristianMunoz31/burrow-releases/releases/latest/download/Burrow-Setup-x64.exe` (and `...-arm64.exe`) always resolve to the newest release.

`release.yml` can also be run by hand (`workflow_dispatch`) with a tag. Tick `desktop` and choose `desktop_platforms` (`windows` by default, or `macos`, `linux`, `all`) to also build desktop installers. Windows runs the same pipeline as above; macOS and Linux (never automatic) attach their installers to the private release. `publish` (`none`, `draft`, `prerelease`, `release`) controls the public repo; `none` only dry-runs the publish script. For a dry run before any real tag exists, set `tag` to a test name such as `v0.1.0-dryrun.1` and `source_ref` to `main`: the build uses `source_ref`, the public release uses the tag name and nothing is written to the private repo. The builds are unsigned until code signing is decided (see the open decisions in [docs/PRODUCT.md](docs/PRODUCT.md)), so users see the SmartScreen warning (see [docs/INSTALL.md](docs/INSTALL.md)). The signing step is a marked placeholder in `desktop-windows.yml`.

### Desktop app

The desktop app is a Tauri v2 shell in `src-tauri/` around the same server and UI. End users follow [docs/INSTALL.md](docs/INSTALL.md).

**Prerequisites.**

- Node (as above) and Rust stable (https://rustup.rs).
- Windows: Visual Studio Build Tools with the C++ workload for your CPU architecture (x64 or ARM64), and Microsoft Edge WebView2 (already on Windows 11).
- Linux: the webkit2gtk-4.1 packages and the usual build tools (see `.github/workflows/desktop-check.yml` for the exact `apt` list).
- macOS: Xcode Command Line Tools (`xcode-select --install`).

**Commands.**

```powershell
npm ci
npm run desktop:dev      # builds the normal UI when dist/ is stale, then runs the shell with `node server.js`
npm run desktop:dev -- --devtools   # the same with the developer tools UI (Settings > Developer)
npm run desktop:build    # npm run build, sidecar, then tauri build
npm run desktop:sidecar  # only the sidecar and src-tauri/resources/ (needs dist/ first)
npm run desktop:icons    # regenerate icons from src-tauri/icons/source.svg (also the Dev icons)
npm run desktop:build:dev # Burrow Dev build (see "Dev channel" below)
```

- `desktop:dev` always uses a fresh temp data dir (`burrow-desktop-dev/<timestamp>` under the OS temp folder) through `BURROW_DESKTOP_DATA_DIR`. It never touches your real data. Without that variable the app would use your real data folder, so do not run the shell by hand without it. Set it per shell only, never as a persistent user variable: an installed Burrow honours it too (it logs a line to `server.log` when it does), and a temp data folder can be cleaned up by the OS.
- `desktop:build` writes installers to `src-tauri/target/release/bundle/` (`nsis/` for the Windows `.exe`, and on other systems `dmg/`, `appimage/` and `deb/`). The default target in `tauri.conf.json` is NSIS only (a per-user installer; MSI was dropped because it installs per machine). CI passes `--bundles` for each OS.
- Icons: replace `src-tauri/icons/source.svg` (square, ideally 1024 px) and run `npm run desktop:icons`. Then delete the extras it makes that the bundle does not use (`android/`, `ios/`, `Square*.png`, `StoreLogo.png`, `64x64.png`). The current logo is a placeholder until the owner approves final artwork.
- Cross-builds: the sidecar is a Node single executable made from a `node` binary, so `desktop:build` only supports the host target and fails clearly for another `--target`. An x64 Windows build needs an x64 `node.exe`, which CI has because it builds on an x64 runner, and the ARM64 build runs on the native `windows-11-arm` runner. macOS CI builds a universal app by injecting the sidecar into both arm64 and x64 Node binaries (`--node-binary` and `--out-triple` in `scripts/desktop/buildSidecar.js`).
- Rust tests: `cd src-tauri; cargo test`. Run `npm run build` and `npm run desktop:sidecar` first, because the build script needs the sidecar and `src-tauri/resources/` to exist (the same applies to `cargo clippy`).
- The protocol between the shell and the server (environment, stdin secret, ready line, shutdown) and the security model are described in [src-tauri/README.md](src-tauri/README.md).
- In-app updates are opt-in and Stable only. With the `updates` setting on (the switch in Settings > Updates, the same one as in Settings > Network, which Check now turns on), Settings > Updates shows what is new and, only after a click on Download and install, saves a backup and lets the Burrow app download and install the update, checked against the owner's signing key. There is no automatic install and no background check. Burrow Dev makes no update request and never installs updates itself (it shows the `npm run dev:update` instruction). The release pipeline stays off (three public assets, no signing) until the owner puts a real public key into `src-tauri/tauri.release.conf.json`: see "Updater signing key" in [docs/RELEASING.md](docs/RELEASING.md). Never commit or paste a signing key.

### Dev channel (Burrow Dev)

Burrow Dev is a second, unsigned build of the desktop app for testing. It installs next to Burrow and shares nothing with it: its own app identity, install folder, data, logs, icon and update source. Dev builds are internal; they are never attached to a `v*` release and never offered to users. The stable path is the default everywhere: nothing becomes a Dev build unless `BURROW_CHANNEL=dev` is set at build time.

**Developer tools.** The developer tools seam (Settings > Developer, `GET /api/dev/status`) lives in the top-level `devtools/` folder, not in the core. It is a minimal placeholder: the Settings > Developer card says developer tools are on, and the route answers `{ devTools: true }`. It is in `npm run dev`, `npm run desktop:dev -- --devtools`, `npm run build:devtools; npm start` and Burrow Dev builds, and never in a stable build, the Microsoft Store build, Docker or the release zip. The tier switcher it used to hold is gone with the tiers (ADR 0002). Plain `desktop:dev` builds the normal UI and rebuilds dist/ by itself when it is missing, was built in the other mode, from another commit, or the worktree has changes (a stamp in dist/ that the sidecar copy and the Store layout skip); the build identity line at the bottom of Settings says `stable · developer tools` when the tools UI is in. `desktop:dev -- --devtools` leaves a dist with the developer tools: run `npm run build` before any stable `desktop:sidecar`, `release:store --reuse-web` or `release:local`, which refuse a dev-tools dist.

**Commands.**

```powershell
npm run desktop:build:dev                 # full local Dev build (host target); installer lands in .dev-build/
npm run desktop:build:dev -- --bundles nsis   # extra flags go to `tauri build`
node scripts/desktop/devVersion.js --json # print the next Dev versions and tag
npm run desktop:icons                     # regenerate the stable icons and the Dev icons (src-tauri/icons/dev)
```

`desktop:build:dev` computes the versions, sets `BURROW_CHANNEL=dev` and `BURROW_DISPLAY_VERSION`, runs `npm run build`, builds the sidecar with `--channel dev`, checks the channel marker, writes the gitignored overlay `src-tauri/tauri.dev.build.json` (the committed `src-tauri/tauri.dev.conf.json` plus the bundle version), runs `tauri build --config`, then collects the installer and `SHA256SUMS-dev-<platform>.txt` into `.dev-build/`. `npm run desktop:build` stays stable only and refuses when `BURROW_CHANNEL` is set to anything but `stable`, or when `BURROW_DISPLAY_VERSION` is set.

**What is separate.**

| | Burrow | Burrow Dev |
| --- | --- | --- |
| App identifier | `com.burrow.desktop` | `com.burrow.desktop.dev` |
| Product and binary | `Burrow` | `Burrow Dev`, `BurrowDev.exe` (the installer's "app is running" check needs a different exe name) |
| Install folder (Windows, per user) | `%LOCALAPPDATA%\Burrow` | `%LOCALAPPDATA%\Burrow Dev` |
| Data folder (Windows) | `%APPDATA%\Burrow` | `%APPDATA%\Burrow Dev` |
| Data folder (macOS, Linux) | `Application Support/Burrow`, `burrow` under `XDG_DATA_HOME` | `Application Support/Burrow Dev`, `burrow-dev` under `XDG_DATA_HOME` |
| Log folder (Windows) | `%LOCALAPPDATA%\com.burrow.desktop\logs` | `%LOCALAPPDATA%\com.burrow.desktop.dev\logs` |
| Single-instance lock | per identifier | per identifier, so both run at once |
| Icon | `src-tauri/icons/*` | `src-tauri/icons/dev/*` (same artwork plus an amber DEV badge) |
| Update source | latest release of the public `burrow-releases` repo (same `vX.Y.Z` tag as the source release); in-app install: stable only | newest dev pre-release (tag `dev-YYYYMMDD-<sha7>`, title `Burrow Dev <display version>`) |

**Versions.** Dev builds carry two version strings for the same build, because the display form is not valid for every installer field.

| | Stable | Dev (example: commit `abc1234`, built 2026-10-05, next version `0.2.0`) |
| --- | --- | --- |
| Display version | `X.Y.Z` | `0.2.0-dev.20261005.abc1234` |
| Bundle version (Tauri and NSIS) | `X.Y.Z` | `0.2.0-dev.20261005+1008` |
| Windows file version | `X.Y.Z` | `0.2.0.1008` |
| Git tag | `vX.Y.Z` | `dev-20261005-abc1234` |
| Installer | `Burrow_X.Y.Z_<arch>-setup.exe` | `Burrow-Dev_0.2.0-dev.20261005.abc1234_arm64-setup.exe` |

- The next version comes from `.release-please-manifest.json` and `bump-minor-pre-major`: while the major is 0 it is `0.(minor+1).0` (so `0.1.0` becomes `0.2.0`), otherwise `major.(minor+1).0`.
- The display version is what the user sees: the server, the About dialog, the Dev badge, backups metadata and the update check all use it. It contains the commit's 7-character sha.
- The bundle version only goes into the generated Tauri overlay. It is valid semver, drops the sha (an all-digit sha with a leading zero is not valid semver) and ends in a build number: whole days since 2024-01-01, between 1 and 65535. That gives Windows a numeric, increasing file version, shows `0.2.0-dev.20261005+1008` in Apps & Features, and lets the installer's downgrade check order Dev builds by date. macOS gets the same number as `bundleVersion`.
- The build date follows `resolveBuildDate()` (`BURROW_BUILD_DATE`, else the HEAD commit time, else the clock). Dev builds need a git checkout.
- `--collect` renames installers (bundle version to display version, `Burrow Dev` to `Burrow-Dev`) and fails if a name lacks the display version or the word `dev`.

**Guards (stable can never become Dev).**

- The server learns its channel from the esbuild define `__BURROW_CHANNEL__` (always set in a bundle, `"stable"` or `"dev"`). The shell environment cannot switch a bundle. `BURROW_CHANNEL=dev` only affects a source checkout (`npm start`); the Rust shell reads its channel from the app identifier.
- Every bundle starts with the marker `/*! BURROW_CHANNEL=<channel> */`, and `dist/burrow-build-info.json` records `channel`. `node scripts/checks/channelMarker.js --expect <stable|dev> --bundle <file> --dist-dir <dir>` verifies both. `release.yml` sets `BURROW_CHANNEL: stable`, runs the check with `--expect stable`, fails if `BURROW_DISPLAY_VERSION` is set, and fails if any collected installer name matches `dev`.
- A `dev-*` tag never starts a release: the release tag pattern is `v*`.
- **Cross-checks before anything touches the data folder.** In the desktop app the shell always passes `BURROW_SHELL_CHANNEL=stable|dev` to the sidecar. The server exits with code 1 and a plain message when that is not its own channel (a bundled server also refuses when it is missing), and its `BURROW_READY` line carries `channel`, which the shell checks against its own (a mismatch stops the server and shows the error page). A Dev server (and a Dev shell, before it starts the sidecar) also refuses a data folder that is, contains or lies inside the stable default data folder or the `BURROW_STABLE_DATA_DIR` copy source, compared by real location (links resolved, case-folded on Windows and macOS) with no read of the folder. `desktop:build` and `desktop:build:dev` accept no `--config` or `-c` in their passthrough, and right before `tauri build` they scan the bundle and the packaged sidecar executable for the channel marker (`channelMarker.js --binary <file>`), so a stale sidecar of the other channel cannot be packaged.
- **Not a trust boundary.** These guards stop mistakes (a wrong `BURROW_DATA_DIR`, an old sidecar, a mixed-up installer), not a determined user. The release zip and Docker image run the server unbundled, so they read `BURROW_CHANNEL` from the environment like a source checkout; `__BURROW_RELEASE_BUILD__` is defined only in a bundled sidecar, so an unbundled copy is a source checkout as far as the developer tools are concerned. Only the esbuild define of a bundled sidecar is fixed at build time.
- **Separate sidecar binary.** Burrow Dev packages its server as `burrow-dev-server-<triple>` (Burrow keeps `burrow-server-<triple>`), so both can install into the same folder, as Linux packages do, without sharing a file. `buildSidecar.js --channel dev` writes that name and the shell picks it from its channel.

**Channel detection (for reuse).** To ask "is this Burrow Dev?" in server code, call `isDevChannel()` (or `getChannel()`) from `server/channel.js`; do not compare `BURROW_CHANNEL` or `'dev'` yourself. The bundled `__BURROW_CHANNEL__` define wins, and the env var is read only by an unbundled source checkout, so it is not a trust boundary. The matching signals are the `channel` field in `dist/burrow-build-info.json` (build time) and `channel` in `GET /api/app-info` (client side). Burrow is free for everyone, so there is no license or purchase behavior that differs between Burrow and Burrow Dev.

**Copy data from Burrow.** Settings > Data & storage in Burrow Dev has "Copy my data from Burrow". It is one-way: Burrow Dev reads Burrow's database files with shared read-only file handles (never opening them with SQLite), copies them into a private folder inside the Dev data folder, and checks that nothing changed during the copy (it retries, then answers busy). Burrow's folder is never written to. The copy then goes through the normal restore flow, so Burrow Dev first makes a safety backup of its own data and keeps its own saved keys. Saved keys from Burrow are never copied. The routes `GET` and `POST /api/backups/stable-copy` exist only in the dev channel (a stable server answers `404 not_found`). For tests, `BURROW_STABLE_DATA_DIR` (server) or `BURROW_DESKTOP_STABLE_DATA_DIR` (Dev shell only) points the copy source at a throwaway folder.

**Dev update check.** The `updates` feature in a Dev build lists releases (`GET /repos/ChristianMunoz31/burrow/releases?per_page=20`, the private source repo, because `dev-build.yml` publishes dev pre-releases there; anonymous reads of a private repo get a 404, so the check reports `unavailable` unless the dev pre-releases move to a public place, a decision for the owner) and only considers non-draft pre-releases whose tag matches `dev-YYYYMMDD-<sha7>` and whose title is `Burrow Dev <display version>` with the same date and sha. It offers the newest one. A stable build never calls the list endpoint: it reads `GET /repos/ChristianMunoz31/burrow-releases/releases/latest`, a public repo, so installed copies can check without a token.

**Environment variables.**

| Variable | Where | Meaning |
| --- | --- | --- |
| `BURROW_CHANNEL` | build scripts, CI; source-checkout runtime | `dev` or `stable`. Unset means `stable`; any other value is an error at build time and is treated as stable at runtime by a source checkout |
| `BURROW_DISPLAY_VERSION` | build scripts, CI | The Dev display version. Required for dev, refused for stable |
| `BURROW_SHELL_CHANNEL` | desktop shell | `stable` or `dev`, always set by the shell for its sidecar; the server refuses to start when it is not its own channel |
| `BURROW_STABLE_DATA_DIR` | server, dev channel only | Overrides the folder "Copy my data from Burrow" reads |
| `BURROW_DESKTOP_STABLE_DATA_DIR` | developer, read by the Dev shell only | Becomes `BURROW_STABLE_DATA_DIR` for the Dev sidecar. The stable shell ignores it |

**CI: `dev-build.yml`.** Manual only (`workflow_dispatch`); it never runs on a push, tag or schedule. Run it from the Actions tab (pick the `dev-build.yml` workflow, then **Run workflow**) or:

```powershell
gh workflow run dev-build.yml -f platforms=windows -f keep=10
```

- Inputs: `platforms` (`windows` by default, or `macos`, `linux`, `all`) and `keep` (how many dev pre-releases to keep, 1 to 50, default 10).
- Jobs: `plan` (versions, matrix, draft pre-release), `test` (`npm test`), `build` (per platform: sidecar with `--channel dev`, channel marker check, `tauri build --config`, upload the installer and checksums to the draft), `publish` (turns the draft into a pre-release, never "latest"), `cleanup`.
- The release is named `Burrow Dev <display version>`, tagged `dev-YYYYMMDD-<sha7>` and marked pre-release. That title and tag are what the Dev update check parses.
- Minutes: the repo is private, so Windows is billed at 2x and macOS at 10x. Windows costs about 30 billed minutes, macOS about 200, Linux about 15, plus the test and plan jobs. Build Windows only while you iterate.
- Cleanup keeps the newest `keep` dev pre-releases, deletes older ones and their tags, and deletes any draft dev release older than one day. It only matches pre-releases whose tag is `dev-YYYYMMDD-<sha7>`, so `v*` releases are never touched.
- Actions are pinned to the same commit SHAs as `release.yml`, and the workflow only has `contents: read` at the top level.

#### Keep this PC's Burrow up to date (developers)

`npm run desktop:install` installs a build over the Burrow or Burrow Dev already on this Windows PC, so your own copy follows the code. It is a developer script (Windows only, nothing in the app calls it) and it is a dry run unless you add `--install` (asks to confirm) or `--yes`.

```powershell
npm run desktop:install                                   # dry run: Burrow Dev from this checkout, prints the plan
npm run desktop:install -- --install                      # build this checkout (desktop:build:dev --bundles nsis), install over Burrow Dev
npm run desktop:install -- --skip-build --yes             # reuse the installer in .dev-build/ if it was built from HEAD
npm run desktop:install -- --channel stable --from latest # dry run: newest public release (sha256 checked against SHA256SUMS.txt)
npm run desktop:install -- --channel stable --from <installer.exe> --install   # a local installer, e.g. the one release:local staged
npm run dev:update                                        # git pull --ff-only, then build and install over Burrow Dev with no prompt (--yes --close)
```

`npm run dev:update` is the one-step refresh of Burrow Dev: it fast-forwards the current branch (and stops if it cannot), then runs `desktop:install -- --yes --close`, so an open Burrow Dev is asked to close and the data folder is backed up as below. It never touches the stable Burrow.

- **What it touches.** Only the target channel: Burrow Dev (`%LOCALAPPDATA%\Burrow Dev`, `BurrowDev.exe`, `burrow-dev-server.exe`, data `%APPDATA%\Burrow Dev`) or Burrow (`%LOCALAPPDATA%\Burrow`, `Burrow.exe`, `burrow-server.exe`, data `%APPDATA%\Burrow`). The names come from `src-tauri/tauri.conf.json` and `tauri.dev.conf.json`. The two channels share no folder, exe name or identifier, and the script refuses to run if they ever overlapped. It never reads, writes, closes or backs up the other channel. The installers are the per-user NSIS ones, so there is no UAC prompt, and the installer hooks keep the data folder.
- **Stable is never built here.** `--channel stable` needs `--from latest` (the only network use: two plain GETs of the public `burrow-releases` download links, on your command) or `--from <path>` (must start with `MZ`; its sha256 and PE version are printed). A downloaded file that does not match `SHA256SUMS.txt` is refused.
- **Running app.** The script refuses if the app or its sidecar is running, and checks again right before the installer starts, because a silent (`/S`) NSIS install force-shuts-down a running app through the Restart Manager (checked in the Tauri NSIS template). `--close` asks it to close (`taskkill /IM`, never `/F`), waits up to 20 seconds and refuses if it is still open. The script itself never kills anything: it refuses to start the installer while the app runs. The installer gets 10 minutes; after that the script fails with a message and leaves the installer alone.
- **Backups.** Before installing, the whole data folder is copied to `%LOCALAPPDATA%\burrow-release\data-backups\<channel>-<YYYYMMDD-HHMMSS>\` (first as `<name>.partial`, renamed only after the checks pass). The checks: the same files, the same sizes, the same sha256 for every file, and `PRAGMA integrity_check` on the copied `burrow.db` (the copy is opened read-only; the live database is never opened). Any mismatch or a result other than `ok` stops the script before the installer. The newest 10 backups per channel are kept; the backup just made is never pruned. Stop every other process that writes the data folder first (for example `npm start` without `BURROW_DATA_DIR` uses the real stable data); the plan reminds you. To roll back: close the app, rename the current data folder aside, then copy the backup folder in as a whole. Never copy it over the existing folder: a newer `-wal` or `-shm` file left there would be applied to the old database.
- **Check afterwards.** The installed exe's ProductVersion must equal the expected one (dev: the bundle version as the installed exe reports it, such as `0.2.0-dev.20261005+1008`, or the plain file version `0.2.0.1008`; stable: the installer's own PE version, and a stable `--from <path>` installer that reports a `-dev.` version is refused). For a dev build made by the same run, the installed exe must also be newer than the start of the run. Otherwise the script exits 1 and names the backup. A relative `--from <path>` is resolved against the folder you ran `npm run` in (`INIT_CWD`). Only the default per-user install folders are supported; a custom install folder is not detected and is not supported.

### Flaky tests

Run the **Flaky test hunt** workflow (Actions tab, manual). Inputs: number of runs (1 to 20, default 5), project (`all`, `frontend` or `backend`) and runner (`ubuntu-latest`, or `windows-latest` at 2x minutes). It repeats `npx vitest run`, writes a table of failing tests with counts to the run summary, and fails if any run failed.

### Dependabot

`.github/dependabot.yml` opens weekly update PRs for npm and GitHub Actions (at most 5 open each, commit prefix `chore(deps)`). npm dev dependencies are grouped, production minor and patch updates are grouped, and all action updates are grouped. Treat them like any other PR: CI must pass.

### Docker (internal)

Docker is an internal development and test setup, not offered for self-hosting and not the consumer path (the desktop app is). An image built while `pro/` exists contains the private module's server source, so it stays internal: never push it to any registry.

```powershell
$env:APP_PASSWORD = '<a password>'
$env:AUTH_SECRET = '<at least 32 random characters>'
docker compose up --build
```

The UI is published on `127.0.0.1:4390` only, so it never collides with 4321 or 5174 (set `BURROW_DOCKER_PORT` to change it). `APP_PASSWORD` and `AUTH_SECRET` are required because the container binds `0.0.0.0`. Data lives in the `burrow-data` volume.

To add a local Ollama container, use the overlay:

```powershell
docker compose -f compose.yaml -f compose.ollama.yaml up --build
docker compose -f compose.yaml -f compose.ollama.yaml exec ollama ollama pull qwen2.5:3b
```

The Ollama container publishes no host ports. Because it is not loopback from Burrow's point of view, the overlay sets `OLLAMA_HOST=http://ollama:11434` and pre-enables the `aiLan` opt-in.

### AI eval

`node pro/scripts/evalAi.js` checks Javi against a real local Ollama (there is no `npm run eval:ai` any more: the script lives in the Pro module, so it needs `pro/`). It is not part of `npm test` and never runs in CI. `npm run eval:javi` stays in core for the core paths. See [docs/EVALS.md](docs/EVALS.md).

### The Pro module (`pro/`, owner workflow)

The private module lives in `pro/`, a separate private git repo (remote `burrow-pro`) that sits inside the core checkout and is ignored by core. It is included at no cost in official builds. The boundary, the allowlist and the extension points are in [docs/OPEN_CORE.md](docs/OPEN_CORE.md). Contributors without access to `pro/` work in core-only mode and need nothing else.

- Clone it into the checkout: `git clone <burrow-pro remote URL> pro`, then `npm run check:pro-present` (exit 0 when it is complete). Commit its changes with `git -C pro ...` to the `burrow-pro` remote. Never commit anything under `pro/` to core (the pre-commit hook refuses it).
- New commands: `npm run check:pro-present`, and `npm run export:core -- --out <dir>` (owner only, see [docs/PUBLISHING_CORE.md](docs/PUBLISHING_CORE.md)). `npm test` runs core plus Pro suites when `pro/` exists; `npx vitest run pro/ui pro/server` runs only the Pro suites; `npm run test:e2e -- --project=pro-flows` runs the Pro end to end flows.
- Put code in core if the core uses it and in `pro/` if only the module uses it. The module may import core only through the allowlist in `scripts/build/proBoundary.js`, and core never imports `pro/` (the boundary test `server/__tests__/proBoundary.test.js` checks both).
- **Test in both modes** before you ask for review: run `npm test` with `pro/` present, then move `pro/` OUTSIDE the repo, run the core checks, and move it back. Never rename `pro/` inside the repo.

  ```powershell
  Move-Item pro "$env:TEMP\burrow-pro-aside"
  git status --porcelain          # must not list anything under pro
  npm test
  npm run build
  Move-Item "$env:TEMP\burrow-pro-aside" pro
  ```

  The full command lists are in [docs/adr/0001-work-split.md](docs/adr/0001-work-split.md) section 7. Official release paths refuse to build without `pro/` (see [docs/RELEASING.md](docs/RELEASING.md)).

### Contributions and the CLA

The Burrow core is published at [github.com/ChristianMunoz31/burrow-core](https://github.com/ChristianMunoz31/burrow-core) under AGPL-3.0-only. Contributions to it need a signed Contributor License Agreement (the text is in [docs/CLA.md](docs/CLA.md), a draft that needs the owner's legal review first). The CLA check is planned: once it is turned on, every pull request on the public repo will ask you to reply with a signature sentence once. It is not turned on yet. The private module does not take outside contributions.
