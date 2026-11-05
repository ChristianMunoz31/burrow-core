//! Burrow desktop shell. It starts the bundled `burrow-server` sidecar, waits for its ready line
//! while showing a local splash page, then points the main webview at the server's loopback URL.
//! The window has no IPC capability: the server UI is plain web content. The only thing the server can
//! ask of the shell is an authenticated stdout line: an opt-in update (`updater.rs`) or a native folder picker or save
//! dialog (`dialogs.rs`, answered on the sidecar's stdin).

mod channel;
mod data_guard;
mod dialogs;
mod downloads;
mod exit_dialog;
mod menu;
mod nav;
mod secret;
mod sidecar;
mod updater;

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::webview::{DownloadEvent, NewWindowResponse, WebviewWindowBuilder};
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WindowEvent};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_window_state::StateFlags;

use channel::{Channel, DataLocation, Distribution, DATA_LOCATION_MARKER, DISTRIBUTION_MARKER};
use exit_dialog::{classify_exit, should_show_exit_dialog, DialogAction, ExitDialog, ExitKind};
use nav::NavDecision;
use sidecar::{log_line, ExitInfo, ServerEvent, SharedLog, Sidecar};

const READY_TIMEOUT: Duration = Duration::from_secs(60);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);
const MAIN_LABEL: &str = "main";

/// Runtime state shared by the window handlers, menu and shutdown path.
struct AppState {
    /// Port of the running server, 0 until it is ready.
    port: Arc<AtomicU16>,
    data_dir: Mutex<Option<String>>,
    sidecar: Mutex<Option<Sidecar>>,
    log: SharedLog,
    log_path: PathBuf,
    shutting_down: AtomicBool,
    /// Stable (Burrow) or Dev (Burrow Dev), from the Tauri identifier.
    channel: Channel,
    /// Direct installer or Microsoft Store package, fixed when the shell was compiled.
    distribution: Distribution,
    data_location: DataLocation,
    /// True when the updater plugin is registered: stable channel, direct distribution and a real public key.
    updater_enabled: bool,
    /// `HMAC(secret, "burrow-update-key-v1")` of the running server; the raw secret is not kept.
    update_key: Mutex<Option<[u8; 32]>>,
    /// Single-use nonces and the one-update-at-a-time flag.
    update_guard: updater::UpdateGuard,
    /// `HMAC(secret, "burrow-dialog-key-v1")` of the running server (folder picker and save dialog); the raw secret is not kept.
    dialog_key: Mutex<Option<[u8; 32]>>,
    /// Single-use dialog ids and the one-dialog-at-a-time flag.
    dialog_guard: dialogs::DialogGuard,
}

fn splash_url(path_and_query: &str) -> Option<Url> {
    let origin = if cfg!(windows) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    };
    Url::parse(&format!("{origin}/{path_and_query}")).ok()
}

fn open_external(app: &AppHandle, url: &Url) {
    if let Err(e) = app.opener().open_url(url.as_str(), None::<&str>) {
        eprintln!("could not open an external link: {e}");
    }
}

fn error_page(app: &AppHandle) {
    let state = app.state::<AppState>();
    let log = state.log_path.to_string_lossy().into_owned();
    let Some(mut url) = splash_url("error.html") else {
        return;
    };
    url.query_pairs_mut().append_pair("log", &log);
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        let _ = window.navigate(url);
    }
}

/// Opens the folder a dialog button asked for. Each candidate is checked like the Help menu's data
/// folder (absolute, not UNC, an existing directory). The restore dialog tries the folder named by
/// the server, then the shell's own data folder; every dialog ends at the log folder, with a log
/// line whenever it falls back.
fn open_folder(app: &AppHandle, dialog: &ExitDialog) {
    let state = app.state::<AppState>();
    let as_text = |p: &Path| p.to_string_lossy().into_owned();
    let mut candidates: Vec<(&str, Option<String>)> =
        vec![("dialog", dialog.open_dir.as_deref().map(as_text))];
    if dialog.kind != ExitKind::Generic {
        candidates.push((
            "default data",
            exit_dialog::default_data_dir(|k| std::env::var(k).ok(), state.channel)
                .as_deref()
                .map(as_text),
        ));
    }
    let mut dir = None;
    for (index, (name, candidate)) in candidates.into_iter().enumerate() {
        if let Some(c) = candidate.filter(|c| is_safe_data_dir(c)) {
            if index > 0 {
                log_line(
                    &state.log,
                    "shell",
                    &format!("opening the {name} folder instead"),
                );
            }
            dir = Some(c);
            break;
        }
    }
    let dir = dir.or_else(|| {
        log_line(&state.log, "shell", "opening the log folder instead");
        state.log_path.parent().map(as_text)
    });
    if let Some(dir) = dir {
        if let Err(e) = app.opener().open_path(dir, None::<&str>) {
            eprintln!("could not open the folder: {e}");
        }
    }
}

