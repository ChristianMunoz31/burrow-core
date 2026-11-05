# Burrow desktop shell (Tauri v2)

A thin native shell. It starts the Burrow server as a sidecar, shows a local splash page while it boots, then points the window at `http://127.0.0.1:<port>`. All product code stays in `server/` and `src/`. End-user install steps are in [docs/INSTALL.md](../docs/INSTALL.md).

## Layout

- `src/` Rust: `lib.rs` (app wiring, window, supervision, single-instance and window-state plugins), `sidecar.rs` (env, spawn, ready line, Job Object, shutdown), `secret.rs` (secret, HMAC bootstrap token, update and dialog keys), `dialogs.rs` (native folder picker and save dialog on request of the server), `nav.rs` (navigation policy), `downloads.rs` (where exports are saved), `menu.rs` (File with Add a folder..., Edit, Help: Open data folder, Export my data, Report content..., Check for updates..., About), `exit_dialog.rs` (exit-code dialog copy), `updater.rs` (opt-in update request, URL pin, redirect allowlist, install flow).
- `splash/` the only frontend bundled in the shell: `index.html` ("Starting Burrow...") and `error.html` (shows the log path) and `updating.html` (shown while an update installs).
- `capabilities/default.json` empty permissions, `local: true`, no `remote` entry: the server UI gets no IPC.
- `installer/hooks.nsh` NSIS hooks: tells the user the data in `%APPDATA%\Burrow` is kept on update and uninstall.
- `installer/hooks.dev.nsh` the Burrow Dev version: refuses an install folder that belongs to Burrow or holds Burrow data, and names `%APPDATA%\Burrow Dev`.
- `tauri.release.conf.json` the updater overlay (committed, applied only by `scripts/release/buildInstaller.js`, see Updater).
- `tauri.dev.conf.json` the Burrow Dev overlay (see below). `tauri.dev.build.json` is generated from it for each Dev build and gitignored.
- `icons/` generated from `icons/source.svg`; `icons/dev/` is the same artwork with a DEV badge.
- `binaries/` and `resources/` are build output (gitignored), produced by `npm run desktop:sidecar`.

## Commands (repo root)

```powershell
npm run desktop:sidecar   # esbuild + Node SEA -> src-tauri/binaries/burrow-server-<triple>[.exe], plus resources/dist and resources/migrations
npm run desktop:dev       # tauri dev, runs `node server.js`, temp data dir
npm run desktop:build     # npm run build -> sidecar -> tauri build (NSIS in src-tauri/target/release/bundle/nsis/)
npm run desktop:icons     # tauri icon src-tauri/icons/source.svg
```

`cargo test` and `cargo clippy` (run in `src-tauri`) need the sidecar and `resources/` to exist, because `tauri-build` checks for them even for `cargo check`. Run `npm run build` and `npm run desktop:sidecar` first. CI (`desktop-check.yml`) uses empty stand-ins instead.

### Sidecar build flags

`node scripts/desktop/buildSidecar.js [flags]` (`npm run desktop:sidecar` passes `--minify`):

- `--minify` minify the esbuild bundle.
- `--bundle-only` stop after the esbuild bundle (`.sidecar-build/server.cjs`); no SEA, no copy.
- `--no-copy` build the SEA exe in `.sidecar-build/` but do not copy anything into `src-tauri/`.
- `--target <triple>` must equal the host triple, otherwise it fails with an explanation.
- `--node-binary <path>` inject the SEA blob into another `node` binary instead of the running one. CI uses this for the macOS x64 half of a universal build.
- `--out-triple <name>` name the copied file `burrow-server-<name>` instead of using the host triple (for example `x86_64-apple-darwin`).
- `--channel <stable|dev>` (default: env `BURROW_CHANNEL`, else stable). A dev build is copied as `burrow-dev-server-<triple>[.exe]` and needs `--display-version`. Every copied executable is scanned for its `/*! BURROW_CHANNEL=<channel> */` marker before the script ends.

`desktop:build` and the sidecar only support the host target triple: the sidecar embeds a local `node` binary. For another target, build natively on that platform. `release.yml` runs one runner per OS. Passing `-- --target <other>` to `desktop:build` fails with an explanation.

### Burrow Dev

