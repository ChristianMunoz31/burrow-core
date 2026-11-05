//! Native dialogs for the server: the folder picker ("Add folder") and the save dialog (export to a place the user picks).
//!
//! The server never opens a window and never writes where the user chose. It asks with one authenticated stdout line:
//! `BURROW_DIALOG_REQUEST {"v":1,"kind":"pick_folder|save_file","id":"<32 hex>","ttl":900,"name":"","ext":"","bytes":0,"mac":"<64 hex>"}`
//! and the shell answers with one authenticated stdin line:
//! `BURROW_DIALOG_REPLY {"v":1,"id":"<32 hex>","status":"...","path":"...","mac":"<64 hex>"}`.
//! `dialogKey = HMAC-SHA256(secret, "burrow-dialog-key-v1")` (see `secret::dialog_mac_key`); every message type has its
//! own MAC prefix. For a save, the shell fetches the bytes once from `GET /desktop/dialog-file/<id>` on the loopback
//! server (proof header `X-Burrow-Dialog-Proof`), shows the OS save dialog, and writes the file itself (temp file in the
//! same folder, then rename). Right before that write it asks the server once more (`GET /desktop/dialog-file/<id>/ok`, a
//! proof under its own MAC prefix) whether the request is still waiting; only a `204` allows the write. A reply carries a path only for `picked`; `validateFolderRoot` on the server stays the only
//! authority on what a picked folder may be. Nothing here logs a path or a file name.

use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::downloads::sanitize_file_name;
use crate::secret::{hmac_sha256, to_hex};
use crate::sidecar::log_line;
use crate::{AppState, MAIN_LABEL};

/// Prefix of the stdout line the server uses to ask for a dialog.
pub const REQUEST_PREFIX: &str = "BURROW_DIALOG_REQUEST ";
/// Prefix of the stdin line the shell answers with.
pub const REPLY_PREFIX: &str = "BURROW_DIALOG_REPLY ";
/// Largest export the shell will fetch and write (32 MiB).
pub const MAX_SAVE_BYTES: u64 = 32 * 1024 * 1024;

const MAX_PAYLOAD_BYTES: usize = 1024;
const MAX_PICKED_UTF16: usize = 1024;
const MAX_NAME_CHARS: usize = 200;
const MIN_TTL: u64 = 60;
const MAX_TTL: u64 = 3600;
const FETCH_TIMEOUT: Duration = Duration::from_secs(30);
const REQUEST_MAC_PREFIX: &str = "burrow-dialog-request-v1\n";
const REPLY_MAC_PREFIX: &str = "burrow-dialog-reply-v1\n";
const FETCH_MAC_PREFIX: &str = "burrow-dialog-fetch-v1\n";
const COMMIT_MAC_PREFIX: &str = "burrow-dialog-commit-v1\n";
const PROOF_HEADER: &str = "X-Burrow-Dialog-Proof";
const SAVE_EXTS: [&str; 3] = ["md", "json", "csv"];
const REQUEST_REDACTED: &str = "BURROW_DIALOG_REQUEST (details not logged)";

/// What the server asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DialogKind {
    PickFolder,
    SaveFile,
}

impl DialogKind {
    fn wire(self) -> &'static str {
        match self {
            DialogKind::PickFolder => "pick_folder",
            DialogKind::SaveFile => "save_file",
        }
    }
}

/// A format-checked dialog request. The MAC is private: only [`verify_request_mac`] reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DialogRequest {
    pub kind: DialogKind,
    pub id: String,
    pub ttl: u64,
    pub name: String,
    pub ext: String,
    pub bytes: u64,
    mac: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Wire {
    v: u64,
    kind: String,
    id: String,
    ttl: u64,
    name: String,
    ext: String,
    bytes: u64,
    mac: String,
}

fn is_lower_hex(text: &str, len: usize) -> bool {
    text.len() == len && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
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

/// Format checks only (prefix, exact keys, shapes, per-kind rules). Authenticity is [`verify_request_mac`].
pub fn parse_dialog_request(line: &str) -> Option<DialogRequest> {
    let payload = line
        .trim_end_matches(['\r', '\n'])
        .strip_prefix(REQUEST_PREFIX)?;
    if payload.len() > MAX_PAYLOAD_BYTES
        || !payload.starts_with('{')
        || !payload.ends_with('}')
        || payload.contains('\u{FFFD}')
    {
        return None;
    }
    let wire: Wire = serde_json::from_str(payload).ok()?;
    if wire.v != 1
        || !is_lower_hex(&wire.id, 32)
        || !is_lower_hex(&wire.mac, 64)
        || !(MIN_TTL..=MAX_TTL).contains(&wire.ttl)
    {
        return None;
    }
    let kind = match wire.kind.as_str() {
        "pick_folder" => {
            if !wire.name.is_empty() || !wire.ext.is_empty() || wire.bytes != 0 {
                return None;
            }
            DialogKind::PickFolder
        }
        "save_file" => {
            if !SAVE_EXTS.contains(&wire.ext.as_str())
                || wire.name.chars().count() > MAX_NAME_CHARS
                || wire.name != sanitize_file_name(&wire.name)
                || !wire.name.ends_with(&format!(".{}", wire.ext))
                || wire.bytes == 0
                || wire.bytes > MAX_SAVE_BYTES
            {
                return None;
            }
            DialogKind::SaveFile
        }
        _ => return None,
    };
    Some(DialogRequest {
        kind,
        id: wire.id,
        ttl: wire.ttl,
        name: wire.name,
        ext: wire.ext,
        bytes: wire.bytes,
        mac: wire.mac,
    })
}

/// Constant-time check of the request MAC against the dialog key.
pub fn verify_request_mac(key: &[u8; 32], req: &DialogRequest) -> bool {
    let Some(expected) = from_hex(&req.mac) else {
        return false;
    };
    let Ok(mut mac) = <Hmac<Sha256> as Mac>::new_from_slice(key) else {
        return false;
    };
    mac.update(
        format!(
            "{REQUEST_MAC_PREFIX}{}\n{}\n{}\n{}\n{}\n{}",
            req.kind.wire(),
            req.id,
            req.ttl,
            req.name,
            req.ext,
            req.bytes
        )
        .as_bytes(),
    );
    mac.verify_slice(&expected).is_ok()
}

/// `hex(HMAC(dialogKey, "burrow-dialog-reply-v1\n" + id + "\n" + status + "\n" + path))`, `path` as UTF-8.
pub fn reply_mac(key: &[u8; 32], id: &str, status: &str, path: &str) -> String {
    to_hex(&hmac_sha256(
        key,
        format!("{REPLY_MAC_PREFIX}{id}\n{status}\n{path}").as_bytes(),
    ))
}

#[derive(Serialize)]
struct ReplyWire<'a> {
    v: u8,
    id: &'a str,
    status: &'a str,
    path: &'a str,
    mac: String,
}

