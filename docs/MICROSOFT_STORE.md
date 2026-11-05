# Microsoft Store (MSIX) distribution

Plan and owner checklist for publishing Burrow in the Microsoft Store as an MSIX package. Read [PRODUCT.md](PRODUCT.md) first (store copy rules, pricing, privacy promises) and [LICENSING.md](LICENSING.md) for how Pro keys work.

Status: written 2026-10-08, owner decisions recorded 2026-10-08. Only Windows is tested. The build script (`npm run release:store`) and the owner config file `config/msstore.json` exist and are documented below. Submission 1 (`Burrow_1.0.0.msixbundle`, package version 1.0.0 plus `.0`) was uploaded and **failed certification on 2026-10-13 (policy 10.6.3 Capabilities: `unvirtualizedResources` requested and denied)**. Decided 2026-10-15: the Store edition ships with the `userprofile` data location (`config/msstore.json` `"dataLocation": "userprofile"`), see "If Partner Center refuses unvirtualizedResources". The resubmission is the 1.4.0 package built from main with that config. No package has been installed from the Store yet.

Items marked `TODO(owner)` need a decision or a value only the owner has.

## Before the first upload: blocking decisions

Do not submit the first package until items 2, 4 and 5 below are settled (items 1 and 3 are decided). They are not formatting questions: each one can cost a paying customer their Pro features or their data, or block certification.

1. **Decided (2026-10-08): Pro after the update window in the Store build is kept per feature.**
   Rule: *Standard buyers always have Pro, just not the version a year after purchase.* A Store build cannot be downgraded and auto-updates without the direct edition's update notice (`licenseImpactFor` in `server/updateCheck.js`), so a build-date cutoff alone would silently switch every Pro feature off after the update window. Instead, when `distribution === 'store'` and a perpetual license (Standard, Founding, Family: no `expiresAt`) has `buildDate > updatesUntil`, Pro stays on for every Pro feature whose `introducedAt` (the build date of the first release that shipped it, `server/license/proFeatureDates.js`) is on or before `updatesUntil`. Features released later, and reserved ones with no date, answer `403 pro_required` with reason `newer_license_required` and the copy "This feature came out after your license's updates ended. It is included in a newer Burrow Pro license.", and Settings > License lists what the license still includes with the Buy button. The Javi panel passes the feature id `javi_tools` to `isKnownFree`, so a typed question on such a license shows the same newer-license notice. Trials, yearly Student and Nonprofit licenses, the clock guard, free features, bug fixes and all of the direct edition are unchanged. Full rule, editions and examples: [LICENSING.md](LICENSING.md) section 6.1.

2. **No upload until an elevated sideload test proves the data stays in the real folder.**
   The Store build relies on `unvirtualizedResources` and `desktop6:FileSystemWriteVirtualization` set to `disabled` so that it writes the real `%APPDATA%\Burrow` (section 4). That is true by manifest and code only; it has never been run on an installed package. `scripts/store/sideload-test.ps1` runs the whole test in an elevated PowerShell (see "Local sideload test"): install the test package, start Burrow, confirm the new files are in `%APPDATA%\Burrow` and not in the package's `LocalCache`, uninstall, and confirm the data and the backups survived.

   If Partner Center refuses `unvirtualizedResources`, follow "If Partner Center refuses unvirtualizedResources" (section 2): build with the `userprofile` data location and run the same sideload test with `-DataLocation userprofile`. Never remove the capability to pass certification without that fallback: without it the data would be virtualized into the package folder and deleted on uninstall.

3. **Decided (2026-10-08): the Store package version equals the app version, `X.Y.Z.0`, and the first Store release was Burrow 1.0.0 on every channel.**
   The old `(major+1).minor.patch.0` mapping is gone. Microsoft: the first section of a package version cannot be 0, so `release:store` refuses a 0.x app version (a `--local-test` build may still use one, for sideload testing only). Burrow 1.0.0 was released on Gumroad, the direct download and the Store; the release-please step it used is recorded in [RELEASING.md](RELEASING.md) ("Releasing 1.0.0 with Release-As", history). See "Package version".

