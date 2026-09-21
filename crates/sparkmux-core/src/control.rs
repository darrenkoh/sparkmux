use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{broadcast, mpsc, oneshot, Mutex};

use crate::error::{Error, Result};
use crate::layout::{parse_window_layout, LayoutNode};

#[derive(Debug, Clone)]
pub enum ControlEvent {
    Output {
        pane_id: String,
        bytes: Vec<u8>,
    },
    LayoutChange {
        window_id: String,
        layout: LayoutNode,
    },
    SnapshotHint,
    Exit,
    Error(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ControlLine {
    Begin,
    End,
    Error(String),
    Output { pane_id: String, escaped: String },
    LayoutChange { window_id: String, layout: String },
    Exit,
    Other(String),
}

pub fn unescape_output(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\' && i + 3 < b.len() && b[i + 1].is_ascii_digit() {
            let d1 = b[i + 1];
            let d2 = b[i + 2];
            let d3 = b[i + 3];
            if d2.is_ascii_digit() && d3.is_ascii_digit() && d1 <= b'7' {
                out.push(((d1 - b'0') << 6) | ((d2 - b'0') << 3) | (d3 - b'0'));
                i += 4;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    out
}

pub fn parse_control_line(line: &str) -> ControlLine {
    let line = line.trim_end_matches('\r');
    if let Some(rest) = line.strip_prefix("%output ") {
        let rest = rest
            .strip_prefix('%')
            .map(|r| format!("%{r}"))
            .unwrap_or_else(|| rest.to_string());
        let mut parts = rest.splitn(2, ' ');
        let pane_id = parts.next().unwrap_or("").to_string();
        let escaped = parts.next().unwrap_or("").to_string();
        return ControlLine::Output { pane_id, escaped };
    }
    if let Some(rest) = line.strip_prefix("%extended-output ") {
        let mut parts = rest.splitn(3, ' ');
        let pane_id = parts.next().unwrap_or("").to_string();
        let _age = parts.next();
        let escaped = parts.next().unwrap_or("").to_string();
        return ControlLine::Output { pane_id, escaped };
    }
    if let Some(rest) = line.strip_prefix("%layout-change ") {
        let mut parts = rest.splitn(3, ' ');
        let window_id = parts.next().unwrap_or("").to_string();
        let layout = parts.next().unwrap_or("").to_string();
        return ControlLine::LayoutChange { window_id, layout };
    }
    if line.starts_with("%begin ") {
        return ControlLine::Begin;
    }
    if line.starts_with("%end ") {
        return ControlLine::End;
    }
    if let Some(rest) = line.strip_prefix("%error ") {
        return ControlLine::Error(rest.to_string());
    }
    if line == "%error" {
        return ControlLine::Error(String::new());
    }
    if line.starts_with("%exit") {
        return ControlLine::Exit;
    }
    ControlLine::Other(line.to_string())
}

pub struct ControlClient {
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    events: broadcast::Sender<ControlEvent>,
    cmd_tx: mpsc::Sender<(String, oneshot::Sender<Result<String>>)>,
}

impl ControlClient {
    pub async fn spawn(bin: PathBuf, args: Vec<OsString>) -> Result<Self> {
        let mut cmd = tokio::process::Command::new(&bin);
        cmd.args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        cmd.env_remove("TMUX");
        cmd.env_remove("STY");
        let mut child = cmd.spawn()?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| Error::Command("control stdin missing".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| Error::Command("control stdout missing".into()))?;
        let (events, _) = broadcast::channel(256);
        let (cmd_tx, mut cmd_rx) = mpsc::channel::<(String, oneshot::Sender<Result<String>>)>(32);
        let (ready_tx, ready_rx) = oneshot::channel();
        let mut ready_tx = Some(ready_tx);
        let stdin = Arc::new(Mutex::new(stdin));
        let stdin_task = stdin.clone();
        let child = Arc::new(Mutex::new(child));
        let events_r = events.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            let mut in_block = false;
            let mut body = String::new();
            let mut pending: Option<oneshot::Sender<Result<String>>> = None;
            let mut handshake = false;
            loop {
                tokio::select! {
                    line = reader.next_line() => {
                        match line {
                            Ok(Some(line)) => {
                                handle_line(
                                    &line,
                                    &events_r,
                                    &mut in_block,
                                    &mut body,
                                    &mut pending,
                                );
                                if !handshake
                                    && matches!(
                                        parse_control_line(&line),
                                        ControlLine::End | ControlLine::Error(_)
                                    )
                                {
                                    handshake = true;
                                    if let Some(tx) = ready_tx.take() {
                                        let _ = tx.send(());
                                    }
                                }
                            }
                            Ok(None) => {
                                let _ = events_r.send(ControlEvent::Exit);
                                break;
                            }
                            Err(e) => {
                                let _ = events_r.send(ControlEvent::Error(e.to_string()));
                                break;
                            }
                        }
                    }
                    msg = cmd_rx.recv(), if pending.is_none() && handshake => {
                        match msg {
                            Some((line, tx)) => {
                                pending = Some(tx);
                                let mut stdin = stdin_task.lock().await;
                                if let Err(e) = stdin.write_all(line.as_bytes()).await {
                                    if let Some(p) = pending.take() {
                                        let _ = p.send(Err(Error::Io(e)));
                                    }
                                } else if let Err(e) = stdin.write_all(b"\n").await {
                                    if let Some(p) = pending.take() {
                                        let _ = p.send(Err(Error::Io(e)));
                                    }
                                } else if let Err(e) = stdin.flush().await {
                                    if let Some(p) = pending.take() {
                                        let _ = p.send(Err(Error::Io(e)));
                                    }
                                }
                            }
                            None => break,
                        }
                    }
                }
            }
        });
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), ready_rx).await;
        Ok(Self {
            child,
            stdin: stdin.clone(),
            events,
            cmd_tx,
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ControlEvent> {
        self.events.subscribe()
    }

    pub async fn command(&self, line: &str) -> Result<String> {
        if line.chars().any(|c| c == '\n' || c == '\r' || c == '\0') {
            return Err(Error::InvalidTarget(
                "control command contains a newline".into(),
            ));
        }
        let (tx, rx) = oneshot::channel();
        self.cmd_tx
            .send((line.to_string(), tx))
            .await
            .map_err(|_| Error::Command("control client closed".into()))?;
        rx.await
            .map_err(|_| Error::Command("control reply dropped".into()))?
    }

    pub async fn attach_session(&self, name: &str) -> Result<()> {
        let name = crate::target::session_target(name)?;
        self.command(&format!("attach-session -t {}", quote_token(name)))
            .await?;
        Ok(())
    }

    pub async fn refresh_size(&self, cols: u16, rows: u16) -> Result<()> {
        self.command(&format!("refresh-client -C {cols}x{rows}"))
            .await?;
        Ok(())
    }

    pub async fn send_keys_raw(&self, pane_id: &str, bytes: &[u8]) -> Result<()> {
        let pane_id = crate::target::pane_id(pane_id)?;
        if bytes.is_empty() {
            return Ok(());
        }
        let mut hex = String::with_capacity(bytes.len() * 3);
        for (i, b) in bytes.iter().enumerate() {
            if i > 0 {
                hex.push(' ');
            }
            hex.push_str(&format!("{b:02x}"));
        }
        self.command(&format!("send-keys -t {pane_id} -H {hex}"))
            .await?;
        Ok(())
    }

    pub async fn shutdown(&self) -> Result<()> {
        {
            let mut stdin = self.stdin.lock().await;
            let _ = stdin.shutdown().await;
        }
        let mut child = self.child.lock().await;
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), child.wait()).await;
        let _ = child.start_kill();
        Ok(())
    }
}

