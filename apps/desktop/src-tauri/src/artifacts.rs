//! Read-only view of a Grok Build or Claude Code transcript.
//!
//! The pane keeps its own `%output` stream. This module never writes to tmux.
//! It only opens `chat_history.jsonl` or a Claude session file under the
//! user's home directory, and only when the focused pane is Grok or Claude.
//! tmux reports the real executable name, so a `grok` symlink to
//! `grok-1.0.50` shows up as `grok-1.0.50`. Grok's pane title ends in ` - grok`.
//!
//! One project directory holds every console started there. The pane's process
//! picks its own file: Grok lists `session_id`, `pid`, and `cwd` in
//! `~/.grok/active_sessions.json`. A title match and an open transcript file
//! are the fallbacks. Several transcripts are never merged into one feed.

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
}

impl CliKind {
    pub(crate) fn as_str(self) -> &'static str {
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
    /// `~/.grok/active_sessions.json`. One record per live Grok process.
    pub grok_active_sessions: PathBuf,
}

pub(crate) fn default_roots() -> TranscriptRoots {
    match directories::UserDirs::new() {
        Some(dirs) => {
            let home = dirs.home_dir();
            TranscriptRoots {
                grok_sessions: home.join(".grok").join("sessions"),
                claude_projects: home.join(".claude").join("projects"),
                grok_active_sessions: home.join(".grok").join("active_sessions.json"),
            }
        }
        None => TranscriptRoots {
            grok_sessions: PathBuf::new(),
            claude_projects: PathBuf::new(),
            grok_active_sessions: PathBuf::new(),
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
    // ending in ` - grok` or `Claude Code` while the shell is still the
    // process tmux names, and after the CLI has returned to the prompt.
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
    if family.is_empty() {
        return None;
    }
    let jail = match kind {
        CliKind::Grok => &roots.grok_sessions,
        CliKind::Claude => &roots.claude_projects,
    };
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
                break;
            }
        }
    }
    if hits.len() == 1 {
        return hits.into_iter().next();
    }
    match_title(kind, &hits, title)
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
}
