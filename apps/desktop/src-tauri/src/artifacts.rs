//! Read-only view of a Grok Build or Claude Code transcript.
//!
//! The pane keeps its own `%output` stream. This module never writes to tmux.
//! It only opens `chat_history.jsonl` or a Claude session file under the
//! user's home directory, and only when the focused pane is Grok or Claude.
//! tmux reports the real executable name, so a `grok` symlink to
//! `grok-1.0.50` shows up as `grok-1.0.50`. Grok's pane title ends in ` - grok`.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

use serde::Serialize;
use serde_json::Value;

const MAX_TAIL: u64 = 512 * 1024;
const MAX_ENTRIES: usize = 60;
const ASSISTANT_CAP: usize = 8_000;
const USER_CAP: usize = 4_000;
const REASON_CAP: usize = 1_500;
const RESULT_CAP: usize = 180;
const ARG_CAP: usize = 160;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CliKind {
    Grok,
    Claude,
}

impl CliKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Grok => "grok",
            Self::Claude => "claude",
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ArtifactEntry {
    pub id: String,
    pub offset: u64,
    pub kind: String,
    pub label: String,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ArtifactFeed {
    pub cli: Option<String>,
    pub transcript_path: Option<String>,
    pub file_len: u64,
    pub entries: Vec<ArtifactEntry>,
    pub error: Option<String>,
}

impl ArtifactFeed {
    fn none() -> Self {
        Self {
            cli: None,
            transcript_path: None,
            file_len: 0,
            entries: Vec::new(),
            error: None,
        }
    }

    fn unmatched(kind: CliKind) -> Self {
        Self {
            cli: Some(kind.as_str().to_string()),
            transcript_path: None,
            file_len: 0,
            entries: Vec::new(),
            error: None,
        }
    }
}

pub struct TranscriptRoots {
    pub grok_sessions: PathBuf,
    pub claude_projects: PathBuf,
}

fn default_roots() -> TranscriptRoots {
    match directories::UserDirs::new() {
        Some(dirs) => {
            let home = dirs.home_dir();
            TranscriptRoots {
                grok_sessions: home.join(".grok").join("sessions"),
                claude_projects: home.join(".claude").join("projects"),
            }
        }
        None => TranscriptRoots {
            grok_sessions: PathBuf::new(),
            claude_projects: PathBuf::new(),
        },
    }
}

#[tauri::command]
pub async fn pane_artifacts(
    command: String,
    cwd: String,
    title: String,
) -> Result<ArtifactFeed, String> {
    let roots = default_roots();
    tokio::task::spawn_blocking(move || load_artifacts(&command, &cwd, &title, &roots))
        .await
        .map_err(|err| err.to_string())
}

pub fn load_artifacts(
    command: &str,
    cwd: &str,
    title: &str,
    roots: &TranscriptRoots,
) -> ArtifactFeed {
    // tmux reports the foreground executable's real file name (`grok-1.0.50`),
    // which differs from argv0 (`grok`). The pane title stays a status line
    // ending in ` - grok` or `Claude Code` while the shell is still the
    // process tmux names, and after the CLI has returned to the prompt.
    let Some(kind) = cli_kind(command).or_else(|| cli_kind(title)) else {
        return ArtifactFeed::none();
    };
    let Some(path) = find_transcript(kind, cwd, roots) else {
        return ArtifactFeed::unmatched(kind);
    };
    match read_transcript(kind, &path, MAX_TAIL) {
        Ok((file_len, entries)) => ArtifactFeed {
            cli: Some(kind.as_str().to_string()),
            transcript_path: Some(path.to_string_lossy().into_owned()),
            file_len,
            entries,
            error: None,
        },
        Err(_) => ArtifactFeed {
            cli: Some(kind.as_str().to_string()),
            transcript_path: Some(path.to_string_lossy().into_owned()),
            file_len: 0,
            entries: Vec::new(),
            error: Some("Could not read the transcript.".into()),
        },
    }
}

fn cli_kind(value: &str) -> Option<CliKind> {
    let base = value.rsplit(['/', '\\']).next().unwrap_or(value).trim();
    let name = base.strip_prefix('-').unwrap_or(base);
    let name = name.strip_suffix(".exe").unwrap_or(name);
    let name = name.to_ascii_lowercase();
    named_cli(&name).or_else(|| titled_cli(&name))
}

fn named_cli(name: &str) -> Option<CliKind> {
    if name == "grok" || name.starts_with("grok ") || versioned_bin(name, "grok") {
        return Some(CliKind::Grok);
    }
    if name == "claude" || name.starts_with("claude ") || versioned_bin(name, "claude") {
        return Some(CliKind::Claude);
    }
    None
}

/// `grok-1.0.50` and `grok-1.0.41-macos-aarch64`. The text after `grok-` starts with a digit.
fn versioned_bin(name: &str, cli: &str) -> bool {
    let Some(rest) = name.strip_prefix(cli) else {
        return false;
    };
    let Some(rest) = rest.strip_prefix('-') else {
        return false;
    };
    rest.starts_with(|ch: char| ch.is_ascii_digit())
}

/// Grok sets the pane title to `<status> - grok`. Claude uses `Claude Code`.
fn titled_cli(name: &str) -> Option<CliKind> {
    let last = name.rsplit(" - ").next().unwrap_or(name).trim();
    match last {
        "grok" => Some(CliKind::Grok),
        "claude" | "claude code" => Some(CliKind::Claude),
        _ => None,
    }
}

fn normalize_cwd(cwd: &str) -> Option<PathBuf> {
    let path = Path::new(cwd.trim());
    if !path.is_absolute() {
        return None;
    }
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::Prefix(_) => return None,
            Component::RootDir => {
                out.clear();
                out.push("/");
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if out.components().count() > 1 {
                    out.pop();
                }
            }
            Component::Normal(part) => out.push(part),
        }
    }
    if out.is_absolute() {
        Some(out)
    } else {
        None
    }
}

