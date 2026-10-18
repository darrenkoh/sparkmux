//! Child conversations launched by the pane's agent.
//!
//! Grok, Claude, and Antigravity write a subagent's tokens and tool calls into
//! a separate transcript. The pane follows only the parent, so that work never
//! reached Stats. This module finds those children, ingests them with the
//! parent's source id, and tags every step with the child id.

use std::collections::{HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use super::event::{self, Event};
use super::ingest::{
    agent_id_ok, clip_label, ingest_one, pull_claude_sidechain, read_new_lines, read_small_json,
    source_id, Cursor, Spawned, MAX_READ,
};
use super::stats::TabAnalyticsStats;
use crate::artifacts::{CliKind, TranscriptRoots};

const MAX_CHILDREN: usize = 64;
const MAX_DEPTH: usize = 6;

struct Found {
    path: PathBuf,
    id: String,
    label: String,
}

pub fn ingest_session(
    kind: CliKind,
    path: &Path,
    cur: &mut Cursor,
    now: i64,
    roots: &TranscriptRoots,
) -> Vec<Event> {
    let src = source_id(kind, path);
    let mut out = ingest_one(kind, path, cur, now, false);
    let mut seen = HashSet::new();
    seen.insert(path_key(path));
    match kind {
        CliKind::Grok => {
            for child in grok_descendants(&roots.grok_sessions, path) {
                ingest_found(kind, child, cur, now, false, &mut seen, &mut out);
            }
        }
        CliKind::Claude => {
            let files = claude_agent_files(path);
            let skip: HashSet<String> = files.iter().map(|file| file.id.clone()).collect();
            out.extend(pull_claude_sidechain(path, cur, now, &skip));
            for file in files {
                remember_sidechain_file(cur, &file);
                ingest_found(kind, file, cur, now, true, &mut seen, &mut out);
            }
        }
        CliKind::Antigravity => {
            for child in agy_children(path, cur, &roots.agy_root) {
                ingest_found(kind, child, cur, now, false, &mut seen, &mut out);
            }
        }
    }
    for event in &mut out {
        event.s.clone_from(&src);
        event.cli = kind.as_str().to_string();
    }
    out.sort_by_key(|event| event.t);
    out
}

/// Parent line totals plus each child's. A subagent with no events yet still
/// gets a row once it has a label or a line delta.
pub fn apply_child_totals(stats: &mut TabAnalyticsStats, cursor: &Cursor) {
    let mut added = cursor.lines_added;
    let mut removed = cursor.lines_removed;
    for child in cursor.children.values() {
        added = added.saturating_add(child.lines_added);
        removed = removed.saturating_add(child.lines_removed);
        if child.agent_id.is_empty() {
            continue;
        }
        if let Some(row) = stats
            .subagents
            .iter_mut()
            .find(|row| row.id == child.agent_id)
        {
            row.lines_added = child.lines_added;
            row.lines_removed = child.lines_removed;
            if row.label.is_empty() && !child.agent_label.is_empty() {
                row.label.clone_from(&child.agent_label);
            }
            if row.model.is_empty() && !child.model.is_empty() {
                row.model.clone_from(&child.model);
            }
        } else if !child.agent_label.is_empty() || child.lines_added > 0 || child.lines_removed > 0
        {
            stats.subagents.push(super::stats::SubagentStat {
                id: child.agent_id.clone(),
                label: child.agent_label.clone(),
                model: child.model.clone(),
                lines_added: child.lines_added,
                lines_removed: child.lines_removed,
                ..super::stats::SubagentStat::default()
            });
        }
    }
    stats.lines_added = added;
    stats.lines_removed = removed;
    stats.subagents.sort_by(|a, b| {
        b.last_ts
            .cmp(&a.last_ts)
            .then_with(|| a.label.cmp(&b.label))
            .then_with(|| a.id.cmp(&b.id))
    });
}

fn ingest_found(
    kind: CliKind,
    found: Found,
    cur: &mut Cursor,
    now: i64,
    keep_sidechain: bool,
    seen: &mut HashSet<String>,
    out: &mut Vec<Event>,
) {
    if seen.len() >= MAX_CHILDREN {
        return;
    }
    let key = path_key(&found.path);
    if key.is_empty() || !seen.insert(key.clone()) {
        return;
    }
    if !regular_file(&found.path) {
        seen.remove(&key);
        return;
    }
    let slot = cur.children.entry(key).or_default();
    slot.agent_id.clone_from(&found.id);
    if !found.label.is_empty() {
        slot.agent_label.clone_from(&found.label);
    }
    let mut evs = ingest_one(kind, &found.path, slot, now, keep_sidechain);
    if slot.agent_label.is_empty() {
        if let Some(text) = evs
            .iter()
            .find(|event| event.k == event::USER && !event.b.is_empty())
            .map(|event| clip_label(&event.b))
        {
            slot.agent_label = text;
        }
    }
    let id = slot.agent_id.clone();
    let label = slot.agent_label.clone();
    for event in &mut evs {
        event.g.clone_from(&id);
        if event.h.is_empty() {
            event.h.clone_from(&label);
        }
    }
    out.extend(evs);
}

/// A Claude agent file that replaces sidechain lines already counted should
/// not be read from the beginning.
fn remember_sidechain_file(cur: &mut Cursor, found: &Found) {
    if !cur.side_ids.iter().any(|id| id == &found.id) {
        return;
    }
    let key = path_key(&found.path);
    let slot = cur.children.entry(key).or_default();
    if slot.offset == 0 {
        if let Ok(meta) = fs::symlink_metadata(&found.path) {
            slot.offset = meta.len();
        }
    }
}

fn path_key(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_file())
        .unwrap_or(false)
}

