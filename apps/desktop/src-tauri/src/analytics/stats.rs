//! Aggregates raw analytics events into high-level metrics and statistics
//! tailored for the Sci-Fi HUD dashboard.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::event::{Event, DONE, REPLY, RESULT, THINK, TOOL, TURN, USAGE, USER};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ActivityPoint {
    pub timestamp: i64,
    pub user_count: u32,
    pub think_count: u32,
    pub reply_count: u32,
    pub tool_count: u32,
    pub tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ToolStat {
    pub name: String,
    pub calls: u64,
    pub errors: u64,
    pub avg_duration_ms: u64,
    pub max_duration_ms: u64,
    pub last_used: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModelStat {
    pub model: String,
    pub calls: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub reasoning_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TabAnalyticsStats {
    pub total_events: u64,
    pub user_prompts: u64,
    pub thinking_blocks: u64,
    pub assistant_replies: u64,
    pub tool_calls: u64,
    pub tool_results: u64,
    pub tool_errors: u64,

    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_cache_read_tokens: u64,
    pub total_cache_write_tokens: u64,
    pub total_reasoning_tokens: u64,

    pub avg_turn_duration_ms: u64,
    pub max_turn_duration_ms: u64,
    pub total_turn_duration_ms: u64,
    pub turn_count: u64,

    pub context_tokens_used: u64,
    pub context_window_tokens: u64,
    pub ttft_ms: u64,
    pub lines_added: u64,
    pub lines_removed: u64,

    pub active_model: String,
    pub tools: Vec<ToolStat>,
    pub models: Vec<ModelStat>,
    /// Activity timeline buckets (10 to 30 buckets)
    pub timeline: Vec<ActivityPoint>,
    /// Recent log entries for HUD stream
    pub recent_events: Vec<Event>,
}

pub fn compute_stats(
    events: &[Event],
    cur_ctx_used: u64,
    cur_ctx_win: u64,
    ttft: u64,
    added: u64,
    removed: u64,
    active_model: &str,
) -> TabAnalyticsStats {
    let mut stats = TabAnalyticsStats {
        total_events: events.len() as u64,
        context_tokens_used: cur_ctx_used,
        context_window_tokens: cur_ctx_win,
        ttft_ms: ttft,
        lines_added: added,
        lines_removed: removed,
        active_model: active_model.to_string(),
        ..Default::default()
    };

    if events.is_empty() {
        return stats;
    }

    let mut tool_map: HashMap<String, (u64, u64, u64, u64, i64)> = HashMap::new(); // calls, errors, sum_dur, max_dur, last_ts
    let mut model_map: HashMap<String, ModelStat> = HashMap::new();

    let mut turn_durations = Vec::new();

    // Find time bounds for timeline binning
    let start_t = events.first().map(|e| e.t).unwrap_or(0);
    let end_t = events.last().map(|e| e.t).unwrap_or(0);
    let time_span = (end_t - start_t).max(1);

    // Choose bucket size, max 24 buckets
    let num_buckets = 24;
    let bucket_ms = (time_span / num_buckets as i64).max(1000);
    let mut buckets: Vec<ActivityPoint> = (0..num_buckets)
        .map(|i| ActivityPoint {
            timestamp: start_t + (i as i64 * bucket_ms),
            ..Default::default()
        })
        .collect();

    for ev in events {
        // Bin into timeline
        let b_idx = if time_span > 0 {
            let idx = ((ev.t - start_t) / bucket_ms) as usize;
            idx.min(num_buckets - 1)
        } else {
            0
        };

        match ev.k.as_str() {
            USER => {
                stats.user_prompts += 1;
                buckets[b_idx].user_count += 1;
            }
            THINK => {
                stats.thinking_blocks += 1;
                buckets[b_idx].think_count += 1;
            }
            REPLY => {
                stats.assistant_replies += 1;
                buckets[b_idx].reply_count += 1;
                if !ev.n.is_empty() && stats.active_model.is_empty() {
                    stats.active_model.clone_from(&ev.n);
                }
            }
            TOOL => {
                stats.tool_calls += 1;
                buckets[b_idx].tool_count += 1;
                let entry = tool_map.entry(ev.n.clone()).or_insert((0, 0, 0, 0, ev.t));
                entry.0 += 1;
                entry.4 = entry.4.max(ev.t);
            }
            RESULT => {
                stats.tool_results += 1;
                if ev.err {
                    stats.tool_errors += 1;
                }
            }
            DONE => {
                let entry = tool_map.entry(ev.n.clone()).or_insert((0, 0, 0, 0, ev.t));
                if ev.err {
                    entry.1 += 1;
                }
                entry.2 += ev.ms;
                entry.3 = entry.3.max(ev.ms);
                entry.4 = entry.4.max(ev.t);
            }
            USAGE => {
                let m = if ev.n.is_empty() {
                    "default".to_string()
                } else {
                    ev.n.clone()
                };
                let m_stat = model_map.entry(m.clone()).or_insert_with(|| ModelStat {
                    model: m,
                    ..Default::default()
                });
                m_stat.calls += ev.c.max(1);
                m_stat.input_tokens += ev.ti;
                m_stat.output_tokens += ev.to;
                m_stat.cache_read_tokens += ev.tc;
                m_stat.reasoning_tokens += ev.tr;

                stats.total_input_tokens += ev.ti;
                stats.total_output_tokens += ev.to;
                stats.total_cache_read_tokens += ev.tc;
                stats.total_cache_write_tokens += ev.tw;
                stats.total_reasoning_tokens += ev.tr;

                buckets[b_idx].tokens += ev.ti + ev.to;
            }
            TURN => {
                stats.turn_count += 1;
                if ev.ms > 0 {
                    turn_durations.push(ev.ms);
                    stats.total_turn_duration_ms += ev.ms;
                    stats.max_turn_duration_ms = stats.max_turn_duration_ms.max(ev.ms);
                }
            }
            _ => {}
        }
    }

    if !turn_durations.is_empty() {
        stats.avg_turn_duration_ms = stats.total_turn_duration_ms / turn_durations.len() as u64;
    }

    let mut tools: Vec<ToolStat> = tool_map
        .into_iter()
        .map(|(name, (calls, errors, sum_dur, max_dur, last_ts))| {
            let avg = sum_dur.checked_div(calls).unwrap_or(0);
            ToolStat {
                name,
                calls,
                errors,
                avg_duration_ms: avg,
                max_duration_ms: max_dur,
                last_used: last_ts,
            }
        })
        .collect();
    tools.sort_by_key(|a| std::cmp::Reverse(a.calls));
    stats.tools = tools;

    let mut models: Vec<ModelStat> = model_map.into_values().collect();
    models.sort_by_key(|a| std::cmp::Reverse(a.input_tokens + a.output_tokens));
    stats.models = models;

    stats.timeline = buckets;

    // Last 60 events for HUD terminal log
    let tail_len = events.len().min(60);
    stats.recent_events = events[events.len() - tail_len..].to_vec();

    stats
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compute_stats() {
        let mut ev1 = Event::new(1000, USER);
        ev1.b = "List files".into();
        let mut ev2 = Event::new(2000, TOOL);
        ev2.n = "ls".into();
        let mut ev3 = Event::new(2100, DONE);
        ev3.n = "ls".into();
        ev3.ms = 100;
        let mut ev4 = Event::new(3000, USAGE);
        ev4.n = "claude-3".into();
        ev4.ti = 500;
        ev4.to = 100;

        let events = vec![ev1, ev2, ev3, ev4];
        let stats = compute_stats(&events, 500, 200000, 120, 10, 2, "claude-3");

        assert_eq!(stats.user_prompts, 1);
        assert_eq!(stats.tool_calls, 1);
        assert_eq!(stats.total_input_tokens, 500);
        assert_eq!(stats.total_output_tokens, 100);
        assert_eq!(stats.tools.len(), 1);
        assert_eq!(stats.tools[0].name, "ls");
        assert_eq!(stats.tools[0].avg_duration_ms, 100);
        assert_eq!(stats.active_model, "claude-3");
    }
}
