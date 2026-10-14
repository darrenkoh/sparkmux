//! Ordered edit stations for one focused pane.
//!
//! Chronicle does not spawn git. It only reads a transcript and, when the
//! canonical path stays inside the pane directory, the worktree.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::analytics::event::parse_iso_ms;
use crate::analytics::ingest::agy_failed;
use crate::artifacts::{self, CliKind};

const MAX_TRANSCRIPT: u64 = 4 * 1024 * 1024;
const MAX_LINE: usize = 1024 * 1024;
const MAX_HUNK: usize = 256 * 1024;
const MAX_WORKTREE: usize = 1024 * 1024;
const MAX_STATIONS: usize = 480;
const MAX_LANES: usize = 80;
const PREVIEW_CHARS: usize = 160;
const MAX_HOLOGRAM_TEXT: usize = 96 * 1024;
const MAX_DIFF_TEXT: usize = 64 * 1024;
const MAX_EVENTS: u64 = 1024 * 1024;
const MAX_FULL_MERGE: u64 = 8 * 1024 * 1024;
const MAX_MERGED_STRING: usize = 256 * 1024;
const MAX_PATH_LEN: usize = 1024;
const MYERS_MAX_LINES: usize = 4_000;
const MYERS_MAX_COMPS: usize = 200_000;
const DIFF_CONTEXT: usize = 3;
const EMPTY_REASON: &str = "No agent transcript for this pane.";

