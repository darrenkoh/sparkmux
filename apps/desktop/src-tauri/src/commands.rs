use std::time::Duration;

use serde::Serialize;
use sparkmux_core::{attach_target, parse_window_layout, LayoutNode, Snapshot, SOCKET_NAME};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, State};

use crate::control;
use crate::error::{map_error, too_old};
use crate::state::{persist_last_session, AppState};

/// A stuck tmux server must not pin the UI. Blocking `TmuxClient::run` calls
/// happen off the `AppState` lock and fail closed after this bound.
const TMUX_BLOCKING_TIMEOUT: Duration = Duration::from_secs(5);

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
    pub error: Option<String>,
    pub hint: Option<String>,
}

#[tauri::command]
pub async fn tmux_status(state: State<'_, AppState>) -> Result<TmuxStatus, String> {
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

#[tauri::command]
pub async fn snapshot(state: State<'_, AppState>) -> Result<Snapshot, String> {
    let client = {
        let mut inner = state.inner.lock().await;
        inner.ensure_client()?.clone()
    };
    match off_lock(move || client.snapshot().map_err(|e| map_error(&e))).await {
        Ok(s) => Ok(s),
        Err(msg) if msg.starts_with("server-down") => Ok(sparkmux_core::Snapshot::empty()),
        Err(msg) => Err(msg),
    }
}

#[tauri::command]
pub async fn ensure_ready(state: State<'_, AppState>) -> Result<Snapshot, String> {
    let (client, spawn, default_session) = {
        let mut inner = state.inner.lock().await;
        let spawn = inner.spawn.clone();
        let default_session = inner.config.default_session.clone();
        let client = inner.ensure_client()?.clone();
        (client, spawn, default_session)
    };
    let snap = off_lock(move || {
        check_version(&client)?;
        client
            .ensure_ready(&spawn, &default_session)
            .map_err(|e| map_error(&e))
    })
    .await?;
    let mut inner = state.inner.lock().await;
    inner.stopped = false;
    Ok(snap)
}

#[tauri::command]
pub async fn new_session(state: State<'_, AppState>, name: String) -> Result<(), String> {
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

#[tauri::command]
pub async fn rename_session(
    state: State<'_, AppState>,
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

#[tauri::command]
pub async fn kill_session(state: State<'_, AppState>, target: String) -> Result<(), String> {
    let client = {
        let inner = state.inner.lock().await;
        inner.client()?.clone()
    };
    off_lock(move || client.kill_session(&target).map_err(|e| map_error(&e))).await
}

#[tauri::command]
pub async fn new_window(
    state: State<'_, AppState>,
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

#[tauri::command]
pub async fn select_window(state: State<'_, AppState>, window_id: String) -> Result<(), String> {
    let client = {
        let inner = state.inner.lock().await;
        inner.client()?.clone()
    };
    off_lock(move || client.select_window(&window_id).map_err(|e| map_error(&e))).await
}

#[tauri::command]
pub async fn rename_window(
    state: State<'_, AppState>,
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

#[tauri::command]
pub async fn kill_window(state: State<'_, AppState>, window_id: String) -> Result<(), String> {
    let client = {
        let inner = state.inner.lock().await;
        inner.client()?.clone()
    };
    off_lock(move || client.kill_window(&window_id).map_err(|e| map_error(&e))).await
}

#[tauri::command]
pub async fn kill_pane(state: State<'_, AppState>, pane_id: String) -> Result<(), String> {
    let client = {
        let inner = state.inner.lock().await;
        inner.client()?.clone()
    };
    off_lock(move || client.kill_pane(&pane_id).map_err(|e| map_error(&e))).await
}

#[tauri::command]
pub async fn split_pane(
    state: State<'_, AppState>,
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
    control::connect(&app, &state, session, cols, rows).await
}

#[tauri::command]
pub async fn control_disconnect(state: State<'_, AppState>) -> Result<(), String> {
    control::disconnect(&state).await
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

#[tauri::command]
pub async fn pane_write(
    state: State<'_, AppState>,
    pane_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let ctl = {
        let inner = state.inner.lock().await;
        inner
            .control
            .clone()
            .ok_or_else(|| "control client is not connected".to_string())?
    };
    ctl.send_keys_raw(&pane_id, &data)
        .await
        .map_err(|e| map_error(&e))
}

#[tauri::command]
pub async fn window_resize(state: State<'_, AppState>, cols: u16, rows: u16) -> Result<(), String> {
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

#[tauri::command]
pub async fn pane_cursor(
    state: State<'_, AppState>,
    pane_id: String,
) -> Result<PaneCursor, String> {
    let client = {
        let inner = state.inner.lock().await;
        inner.client()?.clone()
    };
    let (y, x) = client
        .pane_cursor_timeout(&pane_id, Duration::from_millis(200))
        .await
        .map_err(|e| map_error(&e))?;
    Ok(PaneCursor { y, x })
}

#[tauri::command]
pub async fn focus_pane(state: State<'_, AppState>, pane_id: String) -> Result<(), String> {
    let client = {
        let inner = state.inner.lock().await;
        inner.client()?.clone()
    };
    off_lock(move || client.select_pane(&pane_id).map_err(|e| map_error(&e))).await
}

#[tauri::command]
pub async fn stop_server(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    control::disconnect(&state).await?;
    let client = {
        let inner = state.inner.lock().await;
        inner.client.clone()
    };
    if let Some(client) = client {
        off_lock(move || client.kill_server().map_err(|e| map_error(&e))).await?;
    }
    let mut inner = state.inner.lock().await;
    inner.stopped = true;
    let _ = app.emit("server-stopped", ());
    Ok(())
}

#[tauri::command]
pub async fn remember_session(state: State<'_, AppState>, name: String) -> Result<(), String> {
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

#[tauri::command]
pub async fn attach_target_name(state: State<'_, AppState>) -> Result<Option<String>, String> {
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

fn check_version(client: &sparkmux_core::TmuxClient) -> Result<(), String> {
    let v = client.version().map_err(|e| map_error(&e))?;
    if !v.is_supported() {
        return Err(too_old(&v.raw));
    }
    Ok(())
}
