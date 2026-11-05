//! Ownership marker of the user profile data folder (Microsoft Store build, `userprofile` data location).
//!
//! `%USERPROFILE%\Burrow Data` is a folder in the user's own profile, so Burrow cannot assume it created it. The shell
//! therefore decides before it spawns the server, and before it creates any log (in this location the log folder is
//! inside the data folder): a missing folder is created with `.burrow-data.json`, a folder with a valid marker is used,
//! an empty folder is adopted (marker written), and everything else is refused without a single write. A path that is
//! a file, a symbolic link, a junction or any other reparse point (cloud-files placeholder, deduplicated or projected
//! folder) is refused too (fail closed), and the check never follows a link. The server applies the same rule
//! (`server/dataFolderOwnership.js`) before it touches its data, with the same wording, and exits with
//! [`EXIT_DATA_DIR_NOT_OURS`]. This file is the authoritative first gate: it reads `FILE_ATTRIBUTE_REPARSE_POINT` directly,
//! which Node cannot, so the server's copy of the check is indirect (see `reparseProblem` there). The marker rule is
//! pinned for both runtimes and the sideload script by `server/__tests__/fixtures/markers.json`.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Folder name of the Store build's data inside the user profile; `USER_PROFILE_DATA_FOLDER` in `server/paths.js`.
pub const USER_PROFILE_DATA_FOLDER: &str = "Burrow Data";

/// Name of the ownership marker inside the data folder; `DATA_MARKER_FILE` in `server/dataFolderOwnership.js`.
pub const MARKER_FILE: &str = ".burrow-data.json";

/// Server exit code for "the data folder exists and is not a Burrow data folder"; `EXIT_DATA_DIR_NOT_OURS` in the server.
pub const EXIT_DATA_DIR_NOT_OURS: i32 = 5;

const MARKER_FORMAT_VERSION: u64 = 1;
const MAX_MARKER_BYTES: u64 = 4096;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

/// Why a folder is not ours (or could not be created).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotOursReason {
    /// Unmarked and holds at least one entry (hidden ones included).
    NotEmpty,
    /// The path is a file.
    File,
    /// The path is a symbolic link or junction.
    Link,
    /// The path is any other reparse point (cloud-files placeholder, deduplicated or projected folder).
    Reparse,
    /// The marker is missing its fields, is not JSON, is too big or is not a regular file.
    BadMarker,
    /// The folder could not be inspected or read.
    Unreadable,
    /// The folder was missing and Burrow could not create or mark it (a missing parent, no permission). Not a statement
    /// about whose folder it is.
    CreateFailed,
}

impl NotOursReason {
    fn text(self) -> &'static str {
        match self {
            NotOursReason::NotEmpty => "it already holds other files",
            NotOursReason::File => "it is a file, not a folder",
            NotOursReason::Link => "it is a shortcut, symbolic link or junction",
            NotOursReason::Reparse => "it is a cloud or other special folder (reparse point)",
            NotOursReason::BadMarker => "its Burrow marker file is not valid",
            NotOursReason::Unreadable | NotOursReason::CreateFailed => "it could not be read",
        }
    }
}

/// What a folder is, without having changed anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Inspection {
    Missing,
    Empty,
    Marked,
    Refused(NotOursReason),
}

/// What [`ensure_owned`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Created,
    Adopted,
    Marked,
}

/// A refused folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotOurs {
    pub dir: PathBuf,
    pub reason: NotOursReason,
}

impl NotOurs {
    /// The sentence the server prints for the same refusal (`notOursMessage` in `server/dataFolderOwnership.js`).
    pub fn message(&self) -> String {
        not_ours_message(&self.dir, self.reason)
    }
}

/// Plain-language refusal text; identical to the server's.
pub fn not_ours_message(dir: &Path, reason: NotOursReason) -> String {
    if reason == NotOursReason::CreateFailed {
        return format!(
            "Burrow did not start because it could not create or mark its data folder {}. Check that the folder above it exists and that you can write to it, then start Burrow again, or contact support.",
            dir.display()
        );
    }
    format!(
        "Burrow did not start because the folder {} already exists and is not a Burrow data folder ({}). Burrow did not change anything in it. Rename or move that folder, then start Burrow again, or contact support.",
        dir.display(),
        reason.text()
    )
}

