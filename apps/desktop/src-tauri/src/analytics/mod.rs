//! Analytics coordinator exposing Tauri commands and orchestrating
//! transcript discovery, incremental ingestion, storage, and stat aggregation.

pub mod event;
pub mod ingest;
pub mod prompt_graph;
pub mod stats;
pub mod storage;
mod subagents;

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};
use tauri::command;

use self::event::now_ms;
use self::ingest::{source_id, Cursor};
use self::stats::{compute_stats, TabAnalyticsStats};
use self::storage::{
    append_events, clear_all_analytics, get_storage_stats, is_enabled, load_meta, read_tab_events,
    resume_cursor, save_meta, set_enabled, AnalyticsConfig, TabMeta,
};
use self::subagents::{apply_child_totals, ingest_session};
use crate::artifacts::default_roots;

#[derive(Default)]
struct LiveAnalytics {
    by_key: HashMap<String, Cursor>,
    by_path: HashMap<String, Cursor>,
}

static LIVE: Mutex<Option<LiveAnalytics>> = Mutex::new(None);

fn live_lock() -> MutexGuard<'static, Option<LiveAnalytics>> {
    LIVE.lock().unwrap_or_else(|poison| poison.into_inner())
}

fn fresh_cursor(cursor: &Cursor) -> bool {
    cursor.offset == 0
        && cursor.spawn_offset == 0
        && cursor.children.is_empty()
        && cursor.spawned.is_empty()
}

/// Steps already stored for this tab. A label filled in on the replay (`h`)
/// does not make the same step new.
fn without_recorded(existing: &[event::Event], fresh: Vec<event::Event>) -> Vec<event::Event> {
    let mut left: HashMap<ReplayKey, usize> = HashMap::new();
    for ev in existing {
        *left.entry(ReplayKey::from(ev)).or_default() += 1;
    }
    fresh
        .into_iter()
        .filter(|ev| {
            let key = ReplayKey::from(ev);
            if let Some(n) = left.get_mut(&key) {
                if *n > 0 {
                    *n -= 1;
                    return false;
                }
            }
            true
        })
        .collect()
}

#[derive(Hash, PartialEq, Eq)]
struct ReplayKey {
    t: i64,
    k: String,
    s: String,
    g: String,
    n: String,
    a: String,
    c: u64,
    ms: u64,
    err: bool,
    ti: u64,
    to: u64,
    tc: u64,
    tw: u64,
    tr: u64,
}

impl From<&event::Event> for ReplayKey {
    fn from(ev: &event::Event) -> Self {
        Self {
            t: ev.t,
            k: ev.k.clone(),
            s: ev.s.clone(),
            g: ev.g.clone(),
            n: ev.n.clone(),
            a: ev.a.clone(),
            c: ev.c,
            ms: ev.ms,
            err: ev.err,
            ti: ev.ti,
            to: ev.to,
            tc: ev.tc,
            tw: ev.tw,
            tr: ev.tr,
        }
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
    pub lifetime_stats: Option<TabAnalyticsStats>,
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
        let Some((resolved_kind, resolved_path, roots)) = crate::artifacts::resolve_pane_transcript(
            &command,
            &cwd,
            &title,
            pid,
            &default_roots(),
        ) else {
            return Ok(TabAnalyticsResponse {
                enabled: is_enabled(),
                session_name,
                tab_id,
                cli: None,
                transcript_path: None,
                stats: crate::analytics::stats::TabAnalyticsStats::default(),
                lifetime_stats: Some(crate::analytics::stats::TabAnalyticsStats::default()),
                storage: get_storage_stats(),
            });
        };
        let kind = Some(resolved_kind);
        let transcript = Some(resolved_path);
        let active_src = match (kind, transcript.as_ref()) {
            (Some(k), Some(p)) => Some(source_id(k, p)),
            _ => None,
        };

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

        let cli_str = kind.map(|k| k.as_str().to_string());
        let path_str = transcript
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned());

        // Hold the lock across the read and the write. A purge that runs
        // in between would delete the files and then lose the race to this
        // append, which would put the wiped events straight back.
        let mut guard = live_lock();
        let live = guard.get_or_insert_with(LiveAnalytics::default);
        let mut cursor = live
            .by_key
            .get(&key)
            .cloned()
            .or_else(|| {
                load_meta(&session_name, &tab_id).and_then(|m| {
                    if m.transcript_path.as_deref() == path_str.as_deref() {
                        Some(m.cursor)
                    } else {
                        None
                    }
                })
            })
            .or_else(|| path_str.as_deref().and_then(resume_cursor))
            .unwrap_or_default();