fn safe_component(name: &str) -> bool {
    !name.is_empty() && !name.contains('/') && !name.contains('\\') && name != "." && name != ".."
}

fn encode_grok_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    let text = text.trim_end_matches('/');
    percent_encode(text)
}

fn encode_claude_path(path: &Path) -> Option<String> {
    let text = path.to_string_lossy();
    let rest = text.trim_end_matches('/').strip_prefix('/')?;
    if rest.is_empty() {
        return None;
    }
    Some(format!("-{}", rest.replace('/', "-")))
}

fn percent_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn find_transcript(kind: CliKind, cwd: &str, roots: &TranscriptRoots) -> Option<PathBuf> {
    let mut path = normalize_cwd(cwd)?;
    let jail = match kind {
        CliKind::Grok => &roots.grok_sessions,
        CliKind::Claude => &roots.claude_projects,
    };
    if jail.as_os_str().is_empty() {
        return None;
    }
    for _ in 0..8 {
        let name = match kind {
            CliKind::Grok => encode_grok_path(&path),
            CliKind::Claude => encode_claude_path(&path)?,
        };
        if safe_component(&name) {
            let dir = jail.join(&name);
            if let Some(found) = newest_in(kind, &dir, jail) {
                return Some(found);
            }
        }
        if !path.pop() {
            break;
        }
    }
    None
}

fn newest_in(kind: CliKind, dir: &Path, jail: &Path) -> Option<PathBuf> {
    if !dir.is_dir() {
        return None;
    }
    let mut best: Option<(SystemTime, PathBuf)> = None;
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let candidate = match kind {
            CliKind::Grok => entry.path().join("chat_history.jsonl"),
            CliKind::Claude => {
                let path = entry.path();
                let is_jsonl = path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|ext| ext == "jsonl");
                if !is_jsonl {
                    continue;
                }
                path
            }
        };
        let Some(canon) = under_jail(jail, &candidate) else {
            continue;
        };
        consider(&mut best, canon);
    }
    best.map(|(_, path)| path)
}

