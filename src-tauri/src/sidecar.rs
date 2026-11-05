//! The `burrow-server` sidecar: environment, launch, ready handshake, log draining, shutdown.
//!
//! Protocol (fixed contract with the server):
//! - The child gets a minimal environment (see [`build_sidecar_env`]) and a 64-hex secret plus a
//!   newline on stdin. We keep stdin open for the whole app lifetime; closing it is the graceful
//!   shutdown signal.
//! - The child prints `BURROW_READY {"port":N,"dataDir":"...","version":"...","channel":"stable|dev","commit":"<sha7>"|null}` on
//!   stdout. The shell refuses a ready line whose channel is not its own.
//! - The child may also print `BURROW_UPDATE_REQUEST {"v":1,"version":"x.y.z","nonce":"<32 hex>","mac":"<64 hex>"}`
//!   to ask for an opt-in update (see `updater.rs`). The shell only acts on it when the MAC verifies, the
//!   channel is stable and the updater is enabled; `BURROW_SHELL_UPDATER=1` in the child's env tells the
//!   server that this is the case.
//! - The child may print `BURROW_DIALOG_REQUEST {"v":1,"kind":"pick_folder|save_file","id":"<32 hex>","ttl":900,"name":"...","ext":"...","bytes":N,"mac":"<64 hex>"}`
//!   to ask for a native dialog (folder picker or save dialog, see `dialogs.rs`). The shell answers on the child's stdin
//!   with one line, `BURROW_DIALOG_REPLY {"v":1,"id":"<32 hex>","status":"...","path":"...","mac":"<64 hex>"}`, written by
//!   [`Sidecar::send_line`]. `BURROW_SHELL_DIALOGS=1` in the child's env tells the server that the shell can do this; the
//!   request lines are never written to `server.log` in full.

use std::collections::{HashMap, VecDeque};
use std::ffi::OsString;
use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::channel::{paths_overlap, Channel, DataLocation, Distribution};
use crate::dialogs::{log_redaction, parse_dialog_request, DialogRequest};
use crate::exit_dialog::{platform_data_dir, stable_default_data_dirs};
use crate::secret::{to_hex, SECRET_LEN};
use crate::updater::{parse_update_request, UpdateRequest};

/// Prefix of the stdout line that announces the server is listening.
pub const READY_PREFIX: &str = "BURROW_READY ";

/// Variables copied from the shell's environment into the sidecar's, when present.
/// OneDrive, OneDriveConsumer and OneDriveCommercial are sync-root paths (not secrets); server/dataFolderHealth.js needs them to
/// warn when the data folder lies under a OneDrive root.
const PASSTHROUGH: [&str; 11] = [
    "SystemRoot",
    "TEMP",
    "TMP",
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "HOME",
    "XDG_DATA_HOME",
    "OneDrive",
    "OneDriveConsumer",
    "OneDriveCommercial",
];

/// The parsed `BURROW_READY` payload.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Ready {
    pub port: u16,
    #[serde(rename = "dataDir")]
    pub data_dir: String,
    pub version: String,
    /// Channel of the server (`stable` or `dev`); a line without it is not a ready line.
    pub channel: String,
    /// `direct` or `store`; a line without it (a server built before the Store flavor) is `direct`.
    #[serde(default)]
    pub distribution: Option<String>,
    /// `appdata` or `userprofile`; a line without it (a server built before the data location existed) is `appdata`.
    #[serde(default, rename = "dataLocation")]
    pub data_location: Option<String>,
}

impl Ready {
    /// True when the server runs in the same channel as this shell.
    pub fn matches_channel(&self, channel: Channel) -> bool {
        self.channel == channel.as_str()
    }

    /// True when the server was built for the same distribution as this shell (an absent field is `direct`).
    pub fn matches_distribution(&self, distribution: Distribution) -> bool {
        self.distribution.as_deref().unwrap_or("direct") == distribution.as_str()
    }

    /// True when the server keeps its data where this shell expects (an absent field is `appdata`).
    pub fn matches_data_location(&self, location: DataLocation) -> bool {
        self.data_location.as_deref().unwrap_or("appdata") == location.as_str()
    }
}

/// Parses one stdout line. Returns `None` for anything that is not a well-formed ready line
/// (including port 0 or missing fields, the channel included).
pub fn parse_ready_line(line: &str) -> Option<Ready> {
    let payload = line
        .trim_end_matches(['\r', '\n'])
        .strip_prefix(READY_PREFIX)?;
    let ready: Ready = serde_json::from_str(payload).ok()?;
    (ready.port != 0).then_some(ready)
}

fn lookup<'a>(source: &'a HashMap<String, String>, key: &str) -> Option<&'a String> {
    if let Some(v) = source.get(key) {
        return Some(v);
    }
    if cfg!(windows) {
        return source
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(key))
            .map(|(_, v)| v);
    }
    None
}

/// Message shown (and logged) when a Dev shell would run on the data folder of Burrow.
pub const DEV_DATA_DIR_REFUSED: &str = "Burrow Dev cannot use this data folder because it is the same as, or overlaps, the folder where Burrow keeps its data. Nothing was read or changed.";

/// Dev shell only: refuses a data folder (the `BURROW_DESKTOP_DATA_DIR` override, else the Dev default)
/// that is, contains or lies inside the stable default folder or the stable copy source. The stable
/// shell is not checked. Pure path comparison by real location.
pub fn check_data_dir_isolation(
    channel: Channel,
    source: &HashMap<String, String>,
) -> Result<(), String> {
    if channel != Channel::Dev {
        return Ok(());
    }
    let get = |key: &str| lookup(source, key).cloned();
    let Some(effective) = source
        .get("BURROW_DESKTOP_DATA_DIR")
        .filter(|d| !d.trim().is_empty())
        .map(|d| PathBuf::from(d.trim()))
        .or_else(|| platform_data_dir(get, Channel::Dev))
    else {
        return Ok(());
    };
    refuse_if_stable(source, &effective)
}

