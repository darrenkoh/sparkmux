//! Incremental transcript ingestion.
//!
//! Each `(tab, transcript)` pair owns a [`Cursor`]. A tick reads only the bytes
//! appended since the last tick, so a long session is imported once and then
//! followed. Grok's `chat_history.jsonl` has no timestamps; its sibling
//! `events.jsonl` does. Tool calls and user turns are matched to
//! `tool_started` and `turn_started` by position, which both files share.

use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::event::{self, parse_iso_ms, Event};
use crate::artifacts::{
    agy_bookkeeping, agy_tool_result, args_summary, extract_user_query, reasoning_text,
    text_from_value, tool_args, truncate_chars, CliKind,
};

/// Bytes read from one file per tick. A large history imports over a few ticks.
pub const MAX_READ: u64 = 8 * 1024 * 1024;
const USER_CAP: usize = 1_200;
const REPLY_CAP: usize = 1_200;
const THINK_CAP: usize = 800;
const RESULT_CAP: usize = 240;
const ARG_CAP: usize = 200;
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

pub fn ingest(kind: CliKind, path: &Path, cur: &mut Cursor, now: i64) -> Vec<Event> {
    let src = source_id(kind, path);
    let mut out = match kind {
        CliKind::Grok => ingest_grok(path, cur, now),
        CliKind::Claude => ingest_claude(path, cur, now),
        CliKind::Antigravity => ingest_agy(path, cur, now),
    };
    for event in &mut out {
        event.s.clone_from(&src);
        event.cli = kind.as_str().to_string();
    }
    out.sort_by_key(|event| event.t);
    out
}

/// Complete lines appended after `offset`. Returns the lines and the new offset.
/// A file that shrank was rewritten; skip to its end rather than import twice.
fn read_new_lines(path: &Path, offset: u64, max: u64) -> Option<(Vec<Vec<u8>>, u64)> {
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

fn parse_obj(line: &[u8]) -> Option<Map<String, Value>> {
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

fn read_small_json(path: &Path, cap: u64) -> Option<Map<String, Value>> {
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

/// One-line preview for tool output.
fn one_line(text: &str, cap: usize) -> (String, u64) {
    let count = text.trim().chars().count() as u64;
    let mut flat = String::new();
    for word in text.split_whitespace() {
        if !flat.is_empty() {
            flat.push(' ');
        }
        flat.push_str(word);
        if flat.len() > cap * 4 {
            break;
        }
    }
    (truncate_chars(&flat, cap), count)
}

fn noise_prompt(text: &str) -> bool {
    let head = text.trim_start();
    head.starts_with("<system-reminder>")
        || head.starts_with("<system_reminder>")
        || head.starts_with("<command-")
        || head.starts_with("<local-command-")
        || head.starts_with("Caveat:")
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

// ---------------------------------------------------------------- Grok

fn ingest_grok(path: &Path, cur: &mut Cursor, now: i64) -> Vec<Event> {
    let mut out = Vec::new();
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

fn grok_usage(path: &Path, cur: &mut Cursor, now: i64, out: &mut Vec<Event>) {
    let mtime = mtime_ms(path);
    if mtime == cur.usage_mtime {
        return;
    }
    let Some(obj) = read_small_json(path, 8 * 1024 * 1024) else {
        return;
    };
    cur.usage_mtime = mtime;
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
        ev.ti = u64_of(turn, "inputTokens");
        ev.to = u64_of(turn, "outputTokens");
        ev.tc = u64_of(turn, "cachedReadTokens");
        ev.tw = u64_of(turn, "cacheCreationTokens");
        ev.tr = u64_of(turn, "reasoningTokens");
        ev.n = str_of(turn, "primaryModelId").to_string();
        ev.c = u64_of(turn, "modelCalls");
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
    cur.lines_added = u64_of(&obj, "agentLinesAdded");
    cur.lines_removed = u64_of(&obj, "agentLinesRemoved");
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
            let mut ev = Event::new(fallback(cur), event::THINK);
            (ev.b, ev.c) = body(&reasoning_text(obj), THINK_CAP);
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
                    ev.a = truncate_chars(
                        &args_summary(call.get("arguments").unwrap_or(&Value::Null)),
                        ARG_CAP,
                    );
                    tools.push(ev);
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
            (ev.b, ev.c) = one_line(&raw, RESULT_CAP);
            out.push(ev);
        }
        _ => {}
    }
}

// ---------------------------------------------------------------- Claude

fn ingest_claude(path: &Path, cur: &mut Cursor, now: i64) -> Vec<Event> {
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
                claude_record(&obj, cur, fallback, &mut out);
            }
        }
    }
    out
}

