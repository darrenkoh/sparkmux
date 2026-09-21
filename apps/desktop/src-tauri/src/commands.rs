use serde::Serialize;
use sparkmux_core::{attach_target, parse_window_layout, LayoutNode, Snapshot, SOCKET_NAME};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, State};

use crate::control;
use crate::error::{map_error, too_old};
use crate::state::{persist_last_session, AppState};

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
    match inner.ensure_client() {
        Ok(client) => {
            status.bin = Some(client.bin.display().to_string());
            match client.version() {
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
            if let Ok(path) = client.socket_path_display() {
                status.socket_path = Some(path);
            }
        }
        Err(e) => {
            if e.starts_with("missing-tmux") || e.starts_with("too-old") {
                status.error = Some(e.split(':').next().unwrap_or("missing-tmux").to_string());
            } else {
                status.error = Some("missing-tmux".into());
            }
            status.hint = Some(e);
        }
    }
    Ok(status)
}

#[tauri::command]
pub async fn snapshot(state: State<'_, AppState>) -> Result<Snapshot, String> {
    let mut inner = state.inner.lock().await;
    let client = inner.ensure_client()?;
    match client.snapshot() {
        Ok(s) => Ok(s),
        Err(e) => {
            let msg = map_error(&e);
            if msg.starts_with("server-down") {
                Ok(sparkmux_core::Snapshot::empty())
            } else {
                Err(msg)
            }
        }
    }
}

#[tauri::command]
pub async fn ensure_ready(state: State<'_, AppState>) -> Result<Snapshot, String> {
    let mut inner = state.inner.lock().await;
    let spawn = inner.spawn.clone();
    let default_session = inner.config.default_session.clone();
    let client = inner.ensure_client()?;
    check_version(client)?;
    let snap = client
        .ensure_ready(&spawn, &default_session)
        .map_err(|e| map_error(&e))?;
    inner.stopped = false;
    Ok(snap)
}

#[tauri::command]
pub async fn new_session(state: State<'_, AppState>, name: String) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("session name is required".into());
    }
    let mut inner = state.inner.lock().await;
    let spawn = inner.spawn.clone();
    let client = inner.ensure_client()?;
    check_version(client)?;
    client
        .new_session_ex(&name, &spawn)
        .map_err(|e| map_error(&e))?;
    inner.stopped = false;
    Ok(())
}

#[tauri::command]
pub async fn rename_session(
    state: State<'_, AppState>,
    target: String,
    new_name: String,
) -> Result<(), String> {
    let inner = state.inner.lock().await;
    let client = inner.client()?;
    client
        .rename_session(&target, new_name.trim())
        .map_err(|e| map_error(&e))
}

#[tauri::command]
pub async fn kill_session(state: State<'_, AppState>, target: String) -> Result<(), String> {
    let inner = state.inner.lock().await;
    let client = inner.client()?;
    client.kill_session(&target).map_err(|e| map_error(&e))
}

#[tauri::command]
pub async fn new_window(
    state: State<'_, AppState>,
    session: String,
    name: String,
) -> Result<(), String> {
    let mut inner = state.inner.lock().await;
    let spawn = inner.spawn.clone();
    let attached = inner.attached_session.clone();
    let client = inner.ensure_client()?;
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
    client
        .new_window_ex(&session, &name, &spawn)
        .map_err(|e| map_error(&e))
}

#[tauri::command]
pub async fn select_window(state: State<'_, AppState>, window_id: String) -> Result<(), String> {
    let inner = state.inner.lock().await;
    let client = inner.client()?;
    client.select_window(&window_id).map_err(|e| map_error(&e))
}

#[tauri::command]
pub async fn rename_window(
    state: State<'_, AppState>,
    window_id: String,
    name: String,
) -> Result<(), String> {
    let inner = state.inner.lock().await;
    let client = inner.client()?;
    client
        .rename_window(&window_id, name.trim())
        .map_err(|e| map_error(&e))
}

#[tauri::command]
pub async fn kill_window(state: State<'_, AppState>, window_id: String) -> Result<(), String> {
    let inner = state.inner.lock().await;
    let client = inner.client()?;
    client.kill_window(&window_id).map_err(|e| map_error(&e))
}

#[tauri::command]
pub async fn kill_pane(state: State<'_, AppState>, pane_id: String) -> Result<(), String> {
    let inner = state.inner.lock().await;
    let client = inner.client()?;
    client.kill_pane(&pane_id).map_err(|e| map_error(&e))
}

#[tauri::command]
pub async fn split_pane(
    state: State<'_, AppState>,
    pane_id: String,
    vertical: bool,
) -> Result<(), String> {
    let inner = state.inner.lock().await;
    let client = inner.client()?;
    client
        .split_window(&pane_id, vertical)
        .map_err(|e| map_error(&e))
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

#[tauri::command]
pub async fn focus_pane(state: State<'_, AppState>, pane_id: String) -> Result<(), String> {
    let inner = state.inner.lock().await;
    let client = inner.client()?;
    client.select_pane(&pane_id).map_err(|e| map_error(&e))
}

#[tauri::command]
pub async fn stop_server(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    control::disconnect(&state).await?;
    let mut inner = state.inner.lock().await;
    if let Some(client) = inner.client.as_ref() {
        client.kill_server().map_err(|e| map_error(&e))?;
    }
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
    let mut inner = state.inner.lock().await;
    let last = inner.config.last_session.clone();
    let default = inner.config.default_session.clone();
    let client = inner.ensure_client()?;
    let snap = client.snapshot().map_err(|e| map_error(&e))?;
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