/// `Link` for a symbolic link or junction (a name surrogate), `Reparse` for any other reparse point, `None` otherwise.
fn link_reason_of(is_symlink: bool, attributes: u32) -> Option<NotOursReason> {
    if is_symlink {
        Some(NotOursReason::Link)
    } else if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        Some(NotOursReason::Reparse)
    } else {
        None
    }
}

#[cfg(windows)]
fn link_reason(meta: &fs::Metadata) -> Option<NotOursReason> {
    use std::os::windows::fs::MetadataExt;
    link_reason_of(meta.file_type().is_symlink(), meta.file_attributes())
}

#[cfg(not(windows))]
fn link_reason(meta: &fs::Metadata) -> Option<NotOursReason> {
    link_reason_of(meta.file_type().is_symlink(), 0)
}

/// True when `meta` (from `symlink_metadata`) is a symbolic link, junction or any other reparse point.
pub(crate) fn is_link_or_reparse(meta: &fs::Metadata) -> bool {
    link_reason(meta).is_some()
}

fn marker_is_valid(dir: &Path) -> bool {
    let file = dir.join(MARKER_FILE);
    let Ok(meta) = fs::symlink_metadata(&file) else {
        return false;
    };
    if link_reason(&meta).is_some() || !meta.is_file() || meta.len() > MAX_MARKER_BYTES {
        return false;
    }
    let Ok(bytes) = fs::read(&file) else {
        return false;
    };
    marker_bytes_are_valid(&bytes)
}

/// [`marker_text_is_valid`] for the bytes of the file: a leading byte order mark and invalid UTF-8 are refused.
pub fn marker_bytes_are_valid(bytes: &[u8]) -> bool {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return false;
    }
    std::str::from_utf8(bytes).is_ok_and(marker_text_is_valid)
}

/// True when `text` is a marker this Burrow wrote: a JSON object with `app`, `edition` and `dataLocation` exactly
/// (case-sensitive), a string `createdAt` and `formatVersion` written as the integer `1` (`1.0` and `1e0` are refused).
/// Unknown fields are ignored; with a repeated key the last one counts.
pub fn marker_text_is_valid(text: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return false;
    };
    let field = |name: &str| value.get(name).and_then(serde_json::Value::as_str);
    field("app") == Some("Burrow")
        && field("edition") == Some("store")
        && field("dataLocation") == Some("userprofile")
        && field("createdAt").is_some()
        && value
            .get("formatVersion")
            .and_then(serde_json::Value::as_u64)
            == Some(MARKER_FORMAT_VERSION)
}

/// Looks at `dir` with `symlink_metadata` (a link is never followed) and says what it is. Reads only.
pub fn inspect(dir: &Path) -> Inspection {
    let meta = match fs::symlink_metadata(dir) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Inspection::Missing,
        Err(_) => return Inspection::Refused(NotOursReason::Unreadable),
    };
    if let Some(reason) = link_reason(&meta) {
        return Inspection::Refused(reason);
    }
    if !meta.is_dir() {
        return Inspection::Refused(NotOursReason::File);
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return Inspection::Refused(NotOursReason::Unreadable);
    };
    let mut has_marker = false;
    let mut any = false;
    for entry in entries {
        let Ok(entry) = entry else {
            return Inspection::Refused(NotOursReason::Unreadable);
        };
        any = true;
        if entry.file_name().to_string_lossy().to_lowercase() == MARKER_FILE {
            has_marker = true;
        }
    }
    match (any, has_marker) {
        (false, _) => Inspection::Empty,
        (true, false) => Inspection::Refused(NotOursReason::NotEmpty),
        (true, true) if marker_is_valid(dir) => Inspection::Marked,
        (true, true) => Inspection::Refused(NotOursReason::BadMarker),
    }
}

/// `YYYY-MM-DDTHH:MM:SS.000Z` for `secs` since the Unix epoch (proleptic Gregorian, UTC).
pub fn iso8601_utc(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Civil-from-days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.000Z",
        rem / 3_600,
        rem % 3_600 / 60,
        rem % 60
    )
}