fn claude_record(obj: &Map<String, Value>, cur: &mut Cursor, fallback: i64, out: &mut Vec<Event>) {
    if obj.get("isSidechain").and_then(Value::as_bool) == Some(true) {
        return;
    }
    let ts = parse_iso_ms(str_of(obj, "timestamp")).unwrap_or(fallback);
    cur.last_ts = cur.last_ts.max(ts);
    let meta = obj.get("isMeta").and_then(Value::as_bool) == Some(true);
    match str_of(obj, "type") {
        "system" => {
            if str_of(obj, "subtype") == "turn_duration" {
                let mut ev = Event::new(ts, event::TURN);
                ev.ms = u64_of(obj, "durationMs");
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
                    let mut ev = Event::new(ts, event::USAGE);
                    // `ti` is the whole prompt, cache included, as Grok reports it.
                    ev.ti = input + read + write;
                    ev.tc = read;
                    ev.tw = write;
                    ev.to = u64_of(usage, "output_tokens");
                    ev.n.clone_from(&model);
                    ev.c = 1;
                    cur.ctx_used = ev.ti;
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

fn claude_block(block: &Value, model: &str, cur: &mut Cursor, ts: i64, out: &mut Vec<Event>) {
    match block.get("type").and_then(Value::as_str).unwrap_or("") {
        "thinking" | "redacted_thinking" => {
            let text = block.get("thinking").and_then(Value::as_str).unwrap_or("");
            let mut ev = Event::new(ts, event::THINK);
            (ev.b, ev.c) = body(text, THINK_CAP);
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
            let mut ev = Event::new(ts, event::TOOL);
            ev.a = truncate_chars(
                &args_summary(block.get("input").unwrap_or(&Value::Null)),
                ARG_CAP,
            );
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
                cur.pending.insert(id.to_string(), (ts, name));
            }
            out.push(ev);
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
                    let mut ev = Event::new(ts, event::TOOL);
                    ev.a = truncate_chars(&args_summary(tool_args(call)), ARG_CAP);
                    ev.n.clone_from(&name);
                    out.push(ev);
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
            (ev.b, ev.c) = one_line(&raw, RESULT_CAP);
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

/// Explicit counters only. A missing field is zero, never a character-count guess.
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
    let reasoning = explicit_num(obj, &["reasoning_tokens", "reasoningTokens"]);
    let model = agy_model(obj);
    if input.is_none()
        && output.is_none()
        && cache.is_none()
        && write.is_none()
        && reasoning.is_none()
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
    ev.tr = reasoning.unwrap_or(0);
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

fn agy_failed(obj: &Map<String, Value>) -> bool {
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
    (ev.b, ev.c) = one_line(&raw, RESULT_CAP);
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
        assert!(!blob.contains("system-reminder"), "{blob}");
        let user = events.iter().find(|e| e.k == "user").unwrap();
        assert_eq!(user.b, "hide the drop zone");
        assert_eq!(user.t, parse_iso_ms("2026-10-10T08:55:25Z").unwrap());
        let tools: Vec<_> = events.iter().filter(|e| e.k == "tool").collect();
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0].n, "grep");
        assert_eq!(tools[0].a, "videoDrop");
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
        assert_eq!((usage.ti, usage.to, usage.tc, usage.tr), (900, 30, 500, 20));
        let result = events.iter().find(|e| e.k == "result").unwrap();
        assert_eq!(result.b, "Found 74 matching lines");
        assert!(events.iter().all(|e| e.s == "01a12506" && e.cli == "grok"));
        assert_eq!(cur.ctx_used, 20011);
        assert_eq!(cur.ctx_window, 256000);
        assert_eq!(cur.lines_added, 7);
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
        assert_eq!(usage[0].ti, 1110);
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
                .any(|event| event.b == "build failed next line"),
            "{failed:?}"
        );
        assert!(
            failed
                .iter()
                .any(|event| event.b == "The search returned nothing rest"),
            "{failed:?}"
        );
        assert!(
            failed
                .iter()
                .any(|event| event.b == "Could not apply the edit more"),
            "{failed:?}"
        );
        let results: Vec<_> = events.iter().filter(|event| event.k == "result").collect();
        for line in [
            "Opened artifacts.rs line",
            "Listed the workspace more",
            "Matched the detector more",
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
}