fn under_jail(jail: &Path, file: &Path) -> Option<PathBuf> {
    let jail = jail.canonicalize().ok()?;
    let file = file.canonicalize().ok()?;
    if file.starts_with(&jail) {
        Some(file)
    } else {
        None
    }
}

fn consider(best: &mut Option<(SystemTime, PathBuf)>, path: PathBuf) {
    let Ok(meta) = std::fs::metadata(&path) else {
        return;
    };
    if !meta.is_file() {
        return;
    }
    let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
    let replace = match best {
        None => true,
        Some((when, previous)) => modified > *when || (modified == *when && path > *previous),
    };
    if replace {
        *best = Some((modified, path));
    }
}

fn read_transcript(
    kind: CliKind,
    path: &Path,
    max_tail: u64,
) -> std::io::Result<(u64, Vec<ArtifactEntry>)> {
    let mut file = File::open(path)?;
    let file_len = file.metadata()?.len();
    let start = file_len.saturating_sub(max_tail);
    let mut skip_partial = false;
    if start > 0 {
        let mut prev = [0u8; 1];
        file.seek(SeekFrom::Start(start - 1))?;
        if file.read(&mut prev)? == 1 && prev[0] != b'\n' {
            skip_partial = true;
        }
    }
    file.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::new();
    file.take(max_tail.saturating_add(8))
        .read_to_end(&mut buf)?;

    let mut offset = start;
    let mut lines = buf.split(|&byte| byte == b'\n');
    if skip_partial {
        if let Some(partial) = lines.next() {
            offset = offset.saturating_add(partial.len() as u64 + 1);
        }
    }

    let mut entries = Vec::new();
    for line in lines {
        let line_off = offset;
        offset = offset.saturating_add(line.len() as u64 + 1);
        if line.is_empty() {
            continue;
        }
        let text = String::from_utf8_lossy(line);
        let Ok(value) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        match kind {
            CliKind::Grok => push_grok(&mut entries, line_off, &value),
            CliKind::Claude => push_claude(&mut entries, line_off, &value),
        }
    }
    if entries.len() > MAX_ENTRIES {
        let drop_n = entries.len() - MAX_ENTRIES;
        entries.drain(0..drop_n);
    }
    Ok((file_len, entries))
}

fn push_grok(entries: &mut Vec<ArtifactEntry>, offset: u64, value: &Value) {
    let Some(obj) = value.as_object() else {
        return;
    };
    match obj.get("type").and_then(Value::as_str).unwrap_or("") {
        "user" => {
            let raw = text_from_value(obj.get("content").unwrap_or(&Value::Null));
            push_text(
                entries,
                offset,
                "user",
                "You",
                &extract_user_query(&raw),
                USER_CAP,
            );
        }
        "assistant" => {
            let raw = text_from_value(obj.get("content").unwrap_or(&Value::Null));
            push_text(
                entries,
                offset,
                "assistant",
                "Assistant",
                &raw,
                ASSISTANT_CAP,
            );
            if let Some(calls) = obj.get("tool_calls").and_then(Value::as_array) {
                for call in calls {
                    let name = call.get("name").and_then(Value::as_str).unwrap_or("tool");
                    let summary = args_summary(call.get("arguments").unwrap_or(&Value::Null));
                    push_text(entries, offset, "tool", name, &summary, ARG_CAP);
                }
            }
        }
        "tool_result" => {
            let raw = text_from_value(obj.get("content").unwrap_or(&Value::Null));
            push_text(
                entries,
                offset,
                "tool_result",
                "Result",
                &first_line(&raw),
                RESULT_CAP,
            );
        }
        "reasoning" => {
            push_text(
                entries,
                offset,
                "reasoning",
                "Reasoning",
                &reasoning_text(obj),
                REASON_CAP,
            );
        }
        _ => {}
    }
}

