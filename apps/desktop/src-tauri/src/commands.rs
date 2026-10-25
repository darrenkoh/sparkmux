use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde::Serialize;
use sparkmux_core::{
    attach_target, parse_window_layout, LayoutNode, Pane, Snapshot, TmuxClient, Window, SOCKET_NAME,
};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::attention::{self, AttentionLabel, LabelToken};
use crate::control;
use crate::error::{map_error, too_old};
use crate::state::{persist_last_session, ActiveTarget, AppState, ServerPushEvent};
use crate::window_label;

/// A stuck tmux server must not pin the UI. Blocking `TmuxClient::run` calls
/// happen off the `AppState` lock and fail closed after this bound.
const TMUX_BLOCKING_TIMEOUT: Duration = Duration::from_secs(5);
/// Hidden agent windows that need a fresh transcript on this poll.
const MAX_ATTENTION_READS: usize = 8;

async fn off_lock<T, F>(op: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    match tokio::time::timeout(TMUX_BLOCKING_TIMEOUT, tokio::task::spawn_blocking(op)).await {
        Ok(Ok(result)) => result,
        Ok(Err(err)) => Err(err.to_string()),
        Err(_) => Err("tmux command timed out".into()),
    }
}

#[derive(Debug, Serialize)]
pub struct TmuxStatus {
    pub bin: Option<String>,
    pub version: Option<String>,
    pub supported: bool,
    pub socket_name: String,
    pub socket_path: Option<String>,
    pub default_session: String,
    pub last_session: Option<String>,
    pub app_version: String,
    pub is_headless: bool,
    pub error: Option<String>,
    pub hint: Option<String>,
}

pub async fn tmux_status_core(state: &AppState) -> Result<TmuxStatus, String> {
    let (mut status, client) = {
        let mut inner = state.inner.lock().await;
        let socket_name = inner
            .config
            .socket_name
            .clone()
            .unwrap_or_else(|| SOCKET_NAME.to_string());
        let mut status = TmuxStatus {
            bin: None,
            version: None,
            supported: false,
            socket_name,
            socket_path: None,
            default_session: inner.config.default_session.clone(),
            last_session: inner.config.last_session.clone(),
            app_version: env!("CARGO_PKG_VERSION").into(),
            is_headless: state.is_headless,
            error: None,
            hint: None,
        };
        let client = match inner.ensure_client() {
            Ok(client) => {
                status.bin = Some(client.bin.display().to_string());
                Some(client.clone())
            }
            Err(e) => {
                if e.starts_with("missing-tmux") || e.starts_with("too-old") {
                    status.error = Some(e.split(':').next().unwrap_or("missing-tmux").to_string());
                } else {
                    status.error = Some("missing-tmux".into());
                }
                status.hint = Some(e);
                None
            }
        };
        (status, client)
    };
    let Some(client) = client else {
        return Ok(status);
    };
    let (version, socket_path) =
        off_lock(move || Ok((client.version(), client.socket_path_display().ok()))).await?;
    match version {
        Ok(v) => {
            status.supported = v.is_supported();
            status.version = Some(v.raw.clone());
            if !v.is_supported() {
                status.error = Some("too-old".into());
                status.hint = Some(too_old(&v.raw));
            }
        }
        Err(e) => {
            status.error = Some("missing-tmux".into());
            status.hint = Some(map_error(&e));
        }
    }
    status.socket_path = socket_path;
    Ok(status)
}

pub async fn snapshot_core(state: &AppState) -> Result<Snapshot, String> {
    let client = {
        let mut inner = state.inner.lock().await;
        inner.ensure_client()?.clone()
    };
    let listed = client.clone();
    match off_lock(move || listed.snapshot().map_err(|e| map_error(&e))).await {
        Ok(mut snap) => {
            apply_auto_labels(client, &mut snap).await;
            annotate_attention(state, snap).await
        }
        Err(msg) if msg.starts_with("server-down") => Ok(sparkmux_core::Snapshot::empty()),
        Err(msg) => Err(msg),
    }
}