`tauri.dev.conf.json` is a config overlay for the side-by-side test build (`npm run desktop:build:dev`, which merges it with the Dev bundle version into `tauri.dev.build.json` and runs `tauri build --config`). It changes `productName` (`Burrow Dev`), `mainBinaryName` (`BurrowDev`), `identifier` (`com.burrow.desktop.dev`), the icons (`icons/dev/*`) and the NSIS hooks (`installer/hooks.dev.nsh`). `tauri.conf.json` stays the stable config, so `cargo` builds, `desktop-check.yml` and `desktop:build` are stable.

- **Channel.** The shell reads its channel at runtime from `app.config().identifier` (`src/channel.rs`): `com.burrow.desktop.dev` is Dev, anything else is stable. Dev changes the window title and Help > About (`Burrow Dev`, with the display version from `BURROW_DISPLAY_VERSION` at build time via `option_env!`; stable always shows the package version) and the default data folder name (`Burrow Dev` on Windows and macOS, `burrow-dev` on Linux). The server's channel comes from the bundle, not from the shell.
- **Separate state.** The identifier gives Dev its own single-instance lock, WebView2 profile, window-state file and log folder, so Burrow and Burrow Dev run at the same time without sharing anything.
- **Log paths (Dev).** `server.log` is in `%LOCALAPPDATA%\com.burrow.desktop.dev\logs` (Windows), `~/Library/Logs/com.burrow.desktop.dev` (macOS) or `~/.local/share/com.burrow.desktop.dev/logs` (Linux).
- **Sidecar binary.** Dev launches `burrow-dev-server` (overlay `externalBin`), stable launches `burrow-server`, so both can install into one folder (Linux packages) without sharing a file. `resolve_launch` picks the name from the channel.
- **Isolation checks.** `build_sidecar_env` always sets `BURROW_SHELL_CHANNEL` (`stable` or `dev`) and the server refuses to start on a mismatch. The ready line must carry the same `channel` (a missing or different one stops the server and shows the error page). The Dev shell also refuses a `BURROW_DESKTOP_DATA_DIR` (or reported data folder) that equals, contains or lies inside the default stable data folder or `BURROW_DESKTOP_STABLE_DATA_DIR`, compared by real location, before it starts the server.
- **Installer guard.** `installer/hooks.dev.nsh` normalizes the install folder (full path, no trailing backslash) and refuses a folder that equals, lies inside or contains `%APPDATA%\Burrow`, `%LOCALAPPDATA%\Burrow`, `%APPDATA%\Burrow Dev` or the install folder Burrow recorded (`HKCU\Software\Burrow\Burrow` and the `InstallLocation` of `Uninstall\Burrow`).
- **Copy source override.** In the Dev shell only, a non-empty `BURROW_DESKTOP_STABLE_DATA_DIR` is passed to the sidecar as `BURROW_STABLE_DATA_DIR` (and a line is logged). The stable shell never forwards it, and a raw `BURROW_STABLE_DATA_DIR` in the user's shell is always dropped. Set it per shell only, to a throwaway folder, when testing "Copy my data from Burrow".
- **Icons.** `npm run desktop:icons` regenerates `icons/*` from `icons/source.svg` and `icons/dev/*` from a generated `icons/dev/source.svg` (the same artwork plus a DEV badge drawn with shapes, no text). Both folders keep only the icon files the bundle uses.

Always run the app with `BURROW_DESKTOP_DATA_DIR` pointing at a temp dir while developing (`desktop:dev` does this). Without it the server uses the real Burrow data folder. Set it per shell only, never as a persistent user variable: release builds honour it too (so an installed build can be tested safely) and log a line to `server.log` when it is active. The Tauri identifier is `com.burrow.desktop` on purpose so the Tauri app-data folder never coincides with the Burrow data folder.

## Sidecar protocol

