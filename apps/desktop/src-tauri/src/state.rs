use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use sparkmux_core::{
    gui_spawn_env, load_config, Config, ConfigOverrides, ControlClient, SessionSpawn, TmuxClient,
};
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::sync::Mutex;

use crate::error::map_error;

pub struct PaneFeed {
    pub channel: Channel<InvokeResponseBody>,
    pub seeded: bool,
    pub buf: Vec<Vec<u8>>,
}

pub struct AppState {
    pub inner: Mutex<Inner>,
}

pub struct Inner {
    pub client: Option<TmuxClient>,
    pub control: Option<Arc<ControlClient>>,
    pub config: Config,
    pub spawn: SessionSpawn,
    pub attached_session: Option<String>,
    pub channels: Arc<Mutex<HashMap<String, PaneFeed>>>,
    pub pump: Option<tauri::async_runtime::JoinHandle<()>>,
    pub stopped: bool,
}

impl AppState {
    pub fn new() -> Self {
        let (config, warning) = load_config(ConfigOverrides::default());
        if let Some(w) = warning {
            tracing::warn!("{w}");
        }
        Self {
            inner: Mutex::new(Inner {
                client: None,
                control: None,
                config,
                spawn: gui_spawn_env(),
                attached_session: None,
                channels: Arc::new(Mutex::new(HashMap::new())),
                pump: None,
                stopped: false,
            }),
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
