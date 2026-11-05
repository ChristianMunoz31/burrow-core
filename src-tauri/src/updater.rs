//! Opt-in in-app updates (stable channel only).
//!
//! The server asks for an update with one authenticated stdout line:
//! `BURROW_UPDATE_REQUEST {"v":1,"version":"x.y.z","nonce":"<32 hex>","mac":"<64 hex>"}`.
//! `mac = hex(HMAC-SHA256(updateKey, "burrow-update-v1\n" + version + "\n" + nonce))` where
//! `updateKey = HMAC-SHA256(secret, "burrow-update-key-v1")` (see `secret::update_mac_key`).
//! Everything that matters is re-derived here from the shell's own baked config: the endpoint and the
//! public key come from `plugins.updater` (release overlay only), the installer URL is pinned
//! exactly, and the plugin verifies the minisign signature before anything is installed.
//!
//! Order: check, pin the URL and version, download and verify, show `splash/updating.html`, stop the
//! sidecar gracefully, install. `install()` exits the process on Windows, so the stop comes first.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::Sha256;
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Error as UpdaterError, Update, UpdaterExt};

use crate::channel::{Channel, Distribution};
use crate::sidecar::log_line;
use crate::{
    error_page, mark_shutting_down, navigate_main, settings_url, splash_url, AppState, MAIN_LABEL,
    SHUTDOWN_GRACE,
};

/// Prefix of the stdout line the server uses to ask for an update.
pub const REQUEST_PREFIX: &str = "BURROW_UPDATE_REQUEST ";

/// Placeholder in `tauri.release.conf.json` until the owner pastes a real public key.
pub const PUBKEY_PLACEHOLDER: &str = "BURROW_UPDATER_PUBKEY_PLACEHOLDER";

const MAC_MESSAGE_PREFIX: &str = "burrow-update-v1\n";
/// Longest request payload the shell looks at (the real one is about 180 bytes).
const MAX_PAYLOAD_BYTES: usize = 512;
/// Longest accepted number in a version (keeps comparisons and URLs sane).
const MAX_VERSION_PART_DIGITS: usize = 9;
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const MAX_REDIRECT_HOPS: usize = 5;
const REDIRECT_HOSTS: [&str; 3] = [
    "github.com",
    "release-assets.githubusercontent.com",
    "objects.githubusercontent.com",
];
const RELEASE_BASE: &str = "https://github.com/ChristianMunoz31/burrow-releases/releases/download";

/// A format-checked update request. The MAC is private: only [`verify_mac`] reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateRequest {
    pub version: String,
    pub nonce: String,
    mac: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Wire {
    v: u64,
    version: String,
    nonce: String,
    mac: String,
}

fn is_lower_hex(text: &str, len: usize) -> bool {
    text.len() == len && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Strict stable semver: `x.y.z`, no prerelease, no leading zeros.
fn is_stable_version(version: &str) -> bool {
    let parts: Vec<&str> = version.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|p| {
            !p.is_empty()
                && p.len() <= MAX_VERSION_PART_DIGITS
                && p.bytes().all(|b| b.is_ascii_digit())
                && (*p == "0" || !p.starts_with('0'))
        })
}

/// Format checks only (prefix, exact keys, shapes). Authenticity is [`verify_mac`].
pub fn parse_update_request(line: &str) -> Option<UpdateRequest> {
    let payload = line
        .trim_end_matches(['\r', '\n'])
        .strip_prefix(REQUEST_PREFIX)?;
    if payload.len() > MAX_PAYLOAD_BYTES || !payload.starts_with('{') || !payload.ends_with('}') {
        return None;
    }
    let wire: Wire = serde_json::from_str(payload).ok()?;
    (wire.v == 1
        && is_stable_version(&wire.version)
        && is_lower_hex(&wire.nonce, 32)
        && is_lower_hex(&wire.mac, 64))
    .then_some(UpdateRequest {
        version: wire.version,
        nonce: wire.nonce,
        mac: wire.mac,
    })
}