/// Shows the native exit dialog and keeps showing it after "Open ..." and "Copy details" until the
/// user chooses Quit or closes it. Blocks the calling thread (never the main thread). Never
/// deletes or moves a file.
fn show_exit_dialog(app: &AppHandle, dialog: &ExitDialog) {
    loop {
        let buttons = match dialog.buttons.as_slice() {
            [a, b, c] => MessageDialogButtons::YesNoCancelCustom(a.clone(), b.clone(), c.clone()),
            [a, b] => MessageDialogButtons::OkCancelCustom(a.clone(), b.clone()),
            _ => MessageDialogButtons::OkCustom(exit_dialog::QUIT_LABEL.to_string()),
        };
        let mut builder = app
            .dialog()
            .message(&dialog.message)
            .title(&dialog.title)
            .kind(MessageDialogKind::Error)
            .buttons(buttons);
        if let Some(window) = app.get_webview_window(MAIN_LABEL) {
            builder = builder.parent(&window);
        }
        let label = match builder.blocking_show_with_result() {
            MessageDialogResult::Custom(label) => label,
            _ => exit_dialog::QUIT_LABEL.to_string(),
        };
        match dialog.action_for(&label) {
            DialogAction::OpenFolder => open_folder(app, dialog),
            DialogAction::CopyDetails => {
                if let Err(e) = app.clipboard().write_text(dialog.details.clone()) {
                    eprintln!("could not copy the details: {e}");
                }
            }
            DialogAction::Quit => {
                app.exit(0);
                return;
            }
        }
    }
}

/// Explains an early or unexpected server exit in a native dialog, after the error page is shown.
fn report_exit(app: &AppHandle, info: &ExitInfo) {
    let state = app.state::<AppState>();
    let code_text = info
        .code
        .map_or_else(|| "none".to_string(), |c| c.to_string());
    let shutting_down = state.shutting_down.load(Ordering::SeqCst);
    if !should_show_exit_dialog(shutting_down, info.code) {
        log_line(
            &state.log,
            "shell",
            &format!("the server exited with code {code_text}; no dialog (shutting down: {shutting_down})"),
        );
        if !shutting_down {
            state.port.store(0, Ordering::SeqCst);
            error_page(app);
        }
        return;
    }
    log_line(
        &state.log,
        "shell",
        &format!("the server exited with code {code_text}"),
    );
    let data_dir = exit_dialog::default_data_dir(|k| std::env::var(k).ok(), state.channel);
    let dialog = classify_exit(
        info.code,
        &info.stderr_tail,
        data_dir.as_deref(),
        &state.log_path,
    );
    state.port.store(0, Ordering::SeqCst);
    error_page(app);
    show_exit_dialog(app, &dialog);
}

fn navigate_main(app: &AppHandle, url: Url) {
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        let _ = window.navigate(url);
    }
}

/// `http://127.0.0.1:<port>/settings#<section>`; `None` while the server is not ready (port 0).
fn settings_url(port: u16, section: &str) -> Option<Url> {
    if port == 0 {
        return None;
    }
    Url::parse(&format!("http://127.0.0.1:{port}/settings#{section}")).ok()
}