/// The JSON payload of a reply (without prefix and without the trailing newline).
pub fn reply_line(key: &[u8; 32], id: &str, status: &str, path: &str) -> String {
    let wire = ReplyWire {
        v: 1,
        id,
        status,
        path,
        mac: reply_mac(key, id, status, path),
    };
    let json = serde_json::to_string(&wire).unwrap_or_default();
    format!("{REPLY_PREFIX}{json}")
}

/// The proof header for fetching the bytes of a save request: `hex(HMAC(dialogKey, "burrow-dialog-fetch-v1\n" + id))`.
pub fn fetch_proof(key: &[u8; 32], id: &str) -> String {
    to_hex(&hmac_sha256(
        key,
        format!("{FETCH_MAC_PREFIX}{id}").as_bytes(),
    ))
}

/// The proof header for the commit check that comes right before a save writes its file:
/// `hex(HMAC(dialogKey, "burrow-dialog-commit-v1\n" + id))`. A different prefix from [`fetch_proof`], so a captured fetch
/// proof cannot be used to commit.
pub fn commit_proof(key: &[u8; 32], id: &str) -> String {
    to_hex(&hmac_sha256(
        key,
        format!("{COMMIT_MAC_PREFIX}{id}").as_bytes(),
    ))
}

/// Replaces a request line in the log with a line that holds no details; every other line is logged as it is.
pub fn log_redaction(line: &str) -> Option<&'static str> {
    line.starts_with(REQUEST_PREFIX).then_some(REQUEST_REDACTED)
}

/// A Windows verbatim disk prefix (`\\?\C:\x`) becomes `C:\x`. Other verbatim, device and UNC forms stay as they are.
fn strip_verbatim_disk(text: &str) -> &str {
    if let Some(rest) = text.strip_prefix("\\\\?\\") {
        let b = rest.as_bytes();
        if b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'\\' {
            return rest;
        }
    }
    text
}

/// The text of a picked folder as the shell reports it, or `Err` when it is not something to send: it must be valid Unicode,
/// 1 to 1024 UTF-16 units, free of control characters and absolute. Everything else (links, protected folders, caps) is
/// the server's `validateFolderRoot`.
#[allow(clippy::result_unit_err)]
pub fn check_picked_path(p: &Path) -> Result<String, ()> {
    let text = strip_verbatim_disk(p.to_str().ok_or(())?);
    if text.is_empty()
        || text.encode_utf16().count() > MAX_PICKED_UTF16
        || text.chars().any(char::is_control)
        || !Path::new(text).is_absolute()
    {
        return Err(());
    }
    Ok(text.to_string())
}

/// Why a chosen save target cannot be used.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SaveFailure {
    Exists,
    WriteFailed,
}

/// True when the chosen name already ends with `ext` (any case): the user typed or kept the full name.
fn has_extension(chosen: &Path, ext: &str) -> bool {
    chosen
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case(ext))
}

/// The file to write for the path the OS save dialog returned. A path that already ends with the extension (any case) is
/// used as it is: the OS dialog has already confirmed any overwrite. Otherwise the extension is appended, and an existing
/// file at the appended path is never overwritten (`Exists`). A folder, or a path with no file name, is `WriteFailed`.
pub fn resolve_save_target(chosen: &Path, ext: &str) -> Result<PathBuf, SaveFailure> {
    if chosen.file_name().is_none() || fs::metadata(chosen).is_ok_and(|m| m.is_dir()) {
        return Err(SaveFailure::WriteFailed);
    }
    let has_ext = has_extension(chosen, ext);
    let target = if has_ext {
        chosen.to_path_buf()
    } else {
        let mut text = chosen.as_os_str().to_owned();
        text.push(".");
        text.push(ext);
        PathBuf::from(text)
    };
    match fs::symlink_metadata(&target) {
        Ok(meta) if meta.is_dir() => Err(SaveFailure::WriteFailed),
        Ok(_) if !has_ext => Err(SaveFailure::Exists),
        Ok(_) => Ok(target),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(target),
        Err(_) => Err(SaveFailure::WriteFailed),
    }
}

/// Moves `from` to `to` and fails with `AlreadyExists` when `to` exists, in one step with no window in which the check
/// and the move can be separated: `MoveFileExW` without `MOVEFILE_REPLACE_EXISTING` on Windows.
#[cfg(windows)]
fn rename_no_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;
    let wide = |p: &Path| -> Vec<u16> { p.as_os_str().encode_wide().chain(Some(0)).collect() };
    let (from, to) = (wide(from), wide(to));
    // SAFETY: both buffers are NUL-terminated UTF-16 strings that outlive the call; flags 0 means "do not replace".
    let ok = unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) };
    if ok == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

