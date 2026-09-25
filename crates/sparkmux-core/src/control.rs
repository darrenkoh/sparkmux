use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::{mpsc, oneshot, watch, Mutex};

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

pub fn unescape_output(b: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\' && i + 3 < b.len() && (b'0'..=b'7').contains(&b[i + 1]) {
            let d1 = b[i + 1];
            let d2 = b[i + 2];
            let d3 = b[i + 3];
            if (b'0'..=b'7').contains(&d2) && (b'0'..=b'7').contains(&d3) {
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

/// `%output` payload is raw pane bytes, octal-escaped. A multi-byte character
/// is often split across two notifications, so this must not decode UTF-8.
fn take_pane_output(line: &[u8]) -> Option<(String, Vec<u8>)> {
    if let Some(rest) = line.strip_prefix(b"%output ") {
        let (pane_id, escaped) = split_once_space(rest);
        return Some((pane_id, unescape_output(escaped)));
    }
    let rest = line.strip_prefix(b"%extended-output ")?;
    let (pane_id, rest) = split_once_space(rest);
    let (_age, escaped) = split_once_space(rest);
    Some((pane_id, unescape_output(escaped)))
}

fn split_once_space(bytes: &[u8]) -> (String, &[u8]) {
    match bytes.iter().position(|b| *b == b' ') {
        Some(i) => (
            String::from_utf8_lossy(&bytes[..i]).into_owned(),
            &bytes[i + 1..],
        ),
        None => (String::from_utf8_lossy(bytes).into_owned(), b""),
    }
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

struct Inflight {
    reply: oneshot::Sender<Result<String>>,
    done: oneshot::Sender<()>,
}

pub struct ControlClient {
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    /// One subscriber. Terminal bytes are not broadcast and are not dropped.
    events: StdMutex<Option<mpsc::UnboundedReceiver<ControlEvent>>>,
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
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let (cmd_tx, cmd_rx) = mpsc::channel::<(String, oneshot::Sender<Result<String>>)>(32);
        let inflight = Arc::new(StdMutex::new(None));
        let (handshake_tx, handshake_rx) = watch::channel(false);
        let stdin = Arc::new(Mutex::new(stdin));
        let child = Arc::new(Mutex::new(child));
        // tmux is single-threaded. A task blocked in stdin.write_all stops
        // draining stdout, the server blocks in write(), and every client hangs.
        spawn_reader(stdout, event_tx, inflight.clone(), handshake_tx);
        spawn_writer(stdin.clone(), cmd_rx, inflight, handshake_rx.clone());
        let _ = tokio::time::timeout(Duration::from_secs(2), wait_ready(handshake_rx)).await;
        Ok(Self {
            child,
            stdin,
            events: StdMutex::new(Some(event_rx)),
            cmd_tx,
        })
    }

    pub fn subscribe(&self) -> mpsc::UnboundedReceiver<ControlEvent> {
        self.events
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .take()
            .unwrap_or_else(|| mpsc::unbounded_channel().1)
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
        // The writer may be blocked in write_all and holding stdin. Don't wait
        // forever to close it; killing the client process still only detaches.
        if let Ok(mut stdin) =
            tokio::time::timeout(Duration::from_millis(200), self.stdin.lock()).await
        {
            let _ = stdin.shutdown().await;
        }
        let mut child = self.child.lock().await;
        let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
        let _ = child.start_kill();
        Ok(())
    }
}

fn spawn_reader(
    stdout: ChildStdout,
    events: mpsc::UnboundedSender<ControlEvent>,
    inflight: Arc<StdMutex<Option<Inflight>>>,
    handshake: watch::Sender<bool>,
) {
    tokio::spawn(async move {
        // tmux writes raw pane bytes inside %output lines. `lines()` is UTF-8
        // and aborts the reader on the first invalid sequence, which stops
        // draining stdout and wedges the server.
        let mut reader = BufReader::new(stdout);
        let mut raw = Vec::new();
        let mut in_block = false;
        let mut body = String::new();
        let mut saw_handshake = false;
        loop {
            raw.clear();
            match reader.read_until(b'\n', &mut raw).await {
                Ok(0) => {
                    let _ = events.send(ControlEvent::Exit);
                    finish_reader(
                        &inflight,
                        &handshake,
                        &mut saw_handshake,
                        "control output closed",
                    );
                    break;
                }
                Ok(_) => {
                    if raw.last() == Some(&b'\n') {
                        raw.pop();
                    }
                    if raw.last() == Some(&b'\r') {
                        raw.pop();
                    }
                    if let Some(result) = handle_line(&raw, &events, &mut in_block, &mut body) {
                        complete_inflight(&inflight, result);
                        if !saw_handshake {
                            saw_handshake = true;
                            let _ = handshake.send(true);
                        }
                    }
                }
                Err(err) => {
                    let _ = events.send(ControlEvent::Error(err.to_string()));
                    finish_reader(&inflight, &handshake, &mut saw_handshake, &err.to_string());
                    break;
                }
            }
        }
    });
}

fn finish_reader(
    inflight: &StdMutex<Option<Inflight>>,
    handshake: &watch::Sender<bool>,
    saw_handshake: &mut bool,
    msg: &str,
) {
    complete_inflight(inflight, Err(Error::Command(msg.into())));
    if !*saw_handshake {
        *saw_handshake = true;
        let _ = handshake.send(true);
    }
}

fn spawn_writer(
    stdin: Arc<Mutex<ChildStdin>>,
    mut cmd_rx: mpsc::Receiver<(String, oneshot::Sender<Result<String>>)>,
    inflight: Arc<StdMutex<Option<Inflight>>>,
    mut handshake: watch::Receiver<bool>,
) {
    tokio::spawn(async move {
        loop {
            if *handshake.borrow() {
                break;
            }
            if handshake.changed().await.is_err() {
                return;
            }
        }
        while let Some((line, reply)) = cmd_rx.recv().await {
            let (done_tx, done_rx) = oneshot::channel();
            {
                let mut slot = inflight.lock().unwrap_or_else(|err| err.into_inner());
                *slot = Some(Inflight {
                    reply,
                    done: done_tx,
                });
            }
            let write_result = {
                let mut stdin = stdin.lock().await;
                write_line(&mut stdin, &line).await
            };
            if let Err(err) = write_result {
                complete_inflight(&inflight, Err(Error::Io(err)));
                continue;
            }
            // One command in flight: do not write the next line until %end/%error.
            let _ = done_rx.await;
        }
    });
}

async fn write_line(stdin: &mut ChildStdin, line: &str) -> std::io::Result<()> {
    stdin.write_all(line.as_bytes()).await?;
    stdin.write_all(b"\n").await?;
    stdin.flush().await?;
    Ok(())
}

async fn wait_ready(mut handshake: watch::Receiver<bool>) {
    loop {
        if *handshake.borrow() {
            return;
        }
        if handshake.changed().await.is_err() {
            return;
        }
    }
}

fn complete_inflight(slot: &StdMutex<Option<Inflight>>, result: Result<String>) {
    let pending = slot.lock().unwrap_or_else(|err| err.into_inner()).take();
    if let Some(pending) = pending {
        let _ = pending.reply.send(result);
        let _ = pending.done.send(());
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

/// Returns `Some` when a command block closes (`%end` / `%error`).
/// `%output`, `%extended-output`, `%layout-change`, and any other `%` line
/// that is not begin/end/error are notifications: they are dispatched even
/// inside a block and are not command output.
fn handle_line(
    line: &[u8],
    events: &mpsc::UnboundedSender<ControlEvent>,
    in_block: &mut bool,
    body: &mut String,
) -> Option<Result<String>> {
    if let Some((pane_id, bytes)) = take_pane_output(line) {
        let _ = events.send(ControlEvent::Output { pane_id, bytes });
        return None;
    }
    let line = String::from_utf8_lossy(line);
    let line = line.trim_end_matches('\r');
    match parse_control_line(line) {
        ControlLine::Begin => {
            *in_block = true;
            body.clear();
            None
        }
        ControlLine::End => {
            *in_block = false;
            Some(Ok(std::mem::take(body)))
        }
        ControlLine::Error(err) => {
            *in_block = false;
            body.clear();
            Some(Err(Error::Command(err)))
        }
        ControlLine::Output { .. } => None,
        ControlLine::LayoutChange { window_id, layout } => {
            match parse_window_layout(&layout) {
                Ok(node) => {
                    let _ = events.send(ControlEvent::LayoutChange {
                        window_id,
                        layout: node,
                    });
                }
                Err(err) => {
                    let _ = events.send(ControlEvent::Error(err.to_string()));
                }
            }
            None
        }
        ControlLine::Exit => {
            let _ = events.send(ControlEvent::Exit);
            None
        }
        ControlLine::Other(s) if s.starts_with('%') => {
            let _ = events.send(ControlEvent::SnapshotHint);
            None
        }
        ControlLine::Other(_) => {
            if *in_block {
                if !body.is_empty() {
                    body.push('\n');
                }
                body.push_str(line);
            }
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unescape_octal_escape() {
        let got = unescape_output(br"\033[Hhi\134");
        assert_eq!(got, b"\x1b[Hhi\\");
    }

    #[test]
    fn output_keeps_a_character_split_across_notifications() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut in_block = false;
        let mut body = String::new();
        // ✓ is e2 9c 93. Lossy UTF-8 on each line would replace both halves.
        assert!(handle_line(b"%output %1 \xe2\x9c", &tx, &mut in_block, &mut body).is_none());
        assert!(handle_line(b"%output %1 \x93", &tx, &mut in_block, &mut body).is_none());
        let mut all = Vec::new();
        for _ in 0..2 {
            match rx.try_recv().expect("output") {
                ControlEvent::Output { pane_id, bytes } => {
                    assert_eq!(pane_id, "%1");
                    all.extend(bytes);
                }
                other => panic!("{other:?}"),
            }
        }
        assert_eq!(all, "\u{2713}".as_bytes());
        assert!(body.is_empty());
    }

    #[test]
    fn output_keeps_bytes_that_are_not_utf8() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut in_block = false;
        let mut body = String::new();
        assert!(handle_line(b"%output %2 \xff\xfe", &tx, &mut in_block, &mut body).is_none());
        match rx.try_recv().expect("output") {
            ControlEvent::Output { bytes, .. } => assert_eq!(bytes, b"\xff\xfe"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn parse_output_line() {
        match parse_control_line("%output %3 \\033[Hhello") {
            ControlLine::Output { pane_id, escaped } => {
                assert_eq!(pane_id, "%3");
                assert_eq!(unescape_output(escaped.as_bytes()), b"\x1b[Hhello");
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
    fn notifications_inside_command_block_are_not_swallowed() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut in_block = false;
        let mut body = String::new();

        assert!(handle_line(b"%begin 1 2 3", &tx, &mut in_block, &mut body).is_none());
        assert!(in_block);

        assert!(handle_line(b"%output %7 hello", &tx, &mut in_block, &mut body).is_none());
        match rx.try_recv().expect("output event") {
            ControlEvent::Output { pane_id, bytes } => {
                assert_eq!(pane_id, "%7");
                assert_eq!(bytes, b"hello");
            }
            other => panic!("{other:?}"),
        }
        assert!(
            body.is_empty(),
            "output must not be stored in the command body: {body}"
        );

        assert!(handle_line(
            b"%extended-output %7 0 world",
            &tx,
            &mut in_block,
            &mut body
        )
        .is_none());
        match rx.try_recv().expect("extended output") {
            ControlEvent::Output { pane_id, bytes } => {
                assert_eq!(pane_id, "%7");
                assert_eq!(bytes, b"world");
            }
            other => panic!("{other:?}"),
        }

        assert!(handle_line(
            b"%layout-change @1 b260,80x24,0,0,3 vis",
            &tx,
            &mut in_block,
            &mut body
        )
        .is_none());
        assert!(matches!(
            rx.try_recv().expect("layout"),
            ControlEvent::LayoutChange { .. }
        ));

        assert!(handle_line(b"%session-changed $0 main", &tx, &mut in_block, &mut body).is_none());
        assert!(matches!(
            rx.try_recv().expect("hint"),
            ControlEvent::SnapshotHint
        ));
        assert!(body.is_empty(), "{body}");

        assert!(handle_line(b"main", &tx, &mut in_block, &mut body).is_none());
        assert!(handle_line(b"1 windows", &tx, &mut in_block, &mut body).is_none());
        assert_eq!(body, "main\n1 windows");

        let done = handle_line(b"%end 1 2 3", &tx, &mut in_block, &mut body)
            .expect("block end")
            .expect("ok body");
        assert_eq!(done, "main\n1 windows");
        assert!(!done.contains("%output"));
        assert!(!done.contains("hello"));
        assert!(!in_block);
        assert!(body.is_empty());
        assert!(rx.try_recv().is_err());
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
