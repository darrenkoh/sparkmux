//! Split a tab's stored events into user prompts for the Prompt Graph.
//!
//! Read-only. Callers pass events already on disk. This module does not ingest.

use std::collections::BTreeSet;

use serde::Serialize;

use super::event::{self, Event};

/// Cap on events returned for the selected prompt. The opening user row is kept.
pub const MAX_PROMPT_EVENTS: usize = 3_000;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PromptStatus {
    Complete,
    InProgress,
    Interrupted,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct PromptSummary {
    /// 0-based, chronological.
    pub index: usize,
    pub t_start: i64,
    pub t_end: i64,
    /// `TURN.ms` of the last main-lane turn when one exists, otherwise `t_end - t_start`.
    pub duration_ms: u64,
    /// First 80 characters of the main user body, whitespace collapsed.
    pub preview: String,
    pub status: PromptStatus,
    pub event_count: usize,
    pub tool_count: usize,
    pub ask_count: usize,
    pub err_count: usize,
    /// Distinct non-empty subagent ids (`g`).
    pub subagent_count: usize,
    pub tokens_in: u64,
    pub tokens_out: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct PromptGraphResponse {
    pub prompts: Vec<PromptSummary>,
    pub selected: Option<usize>,
    pub events: Vec<Event>,
    pub truncated: bool,
}

/// Splits a tab's events into prompts. Returns `(start, end_exclusive)` ranges.
///
/// A prompt starts at each main-agent `user` event (`g` empty). Subagent user
/// rows stay inside the parent. Rows before the first main user are dropped.
/// Mixed transcript ids (`s`) stay in one chronological pass.
pub fn segment_prompts(events: &[Event]) -> Vec<(usize, usize)> {
    let starts: Vec<usize> = events
        .iter()
        .enumerate()
        .filter(|(_, ev)| ev.k == event::USER && ev.g.is_empty())
        .map(|(idx, _)| idx)
        .collect();
    let mut ranges = Vec::with_capacity(starts.len());
    for (n, &start) in starts.iter().enumerate() {
        let end = starts.get(n + 1).copied().unwrap_or(events.len());
        ranges.push((start, end));
    }
    ranges
}

pub fn summarize(
    events: &[Event],
    idx: usize,
    range: (usize, usize),
    is_last: bool,
) -> PromptSummary {
    let (start, end) = range;
    let slice = &events[start..end];
    let t_start = slice.first().map(|ev| ev.t).unwrap_or(0);
    let t_end = slice.last().map(|ev| ev.t).unwrap_or(t_start);
    let duration_ms = slice
        .iter()
        .rev()
        .find(|ev| ev.k == event::TURN && ev.g.is_empty())
        .map(|ev| ev.ms)
        .unwrap_or_else(|| t_end.saturating_sub(t_start).max(0) as u64);

    let mut tool_count = 0;
    let mut ask_count = 0;
    let mut err_count = 0;
    let mut tokens_in = 0u64;
    let mut tokens_out = 0u64;
    let mut subs = BTreeSet::new();
    for ev in slice {
        match ev.k.as_str() {
            "tool" => tool_count += 1,
            "ask" => ask_count += 1,
            _ => {}
        }
        if ev.err {
            err_count += 1;
        }
        tokens_in = tokens_in.saturating_add(ev.ti);
        tokens_out = tokens_out.saturating_add(ev.to);
        if !ev.g.is_empty() {
            subs.insert(ev.g.as_str());
        }
    }

    PromptSummary {
        index: idx,
        t_start,
        t_end,
        duration_ms,
        preview: preview_text(slice),
        status: status_of(slice, is_last),
        event_count: slice.len(),
        tool_count,
        ask_count,
        err_count,
        subagent_count: subs.len(),
        tokens_in,
        tokens_out,
    }
}

/// `turn_index`: `None` or `-1` is the latest prompt. `>= 0` is absolute.
/// Values `< -1` count from the end (`-2` is the second latest). Out of range clamps.
pub fn build(events: &[Event], turn_index: Option<i64>) -> PromptGraphResponse {
    let ranges = segment_prompts(events);
    if ranges.is_empty() {
        return PromptGraphResponse {
            prompts: Vec::new(),
            selected: None,
            events: Vec::new(),
            truncated: false,
        };
    }
    let last = ranges.len() - 1;
    let prompts: Vec<PromptSummary> = ranges
        .iter()
        .enumerate()
        .map(|(idx, &range)| summarize(events, idx, range, idx == last))
        .collect();
    let selected = select_index(turn_index, prompts.len()).unwrap_or(last);
    let (start, end) = ranges[selected];
    let (chosen, truncated) = take_events(&events[start..end]);
    PromptGraphResponse {
        prompts,
        selected: Some(selected),
        events: chosen,
        truncated,
    }
}

fn status_of(slice: &[Event], is_last: bool) -> PromptStatus {
    let complete = slice
        .iter()
        .any(|ev| ev.k == event::TURN && ev.g.is_empty());
    if complete {
        PromptStatus::Complete
    } else if is_last {
        PromptStatus::InProgress
    } else {
        PromptStatus::Interrupted
    }
}

fn preview_text(slice: &[Event]) -> String {
    let body = slice
        .iter()
        .find(|ev| ev.k == event::USER && ev.g.is_empty())
        .map(|ev| ev.b.as_str())
        .unwrap_or("");
    let mut out = String::new();
    let mut pending_space = false;
    for ch in body.chars() {
        if ch.is_whitespace() {
            pending_space = !out.is_empty();
            continue;
        }
        if pending_space {
            out.push(' ');
            pending_space = false;
        }
        out.push(ch);
        if out.chars().count() >= 80 {
            break;
        }
    }
    out
}

fn select_index(turn_index: Option<i64>, count: usize) -> Option<usize> {
    if count == 0 {
        return None;
    }
    let n = count as i64;
    let raw = match turn_index {
        None | Some(-1) => n - 1,
        Some(i) if i < 0 => n.saturating_add(i),
        Some(i) => i,
    };
    Some(raw.clamp(0, n - 1) as usize)
}

/// Keep the opening event plus the last `MAX_PROMPT_EVENTS - 1` rows.
fn take_events(events: &[Event]) -> (Vec<Event>, bool) {
    if events.len() <= MAX_PROMPT_EVENTS {
        return (events.to_vec(), false);
    }
    let mut out = Vec::with_capacity(MAX_PROMPT_EVENTS);
    if let Some(first) = events.first() {
        out.push(first.clone());
    }
    let tail = MAX_PROMPT_EVENTS - 1;
    let start = events.len() - tail;
    out.extend_from_slice(&events[start..]);
    (out, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(t: i64, k: &str) -> Event {
        Event::new(t, k)
    }

    fn user(t: i64, body: &str) -> Event {
        let mut event = ev(t, event::USER);
        event.b = body.to_string();
        event
    }

    fn tool(t: i64, name: &str) -> Event {
        let mut event = ev(t, event::TOOL);
        event.n = name.to_string();
        event
    }

    #[test]
    fn preamble_is_dropped_and_subagent_user_does_not_split() {
        let mut sub_user = user(30, "task");
        sub_user.g = "child-1".into();
        sub_user.h = "worker".into();
        let mut sub_tool = tool(40, "Bash");
        sub_tool.g = "child-1".into();
        let events = vec![
            tool(1, "preamble"),
            user(10, "first prompt"),
            tool(20, "Read"),
            sub_user,
            sub_tool,
            user(50, "second"),
        ];
        let ranges = segment_prompts(&events);
        assert_eq!(ranges, vec![(1, 5), (5, 6)]);
        let response = build(&events, None);
        assert_eq!(response.prompts.len(), 2);
        assert_eq!(response.selected, Some(1));
        assert_eq!(response.prompts[0].event_count, 4);
        assert_eq!(response.prompts[0].subagent_count, 1);
        assert_eq!(response.prompts[0].preview, "first prompt");
        assert!(response.events.iter().all(|event| event.t >= 50));
    }

    #[test]
    fn statuses_follow_main_turns_and_position() {
        let mut sub_turn = ev(15, event::TURN);
        sub_turn.g = "child".into();
        sub_turn.ms = 5;
        let mut done = ev(40, event::TURN);
        done.ms = 30;
        let events = vec![
            user(10, "open"),
            sub_turn,
            user(20, "middle"),
            tool(25, "Read"),
            user(30, "last"),
            done,
        ];
        let response = build(&events, Some(0));
        assert_eq!(response.prompts[0].status, PromptStatus::Interrupted);
        assert_eq!(response.prompts[1].status, PromptStatus::Interrupted);
        assert_eq!(response.prompts[2].status, PromptStatus::Complete);
        assert_eq!(response.prompts[2].duration_ms, 30);

        let live = build(&events[..4], None);
        assert_eq!(
            live.prompts.last().unwrap().status,
            PromptStatus::InProgress
        );
        assert_eq!(
            live.prompts[0].duration_ms,
            live.prompts[0].t_end as u64 - live.prompts[0].t_start as u64
        );
    }

    #[test]
    fn turn_index_picks_latest_absolute_negative_and_clamps() {
        let events = vec![user(1, "a"), user(2, "b"), user(3, "c")];
        assert_eq!(build(&events, None).selected, Some(2));
        assert_eq!(build(&events, Some(-1)).selected, Some(2));
        assert_eq!(build(&events, Some(0)).selected, Some(0));
        assert_eq!(build(&events, Some(-2)).selected, Some(1));
        assert_eq!(build(&events, Some(-50)).selected, Some(0));
        assert_eq!(build(&events, Some(9)).selected, Some(2));
        let empty = build(&[], Some(0));
        assert!(empty.prompts.is_empty());
        assert_eq!(empty.selected, None);
        assert!(empty.events.is_empty());
    }

    #[test]
    fn truncation_keeps_the_opening_user_and_the_tail() {
        let mut events = vec![user(0, "keep me")];
        for i in 1..=MAX_PROMPT_EVENTS + 10 {
            events.push(tool(i as i64, "Read"));
        }
        let response = build(&events, Some(0));
        assert!(response.truncated);
        assert_eq!(response.events.len(), MAX_PROMPT_EVENTS);
        assert_eq!(response.events[0].k, event::USER);
        assert_eq!(response.events[0].b, "keep me");
        let tail_start = events.len() - (MAX_PROMPT_EVENTS - 1);
        assert_eq!(response.events[1].t, events[tail_start].t);
        assert_eq!(response.prompts[0].event_count, events.len());
    }

    #[test]
    fn summary_counts_tools_asks_errors_subagents_and_tokens() {
        let mut ask = ev(12, event::ASK);
        ask.n = "AskUserQuestion".into();
        let mut failed = ev(14, event::DONE);
        failed.n = "Bash".into();
        failed.err = true;
        let mut usage = ev(16, event::USAGE);
        usage.ti = 100;
        usage.to = 40;
        let mut child = tool(18, "Edit");
        child.g = "sub-a".into();
        let mut child_b = tool(19, "Read");
        child_b.g = "sub-b".into();
        let mut again = tool(20, "Grep");
        again.g = "sub-a".into();
        let events = vec![
            user(10, "  refactor\tthe   follower  "),
            tool(11, "AskUserQuestion"),
            ask,
            tool(13, "Bash"),
            failed,
            usage,
            child,
            child_b,
            again,
        ];
        let summary = &build(&events, Some(0)).prompts[0];
        assert_eq!(summary.preview, "refactor the follower");
        assert_eq!(summary.tool_count, 5);
        assert_eq!(summary.ask_count, 1);
        assert_eq!(summary.err_count, 1);
        assert_eq!(summary.subagent_count, 2);
        assert_eq!(summary.tokens_in, 100);
        assert_eq!(summary.tokens_out, 40);
        assert_eq!(summary.status, PromptStatus::InProgress);
    }

    #[test]
    fn mixed_sources_stay_in_chronological_order() {
        let mut first = user(10, "from a");
        first.s = "aaaaaaaa".into();
        let mut second = user(20, "from b");
        second.s = "bbbbbbbb".into();
        let response = build(&[second.clone(), first.clone()], Some(0));
        // Segmentation does not sort. The caller passes file order.
        // This case is already chronological: a then b would be two prompts.
        let ordered = build(&[first, second], None);
        assert_eq!(ordered.prompts.len(), 2);
        assert_eq!(ordered.prompts[0].preview, "from a");
        assert_eq!(ordered.prompts[1].preview, "from b");
        assert_eq!(response.prompts[0].preview, "from b");
    }
}