fn marker_content(now: SystemTime) -> String {
    let secs = now.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let marker = serde_json::json!({
        "app": "Burrow",
        "edition": "store",
        "dataLocation": "userprofile",
        "createdAt": iso8601_utc(secs),
        "formatVersion": MARKER_FORMAT_VERSION,
    });
    let mut text = serde_json::to_string_pretty(&marker).unwrap_or_default();
    text.push('\n');
    text
}

fn write_marker(dir: &Path, now: SystemTime) -> std::io::Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dir.join(MARKER_FILE))?;
    file.write_all(marker_content(now).as_bytes())
}

/// The one decision: missing -> create with the marker, marked -> use, empty -> adopt (marker written), anything
/// else -> `Err(NotOurs)` with nothing written.
///
/// Creating is one atomic, non-recursive `create_dir`: the marker is written only into a folder this call just created, or
/// into one it saw empty (adopt). A missing parent, a denied write or a failed marker write is `CreateFailed`;
/// `AlreadyExists` means somebody else created the folder first, so it is inspected again like any existing folder.
/// Adopting an empty folder has an unavoidable window between "saw it empty" and the exclusive marker write.
pub fn ensure_owned(dir: &Path, now: SystemTime) -> Result<Outcome, NotOurs> {
    let refuse = |reason| NotOurs {
        dir: dir.to_path_buf(),
        reason,
    };
    let mut seen = inspect(dir);
    let mut outcome = Outcome::Marked;
    if seen == Inspection::Missing {
        match fs::create_dir(dir) {
            Ok(()) => outcome = Outcome::Created,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                seen = inspect(dir);
                if seen == Inspection::Missing {
                    return Err(refuse(NotOursReason::CreateFailed));
                }
            }
            Err(_) => return Err(refuse(NotOursReason::CreateFailed)),
        }
    }
    if let Inspection::Refused(reason) = seen {
        return Err(refuse(reason));
    }
    if outcome == Outcome::Created || seen == Inspection::Empty {
        if outcome != Outcome::Created {
            outcome = Outcome::Adopted;
        }
        match write_marker(dir, now) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => match inspect(dir) {
                Inspection::Marked => outcome = Outcome::Marked,
                Inspection::Refused(reason) => return Err(refuse(reason)),
                _ => return Err(refuse(NotOursReason::BadMarker)),
            },
            Err(_) => return Err(refuse(NotOursReason::CreateFailed)),
        }
    }
    Ok(outcome)
}

/// Shared by the tests of this module and of `lib.rs` (the startup plan): a temp folder and "byte-for-byte unchanged".
#[cfg(test)]
pub(crate) mod testing {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// A fresh folder under the OS temp dir, removed on drop.
    pub(crate) struct Temp(pub(crate) PathBuf);

    impl Temp {
        pub(crate) fn new() -> Self {
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let dir = std::env::temp_dir().join(format!(
                "burrow-guard-{}-{n}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_or(0, |d| d.as_nanos())
            ));
            fs::create_dir_all(&dir).unwrap();
            Temp(dir)
        }