/// Next event that decides the start: an update or dialog request before the server is ready is logged and
/// skipped, and the wait continues until `deadline`. Never returns `UpdateRequest` or `DialogRequest`.
fn wait_for_ready(
    rx: &Receiver<ServerEvent>,
    deadline: Instant,
    state: &AppState,
) -> Result<ServerEvent, RecvTimeoutError> {
    loop {
        match rx.recv_timeout(deadline.saturating_duration_since(Instant::now()))? {
            ServerEvent::UpdateRequest(_) => log_line(
                &state.log,
                "shell",
                "ignored an update request (the server is not ready yet)",
            ),
            ServerEvent::DialogRequest(_) => log_line(
                &state.log,
                "shell",
                "ignored a dialog request (the server is not ready yet)",
            ),
            other => return Ok(other),
        }
    }
}

/// Waits for the server, then loads the UI. Runs on its own thread for the app's lifetime so a
/// server that dies later also lands on the error page.
fn supervise(app: AppHandle, rx: Receiver<ServerEvent>, token: String) {
    let state = app.state::<AppState>();
    let ready_deadline = Instant::now() + READY_TIMEOUT;
    let ready = match wait_for_ready(&rx, ready_deadline, &state) {
        Ok(ServerEvent::Ready(ready)) => ready,
        Ok(ServerEvent::UpdateRequest(_) | ServerEvent::DialogRequest(_)) => return,
        Err(RecvTimeoutError::Timeout) => {
            log_line(&state.log, "shell", "timed out waiting for the server");
            if let Some(sidecar) = state.sidecar.lock().ok().and_then(|mut s| s.take()) {
                sidecar.shutdown(Duration::ZERO);
            }
            state.port.store(0, Ordering::SeqCst);
            error_page(&app);
            return;
        }
        Ok(ServerEvent::Exited(info)) => {
            log_line(&state.log, "shell", "the server exited before it was ready");
            report_exit(&app, &info);
            return;
        }
        Err(RecvTimeoutError::Disconnected) => {
            log_line(&state.log, "shell", "the server exited before it was ready");
            report_exit(
                &app,
                &ExitInfo {
                    code: None,
                    stderr_tail: String::new(),
                },
            );
            return;
        }
    };
    if let Err(message) = check_ready(&state, &ready) {
        log_line(&state.log, "shell", &message);
        if let Some(sidecar) = state.sidecar.lock().ok().and_then(|mut s| s.take()) {
            sidecar.shutdown(Duration::ZERO);
        }
        state.port.store(0, Ordering::SeqCst);
        error_page(&app);
        return;
    }
    log_line(
        &state.log,
        "shell",
        &format!("server {} ready on port {}", ready.version, ready.port),
    );
    state.port.store(ready.port, Ordering::SeqCst);
    if let Ok(mut dir) = state.data_dir.lock() {
        *dir = Some(ready.data_dir.clone());
    }
    match Url::parse(&format!(
        "http://127.0.0.1:{}/desktop/bootstrap?token={token}",
        ready.port
    )) {
        Ok(url) => navigate_main(&app, url),
        Err(_) => {
            error_page(&app);
            return;
        }
    }
    let mut exit = None;
    while let Ok(event) = rx.recv() {
        match event {
            ServerEvent::Exited(info) => {
                exit = Some(info);
                break;
            }
            ServerEvent::UpdateRequest(req) => updater::dispatch(&app, req),
            ServerEvent::DialogRequest(req) => dialogs::dispatch(&app, req),
            ServerEvent::Ready(_) => {}
        }
    }
    if !state.shutting_down.load(Ordering::SeqCst) {
        log_line(&state.log, "shell", "the server stopped unexpectedly");
        report_exit(
            &app,
            &exit.unwrap_or(ExitInfo {
                code: None,
                stderr_tail: String::new(),
            }),
        );
    }
}

/// A ready line is only trusted when the server runs in this shell's channel and distribution (a Store shell
/// with a direct server would offer the GitHub update check) and, for Burrow Dev, on a data folder that does
/// not overlap the one of Burrow.
fn check_ready(state: &AppState, ready: &sidecar::Ready) -> Result<(), String> {
    if !ready.matches_channel(state.channel) {
        return Err(format!(
            "the server reported channel \"{}\" but this app is {}; refusing it",
            ready.channel,
            state.channel.as_str()
        ));
    }
    if !ready.matches_distribution(state.distribution) {
        return Err(format!(
            "the server reported distribution \"{}\" but this app is {}; refusing it",
            ready.distribution.as_deref().unwrap_or("direct"),
            state.distribution.as_str()
        ));
    }
    if !ready.matches_data_location(state.data_location) {
        return Err(format!(
            "the server reported data location \"{}\" but this app is {}; refusing it",
            ready.data_location.as_deref().unwrap_or("appdata"),
            state.data_location.as_str()
        ));
    }
    sidecar::check_reported_data_dir(state.channel, &shell_env(), &ready.data_dir)
}