fn from_hex(text: &str) -> Option<Vec<u8>> {
    if text.len() % 2 != 0 {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok())
        .collect()
}

/// Constant-time check of the request MAC against `update_key`.
pub fn verify_mac(update_key: &[u8; 32], req: &UpdateRequest) -> bool {
    let Some(expected) = from_hex(&req.mac) else {
        return false;
    };
    let Ok(mut mac) = <Hmac<Sha256> as Mac>::new_from_slice(update_key) else {
        return false;
    };
    mac.update(MAC_MESSAGE_PREFIX.as_bytes());
    mac.update(req.version.as_bytes());
    mac.update(b"\n");
    mac.update(req.nonce.as_bytes());
    mac.verify_slice(&expected).is_ok()
}

/// A real minisign public key: base64 of a text whose second line is base64 of 42 bytes `Ed` + id + key.
fn is_valid_minisign_pubkey(pubkey: &str) -> bool {
    let Ok(text) = STANDARD.decode(pubkey.trim()) else {
        return false;
    };
    let Ok(text) = String::from_utf8(text) else {
        return false;
    };
    let Some(line) = text.lines().nth(1) else {
        return false;
    };
    STANDARD
        .decode(line.trim())
        .is_ok_and(|raw| raw.len() == 42 && raw.starts_with(b"Ed"))
}

/// The updater is on only for the stable channel of the direct distribution with a real public key in
/// `plugins.updater`. The Microsoft Store build never enables it: the Store delivers its updates, whatever
/// the config holds. Mirrors `isUpdaterEnabled` in `scripts/release/updaterConfig.js`.
pub fn should_enable(
    channel: Channel,
    distribution: Distribution,
    updater_cfg: Option<&serde_json::Value>,
) -> bool {
    if channel != Channel::Stable || distribution != Distribution::Direct {
        return false;
    }
    updater_cfg
        .and_then(|cfg| cfg.get("pubkey"))
        .and_then(serde_json::Value::as_str)
        .is_some_and(|key| key != PUBKEY_PLACEHOLDER && is_valid_minisign_pubkey(key))
}

fn arch_label() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    }
}

fn installer_url_for(version: &str, arch: &str) -> String {
    format!("{RELEASE_BASE}/v{version}/Burrow-Setup-{arch}.exe")
}

/// True only for the exact pinned installer URL of `version` for this machine's architecture.
pub fn installer_url_allowed(url: &Url, version: &str) -> bool {
    is_stable_version(version) && url.as_str() == installer_url_for(version, arch_label())
}

/// Redirect target rule for every update request: https, no userinfo or port, an allowlisted host.
pub fn redirect_allowed(url: &Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url
            .host_str()
            .is_some_and(|host| REDIRECT_HOSTS.contains(&host))
}

/// `previous` is the number of redirects already followed plus the first URL.
fn follow_redirect(url: &Url, previous: usize) -> bool {
    previous <= MAX_REDIRECT_HOPS && redirect_allowed(url)
}

/// Why an update did not happen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateFailure {
    NotOffered,
    Mismatch,
    Download,
    Verify,
    Install,
}

/// Native dialog (title, message) for a failure.
pub fn failure_dialog(failure: UpdateFailure) -> (&'static str, &'static str) {
    match failure {
        UpdateFailure::NotOffered => (
            "No update to install",
            "Burrow couldn't find that update on GitHub. Nothing was installed. Check again from Settings > Updates.",
        ),
        UpdateFailure::Mismatch => (
            "Update changed",
            "The update on GitHub is not the one you chose. Nothing was installed. Check again from Settings > Updates to see the current update.",
        ),
        UpdateFailure::Download => (
            "Update not downloaded",
            "Burrow couldn't download the update. Nothing was installed and your data is unchanged. Check your internet connection and try again from Settings > Updates.",
        ),
        UpdateFailure::Verify => (
            "Update not installed",
            "The downloaded update failed Burrow's signature check, so it was not installed. Your data is unchanged. Try again later, and tell us if this keeps happening.",
        ),
        UpdateFailure::Install => (
            "Update not installed",
            "Burrow couldn't start the installer. Your data is safe and a backup was saved. Burrow will close now; open it again to keep using this version.",
        ),
    }
}