        pub(crate) fn data(&self) -> PathBuf {
            self.0.join(USER_PROFILE_DATA_FOLDER)
        }
    }

    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// Every entry under `dir` with its bytes, sorted: equal before and after proves "byte-for-byte unchanged".
    pub(crate) fn snapshot(dir: &Path) -> Vec<(String, Option<Vec<u8>>)> {
        fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, Option<Vec<u8>>)>) {
            for entry in fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                let rel = path.strip_prefix(base).unwrap().display().to_string();
                if path.is_dir() {
                    out.push((rel, None));
                    walk(base, &path, out);
                } else {
                    out.push((rel, Some(fs::read(&path).unwrap())));
                }
            }
        }
        let mut out = Vec::new();
        walk(dir, dir, &mut out);
        out.sort();
        out
    }

    /// A junction (Windows) or symbolic link (elsewhere) at `link` pointing to `target`; false when it cannot be made.
    #[cfg(unix)]
    pub(crate) fn make_link(target: &Path, link: &Path) -> bool {
        std::os::unix::fs::symlink(target, link).is_ok()
    }

    #[cfg(windows)]
    pub(crate) fn make_link(target: &Path, link: &Path) -> bool {
        std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::testing::{make_link, snapshot, Temp};
    use super::*;
    use base64::Engine;

    const NOW: SystemTime = UNIX_EPOCH;

    /// Puts something in an otherwise empty folder.
    type Filler = fn(&Path);

    /// The cases of `server/__tests__/fixtures/markers.json`: (name, bytes, valid).
    fn marker_cases() -> Vec<(String, Vec<u8>, bool)> {
        let doc: serde_json::Value =
            serde_json::from_str(include_str!("../../server/__tests__/fixtures/markers.json"))
                .unwrap();
        doc["cases"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| {
                let bytes = match (c.get("text"), c.get("base64")) {
                    (Some(t), None) => t.as_str().unwrap().as_bytes().to_vec(),
                    (None, Some(b)) => base64::engine::general_purpose::STANDARD
                        .decode(b.as_str().unwrap())
                        .unwrap(),
                    _ => panic!("a case needs exactly one of text and base64"),
                };
                (
                    c["name"].as_str().unwrap().to_string(),
                    bytes,
                    c["valid"].as_bool().unwrap(),
                )
            })
            .collect()
    }

    #[test]
    fn the_constants_match_the_server() {
        assert_eq!(USER_PROFILE_DATA_FOLDER, "Burrow Data");
        assert_eq!(MARKER_FILE, ".burrow-data.json");
        assert_eq!(EXIT_DATA_DIR_NOT_OURS, 5);
    }

    #[test]
    fn iso_timestamps_are_correct() {
        assert_eq!(iso8601_utc(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso8601_utc(951_782_400), "2000-02-29T00:00:00.000Z");
        assert_eq!(iso8601_utc(1_791_460_800), "2026-10-08T12:00:00.000Z");
    }

    #[test]
    fn the_shared_marker_fixture_agrees_with_the_shell() {
        let cases = marker_cases();
        assert!(cases.len() >= 30, "the fixture lost cases");
        for (name, bytes, valid) in cases {
            assert_eq!(marker_bytes_are_valid(&bytes), valid, "bytes: {name}");
            // The same bytes as a file in a folder: a valid marker makes it ours, anything else is refused as bad_marker.
            let t = Temp::new();
            let dir = t.data();
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join(MARKER_FILE), &bytes).unwrap();
            let expected = if valid {
                Inspection::Marked
            } else {
                Inspection::Refused(NotOursReason::BadMarker)
            };
            assert_eq!(inspect(&dir), expected, "folder: {name}");
        }
    }

    #[test]
    fn a_missing_folder_is_created_with_the_marker() {
        let t = Temp::new();
        let dir = t.data();
        assert_eq!(ensure_owned(&dir, NOW), Ok(Outcome::Created));
        let names: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec![MARKER_FILE.to_string()]);
        let text = fs::read_to_string(dir.join(MARKER_FILE)).unwrap();
        assert!(marker_text_is_valid(&text));
        assert!(text.contains("\"createdAt\": \"1970-01-01T00:00:00.000Z\""));
        assert_eq!(inspect(&dir), Inspection::Marked);
    }

    #[test]
    fn a_missing_parent_is_not_created_and_is_reported_as_a_create_failure() {
        let t = Temp::new();
        let parent = t.0.join("no-such-parent");
        let dir = parent.join(USER_PROFILE_DATA_FOLDER);
        let err = ensure_owned(&dir, NOW).unwrap_err();
        assert_eq!(err.reason, NotOursReason::CreateFailed);
        assert!(!parent.exists(), "create_dir must not be recursive");
        let message = err.message();
        assert!(message.contains("could not create or mark its data folder"));
        assert!(!message.contains("already exists"));
    }

    #[test]
    fn a_marked_folder_is_used_unchanged() {
        let t = Temp::new();
        let dir = t.data();
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(MARKER_FILE), marker_content(NOW)).unwrap();
        fs::write(dir.join("burrow.db"), b"data").unwrap();
        let before = snapshot(&dir);
        assert_eq!(ensure_owned(&dir, NOW), Ok(Outcome::Marked));
        assert_eq!(snapshot(&dir), before);
    }

    #[test]
    fn an_empty_folder_is_adopted() {
        let t = Temp::new();
        let dir = t.data();
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(ensure_owned(&dir, NOW), Ok(Outcome::Adopted));
        assert_eq!(inspect(&dir), Inspection::Marked);
    }

    #[test]
    fn an_unmarked_non_empty_folder_is_refused_and_left_byte_for_byte_unchanged() {
        let fillers: [(&str, Filler); 5] = [
            ("visible file", |d| {
                fs::write(d.join("readme.txt"), b"x").unwrap()
            }),
            ("hidden file", |d| {
                fs::write(d.join(".hidden"), b"x").unwrap()
            }),
            (".git folder", |d| fs::create_dir(d.join(".git")).unwrap()),
            ("burrow.db without a marker", |d| {
                fs::write(d.join("burrow.db"), b"x").unwrap()
            }),
            ("desktop.ini with the system and hidden attributes", |d| {
                let ini = d.join("desktop.ini");
                fs::write(&ini, b"[.ShellClassInfo]\r\n").unwrap();
                #[cfg(windows)]
                {
                    let done = std::process::Command::new("attrib")
                        .args(["+s", "+h"])
                        .arg(&ini)
                        .output()
                        .map(|o| o.status.success())
                        .unwrap_or(false);
                    assert!(done, "attrib +s +h failed");
                }
            }),
        ];
        for (label, fill) in fillers {
            let t = Temp::new();
            let dir = t.data();
            fs::create_dir_all(&dir).unwrap();
            fill(&dir);
            let before = snapshot(&dir);
            let err = ensure_owned(&dir, NOW).unwrap_err();
            assert_eq!(err.reason, NotOursReason::NotEmpty, "{label}");
            assert_eq!(snapshot(&dir), before, "{label}");
            assert!(!dir.join(MARKER_FILE).exists(), "{label}");
            let message = err.message();
            assert!(message.contains(&dir.display().to_string()));
            assert!(message.contains("did not change anything"));
        }
    }

    #[test]
    fn a_file_at_the_path_is_refused() {
        let t = Temp::new();
        let path = t.data();
        fs::write(&path, b"i am a file").unwrap();
        assert_eq!(
            ensure_owned(&path, NOW).unwrap_err().reason,
            NotOursReason::File
        );
        assert_eq!(fs::read(&path).unwrap(), b"i am a file");
    }

    #[test]
    fn a_junction_or_symlink_is_refused_even_to_a_marked_folder_and_is_not_followed() {
        let t = Temp::new();
        let real = t.0.join("real");
        fs::create_dir_all(&real).unwrap();
        fs::write(real.join(MARKER_FILE), marker_content(NOW)).unwrap();
        let link = t.data();
        if !make_link(&real, &link) {
            eprintln!("SKIPPED: could not create a junction or symbolic link here");
            return;
        }
        assert_eq!(
            ensure_owned(&link, NOW).unwrap_err().reason,
            NotOursReason::Link
        );
        assert_eq!(fs::read_dir(&real).unwrap().count(), 1);
    }

    #[test]
    fn a_dangling_junction_or_symlink_is_refused_not_treated_as_missing() {
        let t = Temp::new();
        let real = t.0.join("real");
        fs::create_dir_all(&real).unwrap();
        let link = t.data();
        if !make_link(&real, &link) {
            eprintln!("SKIPPED: could not create a junction or symbolic link here");
            return;
        }
        fs::remove_dir(&real).unwrap();
        assert!(!real.exists());
        assert_eq!(
            ensure_owned(&link, NOW).unwrap_err().reason,
            NotOursReason::Link
        );
        assert!(
            !real.exists(),
            "the target must not be created through the link"
        );
    }

    #[test]
    fn other_reparse_points_are_told_apart_from_links() {
        assert_eq!(link_reason_of(true, 0), Some(NotOursReason::Link));
        assert_eq!(link_reason_of(true, 0x400), Some(NotOursReason::Link));
        assert_eq!(link_reason_of(false, 0x400), Some(NotOursReason::Reparse));
        assert_eq!(
            link_reason_of(false, 0x10 | 0x400),
            Some(NotOursReason::Reparse)
        );
        assert_eq!(link_reason_of(false, 0x10), None);
        assert_eq!(link_reason_of(false, 0), None);
    }

    #[test]
    fn a_corrupt_marker_is_refused_and_not_repaired() {
        for text in ["{nope", "", "{\"app\":\"Other\"}", "[]"] {
            let t = Temp::new();
            let dir = t.data();
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join(MARKER_FILE), text).unwrap();
            let err = ensure_owned(&dir, NOW).unwrap_err();
            assert_eq!(err.reason, NotOursReason::BadMarker, "{text}");
            assert_eq!(fs::read_to_string(dir.join(MARKER_FILE)).unwrap(), text);
        }
    }

    #[test]
    fn a_marker_that_is_a_folder_or_too_big_is_refused() {
        let t = Temp::new();
        let dir = t.data();
        fs::create_dir_all(dir.join(MARKER_FILE)).unwrap();
        assert_eq!(inspect(&dir), Inspection::Refused(NotOursReason::BadMarker));
        fs::remove_dir(dir.join(MARKER_FILE)).unwrap();
        fs::write(
            dir.join(MARKER_FILE),
            format!("{}{}", " ".repeat(5000), marker_content(NOW)),
        )
        .unwrap();
        assert_eq!(inspect(&dir), Inspection::Refused(NotOursReason::BadMarker));
    }

    #[test]
    fn a_wrongly_cased_marker_name_is_the_marker_where_the_folder_ignores_case() {
        let t = Temp::new();
        let dir = t.data();
        fs::create_dir_all(&dir).unwrap();
        let odd = dir.join(".Burrow-Data.json");
        fs::write(&odd, marker_content(NOW)).unwrap();
        // NTFS (and APFS by default) treat the two names as one file; a case-sensitive folder does not.
        let same_file = dir.join(MARKER_FILE).exists();
        let expected = if same_file {
            Inspection::Marked
        } else {
            Inspection::Refused(NotOursReason::BadMarker)
        };
        assert_eq!(inspect(&dir), expected);
        let before = snapshot(&dir);
        if !same_file {
            assert!(ensure_owned(&dir, NOW).is_err());
            assert_eq!(snapshot(&dir), before);
        } else {
            assert_eq!(ensure_owned(&dir, NOW), Ok(Outcome::Marked));
            assert_eq!(snapshot(&dir), before);
        }
    }

    #[test]
    fn the_server_and_the_shell_say_the_same_thing() {
        let dir = Path::new("C:\\Users\\example\\Burrow Data");
        assert_eq!(
            not_ours_message(dir, NotOursReason::NotEmpty),
            "Burrow did not start because the folder C:\\Users\\example\\Burrow Data already exists and is not a Burrow data folder (it already holds other files). Burrow did not change anything in it. Rename or move that folder, then start Burrow again, or contact support."
        );
        assert_eq!(
            not_ours_message(dir, NotOursReason::Link),
            "Burrow did not start because the folder C:\\Users\\example\\Burrow Data already exists and is not a Burrow data folder (it is a shortcut, symbolic link or junction). Burrow did not change anything in it. Rename or move that folder, then start Burrow again, or contact support."
        );
        assert_eq!(
            not_ours_message(dir, NotOursReason::Reparse),
            "Burrow did not start because the folder C:\\Users\\example\\Burrow Data already exists and is not a Burrow data folder (it is a cloud or other special folder (reparse point)). Burrow did not change anything in it. Rename or move that folder, then start Burrow again, or contact support."
        );
        assert_eq!(
            not_ours_message(dir, NotOursReason::CreateFailed),
            "Burrow did not start because it could not create or mark its data folder C:\\Users\\example\\Burrow Data. Check that the folder above it exists and that you can write to it, then start Burrow again, or contact support."
        );
    }
}