1. The shell runs `burrow-server` (next to the app executable) with an empty environment plus only: `SystemRoot`, `TEMP`, `TMP`, `APPDATA`, `LOCALAPPDATA`, `USERPROFILE`, `HOME`, `XDG_DATA_HOME` (each if set), `PATH` (`%SystemRoot%\System32` on Windows, `/usr/bin:/bin` elsewhere; never the developer's `PATH`), `BURROW_DESKTOP=1`, `BURROW_HOST=127.0.0.1`, `BURROW_PORT=0`, `BURROW_NO_DOTENV=1`, `BURROW_SHELL_CHANNEL`, `BURROW_DIST_DIR`, `BURROW_MIGRATIONS_DIR`, `BURROW_SHELL_UPDATER=1` only when the stable shell has the updater enabled (see Updater), `BURROW_SHELL_DIALOGS=1` always (see Dialogs), and `BURROW_DATA_DIR` only when the shell itself has `BURROW_DESKTOP_DATA_DIR`.
2. It writes 32 random bytes as 64 lowercase hex plus a newline to the child's stdin and keeps stdin open. Closing stdin (app exit) is the graceful shutdown signal; the shell waits 5 s, then kills. On Windows the child is also in a Job Object with kill-on-close, so a crash of the app never leaves a server behind.
3. The child prints `BURROW_READY {"port":N,"dataDir":"...","version":"...","channel":"stable|dev","distribution":"direct|store","dataLocation":"appdata|userprofile","commit":"<short sha>"|null}` (`commit` is a string or null); the shell refuses a line whose channel, distribution or data location is not its own. The shell waits up to 60 s, then navigates to `http://127.0.0.1:N/desktop/bootstrap?token=<hex(HMAC-SHA256(secret, "burrow-bootstrap-v1"))>`; the server sets an HttpOnly cookie and redirects to `/`. If the child exits or the wait times out, the window shows `splash/error.html`. If the server stops later, the window also shows the error page.
   - **Exit codes.** The shell captures the exit code and the last 40 stderr lines and shows a native dialog (`exit_dialog.rs`, `tauri-plugin-dialog`; the dialog is opened from Rust, so no IPC permission is granted). Exit code `3` (`EXIT_RESTORE_RECOVERY`, startup recovery of an interrupted backup restore failed) shows "Burrow could not finish restoring" naming the folders parsed from the server's message (fallback: `<data dir>/restore-aside` and `<data dir>/backups`) with the buttons Open data folder, Copy details (full server message plus the log path, via `tauri-plugin-clipboard-manager`) and Quit. Open and Copy re-show the dialog; Quit or closing it exits the app. Any other exit (before ready or later) shows "Burrow stopped unexpectedly" with the exit code, the log path and Open log folder / Quit (the server's stderr is not copied into these details; it is in the log). No dialog is shown when the app is already quitting (a Quit during the splash, window close, logoff or shutdown), when the server ends with code 0, or with Windows status `0xC000013A` (`STATUS_CONTROL_C_EXIT`, a session end); the shell then only logs a `[shell]` line (and shows the error page unless it is quitting). Open data folder tries the folder parsed from the server's message, then the shell's own data folder, then the log folder (each must be an absolute, non-UNC, existing directory; falling back is logged). The parsed message is only trusted when it is the final message in the stderr tail, the aside file sits in `restore-aside` under the data folder, and the data folder equals the shell's own when it is known. The shell never deletes or moves a file. To see the code 3 dialog safely, point `BURROW_DESKTOP_DATA_DIR` (this shell only, a temp dir) at a folder holding only a `restore-journal.json` (for example `{"phase":"swapping","safetyId":"x"}`) and run the debug exe from `src-tauri/target/debug` with `BURROW_DEV_NODE` and `BURROW_DEV_ENTRY` set; the server finds neither the old nor the new database and exits 3.
4. The child may also print `BURROW_UPDATE_REQUEST {...}` to ask for an opt-in update. It is authenticated with an HMAC and handled as described under Updater; any other use is ignored. It may print `BURROW_DIALOG_REQUEST {...}` to ask for a native dialog (folder picker or save dialog), authenticated and answered on its stdin as described under Dialogs.
5. stdout and stderr are written to `server.log` in the app log dir, truncated at each launch:
   - Windows: `%LOCALAPPDATA%\com.burrow.desktop\logs\server.log` (Store build with the userprofile data location: `%USERPROFILE%\Burrow Data\logs\server.log`)
   - macOS: `~/Library/Logs/com.burrow.desktop/server.log`
   - Linux: `~/.local/share/com.burrow.desktop/logs/server.log`

Debug builds only: with `BURROW_DEV_NODE` and `BURROW_DEV_ENTRY` set, the shell runs `node server.js` from the repo instead of the sidecar (`npm run desktop:dev` sets both).

