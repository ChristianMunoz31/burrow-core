//! Where webview downloads (the Export button's blob download) are saved.

use std::path::{Path, PathBuf};

const FALLBACK_NAME: &str = "burrow-download";

const MAX_STEM_CHARS: usize = 200;
const MAX_EXT_CHARS: usize = 32;
const RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Invisible formatting characters (Unicode category Cf) that can disguise a file name.
fn is_format_char(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}'
            | '\u{061C}'
            | '\u{180E}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{206F}'
            | '\u{FEFF}'
            | '\u{FFF9}'..='\u{FFFB}'
    )
}

fn trim_name(s: &str) -> &str {
    s.trim_matches(|c: char| c == '.' || c.is_whitespace())
}

/// Strips any directory part, characters Windows rejects, invisible format characters, trailing
/// dots and spaces, and Windows device names; caps the length while keeping the extension.
pub fn sanitize_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .filter(|c| !is_format_char(*c))
        .map(|c| {
            if c.is_control() || "<>:\"|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = trim_name(&cleaned);
    if trimmed.is_empty() {
        return FALLBACK_NAME.to_string();
    }
    let (stem, ext) = match trimmed.rfind('.') {
        Some(i) if i > 0 => (&trimmed[..i], &trimmed[i..]),
        _ => (trimmed, ""),
    };
    let stem: String = stem.chars().take(MAX_STEM_CHARS).collect();
    let ext: String = ext.chars().take(MAX_EXT_CHARS).collect();
    let stem = stem.trim_end_matches(|c: char| c == '.' || c.is_whitespace());
    let mut out = format!("{stem}{ext}");
    let device = out.split('.').next().unwrap_or("").trim_end();
    if RESERVED.iter().any(|r| device.eq_ignore_ascii_case(r)) {
        out.insert(0, '_');
    }
    let out = trim_name(&out);
    if out.is_empty() {
        FALLBACK_NAME.to_string()
    } else {
        out.to_string()
    }
}

/// `dir/name`, or `dir/name (1).ext`, `name (2).ext`, ... if taken.
pub fn unique_path(dir: &Path, name: &str, exists: impl Fn(&Path) -> bool) -> PathBuf {
    let first = dir.join(name);
    if !exists(&first) {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (1u32..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !exists(p))
        .unwrap_or(first)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_names() {
        assert_eq!(sanitize_file_name("burrow-export.zip"), "burrow-export.zip");
        assert_eq!(sanitize_file_name("..\\..\\evil.zip"), "evil.zip");
        assert_eq!(sanitize_file_name("a:b?.zip"), "a_b_.zip");
        assert_eq!(sanitize_file_name(""), FALLBACK_NAME);
        assert_eq!(sanitize_file_name("..."), FALLBACK_NAME);
    }

    #[test]
    fn prefixes_windows_device_names() {
        for n in [
            "CON",
            "con.txt",
            "Prn.tar.gz",
            "AUX",
            "nul.",
            "COM1",
            "lpt9.zip",
            "COM5 .txt",
        ] {
            assert!(sanitize_file_name(n).starts_with('_'), "{n}");
        }
        assert_eq!(sanitize_file_name("CON.txt"), "_CON.txt");
        assert_eq!(sanitize_file_name("COM10.txt"), "COM10.txt");
        assert_eq!(sanitize_file_name("console.txt"), "console.txt");
    }

    #[test]
    fn trims_trailing_dots_and_spaces_in_a_loop() {
        assert_eq!(sanitize_file_name("a. . ."), "a");
        assert_eq!(sanitize_file_name("a.zip . "), "a.zip");
        assert_eq!(sanitize_file_name("name .zip"), "name.zip");
    }

    #[test]
    fn caps_the_stem_and_keeps_the_extension() {
        let got = sanitize_file_name(&format!("{}.zip", "a".repeat(400)));
        assert_eq!(got.chars().count(), 204);
        assert!(got.ends_with(".zip"));
    }

    #[test]
    fn strips_bidi_and_format_characters() {
        assert_eq!(sanitize_file_name("a\u{202E}piz.exe"), "apiz.exe");
        assert_eq!(
            sanitize_file_name("\u{200E}x\u{2066}y\u{2069}\u{200F}.txt"),
            "xy.txt"
        );
        assert_eq!(sanitize_file_name("a\u{FEFF}b\u{0007}c.txt"), "ab_c.txt");
    }

    #[test]
    fn dedupes_with_a_counter() {
        let dir = Path::new("D");
        let taken = [dir.join("a.zip"), dir.join("a (1).zip")];
        let got = unique_path(dir, "a.zip", |p| taken.iter().any(|t| t == p));
        assert_eq!(got, dir.join("a (2).zip"));
        assert_eq!(unique_path(dir, "b.zip", |_| false), dir.join("b.zip"));
        let noext = unique_path(dir, "readme", |p| p == dir.join("readme"));
        assert_eq!(noext, dir.join("readme (1)"));
    }
}
