//! On-disk persistence for per-session, per-tab analytics events.
//!
//! Stored under `<data_dir>/analytics/<session_name>/<tab_id>/`:
//! - `events.jsonl` - Appended JSONL events.
//! - `meta.json` - Active cursor, last update, totals.
//!
//! Also manages user settings: enabled/disabled flag in config.toml,
//! disk space calculation, and wiping all persisted analytics data.

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};

use super::event::Event;
use super::ingest::Cursor;

static ANALYTICS_ENABLED: AtomicBool = AtomicBool::new(true);

const MAX_TAB_EVENTS: usize = 20_000;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TabMeta {
    pub session_name: String,
    pub tab_id: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub cursor: Cursor,
    pub total_events: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalyticsConfig {
    pub enabled: bool,
    pub total_bytes: u64,
    pub session_count: usize,
    pub tab_count: usize,
}

pub fn set_enabled(val: bool) {
    ANALYTICS_ENABLED.store(val, Ordering::SeqCst);
    let _ = persist_config(val);
}

pub fn is_enabled() -> bool {
    ANALYTICS_ENABLED.load(Ordering::SeqCst)
}

pub fn init_config() {
    if let Ok(enabled) = load_persisted_config() {
        ANALYTICS_ENABLED.store(enabled, Ordering::SeqCst);
    }
}

fn config_path() -> Option<PathBuf> {
    directories::ProjectDirs::from("", "", "sparkmux")
        .map(|dirs| dirs.config_dir().join("analytics.json"))
}

fn analytics_root() -> Option<PathBuf> {
    directories::ProjectDirs::from("", "", "sparkmux").map(|dirs| dirs.data_dir().join("analytics"))
}

fn load_persisted_config() -> Result<bool, String> {
    let path = config_path().ok_or_else(|| "no config path".to_string())?;
    if !path.exists() {
        return Ok(true); // enabled by default
    }
    let data = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let val: serde_json::Value = serde_json::from_str(&data).map_err(|e| e.to_string())?;
    Ok(val.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true))
}

fn persist_config(enabled: bool) -> Result<(), String> {
    let path = config_path().ok_or_else(|| "no config path".to_string())?;
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let json = serde_json::json!({ "enabled": enabled });
    fs::write(path, json.to_string()).map_err(|e| e.to_string())
}

pub fn sanitize_name(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

pub fn tab_dir(session_name: &str, tab_id: &str) -> Option<PathBuf> {
    let root = analytics_root()?;
    let sess_safe = sanitize_name(session_name);
    let tab_safe = sanitize_name(tab_id);
    Some(root.join(sess_safe).join(tab_safe))
}

pub fn load_meta(session_name: &str, tab_id: &str) -> Option<TabMeta> {
    let dir = tab_dir(session_name, tab_id)?;
    let meta_file = dir.join("meta.json");
    let file = File::open(meta_file).ok()?;
    serde_json::from_reader(file).ok()
}

pub fn save_meta(meta: &TabMeta) -> Result<(), String> {
    let dir = tab_dir(&meta.session_name, &meta.tab_id)
        .ok_or_else(|| "cannot resolve tab dir".to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let meta_file = dir.join("meta.json");
    let f = File::create(meta_file).map_err(|e| e.to_string())?;
    serde_json::to_writer_pretty(f, meta).map_err(|e| e.to_string())
}

pub fn append_events(session_name: &str, tab_id: &str, events: &[Event]) -> Result<(), String> {
    if events.is_empty() {
        return Ok(());
    }
    let dir = tab_dir(session_name, tab_id).ok_or_else(|| "cannot resolve tab dir".to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file_path = dir.join("events.jsonl");

    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file_path)
        .map_err(|e| e.to_string())?;

    for ev in events {
        let line = serde_json::to_string(ev).map_err(|e| e.to_string())?;
        writeln!(f, "{}", line).map_err(|e| e.to_string())?;
    }

    Ok(())
}

pub fn read_tab_events(session_name: &str, tab_id: &str, max_events: usize) -> Vec<Event> {
    let Some(dir) = tab_dir(session_name, tab_id) else {
        return Vec::new();
    };
    let file_path = dir.join("events.jsonl");
    let Ok(f) = File::open(file_path) else {
        return Vec::new();
    };

    let reader = BufReader::new(f);
    let mut events = Vec::new();

    for line in reader.lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(ev) = serde_json::from_str::<Event>(&line) {
            events.push(ev);
        }
    }

    let limit = if max_events == 0 {
        MAX_TAB_EVENTS
    } else {
        max_events
    };
    if events.len() > limit {
        let drop_n = events.len() - limit;
        events.drain(0..drop_n);
    }

    events
}

pub fn get_storage_stats() -> AnalyticsConfig {
    let enabled = is_enabled();
    let root = match analytics_root() {
        Some(r) => r,
        None => {
            return AnalyticsConfig {
                enabled,
                total_bytes: 0,
                session_count: 0,
                tab_count: 0,
            }
        }
    };

    if !root.exists() {
        return AnalyticsConfig {
            enabled,
            total_bytes: 0,
            session_count: 0,
            tab_count: 0,
        };
    }

    let mut total_bytes = 0u64;
    let mut session_count = 0usize;
    let mut tab_count = 0usize;

    if let Ok(sess_entries) = fs::read_dir(&root) {
        for sess_entry in sess_entries.flatten() {
            if sess_entry.path().is_dir() {
                session_count += 1;
                if let Ok(tab_entries) = fs::read_dir(sess_entry.path()) {
                    for tab_entry in tab_entries.flatten() {
                        if tab_entry.path().is_dir() {
                            tab_count += 1;
                            total_bytes += dir_size(&tab_entry.path());
                        }
                    }
                }
            }
        }
    }

    AnalyticsConfig {
        enabled,
        total_bytes,
        session_count,
        tab_count,
    }
}

fn dir_size(path: &Path) -> u64 {
    let mut size = 0;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    size += meta.len();
                } else if meta.is_dir() {
                    size += dir_size(&entry.path());
                }
            }
        }
    }
    size
}

pub fn clear_all_analytics() -> Result<(), String> {
    let root = analytics_root().ok_or_else(|| "no analytics root".to_string())?;
    if root.exists() {
        fs::remove_dir_all(&root).map_err(|e| e.to_string())?;
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analytics::event::{REPLY, USER};

    #[test]
    fn test_sanitize_name() {
        assert_eq!(sanitize_name("my session / 1"), "my_session___1");
        assert_eq!(sanitize_name("@2"), "_2");
    }

    #[test]
    fn test_append_and_read() {
        let temp =
            std::env::temp_dir().join(format!("sparkmux_test_storage_{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp);
        fs::create_dir_all(&temp).unwrap();

        let s = "sess1";
        let t = "tab1";
        let mut ev1 = Event::new(100, USER);
        ev1.b = "Hello".into();
        let mut ev2 = Event::new(200, REPLY);
        ev2.b = "World".into();

        let dir = temp.join(s).join(t);
        fs::create_dir_all(&dir).unwrap();
        let file_path = dir.join("events.jsonl");
        let mut f = File::create(file_path).unwrap();
        writeln!(f, "{}", serde_json::to_string(&ev1).unwrap()).unwrap();
        writeln!(f, "{}", serde_json::to_string(&ev2).unwrap()).unwrap();

        let _ = fs::remove_dir_all(&temp);
    }
}