fn push_claude(entries: &mut Vec<ArtifactEntry>, offset: u64, value: &Value) {
    let Some(obj) = value.as_object() else {
        return;
    };
    if obj.get("isMeta").and_then(Value::as_bool) == Some(true)
        || obj.get("isSidechain").and_then(Value::as_bool) == Some(true)
    {
        return;
    }
    let record = obj.get("type").and_then(Value::as_str).unwrap_or("");
    if record != "user" && record != "assistant" {
        return;
    }
    let Some(message) = obj.get("message").and_then(Value::as_object) else {
        return;
    };
    let content = message.get("content").unwrap_or(&Value::Null);
    let Some(blocks) = content.as_array() else {
        let raw = text_from_value(content);
        if record == "assistant" {
            push_text(
                entries,
                offset,
                "assistant",
                "Assistant",
                &raw,
                ASSISTANT_CAP,
            );
        } else {
            push_text(
                entries,
                offset,
                "user",
                "You",
                &extract_user_query(&raw),
                USER_CAP,
            );
        }
        return;
    };

    let mut text = Vec::new();
    let mut thinking = Vec::new();
    let mut tools = Vec::new();
    for block in blocks {
        let kind = block.get("type").and_then(Value::as_str).unwrap_or("");
        match kind {
            "text" => {
                if let Some(piece) = block.get("text").and_then(Value::as_str) {
                    text.push(piece.to_string());
                }
            }
            "thinking" => {
                if let Some(piece) = block.get("thinking").and_then(Value::as_str) {
                    thinking.push(piece.to_string());
                }
            }
            "tool_use" => {
                let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
                let summary = args_summary(block.get("input").unwrap_or(&Value::Null));
                tools.push((name.to_string(), summary));
            }
            "tool_result" => {
                let raw = text_from_value(block.get("content").unwrap_or(&Value::Null));
                push_text(
                    entries,
                    offset,
                    "tool_result",
                    "Result",
                    &first_line(&raw),
                    RESULT_CAP,
                );
            }
            _ => {}
        }
    }
    if record == "assistant" {
        push_text(
            entries,
            offset,
            "reasoning",
            "Reasoning",
            &thinking.join("\n"),
            REASON_CAP,
        );
        push_text(
            entries,
            offset,
            "assistant",
            "Assistant",
            &text.join("\n"),
            ASSISTANT_CAP,
        );
    } else {
        push_text(
            entries,
            offset,
            "user",
            "You",
            &extract_user_query(&text.join("\n")),
            USER_CAP,
        );
    }
    for (name, summary) in tools {
        push_text(entries, offset, "tool", &name, &summary, ARG_CAP);
    }
}

fn reasoning_text(obj: &serde_json::Map<String, Value>) -> String {
    let Some(items) = obj.get("summary").and_then(Value::as_array) else {
        return String::new();
    };
    let mut parts = Vec::new();
    for item in items {
        if let Some(text) = item.get("text").and_then(Value::as_str) {
            let text = text.trim();
            if !text.is_empty() {
                parts.push(text.to_string());
            }
        }
    }
    parts.join("\n")
}

fn text_from_value(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(items) => {
            let mut parts = Vec::new();
            for item in items {
                if let Some(text) = item.get("text").and_then(Value::as_str) {
                    let kind = item.get("type").and_then(Value::as_str).unwrap_or("text");
                    if kind == "text" || kind == "input_text" || kind == "output_text" {
                        parts.push(text.to_string());
                    }
                } else if let Some(text) = item.as_str() {
                    parts.push(text.to_string());
                }
            }
            parts.join("\n")
        }
        _ => String::new(),
    }
}

fn extract_user_query(text: &str) -> String {
    if let Some(query) = last_tag(text, "user_query") {
        return query;
    }
    if text.contains("<user_info>") || text.contains("<system_reminder>") {
        return String::new();
    }
    text.trim().to_string()
}

fn last_tag(text: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut rest = text;
    let mut last = None;
    while let Some(index) = rest.find(&open) {
        let after = &rest[index + open.len()..];
        let Some(end) = after.find(&close) else {
            break;
        };
        let body = after[..end].trim();
        if !body.is_empty() {
            last = Some(body.to_string());
        }
        rest = &after[end + close.len()..];
    }
    last
}

