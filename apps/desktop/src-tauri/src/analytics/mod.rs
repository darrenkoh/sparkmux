//! Analytics coordinator exposing Tauri commands and orchestrating
//! transcript discovery, incremental ingestion, storage, and stat aggregation.

pub mod event;
pub mod ingest;
pub mod stats;
pub mod storage;

use std::collections::HashMap;
use std::sync::Mutex;
use tauri::command;

use self::event::now_ms;
use self::ingest::{ingest, Cursor};
use self::stats::{compute_stats, TabAnalyticsStats};
use self::storage::{
    append_events, clear_all_analytics, get_storage_stats, is_enabled, load_meta, read_tab_events,
    save_meta, set_enabled, AnalyticsConfig, TabMeta,
};
use crate::artifacts::{cli_kind, default_roots, pane_family, select_transcript};

static ACTIVE_CURSORS: Mutex<Option<HashMap<String, Cursor>>> = Mutex::new(None);

fn get_active_cursor(key: &str) -> Option<Cursor> {
    let mut lock = ACTIVE_CURSORS.lock().ok()?;
    let map = lock.get_or_insert_with(HashMap::new);
    map.get(key).cloned()
}

fn set_active_cursor(key: &str, cursor: Cursor) {
    if let Ok(mut lock) = ACTIVE_CURSORS.lock() {
        let map = lock.get_or_insert_with(HashMap::new);
        map.insert(key.to_string(), cursor);
    }
}

#[derive(serde::Serialize, serde::Deserialize, Debug)]
pub struct TabAnalyticsResponse {
    pub enabled: bool,
    pub session_name: String,
    pub tab_id: String,
    pub cli: Option<String>,
    pub transcript_path: Option<String>,
    pub stats: TabAnalyticsStats,
    pub storage: AnalyticsConfig,
}

#[command]
pub async fn tab_analytics(
    session_name: String,
    tab_id: String,
    command: String,
    cwd: String,
    title: String,
    pid: u32,
) -> Result<TabAnalyticsResponse, String> {
    tokio::task::spawn_blocking(move || {
        let roots = default_roots();
        let family = pane_family(pid);
        let kind = cli_kind(&command).or_else(|| cli_kind(&title));

        let transcript = kind.and_then(|k| select_transcript(k, &cwd, &title, &family, &roots));

        let enabled = is_enabled();
        let key = format!(
            "{}:{}:{}",
            session_name,
            tab_id,
            transcript
                .as_ref()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default()
        );

        let mut cursor = get_active_cursor(&key)
            .or_else(|| load_meta(&session_name, &tab_id).map(|m| m.cursor))
            .unwrap_or_default();

        let cli_str = kind.map(|k| k.as_str().to_string());
        let path_str = transcript
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned());

        // Ingest new events if transcript exists and analytics is enabled
        if enabled {
            if let (Some(k), Some(p)) = (kind, &transcript) {
                let now = now_ms();
                let new_events = ingest(k, p, &mut cursor, now);
                if !new_events.is_empty() {
                    let _ = append_events(&session_name, &tab_id, &new_events);
                    let mut meta = load_meta(&session_name, &tab_id).unwrap_or_else(|| TabMeta {
                        session_name: session_name.clone(),
                        tab_id: tab_id.clone(),
                        created_at: now,
                        updated_at: now,
                        cursor: cursor.clone(),
                        total_events: 0,
                    });
                    meta.updated_at = now;
                    meta.total_events += new_events.len() as u64;
                    meta.cursor = cursor.clone();
                    let _ = save_meta(&meta);
                }
                set_active_cursor(&key, cursor.clone());
            }
        }

        // Read all accumulated events for this session & tab
        let all_events = read_tab_events(&session_name, &tab_id, 0);

        let active_model = cursor.model.clone();
        let stats = compute_stats(
            &all_events,
            cursor.ctx_used,
            cursor.ctx_window,
            cursor.ttft_ms,
            cursor.lines_added,
            cursor.lines_removed,
            &active_model,
        );

        let storage = get_storage_stats();

        Ok(TabAnalyticsResponse {
            enabled,
            session_name,
            tab_id,
            cli: cli_str,
            transcript_path: path_str,
            stats,
            storage,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[command]
pub fn set_analytics_enabled(enabled: bool) -> Result<(), String> {
    set_enabled(enabled);
    Ok(())
}

#[command]
pub fn clear_analytics_data() -> Result<(), String> {
    if let Ok(mut lock) = ACTIVE_CURSORS.lock() {
        if let Some(map) = lock.as_mut() {
            map.clear();
        }
    }
    clear_all_analytics()
}

#[command]
pub fn analytics_config() -> Result<AnalyticsConfig, String> {
    Ok(get_storage_stats())
}