fn session_dir_name(transcript: &Path) -> Option<String> {
    let name = transcript.parent()?.file_name()?.to_string_lossy();
    agent_id_ok(&name).then(|| name.into_owned())
}

// ---------------------------------------------------------------- Grok

#[derive(Clone)]
struct GrokNode {
    id: String,
    label: String,
    path: PathBuf,
}

fn grok_descendants(root: &Path, parent_transcript: &Path) -> Vec<Found> {
    let Some(root_id) = session_dir_name(parent_transcript) else {
        return Vec::new();
    };
    let index = grok_index(root);
    let mut out = Vec::new();
    let mut queue = VecDeque::from([(root_id.clone(), 0usize)]);
    let mut seen = HashSet::from([root_id]);
    while let Some((id, depth)) = queue.pop_front() {
        if depth >= MAX_DEPTH || out.len() >= MAX_CHILDREN {
            break;
        }
        let Some(kids) = index.get(&id) else {
            continue;
        };
        for kid in kids {
            if !seen.insert(kid.id.clone()) {
                continue;
            }
            queue.push_back((kid.id.clone(), depth + 1));
            out.push(Found {
                path: kid.path.clone(),
                id: kid.id.clone(),
                label: kid.label.clone(),
            });
            if out.len() >= MAX_CHILDREN {
                break;
            }
        }
    }
    out
}

fn grok_index(root: &Path) -> std::collections::HashMap<String, Vec<GrokNode>> {
    let mut by_parent = std::collections::HashMap::<String, Vec<GrokNode>>::new();
    let Ok(projects) = fs::read_dir(root) else {
        return by_parent;
    };
    for project in projects.flatten() {
        if !project
            .file_type()
            .map(|kind| kind.is_dir())
            .unwrap_or(false)
        {
            continue;
        }
        let Ok(sessions) = fs::read_dir(project.path()) else {
            continue;
        };
        for session in sessions.flatten() {
            if !session
                .file_type()
                .map(|kind| kind.is_dir())
                .unwrap_or(false)
            {
                continue;
            }
            let Some(node) = grok_node(&session.path()) else {
                continue;
            };
            let Some(summary) = read_small_json(&session.path().join("summary.json"), 1024 * 1024)
            else {
                continue;
            };
            let parent = text_of(&summary, "parent_session_id");
            let kind = text_of(&summary, "session_kind");
            if !agent_id_ok(&parent) || !kind.starts_with("subagent") {
                continue;
            }
            by_parent.entry(parent).or_default().push(node);
        }
    }
    by_parent
}