/// The user profile data folder when this build must check its ownership before anything is written there: the Store build
/// with the `userprofile` data location on Windows and no `BURROW_DESKTOP_DATA_DIR` override (an override is the developer's
/// own folder). `None` for every other build, which has no marker rule.
fn owned_data_dir_to_check(
    get: impl Fn(&str) -> Option<String>,
    user_profile: bool,
) -> Option<PathBuf> {
    let overridden = get("BURROW_DESKTOP_DATA_DIR").is_some_and(|v| !v.trim().is_empty());
    if !user_profile || overridden {
        return None;
    }
    exit_dialog::user_profile_data_dir(get)
}

/// Folder of `server.log`. Normally Tauri's app log folder (`%LOCALAPPDATA%\com.burrow.desktop\logs`). In the user profile
/// data location (the Store build without unvirtualized resources) MSIX would redirect that new file into the package's
/// LocalCache and delete it on uninstall, so the log goes to `<data folder>\logs` instead, where support can find it next
/// to the data. (WebView2's own folder and the window state stay under LOCALAPPDATA and are virtualized: they are caches.)
/// `<data folder>\logs` is used only when it is missing (it is created) or a real folder: if it exists as a file, a symbolic
/// link, a junction or any other reparse point, the log goes to the default folder instead, so the shell neither fails to
/// start nor writes through a link.
fn log_dir_for(default_dir: PathBuf, data_dir: Option<PathBuf>, user_profile: bool) -> PathBuf {
    match (user_profile, data_dir) {
        (true, Some(dir)) => {
            let logs = dir.join("logs");
            if logs_folder_usable(&logs) {
                logs
            } else {
                default_dir
            }
        }
        _ => default_dir,
    }
}

/// True when `logs` does not exist yet or is a real folder (not a link of any kind, not a file).
fn logs_folder_usable(logs: &Path) -> bool {
    match fs::symlink_metadata(logs) {
        Ok(meta) => meta.is_dir() && !data_guard::is_link_or_reparse(&meta),
        Err(e) => e.kind() == std::io::ErrorKind::NotFound,
    }
}

/// What the shell decides before it writes anything: whether the user profile data folder is refused (`Some`), and the folder
/// of `server.log`. In the user profile location the ownership of the data folder is decided first (a missing one is created
/// with its marker); a folder that is not ours is never written to, not even a log, so the log then goes to
/// `default_log_dir` (the default, virtualized log folder) and the server is not started.
fn startup_plan(
    get: impl Fn(&str) -> Option<String>,
    channel: Channel,
    user_profile: bool,
    now: std::time::SystemTime,
    default_log_dir: PathBuf,
) -> (Option<data_guard::NotOurs>, PathBuf) {
    let refusal = owned_data_dir_to_check(&get, user_profile)
        .and_then(|dir| data_guard::ensure_owned(&dir, now).err());
    let data_dir_for_log = if refusal.is_some() {
        None
    } else {
        exit_dialog::default_data_dir(&get, channel)
    };
    let log_dir = log_dir_for(default_log_dir, data_dir_for_log, user_profile);
    (refusal, log_dir)
}

fn shell_env() -> HashMap<String, String> {
    std::env::vars_os()
        .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
        .collect()
}

