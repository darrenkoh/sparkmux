//! Read-only view of a Grok Build, Claude Code, or Antigravity CLI transcript.
//!
//! The pane keeps its own `%output` stream. This module never writes to tmux
//! or to a CLI's files. It only opens a transcript under the user's home
//! directory, and only when the focused pane is Grok, Claude, or Antigravity
//! (`agy`). tmux reports the real executable name, so a `grok` symlink to
//! `grok-1.0.50` shows up as `grok-1.0.50`. Grok's pane title ends in ` - grok`.
//!
//! One project directory holds every console started there. The pane's process
//! picks its own file: Grok lists `session_id`, `pid`, and `cwd` in
//! `~/.grok/active_sessions.json`. Antigravity's active conversation for a
//! workspace is the id in `~/.gemini/antigravity-cli/cache/last_conversations.json`.
//! A title match and an open transcript file are the fallbacks. Several
//! transcripts are never merged into one feed. The editor store under
//! `~/.gemini/antigravity` is not this CLI transcript.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};

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
pub(crate) enum CliKind {
    Grok,
    Claude,
    Antigravity,
}

impl CliKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Grok => "grok",
            Self::Claude => "claude",
            Self::Antigravity => "antigravity",
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
    /// `~/.grok/active_sessions.json`. One record per live Grok process.
    pub grok_active_sessions: PathBuf,
    /// `~/.gemini/antigravity-cli`. Transcripts live under `brain/<id>/`.
    pub agy_root: PathBuf,
}

pub(crate) fn default_roots() -> TranscriptRoots {
    match directories::UserDirs::new() {
        Some(dirs) => {
            let home = dirs.home_dir();
            TranscriptRoots {
                grok_sessions: home.join(".grok").join("sessions"),
                claude_projects: home.join(".claude").join("projects"),
                grok_active_sessions: home.join(".grok").join("active_sessions.json"),
                agy_root: home.join(".gemini").join("antigravity-cli"),
            }
        }
        None => TranscriptRoots {
            grok_sessions: PathBuf::new(),
            claude_projects: PathBuf::new(),
            grok_active_sessions: PathBuf::new(),
            agy_root: PathBuf::new(),
        },
    }
}

#[tauri::command]
pub async fn pane_artifacts(
    command: String,
    cwd: String,
    title: String,
    pid: u32,
) -> Result<ArtifactFeed, String> {
    let roots = default_roots();
    tokio::task::spawn_blocking(move || load_artifacts(&command, &cwd, &title, pid, &roots))
        .await
        .map_err(|err| err.to_string())
}

pub fn load_artifacts(
    command: &str,
    cwd: &str,
    title: &str,
    pid: u32,
    roots: &TranscriptRoots,
) -> ArtifactFeed {
    load_for_family(command, cwd, title, &pane_family(pid), roots)
}