const PATH_KEYS: &[&str] = &[
    "file_path",
    "target_file",
    "path",
    "absolute_path",
    "AbsolutePath",
    "TargetFile",
    "notebook_path",
    "filePath",
    "targetFile",
];
const OLD_KEYS: &[&str] = &[
    "old_string",
    "old_str",
    "oldstr",
    "search",
    "TargetContent",
    "target_content",
    "targetContent",
];
const NEW_KEYS: &[&str] = &[
    "new_string",
    "new_str",
    "newstr",
    "replace",
    "ReplacementContent",
    "replacement_content",
    "replacementContent",
];
const WRITE_KEYS: &[&str] = &[
    "content",
    "CodeContent",
    "code_content",
    "file_text",
    "text",
    "contents",
];
const ALL_KEYS: &[&str] = &["replace_all", "replaceAll", "ReplaceAll"];

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ChronicleSession {
    pub cli: Option<String>,
    pub stations: Vec<ChronicleStation>,
    pub files: Vec<ChronicleFile>,
    pub now: Vec<ChronicleNow>,
    pub omitted: u32,
    pub truncated_tail: bool,
    pub empty_reason: Option<String>,
    pub transcript_len: u64,
    pub transcript_mtime_ms: i64,
    pub events_mtime_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ChronicleFile {
    pub lane: u32,
    pub path: String,
    pub outside: bool,
    pub edits: u32,
    pub added: u64,
    pub removed: u64,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ChronicleStation {
    pub id: String,
    pub ordinal: u32,
    pub lane: u32,
    pub path: String,
    pub tool: String,
    pub kind: String,
    pub added: u64,
    pub removed: u64,
    pub preview: String,
    pub timestamp_ms: Option<i64>,
    pub time_source: String,
    pub outcome: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ChronicleNow {
    pub path: String,
    pub available: bool,
    pub reason: Option<String>,
    pub worktree_mtime_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ChronicleHologram {
    pub station_id: String,
    pub path: String,
    pub fidelity: String,
    pub reason: Option<String>,
    pub file_text: Option<String>,
    pub file_truncated: bool,
    pub window_start_line: u32,
    pub total_lines: u32,
    pub diff_text: String,
    pub diff_kind: String,
    pub diff_truncated: bool,
    pub added: u64,
    pub removed: u64,
}

struct CacheEntry {
    transcript: PathBuf,
    transcript_mtime_ms: i64,
    transcript_len: u64,
    events_mtime_ms: Option<i64>,
    station_id: String,
    outcome: String,
    worktree_mtime_ms: Option<i64>,
    body: ChronicleHologram,
}

struct CacheKey {
    transcript: PathBuf,
    transcript_mtime_ms: i64,
    transcript_len: u64,
    events_mtime_ms: Option<i64>,
    station_id: String,
    outcome: String,
    worktree_mtime_ms: Option<i64>,
}

static CACHE: Mutex<Option<CacheEntry>> = Mutex::new(None);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Outcome {
    Unknown,
    Ok,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TimeSource {
    Record,
    Event,
    Ordinal,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Replace,
    Write,
    Delete,
    Patch,
    Notebook,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Fidelity {
    Exact,
    Partial,
    Patch,
    Deleted,
    Binary,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum IdHit {
    Unknown,
    Ok,
    Error,
}

#[derive(Clone, Debug)]
struct Hunk {
    old: String,
    new: String,
    replace_all: bool,
    hint: usize,
}

#[derive(Clone, Debug)]
struct Call {
    offset: u64,
    call_index: u32,
    name: String,
    name_lower: String,
    args: Option<Map<String, Value>>,
    timestamp_ms: Option<i64>,
    time_source: TimeSource,
    outcome: Outcome,
    tool_id: Option<String>,
    id_hit: Option<IdHit>,
}

#[derive(Clone, Debug)]
struct Draft {
    id: String,
    path: String,
    outside: bool,
    read_path: Option<PathBuf>,
    tool: String,
    kind: Kind,
    added: u64,
    removed: u64,
    preview: String,
    timestamp_ms: Option<i64>,
    time_source: TimeSource,
    outcome: Outcome,
    hunks: Vec<Hunk>,
    write_bytes: Option<Vec<u8>>,
    preset: Option<String>,
    hunk_display: String,
}

#[derive(Clone, Debug)]
struct Rev {
    fidelity: Fidelity,
    reason: Option<String>,
    before: Option<String>,
    after: Option<String>,
    diff_kind: &'static str,
}

struct Tail {
    lines: Vec<(u64, Vec<u8>)>,
    truncated_tail: bool,
    from_start: bool,
    len: u64,
    mtime_ms: i64,
}

#[derive(Clone)]
struct Resolved {
    display: String,
    outside: bool,
    read: Option<PathBuf>,
}

#[derive(Clone)]
struct NowRead {
    available: bool,
    reason: Option<String>,
    mtime: Option<i64>,
    text: Option<String>,
    binary: bool,
}

struct Loaded {
    session: ChronicleSession,
    ops: Vec<Draft>,
    now_by_path: HashMap<String, NowRead>,
    transcript: PathBuf,
    transcript_mtime_ms: i64,
    transcript_len: u64,
    events_mtime_ms: Option<i64>,
}

struct Events {
    started: Vec<Option<i64>>,
    completed: Vec<bool>,
}

#[tauri::command]
pub async fn chronicle_session(
    command: String,
    cwd: String,
    title: String,
    pid: u32,
) -> Result<ChronicleSession, String> {
    tokio::task::spawn_blocking(move || build_chronicle_session(&command, &cwd, &title, pid))
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn chronicle_hologram(
    command: String,
    cwd: String,
    title: String,
    pid: u32,
    station_id: String,
) -> Result<ChronicleHologram, String> {
    tokio::task::spawn_blocking(move || {
        chronicle_hologram_blocking(&command, &cwd, &title, pid, &station_id)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn clear_chronicle_cache() -> Result<(), String> {
    let mut guard = CACHE.lock().unwrap_or_else(|poison| poison.into_inner());
    *guard = None;
    Ok(())
}

fn chronicle_hologram_blocking(
    command: &str,
    cwd: &str,
    title: &str,
    pid: u32,
    station_id: &str,
) -> Result<ChronicleHologram, String> {
    let loaded = load_for_pane(command, cwd, title, pid);
    let key = cache_key(&loaded, station_id).ok_or_else(|| "unknown station".to_string())?;
    if let Some(hit) = cache_get(&key) {
        return Ok(hit);
    }
    let body = hologram_for(&loaded, station_id)?;
    cache_put(&key, &body);
    Ok(body)
}

fn cache_get(key: &CacheKey) -> Option<ChronicleHologram> {
    let guard = CACHE.lock().unwrap_or_else(|poison| poison.into_inner());
    let entry = guard.as_ref()?;
    let hit = entry.transcript == key.transcript
        && entry.transcript_mtime_ms == key.transcript_mtime_ms
        && entry.transcript_len == key.transcript_len
        && entry.events_mtime_ms == key.events_mtime_ms
        && entry.station_id == key.station_id
        && entry.outcome == key.outcome
        && entry.worktree_mtime_ms == key.worktree_mtime_ms;
    hit.then(|| entry.body.clone())
}

fn cache_put(key: &CacheKey, body: &ChronicleHologram) {
    let mut guard = CACHE.lock().unwrap_or_else(|poison| poison.into_inner());
    *guard = Some(CacheEntry {
        transcript: key.transcript.clone(),
        transcript_mtime_ms: key.transcript_mtime_ms,
        transcript_len: key.transcript_len,
        events_mtime_ms: key.events_mtime_ms,
        station_id: key.station_id.clone(),
        outcome: key.outcome.clone(),
        worktree_mtime_ms: key.worktree_mtime_ms,
        body: body.clone(),
    });
}

fn cache_key(loaded: &Loaded, station_id: &str) -> Option<CacheKey> {
    if loaded.transcript.as_os_str().is_empty() {
        return None;
    }
    let (outcome, worktree_mtime_ms) = if let Some(path) = station_id.strip_prefix("now:") {
        if !loaded.session.files.iter().any(|file| file.path == path) {
            return None;
        }
        let mtime = loaded.now_by_path.get(path).and_then(|now| now.mtime);
        (String::new(), mtime)
    } else {
        let station = loaded
            .session
            .stations
            .iter()
            .find(|station| station.id == station_id)?;
        (station.outcome.clone(), None)
    };
    Some(CacheKey {
        transcript: loaded.transcript.clone(),
        transcript_mtime_ms: loaded.transcript_mtime_ms,
        transcript_len: loaded.transcript_len,
        events_mtime_ms: loaded.events_mtime_ms,
        station_id: station_id.to_string(),
        outcome,
        worktree_mtime_ms,
    })
}

fn build_chronicle_session(command: &str, cwd: &str, title: &str, pid: u32) -> ChronicleSession {
    load_for_pane(command, cwd, title, pid).session
}

fn load_for_pane(command: &str, cwd: &str, title: &str, pid: u32) -> Loaded {
    let started = Instant::now();
    let roots = artifacts::default_roots();
    let family = artifacts::pane_family(pid);
    let Some(kind) = artifacts::detect_cli(command, title, &family) else {
        return Loaded::empty(None);
    };
    let Some(path) = artifacts::select_transcript(kind, cwd, title, &family, &roots) else {
        return Loaded::empty(Some(kind));
    };
    let loaded = load_path(kind, &path, Path::new(cwd));
    let elapsed_ms = started.elapsed().as_millis() as u64;
    tracing::debug!(
        target: "chronicle",
        stations = loaded.session.stations.len(),
        omitted = loaded.session.omitted,
        truncated_tail = loaded.session.truncated_tail,
        exact = 0,
        patch = 0,
        elapsed_ms,
    );
    if loaded.session.truncated_tail {
        tracing::warn!(target: "chronicle", "truncated_tail");
    }
    if loaded.session.files.iter().any(|file| file.outside) {
        tracing::warn!(
            target: "chronicle",
            reason = "outside the pane directory",
            "worktree read refused"
        );
    }
    loaded
}

impl Loaded {
    fn empty(kind: Option<CliKind>) -> Self {
        Self {
            session: ChronicleSession {
                cli: kind.map(|kind| kind.as_str().to_string()),
                stations: Vec::new(),
                files: Vec::new(),
                now: Vec::new(),
                omitted: 0,
                truncated_tail: false,
                empty_reason: Some(EMPTY_REASON.to_string()),
                transcript_len: 0,
                transcript_mtime_ms: 0,
                events_mtime_ms: None,
            },
            ops: Vec::new(),
            now_by_path: HashMap::new(),
            transcript: PathBuf::new(),
            transcript_mtime_ms: 0,
            transcript_len: 0,
            events_mtime_ms: None,
        }
    }
}

fn load_path(kind: CliKind, transcript: &Path, cwd: &Path) -> Loaded {
    let started = Instant::now();
    let primary = artifacts::jailed_sibling(transcript, "transcript_full.jsonl")
        .unwrap_or_else(|| transcript.to_path_buf());
    let primary = primary.canonicalize().unwrap_or(primary);
    let tail = read_tail_lines(&primary, MAX_TRANSCRIPT);
    let events_path = artifacts::jailed_sibling(&primary, "events.jsonl");
    let events_mtime_ms = events_path.as_ref().and_then(|path| symlink_mtime_ms(path));
    let events = events_path
        .as_ref()
        .map(|path| read_events(path))
        .unwrap_or_else(Events::empty);
    let mut records = parse_records(&tail);
    maybe_merge_truncated(kind, &primary, &mut records);
    let cwd_canon = cwd.canonicalize().ok();
    let ops = stations_from_records(
        kind,
        &records,
        &events,
        tail.from_start,
        cwd_canon.as_deref(),
    );
    let loaded = assemble(kind, ops, &tail, &primary, events_mtime_ms);
    let elapsed_ms = started.elapsed().as_millis() as u64;
    tracing::debug!(
        target: "chronicle",
        stations = loaded.session.stations.len(),
        omitted = loaded.session.omitted,
        truncated_tail = loaded.session.truncated_tail,
        exact = 0,
        patch = 0,
        elapsed_ms,
    );
    loaded
}

fn assemble(
    kind: CliKind,
    ops: Vec<Draft>,
    tail: &Tail,
    transcript: &Path,
    events_mtime_ms: Option<i64>,
) -> Loaded {
    let (visible, omitted) = select_window(&ops);
    let mut rank: HashMap<String, (usize, u32)> = HashMap::new();
    for (pos, index) in visible.iter().enumerate() {
        let path = ops[*index].path.clone();
        let entry = rank.entry(path).or_insert((pos, 0));
        entry.0 = pos;
        entry.1 = entry.1.saturating_add(1);
    }
    let mut paths: Vec<(String, usize, u32)> = rank
        .into_iter()
        .map(|(path, (pos, edits))| (path, pos, edits))
        .collect();
    paths.sort_by(|a, b| b.1.cmp(&a.1).then(b.2.cmp(&a.2)).then(a.0.cmp(&b.0)));
    let lane_of: HashMap<String, u32> = paths
        .iter()
        .enumerate()
        .map(|(lane, (path, _, _))| (path.clone(), lane as u32))
        .collect();

    let mut now_by_path: HashMap<String, NowRead> = HashMap::new();
    for index in &visible {
        let draft = &ops[*index];
        now_by_path.entry(draft.path.clone()).or_insert_with(|| {
            if draft.outside {
                NowRead::outside()
            } else if let Some(path) = &draft.read_path {
                read_inside(path)
            } else {
                NowRead::missing()
            }
        });
    }

    let mut file_stats: HashMap<String, (u32, u64, u64, bool)> = HashMap::new();
    for index in &visible {
        let draft = &ops[*index];
        let entry = file_stats
            .entry(draft.path.clone())
            .or_insert((0, 0, 0, draft.outside));
        entry.0 = entry.0.saturating_add(1);
        entry.1 = entry.1.saturating_add(draft.added);
        entry.2 = entry.2.saturating_add(draft.removed);
    }

    let mut files = Vec::new();
    let mut now = Vec::new();
    for (path, _, _) in &paths {
        let (edits, added, removed, outside) =
            file_stats.get(path).cloned().unwrap_or((0, 0, 0, false));
        let read = now_by_path.get(path);
        files.push(ChronicleFile {
            lane: lane_of.get(path).copied().unwrap_or(0),
            path: path.clone(),
            outside,
            edits,
            added,
            removed,
            binary: read.is_some_and(|item| item.binary),
        });
        let read = read.cloned().unwrap_or_else(NowRead::missing);
        now.push(ChronicleNow {
            path: path.clone(),
            available: read.available,
            reason: read.reason.clone(),
            worktree_mtime_ms: read.mtime,
        });
    }

    let mut stations = Vec::new();
    for (ordinal, index) in visible.iter().enumerate() {
        let draft = &ops[*index];
        stations.push(ChronicleStation {
            id: draft.id.clone(),
            ordinal: ordinal as u32,
            lane: lane_of.get(&draft.path).copied().unwrap_or(0),
            path: draft.path.clone(),
            tool: draft.tool.clone(),
            kind: kind_str(draft.kind).to_string(),
            added: draft.added,
            removed: draft.removed,
            preview: draft.preview.clone(),
            timestamp_ms: draft.timestamp_ms,
            time_source: time_str(draft.time_source).to_string(),
            outcome: outcome_str(draft.outcome).to_string(),
        });
    }

    let outside = files.iter().any(|file| file.outside);
    if tail.truncated_tail {
        tracing::warn!(target: "chronicle", "truncated_tail");
    }
    if outside {
        tracing::warn!(
            target: "chronicle",
            reason = "outside the pane directory",
            "worktree read refused"
        );
    }

    Loaded {
        session: ChronicleSession {
            cli: Some(kind.as_str().to_string()),
            stations,
            files,
            now,
            omitted,
            truncated_tail: tail.truncated_tail,
            empty_reason: None,
            transcript_len: tail.len,
            transcript_mtime_ms: tail.mtime_ms,
            events_mtime_ms,
        },
        ops,
        now_by_path,
        transcript: transcript.to_path_buf(),
        transcript_mtime_ms: tail.mtime_ms,
        transcript_len: tail.len,
        events_mtime_ms,
    }
}

fn select_window(drafts: &[Draft]) -> (Vec<usize>, u32) {
    let mut idxs: Vec<usize> = (0..drafts.len()).collect();
    let mut omitted = 0u32;
    if idxs.len() > MAX_STATIONS {
        let drop_n = idxs.len() - MAX_STATIONS;
        idxs.drain(0..drop_n);
        omitted = omitted.saturating_add(drop_n as u32);
    }
    let mut rank: HashMap<String, (usize, u32)> = HashMap::new();
    for (pos, index) in idxs.iter().enumerate() {
        let path = drafts[*index].path.clone();
        let entry = rank.entry(path).or_insert((pos, 0));
        entry.0 = pos;
        entry.1 = entry.1.saturating_add(1);
    }
    let mut paths: Vec<(String, usize, u32)> = rank
        .into_iter()
        .map(|(path, (pos, edits))| (path, pos, edits))
        .collect();
    paths.sort_by(|a, b| b.1.cmp(&a.1).then(b.2.cmp(&a.2)).then(a.0.cmp(&b.0)));
    if paths.len() > MAX_LANES {
        let keep: HashSet<String> = paths
            .iter()
            .take(MAX_LANES)
            .map(|(path, _, _)| path.clone())
            .collect();
        let before = idxs.len();
        idxs.retain(|index| keep.contains(&drafts[*index].path));
        omitted = omitted.saturating_add((before - idxs.len()) as u32);
    }
    (idxs, omitted)
}

fn read_tail_lines(path: &Path, max: u64) -> Tail {
    let Ok(mut file) = File::open(path) else {
        return Tail::empty();
    };
    let Ok(meta) = file.metadata() else {
        return Tail::empty();
    };
    let len = meta.len();
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0);
    let start = len.saturating_sub(max);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return Tail::empty();
    }
    let mut buf = Vec::new();
    if file
        .take(max.saturating_add(8))
        .read_to_end(&mut buf)
        .is_err()
    {
        return Tail::empty();
    }
    let mut dropped = 0usize;
    if start > 0 {
        match buf.iter().position(|byte| *byte == b'\n') {
            Some(index) => dropped = index + 1,
            None => {
                return Tail {
                    lines: Vec::new(),
                    truncated_tail: true,
                    from_start: false,
                    len,
                    mtime_ms,
                };
            }
        }
    }
    let kept = &buf[dropped..];
    let first = start + dropped as u64;
    let mut lines = Vec::new();
    let mut truncated_tail = start > 0;
    let mut pos = 0usize;
    while pos < kept.len() {
        let rest = &kept[pos..];
        let split = rest.iter().position(|byte| *byte == b'\n');
        let (line, next) = match split {
            Some(index) => (&rest[..index], pos + index + 1),
            None => (rest, kept.len()),
        };
        let offset = first + pos as u64;
        if line.len() > MAX_LINE {
            truncated_tail = true;
        } else if !line.is_empty() {
            lines.push((offset, line.to_vec()));
        }
        if split.is_none() {
            break;
        }
        pos = next;
    }
    Tail {
        lines,
        truncated_tail,
        from_start: start == 0,
        len,
        mtime_ms,
    }
}

impl Tail {
    fn empty() -> Self {
        Self {
            lines: Vec::new(),
            truncated_tail: false,
            from_start: true,
            len: 0,
            mtime_ms: 0,
        }
    }
}

fn parse_records(tail: &Tail) -> Vec<(u64, Value)> {
    let mut out = Vec::new();
    for (offset, line) in &tail.lines {
        let text = String::from_utf8_lossy(line);
        let Ok(value) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        out.push((*offset, value));
    }
    out
}

fn maybe_merge_truncated(kind: CliKind, primary: &Path, records: &mut [(u64, Value)]) {
    if kind != CliKind::Antigravity {
        return;
    }
    let mut needed = HashSet::new();
    for (_, value) in records.iter() {
        let Some(obj) = value.as_object() else {
            continue;
        };
        let Some(fields) = obj.get("truncated_fields").and_then(Value::as_array) else {
            continue;
        };
        if fields.is_empty() {
            continue;
        }
        if let Some(index) = step_index(value) {
            needed.insert(index);
        }
    }
    if needed.is_empty() {
        return;
    }
    let source =
        if primary.file_name().and_then(|name| name.to_str()) == Some("transcript_full.jsonl") {
            primary.to_path_buf()
        } else {
            let Some(full) = artifacts::jailed_sibling(primary, "transcript_full.jsonl") else {
                return;
            };
            full
        };
    let tail = read_tail_lines(&source, MAX_FULL_MERGE);
    let mut full_steps = HashMap::new();
    for (_, line) in &tail.lines {
        let text = String::from_utf8_lossy(line);
        let Ok(value) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let Some(index) = step_index(&value) else {
            continue;
        };
        if needed.contains(&index) {
            full_steps.insert(index, value);
        }
    }
    for (_, value) in records.iter_mut() {
        let Some(index) = step_index(value) else {
            continue;
        };
        if let Some(full) = full_steps.get(&index) {
            *value = resolve_truncated(value, Some(full));
        }
    }
}

fn step_index(value: &Value) -> Option<i64> {
    let index = value.get("step_index")?;
    index
        .as_i64()
        .or_else(|| index.as_u64().and_then(|number| i64::try_from(number).ok()))
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
            merged.insert(name.to_string(), cap_merged(full_val));
        }
    }
    Value::Object(merged)
}

fn cap_merged(value: &Value) -> Value {
    match value {
        Value::String(text) if text.len() > MAX_MERGED_STRING => {
            let mut end = MAX_MERGED_STRING;
            while end > 0 && !text.is_char_boundary(end) {
                end -= 1;
            }
            Value::String(text[..end].to_string())
        }
        other => other.clone(),
    }
}

fn read_events(path: &Path) -> Events {
    let tail = read_tail_lines(path, MAX_EVENTS);
    let mut started = Vec::new();
    let mut completed = Vec::new();
    for (_, line) in tail.lines {
        let text = String::from_utf8_lossy(&line);
        let Ok(value) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let Some(obj) = value.as_object() else {
            continue;
        };
        match obj.get("type").and_then(Value::as_str).unwrap_or("") {
            "tool_started" => {
                let ts = obj.get("ts").and_then(Value::as_str).and_then(parse_iso_ms);
                started.push(ts);
            }
            "tool_completed" => {
                let outcome = obj.get("outcome").and_then(Value::as_str).unwrap_or("");
                completed.push(outcome == "success");
            }
            _ => {}
        }
    }
    Events { started, completed }
}

impl Events {
    fn empty() -> Self {
        Self {
            started: Vec::new(),
            completed: Vec::new(),
        }
    }
}

fn stations_from_records(
    kind: CliKind,
    records: &[(u64, Value)],
    events: &Events,
    from_start: bool,
    cwd_canon: Option<&Path>,
) -> Vec<Draft> {
    let mut calls = Vec::new();
    let mut agy_queue = VecDeque::new();
    let mut grok_hits: HashMap<String, IdHit> = HashMap::new();
    let mut claude_hits: HashMap<String, Outcome> = HashMap::new();
    for (offset, value) in records {
        let Some(obj) = value.as_object() else {
            continue;
        };
        match kind {
            CliKind::Grok => walk_grok(obj, *offset, &mut calls, &mut grok_hits),
            CliKind::Claude => walk_claude(obj, *offset, &mut calls, &mut claude_hits),
            CliKind::Antigravity => walk_agy(obj, *offset, &mut calls, &mut agy_queue),
        }
    }
    if kind == CliKind::Grok {
        for call in &mut calls {
            if let Some(id) = &call.tool_id {
                call.id_hit = grok_hits.get(id).copied();
            }
        }
        let zip = if from_start && events.completed.len() == calls.len() {
            Some(events.completed.as_slice())
        } else {
            None
        };
        for (index, call) in calls.iter_mut().enumerate() {
            let zipped = zip.map(|items| {
                if items[index] {
                    Outcome::Ok
                } else {
                    Outcome::Error
                }
            });
            call.outcome = merge_grok(call.id_hit, zipped);
        }
        if from_start && events.started.len() == calls.len() {
            for (call, ts) in calls.iter_mut().zip(events.started.iter()) {
                call.time_source = TimeSource::Event;
                call.timestamp_ms = *ts;
            }
        }
    }
    if kind == CliKind::Claude {
        for call in &mut calls {
            if let Some(id) = &call.tool_id {
                if let Some(outcome) = claude_hits.get(id) {
                    call.outcome = *outcome;
                }
            }
        }
    }
    let mut drafts = Vec::new();
    let mut resolved_cache: HashMap<String, Resolved> = HashMap::new();
    for call in &calls {
        drafts.extend(expand_call(call, cwd_canon, &mut resolved_cache));
    }
    drafts
}

fn walk_grok(
    obj: &Map<String, Value>,
    offset: u64,
    calls: &mut Vec<Call>,
    hits: &mut HashMap<String, IdHit>,
) {
    let record = obj.get("type").and_then(Value::as_str).unwrap_or("");
    if record == "tool_result" {
        if let Some(id) = obj.get("tool_call_id").and_then(Value::as_str) {
            hits.insert(id.to_string(), grok_hit(obj));
        }
        return;
    }
    if record != "assistant" {
        return;
    }
    let Some(list) = obj.get("tool_calls").and_then(Value::as_array) else {
        return;
    };
    for (index, call) in list.iter().enumerate() {
        push_call(calls, offset, index as u32, call, None);
    }
}

fn walk_claude(
    obj: &Map<String, Value>,
    offset: u64,
    calls: &mut Vec<Call>,
    hits: &mut HashMap<String, Outcome>,
) {
    if obj.get("isMeta").and_then(Value::as_bool) == Some(true)
        || obj.get("isSidechain").and_then(Value::as_bool) == Some(true)
    {
        return;
    }
    let ts = obj
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(parse_iso_ms);
    let Some(message) = obj.get("message").and_then(Value::as_object) else {
        return;
    };
    let Some(blocks) = message.get("content").and_then(Value::as_array) else {
        return;
    };
    let mut call_index = 0u32;
    for block in blocks {
        let kind = block.get("type").and_then(Value::as_str).unwrap_or("");
        if kind == "tool_use" {
            push_call(calls, offset, call_index, block, ts);
            call_index = call_index.saturating_add(1);
        } else if kind == "tool_result" {
            if let Some(id) = block.get("tool_use_id").and_then(Value::as_str) {
                let failed = block.get("is_error").and_then(Value::as_bool) == Some(true);
                hits.insert(
                    id.to_string(),
                    if failed { Outcome::Error } else { Outcome::Ok },
                );
            }
        }
    }
}

fn walk_agy(
    obj: &Map<String, Value>,
    offset: u64,
    calls: &mut Vec<Call>,
    queue: &mut VecDeque<usize>,
) {
    let record = obj.get("type").and_then(Value::as_str).unwrap_or("");
    if artifacts::agy_bookkeeping(record) {
        return;
    }
    if obj
        .get("source")
        .and_then(Value::as_str)
        .is_some_and(|source| source.eq_ignore_ascii_case("SYSTEM"))
    {
        return;
    }
    if record == "PLANNER_RESPONSE" {
        let ts = obj
            .get("created_at")
            .and_then(Value::as_str)
            .and_then(parse_iso_ms);
        if let Some(list) = obj.get("tool_calls").and_then(Value::as_array) {
            for (index, call) in list.iter().enumerate() {
                let at = calls.len();
                push_call(calls, offset, index as u32, call, ts);
                queue.push_back(at);
            }
        }
        return;
    }
    if artifacts::agy_tool_result(record) {
        let Some(index) = queue.pop_front() else {
            return;
        };
        if let Some(call) = calls.get_mut(index) {
            call.outcome = if agy_failed(obj) {
                Outcome::Error
            } else {
                Outcome::Ok
            };
        }
    }
}

fn push_call(calls: &mut Vec<Call>, offset: u64, call_index: u32, call: &Value, ts: Option<i64>) {
    let name = call
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let name_lower = name.to_ascii_lowercase();
    let args = object_args(artifacts::tool_args(call));
    let tool_id = call.get("id").and_then(Value::as_str).map(str::to_string);
    let (timestamp_ms, time_source) = match ts {
        Some(ms) => (Some(ms), TimeSource::Record),
        None => (None, TimeSource::Ordinal),
    };
    calls.push(Call {
        offset,
        call_index,
        name,
        name_lower,
        args,
        timestamp_ms,
        time_source,
        outcome: Outcome::Unknown,
        tool_id,
        id_hit: None,
    });
}

fn grok_hit(obj: &Map<String, Value>) -> IdHit {
    if obj.get("is_error").and_then(Value::as_bool) == Some(true) {
        return IdHit::Error;
    }
    match obj.get("error") {
        Some(Value::String(text)) if !text.trim().is_empty() => return IdHit::Error,
        Some(Value::Bool(true)) => return IdHit::Error,
        Some(Value::Object(_)) => return IdHit::Error,
        _ => {}
    }
    if let Some(outcome) = obj.get("outcome").and_then(Value::as_str) {
        if outcome == "success" {
            return IdHit::Ok;
        }
        if !outcome.is_empty() {
            return IdHit::Error;
        }
    }
    IdHit::Unknown
}

fn merge_grok(hit: Option<IdHit>, zip: Option<Outcome>) -> Outcome {
    let id_err = matches!(hit, Some(IdHit::Error));
    let zip_err = matches!(zip, Some(Outcome::Error));
    if id_err || zip_err {
        Outcome::Error
    } else if matches!(zip, Some(Outcome::Ok)) {
        Outcome::Ok
    } else {
        Outcome::Unknown
    }
}

fn object_args(args: &Value) -> Option<Map<String, Value>> {
    let value = match args {
        Value::String(text) => serde_json::from_str::<Value>(text.trim()).unwrap_or(Value::Null),
        other => other.clone(),
    };
    match value {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

fn is_mutating(name: &str) -> bool {
    matches!(
        name,
        "edit"
            | "edit_file"
            | "str_replace"
            | "str_replace_editor"
            | "search_replace"
            | "replace_file_content"
            | "write"
            | "write_file"
            | "write_to_file"
            | "create_file"
            | "apply_patch"
            | "patch"
            | "delete_file"
            | "notebook_edit"
            | "multiedit"
            | "multi_edit"
    )
}

fn expand_call(
    call: &Call,
    cwd_canon: Option<&Path>,
    cache: &mut HashMap<String, Resolved>,
) -> Vec<Draft> {
    if !is_mutating(&call.name_lower) {
        return Vec::new();
    }
    let Some(map) = &call.args else {
        return Vec::new();
    };
    match call.name_lower.as_str() {
        "write" | "write_file" | "write_to_file" | "create_file" => {
            expand_write(call, map, cwd_canon, cache)
        }
        "delete_file" => expand_delete(call, map, cwd_canon, cache),
        "notebook_edit" => expand_notebook(call, map, cwd_canon, cache),
        "patch" | "apply_patch" => expand_patch(call, map, cwd_canon, cache),
        _ => expand_edits(call, map, cwd_canon, cache),
    }
}

fn expand_write(
    call: &Call,
    map: &Map<String, Value>,
    cwd_canon: Option<&Path>,
    cache: &mut HashMap<String, Resolved>,
) -> Vec<Draft> {
    let Some(raw) = path_of(map) else {
        return Vec::new();
    };
    let body = str_of(map, WRITE_KEYS);
    let resolved = resolve_cached(&raw, cwd_canon, cache);
    let preview = one_line(&first_line(&body));
    vec![draft_from(
        call,
        &resolved,
        Kind::Write,
        count_lines(&body),
        0,
        preview,
        Vec::new(),
        Some(body.into_bytes()),
        None,
        String::new(),
    )]
}

fn expand_delete(
    call: &Call,
    map: &Map<String, Value>,
    cwd_canon: Option<&Path>,
    cache: &mut HashMap<String, Resolved>,
) -> Vec<Draft> {
    let Some(raw) = path_of(map) else {
        return Vec::new();
    };
    let resolved = resolve_cached(&raw, cwd_canon, cache);
    vec![draft_from(
        call,
        &resolved,
        Kind::Delete,
        0,
        0,
        "deleted".to_string(),
        Vec::new(),
        None,
        None,
        String::new(),
    )]
}

fn expand_notebook(
    call: &Call,
    map: &Map<String, Value>,
    cwd_canon: Option<&Path>,
    cache: &mut HashMap<String, Resolved>,
) -> Vec<Draft> {
    let Some(raw) = path_of(map) else {
        return Vec::new();
    };
    let old = str_of(map, OLD_KEYS);
    let new = str_of(map, NEW_KEYS);
    let resolved = resolve_cached(&raw, cwd_canon, cache);
    let display = format_replace(&old, &new);
    let preview = added_preview(&new);
    let hunk = Hunk {
        old,
        new,
        replace_all: flag_true(map),
        hint: 0,
    };
    let removed = count_lines(&hunk.old);
    let added = count_lines(&hunk.new);
    vec![draft_from(
        call,
        &resolved,
        Kind::Notebook,
        added,
        removed,
        preview,
        vec![hunk],
        None,
        None,
        display,
    )]
}

fn expand_edits(
    call: &Call,
    map: &Map<String, Value>,
    cwd_canon: Option<&Path>,
    cache: &mut HashMap<String, Resolved>,
) -> Vec<Draft> {
    let array = ["edits", "replacements", "changes"]
        .iter()
        .find_map(|key| map.get(*key).and_then(Value::as_array));
    let Some(array) = array else {
        return single_replace(call, map, cwd_canon, cache);
    };
    let parent = path_of(map);
    let mut out = Vec::new();
    let mut cur_path = parent.clone();
    let mut hunks: Vec<Hunk> = Vec::new();
    let mut display = String::new();
    let mut added = 0u64;
    let mut removed = 0u64;
    let mut flush = |cur_path: &mut Option<String>,
                     hunks: &mut Vec<Hunk>,
                     display: &mut String,
                     added: &mut u64,
                     removed: &mut u64,
                     out: &mut Vec<Draft>| {
        if hunks.is_empty() {
            return;
        }
        let Some(raw) = cur_path.clone() else {
            hunks.clear();
            display.clear();
            *added = 0;
            *removed = 0;
            return;
        };
        let resolved = resolve_cached(&raw, cwd_canon, cache);
        let preview = hunks
            .iter()
            .find_map(|hunk| first_nonempty(&hunk.new))
            .map(|line| plus_preview(&line))
            .unwrap_or_default();
        out.push(draft_from(
            call,
            &resolved,
            Kind::Replace,
            *added,
            *removed,
            preview,
            std::mem::take(hunks),
            None,
            None,
            std::mem::take(display),
        ));
        *added = 0;
        *removed = 0;
    };
    for elem in array {
        let Some(elem_map) = object_args(elem) else {
            continue;
        };
        let elem_path = path_of(&elem_map);
        if elem_path.is_none() && cur_path.is_none() {
            continue;
        }
        if let Some(path) = elem_path.clone() {
            if cur_path.as_ref() != Some(&path) {
                flush(
                    &mut cur_path,
                    &mut hunks,
                    &mut display,
                    &mut added,
                    &mut removed,
                    &mut out,
                );
                cur_path = Some(path);
            }
        }
        if cur_path.is_none() {
            continue;
        }
        let old = str_of(&elem_map, OLD_KEYS);
        let new = str_of(&elem_map, NEW_KEYS);
        added = added.saturating_add(count_lines(&new));
        removed = removed.saturating_add(count_lines(&old));
        display.push_str(&format_replace(&old, &new));
        hunks.push(Hunk {
            old,
            new,
            replace_all: flag_true(&elem_map),
            hint: 0,
        });
    }
    flush(
        &mut cur_path,
        &mut hunks,
        &mut display,
        &mut added,
        &mut removed,
        &mut out,
    );
    out
}

fn single_replace(
    call: &Call,
    map: &Map<String, Value>,
    cwd_canon: Option<&Path>,
    cache: &mut HashMap<String, Resolved>,
) -> Vec<Draft> {
    let Some(raw) = path_of(map) else {
        return Vec::new();
    };
    let old = str_of(map, OLD_KEYS);
    let new = str_of(map, NEW_KEYS);
    let resolved = resolve_cached(&raw, cwd_canon, cache);
    let preview = added_preview(&new);
    let display = format_replace(&old, &new);
    let added = count_lines(&new);
    let removed = count_lines(&old);
    let hunk = Hunk {
        old,
        new,
        replace_all: flag_true(map),
        hint: 0,
    };
    vec![draft_from(
        call,
        &resolved,
        Kind::Replace,
        added,
        removed,
        preview,
        vec![hunk],
        None,
        None,
        display,
    )]
}

enum Piece {
    Update {
        path: String,
        body: String,
    },
    Add {
        path: String,
        body: String,
        failed: bool,
    },
    Delete {
        path: String,
    },
    Moved {
        path: String,
        from_add: bool,
        body: String,
    },
}

fn expand_patch(
    call: &Call,
    map: &Map<String, Value>,
    cwd_canon: Option<&Path>,
    cache: &mut HashMap<String, Resolved>,
) -> Vec<Draft> {
    let text = str_of(map, &["patch", "diff"]);
    let pieces = split_patch(&text);
    if pieces.is_empty() {
        let Some(raw) = path_of(map) else {
            return Vec::new();
        };
        return vec![patch_station(call, &raw, &text, cwd_canon, cache, None)];
    }
    pieces
        .into_iter()
        .map(|piece| piece_draft(call, piece, cwd_canon, cache))
        .collect()
}

fn piece_draft(
    call: &Call,
    piece: Piece,
    cwd_canon: Option<&Path>,
    cache: &mut HashMap<String, Resolved>,
) -> Draft {
    match piece {
        Piece::Update { path, body } => patch_station(call, &path, &body, cwd_canon, cache, None),
        Piece::Add { path, body, failed } => {
            let resolved = resolve_cached(&path, cwd_canon, cache);
            if failed {
                draft_from(
                    call,
                    &resolved,
                    Kind::Patch,
                    0,
                    0,
                    String::new(),
                    Vec::new(),
                    None,
                    Some("hunk context not found".to_string()),
                    body,
                )
            } else {
                let preview = one_line(&first_line(&body));
                draft_from(
                    call,
                    &resolved,
                    Kind::Write,
                    count_lines(&body),
                    0,
                    preview,
                    Vec::new(),
                    Some(body.into_bytes()),
                    None,
                    String::new(),
                )
            }
        }
        Piece::Delete { path } => {
            let resolved = resolve_cached(&path, cwd_canon, cache);
            draft_from(
                call,
                &resolved,
                Kind::Delete,
                0,
                0,
                "deleted".to_string(),
                Vec::new(),
                None,
                None,
                String::new(),
            )
        }
        Piece::Moved {
            path,
            from_add,
            body,
        } => {
            let resolved = resolve_cached(&path, cwd_canon, cache);
            if from_add {
                let preview = one_line(&first_line(&body));
                draft_from(
                    call,
                    &resolved,
                    Kind::Write,
                    count_lines(&body),
                    0,
                    preview,
                    Vec::new(),
                    Some(body.into_bytes()),
                    None,
                    String::new(),
                )
            } else {
                draft_from(
                    call,
                    &resolved,
                    Kind::Patch,
                    0,
                    0,
                    String::new(),
                    Vec::new(),
                    None,
                    Some("move without full body".to_string()),
                    body,
                )
            }
        }
    }
}

fn patch_station(
    call: &Call,
    raw: &str,
    body: &str,
    cwd_canon: Option<&Path>,
    cache: &mut HashMap<String, Resolved>,
    preset: Option<String>,
) -> Draft {
    let resolved = resolve_cached(raw, cwd_canon, cache);
    let walked = walk_patch_body(body);
    let failed = walked.failed || preset.is_some();
    let preview = walked
        .added_line
        .as_deref()
        .map(plus_preview)
        .unwrap_or_default();
    draft_from(
        call,
        &resolved,
        Kind::Patch,
        walked.added,
        walked.removed,
        preview,
        if failed { Vec::new() } else { walked.hunks },
        None,
        if walked.failed {
            Some("hunk context not found".to_string())
        } else {
            preset
        },
        body.to_string(),
    )
}

fn split_patch(text: &str) -> Vec<Piece> {
    #[derive(Clone)]
    enum Open {
        Update { path: String, lines: Vec<String> },
        Add { path: String, lines: Vec<String> },
        Delete { path: String },
        Unified { path: String, lines: Vec<String> },
    }
    let mut out = Vec::new();
    let mut open: Option<Open> = None;
    let flush = |open: &mut Option<Open>, out: &mut Vec<Piece>| {
        let Some(section) = open.take() else {
            return;
        };
        match section {
            Open::Update { path, lines } | Open::Unified { path, lines } => {
                out.push(Piece::Update {
                    path,
                    body: lines.join("\n"),
                });
            }
            Open::Add { path, lines } => match add_body(&lines) {
                Ok(body) => out.push(Piece::Add {
                    path,
                    body,
                    failed: false,
                }),
                Err(()) => out.push(Piece::Add {
                    path,
                    body: lines.join("\n"),
                    failed: true,
                }),
            },
            Open::Delete { path } => out.push(Piece::Delete { path }),
        }
    };
    let consume = |open: &mut Option<Open>, dest: String, out: &mut Vec<Piece>| {
        let Some(section) = open.take() else {
            return;
        };
        match section {
            Open::Add { path, lines } => match add_body(&lines) {
                Ok(body) => {
                    out.push(Piece::Delete { path });
                    out.push(Piece::Moved {
                        path: dest,
                        from_add: true,
                        body,
                    });
                }
                Err(()) => {
                    out.push(Piece::Delete { path });
                    out.push(Piece::Moved {
                        path: dest,
                        from_add: false,
                        body: lines.join("\n"),
                    });
                }
            },
            Open::Update { path, lines } | Open::Unified { path, lines } => {
                out.push(Piece::Delete { path });
                out.push(Piece::Moved {
                    path: dest,
                    from_add: false,
                    body: lines.join("\n"),
                });
            }
            Open::Delete { path } => {
                out.push(Piece::Delete { path });
                out.push(Piece::Moved {
                    path: dest,
                    from_add: false,
                    body: String::new(),
                });
            }
        }
    };
    // A terminating newline is not a body line. A blank line in the middle still is.
    let mut raw_lines: Vec<&str> = text.split('\n').collect();
    if raw_lines.last().is_some_and(|line| line.is_empty()) {
        raw_lines.pop();
    }
    for line in raw_lines {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line == "*** Begin Patch" {
            continue;
        }
        if line == "*** End Patch" {
            flush(&mut open, &mut out);
            continue;
        }
        if let Some(path) = prefixed_path(line, "*** Update File:") {
            flush(&mut open, &mut out);
            open = Some(Open::Update {
                path,
                lines: Vec::new(),
            });
            continue;
        }
        if let Some(path) = prefixed_path(line, "*** Add File:") {
            flush(&mut open, &mut out);
            open = Some(Open::Add {
                path,
                lines: Vec::new(),
            });
            continue;
        }
        if let Some(path) = prefixed_path(line, "*** Delete File:") {
            flush(&mut open, &mut out);
            open = Some(Open::Delete { path });
            continue;
        }
        if let Some(dest) = prefixed_path(line, "*** Move to:") {
            consume(&mut open, dest, &mut out);
            continue;
        }
        if let Some(path) = unified_new_path(line) {
            flush(&mut open, &mut out);
            open = Some(Open::Unified {
                path,
                lines: Vec::new(),
            });
            continue;
        }
        if let Some(section) = open.as_mut() {
            match section {
                Open::Update { lines, .. }
                | Open::Add { lines, .. }
                | Open::Unified { lines, .. } => {
                    lines.push(line.to_string());
                }
                Open::Delete { .. } => {}
            }
        }
    }
    flush(&mut open, &mut out);
    out
}

fn prefixed_path(line: &str, prefix: &str) -> Option<String> {
    let rest = line.strip_prefix(prefix)?.trim();
    if rest.is_empty() {
        None
    } else {
        Some(rest.to_string())
    }
}

fn unified_new_path(line: &str) -> Option<String> {
    let rest = line.strip_prefix("diff --git ")?;
    let (_, new_path) = rest.split_once(" b/")?;
    let new_path = new_path.trim();
    if new_path.is_empty() {
        None
    } else {
        Some(new_path.to_string())
    }
}

fn add_body(lines: &[String]) -> Result<String, ()> {
    let mut parts = Vec::new();
    for line in lines {
        if let Some(rest) = line.strip_prefix('+') {
            parts.push(rest.to_string());
        } else {
            return Err(());
        }
    }
    Ok(parts.join("\n"))
}

struct Walked {
    hunks: Vec<Hunk>,
    added: u64,
    removed: u64,
    failed: bool,
    added_line: Option<String>,
}

fn walk_patch_body(body: &str) -> Walked {
    let mut hunks = Vec::new();
    let mut needle = Vec::new();
    let mut replacement = Vec::new();
    let mut hint = 0usize;
    let mut added = 0u64;
    let mut removed = 0u64;
    let mut failed = false;
    let mut added_line = None;
    let mut have = false;
    let flush = |hunks: &mut Vec<Hunk>,
                 needle: &mut Vec<String>,
                 replacement: &mut Vec<String>,
                 hint: usize,
                 have: &mut bool| {
        if !*have {
            needle.clear();
            replacement.clear();
            return;
        }
        hunks.push(Hunk {
            old: needle.join("\n"),
            new: replacement.join("\n"),
            replace_all: false,
            hint,
        });
        needle.clear();
        replacement.clear();
        *have = false;
    };
    if body.is_empty() {
        return Walked {
            hunks,
            added,
            removed,
            failed: true,
            added_line,
        };
    }
    let mut lines: Vec<&str> = body.split('\n').collect();
    if lines.len() > 1 && lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    for line in lines {
        if is_hunk_header(line) {
            flush(&mut hunks, &mut needle, &mut replacement, hint, &mut have);
            if line.starts_with("@@") {
                hint = at_hint(line);
            }
            continue;
        }
        if line == "\\ No newline at end of file" {
            continue;
        }
        let bytes = line.as_bytes();
        if bytes.is_empty() {
            failed = true;
            continue;
        }
        let rest = &line[1..];
        match bytes[0] {
            b' ' => {
                needle.push(rest.to_string());
                replacement.push(rest.to_string());
                have = true;
            }
            b'+' => {
                replacement.push(rest.to_string());
                added = added.saturating_add(1);
                if added_line.is_none() && !rest.is_empty() {
                    added_line = Some(rest.to_string());
                }
                have = true;
            }
            b'-' => {
                needle.push(rest.to_string());
                removed = removed.saturating_add(1);
                have = true;
            }
            _ => failed = true,
        }
    }
    flush(&mut hunks, &mut needle, &mut replacement, hint, &mut have);
    Walked {
        hunks,
        added,
        removed,
        failed,
        added_line,
    }
}

fn is_hunk_header(line: &str) -> bool {
    if line.starts_with("@@") {
        return true;
    }
    if let Some(rest) = line.strip_prefix("index") {
        return rest.starts_with(' ');
    }
    if let Some(rest) = line.strip_prefix("---") {
        return rest.is_empty() || rest.starts_with(' ');
    }
    if let Some(rest) = line.strip_prefix("+++") {
        return rest.is_empty() || rest.starts_with(' ');
    }
    false
}

fn at_hint(line: &str) -> usize {
    let Some(rest) = line.strip_prefix("@@") else {
        return 0;
    };
    let rest = rest.trim_start();
    let Some(rest) = rest.strip_prefix('-') else {
        return 0;
    };
    let digits: String = rest.chars().take_while(|ch| ch.is_ascii_digit()).collect();
    let start: usize = digits.parse().unwrap_or(1);
    start.saturating_sub(1)
}

#[allow(clippy::too_many_arguments)]
fn draft_from(
    call: &Call,
    resolved: &Resolved,
    kind: Kind,
    added: u64,
    removed: u64,
    preview: String,
    hunks: Vec<Hunk>,
    write_bytes: Option<Vec<u8>>,
    preset: Option<String>,
    hunk_display: String,
) -> Draft {
    Draft {
        id: format!("{}:{}:{}", call.offset, call.call_index, resolved.display),
        path: resolved.display.clone(),
        outside: resolved.outside,
        read_path: resolved.read.clone(),
        tool: call.name.clone(),
        kind,
        added,
        removed,
        preview,
        timestamp_ms: call.timestamp_ms,
        time_source: call.time_source,
        outcome: call.outcome,
        hunks,
        write_bytes,
        preset,
        hunk_display,
    }
}

fn resolve_cached(
    raw: &str,
    cwd_canon: Option<&Path>,
    cache: &mut HashMap<String, Resolved>,
) -> Resolved {
    if let Some(found) = cache.get(raw) {
        return found.clone();
    }
    let resolved = resolve_path(raw, cwd_canon);
    cache.insert(raw.to_string(), resolved.clone());
    resolved
}

fn resolve_path(raw: &str, cwd_canon: Option<&Path>) -> Resolved {
    if raw.is_empty()
        || raw.len() > MAX_PATH_LEN
        || raw.contains('\0')
        || raw.contains('\n')
        || raw.contains('\r')
        || raw.contains("://")
    {
        return Resolved {
            display: raw.to_string(),
            outside: true,
            read: None,
        };
    }
    let Some(cwd_canon) = cwd_canon else {
        return Resolved {
            display: raw.to_string(),
            outside: true,
            read: None,
        };
    };
    let raw_path = Path::new(raw);
    let joined = if raw_path.is_absolute() {
        raw_path.to_path_buf()
    } else {
        cwd_canon.join(raw_path)
    };
    let lex = lexical_normalize(&joined);
    if std::fs::symlink_metadata(&lex).is_ok() {
        return match lex.canonicalize() {
            Ok(canon) if canon.starts_with(cwd_canon) => Resolved {
                display: rel_display(cwd_canon, &canon),
                outside: false,
                read: Some(canon),
            },
            _ => Resolved {
                display: raw.to_string(),
                outside: true,
                read: None,
            },
        };
    }
    let lexical_inside = lex.starts_with(cwd_canon);
    if let Some(name) = lex.file_name() {
        if name != "." && name != ".." {
            if let Some(parent) = lex.parent() {
                if let Ok(parent_canon) = parent.canonicalize() {
                    if parent_canon.starts_with(cwd_canon) {
                        let abs = parent_canon.join(name);
                        return Resolved {
                            display: rel_display(cwd_canon, &abs),
                            outside: false,
                            read: None,
                        };
                    }
                    return Resolved {
                        display: raw.to_string(),
                        outside: true,
                        read: None,
                    };
                }
            }
        }
    }
    if lexical_inside {
        Resolved {
            display: rel_display(cwd_canon, &lex),
            outside: false,
            read: None,
        }
    } else {
        Resolved {
            display: raw.to_string(),
            outside: true,
            read: None,
        }
    }
}

fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

fn rel_display(cwd: &Path, path: &Path) -> String {
    let rel = path.strip_prefix(cwd).unwrap_or(path);
    let mut parts = Vec::new();
    for comp in rel.components() {
        match comp {
            Component::Normal(text) => parts.push(text.to_string_lossy().into_owned()),
            Component::ParentDir => parts.push("..".to_string()),
            _ => {}
        }
    }
    if parts.is_empty() {
        path.file_name()
            .map(|text| text.to_string_lossy().into_owned())
            .unwrap_or_default()
    } else {
        parts.join("/")
    }
}

fn read_inside(path: &Path) -> NowRead {
    let mtime = symlink_mtime_ms(path);
    let len = std::fs::symlink_metadata(path)
        .map(|meta| meta.len())
        .unwrap_or(0);
    if len > MAX_WORKTREE as u64 {
        return NowRead {
            available: false,
            reason: Some("file too large".to_string()),
            mtime,
            text: None,
            binary: false,
        };
    }
    let file = match File::open(path) {
        Ok(file) => file,
        Err(_) => return NowRead::missing(),
    };
    let mut buf = Vec::new();
    if file
        .take((MAX_WORKTREE as u64).saturating_add(1))
        .read_to_end(&mut buf)
        .is_err()
    {
        return NowRead::missing();
    }
    if buf.len() > MAX_WORKTREE {
        return NowRead {
            available: false,
            reason: Some("file too large".to_string()),
            mtime,
            text: None,
            binary: false,
        };
    }
    if buf.contains(&0) || std::str::from_utf8(&buf).is_err() {
        return NowRead {
            available: false,
            reason: Some("binary".to_string()),
            mtime,
            text: None,
            binary: true,
        };
    }
    NowRead {
        available: true,
        reason: None,
        mtime,
        text: String::from_utf8(buf).ok(),
        binary: false,
    }
}

impl NowRead {
    fn outside() -> Self {
        Self {
            available: false,
            reason: Some("outside the pane directory".to_string()),
            mtime: None,
            text: None,
            binary: false,
        }
    }

    fn missing() -> Self {
        Self {
            available: false,
            reason: Some("not found".to_string()),
            mtime: None,
            text: None,
            binary: false,
        }
    }
}

fn symlink_mtime_ms(path: &Path) -> Option<i64> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    let modified = meta.modified().ok()?;
    Some(
        modified
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_millis() as i64,
    )
}

fn hologram_for(loaded: &Loaded, station_id: &str) -> Result<ChronicleHologram, String> {
    if let Some(path) = station_id.strip_prefix("now:") {
        if loaded.session.files.iter().any(|file| file.path == path) {
            return Ok(now_hologram(loaded, path, station_id));
        }
        return Err("unknown station".to_string());
    }
    let Some(draft) = loaded.ops.iter().find(|draft| draft.id == station_id) else {
        return Err("unknown station".to_string());
    };
    if !loaded
        .session
        .stations
        .iter()
        .any(|station| station.id == station_id)
    {
        return Err("unknown station".to_string());
    }
    if draft.kind == Kind::Notebook {
        let now = now_text(loaded, &draft.path);
        let rev = notebook_rev(draft, now);
        return Ok(assemble_hologram(draft, &rev));
    }
    let ops = path_ops(loaded, &draft.path);
    let revs = rebuild(&ops, now_text(loaded, &draft.path));
    let Some(index) = ops.iter().position(|item| item.id == station_id) else {
        return Err("unknown station".to_string());
    };
    Ok(assemble_hologram(ops[index], &revs[index]))
}

fn now_hologram(loaded: &Loaded, path: &str, station_id: &str) -> ChronicleHologram {
    let read = loaded.now_by_path.get(path);
    let outside = loaded
        .session
        .files
        .iter()
        .find(|file| file.path == path)
        .is_some_and(|file| file.outside);
    if outside {
        return empty_hologram(
            station_id,
            path,
            "patch",
            Some("outside the pane directory".to_string()),
            "hunk",
        );
    }
    let Some(read) = read else {
        return empty_hologram(
            station_id,
            path,
            "patch",
            Some("not found".to_string()),
            "none",
        );
    };
    if read.binary {
        return empty_hologram(
            station_id,
            path,
            "binary",
            Some("binary".to_string()),
            "none",
        );
    }
    if !read.available {
        return empty_hologram(station_id, path, "patch", read.reason.clone(), "none");
    }
    let text = read.text.clone().unwrap_or_default();
    let ops = path_ops(loaded, path);
    let revs = rebuild(&ops, Some(&text));
    let previous = ops.iter().zip(revs.iter()).rev().find_map(|(_, rev)| {
        if matches!(rev.fidelity, Fidelity::Exact | Fidelity::Partial) {
            rev.after.clone()
        } else {
            None
        }
    });
    let (diff_text, diff_kind, diff_truncated, reason) = match previous {
        None => (String::new(), "none", false, None),
        Some(ref before) if same_text(before, &text) => (
            String::new(),
            "session",
            false,
            Some("Matches the last edit".to_string()),
        ),
        Some(ref before) => match unified(path, before, &text) {
            Some(diff) => {
                let (diff, truncated) = cap_bytes(&diff, MAX_DIFF_TEXT);
                (diff, "session", truncated, None)
            }
            None => (String::new(), "session", true, None),
        },
    };
    let (file_text, file_truncated, window_start_line, total_lines) =
        present_text(Some(&text), first_changed(previous.as_deref(), &text));
    let (added, removed) = diff_counts(&diff_text);
    ChronicleHologram {
        station_id: station_id.to_string(),
        path: path.to_string(),
        fidelity: "exact".to_string(),
        reason,
        file_text,
        file_truncated,
        window_start_line,
        total_lines,
        diff_text,
        diff_kind: diff_kind.to_string(),
        diff_truncated,
        added,
        removed,
    }
}

fn empty_hologram(
    station_id: &str,
    path: &str,
    fidelity: &str,
    reason: Option<String>,
    diff_kind: &str,
) -> ChronicleHologram {
    ChronicleHologram {
        station_id: station_id.to_string(),
        path: path.to_string(),
        fidelity: fidelity.to_string(),
        reason,
        file_text: None,
        file_truncated: false,
        window_start_line: 0,
        total_lines: 0,
        diff_text: String::new(),
        diff_kind: diff_kind.to_string(),
        diff_truncated: false,
        added: 0,
        removed: 0,
    }
}

fn path_ops<'a>(loaded: &'a Loaded, path: &str) -> Vec<&'a Draft> {
    loaded
        .ops
        .iter()
        .filter(|draft| draft.path == path && draft.kind != Kind::Notebook)
        .collect()
}

fn now_text<'a>(loaded: &'a Loaded, path: &str) -> Option<&'a str> {
    loaded
        .now_by_path
        .get(path)
        .and_then(|read| read.text.as_deref())
}

fn notebook_rev(draft: &Draft, now_text: Option<&str>) -> Rev {
    let Some(now_text) = now_text else {
        return patch_rev("notebook cell only");
    };
    let Some(hunk) = draft.hunks.first() else {
        return patch_rev("notebook cell only");
    };
    match apply_replace(now_text, &hunk.old, &hunk.new, hunk.replace_all) {
        Ok((after, None)) => Rev {
            fidelity: Fidelity::Exact,
            reason: Some("notebook cell applied to the worktree read, not replayed".to_string()),
            before: Some(now_text.to_string()),
            after: Some(after),
            diff_kind: "session",
        },
        _ => patch_rev("notebook cell only"),
    }
}

fn rebuild(ops: &[&Draft], now_text: Option<&str>) -> Vec<Rev> {
    let mut rev = vec![
        Rev {
            fidelity: Fidelity::Patch,
            reason: None,
            before: None,
            after: None,
            diff_kind: "hunk",
        };
        ops.len()
    ];
    let mut state: Option<String> = None;
    for (index, op) in ops.iter().enumerate() {
        if op.outside {
            rev[index] = patch_rev("outside the pane directory");
            continue;
        }
        if op.outcome == Outcome::Error {
            if let Some(prev) = state.clone() {
                rev[index] = Rev {
                    fidelity: Fidelity::Exact,
                    reason: Some("tool reported failure".to_string()),
                    before: Some(prev.clone()),
                    after: Some(prev),
                    diff_kind: "hunk",
                };
            } else {
                rev[index] = patch_rev("tool reported failure");
            }
            continue;
        }
        if op.kind == Kind::Delete {
            if let Some(prev) = state.clone() {
                rev[index] = Rev {
                    fidelity: Fidelity::Deleted,
                    reason: None,
                    before: Some(prev),
                    after: Some(String::new()),
                    diff_kind: "session",
                };
                state = Some(String::new());
            } else {
                rev[index] = patch_rev("deleted; previous text unavailable");
            }
            continue;
        }
        if op.kind == Kind::Write {
            let bytes = op.write_bytes.clone().unwrap_or_default();
            if bytes.contains(&0) || std::str::from_utf8(&bytes).is_err() {
                rev[index] = Rev {
                    fidelity: Fidelity::Binary,
                    reason: Some("binary".to_string()),
                    before: None,
                    after: None,
                    diff_kind: "none",
                };
                continue;
            }
            if bytes.len() > MAX_WORKTREE {
                rev[index] = patch_rev("hunk capped");
                continue;
            }
            let body = String::from_utf8(bytes).unwrap_or_default();
            rev[index] = Rev {
                fidelity: Fidelity::Exact,
                reason: None,
                before: state.clone(),
                after: Some(body.clone()),
                diff_kind: "session",
            };
            state = Some(body);
            continue;
        }
        if let Some(reason) = &op.preset {
            rev[index] = patch_rev(reason);
            continue;
        }
        if let Some(current) = state.clone() {
            match apply_op(op, &current) {
                Ok((next, partial)) => {
                    if let Some(reason) = partial {
                        rev[index] = Rev {
                            fidelity: Fidelity::Partial,
                            reason: Some(reason),
                            before: Some(current),
                            after: Some(next.clone()),
                            diff_kind: "session",
                        };
                    } else {
                        rev[index] = Rev {
                            fidelity: Fidelity::Exact,
                            reason: None,
                            before: Some(current),
                            after: Some(next.clone()),
                            diff_kind: "session",
                        };
                    }
                    state = Some(next);
                }
                Err(err) => rev[index] = patch_rev(&err),
            }
        } else {
            rev[index] = patch_rev("no anchor");
        }
    }

    let mut cursor = now_text.map(str::to_string);
    for index in (0..ops.len()).rev() {
        if ops[index].outcome == Outcome::Error {
            continue;
        }
        match rev[index].fidelity {
            Fidelity::Exact | Fidelity::Partial | Fidelity::Deleted => {
                if rev[index].before.is_none() {
                    break;
                }
                cursor = rev[index].before.clone();
            }
            Fidelity::Binary => {}
            Fidelity::Patch => {
                if let Some(current) = cursor.clone() {
                    match invert_op(ops[index], &current) {
                        Ok(prev) => {
                            rev[index] = Rev {
                                fidelity: Fidelity::Exact,
                                reason: None,
                                before: Some(prev.clone()),
                                after: Some(current),
                                diff_kind: "session",
                            };
                            cursor = Some(prev);
                        }
                        Err(_) => cursor = None,
                    }
                } else {
                    cursor = None;
                }
            }
        }
    }

    if let (Some(now_text), Some(last_op), Some(last)) = (now_text, ops.last(), rev.last_mut()) {
        if last_op.outcome != Outcome::Error
            && matches!(last.fidelity, Fidelity::Exact | Fidelity::Partial)
            && last
                .after
                .as_deref()
                .is_some_and(|after| !same_text(after, now_text))
        {
            let note = "Worktree differs from the last applied edit.";
            last.reason = Some(match last.reason.take() {
                Some(prev) => format!("{prev} {note}"),
                None => note.to_string(),
            });
        }
    }
    rev
}

fn patch_rev(reason: &str) -> Rev {
    Rev {
        fidelity: Fidelity::Patch,
        reason: Some(reason.to_string()),
        before: None,
        after: None,
        diff_kind: "hunk",
    }
}

fn apply_op(op: &Draft, text: &str) -> Result<(String, Option<String>), String> {
    if op.hunks.is_empty() {
        return Err("hunk context not found".to_string());
    }
    if op
        .hunks
        .iter()
        .any(|hunk| hunk.old.len().saturating_add(hunk.new.len()) > MAX_HUNK)
    {
        return Err("hunk capped".to_string());
    }
    let mut cur = text.to_string();
    let mut partial = None;
    for hunk in &op.hunks {
        if op.kind == Kind::Patch {
            cur = apply_patch_hunk(&cur, hunk)?;
        } else {
            let (next, part) = apply_replace(&cur, &hunk.old, &hunk.new, hunk.replace_all)?;
            cur = next;
            if part.is_some() {
                partial = part;
            }
        }
    }
    Ok((cur, partial))
}

fn apply_replace(
    text: &str,
    old: &str,
    new: &str,
    replace_all: bool,
) -> Result<(String, Option<String>), String> {
    if old.is_empty() {
        return Err("empty old_string".to_string());
    }
    if old.len().saturating_add(new.len()) > MAX_HUNK {
        return Err("hunk capped".to_string());
    }
    let spans = find_all(text, old);
    if spans.is_empty() {
        return Err("old_string not in file".to_string());
    }
    if replace_all || spans.len() == 1 {
        return Ok((replace_spans(text, &spans, old.len(), new), None));
    }
    let count = spans.len();
    Ok((
        replace_spans(text, &spans[..1], old.len(), new),
        Some(format!("old_string matched {count} times; applied first")),
    ))
}

fn apply_patch_hunk(text: &str, hunk: &Hunk) -> Result<String, String> {
    if hunk.old.len().saturating_add(hunk.new.len()) > MAX_HUNK {
        return Err("hunk capped".to_string());
    }
    if hunk.old.is_empty() {
        return Err("hunk context not found".to_string());
    }
    let start = line_start_byte(text, hunk.hint);
    let pos = if let Some(rel) = text[start..].find(&hunk.old) {
        start + rel
    } else if start > 0 {
        text.find(&hunk.old)
            .ok_or_else(|| "hunk context not found".to_string())?
    } else {
        return Err("hunk context not found".to_string());
    };
    Ok(replace_spans(text, &[pos], hunk.old.len(), &hunk.new))
}

fn invert_op(op: &Draft, cursor: &str) -> Result<String, String> {
    if op.preset.as_deref() == Some("move without full body") {
        return Err("move without full body".to_string());
    }
    if op.kind != Kind::Replace && op.kind != Kind::Patch {
        return Err("not invertible".to_string());
    }
    if op.hunks.is_empty() {
        return Err("empty".to_string());
    }
    let mut cur = cursor.to_string();
    for hunk in op.hunks.iter().rev() {
        cur = invert_hunk(op.kind, &cur, hunk)?;
    }
    Ok(cur)
}

fn invert_hunk(kind: Kind, text: &str, hunk: &Hunk) -> Result<String, String> {
    if hunk.new.is_empty() {
        return Err("empty new_string".to_string());
    }
    if hunk.replace_all {
        return invert_all(text, &hunk.old, &hunk.new);
    }
    let spans = find_limit(text, &hunk.new, 9);
    if spans.len() > 8 {
        return Err("too many matches".to_string());
    }
    let mut hits = Vec::new();
    for pos in spans {
        let prev = replace_spans(text, &[pos], hunk.new.len(), &hunk.old);
        let replay = if kind == Kind::Patch {
            apply_patch_hunk(&prev, hunk)
        } else {
            apply_replace(&prev, &hunk.old, &hunk.new, false).map(|(next, _)| next)
        };
        if replay.is_ok_and(|next| same_text(&next, text)) {
            hits.push(prev);
        }
    }
    if hits.len() == 1 {
        Ok(hits.remove(0))
    } else {
        Err("not unique".to_string())
    }
}

fn invert_all(text: &str, old: &str, new: &str) -> Result<String, String> {
    if new.is_empty() {
        return Err("empty new_string".to_string());
    }
    let back = find_all(text, new);
    let prev = replace_spans(text, &back, new.len(), old);
    let forward = find_all(&prev, old);
    if back.len() != forward.len() {
        return Err("occurrence count".to_string());
    }
    let replay = replace_spans(&prev, &forward, old.len(), new);
    if same_text(&replay, text) {
        Ok(prev)
    } else {
        Err("not unique".to_string())
    }
}

fn find_all(hay: &str, needle: &str) -> Vec<usize> {
    find_limit(hay, needle, usize::MAX)
}

fn find_limit(hay: &str, needle: &str, limit: usize) -> Vec<usize> {
    let mut out = Vec::new();
    if needle.is_empty() {
        return out;
    }
    let mut start = 0usize;
    while out.len() < limit {
        let Some(pos) = hay[start..].find(needle) else {
            break;
        };
        let abs = start + pos;
        out.push(abs);
        let next = abs + needle.len();
        if next <= start {
            break;
        }
        start = next;
    }
    out
}

fn replace_spans(hay: &str, spans: &[usize], needle_len: usize, replacement: &str) -> String {
    let mut out = String::with_capacity(hay.len());
    let mut last = 0usize;
    for &span in spans {
        if span < last || span + needle_len > hay.len() {
            continue;
        }
        out.push_str(&hay[last..span]);
        out.push_str(replacement);
        last = span + needle_len;
    }
    out.push_str(&hay[last..]);
    out
}

fn line_start_byte(text: &str, line_index: usize) -> usize {
    if line_index == 0 {
        return 0;
    }
    let mut seen = 0usize;
    for (index, byte) in text.bytes().enumerate() {
        if byte == b'\n' {
            seen += 1;
            if seen == line_index {
                return index + 1;
            }
        }
    }
    text.len()
}

fn same_text(left: &str, right: &str) -> bool {
    left == right || strip_one_nl(left) == strip_one_nl(right)
}

fn strip_one_nl(text: &str) -> &str {
    text.strip_suffix('\n').unwrap_or(text)
}

fn assemble_hologram(draft: &Draft, rev: &Rev) -> ChronicleHologram {
    let snapshot = match rev.fidelity {
        Fidelity::Exact | Fidelity::Partial => rev.after.clone(),
        Fidelity::Deleted => Some(String::new()),
        Fidelity::Patch | Fidelity::Binary => None,
    };
    let focus = snapshot
        .as_deref()
        .map(|text| first_changed(rev.before.as_deref(), text))
        .unwrap_or(1);
    let (file_text, file_truncated, window_start_line, total_lines) =
        present_text(snapshot.as_deref(), focus);
    let (diff_text, diff_kind, diff_truncated) = match rev.diff_kind {
        "none" => (String::new(), "none".to_string(), false),
        "hunk" => {
            let (text, truncated) = cap_bytes(&draft.hunk_display, MAX_DIFF_TEXT);
            (text, "hunk".to_string(), truncated)
        }
        _ => {
            let before = rev.before.as_deref().unwrap_or("");
            let after = rev.after.as_deref().unwrap_or("");
            match unified(&draft.path, before, after) {
                Some(diff) => {
                    let (text, truncated) = cap_bytes(&diff, MAX_DIFF_TEXT);
                    (text, "session".to_string(), truncated)
                }
                None => {
                    let (text, _) = cap_bytes(&draft.hunk_display, MAX_DIFF_TEXT);
                    (text, "hunk".to_string(), true)
                }
            }
        }
    };
    ChronicleHologram {
        station_id: draft.id.clone(),
        path: draft.path.clone(),
        fidelity: fidelity_str(rev.fidelity).to_string(),
        reason: rev.reason.clone(),
        file_text,
        file_truncated,
        window_start_line,
        total_lines,
        diff_text,
        diff_kind,
        diff_truncated,
        added: draft.added,
        removed: draft.removed,
    }
}

fn present_text(text: Option<&str>, focus: u32) -> (Option<String>, bool, u32, u32) {
    let Some(text) = text else {
        return (None, false, 0, 0);
    };
    if text.is_empty() {
        return (Some(String::new()), false, 1, 0);
    }
    let (body, truncated, start, total) = window_text(text, focus);
    (Some(body), truncated, start, total)
}

fn window_text(text: &str, focus: u32) -> (String, bool, u32, u32) {
    let lines = split_lines(text);
    let total = lines.len() as u32;
    if text.len() <= MAX_HOLOGRAM_TEXT {
        return (text.to_string(), false, 1, total);
    }
    if lines.is_empty() {
        return (String::new(), true, 1, 0);
    }
    let focus = (focus.max(1) as usize - 1).min(lines.len() - 1);
    let mut lo = focus;
    let mut hi = focus + 1;
    let mut size = lines[focus].len().saturating_add(1);
    while lo > 0 || hi < lines.len() {
        let mut grew = false;
        if focus - lo < 20 && lo > 0 {
            let add = lines[lo - 1].len().saturating_add(1);
            if size + add <= MAX_HOLOGRAM_TEXT {
                lo -= 1;
                size += add;
                grew = true;
            }
        }
        if hi - focus < 20 && hi < lines.len() {
            let add = lines[hi].len().saturating_add(1);
            if size + add <= MAX_HOLOGRAM_TEXT {
                size += add;
                hi += 1;
                grew = true;
            }
        }
        if !grew {
            break;
        }
    }
    let mut window = lines[lo..hi].join("\n");
    if window.len() > MAX_HOLOGRAM_TEXT {
        let (capped, _) = cap_bytes(&window, MAX_HOLOGRAM_TEXT);
        window = capped;
    }
    (window, true, lo as u32 + 1, total)
}

fn first_changed(before: Option<&str>, after: &str) -> u32 {
    let left = split_lines(before.unwrap_or(""));
    let right = split_lines(after);
    let shared = left.len().min(right.len());
    for index in 0..shared {
        if left[index] != right[index] {
            return index as u32 + 1;
        }
    }
    if left.len() != right.len() {
        return shared as u32 + 1;
    }
    1
}

enum Change<'a> {
    Equal(&'a str),
    Delete(&'a str),
    Insert(&'a str),
}

fn unified(path: &str, before: &str, after: &str) -> Option<String> {
    let left = split_lines(before);
    let right = split_lines(after);
    let changes = ses(&left, &right)?;
    let mut rows = Vec::new();
    for change in &changes {
        match change {
            Change::Equal(text) => rows.push((' ', *text)),
            Change::Delete(text) => rows.push(('-', *text)),
            Change::Insert(text) => rows.push(('+', *text)),
        }
    }
    let changed: Vec<usize> = rows
        .iter()
        .enumerate()
        .filter(|(_, row)| row.0 != ' ')
        .map(|(index, _)| index)
        .collect();
    if changed.is_empty() {
        return Some(String::new());
    }
    let n = rows.len();
    let mut ranges = Vec::new();
    let mut start = changed[0].saturating_sub(DIFF_CONTEXT);
    let mut end = (changed[0] + 1 + DIFF_CONTEXT).min(n);
    let mut last = changed[0];
    for &index in &changed[1..] {
        if index <= last + DIFF_CONTEXT * 2 {
            end = (index + 1 + DIFF_CONTEXT).min(n);
            last = index;
        } else {
            ranges.push((start, end));
            start = index.saturating_sub(DIFF_CONTEXT);
            end = (index + 1 + DIFF_CONTEXT).min(n);
            last = index;
        }
    }
    ranges.push((start, end.min(n)));
    let mut out = format!("--- a/{path} (previous session step)\n+++ b/{path} (this step)\n");
    let mut old_line = 1u32;
    let mut new_line = 1u32;
    let mut cursor = 0usize;
    for (from, to) in ranges {
        while cursor < from {
            advance_line(rows[cursor].0, &mut old_line, &mut new_line);
            cursor += 1;
        }
        let old_start = old_line;
        let new_start = new_line;
        let mut old_count = 0u32;
        let mut new_count = 0u32;
        let mut body = String::new();
        while cursor < to {
            let (sig, text) = rows[cursor];
            body.push(sig);
            body.push_str(text);
            body.push('\n');
            match sig {
                ' ' => {
                    old_count += 1;
                    new_count += 1;
                }
                '-' => old_count += 1,
                '+' => new_count += 1,
                _ => {}
            }
            advance_line(sig, &mut old_line, &mut new_line);
            cursor += 1;
        }
        let old_at = if old_count == 0 { 0 } else { old_start };
        let new_at = if new_count == 0 { 0 } else { new_start };
        out.push_str(&format!(
            "@@ -{old_at},{old_count} +{new_at},{new_count} @@\n"
        ));
        out.push_str(&body);
    }
    Some(out)
}

fn advance_line(sig: char, old_line: &mut u32, new_line: &mut u32) {
    match sig {
        ' ' => {
            *old_line += 1;
            *new_line += 1;
        }
        '-' => *old_line += 1,
        '+' => *new_line += 1,
        _ => {}
    }
}

fn ses<'a>(left: &'a [&str], right: &'a [&str]) -> Option<Vec<Change<'a>>> {
    let n = left.len();
    let m = right.len();
    if n > MYERS_MAX_LINES || m > MYERS_MAX_LINES {
        return None;
    }
    if n > 0 && m > 0 && n.saturating_mul(m) > MYERS_MAX_COMPS {
        return None;
    }
    let mut dp = vec![vec![0u32; m + 1]; n + 1];
    for i in 0..n {
        for j in 0..m {
            if left[i] == right[j] {
                dp[i + 1][j + 1] = dp[i][j] + 1;
            } else {
                dp[i + 1][j + 1] = dp[i + 1][j].max(dp[i][j + 1]);
            }
        }
    }
    let mut rev = Vec::new();
    let mut i = n;
    let mut j = m;
    while i > 0 || j > 0 {
        if i > 0 && j > 0 && left[i - 1] == right[j - 1] {
            rev.push(Change::Equal(left[i - 1]));
            i -= 1;
            j -= 1;
        } else if j > 0 && (i == 0 || dp[i][j - 1] >= dp[i - 1][j]) {
            rev.push(Change::Insert(right[j - 1]));
            j -= 1;
        } else if i > 0 {
            rev.push(Change::Delete(left[i - 1]));
            i -= 1;
        } else {
            break;
        }
    }
    rev.reverse();
    Some(rev)
}

fn diff_counts(diff: &str) -> (u64, u64) {
    let mut added = 0u64;
    let mut removed = 0u64;
    for line in diff.lines() {
        if line.starts_with('+') && !line.starts_with("+++") {
            added += 1;
        } else if line.starts_with('-') && !line.starts_with("---") {
            removed += 1;
        }
    }
    (added, removed)
}

fn cap_bytes(text: &str, max: usize) -> (String, bool) {
    if text.len() <= max {
        return (text.to_string(), false);
    }
    let mut end = max;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_string(), true)
}

fn path_of(map: &Map<String, Value>) -> Option<String> {
    for key in PATH_KEYS {
        if let Some(value) = map.get(*key).and_then(Value::as_str) {
            let value = value.trim().trim_matches(['"', '\'', '`']);
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

fn str_of(map: &Map<String, Value>, keys: &[&str]) -> String {
    for key in keys {
        if let Some(value) = map.get(*key).and_then(Value::as_str) {
            return value.to_string();
        }
    }
    String::new()
}

fn flag_true(map: &Map<String, Value>) -> bool {
    ALL_KEYS
        .iter()
        .any(|key| map.get(*key).and_then(Value::as_bool) == Some(true))
}

fn split_lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut lines: Vec<&str> = text.split('\n').collect();
    if text.ends_with('\n') {
        lines.pop();
    }
    lines
}

fn count_lines(text: &str) -> u64 {
    if text.is_empty() {
        0
    } else {
        split_lines(text).len() as u64
    }
}

fn first_line(text: &str) -> String {
    split_lines(text).first().copied().unwrap_or("").to_string()
}

fn first_nonempty(text: &str) -> Option<String> {
    split_lines(text)
        .into_iter()
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

fn one_line(text: &str) -> String {
    let mut out = String::new();
    let mut spaced = false;
    for ch in text.chars() {
        if ch == '\t' {
            spaced = false;
            out.push('\t');
        } else if ch.is_whitespace() || ch.is_ascii_control() {
            if !out.is_empty() {
                spaced = true;
            }
        } else {
            if spaced {
                out.push(' ');
                spaced = false;
            }
            out.push(ch);
        }
    }
    out.chars().take(PREVIEW_CHARS).collect()
}

fn plus_preview(line: &str) -> String {
    let mut text = String::from("+");
    text.push_str(&one_line(line));
    text.chars().take(PREVIEW_CHARS).collect()
}

fn added_preview(text: &str) -> String {
    first_nonempty(text)
        .map(|line| plus_preview(&line))
        .unwrap_or_default()
}

fn format_replace(old: &str, new: &str) -> String {
    let mut out = String::new();
    if old.is_empty() {
        out.push_str("-\n");
    } else {
        for line in split_lines(old) {
            out.push('-');
            out.push_str(line);
            out.push('\n');
        }
    }
    if new.is_empty() {
        out.push_str("+\n");
    } else {
        for line in split_lines(new) {
            out.push('+');
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

fn kind_str(kind: Kind) -> &'static str {
    match kind {
        Kind::Replace => "replace",
        Kind::Write => "write",
        Kind::Delete => "delete",
        Kind::Patch => "patch",
        Kind::Notebook => "notebook",
    }
}

fn outcome_str(outcome: Outcome) -> &'static str {
    match outcome {
        Outcome::Unknown => "unknown",
        Outcome::Ok => "ok",
        Outcome::Error => "error",
    }
}

fn time_str(source: TimeSource) -> &'static str {
    match source {
        TimeSource::Record => "record",
        TimeSource::Event => "event",
        TimeSource::Ordinal => "ordinal",
    }
}

fn fidelity_str(fidelity: Fidelity) -> &'static str {
    match fidelity {
        Fidelity::Exact => "exact",
        Fidelity::Partial => "partial",
        Fidelity::Patch => "patch",
        Fidelity::Deleted => "deleted",
        Fidelity::Binary => "binary",
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    fn scratch(name: &str) -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|dur| dur.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "sparkmux-chronicle-{}-{}-{}-{}",
            std::process::id(),
            n,
            nanos,
            name
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn put(dir: &Path, rel: &str, bytes: &[u8]) {
        let path = dir.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, bytes).unwrap();
    }

    fn ndjson(rows: &[String]) -> String {
        let mut out = String::new();
        for row in rows {
            out.push_str(row);
            out.push('\n');
        }
        out
    }

    fn grok_calls(calls: serde_json::Value) -> String {
        serde_json::json!({"type": "assistant", "tool_calls": calls}).to_string()
    }

    fn write_call(path: &str, content: &str) -> serde_json::Value {
        serde_json::json!({
            "name": "write",
            "arguments": {"file_path": path, "content": content}
        })
    }

    fn replace_call(path: &str, old: &str, new: &str) -> serde_json::Value {
        serde_json::json!({
            "name": "search_replace",
            "arguments": {"file_path": path, "old_string": old, "new_string": new}
        })
    }

    fn load_grok(dir: &Path, body: &str) -> Loaded {
        let path = dir.join("chat_history.jsonl");
        std::fs::write(&path, body).unwrap();
        load_path(CliKind::Grok, &path, dir)
    }

    fn load_in(kind: CliKind, dir: &Path, body: &str) -> Loaded {
        let path = dir.join("session.jsonl");
        std::fs::write(&path, body).unwrap();
        load_path(kind, &path, dir)
    }

    fn write_started(dir: &Path, stamps: &[&str]) {
        let mut body = String::new();
        for ts in stamps {
            body.push_str(&format!("{{\"ts\":\"{ts}\",\"type\":\"tool_started\"}}\n"));
        }
        std::fs::write(dir.join("events.jsonl"), body).unwrap();
    }

    fn holo(loaded: &Loaded, ordinal: usize) -> ChronicleHologram {
        let id = loaded.session.stations[ordinal].id.clone();
        hologram_for(loaded, &id).unwrap_or_else(|err| panic!("{err} id={id}"))
    }

    fn holo_kind(loaded: &Loaded, path: &str, kind: &str) -> ChronicleHologram {
        let station = loaded
            .session
            .stations
            .iter()
            .find(|station| station.path == path && station.kind == kind)
            .unwrap_or_else(|| panic!("missing {kind} {path}"));
        hologram_for(loaded, &station.id).unwrap()
    }

    fn claude_msg(ts: &str, content: serde_json::Value) -> String {
        serde_json::json!({
            "type": "assistant",
            "timestamp": ts,
            "message": {"role": "assistant", "content": content}
        })
        .to_string()
    }

    #[test]
    fn two_edits_to_the_same_path_are_two_stations() {
        let dir = scratch("two");
        let body = ndjson(&[
            grok_calls(serde_json::json!([write_call("src/a.rs", "one")])),
            grok_calls(serde_json::json!([replace_call("src/a.rs", "one", "two")])),
        ]);
        let loaded = load_grok(&dir, &body);
        assert_eq!(loaded.session.stations.len(), 2);
        assert_eq!(
            loaded.session.stations[0].path,
            loaded.session.stations[1].path
        );
        assert_eq!(loaded.session.stations[0].kind, "write");
        assert_eq!(loaded.session.stations[1].kind, "replace");
        assert_ne!(loaded.session.stations[0].id, loaded.session.stations[1].id);
    }

    #[test]
    fn write_then_replace_matches_worktree() {
        let dir = scratch("match");
        put(&dir, "src/a.rs", b"beta");
        let body = ndjson(&[
            grok_calls(serde_json::json!([write_call("src/a.rs", "alpha")])),
            grok_calls(serde_json::json!([replace_call(
                "src/a.rs", "alpha", "beta"
            )])),
        ]);
        let loaded = load_grok(&dir, &body);
        let first = holo(&loaded, 0);
        let second = holo(&loaded, 1);
        assert_eq!(first.file_text.as_deref(), Some("alpha"));
        assert_eq!(second.file_text.as_deref(), Some("beta"));
        assert_eq!(second.diff_kind, "session");
        assert!(second.diff_text.contains("-alpha"), "{}", second.diff_text);
        assert!(second.diff_text.contains("+beta"), "{}", second.diff_text);
    }

    #[test]
    fn reverse_from_worktree_without_a_write() {
        let dir = scratch("rev");
        put(&dir, "src/a.rs", b"ccc");
        let body = ndjson(&[
            grok_calls(serde_json::json!([replace_call("src/a.rs", "aaa", "bbb")])),
            grok_calls(serde_json::json!([replace_call("src/a.rs", "bbb", "ccc")])),
        ]);
        let loaded = load_grok(&dir, &body);
        let first = holo(&loaded, 0);
        let second = holo(&loaded, 1);
        assert_eq!(first.fidelity, "exact");
        assert_eq!(first.file_text.as_deref(), Some("bbb"));
        assert!(first.diff_text.contains("-aaa"), "{}", first.diff_text);
        assert!(first.diff_text.contains("+bbb"), "{}", first.diff_text);
        assert_eq!(second.file_text.as_deref(), Some("ccc"));
    }

    #[test]
    fn old_string_missing_is_patch_only() {
        let dir = scratch("miss");
        put(&dir, "src/a.rs", b"unrelated");
        let loaded = load_grok(
            &dir,
            &grok_calls(serde_json::json!([replace_call(
                "src/a.rs", "missing", "nope"
            )])),
        );
        let panel = holo(&loaded, 0);
        assert_eq!(panel.fidelity, "patch");
        assert!(panel.file_text.is_none());
        assert_eq!(panel.diff_kind, "hunk");
        assert_eq!(panel.reason.as_deref(), Some("no anchor"));
    }

    #[test]
    fn failed_claude_is_error_is_not_applied() {
        let dir = scratch("cerr");
        let assistant = claude_msg(
            "2026-10-10T08:00:00.000Z",
            serde_json::json!([
                {"type":"tool_use","id":"w","name":"write","input":{"file_path":"a.rs","content":"AAA"}},
                {"type":"tool_use","id":"bad","name":"search_replace","input":{"file_path":"a.rs","old_string":"AAA","new_string":"REJECTED"}},
                {"type":"tool_use","id":"good","name":"search_replace","input":{"file_path":"a.rs","old_string":"AAA","new_string":"BBB"}},
                {"type":"tool_use","id":"lone","name":"search_replace","input":{"file_path":"empty.rs","old_string":"nope","new_string":"x"}}
            ]),
        );
        let user = serde_json::json!({
            "type": "user",
            "message": {"role": "user", "content": [
                {"type":"tool_result","tool_use_id":"bad","is_error":true,"content":"fail"},
                {"type":"tool_result","tool_use_id":"lone","is_error":true,"content":"fail"}
            ]}
        })
        .to_string();
        let loaded = load_in(CliKind::Claude, &dir, &ndjson(&[assistant, user]));
        assert_eq!(loaded.session.stations[1].outcome, "error");
        let failed = holo(&loaded, 1);
        assert_eq!(failed.fidelity, "exact");
        assert_eq!(failed.file_text.as_deref(), Some("AAA"));
        assert_eq!(failed.diff_kind, "hunk");
        assert_eq!(failed.reason.as_deref(), Some("tool reported failure"));
        let later = holo(&loaded, 2);
        assert_eq!(later.fidelity, "exact");
        assert_eq!(later.file_text.as_deref(), Some("BBB"));
        assert!(later.diff_text.contains("-AAA"), "{}", later.diff_text);
        assert!(!later.diff_text.contains("REJECTED"), "{}", later.diff_text);
        let lone = holo(&loaded, 3);
        assert_eq!(lone.fidelity, "patch");
        assert!(lone.file_text.is_none());
        assert_eq!(lone.reason.as_deref(), Some("tool reported failure"));
    }

    #[test]
    fn error_does_not_stop_older_inverse() {
        let dir = scratch("inv");
        put(&dir, "a.rs", b"BBB");
        let assistant = claude_msg(
            "2026-10-10T08:00:00.000Z",
            serde_json::json!([
                {"type":"tool_use","id":"w","name":"write","input":{"file_path":"a.rs","content":"AAA"}},
                {"type":"tool_use","id":"miss","name":"search_replace","input":{"file_path":"a.rs","old_string":"zzz","new_string":"BBB"}},
                {"type":"tool_use","id":"bad","name":"search_replace","input":{"file_path":"a.rs","old_string":"AAA","new_string":"QQQ"}}
            ]),
        );
        let user = serde_json::json!({
            "type": "user",
            "message": {"content": [
                {"type":"tool_result","tool_use_id":"bad","is_error":true,"content":"fail"}
            ]}
        })
        .to_string();
        let loaded = load_in(CliKind::Claude, &dir, &ndjson(&[assistant, user]));
        let missed = holo(&loaded, 1);
        assert_eq!(missed.fidelity, "exact");
        assert_eq!(missed.file_text.as_deref(), Some("BBB"));
        assert!(missed.diff_text.contains("-zzz"), "{}", missed.diff_text);
        assert!(missed.diff_text.contains("+BBB"), "{}", missed.diff_text);
        let failed = holo(&loaded, 2);
        assert_eq!(failed.fidelity, "exact");
        assert_eq!(failed.file_text.as_deref(), Some("AAA"));
        assert_eq!(failed.diff_kind, "hunk");
        assert_eq!(failed.reason.as_deref(), Some("tool reported failure"));
    }

    #[test]
    fn multiedit_hunks_apply_in_order() {
        let dir = scratch("multi");
        let write = claude_msg(
            "2026-10-10T08:00:00.000Z",
            serde_json::json!([
                {"type":"tool_use","id":"w","name":"write","input":{"file_path":"src/a.rs","content":"fn a"}}
            ]),
        );
        let edit = claude_msg(
            "2026-10-10T08:00:01.000Z",
            serde_json::json!([
                {"type":"tool_use","id":"e","name":"MultiEdit","input":{
                    "file_path":"src/a.rs",
                    "edits":[
                        {"old_string":"fn a","new_string":"fn b"},
                        {"old_string":"fn b","new_string":"fn c"}
                    ]
                }}
            ]),
        );
        let loaded = load_in(CliKind::Claude, &dir, &ndjson(&[write, edit]));
        let edits: Vec<_> = loaded
            .session
            .stations
            .iter()
            .filter(|station| station.kind == "replace")
            .collect();
        assert_eq!(edits.len(), 1);
        assert_eq!(edits[0].tool, "MultiEdit");
        assert_eq!(edits[0].added, 2);
        assert_eq!(edits[0].removed, 2);
        let panel = holo_kind(&loaded, "src/a.rs", "replace");
        assert_eq!(panel.file_text.as_deref(), Some("fn c"));
        assert_eq!(panel.fidelity, "exact");
    }

    #[test]
    fn apply_patch_two_files_are_two_stations() {
        let dir = scratch("patch2");
        let patch = [
            "*** Begin Patch",
            "*** Update File: src/a.rs",
            "@@",
            "-old",
            "+new",
            "*** Update File: src/b.rs",
            "@@",
            "-x",
            "+y",
            "+z",
            "*** End Patch",
        ]
        .join("\n");
        let loaded = load_grok(
            &dir,
            &grok_calls(serde_json::json!([{
                "name": "apply_patch",
                "arguments": {"patch": patch}
            }])),
        );
        assert_eq!(loaded.session.stations.len(), 2);
        let a = loaded
            .session
            .stations
            .iter()
            .find(|station| station.path == "src/a.rs")
            .unwrap();
        let b = loaded
            .session
            .stations
            .iter()
            .find(|station| station.path == "src/b.rs")
            .unwrap();
        assert_eq!(a.added, 1);
        assert_eq!(a.removed, 1);
        assert_eq!(b.added, 2);
        assert_eq!(b.removed, 1);
        assert_ne!(a.added, b.added);
    }

    #[test]
    fn update_file_bare_at_applies() {
        let dir = scratch("at");
        let prior = ["--- heading", "--- heading", "line", "old"].join("\n");
        let after = ["--- heading", "line", "new"].join("\n");
        let patch = [
            "*** Update File: src/a.rs",
            "@@",
            " --- heading",
            "---- heading",
            " line",
            "-old",
            "+new",
        ]
        .join("\n");
        let body = ndjson(&[
            grok_calls(serde_json::json!([write_call("src/a.rs", &prior)])),
            grok_calls(serde_json::json!([{
                "name": "apply_patch",
                "arguments": {"patch": patch}
            }])),
        ]);
        let loaded = load_grok(&dir, &body);
        let panel = holo(&loaded, 1);
        assert_eq!(panel.fidelity, "exact");
        assert_eq!(panel.file_text.as_deref(), Some(after.as_str()));
    }

    #[test]
    fn grok_events_pair_only_when_counts_match() {
        let matched = scratch("ev");
        let t0 = "2026-10-10T08:55:27.000Z";
        let t1 = "2026-10-10T08:55:28.000Z";
        write_started(&matched, &[t0, t1]);
        let body = grok_calls(serde_json::json!([
            {"name":"read_file","arguments":{"target_file":"skip.rs"}},
            replace_call("src/main.rs", "a", "b")
        ]));
        let loaded = load_grok(&matched, &body);
        assert_eq!(loaded.session.stations.len(), 1);
        assert_eq!(loaded.session.stations[0].path, "src/main.rs");
        assert_eq!(loaded.session.stations[0].time_source, "event");
        assert_eq!(loaded.session.stations[0].timestamp_ms, parse_iso_ms(t1));
        assert_ne!(loaded.session.stations[0].timestamp_ms, parse_iso_ms(t0));

        let drifted = scratch("ev2");
        write_started(&drifted, &[t0, t1, "2026-10-10T08:55:29.000Z"]);
        let loaded = load_grok(&drifted, &body);
        assert_eq!(loaded.session.stations[0].time_source, "ordinal");
        assert!(loaded.session.stations[0].timestamp_ms.is_none());
    }

    #[test]
    fn claude_timestamp_is_record_source() {
        let dir = scratch("ts");
        let later = "2026-10-10T12:00:00.000Z";
        let earlier = "2026-10-10T08:00:00.000Z";
        let body = ndjson(&[
            claude_msg(
                later,
                serde_json::json!([
                    {"type":"tool_use","id":"a","name":"write","input":{"file_path":"first.rs","content":"A"}}
                ]),
            ),
            serde_json::json!({
                "type": "assistant",
                "timestamp": "2026-10-10T09:00:00.000Z",
                "isMeta": true,
                "message": {"content": [
                    {"type":"tool_use","id":"m","name":"write","input":{"file_path":"meta.rs","content":"no"}}
                ]}
            })
            .to_string(),
            claude_msg(
                earlier,
                serde_json::json!([
                    {"type":"tool_use","id":"b","name":"write","input":{"file_path":"second.rs","content":"B"}}
                ]),
            ),
        ]);
        let loaded = load_in(CliKind::Claude, &dir, &body);
        assert_eq!(loaded.session.stations.len(), 2);
        assert!(loaded
            .session
            .stations
            .iter()
            .all(|station| station.path != "meta.rs"));
        assert_eq!(loaded.session.stations[0].path, "first.rs");
        assert_eq!(loaded.session.stations[1].path, "second.rs");
        assert_eq!(loaded.session.stations[0].time_source, "record");
        assert_eq!(loaded.session.stations[1].time_source, "record");
        assert!(loaded.session.stations[0].timestamp_ms > loaded.session.stations[1].timestamp_ms);
        assert_eq!(loaded.session.stations[0].ordinal, 0);
    }

    #[test]
    fn tail_over_cap_sets_truncated() {
        let dir = scratch("cap");
        let station = grok_calls(serde_json::json!([replace_call("src/a.rs", "a", "b")]));
        let mut bytes = Vec::new();
        bytes.extend(br#"{"type":"assistant","tool_calls":[{"name":"read_file","arguments":{"target_file":"old.rs"}}]}"#);
        bytes.push(b'\n');
        bytes.extend(vec![b'x'; MAX_TRANSCRIPT as usize + 32]);
        bytes.push(b'\n');
        bytes.extend(station.as_bytes());
        bytes.push(b'\n');
        let path = dir.join("chat_history.jsonl");
        std::fs::write(&path, &bytes).unwrap();
        write_started(&dir, &["2026-10-10T08:55:27.000Z"]);
        let loaded = load_path(CliKind::Grok, &path, &dir);
        assert!(loaded.session.truncated_tail);
        assert_eq!(loaded.session.stations.len(), 1);
        assert_eq!(loaded.session.stations[0].time_source, "ordinal");
        assert!(loaded.session.stations[0].timestamp_ms.is_none());
    }

    #[test]
    fn symlink_outside_cwd_is_not_read() {
        let dir = scratch("out");
        let cwd = dir.join("proj");
        std::fs::create_dir(&cwd).unwrap();
        let secret = dir.join("secret.txt");
        std::fs::write(&secret, b"OUTSIDE_SECRET_BYTES").unwrap();
        std::os::unix::fs::symlink(&secret, cwd.join("leak.txt")).unwrap();
        let body = grok_calls(serde_json::json!([write_call("leak.txt", "preview")]));
        let path = cwd.join("chat_history.jsonl");
        std::fs::write(&path, body).unwrap();
        let loaded = load_path(CliKind::Grok, &path, &cwd);
        assert_eq!(loaded.session.stations.len(), 1);
        assert!(loaded.session.files[0].outside);
        let panel = holo(&loaded, 0);
        assert_eq!(panel.fidelity, "patch");
        assert_eq!(panel.reason.as_deref(), Some("outside the pane directory"));
        assert!(panel.file_text.is_none());
        assert!(!format!("{panel:?}").contains("OUTSIDE_SECRET_BYTES"));
    }

    #[test]
    fn nul_byte_is_binary() {
        let dir = scratch("nul");
        put(&dir, "a.rs", b"visible\0more");
        let body = grok_calls(serde_json::json!([
            write_call("a.rs", "visible"),
            {"name":"write","arguments":{"file_path":"b.rs","content":"\u{0000}"}}
        ]));
        let loaded = load_grok(&dir, &body);
        let kept = holo(&loaded, 0);
        assert_eq!(kept.fidelity, "exact");
        assert_eq!(kept.file_text.as_deref(), Some("visible"));
        let binary = holo(&loaded, 1);
        assert_eq!(binary.fidelity, "binary");
        assert!(binary.file_text.is_none());
        assert_eq!(binary.diff_kind, "none");
        let now = hologram_for(&loaded, "now:a.rs").unwrap();
        assert_eq!(now.fidelity, "binary");
        assert!(now.file_text.is_none());
        assert!(
            loaded
                .session
                .files
                .iter()
                .find(|file| file.path == "a.rs")
                .unwrap()
                .binary
        );
    }

    #[test]
    fn no_transcript_empty_reason() {
        let dir = scratch("none");
        let session = build_chronicle_session("bash", dir.to_str().unwrap(), "", 0);
        assert_eq!(
            session.empty_reason.as_deref(),
            Some("No agent transcript for this pane.")
        );
        assert!(session.stations.is_empty());
        assert!(session.cli.is_none());
        assert_eq!(session.omitted, 0);
        assert!(!session.truncated_tail);
    }

    #[test]
    fn delete_after_is_empty() {
        let dir = scratch("del");
        put(&dir, "secret.rs", b"SECRET_STILL");
        let body = ndjson(&[
            grok_calls(serde_json::json!([write_call("gone.rs", "gone")])),
            grok_calls(serde_json::json!([
                {"name":"delete_file","arguments":{"file_path":"gone.rs"}},
                {"name":"delete_file","arguments":{"file_path":"secret.rs"}}
            ])),
        ]);
        let loaded = load_grok(&dir, &body);
        let known = holo_kind(&loaded, "gone.rs", "delete");
        assert_eq!(known.fidelity, "deleted");
        assert_eq!(known.file_text.as_deref(), Some(""));
        let unknown = holo_kind(&loaded, "secret.rs", "delete");
        assert_eq!(unknown.fidelity, "patch");
        assert!(unknown.file_text.is_none());
        assert_eq!(
            unknown.reason.as_deref(),
            Some("deleted; previous text unavailable")
        );
        assert!(!format!("{unknown:?}").contains("SECRET_STILL"));
    }

    #[test]
    fn notebook_mismatch_is_patch() {
        let dir = scratch("nb");
        put(&dir, "n.ipynb", b"bbb");
        put(&dir, "m.ipynb", b"cell");
        let body = ndjson(&[
            grok_calls(serde_json::json!([write_call("n.ipynb", "aaa")])),
            grok_calls(serde_json::json!([{
                "name": "notebook_edit",
                "arguments": {"notebook_path": "n.ipynb", "old_string": "zzz", "new_string": "qqq"}
            }])),
            grok_calls(serde_json::json!([replace_call("n.ipynb", "aaa", "bbb")])),
            grok_calls(serde_json::json!([write_call("m.ipynb", "cell")])),
            grok_calls(serde_json::json!([{
                "name": "notebook_edit",
                "arguments": {"notebook_path": "m.ipynb", "old_string": "cell", "new_string": "next"}
            }])),
            grok_calls(serde_json::json!([replace_call("m.ipynb", "cell", "done")])),
        ]);
        let loaded = load_grok(&dir, &body);
        let missed = holo_kind(&loaded, "n.ipynb", "notebook");
        assert_eq!(missed.fidelity, "patch");
        assert_eq!(missed.reason.as_deref(), Some("notebook cell only"));
        assert!(missed.file_text.is_none());
        let replaced = holo_kind(&loaded, "n.ipynb", "replace");
        assert_eq!(replaced.fidelity, "exact");
        assert_eq!(replaced.file_text.as_deref(), Some("bbb"));
        assert!(
            replaced.diff_text.contains("-aaa"),
            "{}",
            replaced.diff_text
        );
        let matched = holo_kind(&loaded, "m.ipynb", "notebook");
        assert_eq!(matched.fidelity, "exact");
        assert_eq!(
            matched.reason.as_deref(),
            Some("notebook cell applied to the worktree read, not replayed")
        );
        assert_eq!(matched.file_text.as_deref(), Some("next"));
        let neighbor = holo_kind(&loaded, "m.ipynb", "replace");
        assert_eq!(neighbor.fidelity, "exact");
        assert_eq!(neighbor.file_text.as_deref(), Some("done"));
    }

    #[test]
    fn hologram_ignores_a_path_that_is_not_a_station() {
        let dir = scratch("unk");
        let loaded = load_grok(
            &dir,
            &grok_calls(serde_json::json!([write_call("src/a.rs", "a")])),
        );
        assert_eq!(
            hologram_for(&loaded, "missing").unwrap_err(),
            "unknown station"
        );
        assert_eq!(
            hologram_for(&loaded, "now:0").unwrap_err(),
            "unknown station"
        );
        assert_eq!(
            hologram_for(&loaded, "now:1").unwrap_err(),
            "unknown station"
        );
    }

    #[test]
    fn module_does_not_spawn_git() {
        let src = include_str!("chronicle.rs");
        let spawn = concat!("Com", "mand::", "new");
        let process = concat!("std::", "process::", "Command");
        assert!(!src.contains(spawn));
        assert!(!src.contains(process));
    }

    #[test]
    fn commands_are_registered() {
        let src = include_str!("lib.rs");
        let start = src.find("generate_handler!").expect("handler");
        let body = &src[start..];
        let end = body.find("])").expect("end");
        let body = &body[..end];
        assert!(body.contains("chronicle::chronicle_session"));
        assert!(body.contains("chronicle::chronicle_hologram"));
        assert!(body.contains("chronicle::clear_chronicle_cache"));
    }

    #[test]
    fn string_arguments_parse_before_field_lookup() {
        let dir = scratch("str");
        let t0 = "2026-10-10T08:55:27.000Z";
        let t1 = "2026-10-10T08:55:28.000Z";
        let t2 = "2026-10-10T08:55:29.000Z";
        write_started(&dir, &[t0, t1, t2]);
        let good = r#"{"type":"assistant","tool_calls":[{"name":"read_file","arguments":{"target_file":"skip.rs"}},{"name":"search_replace","arguments":"{\"file_path\":\"src/main.rs\",\"old_string\":\"a\",\"new_string\":\"b\\nc\"}"}]}"#;
        let bad = r#"{"type":"assistant","tool_calls":[{"name":"search_replace","arguments":"not-json"}]}"#;
        let loaded = load_grok(&dir, &format!("{good}\n{bad}\n"));
        assert_eq!(loaded.session.stations.len(), 1);
        assert_eq!(loaded.session.stations[0].path, "src/main.rs");
        assert_eq!(loaded.session.stations[0].added, 2);
        assert_eq!(loaded.session.stations[0].removed, 1);
        assert_eq!(loaded.session.stations[0].time_source, "event");
        assert_eq!(loaded.session.stations[0].timestamp_ms, parse_iso_ms(t1));
    }

    #[test]
    fn replace_all_forward_and_inverse() {
        let forward = scratch("allf");
        let body = ndjson(&[
            grok_calls(serde_json::json!([write_call("src/a.rs", "foo-foo")])),
            grok_calls(serde_json::json!([{
                "name": "search_replace",
                "arguments": {
                    "file_path": "src/a.rs",
                    "old_string": "foo",
                    "new_string": "bar",
                    "replace_all": true
                }
            }])),
        ]);
        let loaded = load_grok(&forward, &body);
        let panel = holo(&loaded, 1);
        assert_eq!(panel.fidelity, "exact");
        assert_eq!(panel.file_text.as_deref(), Some("bar-bar"));

        let inverse = scratch("alli");
        put(&inverse, "src/a.rs", b"bar-bar");
        let loaded = load_grok(
            &inverse,
            &grok_calls(serde_json::json!([{
                "name": "search_replace",
                "arguments": {
                    "file_path": "src/a.rs",
                    "old_string": "foo",
                    "new_string": "bar",
                    "replace_all": true
                }
            }])),
        );
        let panel = holo(&loaded, 0);
        assert_eq!(panel.fidelity, "exact");
        assert_eq!(panel.file_text.as_deref(), Some("bar-bar"));
        assert!(panel.diff_text.contains("foo-foo"), "{}", panel.diff_text);

        let fail = scratch("allx");
        put(&fail, "src/a.rs", b"aaa");
        let loaded = load_grok(
            &fail,
            &grok_calls(serde_json::json!([{
                "name": "search_replace",
                "arguments": {
                    "file_path": "src/a.rs",
                    "old_string": "a",
                    "new_string": "aa",
                    "replace_all": true
                }
            }])),
        );
        let panel = holo(&loaded, 0);
        assert_eq!(panel.fidelity, "patch");
        assert!(panel.file_text.is_none());

        let text = scratch("allt");
        let body = ndjson(&[
            grok_calls(serde_json::json!([write_call("src/a.rs", "foo-foo")])),
            grok_calls(serde_json::json!([{
                "name": "search_replace",
                "arguments": {
                    "file_path": "src/a.rs",
                    "old_string": "foo",
                    "new_string": "bar",
                    "replace_all": "true"
                }
            }])),
        ]);
        let loaded = load_grok(&text, &body);
        let panel = holo(&loaded, 1);
        assert_eq!(panel.fidelity, "partial");
        assert_eq!(panel.file_text.as_deref(), Some("bar-foo"));
        assert_eq!(
            panel.reason.as_deref(),
            Some("old_string matched 2 times; applied first")
        );
    }

    #[test]
    fn apply_patch_move_replaces_the_open_section() {
        let dir = scratch("move");
        put(&dir, "src/g.rs", b"line\nnew");
        let patch = [
            "*** Update File: src/u.rs",
            "@@",
            " line",
            "-old",
            "+new",
            "*** Move to: src/g.rs",
            "*** Add File: src/e.rs",
            "+full",
            "+text",
            "*** Move to: src/f.rs",
        ]
        .join("\n");
        let body = ndjson(&[
            grok_calls(serde_json::json!([write_call("src/u.rs", "line\nold")])),
            grok_calls(serde_json::json!([write_call("src/g.rs", "KEEP")])),
            grok_calls(serde_json::json!([{
                "name": "apply_patch",
                "arguments": {"patch": patch}
            }])),
            grok_calls(serde_json::json!([replace_call(
                "src/g.rs", "KEEP", "AFTER"
            )])),
        ]);
        let loaded = load_grok(&dir, &body);
        let u: Vec<_> = loaded
            .session
            .stations
            .iter()
            .filter(|station| station.path == "src/u.rs")
            .map(|station| station.kind.as_str())
            .collect();
        assert_eq!(u, vec!["write", "delete"]);
        let deleted = holo_kind(&loaded, "src/u.rs", "delete");
        assert_eq!(deleted.fidelity, "deleted");
        assert_eq!(deleted.file_text.as_deref(), Some(""));
        assert!(deleted.diff_text.contains("-old"), "{}", deleted.diff_text);
        assert!(!deleted.diff_text.contains("-new"), "{}", deleted.diff_text);
        let moved = holo_kind(&loaded, "src/g.rs", "patch");
        assert_eq!(moved.fidelity, "patch");
        assert_eq!(moved.reason.as_deref(), Some("move without full body"));
        assert!(moved.file_text.is_none());
        let kept = holo_kind(&loaded, "src/g.rs", "replace");
        assert_eq!(kept.fidelity, "exact");
        assert_eq!(kept.file_text.as_deref(), Some("AFTER"));
        let e: Vec<_> = loaded
            .session
            .stations
            .iter()
            .filter(|station| station.path == "src/e.rs")
            .collect();
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].kind, "delete");
        let added = holo_kind(&loaded, "src/f.rs", "write");
        assert_eq!(added.fidelity, "exact");
        assert_eq!(added.file_text.as_deref(), Some("full\ntext"));
    }

    #[test]
    fn symlinked_pane_cwd_reads_the_file() {
        let root = scratch("symcwd");
        let real = root.join("real");
        let link = root.join("link");
        std::fs::create_dir(&real).unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        std::fs::write(real.join("note.txt"), b"SYMLINK_OK").unwrap();
        let logical = link.join("note.txt");
        let canon = link.canonicalize().unwrap();
        assert!(
            !logical.starts_with(&canon),
            "logical {} canon {}",
            logical.display(),
            canon.display()
        );
        let calls = serde_json::json!([
            replace_call("note.txt", "BEFORE", "SYMLINK_OK"),
            {
                "name": "search_replace",
                "arguments": {
                    "file_path": logical.to_str().unwrap(),
                    "old_string": "BEFORE",
                    "new_string": "SYMLINK_OK"
                }
            }
        ]);
        let path = root.join("chat_history.jsonl");
        std::fs::write(&path, grok_calls(calls)).unwrap();
        let loaded = load_path(CliKind::Grok, &path, &link);
        assert!(loaded.session.stations.iter().all(|station| {
            station.path == "note.txt" && !loaded.session.files.iter().any(|file| file.outside)
        }));
        assert_eq!(loaded.session.stations.len(), 2);
        let panel = holo(&loaded, 1);
        assert_eq!(panel.file_text.as_deref(), Some("SYMLINK_OK"));
        let now = hologram_for(&loaded, "now:note.txt").unwrap();
        assert_eq!(now.station_id, "now:note.txt");
        assert_eq!(now.file_text.as_deref(), Some("SYMLINK_OK"));
    }

    #[test]
    fn antigravity_view_file_does_not_fail_the_following_edit() {
        let dir = scratch("agy");
        put(&dir, "src/a.rs", b"bbb");
        let body = ndjson(&[
            serde_json::json!({
                "step_index": 1,
                "type": "PLANNER_RESPONSE",
                "created_at": "2026-10-10T01:00:05Z",
                "tool_calls": [
                    {"name": "view_file", "args": {"path": "a.rs"}},
                    {"name": "search_replace", "args": {
                        "file_path": "src/a.rs",
                        "old_string": "aaa",
                        "new_string": "bbb"
                    }}
                ]
            })
            .to_string(),
            serde_json::json!({
                "step_index": 2,
                "type": "VIEW_FILE",
                "source": "MODEL",
                "status": "ERROR",
                "error": "nope"
            })
            .to_string(),
            serde_json::json!({
                "step_index": 3,
                "type": "CODE_ACTION",
                "source": "SYSTEM",
                "status": "ERROR",
                "error": "steal"
            })
            .to_string(),
            serde_json::json!({
                "step_index": 4,
                "type": "CODE_ACTION",
                "source": "MODEL",
                "status": "DONE"
            })
            .to_string(),
        ]);
        let loaded = load_in(CliKind::Antigravity, &dir, &body);
        assert_eq!(loaded.session.stations.len(), 1);
        assert_eq!(loaded.session.stations[0].outcome, "ok");
        assert_eq!(loaded.session.stations[0].time_source, "record");
        assert!(loaded.session.stations[0].timestamp_ms.is_some());
        let panel = holo(&loaded, 0);
        assert_eq!(panel.fidelity, "exact");
        assert_eq!(panel.file_text.as_deref(), Some("bbb"));
    }

    #[test]
    fn file_offset_stable_when_the_tail_slides() {
        let dir = scratch("off");
        put(&dir, "src/a.rs", b"kept");
        let station = grok_calls(serde_json::json!([write_call("src/a.rs", "kept")]));
        let mut bytes = vec![b'p'; MAX_TRANSCRIPT as usize + 64];
        bytes.push(b'\n');
        bytes.extend(br#"{"bad":""#);
        bytes.push(0xff);
        bytes.extend(br#""}"#);
        bytes.push(b'\n');
        let station_at = bytes.len();
        bytes.extend(station.as_bytes());
        bytes.push(b'\n');
        let path = dir.join("chat_history.jsonl");
        std::fs::write(&path, &bytes).unwrap();
        let loaded = load_path(CliKind::Grok, &path, &dir);
        assert!(loaded.session.truncated_tail);
        assert_eq!(loaded.session.stations.len(), 1);
        let id = loaded.session.stations[0].id.clone();
        assert_eq!(id, format!("{station_at}:0:src/a.rs"));
        let kept_from = bytes.iter().position(|byte| *byte == b'\n').unwrap() + 1;
        let lossy = String::from_utf8_lossy(&bytes[kept_from..]);
        let rel = lossy.find(&station).expect("station");
        let lossy_abs = kept_from + rel;
        assert_ne!(lossy_abs, station_at);
        assert!(!id.starts_with(&format!("{lossy_abs}:")));

        let mut extra = Vec::new();
        for _ in 0..200 {
            extra.extend(br#"{"type":"user","content":"pad"}"#);
            extra.push(b'\n');
        }
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        file.write_all(&extra).unwrap();
        let again = load_path(CliKind::Grok, &path, &dir);
        assert_eq!(again.session.stations[0].id, id);
    }

    #[test]
    fn now_id_uses_path_not_lane() {
        let older = scratch("now1");
        put(&older, "src/b.rs", b"b");
        let first = load_grok(
            &older,
            &grok_calls(serde_json::json!([write_call("src/b.rs", "b")])),
        );
        assert_eq!(first.session.files[0].lane, 0);
        assert_eq!(
            hologram_for(&first, "now:src/b.rs").unwrap().station_id,
            "now:src/b.rs"
        );

        let dir = scratch("now2");
        put(&dir, "src/a.rs", b"a");
        put(&dir, "src/b.rs", b"b");
        let body = ndjson(&[
            grok_calls(serde_json::json!([write_call("src/b.rs", "b")])),
            grok_calls(serde_json::json!([write_call("src/a.rs", "a")])),
        ]);
        let loaded = load_grok(&dir, &body);
        assert_eq!(loaded.session.files[0].path, "src/a.rs");
        assert_eq!(loaded.session.files[0].lane, 0);
        let bee = loaded
            .session
            .files
            .iter()
            .find(|file| file.path == "src/b.rs")
            .unwrap();
        assert_ne!(bee.lane, 0);
        assert_eq!(
            hologram_for(&loaded, "now:src/a.rs").unwrap().station_id,
            "now:src/a.rs"
        );
        assert_eq!(
            hologram_for(&loaded, "now:src/b.rs").unwrap().station_id,
            "now:src/b.rs"
        );
        assert_eq!(
            hologram_for(&loaded, "now:0").unwrap_err(),
            "unknown station"
        );
        let value = serde_json::to_value(&loaded.session.now).unwrap();
        assert!(value.to_string().contains("worktree_mtime_ms"));
        for item in value.as_array().unwrap() {
            assert!(item.get("lane").is_none());
        }
        assert!(loaded
            .session
            .now
            .iter()
            .all(|item| item.worktree_mtime_ms.is_some()));
    }

    #[test]
    fn write_after_failed_apply_keeps_last_known_before() {
        let dir = scratch("keep");
        let body = ndjson(&[
            grok_calls(serde_json::json!([write_call("src/a.rs", "AAA")])),
            grok_calls(serde_json::json!([replace_call("src/a.rs", "zzz", "BBB")])),
            grok_calls(serde_json::json!([write_call("src/a.rs", "CCC")])),
        ]);
        let loaded = load_grok(&dir, &body);
        let panel = holo(&loaded, 2);
        assert_eq!(panel.fidelity, "exact");
        assert_eq!(panel.file_text.as_deref(), Some("CCC"));
        assert_eq!(panel.diff_kind, "session");
        assert!(panel.diff_text.contains("-AAA"), "{}", panel.diff_text);
        assert!(panel.diff_text.contains("+CCC"), "{}", panel.diff_text);
        assert!(!panel.diff_text.contains("-0,0"), "{}", panel.diff_text);
    }
}
