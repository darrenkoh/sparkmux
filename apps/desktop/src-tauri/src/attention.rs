//! Unread marks for hidden tmux windows.
//!
//! Bell is immediate. A shell burst counts only after its activity epoch has
//! been quiet. Agent panes use the transcript label instead of the repaint.
//! The same book records a quiet finished mark and the pending question.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use crate::artifacts::{ArtifactEntry, ArtifactFeed};

/// How long a burst must sit still before quiet output counts as unread.
const QUIET: Duration = Duration::from_secs(3);
/// Minimum gap between transcript reads of the same hidden window.
const TRANSCRIPT_EVERY: Duration = Duration::from_secs(2);

const USER_PHRASES: &[&str] = &[
    "do you want",
    "should i",
    "shall i",
    "approve",
    "permission",
    "yes or no",
    "[y/n]",
    "(y/n)",
    "waiting for you",
    "waiting for your",
    "let me know",
];

const ASK_MARKERS: &[&str] = &["askuserquestion", "request_permission", "ask_user"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttentionLabel {
    NeedsUser,
    Failed,
    Succeeded,
    /// The book accepts this label. Transcript classification does not emit it.
    #[allow(dead_code)]
    Noise,
    Running,
}

pub(crate) fn attention_label_wire(label: Option<AttentionLabel>) -> Option<String> {
    let name = match label? {
        AttentionLabel::NeedsUser => "needs_user",
        AttentionLabel::Failed => "failed",
        AttentionLabel::Succeeded => "succeeded",
        AttentionLabel::Running => "running",
        AttentionLabel::Noise => return None,
    };
    Some(name.to_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LabelToken {
    pub transcript_path: String,
    pub file_len: u64,
    pub last_entry_id: String,
}

#[derive(Debug, Default)]
struct Track {
    seen: Option<i64>,
    last_epoch: i64,
    last_move: Option<Instant>,
    label: Option<AttentionLabel>,
    token: Option<LabelToken>,
    last_read: Option<Instant>,
    /// Needs-user question kept across polls that do not re-read the transcript.
    ask: String,
    /// Label last applied to the finished transition. Not the cached transcript label.
    finish_label: Option<AttentionLabel>,
    finished: bool,
}

#[derive(Debug, Default)]
pub struct AttentionBook {
    windows: HashMap<String, Track>,
}

pub struct WindowAttention {
    pub id: String,
    pub bell: bool,
    pub activity_epoch: i64,
    pub visible: bool,
    pub agent: bool,
    /// None when we could not classify. Some(label) when we did.
    pub label: Option<AttentionLabel>,
}

impl AttentionBook {
    pub fn unread(&mut self, view: &WindowAttention, now: Instant) -> bool {
        if view.visible {
            let track = self.track_mut(&view.id);
            track.seen = Some(view.activity_epoch);
            track.last_epoch = view.activity_epoch;
            track.last_move = None;
            // The unread dot clears while the window is on screen. The
            // classifier label stays so a fetch that started on this visit
            // cannot look like a new running-to-waiting edge.
            return false;
        }
        if view.bell {
            return true;
        }
        let track = self.track_mut(&view.id);
        let Some(seen) = track.seen else {
            track.seen = Some(view.activity_epoch);
            track.last_epoch = view.activity_epoch;
            track.last_move = None;
            return false;
        };
        if view.activity_epoch <= seen {
            return false;
        }
        if view.activity_epoch > track.last_epoch {
            track.last_epoch = view.activity_epoch;
            track.last_move = Some(now);
        }
        let quiet = track
            .last_move
            .is_some_and(|moved| now.saturating_duration_since(moved) >= QUIET);
        if !view.agent {
            return quiet;
        }
        match view.label {
            Some(AttentionLabel::NeedsUser | AttentionLabel::Failed) => true,
            Some(AttentionLabel::Succeeded | AttentionLabel::Noise | AttentionLabel::Running) => {
                false
            }
            None => quiet,
        }
    }

    /// Quiet mark when a hidden agent moves from Running to Succeeded on a new
    /// transcript token. A same-token repaint does not set it. The mark stays
    /// until the window is visible, which clears it.
    pub fn finished(&mut self, view: &WindowAttention, same_token: bool) -> bool {
        if view.visible {
            if let Some(track) = self.windows.get_mut(&view.id) {
                track.finished = false;
                track.finish_label = None;
            }
            return false;
        }
        if !view.agent {
            return self
                .windows
                .get(&view.id)
                .is_some_and(|track| track.finished);
        }
        let track = self.track_mut(&view.id);
        if same_token {
            return track.finished;
        }
        if track.finish_label == Some(AttentionLabel::Running)
            && view.label == Some(AttentionLabel::Succeeded)
        {
            track.finished = true;
        }
        track.finish_label = view.label;
        track.finished
    }

    /// Hidden agent window whose epoch is past the baseline, and whose transcript
    /// was not read in the last two seconds. The caller checks agent and visible.
    pub(crate) fn wants_transcript(&self, id: &str, activity_epoch: i64, now: Instant) -> bool {
        let Some(track) = self.windows.get(id) else {
            return false;
        };
        let Some(seen) = track.seen else {
            return false;
        };
        if activity_epoch <= seen {
            return false;
        }
        match track.last_read {
            Some(read) => now.saturating_duration_since(read) >= TRANSCRIPT_EVERY,
            None => true,
        }
    }

    /// Remember a transcript read. The same token keeps the previous label.
    /// An unusable feed (`token == None`) is stored as no label, not as noise.
    pub(crate) fn store_label(
        &mut self,
        id: &str,
        token: Option<LabelToken>,
        label: Option<AttentionLabel>,
        now: Instant,
    ) -> Option<AttentionLabel> {
        let track = self.track_mut(id);
        track.last_read = Some(now);
        let Some(token) = token else {
            track.token = None;
            track.label = None;
            return None;
        };
        if track.token.as_ref() == Some(&token) {
            return track.label;
        }
        track.token = Some(token);
        track.label = label;
        label
    }

    pub(crate) fn cached_label(&self, id: &str) -> Option<AttentionLabel> {
        self.windows.get(id).and_then(|track| track.label)
    }

    pub(crate) fn has_same_token(&self, id: &str, token: Option<&LabelToken>) -> bool {
        match (
            token,
            self.windows.get(id).and_then(|track| track.token.as_ref()),
        ) {
            (Some(next), Some(prev)) => next == prev,
            _ => false,
        }
    }

    /// Keep the question that matches the stored label. A same-token read does not replace it.
    pub(crate) fn note_question(
        &mut self,
        id: &str,
        label: Option<AttentionLabel>,
        question: Option<String>,
        same_token: bool,
    ) -> String {
        let track = self.track_mut(id);
        if label != Some(AttentionLabel::NeedsUser) {
            track.ask.clear();
            return String::new();
        }
        if !same_token {
            track.ask = question.unwrap_or_default();
        }
        track.ask.clone()
    }

    pub(crate) fn cached_ask(&self, id: &str) -> String {
        self.windows
            .get(id)
            .map(|track| track.ask.clone())
            .unwrap_or_default()
    }

    pub(crate) fn clear_ask(&mut self, id: &str) {
        if let Some(track) = self.windows.get_mut(id) {
            track.ask.clear();
        }
    }

    fn track_mut(&mut self, id: &str) -> &mut Track {
        self.windows.entry(id.to_string()).or_default()
    }
}

pub(crate) fn label_from_feed(feed: &ArtifactFeed) -> (Option<LabelToken>, Option<AttentionLabel>) {
    let path = feed.transcript_path.as_deref().unwrap_or("");
    if feed.error.is_some() || path.is_empty() || feed.entries.is_empty() {
        return (None, None);
    }
    let last = &feed.entries[feed.entries.len() - 1];
    let token = LabelToken {
        transcript_path: path.to_string(),
        file_len: feed.file_len,
        last_entry_id: last.id.clone(),
    };
    (Some(token), classify_entries(&feed.entries))
}

pub fn classify_entries(entries: &[ArtifactEntry]) -> Option<AttentionLabel> {
    let kept: Vec<&ArtifactEntry> = entries
        .iter()
        .filter(|entry| entry.kind != "reasoning" && !entry.body.is_empty())
        .collect();
    let Some(last) = kept.last().copied() else {
        return if tail_has_ask(entries) {
            Some(AttentionLabel::NeedsUser)
        } else {
            None
        };
    };
    match last.kind.as_str() {
        "assistant" => {
            if prompts_user(&last.body) || tail_has_ask(entries) {
                Some(AttentionLabel::NeedsUser)
            } else if reports_failure(&last.body) {
                Some(AttentionLabel::Failed)
            } else {
                Some(AttentionLabel::Succeeded)
            }
        }
        "tool" if has_ask_marker(&last.label) || has_ask_marker(&last.body) => {
            Some(AttentionLabel::NeedsUser)
        }
        "tool" | "user" | "tool_result" => Some(AttentionLabel::Running),
        _ => None,
    }
}

/// Entries after the previous assistant, including the last one. With a single
/// assistant the whole slice is the tail, so a tool before that reply still counts.
fn tail_range(entries: &[ArtifactEntry]) -> std::ops::Range<usize> {
    let mut prev = None;
    let mut last = None;
    for (idx, entry) in entries.iter().enumerate() {
        if entry.kind == "assistant" && !entry.body.is_empty() {
            prev = last;
            last = Some(idx);
        }
    }
    match (prev, last) {
        (Some(prev), Some(_)) => prev + 1..entries.len(),
        _ => 0..entries.len(),
    }
}

fn tail_has_ask(entries: &[ArtifactEntry]) -> bool {
    let range = tail_range(entries);
    entries[range].iter().any(|entry| {
        entry.kind != "reasoning" && (has_ask_marker(&entry.label) || has_ask_marker(&entry.body))
    })
}

fn prompts_user(body: &str) -> bool {
    if body.contains('?') {
        return true;
    }
    let lower = body.to_ascii_lowercase();
    USER_PHRASES.iter().any(|phrase| lower.contains(phrase))
}

fn clean_line_start(mut s: &str) -> &str {
    s = s.trim_start();
    while let Some(rest) = s
        .strip_prefix('#')
        .or_else(|| s.strip_prefix('*'))
        .or_else(|| s.strip_prefix('-'))
        .or_else(|| s.strip_prefix('>'))
        .or_else(|| s.strip_prefix('•'))
        .or_else(|| s.strip_prefix('`'))
    {
        s = rest.trim_start();
    }
    if let Some(pos) = s.find(|c: char| !c.is_ascii_digit()) {
        if pos > 0 && (s[pos..].starts_with(". ") || s[pos..].starts_with(") ")) {
            s = s[pos + 2..].trim_start();
        }
    }
    s
}

fn has_error_header(line: &str) -> bool {
    let trimmed = clean_line_start(line);
    let lower = trimmed.to_ascii_lowercase();
    let lower = lower.trim();
    if lower == "failed"
        || lower == "failed."
        || lower == "failure"
        || lower == "failure."
        || lower == "error"
        || lower == "error."
    {
        return true;
    }
    lower.starts_with("error:")
        || lower.starts_with("error [")
        || lower.starts_with("[error]")
        || lower.starts_with("fatal:")
        || lower.starts_with("fatal error:")
        || lower.starts_with("panic:")
        || lower.starts_with("failure:")
        || lower.starts_with("failed:")
        || lower.starts_with("traceback (most recent call last):")
}

const SUCCESS_PHRASES: &[&str] = &[
    "committed and pushed",
    "has been committed",
    "have been committed",
    "pushed to",
    "successfully",
    "all tests pass",
    "all tests passed",
    "tests pass",
    "tests passed",
    "working tree clean",
    "0 failed",
    "zero failed",
    "no errors remain",
    "without error",
    "fixed the error",
    "fixed the failure",
    "resolved the error",
    "resolved the failure",
    "fixed the issue",
    "error has been resolved",
    "error has been fixed",
];

const FAILURE_PHRASES: &[&str] = &[
    "the build failed",
    "build failed",
    "there was a failure",
    "failure while",
    "task failed",
    "command failed",
    "execution failed",
    "operation failed",
    "failed to execute",
    "failed to build",
    "failed to compile",
    "failed to run",
    "failed to connect",
    "failed to push",
    "failed with exit code",
    "failed with error",
    "an error occurred while",
    "encountered an error while",
    "unexpected error occurred",
];

fn has_success_marker(lower: &str) -> bool {
    SUCCESS_PHRASES.iter().any(|phrase| lower.contains(phrase))
}

fn reports_failure(body: &str) -> bool {
    let lower = body.to_ascii_lowercase();
    if has_success_marker(&lower) {
        return false;
    }
    for line in body.lines() {
        if has_error_header(line) {
            return true;
        }
    }
    FAILURE_PHRASES.iter().any(|phrase| lower.contains(phrase))
}

fn has_ask_marker(text: &str) -> bool {
    if text.is_empty() {
        return false;
    }
    let lower = text.to_ascii_lowercase();
    ASK_MARKERS.iter().any(|marker| lower.contains(marker))
}

/// Foreground `ssh`, including a path such as `/usr/bin/ssh`. Not an agent row.
pub(crate) fn command_is_ssh(command: &str) -> bool {
    let base = command.rsplit(['/', '\\']).next().unwrap_or(command).trim();
    let name = base.strip_suffix(".exe").unwrap_or(base);
    name.eq_ignore_ascii_case("ssh")
}

fn cli_label(kind: crate::artifacts::CliKind) -> &'static str {
    match kind {
        crate::artifacts::CliKind::Grok => "Grok",
        crate::artifacts::CliKind::Claude => "Claude",
        crate::artifacts::CliKind::Antigravity => "Antigravity",
    }
}

fn state_label(label: Option<AttentionLabel>) -> &'static str {
    match label {
        Some(AttentionLabel::NeedsUser) => "Waiting on you",
        Some(AttentionLabel::Failed) => "Failed",
        Some(AttentionLabel::Succeeded) => "Finished",
        Some(AttentionLabel::Running | AttentionLabel::Noise) | None => "Running",
    }
}

fn one_line(text: &str, cap: usize) -> String {
    let mut out = String::new();
    let mut count = 0usize;
    let mut pending_space = false;
    for ch in text.chars() {
        if ch.is_whitespace() {
            if count > 0 {
                pending_space = true;
            }
            continue;
        }
        if pending_space {
            if count >= cap {
                break;
            }
            out.push(' ');
            count += 1;
            pending_space = false;
        }
        if count >= cap {
            break;
        }
        out.push(ch);
        count += 1;
    }
    out
}

/// One-line ask for a needs-user transcript, capped at 120 characters.
/// Failed, running, and finished transcripts return nothing.
pub fn pending_question(entries: &[ArtifactEntry]) -> Option<String> {
    if classify_entries(entries) != Some(AttentionLabel::NeedsUser) {
        return None;
    }
    let text = ask_source(entries)?;
    let line = one_line(&text, 120);
    if line.is_empty() {
        None
    } else {
        Some(line)
    }
}

fn ask_source(entries: &[ArtifactEntry]) -> Option<String> {
    let range = tail_range(entries);
    if let Some(entry) = entries[range].iter().rev().find(|entry| {
        entry.kind != "reasoning" && (has_ask_marker(&entry.label) || has_ask_marker(&entry.body))
    }) {
        let body = entry.body.trim();
        if !body.is_empty() {
            return Some(body.to_string());
        }
        let label = entry.label.trim();
        if !label.is_empty() {
            return Some(label.to_string());
        }
    }
    let assistant = entries.iter().rev().find(|entry| {
        entry.kind == "assistant" && !entry.body.is_empty() && prompts_user(&entry.body)
    })?;
    Some(assistant.body.clone())
}

/// Last non-empty assistant body, one line, capped at 160 characters.
pub fn last_assistant_line(entries: &[ArtifactEntry]) -> Option<String> {
    let assistant = entries
        .iter()
        .rev()
        .find(|entry| entry.kind == "assistant" && !entry.body.trim().is_empty())?;
    let line = one_line(&assistant.body, 160);
    if line.is_empty() {
        None
    } else {
        Some(line)
    }
}

/// Fields already taken off the pane and its transcript. `board_row` does not read files.
#[derive(Debug, Clone, Copy)]
pub struct BoardFields<'a> {
    pub session: &'a str,
    pub window_id: &'a str,
    pub window_name: &'a str,
    pub pane_id: &'a str,
    pub command: &'a str,
    pub title: &'a str,
    pub label: Option<AttentionLabel>,
    pub model: Option<&'a str>,
    pub ask: Option<&'a str>,
    pub assistant: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct BoardRow {
    pub session: String,
    pub window_id: String,
    pub window_name: String,
    pub pane_id: String,
    pub state: String,
    pub model: String,
    pub detail: String,
}

/// One agent-board row, or nothing for a shell or `ssh` pane.
pub fn board_row(fields: &BoardFields<'_>) -> Option<BoardRow> {
    if command_is_ssh(fields.command) {
        return None;
    }
    let kind = crate::artifacts::detect_cli(fields.command, fields.title, &[])?;
    let model = fields
        .model
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| cli_label(kind).to_string());
    let waiting = fields.label == Some(AttentionLabel::NeedsUser);
    let raw = if waiting {
        fields.ask.unwrap_or("")
    } else {
        fields.assistant.unwrap_or("")
    };
    Some(BoardRow {
        session: fields.session.to_string(),
        window_id: fields.window_id.to_string(),
        window_name: fields.window_name.to_string(),
        pane_id: fields.pane_id.to_string(),
        state: state_label(fields.label).to_string(),
        model,
        detail: one_line(raw, 160),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ent(kind: &str, label: &str, body: &str) -> ArtifactEntry {
        ArtifactEntry {
            id: format!("{kind}:{label}"),
            offset: 0,
            kind: kind.to_string(),
            label: label.to_string(),
            body: body.to_string(),
            model: String::new(),
        }
    }

    fn view(
        id: &str,
        epoch: i64,
        visible: bool,
        bell: bool,
        agent: bool,
        label: Option<AttentionLabel>,
    ) -> WindowAttention {
        WindowAttention {
            id: id.to_string(),
            bell,
            activity_epoch: epoch,
            visible,
            agent,
            label,
        }
    }

    struct Step {
        ms: u64,
        epoch: i64,
        visible: bool,
        bell: bool,
        agent: bool,
        label: Option<AttentionLabel>,
        unread: bool,
    }

    fn step(
        ms: u64,
        epoch: i64,
        visible: bool,
        bell: bool,
        agent: bool,
        label: Option<AttentionLabel>,
        unread: bool,
    ) -> Step {
        Step {
            ms,
            epoch,
            visible,
            bell,
            agent,
            label,
            unread,
        }
    }

    fn play(name: &str, steps: &[Step]) {
        let mut book = AttentionBook::default();
        let start = Instant::now();
        for (index, step) in steps.iter().enumerate() {
            let now = start
                .checked_add(Duration::from_millis(step.ms))
                .expect("step fits in Instant");
            let got = book.unread(
                &view(
                    "w",
                    step.epoch,
                    step.visible,
                    step.bell,
                    step.agent,
                    step.label,
                ),
                now,
            );
            assert_eq!(
                got, step.unread,
                "{name} step {index} at {}ms epoch {}",
                step.ms, step.epoch
            );
        }
    }

    #[test]
    fn unread_rules() {
        let scripts: Vec<(&str, Vec<Step>)> = vec![
            (
                "bell is immediate on a hidden window that was never seen",
                vec![step(0, 4, false, true, false, None, true)],
            ),
            (
                "a visible window is never unread, even with a bell",
                vec![step(0, 4, true, true, false, None, false)],
            ),
            (
                "first hidden observation baselines and an old epoch does not dot",
                vec![
                    step(0, 50, false, false, false, None, false),
                    step(10_000, 50, false, false, false, None, false),
                ],
            ),
            (
                "shell burst is quiet at 3.0s and not at 2.9s",
                vec![
                    step(0, 1, false, false, false, None, false),
                    step(0, 2, false, false, false, None, false),
                    step(2_900, 2, false, false, false, None, false),
                    step(3_000, 2, false, false, false, None, true),
                ],
            ),
            (
                "continuous shell bumps every 1s for 5s stay unread",
                vec![
                    step(0, 1, false, false, false, None, false),
                    step(1_000, 2, false, false, false, None, false),
                    step(2_000, 3, false, false, false, None, false),
                    step(3_000, 4, false, false, false, None, false),
                    step(4_000, 5, false, false, false, None, false),
                    step(5_000, 6, false, false, false, None, false),
                ],
            ),
            (
                "one shell bump then 3s quiet becomes unread",
                vec![
                    step(0, 1, false, false, false, None, false),
                    step(1_000, 2, false, false, false, None, false),
                    step(3_900, 2, false, false, false, None, false),
                    step(4_000, 2, false, false, false, None, true),
                ],
            ),
            (
                "a newer epoch restarts the quiet timer",
                vec![
                    step(0, 1, false, false, false, None, false),
                    step(0, 2, false, false, false, None, false),
                    step(3_000, 2, false, false, false, None, true),
                    step(3_000, 3, false, false, false, None, false),
                    step(5_900, 3, false, false, false, None, false),
                    step(6_000, 3, false, false, false, None, true),
                ],
            ),
            (
                "opening the window clears unread and the same epoch does not dot later",
                vec![
                    step(0, 7, false, false, false, None, false),
                    step(0, 8, false, false, false, None, false),
                    step(3_000, 8, false, false, false, None, true),
                    step(
                        3_000,
                        8,
                        true,
                        true,
                        true,
                        Some(AttentionLabel::NeedsUser),
                        false,
                    ),
                    step(9_000, 8, false, false, false, None, false),
                ],
            ),
            (
                "hiding with a newer epoch still waits for quiet",
                vec![
                    step(0, 7, true, false, false, None, false),
                    step(1_000, 8, false, false, false, None, false),
                    step(3_900, 8, false, false, false, None, false),
                    step(4_000, 8, false, false, false, None, true),
                ],
            ),
            (
                "bell still dots after a baseline when the epoch has not moved",
                vec![
                    step(0, 1, false, false, false, None, false),
                    step(500, 1, false, true, false, None, true),
                ],
            ),
            (
                "first sight of an agent does not dot, even when the label needs the user",
                vec![step(
                    0,
                    9,
                    false,
                    false,
                    true,
                    Some(AttentionLabel::NeedsUser),
                    false,
                )],
            ),
            (
                "agent needs-user dots while the burst is still painting",
                vec![
                    step(0, 1, false, false, true, None, false),
                    step(
                        100,
                        2,
                        false,
                        false,
                        true,
                        Some(AttentionLabel::NeedsUser),
                        true,
                    ),
                ],
            ),
            (
                "agent failed dots while the burst is still painting",
                vec![
                    step(0, 1, false, false, true, None, false),
                    step(
                        100,
                        2,
                        false,
                        false,
                        true,
                        Some(AttentionLabel::Failed),
                        true,
                    ),
                ],
            ),
            (
                "agent succeeded, noise, and running do not dot after quiet",
                vec![
                    step(0, 1, false, false, true, None, false),
                    step(
                        0,
                        2,
                        false,
                        false,
                        true,
                        Some(AttentionLabel::Succeeded),
                        false,
                    ),
                    step(
                        3_000,
                        2,
                        false,
                        false,
                        true,
                        Some(AttentionLabel::Succeeded),
                        false,
                    ),
                    step(
                        3_000,
                        3,
                        false,
                        false,
                        true,
                        Some(AttentionLabel::Noise),
                        false,
                    ),
                    step(
                        6_000,
                        3,
                        false,
                        false,
                        true,
                        Some(AttentionLabel::Noise),
                        false,
                    ),
                    step(
                        6_000,
                        4,
                        false,
                        false,
                        true,
                        Some(AttentionLabel::Running),
                        false,
                    ),
                    step(
                        9_000,
                        4,
                        false,
                        false,
                        true,
                        Some(AttentionLabel::Running),
                        false,
                    ),
                ],
            ),
            (
                "agent with no classifier result dots only after quiet",
                vec![
                    step(0, 1, false, false, true, None, false),
                    step(0, 2, false, false, true, None, false),
                    step(2_900, 2, false, false, true, None, false),
                    step(3_000, 2, false, false, true, None, true),
                ],
            ),
            (
                "needs-user without a newer epoch does not dot",
                vec![
                    step(0, 4, true, false, true, None, false),
                    step(
                        5_000,
                        4,
                        false,
                        false,
                        true,
                        Some(AttentionLabel::NeedsUser),
                        false,
                    ),
                ],
            ),
            (
                "a shell ignores an agent label and follows quiet",
                vec![
                    step(0, 1, false, false, false, None, false),
                    step(
                        0,
                        2,
                        false,
                        false,
                        false,
                        Some(AttentionLabel::NeedsUser),
                        false,
                    ),
                    step(
                        3_000,
                        2,
                        false,
                        false,
                        false,
                        Some(AttentionLabel::NeedsUser),
                        true,
                    ),
                ],
            ),
            (
                "an epoch older than the one seen on screen does not dot",
                vec![
                    step(0, 10, true, false, false, None, false),
                    step(5_000, 9, false, false, false, None, false),
                ],
            ),
            (
                "a shell heartbeat every 2s stays quiet",
                vec![
                    step(0, 1, false, false, false, None, false),
                    step(0, 2, false, false, false, None, false),
                    step(2_000, 2, false, false, false, None, false),
                    step(2_000, 3, false, false, false, None, false),
                    step(4_000, 3, false, false, false, None, false),
                    step(4_000, 4, false, false, false, None, false),
                    step(6_000, 4, false, false, false, None, false),
                ],
            ),
        ];
        for (name, steps) in scripts {
            play(name, &steps);
        }
    }

    #[test]
    fn hidden_agy_heartbeat_while_grok_is_on_screen() {
        // Sparkmux is attached. grok is current and repaints every second.
        // agy is hidden and its activity epoch steps about every 2s.
        let start = Instant::now();
        let cases = [
            (None, false),
            (Some(AttentionLabel::Running), false),
            (Some(AttentionLabel::Succeeded), false),
            (Some(AttentionLabel::Noise), false),
            (Some(AttentionLabel::NeedsUser), true),
            (Some(AttentionLabel::Failed), true),
        ];
        for (label, dots_after_move) in cases {
            let mut book = AttentionBook::default();
            let mut grok_epoch = 1_000;
            let mut agy_epoch = 5_000;
            for sec in 0..8 {
                let now = start
                    .checked_add(Duration::from_secs(sec))
                    .expect("step fits");
                grok_epoch += 1;
                let grok = book.unread(
                    &view(
                        "grok",
                        grok_epoch,
                        true,
                        true,
                        true,
                        Some(AttentionLabel::NeedsUser),
                    ),
                    now,
                );
                assert!(!grok, "visible grok dotted at {sec}s ({label:?})");
                if sec > 0 && sec % 2 == 0 {
                    agy_epoch += 2;
                }
                let agy = book.unread(&view("agy", agy_epoch, false, false, true, label), now);
                let expect = dots_after_move && sec >= 2;
                assert_eq!(agy, expect, "agy at {sec}s epoch {agy_epoch} ({label:?})");
            }
        }
    }

    #[test]
    fn windows_do_not_share_a_baseline() {
        let mut book = AttentionBook::default();
        let start = Instant::now();
        let later = start.checked_add(Duration::from_secs(10)).unwrap();
        assert!(!book.unread(&view("a", 5, false, false, false, None), start));
        assert!(book.unread(&view("b", 5, false, true, false, None), start));
        assert!(!book.unread(&view("a", 5, false, false, false, None), later));
        assert!(book.unread(
            &view("b", 6, false, true, true, Some(AttentionLabel::Running)),
            later
        ));
    }

    #[test]
    fn transcript_cache_reuses_a_token_and_waits_two_seconds() {
        let mut book = AttentionBook::default();
        let start = Instant::now();
        assert!(!book.wants_transcript("w", 2, start));
        assert!(!book.unread(&view("w", 1, false, false, true, None), start));
        assert!(!book.wants_transcript("w", 1, start));
        assert!(!book.unread(&view("w", 2, false, false, true, None), start));
        assert!(book.wants_transcript("w", 2, start));

        let token = LabelToken {
            transcript_path: "/tmp/chat.jsonl".into(),
            file_len: 10,
            last_entry_id: "a".into(),
        };
        assert_eq!(
            book.store_label(
                "w",
                Some(token.clone()),
                Some(AttentionLabel::Running),
                start
            ),
            Some(AttentionLabel::Running)
        );
        let almost = start.checked_add(Duration::from_millis(1_999)).unwrap();
        let ready = start.checked_add(TRANSCRIPT_EVERY).unwrap();
        assert!(!book.wants_transcript("w", 2, almost));
        assert!(book.wants_transcript("w", 2, ready));
        assert_eq!(
            book.store_label(
                "w",
                Some(token.clone()),
                Some(AttentionLabel::Failed),
                ready
            ),
            Some(AttentionLabel::Running),
            "unchanged token keeps the cached label"
        );
        let replaced = LabelToken {
            last_entry_id: "b".into(),
            ..token
        };
        assert_eq!(
            book.store_label("w", Some(replaced), Some(AttentionLabel::Failed), ready),
            Some(AttentionLabel::Failed)
        );
        assert_eq!(
            book.store_label("w", None, Some(AttentionLabel::Noise), ready),
            None
        );
        assert_eq!(book.cached_label("w"), None);
    }

    #[test]
    fn visible_visit_keeps_the_cached_label_and_is_not_unread() {
        let mut book = AttentionBook::default();
        let now = Instant::now();
        let token = LabelToken {
            transcript_path: "/tmp/chat.jsonl".into(),
            file_len: 4,
            last_entry_id: "ask".into(),
        };
        assert_eq!(
            book.store_label(
                "w",
                Some(token.clone()),
                Some(AttentionLabel::NeedsUser),
                now
            ),
            Some(AttentionLabel::NeedsUser)
        );
        let unread = book.unread(
            &view("w", 3, true, false, true, Some(AttentionLabel::NeedsUser)),
            now,
        );
        assert!(!unread);
        assert_eq!(book.cached_label("w"), Some(AttentionLabel::NeedsUser));
        assert!(book.has_same_token("w", Some(&token)));
        assert!(!book.wants_transcript("w", 9, now));
    }

    #[test]
    fn classify_entries_table() {
        let cases: Vec<(&str, Vec<ArtifactEntry>, Option<AttentionLabel>)> = vec![
            ("no entries", vec![], None),
            (
                "reasoning is ignored",
                vec![ent("reasoning", "Thinking", "should i? error")],
                None,
            ),
            (
                "empty assistant body is ignored",
                vec![ent("assistant", "Assistant", "")],
                None,
            ),
            (
                "user is running",
                vec![ent("user", "You", "hello")],
                Some(AttentionLabel::Running),
            ),
            (
                "tool is running",
                vec![ent("tool", "bash", "ls")],
                Some(AttentionLabel::Running),
            ),
            (
                "tool result is running",
                vec![ent("tool_result", "Result", "ok")],
                Some(AttentionLabel::Running),
            ),
            (
                "assistant finished",
                vec![ent("assistant", "Assistant", "All done.")],
                Some(AttentionLabel::Succeeded),
            ),
            (
                "question mark",
                vec![ent("assistant", "Assistant", "Continue?")],
                Some(AttentionLabel::NeedsUser),
            ),
            (
                "failed word",
                vec![ent("assistant", "Assistant", "The build failed.")],
                Some(AttentionLabel::Failed),
            ),
            (
                "error word",
                vec![ent("assistant", "Assistant", "Error: boom")],
                Some(AttentionLabel::Failed),
            ),
            (
                "failure word",
                vec![ent("assistant", "Assistant", "There was a failure.")],
                Some(AttentionLabel::Failed),
            ),
            (
                "errors is not the word error",
                vec![ent("assistant", "Assistant", "No errors remain.")],
                Some(AttentionLabel::Succeeded),
            ),
            (
                "error_code is one word",
                vec![ent("assistant", "Assistant", "Set error_code later.")],
                Some(AttentionLabel::Succeeded),
            ),
            (
                "needs user wins over failed",
                vec![ent(
                    "assistant",
                    "Assistant",
                    "Should I retry the failed command?",
                )],
                Some(AttentionLabel::NeedsUser),
            ),
            (
                "uppercase should i",
                vec![ent("assistant", "Assistant", "SHOULD I open it")],
                Some(AttentionLabel::NeedsUser),
            ),
            (
                "ask tool is last",
                vec![
                    ent("assistant", "Assistant", "ok"),
                    ent("tool", "AskUserQuestion", "which file"),
                ],
                Some(AttentionLabel::NeedsUser),
            ),
            (
                "empty-body ask tool still counts",
                vec![
                    ent("assistant", "Assistant", "ok"),
                    ent("tool", "AskUserQuestion", ""),
                ],
                Some(AttentionLabel::NeedsUser),
            ),
            (
                "lone ask tool",
                vec![ent("tool", "request_permission", "")],
                Some(AttentionLabel::NeedsUser),
            ),
            (
                "ask marker in the tool body",
                vec![ent("tool", "tool", "please ask_user now")],
                Some(AttentionLabel::NeedsUser),
            ),
            (
                "short assistant after an ask tool in this turn",
                vec![
                    ent("assistant", "Assistant", "I should check."),
                    ent("tool", "AskUserQuestion", "which"),
                    ent("assistant", "Assistant", "ok"),
                ],
                Some(AttentionLabel::NeedsUser),
            ),
            (
                "a later assistant leaves the ask tool behind",
                vec![
                    ent("assistant", "Assistant", "I should check."),
                    ent("tool", "AskUserQuestion", "which"),
                    ent("assistant", "Assistant", "ok"),
                    ent("assistant", "Assistant", "All finished."),
                ],
                Some(AttentionLabel::Succeeded),
            ),
            (
                "tool result after an ask tool is running",
                vec![
                    ent("assistant", "Assistant", "ok"),
                    ent("tool", "AskUserQuestion", "which"),
                    ent("tool_result", "Result", "notes.txt"),
                ],
                Some(AttentionLabel::Running),
            ),
            (
                "user after an ask tool is running",
                vec![
                    ent("assistant", "Assistant", "ok"),
                    ent("tool", "AskUserQuestion", "which"),
                    ent("user", "You", "the notes"),
                ],
                Some(AttentionLabel::Running),
            ),
            (
                "a later bash tool is running",
                vec![
                    ent("assistant", "Assistant", "ok"),
                    ent("tool", "AskUserQuestion", "which"),
                    ent("tool", "bash", "ls"),
                ],
                Some(AttentionLabel::Running),
            ),
            (
                "reasoning does not hide the assistant or force needs user",
                vec![
                    ent("reasoning", "Thinking", "askuserquestion error?"),
                    ent("assistant", "Assistant", "Done."),
                ],
                Some(AttentionLabel::Succeeded),
            ),
            ("unknown kind", vec![ent("system", "Note", "hello?")], None),
            (
                "failure is case insensitive",
                vec![ent("assistant", "Assistant", "FAILURE while writing")],
                Some(AttentionLabel::Failed),
            ),
            (
                "commit message with syntax error is succeeded",
                vec![ent(
                    "assistant",
                    "Assistant",
                    "Both repositories have been committed and pushed:\n\n1. Local Mac Repo (https://github.com/darrenkoh/imagine.git):\n• Commit: b687a7c (Fix iPhone Safari auth and page loading on local LAN)\n• Files: app.py, static/app.js\n• Pushed: main -> origin/main\n2. DGX Spark Repo (https://github.com/darrenkoh/inference.git):\n• Commit: 093dc57 (Fix Safari auth and syntax error, add prompt history and gallery tools)\n• Files: imagine/app.py\n• Pushed: main -> origin/main",
                )],
                Some(AttentionLabel::Succeeded),
            ),
            (
                "removed syntax error block is succeeded",
                vec![ent(
                    "assistant",
                    "Assistant",
                    "Removed the broken unused_old_load syntax-error block (validated with JavaScript AST parser). All 107 unit tests pass.",
                )],
                Some(AttentionLabel::Succeeded),
            ),
            (
                "added error handling is succeeded",
                vec![ent(
                    "assistant",
                    "Assistant",
                    "Added error handling to prevent runtime errors.",
                )],
                Some(AttentionLabel::Succeeded),
            ),
            (
                "syntax error explanation is succeeded",
                vec![ent(
                    "assistant",
                    "Assistant",
                    "The syntax error was caused by a missing bracket in index.js.",
                )],
                Some(AttentionLabel::Succeeded),
            ),
        ];
        for (name, entries, expect) in cases {
            assert_eq!(classify_entries(&entries), expect, "{name}");
        }
    }

    #[test]
    fn assistant_phrases_need_the_user() {
        for phrase in USER_PHRASES {
            let body = format!("Note: {phrase} please");
            assert_eq!(
                classify_entries(&[ent("assistant", "Assistant", &body)]),
                Some(AttentionLabel::NeedsUser),
                "{phrase}"
            );
        }
        assert_eq!(
            classify_entries(&[ent("assistant", "Assistant", "Reply [Y/N] now")]),
            Some(AttentionLabel::NeedsUser)
        );
    }

    #[test]
    fn unusable_feeds_are_not_cached_as_noise() {
        let empty = ArtifactFeed {
            cli: Some("grok".into()),
            transcript_path: None,
            file_len: 0,
            entries: vec![],
            error: None,
        };
        let errored = ArtifactFeed {
            cli: Some("grok".into()),
            transcript_path: Some("/tmp/chat.jsonl".into()),
            file_len: 4,
            entries: vec![],
            error: Some("Could not read the transcript.".into()),
        };
        let usable = ArtifactFeed {
            cli: Some("claude".into()),
            transcript_path: Some("/tmp/chat.jsonl".into()),
            file_len: 20,
            entries: vec![ent("assistant", "Assistant", "All done.")],
            error: None,
        };
        assert_eq!(label_from_feed(&empty), (None, None));
        assert_eq!(label_from_feed(&errored), (None, None));
        let (token, label) = label_from_feed(&usable);
        assert_eq!(label, Some(AttentionLabel::Succeeded));
        let token = token.expect("token");
        assert_eq!(token.transcript_path, "/tmp/chat.jsonl");
        assert_eq!(token.file_len, 20);
        assert_eq!(token.last_entry_id, "assistant:Assistant");
    }

    fn hidden(label: Option<AttentionLabel>) -> WindowAttention {
        view("w", 2, false, false, true, label)
    }

    #[test]
    fn finished_mark_from_a_fresh_book() {
        let mut book = AttentionBook::default();
        assert!(!book.finished(&hidden(Some(AttentionLabel::Running)), false));
        assert!(book.finished(&hidden(Some(AttentionLabel::Succeeded)), false));
        assert!(
            book.finished(&hidden(Some(AttentionLabel::Succeeded)), false),
            "a later succeeded poll keeps the mark"
        );
        assert!(
            book.finished(&hidden(Some(AttentionLabel::Succeeded)), true),
            "a same-token poll after the mark keeps it"
        );
        assert!(!book.finished(
            &view("w", 2, true, false, true, Some(AttentionLabel::Succeeded)),
            false
        ));
        assert!(
            !book.finished(&hidden(Some(AttentionLabel::Succeeded)), false),
            "opening the window clears it, and a later succeeded poll does not set it again"
        );

        let mut book = AttentionBook::default();
        assert!(!book.finished(&hidden(Some(AttentionLabel::Running)), false));
        assert!(!book.finished(&hidden(Some(AttentionLabel::Running)), false));
        assert!(
            !book.finished(&hidden(Some(AttentionLabel::Succeeded)), true),
            "same-token repaint does not set the mark"
        );

        let mut book = AttentionBook::default();
        assert!(!book.finished(
            &view(
                "need",
                2,
                false,
                false,
                true,
                Some(AttentionLabel::NeedsUser)
            ),
            false
        ));
        assert!(!book.finished(
            &view("fail", 2, false, false, true, Some(AttentionLabel::Failed)),
            false
        ));
        assert!(!book.finished(
            &view("run", 2, false, false, true, Some(AttentionLabel::Running)),
            false
        ));
        assert!(!book.finished(
            &view(
                "seen",
                2,
                false,
                false,
                true,
                Some(AttentionLabel::Succeeded)
            ),
            false
        ));
        assert!(!book.finished(
            &view(
                "shell",
                2,
                false,
                false,
                false,
                Some(AttentionLabel::Running)
            ),
            false
        ));
        assert!(!book.finished(
            &view(
                "shell",
                3,
                false,
                false,
                false,
                Some(AttentionLabel::Succeeded),
            ),
            false
        ));
    }

    #[test]
    fn pending_question_is_the_one_line_ask() {
        assert_eq!(pending_question(&[]), None);
        assert_eq!(
            pending_question(&[ent("assistant", "Assistant", "The build failed.")]),
            None
        );
        assert_eq!(
            pending_question(&[ent("assistant", "Assistant", "All done.")]),
            None
        );
        assert_eq!(
            pending_question(&[ent("assistant", "Assistant", "Ship it?\nplease")]),
            Some("Ship it? please".into())
        );
        assert_eq!(
            pending_question(&[ent("tool", "AskUserQuestion", "which file")]),
            Some("which file".into())
        );
        assert_eq!(
            pending_question(&[
                ent("assistant", "Assistant", "I should check."),
                ent("tool", "AskUserQuestion", "which file"),
                ent("assistant", "Assistant", "ok"),
            ]),
            Some("which file".into())
        );
        let mut long = "é".repeat(119);
        long.push('?');
        long.push('x');
        let got = pending_question(&[ent("assistant", "Assistant", &long)]).expect("ask");
        assert_eq!(got.chars().count(), 120);
        assert!(got.ends_with('?'));
    }

    #[test]
    fn last_assistant_line_is_the_latest_reply() {
        assert_eq!(last_assistant_line(&[]), None);
        assert_eq!(
            last_assistant_line(&[
                ent("assistant", "Assistant", "first"),
                ent("tool", "bash", "ls"),
                ent("assistant", "Assistant", "second\nline"),
            ])
            .as_deref(),
            Some("second line")
        );
    }

    fn sample_fields<'a>(
        command: &'a str,
        title: &'a str,
        label: Option<AttentionLabel>,
    ) -> BoardFields<'a> {
        BoardFields {
            session: "spark",
            window_id: "@1",
            window_name: "agent",
            pane_id: "%7",
            command,
            title,
            label,
            model: None,
            ask: None,
            assistant: None,
        }
    }

    #[test]
    fn board_row_lists_only_the_three_clis() {
        assert!(board_row(&sample_fields("zsh", "zsh", None)).is_none());
        assert!(board_row(&sample_fields("/usr/bin/ssh", "fix - grok", None)).is_none());
        assert!(board_row(&sample_fields(
            "ssh",
            "Claude Code",
            Some(AttentionLabel::Running)
        ))
        .is_none());

        let grok =
            board_row(&sample_fields("grok", "", Some(AttentionLabel::Running))).expect("grok");
        assert_eq!(grok.session, "spark");
        assert_eq!(grok.window_id, "@1");
        assert_eq!(grok.window_name, "agent");
        assert_eq!(grok.pane_id, "%7");
        assert_eq!(grok.state, "Running");
        assert_eq!(grok.model, "Grok");
        assert!(grok.detail.is_empty());

        let claude = board_row(&sample_fields(
            "zsh",
            "Claude Code",
            Some(AttentionLabel::Failed),
        ))
        .expect("claude title");
        assert_eq!(claude.state, "Failed");
        assert_eq!(claude.model, "Claude");

        let agy =
            board_row(&sample_fields("agy", "", Some(AttentionLabel::Succeeded))).expect("agy");
        assert_eq!(agy.state, "Finished");
        assert_eq!(agy.model, "Antigravity");

        let mut waiting = sample_fields("claude", "", Some(AttentionLabel::NeedsUser));
        waiting.model = Some("  ");
        waiting.ask = Some("Continue?\nnow");
        waiting.assistant = Some("ignored while waiting");
        let waiting = board_row(&waiting).expect("waiting");
        assert_eq!(waiting.state, "Waiting on you");
        assert_eq!(waiting.model, "Claude");
        assert_eq!(waiting.detail, "Continue? now");

        let mut named = sample_fields("grok-1.0.50", "", None);
        named.model = Some(" grok-4 ");
        named.ask = Some("a question");
        named.assistant = Some("  last reply \n stays ");
        let named = board_row(&named).expect("versioned grok");
        assert_eq!(named.state, "Running");
        assert_eq!(named.model, "grok-4");
        assert_eq!(named.detail, "last reply stays");

        let ask = "q".repeat(180);
        let long = board_row(&BoardFields {
            session: "spark",
            window_id: "@1",
            window_name: "agent",
            pane_id: "%7",
            command: "/opt/homebrew/bin/grok",
            title: "",
            label: Some(AttentionLabel::NeedsUser),
            model: None,
            ask: Some(&ask),
            assistant: None,
        })
        .expect("capped");
        assert_eq!(long.detail.chars().count(), 160);
        assert_eq!(long.model, "Grok");
    }
}