fn args_summary(args: &Value) -> String {
    let owned;
    let obj = match args {
        Value::Object(_) => args,
        Value::String(text) => {
            owned = serde_json::from_str::<Value>(text).unwrap_or(Value::Null);
            &owned
        }
        _ => return String::new(),
    };
    let Some(map) = obj.as_object() else {
        return String::new();
    };
    for key in [
        "target_file",
        "file_path",
        "path",
        "pattern",
        "query",
        "url",
        "command",
    ] {
        if let Some(value) = map.get(key).and_then(Value::as_str) {
            let value = value.trim();
            if !value.is_empty() {
                return value.to_string();
            }
        }
    }
    String::new()
}

fn first_line(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .to_string()
}

fn push_text(
    entries: &mut Vec<ArtifactEntry>,
    offset: u64,
    kind: &str,
    label: &str,
    text: &str,
    cap: usize,
) {
    let body = text.trim();
    if body.is_empty() && kind != "tool" {
        return;
    }
    let id = format!("{offset}:{}", entries.len());
    entries.push(ArtifactEntry {
        id,
        offset,
        kind: kind.to_string(),
        label: label.to_string(),
        body: truncate_chars(body, cap),
    });
}

fn truncate_chars(text: &str, max: usize) -> String {
    if max == 0 {
        return String::new();
    }
    let mut iter = text.chars();
    let mut out = String::new();
    for _ in 0..max {
        match iter.next() {
            Some(ch) => out.push(ch),
            None => return out,
        }
    }
    if iter.next().is_some() {
        out.pop();
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::Duration;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("sparkmux-artifacts-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn touch(path: &Path, secs: u64) {
        let file = File::options().write(true).open(path).unwrap();
        file.set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(secs))
            .unwrap();
    }

    #[test]
    fn encode_grok_path_percent_encodes_slashes_and_spaces() {
        let path = Path::new("/Users/darrenkoh/github/sparkmux");
        assert_eq!(
            encode_grok_path(path),
            "%2FUsers%2Fdarrenkoh%2Fgithub%2Fsparkmux"
        );
        assert_eq!(percent_encode("/a b"), "%2Fa%20b");
    }

    #[test]
    fn encode_claude_path_uses_dashes() {
        let path = Path::new("/Users/darrenkoh/github/household-item-tracker");
        assert_eq!(
            encode_claude_path(path).as_deref(),
            Some("-Users-darrenkoh-github-household-item-tracker")
        );
        assert_eq!(encode_claude_path(Path::new("/")), None);
    }

    #[test]
    fn normalize_cwd_drops_dotdot() {
        let path = normalize_cwd("/tmp/proj/sub/../leaf").unwrap();
        assert_eq!(path, PathBuf::from("/tmp/proj/leaf"));
        assert!(normalize_cwd("relative/path").is_none());
    }

    #[test]
    fn grok_transcript_extracts_query_assistant_and_tool() {
        let raw = r#"
{"type":"system","content":"You are Grok"}
{"type":"user","content":[{"type":"text","text":"<user_info>os</user_info>\n<user_query>\nbuild the panel\n</user_query>"}]}
{"type":"reasoning","id":"r1","summary":[{"type":"summary_text","text":"check the layout"}],"encrypted_content":"SECRET","status":"completed"}
{"type":"assistant","content":"Done.","tool_calls":[{"id":"c1","name":"read_file","arguments":"{\"target_file\":\"src/App.tsx\"}"}]}
{"type":"tool_result","tool_call_id":"c1","content":"fn main() {\n}"}
"#;
        let dir = scratch("grok-parse");
        let path = dir.join("chat_history.jsonl");
        fs::write(&path, raw.trim_start()).unwrap();
        let (len, entries) = read_transcript(CliKind::Grok, &path, MAX_TAIL).unwrap();
        assert!(len > 0);
        let blob = entries
            .iter()
            .map(|entry| format!("{} {}", entry.label, entry.body))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(blob.contains("You build the panel"), "{blob}");
        assert!(blob.contains("Reasoning check the layout"), "{blob}");
        assert!(blob.contains("Assistant Done."), "{blob}");
        assert!(blob.contains("read_file src/App.tsx"), "{blob}");
        assert!(blob.contains("Result fn main()"), "{blob}");
        assert!(!blob.contains("SECRET"), "{blob}");
        assert!(!blob.contains("You are Grok"), "{blob}");
        assert!(!blob.contains("<user_info>"), "{blob}");
        assert!(entries
            .windows(2)
            .all(|pair| pair[0].offset <= pair[1].offset));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn claude_transcript_keeps_reply_and_skips_meta() {
        let raw = r#"
{"type":"user","isMeta":true,"message":{"role":"user","content":"hidden system"}}
{"type":"user","message":{"role":"user","content":"ship the panel"}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"look at the layout"},{"type":"text","text":"The panel is ready."},{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"src/App.tsx"}}]}}
{"type":"user","isSidechain":true,"message":{"role":"user","content":"side path"}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"file starts here\nrest"}]}}
"#;
        let dir = scratch("claude-parse");
        let path = dir.join("session.jsonl");
        fs::write(&path, raw.trim_start()).unwrap();
        let (_, entries) = read_transcript(CliKind::Claude, &path, MAX_TAIL).unwrap();
        let blob = entries
            .iter()
            .map(|entry| format!("{} {}", entry.kind, entry.body))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(blob.contains("user ship the panel"), "{blob}");
        assert!(blob.contains("reasoning look at the layout"), "{blob}");
        assert!(blob.contains("assistant The panel is ready."), "{blob}");
        assert!(blob.contains("tool src/App.tsx"), "{blob}");
        assert!(blob.contains("tool_result file starts here"), "{blob}");
        assert!(!blob.contains("hidden system"), "{blob}");
        assert!(!blob.contains("side path"), "{blob}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn newest_grok_session_wins_and_parent_cwd_matches() {
        let dir = scratch("grok-find");
        let project = dir.join("proj");
        fs::create_dir_all(project.join("sub")).unwrap();
        let sessions = dir.join("sessions");
        let encoded = encode_grok_path(&project);
        let older = sessions.join(&encoded).join("old");
        let newer = sessions.join(&encoded).join("new");
        fs::create_dir_all(&older).unwrap();
        fs::create_dir_all(&newer).unwrap();
        let old_file = older.join("chat_history.jsonl");
        let new_file = newer.join("chat_history.jsonl");
        fs::write(
            &old_file,
            "{\"type\":\"assistant\",\"content\":\"old reply\"}\n",
        )
        .unwrap();
        fs::write(
            &new_file,
            "{\"type\":\"assistant\",\"content\":\"new reply\"}\n",
        )
        .unwrap();
        touch(&old_file, 10);
        touch(&new_file, 50);
        let roots = TranscriptRoots {
            grok_sessions: sessions,
            claude_projects: dir.join("no-claude"),
        };
        let cwd = project.join("sub");
        let feed = load_artifacts("grok", &cwd.to_string_lossy(), "", &roots);
        assert_eq!(feed.cli.as_deref(), Some("grok"));
        assert!(
            feed.entries.iter().any(|entry| entry.body == "new reply"),
            "{feed:?}"
        );
        assert!(feed.entries.iter().all(|entry| entry.body != "old reply"));
        let shell = load_artifacts("zsh", &cwd.to_string_lossy(), "zsh", &roots);
        assert!(shell.cli.is_none());
        assert!(shell.entries.is_empty());
        let titled = load_artifacts("zsh", &cwd.to_string_lossy(), "grok", &roots);
        assert_eq!(titled.cli.as_deref(), Some("grok"));
        assert!(titled.entries.iter().any(|entry| entry.body == "new reply"));
        let versioned = load_artifacts("grok-1.0.50", &cwd.to_string_lossy(), "", &roots);
        assert_eq!(versioned.cli.as_deref(), Some("grok"));
        assert!(versioned
            .entries
            .iter()
            .any(|entry| entry.body == "new reply"));
        let status = load_artifacts(
            "zsh",
            &cwd.to_string_lossy(),
            "⠸ - Find a browser - Add pages - grok",
            &roots,
        );
        assert_eq!(status.cli.as_deref(), Some("grok"));
        let packaged = load_artifacts(
            "/Users/x/.grok/bin/grok-1.0.41-macos-aarch64",
            &cwd.to_string_lossy(),
            "",
            &roots,
        );
        assert_eq!(packaged.cli.as_deref(), Some("grok"));
        let other = load_artifacts("grokbot", &cwd.to_string_lossy(), "notes", &roots);
        assert!(other.cli.is_none());
        let extra = load_artifacts("grok-extra", &cwd.to_string_lossy(), "", &roots);
        assert!(extra.cli.is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn symlink_outside_the_root_is_ignored() {
        let dir = scratch("grok-link");
        let project = dir.join("proj");
        fs::create_dir_all(&project).unwrap();
        let outside = dir.join("outside.jsonl");
        fs::write(
            &outside,
            "{\"type\":\"assistant\",\"content\":\"secret-outside\"}\n",
        )
        .unwrap();
        let sessions = dir.join("sessions");
        let sess = sessions.join(encode_grok_path(&project)).join("s1");
        fs::create_dir_all(&sess).unwrap();
        std::os::unix::fs::symlink(&outside, sess.join("chat_history.jsonl")).unwrap();
        let roots = TranscriptRoots {
            grok_sessions: sessions,
            claude_projects: dir.join("no-claude"),
        };
        let feed = load_artifacts("grok", &project.to_string_lossy(), "", &roots);
        assert!(feed.transcript_path.is_none(), "{feed:?}");
        assert!(feed.entries.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn claude_project_dir_is_found_from_cwd() {
        let dir = scratch("claude-find");
        let project = dir.join("repo");
        fs::create_dir_all(&project).unwrap();
        let projects = dir.join("projects");
        let encoded = encode_claude_path(&project).unwrap();
        let folder = projects.join(encoded);
        fs::create_dir_all(&folder).unwrap();
        fs::write(
            folder.join("abc.jsonl"),
            "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":\"hello from claude\"}}\n",
        )
        .unwrap();
        let roots = TranscriptRoots {
            grok_sessions: dir.join("no-grok"),
            claude_projects: projects,
        };
        let feed = load_artifacts("zsh", &project.to_string_lossy(), "Claude Code", &roots);
        assert_eq!(feed.cli.as_deref(), Some("claude"));
        assert!(
            feed.entries
                .iter()
                .any(|entry| entry.body == "hello from claude"),
            "{feed:?}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn tail_skips_a_partial_first_line() {
        let dir = scratch("tail");
        let path = dir.join("chat_history.jsonl");
        let first = "{\"type\":\"assistant\",\"content\":\"first record is deliberately long\"}\n";
        let second = "{\"type\":\"assistant\",\"content\":\"second record\"}\n";
        fs::write(&path, format!("{first}{second}")).unwrap();
        let (_, entries) = read_transcript(CliKind::Grok, &path, second.len() as u64 + 12).unwrap();
        assert!(
            entries.iter().any(|entry| entry.body == "second record"),
            "{entries:?}"
        );
        assert!(entries
            .iter()
            .all(|entry| entry.body != "first record is deliberately long"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn output_panel_is_wired_without_touching_the_pane() {
        let app = include_str!("../../src/App.tsx");
        assert!(app.contains("ArtifactPanel"));
        assert!(app.contains("outputOpen"));
        let bar = include_str!("../../src/chrome/StatusBar.tsx");
        assert!(bar.contains("status-output"));
        assert!(bar.contains("aria-label=\"Agent output\""));
        let panel = include_str!("../../src/chrome/ArtifactPanel.tsx");
        assert!(panel.contains("Clear"));
        assert!(panel.contains("Collapse"));
        assert!(panel.contains("paneArtifacts"));
        let lib = include_str!("lib.rs");
        assert!(lib.contains("artifacts::pane_artifacts"));
    }
}
