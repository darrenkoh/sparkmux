use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use sparkmux_core::{ControlEvent, LayoutNode};
use tauri::async_runtime::JoinHandle;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

use crate::error::map_error;
use crate::state::{AppState, PaneFeed};

#[derive(Serialize, Clone)]
struct LayoutChangePayload {
    window_id: String,
    layout: LayoutNode,
}

pub async fn connect(
    app: &AppHandle,
    state: &State<'_, AppState>,
    session: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = sparkmux_core::session_name(&session)
        .map_err(|e| map_error(&e))?
        .to_string();
    let mut inner = state.inner.lock().await;
    inner.ensure_client()?;
    let client = inner.client.as_ref().unwrap();
    let (bin, args) = client.control_argv(&session).map_err(|e| map_error(&e))?;

    if let Some(ctl) = inner.control.clone() {
        if inner.attached_session.as_deref() == Some(session.as_str()) {
            drop(inner);
            let _ = ctl.refresh_size(cols.max(2), rows.max(1)).await;
            let mut inner = state.inner.lock().await;
            ensure_screen(&mut inner, &session).await;
            return Ok(());
        }
        drop(inner);
        if ctl
            .command(&format!("switch-client -t {}", tmux_quote(&session)))
            .await
            .is_ok()
        {
            let mut inner = state.inner.lock().await;
            inner.attached_session = Some(session.clone());
            inner.stopped = false;
            drop(inner);
            let _ = ctl.refresh_size(cols.max(2), rows.max(1)).await;
            let mut inner = state.inner.lock().await;
            ensure_screen(&mut inner, &session).await;
            return Ok(());
        }
        inner = state.inner.lock().await;
    }

    shutdown_locked(&mut inner).await;

    tracing::info!(%session, cols, rows, "control_connect");
    let started = std::time::Instant::now();
    let ctl = sparkmux_core::ControlClient::spawn(bin, args)
        .await
        .map_err(|e| map_error(&e))?;
    if let Err(e) = ctl.refresh_size(cols.max(2), rows.max(1)).await {
        let _ = ctl.shutdown().await;
        return Err(map_error(&e));
    }

    let channels = inner.channels.clone();
    let pump = spawn_pump(app.clone(), &ctl, channels);
    inner.control = Some(Arc::new(ctl));
    inner.pump = Some(pump);
    inner.attached_session = Some(session.clone());
    inner.stopped = false;
    ensure_screen(&mut inner, &session).await;
    tracing::info!(ms = started.elapsed().as_millis(), "control_connect_ms");
    Ok(())
}

/// Keep a read-only client on the same session as the control client so a
/// program inside the pane does not see `control-mode` as the active client.
async fn ensure_screen(inner: &mut crate::state::Inner, session: &str) {
    let Some(client) = inner.client.clone() else {
        return;
    };
    if let Some(screen) = inner.screen.as_mut() {
        if screen.is_alive() {
            if screen.session() == session {
                return;
            }
            if screen.retarget(&client, session).is_ok() {
                return;
            }
        }
    }
    inner.screen.take();
    let session_owned = session.to_string();
    match tokio::task::spawn_blocking(move || client.spawn_screen_client(&session_owned)).await {
        Ok(Ok(screen)) => inner.screen = Some(screen),
        Ok(Err(err)) => tracing::warn!(error = %err, "read-only client did not attach"),
        Err(err) => tracing::warn!(error = %err, "read-only client did not attach"),
    }
}

pub async fn disconnect(state: &State<'_, AppState>) -> Result<(), String> {
    let mut inner = state.inner.lock().await;
    shutdown_locked(&mut inner).await;
    Ok(())
}

async fn shutdown_locked(inner: &mut crate::state::Inner) {
    if let Some(handle) = inner.pump.take() {
        handle.abort();
    }
    // Detach the read-only client before the control client so quit does not
    // leave an extra client on the server.
    inner.screen.take();
    inner.channels.lock().await.clear();
    if let Some(ctl) = inner.control.take() {
        let _ = ctl.shutdown().await;
    }
    inner.attached_session = None;
}