fn load_for_family(
    command: &str,
    cwd: &str,
    title: &str,
    family: &[(u32, u8)],
    roots: &TranscriptRoots,
) -> ArtifactFeed {
    // tmux reports the foreground executable's real file name (`grok-1.0.50`),
    // which differs from argv0 (`grok`). The pane title stays a status line
    // ending in ` - grok`, `Claude Code`, or Antigravity while the shell is
    // still the process tmux names, and after the CLI has returned to the prompt.
    let Some(kind) = cli_kind(command).or_else(|| cli_kind(title)) else {
        return ArtifactFeed::none();
    };
    let Some(path) = select_transcript(kind, cwd, title, family, roots) else {
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

pub(crate) fn cli_kind(value: &str) -> Option<CliKind> {
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
    if name == "agy" || name.starts_with("agy ") || versioned_bin(name, "agy") {
        return Some(CliKind::Antigravity);
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
/// Antigravity titles name the product or the `agy` binary. A hyphenated
/// command such as `agy-extra` is not a title match; versioned `agy-1.2`
/// is handled by [`versioned_bin`].
fn titled_cli(name: &str) -> Option<CliKind> {
    let last = name.rsplit(" - ").next().unwrap_or(name).trim();
    match last {
        "grok" => return Some(CliKind::Grok),
        "claude" | "claude code" => return Some(CliKind::Claude),
        "agy" | "antigravity" => return Some(CliKind::Antigravity),
        _ => {}
    }
    if name.contains("antigravity") || name.split_whitespace().any(|part| part == "agy") {
        return Some(CliKind::Antigravity);
    }
    None
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

struct ActiveSession {
    session_id: String,
    pid: u32,
    cwd: String,
    opened_at: String,
}

/// The pane pid, then its descendants, each with a depth from the pane.
/// Depth 0 is the pane process itself. A shell's Grok child is depth 1.
pub(crate) fn pane_family(root: u32) -> Vec<(u32, u8)> {
    if root == 0 {
        return Vec::new();
    }
    let mut out = vec![(root, 0u8)];
    let mut frontier = vec![root];
    for depth in 1..=6u8 {
        if frontier.is_empty() || out.len() >= 64 {
            break;
        }
        let mut next = Vec::new();
        for pid in frontier {
            for child in child_pids(pid) {
                if out.len() >= 64 {
                    break;
                }
                if out.iter().any(|(id, _)| *id == child) {
                    continue;
                }
                out.push((child, depth));
                next.push(child);
            }
        }
        frontier = next;
    }
    out
}

pub(crate) fn select_transcript(
    kind: CliKind,
    cwd: &str,
    title: &str,
    family: &[(u32, u8)],
    roots: &TranscriptRoots,
) -> Option<PathBuf> {
    if kind == CliKind::Antigravity {
        return select_agy(cwd, family, roots);
    }
    if let Some(path) = grok_active_transcript(kind, cwd, family, roots) {
        return Some(path);
    }
    let found = transcripts_for_cwd(kind, cwd, roots);
    if let Some(path) = match_title(kind, &found, title) {
        return Some(path);
    }
    if found.len() == 1 {
        return found.into_iter().next();
    }
    open_transcript(kind, family, title, roots)
}

/// The workspace's active Antigravity conversation, jailed to the CLI store.
///
/// `last_conversations.json` maps a workspace path to one conversation id.
/// An array value means several conversations share the project; the open
/// transcript is the tie-break, and anything still ambiguous stays unread.
/// A nearer directory wins over a parent, so another workspace cannot leak in.
fn select_agy(cwd: &str, family: &[(u32, u8)], roots: &TranscriptRoots) -> Option<PathBuf> {
    let found = agy_for_cwd(cwd, roots);
    if found.len() == 1 {
        return found.into_iter().next();
    }
    if found.len() > 1 {
        let open = opened_transcripts(CliKind::Antigravity, family, &roots.agy_root);
        let mut hits: Vec<PathBuf> = open
            .into_iter()
            .filter(|path| found.contains(path))
            .collect();
        if hits.len() == 1 {
            return hits.pop();
        }
    }
    None
}

fn agy_for_cwd(cwd: &str, roots: &TranscriptRoots) -> Vec<PathBuf> {
    let Some(mut dir) = normalize_cwd(cwd) else {
        return Vec::new();
    };
    if roots.agy_root.as_os_str().is_empty() {
        return Vec::new();
    }
    let index =
        read_last_conversations(&roots.agy_root.join("cache").join("last_conversations.json"));
    for _ in 0..8 {
        if let Some(ids) = index.get(&dir) {
            let mut hits = Vec::new();
            for id in ids {
                if let Some(path) = agy_transcript(&roots.agy_root, id) {
                    if !hits.contains(&path) {
                        hits.push(path);
                    }
                }
            }
            return hits;
        }
        if !dir.pop() {
            break;
        }
    }
    Vec::new()
}

fn agy_transcript(root: &Path, id: &str) -> Option<PathBuf> {
    if !safe_component(id) {
        return None;
    }
    let path = root
        .join("brain")
        .join(id)
        .join(".system_generated")
        .join("logs")
        .join("transcript.jsonl");
    under_jail(root, &path)
}

fn read_last_conversations(path: &Path) -> HashMap<PathBuf, Vec<String>> {
    let Ok(file) = File::open(path) else {
        return HashMap::new();
    };
    let Ok(value) = serde_json::from_reader::<_, Value>(file.take(1024 * 1024)) else {
        return HashMap::new();
    };
    let Some(obj) = value.as_object() else {
        return HashMap::new();
    };
    let mut out = HashMap::new();
    for (key, val) in obj {
        let Some(workspace) = workspace_key(key) else {
            continue;
        };
        let ids = conversation_ids(val);
        if !ids.is_empty() {
            out.insert(workspace, ids);
        }
    }
    out
}

fn conversation_ids(value: &Value) -> Vec<String> {
    let mut out = Vec::new();
    match value {
        Value::String(id) => {
            if let Some(id) = clean_conversation_id(id) {
                out.push(id);
            }
        }
        Value::Array(items) => {
            for item in items {
                if let Some(id) = item.as_str().and_then(clean_conversation_id) {
                    if !out.contains(&id) {
                        out.push(id);
                    }
                }
            }
        }
        _ => {}
    }
    out
}

fn clean_conversation_id(id: &str) -> Option<String> {
    let id = id.trim();
    if safe_component(id) {
        Some(id.to_string())
    } else {
        None
    }
}

/// `last_conversations.json` uses absolute paths. Summaries use `file://` URIs.
fn workspace_key(text: &str) -> Option<PathBuf> {
    let text = text.trim();
    let text = text.strip_prefix("file://").unwrap_or(text);
    normalize_cwd(&percent_decode_path(text))
}

fn percent_decode_path(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn grok_active_transcript(
    kind: CliKind,
    pane_cwd: &str,
    family: &[(u32, u8)],
    roots: &TranscriptRoots,
) -> Option<PathBuf> {
    if kind != CliKind::Grok || family.is_empty() {
        return None;
    }
    let sessions = read_active_sessions(&roots.grok_active_sessions);
    let best = best_active(&sessions, family, pane_cwd)?;
    if !safe_component(&best.session_id) {
        return None;
    }
    let cwd = normalize_cwd(&best.cwd)?;
    let path = roots
        .grok_sessions
        .join(encode_grok_path(&cwd))
        .join(&best.session_id)
        .join("chat_history.jsonl");
    under_jail(&roots.grok_sessions, &path)
}

fn best_active<'a>(
    sessions: &'a [ActiveSession],
    family: &[(u32, u8)],
    pane_cwd: &str,
) -> Option<&'a ActiveSession> {
    let pane_cwd = normalize_cwd(pane_cwd);
    let mut best: Option<(u8, bool, &str, &ActiveSession)> = None;
    for session in sessions {
        let Some((_, depth)) = family.iter().find(|(pid, _)| *pid == session.pid) else {
            continue;
        };
        let same_cwd = pane_cwd
            .as_ref()
            .is_some_and(|cwd| normalize_cwd(&session.cwd).as_ref() == Some(cwd));
        let replace = match best {
            None => true,
            Some((prev_depth, prev_cwd, prev_opened, _)) => {
                *depth < prev_depth
                    || (*depth == prev_depth && same_cwd && !prev_cwd)
                    || (*depth == prev_depth
                        && same_cwd == prev_cwd
                        && session.opened_at.as_str() > prev_opened)
            }
        };
        if replace {
            best = Some((*depth, same_cwd, session.opened_at.as_str(), session));
        }
    }
    best.map(|(_, _, _, session)| session)
}

fn read_active_sessions(path: &Path) -> Vec<ActiveSession> {
    let Ok(file) = File::open(path) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_reader::<_, Value>(file.take(256 * 1024)) else {
        return Vec::new();
    };
    let Some(items) = value.as_array() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in items {
        let Some(id) = item.get("session_id").and_then(Value::as_str) else {
            continue;
        };
        if !safe_component(id) {
            continue;
        }
        let Some(pid) = item.get("pid").and_then(Value::as_u64) else {
            continue;
        };
        if pid == 0 || pid > u64::from(u32::MAX) {
            continue;
        }
        out.push(ActiveSession {
            session_id: id.to_string(),
            pid: pid as u32,
            cwd: item
                .get("cwd")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            opened_at: item
                .get("opened_at")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        });
    }
    out
}

/// Transcripts in the nearest project directory, walking up to eight parents.
/// The first directory that has any session wins, so a parent project does not
/// leak into a nested one.
fn transcripts_for_cwd(kind: CliKind, cwd: &str, roots: &TranscriptRoots) -> Vec<PathBuf> {
    let Some(mut path) = normalize_cwd(cwd) else {
        return Vec::new();
    };
    let jail = match kind {
        CliKind::Grok => &roots.grok_sessions,
        CliKind::Claude => &roots.claude_projects,
        CliKind::Antigravity => return Vec::new(),
    };
    if jail.as_os_str().is_empty() {
        return Vec::new();
    }
    for _ in 0..8 {
        let name = match kind {
            CliKind::Grok => encode_grok_path(&path),
            CliKind::Claude => match encode_claude_path(&path) {
                Some(name) => name,
                None => break,
            },
            CliKind::Antigravity => break,
        };
        if safe_component(&name) {
            let found = transcripts_in(kind, &jail.join(&name), jail);
            if !found.is_empty() {
                return found;
            }
        }
        if !path.pop() {
            break;
        }
    }
    Vec::new()
}

fn transcripts_in(kind: CliKind, dir: &Path, jail: &Path) -> Vec<PathBuf> {
    if !dir.is_dir() {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        if out.len() >= 128 {
            break;
        }
        let candidate = match kind {
            CliKind::Grok => entry.path().join("chat_history.jsonl"),
            CliKind::Antigravity => continue,
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
        if let Some(canon) = under_jail(jail, &candidate) {
            out.push(canon);
        }
    }
    out
}

/// Longest `generated_title` that appears in the pane title. Short titles are
/// skipped so a status word like "Thinking" does not bind the wrong session.
fn match_title(kind: CliKind, paths: &[PathBuf], title: &str) -> Option<PathBuf> {
    if kind != CliKind::Grok {
        return None;
    }
    let hay = title.to_ascii_lowercase();
    if hay.trim().is_empty() {
        return None;
    }
    let mut best: Option<(usize, &Path)> = None;
    for path in paths {
        let Some(generated) = generated_title(path) else {
            continue;
        };
        let needle = generated.trim().to_ascii_lowercase();
        let len = needle.chars().count();
        if len < 12 || !hay.contains(&needle) {
            continue;
        }
        let replace = match best {
            None => true,
            Some((prev, _)) => len > prev,
        };
        if replace {
            best = Some((len, path));
        }
    }
    best.map(|(_, path)| path.to_path_buf())
}

fn generated_title(transcript: &Path) -> Option<String> {
    let summary = transcript.parent()?.join("summary.json");
    let file = File::open(summary).ok()?;
    let value: Value = serde_json::from_reader(file.take(64 * 1024)).ok()?;
    let text = value.get("generated_title").and_then(Value::as_str)?.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

fn open_transcript(
    kind: CliKind,
    family: &[(u32, u8)],
    title: &str,
    roots: &TranscriptRoots,
) -> Option<PathBuf> {
    let jail = match kind {
        CliKind::Grok => &roots.grok_sessions,
        CliKind::Claude => &roots.claude_projects,
        CliKind::Antigravity => &roots.agy_root,
    };
    let hits = opened_transcripts(kind, family, jail);
    if hits.len() == 1 {
        return hits.into_iter().next();
    }
    match_title(kind, &hits, title)
}

fn opened_transcripts(kind: CliKind, family: &[(u32, u8)], jail: &Path) -> Vec<PathBuf> {
    if family.is_empty() || jail.as_os_str().is_empty() {
        return Vec::new();
    }
    let mut hits = Vec::new();
    for (pid, _) in family {
        for path in open_paths(*pid) {
            let Some(transcript) = transcript_from_open(kind, &path, jail) else {
                continue;
            };
            if !hits.contains(&transcript) {
                hits.push(transcript);
            }
            if hits.len() >= 32 {
                return hits;
            }
        }
    }
    hits
}

fn transcript_from_open(kind: CliKind, path: &Path, jail: &Path) -> Option<PathBuf> {
    match kind {
        CliKind::Grok => {
            let name = path.file_name()?.to_str()?;
            if name != "chat_history.jsonl" && name != "events.jsonl" {
                return None;
            }
            under_jail(jail, &path.parent()?.join("chat_history.jsonl"))
        }
        CliKind::Claude => {
            let ext = path.extension()?.to_str()?;
            if ext != "jsonl" {
                return None;
            }
            under_jail(jail, path)
        }
        CliKind::Antigravity => {
            let name = path.file_name()?.to_str()?;
            if name != "transcript.jsonl" && name != "transcript_full.jsonl" {
                return None;
            }
            under_jail(jail, &path.parent()?.join("transcript.jsonl"))
        }
    }
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

fn child_pids(ppid: u32) -> Vec<u32> {
    #[cfg(target_os = "macos")]
    {
        macos_child_pids(ppid)
    }
    #[cfg(target_os = "linux")]
    {
        linux_child_pids(ppid)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = ppid;
        Vec::new()
    }
}

fn open_paths(pid: u32) -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        macos_open_paths(pid)
    }
    #[cfg(target_os = "linux")]
    {
        linux_open_paths(pid)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = pid;
        Vec::new()
    }
}

#[cfg(target_os = "macos")]
mod macos_proc {
    use std::path::PathBuf;

    /// `vnode_fdinfowithpath` is 1200 bytes on the macOS 15.4 and 26.5 SDKs.
    /// `proc_pidfdinfo` rejects any other size. The path is a C string at byte 176.
    const VNODE_PATH_SIZE: i32 = 1200;
    const VNODE_PATH_OFFSET: usize = 176;
    const PROC_PIDLISTFDS: i32 = 1;
    const PROC_PIDFDVNODEPATHINFO: i32 = 2;
    const FDTYPE_VNODE: u32 = 1;

    #[link(name = "proc")]
    unsafe extern "C" {
        fn proc_listchildpids(ppid: i32, buffer: *mut std::ffi::c_void, buffersize: i32) -> i32;
        fn proc_pidinfo(
            pid: i32,
            flavor: i32,
            arg: u64,
            buffer: *mut std::ffi::c_void,
            buffersize: i32,
        ) -> i32;
        fn proc_pidfdinfo(
            pid: i32,
            fd: i32,
            flavor: i32,
            buffer: *mut std::ffi::c_void,
            buffersize: i32,
        ) -> i32;
    }

    pub fn child_pids(ppid: u32) -> Vec<u32> {
        let mut buf = [0i32; 64];
        let n = unsafe {
            proc_listchildpids(
                ppid as i32,
                buf.as_mut_ptr().cast(),
                (buf.len() * std::mem::size_of::<i32>()) as i32,
            )
        };
        if n <= 0 {
            return Vec::new();
        }
        let n = (n as usize).min(buf.len());
        buf[..n]
            .iter()
            .copied()
            .filter(|pid| *pid > 0)
            .map(|pid| pid as u32)
            .collect()
    }

    pub fn open_paths(pid: u32) -> Vec<PathBuf> {
        let mut raw = vec![0u8; 8 * 256];
        let got = unsafe {
            proc_pidinfo(
                pid as i32,
                PROC_PIDLISTFDS,
                0,
                raw.as_mut_ptr().cast(),
                raw.len() as i32,
            )
        };
        if got <= 0 {
            return Vec::new();
        }
        let count = (got as usize).min(raw.len()) / 8;
        let mut out = Vec::new();
        for index in 0..count {
            let base = index * 8;
            let fd = i32::from_ne_bytes(raw[base..base + 4].try_into().unwrap_or([0; 4]));
            let kind = u32::from_ne_bytes(raw[base + 4..base + 8].try_into().unwrap_or([0; 4]));
            if kind != FDTYPE_VNODE {
                continue;
            }
            if let Some(path) = fd_path(pid, fd) {
                out.push(path);
            }
            if out.len() >= 64 {
                break;
            }
        }
        out
    }

    fn fd_path(pid: u32, fd: i32) -> Option<PathBuf> {
        let mut buf = vec![0u8; VNODE_PATH_SIZE as usize];
        let rc = unsafe {
            proc_pidfdinfo(
                pid as i32,
                fd,
                PROC_PIDFDVNODEPATHINFO,
                buf.as_mut_ptr().cast(),
                VNODE_PATH_SIZE,
            )
        };
        if rc != VNODE_PATH_SIZE {
            return None;
        }
        let bytes = buf.get(VNODE_PATH_OFFSET..VNODE_PATH_OFFSET + 1024)?;
        let nul = bytes
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(bytes.len());
        let text = std::str::from_utf8(&bytes[..nul]).ok()?;
        if text.starts_with('/') {
            Some(PathBuf::from(text))
        } else {
            None
        }
    }
}

#[cfg(target_os = "macos")]
fn macos_child_pids(ppid: u32) -> Vec<u32> {
    macos_proc::child_pids(ppid)
}

#[cfg(target_os = "macos")]
fn macos_open_paths(pid: u32) -> Vec<PathBuf> {
    macos_proc::open_paths(pid)
}

#[cfg(target_os = "linux")]
fn linux_child_pids(ppid: u32) -> Vec<u32> {
    let Ok(dir) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in dir.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        if ppid_of(pid) == Some(ppid) {
            out.push(pid);
        }
        if out.len() >= 64 {
            break;
        }
    }
    out
}

#[cfg(target_os = "linux")]
fn ppid_of(pid: u32) -> Option<u32> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let end = text.rfind(')')?;
    let mut fields = text[end + 1..].split_whitespace();
    let _state = fields.next()?;
    fields.next()?.parse().ok()
}

#[cfg(target_os = "linux")]
fn linux_open_paths(pid: u32) -> Vec<PathBuf> {
    let Ok(dir) = std::fs::read_dir(format!("/proc/{pid}/fd")) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in dir.flatten() {
        if let Ok(target) = std::fs::read_link(entry.path()) {
            if target.is_absolute() {
                out.push(target);
            }
        }
        if out.len() >= 64 {
            break;
        }
    }
    out
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
    let marker = b"truncated_fields";
    let needs_full =
        kind == CliKind::Antigravity && buf.windows(marker.len()).any(|word| word == marker);

    let mut offset = start;
    let mut lines = buf.split(|&byte| byte == b'\n');
    if skip_partial {
        if let Some(partial) = lines.next() {
            offset = offset.saturating_add(partial.len() as u64 + 1);
        }
    }

    let full_steps = if needs_full {
        load_full_steps(path)
    } else {
        HashMap::new()
    };

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
            CliKind::Antigravity => {
                let step = step_index(&value);
                push_agy(
                    &mut entries,
                    line_off,
                    &value,
                    step.and_then(|index| full_steps.get(&index)),
                );
            }
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
                "Thinking",
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
            "Thinking",
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

fn step_index(value: &Value) -> Option<i64> {
    let index = value.get("step_index")?;
    index
        .as_i64()
        .or_else(|| index.as_u64().and_then(|n| i64::try_from(n).ok()))
}

/// `transcript.jsonl` marks oversized fields and keeps the rest in the sibling log.
fn load_full_steps(transcript: &Path) -> HashMap<i64, Value> {
    let Some(path) = jailed_sibling(transcript, "transcript_full.jsonl") else {
        return HashMap::new();
    };
    let Ok(file) = File::open(path) else {
        return HashMap::new();
    };
    let mut buf = Vec::new();
    if file.take(32 * 1024 * 1024).read_to_end(&mut buf).is_err() {
        return HashMap::new();
    }
    let mut out = HashMap::new();
    for line in buf.split(|&byte| byte == b'\n') {
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        if let Some(index) = step_index(&value) {
            out.insert(index, value);
        }
    }
    out
}

fn jailed_sibling(transcript: &Path, name: &str) -> Option<PathBuf> {
    let parent = transcript.parent()?;
    let parent = parent.canonicalize().ok()?;
    let file = parent.join(name).canonicalize().ok()?;
    file.starts_with(&parent).then_some(file)
}

fn resolve_truncated(value: &Value, full: Option<&Value>) -> Value {
    let Some(obj) = value.as_object() else {
        return value.clone();
    };
    let Some(fields) = obj.get("truncated_fields").and_then(Value::as_array) else {
        return value.clone();
    };
    if fields.is_empty() {
        return value.clone();
    }
    let Some(full_obj) = full.and_then(Value::as_object) else {
        return value.clone();
    };
    let mut merged = obj.clone();
    for field in fields {
        let Some(name) = field.as_str() else {
            continue;
        };
        if let Some(full_val) = full_obj.get(name) {
            merged.insert(name.to_string(), full_val.clone());
        }
    }
    Value::Object(merged)
}

/// Checkpoints, system notes, and conversation-history copies are not the reply.
pub(crate) fn agy_bookkeeping(record_type: &str) -> bool {
    match record_type {
        "CHECKPOINT" | "SYSTEM_MESSAGE" | "ERROR_MESSAGE" | "CONVERSATION_HISTORY" => true,
        other => {
            let upper = other.to_ascii_uppercase();
            upper.contains("HISTORY") || upper.contains("CHECKPOINT")
        }
    }
}

/// Tool-result step. Published transcripts name the tool (`SEARCH_WEB`,
/// `RUN_COMMAND`, `VIEW_FILE`, `LIST_DIRECTORY`, `GREP_SEARCH`, `CODE_ACTION`).
/// Some logs collapse that step to `GENERIC`. User, planner, and bookkeeping
/// records are not results.
pub(crate) fn agy_tool_result(record_type: &str) -> bool {
    if record_type.is_empty() || agy_bookkeeping(record_type) {
        return false;
    }
    let upper = record_type.to_ascii_uppercase();
    !matches!(upper.as_str(), "USER_INPUT" | "PLANNER_RESPONSE")
}

fn history_blob(text: &str) -> bool {
    let head = text.trim_start();
    head.starts_with("# Resuming from a compaction")
        || head.contains("<CONVERSATION_HISTORY>")
        || head.starts_with("The following is a conversation history")
}

fn push_agy(entries: &mut Vec<ArtifactEntry>, offset: u64, value: &Value, full: Option<&Value>) {
    let Some(obj) = value.as_object() else {
        return;
    };
    let record = obj.get("type").and_then(Value::as_str).unwrap_or("");
    if agy_bookkeeping(record) {
        return;
    }
    let resolved = resolve_truncated(value, full);
    let Some(obj) = resolved.as_object() else {
        return;
    };
    match record {
        "USER_INPUT" => {
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
        "PLANNER_RESPONSE" => {
            let thinking = obj.get("thinking").and_then(Value::as_str).unwrap_or("");
            push_text(
                entries,
                offset,
                "reasoning",
                "Thinking",
                thinking,
                REASON_CAP,
            );
            let content = text_from_value(obj.get("content").unwrap_or(&Value::Null));
            push_text(
                entries,
                offset,
                "assistant",
                "Assistant",
                &content,
                ASSISTANT_CAP,
            );
            if let Some(calls) = obj.get("tool_calls").and_then(Value::as_array) {
                for call in calls {
                    let name = call.get("name").and_then(Value::as_str).unwrap_or("tool");
                    let summary = args_summary(tool_args(call));
                    push_text(entries, offset, "tool", name, &summary, ARG_CAP);
                }
            }
        }
        _ if agy_tool_result(record) => {
            let source = obj.get("source").and_then(Value::as_str).unwrap_or("");
            if source.eq_ignore_ascii_case("SYSTEM") {
                return;
            }
            let raw = text_from_value(obj.get("content").unwrap_or(&Value::Null));
            if history_blob(&raw) {
                return;
            }
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

pub(crate) fn tool_args(call: &Value) -> &Value {
    call.get("args")
        .or_else(|| call.get("arguments"))
        .or_else(|| call.get("input"))
        .unwrap_or(&Value::Null)
}

pub(crate) fn reasoning_text(obj: &serde_json::Map<String, Value>) -> String {
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

pub(crate) fn text_from_value(content: &Value) -> String {
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

pub(crate) fn extract_user_query(text: &str) -> String {
    if let Some(query) = last_tag(text, "user_query") {
        return query;
    }
    if let Some(query) = last_tag(text, "USER_REQUEST") {
        return query;
    }
    if text.contains("<user_info>")
        || text.contains("<system_reminder>")
        || text.contains("<ADDITIONAL_METADATA>")
        || text.contains("<USER_SETTINGS_CHANGE>")
    {
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

pub(crate) fn args_summary(args: &Value) -> String {
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
        "AbsolutePath",
        "TargetFile",
        "pattern",
        "query",
        "url",
        "Url",
        "command",
        "CommandLine",
        "Prompt",
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

pub(crate) fn truncate_chars(text: &str, max: usize) -> String {
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

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("sparkmux-artifacts-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn roots(dir: &Path, sessions: PathBuf, projects: PathBuf) -> TranscriptRoots {
        TranscriptRoots {
            grok_sessions: sessions,
            claude_projects: projects,
            grok_active_sessions: dir.join("active_sessions.json"),
            agy_root: dir.join("no-agy"),
        }
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
        assert!(blob.contains("Thinking check the layout"), "{blob}");
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

    fn write_grok(dir: &Path, session: &str, body: &str) {
        let folder = dir.join(session);
        fs::create_dir_all(&folder).unwrap();
        fs::write(
            folder.join("chat_history.jsonl"),
            format!("{{\"type\":\"assistant\",\"content\":\"{body}\"}}\n"),
        )
        .unwrap();
    }

    #[test]
    fn one_session_in_a_parent_directory_is_the_pane_transcript() {
        let dir = scratch("grok-find");
        let project = dir.join("proj");
        fs::create_dir_all(project.join("sub")).unwrap();
        let sessions = dir.join("sessions");
        let encoded = sessions.join(encode_grok_path(&project));
        write_grok(&encoded, "only", "only reply");
        let roots = roots(&dir, sessions, dir.join("no-claude"));
        let cwd = project.join("sub");
        let feed = load_artifacts("grok", &cwd.to_string_lossy(), "", 0, &roots);
        assert_eq!(feed.cli.as_deref(), Some("grok"));
        assert!(
            feed.entries.iter().any(|entry| entry.body == "only reply"),
            "{feed:?}"
        );
        let shell = load_artifacts("zsh", &cwd.to_string_lossy(), "zsh", 0, &roots);
        assert!(shell.cli.is_none());
        assert!(shell.entries.is_empty());
        let titled = load_artifacts("zsh", &cwd.to_string_lossy(), "grok", 0, &roots);
        assert_eq!(titled.cli.as_deref(), Some("grok"));
        assert!(titled
            .entries
            .iter()
            .any(|entry| entry.body == "only reply"));
        let versioned = load_artifacts("grok-1.0.50", &cwd.to_string_lossy(), "", 0, &roots);
        assert_eq!(versioned.cli.as_deref(), Some("grok"));
        let status = load_artifacts(
            "zsh",
            &cwd.to_string_lossy(),
            "⠸ - Find a browser - Add pages - grok",
            0,
            &roots,
        );
        assert_eq!(status.cli.as_deref(), Some("grok"));
        let packaged = load_artifacts(
            "/Users/x/.grok/bin/grok-1.0.41-macos-aarch64",
            &cwd.to_string_lossy(),
            "",
            0,
            &roots,
        );
        assert_eq!(packaged.cli.as_deref(), Some("grok"));
        let other = load_artifacts("grokbot", &cwd.to_string_lossy(), "notes", 0, &roots);
        assert!(other.cli.is_none());
        let extra = load_artifacts("grok-extra", &cwd.to_string_lossy(), "", 0, &roots);
        assert!(extra.cli.is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn pane_process_selects_its_session_and_other_consoles_stay_out() {
        let dir = scratch("grok-pid");
        let project = dir.join("proj");
        fs::create_dir_all(&project).unwrap();
        let sessions = dir.join("sessions");
        let encoded = sessions.join(encode_grok_path(&project));
        write_grok(&encoded, "old", "old reply");
        write_grok(&encoded, "new", "new reply");
        let cwd = project.to_string_lossy().into_owned();
        fs::write(
            dir.join("active_sessions.json"),
            format!(
                "[{{\"session_id\":\"old\",\"pid\":42,\"cwd\":\"{cwd}\",\"opened_at\":\"2026-01-01T00:00:00Z\"}},{{\"session_id\":\"new\",\"pid\":99,\"cwd\":\"{cwd}\",\"opened_at\":\"2026-06-01T00:00:00Z\"}}]"
            ),
        )
        .unwrap();
        let roots = roots(&dir, sessions, dir.join("no-claude"));
        // Shell pid 7, Grok child pid 42. The newer session belongs to another console.
        let feed = load_for_family(
            "grok-1.0.50",
            &cwd,
            "⠙ - Thinking - grok",
            &[(7, 0), (42, 1)],
            &roots,
        );
        assert!(
            feed.entries.iter().any(|entry| entry.body == "old reply"),
            "{feed:?}"
        );
        assert!(feed.entries.iter().all(|entry| entry.body != "new reply"));
        let unbound = load_artifacts("grok", &cwd, "", 0, &roots);
        assert!(unbound.transcript_path.is_none(), "{unbound:?}");
        assert!(unbound.entries.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn pane_title_selects_the_named_session() {
        let dir = scratch("grok-title");
        let project = dir.join("proj");
        fs::create_dir_all(&project).unwrap();
        let sessions = dir.join("sessions");
        let encoded = sessions.join(encode_grok_path(&project));
        write_grok(&encoded, "alpha", "alpha reply");
        write_grok(&encoded, "beta", "beta reply");
        fs::write(
            encoded.join("beta").join("summary.json"),
            "{\"generated_title\":\"Revert MiniMax H3 V2 to Turbo\"}\n",
        )
        .unwrap();
        fs::write(
            encoded.join("alpha").join("summary.json"),
            "{\"generated_title\":\"Color the output panel\"}\n",
        )
        .unwrap();
        let roots = roots(&dir, sessions, dir.join("no-claude"));
        let cwd = project.to_string_lossy().into_owned();
        let feed = load_artifacts(
            "grok-1.0.50",
            &cwd,
            "⠙ - Thinking - Revert MiniMax H3 V2 to Turbo - grok",
            0,
            &roots,
        );
        assert!(
            feed.entries.iter().any(|entry| entry.body == "beta reply"),
            "{feed:?}"
        );
        assert!(feed.entries.iter().all(|entry| entry.body != "alpha reply"));
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
        let roots = roots(&dir, sessions, dir.join("no-claude"));
        let feed = load_artifacts("grok", &project.to_string_lossy(), "", 0, &roots);
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
        let roots = roots(&dir, dir.join("no-grok"), projects);
        let feed = load_artifacts("zsh", &project.to_string_lossy(), "Claude Code", 0, &roots);
        assert_eq!(feed.cli.as_deref(), Some("claude"));
        assert!(
            feed.entries
                .iter()
                .any(|entry| entry.body == "hello from claude"),
            "{feed:?}"
        );
        fs::write(
            folder.join("other.jsonl"),
            "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":\"other console\"}}\n",
        )
        .unwrap();
        let mixed = load_artifacts(
            "claude",
            &project.to_string_lossy(),
            "Claude Code",
            0,
            &roots,
        );
        assert!(mixed.transcript_path.is_none(), "{mixed:?}");
        assert!(mixed.entries.is_empty());
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
        assert!(panel.contains("Auto scroll"));
        assert!(panel.contains("paneArtifacts"));
        assert!(app.contains("outputPaneForTab"));
        assert!(app.contains("pid={outputPane?.pid ?? 0}"));
        assert!(panel.contains("pid"));
        let css = include_str!("../../src/index.css");
        assert!(css.contains(".artifact-item.user"));
        assert!(css.contains(".artifact-item.reasoning"));
        assert!(css.contains(".artifact-item.assistant"));
        let lib = include_str!("lib.rs");
        assert!(lib.contains("artifacts::pane_artifacts"));
    }

    fn write_agy_conv(root: &Path, id: &str, body: &str, full: Option<&str>) {
        let logs = root
            .join("brain")
            .join(id)
            .join(".system_generated")
            .join("logs");
        fs::create_dir_all(&logs).unwrap();
        fs::write(logs.join("transcript.jsonl"), body).unwrap();
        if let Some(full) = full {
            fs::write(logs.join("transcript_full.jsonl"), full).unwrap();
        }
    }

    #[test]
    fn agy_load_selects_the_workspace_transcript_and_unwraps_steps() {
        let dir = scratch("agy-load");
        let root = dir.join("antigravity-cli");
        let proj_a = dir.join("proj-a");
        let proj_b = dir.join("proj-b");
        fs::create_dir_all(proj_a.join("sub")).unwrap();
        fs::create_dir_all(&proj_b).unwrap();
        let id_a = "aaaaaaaa-1111-4111-8111-111111111111";
        let id_b = "bbbbbbbb-2222-4222-8222-222222222222";
        let short = concat!(
            "{\"step_index\":1,\"type\":\"USER_INPUT\",\"status\":\"DONE\",\"created_at\":\"2026-10-10T01:00:00Z\",\"content\":\"<USER_REQUEST>\\nfix the alignment\\n</USER_REQUEST>\\n<ADDITIONAL_METADATA>\\nlocal time\\n</ADDITIONAL_METADATA>\\n<USER_SETTINGS_CHANGE>\\nhide the model id\\n</USER_SETTINGS_CHANGE>\"}\n",
            "{\"step_index\":2,\"type\":\"PLANNER_RESPONSE\",\"status\":\"DONE\",\"created_at\":\"2026-10-10T01:00:05Z\",\"thinking\":\"check the cells\",\"content\":\"The grid is fixed.\",\"tool_calls\":[{\"name\":\"run_command\",\"args\":{\"CommandLine\":\"cargo test\",\"Cwd\":\"/tmp/proj-a\"}}]}\n",
            "{\"step_index\":3,\"type\":\"RUN_COMMAND\",\"source\":\"MODEL\",\"status\":\"ERROR\",\"created_at\":\"2026-10-10T01:00:09Z\",\"error\":\"command failed\",\"content\":\"cut preview\\nrest\",\"truncated_fields\":[\"content\"]}\n",
            "{\"step_index\":7,\"type\":\"SEARCH_WEB\",\"source\":\"MODEL\",\"status\":\"DONE\",\"created_at\":\"2026-10-10T01:00:10Z\",\"content\":\"The search returned Cloud Run\\nrest\"}\n",
            "{\"step_index\":8,\"type\":\"VIEW_FILE\",\"source\":\"MODEL\",\"status\":\"DONE\",\"content\":\"File Path: artifacts.rs\\nline\"}\n",
            "{\"step_index\":9,\"type\":\"LIST_DIRECTORY\",\"source\":\"MODEL\",\"status\":\"DONE\",\"content\":\"Listed the workspace\\nmore\"}\n",
            "{\"step_index\":10,\"type\":\"GREP_SEARCH\",\"source\":\"MODEL\",\"status\":\"DONE\",\"content\":\"Matched agy_tool_result\\nmore\"}\n",
            "{\"step_index\":11,\"type\":\"CODE_ACTION\",\"source\":\"MODEL\",\"status\":\"ERROR\",\"error\":\"edit failed\",\"content\":\"Could not apply the edit\\nmore\"}\n",
            "{\"step_index\":12,\"type\":\"GENERIC\",\"source\":\"SYSTEM\",\"content\":\"generic system record\"}\n",
            "{\"step_index\":4,\"type\":\"CHECKPOINT\",\"status\":\"DONE\",\"content\":\"checkpoint secret\"}\n",
            "{\"step_index\":5,\"type\":\"SYSTEM_MESSAGE\",\"source\":\"SYSTEM\",\"status\":\"DONE\",\"content\":\"system bookkeeping\"}\n",
            "{\"step_index\":6,\"type\":\"CONVERSATION_HISTORY\",\"content\":\"old conversation history\"}\n",
        );
        let full = concat!(
            "{\"step_index\":3,\"type\":\"RUN_COMMAND\",\"source\":\"MODEL\",\"status\":\"ERROR\",\"content\":\"untruncated tool line\\nrest of the command output\"}\n",
        );
        write_agy_conv(&root, id_a, short, Some(full));
        write_agy_conv(
            &root,
            id_b,
            "{\"step_index\":1,\"type\":\"PLANNER_RESPONSE\",\"content\":\"other workspace reply\"}\n",
            None,
        );
        // Editor markdown is not the CLI transcript, even when it sits beside the store.
        let editor = dir.join("antigravity").join("brain").join(id_a);
        fs::create_dir_all(&editor).unwrap();
        fs::write(editor.join("task.md"), "editor brain markdown").unwrap();
        fs::create_dir_all(root.join("cache")).unwrap();
        let cwd_a = proj_a.to_string_lossy();
        let cwd_b = proj_b.to_string_lossy();
        fs::write(
            root.join("cache").join("last_conversations.json"),
            format!(
                "{{\"{cwd_a}\":\"{id_a}\",\"{cwd_b}\":\"{id_b}\",\"file://{cwd_a}\":\"{id_a}\"}}"
            ),
        )
        .unwrap();
        let mut roots = roots(&dir, dir.join("no-grok"), dir.join("no-claude"));
        roots.agy_root = root;

        let feed = load_artifacts("agy", &cwd_a, "", 0, &roots);
        assert_eq!(feed.cli.as_deref(), Some("antigravity"));
        let blob = feed
            .entries
            .iter()
            .map(|entry| format!("{} {} {}", entry.kind, entry.label, entry.body))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(blob.contains("user You fix the alignment"), "{blob}");
        assert!(!blob.contains("ADDITIONAL_METADATA"), "{blob}");
        assert!(!blob.contains("USER_SETTINGS_CHANGE"), "{blob}");
        assert!(
            blob.contains("reasoning Thinking check the cells"),
            "{blob}"
        );
        assert!(
            blob.contains("assistant Assistant The grid is fixed."),
            "{blob}"
        );
        assert!(blob.contains("tool run_command cargo test"), "{blob}");
        assert!(
            blob.contains("tool_result Result untruncated tool line"),
            "{blob}"
        );
        assert!(
            blob.contains("tool_result Result The search returned Cloud Run"),
            "{blob}"
        );
        assert!(
            blob.contains("tool_result Result File Path: artifacts.rs"),
            "{blob}"
        );
        assert!(
            blob.contains("tool_result Result Listed the workspace"),
            "{blob}"
        );
        assert!(
            blob.contains("tool_result Result Matched agy_tool_result"),
            "{blob}"
        );
        assert!(
            blob.contains("tool_result Result Could not apply the edit"),
            "{blob}"
        );
        assert!(!blob.contains("cut preview"), "{blob}");
        assert!(!blob.contains("generic system record"), "{blob}");
        assert!(!blob.contains("checkpoint secret"), "{blob}");
        assert!(!blob.contains("system bookkeeping"), "{blob}");
        assert!(!blob.contains("old conversation history"), "{blob}");
        assert!(!blob.contains("other workspace reply"), "{blob}");
        assert!(!blob.contains("editor brain markdown"), "{blob}");

        let nested = proj_a.join("sub");
        let from_child = load_artifacts("agy", &nested.to_string_lossy(), "", 0, &roots);
        assert!(
            from_child
                .entries
                .iter()
                .any(|entry| entry.body == "fix the alignment"),
            "{from_child:?}"
        );

        let titled = load_artifacts("zsh", &cwd_a, "Sparkmux - Antigravity", 0, &roots);
        assert_eq!(titled.cli.as_deref(), Some("antigravity"));
        let titled_agy = load_artifacts("zsh", &cwd_a, "agent agy", 0, &roots);
        assert_eq!(titled_agy.cli.as_deref(), Some("antigravity"));
        assert!(titled.transcript_path.is_some(), "{titled:?}");
        assert!(
            titled
                .entries
                .iter()
                .any(|entry| entry.body == "fix the alignment"),
            "{titled:?}"
        );

        let other = load_artifacts("agy", &cwd_b, "Antigravity", 0, &roots);
        assert!(
            other
                .entries
                .iter()
                .any(|entry| entry.body == "other workspace reply"),
            "{other:?}"
        );
        assert!(other
            .entries
            .iter()
            .all(|entry| entry.body != "fix the alignment"));

        let versioned = load_artifacts("/usr/local/bin/agy-1.2.3", &cwd_a, "", 0, &roots);
        assert_eq!(versioned.cli.as_deref(), Some("antigravity"));
        let windows = load_artifacts("agy.exe", &cwd_a, "", 0, &roots);
        assert_eq!(windows.cli.as_deref(), Some("antigravity"));

        let empty = load_artifacts("agy", "/tmp/sparkmux-no-agy-workspace", "", 0, &roots);
        assert_eq!(empty.cli.as_deref(), Some("antigravity"));
        assert!(empty.transcript_path.is_none(), "{empty:?}");
        assert!(empty.entries.is_empty());

        let shell = load_artifacts("zsh", &cwd_a, "zsh", 0, &roots);
        assert!(shell.cli.is_none(), "{shell:?}");
        let bot = load_artifacts("agybot", &cwd_a, "notes", 0, &roots);
        assert!(bot.cli.is_none(), "{bot:?}");
        let extra = load_artifacts("agy-extra", &cwd_a, "", 0, &roots);
        assert!(extra.cli.is_none(), "{extra:?}");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn agy_symlink_outside_the_store_is_ignored() {
        let dir = scratch("agy-link");
        let root = dir.join("antigravity-cli");
        let project = dir.join("proj");
        fs::create_dir_all(&project).unwrap();
        let outside = dir.join("outside.jsonl");
        fs::write(
            &outside,
            "{\"type\":\"PLANNER_RESPONSE\",\"content\":\"secret-outside\"}\n",
        )
        .unwrap();
        let id = "cccccccc-3333-4333-8333-333333333333";
        let logs = root
            .join("brain")
            .join(id)
            .join(".system_generated")
            .join("logs");
        fs::create_dir_all(&logs).unwrap();
        std::os::unix::fs::symlink(&outside, logs.join("transcript.jsonl")).unwrap();
        fs::create_dir_all(root.join("cache")).unwrap();
        let cwd = project.to_string_lossy();
        fs::write(
            root.join("cache").join("last_conversations.json"),
            format!("{{\"{cwd}\":\"{id}\"}}"),
        )
        .unwrap();
        let mut roots = roots(&dir, dir.join("no-grok"), dir.join("no-claude"));
        roots.agy_root = root;
        let feed = load_artifacts("agy", &cwd, "Antigravity", 0, &roots);
        assert_eq!(feed.cli.as_deref(), Some("antigravity"));
        assert!(feed.transcript_path.is_none(), "{feed:?}");
        assert!(feed.entries.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }
}