fn grok_node(dir: &Path) -> Option<GrokNode> {
    let id = dir.file_name()?.to_string_lossy();
    if !agent_id_ok(&id) {
        return None;
    }
    let chat = dir.join("chat_history.jsonl");
    if !regular_file(&chat) {
        return None;
    }
    let summary = read_small_json(&dir.join("summary.json"), 1024 * 1024)?;
    let title = text_of(&summary, "generated_title");
    let agent = text_of(&summary, "agent_name");
    let label = if !title.is_empty() {
        clip_label(&title)
    } else {
        clip_label(&agent)
    };
    Some(GrokNode {
        id: id.into_owned(),
        label,
        path: chat,
    })
}

fn text_of(obj: &Map<String, Value>, key: &str) -> String {
    obj.get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

// ---------------------------------------------------------------- Claude

fn claude_agent_files(transcript: &Path) -> Vec<Found> {
    let Some(parent) = transcript.parent() else {
        return Vec::new();
    };
    let Some(stem) = transcript.file_stem() else {
        return Vec::new();
    };
    let dir = parent.join(stem).join("subagents");
    if !fs::symlink_metadata(&dir)
        .map(|meta| meta.file_type().is_dir())
        .unwrap_or(false)
    {
        return Vec::new();
    }
    let mut files = Vec::new();
    collect_agent_files(&dir, 0, &mut files);
    let mut found: Vec<Found> = files
        .into_iter()
        .filter_map(|path| {
            let name = path.file_name()?.to_string_lossy();
            let id = name
                .strip_prefix("agent-")?
                .strip_suffix(".jsonl")?
                .to_string();
            if !agent_id_ok(&id) {
                return None;
            }
            Some(Found {
                path,
                id,
                label: String::new(),
            })
        })
        .collect();
    found.sort_by(|a, b| a.id.cmp(&b.id));
    if found.len() > MAX_CHILDREN {
        found.truncate(MAX_CHILDREN);
    }
    found
}

fn collect_agent_files(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > 3 || out.len() >= 256 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            collect_agent_files(&entry.path(), depth + 1, out);
            continue;
        }
        if !kind.is_file() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("agent-") && name.ends_with(".jsonl") {
            out.push(entry.path());
        }
    }
}

// ---------------------------------------------------------------- Antigravity

/// Parent spawn lines, then each child's spawn lines, all stored on the root
/// cursor so a later poll does not read the same child twice.
fn agy_children(transcript: &Path, cur: &mut Cursor, agy_root: &Path) -> Vec<Found> {
    note_agy_spawns(transcript, cur, agy_root);
    let mut found: Vec<Found> = Vec::new();
    let mut index = 0;
    while index < cur.spawned.len()
        && found.len() < MAX_CHILDREN
        && index < MAX_DEPTH * MAX_CHILDREN
    {
        let spawned = cur.spawned[index].clone();
        index += 1;
        let path = PathBuf::from(&spawned.path);
        if path_key(&path) == path_key(transcript) || !agy_file_is_inside(agy_root, &path) {
            continue;
        }
        if found.iter().any(|row| row.id == spawned.id) {
            continue;
        }
        found.push(Found {
            path: path.clone(),
            id: spawned.id.clone(),
            label: spawned.label.clone(),
        });
        let key = path_key(&path);
        let extra = {
            let child = cur.children.entry(key).or_default();
            let before = child.spawned.len();
            note_agy_spawns(&path, child, agy_root);
            child
                .spawned
                .iter()
                .skip(before)
                .cloned()
                .collect::<Vec<_>>()
        };
        for extra_sp in extra {
            if cur.spawned.iter().any(|row| row.id == extra_sp.id)
                || cur.spawned.len() >= MAX_CHILDREN
            {
                continue;
            }
            cur.spawned.push(extra_sp);
        }
    }
    found
}