## Security model

- **No IPC for the server UI.** The window loads remote (loopback) content. The capability file has no `remote` entry, so that page cannot call Tauri commands. The shell's own CSP only covers the splash pages.
- **Per-launch gate.** The server (`server/desktop/auth.js`) refuses every request without the `burrow_desktop` cookie. The cookie is only issued for one use of the bootstrap token, which is derived from a secret that exists only in the shell and the server process (passed over stdin, never over HTTP, never logged). Another local program that finds the port gets `401`. `APP_PASSWORD` and `AUTH_SECRET` are ignored in desktop mode.
- **Server hardening.** Loopback bind only, a CSP plus `X-Frame-Options`, `Referrer-Policy` and `nosniff` on every response (`server/desktop/csp.js`), cross-site and foreign-origin writes refused.
- **Minimal environment.** The sidecar only sees the allowlist above, so `NODE_OPTIONS`, `OLLAMA_HOST`, tokens and `BURROW_DATA_DIR` from the user's shell are dropped.
- **Navigation policy** (`nav.rs`). Only the splash pages and `http://127.0.0.1:<port>` load in the window. Web links and `mailto:` open in the default app. A `mailto:` link sends nothing from Burrow (like Help > Report content, Store policy 11.16): it only opens a draft in the user's mail app. Other loopback ports and hosts, `file:`, `data:`, `javascript:` and the rest are dropped. New windows are never opened.
- **Downloads** (`downloads.rs`). Only downloads that start from the Burrow origin are allowed. The file name is cleaned, the file goes to the Downloads folder without overwriting (`name (1).zip`), and the folder is then revealed.
- **Single instance.** A second launch focuses the existing window.
- **Unsigned builds.** See docs/PRODUCT.md open decision 2.

## Swapping the icon

`icons/source.svg` is a placeholder (the favicon) pending owner approval of final artwork. Replace it (square, ideally a 1024 px SVG or PNG) and run `npm run desktop:icons`, then delete the mobile and store extras it generates (`android/`, `ios/`, `Square*.png`, `StoreLogo.png`, `64x64.png`); the bundle only uses `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.icns`, `icon.ico` and `icon.png`.

## Updater (opt-in, stable channel only)

In-app updates are dormant until the owner pastes a real public key into `tauri.release.conf.json` (see docs/RELEASING.md "Updater signing key"). Until then the shell behaves exactly as before and the server only shows its notice.

### Microsoft Store build

The Microsoft Store (MSIX) build is the same shell compiled with `BURROW_DISTRIBUTION=store` (`build.rs` turns it into a compile-time constant; unset or empty is `direct`, and any value other than exactly `direct` or `store` stops the build). `updater::should_enable` returns false for it whatever the config holds, so the plugin is never registered and `BURROW_SHELL_UPDATER` is never set; the sidecar bundle is built with the same distribution baked in, prints it in the ready line and `/api/app/info`, and the shell refuses a ready line whose distribution is not its own. `scripts/release/buildStore.mjs` compiles it with `tauri build --no-bundle` and never applies the release overlay. The layout inside the package is the NSIS install folder: `Burrow.exe`, `burrow-server.exe`, `resources/dist`, `resources/migrations`. See docs/MICROSOFT_STORE.md.

**Data folder ownership (userprofile location).** `data_guard.rs` runs in `setup` before the log file is created and before the server is spawned, only for the Store build with the `userprofile` data location on Windows and no `BURROW_DESKTOP_DATA_DIR` override: a missing `%USERPROFILE%\Burrow Data` is created with `.burrow-data.json`, a marked one is used, an empty one is adopted, and anything else (any entry without a valid marker, a corrupt marker, a file, a symbolic link, junction or reparse point) is refused with nothing written. The shell then does not start the server, writes its log to the default log folder, and shows the `exit_dialog.rs` dialog for exit code `5` (`EXIT_DATA_DIR_NOT_OURS`: Open folder, Copy details, Quit); the server applies the same rule (`server/dataFolderOwnership.js`) and exits `5` itself if it is started against such a folder.

