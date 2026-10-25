use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use sparkmux_core::{
    gui_spawn_env, load_config, Config, ConfigOverrides, ControlClient, LayoutNode, ScreenClient,
    SessionSpawn, TmuxClient,
};
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::sync::{broadcast, mpsc, Mutex};

use crate::attention::AttentionBook;
use crate::error::map_error;
use crate::web_protocol::{encode_frame, FRAME_OUTPUT, FRAME_SEED};

static NEXT_SUB_ID: AtomicU64 = AtomicU64::new(1);

pub fn next_subscriber_id() -> u64 {
    NEXT_SUB_ID.fetch_add(1, Ordering::Relaxed)
}

#[derive(Clone)]
pub enum PaneSink {
    Tauri(Channel<InvokeResponseBody>),
    WebSocket(mpsc::UnboundedSender<Vec<u8>>),
}

impl PaneSink {
    /// Tauri gets raw terminal bytes. A web client gets a `0x01` seed or `0x02` output frame.
    pub fn send_bytes(&self, is_seed: bool, pane_id: &str, bytes: Vec<u8>) -> bool {
        match self {
            PaneSink::Tauri(channel) => channel.send(InvokeResponseBody::Raw(bytes)).is_ok(),
            PaneSink::WebSocket(tx) => {
                let kind = if is_seed { FRAME_SEED } else { FRAME_OUTPUT };
                let Ok(frame) = encode_frame(kind, pane_id, &bytes) else {
                    return false;
                };
                tx.send(frame).is_ok()
            }
        }
    }
}

pub struct PaneSubscriber {
    pub id: u64,
    pub sink: PaneSink,
    pub seeded: bool,
    pub buf: Vec<Vec<u8>>,
}

/// Push events shared by the desktop window and every WebSocket client.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "event", content = "payload")]
pub enum ServerPushEvent {
    #[serde(rename = "layout-change")]
    LayoutChange {
        window_id: String,
        layout: LayoutNode,
    },
    #[serde(rename = "tree-dirty")]
    TreeDirty,
    #[serde(rename = "control-exit")]
    ControlExit,
    #[serde(rename = "server-stopped")]
    ServerStopped,
    #[serde(rename = "menu")]
    Menu(String),
    #[serde(rename = "active-target-changed")]
    ActiveTargetChanged(ActiveTarget),
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct ActiveTarget {
    pub session_name: String,
    pub tab_id: String,
    pub tab_name: String,
    pub focused_pane: String,
    pub command: String,
    pub cwd: String,
    pub title: String,
    pub pid: u32,
}

#[derive(Clone)]
pub struct AppState {
    pub inner: Arc<Mutex<Inner>>,
    pub active_target: Arc<std::sync::Mutex<ActiveTarget>>,
    pub events_tx: broadcast::Sender<ServerPushEvent>,
    pub is_headless: bool,
    pub web_urls: Arc<std::sync::Mutex<Vec<String>>>,
}

pub struct Inner {
    pub client: Option<TmuxClient>,
    pub control: Option<Arc<ControlClient>>,
    /// Read-only client so programs inside a pane do not treat Sparkmux as
    /// tmux control mode. See `sparkmux_core::ScreenClient`.
    pub screen: Option<ScreenClient>,
    pub config: Config,
    pub spawn: SessionSpawn,
    pub attached_session: Option<String>,
    pub attention: AttentionBook,
    pub channels: Arc<Mutex<HashMap<String, Vec<PaneSubscriber>>>>,
    pub pump: Option<tokio::task::JoinHandle<()>>,
    pub stopped: bool,
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

impl AppState {
    pub fn new() -> Self {
        Self::with_headless(false)
    }

    pub fn new_headless() -> Self {
        Self::with_headless(true)
    }

    pub fn with_headless(is_headless: bool) -> Self {
        let (config, warning) = load_config(ConfigOverrides::default());
        if let Some(w) = warning {
            tracing::warn!("{w}");
        }
        let (events_tx, _) = broadcast::channel(256);
        Self {
            inner: Arc::new(Mutex::new(Inner {
                client: None,
                control: None,
                screen: None,
                config,
                spawn: gui_spawn_env(),
                attached_session: None,
                attention: AttentionBook::default(),
                channels: Arc::new(Mutex::new(HashMap::new())),
                pump: None,
                stopped: false,
            })),
            active_target: Arc::new(std::sync::Mutex::new(ActiveTarget::default())),
            events_tx,
            is_headless,
            web_urls: Arc::new(std::sync::Mutex::new(Vec::new())),
        }
    }
}

impl Inner {
    pub fn ensure_client(&mut self) -> Result<&TmuxClient, String> {
        if self.client.is_none() {
            let client = TmuxClient::new_owned(
                self.config.tmux_bin.clone(),
                self.config.socket_name.clone(),
                self.config.socket_path.clone(),
            )
            .map_err(|e| map_error(&e))?;
            self.client = Some(client);
        }
        Ok(self.client.as_ref().unwrap())
    }