/// Same contract elsewhere: a hard link is created atomically and fails with `AlreadyExists`; the temp name is then removed.
#[cfg(not(windows))]
fn rename_no_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::hard_link(from, to)?;
    let _ = fs::remove_file(from);
    Ok(())
}

/// Writes `bytes` to a new temp file next to `target`, syncs it and renames it over `target`. The temp file is removed on
/// any failure.
pub fn write_atomic(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    write_with(target, bytes, true)
}

/// Like [`write_atomic`], but never replaces: when `target` exists the error kind is `AlreadyExists` and nothing changed.
pub fn write_new_atomic(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    write_with(target, bytes, false)
}

fn write_with(target: &Path, bytes: &[u8], replace: bool) -> std::io::Result<()> {
    let parent = target
        .parent()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "no parent folder"))?;
    let mut random = [0u8; 8];
    getrandom::fill(&mut random).map_err(|e| std::io::Error::other(e.to_string()))?;
    let temp = parent.join(format!(".burrow-save-{}.tmp", to_hex(&random)));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        if replace {
            fs::rename(&temp, target)
        } else {
            rename_no_replace(&temp, target)
        }
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

/// Resolve the chosen target and write the file: the reply status for a save. `commit` is the server's last word, asked
/// after the target is known and right before the write (`true` = still wanted); `false` writes nothing and is `cancelled`.
/// A name Burrow appended the extension to is written with a no-replace move, so a file that appeared since the check is
/// never overwritten (`exists`); a name the user chose in full (the OS dialog confirmed any overwrite) may replace.
fn save_to_disk(
    chosen: &Path,
    ext: &str,
    bytes: &[u8],
    commit: impl FnOnce() -> bool,
) -> &'static str {
    match resolve_save_target(chosen, ext) {
        Err(SaveFailure::Exists) => "exists",
        Err(SaveFailure::WriteFailed) => "write_failed",
        Ok(target) => {
            if !commit() {
                return "cancelled";
            }
            let result = if has_extension(chosen, ext) {
                write_atomic(&target, bytes)
            } else {
                write_new_atomic(&target, bytes)
            };
            match result {
                Ok(()) => "saved",
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => "exists",
                Err(_) => "write_failed",
            }
        }
    }
}

/// Why an authentic request was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    Replay,
    InFlight,
}

/// Single-use ids and the one-dialog-at-a-time flag.
#[derive(Default)]
pub struct DialogGuard {
    seen: Mutex<HashSet<String>>,
    in_flight: AtomicBool,
}

impl DialogGuard {
    /// Claims the id and the in-flight slot. Call only for an authenticated request, so a forged line can never fill the set.
    /// The id is used up even when another dialog is open (that request is answered `busy`), so a copy of the line can never
    /// open a window later.
    pub fn begin(&self, id: &str) -> Result<(), Refusal> {
        let mut seen = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        if !seen.insert(id.to_string()) {
            return Err(Refusal::Replay);
        }
        if self.in_flight.swap(true, Ordering::SeqCst) {
            return Err(Refusal::InFlight);
        }
        Ok(())
    }

    /// Frees the in-flight slot.
    pub fn finish(&self) {
        self.in_flight.store(false, Ordering::SeqCst);
    }
}

/// Frees the in-flight slot when the dialog thread ends, however it ends.
struct FinishOnDrop(AppHandle);

impl Drop for FinishOnDrop {
    fn drop(&mut self) {
        self.0.state::<AppState>().dialog_guard.finish();
    }
}

fn send_reply(app: &AppHandle, key: &[u8; 32], id: &str, status: &str, path: &str) {
    let state = app.state::<AppState>();
    let line = reply_line(key, id, status, path);
    let sent = state
        .sidecar
        .lock()
        .ok()
        .and_then(|s| s.as_ref().map(|sidecar| sidecar.send_line(&line)));
    if !matches!(sent, Some(Ok(()))) {
        log_line(
            &state.log,
            "shell",
            "could not send a dialog reply to the server",
        );
    }
}

/// Validates and starts a dialog request from the server. Every refusal is a log line only (a `busy` reply when another
/// dialog is open).
pub fn dispatch(app: &AppHandle, req: DialogRequest) {
    let state = app.state::<AppState>();
    let ignore = |reason: &str| {
        log_line(
            &state.log,
            "shell",
            &format!("ignored a dialog request ({reason})"),
        );
    };
    let key = state.dialog_key.lock().ok().and_then(|k| *k);
    let Some(key) = key else {
        ignore("no key");
        return;
    };
    if !verify_request_mac(&key, &req) {
        ignore("authentication failed");
        return;
    }
    match state.dialog_guard.begin(&req.id) {
        Err(Refusal::Replay) => {
            ignore("id already used");
            return;
        }
        Err(Refusal::InFlight) => {
            log_line(
                &state.log,
                "shell",
                "a dialog request arrived while one is open: busy",
            );
            send_reply(app, &key, &req.id, "busy", "");
            return;
        }
        Ok(()) => {}
    }
    let started = Instant::now();
    let app = app.clone();
    // Blocking dialogs never run on the main thread or on the thread that reads the server's output.
    std::thread::spawn(move || {
        let _free = FinishOnDrop(app.clone());
        let (status, path) = match req.kind {
            DialogKind::PickFolder => pick(&app, &req, started),
            DialogKind::SaveFile => save(&app, &req, key, started),
        };
        let state = app.state::<AppState>();
        log_line(
            &state.log,
            "shell",
            &format!("folder dialog: {} {status}", req.kind.wire()),
        );
        send_reply(&app, &key, &req.id, status, &path);
    });
}

fn expired(req: &DialogRequest, started: Instant) -> bool {
    started.elapsed() > Duration::from_secs(req.ttl)
}

