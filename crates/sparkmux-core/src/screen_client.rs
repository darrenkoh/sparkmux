//! Read-only tmux client that keeps Grok Build on the alternate screen.
//!
//! Grok's automatic fullscreen policy runs `tmux display-message -p '#{client_flags}'`
//! from inside the pane. tmux fills that from the most recently active attached
//! client. Sparkmux's control client is that client, the flags contain
//! `control-mode`, and Grok stays inline. Inline scrolling pushes the scrollbar
//! and the composer into the pane's history.
//!
//! A second client attached with `-r` is read-only and `ignore-size` (tmux 3.2+),
//! so it does not take keys and does not change the window size set by
//! `refresh-client -C`. It is started after the control client, so its activity
//! time is newer, and its flags do not contain `control-mode`. Grok then uses
//! the alternate screen, which this app's terminal already displays.

use std::fs::File;
use std::io::Read;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::process::{Child, Stdio};
use std::thread::JoinHandle;
use std::time::Duration;

use crate::client::TmuxClient;
use crate::error::{Error, Result};

const CLIENT_SEP: &str = "@@@";

pub struct ScreenClient {
    child: Child,
    drain: Option<JoinHandle<()>>,
    /// `#{client_name}`, the target `switch-client -c` accepts.
    name: String,
    session: String,
}

impl TmuxClient {
    /// Attach a read-only, size-ignored client to `session`.
    ///
    /// Call this after the control client is attached so this client's activity
    /// time is the newer one.
    pub fn spawn_screen_client(&self, session: &str) -> Result<ScreenClient> {
        let session = crate::target::session_target(session)?.to_string();
        let (master, slave) = open_pty()?;
        set_winsize(&slave, 24, 80)?;

        let mut cmd = self.bare_command();
        cmd.arg("attach-session").arg("-r").arg("-t").arg(&session);
        cmd.env_remove("TMUX");
        cmd.env_remove("TMUX_PANE");
        cmd.env_remove("STY");
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        if std::env::var("LANG").map(|s| s.is_empty()).unwrap_or(true) {
            cmd.env("LANG", "en_US.UTF-8");
        }
        if std::env::var("LC_ALL")
            .map(|s| s.is_empty())
            .unwrap_or(true)
        {
            cmd.env("LC_ALL", "en_US.UTF-8");
        }
        // tmux identifies the client tty from stdin. Give it the slave three
        // ways so a later dup of stderr cannot outlive the child.
        let slave_in = slave.try_clone()?;
        let slave_out = slave.try_clone()?;
        let slave_err = slave.try_clone()?;
        drop(slave);
        cmd.stdin(Stdio::from(slave_in))
            .stdout(Stdio::from(slave_out))
            .stderr(Stdio::from(slave_err));
        // Own session, with the slave as the controlling tty, so tmux accepts
        // the attach. Drop still kills this pid.
        // SAFETY: `pre_exec` runs in the forked child before exec. `setsid`
        // makes that child a session leader; `TIOCSCTTY` on stdin claims the
        // pty slave std has already installed there.
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                let _ = libc::ioctl(0, libc::TIOCSCTTY as libc::c_ulong, 0);
                Ok(())
            });
        }

        let mut child = cmd.spawn()?;
        let drain = match std::thread::Builder::new()
            .name("sparkmux-screen".into())
            .spawn(move || drain_pty(master))
        {
            Ok(handle) => handle,
            Err(err) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(err.into());
            }
        };

        let pid = child.id();
        match wait_for_client(self, pid, &mut child) {
            Ok((name, flags)) => {
                if !flags_hide_control_mode(&flags) {
                    stop_child(&mut child, drain);
                    return Err(Error::Command(format!(
                        "read-only client flags were `{flags}`"
                    )));
                }
                tracing::info!(%session, %name, "screen client attached");
                Ok(ScreenClient {
                    child,
                    drain: Some(drain),
                    name,
                    session,
                })
            }
            Err(err) => {
                stop_child(&mut child, drain);
                Err(err)
            }
        }
    }
}

impl ScreenClient {
    pub fn session(&self) -> &str {
        &self.session
    }

