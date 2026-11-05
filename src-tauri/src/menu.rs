//! Native menu: File (Add a folder..., Quit), Edit (clipboard, needed on macOS) and Help (data folder, export, report content, check for updates, about).
//! The About box names the channel (Burrow or Burrow Dev) and shows the display version.

use crate::channel::{display_version, Channel};
use tauri::menu::{AboutMetadataBuilder, Menu, MenuBuilder, SubmenuBuilder};
use tauri::{AppHandle, Runtime};

/// File > Add a folder...: opens the Folders page, which starts the folder picker (the shell never opens it by itself).
pub const ADD_FOLDER_ID: &str = "add-folder";
/// Label of File > Add a folder...
pub const ADD_FOLDER_LABEL: &str = "Add a folder...";
/// Help > Open data folder.
pub const OPEN_DATA_ID: &str = "open-data-folder";
/// Help > Export my data.
pub const EXPORT_DATA_ID: &str = "export-data";
/// Help > Report content... (Store policy 11.16): opens the default mail app with an empty template.
pub const REPORT_CONTENT_ID: &str = "report-content";

/// Help > Check for updates...: only opens Settings > Updates in the window; no network call, no IPC.
pub const CHECK_UPDATES_ID: &str = "check-updates";

/// Where reports go. Must equal `supportContact` in config/store.json (a unit test checks it).
const SUPPORT_EMAIL: &str = "burrowsupport@gmail.com";
const REPORT_SUBJECT: &str = "Burrow: report AI content";
/// A template with no user data: nothing from the app is added to it.
const REPORT_BODY: &str = "Describe what Javi said that was inappropriate. Paste the text here only if you want to share it.";

/// Percent-encodes everything except RFC 3986 unreserved characters (a space is `%20`, never `+`).
fn encode_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for b in value.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The `mailto:` link behind Help > Report content. Sending anything is up to the user in their mail app.
pub fn report_content_url() -> String {
    format!(
        "mailto:{SUPPORT_EMAIL}?subject={}&body={}",
        encode_component(REPORT_SUBJECT),
        encode_component(REPORT_BODY)
    )
}

fn about_label(channel: Channel) -> &'static str {
    match channel {
        Channel::Stable => "About Burrow",
        Channel::Dev => "About Burrow Dev",
    }
}

fn about_comments(channel: Channel) -> &'static str {
    match channel {
        Channel::Stable => {
            "Private, local-first budget and journal tracker. Core source under AGPL-3.0-only at github.com/ChristianMunoz31/burrow-core."
        }
        Channel::Dev => {
            "Dev build. Private, local-first budget and journal tracker. Core source under AGPL-3.0-only at github.com/ChristianMunoz31/burrow-core."
        }
    }
}

/// Builds the application menu.
pub fn build<R: Runtime>(app: &AppHandle<R>, channel: Channel) -> tauri::Result<Menu<R>> {
    let file = SubmenuBuilder::new(app, "File")
        .text(ADD_FOLDER_ID, ADD_FOLDER_LABEL)
        .separator()
        .quit()
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let about = AboutMetadataBuilder::new()
        .name(Some(channel.product_name()))
        .version(Some(display_version(
            channel,
            &app.package_info().version.to_string(),
        )))
        .comments(Some(about_comments(channel)))
        .build();
    let help = SubmenuBuilder::new(app, "Help")
        .text(OPEN_DATA_ID, "Open data folder")
        .text(EXPORT_DATA_ID, "Export my data")
        .text(REPORT_CONTENT_ID, "Report content...")
        .separator()
        .text(CHECK_UPDATES_ID, "Check for updates...")
        .about_with_text(about_label(channel), Some(about))
        .build()?;
    MenuBuilder::new(app).items(&[&file, &edit, &help]).build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_file_menu_offers_add_a_folder() {
        assert_eq!(ADD_FOLDER_LABEL, "Add a folder...");
        assert_eq!(ADD_FOLDER_ID, "add-folder");
        assert!(!ADD_FOLDER_LABEL.contains('\u{2014}') && !ADD_FOLDER_LABEL.contains('\u{2013}'));
    }

    #[test]
    fn menu_ids_are_distinct() {
        let ids = [
            ADD_FOLDER_ID,
            OPEN_DATA_ID,
            EXPORT_DATA_ID,
            REPORT_CONTENT_ID,
            CHECK_UPDATES_ID,
        ];
        for (i, a) in ids.iter().enumerate() {
            for b in &ids[i + 1..] {
                assert_ne!(a, b);
            }
        }
        assert_eq!(CHECK_UPDATES_ID, "check-updates");
    }

    #[test]
    fn about_copy_names_the_channel() {
        assert_eq!(about_label(Channel::Stable), "About Burrow");
        assert_eq!(about_label(Channel::Dev), "About Burrow Dev");
        assert_eq!(
            about_comments(Channel::Stable),
            "Private, local-first budget and journal tracker. Core source under AGPL-3.0-only at github.com/ChristianMunoz31/burrow-core."
        );
        assert_eq!(
            about_comments(Channel::Dev),
            "Dev build. Private, local-first budget and journal tracker. Core source under AGPL-3.0-only at github.com/ChristianMunoz31/burrow-core."
        );
    }

    #[test]
    fn report_url_is_an_encoded_mailto_with_no_user_data() {
        let url = report_content_url();
        assert_eq!(
            url,
            format!(
                "mailto:{SUPPORT_EMAIL}?subject=Burrow%3A%20report%20AI%20content&body={}",
                encode_component(REPORT_BODY)
            )
        );
        assert!(url.starts_with("mailto:"));
        assert!(!url.contains(' ') && !url.contains('+'));
        let parsed = url::Url::parse(&url).unwrap();
        assert_eq!(parsed.scheme(), "mailto");
        let pairs: Vec<(String, String)> = parsed
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        assert_eq!(pairs[0], ("subject".into(), REPORT_SUBJECT.into()));
        assert_eq!(pairs[1], ("body".into(), REPORT_BODY.into()));
        assert_eq!(pairs.len(), 2);
        assert_eq!(
            crate::nav::classify(&parsed, 5000),
            crate::nav::NavDecision::External
        );
    }

    #[test]
    fn encoding_escapes_reserved_and_non_ascii_bytes() {
        assert_eq!(
            encode_component("a&b=c?d#e é"),
            "a%26b%3Dc%3Fd%23e%20%C3%A9"
        );
        assert_eq!(encode_component("Az09-_.~"), "Az09-_.~");
    }

    #[test]
    fn support_address_matches_config_store_json() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../config/store.json");
        let raw = std::fs::read_to_string(path).unwrap();
        let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(json["supportContact"].as_str(), Some(SUPPORT_EMAIL));
    }
}
