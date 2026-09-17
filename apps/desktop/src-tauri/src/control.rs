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
use crate::state::AppState;

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
    let mut inner = state.inner.lock().await;
    inner.ensure_client()?;
    let client = inner.client.as_ref().unwrap();
    let (bin, args) = client.control_argv(&session);

    if let Some(ctl) = inner.control.clone() {
        if inner.attached_session.as_deref() == Some(session.as_str()) {
            drop(inner);
            let _ = ctl.refresh_size(cols.max(2), rows.max(1)).await;
            return Ok(());
        }
        drop(inner);
        if ctl
            .command(&format!("switch-client -t {session}"))
            .await
            .is_ok()
        {
            let mut inner = state.inner.lock().await;
            inner.attached_session = Some(session);
            inner.stopped = false;
            drop(inner);
            let _ = ctl.refresh_size(cols.max(2), rows.max(1)).await;
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
    inner.attached_session = Some(session);
    inner.stopped = false;
    tracing::info!(ms = started.elapsed().as_millis(), "control_connect_ms");
    Ok(())
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
    let (client, channel) = {
        let inner = state.inner.lock().await;
        inner
            .channels
            .lock()
            .await
            .insert(pane_id.clone(), on_data.clone());
        (inner.client.clone(), on_data)
    };
    if let Some(client) = client {
        match client
            .capture_pane_timeout(&pane_id, Duration::from_millis(300))
            .await
        {
            Ok(text) => {
                let _ = channel.send(InvokeResponseBody::Raw(text.into_bytes()));
            }
            Err(e) => {
                tracing::debug!(pane = %pane_id, error = %e, "seed capture-pane failed");
            }
        }
    }
    Ok(())
}

pub async fn unsubscribe_pane(state: &State<'_, AppState>, pane_id: &str) {
    let inner = state.inner.lock().await;
    inner.channels.lock().await.remove(pane_id);
}

fn spawn_pump(
    app: AppHandle,
    ctl: &sparkmux_core::ControlClient,
    channels: Arc<Mutex<HashMap<String, Channel<InvokeResponseBody>>>>,
) -> JoinHandle<()> {
    let mut rx = ctl.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(ControlEvent::Output { pane_id, bytes }) => {
                    let map = channels.lock().await;
                    if let Some(ch) = map.get(&pane_id) {
                        let _ = ch.send(InvokeResponseBody::Raw(bytes));
                    }
                }
                Ok(ControlEvent::LayoutChange { window_id, layout }) => {
                    let _ = app.emit("layout-change", LayoutChangePayload { window_id, layout });
                }
                Ok(ControlEvent::SnapshotHint) => {
                    let _ = app.emit("tree-dirty", ());
                }
                Ok(ControlEvent::Exit) => {
                    let _ = app.emit("control-exit", ());
                    break;
                }
                Ok(ControlEvent::Error(e)) => {
                    tracing::warn!(%e, "control error");
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(n, "control events lagged");
                }
                Err(_) => break,
            }
        }
    })
}
