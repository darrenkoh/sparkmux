use std::collections::HashSet;
use std::time::{Duration, Instant};

use color_eyre::eyre::Result;
use crossterm::event::{self, Event};
use ratatui::prelude::{CrosstermBackend, Terminal};
use sparkmux_core::{
    cap_lines, first_cursor, restore_cursor, Cursor, Error, Session, Snapshot, TmuxClient, Window,
};
use tokio::sync::watch;
use tokio::time::{interval_at, MissedTickBehavior};

use crate::action;
use crate::config::Config;
use crate::event as keymap;
use crate::ui;

const TOAST_TTL: Duration = Duration::from_secs(4);
const CAPTURE_TIMEOUT: Duration = Duration::from_millis(300);
// list-* is usually <50ms; 2s is a hang ceiling so a stuck tmux cannot freeze the TUI.
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum Panel {
    #[default]
    Sessions,
    Windows,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum InputKind {
    NewSession,
    NewWindow,
    RenameSession,
    RenameWindow,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum KillTarget {
    Session(String),
    Window(String),
    Pane(String),
}

#[derive(Debug, Clone, Default)]
pub(crate) enum Modal {
    #[default]
    None,
    Input {
        kind: InputKind,
        buffer: String,
    },
    ConfirmKill {
        target: KillTarget,
        name: String,
    },
    Help,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct PreviewState {
    pub pane_id: Option<String>,
    pub text: String,
    pub ok: bool,
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum MiddleItem<'a> {
    Window(&'a Window, bool),
    Pane(&'a Window, &'a sparkmux_core::Pane),
}

#[derive(Debug, Clone)]
pub enum ExitAction {
    Quit,
    Attach(String),
}

pub struct App {
    pub(crate) client: Option<TmuxClient>,
    pub(crate) snapshot: Snapshot,
    pub(crate) cursor: Option<Cursor>,
    pub(crate) panel: Panel,
    pub(crate) expanded: HashSet<String>,
    pub(crate) modal: Modal,
    pub(crate) preview: PreviewState,
    pub(crate) toast_msg: Option<String>,
    pub(crate) toast_at: Option<Instant>,
    pub(crate) server_error: Option<String>,
    pub(crate) version_banner: Option<String>,
    pub(crate) read_only: bool,
    pub(crate) inside: bool,
    pub(crate) exit: Option<ExitAction>,
    pub(crate) config: Config,
    loaded: bool,
    force_snapshot: bool,
    pending_snapshot: bool,
    last_snapshot_at: Option<Instant>,
    snapshot_job: Option<tokio::task::JoinHandle<sparkmux_core::Result<Snapshot>>>,
    snapshot_deadline: Option<tokio::time::Instant>,
    preview_target_tx: watch::Sender<Option<String>>,
    preview_rx: watch::Receiver<PreviewState>,
}

impl App {
    pub fn new(
        client: Option<TmuxClient>,
        config: Config,
        inside: bool,
        read_only: bool,
        version_banner: Option<String>,
        server_error: Option<String>,
        config_warning: Option<String>,
    ) -> Self {
        let (preview_target_tx, preview_target_rx) = watch::channel(None);
        let (preview_tx, preview_rx) = watch::channel(PreviewState::default());
        if let Some(client) = client.clone() {
            spawn_preview_worker(
                client,
                preview_target_rx,
                preview_tx,
                config.preview_ms,
                config.preview_lines,
            );
        }
        let mut app = Self {
            client,
            snapshot: Snapshot::empty(),
            cursor: None,
            panel: Panel::Sessions,
            expanded: HashSet::new(),
            modal: Modal::None,
            preview: PreviewState::default(),
            toast_msg: None,
            toast_at: None,
            server_error,
            version_banner,
            read_only,
            inside,
            exit: None,
            config,
            loaded: false,
            force_snapshot: true,
            pending_snapshot: false,
            last_snapshot_at: None,
            snapshot_job: None,
            snapshot_deadline: None,
            preview_target_tx,
            preview_rx,
        };
        if let Some(msg) = config_warning {
            app.toast(msg);
        }
        app
    }

    pub async fn run(
        mut self,
        terminal: &mut Terminal<CrosstermBackend<std::io::Stdout>>,
    ) -> Result<ExitAction> {
        let period = Duration::from_millis(self.config.refresh_ms.max(100));
        let mut refresh = interval_at(tokio::time::Instant::now() + period, period);
        refresh.set_missed_tick_behavior(MissedTickBehavior::Skip);

        loop {
            self.expire_toast();
            terminal.draw(|f| ui::draw(f, &self))?;

            if let Some(exit) = self.exit.take() {
                return Ok(exit);
            }

            self.start_snapshot_if_needed();

            tokio::select! {
                biased;
                Some(result) = await_snapshot(&mut self.snapshot_job) => {
                    self.snapshot_job = None;
                    self.snapshot_deadline = None;
                    self.loaded = true;
                    match result {
                        Ok(Ok(snap)) => self.apply_snapshot(snap),
                        Ok(Err(e)) => self.apply_snapshot_err(e),
                        Err(e) => self.toast(format!("snapshot task failed: {e}")),
                    }
                }
                () = await_deadline(self.snapshot_deadline) => {
                    self.snapshot_job = None;
                    self.snapshot_deadline = None;
                    self.toast("timed out listing tmux tree");
                }
                _ = refresh.tick() => {
                    self.force_snapshot = true;
                }
                _ = self.preview_rx.changed() => {
                    self.preview = self.preview_rx.borrow().clone();
                }
                _ = tokio::time::sleep(Duration::from_millis(20)) => {
                    self.drain_keys()?;
                }
            }
        }
    }

    fn drain_keys(&mut self) -> Result<()> {
        while event::poll(Duration::from_millis(0))? {
            if let Event::Key(key) = event::read()? {
                if let Some(action) = keymap::map_key(key, &self.modal) {
                    action::dispatch(self, action);
                }
            }
        }
        Ok(())
    }

    pub(crate) fn request_snapshot(&mut self, force: bool) {
        if force {
            self.force_snapshot = true;
        } else {
            self.pending_snapshot = true;
        }
    }

    fn start_snapshot_if_needed(&mut self) {
        if self.snapshot_job.is_some() {
            return;
        }
        let go = if self.force_snapshot {
            self.force_snapshot = false;
            self.pending_snapshot = false;
            true
        } else if self.pending_snapshot {
            let min = Duration::from_millis(self.config.refresh_ms.max(100));
            if self.last_snapshot_at.is_some_and(|at| at.elapsed() < min) {
                return;
            }
            self.pending_snapshot = false;
            true
        } else {
            false
        };
        if !go {
            return;
        }
        self.last_snapshot_at = Some(Instant::now());
        let Some(client) = self.client.clone() else {
            self.loaded = true;
            if self.server_error.is_none() {
                self.server_error = Some("tmux binary not found".into());
            }
            self.snapshot = Snapshot::empty();
            self.cursor = None;
            self.update_preview_target();
            return;
        };
        self.snapshot_deadline = Some(tokio::time::Instant::now() + SNAPSHOT_TIMEOUT);
        self.snapshot_job = Some(tokio::task::spawn_blocking(move || client.snapshot()));
    }

    pub(crate) fn is_loading(&self) -> bool {
        self.client.is_some() && !self.loaded
    }

    fn apply_snapshot(&mut self, snap: Snapshot) {
        let had_cursor = self.cursor.is_some();
        let new_cursor = match &self.cursor {
            Some(c) => restore_cursor(&self.snapshot, &snap, c),
            None => first_cursor(&snap),
        };
        self.snapshot = snap;
        self.cursor = new_cursor;
        self.server_error = None;
        self.prune_expanded();
        if !had_cursor {
            if let Some(wid) = self.cursor.as_ref().and_then(|c| c.window_id.clone()) {
                self.expanded.insert(wid);
            }
        }
        self.update_preview_target();
    }

    fn apply_snapshot_err(&mut self, e: Error) {
        let clear = matches!(
            e,
            Error::TmuxNotFound | Error::TmuxNotExecutable(_) | Error::ServerDown(_)
        );
        self.server_error = Some(e.to_string());
        if clear {
            self.snapshot = Snapshot::empty();
            self.cursor = None;
            self.update_preview_target();
        } else {
            self.toast(e.to_string());
        }
    }

    fn prune_expanded(&mut self) {
        self.expanded.retain(|id| {
            self.snapshot
                .sessions
                .iter()
                .any(|s| s.windows.iter().any(|w| w.id == *id))
        });
    }

    pub(crate) fn toast(&mut self, msg: impl Into<String>) {
        self.toast_msg = Some(msg.into());
        self.toast_at = Some(Instant::now());
    }

    fn expire_toast(&mut self) {
        if let Some(at) = self.toast_at {
            if at.elapsed() >= TOAST_TTL {
                self.toast_msg = None;
                self.toast_at = None;
            }
        }
    }

    pub(crate) fn ensure_writable(&mut self) -> bool {
        if self.client.is_none() {
            self.toast("tmux binary not found");
            return false;
        }
        if self.read_only {
            self.toast(
                self.version_banner
                    .clone()
                    .unwrap_or_else(|| "tmux < 3.2: read-only".into()),
            );
            return false;
        }
        true
    }

    pub(crate) fn current_session(&self) -> Option<&Session> {
        let id = self.cursor.as_ref()?.session_id.as_str();
        self.snapshot.sessions.iter().find(|s| s.id == id)
    }

    pub(crate) fn session_index(&self) -> Option<usize> {
        let id = self.cursor.as_ref()?.session_id.as_str();
        self.snapshot.sessions.iter().position(|s| s.id == id)
    }

    pub(crate) fn select_session(&mut self, idx: usize) {
        let Some(session) = self.snapshot.sessions.get(idx) else {
            return;
        };
        let mut cursor = Cursor {
            session_id: session.id.clone(),
            window_id: None,
            pane_id: None,
        };
        if let Some(window) = session
            .windows
            .iter()
            .find(|w| w.active)
            .or(session.windows.first())
        {
            cursor.window_id = Some(window.id.clone());
            if let Some(pane) = window
                .panes
                .iter()
                .find(|p| p.active)
                .or(window.panes.first())
            {
                cursor.pane_id = Some(pane.id.clone());
            }
        }
        self.cursor = Some(cursor);
        self.note_focus_change();
    }

    pub(crate) fn middle_items(&self) -> Vec<MiddleItem<'_>> {
        let Some(session) = self.current_session() else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for window in &session.windows {
            let expanded = self.expanded.contains(&window.id);
            out.push(MiddleItem::Window(window, expanded));
            if expanded {
                for pane in &window.panes {
                    out.push(MiddleItem::Pane(window, pane));
                }
            }
        }
        out
    }

    pub(crate) fn middle_index(&self) -> Option<usize> {
        let cursor = self.cursor.as_ref()?;
        let items = self.middle_items();
        if let Some(pid) = &cursor.pane_id {
            if let Some(idx) = items
                .iter()
                .position(|item| matches!(item, MiddleItem::Pane(_, p) if p.id == *pid))
            {
                return Some(idx);
            }
        }
        if let Some(wid) = &cursor.window_id {
            return items
                .iter()
                .position(|item| matches!(item, MiddleItem::Window(w, _) if w.id == *wid));
        }
        if items.is_empty() {
            None
        } else {
            Some(0)
        }
    }

    pub(crate) fn select_middle(&mut self, idx: usize) {
        let selected = {
            let items = self.middle_items();
            items.get(idx).copied().map(|item| match item {
                MiddleItem::Window(window, _) => (
                    window.id.clone(),
                    window
                        .panes
                        .iter()
                        .find(|p| p.active)
                        .or(window.panes.first())
                        .map(|p| p.id.clone()),
                ),
                MiddleItem::Pane(window, pane) => (window.id.clone(), Some(pane.id.clone())),
            })
        };
        let Some((window_id, pane_id)) = selected else {
            return;
        };
        if let Some(cursor) = self.cursor.as_mut() {
            cursor.window_id = Some(window_id);
            cursor.pane_id = pane_id;
        }
        self.note_focus_change();
    }

    pub(crate) fn note_focus_change(&mut self) {
        self.request_snapshot(false);
        self.update_preview_target();
    }

    pub(crate) fn update_preview_target(&mut self) {
        let id = self.resolve_preview_pane().map(str::to_string);
        let _ = self.preview_target_tx.send(id);
    }

    pub(crate) fn resolve_preview_pane(&self) -> Option<&str> {
        let cursor = self.cursor.as_ref()?;
        let session = self
            .snapshot
            .sessions
            .iter()
            .find(|s| s.id == cursor.session_id)?;
        if let Some(pid) = &cursor.pane_id {
            if session
                .windows
                .iter()
                .any(|w| w.panes.iter().any(|p| p.id == *pid))
            {
                return Some(pid);
            }
        }
        if let Some(wid) = &cursor.window_id {
            if let Some(window) = session.windows.iter().find(|w| w.id == *wid) {
                return window
                    .panes
                    .iter()
                    .find(|p| p.active)
                    .or(window.panes.first())
                    .map(|p| p.id.as_str());
            }
        }
        let window = session
            .windows
            .iter()
            .find(|w| w.active)
            .or(session.windows.first())?;
        window
            .panes
            .iter()
            .find(|p| p.active)
            .or(window.panes.first())
            .map(|p| p.id.as_str())
    }

    pub(crate) fn resolve_pane_name(&self, pane_id: &str) -> Option<String> {
        for session in &self.snapshot.sessions {
            for window in &session.windows {
                for pane in &window.panes {
                    if pane.id == pane_id {
                        if !pane.title.is_empty() {
                            return Some(pane.title.clone());
                        }
                        if !pane.command.is_empty() {
                            return Some(pane.command.clone());
                        }
                        return Some(pane.id.clone());
                    }
                }
            }
        }
        None
    }
}

async fn await_snapshot(
    job: &mut Option<tokio::task::JoinHandle<sparkmux_core::Result<Snapshot>>>,
) -> Option<std::result::Result<sparkmux_core::Result<Snapshot>, tokio::task::JoinError>> {
    match job.as_mut() {
        Some(handle) => Some(handle.await),
        None => std::future::pending().await,
    }
}

async fn await_deadline(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

fn spawn_preview_worker(
    client: TmuxClient,
    mut target_rx: watch::Receiver<Option<String>>,
    preview_tx: watch::Sender<PreviewState>,
    preview_ms: u64,
    preview_lines: usize,
) {
    let interval = Duration::from_millis(preview_ms.max(50));
    tokio::spawn(async move {
        let mut last_good: Option<(String, String)> = None;
        loop {
            tokio::select! {
                res = target_rx.changed() => {
                    if res.is_err() {
                        break;
                    }
                }
                _ = tokio::time::sleep(interval) => {}
            }
            let id = target_rx.borrow().clone();
            let Some(id) = id else {
                last_good = None;
                let _ = preview_tx.send(PreviewState::default());
                continue;
            };
            match client.capture_pane_timeout(&id, CAPTURE_TIMEOUT).await {
                Ok(text) => {
                    if target_rx.borrow().as_deref() != Some(id.as_str()) {
                        continue;
                    }
                    let text = cap_lines(&text, preview_lines);
                    last_good = Some((id.clone(), text.clone()));
                    let _ = preview_tx.send(PreviewState {
                        pane_id: Some(id),
                        text,
                        ok: true,
                    });
                }
                Err(_) => {
                    if target_rx.borrow().as_deref() != Some(id.as_str()) {
                        continue;
                    }
                    if last_good.as_ref().map(|(p, _)| p.as_str()) == Some(id.as_str()) {
                        continue;
                    }
                    let _ = preview_tx.send(PreviewState {
                        pane_id: Some(id),
                        text: String::new(),
                        ok: false,
                    });
                }
            }
        }
    });
}