/// Spawns the server. Returns the token the webview presents once the server is ready.
fn start_server(
    app: &AppHandle,
    state: &AppState,
) -> Result<(Receiver<ServerEvent>, String), String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("no resource directory: {e}"))?;
    let source = shell_env();
    // Burrow Dev never runs on the data folder of Burrow: refuse before the server starts.
    sidecar::check_data_dir_isolation(state.channel, &source)?;
    let launch = sidecar::resolve_launch(&resource_dir, &source, state.channel)?;
    let env = sidecar::build_sidecar_env(
        &source,
        &launch.dist_dir,
        &launch.migrations_dir,
        state.channel,
        state.updater_enabled,
    );
    if let Some(dir) = source
        .get("BURROW_DESKTOP_DATA_DIR")
        .filter(|d| !d.is_empty())
    {
        log_line(
            &state.log,
            "shell",
            &format!("Using data folder override from BURROW_DESKTOP_DATA_DIR: {dir}"),
        );
    }
    if state.channel == Channel::Dev {
        if let Some(dir) = source
            .get("BURROW_DESKTOP_STABLE_DATA_DIR")
            .filter(|d| !d.trim().is_empty())
        {
            log_line(
                &state.log,
                "shell",
                &format!("Using copy source override from BURROW_DESKTOP_STABLE_DATA_DIR: {dir}"),
            );
        }
    }
    let secret = secret::generate_secret()?;
    let token = secret::bootstrap_token(&secret);
    if let Ok(mut key) = state.update_key.lock() {
        *key = Some(secret::update_mac_key(&secret));
    }
    if let Ok(mut key) = state.dialog_key.lock() {
        *key = Some(secret::dialog_mac_key(&secret));
    }
    let (sidecar, rx) = sidecar::spawn(&launch, &env, &secret, &state.log)?;
    if let Ok(mut slot) = state.sidecar.lock() {
        *slot = Some(sidecar);
    }
    Ok((rx, token))
}

fn download_allowed(url: &Url, port: u16) -> bool {
    if url.scheme() == "blob" {
        return Url::parse(url.path())
            .map(|inner| nav::classify(&inner, port) == NavDecision::Allow)
            .unwrap_or(false);
    }
    nav::classify(url, port) == NavDecision::Allow
}

fn build_main_window(app: &AppHandle, port: Arc<AtomicU16>, channel: Channel) -> tauri::Result<()> {
    let nav_app = app.clone();
    let nav_port = Arc::clone(&port);
    let new_app = app.clone();
    let new_port = Arc::clone(&port);
    let dl_port = port;

    WebviewWindowBuilder::new(app, MAIN_LABEL, WebviewUrl::App("index.html".into()))
        .title(channel.product_name())
        .inner_size(1200.0, 800.0)
        .min_inner_size(960.0, 640.0)
        .center()
        .on_navigation(
            move |url| match nav::classify(url, nav_port.load(Ordering::SeqCst)) {
                NavDecision::Allow => true,
                NavDecision::External => {
                    open_external(&nav_app, url);
                    false
                }
                NavDecision::Deny => false,
            },
        )
        .on_new_window(move |url, _features| {
            if nav::classify(&url, new_port.load(Ordering::SeqCst)) == NavDecision::External {
                open_external(&new_app, &url);
            }
            NewWindowResponse::Deny
        })
        .on_download(move |webview, event| match event {
            DownloadEvent::Requested { url, destination } => {
                if !download_allowed(&url, dl_port.load(Ordering::SeqCst)) {
                    return false;
                }
                let app = webview.app_handle();
                let name = destination
                    .file_name()
                    .map(|n| downloads::sanitize_file_name(&n.to_string_lossy()))
                    .unwrap_or_else(|| downloads::sanitize_file_name(""));
                let dir = app
                    .path()
                    .download_dir()
                    .ok()
                    .or_else(|| destination.parent().map(PathBuf::from));
                if let Some(dir) = dir {
                    let _ = fs::create_dir_all(&dir);
                    *destination = downloads::unique_path(&dir, &name, |p| p.exists());
                }
                true
            }
            DownloadEvent::Finished { path, success, .. } => {
                if let (true, Some(path)) = (success, path) {
                    let _ = webview.app_handle().opener().reveal_item_in_dir(path);
                }
                true
            }
            _ => true,
        })
        .build()?;
    Ok(())
}

/// Only an absolute, non-UNC path to an existing directory may be opened from the menu.
fn is_safe_data_dir(dir: &str) -> bool {
    let path = Path::new(dir);
    path.is_absolute()
        && !dir.starts_with("\\\\")
        && !dir.starts_with("//")
        && fs::metadata(path).map(|m| m.is_dir()).unwrap_or(false)
}

