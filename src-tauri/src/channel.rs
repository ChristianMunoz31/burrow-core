//! Release channel of this shell: stable (Burrow) or dev (Burrow Dev, a side-by-side test build).
//!
//! The channel is read at runtime from the Tauri identifier, which `tauri build --config` bakes in
//! (`tauri.dev.conf.json` for a Dev build), so it needs no build script or feature flag and the
//! stand-in builds in CI stay stable.

use std::path::{Path, PathBuf};

/// Identifier of the stable app (`tauri.conf.json`).
pub const STABLE_IDENTIFIER: &str = "com.burrow.desktop";
/// Identifier of the Dev app (`tauri.dev.conf.json`).
pub const DEV_IDENTIFIER: &str = "com.burrow.desktop.dev";

/// Which Burrow this shell is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Channel {
    Stable,
    Dev,
}

impl Channel {
    /// Only the exact Dev identifier is Dev; anything else is stable.
    pub fn from_identifier(id: &str) -> Self {
        if id == DEV_IDENTIFIER {
            Channel::Dev
        } else {
            Channel::Stable
        }
    }

    /// The Tauri identifier of this channel.
    pub fn identifier(self) -> &'static str {
        match self {
            Channel::Stable => STABLE_IDENTIFIER,
            Channel::Dev => DEV_IDENTIFIER,
        }
    }

    /// The channel's name as the server spells it (`BURROW_SHELL_CHANNEL`, the ready line's `channel`).
    pub fn as_str(self) -> &'static str {
        match self {
            Channel::Stable => "stable",
            Channel::Dev => "dev",
        }
    }

    /// Name of the bundled sidecar program, without extension. Dev has its own name so the two apps
    /// never share a binary when both install into one folder (Linux packages).
    pub fn sidecar_name(self) -> &'static str {
        match self {
            Channel::Stable => "burrow-server",
            Channel::Dev => "burrow-dev-server",
        }
    }

    /// Name shown in the window title and Help > About.
    pub fn product_name(self) -> &'static str {
        match self {
            Channel::Stable => "Burrow",
            Channel::Dev => "Burrow Dev",
        }
    }

    /// Folder name of the server's data folder, mirroring `dataFolderName` in `server/paths.js`:
    /// `Burrow` / `Burrow Dev` on Windows and macOS, `burrow` / `burrow-dev` elsewhere.
    pub fn data_folder_name(self) -> &'static str {
        folder_name(self, cfg!(any(windows, target_os = "macos")))
    }
}

/// `title_case` is the Windows and macOS spelling.
fn folder_name(channel: Channel, title_case: bool) -> &'static str {
    match (channel, title_case) {
        (Channel::Stable, true) => "Burrow",
        (Channel::Dev, true) => "Burrow Dev",
        (Channel::Stable, false) => "burrow",
        (Channel::Dev, false) => "burrow-dev",
    }
}

/// How this build reached the user: the direct installer (default) or the Microsoft Store MSIX package.
///
/// Decided at compile time by `build.rs` from `BURROW_DISTRIBUTION` (`scripts/release/buildStore.mjs` sets it to
/// `store`); an absent or empty value is `Direct`, so every existing build is unchanged (any other value stops the
/// build in `build.rs`). The Store updates the app itself, so a Store build never enables the in-app updater (see
/// `updater::should_enable`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Distribution {
    Direct,
    Store,
}

impl Distribution {
    /// Only the exact value `store` (surrounding whitespace ignored) is the Store build.
    pub fn from_build_value(value: Option<&str>) -> Self {
        match value.map(str::trim) {
            Some("store") => Distribution::Store,
            _ => Distribution::Direct,
        }
    }

    /// The distribution this binary was compiled for.
    pub fn current() -> Self {
        Self::from_build_value(Some(env!("BURROW_BUILD_DISTRIBUTION")))
    }

    /// The name the server spells it (`distribution` in the ready line and `/api/app/info`).
    pub fn as_str(self) -> &'static str {
        match self {
            Distribution::Direct => "direct",
            Distribution::Store => "store",
        }
    }
}

/// Marker string kept in the binary (and logged at start) so a build script can check which distribution an exe is
/// without running it: `burrow-distribution=store` or `burrow-distribution=direct`.
pub const DISTRIBUTION_MARKER: &str =
    concat!("burrow-distribution=", env!("BURROW_BUILD_DISTRIBUTION"));

/// Where this build keeps its data folder: `%APPDATA%\Burrow` (`Appdata`, every direct build) or `%USERPROFILE%\Burrow Data`
/// (`Userprofile`, the Microsoft Store build made without desktop6:FileSystemWriteVirtualization and
/// rescap:unvirtualizedResources, because MSIX redirects new files under AppData into the package's LocalCache and deletes
/// them on uninstall). Decided at compile time by `build.rs` from `BURROW_DATA_LOCATION` (`scripts/release/buildStore.mjs`
/// sets it); `build.rs` stops on any value but `appdata` or `userprofile`, and on `userprofile` without the store
/// distribution. The server bakes the same marker in and the shell refuses a ready line that disagrees.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DataLocation {
    Appdata,
    Userprofile,
}

