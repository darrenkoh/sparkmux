//! Incremental transcript ingestion.
//!
//! Each `(tab, transcript)` pair owns a [`Cursor`]. A tick reads only the bytes
//! appended since the last tick, so a long session is imported once and then
//! followed. Grok's `chat_history.jsonl` has no timestamps; its sibling
//! `events.jsonl` does. Tool calls and user turns are matched to
//! `tool_started` and `turn_started` by position, which both files share.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::event::{self, parse_iso_ms, Event};
use crate::artifacts::{
    agy_bookkeeping, agy_tool_result, args_detail, args_summary, extract_user_query, noise_prompt,
    reasoning_text, text_from_value, tool_args, truncate_chars, CliKind,
};

/// Bytes read from one file per tick. A large history imports over a few ticks.
pub const MAX_READ: u64 = 8 * 1024 * 1024;
const USER_CAP: usize = 4_000;
const REPLY_CAP: usize = 4_000;
const THINK_CAP: usize = 4_000;
const RESULT_CAP: usize = 4_000;
/// Short tool label (a path or command) shown on the collapsed log row.
const ARG_CAP: usize = 200;
/// Full tool arguments kept for the expanded log row.
const DETAIL_CAP: usize = 4_000;
const PENDING_CAP: usize = 256;
const QUEUE_CAP: usize = 20_000;
/// Context window assumed for Claude, which does not record it.
const CLAUDE_WINDOW: u64 = 200_000;
/// A transcript written this recently is live; new lines get the current time.
const LIVE_MS: i64 = 30_000;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Cursor {
    /// Transcript bytes consumed.
    #[serde(default)]
    pub offset: u64,
    /// Grok `events.jsonl` bytes consumed.
    #[serde(default)]
    pub ev_offset: u64,
    /// Grok `usage.json` turns already emitted.
    #[serde(default)]
    pub usage_turns: usize,
    #[serde(default)]
    pub usage_mtime: u64,
    #[serde(default)]
    pub signals_mtime: u64,
    #[serde(default)]
    pub tools_ev: u64,
    #[serde(default)]
    pub tools_chat: u64,
    #[serde(default)]
    pub tool_ts: VecDeque<i64>,
    #[serde(default)]
    pub turns_ev: u64,
    #[serde(default)]
    pub turns_chat: u64,
    #[serde(default)]
    pub turn_ts: VecDeque<i64>,
    #[serde(default)]
    pub turn_start: i64,
    /// Antigravity user turn opened and not yet emitted. Stats polls once a
    /// second, so the user step and the later planner step are different reads.
    #[serde(default)]
    pub agy_turn_open: bool,
    /// Latest timestamp seen in this transcript.
    #[serde(default)]
    pub last_ts: i64,
    /// Claude repeats usage on every block of one response. Emit it once.
    #[serde(default)]
    pub last_msg: String,
    /// Claude `tool_use` id to (start ms, tool name).
    #[serde(default)]
    pub pending: HashMap<String, (i64, String)>,
    #[serde(default)]
    pub model: String,
    /// JSON object `sessionCost` reads. The CLI's recorded stamp, not a reprice.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub cost_ledger: String,
    #[serde(default)]
    pub ctx_used: u64,
    #[serde(default)]
    pub ctx_window: u64,
    #[serde(default)]
    pub ttft_ms: u64,
    #[serde(default)]
    pub lines_added: u64,
    #[serde(default)]
    pub lines_removed: u64,
    #[serde(default)]
    pub pending_reasoning_tokens: u64,
    #[serde(default)]
    pub pending_output_tokens: u64,
    /// Grok `updates.jsonl` bytes consumed.
    #[serde(default)]
    pub updates_offset: u64,
    #[serde(default)]
    pub last_stream_ms: i64,
    #[serde(default)]
    pub last_stream_tokens: u64,
    #[serde(default)]
    pub waiting_ts: i64,
    #[serde(default)]
    pub ttft_samples: u64,
    #[serde(default)]
    pub ttft_sum_ms: u64,
    /// Line totals already counted, including a scan of older bytes.
    /// A purge sets this so a zero total is not filled back in from history.
    #[serde(default)]
    pub lines_tracked: bool,
    /// Session line total at the last purge. Later signal files are cumulative,
    /// so the HUD shows only the growth above this baseline.
    #[serde(default)]
    pub lines_base_added: u64,
    #[serde(default)]
    pub lines_base_removed: u64,
    /// Child transcripts already followed for this pane. Keyed by transcript path.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub children: HashMap<String, Cursor>,
    /// Set on a child cursor. Full subagent id, not the parent's.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub agent_id: String,
    /// Task title or role for `agent_id`.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub agent_label: String,
    /// Claude parent bytes already scanned for sidechain records.
    /// Independent of `offset`, which still skips those records.
    #[serde(default, skip_serializing_if = "zero_u64")]
    pub side_offset: u64,
    /// Bytes scanned for spawned conversation ids. Independent of `offset`.
    #[serde(default, skip_serializing_if = "zero_u64")]
    pub spawn_offset: u64,
    /// Roles seen on an Antigravity spawn call, waiting for the result line.
    #[serde(default, skip_serializing_if = "VecDeque::is_empty")]
    pub pending_roles: VecDeque<String>,
    /// Subagents named by a parent transcript, including ones not on disk yet.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub spawned: Vec<Spawned>,
    /// Claude agent ids already imported from the parent sidechain.
    /// A later agent file for one of these ids is followed from its end.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub side_ids: Vec<String>,
    /// Tool-pairing state for Claude sidechain lines. Kept off the parent cursor
    /// so a child tool result cannot close a parent tool call.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sidechain: Option<Box<Cursor>>,
}

fn zero_u64(value: &u64) -> bool {
    *value == 0
}

/// One child conversation discovered from a parent transcript.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Spawned {
    pub id: String,
    pub label: String,
    pub path: String,
}

impl Cursor {
    /// Drop captured totals. File offsets stay so the next read continues
    /// at the end instead of importing the transcript again.
    pub fn mark_purged(&mut self) {
        self.lines_base_added = self.lines_base_added.saturating_add(self.lines_added);
        self.lines_base_removed = self.lines_base_removed.saturating_add(self.lines_removed);
        self.lines_added = 0;
        self.lines_removed = 0;
        self.lines_tracked = true;
        self.ctx_used = 0;
        self.ttft_ms = 0;
        self.ttft_samples = 0;
        self.ttft_sum_ms = 0;
        self.pending_reasoning_tokens = 0;
        self.pending_output_tokens = 0;
        self.tool_ts.clear();
        self.turn_ts.clear();
        self.pending.clear();
        self.agy_turn_open = false;
        self.turn_start = 0;
        self.waiting_ts = 0;
        self.last_stream_ms = 0;
        self.last_stream_tokens = 0;
        for child in self.children.values_mut() {
            child.mark_purged();
        }
        if let Some(side) = self.sidechain.as_mut() {
            side.mark_purged();
        }
    }
}

/// First 8 characters of the Grok session directory or the Claude file stem.
pub fn source_id(kind: CliKind, path: &Path) -> String {
    let raw = match kind {
        CliKind::Grok => path
            .parent()
            .and_then(Path::file_name)
            .map(|name| name.to_string_lossy().into_owned()),
        CliKind::Claude => path
            .file_stem()
            .map(|name| name.to_string_lossy().into_owned()),
        // `brain/<conversation-id>/.system_generated/logs/transcript.jsonl`
        CliKind::Antigravity => path
            .parent()
            .and_then(Path::parent)
            .and_then(Path::parent)
            .and_then(Path::file_name)
            .map(|name| name.to_string_lossy().into_owned()),
    }
    .unwrap_or_default();
    raw.chars().take(8).collect()
}

/// Parent transcript only. Live Stats adds child agents on top of `ingest_one`.
/// Unit tests keep this path so a parent fixture stays parent-only.
#[cfg(test)]
fn ingest(kind: CliKind, path: &Path, cur: &mut Cursor, now: i64) -> Vec<Event> {
    let src = source_id(kind, path);
    let mut out = ingest_one(kind, path, cur, now, false);
    for event in &mut out {
        event.s.clone_from(&src);
        event.cli = kind.as_str().to_string();
    }
    out.sort_by_key(|event| event.t);
    out
}

/// Read one transcript. `keep_sidechain` is for a Claude agent file, whose
/// records are the subagent's own steps. The parent transcript leaves this
/// false and picks those steps up separately so they are not mixed in twice.
pub(super) fn ingest_one(
    kind: CliKind,
    path: &Path,
    cur: &mut Cursor,
    now: i64,
    keep_sidechain: bool,
) -> Vec<Event> {
    match kind {
        CliKind::Grok => ingest_grok(path, cur, now),
        CliKind::Claude => ingest_claude(path, cur, now, keep_sidechain),
        CliKind::Antigravity => ingest_agy(path, cur, now),
    }
}

/// Complete lines appended after `offset`. Returns the lines and the new offset.
/// A file that shrank was rewritten; skip to its end rather than import twice.
pub(super) fn read_new_lines(path: &Path, offset: u64, max: u64) -> Option<(Vec<Vec<u8>>, u64)> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.file_type().is_file() {
        return None;
    }
    let len = meta.len();
    if len < offset {
        return Some((Vec::new(), len));
    }
    if len == offset {
        return Some((Vec::new(), offset));
    }
    let mut file = File::open(path).ok()?;
    file.seek(SeekFrom::Start(offset)).ok()?;
    let mut buf = Vec::new();
    file.take(max).read_to_end(&mut buf).ok()?;
    let Some(last_nl) = buf.iter().rposition(|&b| b == b'\n') else {
        // One line longer than a whole read cannot be parsed. Step over it.
        if buf.len() as u64 >= max {
            return Some((Vec::new(), offset + buf.len() as u64));
        }
        return Some((Vec::new(), offset));
    };
    let consumed = &buf[..=last_nl];
    let lines = consumed
        .split(|&b| b == b'\n')
        .filter(|line| !line.is_empty())
        .map(<[u8]>::to_vec)
        .collect();
    Some((lines, offset + consumed.len() as u64))
}

pub(super) fn parse_obj(line: &[u8]) -> Option<Map<String, Value>> {
    match serde_json::from_slice::<Value>(line).ok()? {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

fn str_of<'a>(obj: &'a Map<String, Value>, key: &str) -> &'a str {
    obj.get(key).and_then(Value::as_str).unwrap_or("")
}

