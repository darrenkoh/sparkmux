use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use sparkmux_core::{ControlEvent, LayoutNode};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

use crate::error::map_error;
use crate::state::{
    deliver_output, next_subscriber_id, AppState, PaneSink, PaneSubscriber, ServerPushEvent,
};

#[derive(Serialize, Clone)]
struct LayoutChangePayload {
    window_id: String,
    layout: LayoutNode,
}

pub async fn connect_core(
    app: Option<&AppHandle>,
    state: &AppState,
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
    let pump = spawn_pump(app.cloned(), state.events_tx.clone(), &ctl, channels);
    inner.control = Some(Arc::new(ctl));
    inner.pump = Some(pump);
    inner.attached_session = Some(session.clone());
    inner.stopped = false;
    ensure_screen(&mut inner, &session).await;
    tracing::info!(ms = started.elapsed().as_millis(), "control_connect_ms");
    Ok(())
}

/// Desktop detach. Drops the control client and does not kill the tmux server.
pub async fn disconnect_core(state: &AppState) -> Result<(), String> {
    let mut inner = state.inner.lock().await;
    shutdown_locked(&mut inner).await;
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
    state: &AppState,
    pane_id: String,
    on_data: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    let sub_id = next_subscriber_id();
    subscribe_pane_with_sink(state, pane_id, sub_id, PaneSink::Tauri(on_data)).await
}

