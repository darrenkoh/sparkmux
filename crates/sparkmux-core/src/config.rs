use std::fs;
use std::path::PathBuf;

use directories::ProjectDirs;
use serde::Deserialize;

use crate::SOCKET_NAME;

#[derive(Debug, Clone)]
pub struct Config {
    pub tmux_bin: Option<PathBuf>,
    pub socket_name: Option<String>,
    pub socket_path: Option<PathBuf>,
    pub refresh_ms: u64,
    pub default_session: String,
    pub last_session: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            tmux_bin: None,
            socket_name: Some(SOCKET_NAME.to_string()),
            socket_path: None,
            refresh_ms: 1000,
            default_session: crate::DEFAULT_SESSION.to_string(),
            last_session: None,
        }
    }
}

#[derive(Debug, Default, Clone)]
pub struct ConfigOverrides {
    pub tmux_bin: Option<PathBuf>,
    pub socket_name: Option<String>,
    pub socket_path: Option<PathBuf>,
    pub config_path: Option<PathBuf>,
    pub system: bool,
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
    default_session: Option<String>,
    last_session: Option<String>,
}

pub fn load(overrides: ConfigOverrides) -> (Config, Option<String>) {
    let mut cfg = Config::default();
    let mut warning = None;
    let path = overrides.config_path.clone().or_else(default_config_path);
    if let Some(path) = path {
        match fs::read_to_string(&path) {
            Ok(text) => match toml::from_str::<FileConfig>(&text) {
                Ok(file) => apply_file(&mut cfg, file),
                Err(e) => {
                    warning = Some(format!(
                        "invalid config {}, using defaults: {e}",
                        path.display()
                    ));
                }
            },
            Err(e)
                if e.kind() == std::io::ErrorKind::NotFound && overrides.config_path.is_none() => {}
            Err(e) => {
                warning = Some(format!(
                    "could not read config {}, using defaults: {e}",
                    path.display()
                ));
            }
        }
    }
    apply_env(&mut cfg);
    if let Some(bin) = overrides.tmux_bin {
        cfg.tmux_bin = Some(bin);
    }
    if overrides.system {
        cfg.socket_name = Some("default".into());
        cfg.socket_path = None;
    }
    if let Some(name) = overrides.socket_name {
        cfg.socket_name = Some(name);
        cfg.socket_path = None;
    }
    if let Some(path) = overrides.socket_path {
        cfg.socket_path = Some(path);
        cfg.socket_name = None;
    }
    (cfg, warning)
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
    if let Some(name) = file.default_session.filter(|s| !s.is_empty()) {
        cfg.default_session = name;
    }
    if let Some(name) = file.last_session.filter(|s| !s.is_empty()) {
        cfg.last_session = Some(name);
    }
}

fn apply_env(cfg: &mut Config) {
    if let Ok(bin) = std::env::var("SPARKMUX_TMUX") {
        if !bin.is_empty() {
            cfg.tmux_bin = Some(PathBuf::from(bin));
        }
    }
}

pub fn default_config_path() -> Option<PathBuf> {
    project_dirs().map(|d| d.config_dir().join("config.toml"))
}

pub fn project_dirs() -> Option<ProjectDirs> {
    ProjectDirs::from("", "", "sparkmux")
}

pub fn gui_spawn_env() -> crate::client::SessionSpawn {
    let home = directories::BaseDirs::new()
        .map(|b| b.home_dir().to_path_buf())
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("/"));
    let extras = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
    let path = match std::env::var("PATH") {
        Ok(p) if !p.is_empty() => format!("{p}:{extras}"),
        _ => extras.to_string(),
    };
    let mut env = vec![
        ("PATH".into(), path),
        ("HOME".into(), home.display().to_string()),
    ];
    if let Ok(sock) = std::env::var("SSH_AUTH_SOCK") {
        if !sock.is_empty() {
            env.push(("SSH_AUTH_SOCK".into(), sock));
        }
    }
    crate::client::SessionSpawn { cwd: home, env }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_file_ignores_empty_and_zero() {
        let mut cfg = Config::default();
        apply_file(
            &mut cfg,
            FileConfig {
                tmux_bin: String::new(),
                socket_name: String::new(),
                socket_path: String::new(),
                refresh_ms: Some(0),
                default_session: None,
                last_session: None,
            },
        );
        assert!(cfg.tmux_bin.is_none());
        assert_eq!(cfg.socket_name.as_deref(), Some(SOCKET_NAME));
        assert_eq!(cfg.refresh_ms, 1000);
        assert_eq!(cfg.default_session, "main");
    }

    #[test]
    fn apply_file_positive_overrides() {
        let mut cfg = Config::default();
        apply_file(
            &mut cfg,
            FileConfig {
                tmux_bin: "/usr/bin/tmux".into(),
                socket_name: "other".into(),
                socket_path: String::new(),
                refresh_ms: Some(2500),
                default_session: Some("work".into()),
                last_session: Some("play".into()),
            },
        );
        assert_eq!(
            cfg.tmux_bin.as_deref(),
            Some(std::path::Path::new("/usr/bin/tmux"))
        );
        assert_eq!(cfg.socket_name.as_deref(), Some("other"));
        assert_eq!(cfg.refresh_ms, 2500);
        assert_eq!(cfg.default_session, "work");
        assert_eq!(cfg.last_session.as_deref(), Some("play"));
    }

    #[test]
    fn system_override_uses_default_socket() {
        let (cfg, _) = load(ConfigOverrides {
            system: true,
            ..ConfigOverrides::default()
        });
        assert_eq!(cfg.socket_name.as_deref(), Some("default"));
        assert!(cfg.socket_path.is_none());
    }
}