fn on_menu_event(app: &AppHandle, id: &str) {
    let state = app.state::<AppState>();
    match id {
        menu::OPEN_DATA_ID => {
            let dir = state.data_dir.lock().ok().and_then(|d| d.clone());
            if let Some(dir) = dir {
                if !is_safe_data_dir(&dir) {
                    log_line(&state.log, "shell", "ignored an unsafe data folder path");
                } else if let Err(e) = app.opener().open_path(dir, None::<&str>) {
                    eprintln!("could not open the data folder: {e}");
                }
            }
        }
        menu::REPORT_CONTENT_ID => {
            // Same default-mail-app path as a mailto link clicked in the window (nav.rs). Opens a draft only.
            if let Ok(url) = Url::parse(&menu::report_content_url()) {
                open_external(app, &url);
            }
        }
        menu::ADD_FOLDER_ID => {
            // Only navigates: the Folders page starts the normal flow (page to server to an authenticated line to this shell).
            let port = state.port.load(Ordering::SeqCst);
            if port != 0 {
                if let Ok(url) = Url::parse(&format!("http://127.0.0.1:{port}/folders#add-folder"))
                {
                    navigate_main(app, url);
                }
            }
        }
        menu::EXPORT_DATA_ID => {
            if let Some(url) = settings_url(state.port.load(Ordering::SeqCst), "data-storage") {
                navigate_main(app, url);
            }
        }
        menu::CHECK_UPDATES_ID => {
            // Navigation only: the Updates section decides what each channel shows. No network, no IPC.
            if let Some(url) = settings_url(state.port.load(Ordering::SeqCst), "updates") {
                navigate_main(app, url);
            }
        }
        _ => {}
    }
}

fn mark_shutting_down(app: &AppHandle) {
    app.state::<AppState>()
        .shutting_down
        .store(true, Ordering::SeqCst);
}

fn shutdown_sidecar(app: &AppHandle) {
    mark_shutting_down(app);
    let state = app.state::<AppState>();
    let sidecar = state.sidecar.lock().ok().and_then(|mut s| s.take());
    if let Some(sidecar) = sidecar {
        sidecar.shutdown(SHUTDOWN_GRACE);
    }
}