/// Rename default `shell` tabs to the running CLI, off the app-state lock.
async fn apply_auto_labels(client: TmuxClient, snap: &mut Snapshot) {
    let versions = window_label::cached_versions();
    let (changes, need_probe) = window_label::plan(snap, &versions);
    if need_probe {
        window_label::start_agy_probe();
    }
    if changes.is_empty() {
        return;
    }
    let renamed = match off_lock(move || {
        let mut done = Vec::new();
        for change in changes {
            match client.rename_window(&change.window_id, &change.name) {
                Ok(()) => done.push(change),
                Err(err) => tracing::warn!("auto label {} failed: {err}", change.window_id),
            }
        }
        Ok(done)
    })
    .await
    {
        Ok(done) => done,
        Err(err) => {
            tracing::warn!("auto label rename did not finish: {err}");
            Vec::new()
        }
    };
    for change in renamed {
        for session in &mut snap.sessions {
            if let Some(window) = session
                .windows
                .iter_mut()
                .find(|window| window.id == change.window_id)
            {
                window.name = change.name;
                break;
            }
        }
    }
}

pub async fn ensure_ready_core(state: &AppState) -> Result<Snapshot, String> {
    let (client, spawn, default_session) = {
        let mut inner = state.inner.lock().await;
        let spawn = inner.spawn.clone();
        let default_session = inner.config.default_session.clone();
        let client = inner.ensure_client()?.clone();
        (client, spawn, default_session)
    };
    let ready = client.clone();
    let mut snap = off_lock(move || {
        check_version(&ready)?;
        ready
            .ensure_ready(&spawn, &default_session)
            .map_err(|e| map_error(&e))
    })
    .await?;
    {
        let mut inner = state.inner.lock().await;
        inner.stopped = false;
    }
    apply_auto_labels(client, &mut snap).await;
    annotate_attention(state, snap).await
}

struct AttentionRead {
    id: String,
    command: String,
    cwd: String,
    title: String,
}

struct AttentionHit {
    token: Option<LabelToken>,
    label: Option<AttentionLabel>,
    question: Option<String>,
}

fn attention_pane(window: &Window) -> Option<&Pane> {
    if let Some(pane) = window.panes.iter().find(|pane| pane.active) {
        return Some(pane);
    }
    window.panes.first()
}

fn pane_is_agent(pane: &Pane) -> bool {
    crate::artifacts::detect_cli(&pane.command, &pane.title, &[]).is_some()
}

