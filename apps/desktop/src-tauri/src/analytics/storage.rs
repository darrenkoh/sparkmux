//! On-disk persistence for per-session, per-tab analytics events.
//!
//! Stored under `<data_dir>/analytics/<session_name>/<tab_id>/`:
//! - `events.jsonl` - Appended JSONL events.
//! - `meta.json` - Active cursor, last update, totals.
//!
//! Also manages user settings: enabled/disabled flag in analytics.json,
//! disk space calculation, and wiping all persisted analytics data.
//! A wipe keeps each transcript's read cursor in `analytics-cursors.json`
//! (next to the config, outside the wiped directory) so the same bytes
//! are not imported again.

use std::collections::HashMap;
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
    #[serde(default)]
    pub transcript_path: Option<String>,
    #[serde(default)]
    pub source_id: Option<String>,
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

#[cfg(test)]
static ANALYTICS_ROOT_OVERRIDE: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Tests point tab storage at a temp directory so a `tab_analytics` call does
/// not write the user's sparkmux analytics directory.
#[cfg(test)]
pub(super) fn set_analytics_root_override(root: Option<PathBuf>) {
    *ANALYTICS_ROOT_OVERRIDE
        .lock()
        .unwrap_or_else(|poison| poison.into_inner()) = root;
    if let Ok(mut cache) = STORAGE_CACHE.lock() {
        *cache = None;
    }
}

fn analytics_root() -> Option<PathBuf> {
    #[cfg(test)]
    {
        if let Some(root) = ANALYTICS_ROOT_OVERRIDE
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
        {
            return Some(root);
        }
    }
    directories::ProjectDirs::from("", "", "sparkmux").map(|dirs| dirs.data_dir().join("analytics"))
}