pub async fn subscribe_pane(
    state: &State<'_, AppState>,
    pane_id: String,
    on_data: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    sparkmux_core::pane_id(&pane_id).map_err(|e| map_error(&e))?;
    let client = {
        let inner = state.inner.lock().await;
        inner.channels.lock().await.insert(
            pane_id.clone(),
            PaneFeed {
                channel: on_data,
                seeded: false,
                buf: Vec::new(),
            },
        );
        inner.client.clone()
    };
    let mut seed = Vec::new();
    if let Some(client) = client {
        seed = seed_pane_bytes(&client, &pane_id).await;
    }
    let channels = {
        let inner = state.inner.lock().await;
        inner.channels.clone()
    };
    let mut map = channels.lock().await;
    let Some(feed) = map.get_mut(&pane_id) else {
        return Ok(());
    };
    let _ = feed.channel.send(InvokeResponseBody::Raw(seed));
    feed.seeded = true;
    for bytes in std::mem::take(&mut feed.buf) {
        let _ = feed.channel.send(InvokeResponseBody::Raw(bytes));
    }
    Ok(())
}

/// First payload for a pane: tmux scrollback, then the visible screen and cursor.
/// A failed history capture falls back to the visible screen so the pane still opens.
async fn seed_pane_bytes(client: &sparkmux_core::TmuxClient, pane_id: &str) -> Vec<u8> {
    let timeout = Duration::from_secs(1);
    match client
        .capture_pane_scrollback_timeout(pane_id, sparkmux_core::PANE_SCROLLBACK_LINES, timeout)
        .await
    {
        Ok(text) => match client.pane_seed_meta_timeout(pane_id, timeout).await {
            Ok((y, x, height)) if height > 0 => {
                let (history, visible) = sparkmux_core::split_pane_capture(&text, height);
                let mut body = sparkmux_core::visible_seed_body(&visible);
                body.push_str(&sparkmux_core::TmuxClient::cursor_cup(y, x));
                sparkmux_core::format_pane_seed(&history, &body).into_bytes()
            }
            Ok(_) => {
                tracing::debug!(pane = %pane_id, "pane height missing; seeding the visible screen");
                visible_only_seed(client, pane_id).await
            }
            Err(e) => {
                tracing::debug!(pane = %pane_id, error = %e, "pane meta failed; seeding the visible screen");
                visible_only_seed(client, pane_id).await
            }
        },
        Err(e) => {
            tracing::debug!(pane = %pane_id, error = %e, "scrollback capture failed");
            visible_only_seed(client, pane_id).await
        }
    }
}

async fn visible_only_seed(client: &sparkmux_core::TmuxClient, pane_id: &str) -> Vec<u8> {
    let timeout = Duration::from_secs(1);
    let Ok(mut text) = client.capture_pane_timeout(pane_id, timeout).await else {
        return Vec::new();
    };
    while text.ends_with('\n') || text.ends_with('\r') {
        text.pop();
    }
    if let Ok((y, x)) = client.pane_cursor_timeout(pane_id, timeout).await {
        text.push_str(&sparkmux_core::TmuxClient::cursor_cup(y, x));
    }
    text.into_bytes()
}

pub async fn unsubscribe_pane(state: &State<'_, AppState>, pane_id: &str) {
    let inner = state.inner.lock().await;
    inner.channels.lock().await.remove(pane_id);
}

fn tmux_quote(s: &str) -> String {
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

fn spawn_pump(
    app: AppHandle,
    ctl: &sparkmux_core::ControlClient,
    channels: Arc<Mutex<HashMap<String, PaneFeed>>>,
) -> JoinHandle<()> {
    let mut rx = ctl.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Some(ControlEvent::Output { pane_id, bytes }) => {
                    let mut map = channels.lock().await;
                    if let Some(feed) = map.get_mut(&pane_id) {
                        if feed.seeded {
                            let _ = feed.channel.send(InvokeResponseBody::Raw(bytes));
                        } else if feed.buf.len() < 256 {
                            feed.buf.push(bytes);
                        }
                    }
                }
                Some(ControlEvent::LayoutChange { window_id, layout }) => {
                    let _ = app.emit("layout-change", LayoutChangePayload { window_id, layout });
                }
                Some(ControlEvent::SnapshotHint) => {
                    let _ = app.emit("tree-dirty", ());
                }
                Some(ControlEvent::Exit) => {
                    let _ = app.emit("control-exit", ());
                    break;
                }
                Some(ControlEvent::Error(e)) => {
                    tracing::warn!(%e, "control error");
                }
                None => break,
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::tmux_quote;

    #[test]
    fn quotes_spaces_and_escapes() {
        assert_eq!(tmux_quote("main"), "\"main\"");
        assert_eq!(tmux_quote("my work"), "\"my work\"");
        assert_eq!(tmux_quote("a\"b"), "\"a\\\"b\"");
    }
}