        // Ingest new events if transcript exists and analytics is enabled
        if enabled {
            if let (Some(k), Some(p)) = (kind, &transcript) {
                // The on-disk cursor follows whichever transcript was selected
                // last. After a subagent file stole the pane, that cursor is
                // the child, and a fresh parent read would append the history
                // again. Drop steps this tab already stored.
                let replay = fresh_cursor(&cursor);
                let now = now_ms();
                let mut new_events = ingest_session(k, p, &mut cursor, now, &roots);
                let mut caught_up = false;
                if replay {
                    let existing = read_tab_events(&session_name, &tab_id, 0);
                    if active_src
                        .as_ref()
                        .is_some_and(|src| existing.iter().any(|ev| &ev.s == src))
                    {
                        new_events = without_recorded(&existing, new_events);
                        caught_up = true;
                    }
                }
                if !new_events.is_empty() || caught_up {
                    if !new_events.is_empty() {
                        let _ = append_events(&session_name, &tab_id, &new_events);
                    }
                    let mut meta = load_meta(&session_name, &tab_id).unwrap_or_else(|| TabMeta {
                        session_name: session_name.clone(),
                        tab_id: tab_id.clone(),
                        created_at: now,
                        updated_at: now,
                        cursor: cursor.clone(),
                        total_events: 0,
                        transcript_path: path_str.clone(),
                        source_id: active_src.clone(),
                    });
                    meta.updated_at = now;
                    meta.total_events += new_events.len() as u64;
                    meta.cursor = cursor.clone();
                    meta.transcript_path = path_str.clone();
                    meta.source_id = active_src.clone();
                    let _ = save_meta(&meta);
                }
                if let Some(path) = path_str.clone() {
                    live.by_path.insert(path, cursor.clone());
                }
                live.by_key.insert(key, cursor.clone());
            }
        }

        // Read accumulated events for this session & tab
        let all_events = read_tab_events(&session_name, &tab_id, 0);
        drop(guard);

        // Filter events strictly to the active agent session/conversation if one is active,
        // so metrics are not polluted by prior or other sessions that were run in this tab.
        let events_to_analyze: Vec<event::Event> = if let Some(ref src) = active_src {
            all_events
                .iter()
                .filter(|ev| ev.s == *src)
                .cloned()
                .collect()
        } else {
            all_events.clone()
        };

        let active_model = cursor.model.clone();
        let mut stats = compute_stats(
            &events_to_analyze,
            cursor.ctx_used,
            cursor.ctx_window,
            cursor.ttft_ms,
            cursor.lines_added,
            cursor.lines_removed,
            &active_model,
        );
        apply_child_totals(&mut stats, &cursor);

        let lifetime_stats = if active_src.is_some() && all_events.len() > events_to_analyze.len() {
            let mut lifetime = compute_stats(
                &all_events,
                cursor.ctx_used,
                cursor.ctx_window,
                cursor.ttft_ms,
                cursor.lines_added,
                cursor.lines_removed,
                &active_model,
            );
            apply_child_totals(&mut lifetime, &cursor);
            Some(lifetime)
        } else {
            Some(stats.clone())
        };

        let mut storage = get_storage_stats();
        storage.total_bytes = storage::tab_storage_bytes(&session_name, &tab_id);

        Ok(TabAnalyticsResponse {
            enabled,
            session_name,
            tab_id,
            cli: cli_str,
            transcript_path: path_str,
            stats,
            lifetime_stats,
            storage,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Full event list for one prompt. Read-only: `tab_analytics` already ingests.
#[command]
pub async fn tab_prompt_graph(
    session_name: String,
    tab_id: String,
    turn_index: Option<i64>,
) -> Result<prompt_graph::PromptGraphResponse, String> {
    tokio::task::spawn_blocking(move || {
        // Same lock as `tab_analytics`, so a purge cannot delete the file
        // between this read and an in-flight append.
        let guard = live_lock();
        let events = read_tab_events(&session_name, &tab_id, 0);
        drop(guard);
        Ok(prompt_graph::build(&events, turn_index))
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
    let mut guard = live_lock();
    let live = guard.get_or_insert_with(LiveAnalytics::default);
    let result = clear_all_analytics(live.by_path.clone());
    if result.is_ok() {
        live.by_key.clear();
        live.by_path.clear();
    }
    result
}

#[command]
pub fn analytics_config() -> Result<AnalyticsConfig, String> {
    Ok(get_storage_stats())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(t: i64, kind: &str, source: &str, agent: &str, name: &str) -> event::Event {
        let mut ev = event::Event::new(t, kind);
        ev.s = source.to_string();
        ev.g = agent.to_string();
        ev.n = name.to_string();
        ev
    }

    #[test]
    fn replay_keeps_a_new_subagent_step_and_drops_the_copy() {
        let child = "22222222-2222-4222-8222-222222222222";
        let stored = vec![
            ev(10, "tool", "11111111", "", "read_file"),
            ev(20, "tool", "11111111", child, "run_command"),
        ];
        let mut again = stored[1].clone();
        again.h = "Spark Model".to_string();
        let mut later = ev(30, "usage", "11111111", child, "");
        later.ti = 40;
        let kept = without_recorded(&stored, vec![stored[0].clone(), again, later.clone()]);
        assert_eq!(kept, vec![later]);
    }
}