**Data location.** The Store build also has a compile-time data location (`BURROW_DATA_LOCATION`, `build.rs` turns it into `BURROW_BUILD_DATA_LOCATION`; `appdata` is the default, `userprofile` is accepted only together with `BURROW_DISTRIBUTION=store`, and any other value stops the build). It exists for the case where Partner Center refuses `rescap:unvirtualizedResources`: the package is then built without that capability and without `desktop6:FileSystemWriteVirtualization`, MSIX virtualizes new files under AppData into the package's `LocalCache` (deleted on uninstall), and the app keeps its data in `%USERPROFILE%\Burrow Data`, which MSIX does not virtualize. `channel.rs` `DataLocation::uses_user_profile` (userprofile marker, Store distribution, stable channel, Windows) and `exit_dialog.rs` `platform_data_dir` are the one place that resolves the folder in the shell, mirroring `resolveDataDir` in `server/paths.js`; Burrow Dev never moves. `stable_default_data_dirs` lists both stable folders for the Dev isolation check. The ready line carries `dataLocation` and the shell refuses one that is not its own (an absent field means `appdata`). The exe contains `burrow-data-location=<value>` (logged at start next to `burrow-distribution=`), which `buildInstaller.js` and `buildStore.mjs` check. In the userprofile location `server.log` is written to `<data folder>\logs\server.log` (a new file under `%LOCALAPPDATA%` would be virtualized and deleted on uninstall). WebView2's user data folder (`%LOCALAPPDATA%\com.burrow.desktop\EBWebView`) and the window-state file stay where they are and are virtualized into `LocalCache`: they are caches, not data (losing them forgets only the window size and cached web data; settings live in the database), and moving them would need Tauri/WebView2 environment overrides for no benefit.

### Release overlay rule

`tauri.release.conf.json` is committed but is applied ONLY by `scripts/release/buildInstaller.js` (`tauri build --no-bundle --config src-tauri/tauri.release.conf.json` with no signing variable, then `tauri bundle --bundles nsis --config ...` with the key; CI runs the two as separate steps and only the second has the secrets), and only when its `plugins.updater.pubkey` is not `BURROW_UPDATER_PUBKEY_PLACEHOLDER` and decodes to a valid minisign public key (base64 text whose second line base64-decodes to 42 bytes starting with `Ed`). `scripts/desktop/build.js` refuses `--config`, `buildDev.js` merges only `tauri.dev.conf.json`, and `tauri.conf.json` has no `plugins.updater`, so normal builds and Burrow Dev never contain the updater config. `server/__tests__/updaterConfig.test.js` pins all of this. The overlay sets `bundle.createUpdaterArtifacts` (needs `TAURI_SIGNING_PRIVATE_KEY` and its password at bundle time), `windows.installMode: passive` and `requireSignedVersion: true`: the Tauri CLI writes `version:<app version>` into the signed trusted comment of every `.sig`, and the updater plugin refuses an update whose `latest.json` version differs from it, so a tampered `latest.json` cannot pair a newer version number with an older signed installer (downgrade guard). `buildInstaller.js`, `publishPublic.js` and `release:local` check the same thing before anything is published.

### Request line (server to shell)

```
BURROW_UPDATE_REQUEST {"v":1,"version":"0.5.0","nonce":"<32 lowercase hex>","mac":"<64 lowercase hex>"}
```

- `updateKey = HMAC-SHA256(secret, "burrow-update-key-v1")`; `mac = hex(HMAC-SHA256(updateKey, "burrow-update-v1\n" + version + "\n" + nonce))`. The shell derives `updateKey` when it creates the secret and keeps only that key.
- Accepted only when: the line starts with exactly `BURROW_UPDATE_REQUEST `; the payload is a JSON object with exactly the four keys; `v` is 1; `version` is strict `x.y.z` (no prerelease, no leading zeros); `nonce` and `mac` are lowercase hex of the right length; the MAC verifies in constant time; the nonce was not seen this launch; the channel is stable; the updater is enabled; no update is in flight. Anything else is logged as `[shell] ignored an update request (<reason>)` with no dialog. Nonces are recorded only after the MAC verifies.
- Test vector (secret = bytes 0..31, nonce `00112233445566778899aabbccddeeff`, version `1.2.3`): `updateKey` `d7a04009cce2a159b133fea3d6c6675258b1ad63e514b5dc6a78f8bf47dc681b`, `mac` `131a3fcae49bf067678e9c40618722760ecf5b9b32a68568b4ef2eada010a9a2`. The server tests pin the same literal.

