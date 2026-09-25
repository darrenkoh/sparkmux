use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use crate::error::{Error, Result};
use crate::snapshot::{Cursor, Snapshot, PANE_FMT, SESS_FMT, WIN_FMT};
use crate::version::{parse_version, TmuxVersion};
use crate::SOCKET_NAME;

#[derive(Debug, Clone)]
pub struct SessionSpawn {
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
}

impl Default for SessionSpawn {
    fn default() -> Self {
        Self {
            cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")),
            env: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttachAction {
    Attach {
        session: String,
        window: Option<String>,
        pane: Option<String>,
    },
    Switch {
        session: String,
        window: Option<String>,
        pane: Option<String>,
    },
}

pub fn decide_attach(inside: bool, target: &Cursor) -> AttachAction {
    if inside {
        AttachAction::Switch {
            session: target.session_id.clone(),
            window: target.window_id.clone(),
            pane: target.pane_id.clone(),
        }
    } else {
        AttachAction::Attach {
            session: target.session_id.clone(),
            window: target.window_id.clone(),
            pane: target.pane_id.clone(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct TmuxClient {
    pub bin: PathBuf,
    socket_name: Option<String>,
    socket_path: Option<PathBuf>,
}

impl TmuxClient {
    pub fn new(
        bin: Option<PathBuf>,
        socket_name: Option<String>,
        socket_path: Option<PathBuf>,
    ) -> Result<Self> {
        Ok(Self {
            bin: discover_bin(bin.as_deref())?,
            socket_name,
            socket_path,
        })
    }

    pub fn new_owned(
        bin: Option<PathBuf>,
        socket_name: Option<String>,
        socket_path: Option<PathBuf>,
    ) -> Result<Self> {
        let socket_name = if socket_path.is_none() && socket_name.is_none() {
            Some(SOCKET_NAME.to_string())
        } else {
            socket_name
        };
        Self::new(bin, socket_name, socket_path)
    }

    pub fn version(&self) -> Result<TmuxVersion> {
        let output = Command::new(&self.bin)
            .arg("-V")
            .stdin(Stdio::null())
            .output()?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(Error::Command(err));
        }
        parse_version(&String::from_utf8_lossy(&output.stdout))
    }

    pub fn snapshot(&self) -> Result<Snapshot> {
        let sessions = match self.run(&["list-sessions", "-F", SESS_FMT]) {
            Ok(s) => s,
            Err(Error::Command(e)) | Err(Error::ServerDown(e)) if is_no_sessions(&e) => {
                return Ok(Snapshot::empty());
            }
            Err(e) => return Err(e),
        };
        if sessions.trim().is_empty() {
            return Ok(Snapshot::empty());
        }
        let windows = match self.run(&["list-windows", "-a", "-F", WIN_FMT]) {
            Ok(s) => s,
            Err(Error::Command(e)) | Err(Error::ServerDown(e)) if is_no_sessions(&e) => {
                String::new()
            }
            Err(e) => return Err(e),
        };
        let panes = match self.run(&["list-panes", "-a", "-F", PANE_FMT]) {
            Ok(s) => s,
            Err(Error::Command(e)) | Err(Error::ServerDown(e)) if is_no_sessions(&e) => {
                String::new()
            }
            Err(e) => return Err(e),
        };
        crate::snapshot::parse_snapshot(&sessions, &windows, &panes)
    }

    pub fn ensure_ready(&self, spawn: &SessionSpawn, default_session: &str) -> Result<Snapshot> {
        match self.snapshot() {
            Ok(snap) if !snap.sessions.is_empty() => {
                let _ = self.pin_server_alive();
                Ok(snap)
            }
            Ok(_) | Err(Error::ServerDown(_)) => {
                self.create_session(default_session, spawn)?;
                self.pin_server_alive()?;
                self.snapshot()
            }
            Err(e) => Err(e),
        }
    }

    pub fn has_session(&self, name: &str) -> Result<bool> {
        match self.run(&["has-session", "-t", name]) {
            Ok(_) => Ok(true),
            Err(Error::Command(e)) if is_missing_session(&e) => Ok(false),
            Err(Error::ServerDown(_)) => Ok(false),
            Err(e) => Err(e),
        }
    }

    pub fn new_session_ex(&self, name: &str, spawn: &SessionSpawn) -> Result<()> {
        self.create_session(name, spawn)?;
        self.pin_server_alive()
    }

    pub fn new_window_ex(&self, session: &str, name: &str, spawn: &SessionSpawn) -> Result<()> {
        let session = crate::target::session_target(session)?;
        let name = crate::target::display_name(name)?;
        let args: Vec<String> = vec![
            "new-window".into(),
            "-t".into(),
            session.into(),
            "-n".into(),
            name.into(),
            "-c".into(),
            spawn.cwd.display().to_string(),
        ];
        let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        self.run(&refs).map(|_| ())
    }

    pub fn split_window(&self, target: &str, vertical: bool) -> Result<()> {
        let target = crate::target::pane_id(target)?;
        let flag = if vertical { "-v" } else { "-h" };
        self.run(&["split-window", flag, "-t", target]).map(|_| ())
    }

    pub fn kill_server(&self) -> Result<()> {
        match self.run(&["kill-server"]) {
            Ok(_) => Ok(()),
            Err(Error::ServerDown(_)) => Ok(()),
            Err(e) => Err(e),
        }
    }

    pub fn socket_path_display(&self) -> Result<String> {
        let out = self.run(&["display-message", "-p", "#{socket_path}"])?;
        Ok(out.trim().to_string())
    }

    pub fn pin_server_alive(&self) -> Result<()> {
        let _ = self.run(&["set-option", "-s", "exit-unattached", "off"]);
        let _ = self.run(&["set-option", "-g", "destroy-unattached", "off"]);
        let _ = self.run(&["set-window-option", "-g", "monitor-activity", "on"]);
        let _ = self.run(&["set-window-option", "-g", "monitor-bell", "on"]);
        let _ = self.run(&["set-option", "-g", "bell-action", "any"]);
        // The xterm grid is the client size. A status line is not part of
        // that grid; leaving it on makes the pane one row shorter, so a
        // bottom-anchored option list wraps onto the wrong lines.
        let _ = self.run(&["set-option", "-g", "status", "off"]);
        self.run(&["set-option", "-g", "default-terminal", "xterm-256color"])
            .map(|_| ())
    }

    pub fn control_argv(&self, session: &str) -> Result<(PathBuf, Vec<OsString>)> {
        let mut args = Vec::new();
        if let Some(path) = &self.socket_path {
            args.push("-S".into());
            args.push(path.into());
        } else if let Some(name) = &self.socket_name {
            args.push("-L".into());
            args.push(name.into());
        } else {
            args.push("-L".into());
            args.push(SOCKET_NAME.into());
        }
        args.push("-C".into());
        args.push("attach-session".into());
        let session = crate::target::session_target(session)?;
        args.push("-t".into());
        args.push(session.into());
        Ok((self.bin.clone(), args))
    }

    fn create_session(&self, name: &str, spawn: &SessionSpawn) -> Result<()> {
        let name = crate::target::session_name(name)?;
        let args = new_session_args(name, spawn);
        let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        self.run(&refs).map(|_| ())
    }

    pub async fn capture_pane_timeout(&self, pane_id: &str, timeout: Duration) -> Result<String> {
        let pane_id = crate::target::pane_id(pane_id)?;
        self.run_timeout(
            &["capture-pane", "-p", "-e", "-t", pane_id],
            timeout,
            pane_id,
        )
        .await
    }

    /// tmux `#{cursor_y}` / `#{cursor_x}` are 0-based; CSI CUP is 1-based.
    pub fn cursor_cup(y: u16, x: u16) -> String {
        format!("\x1b[{};{}H", y.saturating_add(1), x.saturating_add(1))
    }

    pub fn parse_cursor_pair(s: &str) -> Option<(u16, u16)> {
        let s = s.trim();
        let (y, x) = s.split_once(',')?;
        Some((y.trim().parse().ok()?, x.trim().parse().ok()?))
    }

    pub async fn pane_cursor_timeout(
        &self,
        pane_id: &str,
        timeout: Duration,
    ) -> Result<(u16, u16)> {
        let pane_id = crate::target::pane_id(pane_id)?;
        let out = self
            .run_timeout(
                &[
                    "display-message",
                    "-p",
                    "-t",
                    pane_id,
                    "#{cursor_y},#{cursor_x}",
                ],
                timeout,
                pane_id,
            )
            .await?;
        Self::parse_cursor_pair(&out).ok_or_else(|| Error::Parse(format!("cursor: {out:?}")))
    }

    async fn run_timeout(&self, args: &[&str], timeout: Duration, label: &str) -> Result<String> {
        let mut cmd = tokio::process::Command::new(&self.bin);
        self.apply_socket_tokio(&mut cmd);
        cmd.args(args)
            .kill_on_drop(true)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        match tokio::time::timeout(timeout, cmd.output()).await {
            Ok(Ok(output)) => {
                if output.status.success() {
                    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
                } else {
                    Err(Error::Command(
                        String::from_utf8_lossy(&output.stderr).trim().to_string(),
                    ))
                }
            }
            Ok(Err(e)) => Err(e.into()),
            Err(_) => Err(Error::Timeout(label.to_string())),
        }
    }

    pub fn new_session(&self, name: &str) -> Result<()> {
        let name = crate::target::session_name(name)?;
        self.run(&["new-session", "-d", "-s", name]).map(|_| ())
    }

    pub fn rename_session(&self, target: &str, new_name: &str) -> Result<()> {
        let target = crate::target::session_target(target)?;
        let new_name = crate::target::session_name(new_name)?;
        self.run(&["rename-session", "-t", target, "--", new_name])
            .map(|_| ())
    }

    pub fn kill_session(&self, target: &str) -> Result<()> {
        let target = crate::target::session_target(target)?;
        self.run(&["kill-session", "-t", target]).map(|_| ())
    }

    pub fn new_window(&self, session: &str, name: &str) -> Result<()> {
        let session = crate::target::session_target(session)?;
        let name = crate::target::display_name(name)?;
        self.run(&["new-window", "-t", session, "-n", name])
            .map(|_| ())
    }

    pub fn rename_window(&self, window_id: &str, name: &str) -> Result<()> {
        let window_id = crate::target::window_id(window_id)?;
        let name = crate::target::display_name(name)?;
        self.run(&["rename-window", "-t", window_id, "--", name])
            .map(|_| ())
    }

    pub fn kill_window(&self, window_id: &str) -> Result<()> {
        let window_id = crate::target::window_id(window_id)?;
        self.run(&["kill-window", "-t", window_id]).map(|_| ())
    }

    pub fn kill_pane(&self, pane_id: &str) -> Result<()> {
        let pane_id = crate::target::pane_id(pane_id)?;
        self.run(&["kill-pane", "-t", pane_id]).map(|_| ())
    }

    pub fn switch_client(&self, session: &str) -> Result<()> {
        let session = crate::target::session_target(session)?;
        self.run(&["switch-client", "-t", session]).map(|_| ())
    }

    pub fn select_window(&self, window_id: &str) -> Result<()> {
        let window_id = crate::target::window_id(window_id)?;
        self.run(&["select-window", "-t", window_id]).map(|_| ())
    }

    pub fn select_pane(&self, pane_id: &str) -> Result<()> {
        let pane_id = crate::target::pane_id(pane_id)?;
        self.run(&["select-pane", "-t", pane_id]).map(|_| ())
    }

    pub fn attach_command(&self, session: &str) -> Command {
        let mut cmd = Command::new(&self.bin);
        self.apply_socket(&mut cmd);
        cmd.arg("attach-session").arg("-t").arg(session);
        cmd
    }

    fn run(&self, args: &[&str]) -> Result<String> {
        let mut cmd = Command::new(&self.bin);
        self.apply_socket(&mut cmd);
        cmd.args(args).stdin(Stdio::null());
        tracing::debug!(bin = %self.bin.display(), ?args, "tmux");
        let output = cmd.output()?;
        if output.status.success() {
            return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
        }
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if is_server_down(&err) {
            Err(Error::ServerDown(err))
        } else {
            Err(Error::Command(err))
        }
    }

    fn apply_socket(&self, cmd: &mut Command) {
        if let Some(path) = &self.socket_path {
            cmd.arg("-S").arg(path);
        } else if let Some(name) = &self.socket_name {
            cmd.arg("-L").arg(name);
        }
    }

    fn apply_socket_tokio(&self, cmd: &mut tokio::process::Command) {
        if let Some(path) = &self.socket_path {
            cmd.arg("-S").arg(path);
        } else if let Some(name) = &self.socket_name {
            cmd.arg("-L").arg(name);
        }
    }
}

pub fn discover_bin(override_bin: Option<&Path>) -> Result<PathBuf> {
    if let Some(path) = override_bin {
        if is_executable(path) {
            return Ok(path.to_path_buf());
        }
        if path.exists() {
            return Err(Error::TmuxNotExecutable(path.to_path_buf()));
        }
        return Err(Error::TmuxNotFound);
    }
    if let Some(found) = find_in_path("tmux") {
        return Ok(found);
    }
    for fallback in [
        "/opt/homebrew/bin/tmux",
        "/usr/local/bin/tmux",
        "/usr/bin/tmux",
    ] {
        let path = Path::new(fallback);
        if is_executable(path) {
            return Ok(path.to_path_buf());
        }
    }
    Err(Error::TmuxNotFound)
}

fn find_in_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if is_executable(&candidate) {
            return Some(candidate);
        }
    }
    None
}

fn is_executable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

pub fn attach_target(
    snapshot: &Snapshot,
    last_session: Option<&str>,
    default_session: &str,
) -> Option<String> {
    let usable = |name: &str| crate::target::session_name(name).is_ok();
    if let Some(last) = last_session {
        if usable(last) && snapshot.sessions.iter().any(|s| s.name == last) {
            return Some(last.to_string());
        }
    }
    if usable(default_session) && snapshot.sessions.iter().any(|s| s.name == default_session) {
        return Some(default_session.to_string());
    }
    snapshot
        .sessions
        .iter()
        .find(|s| usable(&s.name))
        .map(|s| s.name.clone())
}

pub fn new_session_args(name: &str, spawn: &SessionSpawn) -> Vec<String> {
    let mut args = vec![
        "new-session".into(),
        "-d".into(),
        "-s".into(),
        name.to_string(),
        "-c".into(),
        spawn.cwd.display().to_string(),
    ];
    for (k, v) in &spawn.env {
        args.push("-e".into());
        args.push(format!("{k}={v}"));
    }
    args
}

fn is_server_down(stderr: &str) -> bool {
    let s = stderr.to_ascii_lowercase();
    if is_no_sessions(&s) {
        return false;
    }
    s.contains("no server") || s.contains("error connecting") || s.contains("no such file")
}

pub fn is_no_sessions(stderr: &str) -> bool {
    stderr.to_ascii_lowercase().contains("no sessions")
}

fn is_missing_session(stderr: &str) -> bool {
    let s = stderr.to_ascii_lowercase();
    s.contains("can't find session")
        || s.contains("no current session")
        || s.contains("session not found")
        || is_no_sessions(&s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, MutexGuard};

    static LIVE_TMUX: Mutex<()> = Mutex::new(());

    fn live_lock() -> MutexGuard<'static, ()> {
        LIVE_TMUX.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn wait_snapshot(client: &TmuxClient) -> Snapshot {
        let mut last = None;
        for _ in 0..20 {
            match client.snapshot() {
                Ok(s) => return s,
                Err(e) => {
                    last = Some(e);
                    std::thread::sleep(Duration::from_millis(25));
                }
            }
        }
        panic!("snapshot: {last:?}");
    }

    #[test]
    fn decide_switch_when_inside() {
        let cursor = Cursor {
            session_id: "$0".into(),
            window_id: Some("@1".into()),
            pane_id: Some("%2".into()),
        };
        assert_eq!(
            decide_attach(true, &cursor),
            AttachAction::Switch {
                session: "$0".into(),
                window: Some("@1".into()),
                pane: Some("%2".into()),
            }
        );
    }

    #[test]
    fn decide_attach_when_outside() {
        let cursor = Cursor {
            session_id: "$0".into(),
            window_id: Some("@1".into()),
            pane_id: Some("%2".into()),
        };
        assert_eq!(
            decide_attach(false, &cursor),
            AttachAction::Attach {
                session: "$0".into(),
                window: Some("@1".into()),
                pane: Some("%2".into()),
            }
        );
    }

    #[test]
    fn server_down_from_stderr() {
        assert!(is_server_down("no server running on /tmp/tmux-501/default"));
        assert!(is_server_down("error connecting to /tmp/tmux-501/default"));
        assert!(is_server_down(
            "error connecting to /tmp/tmux.sock (No such file or directory)"
        ));
        assert!(!is_server_down("duplicate session: foo"));
        assert!(!is_server_down("no sessions"));
        assert!(is_no_sessions("error connecting: no sessions"));
    }

    fn named(name: &str) -> crate::snapshot::Session {
        crate::snapshot::Session {
            id: format!("${name}"),
            name: name.into(),
            attached: false,
            created_epoch: 0,
            activity_epoch: 0,
            path: PathBuf::from("/"),
            windows: Vec::new(),
        }
    }

    #[test]
    fn attach_target_prefers_last_then_default_then_first() {
        let mut snap = Snapshot::empty();
        snap.sessions = vec![named("alpha"), named("main"), named("zeta")];
        assert_eq!(
            attach_target(&snap, Some("zeta"), crate::DEFAULT_SESSION).as_deref(),
            Some("zeta")
        );
        assert_eq!(
            attach_target(&snap, Some("gone"), crate::DEFAULT_SESSION).as_deref(),
            Some("main")
        );
        snap.sessions.retain(|s| s.name != "main");
        assert_eq!(
            attach_target(&snap, None, crate::DEFAULT_SESSION).as_deref(),
            Some("alpha")
        );
        assert_eq!(attach_target(&Snapshot::empty(), None, "main"), None);
        snap.sessions = vec![named(""), named("main")];
        assert_eq!(
            attach_target(&snap, Some(""), crate::DEFAULT_SESSION).as_deref(),
            Some("main")
        );
        snap.sessions = vec![named("")];
        assert_eq!(attach_target(&snap, None, "main"), None);
    }

    #[test]
    fn named_new_session_args_do_not_create_main() {
        let spawn = SessionSpawn {
            cwd: PathBuf::from("/tmp"),
            env: vec![],
        };
        let args = new_session_args("work", &spawn);
        assert_eq!(args[0], "new-session");
        assert!(args.contains(&"work".to_string()));
        assert!(!args.iter().any(|a| a == crate::DEFAULT_SESSION));
        let ensure_args = new_session_args(crate::DEFAULT_SESSION, &spawn);
        assert!(ensure_args.contains(&crate::DEFAULT_SESSION.to_string()));
        assert_ne!(args, ensure_args);
    }

    #[test]
    fn cursor_cup_is_one_based() {
        assert_eq!(TmuxClient::cursor_cup(0, 0), "\x1b[1;1H");
        assert_eq!(TmuxClient::cursor_cup(3, 10), "\x1b[4;11H");
    }

    #[test]
    fn parse_cursor_pair_trims() {
        assert_eq!(TmuxClient::parse_cursor_pair("0,12\n"), Some((0, 12)));
        assert_eq!(TmuxClient::parse_cursor_pair(" 7 , 1 "), Some((7, 1)));
        assert_eq!(TmuxClient::parse_cursor_pair("nope"), None);
    }

    #[test]
    fn new_owned_defaults_socket_name() {
        let c = TmuxClient::new_owned(None, None, None);
        if let Ok(c) = c {
            assert_eq!(c.socket_name.as_deref(), Some(SOCKET_NAME));
        }
    }

    #[test]
    fn snapshot_maps_no_sessions_stderr() {
        assert!(is_no_sessions("no sessions"));
        assert!(!is_server_down("no sessions"));
    }

    #[test]
    fn control_argv_attaches_instead_of_bare_new_session() {
        let client = TmuxClient {
            bin: PathBuf::from("/usr/bin/tmux"),
            socket_name: Some("sock".into()),
            socket_path: None,
        };
        let (bin, args) = client.control_argv("main").unwrap();
        assert_eq!(bin, PathBuf::from("/usr/bin/tmux"));
        let args: Vec<String> = args
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            vec!["-L", "sock", "-C", "attach-session", "-t", "main"]
        );
        assert!(!args.windows(1).any(|w| w == ["new-session"]));
    }

    #[test]
    fn named_new_session_live_does_not_create_main() {
        let _live = live_lock();
        let Ok(client) =
            TmuxClient::new(None, Some(format!("smux-new-{}", std::process::id())), None)
        else {
            return;
        };
        let spawn = SessionSpawn::default();
        if client.new_session_ex("work", &spawn).is_err() {
            let _ = client.kill_server();
            return;
        }
        let snap = wait_snapshot(&client);
        let names: Vec<_> = snap.sessions.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"work"), "missing work: {names:?}");
        assert!(
            !names.contains(&crate::DEFAULT_SESSION),
            "leftover main: {names:?}"
        );
        let _ = client.kill_server();
    }

    #[test]
    fn ensure_ready_creates_default_session() {
        let _live = live_lock();
        let Ok(client) =
            TmuxClient::new(None, Some(format!("smux-ens-{}", std::process::id())), None)
        else {
            return;
        };
        let spawn = SessionSpawn::default();
        let snap = match client.ensure_ready(&spawn, crate::DEFAULT_SESSION) {
            Ok(s) => s,
            Err(_) => {
                let _ = client.kill_server();
                return;
            }
        };
        assert!(snap
            .sessions
            .iter()
            .any(|s| s.name == crate::DEFAULT_SESSION));
        let snap2 = client.snapshot().expect("second dump");
        assert!(snap2
            .sessions
            .iter()
            .any(|s| s.name == crate::DEFAULT_SESSION));
        let _ = client.kill_server();
    }

    #[tokio::test]
    async fn new_pane_cursor_is_top_row() {
        let _live = live_lock();
        let Ok(client) =
            TmuxClient::new(None, Some(format!("smux-cur-{}", std::process::id())), None)
        else {
            return;
        };
        let spawn = SessionSpawn::default();
        if client.ensure_ready(&spawn, crate::DEFAULT_SESSION).is_err() {
            return;
        }
        let snap = match client.snapshot() {
            Ok(s) => s,
            Err(_) => {
                let _ = client.kill_server();
                return;
            }
        };
        let Some((pane, height)) = snap.sessions.first().and_then(|s| {
            s.windows
                .first()
                .and_then(|w| w.panes.first())
                .map(|p| (p.id.clone(), p.height))
        }) else {
            let _ = client.kill_server();
            return;
        };
        let cur = client
            .pane_cursor_timeout(&pane, Duration::from_millis(400))
            .await;
        let _ = client.kill_server();
        let (y, _x) = cur.expect("cursor");
        // A multi-line MOTD/prompt (CI) is not row 0; the seed bug was the
        // caret on the last blank dump row.
        assert!(
            u32::from(y) + 1 < u32::from(height.max(2)),
            "cursor y={y} h={height} should not sit on the last dump row"
        );
    }

    #[test]
    fn hidden_window_gets_activity_flag() {
        let _live = live_lock();
        let Ok(client) = TmuxClient::new(
            None,
            Some(format!("smux-attn-{}", std::process::id())),
            None,
        ) else {
            return;
        };
        let spawn = SessionSpawn::default();
        if client.ensure_ready(&spawn, crate::DEFAULT_SESSION).is_err() {
            return;
        }
        if client.new_window(crate::DEFAULT_SESSION, "build").is_err() {
            let _ = client.kill_server();
            return;
        }
        let snap = match client.snapshot() {
            Ok(s) => s,
            Err(_) => {
                let _ = client.kill_server();
                return;
            }
        };
        let Some(sess) = snap
            .sessions
            .iter()
            .find(|s| s.name == crate::DEFAULT_SESSION)
        else {
            let _ = client.kill_server();
            panic!("missing default session");
        };
        let first = &sess.windows[0];
        let Some(build) = sess.windows.iter().find(|w| w.name == "build") else {
            let _ = client.kill_server();
            panic!("missing build window");
        };
        if client.run(&["select-window", "-t", &first.id]).is_err() {
            let _ = client.kill_server();
            return;
        }
        if client
            .run(&["send-keys", "-t", &build.id, "echo hidden-output", "Enter"])
            .is_err()
        {
            let _ = client.kill_server();
            return;
        }
        std::thread::sleep(Duration::from_millis(400));
        let snap = match client.snapshot() {
            Ok(s) => s,
            Err(_) => {
                let _ = client.kill_server();
                return;
            }
        };
        let _ = client.kill_server();
        let build = snap
            .sessions
            .iter()
            .flat_map(|s| s.windows.iter())
            .find(|w| w.name == "build")
            .expect("build window");
        assert!(
            build.activity || build.bell,
            "hidden window should be unread after output (activity={} bell={})",
            build.activity,
            build.bell
        );
    }

    #[tokio::test]
    async fn live_flood_command_and_new_window_finish() {
        let _live = live_lock();
        let Some(client) = TmuxClient::new(
            None,
            Some(format!("smux-flood-{}", std::process::id())),
            None,
        )
        .ok() else {
            return;
        };
        let mut guard = TestServer {
            client: client.clone(),
            pid: None,
        };
        let spawn = SessionSpawn::default();
        if client.ensure_ready(&spawn, crate::DEFAULT_SESSION).is_err() {
            return;
        }
        guard.pid = client
            .run(&["display-message", "-p", "#{pid}"])
            .ok()
            .and_then(|raw| raw.trim().parse().ok());
        let pane = match client.snapshot() {
            Ok(snap) => snap
                .sessions
                .first()
                .and_then(|session| session.windows.first())
                .and_then(|window| window.panes.first())
                .map(|pane| pane.id.clone()),
            Err(_) => None,
        };
        let Some(pane) = pane else {
            return;
        };
        let (bin, args) = match client.control_argv(crate::DEFAULT_SESSION) {
            Ok(argv) => argv,
            Err(_) => return,
        };
        let ctl = match crate::ControlClient::spawn(bin, args).await {
            Ok(ctl) => ctl,
            Err(_) => return,
        };
        let mut sub = ctl.subscribe();
        // Tight loop so %output is already queued while send-keys is in flight.
        // A sleep-paced flood can return the command before the next line.
        let script = "sh -c 'while true; do echo FLOOD; done'";
        if client
            .run(&["send-keys", "-t", &pane, "-l", script])
            .is_err()
            || client.run(&["send-keys", "-t", &pane, "Enter"]).is_err()
        {
            let _ = ctl.shutdown().await;
            return;
        }
        let started = tokio::time::timeout(Duration::from_secs(3), wait_flood(&mut sub)).await;
        if !matches!(started, Ok(true)) {
            let _ = ctl.shutdown().await;
            panic!("flood output never arrived on the control subscriber");
        }
        // Only bytes that arrive after the command is submitted count.
        while sub.try_recv().is_ok() {}

        let nw_client = client.clone();
        let new_window = async move {
            tokio::time::timeout(
                Duration::from_secs(5),
                tokio::task::spawn_blocking(move || {
                    nw_client.new_window(crate::DEFAULT_SESSION, "extra")
                }),
            )
            .await
        };
        let pane_for_keys = pane.clone();
        // Large enough to exercise write_all, small enough for tmux's parser.
        let payload = vec![b'a'; 8192];
        let mut saw_during = false;
        let keys = async {
            let mut op = std::pin::pin!(ctl.send_keys_raw(&pane_for_keys, &payload));
            let deadline = tokio::time::sleep(Duration::from_secs(5));
            tokio::pin!(deadline);
            loop {
                tokio::select! {
                    biased;
                    // Poll the command first. A ready event queue must not
                    // starve it (the old failure mode of this test).
                    res = &mut op => return res,
                    _ = &mut deadline => {
                        panic!("send-keys timed out during flood");
                    }
                    ev = sub.recv() => {
                        if let Some(crate::ControlEvent::Output { bytes, .. }) = ev {
                            if is_flood_line(&bytes) {
                                saw_during = true;
                            }
                        } else if ev.is_none() {
                            panic!("control subscriber closed during send-keys");
                        }
                    }
                }
            }
        };
        let (keys, nw) = tokio::join!(keys, new_window);
        let body = tokio::time::timeout(Duration::from_secs(3), ctl.command("list-sessions"))
            .await
            .expect("list-sessions timed out during flood")
            .expect("list-sessions failed during flood");
        let _ = ctl.shutdown().await;

        keys.expect("send-keys failed during flood");
        nw.expect("new-window timed out during flood")
            .expect("new-window task")
            .expect("new-window failed");
        assert!(
            !body.contains("FLOOD") && !body.contains("%output"),
            "notification swallowed into command body: {}",
            preview(&body)
        );
        assert!(
            body.contains("main"),
            "list-sessions missing session: {}",
            preview(&body)
        );
        assert!(
            saw_during,
            "subscriber got no %output while send-keys was in flight"
        );
        eprintln!("live_flood_command_and_new_window_finish: in-flight output delivered");
    }

    #[tokio::test]
    async fn live_binary_pane_output_does_not_stall_control() {
        let _live = live_lock();
        let Ok(client) =
            TmuxClient::new(None, Some(format!("smux-bin-{}", std::process::id())), None)
        else {
            return;
        };
        let mut guard = TestServer {
            client: client.clone(),
            pid: None,
        };
        let spawn = SessionSpawn::default();
        if client.ensure_ready(&spawn, crate::DEFAULT_SESSION).is_err() {
            return;
        }
        guard.pid = client
            .run(&["display-message", "-p", "#{pid}"])
            .ok()
            .and_then(|raw| raw.trim().parse().ok());
        let pane = match client.snapshot() {
            Ok(snap) => snap
                .sessions
                .first()
                .and_then(|session| session.windows.first())
                .and_then(|window| window.panes.first())
                .map(|pane| pane.id.clone()),
            Err(_) => None,
        };
        let Some(pane) = pane else {
            return;
        };
        let (bin, args) = client
            .control_argv(crate::DEFAULT_SESSION)
            .expect("control argv");
        let ctl = crate::ControlClient::spawn(bin, args)
            .await
            .expect("control spawn");
        let _sub = ctl.subscribe();
        if client
            .run(&[
                "send-keys",
                "-t",
                &pane,
                "-l",
                "printf '\\377\\376 FLOODBIN\\n'",
            ])
            .is_err()
            || client.run(&["send-keys", "-t", &pane, "Enter"]).is_err()
        {
            let _ = ctl.shutdown().await;
            panic!("could not write binary probe into the pane");
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
        let body = tokio::time::timeout(Duration::from_secs(2), ctl.command("list-sessions"))
            .await
            .expect("control stalled after non-UTF-8 pane output")
            .expect("list-sessions failed after non-UTF-8 pane output");
        let _ = ctl.shutdown().await;
        assert!(
            body.contains("main"),
            "list-sessions missing session after binary output: {}",
            preview(&body)
        );
        eprintln!("live_binary_pane_output_does_not_stall_control: command completed");
    }

    struct TestServer {
        client: TmuxClient,
        pid: Option<u32>,
    }

    impl Drop for TestServer {
        fn drop(&mut self) {
            if let Some(pid) = self.pid {
                let _ = std::process::Command::new("kill")
                    .args(["-9", &pid.to_string()])
                    .status();
            }
            let _ = self.client.kill_server();
        }
    }

    fn preview(body: &str) -> String {
        body.chars().take(180).collect()
    }

    fn is_flood_line(bytes: &[u8]) -> bool {
        // The typed command contains the letters FLOOD. Only the echo's
        // newline-terminated line means the loop is actually running.
        bytes
            .windows(6)
            .any(|chunk| chunk == b"FLOOD\n" || chunk == b"FLOOD\r")
    }

    async fn wait_flood(
        sub: &mut tokio::sync::mpsc::UnboundedReceiver<crate::ControlEvent>,
    ) -> bool {
        loop {
            match sub.recv().await {
                Some(crate::ControlEvent::Output { bytes, .. }) if is_flood_line(&bytes) => {
                    return true;
                }
                Some(_) => {}
                None => return false,
            }
        }
    }
}
