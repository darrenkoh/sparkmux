use std::fs;
use std::path::PathBuf;

use directories::ProjectDirs;
use serde::Deserialize;

use crate::Cli;

#[derive(Debug, Clone)]
pub struct Config {
    pub tmux_bin: Option<PathBuf>,
    pub socket_name: Option<String>,
    pub socket_path: Option<PathBuf>,
    pub refresh_ms: u64,
    pub preview_ms: u64,
    pub preview_lines: usize,
    pub verbose: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            tmux_bin: None,
            socket_name: None,
            socket_path: None,
            refresh_ms: 1000,
            preview_ms: 400,
            preview_lines: 200,
            verbose: false,
        }
    }
}

#[derive(Debug, Deserialize, Default)]
struct FileConfig {
    #[serde(default)]
    tmux_bin: String,
    #[serde(default)]
    socket_name: String,
    #[serde(default)]
    socket_path: String,
    refresh_ms: Option<u64>,
    preview_ms: Option<u64>,
    preview_lines: Option<usize>,
}

pub fn load(cli: &Cli) -> Config {
    let mut cfg = Config::default();
    let path = cli.config.clone().or_else(default_config_path);
    if let Some(path) = path {
        match fs::read_to_string(&path) {
            Ok(text) => match toml::from_str::<FileConfig>(&text) {
                Ok(file) => apply_file(&mut cfg, file),
                Err(e) => {
                    tracing::warn!(error = %e, path = %path.display(), "invalid config, using defaults")
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && cli.config.is_none() => {}
            Err(e) => {
                tracing::warn!(error = %e, path = %path.display(), "could not read config, using defaults")
            }
        }
    }

    if let Some(bin) = &cli.tmux_bin {
        cfg.tmux_bin = Some(bin.clone());
    }
    if let Some(name) = &cli.socket_name {
        cfg.socket_name = Some(name.clone());
    }
    if let Some(path) = &cli.socket_path {
        cfg.socket_path = Some(path.clone());
    }
    cfg.verbose = cli.verbose;
    cfg
}

fn apply_file(cfg: &mut Config, file: FileConfig) {
    if !file.tmux_bin.is_empty() {
        cfg.tmux_bin = Some(PathBuf::from(file.tmux_bin));
    }
    if !file.socket_name.is_empty() {
        cfg.socket_name = Some(file.socket_name);
    }
    if !file.socket_path.is_empty() {
        cfg.socket_path = Some(PathBuf::from(file.socket_path));
    }
    if let Some(ms) = file.refresh_ms.filter(|v| *v > 0) {
        cfg.refresh_ms = ms;
    }
    if let Some(ms) = file.preview_ms.filter(|v| *v > 0) {
        cfg.preview_ms = ms;
    }
    if let Some(n) = file.preview_lines.filter(|v| *v > 0) {
        cfg.preview_lines = n;
    }
}

pub fn default_config_path() -> Option<PathBuf> {
    project_dirs().map(|d| d.config_dir().join("config.toml"))
}

pub fn project_dirs() -> Option<ProjectDirs> {
    ProjectDirs::from("", "", "sparkmux")
}