impl DataLocation {
    /// Only the exact value `userprofile` (surrounding whitespace ignored) is the user profile location.
    pub fn from_build_value(value: Option<&str>) -> Self {
        match value.map(str::trim) {
            Some("userprofile") => DataLocation::Userprofile,
            _ => DataLocation::Appdata,
        }
    }

    /// The data location this binary was compiled for.
    pub fn current() -> Self {
        Self::from_build_value(Some(env!("BURROW_BUILD_DATA_LOCATION")))
    }

    /// The name the server spells it (`dataLocation` in the ready line and `/api/app/info`).
    pub fn as_str(self) -> &'static str {
        match self {
            DataLocation::Appdata => "appdata",
            DataLocation::Userprofile => "userprofile",
        }
    }

    /// True when the data folder of `channel` under `distribution` is `%USERPROFILE%\Burrow Data`: the marker, the Store
    /// distribution, the stable channel and Windows, all four (the same rule as `usesUserProfileDir` in
    /// `server/paths.js`). Burrow Dev always keeps its own AppData folder.
    pub fn uses_user_profile(self, channel: Channel, distribution: Distribution) -> bool {
        cfg!(windows)
            && self == DataLocation::Userprofile
            && channel == Channel::Stable
            && distribution == Distribution::Store
    }
}

/// Marker string kept in the binary (and logged at start) so a build script can check which data location an exe has
/// without running it: `burrow-data-location=appdata` or `burrow-data-location=userprofile`.
pub const DATA_LOCATION_MARKER: &str =
    concat!("burrow-data-location=", env!("BURROW_BUILD_DATA_LOCATION"));

/// Real location of `path`: symlinks and junctions are resolved on the deepest existing ancestor and the
/// missing tail is appended. Never creates or writes anything.
pub fn canonical_deepest(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    };
    let mut tail = Vec::new();
    let mut current = absolute.clone();
    loop {
        if let Ok(mut real) = std::fs::canonicalize(&current) {
            for part in tail.iter().rev() {
                real.push(part);
            }
            return real;
        }
        match (current.file_name(), current.parent()) {
            (Some(name), Some(parent)) => {
                tail.push(name.to_os_string());
                current = parent.to_path_buf();
            }
            _ => return absolute,
        }
    }
}

fn folded_components(path: &Path) -> Vec<String> {
    let fold = cfg!(any(windows, target_os = "macos"));
    canonical_deepest(path)
        .components()
        .map(|c| {
            let text = c.as_os_str().to_string_lossy().into_owned();
            if fold {
                text.to_lowercase()
            } else {
                text
            }
        })
        .collect()
}

/// True when two folders are the same, or one contains the other, by real location (case-insensitive
/// on Windows and macOS).
pub fn paths_overlap(a: &Path, b: &Path) -> bool {
    let (a, b) = (folded_components(a), folded_components(b));
    a.starts_with(&b) || b.starts_with(&a)
}

/// Version shown in Help > About. Dev: the `BURROW_DISPLAY_VERSION` the build was made with (for
/// example `0.2.0-dev.20261005.abc1234`), else the package version. Stable: always the package version.
pub fn display_version(channel: Channel, package_version: &str) -> String {
    display_version_from(
        channel,
        package_version,
        option_env!("BURROW_DISPLAY_VERSION"),
    )
}