### Flow and security model

1. Check with the plugin, using only its own baked endpoint and public key. The shell HTTP client allows redirects only to https `github.com`, `release-assets.githubusercontent.com` and `objects.githubusercontent.com` (no userinfo, no port), at most 5 hops (H3).
2. The announced version must equal the requested one, and the download URL must equal exactly `https://github.com/ChristianMunoz31/burrow-releases/releases/download/v{version}/Burrow-Setup-{x64|arm64}.exe` for this machine's architecture (H2).
3. Download (15 minute limit) and verify the minisign signature BEFORE anything is stopped (H4). A failure here shows a native dialog and reloads Settings > Updates; the in-flight flag is cleared.
4. Navigate the window to `splash/updating.html` (H5), mark the app as shutting down (no crash dialog), stop the sidecar gracefully (stdin closed, 5 s grace, WAL checkpoint), then `install()`. On Windows `install()` starts the passive NSIS installer and exits at once; the installer relaunches Burrow. If the installer cannot start, the shell shows a dialog and quits (the sidecar is already down; the user reopens Burrow).
5. `BURROW_SHELL_UPDATER=1` is put in the sidecar env only when the updater is enabled and the channel is stable (H6); an inherited value is dropped. The Dev channel never registers the plugin and ignores request lines.

The remote origin still has no IPC: the only input is one authenticated, typed, single-use line from the child process the shell spawned. A compromised server can at most ask for the newest signed stable release.

The plugin is built with `native-tls` (Windows SChannel) instead of its default rustls plus `ring`, because `ring` needs `clang` to compile for ARM64 Windows. `reqwest` is a direct dependency pinned to the minor version the plugin resolves (0.13), only to name `reqwest::redirect::Policy` in `configure_client`; bump both together.

## Dialogs (folder picker and save dialog)

The Folders page adds a folder, and exports a folder report, through native operating system windows. The window is opened by this shell from Rust (the plugin is called from Rust, so the capability file still grants no IPC to the remote origin). The server only asks, and never writes where the user chose.

