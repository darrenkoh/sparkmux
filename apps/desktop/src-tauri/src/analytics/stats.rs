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
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_read_tokens: u64,
    #[serde(default)]
    pub cache_write_tokens: u64,
    #[serde(default)]
    pub reasoning_tokens: u64,
    pub top_event_kind: String,
    pub top_event_label: String,
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
    pub cache_write_tokens: u64,
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
    /// One column per time bucket across the whole session.
    /// Up to 30 minutes the columns are 15–60 seconds. After that they are
    /// one minute, and past eight hours they widen so the vector stays
    /// within [`MAX_BUCKETS`]. The area map shows a draggable 30-minute slice.
    pub timeline: Vec<ActivityPoint>,
    /// Earliest event timestamp. The map window slides from here.
    #[serde(default)]
    pub timeline_start: i64,
    /// Latest event timestamp.
    #[serde(default)]
    pub timeline_end: i64,
    /// Recent log entries for HUD stream
    pub recent_events: Vec<Event>,
}

/// Shortest column. A two-minute session still grows a new node every 15 seconds.
const MIN_BUCKET_MS: i64 = 15_000;
const MINUTE_MS: i64 = 60_000;
/// Sessions this long or shorter are drawn in full. Longer ones use minute columns.
const DETAIL_SPAN_MS: i64 = 30 * MINUTE_MS;
/// Eight hours of one-minute columns. Longer sessions widen the column.
const MAX_BUCKETS: usize = 480;