/// Mark hidden windows unread. Transcript reads happen off the state lock.
async fn annotate_attention(state: &AppState, mut snap: Snapshot) -> Result<Snapshot, String> {
    let now = Instant::now();
    let (attached, mut reads) = {
        let inner = state.inner.lock().await;
        let attached = inner.attached_session.clone();
        let mut reads = Vec::new();
        for session in &snap.sessions {
            let on_screen = attached.as_deref() == Some(session.name.as_str());
            for window in &session.windows {
                if on_screen && window.active {
                    continue;
                }
                let Some(pane) = attention_pane(window) else {
                    continue;
                };
                if !pane_is_agent(pane) {
                    continue;
                }
                if !inner
                    .attention
                    .wants_transcript(&window.id, window.activity_epoch, now)
                {
                    continue;
                }
                reads.push(AttentionRead {
                    id: window.id.clone(),
                    command: pane.command.clone(),
                    cwd: pane.path.to_string_lossy().into_owned(),
                    title: pane.title.clone(),
                });
            }
        }
        (attached, reads)
    };

    if reads.len() > MAX_ATTENTION_READS {
        reads.truncate(MAX_ATTENTION_READS);
    }

    let roots = crate::artifacts::default_roots();
    let loaded = tokio::task::spawn_blocking(move || {
        let mut out = Vec::with_capacity(reads.len());
        for read in reads {
            // pid 0 skips the process-family walk. Snapshot polling must not touch /proc.
            let feed =
                crate::artifacts::load_artifacts(&read.command, &read.cwd, &read.title, 0, &roots);
            let (token, label) = attention::label_from_feed(&feed);
            let question = attention::pending_question(&feed.entries);
            out.push((
                read.id,
                AttentionHit {
                    token,
                    label,
                    question,
                },
            ));
        }
        out
    })
    .await
    .unwrap_or_else(|err| {
        tracing::warn!("attention transcripts were not read: {err}");
        Vec::new()
    });
    let mut fresh: HashMap<String, AttentionHit> = loaded.into_iter().collect();

    let mut inner = state.inner.lock().await;
    for session in &mut snap.sessions {
        let on_screen = attached.as_deref() == Some(session.name.as_str());
        for window in &mut session.windows {
            let visible = on_screen && window.active;
            let (agent, ssh) = match attention_pane(window) {
                Some(pane) => (
                    pane_is_agent(pane),
                    attention::command_is_ssh(&pane.command),
                ),
                None => (false, false),
            };
            let mut same_token = false;
            let mut question = None;
            let mut read_now = false;
            let classified = if let Some(hit) = fresh.remove(&window.id) {
                read_now = true;
                same_token = inner
                    .attention
                    .has_same_token(&window.id, hit.token.as_ref());
                question = hit.question;
                inner
                    .attention
                    .store_label(&window.id, hit.token, hit.label, now)
            } else {
                // A skipped read is not "no classifier result". Keep the last label,
                // including while this window is the active one.
                inner.attention.cached_label(&window.id)
            };
            // Unread, the pending question, and the finished mark stay blank on
            // the visible window. The durable classifier label does not.
            let label = if visible { None } else { classified };
            window.attention_label = attention::attention_label_wire(classified);
            let ask = if visible {
                inner.attention.clear_ask(&window.id);
                String::new()
            } else if read_now {
                inner
                    .attention
                    .note_question(&window.id, label, question, same_token)
            } else if label == Some(AttentionLabel::NeedsUser) {
                inner.attention.cached_ask(&window.id)
            } else {
                String::new()
            };
            window.unread = inner.attention.unread(
                &attention::WindowAttention {
                    id: window.id.clone(),
                    bell: window.bell,
                    activity_epoch: window.activity_epoch,
                    visible,
                    agent,
                    label,
                },
                now,
            );
            // Failed and bell-only rows stay blank. The question is only for needs-user.
            window.pending_ask = if window.unread && label == Some(AttentionLabel::NeedsUser) {
                ask
            } else {
                String::new()
            };
            window.finished = inner.attention.finished(
                &attention::WindowAttention {
                    id: window.id.clone(),
                    bell: window.bell,
                    activity_epoch: window.activity_epoch,
                    visible,
                    agent: agent && !ssh,
                    label,
                },
                same_token,
            );
        }
    }
    Ok(snap)
}

pub async fn new_session_core(state: &AppState, name: String) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("session name is required".into());
    }
    let (client, spawn) = {
        let mut inner = state.inner.lock().await;
        let spawn = inner.spawn.clone();
        let client = inner.ensure_client()?.clone();
        (client, spawn)
    };
    off_lock(move || {
        check_version(&client)?;
        client
            .new_session_ex(&name, &spawn)
            .map_err(|e| map_error(&e))
    })
    .await?;
    let mut inner = state.inner.lock().await;
    inner.stopped = false;
    Ok(())
}

pub async fn rename_session_core(
    state: &AppState,
    target: String,
    new_name: String,
) -> Result<(), String> {
    let new_name = new_name.trim().to_string();
    let client = {
        let inner = state.inner.lock().await;
        inner.client()?.clone()
    };
    off_lock(move || {
        client
            .rename_session(&target, &new_name)
            .map_err(|e| map_error(&e))
    })
    .await
}

pub async fn kill_session_core(state: &AppState, target: String) -> Result<(), String> {
    let client = {
        let inner = state.inner.lock().await;
        inner.client()?.clone()
    };
    off_lock(move || client.kill_session(&target).map_err(|e| map_error(&e))).await
}

pub async fn new_window_core(
    state: &AppState,
    session: String,
    name: String,
) -> Result<(), String> {
    let (client, spawn, session, name) = {
        let mut inner = state.inner.lock().await;
        let spawn = inner.spawn.clone();
        let attached = inner.attached_session.clone();
        let client = inner.ensure_client()?.clone();
        let session = if session.trim().is_empty() {
            attached.ok_or_else(|| "no attached session".to_string())?
        } else {
            session
        };
        let name = if name.trim().is_empty() {
            "shell".to_string()
        } else {
            name.trim().to_string()
        };
        (client, spawn, session, name)
    };
    off_lock(move || {
        client
            .new_window_ex(&session, &name, &spawn)
            .map_err(|e| map_error(&e))
    })
    .await
}