fn display_version_from(
    channel: Channel,
    package_version: &str,
    build_value: Option<&str>,
) -> String {
    match (channel, build_value.map(str::trim)) {
        (Channel::Dev, Some(value)) if !value.is_empty() => value.to_string(),
        _ => package_version.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_exact_dev_identifier_is_dev() {
        assert_eq!(Channel::from_identifier(DEV_IDENTIFIER), Channel::Dev);
        assert_eq!(Channel::from_identifier(STABLE_IDENTIFIER), Channel::Stable);
        assert_eq!(Channel::from_identifier(""), Channel::Stable);
        assert_eq!(
            Channel::from_identifier("com.burrow.desktop.dev2"),
            Channel::Stable
        );
        assert_eq!(
            Channel::from_identifier("COM.BURROW.DESKTOP.DEV"),
            Channel::Stable
        );
    }

    #[test]
    fn identifier_round_trips() {
        for channel in [Channel::Stable, Channel::Dev] {
            assert_eq!(Channel::from_identifier(channel.identifier()), channel);
        }
    }

    #[test]
    fn the_dev_identifier_extends_the_stable_one() {
        assert!(DEV_IDENTIFIER.starts_with(STABLE_IDENTIFIER));
        assert_ne!(DEV_IDENTIFIER, STABLE_IDENTIFIER);
    }

    #[test]
    fn only_the_exact_value_store_is_the_store_distribution() {
        assert_eq!(
            Distribution::from_build_value(Some("store")),
            Distribution::Store
        );
        assert_eq!(
            Distribution::from_build_value(Some("  store ")),
            Distribution::Store
        );
        assert_eq!(Distribution::from_build_value(None), Distribution::Direct);
        assert_eq!(
            Distribution::from_build_value(Some("")),
            Distribution::Direct
        );
        assert_eq!(
            Distribution::from_build_value(Some("direct")),
            Distribution::Direct
        );
        assert_eq!(
            Distribution::from_build_value(Some("Store")),
            Distribution::Direct
        );
        assert_eq!(Distribution::Direct.as_str(), "direct");
        assert_eq!(Distribution::Store.as_str(), "store");
    }

    #[test]
    fn only_the_exact_value_userprofile_is_the_user_profile_location() {
        assert_eq!(
            DataLocation::from_build_value(Some("userprofile")),
            DataLocation::Userprofile
        );
        assert_eq!(
            DataLocation::from_build_value(Some(" userprofile ")),
            DataLocation::Userprofile
        );
        assert_eq!(DataLocation::from_build_value(None), DataLocation::Appdata);
        assert_eq!(
            DataLocation::from_build_value(Some("")),
            DataLocation::Appdata
        );
        assert_eq!(
            DataLocation::from_build_value(Some("UserProfile")),
            DataLocation::Appdata
        );
        assert_eq!(DataLocation::Appdata.as_str(), "appdata");
        assert_eq!(DataLocation::Userprofile.as_str(), "userprofile");
    }

    #[test]
    fn user_profile_needs_store_stable_and_windows() {
        let up = DataLocation::Userprofile;
        let on = cfg!(windows);
        assert_eq!(
            up.uses_user_profile(Channel::Stable, Distribution::Store),
            on
        );
        assert!(!up.uses_user_profile(Channel::Dev, Distribution::Store));
        assert!(!up.uses_user_profile(Channel::Stable, Distribution::Direct));
        assert!(!DataLocation::Appdata.uses_user_profile(Channel::Stable, Distribution::Store));
    }

    #[test]
    fn product_names() {
        assert_eq!(Channel::Stable.product_name(), "Burrow");
        assert_eq!(Channel::Dev.product_name(), "Burrow Dev");
    }

    #[test]
    fn data_folder_names_per_os_spelling() {
        assert_eq!(folder_name(Channel::Stable, true), "Burrow");
        assert_eq!(folder_name(Channel::Dev, true), "Burrow Dev");
        assert_eq!(folder_name(Channel::Stable, false), "burrow");
        assert_eq!(folder_name(Channel::Dev, false), "burrow-dev");
    }

    #[test]
    fn data_folder_name_follows_the_host_os() {
        let title_case = cfg!(any(windows, target_os = "macos"));
        assert_eq!(
            Channel::Stable.data_folder_name(),
            folder_name(Channel::Stable, title_case)
        );
        assert_eq!(
            Channel::Dev.data_folder_name(),
            folder_name(Channel::Dev, title_case)
        );
    }

    #[test]
    fn channel_names_and_sidecar_names() {
        assert_eq!(Channel::Stable.as_str(), "stable");
        assert_eq!(Channel::Dev.as_str(), "dev");
        assert_eq!(Channel::Stable.sidecar_name(), "burrow-server");
        assert_eq!(Channel::Dev.sidecar_name(), "burrow-dev-server");
        assert_ne!(Channel::Stable.sidecar_name(), Channel::Dev.sidecar_name());
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "burrow-channel-test-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn overlap_detects_equal_nested_and_containing_folders() {
        let base = scratch("overlap");
        let stable = base.join("Burrow");
        std::fs::create_dir_all(stable.join("backups")).unwrap();
        assert!(paths_overlap(&stable, &stable));
        assert!(paths_overlap(&stable, &stable.join("backups")));
        assert!(paths_overlap(&stable.join("backups").join("new"), &stable));
        assert!(paths_overlap(&base, &stable));
        assert!(!paths_overlap(&stable, &base.join("Burrow Dev")));
        assert!(!paths_overlap(&stable, &base.join("Burrow2")));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn overlap_ignores_case_where_the_file_system_does() {
        let base = scratch("case");
        let stable = base.join("Burrow");
        std::fs::create_dir_all(&stable).unwrap();
        let shouting = base.join("BURROW");
        assert_eq!(
            paths_overlap(&stable, &shouting),
            cfg!(any(windows, target_os = "macos"))
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn overlap_keeps_the_missing_tail_of_a_path() {
        let base = scratch("tail");
        let missing = base.join("a").join("b");
        assert!(canonical_deepest(&missing).ends_with(Path::new("a").join("b")));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn dev_shows_the_build_display_version() {
        let shown = display_version_from(Channel::Dev, "0.1.0", Some("0.2.0-dev.20261005.abc1234"));
        assert_eq!(shown, "0.2.0-dev.20261005.abc1234");
    }

    #[test]
    fn dev_falls_back_to_the_package_version() {
        assert_eq!(display_version_from(Channel::Dev, "0.1.0", None), "0.1.0");
        assert_eq!(
            display_version_from(Channel::Dev, "0.1.0", Some("  ")),
            "0.1.0"
        );
    }

    #[test]
    fn stable_ignores_the_build_display_version() {
        let shown =
            display_version_from(Channel::Stable, "0.1.0", Some("0.2.0-dev.20261005.abc1234"));
        assert_eq!(shown, "0.1.0");
    }
}