fn classify_download_error(error: &UpdaterError) -> UpdateFailure {
    match error {
        UpdaterError::Minisign(_)
        | UpdaterError::Base64(_)
        | UpdaterError::SignatureUtf8(_)
        | UpdaterError::SignedVersionMismatch { .. }
        | UpdaterError::MissingSignedVersion => UpdateFailure::Verify,
        _ => UpdateFailure::Download,
    }
}

/// Why a well-formed, authentic request was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    Replay,
    InFlight,
}

impl Refusal {
    fn reason(self) -> &'static str {
        match self {
            Refusal::Replay => "nonce already used",
            Refusal::InFlight => "an update is already in progress",
        }
    }
}

/// Single-use nonces and the one-update-at-a-time flag.
#[derive(Default)]
pub struct UpdateGuard {
    seen: Mutex<HashSet<String>>,
    in_flight: AtomicBool,
}

impl UpdateGuard {
    /// Claims the nonce and the in-flight slot. Call only for an authenticated request, so a forged
    /// line can never fill the set.
    pub fn begin(&self, nonce: &str) -> Result<(), Refusal> {
        let mut seen = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        if seen.contains(nonce) {
            return Err(Refusal::Replay);
        }
        if self.in_flight.swap(true, Ordering::SeqCst) {
            return Err(Refusal::InFlight);
        }
        seen.insert(nonce.to_string());
        Ok(())
    }

    /// Frees the in-flight slot after a failure before the install step.
    pub fn finish(&self) {
        self.in_flight.store(false, Ordering::SeqCst);
    }
}

/// Validates and starts an update request from the server. Every refusal is a log line only.
pub fn dispatch(app: &AppHandle, req: UpdateRequest) {
    let state = app.state::<AppState>();
    let ignore = |reason: &str| {
        log_line(
            &state.log,
            "shell",
            &format!("ignored an update request ({reason})"),
        );
    };
    if state.channel != Channel::Stable || !state.updater_enabled {
        ignore("updates are not enabled in this build");
        return;
    }
    let key = state.update_key.lock().ok().and_then(|k| *k);
    let Some(key) = key else {
        ignore("no key");
        return;
    };
    if !verify_mac(&key, &req) {
        ignore("authentication failed");
        return;
    }
    if let Err(refusal) = state.update_guard.begin(&req.nonce) {
        ignore(refusal.reason());
        return;
    }
    log_line(
        &state.log,
        "shell",
        &format!("update to {} requested", req.version),
    );
    let app = app.clone();
    tauri::async_runtime::spawn(async move { run(app, req).await });
}

async fn run(app: AppHandle, req: UpdateRequest) {
    match fetch_verified(&app, &req).await {
        Ok((update, bytes)) => install(app, update, bytes).await,
        Err(failure) => fail_and_reload(&app, failure).await,
    }
}