fn note_agy_spawns(transcript: &Path, cur: &mut Cursor, agy_root: &Path) {
    let Some((lines, next)) = read_new_lines(transcript, cur.spawn_offset, MAX_READ) else {
        return;
    };
    cur.spawn_offset = next;
    for line in lines {
        let Ok(text) = std::str::from_utf8(&line) else {
            continue;
        };
        if text.contains("invoke_subagent") {
            push_roles(text, &mut cur.pending_roles);
        }
        if !text.to_ascii_lowercase().contains("subagent") || !text.contains("conversationId") {
            continue;
        }
        for id in conversation_ids(text) {
            if cur.spawned.iter().any(|row| row.id == id) || cur.spawned.len() >= MAX_CHILDREN {
                continue;
            }
            let label = cur.pending_roles.pop_front().unwrap_or_default();
            let path = agy_root
                .join("brain")
                .join(&id)
                .join(".system_generated")
                .join("logs")
                .join("transcript.jsonl");
            cur.spawned.push(Spawned {
                id,
                label: clip_label(&label),
                path: path.to_string_lossy().into_owned(),
            });
        }
    }
}

fn agy_file_is_inside(root: &Path, file: &Path) -> bool {
    if !regular_file(file) {
        return false;
    }
    let Ok(root_real) = root.join("brain").canonicalize() else {
        return false;
    };
    let Ok(file_real) = file.canonicalize() else {
        return false;
    };
    file_real.starts_with(&root_real)
}

fn push_roles(line: &str, roles: &mut VecDeque<String>) {
    let mut rest = line;
    while let Some(pos) = rest.find("Role") {
        let after = &rest[pos + 4..];
        rest = after;
        let Some(colon) = after.find(':') else {
            continue;
        };
        if colon > 8 {
            continue;
        }
        let mut value = after[colon + 1..].trim_start_matches(['\\', ' ', '"']);
        if value.starts_with(':') {
            value = value[1..].trim_start_matches(['\\', ' ', '"']);
        }
        let mut label = String::new();
        for ch in value.chars() {
            if ch == '\\' || ch == '"' {
                break;
            }
            label.push(ch);
            if label.chars().count() >= 80 {
                break;
            }
        }
        let label = clip_label(&label);
        if !label.is_empty() && roles.len() < MAX_CHILDREN {
            roles.push_back(label);
        }
    }
}

fn conversation_ids(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = line;
    while let Some(pos) = rest.find("conversationId") {
        let after = &rest[pos + "conversationId".len()..];
        rest = &rest[pos + "conversationId".len()..];
        if let Some(id) = next_uuid(after) {
            if agent_id_ok(&id) && !out.iter().any(|seen| seen == &id) {
                out.push(id);
            }
        }
        if rest.is_empty() {
            break;
        }
    }
    out
}

fn next_uuid(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let end = bytes.len().min(96);
    let mut i = 0;
    while i + 36 <= end {
        if is_uuid(&bytes[i..i + 36]) {
            return Some(text[i..i + 36].to_string());
        }
        i += 1;
    }
    None
}