    pub fn client(&self) -> Result<&TmuxClient, String> {
        self.client
            .as_ref()
            .ok_or_else(|| "tmux client is not initialized".to_string())
    }
}

/// Deliver one `%output` chunk. Unseeded subscribers buffer it. A closed sink is dropped.
pub fn deliver_output(subs: &mut Vec<PaneSubscriber>, pane_id: &str, bytes: &[u8]) {
    let mut index = 0;
    while index < subs.len() {
        let keep = if subs[index].seeded {
            subs[index].sink.send_bytes(false, pane_id, bytes.to_vec())
        } else if subs[index].buf.len() < 256 {
            subs[index].buf.push(bytes.to_vec());
            true
        } else {
            true
        };
        if keep {
            index += 1;
        } else {
            subs.remove(index);
        }
    }
}

pub fn persist_last_session(name: &str) -> Result<PathBuf, String> {
    let dirs = directories::ProjectDirs::from("", "", "sparkmux")
        .ok_or_else(|| "could not resolve config directory".to_string())?;
    let dir = dirs.config_dir();
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join("config.toml");
    let existing = fs::read_to_string(&path).unwrap_or_default();
    let escaped = name.replace('\\', "\\\\").replace('"', "\\\"");
    let mut out = String::new();
    let mut replaced = false;
    if !existing.is_empty() {
        for line in existing.lines() {
            if line.trim_start().starts_with("last_session") {
                out.push_str(&format!("last_session = \"{escaped}\"\n"));
                replaced = true;
            } else {
                out.push_str(line);
                out.push('\n');
            }
        }
    }
    if !replaced {
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(&format!("last_session = \"{escaped}\"\n"));
    }
    fs::write(&path, out).map_err(|e| e.to_string())?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::web_protocol::{decode_frame, FRAME_OUTPUT, FRAME_SEED};

    #[test]
    fn each_subscriber_gets_its_own_seed_and_later_output() {
        let (tx_a, mut rx_a) = mpsc::unbounded_channel();
        let (tx_b, mut rx_b) = mpsc::unbounded_channel();
        let mut subs = vec![
            PaneSubscriber {
                id: 1,
                sink: PaneSink::WebSocket(tx_a),
                seeded: false,
                buf: Vec::new(),
            },
            PaneSubscriber {
                id: 2,
                sink: PaneSink::WebSocket(tx_b),
                seeded: false,
                buf: Vec::new(),
            },
        ];
        assert!(subs[0].sink.send_bytes(true, "%0", b"seed-a".to_vec()));
        subs[0].seeded = true;
        assert!(subs[1].sink.send_bytes(true, "%999", b"seed-b".to_vec()));
        subs[1].seeded = true;
        deliver_output(&mut subs, "%0", b"live");
        let seed_a = decode_frame(&rx_a.try_recv().unwrap()).unwrap();
        assert_eq!(seed_a.kind, FRAME_SEED);
        assert_eq!(seed_a.pane_id, "%0");
        assert_eq!(seed_a.payload, b"seed-a");
        let live_a = decode_frame(&rx_a.try_recv().unwrap()).unwrap();
        assert_eq!(live_a.kind, FRAME_OUTPUT);
        assert_eq!(live_a.payload, b"live");
        let seed_b = decode_frame(&rx_b.try_recv().unwrap()).unwrap();
        assert_eq!(seed_b.kind, FRAME_SEED);
        assert_eq!(seed_b.pane_id, "%999");
        assert_eq!(seed_b.payload, b"seed-b");
        let live_b = decode_frame(&rx_b.try_recv().unwrap()).unwrap();
        assert_eq!(live_b.kind, FRAME_OUTPUT);
        assert_eq!(live_b.pane_id, "%0");
        assert!(rx_a.try_recv().is_err());
    }
}
