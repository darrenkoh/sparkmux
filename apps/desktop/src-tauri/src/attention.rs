//! Unread marks for hidden tmux windows.
//!
//! Bell is immediate. A shell burst counts only after its activity epoch has
//! been quiet. Agent panes use the transcript label instead of the repaint.

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
            track.label = None;
            track.token = None;
            track.last_read = None;
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

fn reports_failure(body: &str) -> bool {
    let lower = body.to_ascii_lowercase();
    ["error", "failed", "failure"]
        .into_iter()
        .any(|word| has_word(&lower, word))
}

fn has_word(hay: &str, word: &str) -> bool {
    let bytes = hay.as_bytes();
    let needle = word.as_bytes();
    if needle.is_empty() || needle.len() > bytes.len() {
        return false;
    }
    let mut index = 0;
    while index + needle.len() <= bytes.len() {
        if &bytes[index..index + needle.len()] == needle {
            let before = index == 0 || !is_word(bytes[index - 1]);
            let after_at = index + needle.len();
            let after = after_at == bytes.len() || !is_word(bytes[after_at]);
            if before && after {
                return true;
            }
        }
        index += 1;
    }
    false
}

fn is_word(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn has_ask_marker(text: &str) -> bool {
    if text.is_empty() {
        return false;
    }
    let lower = text.to_ascii_lowercase();
    ASK_MARKERS.iter().any(|marker| lower.contains(marker))
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
}