/// The same check for a data folder the server reported in its ready line.
pub fn check_reported_data_dir(
    channel: Channel,
    source: &HashMap<String, String>,
    data_dir: &str,
) -> Result<(), String> {
    if channel != Channel::Dev {
        return Ok(());
    }
    refuse_if_stable(source, Path::new(data_dir))
}

fn refuse_if_stable(source: &HashMap<String, String>, dir: &Path) -> Result<(), String> {
    let get = |key: &str| lookup(source, key).cloned();
    // Both default folders of the stable Burrow: %APPDATA%\Burrow and, on Windows, %USERPROFILE%\Burrow Data of the Store build.
    let mut stable: Vec<PathBuf> = stable_default_data_dirs(get);
    if let Some(copy_source) =
        lookup(source, "BURROW_DESKTOP_STABLE_DATA_DIR").filter(|d| !d.trim().is_empty())
    {
        stable.push(PathBuf::from(copy_source.trim()));
    }
    if stable.iter().any(|s| paths_overlap(s, dir)) {
        Err(DEV_DATA_DIR_REFUSED.to_string())
    } else {
        Ok(())
    }
}

/// Builds the sidecar's complete environment from the shell's environment. Everything not named
/// here (NODE_OPTIONS, OLLAMA_HOST, APP_PASSWORD, tokens, BURROW_DATA_DIR, ...) is dropped.
/// `BURROW_DESKTOP_DATA_DIR` in the shell becomes `BURROW_DATA_DIR` for the child. In the Dev channel only,
/// `BURROW_DESKTOP_STABLE_DATA_DIR` becomes `BURROW_STABLE_DATA_DIR` (the test source for "Copy my data
/// from Burrow"); a stable shell never passes it, and a raw `BURROW_STABLE_DATA_DIR` is always dropped.
pub fn build_sidecar_env(
    source: &HashMap<String, String>,
    dist_dir: &Path,
    migrations_dir: &Path,
    channel: Channel,
    updater_enabled: bool,
) -> HashMap<String, String> {
    let mut env = HashMap::new();
    for key in PASSTHROUGH {
        if let Some(v) = lookup(source, key) {
            env.insert(key.to_string(), v.clone());
        }
    }
    if cfg!(windows) {
        if let Some(root) = lookup(source, "SystemRoot") {
            env.insert("PATH".into(), format!("{root}\\System32"));
        }
    } else {
        // Fixed system path: the developer's PATH never reaches the sidecar.
        env.insert("PATH".into(), "/usr/bin:/bin".into());
    }
    env.insert("BURROW_DESKTOP".into(), "1".into());
    // The server refuses to start when this is not its own channel (see server/channelGuards.js).
    env.insert("BURROW_SHELL_CHANNEL".into(), channel.as_str().into());
    // Tells the server it may offer "Download and install". Never a passthrough: only the stable
    // shell with a real updater key sets it.
    if updater_enabled && channel == Channel::Stable {
        env.insert("BURROW_SHELL_UPDATER".into(), "1".into());
    }
    // Tells the server that this shell opens the native folder picker and save dialog for it (dialogs.rs). Always set, for
    // every channel and distribution, and never a passthrough: a value in the shell's own environment is ignored.
    env.insert("BURROW_SHELL_DIALOGS".into(), "1".into());
    env.insert("BURROW_HOST".into(), "127.0.0.1".into());
    env.insert("BURROW_PORT".into(), "0".into());
    env.insert("BURROW_NO_DOTENV".into(), "1".into());
    env.insert(
        "BURROW_DIST_DIR".into(),
        dist_dir.to_string_lossy().into_owned(),
    );
    env.insert(
        "BURROW_MIGRATIONS_DIR".into(),
        migrations_dir.to_string_lossy().into_owned(),
    );
    if let Some(dir) = source
        .get("BURROW_DESKTOP_DATA_DIR")
        .filter(|d| !d.is_empty())
    {
        env.insert("BURROW_DATA_DIR".into(), dir.clone());
    }
    if channel == Channel::Dev {
        if let Some(dir) = source
            .get("BURROW_DESKTOP_STABLE_DATA_DIR")
            .filter(|d| !d.trim().is_empty())
        {
            env.insert("BURROW_STABLE_DATA_DIR".into(), dir.clone());
        }
    }
    env
}

/// How to start the server process.
#[derive(Debug)]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub cwd: Option<PathBuf>,
    pub dist_dir: PathBuf,
    pub migrations_dir: PathBuf,
}