fn u64_of(obj: &Map<String, Value>, key: &str) -> u64 {
    obj.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn i64_of(obj: &Map<String, Value>, key: &str) -> Option<i64> {
    obj.get(key).and_then(Value::as_i64)
}

fn mtime_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn sibling(path: &Path, name: &str) -> Option<std::path::PathBuf> {
    let file = path.parent()?.join(name);
    let meta = std::fs::symlink_metadata(&file).ok()?;
    meta.file_type().is_file().then_some(file)
}

pub(super) fn read_small_json(path: &Path, cap: u64) -> Option<Map<String, Value>> {
    let file = File::open(path).ok()?;
    match serde_json::from_reader::<_, Value>(file.take(cap)).ok()? {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

/// A body preview: trimmed, capped, with the full length kept separately.
fn body(text: &str, cap: usize) -> (String, u64) {
    let trimmed = text.trim();
    (truncate_chars(trimmed, cap), trimmed.chars().count() as u64)
}

fn fill_tool(ev: &mut Event, args: &Value) {
    ev.a = truncate_chars(&args_summary(args), ARG_CAP);
    let detail = args_detail(args);
    (ev.b, ev.c) = body(&detail, DETAIL_CAP);
}

fn push_queue(queue: &mut VecDeque<i64>, ev_count: &mut u64, chat_count: u64, ts: i64) {
    // Chat already consumed this index with a fallback time. Do not queue it.
    if *ev_count >= chat_count {
        queue.push_back(ts);
        while queue.len() > QUEUE_CAP {
            queue.pop_front();
        }
    }
    *ev_count += 1;
}

fn pop_queue(queue: &mut VecDeque<i64>, chat_count: &mut u64, fallback: i64) -> i64 {
    *chat_count += 1;
    queue.pop_front().unwrap_or(fallback)
}

pub fn estimate_tokens(text: &str) -> u64 {
    let t = text.trim();
    if t.is_empty() {
        return 0;
    }
    let chars = t.chars().count();
    chars.div_ceil(4).max(1) as u64
}

fn count_lines(text: &str) -> u64 {
    if text.is_empty() {
        return 0;
    }
    text.split('\n').count() as u64
}

fn str_of_any(obj: &Value, keys: &[&str]) -> String {
    let Some(map) = obj.as_object() else {
        return String::new();
    };
    for key in keys {
        if let Some(val) = map.get(*key) {
            match val {
                Value::String(s) => {
                    if s.starts_with('"') && s.ends_with('"') && s.len() >= 2 {
                        if let Ok(unquoted) = serde_json::from_str::<String>(s) {
                            return unquoted;
                        }
                        return s[1..s.len() - 1].to_string();
                    }
                    return s.clone();
                }
                Value::Array(arr) => {
                    let parts: Vec<String> = arr
                        .iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect();
                    if !parts.is_empty() {
                        return parts.join("\n");
                    }
                }
                _ => {}
            }
        }
    }
    String::new()
}

/// Tool names that block on the user. Compare case-insensitively.
const ASK_TOOLS: &[&str] = &[
    "askuserquestion", // Claude Code
    "exitplanmode",    // Claude Code plan approval
    "ask_question",    // Antigravity
    "ask_user",
    "request_user_input",
    "notify_user", // defensive, for Grok and Antigravity variants
];

fn is_ask_tool(name: &str) -> bool {
    ASK_TOOLS.iter().any(|tool| name.eq_ignore_ascii_case(tool))
}

/// Question text for an ask tool: `question`, `questions[0].question`, `plan`, `message`, or `prompt`.
fn ask_text(args: &Value) -> String {
    let question = str_of_any(args, &["question"]);
    if !question.is_empty() {
        return question;
    }
    if let Some(first) = args
        .get("questions")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
    {
        let nested = str_of_any(first, &["question"]);
        if !nested.is_empty() {
            return nested;
        }
    }
    str_of_any(args, &["plan", "message", "prompt"])
}

/// Extra marker next to a TOOL event. The TOOL event itself stays, so tool counts do not change.
fn emit_ask(out: &mut Vec<Event>, ts: i64, name: &str, args: &Value, g: &str, h: &str) {
    if !is_ask_tool(name) {
        return;
    }
    let mut ask = Event::new(ts, event::ASK);
    ask.n = name.to_string();
    (ask.b, ask.c) = body(&ask_text(args), DETAIL_CAP);
    ask.g = g.to_string();
    ask.h = h.to_string();
    out.push(ask);
}

fn get_args_value<'a>(val: &'a Value, buf: &'a mut Option<Value>) -> &'a Value {
    if let Value::String(s) = val {
        if let Ok(parsed) = serde_json::from_str::<Value>(s) {
            *buf = Some(parsed);
            return buf.as_ref().unwrap();
        }
    }
    val
}

fn track_tool_code_delta(tool_name: &str, args: &Value, cur: &mut Cursor) {
    let name_lower = tool_name.to_ascii_lowercase();
    match name_lower.as_str() {
        "replace_file_content"
        | "edit"
        | "edit_file"
        | "str_replace_editor"
        | "str_replace"
        | "search_replace" => {
            let old_str = str_of_any(
                args,
                &[
                    "Target",
                    "target",
                    "TargetContent",
                    "target_content",
                    "targetContent",
                    "old_string",
                    "old_str",
                    "oldstr",
                    "search",
                ],
            );
            let new_str = str_of_any(
                args,
                &[
                    "Replacement",
                    "replacement",
                    "ReplacementContent",
                    "replacement_content",
                    "replacementContent",
                    "new_string",
                    "new_str",
                    "newstr",
                    "replace",
                ],
            );
            if !old_str.is_empty() {
                cur.lines_removed += count_lines(&old_str);
            }
            if !new_str.is_empty() {
                cur.lines_added += count_lines(&new_str);
            }
        }
        "write_to_file" | "write" | "write_file" | "create_file" => {
            let content = str_of_any(
                args,
                &[
                    "Content",
                    "CodeContent",
                    "code_content",
                    "codeContent",
                    "content",
                    "file_text",
                    "text",
                ],
            );
            if !content.is_empty() {
                cur.lines_added += count_lines(&content);
            }
        }
        "patch" | "apply_patch" => {
            let patch = str_of_any(args, &["patch", "diff"]);
            for line in patch.lines() {
                if line.starts_with('+') && !line.starts_with("+++") {
                    cur.lines_added += 1;
                } else if line.starts_with('-') && !line.starts_with("---") {
                    cur.lines_removed += 1;
                }
            }
        }
        _ => {}
    }
}

// ---------------------------------------------------------------- Grok

fn ingest_grok(path: &Path, cur: &mut Cursor, now: i64) -> Vec<Event> {
    let mut out = Vec::new();

    // Default Grok context window and model if not already set
    if cur.ctx_window == 0 {
        cur.ctx_window = 256_000;
    }
    if cur.model.is_empty() {
        cur.model = "grok-4.7".to_string();
    }

    // Older cursors consumed the chat file before line totals existed.
    // A purge also leaves offset > 0 and totals at 0, and must not rescan.
    if !cur.lines_tracked && cur.lines_added == 0 && cur.lines_removed == 0 && cur.offset > 0 {
        if let Ok(file) = File::open(path) {
            let reader = BufReader::new(file.take(cur.offset));
            for line in reader.lines().map_while(Result::ok) {
                if let Some(obj) = parse_obj(line.as_bytes()) {
                    if str_of(&obj, "type") == "assistant" {
                        if let Some(calls) = obj.get("tool_calls").and_then(Value::as_array) {
                            for call in calls {
                                let name = call.get("name").and_then(Value::as_str).unwrap_or("");
                                let args = call
                                    .get("arguments")
                                    .or_else(|| call.get("args"))
                                    .unwrap_or(&Value::Null);
                                let mut args_buf = None;
                                let parsed_args = get_args_value(args, &mut args_buf);
                                track_tool_code_delta(name, parsed_args, cur);
                            }
                        }
                    }
                }
            }
            cur.lines_tracked = true;
        }
    }

    if let Some(events) = sibling(path, "events.jsonl") {
        if let Some((lines, next)) = read_new_lines(&events, cur.ev_offset, MAX_READ) {
            cur.ev_offset = next;
            for line in lines {
                if let Some(obj) = parse_obj(&line) {
                    grok_event(&obj, cur, &mut out);
                }
            }
        }
    }
    let has_usage = sibling(path, "usage.json").is_some();
    if let Some(updates) = sibling(path, "updates.jsonl") {
        grok_updates(&updates, cur, now, !has_usage, &mut out);
    }
    if let Some(usage) = sibling(path, "usage.json") {
        grok_usage(&usage, cur, now, &mut out);
    }
    if let Some(signals) = sibling(path, "signals.json") {
        grok_signals(&signals, cur);
    }
    let modified = mtime_ms(path) as i64;
    let live = cur.offset > 0 && now - modified < LIVE_MS;
    if let Some((lines, next)) = read_new_lines(path, cur.offset, MAX_READ) {
        cur.offset = next;
        for line in lines {
            if let Some(obj) = parse_obj(&line) {
                grok_chat(&obj, cur, live, now, modified, &mut out);
            }
        }
    }
    out
}

fn grok_event(obj: &Map<String, Value>, cur: &mut Cursor, out: &mut Vec<Event>) {
    let Some(ts) = parse_iso_ms(str_of(obj, "ts")) else {
        return;
    };
    cur.last_ts = cur.last_ts.max(ts);
    match str_of(obj, "type") {
        "turn_started" => {
            cur.turn_start = ts;
            push_queue(&mut cur.turn_ts, &mut cur.turns_ev, cur.turns_chat, ts);
            let model = str_of(obj, "model_id");
            if !model.is_empty() && cur.model.is_empty() {
                cur.model = model.to_string();
            }
        }
        "turn_ended" => {
            let mut ev = Event::new(ts, event::TURN);
            if cur.turn_start > 0 && ts >= cur.turn_start {
                ev.ms = (ts - cur.turn_start) as u64;
            }
            let outcome = str_of(obj, "outcome");
            ev.err = !outcome.is_empty() && outcome != "completed";
            ev.a = outcome.to_string();
            cur.turn_start = 0;
            out.push(ev);
        }
        "phase_changed" => {
            if str_of(obj, "phase") == "waiting_for_model" {
                cur.waiting_ts = ts;
            }
        }
        "first_token" => {
            if cur.waiting_ts > 0 && ts >= cur.waiting_ts {
                let diff = (ts - cur.waiting_ts) as u64;
                cur.ttft_sum_ms += diff;
                cur.ttft_samples += 1;
                cur.ttft_ms = cur.ttft_sum_ms / cur.ttft_samples;
                cur.waiting_ts = 0;
            }
        }
        "tool_started" => {
            push_queue(&mut cur.tool_ts, &mut cur.tools_ev, cur.tools_chat, ts);
        }
        "tool_completed" => {
            let mut ev = Event::new(ts, event::DONE);
            ev.n = str_of(obj, "tool_name").to_string();
            ev.ms = u64_of(obj, "duration_ms");
            let outcome = str_of(obj, "outcome");
            ev.err = !outcome.is_empty() && outcome != "success";
            out.push(ev);
        }
        _ => {}
    }
}

fn grok_updates(path: &Path, cur: &mut Cursor, _now: i64, emit_usage: bool, out: &mut Vec<Event>) {
    let Some((lines, next)) = read_new_lines(path, cur.updates_offset, MAX_READ) else {
        return;
    };
    cur.updates_offset = next;
    for line in lines {
        let Some(obj) = parse_obj(&line) else {
            continue;
        };
        let params = match obj.get("params").and_then(Value::as_object) {
            Some(p) => p,
            None => continue,
        };
        let meta = match params.get("_meta").and_then(Value::as_object) {
            Some(m) => m,
            None => continue,
        };

        let total_tokens = u64_of(meta, "totalTokens");
        if total_tokens > 0 {
            cur.ctx_used = cur.ctx_used.max(total_tokens);
            if cur.ctx_window == 0 {
                cur.ctx_window = 256_000;
            }
        }

        if cur.model.is_empty() || cur.model == "grok-4.7" {
            let model_id = str_of(meta, "modelId");
            if !model_id.is_empty() {
                cur.model = model_id.to_string();
            } else if let Some(u_meta) = params
                .get("update")
                .and_then(|u| u.get("_meta"))
                .and_then(Value::as_object)
            {
                let m = str_of(u_meta, "modelId");
                if !m.is_empty() {
                    cur.model = m.to_string();
                }
            }
        }

        let stream_start_ms = i64_of(meta, "streamStartMs");
        if let Some(ss) = stream_start_ms {
            if ss > 0 && ss != cur.last_stream_ms && total_tokens > 0 {
                let cached = cur.last_stream_tokens.min(total_tokens);
                let non_cached = total_tokens.saturating_sub(cached);
                let reasoning = cur.pending_reasoning_tokens;
                let output = cur.pending_output_tokens;
                cur.pending_reasoning_tokens = 0;
                cur.pending_output_tokens = 0;

                if emit_usage {
                    let mut ev = Event::new(ss, event::USAGE);
                    ev.ti = non_cached;
                    ev.tc = cached;
                    ev.tw = 0;
                    ev.tr = reasoning;
                    ev.to = output;
                    ev.n = if !cur.model.is_empty() {
                        cur.model.clone()
                    } else {
                        "grok-4.7".to_string()
                    };
                    ev.c = 1;
                    out.push(ev);
                }

                cur.last_stream_ms = ss;
                cur.last_stream_tokens = total_tokens;
            } else if total_tokens > cur.last_stream_tokens {
                cur.last_stream_tokens = total_tokens;
            }
        }

        if emit_usage {
            if let Some(update) = params.get("update").and_then(Value::as_object) {
                let session_update = str_of(update, "sessionUpdate");
                if session_update == "agent_message_chunk"
                    || session_update == "agent_thought_chunk"
                {
                    if let Some(content) = update.get("content").and_then(Value::as_object) {
                        if let Some(text) = content.get("text").and_then(Value::as_str) {
                            let est = estimate_tokens(text);
                            if session_update == "agent_thought_chunk" {
                                cur.pending_reasoning_tokens += est;
                                if let Some(last_ev) = out
                                    .last_mut()
                                    .filter(|e| e.k == event::USAGE && e.t == cur.last_stream_ms)
                                {
                                    last_ev.tr += est;
                                    cur.pending_reasoning_tokens =
                                        cur.pending_reasoning_tokens.saturating_sub(est);
                                }
                            } else {
                                cur.pending_output_tokens += est;
                                if let Some(last_ev) = out
                                    .last_mut()
                                    .filter(|e| e.k == event::USAGE && e.t == cur.last_stream_ms)
                                {
                                    last_ev.to += est;
                                    cur.pending_output_tokens =
                                        cur.pending_output_tokens.saturating_sub(est);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

fn grok_usage(path: &Path, cur: &mut Cursor, now: i64, out: &mut Vec<Event>) {
    let mtime = mtime_ms(path);
    if mtime == cur.usage_mtime {
        return;
    }
    let Some(obj) = read_small_json(path, 8 * 1024 * 1024) else {
        return;
    };
    cur.usage_mtime = mtime;
    if let Some(session) = obj.get("session").and_then(Value::as_object) {
        cur.cost_ledger = grok_cost_ledger(session);
    }
    let Some(turns) = obj.get("turns").and_then(Value::as_array) else {
        return;
    };
    if turns.len() < cur.usage_turns {
        cur.usage_turns = turns.len();
    }
    for turn in &turns[cur.usage_turns..] {
        let Some(turn) = turn.as_object() else {
            continue;
        };
        let ts = parse_iso_ms(str_of(turn, "endedAt")).unwrap_or(now);
        let mut ev = Event::new(ts, event::USAGE);
        let input_tokens = u64_of(turn, "inputTokens");
        let cached_read = u64_of(turn, "cachedReadTokens");
        ev.ti = input_tokens.saturating_sub(cached_read);
        ev.to = u64_of(turn, "outputTokens");
        ev.tc = cached_read;
        ev.tw = u64_of(turn, "cacheCreationTokens");
        let rep_reasoning = u64_of(turn, "reasoningTokens");
        if rep_reasoning > 0 {
            ev.tr = rep_reasoning;
            cur.pending_reasoning_tokens = 0;
        } else if cur.pending_reasoning_tokens > 0 {
            ev.tr = cur.pending_reasoning_tokens;
            cur.pending_reasoning_tokens = 0;
        }
        let model = str_of(turn, "primaryModelId");
        ev.n = if !model.is_empty() {
            model.to_string()
        } else if !cur.model.is_empty() {
            cur.model.clone()
        } else {
            "grok-4.7".to_string()
        };
        ev.c = u64_of(turn, "modelCalls").max(1);
        if !ev.n.is_empty() {
            cur.model.clone_from(&ev.n);
        }
        out.push(ev);
    }
    cur.usage_turns = turns.len();
}

fn grok_signals(path: &Path, cur: &mut Cursor) {
    let mtime = mtime_ms(path);
    if mtime == cur.signals_mtime {
        return;
    }
    let Some(obj) = read_small_json(path, 1024 * 1024) else {
        return;
    };
    cur.signals_mtime = mtime;
    cur.ctx_used = u64_of(&obj, "contextTokensUsed");
    cur.ctx_window = u64_of(&obj, "contextWindowTokens");
    cur.ttft_ms = u64_of(&obj, "avgTimeToFirstTokenMs");
    let sig_added = u64_of(&obj, "agentLinesAdded");
    let sig_removed = u64_of(&obj, "agentLinesRemoved");
    if sig_added > 0 || sig_removed > 0 {
        // The signal file is the whole session. After a purge, show only
        // the lines added once the stored totals were wiped.
        let added = sig_added.saturating_sub(cur.lines_base_added);
        let removed = sig_removed.saturating_sub(cur.lines_base_removed);
        cur.lines_added = cur.lines_added.max(added);
        cur.lines_removed = cur.lines_removed.max(removed);
    }
}

fn grok_chat(
    obj: &Map<String, Value>,
    cur: &mut Cursor,
    live: bool,
    now: i64,
    modified: i64,
    out: &mut Vec<Event>,
) {
    let fallback = |cur: &Cursor| -> i64 {
        if live {
            cur.last_ts.max(now)
        } else if cur.last_ts > 0 {
            cur.last_ts
        } else {
            modified
        }
    };
    match str_of(obj, "type") {
        "user" => {
            if obj.get("synthetic_reason").is_some_and(|v| !v.is_null()) {
                return;
            }
            let raw = text_from_value(obj.get("content").unwrap_or(&Value::Null));
            let query = extract_user_query(&raw);
            if query.is_empty() || noise_prompt(&query) {
                return;
            }
            let base = fallback(cur);
            let ts = pop_queue(&mut cur.turn_ts, &mut cur.turns_chat, base);
            cur.last_ts = cur.last_ts.max(ts);
            let mut ev = Event::new(ts, event::USER);
            (ev.b, ev.c) = body(&query, USER_CAP);
            out.push(ev);
        }
        "reasoning" => {
            let text = reasoning_text(obj);
            // An empty summary leaves only `encrypted_content`, which is not
            // the reasoning text. Skip it instead of logging a blank think row.
            if text.trim().is_empty() {
                return;
            }
            let mut ev = Event::new(fallback(cur), event::THINK);
            (ev.b, ev.c) = body(&text, THINK_CAP);
            cur.pending_reasoning_tokens += estimate_tokens(&text);
            out.push(ev);
        }
        "assistant" => {
            let model = str_of(obj, "model_id").to_string();
            if !model.is_empty() {
                cur.model.clone_from(&model);
            }
            let mut tools = Vec::new();
            if let Some(calls) = obj.get("tool_calls").and_then(Value::as_array) {
                for call in calls {
                    let base = fallback(cur);
                    let ts = pop_queue(&mut cur.tool_ts, &mut cur.tools_chat, base);
                    cur.last_ts = cur.last_ts.max(ts);
                    let mut ev = Event::new(ts, event::TOOL);
                    ev.n = call
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("tool")
                        .to_string();
                    let args = call
                        .get("arguments")
                        .or_else(|| call.get("args"))
                        .unwrap_or(&Value::Null);
                    let mut args_buf = None;
                    let parsed_args = get_args_value(args, &mut args_buf);
                    track_tool_code_delta(&ev.n, parsed_args, cur);
                    fill_tool(&mut ev, args);
                    let ask_name = ev.n.clone();
                    let ask_g = ev.g.clone();
                    let ask_h = ev.h.clone();
                    let ask_ts = ev.t;
                    tools.push(ev);
                    // Grok buffers tool rows, then extends `out`. The marker
                    // stays in that buffer so it follows its TOOL event.
                    emit_ask(&mut tools, ask_ts, &ask_name, parsed_args, &ask_g, &ask_h);
                }
            }
            let text = text_from_value(obj.get("content").unwrap_or(&Value::Null));
            if !text.trim().is_empty() {
                let ts = tools
                    .first()
                    .map(|ev| ev.t)
                    .unwrap_or_else(|| fallback(cur));
                let mut ev = Event::new(ts, event::REPLY);
                (ev.b, ev.c) = body(&text, REPLY_CAP);
                ev.n = model;
                out.push(ev);
            }
            out.extend(tools);
        }
        "tool_result" => {
            let raw = text_from_value(obj.get("content").unwrap_or(&Value::Null));
            let mut ev = Event::new(fallback(cur), event::RESULT);
            (ev.b, ev.c) = body(&raw, RESULT_CAP);
            out.push(ev);
        }
        _ => {}
    }
}

// ---------------------------------------------------------------- Claude

fn ingest_claude(path: &Path, cur: &mut Cursor, now: i64, keep_sidechain: bool) -> Vec<Event> {
    let mut out = Vec::new();
    let modified = mtime_ms(path) as i64;
    if let Some((lines, next)) = read_new_lines(path, cur.offset, MAX_READ) {
        cur.offset = next;
        for line in lines {
            if let Some(obj) = parse_obj(&line) {
                let fallback = if cur.last_ts > 0 {
                    cur.last_ts
                } else {
                    modified.min(now)
                };
                claude_record(&obj, cur, fallback, keep_sidechain, &mut out);
            }
        }
    }
    out
}

/// Sidechain lines from the parent Claude transcript whose agent has no
/// `subagents/agent-<id>.jsonl` file yet. Ids in `skip` are read from that file
/// instead, so the same step is not stored twice.
pub(super) fn pull_claude_sidechain(
    path: &Path,
    cur: &mut Cursor,
    now: i64,
    skip: &HashSet<String>,
) -> Vec<Event> {
    let mut out = Vec::new();
    let Some((lines, next)) = read_new_lines(path, cur.side_offset, MAX_READ) else {
        return out;
    };
    cur.side_offset = next;
    let parent_ts = cur.last_ts;
    let mut noted = Vec::new();
    {
        let side = cur
            .sidechain
            .get_or_insert_with(|| Box::new(Cursor::default()));
        for line in lines {
            let Some(obj) = parse_obj(&line) else {
                continue;
            };
            if obj.get("isSidechain").and_then(Value::as_bool) != Some(true) {
                continue;
            }
            let id = claude_agent_id(&obj);
            if id.is_empty() || skip.contains(&id) || !agent_id_ok(&id) {
                continue;
            }
            let fallback = if side.last_ts > 0 {
                side.last_ts
            } else if parent_ts > 0 {
                parent_ts
            } else {
                now
            };
            let from = out.len();
            claude_record(&obj, side, fallback, true, &mut out);
            let label = claude_agent_label(&obj);
            for event in &mut out[from..] {
                event.g.clone_from(&id);
                if event.h.is_empty() {
                    event.h.clone_from(&label);
                }
            }
            noted.push(id);
        }
    }
    for id in noted {
        if !cur.side_ids.iter().any(|seen| seen == &id) && cur.side_ids.len() < 128 {
            cur.side_ids.push(id);
        }
    }
    out
}

pub(super) fn agent_id_ok(id: &str) -> bool {
    let n = id.len();
    (8..=80).contains(&n)
        && !id.contains("..")
        && !id.starts_with('.')
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn claude_agent_id(obj: &Map<String, Value>) -> String {
    for key in ["agentId", "agent_id", "subagentId", "subagent_id"] {
        let text = str_of(obj, key).trim();
        if agent_id_ok(text) {
            return text.to_string();
        }
    }
    String::new()
}

fn claude_agent_label(obj: &Map<String, Value>) -> String {
    for key in ["subagent_type", "subagentType", "agentType", "agent_type"] {
        let text = str_of(obj, key).trim();
        if !text.is_empty() {
            return clip_label(text);
        }
    }
    String::new()
}

pub(super) fn clip_label(text: &str) -> String {
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    flat.chars().take(80).collect()
}

fn claude_record(
    obj: &Map<String, Value>,
    cur: &mut Cursor,
    fallback: i64,
    keep_sidechain: bool,
    out: &mut Vec<Event>,
) {
    let sidechain = obj.get("isSidechain").and_then(Value::as_bool) == Some(true);
    if sidechain && !keep_sidechain {
        return;
    }
    let ts = parse_iso_ms(str_of(obj, "timestamp")).unwrap_or(fallback);
    cur.last_ts = cur.last_ts.max(ts);
    let meta = obj.get("isMeta").and_then(Value::as_bool) == Some(true);
    match str_of(obj, "type") {
        "cost-state" => {
            if let Some(ledger) = claude_cost_ledger(obj) {
                cur.cost_ledger = ledger;
            }
        }
        "system" => {
            if str_of(obj, "subtype") == "turn_duration" {
                // Wall clock for one user turn, including tool calls.
                // `durationMs` feeds the average. `messageCount` is how many
                // messages that turn contained.
                let mut ev = Event::new(ts, event::TURN);
                ev.ms = u64_of(obj, "durationMs");
                let messages = u64_of(obj, "messageCount");
                if messages == 1 {
                    ev.b = "1 message".into();
                } else if messages > 1 {
                    ev.b = format!("{messages} messages");
                }
                out.push(ev);
            }
        }
        "user" if !meta => {
            let Some(message) = obj.get("message").and_then(Value::as_object) else {
                return;
            };
            let content = message.get("content").unwrap_or(&Value::Null);
            let Some(blocks) = content.as_array() else {
                claude_prompt(&text_from_value(content), ts, out);
                return;
            };
            let mut text = Vec::new();
            for block in blocks {
                match block.get("type").and_then(Value::as_str).unwrap_or("") {
                    "text" => {
                        if let Some(piece) = block.get("text").and_then(Value::as_str) {
                            text.push(piece.to_string());
                        }
                    }
                    "tool_result" => claude_result(block, cur, ts, out),
                    _ => {}
                }
            }
            claude_prompt(&text.join("\n"), ts, out);
        }
        "assistant" if !meta => {
            let Some(message) = obj.get("message").and_then(Value::as_object) else {
                return;
            };
            let model = str_of(message, "model").to_string();
            let synthetic = model.starts_with('<');
            if !model.is_empty() && !synthetic {
                cur.model.clone_from(&model);
            }
            let content = message.get("content").unwrap_or(&Value::Null);
            match content.as_array() {
                Some(blocks) => {
                    for block in blocks {
                        claude_block(block, &model, cur, ts, out);
                    }
                }
                None => {
                    let text = text_from_value(content);
                    if !text.trim().is_empty() {
                        let mut ev = Event::new(ts, event::REPLY);
                        (ev.b, ev.c) = body(&text, REPLY_CAP);
                        ev.n.clone_from(&model);
                        out.push(ev);
                    }
                }
            }
            let id = str_of(message, "id").to_string();
            if let Some(usage) = message.get("usage").and_then(Value::as_object) {
                if !synthetic && (id.is_empty() || id != cur.last_msg) {
                    let input = u64_of(usage, "input_tokens");
                    let read = u64_of(usage, "cache_read_input_tokens");
                    let write = u64_of(usage, "cache_creation_input_tokens");
                    let explicit_reasoning = explicit_num(
                        usage,
                        &[
                            "reasoning_tokens",
                            "reasoningTokens",
                            "thinking_tokens",
                            "thinkingTokens",
                        ],
                    );
                    let reasoning_val = explicit_reasoning.unwrap_or(cur.pending_reasoning_tokens);
                    cur.pending_reasoning_tokens = 0;

                    let mut ev = Event::new(ts, event::USAGE);
                    ev.ti = input;
                    ev.tc = read;
                    ev.tw = write;
                    ev.to = u64_of(usage, "output_tokens");
                    ev.tr = reasoning_val;
                    ev.n.clone_from(&model);
                    ev.c = 1;
                    cur.ctx_used = input + read + write;
                    cur.ctx_window = CLAUDE_WINDOW;
                    out.push(ev);
                }
            }
            if !id.is_empty() {
                cur.last_msg = id;
            }
        }
        _ => {}
    }
}

fn claude_prompt(raw: &str, ts: i64, out: &mut Vec<Event>) {
    let query = extract_user_query(raw);
    if query.is_empty() || noise_prompt(&query) {
        return;
    }
    let mut ev = Event::new(ts, event::USER);
    (ev.b, ev.c) = body(&query, USER_CAP);
    out.push(ev);
}

/// Plain thinking text. An empty string plus a signature is Claude's
/// omitted-thinking shape. `redacted_thinking` stores ciphertext in `data`.
fn claude_thinking_text(block: &Value) -> String {
    if let Some(text) = block.get("thinking").and_then(Value::as_str) {
        let text = text.trim();
        if !text.is_empty() {
            return text.to_string();
        }
    }
    for key in ["summary", "text"] {
        if let Some(text) = block.get(key).and_then(Value::as_str) {
            let text = text.trim();
            if !text.is_empty() {
                return text.to_string();
            }
        }
    }
    String::new()
}

fn claude_block(block: &Value, model: &str, cur: &mut Cursor, ts: i64, out: &mut Vec<Event>) {
    match block.get("type").and_then(Value::as_str).unwrap_or("") {
        "thinking" | "redacted_thinking" => {
            let text = claude_thinking_text(block);
            // Newer Claude models persist thinking with an empty string and a
            // signature (`display: omitted`). The signature is not the text
            // and cannot be turned back into it. A blank row is noise.
            if text.is_empty() {
                return;
            }
            let mut ev = Event::new(ts, event::THINK);
            (ev.b, ev.c) = body(&text, THINK_CAP);
            cur.pending_reasoning_tokens += estimate_tokens(&text);
            out.push(ev);
        }
        "text" => {
            let text = block.get("text").and_then(Value::as_str).unwrap_or("");
            if text.trim().is_empty() {
                return;
            }
            let mut ev = Event::new(ts, event::REPLY);
            (ev.b, ev.c) = body(text, REPLY_CAP);
            ev.n = model.to_string();
            out.push(ev);
        }
        "tool_use" => {
            let name = block
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .to_string();
            let input = block.get("input").unwrap_or(&Value::Null);
            let mut args_buf = None;
            let parsed_args = get_args_value(input, &mut args_buf);
            track_tool_code_delta(&name, parsed_args, cur);
            let mut ev = Event::new(ts, event::TOOL);
            fill_tool(&mut ev, input);
            ev.n.clone_from(&name);
            if let Some(id) = block.get("id").and_then(Value::as_str) {
                if cur.pending.len() >= PENDING_CAP {
                    if let Some(oldest) = cur
                        .pending
                        .iter()
                        .min_by_key(|(_, (t, _))| *t)
                        .map(|(k, _)| k.clone())
                    {
                        cur.pending.remove(&oldest);
                    }
                }
                cur.pending.insert(id.to_string(), (ts, name.clone()));
            }
            let ask_g = ev.g.clone();
            let ask_h = ev.h.clone();
            out.push(ev);
            emit_ask(out, ts, &name, parsed_args, &ask_g, &ask_h);
        }
        _ => {}
    }
}

// ---------------------------------------------------------------- Antigravity

fn ingest_agy(path: &Path, cur: &mut Cursor, now: i64) -> Vec<Event> {
    let mut out = Vec::new();
    let mut saw_after = false;
    let Some((lines, next)) = read_new_lines(path, cur.offset, MAX_READ) else {
        return out;
    };
    cur.offset = next;
    for line in lines {
        let Some(obj) = parse_obj(&line) else {
            continue;
        };
        agy_step(&obj, cur, now, &mut saw_after, &mut out);
    }
    if saw_after {
        close_agy_turn(cur, &mut out);
    }
    out
}

/// One turn per open user prompt. Cleared when emitted so a later poll does not
/// emit it again.
fn close_agy_turn(cur: &mut Cursor, out: &mut Vec<Event>) {
    if !cur.agy_turn_open || cur.turn_start <= 0 || cur.last_ts < cur.turn_start {
        cur.agy_turn_open = false;
        return;
    }
    let mut ev = Event::new(cur.last_ts, event::TURN);
    ev.ms = cur.last_ts.saturating_sub(cur.turn_start) as u64;
    out.push(ev);
    cur.agy_turn_open = false;
}

fn agy_step(
    obj: &Map<String, Value>,
    cur: &mut Cursor,
    now: i64,
    saw_after: &mut bool,
    out: &mut Vec<Event>,
) {
    note_agy_cost(obj, cur);
    let record = str_of(obj, "type");
    if agy_bookkeeping(record) || history_blob_line(obj) {
        return;
    }
    // Close the previous turn before this prompt's timestamp replaces `last_ts`.
    if record == "USER_INPUT" && *saw_after {
        close_agy_turn(cur, out);
        *saw_after = false;
    }
    let ts = agy_timestamp(obj, cur, now);
    match record {
        "USER_INPUT" => {
            cur.turn_start = ts;
            cur.agy_turn_open = true;
            let raw = text_from_value(obj.get("content").unwrap_or(&Value::Null));
            let query = extract_user_query(&raw);
            if query.is_empty() || noise_prompt(&query) {
                return;
            }
            let mut ev = Event::new(ts, event::USER);
            (ev.b, ev.c) = body(&query, USER_CAP);
            out.push(ev);
        }
        "PLANNER_RESPONSE" => {
            if cur.agy_turn_open {
                *saw_after = true;
            }
            let thinking = str_of(obj, "thinking");
            if !thinking.trim().is_empty() {
                let mut ev = Event::new(ts, event::THINK);
                (ev.b, ev.c) = body(thinking, THINK_CAP);
                cur.pending_reasoning_tokens += estimate_tokens(thinking);
                out.push(ev);
            }
            let content = text_from_value(obj.get("content").unwrap_or(&Value::Null));
            if !content.trim().is_empty() {
                let mut ev = Event::new(ts, event::REPLY);
                (ev.b, ev.c) = body(&content, REPLY_CAP);
                let model = agy_model(obj);
                if !model.is_empty() {
                    ev.n.clone_from(&model);
                    cur.model.clone_from(&model);
                }
                out.push(ev);
            }
            if let Some(calls) = obj.get("tool_calls").and_then(Value::as_array) {
                for call in calls {
                    let name = call
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("tool")
                        .to_string();
                    let args = tool_args(call);
                    let mut args_buf = None;
                    let parsed_args = get_args_value(args, &mut args_buf);
                    track_tool_code_delta(&name, parsed_args, cur);
                    let mut ev = Event::new(ts, event::TOOL);
                    fill_tool(&mut ev, args);
                    ev.n.clone_from(&name);
                    let ask_g = ev.g.clone();
                    let ask_h = ev.h.clone();
                    out.push(ev);
                    emit_ask(out, ts, &name, parsed_args, &ask_g, &ask_h);
                    remember_agy_tool(cur, ts, name);
                }
            }
            agy_usage(obj, cur, ts, out);
        }
        _ if agy_tool_result(record) => {
            if str_of(obj, "source").eq_ignore_ascii_case("SYSTEM") {
                return;
            }
            if cur.agy_turn_open {
                *saw_after = true;
            }
            let raw = text_from_value(obj.get("content").unwrap_or(&Value::Null));
            let failed = agy_failed(obj);
            let mut ev = Event::new(ts, event::RESULT);
            (ev.b, ev.c) = body(&raw, RESULT_CAP);
            ev.err = failed;
            out.push(ev);
            if let Some((start, name)) = take_oldest_pending(cur) {
                let mut done = Event::new(ts, event::DONE);
                done.n = name;
                done.ms = ts.saturating_sub(start) as u64;
                done.err = failed;
                out.push(done);
            }
            agy_usage(obj, cur, ts, out);
        }
        _ => {}
    }
}

fn history_blob_line(obj: &Map<String, Value>) -> bool {
    let raw = text_from_value(obj.get("content").unwrap_or(&Value::Null));
    let head = raw.trim_start();
    head.starts_with("# Resuming from a compaction")
        || head.contains("<CONVERSATION_HISTORY>")
        || head.starts_with("The following is a conversation history")
}

fn agy_timestamp(obj: &Map<String, Value>, cur: &mut Cursor, now: i64) -> i64 {
    let ts = parse_iso_ms(str_of(obj, "created_at")).unwrap_or(if cur.last_ts > 0 {
        cur.last_ts
    } else {
        now
    });
    if ts > 0 {
        cur.last_ts = cur.last_ts.max(ts);
    }
    ts
}

fn agy_model(obj: &Map<String, Value>) -> String {
    for key in ["model", "model_id", "modelId", "primaryModelId"] {
        if let Some(text) = obj.get(key).and_then(Value::as_str) {
            let text = text.trim();
            if !text.is_empty() && !text.starts_with('<') {
                return text.to_string();
            }
        }
    }
    String::new()
}

fn agy_usage(obj: &Map<String, Value>, cur: &mut Cursor, ts: i64, out: &mut Vec<Event>) {
    let input = explicit_num(obj, &["input_tokens", "inputTokens"]);
    let output = explicit_num(obj, &["output_tokens", "outputTokens"]);
    let cache = explicit_num(
        obj,
        &["cache_read_tokens", "cacheReadTokens", "cachedReadTokens"],
    );
    let write = explicit_num(
        obj,
        &[
            "cache_write_tokens",
            "cacheWriteTokens",
            "cache_creation_input_tokens",
        ],
    );
    let explicit_reasoning = explicit_num(
        obj,
        &[
            "reasoning_tokens",
            "reasoningTokens",
            "thinking_tokens",
            "thinkingTokens",
            "thought_tokens",
            "thoughts_tokens",
        ],
    );
    let reasoning_val = explicit_reasoning.unwrap_or(cur.pending_reasoning_tokens);
    cur.pending_reasoning_tokens = 0;
    let model = agy_model(obj);
    if input.is_none()
        && output.is_none()
        && cache.is_none()
        && write.is_none()
        && explicit_reasoning.is_none()
        && reasoning_val == 0
        && model.is_empty()
    {
        return;
    }
    if !model.is_empty() {
        cur.model.clone_from(&model);
    }
    let mut ev = Event::new(ts, event::USAGE);
    ev.ti = input.unwrap_or(0);
    ev.to = output.unwrap_or(0);
    ev.tc = cache.unwrap_or(0);
    ev.tw = write.unwrap_or(0);
    ev.tr = reasoning_val;
    ev.n = model;
    ev.c = 1;
    if ev.ti > 0 {
        cur.ctx_used = ev.ti;
    }
    out.push(ev);
}

fn explicit_num(obj: &Map<String, Value>, keys: &[&str]) -> Option<u64> {
    for key in keys {
        let Some(value) = obj.get(*key) else {
            continue;
        };
        if let Some(number) = value.as_u64() {
            return Some(number);
        }
        if let Some(number) = value.as_i64() {
            if number >= 0 {
                return Some(number as u64);
            }
        }
    }
    None
}

pub(crate) fn agy_failed(obj: &Map<String, Value>) -> bool {
    let status = str_of(obj, "status");
    if status.eq_ignore_ascii_case("ERROR") || status.eq_ignore_ascii_case("INVALID") {
        return true;
    }
    match obj.get("error") {
        Some(Value::String(text)) => !text.trim().is_empty(),
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Object(_)) => true,
        _ => false,
    }
}

fn json_f64(value: f64) -> Option<Value> {
    serde_json::Number::from_f64(value).map(Value::Number)
}

fn f64_any(obj: &Map<String, Value>, keys: &[&str]) -> Option<f64> {
    for key in keys {
        let Some(value) = obj.get(*key) else {
            continue;
        };
        if let Some(number) = value.as_f64() {
            if number.is_finite() {
                return Some(number);
            }
        }
    }
    None
}

fn i64_any(obj: &Map<String, Value>, keys: &[&str]) -> Option<i64> {
    for key in keys {
        let Some(value) = obj.get(*key) else {
            continue;
        };
        if let Some(number) = value.as_i64() {
            return Some(number);
        }
        if let Some(number) = value.as_u64() {
            return i64::try_from(number).ok();
        }
    }
    None
}

fn flag_any(obj: &Map<String, Value>, keys: &[&str]) -> bool {
    keys.iter()
        .any(|key| obj.get(*key).and_then(Value::as_bool) == Some(true))
}

fn put_f64(obj: &mut Map<String, Value>, key: &str, value: Option<f64>) {
    if let Some(number) = value.and_then(json_f64) {
        obj.insert(key.to_string(), number);
    }
}

fn put_i64(obj: &mut Map<String, Value>, key: &str, value: Option<i64>) {
    if let Some(number) = value {
        obj.insert(key.to_string(), Value::from(number));
    }
}

/// Grok `usage.json` `session` object. `inputTokens` still include cached reads.
fn grok_cost_ledger(session: &Map<String, Value>) -> String {
    let mut ledger = Map::new();
    ledger.insert("provider".into(), Value::String("grok".into()));
    ledger.insert("inputIncludesCache".into(), Value::Bool(true));
    put_i64(
        &mut ledger,
        "costUsdTicks",
        i64_any(session, &["costUsdTicks", "cost_usd_ticks"]),
    );
    ledger.insert(
        "costIsPartial".into(),
        Value::Bool(flag_any(session, &["costIsPartial", "cost_is_partial"])),
    );
    ledger.insert(
        "usageIsIncomplete".into(),
        Value::Bool(flag_any(
            session,
            &["usageIsIncomplete", "usage_is_incomplete"],
        )),
    );
    ledger.insert(
        "inputTokens".into(),
        Value::from(u64_of(session, "inputTokens")),
    );
    ledger.insert(
        "outputTokens".into(),
        Value::from(u64_of(session, "outputTokens")),
    );
    ledger.insert(
        "cachedReadTokens".into(),
        Value::from(u64_of(session, "cachedReadTokens")),
    );
    ledger.insert(
        "cacheCreationTokens".into(),
        Value::from(u64_of(session, "cacheCreationTokens")),
    );
    ledger.insert(
        "reasoningTokens".into(),
        Value::from(u64_of(session, "reasoningTokens")),
    );
    let model = str_of(session, "primaryModelId");
    if !model.is_empty() {
        ledger.insert("model".into(), Value::String(model.to_string()));
    }
    if let Some(usage) = session.get("modelUsage").and_then(Value::as_object) {
        let mut models = Map::new();
        for (name, row) in usage {
            let Some(row) = row.as_object() else {
                continue;
            };
            let mut one = Map::new();
            put_i64(
                &mut one,
                "costUsdTicks",
                i64_any(row, &["costUsdTicks", "cost_usd_ticks"]),
            );
            one.insert(
                "inputTokens".into(),
                Value::from(u64_of(row, "inputTokens")),
            );
            one.insert(
                "outputTokens".into(),
                Value::from(u64_of(row, "outputTokens")),
            );
            one.insert(
                "cachedReadTokens".into(),
                Value::from(u64_of(row, "cachedReadTokens")),
            );
            one.insert(
                "cacheCreationTokens".into(),
                Value::from(u64_of(row, "cacheCreationTokens")),
            );
            models.insert(name.clone(), Value::Object(one));
        }
        if !models.is_empty() {
            ledger.insert("modelUsage".into(), Value::Object(models));
        }
    }
    Value::Object(ledger).to_string()
}

/// Latest Claude `cost-state`. `totalCostUSD` is `/usage`'s Total cost.
fn claude_cost_ledger(obj: &Map<String, Value>) -> Option<String> {
    let total = f64_any(obj, &["totalCostUSD", "total_cost_usd"])?;
    let mut ledger = Map::new();
    ledger.insert("provider".into(), Value::String("claude".into()));
    ledger.insert("inputIncludesCache".into(), Value::Bool(false));
    put_f64(&mut ledger, "totalCostUSD", Some(total));
    ledger.insert(
        "hasUnknownModelCost".into(),
        Value::Bool(flag_any(
            obj,
            &["hasUnknownModelCost", "has_unknown_model_cost"],
        )),
    );
    if let Some(usage) = obj.get("modelUsage").and_then(Value::as_object) {
        let mut models = Map::new();
        for (name, row) in usage {
            let Some(row) = row.as_object() else {
                continue;
            };
            let mut one = Map::new();
            put_f64(
                &mut one,
                "costUSD",
                f64_any(row, &["costUSD", "costUsd", "cost_usd"]),
            );
            one.insert(
                "inputTokens".into(),
                Value::from(u64_of(row, "inputTokens")),
            );
            one.insert(
                "outputTokens".into(),
                Value::from(u64_of(row, "outputTokens")),
            );
            one.insert(
                "cacheReadInputTokens".into(),
                Value::from(u64_of(row, "cacheReadInputTokens")),
            );
            one.insert(
                "cacheCreationInputTokens".into(),
                Value::from(u64_of(row, "cacheCreationInputTokens")),
            );
            models.insert(name.clone(), Value::Object(one));
        }
        if !models.is_empty() {
            ledger.insert("modelUsage".into(), Value::Object(models));
        }
    }
    Some(Value::Object(ledger).to_string())
}

fn agy_category(section: &Map<String, Value>, snake: &str, camel: &str) -> Option<Value> {
    let cat = section
        .get(snake)
        .or_else(|| section.get(camel))
        .and_then(Value::as_object)?;
    let mut out = Map::new();
    if let Some(tokens) = i64_any(cat, &["tokens"]) {
        if tokens >= 0 {
            out.insert("tokens".into(), Value::from(tokens));
        }
    }
    put_f64(
        &mut out,
        "estimatedCostUsd",
        f64_any(cat, &["estimated_cost_usd", "estimatedCostUsd"]),
    );
    if out.is_empty() {
        None
    } else {
        Some(Value::Object(out))
    }
}

fn agy_pricing(obj: &Map<String, Value>) -> Option<Value> {
    let pricing = obj
        .get("pricing")
        .and_then(Value::as_object)
        .or_else(|| obj.get("model_pricing").and_then(Value::as_object))?;
    let mut out = Map::new();
    put_f64(
        &mut out,
        "inputPricePerMillionTokens",
        f64_any(
            pricing,
            &[
                "input_price_per_million_tokens",
                "inputPricePerMillionTokens",
            ],
        ),
    );
    put_f64(
        &mut out,
        "outputPricePerMillionTokens",
        f64_any(
            pricing,
            &[
                "output_price_per_million_tokens",
                "outputPricePerMillionTokens",
            ],
        ),
    );
    put_f64(
        &mut out,
        "cacheReadPricePerMillionTokens",
        f64_any(
            pricing,
            &[
                "cache_read_price_per_million_tokens",
                "cacheReadPricePerMillionTokens",
            ],
        ),
    );
    let model = str_of(pricing, "model_name");
    let model = if model.is_empty() {
        str_of(pricing, "modelName")
    } else {
        model
    };
    if !model.is_empty() {
        out.insert("modelName".into(), Value::String(model.to_string()));
    }
    if out.is_empty() {
        None
    } else {
        Some(Value::Object(out))
    }
}

/// Antigravity `ConversationCostSummary`. The session figure is the cumulative
/// total, which already includes the turn and subagent cost when the CLI folded
/// them in. Quota percents are not copied.
fn agy_cost_ledger(summary: &Map<String, Value>) -> Option<String> {
    let total = summary.get("total").and_then(Value::as_object);
    let cumulative = total
        .and_then(|item| {
            item.get("cumulative_total")
                .or_else(|| item.get("cumulativeTotal"))
        })
        .and_then(Value::as_object)
        .or_else(|| {
            summary
                .get("cumulative_total")
                .or_else(|| summary.get("cumulativeTotal"))
                .and_then(Value::as_object)
        });
    let section = cumulative.unwrap_or(summary);
    let mut ledger = Map::new();
    ledger.insert("provider".into(), Value::String("antigravity".into()));
    ledger.insert("inputIncludesCache".into(), Value::Bool(false));
    put_f64(
        &mut ledger,
        "estimatedCostUsd",
        f64_any(section, &["estimated_cost_usd", "estimatedCostUsd"]),
    );
    let mut categories = Map::new();
    for (snake, camel, key) in [
        ("input", "input", "input"),
        ("cache_read", "cacheRead", "cacheRead"),
        ("output", "output", "output"),
        ("thinking", "thinking", "thinking"),
        ("tools", "tools", "tools"),
    ] {
        if let Some(category) = agy_category(section, snake, camel) {
            categories.insert(key.to_string(), category);
        }
    }
    if !categories.is_empty() {
        ledger.insert("categories".into(), Value::Object(categories));
    }
    if let Some(pricing) = agy_pricing(summary).or_else(|| agy_pricing(section)) {
        ledger.insert("pricing".into(), pricing);
    }
    let model = str_of(summary, "model");
    if !model.is_empty() {
        ledger.insert("model".into(), Value::String(model.to_string()));
    }
    if ledger.len() <= 2
        && !ledger.contains_key("estimatedCostUsd")
        && !ledger.contains_key("pricing")
    {
        return None;
    }
    Some(Value::Object(ledger).to_string())
}

fn note_agy_cost(obj: &Map<String, Value>, cur: &mut Cursor) {
    let summary = obj
        .get("cost_summary")
        .or_else(|| obj.get("costSummary"))
        .and_then(Value::as_object)
        .or_else(|| {
            if obj.contains_key("cumulative_total") || obj.contains_key("cumulativeTotal") {
                Some(obj)
            } else {
                None
            }
        });
    let Some(summary) = summary else {
        return;
    };
    if let Some(ledger) = agy_cost_ledger(summary) {
        cur.cost_ledger = ledger;
    }
}

fn remember_agy_tool(cur: &mut Cursor, ts: i64, name: String) {
    if cur.pending.len() >= PENDING_CAP {
        take_oldest_pending(cur);
    }
    cur.tools_chat = cur.tools_chat.saturating_add(1);
    cur.pending
        .insert(format!("agy-{}", cur.tools_chat), (ts, name));
}

fn take_oldest_pending(cur: &mut Cursor) -> Option<(i64, String)> {
    let oldest = cur
        .pending
        .iter()
        .min_by_key(|(_, (ts, _))| *ts)
        .map(|(id, _)| id.clone())?;
    cur.pending.remove(&oldest)
}

fn claude_result(block: &Value, cur: &mut Cursor, ts: i64, out: &mut Vec<Event>) {
    let raw = text_from_value(block.get("content").unwrap_or(&Value::Null));
    let failed = block.get("is_error").and_then(Value::as_bool) == Some(true);
    let mut ev = Event::new(ts, event::RESULT);
    (ev.b, ev.c) = body(&raw, RESULT_CAP);
    ev.err = failed;
    out.push(ev);
    let id = block
        .get("tool_use_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    if let Some((start, name)) = cur.pending.remove(id) {
        let mut done = Event::new(ts, event::DONE);
        done.n = name;
        done.ms = ts.saturating_sub(start).max(0) as u64;
        done.err = failed;
        out.push(done);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "sparkmux-analytics-ingest-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn kinds(events: &[Event]) -> Vec<&str> {
        events.iter().map(|e| e.k.as_str()).collect()
    }

    #[test]
    fn grok_aligns_tools_and_turns_with_events_file() {
        let dir = scratch("grok").join("01a12506-session");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("events.jsonl"),
            concat!(
                "{\"ts\":\"2026-10-10T08:55:25.000Z\",\"type\":\"turn_started\"}\n",
                "{\"ts\":\"2026-10-10T08:55:27.000Z\",\"type\":\"tool_started\",\"tool_name\":\"grep\"}\n",
                "{\"ts\":\"2026-10-10T08:55:27.014Z\",\"type\":\"tool_completed\",\"tool_name\":\"grep\",\"duration_ms\":14,\"outcome\":\"success\"}\n",
                "{\"ts\":\"2026-10-10T08:55:30.000Z\",\"type\":\"tool_started\",\"tool_name\":\"read_file\"}\n",
                "{\"ts\":\"2026-10-10T08:55:30.500Z\",\"type\":\"tool_completed\",\"tool_name\":\"read_file\",\"duration_ms\":500,\"outcome\":\"error\"}\n",
                "{\"ts\":\"2026-10-10T08:56:02.000Z\",\"type\":\"turn_ended\",\"outcome\":\"completed\"}\n",
            ),
        )
        .unwrap();
        fs::write(
            dir.join("usage.json"),
            r#"{"turns":[{"endedAt":"2026-10-10T08:56:02.853932+00:00","inputTokens":900,"outputTokens":30,"cachedReadTokens":500,"reasoningTokens":20,"primaryModelId":"grok-4.7-build","modelCalls":2}]}"#,
        )
        .unwrap();
        fs::write(
            dir.join("signals.json"),
            r#"{"contextTokensUsed":20011,"contextWindowTokens":256000,"avgTimeToFirstTokenMs":5692,"agentLinesAdded":7,"agentLinesRemoved":2}"#,
        )
        .unwrap();
        let chat = dir.join("chat_history.jsonl");
        fs::write(
            &chat,
            concat!(
                "{\"type\":\"system\",\"content\":\"You are Grok\"}\n",
                "{\"type\":\"user\",\"synthetic_reason\":\"mcp\",\"content\":[{\"type\":\"text\",\"text\":\"<system-reminder>x</system-reminder>\"}]}\n",
                "{\"type\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"<user_query>hide the drop zone</user_query>\"}]}\n",
                "{\"type\":\"reasoning\",\"summary\":[{\"type\":\"summary_text\",\"text\":\"look first\"}],\"encrypted_content\":\"SECRET\"}\n",
                "{\"type\":\"reasoning\",\"summary\":[],\"encrypted_content\":\"CIPHER\"}\n",
                "{\"type\":\"assistant\",\"content\":\"Reading.\",\"model_id\":\"grok-4.7-build\",\"tool_calls\":[{\"id\":\"c1\",\"name\":\"grep\",\"arguments\":\"{\\\"pattern\\\":\\\"videoDrop\\\"}\"}]}\n",
                "{\"type\":\"tool_result\",\"tool_call_id\":\"c1\",\"content\":\"Found 74\\nmatching lines\"}\n",
                "{\"type\":\"assistant\",\"content\":\"\",\"tool_calls\":[{\"id\":\"c2\",\"name\":\"read_file\",\"arguments\":{\"target_file\":\"app.js\"}}]}\n",
            ),
        )
        .unwrap();
        let mut cur = Cursor::default();
        let events = ingest(CliKind::Grok, &chat, &mut cur, 0);
        let blob = serde_json::to_string(&events).unwrap();
        assert!(!blob.contains("SECRET"), "{blob}");
        assert!(!blob.contains("CIPHER"), "{blob}");
        assert_eq!(events.iter().filter(|event| event.k == "think").count(), 1);
        assert!(!blob.contains("system-reminder"), "{blob}");
        let user = events.iter().find(|e| e.k == "user").unwrap();
        assert_eq!(user.b, "hide the drop zone");
        assert_eq!(user.t, parse_iso_ms("2026-10-10T08:55:25Z").unwrap());
        let tools: Vec<_> = events.iter().filter(|e| e.k == "tool").collect();
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0].n, "grep");
        assert_eq!(tools[0].a, "videoDrop");
        assert_eq!(tools[0].b, "pattern: videoDrop");
        assert_eq!(tools[0].t, parse_iso_ms("2026-10-10T08:55:27Z").unwrap());
        assert_eq!(tools[1].a, "app.js");
        assert_eq!(tools[1].t, parse_iso_ms("2026-10-10T08:55:30Z").unwrap());
        let reply = events.iter().find(|e| e.k == "reply").unwrap();
        assert_eq!(reply.n, "grok-4.7-build");
        assert_eq!(reply.t, tools[0].t);
        let done: Vec<_> = events.iter().filter(|e| e.k == "done").collect();
        assert_eq!(done.len(), 2);
        assert!(done[1].err);
        assert_eq!(done[0].ms, 14);
        let turn = events.iter().find(|e| e.k == "turn").unwrap();
        assert_eq!(turn.ms, 37_000);
        let usage = events.iter().find(|e| e.k == "usage").unwrap();
        assert_eq!((usage.ti, usage.to, usage.tc, usage.tr), (400, 30, 500, 20));
        let result = events.iter().find(|e| e.k == "result").unwrap();
        assert_eq!(result.b, "Found 74\nmatching lines");
        assert!(events.iter().all(|e| e.s == "01a12506" && e.cli == "grok"));
        assert_eq!(cur.ctx_used, 20011);
        assert_eq!(cur.ctx_window, 256000);
        assert_eq!(cur.lines_added, 7);
        assert!(cur.cost_ledger.is_empty());
        assert!(events.windows(2).all(|w| w[0].t <= w[1].t));

        // Nothing new: nothing emitted.
        assert!(ingest(CliKind::Grok, &chat, &mut cur, 0).is_empty());

        // Chat runs ahead of events: the tool takes the fallback time, and the
        // late `tool_started` does not shift later tools.
        let mut file = fs::OpenOptions::new().append(true).open(&chat).unwrap();
        writeln!(
            file,
            "{{\"type\":\"assistant\",\"content\":\"\",\"tool_calls\":[{{\"id\":\"c3\",\"name\":\"edit\",\"arguments\":{{}}}}]}}"
        )
        .unwrap();
        let ahead = ingest(CliKind::Grok, &chat, &mut cur, 0);
        assert_eq!(kinds(&ahead), vec!["tool"]);
        let mut ev_file = fs::OpenOptions::new()
            .append(true)
            .open(dir.join("events.jsonl"))
            .unwrap();
        writeln!(
            ev_file,
            "{{\"ts\":\"2026-10-10T09:00:00.000Z\",\"type\":\"tool_started\",\"tool_name\":\"edit\"}}"
        )
        .unwrap();
        writeln!(
            ev_file,
            "{{\"ts\":\"2026-10-10T09:00:05.000Z\",\"type\":\"tool_started\",\"tool_name\":\"grep\"}}"
        )
        .unwrap();
        writeln!(
            file,
            "{{\"type\":\"assistant\",\"content\":\"\",\"tool_calls\":[{{\"id\":\"c4\",\"name\":\"grep\",\"arguments\":{{}}}}]}}"
        )
        .unwrap();
        let next = ingest(CliKind::Grok, &chat, &mut cur, 0);
        let tool = next.iter().find(|e| e.k == "tool").unwrap();
        assert_eq!(tool.n, "grep");
        assert_eq!(tool.t, parse_iso_ms("2026-10-10T09:00:05Z").unwrap());
        let _ = fs::remove_dir_all(dir.parent().unwrap());
    }

    #[test]
    fn grok_live_session_ingests_updates_jsonl_and_tracks_diffs() {
        let dir = scratch("grok-live").join("01a131cf-session");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("events.jsonl"),
            concat!(
                "{\"ts\":\"2026-10-12T20:32:54.023Z\",\"type\":\"turn_started\",\"model_id\":\"grok-4.7\"}\n",
                "{\"ts\":\"2026-10-12T20:32:54.248Z\",\"type\":\"phase_changed\",\"phase\":\"waiting_for_model\"}\n",
                "{\"ts\":\"2026-10-12T20:32:56.748Z\",\"type\":\"first_token\"}\n",
                "{\"ts\":\"2026-10-12T20:33:00.000Z\",\"type\":\"tool_started\",\"tool_name\":\"search_replace\"}\n",
                "{\"ts\":\"2026-10-12T20:33:00.020Z\",\"type\":\"tool_completed\",\"tool_name\":\"search_replace\",\"duration_ms\":20,\"outcome\":\"success\"}\n",
            ),
        )
        .unwrap();

        fs::write(
            dir.join("updates.jsonl"),
            concat!(
                "{\"timestamp\":1791837175,\"method\":\"session/update\",\"params\":{\"_meta\":{\"streamStartMs\":1791837175061,\"totalTokens\":2031,\"modelId\":\"grok-4.7\"},\"update\":{\"sessionUpdate\":\"agent_thought_chunk\",\"content\":{\"type\":\"text\",\"text\":\"Planning changes...\"}}}}\n",
                "{\"timestamp\":1791837178,\"method\":\"session/update\",\"params\":{\"_meta\":{\"streamStartMs\":1791837178984,\"totalTokens\":18817,\"modelId\":\"grok-4.7\"},\"update\":{\"sessionUpdate\":\"tool_call\",\"toolCallId\":\"c1\"}}}\n",
                "{\"timestamp\":1791837180,\"method\":\"session/update\",\"params\":{\"_meta\":{\"streamStartMs\":1791837178984,\"totalTokens\":28765,\"modelId\":\"grok-4.7\"},\"update\":{\"sessionUpdate\":\"tool_call_update\",\"status\":\"completed\"}}}\n",
            ),
        )
        .unwrap();

        let chat = dir.join("chat_history.jsonl");
        fs::write(
            &chat,
            concat!(
                "{\"type\":\"user\",\"content\":\"Refactor the layout\"}\n",
                "{\"type\":\"assistant\",\"content\":\"Applying edit\",\"tool_calls\":[{\"id\":\"c1\",\"name\":\"search_replace\",\"arguments\":{\"old_string\":\"line 1\\nline 2\",\"new_string\":\"line 1\\nline 2\\nline 3\\nline 4\"}}]}\n",
                "{\"type\":\"tool_result\",\"tool_call_id\":\"c1\",\"content\":\"File updated\"}\n",
            ),
        )
        .unwrap();

        let mut cur = Cursor::default();
        let events = ingest(CliKind::Grok, &chat, &mut cur, 1791837200000);

        assert_eq!(cur.model, "grok-4.7");
        assert_eq!(cur.ctx_used, 28765);
        assert_eq!(cur.ctx_window, 256000);
        assert_eq!(cur.ttft_ms, 2500); // 20:32:56.748 - 20:32:54.248 = 2500ms
        assert_eq!(cur.lines_removed, 2);
        assert_eq!(cur.lines_added, 4);

        let usage_events: Vec<_> = events.iter().filter(|e| e.k == "usage").collect();
        assert_eq!(usage_events.len(), 2);
        // First stream: 2031 total, 0 cached, non-cached 2031
        assert_eq!(usage_events[0].ti, 2031);
        assert_eq!(usage_events[0].tc, 0);
        assert!(usage_events[0].tr > 0); // reasoned "Planning changes..."
                                         // Second stream: 18817 total, 2031 cached, non-cached 16786
        assert_eq!(usage_events[1].ti, 16786);
        assert_eq!(usage_events[1].tc, 2031);

        // Stats computation should populate Sections 04 & 05
        let stats = crate::analytics::stats::compute_stats(
            &events,
            cur.ctx_used,
            cur.ctx_window,
            cur.ttft_ms,
            cur.lines_added,
            cur.lines_removed,
            &cur.model,
        );

        assert_eq!(stats.context_tokens_used, 28765);
        assert_eq!(stats.context_window_tokens, 256000);
        assert_eq!(stats.ttft_ms, 2500);
        assert_eq!(stats.lines_added, 4);
        assert_eq!(stats.lines_removed, 2);
        assert_eq!(stats.total_cache_read_tokens, 2031);
        assert_eq!(stats.total_input_tokens, 2031 + 16786);
        assert!(stats.turn_count >= 1);
        assert!(stats.avg_turn_duration_ms > 0);
        assert_eq!(stats.models.len(), 1);
        assert_eq!(stats.models[0].model, "grok-4.7");

        let total_bucket_tokens: u64 = stats.timeline.iter().map(|b| b.tokens).sum();
        assert!(
            total_bucket_tokens > 0,
            "Timeline must contain non-zero token activity"
        );

        let _ = fs::remove_dir_all(dir.parent().unwrap());
    }

    #[test]
    fn claude_pairs_tool_results_and_dedupes_usage() {
        let dir = scratch("claude");
        let path = dir.join("3d98fbc5-695a.jsonl");
        fs::write(
            &path,
            concat!(
                "{\"type\":\"user\",\"isMeta\":true,\"timestamp\":\"2026-04-30T22:09:00Z\",\"message\":{\"role\":\"user\",\"content\":\"hidden\"}}\n",
                "{\"type\":\"user\",\"timestamp\":\"2026-04-30T22:09:21.702Z\",\"message\":{\"role\":\"user\",\"content\":\"upload the HEIC\"}}\n",
                "{\"type\":\"assistant\",\"timestamp\":\"2026-04-30T22:09:30Z\",\"message\":{\"id\":\"m1\",\"model\":\"opus\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"check the path\"}],\"usage\":{\"input_tokens\":100,\"cache_read_input_tokens\":1000,\"cache_creation_input_tokens\":10,\"output_tokens\":50}}}\n",
                "{\"type\":\"assistant\",\"timestamp\":\"2026-04-30T22:09:31Z\",\"message\":{\"id\":\"m1\",\"model\":\"opus\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"Bash\",\"input\":{\"command\":\"ls -la\"}}],\"usage\":{\"input_tokens\":100,\"cache_read_input_tokens\":1000,\"cache_creation_input_tokens\":10,\"output_tokens\":50}}}\n",
                "{\"type\":\"user\",\"isSidechain\":true,\"timestamp\":\"2026-04-30T22:09:32Z\",\"message\":{\"role\":\"user\",\"content\":\"side\"}}\n",
                "{\"type\":\"user\",\"timestamp\":\"2026-04-30T22:09:33.5Z\",\"message\":{\"role\":\"user\",\"content\":[{\"tool_use_id\":\"t1\",\"type\":\"tool_result\",\"content\":\"permission denied\",\"is_error\":true}]}}\n",
                "{\"type\":\"assistant\",\"timestamp\":\"2026-04-30T22:09:40Z\",\"message\":{\"id\":\"m2\",\"model\":\"opus\",\"content\":[{\"type\":\"text\",\"text\":\"It failed.\"}],\"usage\":{\"input_tokens\":5,\"output_tokens\":7}}}\n",
                "{\"type\":\"system\",\"subtype\":\"turn_duration\",\"durationMs\":19000,\"timestamp\":\"2026-04-30T22:09:41Z\"}\n",
                "{\"type\":\"user\",\"timestamp\":\"2026-04-30T22:10:00Z\",\"message\":{\"role\":\"user\",\"content\":\"<command-name>/clear</command-name>\"}}\n",
            ),
        )
        .unwrap();
        let mut cur = Cursor::default();
        let events = ingest(CliKind::Claude, &path, &mut cur, 0);
        assert_eq!(
            kinds(&events),
            vec!["user", "think", "usage", "tool", "result", "done", "reply", "usage", "turn"]
        );
        let usage: Vec<_> = events.iter().filter(|e| e.k == "usage").collect();
        assert_eq!(usage[0].ti, 100);
        assert_eq!(usage[0].tc, 1000);
        assert_eq!(usage[1].to, 7);
        let done = events.iter().find(|e| e.k == "done").unwrap();
        assert_eq!(done.n, "Bash");
        assert_eq!(done.ms, 2_500);
        assert!(done.err);
        let tool = events.iter().find(|e| e.k == "tool").unwrap();
        assert_eq!(tool.a, "ls -la");
        assert!(events.iter().all(|e| e.s == "3d98fbc5"));
        assert!(!serde_json::to_string(&events).unwrap().contains("hidden"));
        assert_eq!(cur.ctx_used, 5);
        assert!(ingest(CliKind::Claude, &path, &mut cur, 0).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn partial_last_line_waits_for_newline() {
        let dir = scratch("partial");
        let path = dir.join("abc.jsonl");
        fs::write(
            &path,
            "{\"type\":\"user\",\"timestamp\":\"2026-04-30T22:09:21Z\",\"message\":{\"content\":\"one\"}}\n{\"type\":\"user\"",
        )
        .unwrap();
        let mut cur = Cursor::default();
        let first = ingest(CliKind::Claude, &path, &mut cur, 0);
        assert_eq!(first.len(), 1);
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(
            file,
            ",\"timestamp\":\"2026-04-30T22:09:22Z\",\"message\":{{\"content\":\"two\"}}}}"
        )
        .unwrap();
        let second = ingest(CliKind::Claude, &path, &mut cur, 0);
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].b, "two");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn agy_ingests_a_turn_once_and_sums_only_explicit_tokens() {
        let scratch_dir = scratch("agy");
        let dir = scratch_dir
            .join("brain")
            .join("dddddddd-4444-4444-8444-444444444444");
        let logs = dir.join(".system_generated").join("logs");
        fs::create_dir_all(&logs).unwrap();
        let path = logs.join("transcript.jsonl");
        let long_reply = "x".repeat(400);
        // Stats polls once a second. The user step and the later planner step
        // are separate ingest calls, and the turn is emitted on the second.
        fs::write(
            &path,
            concat!(
                "{\"step_index\":1,\"type\":\"USER_INPUT\",\"status\":\"DONE\",\"created_at\":\"2026-10-10T01:00:00Z\",\"content\":\"<USER_REQUEST>\\nfix the alignment\\n</USER_REQUEST>\\n<ADDITIONAL_METADATA>\\nlocal time\\n</ADDITIONAL_METADATA>\"}\n",
            ),
        )
        .unwrap();
        let mut cur = Cursor::default();
        let opened = ingest(CliKind::Antigravity, &path, &mut cur, 0);
        assert!(cur.agy_turn_open);
        assert_eq!(kinds(&opened), vec!["user"]);
        let opened_blob = serde_json::to_string(&opened).unwrap();
        assert!(opened_blob.contains("fix the alignment"), "{opened_blob}");
        assert!(
            !opened_blob.contains("ADDITIONAL_METADATA"),
            "{opened_blob}"
        );
        assert!(opened
            .iter()
            .all(|event| event.s == "dddddddd" && event.cli == "antigravity"));

        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(
            format!(
                concat!(
                    "{{\"step_index\":2,\"type\":\"PLANNER_RESPONSE\",\"status\":\"DONE\",\"created_at\":\"2026-10-10T01:00:05Z\",\"thinking\":\"check the cells\",\"content\":\"The grid is fixed.\",\"model\":\"gemini-test\",\"input_tokens\":1200,\"output_tokens\":30,\"cache_read_tokens\":800,\"tool_calls\":[{{\"name\":\"run_command\",\"args\":{{\"CommandLine\":\"cargo test\"}}}}]}}\n",
                    "{{\"step_index\":3,\"type\":\"RUN_COMMAND\",\"source\":\"MODEL\",\"status\":\"ERROR\",\"created_at\":\"2026-10-10T01:00:09Z\",\"error\":\"command failed\",\"content\":\"build failed\\nnext line\"}}\n",
                    "{{\"step_index\":9,\"type\":\"SEARCH_WEB\",\"source\":\"MODEL\",\"status\":\"ERROR\",\"created_at\":\"2026-10-10T01:00:10Z\",\"error\":\"no summary\",\"content\":\"The search returned nothing\\nrest\"}}\n",
                    "{{\"step_index\":10,\"type\":\"VIEW_FILE\",\"source\":\"MODEL\",\"status\":\"DONE\",\"created_at\":\"2026-10-10T01:00:10Z\",\"content\":\"Opened artifacts.rs\\nline\"}}\n",
                    "{{\"step_index\":11,\"type\":\"LIST_DIRECTORY\",\"source\":\"MODEL\",\"status\":\"DONE\",\"created_at\":\"2026-10-10T01:00:10Z\",\"content\":\"Listed the workspace\\nmore\"}}\n",
                    "{{\"step_index\":12,\"type\":\"GREP_SEARCH\",\"source\":\"MODEL\",\"status\":\"DONE\",\"created_at\":\"2026-10-10T01:00:10Z\",\"content\":\"Matched the detector\\nmore\"}}\n",
                    "{{\"step_index\":13,\"type\":\"CODE_ACTION\",\"source\":\"MODEL\",\"status\":\"ERROR\",\"created_at\":\"2026-10-10T01:00:11Z\",\"error\":\"edit failed\",\"content\":\"Could not apply the edit\\nmore\"}}\n",
                    "{{\"step_index\":14,\"type\":\"GENERIC\",\"source\":\"SYSTEM\",\"created_at\":\"2026-10-10T01:00:11Z\",\"content\":\"generic system record\"}}\n",
                    "{{\"step_index\":4,\"type\":\"PLANNER_RESPONSE\",\"status\":\"DONE\",\"created_at\":\"2026-10-10T01:00:12Z\",\"content\":\"{long}\"}}\n",
                    "{{\"step_index\":5,\"type\":\"CHECKPOINT\",\"created_at\":\"2026-10-10T01:00:13Z\",\"content\":\"checkpoint secret\"}}\n",
                    "{{\"step_index\":6,\"type\":\"SYSTEM_MESSAGE\",\"created_at\":\"2026-10-10T01:00:14Z\",\"content\":\"system bookkeeping\"}}\n",
                    "{{\"step_index\":7,\"type\":\"CONVERSATION_HISTORY\",\"created_at\":\"2026-10-10T01:00:15Z\",\"content\":\"old conversation history\"}}\n",
                ),
                long = long_reply,
            )
            .as_bytes(),
        )
        .unwrap();
        drop(file);
        let events = ingest(CliKind::Antigravity, &path, &mut cur, 0);
        assert!(!cur.agy_turn_open);
        let blob = serde_json::to_string(&events).unwrap();
        assert!(!blob.contains("checkpoint secret"), "{blob}");
        assert!(!blob.contains("system bookkeeping"), "{blob}");
        assert!(!blob.contains("old conversation history"), "{blob}");
        assert!(events.iter().all(|event| event.k != "user"));
        assert!(events.iter().any(|event| event.k == "think"));
        assert!(events.iter().any(|event| event.k == "reply"));
        let tool = events.iter().find(|event| event.k == "tool").unwrap();
        assert_eq!(tool.n, "run_command");
        assert_eq!(tool.a, "cargo test");
        let failed: Vec<_> = events
            .iter()
            .filter(|event| event.k == "result" && event.err)
            .collect();
        assert!(
            failed
                .iter()
                .any(|event| event.b == "build failed\nnext line"),
            "{failed:?}"
        );
        assert!(
            failed
                .iter()
                .any(|event| event.b == "The search returned nothing\nrest"),
            "{failed:?}"
        );
        assert!(
            failed
                .iter()
                .any(|event| event.b == "Could not apply the edit\nmore"),
            "{failed:?}"
        );
        let results: Vec<_> = events.iter().filter(|event| event.k == "result").collect();
        for line in [
            "Opened artifacts.rs\nline",
            "Listed the workspace\nmore",
            "Matched the detector\nmore",
        ] {
            assert!(
                results.iter().any(|event| event.b == line),
                "{line} missing in {results:?}"
            );
        }
        assert!(!blob.contains("generic system record"), "{blob}");
        let done = events.iter().find(|event| event.k == "done").unwrap();
        assert!(done.err, "{done:?}");
        assert_eq!(done.n, "run_command");
        let turns: Vec<_> = events.iter().filter(|event| event.k == "turn").collect();
        assert_eq!(turns.len(), 1, "{events:?}");
        assert_eq!(turns[0].t, parse_iso_ms("2026-10-10T01:00:12Z").unwrap());
        assert_eq!(turns[0].ms, 12_000);
        let usage: Vec<_> = events.iter().filter(|event| event.k == "usage").collect();
        assert_eq!(usage.len(), 1, "{events:?}");
        assert_eq!((usage[0].ti, usage[0].to, usage[0].tc), (1200, 30, 800));
        assert_eq!(usage[0].n, "gemini-test");
        let token_sum: u64 = events
            .iter()
            .map(|event| event.ti + event.to + event.tc)
            .sum();
        assert_eq!(token_sum, 1200 + 30 + 800);
        assert!(events.iter().all(|event| event.ti != 400));
        assert!(events
            .iter()
            .all(|event| event.s == "dddddddd" && event.cli == "antigravity"));

        assert!(ingest(CliKind::Antigravity, &path, &mut cur, 0).is_empty());

        // A planner that arrives after the turn closed must not emit another turn.
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(
            file,
            "{{\"step_index\":15,\"type\":\"PLANNER_RESPONSE\",\"status\":\"DONE\",\"created_at\":\"2026-10-10T01:01:00Z\",\"content\":\"no new turn\"}}"
        )
        .unwrap();
        drop(file);
        let late = ingest(CliKind::Antigravity, &path, &mut cur, 0);
        assert_eq!(kinds(&late), vec!["reply"]);
        assert_eq!(late[0].b, "no new turn");
        assert!(!cur.agy_turn_open);

        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(
            file,
            "{{\"step_index\":8,\"type\":\"USER_INPUT\",\"status\":\"DONE\",\"created_at\":\"2026-10-10T01:02:00Z\",\"content\":\"<USER_REQUEST>\\nonly the new step\\n</USER_REQUEST>\"}}"
        )
        .unwrap();
        let appended = ingest(CliKind::Antigravity, &path, &mut cur, 0);
        assert_eq!(kinds(&appended), vec!["user"]);
        assert_eq!(appended[0].b, "only the new step");
        assert_eq!(appended[0].ti, 0);
        let _ = fs::remove_dir_all(&scratch_dir);
    }

    #[test]
    fn agy_estimates_reasoning_and_tracks_tool_code_delta() {
        let scratch_dir = scratch("agy_delta");
        let dir = scratch_dir
            .join("brain")
            .join("aaaaaaaa-1111-2222-3333-444444444444");
        let logs = dir.join(".system_generated").join("logs");
        fs::create_dir_all(&logs).unwrap();
        let path = logs.join("transcript.jsonl");

        fs::write(
            &path,
            concat!(
                "{\"step_index\":1,\"type\":\"USER_INPUT\",\"status\":\"DONE\",\"created_at\":\"2026-10-10T01:00:00Z\",\"content\":\"refactor the code\"}\n",
                "{\"step_index\":2,\"type\":\"PLANNER_RESPONSE\",\"status\":\"DONE\",\"created_at\":\"2026-10-10T01:00:05Z\",\"thinking\":\"pondering deep architecture decisions\",\"content\":\"done\",\"input_tokens\":500,\"output_tokens\":50,\"cache_read_tokens\":100,\"tool_calls\":[{\"name\":\"replace_file_content\",\"args\":{\"TargetContent\":\"line1\\nline2\",\"ReplacementContent\":\"newLine1\\nnewLine2\\nnewLine3\"}},{\"name\":\"write_to_file\",\"args\":{\"CodeContent\":\"a\\nb\\nc\\nd\"}}]}\n",
            ),
        )
        .unwrap();

        let mut cur = Cursor::default();
        let events = ingest(CliKind::Antigravity, &path, &mut cur, 0);
        let usage = events.iter().find(|e| e.k == "usage").unwrap();
        // Thinking text "pondering deep architecture decisions" has 37 chars -> ~10 estimated tokens
        assert!(usage.tr > 0, "Reasoning tokens must be > 0: {}", usage.tr);
        assert_eq!(cur.lines_removed, 2);
        assert_eq!(cur.lines_added, 3 + 4);
        let _ = fs::remove_dir_all(&scratch_dir);
    }

    #[test]
    fn claude_estimates_reasoning_and_tracks_tool_code_delta() {
        let dir = scratch("claude_delta");
        let path = dir.join("proj.jsonl");
        fs::write(
            &path,
            concat!(
                "{\"type\":\"user\",\"timestamp\":\"2026-04-30T22:09:20Z\",\"message\":{\"content\":\"fix bug\"}}\n",
                "{\"type\":\"assistant\",\"timestamp\":\"2026-04-30T22:09:30Z\",\"message\":{\"id\":\"m1\",\"model\":\"claude-3-7-sonnet\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"analyzing the root cause here\"},{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"Edit\",\"input\":{\"old_string\":\"bad line\",\"new_string\":\"fixed line 1\\nfixed line 2\"}}],\"usage\":{\"input_tokens\":120,\"output_tokens\":40,\"cache_read_input_tokens\":500,\"cache_creation_input_tokens\":0}}}\n",
            ),
        )
        .unwrap();

        let mut cur = Cursor::default();
        let events = ingest(CliKind::Claude, &path, &mut cur, 0);
        let usage = events.iter().find(|e| e.k == "usage").unwrap();
        assert!(usage.tr > 0, "Reasoning tokens must be > 0: {}", usage.tr);
        assert_eq!(cur.lines_removed, 1);
        assert_eq!(cur.lines_added, 2);
        let think = events.iter().find(|event| event.k == "think").unwrap();
        assert_eq!(think.b, "analyzing the root cause here");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn claude_skips_omitted_thinking_and_labels_turn_duration() {
        let dir = scratch("claude_omit");
        let path = dir.join("proj.jsonl");
        fs::write(
            &path,
            concat!(
                "{\"type\":\"assistant\",\"timestamp\":\"2026-04-30T22:09:30Z\",\"message\":{\"id\":\"m1\",\"model\":\"claude-opus-4-8\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"\",\"signature\":\"EosT\"},{\"type\":\"redacted_thinking\",\"data\":\"abc\"},{\"type\":\"text\",\"text\":\"Done.\"}],\"usage\":{\"input_tokens\":10,\"output_tokens\":2}}}\n",
                "{\"type\":\"system\",\"subtype\":\"turn_duration\",\"timestamp\":\"2026-04-30T22:09:40Z\",\"durationMs\":10530,\"messageCount\":4}\n",
            ),
        )
        .unwrap();

        let mut cur = Cursor::default();
        let events = ingest(CliKind::Claude, &path, &mut cur, 0);
        assert!(events.iter().all(|event| event.k != "think"), "{events:?}");
        assert!(events
            .iter()
            .any(|event| event.k == "reply" && event.b == "Done."));
        let turn = events.iter().find(|event| event.k == "turn").unwrap();
        assert_eq!(turn.ms, 10_530);
        assert_eq!(turn.b, "4 messages");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn purged_grok_cursor_does_not_reimport_history() {
        let dir = scratch("grok-purge").join("01a19999-session");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("signals.json"),
            r#"{"contextTokensUsed":20011,"contextWindowTokens":256000,"avgTimeToFirstTokenMs":5692,"agentLinesAdded":7,"agentLinesRemoved":2}"#,
        )
        .unwrap();
        let chat = dir.join("chat_history.jsonl");
        fs::write(
            &chat,
            "{\"type\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"<user_query>count me</user_query>\"}]}\n",
        )
        .unwrap();

        let mut cur = Cursor::default();
        let first = ingest(CliKind::Grok, &chat, &mut cur, 0);
        assert!(first.iter().any(|event| event.k == "user"));
        assert_eq!(cur.lines_added, 7);
        assert_eq!(cur.lines_removed, 2);
        let offset = cur.offset;
        assert!(offset > 0);

        cur.mark_purged();
        assert_eq!(cur.offset, offset);
        assert_eq!(cur.lines_added, 0);
        assert_eq!(cur.lines_removed, 0);
        assert_eq!(cur.lines_base_added, 7);
        assert_eq!(cur.lines_base_removed, 2);
        assert!(cur.lines_tracked);

        let again = ingest(CliKind::Grok, &chat, &mut cur, 0);
        assert!(again.is_empty(), "{again:?}");
        assert_eq!(cur.lines_added, 0);
        assert_eq!(cur.lines_removed, 0);

        // The same cumulative signal file must not refill the wiped totals.
        cur.signals_mtime = 0;
        let reread = ingest(CliKind::Grok, &chat, &mut cur, 0);
        assert!(reread.is_empty(), "{reread:?}");
        assert_eq!(cur.lines_added, 0);
        assert_eq!(cur.lines_removed, 0);

        fs::write(
            dir.join("signals.json"),
            r#"{"contextTokensUsed":20011,"contextWindowTokens":256000,"avgTimeToFirstTokenMs":1000,"agentLinesAdded":9,"agentLinesRemoved":2}"#,
        )
        .unwrap();
        cur.signals_mtime = 0;
        let grown = ingest(CliKind::Grok, &chat, &mut cur, 0);
        assert!(grown.is_empty(), "{grown:?}");
        assert_eq!(cur.lines_added, 2);
        assert_eq!(cur.lines_removed, 0);

        let _ = fs::remove_dir_all(dir.parent().unwrap());
    }

    fn assert_ask_follows_tool(events: &[Event], name: &str, question: &str) {
        let pos = events
            .iter()
            .position(|ev| ev.k == event::TOOL && ev.n == name)
            .unwrap_or_else(|| panic!("missing tool {name}"));
        let tool = &events[pos];
        let ask = events
            .get(pos + 1)
            .unwrap_or_else(|| panic!("no event after {name}"));
        assert_eq!(ask.k, event::ASK, "{events:?}");
        assert_eq!(ask.t, tool.t);
        assert_eq!(ask.n, name);
        assert!(
            ask.b.contains(question),
            "ask body {:?} does not contain {question}",
            ask.b
        );
    }

    #[test]
    fn grok_ask_user_emits_tool_then_ask() {
        let raw = serde_json::json!({
            "type": "assistant",
            "tool_calls": [
                {"name": "ask_user", "arguments": {"question": "Which file?"}},
                {"name": "read_file", "arguments": {"path": "src/main.rs"}}
            ]
        });
        let mut cur = Cursor::default();
        let mut out = Vec::new();
        grok_chat(
            raw.as_object().unwrap(),
            &mut cur,
            false,
            1_000,
            1_000,
            &mut out,
        );
        assert_ask_follows_tool(&out, "ask_user", "Which file?");
        assert!(out
            .iter()
            .any(|ev| ev.k == event::TOOL && ev.n == "read_file"));
        assert_eq!(out.iter().filter(|ev| ev.k == event::ASK).count(), 1);
    }

    #[test]
    fn claude_ask_user_question_emits_tool_then_ask() {
        let ask = serde_json::json!({
            "type": "tool_use",
            "id": "t-ask",
            "name": "AskUserQuestion",
            "input": {"questions": [{"question": "Ship it?", "header": "Ship"}]}
        });
        let mut cur = Cursor::default();
        let mut out = Vec::new();
        claude_block(&ask, "opus", &mut cur, 42, &mut out);
        assert_ask_follows_tool(&out, "AskUserQuestion", "Ship it?");

        let plan = serde_json::json!({
            "type": "tool_use",
            "id": "t-plan",
            "name": "ExitPlanMode",
            "input": {"plan": "Ship the graph"}
        });
        let mut plan_out = Vec::new();
        claude_block(&plan, "opus", &mut cur, 43, &mut plan_out);
        assert_ask_follows_tool(&plan_out, "ExitPlanMode", "Ship the graph");

        let bash = serde_json::json!({
            "type": "tool_use",
            "id": "t-bash",
            "name": "Bash",
            "input": {"command": "ls"}
        });
        let mut bash_out = Vec::new();
        claude_block(&bash, "opus", &mut cur, 44, &mut bash_out);
        assert_eq!(bash_out.len(), 1);
        assert_eq!(bash_out[0].k, event::TOOL);
        assert!(bash_out.iter().all(|ev| ev.k != event::ASK));
    }

    #[test]
    fn agy_ask_question_emits_tool_then_ask() {
        let raw = serde_json::json!({
            "type": "PLANNER_RESPONSE",
            "created_at": "2026-10-10T08:55:25.000Z",
            "tool_calls": [
                {"name": "ask_question", "args": {"question": "Continue?"}},
                {"name": "read_file", "args": {"path": "x.rs"}}
            ]
        });
        let mut cur = Cursor::default();
        let mut out = Vec::new();
        let mut saw = false;
        agy_step(
            raw.as_object().unwrap(),
            &mut cur,
            1_000,
            &mut saw,
            &mut out,
        );
        assert_ask_follows_tool(&out, "ask_question", "Continue?");
        assert!(out
            .iter()
            .any(|ev| ev.k == event::TOOL && ev.n == "read_file"));
        assert_eq!(out.iter().filter(|ev| ev.k == event::ASK).count(), 1);
    }

    #[test]
    fn grok_session_cost_lands_on_the_cursor() {
        let dir = scratch("grok-cost").join("01a1cost-session");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("usage.json"),
            r#"{"session":{"costUsdTicks":12345000000,"costIsPartial":false,"usageIsIncomplete":false,"inputTokens":2000000,"cachedReadTokens":1000000,"outputTokens":1000000,"reasoningTokens":500000,"primaryModelId":"grok-4.7","modelUsage":{"grok-4.7":{"costUsdTicks":8000000000,"inputTokens":2000000,"outputTokens":1000000,"cachedReadTokens":1000000}}},"turns":[]}"#,
        )
        .unwrap();
        let chat = dir.join("chat_history.jsonl");
        fs::write(&chat, "{\"type\":\"user\",\"content\":\"hello\"}\n").unwrap();
        let mut cur = Cursor::default();
        ingest(CliKind::Grok, &chat, &mut cur, 0);
        let ledger: serde_json::Value = serde_json::from_str(&cur.cost_ledger).unwrap();
        assert_eq!(ledger["provider"], "grok");
        assert_eq!(ledger["inputIncludesCache"], true);
        assert_eq!(ledger["costUsdTicks"].as_i64(), Some(12_345_000_000));
        assert_eq!(
            ledger["modelUsage"]["grok-4.7"]["costUsdTicks"].as_i64(),
            Some(8_000_000_000)
        );
        assert_eq!(ledger["cachedReadTokens"].as_u64(), Some(1_000_000));
        let _ = fs::remove_dir_all(dir.parent().unwrap());

        let partial = scratch("grok-partial").join("01a1part-session");
        fs::create_dir_all(&partial).unwrap();
        fs::write(
            partial.join("usage.json"),
            r#"{"session":{"costIsPartial":true,"usageIsIncomplete":true,"inputTokens":2000000,"cachedReadTokens":1000000,"outputTokens":1000000,"primaryModelId":"grok-4.7"},"turns":[]}"#,
        )
        .unwrap();
        let chat = partial.join("chat_history.jsonl");
        fs::write(&chat, "{\"type\":\"user\",\"content\":\"hello\"}\n").unwrap();
        let mut cur = Cursor::default();
        ingest(CliKind::Grok, &chat, &mut cur, 0);
        let ledger: serde_json::Value = serde_json::from_str(&cur.cost_ledger).unwrap();
        assert_eq!(ledger["costIsPartial"], true);
        assert_eq!(ledger["usageIsIncomplete"], true);
        assert!(ledger.get("costUsdTicks").is_none());
        let _ = fs::remove_dir_all(partial.parent().unwrap());
    }

    #[test]
    fn claude_cost_state_lands_on_the_cursor() {
        let dir = scratch("claude-cost");
        let path = dir.join("aaaaaaaa-1111.jsonl");
        fs::write(
            &path,
            concat!(
                "{\"type\":\"cost-state\",\"totalCostUSD\":0.5,\"hasUnknownModelCost\":false,\"modelUsage\":{\"claude-sonnet-4-5\":{\"costUSD\":0.5,\"inputTokens\":10,\"outputTokens\":1,\"cacheReadInputTokens\":0,\"cacheCreationInputTokens\":0}}}\n",
                "{\"type\":\"assistant\",\"timestamp\":\"2026-04-30T22:09:30Z\",\"message\":{\"id\":\"m1\",\"model\":\"claude-sonnet-4-5\",\"usage\":{\"input_tokens\":100000,\"output_tokens\":10000,\"cache_creation_input_tokens\":20000}}}\n",
                "{\"type\":\"cost-state\",\"totalCostUSD\":1.48,\"hasUnknownModelCost\":true,\"modelUsage\":{\"claude-sonnet-4-5\":{\"costUSD\":1.11,\"inputTokens\":100000,\"outputTokens\":10000,\"cacheReadInputTokens\":50000,\"cacheCreationInputTokens\":20000},\"claude-haiku-4-5\":{\"costUSD\":0.22,\"inputTokens\":1000,\"outputTokens\":100}}}\n",
            ),
        )
        .unwrap();
        let mut cur = Cursor::default();
        ingest(CliKind::Claude, &path, &mut cur, 0);
        let ledger: serde_json::Value = serde_json::from_str(&cur.cost_ledger).unwrap();
        assert_eq!(ledger["provider"], "claude");
        assert_eq!(ledger["inputIncludesCache"], false);
        assert!((ledger["totalCostUSD"].as_f64().unwrap() - 1.48).abs() < 1e-9);
        assert_eq!(ledger["hasUnknownModelCost"], true);
        assert!(
            (ledger["modelUsage"]["claude-sonnet-4-5"]["costUSD"]
                .as_f64()
                .unwrap()
                - 1.11)
                .abs()
                < 1e-9
        );
        assert_eq!(
            ledger["modelUsage"]["claude-sonnet-4-5"]["cacheCreationInputTokens"].as_u64(),
            Some(20_000)
        );
        assert!(
            (ledger["modelUsage"]["claude-haiku-4-5"]["costUSD"]
                .as_f64()
                .unwrap()
                - 0.22)
                .abs()
                < 1e-9
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn agy_cost_summary_lands_on_the_cursor() {
        let scratch_dir = scratch("agy-cost");
        let dir = scratch_dir
            .join("brain")
            .join("eeeeeeee-5555-4555-8555-555555555555");
        let logs = dir.join(".system_generated").join("logs");
        fs::create_dir_all(&logs).unwrap();
        let path = logs.join("transcript.jsonl");
        fs::write(
            &path,
            concat!(
                "{\"step_index\":2,\"type\":\"PLANNER_RESPONSE\",\"status\":\"DONE\",\"created_at\":\"2026-10-10T01:00:05Z\",\"content\":\"priced\",\"model\":\"gemini-4-argon\",\"cost_summary\":{\"model\":\"gemini-4-argon\",\"quota_percent\":40,\"pricing\":{\"model_name\":\"gemini-4-argon\",\"input_price_per_million_tokens\":1.25,\"output_price_per_million_tokens\":10,\"cache_read_price_per_million_tokens\":0.125},\"total\":{\"cumulative_total\":{\"estimated_cost_usd\":0.87,\"input\":{\"tokens\":100000,\"estimated_cost_usd\":0.1},\"cache_read\":{\"tokens\":200000,\"estimated_cost_usd\":0.02},\"output\":{\"tokens\":50000,\"estimated_cost_usd\":0.3},\"thinking\":{\"tokens\":1000000,\"estimated_cost_usd\":0.4},\"tools\":{\"tokens\":10000,\"estimated_cost_usd\":0.05}}}}}\n",
            ),
        )
        .unwrap();
        let mut cur = Cursor::default();
        ingest(CliKind::Antigravity, &path, &mut cur, 0);
        assert!(!cur.cost_ledger.contains("quota"), "{}", cur.cost_ledger);
        let ledger: serde_json::Value = serde_json::from_str(&cur.cost_ledger).unwrap();
        assert_eq!(ledger["provider"], "antigravity");
        assert!((ledger["estimatedCostUsd"].as_f64().unwrap() - 0.87).abs() < 1e-9);
        assert_eq!(ledger["model"], "gemini-4-argon");
        assert_eq!(
            ledger["categories"]["thinking"]["tokens"].as_i64(),
            Some(1_000_000)
        );
        assert!(
            (ledger["categories"]["thinking"]["estimatedCostUsd"]
                .as_f64()
                .unwrap()
                - 0.4)
                .abs()
                < 1e-9
        );
        assert!(
            (ledger["categories"]["tools"]["estimatedCostUsd"]
                .as_f64()
                .unwrap()
                - 0.05)
                .abs()
                < 1e-9
        );
        assert_eq!(ledger["pricing"]["modelName"], "gemini-4-argon");
        assert!(
            (ledger["pricing"]["inputPricePerMillionTokens"]
                .as_f64()
                .unwrap()
                - 1.25)
                .abs()
                < 1e-9
        );
        let _ = fs::remove_dir_all(&scratch_dir);
    }
}