/// Steps 5 to 7: check, pin, download and verify the signature. Nothing is stopped yet.
async fn fetch_verified(
    app: &AppHandle,
    req: &UpdateRequest,
) -> Result<(Update, Vec<u8>), UpdateFailure> {
    let log = app.state::<AppState>().log.clone();
    let note = |text: &str| log_line(&log, "shell", text);
    let updater = app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        .restart_after_install(true)
        .configure_client(|client| {
            client.redirect(reqwest::redirect::Policy::custom(|attempt| {
                if follow_redirect(attempt.url(), attempt.previous().len()) {
                    attempt.follow()
                } else {
                    attempt.error("redirect not allowed")
                }
            }))
        })
        .build()
        .map_err(|e| {
            note(&format!("update: could not set up the updater ({e})"));
            UpdateFailure::NotOffered
        })?;
    let mut update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => {
            note("update: no newer version is offered");
            return Err(UpdateFailure::NotOffered);
        }
        Err(e) => {
            note(&format!("update: the check failed ({e})"));
            return Err(UpdateFailure::Download);
        }
    };
    if update.version != req.version {
        note(&format!(
            "update: GitHub offers {} but {} was requested",
            update.version, req.version
        ));
        return Err(UpdateFailure::Mismatch);
    }
    if !installer_url_allowed(&update.download_url, &update.version) {
        note("update: the installer URL is not the pinned release URL");
        return Err(UpdateFailure::NotOffered);
    }
    update.timeout = Some(DOWNLOAD_TIMEOUT);
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| {
        let failure = classify_download_error(&e);
        note(&format!("update: download failed ({failure:?}): {e}"));
        failure
    })?;
    note("update: downloaded and signature verified");
    Ok((update, bytes))
}

/// Steps 8 to 10: splash page, graceful sidecar stop, installer. On Windows `install` exits the app.
async fn install(app: AppHandle, update: Update, bytes: Vec<u8>) {
    let state = app.state::<AppState>();
    if let Some(url) = splash_url("updating.html") {
        navigate_main(&app, url);
    }
    mark_shutting_down(&app);
    let sidecar = state.sidecar.lock().ok().and_then(|mut s| s.take());
    if let Some(sidecar) = sidecar {
        let _ =
            tauri::async_runtime::spawn_blocking(move || sidecar.shutdown(SHUTDOWN_GRACE)).await;
    }
    state.port.store(0, Ordering::SeqCst);
    log_line(&state.log, "shell", "update: server stopped, installing");
    if let Err(e) = update.install(&bytes) {
        log_line(
            &state.log,
            "shell",
            &format!("update: the installer did not start ({e})"),
        );
        show_failure(&app, UpdateFailure::Install).await;
    }
    app.exit(0);
}

async fn fail_and_reload(app: &AppHandle, failure: UpdateFailure) {
    let state = app.state::<AppState>();
    state.update_guard.finish();
    show_failure(app, failure).await;
    let port = state.port.load(Ordering::SeqCst);
    match settings_url(port, "updates") {
        Some(url) => navigate_main(app, url),
        None => error_page(app),
    }
}