pub async fn select_window_core(state: &AppState, window_id: String) -> Result<(), String> {
    let client = {
        let inner = state.inner.lock().await;
        inner.client()?.clone()
    };
    off_lock(move || client.select_window(&window_id).map_err(|e| map_error(&e))).await
}

pub async fn rename_window_core(
    state: &AppState,
    window_id: String,
    name: String,
) -> Result<(), String> {
    let name = name.trim().to_string();
    let client = {
        let inner = state.inner.lock().await;
        inner.client()?.clone()
    };
    off_lock(move || {
        client
            .rename_window(&window_id, &name)
            .map_err(|e| map_error(&e))
    })
    .await
}

pub async fn kill_window_core(state: &AppState, window_id: String) -> Result<(), String> {
    let client = {
        let inner = state.inner.lock().await;
        inner.client()?.clone()
    };
    off_lock(move || client.kill_window(&window_id).map_err(|e| map_error(&e))).await
}

pub async fn kill_pane_core(state: &AppState, pane_id: String) -> Result<(), String> {
    let client = {
        let inner = state.inner.lock().await;
        inner.client()?.clone()
    };
    off_lock(move || client.kill_pane(&pane_id).map_err(|e| map_error(&e))).await
}

pub async fn split_pane_core(
    state: &AppState,
    pane_id: String,
    vertical: bool,
) -> Result<(), String> {
    let client = {
        let inner = state.inner.lock().await;
        inner.client()?.clone()
    };
    off_lock(move || {
        client
            .split_window(&pane_id, vertical)
            .map_err(|e| map_error(&e))
    })
    .await
}

#[tauri::command]
pub async fn control_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    session: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    control::connect_core(Some(&app), &state, session, cols, rows).await
}

#[tauri::command]
pub async fn control_disconnect(state: State<'_, AppState>) -> Result<(), String> {
    control::disconnect_core(&state).await
}

#[tauri::command]
pub async fn pane_subscribe(
    state: State<'_, AppState>,
    pane_id: String,
    on_data: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    control::subscribe_pane(&state, pane_id, on_data).await
}

#[tauri::command]
pub async fn pane_unsubscribe(state: State<'_, AppState>, pane_id: String) -> Result<(), String> {
    control::unsubscribe_pane(&state, &pane_id).await;
    Ok(())
}

pub async fn pane_write_core(state: &AppState, pane_id: &str, data: &[u8]) -> Result<(), String> {
    let ctl = {
        let inner = state.inner.lock().await;
        inner
            .control
            .clone()
            .ok_or_else(|| "control client is not connected".to_string())?
    };
    ctl.send_keys_raw(pane_id, data)
        .await
        .map_err(|e| map_error(&e))
}

#[tauri::command]
pub async fn pane_write(
    state: State<'_, AppState>,
    pane_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    pane_write_core(&state, &pane_id, &data).await
}

pub async fn window_resize_core(state: &AppState, cols: u16, rows: u16) -> Result<(), String> {
    let ctl = {
        let inner = state.inner.lock().await;
        inner.control.clone()
    };
    let Some(ctl) = ctl else {
        return Ok(());
    };
    ctl.refresh_size(cols.max(2), rows.max(1))
        .await
        .map_err(|e| map_error(&e))
}

#[derive(Debug, Serialize)]
pub struct PaneCursor {
    pub y: u16,
    pub x: u16,
}

pub async fn pane_cursor_core(state: &AppState, pane_id: String) -> Result<PaneCursor, String> {
    let (ctl, client) = {
        let inner = state.inner.lock().await;
        (inner.control.clone(), inner.client()?.clone())
    };
    let (y, x) = if let Some(ctl) = ctl {
        match ctl.pane_cursor(&pane_id).await {
            Ok(pos) => pos,
            Err(_) => client
                .pane_cursor_timeout(&pane_id, Duration::from_secs(1))
                .await
                .map_err(|e| map_error(&e))?,
        }
    } else {
        client
            .pane_cursor_timeout(&pane_id, Duration::from_secs(1))
            .await
            .map_err(|e| map_error(&e))?
    };
    Ok(PaneCursor { y, x })
}