fn is_uuid(bytes: &[u8]) -> bool {
    let groups = [8usize, 4, 4, 4, 12];
    let mut at = 0;
    for (index, len) in groups.iter().enumerate() {
        if index > 0 {
            if bytes.get(at) != Some(&b'-') {
                return false;
            }
            at += 1;
        }
        for _ in 0..*len {
            if !bytes.get(at).is_some_and(|b| b.is_ascii_hexdigit()) {
                return false;
            }
            at += 1;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::super::stats::compute_stats;
    use super::*;
    use crate::artifacts::TranscriptRoots;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn scratch(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("sparkmux-sub-{name}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn roots(dir: &Path) -> TranscriptRoots {
        TranscriptRoots {
            grok_sessions: dir.join("grok"),
            claude_projects: dir.join("claude"),
            grok_active_sessions: dir.join("active.json"),
            agy_root: dir.join("agy"),
        }
    }

    fn write(path: &Path, body: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, body).unwrap();
    }

    #[test]
    fn grok_children_and_grandchildren_join_the_parent_totals() {
        let dir = scratch("grok");
        let root = dir.join("grok").join("sparkmux");
        let parent_id = "01a10000-0000-7000-8000-000000000001";
        let child_id = "01a10000-0000-7000-8000-000000000002";
        let grand_id = "01a10000-0000-7000-8000-000000000003";
        let fork_id = "01a10000-0000-7000-8000-000000000004";
        let parent = root.join(parent_id);
        write(
            &parent.join("summary.json"),
            &format!(r#"{{"id":"{parent_id}","session_kind":"primary"}}"#),
        );
        write(
            &parent.join("chat_history.jsonl"),
            "{\"type\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"<user_query>fix the hang</user_query>\"}]}\n",
        );
        write(
            &parent.join("usage.json"),
            r#"{"turns":[{"endedAt":"2026-10-10T08:00:00Z","inputTokens":100,"outputTokens":10,"primaryModelId":"grok-4.7"}]}"#,
        );
        write(
            &parent.join("signals.json"),
            r#"{"agentLinesAdded":4,"agentLinesRemoved":1}"#,
        );
        let child = root.join(child_id);
        write(
            &child.join("summary.json"),
            &format!(
                r#"{{"id":"{child_id}","parent_session_id":"{parent_id}","session_kind":"subagent","generated_title":"Fix control-mode hang","agent_name":"general-purpose"}}"#
            ),
        );
        write(
            &child.join("chat_history.jsonl"),
            "{\"type\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"<user_query>delegate</user_query>\"}]}\n{\"type\":\"assistant\",\"content\":\"Looking.\",\"tool_calls\":[{\"id\":\"c1\",\"name\":\"grep\",\"arguments\":\"{\\\"pattern\\\":\\\"hang\\\"}\"}]}\n",
        );
        write(
            &child.join("usage.json"),
            r#"{"turns":[{"endedAt":"2026-10-10T08:05:00Z","inputTokens":900,"outputTokens":40,"cachedReadTokens":100,"reasoningTokens":15,"primaryModelId":"grok-4.7"}]}"#,
        );
        write(
            &child.join("signals.json"),
            r#"{"agentLinesAdded":9,"agentLinesRemoved":3}"#,
        );
        let grand = root.join(grand_id);
        write(
            &grand.join("summary.json"),
            &format!(
                r#"{{"id":"{grand_id}","parent_session_id":"{child_id}","session_kind":"subagent_resume","generated_title":"QA the hang fix"}}"#
            ),
        );
        write(
            &grand.join("chat_history.jsonl"),
            "{\"type\":\"assistant\",\"content\":\"Checked.\"}\n",
        );
        write(
            &grand.join("usage.json"),
            r#"{"turns":[{"endedAt":"2026-10-10T08:10:00Z","inputTokens":50,"outputTokens":5,"primaryModelId":"grok-4.7"}]}"#,
        );
        let fork = root.join(fork_id);
        write(
            &fork.join("summary.json"),
            &format!(
                r#"{{"id":"{fork_id}","parent_session_id":"{parent_id}","generated_title":"user fork"}}"#
            ),
        );
        write(
            &fork.join("chat_history.jsonl"),
            "{\"type\":\"assistant\",\"content\":\"no\"}\n",
        );
        write(
            &fork.join("usage.json"),
            r#"{"turns":[{"endedAt":"2026-10-10T08:12:00Z","inputTokens":99999,"outputTokens":99999,"primaryModelId":"grok-4.7"}]}"#,
        );
        let linked = root.join("01a10000-0000-7000-8000-000000000005");
        fs::create_dir_all(&linked).unwrap();
        write(
            &linked.join("summary.json"),
            &format!(
                r#"{{"id":"01a10000-0000-7000-8000-000000000005","parent_session_id":"{parent_id}","session_kind":"subagent","generated_title":"outside"}}"#
            ),
        );
        let outside = dir.join("outside-usage.json");
        write(
            &outside,
            r#"{"turns":[{"endedAt":"2026-10-10T08:20:00Z","inputTokens":88888,"outputTokens":1}]}"#,
        );
        std::os::unix::fs::symlink(outside, linked.join("chat_history.jsonl")).unwrap();

        let transcript = parent.join("chat_history.jsonl");
        let mut cur = Cursor::default();
        let events = ingest_session(
            CliKind::Grok,
            &transcript,
            &mut cur,
            1_700_000_000_000,
            &roots(&dir),
        );
        let mut stats = compute_stats(&events, 0, 0, 0, cur.lines_added, cur.lines_removed, "");
        apply_child_totals(&mut stats, &cur);

        assert_eq!(
            stats.user_prompts, 1,
            "delegated prompts are not human prompts"
        );
        assert_eq!(stats.total_input_tokens, 100 + 900 - 100 + 50);
        assert_eq!(stats.total_output_tokens, 10 + 40 + 5);
        assert_eq!(stats.total_cache_read_tokens, 100);
        assert_eq!(stats.total_reasoning_tokens, 15);
        assert_eq!(stats.tool_calls, 1);
        assert_eq!(stats.lines_added, 4 + 9);
        assert_eq!(stats.lines_removed, 1 + 3);
        assert_eq!(stats.subagents.len(), 2);
        let hang = stats
            .subagents
            .iter()
            .find(|row| row.label == "Fix control-mode hang")
            .unwrap();
        assert_eq!(hang.id, child_id);
        assert_eq!(hang.input_tokens, 800);
        assert_eq!(hang.output_tokens, 40);
        assert_eq!(hang.tool_calls, 1);
        assert_eq!(hang.lines_added, 9);
        assert!(stats
            .subagents
            .iter()
            .any(|row| row.label == "QA the hang fix"));
        assert!(events
            .iter()
            .any(|event| event.g == child_id && event.k == "tool"));
        assert!(events.iter().all(|event| event.s == "01a10000"));

        let again = ingest_session(
            CliKind::Grok,
            &transcript,
            &mut cur,
            1_700_000_000_000,
            &roots(&dir),
        );
        assert!(
            again.is_empty(),
            "a second poll must not reimport the children"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn claude_agent_file_wins_and_sidechain_still_counts() {
        let dir = scratch("claude");
        let project = dir.join("claude").join("proj");
        let session = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        let filed = "agentfile0001";
        let loose = "sideonly00001";
        let parent = project.join(format!("{session}.jsonl"));
        write(
            &parent,
            &format!(
                concat!(
                    "{{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"fix the map\"}},\"timestamp\":\"2026-10-10T08:00:00Z\"}}\n",
                    "{{\"type\":\"assistant\",\"message\":{{\"role\":\"assistant\",\"model\":\"claude-sonnet\",\"id\":\"m1\",\"content\":[{{\"type\":\"text\",\"text\":\"On it.\"}}],\"usage\":{{\"input_tokens\":10,\"output_tokens\":4}}}},\"timestamp\":\"2026-10-10T08:00:01Z\"}}\n",
                    "{{\"type\":\"assistant\",\"isSidechain\":true,\"agentId\":\"{loose}\",\"subagent_type\":\"Explore\",\"message\":{{\"role\":\"assistant\",\"model\":\"claude-haiku\",\"id\":\"s1\",\"content\":[{{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"grep\",\"input\":{{\"pattern\":\"map\"}}}}],\"usage\":{{\"input_tokens\":20,\"output_tokens\":7}}}},\"timestamp\":\"2026-10-10T08:00:02Z\"}}\n",
                    "{{\"type\":\"assistant\",\"isSidechain\":true,\"agentId\":\"{filed}\",\"message\":{{\"role\":\"assistant\",\"model\":\"claude-haiku\",\"id\":\"s2\",\"content\":[{{\"type\":\"text\",\"text\":\"duplicate\"}}],\"usage\":{{\"input_tokens\":99,\"output_tokens\":99}}}},\"timestamp\":\"2026-10-10T08:00:03Z\"}}\n",
                ),
                loose = loose,
                filed = filed,
            ),
        );
        write(
            &project
                .join(session)
                .join("subagents")
                .join(format!("agent-{filed}.jsonl")),
            &format!(
                "{{\"type\":\"assistant\",\"isSidechain\":true,\"agentId\":\"{filed}\",\"message\":{{\"role\":\"assistant\",\"model\":\"claude-haiku\",\"id\":\"f1\",\"content\":[{{\"type\":\"text\",\"text\":\"from the file\"}}],\"usage\":{{\"input_tokens\":30,\"output_tokens\":8}}}},\"timestamp\":\"2026-10-10T08:00:04Z\"}}\n"
            ),
        );

        let mut cur = Cursor::default();
        let events = ingest_session(
            CliKind::Claude,
            &parent,
            &mut cur,
            1_700_000_000_000,
            &roots(&dir),
        );
        let stats = compute_stats(&events, 0, 0, 0, 0, 0, "");
        assert_eq!(stats.user_prompts, 1);
        assert_eq!(stats.total_input_tokens, 10 + 20 + 30);
        assert_eq!(stats.total_output_tokens, 4 + 7 + 8);
        assert_eq!(stats.tool_calls, 1);
        assert_eq!(stats.subagents.len(), 2);
        assert!(stats
            .subagents
            .iter()
            .any(|row| row.id == loose && row.label == "Explore"));
        assert!(stats
            .subagents
            .iter()
            .any(|row| row.id == filed && row.output_tokens == 8));
        assert!(!events.iter().any(|event| event.to == 99));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn agy_spawn_reads_the_child_and_its_child() {
        let dir = scratch("agy");
        let agy = dir.join("agy");
        let parent_id = "11111111-1111-4111-8111-111111111111";
        let child_id = "22222222-2222-4222-8222-222222222222";
        let grand_id = "33333333-3333-4333-8333-333333333333";
        let parent = agy
            .join("brain")
            .join(parent_id)
            .join(".system_generated")
            .join("logs")
            .join("transcript.jsonl");
        write(
            &parent,
            &format!(
                "{{\"type\":\"USER_INPUT\",\"created_at\":\"2026-10-14T05:00:00Z\",\"content\":\"draw four icons\"}}\n\
                 {{\"type\":\"PLANNER_RESPONSE\",\"created_at\":\"2026-10-14T05:00:01Z\",\"content\":\"Spawning.\",\"input_tokens\":5,\"output_tokens\":1,\"tool_calls\":[{{\"name\":\"invoke_subagent\",\"args\":{{\"Subagents\":\"[{{\\\"Role\\\":\\\"Icon Designer\\\"}}]\"}}}}]}}\n\
                 {{\"type\":\"GENERIC\",\"created_at\":\"2026-10-14T05:00:02Z\",\"content\":\"Created the following subagents: {{\\\"conversationId\\\": \\\"{child_id}\\\"}}\"}}\n"
            ),
        );
        let child = agy
            .join("brain")
            .join(child_id)
            .join(".system_generated")
            .join("logs")
            .join("transcript.jsonl");
        write(
            &child,
            &format!(
                "{{\"type\":\"USER_INPUT\",\"created_at\":\"2026-10-14T05:01:00Z\",\"content\":\"draw the icon\"}}\n\
                 {{\"type\":\"PLANNER_RESPONSE\",\"created_at\":\"2026-10-14T05:01:01Z\",\"content\":\"Asking a helper.\",\"input_tokens\":100,\"output_tokens\":20,\"tool_calls\":[{{\"name\":\"invoke_subagent\",\"args\":{{\"Subagents\":\"[{{\\\"Role\\\":\\\"Palette Checker\\\"}}]\"}}}}]}}\n\
                 {{\"type\":\"GENERIC\",\"created_at\":\"2026-10-14T05:01:02Z\",\"content\":\"Created the following subagents: {{\\\"conversationId\\\":\\\"{grand_id}\\\"}}\"}}\n"
            ),
        );
        let grand = agy
            .join("brain")
            .join(grand_id)
            .join(".system_generated")
            .join("logs")
            .join("transcript.jsonl");
        write(
            &grand,
            "{\"type\":\"PLANNER_RESPONSE\",\"created_at\":\"2026-10-14T05:02:00Z\",\"content\":\"Palette is fine.\",\"input_tokens\":12,\"output_tokens\":3}\n",
        );

        let mut cur = Cursor::default();
        let events = ingest_session(
            CliKind::Antigravity,
            &parent,
            &mut cur,
            1_700_000_000_000,
            &roots(&dir),
        );
        let stats = compute_stats(&events, 0, 0, 0, 0, 0, "");
        assert_eq!(stats.user_prompts, 1);
        assert_eq!(stats.total_input_tokens, 5 + 100 + 12);
        assert_eq!(stats.total_output_tokens, 1 + 20 + 3);
        assert_eq!(stats.subagents.len(), 2);
        assert!(stats.subagents.iter().any(|row| row.id == child_id
            && row.label == "Icon Designer"
            && row.input_tokens == 100));
        assert!(stats
            .subagents
            .iter()
            .any(|row| row.id == grand_id && row.label == "Palette Checker"));
        let _ = fs::remove_dir_all(&dir);
    }
}