/// Resolves the launch plan. Release: the bundled sidecar of `channel` (`burrow-server`, or
/// `burrow-dev-server` for Burrow Dev) next to the app exe, with the UI and migrations under the
/// resource dir. Debug builds with `BURROW_DEV_NODE` and
/// `BURROW_DEV_ENTRY` run `node server.js` from the repo instead.
pub fn resolve_launch(
    resource_dir: &Path,
    source: &HashMap<String, String>,
    channel: Channel,
) -> Result<Launch, String> {
    #[cfg(debug_assertions)]
    {
        if let (Some(node), Some(entry)) = (
            source.get("BURROW_DEV_NODE").filter(|v| !v.is_empty()),
            source.get("BURROW_DEV_ENTRY").filter(|v| !v.is_empty()),
        ) {
            let entry = PathBuf::from(entry);
            let root = entry
                .parent()
                .ok_or_else(|| "BURROW_DEV_ENTRY has no parent directory".to_string())?
                .to_path_buf();
            return Ok(Launch {
                program: PathBuf::from(node),
                args: vec![entry.into_os_string()],
                cwd: Some(root.clone()),
                dist_dir: root.join("dist"),
                migrations_dir: root.join("server").join("db").join("migrations"),
            });
        }
    }
    #[cfg(not(debug_assertions))]
    let _ = source;
    let exe = std::env::current_exe().map_err(|e| format!("cannot locate the app: {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "the app executable has no parent directory".to_string())?;
    Ok(Launch {
        program: dir.join(sidecar_file_name(channel)),
        args: Vec::new(),
        cwd: None,
        dist_dir: resource_dir.join("resources").join("dist"),
        migrations_dir: resource_dir.join("resources").join("migrations"),
    })
}

/// File name of the bundled sidecar of `channel` (with `.exe` on Windows).
pub fn sidecar_file_name(channel: Channel) -> String {
    if cfg!(windows) {
        format!("{}.exe", channel.sidecar_name())
    } else {
        channel.sidecar_name().to_string()
    }
}

/// How the server process ended, as far as the shell could tell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExitInfo {
    /// Process exit code; `None` when it was killed by a signal or the status was unavailable.
    pub code: Option<i32>,
    /// The last lines the server wrote to stderr, joined with newlines.
    pub stderr_tail: String,
}

/// Messages from the stdout reader thread.
#[derive(Debug)]
pub enum ServerEvent {
    Ready(Ready),
    /// A format-checked, still unauthenticated `BURROW_UPDATE_REQUEST` line.
    UpdateRequest(UpdateRequest),
    /// A format-checked, still unauthenticated `BURROW_DIALOG_REQUEST` line.
    DialogRequest(DialogRequest),
    Exited(ExitInfo),
}

/// Shared handle to `server.log`.
pub type SharedLog = Arc<Mutex<File>>;

/// Appends one tagged line to the log (best effort).
pub fn log_line(log: &SharedLog, tag: &str, line: &str) {
    if let Ok(mut f) = log.lock() {
        let _ = writeln!(f, "[{tag}] {line}");
        let _ = f.flush();
    }
}

/// Most stderr lines kept for the exit dialog.
const MAX_TAIL_LINES: usize = 40;
/// Longest stderr line kept in the tail (characters).
const MAX_TAIL_LINE_CHARS: usize = 2000;
/// How long to wait for the exit status once the server's stdout has closed.
const EXIT_STATUS_WAIT: Duration = Duration::from_secs(3);
/// How long to wait for the stderr reader to finish after the exit status is known.
const STDERR_DRAIN_WAIT: Duration = Duration::from_secs(2);

#[derive(Default)]
struct TailInner {
    lines: VecDeque<String>,
    closed: bool,
}

/// The last lines of the server's stderr, plus a way to wait until the stream has ended.
#[derive(Default)]
pub struct StderrTail {
    inner: Mutex<TailInner>,
    closed: Condvar,
}

impl StderrTail {
    pub fn push(&self, line: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            if inner.lines.len() >= MAX_TAIL_LINES {
                inner.lines.pop_front();
            }
            inner
                .lines
                .push_back(line.chars().take(MAX_TAIL_LINE_CHARS).collect());
        }
    }

    /// Marks the stream as ended and wakes any waiter.
    pub fn close(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.closed = true;
        }
        self.closed.notify_all();
    }

    /// Waits up to `timeout` for the stream to end, then returns the kept lines joined by newlines.
    pub fn wait_text(&self, timeout: Duration) -> String {
        let Ok(guard) = self.inner.lock() else {
            return String::new();
        };
        let guard = self
            .closed
            .wait_timeout_while(guard, timeout, |inner| !inner.closed)
            .map(|(g, _)| g)
            .unwrap_or_else(|e| e.into_inner().0);
        guard.lines.iter().cloned().collect::<Vec<_>>().join("\n")
    }
}

/// Longest line the shell writes to the server's stdin (the server drops anything longer).
pub const MAX_STDIN_LINE_BYTES: usize = 16384;

/// Checks a line before it is written to the server: one line, within the size the server accepts.
fn check_outgoing_line(line: &str) -> Result<(), String> {
    if line.contains(['\r', '\n']) {
        return Err("a line to the server cannot contain a line break".to_string());
    }
    if line.len() > MAX_STDIN_LINE_BYTES {
        return Err("a line to the server is too long".to_string());
    }
    Ok(())
}

/// Owns the child's stdin on its own thread and writes each buffer it receives, in order. The thread ends when the channel
/// closes or a write fails; dropping the writer then closes the pipe, which is the server's EOF (graceful shutdown). Callers
/// only push into the channel, so no dialog thread ever blocks on the pipe while holding a lock.
fn spawn_stdin_writer<W: Write + Send + 'static>(mut writer: W) -> Sender<Vec<u8>> {
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        while let Ok(buf) = rx.recv() {
            if writer
                .write_all(&buf)
                .and_then(|()| writer.flush())
                .is_err()
            {
                break;
            }
        }
    });
    tx
}

/// A running sidecar. Closing its stdin tells the server to shut down.
pub struct Sidecar {
    child: Arc<Mutex<Child>>,
    stdin_tx: Option<Sender<Vec<u8>>>,
    _job: Option<job::JobGuard>,
}

impl Sidecar {
    /// Queues one line (plus a newline) for the server's stdin. Refuses a line with a line break or over
    /// [`MAX_STDIN_LINE_BYTES`], and fails once the server is shutting down. Never blocks on the pipe.
    pub fn send_line(&self, line: &str) -> Result<(), String> {
        check_outgoing_line(line)?;
        let tx = self
            .stdin_tx
            .as_ref()
            .ok_or_else(|| "the server is shutting down".to_string())?;
        tx.send(format!("{line}\n").into_bytes())
            .map_err(|_| "the server is not listening".to_string())
    }