pub async fn focus_pane_core(state: &AppState, pane_id: String) -> Result<(), String> {
    let client = {
        let inner = state.inner.lock().await;
        inner.client()?.clone()
    };
    off_lock(move || client.select_pane(&pane_id).map_err(|e| map_error(&e))).await
}

pub async fn stop_server_core(app: Option<&AppHandle>, state: &AppState) -> Result<(), String> {
    control::disconnect_core(state).await?;
    let client = {
        let inner = state.inner.lock().await;
        inner.client.clone()
    };
    if let Some(client) = client {
        off_lock(move || client.kill_server().map_err(|e| map_error(&e))).await?;
    }
    let mut inner = state.inner.lock().await;
    inner.stopped = true;
    drop(inner);
    let _ = state.events_tx.send(ServerPushEvent::ServerStopped);
    if let Some(app) = app {
        let _ = app.emit("server-stopped", ());
    }
    Ok(())
}

#[tauri::command]
pub async fn stop_server(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    stop_server_core(Some(&app), &state).await
}

pub async fn remember_session_core(state: &AppState, name: String) -> Result<(), String> {
    let name = sparkmux_core::session_name(&name)
        .map_err(|e| map_error(&e))?
        .to_string();
    let mut inner = state.inner.lock().await;
    inner.config.last_session = Some(name.clone());
    persist_last_session(&name)?;
    Ok(())
}

#[tauri::command]
pub fn parse_layout(layout: String) -> Result<LayoutNode, String> {
    parse_window_layout(&layout).map_err(|e| e.to_string())
}

pub async fn attach_target_name_core(state: &AppState) -> Result<Option<String>, String> {
    let (last, default, client) = {
        let mut inner = state.inner.lock().await;
        let last = inner.config.last_session.clone();
        let default = inner.config.default_session.clone();
        let client = inner.ensure_client()?.clone();
        (last, default, client)
    };
    let snap = off_lock(move || client.snapshot().map_err(|e| map_error(&e))).await?;
    Ok(attach_target(&snap, last.as_deref(), &default))
}

const CLIP_MAX: usize = 1_048_576;

#[tauri::command]
pub async fn paste_into_pane(
    state: State<'_, AppState>,
    pane_id: String,
    bracket: bool,
) -> Result<(), String> {
    sparkmux_core::pane_id(&pane_id).map_err(|e| map_error(&e))?;
    let mut text = arboard::Clipboard::new()
        .and_then(|mut c| c.get_text())
        .map_err(|e| e.to_string())?;
    if text.len() > CLIP_MAX {
        text.truncate(CLIP_MAX);
    }
    if text.is_empty() {
        return Ok(());
    }
    if bracket {
        text = bracket_paste(&text);
    }
    let ctl = {
        let inner = state.inner.lock().await;
        inner
            .control
            .clone()
            .ok_or_else(|| "control client is not connected".to_string())?
    };
    ctl.send_keys_raw(&pane_id, text.as_bytes())
        .await
        .map_err(|e| map_error(&e))
}

fn bracket_paste(text: &str) -> String {
    let cleaned = text.replace("\u{1b}[200~", "").replace("\u{1b}[201~", "");
    format!("\u{1b}[200~{cleaned}\u{1b}[201~")
}