fn pick(app: &AppHandle, req: &DialogRequest, started: Instant) -> (&'static str, String) {
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Choose a folder for Burrow to read");
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        dialog = dialog.set_parent(&window);
    }
    let Some(chosen) = dialog.blocking_pick_folder() else {
        return ("cancelled", String::new());
    };
    if expired(req, started) {
        return ("expired", String::new());
    }
    let Ok(path) = chosen.into_path() else {
        return ("failed", String::new());
    };
    match check_picked_path(&path) {
        Ok(text) => ("picked", text),
        Err(()) => ("unusable", String::new()),
    }
}

async fn fetch_bytes(port: u16, key: &[u8; 32], req: &DialogRequest) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(FETCH_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client
        .get(format!(
            "http://127.0.0.1:{port}/desktop/dialog-file/{}",
            req.id
        ))
        .header(PROOF_HEADER, fetch_proof(key, &req.id))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if response.status().as_u16() != 200 {
        return Err("unexpected status".to_string());
    }
    let expected = usize::try_from(req.bytes).map_err(|e| e.to_string())?;
    if response
        .content_length()
        .is_some_and(|len| len != req.bytes)
    {
        return Err("unexpected length".to_string());
    }
    let mut data: Vec<u8> = Vec::with_capacity(expected);
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if data.len() + chunk.len() > expected {
            return Err("too many bytes".to_string());
        }
        data.extend_from_slice(&chunk);
    }
    if data.len() != expected {
        return Err("short body".to_string());
    }
    Ok(data)
}

/// Asks the server whether this save request is still waiting: `GET /desktop/dialog-file/<id>/ok` with the commit proof.
/// Only a `204` allows the write; any other answer or an error does not.
async fn commit_allowed(port: u16, key: &[u8; 32], req: &DialogRequest) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(FETCH_TIMEOUT)
        .build()
    else {
        return false;
    };
    client
        .get(format!(
            "http://127.0.0.1:{port}/desktop/dialog-file/{}/ok",
            req.id
        ))
        .header(PROOF_HEADER, commit_proof(key, &req.id))
        .send()
        .await
        .is_ok_and(|response| response.status().as_u16() == 204)
}