    /// Graceful stop: close stdin, wait up to `grace`, then kill.
    pub fn shutdown(mut self, grace: Duration) {
        drop(self.stdin_tx.take());
        let deadline = Instant::now() + grace;
        loop {
            let status = self.child.lock().map(|mut c| c.try_wait());
            match status {
                Ok(Ok(Some(_))) => return,
                Ok(Ok(None)) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                _ => break,
            }
        }
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Polls for the child's exit status for up to `wait`. The lock is only held for each poll, so
/// [`Sidecar::shutdown`] is never blocked.
fn wait_for_exit_code(child: &Mutex<Child>, wait: Duration) -> Option<i32> {
    let deadline = Instant::now() + wait;
    loop {
        match child.lock().map(|mut c| c.try_wait()) {
            Ok(Ok(Some(status))) => return status.code(),
            Ok(Ok(None)) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            _ => return None,
        }
    }
}

/// Longest line kept from the server's output; the rest of a longer line is discarded.
const MAX_LINE_BYTES: usize = 64 * 1024;

/// Reads one line (without its line ending), lossily decoded, keeping at most [`MAX_LINE_BYTES`]
/// and discarding the remainder. `None` at EOF or on a read error.
fn read_capped_line<R: BufRead>(reader: &mut R) -> Option<String> {
    let mut kept: Vec<u8> = Vec::new();
    let mut seen_any = false;
    loop {
        let (consumed, done) = {
            let buf = match reader.fill_buf() {
                Ok(b) => b,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => return None,
            };
            if buf.is_empty() {
                return seen_any.then(|| decode_line(&kept));
            }
            seen_any = true;
            let (chunk, done) = match buf.iter().position(|b| *b == b'\n') {
                Some(i) => (&buf[..i], true),
                None => (buf, false),
            };
            let room = MAX_LINE_BYTES.saturating_sub(kept.len());
            kept.extend_from_slice(&chunk[..chunk.len().min(room)]);
            (chunk.len() + usize::from(done), done)
        };
        reader.consume(consumed);
        if done {
            return Some(decode_line(&kept));
        }
    }
}

fn decode_line(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .trim_end_matches('\r')
        .to_string()
}

/// Reads `stream` line by line on its own thread: every line goes to the log and `on_line`;
/// `on_end` runs once at EOF. When `redact` returns a replacement for a line, that is logged instead of the line.
fn pump<R, L, E>(
    stream: R,
    tag: &'static str,
    log: SharedLog,
    redact: fn(&str) -> Option<&'static str>,
    mut on_line: L,
    on_end: E,
) where
    R: std::io::Read + Send + 'static,
    L: FnMut(&str) + Send + 'static,
    E: FnOnce() + Send + 'static,
{
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        while let Some(line) = read_capped_line(&mut reader) {
            log_line(&log, tag, redact(&line).unwrap_or(&line));
            on_line(&line);
        }
        on_end();
    });
}

/// Starts the server, hands it the secret on stdin and begins draining its output to `log`.
pub fn spawn(
    launch: &Launch,
    env: &HashMap<String, String>,
    secret: &[u8; SECRET_LEN],
    log: &SharedLog,
) -> Result<(Sidecar, Receiver<ServerEvent>), String> {
    let mut cmd = Command::new(&launch.program);
    cmd.args(&launch.args)
        .env_clear()
        .envs(env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = &launch.cwd {
        cmd.current_dir(cwd);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("cannot start {}: {e}", launch.program.display()))?;
    let job = job::assign(&child);
    if job.is_none() {
        log_line(
            log,
            "shell",
            "could not attach the server to a job object; it may outlive the app if the app is killed",
        );
    }

    let mut stdin = child.stdin.take().ok_or("sidecar stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("sidecar stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("sidecar stderr unavailable")?;
    let handshake = format!("{}\n", to_hex(secret));
    if let Err(e) = stdin
        .write_all(handshake.as_bytes())
        .and_then(|()| stdin.flush())
    {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("cannot send the startup secret: {e}"));
    }

    let child = Arc::new(Mutex::new(child));
    let tail = Arc::new(StderrTail::default());
    let (tx, rx) = mpsc::channel();
    let ready_tx = tx.clone();
    let exit_child = Arc::clone(&child);
    let exit_tail = Arc::clone(&tail);
    pump(
        stdout,
        "out",
        Arc::clone(log),
        log_redaction,
        move |line| {
            if let Some(ready) = parse_ready_line(line) {
                let _ = ready_tx.send(ServerEvent::Ready(ready));
            } else if let Some(request) = parse_update_request(line) {
                let _ = ready_tx.send(ServerEvent::UpdateRequest(request));
            } else if let Some(request) = parse_dialog_request(line) {
                let _ = ready_tx.send(ServerEvent::DialogRequest(request));
            }
        },
        move || {
            let code = wait_for_exit_code(&exit_child, EXIT_STATUS_WAIT);
            let stderr_tail = exit_tail.wait_text(STDERR_DRAIN_WAIT);
            let _ = tx.send(ServerEvent::Exited(ExitInfo { code, stderr_tail }));
        },
    );
    let line_tail = Arc::clone(&tail);
    pump(
        stderr,
        "err",
        Arc::clone(log),
        |_| None,
        move |line| line_tail.push(line),
        move || tail.close(),
    );
    Ok((
        Sidecar {
            child,
            stdin_tx: Some(spawn_stdin_writer(stdin)),
            _job: job,
        },
        rx,
    ))
}

/// Windows Job Object so a crash or kill of the app never leaves the server running.
#[cfg(windows)]
mod job {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct JobGuard(HANDLE);

    // SAFETY: the handle is only used to keep the job alive and to close it on drop.
    unsafe impl Send for JobGuard {}

    impl Drop for JobGuard {
        fn drop(&mut self) {
            // SAFETY: the handle came from CreateJobObjectW and is closed exactly once.
            unsafe { CloseHandle(self.0) };
        }
    }

    pub fn assign(child: &Child) -> Option<JobGuard> {
        // SAFETY: plain Win32 calls with valid, owned handles and a correctly sized struct.
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return None;
            }
            let guard = JobGuard(handle);
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(info).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 || AssignProcessToJobObject(handle, child.as_raw_handle()) == 0 {
                return None;
            }
            Some(guard)
        }
    }
}