`BURROW_SHELL_DIALOGS=1` is always put in the sidecar env (every channel and distribution, never a passthrough: a value in the shell's own environment is ignored). It tells the server that this shell can do the following; without it the Folders page keeps the pasted path and the download.

### Wire format

Server to shell, one stdout line (written in a single call). Request lines are never written to `server.log` in full (`[out] BURROW_DIALOG_REQUEST (details not logged)`):

```
BURROW_DIALOG_REQUEST {"v":1,"kind":"pick_folder","id":"<32 hex>","ttl":900,"name":"","ext":"","bytes":0,"mac":"<64 hex>"}
BURROW_DIALOG_REQUEST {"v":1,"kind":"save_file","id":"<32 hex>","ttl":900,"name":"burrow-folder-notes-2026-10-08.md","ext":"md","bytes":1234,"mac":"<64 hex>"}
```

Shell to server, one stdin line (queued to a writer thread by `Sidecar::send_line`, so a dialog never blocks on the pipe; a line may not contain a line break and is at most 16384 bytes). Only `picked` carries a path; replies never log a path:

```
BURROW_DIALOG_REPLY {"v":1,"id":"<32 hex>","status":"<status>","path":"<string>","mac":"<64 hex>"}
```

- `status` for a pick: `picked | cancelled | unusable | busy | expired | failed`. For a save: `saved | cancelled | exists | too_large | fetch_failed | write_failed | busy | expired`.
- `dialogKey = HMAC-SHA256(secret, "burrow-dialog-key-v1")` (a different label from the update key). The shell keeps only this key. Request MAC: `hex(HMAC(dialogKey, "burrow-dialog-request-v1\n" + kind + "\n" + id + "\n" + ttl + "\n" + name + "\n" + ext + "\n" + bytes))`. Reply MAC: `hex(HMAC(dialogKey, "burrow-dialog-reply-v1\n" + id + "\n" + status + "\n" + path))`. Fetch proof: `hex(HMAC(dialogKey, "burrow-dialog-fetch-v1\n" + id))`. Commit proof: `hex(HMAC(dialogKey, "burrow-dialog-commit-v1\n" + id))`. Numbers are decimal ASCII, every value UTF-8.
- Test vectors (secret = bytes 0..31, id `00112233445566778899aabbccddeeff`): `dialogKey` `0a89a8b731cd49c6037f32cd1ea9fdc74fb725f8cb6635954b2c2c0882fcf179`; pick request MAC (ttl 900) `b2b40e2bcc003dc7f7a1e9f04ded223ce1631109d2b2fcb4e14b6d119e9fcdda`; save request MAC (`burrow-folder-notes-2026-10-08.md`, `md`, 1234) `9102e87ea551fe60e7fba7ba87699f8840c6c4f315273ce3b81d966b5fc0e6fe`; fetch proof `6f7ae1594d6797f221d09f7b162cd2757c3df427eb6e51b6556fd9737d297890`; commit proof `f4426519f75890ec096639824f36726b528c14b057fa019a7a2e11560b94a6cf`. The reply vectors are in `dialogs.rs`. `server/__tests__/desktopDialogAuth.test.js` and `server/__tests__/foldersRound2Fixes.test.js` pin the same literals.

### Rules

- A request is accepted only when the line starts with exactly `BURROW_DIALOG_REQUEST `, the payload is at most 1024 bytes of JSON with exactly the eight keys (no U+FFFD), `v` is 1, `id` is 32 and `mac` 64 lowercase hex, `ttl` is 60 to 3600, a pick has an empty `name` and `ext` and `bytes` 0, a save has `ext` `md|json|csv`, a `name` that sanitizing leaves unchanged (at most 200 characters, ending in `.` + `ext`) and `bytes` from 1 to 32 MiB, and the MAC verifies in constant time. An unauthentic request is logged and ignored with no reply.
- Each id is single use (the set of used ids only holds authenticated requests). Only one dialog is open at a time: an authentic request that arrives meanwhile is answered `busy`. The shell measures `ttl` from the moment it received the line; a window that closes later gets `expired` and no path.
- The window opens on its own thread (never the main thread or the thread that reads the server's output). Closing it is `cancelled`. A picked path must be valid Unicode, a Windows verbatim disk prefix (`\\?\C:\`) is shortened, it must be 1 to 1024 UTF-16 units, free of control characters and absolute; anything else is `unusable`. Other checks (links, protected folders, caps, overlap) are the server's `validateFolderRoot`.
- A save first fetches the bytes with `GET http://127.0.0.1:<port>/desktop/dialog-file/<id>` and the header `X-Burrow-Dialog-Proof` (no cookie, no proxy, no redirects, 30 s). The status must be 200, `Content-Length` (if sent) and the received total must equal `bytes`, and reading stops as soon as it goes over. The server serves the bytes once. Any failure is `fetch_failed`.
- The commit check comes after the save window and the target is resolved, right before the write: `GET http://127.0.0.1:<port>/desktop/dialog-file/<id>/ok` with the header `X-Burrow-Dialog-Proof` set to the commit proof (no cookie, no proxy, no redirects, 30 s). Only a `204` allows the write; the server answers it once, after the fetch, while the request is still waiting and unexpired, and every other case (cancelled, expired, reset, unknown, wrong proof, second ask) is the same uniform `404`. Anything but `204`, or a transport error, writes nothing and the reply is `cancelled`.
- The save window comes after the fetch. A chosen name that already ends in the extension is used as it is (the OS dialog confirmed any overwrite). Otherwise the extension is appended, and an existing file at that name is never overwritten (`exists`). The write goes to a new temp file in the same folder (`.burrow-save-<16 hex>.tmp`), is synced and renamed over the target, and the temp file is removed on any error (`write_failed`). When Burrow appended the extension, the rename is no-replace (`MoveFileExW` without `MOVEFILE_REPLACE_EXISTING` on Windows through the existing `windows-sys` dependency; a hard link and unlink elsewhere), and `AlreadyExists` is the reply `exists`, so a file that appeared after the existence check is never overwritten.
- The log holds only `folder dialog: <kind> <status>`. No path or file name is logged, and the shell shows no native error dialog (the page shows the result).
- File > Add a folder... only navigates the window to `/folders#add-folder`; the page then starts the normal flow, so the shell never sends anything the server did not ask for.