#[tauri::command]
pub fn clipboard_write(text: String) -> Result<(), String> {
    if text.len() > CLIP_MAX {
        return Err("clipboard text is too large".into());
    }
    arboard::Clipboard::new()
        .and_then(|mut c| c.set_text(text))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tmux_status(state: State<'_, AppState>) -> Result<TmuxStatus, String> {
    tmux_status_core(&state).await
}

#[tauri::command]
pub async fn snapshot(state: State<'_, AppState>) -> Result<Snapshot, String> {
    snapshot_core(&state).await
}

#[tauri::command]
pub async fn ensure_ready(state: State<'_, AppState>) -> Result<Snapshot, String> {
    ensure_ready_core(&state).await
}

#[tauri::command]
pub async fn new_session(state: State<'_, AppState>, name: String) -> Result<(), String> {
    new_session_core(&state, name).await
}

#[tauri::command]
pub async fn rename_session(
    state: State<'_, AppState>,
    target: String,
    new_name: String,
) -> Result<(), String> {
    rename_session_core(&state, target, new_name).await
}

#[tauri::command]
pub async fn kill_session(state: State<'_, AppState>, target: String) -> Result<(), String> {
    kill_session_core(&state, target).await
}

#[tauri::command]
pub async fn new_window(
    state: State<'_, AppState>,
    session: String,
    name: String,
) -> Result<(), String> {
    new_window_core(&state, session, name).await
}

#[tauri::command]
pub async fn select_window(state: State<'_, AppState>, window_id: String) -> Result<(), String> {
    select_window_core(&state, window_id).await
}

#[tauri::command]
pub async fn rename_window(
    state: State<'_, AppState>,
    window_id: String,
    name: String,
) -> Result<(), String> {
    rename_window_core(&state, window_id, name).await
}

#[tauri::command]
pub async fn kill_window(state: State<'_, AppState>, window_id: String) -> Result<(), String> {
    kill_window_core(&state, window_id).await
}

#[tauri::command]
pub async fn kill_pane(state: State<'_, AppState>, pane_id: String) -> Result<(), String> {
    kill_pane_core(&state, pane_id).await
}

#[tauri::command]
pub async fn split_pane(
    state: State<'_, AppState>,
    pane_id: String,
    vertical: bool,
) -> Result<(), String> {
    split_pane_core(&state, pane_id, vertical).await
}

#[tauri::command]
pub async fn window_resize(state: State<'_, AppState>, cols: u16, rows: u16) -> Result<(), String> {
    window_resize_core(&state, cols, rows).await
}

#[tauri::command]
pub async fn pane_cursor(
    state: State<'_, AppState>,
    pane_id: String,
) -> Result<PaneCursor, String> {
    pane_cursor_core(&state, pane_id).await
}

#[tauri::command]
pub async fn focus_pane(state: State<'_, AppState>, pane_id: String) -> Result<(), String> {
    focus_pane_core(&state, pane_id).await
}

#[tauri::command]
pub async fn remember_session(state: State<'_, AppState>, name: String) -> Result<(), String> {
    remember_session_core(&state, name).await
}

#[tauri::command]
pub async fn attach_target_name(state: State<'_, AppState>) -> Result<Option<String>, String> {
    attach_target_name_core(&state).await
}

fn check_version(client: &sparkmux_core::TmuxClient) -> Result<(), String> {
    let v = client.version().map_err(|e| map_error(&e))?;
    if !v.is_supported() {
        return Err(too_old(&v.raw));
    }
    Ok(())
}

pub fn sync_active_target_core(
    app: Option<&AppHandle>,
    state: &AppState,
    target: ActiveTarget,
) -> Result<(), String> {
    let changed = {
        let mut guard = state
            .active_target
            .lock()
            .map_err(|_| "active target lock poisoned".to_string())?;
        if *guard != target {
            *guard = target.clone();
            true
        } else {
            false
        }
    };
    if changed {
        if let Some(app) = app {
            let _ = app.emit("active-target-changed", &target);
        }
        let _ = state
            .events_tx
            .send(ServerPushEvent::ActiveTargetChanged(target));
    }
    Ok(())
}

#[tauri::command]
pub fn sync_active_target(
    app: AppHandle,
    state: State<'_, AppState>,
    target: ActiveTarget,
) -> Result<(), String> {
    sync_active_target_core(Some(&app), &state, target)
}

pub fn get_active_target_core(state: &AppState) -> Result<ActiveTarget, String> {
    let guard = state
        .active_target
        .lock()
        .map_err(|_| "active target lock poisoned".to_string())?;
    Ok(guard.clone())
}

#[tauri::command]
pub fn get_active_target(state: State<'_, AppState>) -> Result<ActiveTarget, String> {
    get_active_target_core(&state)
}

#[tauri::command]
pub fn open_popout_window(
    app: AppHandle,
    state: State<'_, AppState>,
    kind: String,
    target: Option<ActiveTarget>,
) -> Result<(), String> {
    let label = match kind.as_str() {
        "stats" => "stats",
        "gits" => "gits",
        _ => return Err(format!("unsupported popout window kind: {kind}")),
    };
    if let Some(target) = target {
        if let Ok(mut guard) = state.active_target.lock() {
            *guard = target.clone();
        }
        let _ = app.emit("active-target-changed", &target);
    }
    if let Some(existing) = app.get_webview_window(label) {
        let _ = existing.show();
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return Ok(());
    }
    let title = if label == "stats" {
        "Sparkmux — Stats"
    } else {
        "Sparkmux — Gits"
    };
    let url = WebviewUrl::App(format!("index.html?window={label}").into());
    WebviewWindowBuilder::new(&app, label, url)
        .title(title)
        .inner_size(1200.0, 800.0)
        .min_inner_size(720.0, 480.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::Duration;

    use sparkmux_core::{Pane, Session};

    use super::*;

    fn pane(id: &str, command: &str) -> Pane {
        Pane {
            id: id.into(),
            index: 0,
            command: command.into(),
            path: PathBuf::from("/sparkmux-qa-attention-does-not-exist"),
            pid: 0,
            active: true,
            width: 80,
            height: 24,
            title: String::new(),
            alternate: false,
            mouse: false,
            mouse_drag: false,
            mouse_any: false,
            mouse_sgr: false,
        }
    }

    fn window(
        id: &str,
        name: &str,
        index: u32,
        active: bool,
        bell: bool,
        activity: bool,
        epoch: i64,
        command: &str,
    ) -> Window {
        Window {
            id: id.into(),
            index,
            name: name.into(),
            active,
            layout: String::new(),
            bell,
            activity,
            activity_epoch: epoch,
            unread: false,
            pending_ask: String::new(),
            finished: false,
            attention_label: None,
            panes: vec![pane(id, command)],
        }
    }

    fn session(name: &str, attached: bool, windows: Vec<Window>) -> Session {
        Session {
            id: name.into(),
            name: name.into(),
            attached,
            created_epoch: 0,
            activity_epoch: 0,
            path: PathBuf::from("/tmp"),
            windows,
        }
    }

    fn tree(sessions: Vec<Session>) -> Snapshot {
        Snapshot {
            sessions,
            fetched_at: Instant::now(),
        }
    }

    async fn attached(name: &str) -> AppState {
        let state = AppState::new();
        state.inner.lock().await.attached_session = Some(name.to_string());
        state
    }

    #[tokio::test]
    async fn annotate_visible_window_is_the_attached_sessions_active_window() {
        let state = attached("Sparkmux").await;
        // "other" is first and tmux-attached, so a bug that uses snapshot order
        // or session.attached would treat the wrong window as on screen.
        let snap = annotate_attention(
            &state,
            tree(vec![
                session(
                    "other",
                    true,
                    vec![window("old", "zsh", 0, true, true, true, 10, "zsh")],
                ),
                session(
                    "Sparkmux",
                    false,
                    vec![
                        window("agy", "agy", 0, false, true, true, 10, "zsh"),
                        window("grok", "grok", 1, true, true, true, 50, "grok"),
                    ],
                ),
            ]),
        )
        .await
        .expect("annotate");
        let spark = snap
            .sessions
            .iter()
            .find(|s| s.name == "Sparkmux")
            .expect("sparkmux");
        let grok = spark.windows.iter().find(|w| w.id == "grok").expect("grok");
        let agy = spark.windows.iter().find(|w| w.id == "agy").expect("agy");
        let other = &snap.sessions[0].windows[0];
        assert!(
            !grok.unread,
            "the active window of the attached session is never unread"
        );
        assert!(
            agy.unread,
            "a hidden bell is unread even on the first sight"
        );
        assert!(
            other.unread,
            "the active window of another session is not the one on screen"
        );
    }

    #[tokio::test]
    async fn annotate_activity_flag_does_not_dot_a_hidden_shell() {
        let state = attached("Sparkmux").await;
        let hidden = |epoch| {
            tree(vec![session(
                "Sparkmux",
                true,
                vec![
                    window("grok", "grok", 0, true, false, true, epoch + 5, "grok"),
                    window("agy", "agy", 1, false, false, true, epoch, "zsh"),
                ],
            )])
        };
        let first = annotate_attention(&state, hidden(100))
            .await
            .expect("first");
        let agy = &first.sessions[0].windows[1];
        assert!(!agy.unread, "first hidden sight baselines");
        assert!(!first.sessions[0].windows[0].unread, "visible grok");
        let same = annotate_attention(&state, hidden(100))
            .await
            .expect("same epoch");
        assert!(
            !same.sessions[0].windows[1].unread,
            "a latched activity flag is not unread"
        );
        let moved = annotate_attention(&state, hidden(102))
            .await
            .expect("moved");
        assert!(
            !moved.sessions[0].windows[1].unread,
            "a shell burst is not unread before it has been quiet for 3s"
        );
    }

    #[tokio::test]
    async fn annotate_keeps_a_cached_label_when_the_read_cap_drops_the_window() {
        let state = attached("Sparkmux").await;
        let mut windows = Vec::new();
        for index in 0..9 {
            windows.push(window(
                &format!("w{index}"),
                "agy",
                index,
                false,
                false,
                true,
                10,
                "agy",
            ));
        }
        let first = annotate_attention(
            &state,
            tree(vec![session("Sparkmux", true, windows.clone())]),
        )
        .await
        .expect("baseline");
        assert!(
            first.sessions[0].windows.iter().all(|w| !w.unread),
            "first sight does not dot"
        );
        let past = Instant::now()
            .checked_sub(Duration::from_secs(5))
            .expect("past");
        {
            let mut inner = state.inner.lock().await;
            assert!(!inner.attention.unread(
                &attention::WindowAttention {
                    id: "w8".into(),
                    bell: false,
                    activity_epoch: 12,
                    visible: false,
                    agent: true,
                    label: Some(AttentionLabel::Running),
                },
                past,
            ));
            inner.attention.store_label(
                "w8",
                Some(LabelToken {
                    transcript_path: "/tmp/chat.jsonl".into(),
                    file_len: 4,
                    last_entry_id: "a".into(),
                }),
                Some(AttentionLabel::Running),
                past,
            );
        }
        for window in &mut windows {
            window.activity_epoch = 12;
        }
        let second = annotate_attention(&state, tree(vec![session("Sparkmux", true, windows)]))
            .await
            .expect("capped");
        let held = second.sessions[0]
            .windows
            .iter()
            .find(|w| w.id == "w8")
            .expect("w8");
        assert!(
            !held.unread,
            "a running agent past the 8-read cap must not be treated as unlabeled"
        );
    }

    #[tokio::test]
    async fn annotate_visible_fetch_keeps_needs_user_when_unread_is_clear() {
        let state = attached("Sparkmux").await;
        {
            let mut inner = state.inner.lock().await;
            inner.attention.store_label(
                "grok",
                Some(LabelToken {
                    transcript_path: "/tmp/chat.jsonl".into(),
                    file_len: 8,
                    last_entry_id: "ask".into(),
                }),
                Some(AttentionLabel::NeedsUser),
                Instant::now(),
            );
        }
        let visible = annotate_attention(
            &state,
            tree(vec![session(
                "Sparkmux",
                true,
                vec![window("grok", "grok", 0, true, false, true, 40, "grok")],
            )]),
        )
        .await
        .expect("visible");
        let on_screen = &visible.sessions[0].windows[0];
        assert!(!on_screen.unread);
        assert!(on_screen.pending_ask.is_empty());
        assert_eq!(on_screen.attention_label.as_deref(), Some("needs_user"));

        let left = annotate_attention(
            &state,
            tree(vec![session(
                "Sparkmux",
                true,
                vec![window("grok", "grok", 0, false, false, true, 40, "grok")],
            )]),
        )
        .await
        .expect("left");
        let hidden = &left.sessions[0].windows[0];
        assert!(!hidden.unread);
        assert!(hidden.pending_ask.is_empty());
        assert!(!hidden.active);
        assert_eq!(hidden.attention_label.as_deref(), Some("needs_user"));
    }
}