async fn show_failure(app: &AppHandle, failure: UpdateFailure) {
    let (title, message) = failure_dialog(failure);
    let app = app.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        let mut builder = app
            .dialog()
            .message(message)
            .title(title)
            .kind(MessageDialogKind::Error)
            .buttons(MessageDialogButtons::Ok);
        if let Some(window) = app.get_webview_window(MAIN_LABEL) {
            builder = builder.parent(&window);
        }
        builder.blocking_show();
    })
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONCE: &str = "00112233445566778899aabbccddeeff";
    const VECTOR_MAC: &str = "131a3fcae49bf067678e9c40618722760ecf5b9b32a68568b4ef2eada010a9a2";

    fn key() -> [u8; 32] {
        let mut secret = [0u8; 32];
        for (i, b) in secret.iter_mut().enumerate() {
            *b = i as u8;
        }
        crate::secret::update_mac_key(&secret)
    }

    fn line(version: &str, nonce: &str, mac: &str) -> String {
        format!(
            "{REQUEST_PREFIX}{{\"v\":1,\"version\":\"{version}\",\"nonce\":\"{nonce}\",\"mac\":\"{mac}\"}}"
        )
    }

    fn valid() -> UpdateRequest {
        parse_update_request(&line("1.2.3", NONCE, VECTOR_MAC)).unwrap()
    }

    #[test]
    fn parses_a_valid_line() {
        let req = valid();
        assert_eq!(req.version, "1.2.3");
        assert_eq!(req.nonce, NONCE);
        assert!(
            parse_update_request(&format!("{}\r\n", line("1.2.3", NONCE, VECTOR_MAC))).is_some()
        );
    }

    #[test]
    fn refuses_a_wrong_prefix_or_extra_whitespace() {
        let good = line("1.2.3", NONCE, VECTOR_MAC);
        assert!(parse_update_request(&format!(" {good}")).is_none());
        assert!(parse_update_request(&good.replacen("REQUEST ", "REQUEST  ", 1)).is_none());
        assert!(parse_update_request(&good.replacen("BURROW_", "burrow_", 1)).is_none());
        assert!(parse_update_request(&good.replacen("REQUEST ", "REQUEST", 1)).is_none());
        assert!(parse_update_request(&format!("{good} ")).is_none());
        assert!(parse_update_request(&format!("x{good}")).is_none());
    }

    #[test]
    fn refuses_extra_missing_or_mistyped_keys() {
        let good = line("1.2.3", NONCE, VECTOR_MAC);
        let extra = good.replacen("{\"v\":1,", "{\"v\":1,\"x\":1,", 1);
        assert!(parse_update_request(&extra).is_none());
        let missing =
            format!("{REQUEST_PREFIX}{{\"v\":1,\"version\":\"1.2.3\",\"nonce\":\"{NONCE}\"}}");
        assert!(parse_update_request(&missing).is_none());
        assert!(parse_update_request(&good.replacen("\"v\":1", "\"v\":\"1\"", 1)).is_none());
        assert!(parse_update_request(&format!("{REQUEST_PREFIX}[]")).is_none());
        assert!(parse_update_request(REQUEST_PREFIX).is_none());
    }

    #[test]
    fn refuses_other_protocol_versions() {
        let good = line("1.2.3", NONCE, VECTOR_MAC);
        assert!(parse_update_request(&good.replacen("\"v\":1", "\"v\":2", 1)).is_none());
        assert!(parse_update_request(&good.replacen("\"v\":1", "\"v\":0", 1)).is_none());
    }

    #[test]
    fn refuses_prerelease_and_malformed_versions() {
        for version in [
            "1.2.3-beta.1",
            "1.2.3+build",
            "01.2.3",
            "1.02.3",
            "1.2.03",
            "1.2",
            "1.2.3.4",
            "v1.2.3",
            "1..3",
            "",
            "1.2.x",
            "1.2.3 ",
            "1234567890.0.0",
        ] {
            assert!(
                parse_update_request(&line(version, NONCE, VECTOR_MAC)).is_none(),
                "{version:?} accepted"
            );
        }
        assert!(parse_update_request(&line("0.0.0", NONCE, VECTOR_MAC)).is_some());
        assert!(parse_update_request(&line("10.20.30", NONCE, VECTOR_MAC)).is_some());
    }

    #[test]
    fn refuses_uppercase_or_short_hex() {
        let upper_nonce = NONCE.to_uppercase();
        assert!(parse_update_request(&line("1.2.3", &upper_nonce, VECTOR_MAC)).is_none());
        assert!(parse_update_request(&line("1.2.3", &NONCE[..30], VECTOR_MAC)).is_none());
        assert!(parse_update_request(&line("1.2.3", &format!("{NONCE}0"), VECTOR_MAC)).is_none());
        let upper_mac = VECTOR_MAC.to_uppercase();
        assert!(parse_update_request(&line("1.2.3", NONCE, &upper_mac)).is_none());
        assert!(parse_update_request(&line("1.2.3", NONCE, &VECTOR_MAC[..62])).is_none());
        assert!(parse_update_request(&line("1.2.3", NONCE, &"g".repeat(64))).is_none());
    }

    #[test]
    fn refuses_huge_junk() {
        let junk = format!("{REQUEST_PREFIX}{}", "a".repeat(64 * 1024));
        assert!(parse_update_request(&junk).is_none());
        let padded = format!(
            "{REQUEST_PREFIX}{{\"v\":1,\"pad\":\"{}\"}}",
            "a".repeat(64 * 1024)
        );
        assert!(parse_update_request(&padded).is_none());
    }

    #[test]
    fn mac_matches_the_shared_vector() {
        assert!(verify_mac(&key(), &valid()));
    }

    #[test]
    fn a_flipped_bit_or_changed_field_fails() {
        let req = valid();
        let mut bytes = from_hex(&req.mac).unwrap();
        bytes[0] ^= 1;
        let flipped = UpdateRequest {
            mac: crate::secret::to_hex(&bytes),
            ..req.clone()
        };
        assert!(!verify_mac(&key(), &flipped));
        let other_version = UpdateRequest {
            version: "1.2.4".into(),
            ..req.clone()
        };
        assert!(!verify_mac(&key(), &other_version));
        let other_nonce = UpdateRequest {
            nonce: "ffeeddccbbaa99887766554433221100".into(),
            ..req
        };
        assert!(!verify_mac(&key(), &other_nonce));
    }

    #[test]
    fn a_wrong_key_fails() {
        let mut wrong = key();
        wrong[31] ^= 0x80;
        assert!(!verify_mac(&wrong, &valid()));
        assert!(!verify_mac(&[0u8; 32], &valid()));
    }

    #[test]
    fn nonce_replay_and_second_request_are_refused() {
        let guard = UpdateGuard::default();
        assert_eq!(guard.begin("a"), Ok(()));
        assert_eq!(guard.begin("b"), Err(Refusal::InFlight));
        guard.finish();
        assert_eq!(guard.begin("a"), Err(Refusal::Replay));
        assert_eq!(guard.begin("b"), Ok(()));
        guard.finish();
        assert_eq!(guard.begin("b"), Err(Refusal::Replay));
    }

    fn synthetic_pubkey() -> String {
        let mut raw = vec![b'E', b'd'];
        raw.extend_from_slice(&[7u8; 8]);
        raw.extend_from_slice(&[9u8; 32]);
        let text = format!(
            "untrusted comment: minisign public key: 0707070707070707\n{}\n",
            STANDARD.encode(raw)
        );
        STANDARD.encode(text)
    }

    fn cfg(pubkey: &str) -> serde_json::Value {
        serde_json::json!({ "pubkey": pubkey, "endpoints": [] })
    }

    #[test]
    fn should_enable_needs_stable_and_a_real_key() {
        let real = cfg(&synthetic_pubkey());
        assert!(should_enable(
            Channel::Stable,
            Distribution::Direct,
            Some(&real)
        ));
        assert!(!should_enable(
            Channel::Dev,
            Distribution::Direct,
            Some(&real)
        ));
        assert!(!should_enable(
            Channel::Stable,
            Distribution::Direct,
            Some(&cfg(PUBKEY_PLACEHOLDER))
        ));
        assert!(!should_enable(Channel::Stable, Distribution::Direct, None));
        assert!(!should_enable(
            Channel::Stable,
            Distribution::Direct,
            Some(&serde_json::json!({}))
        ));
        assert!(!should_enable(
            Channel::Stable,
            Distribution::Direct,
            Some(&serde_json::json!({ "pubkey": 5 }))
        ));
        assert!(!should_enable(
            Channel::Stable,
            Distribution::Direct,
            Some(&cfg("garbage"))
        ));
        assert!(!should_enable(
            Channel::Stable,
            Distribution::Direct,
            Some(&cfg(""))
        ));
        let wrong_alg = STANDARD.encode(format!(
            "untrusted comment: x\n{}\n",
            STANDARD.encode([b'X'; 42])
        ));
        assert!(!should_enable(
            Channel::Stable,
            Distribution::Direct,
            Some(&cfg(&wrong_alg))
        ));
        let short = STANDARD.encode(format!(
            "untrusted comment: x\n{}\n",
            STANDARD.encode([b'E', b'd'])
        ));
        assert!(!should_enable(
            Channel::Stable,
            Distribution::Direct,
            Some(&cfg(&short))
        ));
        let one_line = STANDARD.encode("untrusted comment: x");
        assert!(!should_enable(
            Channel::Stable,
            Distribution::Direct,
            Some(&cfg(&one_line))
        ));
    }

    #[test]
    fn should_enable_is_off_for_the_store_distribution_whatever_the_key() {
        let real = cfg(&synthetic_pubkey());
        assert!(should_enable(
            Channel::Stable,
            Distribution::Direct,
            Some(&real)
        ));
        assert!(!should_enable(
            Channel::Stable,
            Distribution::Store,
            Some(&real)
        ));
        assert!(!should_enable(
            Channel::Dev,
            Distribution::Store,
            Some(&real)
        ));
        assert!(!should_enable(Channel::Stable, Distribution::Store, None));
    }

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    #[test]
    fn the_pinned_installer_url_is_accepted() {
        let pinned = installer_url_for("1.2.3", arch_label());
        assert!(pinned.starts_with(
            "https://github.com/ChristianMunoz31/burrow-releases/releases/download/v1.2.3/Burrow-Setup-"
        ));
        assert!(installer_url_allowed(&url(&pinned), "1.2.3"));
    }

    #[test]
    fn every_other_installer_url_is_refused() {
        let pinned = installer_url_for("1.2.3", arch_label());
        let other_arch = installer_url_for(
            "1.2.3",
            if arch_label() == "x64" {
                "arm64"
            } else {
                "x64"
            },
        );
        let refused = [
            other_arch,
            pinned.replacen("https:", "http:", 1),
            pinned.replacen("github.com", "evil.example", 1),
            pinned.replacen("github.com", "github.com.evil.example", 1),
            pinned.replacen("burrow-releases", "burrow", 1),
            pinned.replacen("ChristianMunoz31", "someone", 1),
            pinned.replacen("v1.2.3/", "v1.2.3/../v1.2.4/", 1),
            pinned.replacen("v1.2.3/", "v1.2.4/", 1),
            format!("{pinned}?x=1"),
            format!("{pinned}#frag"),
            format!("{pinned}/"),
            pinned.replacen("https://", "https://user@", 1),
            pinned.replacen("github.com", "github.com:8443", 1),
        ];
        for candidate in refused {
            assert!(
                !installer_url_allowed(&url(&candidate), "1.2.3"),
                "{candidate} accepted"
            );
        }
        assert!(!installer_url_allowed(&url(&pinned), "1.2.4"));
        assert!(!installer_url_allowed(&url(&pinned), "1.2.3-beta"));
    }

    #[test]
    fn redirects_only_to_the_three_hosts_over_https() {
        for ok in [
            "https://github.com/a/b",
            "https://release-assets.githubusercontent.com/x?y=1",
            "https://objects.githubusercontent.com/x",
        ] {
            assert!(redirect_allowed(&url(ok)), "{ok}");
        }
        for bad in [
            "http://github.com/a",
            "https://evil-github.com/a",
            "https://github.com.evil.io/a",
            "https://user:pw@github.com/a",
            "https://user@github.com/a",
            "https://github.com:8443/a",
            "https://api.github.com/a",
            "https://githubusercontent.com/a",
            "ftp://github.com/a",
        ] {
            assert!(!redirect_allowed(&url(bad)), "{bad}");
        }
    }

    #[test]
    fn redirect_chains_are_capped() {
        let ok = url("https://github.com/a");
        assert!(follow_redirect(&ok, 1));
        assert!(follow_redirect(&ok, 5));
        assert!(!follow_redirect(&ok, 6));
        assert!(!follow_redirect(&url("http://github.com/a"), 1));
    }

    #[test]
    fn failure_copy_is_plain() {
        for failure in [
            UpdateFailure::NotOffered,
            UpdateFailure::Mismatch,
            UpdateFailure::Download,
            UpdateFailure::Verify,
            UpdateFailure::Install,
        ] {
            let (title, message) = failure_dialog(failure);
            assert!(!title.is_empty() && !message.is_empty());
            assert!(!title.contains('\u{2014}') && !message.contains('\u{2014}'));
            assert!(!message.contains("Settings > Network"));
        }
    }
}