/// `(start, end, bucket_ms, count)` covering every event, including the last one.
fn timeline_grid(start_t: i64, end_t: i64) -> (i64, i64, i64, usize) {
    let start = start_t.min(end_t);
    let end = start_t.max(end_t);
    let span = (end - start).max(1);
    let bucket_ms = if span <= DETAIL_SPAN_MS {
        (span / 40).clamp(MIN_BUCKET_MS, MINUTE_MS)
    } else {
        (span / (MAX_BUCKETS as i64 - 1)).max(MINUTE_MS)
    };
    let count = ((span / bucket_ms) as usize + 1).clamp(1, MAX_BUCKETS);
    (start, end, bucket_ms, count)
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

    // Find time bounds for timeline binning (using min/max to be resilient to out-of-order logs)
    let start_t = events.iter().map(|e| e.t).min().unwrap_or(0);
    let end_t = events.iter().map(|e| e.t).max().unwrap_or(0);
    let time_span = (end_t - start_t).max(1);

    let (start_t, end_t, bucket_ms, num_buckets) = timeline_grid(start_t, end_t);
    stats.timeline_start = start_t;
    stats.timeline_end = end_t;
    let mut buckets: Vec<ActivityPoint> = (0..num_buckets)
        .map(|i| ActivityPoint {
            timestamp: start_t + (i as i64 * bucket_ms),
            ..Default::default()
        })
        .collect();
    let mut bucket_last_tools = vec![String::new(); num_buckets];

    for ev in events {
        // Bin into timeline
        let b_idx = if time_span > 0 {
            let idx = ((ev.t - start_t) / bucket_ms) as usize;
            idx.min(num_buckets - 1)
        } else {
            0
        };

        // Claude writes thinking blocks with an empty string when the model
        // omits the summary. Those rows have no text to count.
        if ev.k == THINK && ev.b.trim().is_empty() {
            continue;
        }

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
                if !ev.n.is_empty() {
                    bucket_last_tools[b_idx].clone_from(&ev.n);
                }
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
                m_stat.cache_write_tokens += ev.tw;
                m_stat.reasoning_tokens += ev.tr;

                stats.total_input_tokens += ev.ti;
                stats.total_output_tokens += ev.to;
                stats.total_cache_read_tokens += ev.tc;
                stats.total_cache_write_tokens += ev.tw;
                stats.total_reasoning_tokens += ev.tr;

                buckets[b_idx].tokens += ev.ti + ev.to;
                buckets[b_idx].input_tokens += ev.ti;
                buckets[b_idx].output_tokens += ev.to;
                buckets[b_idx].cache_read_tokens += ev.tc;
                buckets[b_idx].cache_write_tokens += ev.tw;
                buckets[b_idx].reasoning_tokens += ev.tr;
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
    } else if stats.user_prompts > 0 {
        stats.turn_count = stats.user_prompts;
        stats.total_turn_duration_ms = (end_t - start_t).max(0) as u64;
        stats.avg_turn_duration_ms = stats.total_turn_duration_ms;
        stats.max_turn_duration_ms = stats.total_turn_duration_ms;
    }
    stats.turn_count = stats.turn_count.max(stats.user_prompts);

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

    for (i, b) in buckets.iter_mut().enumerate() {
        if b.user_count > 0 {
            b.top_event_kind = "user".into();
            b.top_event_label = "USER PROMPT".into();
        } else if b.reply_count > 0 && b.reply_count >= b.think_count {
            b.top_event_kind = "reply".into();
            b.top_event_label = "ASSISTANT".into();
        } else if b.think_count > 0 {
            b.top_event_kind = "think".into();
            b.top_event_label = "REASONING".into();
        } else if b.tool_count > 0 {
            b.top_event_kind = "tool".into();
            b.top_event_label = if !bucket_last_tools[i].is_empty() {
                bucket_last_tools[i].clone()
            } else {
                "TOOL".into()
            };
        }
    }

    stats.timeline = buckets;

    // Last 60 events for the HUD log. Blank thinking rows are omitted so they
    // do not crowd out a prompt, reply, or tool call.
    stats.recent_events = events
        .iter()
        .rev()
        .filter(|ev| !(ev.k == THINK && ev.b.trim().is_empty()))
        .take(60)
        .cloned()
        .collect();
    stats.recent_events.reverse();

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
        let blank = Event::new(1500, THINK);
        let mut filled = Event::new(1600, THINK);
        filled.b = "look at the layout".into();

        let events = vec![ev1, blank, filled, ev2, ev3, ev4];
        let stats = compute_stats(&events, 500, 200000, 120, 10, 2, "claude-3");

        assert_eq!(stats.user_prompts, 1);
        assert_eq!(stats.thinking_blocks, 1);
        assert_eq!(stats.tool_calls, 1);
        assert_eq!(stats.total_input_tokens, 500);
        assert_eq!(stats.total_output_tokens, 100);
        assert_eq!(stats.tools.len(), 1);
        assert_eq!(stats.tools[0].name, "ls");
        assert_eq!(stats.tools[0].avg_duration_ms, 100);
        assert_eq!(stats.active_model, "claude-3");

        let total_bucket_input: u64 = stats.timeline.iter().map(|b| b.input_tokens).sum();
        let total_bucket_output: u64 = stats.timeline.iter().map(|b| b.output_tokens).sum();
        assert_eq!(total_bucket_input, 500);
        assert_eq!(total_bucket_output, 100);
    }

    #[test]
    fn two_hour_session_keeps_a_column_per_minute() {
        let start = 1_700_000_000_000;
        let mut events = Vec::new();
        for minute in [0_i64, 30, 90, 119] {
            let mut ev = Event::new(start + minute * 60_000, USER);
            ev.b = "prompt".into();
            events.push(ev);
        }
        let stats = compute_stats(&events, 0, 0, 0, 0, 0, "");

        assert!(stats.timeline.len() > 24);
        assert_eq!(stats.timeline_start, start);
        assert_eq!(stats.timeline_end, start + 119 * 60_000);
        let occupied: Vec<_> = stats
            .timeline
            .iter()
            .filter(|bucket| bucket.user_count > 0)
            .collect();
        assert_eq!(occupied.len(), 4);
        assert!(occupied[1].timestamp - occupied[0].timestamp >= 30 * 60_000);
        assert!(occupied[3].timestamp >= start + 119 * 60_000);
        assert!(stats.timeline.last().unwrap().timestamp >= start + 119 * 60_000);
    }

    #[test]
    fn short_session_grows_a_column_faster_than_once_a_minute() {
        let start = 1_700_000_000_000;
        let mut events = Vec::new();
        for sec in [0_i64, 20, 40, 80] {
            let mut ev = Event::new(start + sec * 1000, TOOL);
            ev.n = "read".into();
            events.push(ev);
        }
        let stats = compute_stats(&events, 0, 0, 0, 0, 0, "");
        let occupied = stats
            .timeline
            .iter()
            .filter(|bucket| bucket.tool_count > 0)
            .count();
        assert!(
            occupied >= 3,
            "calls 20 seconds apart should not collapse into one column"
        );
    }
}