4. **Windows 10 support is kept (decided 2026-10-08), with a certification RISK that is open.**
   `MinVersion` is `10.0.18362.0` (Windows 10 version 1903), the first Windows 10 release that has `desktop6:FileSystemWriteVirtualization` ("Minimum OS Version: Windows 10 version 1903 (Build 18362)", https://learn.microsoft.com/en-us/uwp/schemas/appxpackage/uapmanifestschema/element-desktop6-filesystemwritevirtualization) and `unvirtualizedResources` ("introduced in Windows 10, version 1903 (10.0; Build 18362)", https://learn.microsoft.com/en-us/windows/msix/desktop/flexible-virtualization). The listing says: "Windows 10 requires Microsoft Edge WebView2, preinstalled on most PCs."

   **This happened (2026-10-13): submission 1 failed policy 10.6.3, `unvirtualizedResources` denied. The fallback below is now the shipped configuration (2026-10-15).** The same Microsoft schema page says `desktop6:FileSystemWriteVirtualization` "is currently intended to be used only by certain types of desktop PC games that are published by Microsoft and our partners." Partner Center may therefore refuse `unvirtualizedResources` for Burrow. If it does, the fallback is implemented and documented in "If Partner Center refuses unvirtualizedResources" (section 2): `npm run release:store -- --data-location userprofile` (or `"dataLocation": "userprofile"` in `config/msstore.json`) builds a package without `unvirtualizedResources` and without `desktop6:FileSystemWriteVirtualization`, and the app keeps its data in `%USERPROFILE%\Burrow Data`. MSIX does not virtualize other `%USERPROFILE%` locations (flexible-virtualization page: "Apart from AppData, the app can write to any location where the user has write access, including other parts of %userprofile%"). Documents is not used, because OneDrive folder backup can sync a live SQLite file. The two editions then no longer share a data folder; the Store build offers a user-clicked "Import from your existing Burrow" instead. Neither kind of package has been installed yet (the sideload test needs an administrator). Never remove the capability just to pass certification without that fallback in place.

5. **Privacy policy page: done (live 2026-10-08)** at https://christianmunoz31.github.io/burrow-releases/privacy/ (see "Privacy policy hosting"). Screenshots are generated locally (see `docs/store/chrome-prompts.md`).

Also keep in mind (not blockers for the build, but know them before you publish):

- **Version skew.** In the default `appdata` data location the Store and direct editions share one data folder and one `burrow.db` (in the `userprofile` data location they do not: the Store build has its own database and an import copies the direct one, so this risk does not apply). A newer Store build migrates that database forward (migrations are forward-only, with a pre-migration `.bak`). The code makes an older build refuse a newer schema (`db_too_new` in `server/db/migrate.js`), but an installed older direct build refusing a schema migrated by a newer Store build, and what the user sees, has not been tested. Test pending.
- **Store updates can close a running app.** A Store update may close Burrow while it runs, so the pre-update backup that the direct edition's in-app update makes does not happen. The database is in WAL mode and every migration writes a pre-migration `.bak` first, which is what covers this case.

## 1. Why MSIX

- The Store re-signs MSIX packages with a Microsoft certificate. There is no paid code-signing certificate to buy ($0), which fits the $0 marginal cost rule in PRODUCT.md.
- Store installs are trusted by Windows. SmartScreen prompts on Store installs are not expected, but Microsoft does not state this explicitly.
- The alternative is an EXE or MSI submission. Policy 10.2.9 requires every binary to be signed by a certificate chaining to a Microsoft Trusted Root Program CA, and the installer must be self-hosted at a versioned HTTPS URL. Azure Artifact Signing costs about $9.99 per month (this is open decision 2 in PRODUCT.md). MSIX avoids that cost.
- Direct NSIS downloads from `burrow-releases` stay unsigned and unchanged (see [INSTALL.md](INSTALL.md) and [RELEASING.md](RELEASING.md)). The Store edition is an extra channel, not a replacement.

## 2. Owner checklist

Do these in order.

- [x] **Register a Partner Center developer account** (done; account decision made 2026-10-08). Account type: **Individual developer account**, Seller ID `96499430`, publisher display name **"Neural Foundry"** (a display name, not a registered company: no "Inc." or "LLC" anywhere). For reference: registration is free for both account types. Individual accounts are for distribution "not in relation to their business, trade, or profession", and policy 10.14 requires a Company account for anyone acting in relation to their trade or profession; an Individual account cannot be converted to Company later. Keep the 10.14 and 10.8.3 rows in section 3 in mind. **Switch to a Company account (DBA plus a free D-U-N-S number) only if revenue grows or a certification reviewer cites policy 10.14.**
- [x] **Reserve the name** (done 2026-10-08, Apps and games > New product > MSIX or PWA app, status In draft). Reserved name: **"Burrow: Private Life Organizer"**. The manifest `DisplayName` must equal it exactly; the in-app branding stays "Burrow".
- [x] **Package identity copied into the owner config file** `config/msstore.json` (from Product management > Product identity). None of these values are secrets.

  | Field | Value |
  | --- | --- |
  | `Package/Identity/Name` | `NeuralFoundry.BurrowPrivateLifeOrganizer` |
  | `Package/Identity/Publisher` | `CN=ED5E4A2A-3217-4F54-A392-3EAD302CF036` |
  | `Package/Properties/PublisherDisplayName` | `Neural Foundry` |
  | `Package/Properties/DisplayName` | `Burrow: Private Life Organizer` |
  | Package family name (PFN) | `NeuralFoundry.BurrowPrivateLifeOrganizer_mgg9wnr6rtg28` |
  | Store ID | `9NT29CNPKBK4` |
  | Store URL | https://apps.microsoft.com/detail/9NT29CNPKBK4 |
  | Store protocol link | `ms-windows-store://pdp/?productid=9NT29CNPKBK4` |

  The Store page goes live only after the first submission passes certification.
- [ ] **Settle the blocking items** in "Before the first upload: blocking decisions" above (the Pro lapse rule, the 1.0.0 versioning and Windows 10 support are decided; the elevated sideload data-folder test and the `unvirtualizedResources` certification risk are still open).
- [ ] **Build the bundle** (Burrow 1.0.0 is released; the upload build refuses a 0.x app version). See "Build commands" below. The upload file is `Burrow_<version>.msixbundle` (unsigned; the Store signs it).
- [ ] **Local sideload test (required before the first upload, blocking item 2).** See "Local sideload test" below. It installs a self-signed test build with the real identity, so uninstall it before you ever install from the Store.
- [ ] **Run the Windows App Certification Kit (WACK)** on the bundle. Expect the S Mode blocked-executables check to flag Tauri (https://github.com/tauri-apps/tauri/issues/14935). Do not claim S Mode support anywhere in the listing.
- [ ] **Submit.** Partner Center shows these submission sections, all currently **Not started**. Fill each one and use the draft copy listed here.

  | Partner Center section | What to enter | Draft copy |
  | --- | --- | --- |
  | **Pricing and availability** | Price Free, all markets. Declare third-party in-app purchases if the UI offers it (Pro is sold through Gumroad, policy 10.8.1 and 10.8.2). | The "Price:" paragraph of the full description in section 5, and the policy rows in section 3. |
  | **Properties** | Category **Productivity** (decided 2026-10-08), the privacy policy URL (`https://christianmunoz31.github.io/burrow-releases/privacy/`, live), support contact `burrowsupport@gmail.com`, how personal information is handled (Burrow collects none), and a system requirements note. | "Privacy statement (draft)" and "Privacy policy hosting" in section 5. Note the Gumroad purchase API (10.8.2) and the generative AI declaration (11.16, section 3). |
  | **Age ratings** | Complete the IARC questionnaire in Partner Center. It is free. | "Age ratings guidance" in section 5: the facts to answer with. The questionnaire wording is not reproduced here. |
  | **Packages** | Upload `Burrow_<version>.msixbundle` from `%LOCALAPPDATA%\burrow-release\store\<version>\`. | "Build commands" below. The package version is the app version plus `.0`, so `1.0.0.0` for app 1.0.0 (see "Package version"). |
  | **Store listings** (en-us) | Product name, descriptions, features, screenshots (at least 1, recommended 4 at 1920x1080 or larger), search terms (max 7), What's new, copyright. The app icon and tiles come from the package. | Section 5: "Product name" (`Burrow: Private Life Organizer`), "Short description", "Full description", "Features", "Search terms", "What's new", "Copyright". Ready-to-paste Claude-in-Chrome prompts for every section: [store/chrome-prompts.md](store/chrome-prompts.md). |
  | **Submission options** (inside the submission, not a separate step in the list) | The restricted capability justifications (`runFullTrust`, `unvirtualizedResources`) and the notes for certification. | "Restricted capability justifications" and "Notes for certification" below. |

- [ ] **After publishing:** see section 4. Store installs update through the Store only.

### Build commands

Run from the repository root on the Windows PC. Needs the Windows SDK (`makeappx.exe`, `signtool.exe`; the script finds the newest installed one) and the normal desktop build tools (Rust, the Tauri CLI from `node_modules`).

```powershell
npm run release:store -- --check     # report the identity and tools; builds nothing
npm run release:store                # the upload build: x64 and arm64 .msix plus the .msixbundle (refuses a 0.x app version)
```

Flags (all optional):

| Flag | Meaning |
| --- | --- |
| `--arch arm64,x64` | Which architectures to build. Default both. |
| `--local-test` | Build a test package for sideloading, not for upload. It is the only build that accepts a 0.x app version. With real values in `config/msstore.json` it uses the real `Name` and `Publisher`; only while that file still has `PLACEHOLDER` values does it fall back to a made-up identity (`Burrow.LocalTest`, `CN=Burrow Local Test`). |
| `--sign-local-test` | With `--local-test` only: create or reuse a self-signed certificate whose subject equals the package Publisher in `Cert:\CurrentUser\My` (30 days, created with a non-exportable private key; the subject and paths reach PowerShell through environment variables), write its public part to `BurrowLocalTest.cer` next to the packages, and sign every `.msix` and the `.msixbundle`. |
| `--data-location appdata\|userprofile` | Where the app keeps its data. `appdata` (default, or `"dataLocation"` in `config/msstore.json`): the manifest has `rescap:unvirtualizedResources` and `desktop6:FileSystemWriteVirtualization` `disabled`, and the app writes the real `%APPDATA%\Burrow`. `userprofile`: the fallback for when Partner Center refuses `unvirtualizedResources` (runbook below): neither of those is in the manifest and the app writes `%USERPROFILE%\Burrow Data`. The flag wins over the config; any other value stops the build. The output folder and the file names then carry `userprofile`, so the two kinds cannot be mixed up at upload. `build-summary.txt` and `--check` print the data location. |
| `--out-dir <dir>` | Output folder. Must be outside the repository. |
| `--x64-node <node.exe>` | Use this x64 `node.exe` for the x64 sidecar instead of downloading one. It must be x64 and the same Node version as the one running the script. This is the only way to build x64 with a Node version that has no pinned hash. |
| `--reuse-web` | Skip `npm run build` and use the existing `dist/`. Its `burrow-build-info.json` (in `dist/` and again in `src-tauri/resources/dist` after the sidecar copy) must be a stable build of the current app version; a dev or stale build stops the build. |
| `--keep-staging` | Keep the staged package folders in `<out-dir>\staging`. |
| `--skip-smoke` | Skip the sidecar smoke test (see below). Only for a PC that cannot start the exe; `build-summary.txt` then says the smoke test was skipped. Do not upload such a build. |
| `--check` | Only report; build nothing. |

What it does: removes the packages, bundle, `SHA256SUMS.txt`, `build-summary.txt` and `BurrowLocalTest.cer` that an earlier build left in the output folder, builds the web app, then for each architecture builds the sidecar with `BURROW_DISTRIBUTION=store`, compiles the app with `tauri build --no-bundle` (no updater overlay), stages `Burrow.exe`, `burrow-server.exe`, `resources/` and the logos next to a generated `AppxManifest.xml`, runs the sidecar smoke test on the staged `burrow-server.exe`, and packs it with `makeappx pack`; then `makeappx bundle` joins the packages. It publishes and uploads nothing.

The data location works the same way as the distribution: a compile-time marker. `BURROW_DATA_LOCATION=userprofile` is set only by this script (and only for `--data-location userprofile`), for its own children; `desktop:build` and `buildInstaller.js` remove it, `buildSidecar.js` takes it only from `--data-location` and refuses `userprofile` without `--distribution store` (and on the Dev channel), `src-tauri/build.rs` stops on any value other than `appdata` or `userprofile` and on `userprofile` without `BURROW_DISTRIBUTION=store`, the sidecar bundle carries `/*! BURROW_DATA_LOCATION=userprofile */` and the shell exe `burrow-data-location=userprofile` (a direct build can never carry either: `scripts/checks/channelMarker.js --expect-distribution direct` and `buildInstaller.js` refuse them), and the shell refuses a ready line whose `dataLocation` is not its own.

The environment variable `BURROW_DISTRIBUTION` is set only by this script, for its own children. `desktop:build` and `buildInstaller.js` remove it from their children's environment, `buildSidecar.js` takes the distribution only from `--distribution`, `src-tauri/build.rs` stops the compile on any value other than `direct` or `store`, and `buildInstaller.js` checks after the compile that the shell exe carries `burrow-distribution=direct` and not `burrow-distribution=store`. A lingering `BURROW_DISTRIBUTION=store` can therefore not turn a direct build into a Store build.

**Sidecar smoke test.** After each architecture is staged, the build runs `scripts/release/smokeSidecar.js --expect-distribution store` against the staged `burrow-server.exe`, with the UI and migrations taken from the stage folder (`BURROW_DIST_DIR` and `BURROW_MIGRATIONS_DIR` point into it). It starts the exe on a throwaway data folder the way the shell does and checks the ready line, the desktop gate, `distribution` store in `/api/app/info`, the `store_managed` update check and a clean exit. A failure stops the build. The x64 exe runs under emulation on an ARM64 PC (Windows 11 ARM).

- **Output folder:** `%LOCALAPPDATA%\burrow-release\store\<app version>\` (`...\<app version>-localtest\` for `--local-test`; `-userprofile` is added for the userprofile data location, for example `...\<app version>-localtest-userprofile\`). It holds `Burrow_<app version>_arm64.msix`, `Burrow_<app version>_x64.msix`, `Burrow_<app version>.msixbundle`, `SHA256SUMS.txt` and `build-summary.txt` (`Burrow_<app version>_userprofile_arm64.msix`, `Burrow_<app version>_userprofile.msixbundle` and so on for the userprofile data location). File names use the app version; the manifest and the bundle carry the Store package version (the app version plus `.0`). `build-summary.txt` prints both (and, for a test build, that it is self-signed and for sideload only).
- **x64 on an ARM64 PC:** the x64 sidecar is the server bundle injected into an official x64 `node.exe`. Without `--x64-node` the script downloads `https://nodejs.org/dist/<node version>/win-x64/node.exe` and accepts it only if its sha256 equals the hash pinned for that Node version in `config/store-node.json` (the file holds the verified hash for v24.15.0, taken from the cached download and cross-checked against the official `SHASUMS256.txt`). A Node version with no pin is refused unless you pass `--x64-node`. The download must also match the `SHASUMS256.txt` line, redirects are not followed, an announced size above the 200 MiB cap is refused before the body is read, and a mismatch discards the download. The file is cached in `%LOCALAPPDATA%\burrow-release\cache`; a cached copy is checked against the pin and run (`--version`, under emulation) every time, and downloaded again if it does not match. The Node version is the one running the script. To add a version, copy its `win-x64/node.exe` line from `https://nodejs.org/dist/<version>/SHASUMS256.txt` into the pin file after checking it against a download you made yourself.
- **Sidecar signature:** an official `node.exe` is Authenticode-signed, and injecting the server rewrites the file so that signature is dead. `signtool sign` on a package that contains such a file fails (0x800700C1), so the packaged copy of `burrow-server.exe` has the embedded signature removed (`scripts/release/pe.mjs`). The tool clears the Security data directory and the header checksum, and cuts the certificate blob off the end of the file only when the blob starts at or after the end of the last section's raw data and ends exactly at the end of the file; otherwise the file keeps its length. A file whose header declares 4 or fewer data directories is left unchanged. An unsigned exe is fine in an MSIX because the package signature covers every file. The direct installer's sidecar is not changed.
- **Leftover sidecars:** the Store sidecars are written to `src-tauri/binaries`, and the Store bundle and SEA exe to `.sidecar-build`, while building. They are deleted when the build ends (also on failure), but only if they carry the `store` marker: a direct sidecar or bundle in the same place is never deleted. After a Store build, run `npm run desktop:sidecar` before direct dev work. Every direct build path refuses a sidecar marked `store`: `desktop:build`, `buildInstaller.js`, `release:local` and the CI steps check `--expect-distribution direct` (`scripts/checks/channelMarker.js`). If you see "A Microsoft Store sidecar is present", run `npm run desktop:sidecar`.
- **Version gate:** the build and `--check` stop with a clear message on a 0.x app version unless `--local-test` is given, and always on a dev or prerelease version.
- **Gate:** while `identityName`, `publisher` or `publisherDisplayName` is empty or a placeholder, the upload build refuses and says which. The upload build also refuses an empty `displayName` (the reserved Store name has no default); only a `--local-test` build falls back to `Burrow` for it.

### Owner config

`config/msstore.json` holds the Partner Center identity (not secret, committed). The build reads `identityName`, `publisher`, `publisherDisplayName` and `displayName`; the `reserved` block (package family name, Store ID, Store URL, protocol link) is for reference only and no build step reads it. Values are case sensitive; a wrong one makes Partner Center reject the upload. The manifest `Properties/DisplayName` must equal the reserved Store name, so it is `Burrow: Private Life Organizer` (the colon is valid in XML and passes the build's checks); the Start menu entry (`uap:VisualElements/DisplayName`) uses the same value so the package has one name. The in-app branding and the window stay "Burrow"; the package name is only package metadata. Not verified: how Windows truncates the longer name in the Start menu.

### Package version

Microsoft's rule (checked 2026-10-08, [app package requirements](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-package-requirements)): "the last (fourth) section of the version number is reserved for Store use and must be left as 0 when you build your package ... The other sections must be set to an integer between 0 and 65535 (except for the first section, which cannot be 0)."

Decided 2026-10-08: the Store package version is the app version with a fourth part of 0, identical to the app version. There is no mapping:

| App version | Store package version |
| --- | --- |
| 1.0.0 | 1.0.0.0 |
| 1.4.1 | 1.4.1.0 |
| 2.0.0 | 2.0.0.0 |

The same value is used for each package and for the bundle version (`makeappx bundle /bv`); each part must be at most 65535. Because the first section cannot be 0, **`release:store` refuses a 0.x app version for the upload build, and `--check` reports it as refused.** Burrow 1.0.0 went out on all channels (Gumroad, direct download and Store); see [RELEASING.md](RELEASING.md), "Releasing 1.0.0 with Release-As" (history). `--local-test` is the one exception: it may build a 0.x version (0.4.1 gives package version `0.4.1.0`) so the sideload test could run before 1.0.0, and that package is never uploaded.

### Local sideload test

The test package has the real `Name` and `Publisher`, so it has the same identity as the Store app: **uninstall it before installing from the Store**. It uses the real data folder (`%APPDATA%\Burrow`, or `%USERPROFILE%\Burrow Data` for the userprofile data location; see section 4), so the script backs that up first. A 0.x app version is allowed here (`--local-test` only).

```powershell
# Build (arm64 shown; this PC). Output: %LOCALAPPDATA%\burrow-release\store\<version>-localtest\
npm run release:store -- --local-test --sign-local-test --arch arm64
```

For the userprofile data location add `--data-location userprofile` (output `...\<version>-localtest-userprofile\`):

```powershell
npm run release:store -- --local-test --sign-local-test --arch arm64 --data-location userprofile
```

Use `--arch x64` on an x64 PC. `build-summary.txt` of a signed local test build with the real identity ends with the manual cleanup commands, in case the script below was not used.

**Sideload data-folder test.** Run `scripts/store/sideload-test.ps1` (dry run by default; add `-Run` in an elevated PowerShell) against the `--local-test --sign-local-test` bundle. It backs up `%APPDATA%\Burrow` to `%USERPROFILE%\BurrowBackup-<stamp>`, trusts `BurrowLocalTest.cer` in `Cert:\LocalMachine\TrustedPeople` (CurrentUser\TrustedPeople is not enough: Add-AppxPackage fails with 0x800B0109, so admin is required), installs, launches from `shell:AppsFolder`, and compares `%APPDATA%\Burrow` with `%LOCALAPPDATA%\Packages\<PFN>\LocalCache`. PASS means no Burrow data files under LocalCache and new or changed files in the real folder. It then closes Burrow, uninstalls, checks the real data and backups survived and the Packages folder is gone, and removes the certificate. A text and JSON report (checks, snapshots, backup folder, restore command) is written beside the bundle. The script reports the real PackageFamilyName. Exit code 0 means pass.

**Userprofile ownership check and backup limits.** The preflight FAILS when `%USERPROFILE%\Burrow Data` exists without a valid `.burrow-data.json` marker, or is a file, link or junction: it is then not a Burrow data folder, the script says so and never backs it up or touches it. Every backup also refuses a folder with a `.git` folder, more than 5000 files or more than 1 GB unless `-Force` (which does not lift the marker check). `-ProfileRoot <dir>` points `Burrow Data` and the backups at a temp folder for tests. `burrow.db-wal` and `burrow.db-shm` missing after the run is reported as INFO (SQLite deletes them on a clean close); any other missing file outside `backups\` is a FAIL.

**Userprofile mode** (`-DataLocation userprofile`, or read from the bundle: a manifest without `unvirtualizedResources` is a userprofile package, and a `-DataLocation` that disagrees with the bundle fails the preflight). It backs up and verifies both `%USERPROFILE%\Burrow Data` (if it exists) and the direct data `%APPDATA%\Burrow` (if it exists; to `BurrowDirect` in the same backup folder), and PASS needs: `burrow.db` and `secrets.key` landed in `%USERPROFILE%\Burrow Data`, `logs\server.log` was written there, no data files under LocalCache, `%APPDATA%\Burrow` exactly as before (files, sizes, times, `burrow.db` SHA256) after the run and again after the uninstall, and the data folder with its backups survived the uninstall. The schema-upgrade gate (`-AllowSchemaUpgrade`) applies only in appdata mode: the userprofile build never opens the AppData database (an import copies it and migrates only the copy), and the script verifies it stays unchanged.

Owner one-liners (elevated PowerShell, quit Burrow first; replace `<repo>` with the path of this checkout). Add `-Run`; leave it out for a dry run:

```powershell
# appdata package (the default build)
powershell -NoProfile -ExecutionPolicy Bypass -File "<repo>\scripts\store\sideload-test.ps1" -Run
# userprofile package (the fallback build)
powershell -NoProfile -ExecutionPolicy Bypass -File "<repo>\scripts\store\sideload-test.ps1" -DataLocation userprofile -Run
```

The test certificate carries the real Publisher, so do not leave it trusted (the script removes it). The sideload install has not been run yet: it needs an administrator. The build output was inspected (manifest identity, `DisplayName`, version, `MinVersion`) but not installed.

### Restricted capability justifications

Paste these into Submission options.

`runFullTrust`:

> Burrow is a desktop app that runs its own local server process on 127.0.0.1 and talks to a locally installed Ollama. It needs full trust to start and supervise that process and to read and write the user's database on disk.
>
> Folders reads only the folders the user picks in the system folder window, and only reads: it never writes into them. Exports go through the system save window. A Folders summary needs Ollama, like Javi. A Folders question also needs the `nomic-embed-text` model, which is downloaded only when the user clicks. PDF and Word files are listed as Not supported yet.

`unvirtualizedResources` (only the default `appdata` package declares it; the userprofile fallback package does not, so leave this text out for that build, see "If Partner Center refuses unvirtualizedResources"):

> Burrow keeps the user's budget and journal database in %APPDATA%\Burrow, the same folder as the direct download edition. This way data is never lost on reinstall or uninstall, and it migrates between editions.

### If Partner Center refuses unvirtualizedResources

Why this can happen: Microsoft's schema page says `desktop6:FileSystemWriteVirtualization` "is currently intended to be used only by certain types of desktop PC games that are published by Microsoft and our partners", and `unvirtualizedResources` is what lets a package turn it off. Without both, MSIX redirects NEW files an app creates under AppData into the package's `LocalCache` and deletes them on uninstall. The fallback keeps the data outside AppData: MSIX does not virtualize other `%USERPROFILE%` locations ("Apart from AppData, the app can write to any location where the user has write access, including other parts of %userprofile%", https://learn.microsoft.com/en-us/windows/msix/desktop/flexible-virtualization). Reads of existing real AppData files still fall back to the real location (merged view).

1. **Decide once, before the first public release.** Decided 2026-10-15 after the 10.6.3 refusal: `userprofile` is the shipped configuration and `pages/` was re-rendered with it (the live privacy page must be re-published from it before the resubmission). Edit `config/msstore.json`: `"dataLocation": "userprofile"` (the default is `appdata`), then `npm run privacy:render` and commit `pages/` (the privacy page names the folder of each edition and follows this value; `npm run check:privacy` fails while it is stale). Or build one package with the flag and no config change: `npm run release:store -- --data-location userprofile` (the build summary then warns that the config and the privacy page say something else). Do not switch a published Store listing from `userprofile` back to `appdata` later: the data would stay in `%USERPROFILE%\Burrow Data` and the new build would not look there.
2. **Build and test the package.** `npm run release:store -- --local-test --sign-local-test --arch arm64 --data-location userprofile`, then the elevated sideload test in userprofile mode (see "Local sideload test"). Both exit codes must be 0 before anything is uploaded.
3. **Build the upload package.** `npm run release:store -- --data-location userprofile` (a 0.x app version is refused). Upload `Burrow_<version>_userprofile.msixbundle` from `...\store\<version>-userprofile\`. The folder and file names carry `userprofile` so it cannot be confused with the other build.
4. **Resubmit in Partner Center and fix the Submission options.** The manifest now declares only `runFullTrust`. Remove the `unvirtualizedResources` justification text (keep the `runFullTrust` one). Do not leave the old text in: it describes a capability the package no longer has.
5. **What changes for users.**
   - The data folder is `%USERPROFILE%\Burrow Data` (for example `C:\Users\<name>\Burrow Data`), not `%APPDATA%\Burrow`. Settings shows it at the bottom of the page ("Data folder: ...", and the build line says "data in your user folder"), and `/api/app/info` and the ready line carry `dataLocation`. The server log moves to `%USERPROFILE%\Burrow Data\logs\server.log` too, because a new file under `%LOCALAPPDATA%` would be virtualized. WebView2's own profile and the window state stay under `%LOCALAPPDATA%` and are virtualized into the package's `LocalCache`: they are caches (a reset only forgets the window size), so they are not moved.
   - A new install starts a new, empty data folder with its own `secrets.key`, so a new 14-day trial (the same as wiping a data folder, which is accepted, [LICENSING.md](LICENSING.md) section 8) and no activation. Someone who used the direct edition or an earlier `appdata` Store build sees a dismissible pointer on Home while the new Burrow is still empty, and the **Import from your existing Burrow** card in Settings > Data & storage. It is never automatic. It copies the data, the backups, `secrets.key`, the license activation and the trial record, leaves the original untouched, and finishes at the next start ("Close Burrow completely and open it again"). Importing makes no network call, so a license seat is not used a second time. Not importing means activating the key again in the new folder.
   - Uninstalling the Store build keeps `%USERPROFILE%\Burrow Data` (it is outside the package), as the direct edition keeps its folder.
   - **Ownership marker.** `%USERPROFILE%\Burrow Data` is a folder in the user's own profile, so Burrow never assumes it created it. When Burrow creates the folder it writes `.burrow-data.json` (`{ "app": "Burrow", "edition": "store", "dataLocation": "userprofile", "createdAt": <ISO time>, "formatVersion": 1 }`). At every start, in the Rust shell before it spawns the server (`src-tauri/src/data_guard.rs`, before even the log folder is created, because in this location the log folder is inside the data folder) and again in the server before any data access (`server/dataFolderOwnership.js`, `ensureDataDirOwnership` at the top of `startServer` and in `getDataDir`): a missing folder is created with the marker; a folder with a valid marker is used; an empty folder is adopted (marker written). Anything else is refused and never written to, not even a log: a folder that already holds any entry (hidden ones included) and has no marker, a corrupt or invalid marker, a path that is a file, and a symbolic link, junction or other reparse point (the marker check never follows a link). The server then exits with code `5` (`EXIT_DATA_DIR_NOT_OURS`) and the shell shows a dialog that names the folder, says Burrow did not change anything in it, and asks the user to rename or move that folder (or contact support), with Open folder, Copy details and Quit. Because the shell log folder is not usable in that case, the shell log goes to `%LOCALAPPDATA%\com.burrow.desktop\logs` (which MSIX may virtualize; it holds only the refusal). The import from the direct Burrow also writes only into a folder that carries the marker. The `%APPDATA%\Burrow` (direct) and Dev folders have no marker rule and are unchanged. This is why the folder is named `Burrow Data` and not `Burrow`: a plain `Burrow` folder in the profile can already exist for unrelated reasons (a source checkout, an old install).
   - The two editions no longer share data: a change made in one does not appear in the other. Do not run both at once (they still share the single-instance mutex).
   - If `%USERPROFILE%\Burrow Data` lies inside OneDrive (the whole profile, or the folder, is synced), Settings and Home show a one-time warning ("Your Burrow data folder is inside OneDrive. Syncing a live database can damage it."). OneDrive Known Folder Move redirects Desktop, Documents, Pictures, Screenshots and Camera Roll, not other folders in the profile (https://learn.microsoft.com/en-us/sharepoint/redirect-known-folders), so a default setup does not warn.
6. **Dev channel and direct edition are unchanged.** Burrow Dev keeps `%APPDATA%\Burrow Dev`, and the Dev channel guards also refuse `%USERPROFILE%\Burrow Data`. "Copy my data from Burrow" in Burrow Dev still reads the direct folder `%APPDATA%\Burrow`.

#### How "Import from your existing Burrow" reads the direct data (userprofile package only)

- **Deviation from the owner spec, needs owner sign-off.** The spec asked for the SQLite backup API on the direct database. The import instead makes a raw, read-only file copy of `burrow.db` (plus `-wal` and `-journal` when present), because any SQLite open of the source, even read-only, creates `-wal` and `-shm` files in the user's direct folder, and under MSIX virtualization such files could land in `LocalCache` and shadow the real ones. The copy only runs with the direct app stopped (a process check before the copy and again right after it; anything but a clear "not running" refuses), every copied file is hashed while it is read and the source is hashed again after the file signatures were compared (so a change that keeps size and time still forces a retry or a refusal), and SQLite then recovers and verifies only the private copy (WAL recovery runs in the backup worker, not on the server's main thread). The direct folder is byte-for-byte unchanged afterwards.
- **If PowerShell or CIM is blocked** (group policy, endpoint protection or a stripped-down Windows), the "is the other Burrow running" check cannot run and answers "unknown". An unknown answer refuses the import ("Burrow could not tell whether your other Burrow is open. Close it and try again. Nothing was changed."), so the import is unavailable on that PC. The way around it is the free export: Settings > Data & storage > Export my data in the direct Burrow, then Import in the Store build (an import of an export never overwrites the license or trial records, so activate the key again in the Store build). The check runs `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` with `-NoProfile`, and it was run on the owner's PC with exactly the environment the shell gives the sidecar (`SystemRoot`, `PATH=%SystemRoot%\System32`, the profile folders; no `windir`, no `PSModulePath`): it answers "no" or "yes", never "unknown". A test repeats that run (`server/__tests__/directRunning.test.js`).
- **Startup cost.** At the next start the shell waits at most 60 s for the server. The check of the staged files therefore hashes only `burrow.db`, `secrets.key` and the license files, and checks the backups by size (they were hashed when they were staged); the database integrity check is made at stage time and recorded in the manifest.
- **Safety folders.** The swap never deletes: the target's own files go to `import-aside\<stamp>\` (a taken name gets `-1`, `-2`, and nothing is overwritten), and the staged folder is removed only after every file in the manifest is confirmed in place. An unreadable manifest while staged files are still in the stage refuses to start Burrow with a message (exit code 4; the shell shows "Burrow could not finish importing" with Open data folder, Copy details and Quit, and the message names `<data dir>\.import-*` and `<data dir>\import-aside`) instead of discarding anything. A swap that already moved every file but could not close its stage (the rename to `.done` was refused, for example by an antivirus scan) is left as it is and closed at the next start: an existence check of `burrow.db` and `secrets.key` only (no size check, because the database may have been used since), and files that appeared after the swap, such as a new `license-activation.json`, are never moved aside. The staged folder is never wiped in arbitrary order.
- **The target's own backups.** The target's own backups (they come from a database nobody used, so they hold no data) move to `import-aside\<stamp>\backups\`, a whole backup at a time, and the imported backups land in `backups\`, so the empty, newer ones cannot push the imported ones out of the retention plan. A target whose `backups\` holds a manual backup, or an automatic one with rows above a fresh database, counts as used and is not offered the import (a kept backup after Erase is exactly that). Erase all my data deletes `import-aside\` except the backups in it, unless "Also delete all backups" is chosen.
- **A stage that cannot be read right now** (a locked file, an antivirus scan: any error other than "file not found") is kept for the next start instead of being cancelled as unverified; Burrow starts without it that time.
- **Another Windows user's Burrow.** The running check ignores Burrow processes in another Windows session (fast user switching) when both session ids are known; an unknown session id still counts as running.
- **The import is a point-in-time copy.** It holds what the direct Burrow had when the user clicked, as of the moment the copy ran. Data added to the direct Burrow afterwards is not included; the Settings copy says so. To bring newer data over, use Export my data there and Import here.
- **T1 (manual check on the sideload machine, userprofile package).** The script cannot read the import status: it is behind the desktop sign-in cookie and the server writes no log line for it. With direct data present, start the package once and confirm that Home shows the pointer and Settings > Data & storage shows "Import from your existing Burrow"; click it, close Burrow completely, reopen, and confirm the data, the trial or license and the backups are there; then confirm `%APPDATA%\Burrow` is unchanged (the script already checks that).
- **T2 (check before testing the userprofile import).** If a package of the same family previously ran in `appdata` mode, `%APPDATA%\Burrow` as the package sees it can include a package-private virtualized copy (`%LOCALAPPDATA%\Packages\<PFN>\LocalCache\Roaming\Burrow`) merged over the real folder, and the import reads that merged view. Uninstall any earlier `appdata`-mode test package first (uninstalling deletes its `LocalCache`), then check on the sideload machine that `LocalCache\Roaming\Burrow` does not exist before the userprofile import is tried.

### Notes for certification

Paste these. No review license key is needed.

> Burrow needs no account, sign-in or license key to test. Every install gets all Pro features free for 14 days automatically, so every feature can be reviewed right away.
>
> The assistant features (Javi) need Ollama (free, installed separately from ollama.com) with a model such as llama3.2:3b. Install Ollama, then run "ollama pull llama3.2:3b", or use the app's first-run setup. Everything else works without Ollama: budget, todos, calendar, habits, journal, notes, bookmarks, countdowns, focus, export, import and backups need no setup. Without Ollama, Javi shows a friendly "needs Ollama" state and the rest of the app is unaffected.
>
> Burrow Pro is sold through Gumroad (a third-party purchase, policy 10.8.2). The Buy Burrow Pro button opens the Gumroad page in the browser; Burrow sends nothing.
>
> Windows 10 requires Microsoft Edge WebView2, preinstalled on most PCs.
>
> Menu (Burrow 1.2.0): every page is in the menu at the top left of the window: Home, then three groups, Budget (Budget, Subscriptions), Productivity (Todos, Notes, Focus, Countdowns, Bookmarks, Folders) and Health (Journal, Habits, Sleep & activity), then Calendar. Home also opens from the Burrow name at the top left and Settings from the gear at the top right. Every page can also be found with search (Ctrl+K).
>
> Folders (Burrow 1.1.0): the user picks a folder in the system folder window and Burrow only reads it, never writes into it; exports go through the system save window. Folders summaries need Ollama, the same as Javi. Folders questions also need the `nomic-embed-text` model, which is downloaded only when the user clicks. Without Ollama the file list, counts and exports still work. PDF and Word files are listed as Not supported yet.

## 3. Policy notes

Source: Microsoft Store Policies, version 7.20, published 2026-09-15, effective 2026-10-22 (the policy text was summarized to the doc author by the owner, not re-read here). Re-check the current text before submitting. Quotes are short on purpose.

| Policy | What it means for Burrow |
| --- | --- |
| 10.8.1 | Non-game PC products may use a secure third-party purchase API. Burrow sells Pro through Gumroad. |
| 10.8.2 | Identify the provider, which must be PCI DSS compliant (Gumroad is). Users may be directed to a browser after install. Declare third-party in-app purchases in Partner Center (Pricing and availability) and name Gumroad as the provider. The "Buy Burrow Pro" button opens the Gumroad page in the default browser and Burrow itself sends nothing (PRODUCT.md, 2026-10-07). |
| 10.8.4 | State the purchase types and price range in the listing. Draft line is in section 5. |
| 10.14 | A Company account is required for anyone acting in relation to their trade or profession. Burrow is published under an Individual account (Seller ID 96499430, decision 2026-10-08). Switch to a Company account (DBA plus a free D-U-N-S number) only if revenue grows or a certification reviewer cites 10.14. |
| 10.8.3 | Individual accounts: a product cannot require financial information, including bank or card account info or API secret keys, for its primary function. Burrow's budget data typed in by the user is not bank credentials. Optional cloud AI keys (`cloudAi`, bring your own key) must stay optional. Flag this as a review risk. |
| 10.2.4 | Disclose the Ollama dependency at the beginning of the description. The draft listing does. |
| 10.2.3 | Do not bundle or offer to install Ollama. Burrow does not bundle it. In first-run setup the **Get Ollama** button opens https://ollama.com/download in the browser and Burrow does not install it (INSTALL.md). Our reading is that linking to the download page is acceptable. Not tested with certification. |
| 11.16 | Generative AI: disclose it in the listing, flag it in Partner Center, and provide an in-app way to report inappropriate content. Done: see "11.16 Report content" below. |
| 10.5.1 | A privacy policy is required. See section 5. |
| 11.11.1 | Age rating through the IARC questionnaire. |

### 11.16 Report content

Both editions and all channels (free tier) have Help > Report content... and a Report link under each Javi reply. Both open the default mail app with a draft to the `config/store.json` supportContact, subject "Burrow: report AI content" and the template "Describe what Javi said that was inappropriate. Paste the text here only if you want to share it." No message text or other user data is added, and Burrow sends nothing: the user decides what to paste and whether to send. Implementation: `src-tauri/src/menu.rs` (`report_content_url`), `src/components/javi/ReportLink.jsx` and `reportContent.js`; tests assert both addresses equal supportContact.

## 4. Updates and data under MSIX

Facts below are verified from the code unless marked "not tested". No Store package has been installed yet.

- **Updates.** Store installs update only through the Store. In the Store build the updater is off: the sidecar and the shell are compiled with `BURROW_DISTRIBUTION=store`, `isShellUpdaterAvailable` is false and the shell never registers the updater. `GET /api/settings/updates/check` answers `{ status: 'store_managed' }` without any network request, and Settings > Network and Settings > Updates show "Updates come from the Microsoft Store. Burrow does not check for updates itself." (Settings > Updates adds an "Open in Microsoft Store" link to `https://apps.microsoft.com/detail/9NT29CNPKBK4`; no switch and no Check now)
- **Telling the editions apart.** `/api/app/info` and the ready line carry `distribution` (`direct` or `store`). Settings shows the build identity line with "Microsoft Store" after the channel, for example `Version 0.4.1 · stable · Microsoft Store · <commit> · built <date>`. A direct build adds nothing.
- **Data location.** Two modes, chosen at build time (`config/msstore.json` `dataLocation` or `--data-location`; `server/dataLocation.js` and `src-tauri/build.rs` hold the compile-time marker, `server/paths.js` `resolveDataDir` and `src-tauri/src/exit_dialog.rs` `platform_data_dir` are the one place per language that resolves it). `appdata` (default): the data folder comes from `%APPDATA%` (`%APPDATA%\Burrow`; `Burrow Dev` for the Dev channel). MSIX normally virtualizes new files written under `%APPDATA%` into a package-private folder that is deleted on uninstall; the manifest sets `desktop6:FileSystemWriteVirtualization` to `disabled` and declares `unvirtualizedResources`, so by design the Store build reads and writes the real `%APPDATA%\Burrow`. `userprofile` (the fallback when Partner Center refuses that capability, runbook in section 2): the Store build, stable channel, on Windows keeps everything the app writes as data in `%USERPROFILE%\Burrow Data` (`burrow.db` and its `-wal` and `-shm`, `backups\`, `secrets.key`, `license-*.json`, `restore-aside\`, `import-aside\`, and the server log in `logs\`). The marker is valid only with the Store distribution on the stable channel: the server refuses to start otherwise (exit 1 before any data access), the shell and sidecar must agree (a ready line with another `dataLocation` is refused), and the direct installer build paths refuse a userprofile sidecar or shell exe. Both are by code and manifest only: the runtime check on an installed package is still pending, because installing needs an administrator. Not tested. See [INSTALL.md](INSTALL.md) "Where your data lives" for the folder contents.
- **Licenses and trial.** Activation sends the license key to the store API and nothing about the machine or the package: the code has no machine id, hostname or package input. The activation record (`license-activation.json` and the `app_state` row) and the trial and clock records live in the data folder. In the `appdata` data location the Store and direct editions share that folder, so a key activated in one edition is active in the other and a trial started in one carries over. In the `userprofile` data location they do not share it: a Store install without an import starts its own trial (equivalent to wiping a data folder, accepted) and needs the key activated again, while the one-time import copies the records with `secrets.key` (their MAC key) so the trial does not restart and the seat is not used again. The check is unchanged ([LICENSING.md](LICENSING.md)).
- **Running both editions.** Do not run the Store and direct editions at once. Burrow uses `tauri-plugin-single-instance`, which on Windows takes a named mutex built from the app identifier (`com.burrow.desktop`, giving `com.burrow.desktop-sim`); both editions have the same identifier, so the mutex is likely shared and the second launch would just focus the first. Not tested, and a packaged full-trust app's mutex behavior was not checked. There is no cross-process lock on the database, so if the mutex is not shared two editions could open the same `burrow.db`. Close one edition before opening the other.
- **Installing over a sideload test.** A sideloaded test package has the same identity as the Store app. Uninstall it (`Remove-AppxPackage`) before installing from the Store.
- **WebView2.** Windows 11 includes the WebView2 runtime. The direct installer downloads it when missing (`webviewInstallMode: downloadBootstrapper`), but an MSIX has no bootstrapper, so on a Windows 10 PC without the WebView2 runtime the app would start but not open a window. Not tested. Windows 10 support is kept (decided 2026-10-08): the manifest `MinVersion` is `10.0.18362.0` (Windows 10 version 1903, the first release with `desktop6:FileSystemWriteVirtualization` and `unvirtualizedResources`; blocking item 4 has the sources and the certification risk), and the listing says "Windows 10 requires Microsoft Edge WebView2, preinstalled on most PCs."
- **Sidecar signature.** The packaged `burrow-server.exe` has the dead Authenticode signature of the official `node.exe` removed; see "Build commands".

## 5. Draft Store listing

### Product name

Burrow: Private Life Organizer (reserved in Partner Center; must match the manifest DisplayName).

### Short description

A private budget and journal tracker that runs on your own computer. Zero subscriptions. Private by default.

### Full description

Requires Ollama (free, installed separately from ollama.com) for the Javi assistant. Everything else in Burrow works without it.

Generative AI: Javi uses a local generative AI model through Ollama, on your own computer. Its answers can be wrong or inappropriate, so check anything that matters. Under each Javi reply there is a Report link, and Help > Report content... does the same: both open a draft email to the support address, and Burrow sends nothing itself.

Burrow is a private budget and journal tracker for your Windows PC. Your data stays on your computer, in open formats. No accounts, no telemetry, and nothing goes to the cloud unless you choose to turn something on.

- One simple menu for your money and your days: transactions and subscriptions, todos, notes, focus sessions, countdowns, bookmarks and folders, your journal, habits, sleep and activity, a calendar, and the weather in the Javi card on Home.
- Automatic daily local backups with one-click restore, plus an export of everything as open files (JSON, CSV and Markdown).
- Javi, a built-in helper that gives a quick insight about the page you are on, shows a small count when there is something new to look at, and with Burrow Pro answers questions about your own data. All math (totals, averages, budgets) is calculated by Burrow, not by the model.
- Privacy controls you can see: a Network activity page lists recent outbound connections Burrow has made (the last 90 days). Anything that contacts the internet is off until you turn it on.
- Optional: bring your own cloud AI provider. It is off by default and asks for confirmation first.
- Your data is never paywalled. Export, import, backups and privacy controls are free forever.

Price: Burrow is free to download and includes a full 14-day trial of every Pro feature, with no card and no account. Burrow Pro is a one-time purchase sold through Gumroad, a third-party seller, not through the Store. It includes a year of new Pro features (two years for the Founding edition): the Pro features released during that year stay yours forever, and Pro features released after it need a newer Burrow Pro license. Everything in Burrow Free is unaffected. Prices range from $49 (Standard) to $99 (Founding edition, limited-time, on sale until January 5, 2027), with a Family edition for up to 5 people at $79. After you buy, paste the license key in Settings > License. Clicking "Buy Burrow Pro" opens the Gumroad page in your browser.

Windows 10 requires Microsoft Edge WebView2, preinstalled on most PCs.

### Features

One line each (the Store allows up to 20 features):

1. Budget and journal with todos, habits, notes, focus, calendar, countdowns and bookmarks, in one app
2. Your data stays on your computer: no account, no telemetry, nothing sent to the cloud by default
3. Automatic daily backups with one-click restore, and export as JSON, CSV or Markdown
4. Javi, a built-in helper on your computer (needs Ollama), gives a quick insight on each page and shows when there is something new
5. Network activity page shows recent outbound connections (kept 90 days); anything that goes online is off until you turn it on
6. Free to use; Burrow Pro is an optional one-time purchase through Gumroad

### Search terms (max 7)

1. budget tracker
2. private journal
3. expense tracker
4. offline finance
5. local first
6. personal finance
7. privacy

### What's new (first Store version)

Welcome text used for the first Store listing (Burrow 1.0.0):

> Burrow is now in the Microsoft Store. Same private, local-first app as the direct download, and it uses the same data folder. Updates come from the Store.

### What's new (1.1.0)

> New: Folders. Pick a folder on your computer and Burrow lists its files, works out counts, sizes and duplicates, can write short summaries with Javi on your computer, and exports the list as Markdown, JSON or CSV. It only reads, and only the folders you choose. With Burrow Pro you can ask questions about a folder and get a report. PDF and Word files show as Not supported yet; support for them is coming in a later version.
> Updates come from the Microsoft Store.
> Faster Javi: answers come faster on small models and stick to your own numbers.

The hand-written text for the other channels is `release-notes/v1.1.0.md`.

### What's new (1.2.0)

> New: one simple menu. Home is at the top, then your pages in three groups: Budget (Budget, Subscriptions), Productivity (Todos, Notes, Focus, Countdowns, Bookmarks, Folders) and Health (Journal, Habits, Sleep & activity), with Calendar at the bottom. The Work and Home filter is now on the Todos page, and your tags are kept.
> The Health page is now called Sleep & activity. It still shows the readiness, sleep and activity from your Oura Ring.
> Home starts with a Javi card: today's briefing with Burrow Pro, otherwise Get insight for a short note about your day.
> The weather now shows in the Javi card: turn it on and set your location in Settings > Network. Calendar is just your events.
> Home shows a Budget card with what you spent this month, what you budgeted and what is left.
> Next to it, a Subscriptions card shows your next subscription charges in the coming 30 days and what they add up to.
> If you never customized Home, it starts with the Javi card and six others. Use Customize to show the rest.
> New: a calculator. Press Ctrl+K and choose Calculator.
> Javi has a new look: a message bar at the bottom right of your pages that opens upward, where its insight about the page reads like a message from Javi. When a page has something new for Javi, a small count on the bar lets you know. Press Alt+J to open Javi.
> A calmer top bar: Burrow takes you Home, the gear opens Settings, and a Back button takes you back to where you were.

The same text as `release-notes/v1.2.0.md`, the hand-written text for the other channels. If the Alt+J check in the desktop app fails before the release, change both together.

### Copyright

Neural Foundry

### Privacy policy text

The published privacy page is generated, not hand-written: `pages/privacy/index.html` is rendered by `npm run privacy:render` from `server/netFeatures.js` (every outbound feature, its hosts and its `policy` text), `config/store.json` (`supportContact`) and `config/privacy.json` (version and effective date). `npm run check:privacy` fails while the committed `pages/` output is stale. Change the registry, not this document, so there is one source.

### Privacy policy hosting

Checklist before the 1.1.0 Store submission and the direct 1.1.0 release: the privacy page is now version 1.1 (effective 2026-10-09, `config/privacy.json`). Re-publish it to the `gh-pages` branch of `burrow-releases` first, because the live page is still the 2026-10-08 version.

Partner Center needs a public URL. Decided 2026-10-08: a GitHub Pages page on the public `burrow-releases` repo, at

`https://christianmunoz31.github.io/burrow-releases/privacy/` (live since 2026-10-08: `gh-pages` branch of `burrow-releases`, commit 31d233d, published from this repository's `pages/` output, appdata wording, effective 2026-10-08, 7 network features)

The page text is the generated `pages/privacy/index.html` (see "Privacy policy text"). Keep the private source repo out of it: the repo name appears in the URL, and nothing may link to the private repo. The page files are prepared in this repository but publishing them to `burrow-releases` is the owner's step. Published 2026-10-08 and confirmed loading (HTTP 200). Re-publish (`npm run privacy:render`, then copy `pages/` to the `gh-pages` branch, see `scripts/privacy/README.md`) whenever `npm run check:privacy` shows the rendered output changed, and in particular if the Store edition ships with `dataLocation` `userprofile`: the live page describes the appdata folder (`%APPDATA%\Burrow`), so a userprofile release needs the page re-rendered with that config and re-published before submission.

### Age ratings guidance

Partner Center asks for an IARC questionnaire (free). The questionnaire's wording and categories change, so this section lists the facts to answer with, not the questions. Answer honestly and let the questionnaire compute the rating.

- Burrow is a personal budget, journal and productivity app. It contains no violence, sexual content, nudity, profanity, drugs, alcohol or gambling of its own, and no user-generated content from other people.
- **Generative AI: yes.** The app contains generative AI (Javi, a language model run locally through Ollama). The user opens Javi to get a short insight about the current page; with Burrow Pro the user can also type follow-up questions and get a daily briefing, which Burrow can write on a schedule on this computer. Its output is not pre-moderated by the developer and can be wrong or inappropriate. Reporting is built in (Help > Report content... and the Report link under each Javi reply and under the briefing, policy 11.16).
- **User-to-user communication: no.** Burrow has no messaging, forums or sharing with other users.
- **Sharing of location: no.** Weather is optional and off by default. When the user turns it on in Settings > Network, they type a latitude and longitude, or click Use my location, which asks for the device's approximate location through the system permission (the user can decline; nothing is asked on startup or in the background). Burrow sends only the coordinates rounded to 2 decimals to Open-Meteo to get the forecast, keeps the saved location on this computer, does not share it with other users and does not send it to the developer. The Network activity log records only the host name.
- **Digital purchases: yes, external.** Burrow Pro is sold through Gumroad outside the Store. The app opens the Gumroad page in the browser; there is no purchase flow inside the app.
- No accounts, no ads, no online play, and no personal information collected by the developer (see the privacy statement).

Review the questionnaire's summary before confirming, and do not change a truthful answer to get a lower rating.

## 6. Sources

- https://learn.microsoft.com/en-us/windows/apps/publish/store-policies
- https://blogs.windows.com/windowsdeveloper/2025/09/10/free-developer-registration-for-individual-developers-on-microsoft-store/
- https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/open-a-developer-account
- https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-package-requirements
- https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options
- https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/app-capability-declarations
- https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-behind-the-scenes
- https://learn.microsoft.com/en-us/windows/msix/desktop/flexible-virtualization
- https://learn.microsoft.com/en-us/uwp/schemas/appxpackage/uapmanifestschema/element-desktop6-filesystemwritevirtualization
- https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/age-ratings
- https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/enter-app-properties
- https://github.com/tauri-apps/tauri/issues/14935
