use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use crate::error::{Error, Result};
use crate::snapshot::{Cursor, Snapshot, PANE_FMT, SESS_FMT, WIN_FMT};
use crate::version::{parse_version, TmuxVersion};

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

    pub fn version(&self) -> Result<TmuxVersion> {
        let output = Command::new(&self.bin).arg("-V").output()?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(Error::Command(err));
        }
        parse_version(&String::from_utf8_lossy(&output.stdout))
    }

    pub fn snapshot(&self) -> Result<Snapshot> {
        let sessions = self.run(&["list-sessions", "-F", SESS_FMT])?;
        let windows = self.run(&["list-windows", "-a", "-F", WIN_FMT])?;
        let panes = self.run(&["list-panes", "-a", "-F", PANE_FMT])?;
        crate::snapshot::parse_snapshot(&sessions, &windows, &panes)
    }

    pub fn capture_pane(&self, pane_id: &str) -> Result<String> {
        self.run(&["capture-pane", "-p", "-e", "-t", pane_id])
    }

    pub async fn capture_pane_timeout(&self, pane_id: &str, timeout: Duration) -> Result<String> {
        let mut cmd = tokio::process::Command::new(&self.bin);
        self.apply_socket_tokio(&mut cmd);
        cmd.arg("capture-pane")
            .arg("-p")
            .arg("-e")
            .arg("-t")
            .arg(pane_id)
            .kill_on_drop(true)
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
            Err(_) => Err(Error::Timeout(pane_id.to_string())),
        }
    }

    pub fn new_session(&self, name: &str) -> Result<()> {
        self.run(&["new-session", "-d", "-s", name]).map(|_| ())
    }

    pub fn rename_session(&self, target: &str, new_name: &str) -> Result<()> {
        self.run(&["rename-session", "-t", target, "--", new_name])
            .map(|_| ())
    }

    pub fn kill_session(&self, target: &str) -> Result<()> {
        self.run(&["kill-session", "-t", target]).map(|_| ())
    }

    pub fn new_window(&self, session: &str, name: &str) -> Result<()> {
        self.run(&["new-window", "-t", session, "-n", name])
            .map(|_| ())
    }

    pub fn rename_window(&self, window_id: &str, name: &str) -> Result<()> {
        self.run(&["rename-window", "-t", window_id, "--", name])
            .map(|_| ())
    }

    pub fn kill_window(&self, window_id: &str) -> Result<()> {
        self.run(&["kill-window", "-t", window_id]).map(|_| ())
    }

    pub fn kill_pane(&self, pane_id: &str) -> Result<()> {
        self.run(&["kill-pane", "-t", pane_id]).map(|_| ())
    }

    pub fn switch_client(&self, session: &str) -> Result<()> {
        self.run(&["switch-client", "-t", session]).map(|_| ())
    }

    pub fn select_window(&self, window_id: &str) -> Result<()> {
        self.run(&["select-window", "-t", window_id]).map(|_| ())
    }

    pub fn select_pane(&self, pane_id: &str) -> Result<()> {
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
        cmd.args(args);
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

fn is_server_down(stderr: &str) -> bool {
    let s = stderr.to_ascii_lowercase();
    s.contains("no server") || s.contains("error connecting") || s.contains("no such file")
}

#[cfg(test)]
mod tests {
    use super::*;

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
            session_id: "work".into(),
            window_id: None,
            pane_id: None,
        };
        assert_eq!(
            decide_attach(false, &cursor),
            AttachAction::Attach {
                session: "work".into(),
                window: None,
                pane: None,
            }
        );
    }
}