#[cfg(not(windows))]
mod job {
    use std::process::Child;

    pub struct JobGuard;

    pub fn assign(_child: &Child) -> Option<JobGuard> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source() -> HashMap<String, String> {
        [
            ("SystemRoot", "C:\\Windows"),
            ("TEMP", "C:\\Temp"),
            ("TMP", "C:\\Temp"),
            ("APPDATA", "C:\\Users\\user\\AppData\\Roaming"),
            ("LOCALAPPDATA", "C:\\Users\\user\\AppData\\Local"),
            ("USERPROFILE", "C:\\Users\\user"),
            ("OneDrive", "C:\\Users\\user\\OneDrive"),
            ("OneDriveConsumer", "C:\\Users\\user\\OneDrive"),
            ("OneDriveCommercial", "C:\\Users\\user\\OneDrive - Org"),
            ("PATH", "C:\\evil;C:\\Windows\\System32"),
            ("NODE_OPTIONS", "--require evil.js"),
            ("OLLAMA_HOST", "http://10.0.0.5:11434"),
            ("APP_PASSWORD", "hunter2"),
            ("BURROW_DATA_DIR", "C:\\real\\data"),
            ("BURROW_DESKTOP_DATA_DIR", "C:\\Temp\\sandbox"),
            ("SOME_RANDOM_VAR", "x"),
            ("GITHUB_TOKEN", "t"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
    }

    fn env() -> HashMap<String, String> {
        build_sidecar_env(
            &source(),
            Path::new("/r/dist"),
            Path::new("/r/migrations"),
            Channel::Stable,
            false,
        )
    }

    #[test]
    fn env_excludes_everything_not_allowlisted() {
        let env = env();
        for key in [
            "NODE_OPTIONS",
            "OLLAMA_HOST",
            "APP_PASSWORD",
            "SOME_RANDOM_VAR",
            "GITHUB_TOKEN",
            "BURROW_DESKTOP_DATA_DIR",
        ] {
            assert!(!env.contains_key(key), "{key} leaked");
        }
        assert!(!env
            .values()
            .any(|v| v.contains("hunter2") || v.contains("evil")));
    }

    #[test]
    fn env_carries_the_fixed_burrow_vars_and_passthrough() {
        let env = env();
        assert_eq!(env["BURROW_DESKTOP"], "1");
        assert_eq!(env["BURROW_HOST"], "127.0.0.1");
        assert_eq!(env["BURROW_PORT"], "0");
        assert_eq!(env["BURROW_NO_DOTENV"], "1");
        assert_eq!(env["SystemRoot"], "C:\\Windows");
        assert_eq!(env["APPDATA"], "C:\\Users\\user\\AppData\\Roaming");
        assert!(env["BURROW_DIST_DIR"].contains("dist"));
        assert!(env["BURROW_MIGRATIONS_DIR"].contains("migrations"));
        assert!(!env.contains_key("HOME"));
        // dataFolderHealth.js reads these three to detect a data folder under OneDrive.
        assert_eq!(env["OneDrive"], "C:\\Users\\user\\OneDrive");
        assert_eq!(env["OneDriveConsumer"], "C:\\Users\\user\\OneDrive");
        assert_eq!(env["OneDriveCommercial"], "C:\\Users\\user\\OneDrive - Org");
        if cfg!(windows) {
            assert_eq!(env["PATH"], "C:\\Windows\\System32");
        } else {
            assert_eq!(env["PATH"], "/usr/bin:/bin");
        }
    }

    #[test]
    fn desktop_data_dir_maps_to_burrow_data_dir() {
        assert_eq!(env()["BURROW_DATA_DIR"], "C:\\Temp\\sandbox");
    }

    #[test]
    fn real_data_dir_is_not_passed_without_the_desktop_name() {
        let mut src = source();
        src.remove("BURROW_DESKTOP_DATA_DIR");
        let env = build_sidecar_env(&src, Path::new("d"), Path::new("m"), Channel::Stable, false);
        assert!(!env.contains_key("BURROW_DATA_DIR"));
    }

    fn env_with_stable_dir(channel: Channel) -> HashMap<String, String> {
        let mut src = source();
        src.insert(
            "BURROW_DESKTOP_STABLE_DATA_DIR".into(),
            "C:\\Temp\\fake-stable".into(),
        );
        src.insert(
            "BURROW_STABLE_DATA_DIR".into(),
            "C:\\Temp\\raw-stable".into(),
        );
        build_sidecar_env(&src, Path::new("d"), Path::new("m"), channel, false)
    }

    #[test]
    fn dev_maps_the_desktop_stable_dir_and_drops_a_raw_one() {
        let env = env_with_stable_dir(Channel::Dev);
        assert_eq!(env["BURROW_STABLE_DATA_DIR"], "C:\\Temp\\fake-stable");
        assert!(!env.contains_key("BURROW_DESKTOP_STABLE_DATA_DIR"));
    }

    #[test]
    fn stable_never_passes_a_stable_dir() {
        let env = env_with_stable_dir(Channel::Stable);
        assert!(!env.contains_key("BURROW_STABLE_DATA_DIR"));
        assert!(!env.contains_key("BURROW_DESKTOP_STABLE_DATA_DIR"));
    }

    #[test]
    fn dev_drops_a_raw_stable_dir_when_no_desktop_name_is_set() {
        let mut src = source();
        src.insert(
            "BURROW_STABLE_DATA_DIR".into(),
            "C:\\Temp\\raw-stable".into(),
        );
        let env = build_sidecar_env(&src, Path::new("d"), Path::new("m"), Channel::Dev, false);
        assert!(!env.contains_key("BURROW_STABLE_DATA_DIR"));
        src.insert("BURROW_DESKTOP_STABLE_DATA_DIR".into(), "  ".into());
        let blank = build_sidecar_env(&src, Path::new("d"), Path::new("m"), Channel::Dev, false);
        assert!(!blank.contains_key("BURROW_STABLE_DATA_DIR"));
    }

    #[test]
    fn capped_lines_survive_bad_utf8_and_huge_lines() {
        let mut data: Vec<u8> = b"ok\r\n".to_vec();
        data.extend_from_slice(&[0xff, 0xfe, b'x', b'\n']);
        data.resize(data.len() + MAX_LINE_BYTES * 2 + 5, b'a');
        data.extend_from_slice(b"\nlast");
        let mut r = std::io::BufReader::with_capacity(7, &data[..]);
        assert_eq!(read_capped_line(&mut r).unwrap(), "ok");
        assert_eq!(read_capped_line(&mut r).unwrap(), "\u{fffd}\u{fffd}x");
        assert_eq!(read_capped_line(&mut r).unwrap().len(), MAX_LINE_BYTES);
        assert_eq!(read_capped_line(&mut r).unwrap(), "last");
        assert!(read_capped_line(&mut r).is_none());
    }

    #[test]
    fn ready_line_valid() {
        let r = parse_ready_line(
            "BURROW_READY {\"port\":51234,\"dataDir\":\"C:\\\\data\",\"version\":\"0.1.0\",\"channel\":\"stable\"}\r\n",
        )
        .unwrap();
        assert_eq!(r.port, 51234);
        assert_eq!(r.data_dir, "C:\\data");
        assert_eq!(r.version, "0.1.0");
        assert_eq!(r.channel, "stable");
    }

    #[test]
    fn ready_line_rejects_junk_port_zero_and_missing_fields() {
        assert!(parse_ready_line("listening on 4321").is_none());
        assert!(parse_ready_line("BURROW_READY not json").is_none());
        let zero =
            "BURROW_READY {\"port\":0,\"dataDir\":\"d\",\"version\":\"1\",\"channel\":\"dev\"}";
        assert!(parse_ready_line(zero).is_none());
        let big =
            "BURROW_READY {\"port\":70000,\"dataDir\":\"d\",\"version\":\"1\",\"channel\":\"dev\"}";
        assert!(parse_ready_line(big).is_none());
        let no_port = "BURROW_READY {\"dataDir\":\"d\",\"version\":\"1\",\"channel\":\"dev\"}";
        assert!(parse_ready_line(no_port).is_none());
        let no_dir = "BURROW_READY {\"port\":5,\"version\":\"1\",\"channel\":\"dev\"}";
        assert!(parse_ready_line(no_dir).is_none());
        let no_version = "BURROW_READY {\"port\":5,\"dataDir\":\"d\",\"channel\":\"dev\"}";
        assert!(parse_ready_line(no_version).is_none());
        assert!(parse_ready_line("").is_none());
    }

    #[test]
    fn ready_line_without_a_channel_is_refused() {
        let old = "BURROW_READY {\"port\":5,\"dataDir\":\"d\",\"version\":\"1\"}";
        assert!(parse_ready_line(old).is_none());
    }

    #[test]
    fn ready_line_distribution_defaults_to_direct_and_must_match_the_shell() {
        let old = parse_ready_line(
            "BURROW_READY {\"port\":5,\"dataDir\":\"d\",\"version\":\"1\",\"channel\":\"stable\"}",
        )
        .unwrap();
        assert!(old.matches_distribution(Distribution::Direct));
        assert!(!old.matches_distribution(Distribution::Store));
        let store = parse_ready_line(
            "BURROW_READY {\"port\":5,\"dataDir\":\"d\",\"version\":\"1\",\"channel\":\"stable\",\"distribution\":\"store\"}",
        )
        .unwrap();
        assert!(store.matches_distribution(Distribution::Store));
        assert!(!store.matches_distribution(Distribution::Direct));
    }

    #[test]
    fn ready_line_must_carry_the_shell_channel() {
        let dev = parse_ready_line(
            "BURROW_READY {\"port\":5,\"dataDir\":\"d\",\"version\":\"1\",\"channel\":\"dev\"}",
        )
        .unwrap();
        assert!(dev.matches_channel(Channel::Dev));
        assert!(!dev.matches_channel(Channel::Stable));
        let stable = parse_ready_line(
            "BURROW_READY {\"port\":5,\"dataDir\":\"d\",\"version\":\"1\",\"channel\":\"stable\"}",
        )
        .unwrap();
        assert!(stable.matches_channel(Channel::Stable));
        assert!(!stable.matches_channel(Channel::Dev));
        let other = parse_ready_line(
            "BURROW_READY {\"port\":5,\"dataDir\":\"d\",\"version\":\"1\",\"channel\":\"Dev\"}",
        )
        .unwrap();
        assert!(!other.matches_channel(Channel::Dev));
    }

    #[test]
    fn the_sidecar_always_learns_the_shell_channel() {
        assert_eq!(env()["BURROW_SHELL_CHANNEL"], "stable");
        let dev = build_sidecar_env(
            &source(),
            Path::new("d"),
            Path::new("m"),
            Channel::Dev,
            false,
        );
        assert_eq!(dev["BURROW_SHELL_CHANNEL"], "dev");
        // A value in the shell's own environment never overrides it.
        let mut src = source();
        src.insert("BURROW_SHELL_CHANNEL".into(), "dev".into());
        let stable =
            build_sidecar_env(&src, Path::new("d"), Path::new("m"), Channel::Stable, false);
        assert_eq!(stable["BURROW_SHELL_CHANNEL"], "stable");
    }

    #[test]
    fn shell_updater_flag_is_set_only_when_enabled_and_stable() {
        let mut src = source();
        src.insert("BURROW_SHELL_UPDATER".into(), "1".into());
        let build = |channel, enabled| {
            build_sidecar_env(&src, Path::new("d"), Path::new("m"), channel, enabled)
        };
        assert_eq!(build(Channel::Stable, true)["BURROW_SHELL_UPDATER"], "1");
        assert!(!build(Channel::Stable, false).contains_key("BURROW_SHELL_UPDATER"));
        assert!(!build(Channel::Dev, true).contains_key("BURROW_SHELL_UPDATER"));
        assert!(!build(Channel::Dev, false).contains_key("BURROW_SHELL_UPDATER"));
    }

    #[test]
    fn the_dialog_flag_is_always_set_and_never_a_passthrough() {
        for channel in [Channel::Stable, Channel::Dev] {
            for updater in [false, true] {
                let env =
                    build_sidecar_env(&source(), Path::new("d"), Path::new("m"), channel, updater);
                assert_eq!(env["BURROW_SHELL_DIALOGS"], "1");
            }
        }
        // A value in the shell's own environment changes nothing.
        let mut src = source();
        src.insert("BURROW_SHELL_DIALOGS".into(), "0".into());
        let env = build_sidecar_env(&src, Path::new("d"), Path::new("m"), Channel::Stable, false);
        assert_eq!(env["BURROW_SHELL_DIALOGS"], "1");
    }

    #[test]
    fn a_line_to_the_server_must_be_one_short_line() {
        assert!(check_outgoing_line("BURROW_DIALOG_REPLY {}").is_ok());
        assert!(check_outgoing_line("").is_ok());
        assert!(check_outgoing_line(&"a".repeat(MAX_STDIN_LINE_BYTES)).is_ok());
        assert!(check_outgoing_line(&"a".repeat(MAX_STDIN_LINE_BYTES + 1)).is_err());
        assert!(check_outgoing_line("one\ntwo").is_err());
        assert!(check_outgoing_line("one\r").is_err());
        assert!(check_outgoing_line("\n").is_err());
    }

    /// A writer that records everything into a shared buffer and marks when it is dropped (the pipe closing).
    struct Recorder {
        data: Arc<Mutex<Vec<u8>>>,
        closed: Arc<std::sync::atomic::AtomicBool>,
    }

    impl Write for Recorder {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.data.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Drop for Recorder {
        fn drop(&mut self) {
            self.closed.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }

    #[test]
    fn the_stdin_writer_delivers_lines_in_order_and_closes_the_pipe_when_the_channel_closes() {
        let data = Arc::new(Mutex::new(Vec::new()));
        let closed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let tx = spawn_stdin_writer(Recorder {
            data: Arc::clone(&data),
            closed: Arc::clone(&closed),
        });
        for i in 0..50 {
            tx.send(format!("line {i}\n").into_bytes()).unwrap();
        }
        drop(tx);
        let deadline = Instant::now() + Duration::from_secs(5);
        while !closed.load(std::sync::atomic::Ordering::SeqCst) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(
            closed.load(std::sync::atomic::Ordering::SeqCst),
            "the pipe was not closed"
        );
        let text = String::from_utf8(data.lock().unwrap().clone()).unwrap();
        let expected: String = (0..50).map(|i| format!("line {i}\n")).collect();
        assert_eq!(text, expected);
    }

    #[test]
    fn the_stdin_writer_stops_on_a_write_error() {
        struct Broken;
        impl Write for Broken {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("broken pipe"))
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let tx = spawn_stdin_writer(Broken);
        let _ = tx.send(b"a\n".to_vec());
        let deadline = Instant::now() + Duration::from_secs(5);
        while tx.send(b"b\n".to_vec()).is_ok() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(
            tx.send(b"c\n".to_vec()).is_err(),
            "the writer thread should have ended"
        );
    }

    #[test]
    fn server_output_with_a_dialog_request_is_not_logged_in_full() {
        let line = "BURROW_DIALOG_REQUEST {\"v\":1}";
        assert_eq!(
            log_redaction(line),
            Some("BURROW_DIALOG_REQUEST (details not logged)")
        );
        assert_eq!(log_redaction("BURROW_READY {}"), None);
    }

    #[test]
    fn each_channel_launches_its_own_sidecar_binary() {
        let stable = sidecar_file_name(Channel::Stable);
        let dev = sidecar_file_name(Channel::Dev);
        assert_ne!(stable, dev);
        assert!(stable.starts_with("burrow-server"));
        assert!(dev.starts_with("burrow-dev-server"));
        if cfg!(windows) {
            assert!(stable.ends_with(".exe") && dev.ends_with(".exe"));
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "burrow-sidecar-test-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A shell environment whose per-OS default folders live under `home`.
    fn home_env(home: &Path) -> HashMap<String, String> {
        let mut src = HashMap::new();
        let text = |p: PathBuf| p.to_string_lossy().into_owned();
        src.insert("APPDATA".into(), text(home.join("AppData").join("Roaming")));
        src.insert("USERPROFILE".into(), text(home.to_path_buf()));
        src.insert("HOME".into(), text(home.to_path_buf()));
        src.insert(
            "XDG_DATA_HOME".into(),
            text(home.join(".local").join("share")),
        );
        src
    }

    fn stable_default(src: &HashMap<String, String>) -> PathBuf {
        let get = |k: &str| src.get(k).cloned();
        platform_data_dir(get, Channel::Stable).unwrap()
    }

    #[test]
    fn a_dev_shell_refuses_the_stable_data_folder() {
        let home = scratch("isolation");
        let mut src = home_env(&home);
        let stable = stable_default(&src);
        std::fs::create_dir_all(stable.join("backups")).unwrap();
        // The Dev default is a sibling of the stable folder: fine.
        assert!(check_data_dir_isolation(Channel::Dev, &src).is_ok());
        for dir in [
            stable.clone(),
            stable.join("backups"),
            stable.join("not-yet"),
            stable.parent().unwrap().to_path_buf(),
        ] {
            src.insert(
                "BURROW_DESKTOP_DATA_DIR".into(),
                dir.to_string_lossy().into_owned(),
            );
            let res = check_data_dir_isolation(Channel::Dev, &src);
            assert_eq!(res, Err(DEV_DATA_DIR_REFUSED.to_string()), "{dir:?}");
            assert!(check_reported_data_dir(Channel::Dev, &src, &dir.to_string_lossy()).is_err());
        }
        // The stable shell is never blocked by this check.
        assert!(check_data_dir_isolation(Channel::Stable, &src).is_ok());
        assert!(check_reported_data_dir(Channel::Stable, &src, &stable.to_string_lossy()).is_ok());
        // An unrelated folder is fine.
        let other = home.join("elsewhere");
        src.insert(
            "BURROW_DESKTOP_DATA_DIR".into(),
            other.to_string_lossy().into_owned(),
        );
        assert!(check_data_dir_isolation(Channel::Dev, &src).is_ok());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_dev_shell_also_refuses_the_stable_copy_source_as_its_data_folder() {
        let home = scratch("copysource");
        let mut src = home_env(&home);
        let fake = home.join("fake-stable");
        std::fs::create_dir_all(&fake).unwrap();
        src.insert(
            "BURROW_DESKTOP_STABLE_DATA_DIR".into(),
            fake.to_string_lossy().into_owned(),
        );
        src.insert(
            "BURROW_DESKTOP_DATA_DIR".into(),
            fake.to_string_lossy().into_owned(),
        );
        assert!(check_data_dir_isolation(Channel::Dev, &src).is_err());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn stderr_tail_keeps_only_the_last_lines_and_caps_long_ones() {
        let tail = StderrTail::default();
        for i in 0..(MAX_TAIL_LINES + 5) {
            tail.push(&format!("line {i}"));
        }
        tail.push(&"x".repeat(MAX_TAIL_LINE_CHARS + 50));
        tail.close();
        let text = tail.wait_text(Duration::from_millis(10));
        let lines: Vec<&str> = text.split('\n').collect();
        assert_eq!(lines.len(), MAX_TAIL_LINES);
        assert_eq!(lines[0], "line 6");
        assert_eq!(
            lines[MAX_TAIL_LINES - 1].chars().count(),
            MAX_TAIL_LINE_CHARS
        );
    }

    #[test]
    fn stderr_tail_wait_returns_after_timeout_when_never_closed() {
        let tail = StderrTail::default();
        tail.push("partial");
        assert_eq!(tail.wait_text(Duration::from_millis(10)), "partial");
    }

    #[test]
    fn a_ready_line_without_a_data_location_is_appdata() {
        let ready = parse_ready_line(
            "BURROW_READY {\"port\":1234,\"dataDir\":\"C:/d\",\"version\":\"1.0.0\",\"channel\":\"stable\"}",
        )
        .expect("ready line");
        assert!(ready.matches_data_location(DataLocation::Appdata));
        assert!(!ready.matches_data_location(DataLocation::Userprofile));
        let profile = parse_ready_line(
            "BURROW_READY {\"port\":1234,\"dataDir\":\"C:/d\",\"version\":\"1.0.0\",\"channel\":\"stable\",\"dataLocation\":\"userprofile\"}",
        )
        .expect("ready line");
        assert!(profile.matches_data_location(DataLocation::Userprofile));
        assert!(!profile.matches_data_location(DataLocation::Appdata));
    }

    #[test]
    fn the_dev_shell_refuses_the_user_profile_folder_of_the_store_build() {
        if !cfg!(windows) {
            return;
        }
        let mut source = HashMap::new();
        source.insert(
            "APPDATA".to_string(),
            "C:\\Users\\example\\AppData\\Roaming".to_string(),
        );
        source.insert("USERPROFILE".to_string(), "C:\\Users\\example".to_string());
        assert!(
            check_reported_data_dir(Channel::Dev, &source, "C:\\Users\\example\\Burrow Data")
                .is_err()
        );
        assert!(check_reported_data_dir(
            Channel::Dev,
            &source,
            "C:\\Users\\example\\Burrow Data\\sub"
        )
        .is_err());
        assert!(check_reported_data_dir(
            Channel::Dev,
            &source,
            "C:\\Users\\example\\AppData\\Roaming\\Burrow Dev"
        )
        .is_ok());
    }
}