/// Read cursors that survive a wipe. This file lives beside the config,
/// not inside the analytics directory that purge deletes.
fn resume_path() -> Option<PathBuf> {
    directories::ProjectDirs::from("", "", "sparkmux")
        .map(|dirs| dirs.config_dir().join("analytics-cursors.json"))
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
        for ev in serde_json::Deserializer::from_str(&line)
            .into_iter::<Event>()
            .flatten()
        {
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

use std::sync::Mutex;
use std::time::Instant;

static STORAGE_CACHE: Mutex<Option<(Instant, AnalyticsConfig)>> = Mutex::new(None);

pub fn get_storage_stats() -> AnalyticsConfig {
    let mut cache = STORAGE_CACHE
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    if let Some((at, ref conf)) = *cache {
        if at.elapsed().as_secs() < 30 {
            return conf.clone();
        }
    }
    let stats = compute_storage_stats();
    *cache = Some((Instant::now(), stats.clone()));
    stats
}

fn compute_storage_stats() -> AnalyticsConfig {
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

pub fn tab_storage_bytes(session_name: &str, tab_id: &str) -> u64 {
    tab_dir(session_name, tab_id)
        .map(|dir| dir_size(&dir))
        .unwrap_or(0)
}

/// How far a cursor has read, then how many lines it has counted.
/// A later purge must not replace a further cursor with an older one.
/// At the same file position, the cursor that counted more lines wins so
/// the baseline is not stuck on a stale total.
fn cursor_rank(cursor: &Cursor) -> (u64, u64) {
    let read = cursor
        .offset
        .saturating_add(cursor.ev_offset)
        .saturating_add(cursor.updates_offset)
        .saturating_add(cursor.usage_turns as u64)
        .saturating_add(cursor.tools_ev)
        .saturating_add(cursor.tools_chat)
        .saturating_add(cursor.turns_ev)
        .saturating_add(cursor.turns_chat);
    let lines = cursor
        .lines_base_added
        .saturating_add(cursor.lines_added)
        .saturating_add(cursor.lines_base_removed)
        .saturating_add(cursor.lines_removed);
    (read, lines)
}

pub fn merge_resume(map: &mut HashMap<String, Cursor>, path: &str, cursor: Cursor) {
    if path.is_empty() {
        return;
    }
    match map.get(path) {
        Some(prev) if cursor_rank(prev) >= cursor_rank(&cursor) => {}
        _ => {
            map.insert(path.to_string(), cursor);
        }
    }
}

fn read_resume_at(path: &Path) -> HashMap<String, Cursor> {
    let Ok(file) = File::open(path) else {
        return HashMap::new();
    };
    serde_json::from_reader(file).unwrap_or_default()
}

fn write_resume_at(path: &Path, map: &HashMap<String, Cursor>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let file = File::create(path).map_err(|e| e.to_string())?;
    serde_json::to_writer_pretty(file, map).map_err(|e| e.to_string())
}

fn cursors_in(root: &Path) -> HashMap<String, Cursor> {
    let mut out = HashMap::new();
    let Ok(sessions) = fs::read_dir(root) else {
        return out;
    };
    for session in sessions.flatten() {
        if !session.path().is_dir() {
            continue;
        }
        let Ok(tabs) = fs::read_dir(session.path()) else {
            continue;
        };
        for tab in tabs.flatten() {
            if !tab.path().is_dir() {
                continue;
            }
            let Ok(file) = File::open(tab.path().join("meta.json")) else {
                continue;
            };
            let Ok(meta) = serde_json::from_reader::<_, TabMeta>(file) else {
                continue;
            };
            let Some(path) = meta.transcript_path.filter(|p| !p.is_empty()) else {
                continue;
            };
            merge_resume(&mut out, &path, meta.cursor);
        }
    }
    out
}

/// Cursor to resume from after a purge, keyed by transcript path.
pub fn resume_cursor(transcript_path: &str) -> Option<Cursor> {
    if transcript_path.is_empty() {
        return None;
    }
    let path = resume_path()?;
    read_resume_at(&path).get(transcript_path).cloned()
}

/// Delete saved events. `live` is the in-memory cursor for each open
/// transcript. Those positions are kept so the next poll does not read
/// the transcript from byte 0 and refill the HUD.
pub fn clear_all_analytics(live: HashMap<String, Cursor>) -> Result<(), String> {
    let root = analytics_root().ok_or_else(|| "no analytics root".to_string())?;
    let resume = resume_path().ok_or_else(|| "no analytics root".to_string())?;
    clear_analytics_at(&root, &resume, live)
}

fn clear_analytics_at(
    root: &Path,
    resume_file: &Path,
    live: HashMap<String, Cursor>,
) -> Result<(), String> {
    let mut resumed = read_resume_at(resume_file);
    for (path, mut cursor) in cursors_in(root) {
        cursor.mark_purged();
        merge_resume(&mut resumed, &path, cursor);
    }
    for (path, mut cursor) in live {
        cursor.mark_purged();
        merge_resume(&mut resumed, &path, cursor);
    }
    write_resume_at(resume_file, &resumed)?;
    if root.exists() {
        fs::remove_dir_all(root).map_err(|e| e.to_string())?;
    }
    let _ = fs::create_dir_all(root);
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

    #[test]
    fn purge_keeps_the_transcript_cursor_and_deletes_events() {
        let temp = std::env::temp_dir().join(format!("sparkmux_test_purge_{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp);
        let root = temp.join("analytics");
        let tab = root.join("sess").join("tab");
        fs::create_dir_all(&tab).unwrap();
        fs::write(tab.join("events.jsonl"), "{\"k\":\"user\"}\n").unwrap();

        let mut cursor = Cursor::default();
        cursor.offset = 120;
        cursor.ev_offset = 30;
        cursor.lines_added = 4;
        cursor.lines_removed = 1;
        let meta = TabMeta {
            session_name: "sess".into(),
            tab_id: "tab".into(),
            created_at: 1,
            updated_at: 2,
            cursor,
            total_events: 3,
            transcript_path: Some("/tmp/chat.jsonl".into()),
            source_id: Some("abcd".into()),
        };
        serde_json::to_writer_pretty(File::create(tab.join("meta.json")).unwrap(), &meta).unwrap();

        let resume = temp.join("analytics-cursors.json");
        clear_analytics_at(&root, &resume, HashMap::new()).unwrap();

        assert!(!tab.join("events.jsonl").exists());
        assert!(!tab.join("meta.json").exists());
        let saved = read_resume_at(&resume);
        let kept = saved.get("/tmp/chat.jsonl").unwrap();
        assert_eq!(kept.offset, 120);
        assert_eq!(kept.ev_offset, 30);
        assert_eq!(kept.lines_added, 0);
        assert_eq!(kept.lines_removed, 0);
        assert_eq!(kept.lines_base_added, 4);
        assert_eq!(kept.lines_base_removed, 1);
        assert!(kept.lines_tracked);

        let mut later = Cursor::default();
        later.offset = 200;
        later.ev_offset = 30;
        later.lines_base_added = 4;
        later.lines_added = 2;
        let mut live = HashMap::new();
        live.insert("/tmp/chat.jsonl".into(), later);
        live.insert(String::new(), Cursor::default());
        clear_analytics_at(&root, &resume, live).unwrap();
        let saved = read_resume_at(&resume);
        let kept = saved.get("/tmp/chat.jsonl").unwrap();
        assert_eq!(kept.offset, 200);
        assert_eq!(kept.lines_added, 0);
        assert_eq!(kept.lines_base_added, 6);
        assert!(!saved.contains_key(""));

        // Same file position, but a newer line total, must advance the baseline.
        let mut same = Cursor::default();
        same.offset = 200;
        same.ev_offset = 30;
        same.lines_base_added = 6;
        same.lines_added = 5;
        let mut live = HashMap::new();
        live.insert("/tmp/chat.jsonl".into(), same);
        clear_analytics_at(&root, &resume, live).unwrap();
        let saved = read_resume_at(&resume);
        let kept = saved.get("/tmp/chat.jsonl").unwrap();
        assert_eq!(kept.offset, 200);
        assert_eq!(kept.lines_added, 0);
        assert_eq!(kept.lines_base_added, 11);

        let _ = fs::remove_dir_all(&temp);
    }
}