/// Entry point shared by the binary and (later) mobile targets.
pub fn run() {
    let context = tauri::generate_context!();
    let channel = Channel::from_identifier(&context.config().identifier);
    let distribution = Distribution::current();
    let data_location = DataLocation::current();
    let updater_enabled = updater::should_enable(
        channel,
        distribution,
        context.config().plugins.0.get("updater"),
    );
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window(MAIN_LABEL) {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
                .build(),
        )
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init());
    if updater_enabled {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
    let app = builder
        .on_menu_event(|app, event| on_menu_event(app, event.id().as_ref()))
        .setup(move |app| {
            let handle = app.handle().clone();
            let user_profile = data_location.uses_user_profile(channel, distribution);
            // Before any file is written (see `startup_plan`): the data folder's ownership first, then the log folder.
            let (refusal, log_dir) = startup_plan(
                |k| std::env::var(k).ok(),
                channel,
                user_profile,
                std::time::SystemTime::now(),
                handle.path().app_log_dir()?,
            );
            fs::create_dir_all(&log_dir)?;
            let log_path = log_dir.join("server.log");
            let log: SharedLog = Arc::new(Mutex::new(fs::File::create(&log_path)?));
            let port = Arc::new(AtomicU16::new(0));
            app.manage(AppState {
                port: Arc::clone(&port),
                data_dir: Mutex::new(None),
                sidecar: Mutex::new(None),
                log,
                log_path,
                shutting_down: AtomicBool::new(false),
                channel,
                distribution,
                data_location,
                updater_enabled,
                update_key: Mutex::new(None),
                update_guard: updater::UpdateGuard::default(),
                dialog_key: Mutex::new(None),
                dialog_guard: dialogs::DialogGuard::default(),
            });

            log_line(
                &handle.state::<AppState>().log,
                "shell",
                &format!(
                    "{} ({}) {} {}",
                    channel.product_name(),
                    channel.identifier(),
                    DISTRIBUTION_MARKER,
                    DATA_LOCATION_MARKER
                ),
            );
            app.set_menu(menu::build(&handle, channel)?)?;
            build_main_window(&handle, port, channel)?;

            if let Some(not_ours) = refusal {
                let message = not_ours.message();
                log_line(&handle.state::<AppState>().log, "shell", &message);
                error_page(&handle);
                // The dialog blocks until the user chooses, so it runs off the main thread (like `supervise`).
                std::thread::spawn(move || {
                    report_exit(
                        &handle,
                        &ExitInfo {
                            code: Some(data_guard::EXIT_DATA_DIR_NOT_OURS),
                            stderr_tail: message,
                        },
                    );
                });
                return Ok(());
            }
            let started = {
                let state = handle.state::<AppState>();
                start_server(&handle, &state).inspect_err(|message| {
                    log_line(&state.log, "shell", message);
                })
            };
            match started {
                Ok((rx, token)) => {
                    std::thread::spawn(move || supervise(handle, rx, token));
                }
                Err(_) => error_page(&handle),
            }
            Ok(())
        })
        .build(context)
        .expect("error while building the Burrow desktop shell");

    app.run(|app, event| match event {
        RunEvent::WindowEvent {
            event: WindowEvent::CloseRequested { .. },
            ..
        } => mark_shutting_down(app),
        RunEvent::ExitRequested { .. } | RunEvent::Exit => shutdown_sidecar(app),
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_url_needs_a_port_and_ends_in_the_exact_fragment() {
        assert_eq!(settings_url(0, "updates"), None);
        let url = settings_url(5000, "updates").expect("a port gives a URL");
        assert_eq!(url.as_str(), "http://127.0.0.1:5000/settings#updates");
        assert_eq!(url.fragment(), Some("updates"));
        assert_eq!(nav::classify(&url, 5000), NavDecision::Allow);
        assert_eq!(
            settings_url(4321, "data-storage").map(|u| u.to_string()),
            Some("http://127.0.0.1:4321/settings#data-storage".to_string())
        );
    }

    #[test]
    fn only_the_user_profile_location_without_an_override_is_checked() {
        let get = |k: &str| match k {
            "USERPROFILE" => Some("C:\\Users\\example".to_string()),
            _ => None,
        };
        assert_eq!(owned_data_dir_to_check(get, false), None);
        let overridden = |k: &str| match k {
            "USERPROFILE" => Some("C:\\Users\\example".to_string()),
            "BURROW_DESKTOP_DATA_DIR" => Some("C:\\Temp\\x".to_string()),
            _ => None,
        };
        assert_eq!(owned_data_dir_to_check(overridden, true), None);
        assert_eq!(
            owned_data_dir_to_check(get, true),
            Some(Path::new("C:\\Users\\example").join("Burrow Data"))
        );
    }

    #[test]
    fn the_log_stays_in_the_default_folder_unless_data_lives_in_the_user_profile() {
        let default_dir = PathBuf::from("default-logs");
        let data = PathBuf::from("data");
        assert_eq!(
            log_dir_for(default_dir.clone(), Some(data.clone()), false),
            default_dir
        );
        assert_eq!(
            log_dir_for(default_dir.clone(), Some(data.clone()), true),
            data.join("logs")
        );
        assert_eq!(log_dir_for(default_dir.clone(), None, true), default_dir);
    }

    fn profile_env(profile: &Path) -> impl Fn(&str) -> Option<String> {
        let profile = profile.display().to_string();
        move |k: &str| match k {
            "USERPROFILE" => Some(profile.clone()),
            _ => None,
        }
    }

    #[test]
    fn a_foreign_burrow_data_folder_is_refused_unchanged_and_the_log_stays_in_the_default_folder() {
        let t = data_guard::testing::Temp::new();
        let data = t.data();
        fs::create_dir_all(data.join(".git")).unwrap();
        fs::write(data.join("README.md"), b"somebody else's folder").unwrap();
        let before = data_guard::testing::snapshot(&data);
        let default_logs = t.0.join("default-logs");
        let (refusal, log_dir) = startup_plan(
            profile_env(&t.0),
            Channel::Stable,
            true,
            std::time::UNIX_EPOCH,
            default_logs.clone(),
        );
        let refusal = refusal.expect("a foreign folder must be refused");
        assert_eq!(refusal.dir, data);
        assert_eq!(refusal.reason, data_guard::NotOursReason::NotEmpty);
        assert_eq!(log_dir, default_logs);
        assert_eq!(data_guard::testing::snapshot(&data), before);
        assert!(!data.join("logs").exists());
        assert!(!data.join(data_guard::MARKER_FILE).exists());
        assert!(
            !default_logs.exists(),
            "the plan decides; it creates no log folder"
        );
    }

    #[test]
    fn an_owned_data_folder_is_not_refused_and_a_missing_one_is_created_with_its_marker() {
        let t = data_guard::testing::Temp::new();
        let default_logs = t.0.join("default-logs");
        let (refusal, log_dir) = startup_plan(
            profile_env(&t.0),
            Channel::Stable,
            true,
            std::time::UNIX_EPOCH,
            default_logs.clone(),
        );
        assert_eq!(refusal, None);
        assert_eq!(
            data_guard::inspect(&t.data()),
            data_guard::Inspection::Marked
        );
        // Where the log goes then depends on the data location this binary was built for.
        let expected = exit_dialog::default_data_dir(|k| profile_env(&t.0)(k), Channel::Stable)
            .map_or(default_logs.clone(), |d| d.join("logs"));
        assert_eq!(log_dir, expected);
        // A build without the user profile location has no rule: nothing is created or checked.
        let other = data_guard::testing::Temp::new();
        let (none, log_dir) = startup_plan(
            profile_env(&other.0),
            Channel::Stable,
            false,
            std::time::UNIX_EPOCH,
            default_logs.clone(),
        );
        assert_eq!(none, None);
        assert_eq!(log_dir, default_logs);
        assert!(!other.data().exists());
    }

    #[test]
    fn a_data_folder_that_cannot_be_created_is_reported_and_the_log_stays_in_the_default_folder() {
        let t = data_guard::testing::Temp::new();
        let (refusal, log_dir) = startup_plan(
            profile_env(&t.0.join("no-such-profile")),
            Channel::Stable,
            true,
            std::time::UNIX_EPOCH,
            t.0.join("default-logs"),
        );
        assert_eq!(
            refusal.map(|r| r.reason),
            Some(data_guard::NotOursReason::CreateFailed)
        );
        assert_eq!(log_dir, t.0.join("default-logs"));
        assert!(!t.0.join("no-such-profile").exists());
    }

    #[test]
    fn a_logs_entry_that_is_not_a_real_folder_sends_the_log_to_the_default_folder() {
        let default_dir = PathBuf::from("default-logs");
        // A file called logs.
        let t = data_guard::testing::Temp::new();
        let data = t.0.join("data");
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("logs"), b"i am a file").unwrap();
        assert_eq!(
            log_dir_for(default_dir.clone(), Some(data.clone()), true),
            default_dir
        );
        assert_eq!(fs::read(data.join("logs")).unwrap(), b"i am a file");
        // A link (junction on Windows) called logs, to a real folder and dangling.
        let data2 = t.0.join("data2");
        let elsewhere = t.0.join("elsewhere");
        fs::create_dir_all(&data2).unwrap();
        fs::create_dir_all(&elsewhere).unwrap();
        if data_guard::testing::make_link(&elsewhere, &data2.join("logs")) {
            assert_eq!(
                log_dir_for(default_dir.clone(), Some(data2.clone()), true),
                default_dir
            );
            fs::remove_dir(&elsewhere).unwrap();
            assert_eq!(
                log_dir_for(default_dir.clone(), Some(data2.clone()), true),
                default_dir
            );
            assert!(!elsewhere.exists(), "nothing is created through the link");
        } else {
            eprintln!("SKIPPED: could not create a junction or symbolic link here");
        }
        // A real folder or a missing one is used.
        let data3 = t.0.join("data3");
        fs::create_dir_all(data3.join("logs")).unwrap();
        assert_eq!(
            log_dir_for(default_dir.clone(), Some(data3.clone()), true),
            data3.join("logs")
        );
        assert_eq!(
            log_dir_for(default_dir, Some(t.0.join("data4")), true),
            t.0.join("data4").join("logs")
        );
    }
}
