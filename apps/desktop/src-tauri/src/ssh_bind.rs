//! Decide whether a pane may bind a local CLI transcript.
//!
//! An `ssh` foreground command never opens the Mac's `~/.grok`, `~/.claude`,
//! or `~/.gemini` trees. A readable remote store is a cache directory shaped
//! like that user's home. Pid 0 never fetches and never sees a staged store.
//! The fetch parses `ps` argv, then runs `ssh` with that host as its own
//! argument (`BatchMode`, short connect timeout). It does not use a local shell.

use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{LazyLock, Mutex, MutexGuard};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranscriptBind {
    Local,
    Empty,
    Remote,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteRoots {
    pub grok_sessions: PathBuf,
    pub claude_projects: PathBuf,
    pub grok_active_sessions: PathBuf,
    pub agy_root: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BindRoots {
    /// Use the roots the caller already has. This is the local pane path.
    UseCaller,
    /// Do not open any transcript. Never falls through to a different home.
    Empty,
    Remote(RemoteRoots),
}

struct CacheEntry {
    at: Instant,
    roots: Option<RemoteRoots>,
}

struct Connection {
    program: String,
    destination: String,
    port: Option<u16>,
    identities: Vec<String>,
    jump: Option<String>,
}

static STAGED: LazyLock<Mutex<HashMap<u32, RemoteRoots>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static CACHE: LazyLock<Mutex<HashMap<u32, CacheEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static INFLIGHT: LazyLock<Mutex<HashSet<u32>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

const HIT: Duration = Duration::from_secs(60);
const MISS: Duration = Duration::from_secs(30);
const FETCH_LIMIT: Duration = Duration::from_secs(20);
const MAX_FILE: u64 = 64 * 1024 * 1024;
const MAX_TOTAL: u64 = 256 * 1024 * 1024;
const MAX_FILES: usize = 4_000;

const REMOTE_READ: &str = r#"export LC_ALL=C
cd "$HOME" || exit 1
find .grok/sessions .grok/active_sessions.json .claude/projects .gemini/antigravity-cli -type f 2>/dev/null |
while IFS= read -r f; do
  case "$f" in
    .grok/sessions/*|.grok/active_sessions.json|.claude/projects/*|.gemini/antigravity-cli/*) ;;
    *) continue ;;
  esac
  case "$f" in
    *..*) continue ;;
  esac
  size=$(wc -c < "$f" | tr -d ' ') || continue
  case "$size" in
    ''|*[!0-9]*) continue ;;
  esac
  printf 'SPARKMUX1\n%s\n%s\n' "$size" "$f" || exit 1
  cat < "$f" || exit 1
done
exit 0
"#;

pub fn ssh_foreground(command: &str) -> bool {
    let Some(token) = command.split_whitespace().next() else {
        return false;
    };
    let base = token.rsplit(['/', '\\']).next().unwrap_or(token);
    let base = base.to_ascii_lowercase();
    base == "ssh" || base == "ssh.exe"
}

pub fn bind_transcript(command: &str, remote_readable: bool) -> TranscriptBind {
    if !ssh_foreground(command) {
        return TranscriptBind::Local;
    }
    if remote_readable {
        TranscriptBind::Remote
    } else {
        TranscriptBind::Empty
    }
}

/// Pid 0 is the attention poll. It must not fetch and must not see a staged store.
pub(crate) fn stage_remote_roots(pid: u32, roots: RemoteRoots) {
    if pid == 0 || roots_are_user_home(&roots) {
        return;
    }
    lock(&STAGED).insert(pid, roots);
}

#[cfg(test)]
pub(crate) fn clear_remote_roots(pid: u32) {
    lock(&STAGED).remove(&pid);
    lock(&CACHE).remove(&pid);
}

/// Staged or cached remote roots only. Does not fetch and does not touch pid 0.
pub fn bind_roots(command: &str, pid: u32) -> BindRoots {
    let roots = ready(pid);
    match bind_transcript(command, roots.is_some()) {
        TranscriptBind::Local => BindRoots::UseCaller,
        TranscriptBind::Remote => match roots {
            Some(roots) => BindRoots::Remote(roots),
            None => BindRoots::Empty,
        },
        TranscriptBind::Empty => BindRoots::Empty,
    }
}

/// Remote roots for a non-zero pid, fetching once when nothing is staged.
/// Pid 0 always returns `None`.
pub fn remote_roots(pid: u32) -> Option<RemoteRoots> {
    if pid == 0 {
        return None;
    }
    if let Some(roots) = ready(pid) {
        return Some(roots);
    }
    if fresh_miss(pid) {
        return None;
    }
    {
        let mut inflight = lock(&INFLIGHT);
        if !inflight.insert(pid) {
            return None;
        }
    }
    let _guard = InflightGuard(pid);
    if let Some(roots) = ready(pid) {
        return Some(roots);
    }
    let fetched = fetch_remote(pid);
    if let Some(roots) = fetched.clone() {
        stage_remote_roots(pid, roots);
    }
    remember(pid, fetched.clone());
    fetched
}

fn ready(pid: u32) -> Option<RemoteRoots> {
    if pid == 0 {
        return None;
    }
    if let Some(roots) = lock(&STAGED).get(&pid).cloned() {
        return Some(roots);
    }
    match lock(&CACHE).get(&pid) {
        Some(entry) if entry.roots.is_some() && entry.at.elapsed() < HIT => entry.roots.clone(),
        _ => None,
    }
}

fn fresh_miss(pid: u32) -> bool {
    match lock(&CACHE).get(&pid) {
        Some(entry) if entry.roots.is_none() => entry.at.elapsed() < MISS,
        _ => false,
    }
}

fn remember(pid: u32, roots: Option<RemoteRoots>) {
    if pid == 0 {
        return;
    }
    lock(&CACHE).insert(
        pid,
        CacheEntry {
            at: Instant::now(),
            roots,
        },
    );
}

struct InflightGuard(u32);

impl Drop for InflightGuard {
    fn drop(&mut self) {
        lock(&INFLIGHT).remove(&self.0);
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

fn fetch_remote(pid: u32) -> Option<RemoteRoots> {
    let line = process_args(pid)?;
    let conn = connection_from(&line)?;
    let home = cache_home(pid)?;
    if under_user_cli_home(&home) {
        return None;
    }
    if home.exists() {
        fs::remove_dir_all(&home).ok()?;
    }
    fs::create_dir_all(&home).ok()?;
    let home = home.canonicalize().ok()?;
    if under_user_cli_home(&home) {
        let _ = fs::remove_dir_all(&home);
        return None;
    }
    if !copy_remote(&conn, &home) {
        let _ = fs::remove_dir_all(&home);
        return None;
    }
    let roots = roots_under(&home);
    if roots_are_user_home(&roots) || !cache_has_transcript(&roots) {
        let _ = fs::remove_dir_all(&home);
        return None;
    }
    Some(roots)
}

fn copy_remote(conn: &Connection, dest: &Path) -> bool {
    let mut command = Command::new(&conn.program);
    command
        .args(ssh_args(conn))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let Ok(mut child) = command.spawn() else {
        return false;
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return false;
    };
    let dest = dest.to_path_buf();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(ingest_stream(stdout, &dest));
    });
    let deadline = Instant::now() + FETCH_LIMIT;
    let copied = loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            let _ = child.kill();
            let _ = child.wait();
            return false;
        }
        match rx.recv_timeout(left.min(Duration::from_millis(200))) {
            Ok(Ok(())) => break true,
            Ok(Err(())) => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    };
    match child.wait() {
        Ok(status) => copied && status.success(),
        Err(_) => false,
    }
}

fn ssh_args(conn: &Connection) -> Vec<String> {
    let mut args = vec![
        "-o".to_string(),
        "BatchMode=yes".to_string(),
        "-o".to_string(),
        "ConnectTimeout=5".to_string(),
        "-o".to_string(),
        "ConnectionAttempts=1".to_string(),
        "-o".to_string(),
        "NumberOfPasswordPrompts=0".to_string(),
        "-o".to_string(),
        "ClearAllForwardings=yes".to_string(),
    ];
    if let Some(port) = conn.port {
        args.push("-p".to_string());
        args.push(port.to_string());
    }
    for identity in &conn.identities {
        args.push("-i".to_string());
        args.push(identity.clone());
    }
    if let Some(jump) = &conn.jump {
        args.push("-J".to_string());
        args.push(jump.clone());
    }
    args.push(conn.destination.clone());
    args.push(REMOTE_READ.to_string());
    args
}

fn connection_from(line: &str) -> Option<Connection> {
    let tokens = split_command(line);
    let bin = tokens.first()?;
    if !ssh_foreground(bin) {
        return None;
    }
    let destination = parse_ssh_destination(line)?;
    let ports = option_values(&tokens, "-p");
    let port = match ports.as_slice() {
        [] => None,
        [one] => Some(parse_port(one)?),
        _ => return None,
    };
    let identities: Vec<String> = option_values(&tokens, "-i")
        .into_iter()
        .map(str::to_string)
        .collect();
    if identities.iter().any(|path| !safe_identity(path)) {
        return None;
    }
    let jumps = option_values(&tokens, "-J");
    let jump = match jumps.as_slice() {
        [] => None,
        [one] if safe_jump(one) => Some((*one).to_string()),
        _ => return None,
    };
    Some(Connection {
        program: ssh_program(bin),
        destination,
        port,
        identities,
        jump,
    })
}

fn ssh_program(argv0: &str) -> String {
    if argv0.starts_with('/') && safe_abs_file(argv0) {
        argv0.to_string()
    } else {
        "ssh".to_string()
    }
}

fn option_values<'a>(tokens: &'a [String], flag: &str) -> Vec<&'a str> {
    let mut out = Vec::new();
    let mut index = 1usize;
    while index < tokens.len() {
        let token = &tokens[index];
        if token == "--" {
            break;
        }
        if token == flag {
            if let Some(value) = tokens.get(index + 1) {
                out.push(value.as_str());
            }
            index += 2;
            continue;
        }
        if flag.len() == 2 {
            if let Some(rest) = token.strip_prefix(flag) {
                if !rest.is_empty() && !rest.starts_with('-') {
                    out.push(rest);
                    index += 1;
                    continue;
                }
            }
        }
        if takes_argument(token) {
            index += 2;
            continue;
        }
        if token.starts_with("-o") && token.len() > 2 {
            index += 1;
            continue;
        }
        if token.starts_with('-') {
            index += 1;
            continue;
        }
        break;
    }
    out
}

fn cache_home(pid: u32) -> Option<PathBuf> {
    if pid == 0 {
        return None;
    }
    let base = directories::ProjectDirs::from("", "", "sparkmux")
        .map(|dirs| dirs.cache_dir().to_path_buf())
        .unwrap_or_else(|| std::env::temp_dir().join("sparkmux"));
    Some(
        base.join("ssh-transcripts")
            .join(pid.to_string())
            .join("home"),
    )
}

pub fn roots_under(home: &Path) -> RemoteRoots {
    RemoteRoots {
        grok_sessions: home.join(".grok").join("sessions"),
        claude_projects: home.join(".claude").join("projects"),
        grok_active_sessions: home.join(".grok").join("active_sessions.json"),
        agy_root: home.join(".gemini").join("antigravity-cli"),
    }
}

fn roots_are_user_home(roots: &RemoteRoots) -> bool {
    under_user_cli_home(&roots.grok_sessions)
        || under_user_cli_home(&roots.claude_projects)
        || under_user_cli_home(&roots.grok_active_sessions)
        || under_user_cli_home(&roots.agy_root)
}

fn under_user_cli_home(path: &Path) -> bool {
    let Some(dirs) = directories::UserDirs::new() else {
        return false;
    };
    let home = dirs.home_dir();
    [".grok", ".claude", ".gemini"]
        .into_iter()
        .any(|leaf| path.starts_with(home.join(leaf)))
}

fn process_args(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    let output = Command::new("ps")
        .args(["-ww", "-p", &pid.to_string(), "-o", "args="])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().find(|line| !line.trim().is_empty())?;
    let line = line.trim();
    if line.is_empty() {
        None
    } else {
        Some(line.to_string())
    }
}

/// First non-option argument of an ssh command line. The host is validated
/// before it is ever passed to `ssh` as its own argv element.
pub fn parse_ssh_destination(command_line: &str) -> Option<String> {
    let tokens = split_command(command_line);
    if tokens.is_empty() {
        return None;
    }
    let mut index = if ssh_foreground(&tokens[0]) { 1 } else { 0 };
    while index < tokens.len() {
        let token = &tokens[index];
        if token == "--" {
            index += 1;
            break;
        }
        if takes_argument(token) {
            index += 2;
            continue;
        }
        if token.starts_with("-o") && token.len() > 2 {
            index += 1;
            continue;
        }
        if token.starts_with('-') {
            index += 1;
            continue;
        }
        return validate_host(token);
    }
    tokens.get(index).and_then(|host| validate_host(host))
}

fn takes_argument(token: &str) -> bool {
    matches!(
        token,
        "-B" | "-b"
            | "-c"
            | "-D"
            | "-E"
            | "-e"
            | "-F"
            | "-I"
            | "-i"
            | "-J"
            | "-L"
            | "-l"
            | "-m"
            | "-O"
            | "-o"
            | "-P"
            | "-p"
            | "-Q"
            | "-R"
            | "-S"
            | "-W"
            | "-w"
    )
}

fn validate_host(host: &str) -> Option<String> {
    if host.is_empty() || host.len() > 253 || host.starts_with('-') {
        return None;
    }
    if !host
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '@' | ':' | '%' | '-'))
    {
        return None;
    }
    Some(host.to_string())
}

fn parse_port(text: &str) -> Option<u16> {
    if text.is_empty() || text.len() > 5 || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let port: u16 = text.parse().ok()?;
    (1..=65535).contains(&port).then_some(port)
}

fn safe_identity(path: &str) -> bool {
    safe_token(path) && !path.starts_with('-') && !path.split('/').any(|part| part == "..")
}

fn safe_jump(raw: &str) -> bool {
    safe_token(raw)
        && raw.split(',').all(|part| {
            let part = part.trim();
            !part.is_empty() && !part.starts_with('-') && validate_host(part).is_some()
        })
}

fn safe_abs_file(path: &str) -> bool {
    path.starts_with('/')
        && safe_token(path)
        && Path::new(path)
            .components()
            .all(|component| matches!(component, Component::RootDir | Component::Normal(_)))
}

fn safe_token(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 1024
        && text.chars().all(|ch| !ch.is_control())
        && !text.chars().any(|ch| {
            matches!(
                ch,
                ';' | '|' | '&' | '$' | '`' | '\\' | '"' | '\'' | '<' | '>' | '(' | ')' | '{' | '}'
            )
        })
}

fn split_command(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    for ch in line.chars() {
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => cur.push(ch),
            None if ch == '\'' || ch == '"' => quote = Some(ch),
            None if ch.is_whitespace() => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            None => cur.push(ch),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn ingest_stream<R: Read>(reader: R, dest: &Path) -> Result<(), ()> {
    let mut reader = BufReader::new(reader);
    let mut total = 0u64;
    let mut files = 0usize;
    loop {
        let magic = match read_frame_line(&mut reader)? {
            None => return Ok(()),
            Some(line) => line,
        };
        if magic.trim_end_matches(['\r', '\n']) != "SPARKMUX1" {
            return Err(());
        }
        let size_line = read_frame_line(&mut reader)?.ok_or(())?;
        let size = parse_size(size_line.trim())?;
        let path_line = read_frame_line(&mut reader)?.ok_or(())?;
        let rel = path_line.trim_end_matches(['\r', '\n']);
        if size > MAX_FILE || total.saturating_add(size) > MAX_TOTAL || files >= MAX_FILES {
            discard(&mut reader, size)?;
            continue;
        }
        let mut data = vec![0u8; size as usize];
        reader.read_exact(&mut data).map_err(|_| ())?;
        write_cached(dest, rel, &data)?;
        total += size;
        files += 1;
    }
}

fn read_frame_line(reader: &mut impl BufRead) -> Result<Option<String>, ()> {
    let mut line = String::new();
    let read = reader.read_line(&mut line).map_err(|_| ())?;
    if read == 0 {
        return Ok(None);
    }
    if read > 2048 {
        return Err(());
    }
    Ok(Some(line))
}

fn parse_size(text: &str) -> Result<u64, ()> {
    if text.is_empty() || text.len() > 12 || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(());
    }
    text.parse().map_err(|_| ())
}

fn discard(reader: &mut impl Read, size: u64) -> Result<(), ()> {
    std::io::copy(&mut reader.take(size), &mut std::io::sink()).map_err(|_| ())?;
    Ok(())
}

fn write_cached(root: &Path, rel: &str, data: &[u8]) -> Result<(), ()> {
    let rel_path = safe_rel(rel)?;
    let path = root.join(&rel_path);
    let parent = path.parent().ok_or(())?;
    fs::create_dir_all(parent).map_err(|_| ())?;
    let root_canon = root.canonicalize().map_err(|_| ())?;
    let parent_canon = parent.canonicalize().map_err(|_| ())?;
    if under_user_cli_home(&parent_canon) || !parent_canon.starts_with(&root_canon) {
        return Err(());
    }
    if fs::symlink_metadata(&path).is_ok() {
        return Err(());
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|_| ())?;
    file.write_all(data).map_err(|_| ())?;
    let written = path.canonicalize().map_err(|_| ())?;
    if under_user_cli_home(&written) || !written.starts_with(&root_canon) {
        let _ = fs::remove_file(&path);
        return Err(());
    }
    Ok(())
}

fn safe_rel(rel: &str) -> Result<PathBuf, ()> {
    if rel.is_empty()
        || rel.len() > 1024
        || rel.contains('\0')
        || rel.starts_with('/')
        || rel.contains('\\')
    {
        return Err(());
    }
    let allowed = rel == ".grok/active_sessions.json"
        || rel.starts_with(".grok/sessions/")
        || rel.starts_with(".claude/projects/")
        || rel.starts_with(".gemini/antigravity-cli/");
    if !allowed {
        return Err(());
    }
    let path = Path::new(rel);
    for component in path.components() {
        let Component::Normal(part) = component else {
            return Err(());
        };
        let text = part.to_str().ok_or(())?;
        if text.is_empty() || text == "." || text == ".." || text.contains("..") {
            return Err(());
        }
        if !text.chars().all(|ch| ch.is_ascii_graphic() || ch == ' ') {
            return Err(());
        }
    }
    Ok(path.to_path_buf())
}

fn cache_has_transcript(roots: &RemoteRoots) -> bool {
    named_file(&roots.grok_sessions, "chat_history.jsonl", 8)
        || jsonl_file(&roots.claude_projects, 6)
        || named_file(&roots.agy_root, "transcript.jsonl", 10)
}

fn named_file(root: &Path, name: &str, depth: u8) -> bool {
    walk_files(root, depth, &mut |path| {
        path.file_name().and_then(|part| part.to_str()) == Some(name) && jailed_file(root, path)
    })
}

fn jsonl_file(root: &Path, depth: u8) -> bool {
    walk_files(root, depth, &mut |path| {
        path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") && jailed_file(root, path)
    })
}

fn jailed_file(root: &Path, path: &Path) -> bool {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return false;
    };
    if !meta.file_type().is_file() || meta.len() == 0 {
        return false;
    }
    let Ok(root) = root.canonicalize() else {
        return false;
    };
    let Ok(file) = path.canonicalize() else {
        return false;
    };
    file.starts_with(&root) && !under_user_cli_home(&file)
}

fn walk_files(dir: &Path, depth: u8, hit: &mut dyn FnMut(&Path) -> bool) -> bool {
    if depth == 0 {
        return false;
    }
    let Ok(meta) = fs::symlink_metadata(dir) else {
        return false;
    };
    if !meta.file_type().is_dir() {
        return false;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.file_type().is_dir() {
            if walk_files(&path, depth - 1, hit) {
                return true;
            }
        } else if meta.file_type().is_file() && hit(&path) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bind_transcript_keeps_local_panes_and_blocks_ssh_without_a_store() {
        assert_eq!(bind_transcript("zsh", false), TranscriptBind::Local);
        assert_eq!(bind_transcript("zsh", true), TranscriptBind::Local);
        assert_eq!(bind_transcript("grok-1.0.50", true), TranscriptBind::Local);
        assert_eq!(bind_transcript("ssh", false), TranscriptBind::Empty);
        assert_eq!(bind_transcript("ssh", true), TranscriptBind::Remote);
        assert_eq!(
            bind_transcript("/usr/bin/ssh", false),
            TranscriptBind::Empty
        );
        assert_eq!(
            bind_transcript("/usr/bin/ssh", true),
            TranscriptBind::Remote
        );
        assert_eq!(bind_transcript("ssh.exe", true), TranscriptBind::Remote);
        assert_eq!(
            bind_transcript(r"C:\Windows\System32\OpenSSH\ssh.exe", false),
            TranscriptBind::Empty
        );
        assert_eq!(bind_transcript("sshd", false), TranscriptBind::Local);
        assert_eq!(bind_transcript("sshd", true), TranscriptBind::Local);
        assert_eq!(
            bind_transcript("/usr/sbin/sshd", true),
            TranscriptBind::Local
        );
        assert_eq!(bind_transcript("ssh-agent", false), TranscriptBind::Local);
        assert_eq!(bind_transcript("ssh-agent", true), TranscriptBind::Local);
        assert_eq!(bind_transcript("ssh-keygen", true), TranscriptBind::Local);
        assert!(ssh_foreground("/usr/bin/ssh"));
        assert!(!ssh_foreground("sshd"));
        assert!(!ssh_foreground("ssh-agent"));
        assert!(!ssh_foreground("ssh-keygen"));
    }

    #[test]
    fn parse_ssh_destination_skips_options() {
        assert_eq!(
            parse_ssh_destination("ssh dkoh@spark-7819.local"),
            Some("dkoh@spark-7819.local".into())
        );
        assert_eq!(
            parse_ssh_destination("ssh -p 22 -i ~/.ssh/id_ed25519 spark-7819.local tmux"),
            Some("spark-7819.local".into())
        );
        assert_eq!(
            parse_ssh_destination("ssh -o BatchMode=yes -- host.example"),
            Some("host.example".into())
        );
        assert_eq!(
            parse_ssh_destination("ssh -o ProxyCommand=nc evil"),
            Some("evil".into())
        );
        assert_eq!(parse_ssh_destination("ssh '-o' 'BatchMode=yes'"), None);
        assert_eq!(parse_ssh_destination("ssh host;rm"), None);
    }

    #[test]
    fn fetch_args_use_ssh_argv_not_a_shell() {
        let line = "ssh -p 2222 -o ProxyCommand=nc alice@example.test rm -rf /";
        let conn = connection_from(line).unwrap();
        let args = ssh_args(&conn);
        assert_eq!(conn.program, "ssh");
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "-o" && pair[1] == "BatchMode=yes"));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "-o" && pair[1] == "ConnectTimeout=5"));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "-p" && pair[1] == "2222"));
        assert!(args.iter().any(|arg| arg == "alice@example.test"));
        assert!(!args.iter().any(|arg| arg.contains("ProxyCommand")));
        assert!(!args
            .iter()
            .any(|arg| arg == "rm" || arg == "sh" || arg == "-c" || arg == "/bin/sh"));
        let script = args.last().unwrap();
        assert!(script.contains("SPARKMUX1"));
        assert!(script.contains(".grok/sessions"));
        assert!(connection_from("ssh host;rm").is_none());
        assert!(connection_from("sshd alice@example.test").is_none());
        assert!(connection_from("/usr/bin/ssh bob@example.test").is_some());
    }

    #[test]
    fn pid_zero_never_uses_a_staged_store() {
        stage_remote_roots(
            0,
            RemoteRoots {
                grok_sessions: PathBuf::from("/nope/grok"),
                claude_projects: PathBuf::from("/nope/claude"),
                grok_active_sessions: PathBuf::from("/nope/active"),
                agy_root: PathBuf::from("/nope/agy"),
            },
        );
        assert!(remote_roots(0).is_none());
        assert_eq!(bind_roots("ssh", 0), BindRoots::Empty);
        assert_eq!(bind_roots("zsh", 0), BindRoots::UseCaller);
    }

    #[test]
    fn user_cli_directories_are_not_a_remote_store() {
        let Some(home) = directories::UserDirs::new() else {
            return;
        };
        let home = home.home_dir();
        let pid = 4_100_000_099;
        clear_remote_roots(pid);
        stage_remote_roots(
            pid,
            RemoteRoots {
                grok_sessions: home.join(".grok").join("sessions"),
                claude_projects: home.join(".claude").join("projects"),
                grok_active_sessions: home.join(".grok").join("active_sessions.json"),
                agy_root: home.join(".gemini").join("antigravity-cli"),
            },
        );
        assert_eq!(bind_roots("ssh", pid), BindRoots::Empty);
    }
}