    pub fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// Move this client onto `session` without attaching a new one.
    /// A new process would be unnecessary, and a gap with only the control
    /// client would make Grok's probe see `control-mode` again.
    pub fn retarget(&mut self, client: &TmuxClient, session: &str) -> Result<()> {
        let session = crate::target::session_target(session)?.to_string();
        client.run(&["switch-client", "-c", &self.name, "-t", &session])?;
        self.session = session;
        Ok(())
    }
}

impl Drop for ScreenClient {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(handle) = self.drain.take() {
            let _ = handle.join();
        }
    }
}

fn flags_hide_control_mode(flags: &str) -> bool {
    flags.contains("ignore-size") && flags.contains("read-only") && !flags.contains("control-mode")
}

fn stop_child(child: &mut Child, drain: JoinHandle<()>) {
    let _ = child.kill();
    let _ = child.wait();
    let _ = drain.join();
}

fn wait_for_client(client: &TmuxClient, pid: u32, child: &mut Child) -> Result<(String, String)> {
    let format =
        format!("#{{client_pid}}{CLIENT_SEP}#{{client_name}}{CLIENT_SEP}#{{client_flags}}");
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(Error::Command(format!(
                "read-only client exited ({status})"
            )));
        }
        if let Ok(out) = client.run(&["list-clients", "-F", &format]) {
            if let Some(found) = find_client(&out, pid) {
                return Ok(found);
            }
        }
        if std::time::Instant::now() >= deadline {
            return Err(Error::Command("read-only client did not attach".into()));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn find_client(output: &str, pid: u32) -> Option<(String, String)> {
    let pid = pid.to_string();
    for line in output.lines() {
        let mut parts = line.split(CLIENT_SEP);
        let got = parts.next()?.trim();
        let name = parts.next()?.trim();
        let flags = parts.next()?.trim();
        if got == pid && !name.is_empty() {
            return Some((name.to_string(), flags.to_string()));
        }
    }
    None
}

fn drain_pty(master: OwnedFd) {
    let mut file = File::from(master);
    let mut buf = [0u8; 8192];
    loop {
        match file.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
    }
}

fn open_pty() -> Result<(OwnedFd, OwnedFd)> {
    let mut master: libc::c_int = -1;
    let mut slave: libc::c_int = -1;
    // SAFETY: openpty writes two new file descriptors on success. We take
    // ownership of both. On failure neither fd is consumed.
    let rc = unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if rc != 0 {
        return Err(Error::Io(std::io::Error::last_os_error()));
    }
    // SAFETY: openpty succeeded, so both descriptors are open and owned here.
    let master = unsafe { OwnedFd::from_raw_fd(master) };
    let slave = unsafe { OwnedFd::from_raw_fd(slave) };
    Ok((master, slave))
}

fn set_winsize(slave: &OwnedFd, rows: u16, cols: u16) -> Result<()> {
    let size = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    // SAFETY: `slave` is the pty slave from openpty, and `size` is a valid
    // winsize for TIOCSWINSZ.
    let rc = unsafe { libc::ioctl(slave.as_raw_fd(), libc::TIOCSWINSZ as libc::c_ulong, &size) };
    if rc != 0 {
        return Err(Error::Io(std::io::Error::last_os_error()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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

    fn window_size(client: &TmuxClient, session: &str) -> (u32, u32) {
        let out = client
            .run(&[
                "display-message",
                "-t",
                session,
                "-p",
                "#{window_width} #{window_height}",
            ])
            .expect("window size");
        let mut parts = out.split_whitespace();
        let width = parts.next().unwrap().parse().unwrap();
        let height = parts.next().unwrap().parse().unwrap();
        (width, height)
    }

    fn pane_of(client: &TmuxClient, session: &str) -> String {
        let snap = client.snapshot().expect("snapshot");
        snap.sessions
            .iter()
            .find(|s| s.name == session)
            .and_then(|s| s.windows.first())
            .and_then(|w| w.panes.first())
            .map(|p| p.id.clone())
            .unwrap_or_else(|| panic!("no pane in {session}"))
    }

    fn flags_from_pane(client: &TmuxClient, pane: &str, script: &std::path::Path) -> String {
        let out = std::env::temp_dir().join(format!(
            "smux-flags-{}-{}-{}.txt",
            std::process::id(),
            pane.trim_start_matches('%'),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        ));
        let _ = std::fs::remove_file(&out);
        let cmdline = format!("sh {} {}", script.display(), out.display());
        client
            .run(&["send-keys", "-t", pane, "-l", &cmdline])
            .expect("send probe");
        client
            .run(&["send-keys", "-t", pane, "Enter"])
            .expect("enter probe");
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if let Ok(text) = std::fs::read_to_string(&out) {
                let text = text.trim().to_string();
                if !text.is_empty() {
                    let _ = std::fs::remove_file(&out);
                    return text;
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let visible = client
            .run(&["capture-pane", "-t", pane, "-p"])
            .unwrap_or_default();
        panic!("pane {pane} did not report client flags.\n{visible}");
    }

    #[tokio::test]
    async fn read_only_client_hides_control_mode_and_keeps_size() {
        let Ok(client) = TmuxClient::new(
            None,
            Some(format!("smux-screen-{}", std::process::id())),
            None,
        ) else {
            return;
        };
        let mut guard = TestServer {
            client: client.clone(),
            pid: None,
        };
        let spawn = crate::client::SessionSpawn::default();
        if client.ensure_ready(&spawn, crate::DEFAULT_SESSION).is_err() {
            return;
        }
        guard.pid = client
            .run(&["display-message", "-p", "#{pid}"])
            .ok()
            .and_then(|raw| raw.trim().parse().ok());

        let (bin, args) = client
            .control_argv(crate::DEFAULT_SESSION)
            .expect("control argv");
        let ctl = crate::ControlClient::spawn(bin, args)
            .await
            .expect("control client");
        ctl.refresh_size(100, 32).await.expect("resize");
        let pane = pane_of(&client, crate::DEFAULT_SESSION);
        assert_eq!(window_size(&client, crate::DEFAULT_SESSION), (100, 32));

        let script = std::env::temp_dir().join(format!("smux-flags-{}.sh", std::process::id()));
        std::fs::write(
            &script,
            "#!/bin/sh\ntmux display-message -p '#{client_flags}' > \"$1\"\n",
        )
        .expect("script");

        let before = flags_from_pane(&client, &pane, &script);
        assert!(
            before.contains("control-mode"),
            "control client should be the probed client, flags were {before}"
        );

        let mut screen = client
            .spawn_screen_client(crate::DEFAULT_SESSION)
            .expect("screen client");
        assert_eq!(
            window_size(&client, crate::DEFAULT_SESSION),
            (100, 32),
            "read-only client changed the window size"
        );
        let after = flags_from_pane(&client, &pane, &script);
        assert!(
            flags_hide_control_mode(&after),
            "probe should see the read-only client, flags were {after}"
        );

        ctl.refresh_size(90, 20).await.expect("resize again");
        assert_eq!(window_size(&client, crate::DEFAULT_SESSION), (90, 20));
        let still = flags_from_pane(&client, &pane, &script);
        assert!(
            flags_hide_control_mode(&still),
            "resize should keep the read-only client current, flags were {still}"
        );

        client
            .new_session_ex("other", &spawn)
            .expect("second session");
        ctl.command("switch-client -t other")
            .await
            .expect("switch control client");
        screen.retarget(&client, "other").expect("retarget");
        assert_eq!(screen.session(), "other");
        let other_pane = pane_of(&client, "other");
        let other_flags = flags_from_pane(&client, &other_pane, &script);
        assert!(
            flags_hide_control_mode(&other_flags),
            "switched session should still hide control mode, flags were {other_flags}"
        );

        drop(screen);
        let restored = flags_from_pane(&client, &other_pane, &script);
        assert!(
            restored.contains("control-mode"),
            "dropping the read-only client should restore the control client, flags were {restored}"
        );
        client.snapshot().expect("server still up");

        ctl.shutdown().await.expect("shutdown control");
        let _ = std::fs::remove_file(&script);
    }
}