pub async fn subscribe_pane_with_sink(
    state: &AppState,
    pane_id: String,
    sub_id: u64,
    sink: PaneSink,
) -> Result<(), String> {
    sparkmux_core::pane_id(&pane_id).map_err(|e| map_error(&e))?;
    let client = {
        let inner = state.inner.lock().await;
        {
            let mut map = inner.channels.lock().await;
            if matches!(sink, PaneSink::Tauri(_)) {
                if let Some(subs) = map.get_mut(&pane_id) {
                    subs.retain(|sub| !matches!(sub.sink, PaneSink::Tauri(_)));
                    if subs.is_empty() {
                        map.remove(&pane_id);
                    }
                }
            }
            map.entry(pane_id.clone())
                .or_default()
                .push(PaneSubscriber {
                    id: sub_id,
                    sink,
                    seeded: false,
                    buf: Vec::new(),
                });
        }
        inner.client.clone()
    };
    let seed = if let Some(client) = client {
        seed_pane_bytes(&client, &pane_id).await
    } else {
        Vec::new()
    };
    let channels = {
        let inner = state.inner.lock().await;
        inner.channels.clone()
    };
    let mut map = channels.lock().await;
    let Some(subs) = map.get_mut(&pane_id) else {
        return Ok(());
    };
    let Some(sub) = subs.iter_mut().find(|sub| sub.id == sub_id) else {
        return Ok(());
    };
    if !sub.sink.send_bytes(true, &pane_id, seed) {
        subs.retain(|sub| sub.id != sub_id);
        if subs.is_empty() {
            map.remove(&pane_id);
        }
        return Ok(());
    }
    sub.seeded = true;
    let buffered = std::mem::take(&mut sub.buf);
    for bytes in buffered {
        if !sub.sink.send_bytes(false, &pane_id, bytes) {
            break;
        }
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

/// Desktop unsubscribe drops Tauri sinks for this pane and leaves web subscribers attached.
pub async fn unsubscribe_pane(state: &AppState, pane_id: &str) {
    let inner = state.inner.lock().await;
    let mut map = inner.channels.lock().await;
    let Some(subs) = map.get_mut(pane_id) else {
        return;
    };
    subs.retain(|sub| !matches!(sub.sink, PaneSink::Tauri(_)));
    if subs.is_empty() {
        map.remove(pane_id);
    }
}

/// Remove one web subscriber. `None` clears every subscriber of that pane.
/// The shared control client is left running.
pub async fn unsubscribe_pane_by_id(state: &AppState, pane_id: &str, sub_id: Option<u64>) {
    let inner = state.inner.lock().await;
    let mut map = inner.channels.lock().await;
    let Some(subs) = map.get_mut(pane_id) else {
        return;
    };
    match sub_id {
        Some(id) => subs.retain(|sub| sub.id != id),
        None => subs.clear(),
    }
    if subs.is_empty() {
        map.remove(pane_id);
    }
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

fn emit_push(
    app: Option<&AppHandle>,
    tx: &tokio::sync::broadcast::Sender<ServerPushEvent>,
    ev: ServerPushEvent,
) {
    if let Some(app) = app {
        match &ev {
            ServerPushEvent::LayoutChange { window_id, layout } => {
                let _ = app.emit(
                    "layout-change",
                    LayoutChangePayload {
                        window_id: window_id.clone(),
                        layout: layout.clone(),
                    },
                );
            }
            ServerPushEvent::TreeDirty => {
                let _ = app.emit("tree-dirty", ());
            }
            ServerPushEvent::ControlExit => {
                let _ = app.emit("control-exit", ());
            }
            ServerPushEvent::ServerStopped => {
                let _ = app.emit("server-stopped", ());
            }
            ServerPushEvent::Menu(id) => {
                let _ = app.emit("menu", id.clone());
            }
            ServerPushEvent::ActiveTargetChanged(target) => {
                let _ = app.emit("active-target-changed", target);
            }
        }
    }
    let _ = tx.send(ev);
}

fn spawn_pump(
    app: Option<AppHandle>,
    events_tx: tokio::sync::broadcast::Sender<ServerPushEvent>,
    ctl: &sparkmux_core::ControlClient,
    channels: Arc<Mutex<std::collections::HashMap<String, Vec<PaneSubscriber>>>>,
) -> tokio::task::JoinHandle<()> {
    let mut rx = ctl.subscribe();
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Some(ControlEvent::Output { pane_id, bytes }) => {
                    let mut map = channels.lock().await;
                    if let Some(subs) = map.get_mut(&pane_id) {
                        deliver_output(subs, &pane_id, &bytes);
                        if subs.is_empty() {
                            map.remove(&pane_id);
                        }
                    }
                }
                Some(ControlEvent::LayoutChange { window_id, layout }) => {
                    emit_push(
                        app.as_ref(),
                        &events_tx,
                        ServerPushEvent::LayoutChange { window_id, layout },
                    );
                }
                Some(ControlEvent::SnapshotHint) => {
                    emit_push(app.as_ref(), &events_tx, ServerPushEvent::TreeDirty);
                }
                Some(ControlEvent::Exit) => {
                    emit_push(app.as_ref(), &events_tx, ServerPushEvent::ControlExit);
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
    use crate::state::{AppState, PaneSink, PaneSubscriber};
    use tokio::sync::mpsc;

    #[test]
    fn quotes_spaces_and_escapes() {
        assert_eq!(tmux_quote("main"), "\"main\"");
        assert_eq!(tmux_quote("my work"), "\"my work\"");
        assert_eq!(tmux_quote("a\"b"), "\"a\\\"b\"");
    }

    #[tokio::test]
    async fn dropping_one_subscriber_leaves_the_other_and_the_session() {
        let state = AppState::new();
        let (tx_a, mut rx_a) = mpsc::unbounded_channel();
        let (tx_b, mut rx_b) = mpsc::unbounded_channel();
        {
            let mut inner = state.inner.lock().await;
            inner.attached_session = Some("keep-me".into());
            let mut map = inner.channels.lock().await;
            map.insert(
                "%0".into(),
                vec![
                    PaneSubscriber {
                        id: 1,
                        sink: PaneSink::WebSocket(tx_a),
                        seeded: true,
                        buf: Vec::new(),
                    },
                    PaneSubscriber {
                        id: 2,
                        sink: PaneSink::WebSocket(tx_b.clone()),
                        seeded: true,
                        buf: Vec::new(),
                    },
                ],
            );
        }
        super::unsubscribe_pane_by_id(&state, "%0", Some(1)).await;
        {
            let inner = state.inner.lock().await;
            assert_eq!(inner.attached_session.as_deref(), Some("keep-me"));
            assert!(inner.control.is_none());
            let map = inner.channels.lock().await;
            let subs = map.get("%0").unwrap();
            assert_eq!(subs.len(), 1);
            assert_eq!(subs[0].id, 2);
            assert!(subs[0].sink.send_bytes(false, "%0", b"after".to_vec()));
        }
        let frame = rx_b.try_recv().unwrap();
        assert_eq!(frame[0], 0x02);
        assert!(rx_a.try_recv().is_err());
    }
}