fn save(
    app: &AppHandle,
    req: &DialogRequest,
    key: [u8; 32],
    started: Instant,
) -> (&'static str, String) {
    let port = app.state::<AppState>().port.load(Ordering::SeqCst);
    if port == 0 {
        return ("fetch_failed", String::new());
    }
    let Ok(bytes) = tauri::async_runtime::block_on(fetch_bytes(port, &key, req)) else {
        return ("fetch_failed", String::new());
    };
    let label = match req.ext.as_str() {
        "md" => "Markdown",
        "json" => "JSON",
        _ => "CSV",
    };
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Save export")
        .set_file_name(&req.name)
        .add_filter(label, &[req.ext.as_str()]);
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        dialog = dialog.set_parent(&window);
    }
    let Some(chosen) = dialog.blocking_save_file() else {
        return ("cancelled", String::new());
    };
    if expired(req, started) {
        return ("expired", String::new());
    }
    let Ok(path) = chosen.into_path() else {
        return ("write_failed", String::new());
    };
    let commit = || tauri::async_runtime::block_on(commit_allowed(port, &key, req));
    (save_to_disk(&path, &req.ext, &bytes, commit), String::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "00112233445566778899aabbccddeeff";
    const PICK_MAC: &str = "b2b40e2bcc003dc7f7a1e9f04ded223ce1631109d2b2fcb4e14b6d119e9fcdda";
    const SAVE_MAC: &str = "9102e87ea551fe60e7fba7ba87699f8840c6c4f315273ce3b81d966b5fc0e6fe";
    const REPLY_PICKED_MAC: &str =
        "0914461379dc7f21902dc2ed0932179b6f7336892c206cb40638c2a13db2e84d";
    const REPLY_PICKED_UTF8_MAC: &str =
        "3565fc97e76d00cf15b330d8fad46a553e3c549a2ae4cdbd67395577e2c6135b";
    const REPLY_CANCELLED_MAC: &str =
        "a766a70a194f0526f7dcb2b38eb9c68d0fa9dbfaafc9befe37ef6b8ea817d854";
    const FETCH_PROOF: &str = "6f7ae1594d6797f221d09f7b162cd2757c3df427eb6e51b6556fd9737d297890";
    // Same literal as COMMIT_VECTOR in server/__tests__/foldersRound2Fixes.test.js.
    const COMMIT_PROOF: &str = "f4426519f75890ec096639824f36726b528c14b057fa019a7a2e11560b94a6cf";
    const SAVE_NAME: &str = "burrow-folder-notes-2026-10-08.md";

    fn key() -> [u8; 32] {
        let mut secret = [0u8; 32];
        for (i, b) in secret.iter_mut().enumerate() {
            *b = i as u8;
        }
        crate::secret::dialog_mac_key(&secret)
    }

    fn pick_line() -> String {
        format!(
            "{REQUEST_PREFIX}{{\"v\":1,\"kind\":\"pick_folder\",\"id\":\"{ID}\",\"ttl\":900,\"name\":\"\",\"ext\":\"\",\"bytes\":0,\"mac\":\"{PICK_MAC}\"}}"
        )
    }

    fn save_line_with(name: &str, ext: &str, bytes: u64, ttl: u64, mac: &str) -> String {
        format!(
            "{REQUEST_PREFIX}{{\"v\":1,\"kind\":\"save_file\",\"id\":\"{ID}\",\"ttl\":{ttl},\"name\":\"{name}\",\"ext\":\"{ext}\",\"bytes\":{bytes},\"mac\":\"{mac}\"}}"
        )
    }

    fn save_line() -> String {
        save_line_with(SAVE_NAME, "md", 1234, 900, SAVE_MAC)
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "burrow-dialogs-test-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    // ----- parsing -----

    #[test]
    fn parses_a_valid_pick_line() {
        let req = parse_dialog_request(&pick_line()).unwrap();
        assert_eq!(req.kind, DialogKind::PickFolder);
        assert_eq!(req.id, ID);
        assert_eq!(req.ttl, 900);
        assert!(req.name.is_empty() && req.ext.is_empty() && req.bytes == 0);
        assert!(parse_dialog_request(&format!("{}\r\n", pick_line())).is_some());
    }

    #[test]
    fn parses_a_valid_save_line() {
        let req = parse_dialog_request(&save_line()).unwrap();
        assert_eq!(req.kind, DialogKind::SaveFile);
        assert_eq!(req.name, SAVE_NAME);
        assert_eq!(req.ext, "md");
        assert_eq!(req.bytes, 1234);
        for (name, ext) in [("a.json", "json"), ("a.csv", "csv"), ("A.MD.md", "md")] {
            assert!(
                parse_dialog_request(&save_line_with(name, ext, 1, 900, SAVE_MAC)).is_some(),
                "{name}"
            );
        }
        // The ends of the allowed ranges.
        assert!(parse_dialog_request(&save_line_with(
            SAVE_NAME,
            "md",
            MAX_SAVE_BYTES,
            60,
            SAVE_MAC
        ))
        .is_some());
        assert!(
            parse_dialog_request(&save_line_with(SAVE_NAME, "md", 1, 3600, SAVE_MAC)).is_some()
        );
    }

    #[test]
    fn refuses_a_wrong_prefix_or_extra_whitespace() {
        let line = pick_line();
        assert!(parse_dialog_request(&line[..line.len() - 1]).is_none());
        assert!(parse_dialog_request(&format!(" {line}")).is_none());
        assert!(parse_dialog_request(&format!("{line} ")).is_none());
        assert!(parse_dialog_request(&line.replacen(
            "BURROW_DIALOG_REQUEST ",
            "BURROW_DIALOG_REQUEST  ",
            1
        ))
        .is_none());
        assert!(parse_dialog_request(&line.replacen(
            "BURROW_DIALOG_REQUEST ",
            "BURROW_UPDATE_REQUEST ",
            1
        ))
        .is_none());
        assert!(parse_dialog_request(&line.replacen(
            "BURROW_DIALOG_REQUEST ",
            "burrow_dialog_request ",
            1
        ))
        .is_none());
        assert!(parse_dialog_request(&line.replacen(
            "BURROW_DIALOG_REQUEST ",
            "BURROW_DIALOG_REQUEST",
            1
        ))
        .is_none());
        assert!(parse_dialog_request("").is_none());
        assert!(parse_dialog_request("BURROW_DIALOG_REQUEST ").is_none());
    }

    #[test]
    fn refuses_unknown_missing_or_mistyped_keys() {
        let base = pick_line();
        assert!(
            parse_dialog_request(&base.replace("\"bytes\":0,", "\"bytes\":0,\"extra\":1,"))
                .is_none()
        );
        assert!(parse_dialog_request(&base.replace("\"ext\":\"\",", "")).is_none());
        assert!(parse_dialog_request(&base.replace("\"bytes\":0,", "")).is_none());
        assert!(parse_dialog_request(&base.replace("\"ttl\":900", "\"ttl\":\"900\"")).is_none());
        assert!(parse_dialog_request(&base.replace("\"bytes\":0", "\"bytes\":\"0\"")).is_none());
        assert!(parse_dialog_request(&base.replace("\"bytes\":0", "\"bytes\":-1")).is_none());
        assert!(parse_dialog_request(&base.replace("\"bytes\":0", "\"bytes\":0.5")).is_none());
        assert!(parse_dialog_request(
            &base.replace("\"kind\":\"pick_folder\"", "\"kind\":\"open_file\"")
        )
        .is_none());
        assert!(parse_dialog_request(&base.replace("\"v\":1", "\"v\":0")).is_none());
        assert!(parse_dialog_request(&base.replace("\"v\":1", "\"v\":2")).is_none());
        assert!(parse_dialog_request(&base.replace("\"v\":1", "\"v\":\"1\"")).is_none());
    }

    #[test]
    fn refuses_bad_ids_and_macs() {
        let base = pick_line();
        assert!(parse_dialog_request(&base.replace(ID, &ID.to_uppercase())).is_none());
        assert!(parse_dialog_request(&base.replace(ID, &ID[..31])).is_none());
        assert!(parse_dialog_request(&base.replace(ID, &format!("{ID}0"))).is_none());
        assert!(parse_dialog_request(&base.replace(PICK_MAC, &PICK_MAC.to_uppercase())).is_none());
        assert!(parse_dialog_request(&base.replace(PICK_MAC, &PICK_MAC[..63])).is_none());
        assert!(parse_dialog_request(&base.replace(PICK_MAC, &"g".repeat(64))).is_none());
    }

    #[test]
    fn a_pick_line_with_a_name_an_extension_or_bytes_is_refused() {
        let base = pick_line();
        assert!(parse_dialog_request(&base.replace("\"name\":\"\"", "\"name\":\"x\"")).is_none());
        assert!(parse_dialog_request(&base.replace("\"ext\":\"\"", "\"ext\":\"md\"")).is_none());
        assert!(parse_dialog_request(&base.replace("\"bytes\":0", "\"bytes\":1")).is_none());
    }

    #[test]
    fn a_save_line_with_a_bad_field_is_refused() {
        let ok = |name: &str, ext: &str, bytes: u64, ttl: u64| {
            parse_dialog_request(&save_line_with(name, ext, bytes, ttl, SAVE_MAC)).is_some()
        };
        assert!(ok(SAVE_NAME, "md", 1234, 900));
        assert!(!ok(SAVE_NAME, "txt", 1234, 900), "extension not allowed");
        assert!(!ok("a.exe", "exe", 1234, 900));
        assert!(
            !ok("a.json", "md", 1234, 900),
            "name does not end with the extension"
        );
        assert!(!ok("a.md", "", 1234, 900));
        assert!(!ok("", "md", 1234, 900), "empty name");
        assert!(!ok(".md", "md", 1234, 900), "name that sanitizing changes");
        assert!(!ok("a/b.md", "md", 1234, 900), "directory part");
        assert!(!ok("a\\\\b.md", "md", 1234, 900), "backslash");
        assert!(!ok("a:b.md", "md", 1234, 900));
        assert!(!ok("CON.md", "md", 1234, 900), "device name");
        assert!(!ok("a .md", "md", 1234, 900), "space before the extension");
        assert!(
            !ok(&format!("{}.md", "a".repeat(199)), "md", 1234, 900),
            "over 200 characters"
        );
        assert!(!ok(SAVE_NAME, "md", 0, 900));
        assert!(!ok(SAVE_NAME, "md", MAX_SAVE_BYTES + 1, 900));
        assert!(!ok(SAVE_NAME, "md", 1234, 59));
        assert!(!ok(SAVE_NAME, "md", 1234, 3601));
        assert!(!ok(SAVE_NAME, "md", 1234, 0));
    }

    #[test]
    fn a_payload_over_1024_bytes_or_with_a_replacement_character_is_refused() {
        // Spaces are legal JSON between tokens, so only the length rule can refuse these.
        let padded = |total: usize| {
            let base = pick_line();
            let spaces = total - (base.len() - REQUEST_PREFIX.len());
            base.replacen("{\"v\":1,", &format!("{{\"v\":1,{}", " ".repeat(spaces)), 1)
        };
        let fits = padded(1024);
        assert_eq!(fits.len() - REQUEST_PREFIX.len(), 1024);
        assert!(parse_dialog_request(&fits).is_some());
        let too_long = padded(1025);
        assert_eq!(too_long.len() - REQUEST_PREFIX.len(), 1025);
        assert!(parse_dialog_request(&too_long).is_none());
        assert!(
            parse_dialog_request(&save_line_with("caf\u{fffd}.md", "md", 1, 900, SAVE_MAC))
                .is_none()
        );
    }

    // ----- MACs -----

    #[test]
    fn request_mac_matches_the_server_vectors() {
        assert!(verify_request_mac(
            &key(),
            &parse_dialog_request(&pick_line()).unwrap()
        ));
        assert!(verify_request_mac(
            &key(),
            &parse_dialog_request(&save_line()).unwrap()
        ));
    }

    #[test]
    fn a_tampered_request_or_the_wrong_key_fails() {
        let key = key();
        let pick = parse_dialog_request(&pick_line()).unwrap();
        for tampered in [
            DialogRequest {
                ttl: 901,
                ..pick.clone()
            },
            DialogRequest {
                id: "f".repeat(32),
                ..pick.clone()
            },
            DialogRequest {
                kind: DialogKind::SaveFile,
                ..pick.clone()
            },
            DialogRequest {
                bytes: 1,
                ..pick.clone()
            },
            DialogRequest {
                mac: "0".repeat(64),
                ..pick.clone()
            },
            DialogRequest {
                mac: "zz".repeat(32),
                ..pick.clone()
            },
        ] {
            assert!(!verify_request_mac(&key, &tampered));
        }
        let save = parse_dialog_request(&save_line()).unwrap();
        assert!(!verify_request_mac(
            &key,
            &DialogRequest {
                name: "other.md".into(),
                ..save.clone()
            }
        ));
        assert!(!verify_request_mac(
            &key,
            &DialogRequest {
                ext: "json".into(),
                ..save
            }
        ));
        // The update key is not the dialog key.
        let mut secret = [0u8; 32];
        for (i, b) in secret.iter_mut().enumerate() {
            *b = i as u8;
        }
        assert!(!verify_request_mac(
            &crate::secret::update_mac_key(&secret),
            &pick
        ));
        assert!(!verify_request_mac(&[9u8; 32], &pick));
    }

    #[test]
    fn reply_macs_match_the_server_vectors() {
        let key = key();
        assert_eq!(
            reply_mac(&key, ID, "picked", "C:\\Users\\Example\\Documents\\Notes"),
            REPLY_PICKED_MAC
        );
        assert_eq!(
            reply_mac(
                &key,
                ID,
                "picked",
                "C:\\Users\\Ex\u{e4}mple\\Notes \u{2713}"
            ),
            REPLY_PICKED_UTF8_MAC
        );
        assert_eq!(reply_mac(&key, ID, "cancelled", ""), REPLY_CANCELLED_MAC);
        assert_ne!(
            reply_mac(&[9u8; 32], ID, "cancelled", ""),
            REPLY_CANCELLED_MAC
        );
        assert_ne!(reply_mac(&key, ID, "failed", ""), REPLY_CANCELLED_MAC);
    }

    #[test]
    fn reply_line_is_valid_json_with_exact_keys_and_the_vector_mac() {
        let key = key();
        let path = "C:\\Users\\Ex\u{e4}mple\\Notes \u{2713}";
        let line = reply_line(&key, ID, "picked", path);
        let payload = line.strip_prefix(REPLY_PREFIX).unwrap();
        assert!(!line.contains('\n'));
        let value: serde_json::Value = serde_json::from_str(payload).unwrap();
        let object = value.as_object().unwrap();
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["id", "mac", "path", "status", "v"]);
        assert_eq!(object["v"], 1);
        assert_eq!(object["id"], ID);
        assert_eq!(object["status"], "picked");
        assert_eq!(object["path"], path);
        assert_eq!(object["mac"], REPLY_PICKED_UTF8_MAC);
        let cancelled = reply_line(&key, ID, "cancelled", "");
        let value: serde_json::Value =
            serde_json::from_str(cancelled.strip_prefix(REPLY_PREFIX).unwrap()).unwrap();
        assert_eq!(value["path"], "");
        assert_eq!(value["mac"], REPLY_CANCELLED_MAC);
    }

    #[test]
    fn fetch_proof_matches_the_server_vector() {
        assert_eq!(fetch_proof(&key(), ID), FETCH_PROOF);
        assert_ne!(fetch_proof(&key(), &"f".repeat(32)), FETCH_PROOF);
        assert_ne!(fetch_proof(&[9u8; 32], ID), FETCH_PROOF);
    }

    #[test]
    fn commit_proof_matches_the_server_vector_and_differs_from_the_fetch_proof() {
        assert_eq!(commit_proof(&key(), ID), COMMIT_PROOF);
        assert_ne!(COMMIT_PROOF, FETCH_PROOF);
        assert_ne!(commit_proof(&key(), &"f".repeat(32)), COMMIT_PROOF);
        assert_ne!(commit_proof(&[9u8; 32], ID), COMMIT_PROOF);
        assert_eq!(COMMIT_MAC_PREFIX, "burrow-dialog-commit-v1\n");
    }

    // ----- log redaction -----

    #[test]
    fn request_lines_are_not_logged_in_full() {
        assert_eq!(
            log_redaction(&save_line()),
            Some("BURROW_DIALOG_REQUEST (details not logged)")
        );
        assert_eq!(log_redaction(&pick_line()), Some(REQUEST_REDACTED));
        assert_eq!(log_redaction("BURROW_READY {}"), None);
        assert_eq!(log_redaction("something else"), None);
        assert!(!REQUEST_REDACTED.contains(ID));
    }

    // ----- picked paths -----

    #[cfg(windows)]
    #[test]
    fn picked_windows_paths() {
        assert_eq!(
            check_picked_path(Path::new("C:\\x")),
            Ok("C:\\x".to_string())
        );
        assert_eq!(
            check_picked_path(Path::new("\\\\?\\C:\\x")),
            Ok("C:\\x".to_string())
        );
        assert_eq!(
            check_picked_path(Path::new("\\\\server\\share")),
            Ok("\\\\server\\share".to_string())
        );
        assert_eq!(
            check_picked_path(Path::new("\\\\?\\UNC\\server\\share\\x")),
            Ok("\\\\?\\UNC\\server\\share\\x".to_string())
        );
        assert!(check_picked_path(Path::new("relative\\path")).is_err());
        assert!(check_picked_path(Path::new("C:relative")).is_err());
        assert!(check_picked_path(Path::new("")).is_err());
        assert!(check_picked_path(Path::new("C:\\a\u{7}b")).is_err());
        assert!(check_picked_path(Path::new("C:\\a\nb")).is_err());
    }

    #[cfg(not(windows))]
    #[test]
    fn picked_unix_paths() {
        assert_eq!(
            check_picked_path(Path::new("/home/x")),
            Ok("/home/x".to_string())
        );
        assert!(check_picked_path(Path::new("relative/path")).is_err());
        assert!(check_picked_path(Path::new("")).is_err());
        assert!(check_picked_path(Path::new("/a\u{7}b")).is_err());
    }

    #[test]
    fn a_picked_path_is_capped_in_utf16_units() {
        let prefix = if cfg!(windows) { "C:\\" } else { "/" };
        let ok = format!("{prefix}{}", "a".repeat(MAX_PICKED_UTF16 - prefix.len()));
        assert_eq!(ok.encode_utf16().count(), 1024);
        assert!(check_picked_path(Path::new(&ok)).is_ok());
        let long = format!("{ok}a");
        assert_eq!(long.encode_utf16().count(), 1025);
        assert!(check_picked_path(Path::new(&long)).is_err());
        // Counted in UTF-16 units, not characters: an astral character is two.
        let astral = format!("{prefix}{}", "\u{1F600}".repeat(511));
        assert!(astral.encode_utf16().count() > 1024 - prefix.len() - 1);
        assert!(check_picked_path(Path::new(&format!("{astral}\u{1F600}\u{1F600}"))).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_picked_path_that_is_not_unicode_is_refused() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;
        let bytes = [b'/', b'a', 0xff, 0xfe, b'b'];
        assert!(check_picked_path(Path::new(OsStr::from_bytes(&bytes))).is_err());
    }

    // ----- saving -----

    #[test]
    fn resolve_keeps_an_extension_in_any_case_and_appends_when_missing() {
        let dir = scratch("resolve");
        let kept = dir.join("report.MD");
        assert_eq!(resolve_save_target(&kept, "md"), Ok(kept.clone()));
        let plain = dir.join("report.md");
        assert_eq!(resolve_save_target(&plain, "md"), Ok(plain));
        let bare = dir.join("notes");
        assert_eq!(resolve_save_target(&bare, "md"), Ok(dir.join("notes.md")));
        let other = dir.join("notes.txt");
        assert_eq!(
            resolve_save_target(&other, "md"),
            Ok(dir.join("notes.txt.md"))
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_appended_name_never_overwrites_but_a_chosen_one_may() {
        let dir = scratch("exists");
        fs::write(dir.join("notes.md"), b"old").unwrap();
        assert_eq!(
            resolve_save_target(&dir.join("notes"), "md"),
            Err(SaveFailure::Exists)
        );
        // The user typed the full name and the OS dialog confirmed the overwrite.
        assert_eq!(
            resolve_save_target(&dir.join("notes.md"), "md"),
            Ok(dir.join("notes.md"))
        );
        assert_eq!(
            save_to_disk(&dir.join("notes"), "md", b"new", || true),
            "exists"
        );
        assert_eq!(fs::read(dir.join("notes.md")).unwrap(), b"old");
        assert_eq!(
            save_to_disk(&dir.join("notes.md"), "md", b"new", || true),
            "saved"
        );
        assert_eq!(fs::read(dir.join("notes.md")).unwrap(), b"new");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_folder_or_a_missing_name_is_a_failed_write() {
        let dir = scratch("folder");
        assert_eq!(
            resolve_save_target(&dir, "md"),
            Err(SaveFailure::WriteFailed)
        );
        fs::create_dir_all(dir.join("sub.md")).unwrap();
        assert_eq!(
            resolve_save_target(&dir.join("sub.md"), "md"),
            Err(SaveFailure::WriteFailed)
        );
        fs::create_dir_all(dir.join("other")).unwrap();
        assert_eq!(
            resolve_save_target(&dir.join("other"), "md"),
            Err(SaveFailure::WriteFailed)
        );
        assert_eq!(
            resolve_save_target(Path::new(""), "md"),
            Err(SaveFailure::WriteFailed)
        );
        // A target in a folder that does not exist fails at the write.
        assert_eq!(
            save_to_disk(&dir.join("missing").join("x.md"), "md", b"x", || true),
            "write_failed"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_atomic_writes_the_bytes_and_leaves_no_temp_file() {
        let dir = scratch("atomic");
        let target = dir.join("out.json");
        let data: Vec<u8> = (0..=255u8).cycle().take(100_000).collect();
        write_atomic(&target, &data).unwrap();
        assert_eq!(fs::read(&target).unwrap(), data);
        write_atomic(&target, b"second").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"second");
        let names: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["out.json"]);
        let _ = fs::remove_dir_all(&dir);
    }

    fn names_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn a_denied_commit_writes_nothing() {
        let dir = scratch("commit-denied");
        assert_eq!(
            save_to_disk(&dir.join("notes"), "md", b"new", || false),
            "cancelled"
        );
        assert_eq!(
            save_to_disk(&dir.join("full.md"), "md", b"new", || false),
            "cancelled"
        );
        assert!(names_in(&dir).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_commit_is_asked_once_and_only_after_the_target_is_known() {
        let dir = scratch("commit-once");
        let mut asked = 0;
        // A name that cannot be written is decided before the server is asked.
        assert_eq!(
            save_to_disk(&dir, "md", b"x", || {
                asked += 1;
                true
            }),
            "write_failed"
        );
        assert_eq!(asked, 0);
        fs::write(dir.join("taken.md"), b"old").unwrap();
        assert_eq!(
            save_to_disk(&dir.join("taken"), "md", b"x", || {
                asked += 1;
                true
            }),
            "exists"
        );
        assert_eq!(asked, 0);
        assert_eq!(
            save_to_disk(&dir.join("fresh"), "md", b"x", || {
                asked += 1;
                true
            }),
            "saved"
        );
        assert_eq!(asked, 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_name_burrow_appended_is_never_replaced_even_by_a_file_that_appears_late() {
        let dir = scratch("late-file");
        let late = dir.join("notes.md");
        // The target looked free when it was resolved; the file shows up before the write (the commit check is the gap).
        let status = save_to_disk(&dir.join("notes"), "md", b"new", || {
            fs::write(&late, b"theirs").unwrap();
            true
        });
        assert_eq!(status, "exists");
        assert_eq!(fs::read(&late).unwrap(), b"theirs");
        assert_eq!(names_in(&dir), ["notes.md"]); // no temp file left behind
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_name_the_user_chose_in_full_may_still_be_replaced() {
        let dir = scratch("late-chosen");
        let chosen = dir.join("notes.md");
        fs::write(&chosen, b"old").unwrap();
        assert_eq!(save_to_disk(&chosen, "md", b"new", || true), "saved");
        assert_eq!(fs::read(&chosen).unwrap(), b"new");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_new_atomic_refuses_an_existing_file_and_creates_a_missing_one() {
        let dir = scratch("new-atomic");
        let target = dir.join("out.csv");
        write_new_atomic(&target, b"first").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"first");
        let err = write_new_atomic(&target, b"second").unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&target).unwrap(), b"first");
        assert_eq!(names_in(&dir), ["out.csv"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_write_removes_its_temp_file() {
        let dir = scratch("atomic-fail");
        // Renaming a file over a folder fails after the temp file was written.
        let target = dir.join("taken");
        fs::create_dir_all(&target).unwrap();
        assert!(write_atomic(&target, b"x").is_err());
        let names: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["taken"]);
        let _ = fs::remove_dir_all(&dir);
    }

    // ----- guard -----

    #[test]
    fn the_guard_refuses_a_replay_and_a_second_dialog() {
        let guard = DialogGuard::default();
        assert_eq!(guard.begin("a"), Ok(()));
        assert_eq!(guard.begin("a"), Err(Refusal::Replay));
        assert_eq!(guard.begin("b"), Err(Refusal::InFlight));
        guard.finish();
        assert_eq!(guard.begin("c"), Ok(()));
        guard.finish();
        // An id that was answered busy is used up as well.
        assert_eq!(guard.begin("b"), Err(Refusal::Replay));
        assert_eq!(guard.begin("a"), Err(Refusal::Replay));
    }

    // ----- copy -----

    #[test]
    fn dialog_copy_has_no_em_or_en_dash() {
        for text in [
            REQUEST_REDACTED,
            "Choose a folder for Burrow to read",
            "Save export",
            "Markdown",
            "JSON",
            "CSV",
        ] {
            assert!(
                !text.contains('\u{2014}') && !text.contains('\u{2013}'),
                "{text}"
            );
        }
        let source = include_str!("dialogs.rs");
        assert!(!source.contains('\u{2014}'));
        assert!(!source.contains('\u{2013}'));
    }
}