fn quote_token(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        if c == '\\' || c == '"' {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('"');
    out
}

fn handle_line(
    line: &str,
    events: &broadcast::Sender<ControlEvent>,
    in_block: &mut bool,
    body: &mut String,
    pending: &mut Option<oneshot::Sender<Result<String>>>,
) {
    match parse_control_line(line) {
        ControlLine::Begin => {
            *in_block = true;
            body.clear();
        }
        ControlLine::End => {
            *in_block = false;
            if let Some(tx) = pending.take() {
                let _ = tx.send(Ok(std::mem::take(body)));
            }
        }
        ControlLine::Error(e) => {
            *in_block = false;
            body.clear();
            if let Some(tx) = pending.take() {
                let _ = tx.send(Err(Error::Command(e)));
            }
        }
        ControlLine::Output { pane_id, escaped } if !*in_block => {
            let _ = events.send(ControlEvent::Output {
                pane_id,
                bytes: unescape_output(&escaped),
            });
        }
        ControlLine::LayoutChange { window_id, layout } if !*in_block => {
            match parse_window_layout(&layout) {
                Ok(node) => {
                    let _ = events.send(ControlEvent::LayoutChange {
                        window_id,
                        layout: node,
                    });
                }
                Err(e) => {
                    let _ = events.send(ControlEvent::Error(e.to_string()));
                }
            }
        }
        ControlLine::Exit => {
            let _ = events.send(ControlEvent::Exit);
        }
        ControlLine::Other(s) if !*in_block && s.starts_with('%') => {
            let _ = events.send(ControlEvent::SnapshotHint);
        }
        ControlLine::Output { .. } | ControlLine::LayoutChange { .. } | ControlLine::Other(_) => {
            if *in_block {
                if !body.is_empty() {
                    body.push('\n');
                }
                body.push_str(line);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unescape_octal_escape() {
        let got = unescape_output(r"\033[Hhi\134");
        assert_eq!(got, b"\x1b[Hhi\\");
    }

    #[test]
    fn parse_output_line() {
        match parse_control_line("%output %3 \\033[Hhello") {
            ControlLine::Output { pane_id, escaped } => {
                assert_eq!(pane_id, "%3");
                assert_eq!(unescape_output(&escaped), b"\x1b[Hhello");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn parse_layout_change_line() {
        match parse_control_line("%layout-change @1 b260,80x24,0,0,3 vis flags") {
            ControlLine::LayoutChange { window_id, layout } => {
                assert_eq!(window_id, "@1");
                assert_eq!(layout, "b260,80x24,0,0,3");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn parse_begin_end() {
        assert_eq!(parse_control_line("%begin 1 2 0"), ControlLine::Begin);
        assert_eq!(parse_control_line("%end 1 2 0"), ControlLine::End);
        assert!(matches!(
            parse_control_line("%error bad"),
            ControlLine::Error(_)
        ));
        assert_eq!(parse_control_line("%exit"), ControlLine::Exit);
    }

    #[tokio::test]
    async fn live_control_mode_begin_end() {
        let Ok(client) =
            crate::TmuxClient::new(None, Some(format!("smux-ctl-{}", std::process::id())), None)
        else {
            return;
        };
        let spawn = crate::SessionSpawn::default();
        if client.ensure_ready(&spawn, crate::DEFAULT_SESSION).is_err() {
            return;
        }
        let (bin, args) = client.control_argv(crate::DEFAULT_SESSION).expect("argv");
        let ctl = match ControlClient::spawn(bin, args).await {
            Ok(c) => c,
            Err(_) => {
                let _ = client.kill_server();
                return;
            }
        };
        let body = ctl.command("list-sessions").await;
        let snap = client.snapshot();
        let _ = ctl.shutdown().await;
        let _ = client.kill_server();
        let body = body.expect("list-sessions over control mode");
        assert!(
            body.contains("main"),
            "expected session name in control body: {body:?}"
        );
        let snap = snap.expect("snapshot after control connect");
        let names: Vec<&str> = snap.sessions.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(
            names,
            vec![crate::DEFAULT_SESSION],
            "control spawn must not create leftover sessions: {names:?}"
        );
    }
}
