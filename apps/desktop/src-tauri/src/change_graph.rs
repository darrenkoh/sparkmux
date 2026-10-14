//! Read-only map of files changing in the focused pane's repo.
//!
//! Git is only asked for `rev-parse`, `status`, and `diff --numstat`. The
//! transcript is read the same way as the output panel. Nothing here writes
//! to git, tmux, or a CLI directory.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

use crate::artifacts;

const MAX_REPOS: usize = 8;
const MAX_FILES: usize = 240;
const MAX_FILES_PER_REPO: usize = 160;
const MAX_REFERENCED: usize = 8;
const MAX_IMPORT_FILES: usize = 40;
const MAX_TEXT: u64 = 64 * 1024;
const MAX_MANIFEST: u64 = 256 * 1024;
const MAX_TRANSCRIPT: u64 = 4 * 1024 * 1024;
const GIT_TIMEOUT: Duration = Duration::from_secs(4);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ChangeGraph {
    pub repos: Vec<RepoCluster>,
    pub edges: Vec<RepoEdge>,
    pub truncated: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RepoCluster {
    pub id: String,
    pub name: String,
    pub primary: bool,
    pub files: Vec<ChangedFile>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ChangedFile {
    pub path: String,
    pub status: String,
    pub agent_edited: bool,
    pub lines_added: u64,
    pub lines_removed: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RepoEdge {
    pub from_repo: String,
    pub to_repo: String,
    pub label: String,
    pub via: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AgentEdit {
    path: String,
    added: u64,
    removed: u64,
    deleted: bool,
}

#[derive(Debug, Clone)]
struct Dirty {
    path: String,
    status: &'static str,
    added: u64,
    removed: u64,
}

#[derive(Debug, Clone, Default)]
struct Identity {
    cargo: Vec<String>,
    npm: Vec<String>,
    go_module: Option<String>,
    python: Vec<String>,
}

#[derive(Clone, Copy)]
enum Lang {
    Rust,
    Js,
    Py,
    Go,
}

enum GitTop {
    Root(PathBuf),
    Outside,
    Unavailable(String),
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FileDiff {
    pub path: String,
    pub diff: String,
    pub is_binary: bool,
}

#[tauri::command]
pub async fn change_graph(
    command: String,
    cwd: String,
    title: String,
    pid: u32,
) -> Result<ChangeGraph, String> {
    tokio::task::spawn_blocking(move || {
        let edits = session_edits(&command, &cwd, &title, pid);
        build_change_graph(Path::new(&cwd), &edits)
    })
    .await
    .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn file_diff(repo_id: String, path: String, cwd: String) -> Result<FileDiff, String> {
    tokio::task::spawn_blocking(move || fetch_file_diff(&repo_id, &path, &cwd))
        .await
        .map_err(|err| err.to_string())?
}

#[derive(Debug, Clone, serde::Deserialize, PartialEq, Eq)]
pub struct SearchFileTarget {
    pub repo_id: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ChangedFileMatch {
    pub repo_id: String,
    pub path: String,
    pub match_count: usize,
}

#[tauri::command]
pub async fn search_changed_files(
    targets: Vec<SearchFileTarget>,
    query: String,
    scope: String,
    cwd: String,
) -> Result<Vec<ChangedFileMatch>, String> {
    tokio::task::spawn_blocking(move || {
        execute_search_changed_files(&targets, &query, &scope, &cwd)
    })
    .await
    .map_err(|err| err.to_string())
}

fn execute_search_changed_files(
    targets: &[SearchFileTarget],
    query: &str,
    scope: &str,
    cwd: &str,
) -> Vec<ChangedFileMatch> {
    let clean_query = query.trim().to_lowercase();
    if clean_query.is_empty() || targets.is_empty() {
        return Vec::new();
    }

    let num_workers = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(8)
        .min(targets.len());

    if num_workers <= 1 {
        let mut results = Vec::new();
        for target in targets {
            if let Some(m) = search_single_target(target, &clean_query, scope, cwd) {
                results.push(m);
            }
        }
        return results;
    }

    let chunk_size = targets.len().div_ceil(num_workers);
    let chunks: Vec<&[SearchFileTarget]> = targets.chunks(chunk_size).collect();

    std::thread::scope(|s| {
        let mut handles = Vec::with_capacity(chunks.len());
        for chunk in chunks {
            let q = &clean_query;
            handles.push(s.spawn(move || {
                let mut chunk_results = Vec::new();
                for target in chunk {
                    if let Some(m) = search_single_target(target, q, scope, cwd) {
                        chunk_results.push(m);
                    }
                }
                chunk_results
            }));
        }
        handles
            .into_iter()
            .flat_map(|h| h.join().unwrap_or_default())
            .collect()
    })
}

fn search_single_target(
    target: &SearchFileTarget,
    query_lower: &str,
    scope: &str,
    cwd: &str,
) -> Option<ChangedFileMatch> {
    let count = if scope == "full" {
        search_full_file(target, query_lower, cwd)
    } else {
        search_diff_file(target, query_lower, cwd)
    };

    if count > 0 {
        Some(ChangedFileMatch {
            repo_id: target.repo_id.clone(),
            path: target.path.clone(),
            match_count: count,
        })
    } else {
        None
    }
}

fn search_diff_file(target: &SearchFileTarget, query_lower: &str, cwd: &str) -> usize {
    let diff_res = fetch_file_diff(&target.repo_id, &target.path, cwd);
    let Ok(file_diff) = diff_res else {
        return 0;
    };
    if file_diff.is_binary {
        return 0;
    }
    let mut count = 0;
    for line in file_diff.diff.lines() {
        let is_add = line.starts_with('+') && !line.starts_with("+++");
        let is_rem = line.starts_with('-') && !line.starts_with("---");
        if is_add || is_rem {
            let content = &line[1..];
            if content.to_lowercase().contains(query_lower) {
                count += 1;
            }
        }
    }
    count
}

fn search_full_file(target: &SearchFileTarget, query_lower: &str, cwd: &str) -> usize {
    let clean_path = target
        .path
        .trim()
        .trim_matches(['"', '\'', '`'])
        .replace('\\', "/");
    if clean_path.is_empty() || clean_path.contains('\0') {
        return 0;
    }
    let repo_id_clean = target.repo_id.trim().trim_matches(['"', '\'', '`']);
    let repo_dir = if !repo_id_clean.is_empty() && Path::new(repo_id_clean).is_dir() {
        PathBuf::from(repo_id_clean)
    } else if !cwd.is_empty() && Path::new(cwd).is_dir() {
        match git_toplevel(Path::new(cwd)) {
            GitTop::Root(root) => root,
            _ => PathBuf::from(cwd),
        }
    } else {
        return 0;
    };

    let target_path = repo_dir.join(&clean_path);
    if let Ok(meta) = target_path.metadata() {
        if meta.len() > 2 * 1024 * 1024 {
            return 0;
        }
    }

    if target_path.is_file() {
        if let Ok(bytes) = std::fs::read(&target_path) {
            if bytes.contains(&0) {
                return 0;
            }
            let text = String::from_utf8_lossy(&bytes);
            let mut count = 0;
            for line in text.lines() {
                if line.to_lowercase().contains(query_lower) {
                    count += 1;
                }
            }
            return count;
        }
    }

    // Fallback if file was deleted on disk: check diff removed lines
    search_diff_file(target, query_lower, cwd)
}

fn fetch_file_diff(repo_id: &str, path: &str, cwd: &str) -> Result<FileDiff, String> {
    let clean_path = path
        .trim()
        .trim_matches(['"', '\'', '`'])
        .replace('\\', "/");
    if clean_path.is_empty() || clean_path.contains('\0') {
        return Err("invalid path".into());
    }
    let repo_id_clean = repo_id.trim().trim_matches(['"', '\'', '`']);
    let repo_dir = if !repo_id_clean.is_empty() && Path::new(repo_id_clean).is_dir() {
        PathBuf::from(repo_id_clean)
    } else if !cwd.is_empty() && Path::new(cwd).is_dir() {
        match git_toplevel(Path::new(cwd)) {
            GitTop::Root(root) => root,
            _ => PathBuf::from(cwd),
        }
    } else {
        return Err("invalid repository directory".into());
    };

    let target_path = repo_dir.join(&clean_path);
    if let Ok(meta) = target_path.metadata() {
        if meta.len() > 1024 * 1024 {
            return Ok(FileDiff {
                path: clean_path,
                diff: "Diff suppressed: File size exceeds 1MB.".into(),
                is_binary: true,
            });
        }
    }

    match git(
        &repo_dir,
        &["diff", "--no-ext-diff", "-U3", "HEAD", "--", &clean_path],
    ) {
        Ok(bytes) => {
            if bytes.contains(&0) {
                return Ok(FileDiff {
                    path: clean_path,
                    diff: "Binary file diff cannot be displayed.".into(),
                    is_binary: true,
                });
            }
            let diff_text = String::from_utf8_lossy(&bytes).into_owned();
            if !diff_text.trim().is_empty() {
                return Ok(FileDiff {
                    path: clean_path,
                    diff: diff_text,
                    is_binary: false,
                });
            }
        }
        Err(e) => {
            tracing::debug!("git diff failed: {e}");
        }
    }

    let is_tracked = git(
        &repo_dir,
        &["ls-files", "--error-unmatch", "--", &clean_path],
    )
    .is_ok();

    if !is_tracked && target_path.is_file() {
        match std::fs::read(&target_path) {
            Ok(bytes) => {
                if bytes.contains(&0) {
                    return Ok(FileDiff {
                        path: clean_path,
                        diff: "Binary file content cannot be displayed.".into(),
                        is_binary: true,
                    });
                }
                let content = String::from_utf8_lossy(&bytes);
                let mut pseudo = format!(
                    "--- /dev/null\n+++ b/{clean_path}\n@@ -0,0 +1,{} @@\n",
                    content.lines().count()
                );
                for line in content.lines() {
                    pseudo.push('+');
                    pseudo.push_str(line);
                    pseudo.push('\n');
                }
                return Ok(FileDiff {
                    path: clean_path,
                    diff: pseudo,
                    is_binary: false,
                });
            }
            Err(err) => {
                return Err(format!("failed to read file: {err}"));
            }
        }
    }

    if is_tracked {
        if let Ok(log_bytes) = git(
            &repo_dir,
            &[
                "log",
                "-n",
                "1",
                "--no-ext-diff",
                "-U3",
                "-p",
                "--",
                &clean_path,
            ],
        ) {
            let log_text = String::from_utf8_lossy(&log_bytes);
            if let Some(pos) = log_text.find("diff --git") {
                let diff_portion = &log_text[pos..];
                if !diff_portion.trim().is_empty() {
                    let header_info: Vec<&str> = log_text[..pos]
                        .lines()
                        .map(str::trim)
                        .filter(|l| !l.is_empty())
                        .collect();
                    let commit_banner = if let (Some(commit), Some(subject)) =
                        (header_info.first(), header_info.last())
                    {
                        format!("# Latest Commit: {commit} ({subject})\n# (No uncommitted working tree differences; showing latest commit changes)\n\n")
                    } else {
                        String::new()
                    };
                    return Ok(FileDiff {
                        path: clean_path,
                        diff: format!("{commit_banner}{diff_portion}"),
                        is_binary: false,
                    });
                }
            }
        }
    }

    Ok(FileDiff {
        path: clean_path,
        diff: "No differences found between HEAD and working copy.".into(),
        is_binary: false,
    })
}

fn session_edits(command: &str, cwd: &str, title: &str, pid: u32) -> Vec<AgentEdit> {
    let roots = artifacts::default_roots();
    let family = artifacts::pane_family(pid);
    let Some(kind) = artifacts::detect_cli(command, title, &family) else {
        return Vec::new();
    };
    let Some(path) = artifacts::select_transcript(kind, cwd, title, &family, &roots) else {
        return Vec::new();
    };
    // If transcript_full.jsonl exists, it contains the untruncated entries.
    // Read transcript_full.jsonl if present, or fallback to transcript.jsonl.
    // Do not concatenate both as that double-counts the same edits.
    let edits = if let Some(full) = jailed_sibling(&path, "transcript_full.jsonl") {
        edits_from_jsonl(&read_tail(&full, MAX_TRANSCRIPT))
    } else {
        edits_from_jsonl(&read_tail(&path, MAX_TRANSCRIPT))
    };
    dedupe_edits(edits)
}

fn build_change_graph(cwd: &Path, edits: &[AgentEdit]) -> ChangeGraph {
    if cwd.as_os_str().is_empty() {
        return ChangeGraph {
            repos: Vec::new(),
            edges: Vec::new(),
            truncated: false,
            error: None,
        };
    }
    let cwd_canon = std::path::absolute(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    let (primary, git_error) = match git_toplevel(&cwd_canon) {
        GitTop::Root(root) => (Some(root), None),
        GitTop::Outside => (None, None),
        GitTop::Unavailable(message) => (None, Some(message)),
    };

    let mut truncated = false;
    let mut rows: BTreeMap<(String, String), ChangedFile> = BTreeMap::new();
    let mut names: BTreeMap<String, String> = BTreeMap::new();

    if let Some(root) = &primary {
        let id = root_id(root);
        names.insert(id.clone(), repo_name(root));
        match dirty_files(root) {
            Ok(files) => {
                for (index, dirty) in files.into_iter().enumerate() {
                    if index >= MAX_FILES_PER_REPO || rows.len() >= MAX_FILES {
                        truncated = true;
                        break;
                    }
                    rows.insert(
                        (id.clone(), dirty.path.clone()),
                        ChangedFile {
                            path: dirty.path,
                            status: dirty.status.to_string(),
                            agent_edited: false,
                            lines_added: dirty.added,
                            lines_removed: dirty.removed,
                        },
                    );
                }
            }
            Err(message) => {
                return ChangeGraph {
                    repos: Vec::new(),
                    edges: Vec::new(),
                    truncated: false,
                    error: Some(message),
                };
            }
        }
    }

    for edit in edits {
        let Some(placed) = place_edit(&cwd_canon, primary.as_deref(), edit) else {
            continue;
        };
        if !names.contains_key(&placed.root_id) && names.len() >= MAX_REPOS {
            truncated = true;
            continue;
        }
        names
            .entry(placed.root_id.clone())
            .or_insert_with(|| repo_name(&placed.root));
        let key = (placed.root_id.clone(), placed.rel.clone());
        let (git_added, git_removed) = if let Some(path_str) = placed.root.to_str() {
            latest_commit_numstat(Path::new(path_str), &placed.rel).unwrap_or((0, 0))
        } else {
            (0, 0)
        };
        match rows.get_mut(&key) {
            Some(file) => {
                file.agent_edited = true;
                if file.lines_added == 0 && file.lines_removed == 0 {
                    if git_added > 0 || git_removed > 0 {
                        file.lines_added = git_added;
                        file.lines_removed = git_removed;
                    } else {
                        file.lines_added = edit.added;
                        file.lines_removed = edit.removed;
                    }
                }
                if edit.deleted && file.status != "deleted" {
                    file.status = "deleted".to_string();
                }
            }
            None => {
                if rows.len() >= MAX_FILES {
                    truncated = true;
                    continue;
                }
                let status = if edit.deleted { "deleted" } else { "edited" };
                let (lines_added, lines_removed) = if git_added > 0 || git_removed > 0 {
                    (git_added, git_removed)
                } else {
                    (edit.added, edit.removed)
                };
                rows.insert(
                    key,
                    ChangedFile {
                        path: placed.rel,
                        status: status.to_string(),
                        agent_edited: true,
                        lines_added,
                        lines_removed,
                    },
                );
            }
        }
    }

    let mut edges: Vec<RepoEdge> = Vec::new();
    let mut seen_edges: BTreeSet<(String, String, String)> = BTreeSet::new();
    let changed_roots: Vec<String> = names.keys().cloned().collect();
    let mut id_to_path: BTreeMap<String, PathBuf> = BTreeMap::new();
    if let Some(root) = &primary {
        id_to_path.insert(root_id(root), root.clone());
    }
    for edit in edits {
        if let Some(placed) = place_edit(&cwd_canon, primary.as_deref(), edit) {
            id_to_path.entry(placed.root_id).or_insert(placed.root);
        }
    }

    let mut identities: BTreeMap<String, Identity> = BTreeMap::new();
    for id in &changed_roots {
        if let Some(path) = id_to_path.get(id) {
            identities.insert(id.clone(), read_identity(path));
        }
    }

    for id in changed_roots {
        let Some(root) = id_to_path.get(&id).cloned() else {
            continue;
        };
        if !rows.keys().any(|(repo, _)| repo == &id) {
            continue;
        }
        for (label, raw_path, via) in manifest_deps(&root) {
            for target in expand_dep(&root, &raw_path) {
                let GitTop::Root(target_root) = git_toplevel(&target) else {
                    continue;
                };
                let target_id = root_id(&target_root);
                if target_id == id {
                    continue;
                }
                if !names.contains_key(&target_id) && names.len() >= MAX_REPOS {
                    truncated = true;
                    continue;
                }
                let edge_label = if raw_path.contains('*') {
                    repo_name(&target)
                } else {
                    label.clone()
                };
                names
                    .entry(target_id.clone())
                    .or_insert_with(|| repo_name(&target_root));
                id_to_path
                    .entry(target_id.clone())
                    .or_insert_with(|| target_root.clone());
                identities
                    .entry(target_id.clone())
                    .or_insert_with(|| read_identity(&target_root));
                push_edge(
                    &mut edges,
                    &mut seen_edges,
                    &id,
                    &target_id,
                    &edge_label,
                    via.to_string(),
                );
                ensure_anchor(&mut rows, &target_id, &edge_label, &mut truncated);
            }
        }
        let files: Vec<ChangedFile> = rows
            .iter()
            .filter(|((repo, _), file)| repo == &id && importable(file))
            .map(|(_, file)| file.clone())
            .collect();
        let extras = scan_imports(
            &root,
            &id,
            &files,
            &mut LinkMap {
                names: &mut names,
                paths: &mut id_to_path,
                identities: &mut identities,
                edges: &mut edges,
                seen: &mut seen_edges,
                truncated: &mut truncated,
            },
        );
        for extra in extras {
            let key = (extra.repo_id.clone(), extra.path.clone());
            if rows.contains_key(&key) {
                continue;
            }
            ensure_anchor(&mut rows, &extra.repo_id, &extra.path, &mut truncated);
            if extra.status == "referenced" {
                if let Some(file) = rows.get_mut(&key) {
                    file.status = "referenced".to_string();
                }
            }
        }
    }

    drop_library_when_real(&mut rows);

    let primary_id = primary.as_ref().map(|root| root_id(root));
    let mut repos = Vec::new();
    let mut ids: Vec<String> = names.keys().cloned().collect();
    ids.sort_by(|left, right| {
        let left_primary = primary_id.as_ref() == Some(left);
        let right_primary = primary_id.as_ref() == Some(right);
        right_primary
            .cmp(&left_primary)
            .then_with(|| names[left].cmp(&names[right]))
            .then(left.cmp(right))
    });
    for id in ids {
        let mut files: Vec<ChangedFile> = rows
            .iter()
            .filter(|((repo, _), _)| repo == &id)
            .map(|(_, file)| file.clone())
            .collect();
        if files.is_empty() {
            continue;
        }
        files.sort_by(|left, right| {
            file_rank(&left.status)
                .cmp(&file_rank(&right.status))
                .then(right.agent_edited.cmp(&left.agent_edited))
                .then(left.path.cmp(&right.path))
        });
        if files.len() > MAX_FILES_PER_REPO {
            files.truncate(MAX_FILES_PER_REPO);
            truncated = true;
        }
        repos.push(RepoCluster {
            name: names[&id].clone(),
            primary: primary_id.as_ref() == Some(&id),
            id,
            files,
        });
    }
    edges.sort_by(|left, right| {
        left.from_repo
            .cmp(&right.from_repo)
            .then(left.to_repo.cmp(&right.to_repo))
            .then(left.label.cmp(&right.label))
    });

    ChangeGraph {
        repos,
        edges,
        truncated,
        error: git_error,
    }
}

fn file_rank(status: &str) -> u8 {
    match status {
        "library" => 2,
        "referenced" => 1,
        _ => 0,
    }
}

struct PlacedEdit {
    root: PathBuf,
    root_id: String,
    rel: String,
}

struct ExtraNode {
    repo_id: String,
    path: String,
    status: &'static str,
}

struct LinkMap<'a> {
    names: &'a mut BTreeMap<String, String>,
    paths: &'a mut BTreeMap<String, PathBuf>,
    identities: &'a mut BTreeMap<String, Identity>,
    edges: &'a mut Vec<RepoEdge>,
    seen: &'a mut BTreeSet<(String, String, String)>,
    truncated: &'a mut bool,
}

fn place_edit(cwd: &Path, primary: Option<&Path>, edit: &AgentEdit) -> Option<PlacedEdit> {
    let raw = edit.path.trim().trim_matches(['"', '\'', '`']);
    if raw.is_empty() || raw.len() > 1024 || raw.contains('\0') || raw.contains('\n') {
        return None;
    }
    if raw.starts_with("http://") || raw.starts_with("https://") {
        return None;
    }
    let raw_path = Path::new(raw);
    let abs = if raw_path.is_absolute() {
        raw_path.to_path_buf()
    } else {
        cwd.join(raw_path)
    };
    let abs = normalize_lex(&abs);
    let probe = if abs.exists() {
        abs.clone()
    } else {
        abs.parent()?.to_path_buf()
    };
    let root = match git_toplevel(&probe) {
        GitTop::Root(root) => root,
        _ => {
            let cwd_abs = std::path::absolute(cwd).ok()?;
            if abs.starts_with(&cwd_abs) {
                primary.map(Path::to_path_buf).unwrap_or(cwd_abs)
            } else {
                return None;
            }
        }
    };
    let rel = relative_to(&root, &abs)?;
    Some(PlacedEdit {
        root_id: root_id(&root),
        root,
        rel,
    })
}

fn relative_to(root: &Path, abs: &Path) -> Option<String> {
    let root_canon = root.canonicalize().unwrap_or_else(|_| normalize_lex(root));
    if let Ok(canon) = abs.canonicalize() {
        let rel = canon.strip_prefix(&root_canon).ok()?;
        return clean_rel(rel);
    }
    let abs_norm = normalize_lex(abs);
    let root_norm = normalize_lex(&root_canon);
    let rel = abs_norm.strip_prefix(&root_norm).ok()?;
    clean_rel(rel)
}

fn clean_rel(rel: &Path) -> Option<String> {
    if rel.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return None;
    }
    let text = rel.to_string_lossy().replace('\\', "/");
    if text.is_empty() || text.contains('\0') {
        return None;
    }
    Some(text)
}

fn normalize_lex(path: &Path) -> PathBuf {
    let absolute = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let mut out = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn root_id(root: &Path) -> String {
    root.to_string_lossy().replace('\\', "/")
}

fn repo_name(root: &Path) -> String {
    root.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| root_id(root))
}

fn ensure_anchor(
    rows: &mut BTreeMap<(String, String), ChangedFile>,
    repo: &str,
    label: &str,
    truncated: &mut bool,
) {
    if label.is_empty() || rows.keys().any(|(id, path)| id == repo && path == label) {
        return;
    }
    if rows.len() >= MAX_FILES {
        *truncated = true;
        return;
    }
    rows.insert(
        (repo.to_string(), label.to_string()),
        ChangedFile {
            path: label.to_string(),
            status: "library".to_string(),
            agent_edited: false,
            lines_added: 0,
            lines_removed: 0,
        },
    );
}

fn drop_library_when_real(rows: &mut BTreeMap<(String, String), ChangedFile>) {
    let mut drop_keys = Vec::new();
    let repos: BTreeSet<String> = rows.keys().map(|(repo, _)| repo.clone()).collect();
    for repo in repos {
        let has_real = rows
            .iter()
            .any(|((id, _), file)| id == &repo && file.status != "library");
        if !has_real {
            continue;
        }
        for (key, file) in rows.iter() {
            if key.0 == repo && file.status == "library" {
                drop_keys.push(key.clone());
            }
        }
    }
    for key in drop_keys {
        rows.remove(&key);
    }
}

fn push_edge(
    edges: &mut Vec<RepoEdge>,
    seen: &mut BTreeSet<(String, String, String)>,
    from: &str,
    to: &str,
    label: &str,
    via: String,
) {
    if from == to || label.is_empty() {
        return;
    }
    let key = (from.to_string(), to.to_string(), label.to_string());
    if !seen.insert(key) {
        return;
    }
    if edges.len() >= 48 {
        return;
    }
    edges.push(RepoEdge {
        from_repo: from.to_string(),
        to_repo: to.to_string(),
        label: label.to_string(),
        via,
    });
}

fn dirty_files(root: &Path) -> Result<Vec<Dirty>, String> {
    let status = git(
        root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    let numstat =
        git(root, &["diff", "--no-ext-diff", "--numstat", "-z", "HEAD"]).unwrap_or_default();
    let counts = parse_numstat(&numstat);
    let mut files = parse_porcelain(&status);
    for file in &mut files {
        if let Some((added, removed)) = counts.get(&file.path) {
            file.added = *added;
            file.removed = *removed;
        } else if file.status == "untracked" || file.status == "added" {
            file.added = count_text_lines(root, &file.path);
        }
    }
    Ok(files)
}

fn count_text_lines(root: &Path, rel: &str) -> u64 {
    let Some(path) = rooted_file(root, rel) else {
        return 0;
    };
    let Ok(meta) = path.metadata() else {
        return 0;
    };
    if !meta.is_file() || meta.len() > 256 * 1024 {
        return 0;
    }
    let Ok(file) = File::open(path) else {
        return 0;
    };
    let mut buf = Vec::new();
    if file.take(256 * 1024).read_to_end(&mut buf).is_err() {
        return 0;
    }
    if buf.contains(&0) {
        return 0;
    }
    let text = String::from_utf8_lossy(&buf);
    if text.is_empty() {
        0
    } else {
        text.lines().count() as u64
    }
}

fn rooted_file(root: &Path, rel: &str) -> Option<PathBuf> {
    if rel.is_empty() || rel.contains('\0') {
        return None;
    }
    let rel_path = Path::new(rel);
    if rel_path.is_absolute()
        || rel_path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return None;
    }
    let joined = root.join(rel_path);
    let canon = joined.canonicalize().ok()?;
    let root_canon = root.canonicalize().ok()?;
    canon.starts_with(&root_canon).then_some(canon)
}

/// `git status --porcelain=v1 -z`: `XY PATH\0`, and for a rename
/// `XY NEW\0OLD\0`. The first path is the path git is showing now.
fn parse_porcelain(bytes: &[u8]) -> Vec<Dirty> {
    let mut files = Vec::new();
    let mut rest = bytes;
    while rest.len() >= 4 {
        let x = rest[0] as char;
        let y = rest[1] as char;
        if rest[2] != b' ' {
            break;
        }
        rest = &rest[3..];
        let Some((path, next)) = split_nul(rest) else {
            break;
        };
        rest = next;
        let mut path = path.to_string();
        if x == 'R' || x == 'C' || y == 'R' || y == 'C' {
            let Some((_old, next)) = split_nul(rest) else {
                break;
            };
            rest = next;
        }
        if path.is_empty() || path.contains('\0') {
            continue;
        }
        path = path.replace('\\', "/");
        let status = porcelain_status(x, y);
        if status.is_empty() {
            continue;
        }
        if skip_noise(&path) {
            continue;
        }
        files.push(Dirty {
            path,
            status,
            added: 0,
            removed: 0,
        });
    }
    files
}

fn porcelain_status(x: char, y: char) -> &'static str {
    if x == '!' || y == '!' {
        return "";
    }
    if x == '?' || y == '?' {
        return "untracked";
    }
    if x == 'R' || y == 'R' || x == 'C' || y == 'C' {
        return "renamed";
    }
    if x == 'D' || y == 'D' {
        return "deleted";
    }
    if x == 'A' || y == 'A' {
        return "added";
    }
    if x == ' ' && y == ' ' {
        return "";
    }
    "modified"
}

fn skip_noise(path: &str) -> bool {
    path == ".git"
        || path.starts_with(".git/")
        || path.starts_with("node_modules/")
        || path.starts_with("target/")
        || path.starts_with("dist/")
}

fn split_nul(bytes: &[u8]) -> Option<(String, &[u8])> {
    let end = bytes.iter().position(|byte| *byte == 0)?;
    let text = String::from_utf8_lossy(&bytes[..end]).into_owned();
    Some((text, &bytes[end + 1..]))
}

/// `git diff --numstat -z`. A rename is `added\tremoved\t\0old\0new\0`.
fn parse_numstat(bytes: &[u8]) -> BTreeMap<String, (u64, u64)> {
    let mut out = BTreeMap::new();
    let mut rest = bytes;
    while !rest.is_empty() {
        let Some((added, next)) = split_tab(rest) else {
            break;
        };
        let Some((removed, next)) = split_tab(next) else {
            break;
        };
        rest = next;
        let path = if rest.first() == Some(&0) {
            rest = &rest[1..];
            let Some((_old, next)) = split_nul(rest) else {
                break;
            };
            let Some((new_path, next)) = split_nul(next) else {
                break;
            };
            rest = next;
            new_path
        } else {
            let Some((path, next)) = split_nul(rest) else {
                break;
            };
            rest = next;
            path
        };
        if path.is_empty() {
            continue;
        }
        out.insert(
            path.replace('\\', "/"),
            (parse_count(&added), parse_count(&removed)),
        );
    }
    out
}

fn split_tab(bytes: &[u8]) -> Option<(String, &[u8])> {
    let end = bytes.iter().position(|byte| *byte == b'\t')?;
    let text = String::from_utf8_lossy(&bytes[..end]).into_owned();
    Some((text, &bytes[end + 1..]))
}

fn parse_count(text: &str) -> u64 {
    text.parse().unwrap_or(0)
}

fn git_args_allowed(args: &[&str]) -> bool {
    matches!(
        args,
        ["rev-parse", "--show-toplevel"]
            | ["status", "--porcelain=v1", "-z", "--untracked-files=all"]
            | ["diff", "--no-ext-diff", "--numstat", "-z", "HEAD"]
    ) || (args.len() == 6
        && args[0] == "diff"
        && args[1] == "--no-ext-diff"
        && args[2] == "-U3"
        && args[3] == "HEAD"
        && args[4] == "--"
        && !args[5].starts_with('-'))
        || (args.len() == 4
            && args[0] == "ls-files"
            && args[1] == "--error-unmatch"
            && args[2] == "--"
            && !args[3].starts_with('-'))
        || (args.len() == 8
            && args[0] == "log"
            && args[1] == "-n"
            && args[2] == "1"
            && args[3] == "--no-ext-diff"
            && args[4] == "-U3"
            && args[5] == "-p"
            && args[6] == "--"
            && !args[7].starts_with('-'))
        || (args.len() == 8
            && args[0] == "log"
            && args[1] == "-n"
            && args[2] == "1"
            && args[3] == "--format="
            && args[4] == "--numstat"
            && args[5] == "-z"
            && args[6] == "--"
            && !args[7].starts_with('-'))
}

fn latest_commit_numstat(root: &Path, rel: &str) -> Option<(u64, u64)> {
    let clean = rel.trim().trim_matches(['"', '\'', '`']);
    if clean.is_empty() || clean.starts_with('-') || clean.contains('\0') {
        return None;
    }
    let bytes = git(
        root,
        &[
            "log",
            "-n",
            "1",
            "--format=",
            "--numstat",
            "-z",
            "--",
            clean,
        ],
    )
    .ok()?;
    let counts = parse_numstat(&bytes);
    counts.get(&clean.replace('\\', "/")).copied()
}

fn git(dir: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    if !git_args_allowed(args) {
        return Err("git command is not read-only".into());
    }
    if dir.as_os_str().is_empty() {
        return Err("missing git directory".into());
    }
    let mut child = Command::new("git")
        .arg("-C")
        .arg(dir)
        .arg("--no-pager")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GCM_INTERACTIVE", "never")
        .spawn()
        .map_err(|_| "git is not available".to_string())?;
    let stdout = child.stdout.take().ok_or("git stdout")?;
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.take(2 * 1024 * 1024).read_to_end(&mut buf);
        buf
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() > GIT_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return Err("git timed out".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(15)),
            Err(err) => return Err(err.to_string()),
        }
    };
    let buf = reader.join().unwrap_or_default();
    if status.success() {
        Ok(buf)
    } else {
        Err(format!("git exited {status}"))
    }
}

fn git_toplevel(path: &Path) -> GitTop {
    let dir = if path.is_dir() {
        path.to_path_buf()
    } else {
        match path.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => parent.to_path_buf(),
            _ => return GitTop::Outside,
        }
    };
    if !dir.exists() {
        return GitTop::Outside;
    }
    match git(&dir, &["rev-parse", "--show-toplevel"]) {
        Ok(bytes) => {
            let text = String::from_utf8_lossy(&bytes).trim().to_string();
            if text.is_empty() {
                return GitTop::Outside;
            }
            let root = PathBuf::from(text);
            GitTop::Root(root.canonicalize().unwrap_or(root))
        }
        Err(message) if message == "git is not available" || message == "git timed out" => {
            GitTop::Unavailable(message)
        }
        Err(_) => GitTop::Outside,
    }
}

fn manifest_deps(root: &Path) -> Vec<(String, String, &'static str)> {
    let mut deps = Vec::new();
    if let Some(text) = read_limited(&root.join("Cargo.toml"), MAX_MANIFEST) {
        for (name, path) in cargo_path_deps(&text) {
            deps.push((name, path, "Cargo.toml"));
        }
    }
    if let Some(text) = read_limited(&root.join("package.json"), MAX_MANIFEST) {
        for (name, path) in npm_path_deps(&text) {
            deps.push((name, path, "package.json"));
        }
    }
    if let Some(text) = read_limited(&root.join("go.mod"), MAX_MANIFEST) {
        for (name, path) in go_replace_deps(&text) {
            deps.push((name, path, "go.mod"));
        }
    }
    if let Some(text) = read_limited(&root.join("pyproject.toml"), MAX_MANIFEST) {
        for (name, path) in py_path_deps(&text) {
            deps.push((name, path, "pyproject.toml"));
        }
    }
    deps
}

fn read_identity(root: &Path) -> Identity {
    let mut identity = Identity::default();
    if let Some(text) = read_limited(&root.join("Cargo.toml"), MAX_MANIFEST) {
        if let Some(name) = cargo_package_name(&text) {
            identity.cargo.push(name);
        }
    }
    if let Some(text) = read_limited(&root.join("package.json"), MAX_MANIFEST) {
        if let Some(name) = npm_package_name(&text) {
            identity.npm.push(name);
        }
    }
    if let Some(text) = read_limited(&root.join("go.mod"), MAX_MANIFEST) {
        identity.go_module = go_module_name(&text);
    }
    if let Some(text) = read_limited(&root.join("pyproject.toml"), MAX_MANIFEST) {
        if let Some(name) = py_project_name(&text) {
            identity.python.push(name);
        }
    }
    identity
}

fn expand_dep(root: &Path, raw: &str) -> Vec<PathBuf> {
    let raw = raw.trim().trim_matches('"');
    if raw.is_empty() || raw.contains('\0') {
        return Vec::new();
    }
    if let Some(prefix) = raw.strip_suffix("/*").or_else(|| raw.strip_suffix("\\*")) {
        if prefix.contains('*') {
            return Vec::new();
        }
        let Some(dir) = resolve_dir(root, prefix) else {
            return Vec::new();
        };
        let Ok(entries) = std::fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for entry in entries.flatten() {
            if out.len() >= 32 {
                break;
            }
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || name == "node_modules" || name == "target" {
                continue;
            }
            out.push(path);
        }
        return out;
    }
    resolve_dir(root, raw).into_iter().collect()
}

fn resolve_dir(root: &Path, raw: &str) -> Option<PathBuf> {
    let path = Path::new(raw.trim());
    if path.as_os_str().is_empty() {
        return None;
    }
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    let canon = joined.canonicalize().ok()?;
    if !canon.is_dir() || canon.parent().is_none() {
        return None;
    }
    Some(canon)
}

fn scan_imports(
    root: &Path,
    repo_id: &str,
    files: &[ChangedFile],
    links: &mut LinkMap<'_>,
) -> Vec<ExtraNode> {
    let mut extras: Vec<ExtraNode> = Vec::new();
    let mut scanned = 0;
    for file in files {
        if scanned >= MAX_IMPORT_FILES {
            break;
        }
        let Some(lang) = source_kind(&file.path) else {
            continue;
        };
        let Some(absolute) = rooted_file(root, &file.path) else {
            continue;
        };
        let Some(text) = read_limited(&absolute, MAX_TEXT) else {
            continue;
        };
        scanned += 1;
        let specs = match lang {
            Lang::Rust => rust_imports(&text),
            Lang::Js => js_imports(&text),
            Lang::Py => py_imports(&text),
            Lang::Go => go_imports(&text),
        };
        for spec in specs {
            if spec.starts_with("./") || spec.starts_with("../") {
                if let Some(extra) =
                    link_relative(root, repo_id, &file.path, &absolute, &spec, links)
                {
                    let referenced = extras
                        .iter()
                        .filter(|node| node.repo_id == extra.repo_id && node.status == "referenced")
                        .count();
                    if referenced < MAX_REFERENCED {
                        extras.push(extra);
                    }
                }
            } else {
                link_package(
                    repo_id,
                    &file.path,
                    &spec,
                    lang,
                    links.identities,
                    links.edges,
                    links.seen,
                );
            }
        }
    }
    extras
}

fn importable(file: &ChangedFile) -> bool {
    !matches!(file.status.as_str(), "deleted" | "library" | "referenced")
}

fn source_kind(path: &str) -> Option<Lang> {
    let ext = path.rsplit('.').next()?.to_ascii_lowercase();
    match ext.as_str() {
        "rs" => Some(Lang::Rust),
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => Some(Lang::Js),
        "py" => Some(Lang::Py),
        "go" => Some(Lang::Go),
        _ => None,
    }
}

fn link_package(
    from: &str,
    via: &str,
    spec: &str,
    lang: Lang,
    identities: &BTreeMap<String, Identity>,
    edges: &mut Vec<RepoEdge>,
    seen: &mut BTreeSet<(String, String, String)>,
) {
    for (repo, identity) in identities {
        if repo == from {
            continue;
        }
        let label = match lang {
            Lang::Rust => identity
                .cargo
                .iter()
                .find(|name| crate_key(name) == crate_key(spec))
                .cloned(),
            Lang::Js => identity
                .npm
                .iter()
                .find(|name| js_package_matches(spec, name))
                .cloned(),
            Lang::Py => identity
                .python
                .iter()
                .find(|name| crate_key(name) == crate_key(spec.split('.').next().unwrap_or(spec)))
                .cloned(),
            Lang::Go => identity
                .go_module
                .as_ref()
                .and_then(|module| go_module_matches(spec, module).then(|| module.clone())),
        };
        if let Some(label) = label {
            push_edge(edges, seen, from, repo, &label, via.to_string());
        }
    }
}

fn link_relative(
    from_root: &Path,
    from: &str,
    via: &str,
    from_file: &Path,
    spec: &str,
    links: &mut LinkMap<'_>,
) -> Option<ExtraNode> {
    if spec.contains("node_modules") || spec.contains('\0') {
        return None;
    }
    let resolved = resolve_relative(from_file, spec)?;
    let GitTop::Root(target_root) = git_toplevel(&resolved) else {
        return None;
    };
    if target_root == from_root {
        return None;
    }
    let target_id = root_id(&target_root);
    if target_id == from {
        return None;
    }
    if !links.names.contains_key(&target_id) && links.names.len() >= MAX_REPOS {
        *links.truncated = true;
        return None;
    }
    links
        .names
        .entry(target_id.clone())
        .or_insert_with(|| repo_name(&target_root));
    links
        .paths
        .entry(target_id.clone())
        .or_insert_with(|| target_root.clone());
    links
        .identities
        .entry(target_id.clone())
        .or_insert_with(|| read_identity(&target_root));
    push_edge(
        links.edges,
        links.seen,
        from,
        &target_id,
        spec,
        via.to_string(),
    );
    match relative_to(&target_root, &resolved) {
        Some(rel) => Some(ExtraNode {
            repo_id: target_id,
            path: rel,
            status: "referenced",
        }),
        None => Some(ExtraNode {
            repo_id: target_id,
            path: repo_name(&target_root),
            status: "library",
        }),
    }
}

fn resolve_relative(from_file: &Path, spec: &str) -> Option<PathBuf> {
    let spec = spec.split(['?', '#']).next().unwrap_or(spec);
    if !(spec.starts_with("./") || spec.starts_with("../")) {
        return None;
    }
    let parent = from_file.parent()?;
    let joined = parent.join(spec);
    let mut candidates = vec![joined.clone()];
    for ext in ["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go"] {
        candidates.push(joined.with_extension(ext));
    }
    for name in ["index.ts", "index.tsx", "index.js", "mod.rs", "lib.rs"] {
        candidates.push(joined.join(name));
    }
    for candidate in candidates {
        if candidate.is_file() {
            return candidate.canonicalize().ok();
        }
    }
    let mut cursor = joined;
    for _ in 0..8 {
        if cursor.exists() {
            return cursor.canonicalize().ok();
        }
        cursor = cursor.parent()?.to_path_buf();
    }
    None
}

fn cargo_path_deps(text: &str) -> Vec<(String, String)> {
    let Ok(value) = text.parse::<toml::Value>() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if let toml::Value::Table(table) = value {
        walk_cargo(&table, &mut out);
    }
    out
}

fn walk_cargo(table: &toml::map::Map<String, toml::Value>, out: &mut Vec<(String, String)>) {
    for (key, value) in table {
        if is_dep_table(key) {
            collect_dep_table(value, out);
        } else if key == "target" || key == "patch" {
            if let Some(inner) = value.as_table() {
                for child in inner.values() {
                    if let Some(child) = child.as_table() {
                        walk_cargo(child, out);
                    }
                }
            }
        } else if key == "workspace" {
            if let Some(workspace) = value.as_table() {
                if let Some(members) = workspace.get("members").and_then(toml::Value::as_array) {
                    for member in members {
                        if let Some(path) = member.as_str() {
                            if looks_like_path(path) {
                                let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
                                out.push((name.to_string(), path.to_string()));
                            }
                        }
                    }
                }
                walk_cargo(workspace, out);
            }
        }
    }
}

fn is_dep_table(key: &str) -> bool {
    matches!(
        key,
        "dependencies"
            | "dev-dependencies"
            | "build-dependencies"
            | "dev_dependencies"
            | "build_dependencies"
    )
}

fn collect_dep_table(value: &toml::Value, out: &mut Vec<(String, String)>) {
    let Some(table) = value.as_table() else {
        return;
    };
    for (name, spec) in table {
        if let Some(path) = spec
            .as_table()
            .and_then(|table| table.get("path"))
            .and_then(toml::Value::as_str)
        {
            if !path.is_empty() {
                out.push((name.clone(), path.to_string()));
            }
        }
    }
}

fn looks_like_path(path: &str) -> bool {
    path.starts_with('.') || path.starts_with('/') || path.contains('/') || path.contains('\\')
}

fn npm_path_deps(text: &str) -> Vec<(String, String)> {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for key in [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
    ] {
        let Some(map) = value.get(key).and_then(Value::as_object) else {
            continue;
        };
        for (name, spec) in map {
            let Some(spec) = spec.as_str() else {
                continue;
            };
            if let Some(path) = file_dep_path(spec) {
                out.push((name.clone(), path));
            }
        }
    }
    let list = value.get("workspaces").and_then(|workspaces| {
        workspaces
            .as_array()
            .or_else(|| workspaces.get("packages")?.as_array())
    });
    if let Some(list) = list {
        for item in list {
            let Some(path) = item.as_str() else {
                continue;
            };
            if looks_like_path(path) {
                let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
                out.push((name.to_string(), path.to_string()));
            }
        }
    }
    out
}

fn file_dep_path(spec: &str) -> Option<String> {
    let path = spec
        .strip_prefix("file:")
        .or_else(|| spec.strip_prefix("link:"))?
        .trim();
    if path.is_empty() {
        None
    } else {
        Some(path.to_string())
    }
}

fn go_replace_deps(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut in_block = false;
    for raw in text.lines() {
        let line = strip_go_comment(raw).trim().to_string();
        if line.is_empty() {
            continue;
        }
        if line.starts_with("replace (") {
            in_block = true;
            continue;
        }
        if in_block {
            if line.starts_with(')') {
                in_block = false;
            } else if let Some(pair) = parse_replace(&line) {
                out.push(pair);
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("replace ") {
            if let Some(pair) = parse_replace(rest) {
                out.push(pair);
            }
        }
    }
    out
}

fn parse_replace(line: &str) -> Option<(String, String)> {
    let (left, right) = line.split_once("=>")?;
    let name = left.split_whitespace().next()?.trim().to_string();
    let path = right.split_whitespace().next()?.trim();
    if path.starts_with('.') || path.starts_with('/') || path.starts_with('\\') {
        Some((name, path.to_string()))
    } else {
        None
    }
}

fn strip_go_comment(line: &str) -> &str {
    line.split("//").next().unwrap_or(line)
}

fn py_path_deps(text: &str) -> Vec<(String, String)> {
    let Ok(value) = text.parse::<toml::Value>() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if let toml::Value::Table(table) = value {
        walk_py(&table, &mut out);
    }
    out
}

fn walk_py(table: &toml::map::Map<String, toml::Value>, out: &mut Vec<(String, String)>) {
    for (key, value) in table {
        if key == "dependencies" || key == "dev-dependencies" || key == "sources" {
            collect_py(value, out);
        } else if let Some(child) = value.as_table() {
            walk_py(child, out);
        }
    }
}

fn collect_py(value: &toml::Value, out: &mut Vec<(String, String)>) {
    if let Some(table) = value.as_table() {
        for (name, spec) in table {
            if let Some(path) = spec
                .as_table()
                .and_then(|table| table.get("path"))
                .and_then(toml::Value::as_str)
            {
                if !path.is_empty() {
                    out.push((name.clone(), path.to_string()));
                }
            }
        }
        return;
    }
    let Some(items) = value.as_array() else {
        return;
    };
    for item in items {
        let Some(text) = item.as_str() else {
            continue;
        };
        if let Some(path) = text.split("file://").nth(1) {
            let path = path.split_whitespace().next().unwrap_or(path);
            let name = text.split([' ', '@', '[']).next().unwrap_or(text).trim();
            if !name.is_empty() && !path.is_empty() {
                out.push((name.to_string(), path.to_string()));
            }
        }
    }
}

fn cargo_package_name(text: &str) -> Option<String> {
    let value = text.parse::<toml::Value>().ok()?;
    value
        .get("package")?
        .get("name")?
        .as_str()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
}

fn npm_package_name(text: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(text).ok()?;
    value
        .get("name")?
        .as_str()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
}

fn go_module_name(text: &str) -> Option<String> {
    for raw in text.lines() {
        let line = strip_go_comment(raw).trim();
        let Some(rest) = line.strip_prefix("module ") else {
            continue;
        };
        let name = rest.split_whitespace().next().unwrap_or("").trim();
        if !name.is_empty() {
            return Some(name.to_string());
        }
    }
    None
}

fn py_project_name(text: &str) -> Option<String> {
    let value = text.parse::<toml::Value>().ok()?;
    value
        .get("project")
        .and_then(|project| project.get("name"))
        .and_then(toml::Value::as_str)
        .or_else(|| value.get("tool")?.get("poetry")?.get("name")?.as_str())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
}

fn rust_imports(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.split("//").next().unwrap_or("").trim();
        let rest = line
            .strip_prefix("pub use ")
            .or_else(|| line.strip_prefix("use "))
            .or_else(|| line.strip_prefix("extern crate "));
        let Some(rest) = rest else {
            continue;
        };
        let rest = rest.trim();
        if rest.starts_with("crate::") || rest.starts_with("super::") || rest.starts_with("self::")
        {
            continue;
        }
        let name: String = rest
            .chars()
            .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '_')
            .collect();
        if !name.is_empty() {
            push_unique(&mut out, name);
        }
    }
    out
}

fn js_imports(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for marker in [
        "from \"",
        "from '",
        "require(\"",
        "require('",
        "import(\"",
        "import('",
    ] {
        let mut rest = text;
        while let Some(index) = rest.find(marker) {
            let after = &rest[index + marker.len()..];
            let quote = if marker.ends_with('"') { '"' } else { '\'' };
            if let Some(end) = after.find(quote) {
                let spec = after[..end].trim();
                if !spec.is_empty() && spec.len() < 300 {
                    push_unique(&mut out, spec.to_string());
                }
            }
            rest = &rest[index + marker.len()..];
        }
    }
    out
}

fn py_imports(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.split('#').next().unwrap_or("").trim();
        if let Some(rest) = line.strip_prefix("import ") {
            for part in rest.split(',') {
                let name = part.split_whitespace().next().unwrap_or("");
                let root = name.split('.').next().unwrap_or("");
                if is_ident(root) {
                    push_unique(&mut out, root.to_string());
                }
            }
        } else if let Some(rest) = line.strip_prefix("from ") {
            let name = rest.split_whitespace().next().unwrap_or("");
            if name.starts_with('.') {
                continue;
            }
            let root = name.split('.').next().unwrap_or("");
            if is_ident(root) {
                push_unique(&mut out, root.to_string());
            }
        }
    }
    out
}

fn go_imports(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut in_block = false;
    for raw in text.lines() {
        let line = strip_go_comment(raw).trim();
        if line.starts_with("import (") {
            in_block = true;
            continue;
        }
        if in_block && line.starts_with(')') {
            in_block = false;
            continue;
        }
        if in_block || line.starts_with("import ") {
            if let Some(spec) = quoted_path(line) {
                push_unique(&mut out, spec);
            }
        }
    }
    out
}

fn quoted_path(line: &str) -> Option<String> {
    let start = line.find('"')?;
    let rest = &line[start + 1..];
    let end = rest.find('"')?;
    let spec = rest[..end].trim();
    if spec.is_empty() {
        None
    } else {
        Some(spec.to_string())
    }
}

fn is_ident(text: &str) -> bool {
    let mut chars = text.chars();
    match chars.next() {
        Some(ch) if ch == '_' || ch.is_ascii_alphabetic() => {}
        _ => return false,
    }
    chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
}

fn crate_key(name: &str) -> String {
    name.chars()
        .map(|ch| match ch {
            '-' => '_',
            other => other.to_ascii_lowercase(),
        })
        .collect()
}

fn js_package_matches(spec: &str, name: &str) -> bool {
    spec == name || spec.starts_with(&format!("{name}/"))
}

fn go_module_matches(spec: &str, module: &str) -> bool {
    spec == module || spec.starts_with(&format!("{module}/"))
}

fn push_unique(out: &mut Vec<String>, value: String) {
    if !out.iter().any(|existing| existing == &value) {
        out.push(value);
    }
}

fn edits_from_jsonl(text: &str) -> Vec<AgentEdit> {
    let mut edits = Vec::new();
    for line in text.split('\n') {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        collect_edits(&value, &mut edits);
    }
    dedupe_edits(edits)
}

fn dedupe_edits(edits: Vec<AgentEdit>) -> Vec<AgentEdit> {
    let mut map: BTreeMap<String, AgentEdit> = BTreeMap::new();
    for edit in edits {
        match map.get_mut(&edit.path) {
            Some(existing) => {
                existing.added = existing.added.saturating_add(edit.added);
                existing.removed = existing.removed.saturating_add(edit.removed);
                existing.deleted = existing.deleted || edit.deleted;
            }
            None => {
                map.insert(edit.path.clone(), edit);
            }
        }
    }
    map.into_values().collect()
}

fn collect_edits(value: &Value, edits: &mut Vec<AgentEdit>) {
    let Some(obj) = value.as_object() else {
        return;
    };
    if let Some(calls) = obj.get("tool_calls").and_then(Value::as_array) {
        for call in calls {
            let name = call.get("name").and_then(Value::as_str).unwrap_or("");
            record_tool(name, artifacts::tool_args(call), edits);
        }
    }
    if let Some(blocks) = obj
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
    {
        for block in blocks {
            if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                continue;
            }
            let name = block.get("name").and_then(Value::as_str).unwrap_or("");
            let input = block.get("input").unwrap_or(&Value::Null);
            record_tool(name, input, edits);
        }
    }
}

fn record_tool(name: &str, args: &Value, edits: &mut Vec<AgentEdit>) {
    let name = name.to_ascii_lowercase();
    if !is_mutating(&name) {
        return;
    }
    let args = coerce_object(args);
    let deleted = name == "delete_file";
    let mut paths = path_fields(&args);
    if paths.is_empty() && (name == "patch" || name == "apply_patch") {
        let patch = str_field(&args, &["patch", "diff"]);
        paths.extend(patch_paths(&patch));
    }
    let (added, removed) = line_delta(&name, &args);
    for path in paths {
        edits.push(AgentEdit {
            path,
            added,
            removed,
            deleted,
        });
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

fn coerce_object(args: &Value) -> Value {
    match args {
        Value::String(text) => serde_json::from_str(text.trim()).unwrap_or(Value::Null),
        other => other.clone(),
    }
}

fn path_fields(args: &Value) -> Vec<String> {
    let Some(map) = args.as_object() else {
        return Vec::new();
    };
    for key in [
        "file_path",
        "target_file",
        "path",
        "absolute_path",
        "AbsolutePath",
        "TargetFile",
        "notebook_path",
        "filePath",
        "targetFile",
    ] {
        if let Some(value) = map.get(key).and_then(Value::as_str) {
            let value = value.trim().trim_matches(['"', '\'', '`']);
            if !value.is_empty() {
                return vec![value.to_string()];
            }
        }
    }
    Vec::new()
}

fn str_field(args: &Value, keys: &[&str]) -> String {
    let Some(map) = args.as_object() else {
        return String::new();
    };
    for key in keys {
        if let Some(value) = map.get(*key).and_then(Value::as_str) {
            return value.to_string();
        }
    }
    String::new()
}

fn line_delta(name: &str, args: &Value) -> (u64, u64) {
    match name {
        "write" | "write_file" | "write_to_file" | "create_file" => {
            let content = str_field(
                args,
                &[
                    "content",
                    "CodeContent",
                    "code_content",
                    "file_text",
                    "text",
                    "contents",
                ],
            );
            (count_lines(&content), 0)
        }
        "edit"
        | "edit_file"
        | "str_replace"
        | "str_replace_editor"
        | "search_replace"
        | "replace_file_content"
        | "notebook_edit"
        | "multiedit"
        | "multi_edit" => {
            let old = str_field(
                args,
                &["old_string", "old_str", "TargetContent", "target_content"],
            );
            let new = str_field(
                args,
                &[
                    "new_string",
                    "new_str",
                    "ReplacementContent",
                    "replacement_content",
                    "contents",
                ],
            );
            (count_lines(&new), count_lines(&old))
        }
        "patch" | "apply_patch" => {
            let patch = str_field(args, &["patch", "diff"]);
            let mut added = 0;
            let mut removed = 0;
            for line in patch.lines() {
                if line.starts_with('+') && !line.starts_with("+++") {
                    added += 1;
                } else if line.starts_with('-') && !line.starts_with("---") {
                    removed += 1;
                }
            }
            (added, removed)
        }
        _ => (0, 0),
    }
}

fn count_lines(text: &str) -> u64 {
    if text.is_empty() {
        0
    } else {
        text.lines().count() as u64
    }
}

fn patch_paths(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        for prefix in [
            "*** Update File: ",
            "*** Add File: ",
            "*** Delete File: ",
            "*** Move to: ",
        ] {
            if let Some(path) = line.strip_prefix(prefix) {
                let path = path.trim();
                if !path.is_empty() {
                    push_unique(&mut out, path.to_string());
                }
            }
        }
        if let Some(rest) = line.strip_prefix("diff --git ") {
            if let Some((_, new_path)) = rest.split_once(" b/") {
                let new_path = new_path.trim();
                if !new_path.is_empty() {
                    push_unique(&mut out, new_path.to_string());
                }
            }
        }
    }
    out
}

fn read_limited(path: &Path, max: u64) -> Option<String> {
    let file = File::open(path).ok()?;
    let mut buf = Vec::new();
    file.take(max).read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

fn read_tail(path: &Path, max: u64) -> String {
    let Ok(mut file) = File::open(path) else {
        return String::new();
    };
    let Ok(meta) = file.metadata() else {
        return String::new();
    };
    let len = meta.len();
    let start = len.saturating_sub(max);
    if file.seek_read_at(start).is_err() {
        return String::new();
    }
    let mut buf = Vec::new();
    if file
        .take(max.saturating_add(8))
        .read_to_end(&mut buf)
        .is_err()
    {
        return String::new();
    }
    if start > 0 {
        if let Some(index) = buf.iter().position(|byte| *byte == b'\n') {
            buf.drain(..=index);
        }
    }
    String::from_utf8_lossy(&buf).into_owned()
}

trait SeekReadAt {
    fn seek_read_at(&mut self, start: u64) -> std::io::Result<()>;
}

impl SeekReadAt for File {
    fn seek_read_at(&mut self, start: u64) -> std::io::Result<()> {
        use std::io::Seek;
        self.seek(std::io::SeekFrom::Start(start))?;
        Ok(())
    }
}

fn jailed_sibling(transcript: &Path, name: &str) -> Option<PathBuf> {
    let parent = transcript.parent()?.canonicalize().ok()?;
    let file = parent.join(name).canonicalize().ok()?;
    file.starts_with(&parent).then_some(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command as Proc;

    #[test]
    fn porcelain_keeps_the_new_rename_path_and_spaces() {
        let bytes = b"R  new name.txt\0old.txt\0 M src/lib.rs\0?? un tracked.txt\0";
        let files = parse_porcelain(bytes);
        assert_eq!(files.len(), 3, "{files:?}");
        assert_eq!(files[0].path, "new name.txt");
        assert_eq!(files[0].status, "renamed");
        assert_eq!(files[1].path, "src/lib.rs");
        assert_eq!(files[1].status, "modified");
        assert_eq!(files[2].path, "un tracked.txt");
        assert_eq!(files[2].status, "untracked");
    }

    #[test]
    fn numstat_pairs_renames_with_the_new_path() {
        let bytes = b"0\t0\t\0old.txt\0new name.txt\01\t1\tsrc/lib.rs\0";
        let counts = parse_numstat(bytes);
        assert_eq!(counts.get("new name.txt"), Some(&(0, 0)));
        assert_eq!(counts.get("src/lib.rs"), Some(&(1, 1)));
    }

    #[test]
    fn git_allowlist_is_status_diff_and_toplevel_only() {
        assert!(git_args_allowed(&["rev-parse", "--show-toplevel"]));
        assert!(git_args_allowed(&[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all"
        ]));
        assert!(git_args_allowed(&[
            "diff",
            "--no-ext-diff",
            "--numstat",
            "-z",
            "HEAD"
        ]));
        assert!(git_args_allowed(&[
            "diff",
            "--no-ext-diff",
            "-U3",
            "HEAD",
            "--",
            "src/lib.rs"
        ]));
        assert!(git_args_allowed(&[
            "ls-files",
            "--error-unmatch",
            "--",
            "src/lib.rs"
        ]));
        assert!(!git_args_allowed(&[
            "ls-files",
            "--error-unmatch",
            "--",
            "-something"
        ]));
        assert!(git_args_allowed(&[
            "log",
            "-n",
            "1",
            "--no-ext-diff",
            "-U3",
            "-p",
            "--",
            "src/lib.rs"
        ]));
        assert!(!git_args_allowed(&[
            "log",
            "-n",
            "1",
            "--no-ext-diff",
            "-U3",
            "-p",
            "--",
            "-something"
        ]));
        assert!(git_args_allowed(&[
            "log",
            "-n",
            "1",
            "--format=",
            "--numstat",
            "-z",
            "--",
            "src/lib.rs"
        ]));
        assert!(!git_args_allowed(&[
            "log",
            "-n",
            "1",
            "--format=",
            "--numstat",
            "-z",
            "--",
            "-something"
        ]));
        assert!(!git_args_allowed(&[
            "diff",
            "--no-ext-diff",
            "-U3",
            "HEAD",
            "--",
            "-something"
        ]));
        assert!(!git_args_allowed(&["add", "."]));
        assert!(!git_args_allowed(&["commit", "-m", "x"]));
        assert!(!git_args_allowed(&["reset", "--hard"]));
        assert!(!git_args_allowed(&["clean", "-fd"]));
    }

    #[test]
    fn manifests_only_keep_local_path_deps() {
        let cargo = r#"
            [package]
            name = "app"
            [lib]
            path = "src/lib.rs"
            [dependencies]
            other-lib = { path = "../librepo" }
            remote = "1.0"
            [workspace]
            members = ["crates/*"]
        "#;
        let deps = cargo_path_deps(cargo);
        assert!(deps
            .iter()
            .any(|(name, path)| name == "other-lib" && path == "../librepo"));
        assert!(deps.iter().any(|(_, path)| path == "crates/*"));
        assert!(!deps.iter().any(|(_, path)| path == "src/lib.rs"));

        let package = r#"{"name":"app","dependencies":{"other":"file:../other","left":"1.2.3"},"workspaces":["packages/*"]}"#;
        let deps = npm_path_deps(package);
        assert!(deps
            .iter()
            .any(|(name, path)| name == "other" && path == "../other"));
        assert!(deps.iter().any(|(_, path)| path == "packages/*"));
        assert!(!deps.iter().any(|(name, _)| name == "left"));

        let go = "module example.com/app\n\nreplace example.com/lib => ../lib\nreplace example.com/remote => example.com/remote v1.2.3\n";
        let deps = go_replace_deps(go);
        assert_eq!(
            deps,
            vec![("example.com/lib".to_string(), "../lib".to_string())]
        );

        let py = r#"
            [project]
            name = "app"
            [tool.uv.sources]
            other = { path = "../other" }
        "#;
        let deps = py_path_deps(py);
        assert!(deps
            .iter()
            .any(|(name, path)| name == "other" && path == "../other"));
    }

    #[test]
    fn imports_match_local_package_names() {
        assert_eq!(
            rust_imports("use other_lib::Widget;\nuse crate::local;\n"),
            vec!["other_lib".to_string()]
        );
        assert!(js_imports(
            "import { x } from \"../lib/src/api\";\nimport left from 'left-pad';\n"
        )
        .contains(&"../lib/src/api".to_string()));
        assert_eq!(crate_key("other-lib"), crate_key("other_lib"));
        assert!(js_package_matches("@scope/name/sub", "@scope/name"));
        assert!(go_module_matches("example.com/lib/pkg", "example.com/lib"));
        assert!(!go_module_matches("example.com/library", "example.com/lib"));
    }

    #[test]
    fn transcript_edits_ignore_reads() {
        let grok = r#"{"type":"assistant","tool_calls":[{"name":"read_file","arguments":{"target_file":"skip.rs"}},{"name":"search_replace","arguments":"{\"file_path\":\"src/main.rs\",\"old_string\":\"a\",\"new_string\":\"b\\nc\"}"}]}"#;
        let edits = edits_from_jsonl(grok);
        assert_eq!(edits.len(), 1, "{edits:?}");
        assert_eq!(edits[0].path, "src/main.rs");
        assert_eq!(edits[0].added, 2);
        assert_eq!(edits[0].removed, 1);

        let claude = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"src/new.ts","content":"one\ntwo"}}]}}"#;
        let edits = edits_from_jsonl(claude);
        assert_eq!(edits[0].path, "src/new.ts");
        assert_eq!(edits[0].added, 2);
    }

    #[test]
    fn path_dep_and_agent_edit_build_two_clusters() {
        let root = scratch("two");
        let app = root.join("app");
        let lib = root.join("librepo");
        fs::create_dir_all(app.join("src")).unwrap();
        fs::create_dir_all(lib.join("src")).unwrap();
        fs::write(
            lib.join("Cargo.toml"),
            "[package]\nname = \"other-lib\"\nversion = \"0.1.0\"\n",
        )
        .unwrap();
        fs::write(lib.join("src/lib.rs"), "pub struct Widget;\n").unwrap();
        git_init(&lib);
        fs::write(
            app.join("Cargo.toml"),
            "[package]\nname = \"app\"\nversion = \"0.1.0\"\n\n[dependencies]\nother-lib = { path = \"../librepo\" }\n",
        )
        .unwrap();
        fs::write(app.join("src/main.rs"), "fn main() {}\n").unwrap();
        git_init(&app);
        fs::write(
            app.join("src/main.rs"),
            "use other_lib::Widget;\nfn main() {}\nlet _fresh = 1;\n",
        )
        .unwrap();
        fs::write(app.join("notes.txt"), "scratch\n").unwrap();

        let edits = vec![AgentEdit {
            path: "src/main.rs".into(),
            added: 2,
            removed: 1,
            deleted: false,
        }];
        let graph = build_change_graph(&app, &edits);
        assert!(graph.error.is_none(), "{graph:?}");
        assert_eq!(graph.repos.len(), 2, "{graph:?}");
        let primary = graph.repos.iter().find(|repo| repo.primary).unwrap();
        assert_eq!(primary.name, "app");
        let main = primary
            .files
            .iter()
            .find(|file| file.path == "src/main.rs")
            .unwrap();
        assert!(main.agent_edited, "{main:?}");
        assert_eq!(main.status, "modified");
        assert!(primary
            .files
            .iter()
            .any(|file| file.path == "notes.txt" && file.status == "untracked"));
        let other = graph
            .repos
            .iter()
            .find(|repo| repo.name == "librepo")
            .unwrap();
        assert!(!other.primary);
        assert!(other
            .files
            .iter()
            .any(|file| file.status == "library" || file.path.contains("other-lib")));
        assert!(
            graph.edges.iter().any(|edge| {
                edge.from_repo == primary.id
                    && edge.to_repo == other.id
                    && edge.label == "other-lib"
            }),
            "{graph:?}"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn relative_import_links_a_second_repo() {
        let root = scratch("js");
        let app = root.join("web");
        let lib = root.join("ui");
        fs::create_dir_all(app.join("src")).unwrap();
        fs::create_dir_all(lib.join("src")).unwrap();
        fs::write(lib.join("src/api.ts"), "export const value = 1;\n").unwrap();
        fs::write(lib.join("package.json"), "{\"name\":\"ui-lib\"}\n").unwrap();
        git_init(&lib);
        fs::write(app.join("package.json"), "{\"name\":\"web\"}\n").unwrap();
        fs::write(app.join("src/app.ts"), "export const a = 1;\n").unwrap();
        git_init(&app);
        fs::write(
            app.join("src/app.ts"),
            "import { value } from \"../../ui/src/api\";\nexport const a = 2;\n",
        )
        .unwrap();
        let graph = build_change_graph(&app, &[]);
        assert!(graph.error.is_none(), "{graph:?}");
        let primary = graph
            .repos
            .iter()
            .find(|repo| repo.primary)
            .expect("primary");
        let other = graph
            .repos
            .iter()
            .find(|repo| repo.name == "ui")
            .expect("ui");
        assert!(
            graph
                .edges
                .iter()
                .any(|edge| edge.from_repo == primary.id && edge.to_repo == other.id),
            "{graph:?}"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn file_diff_returns_the_requested_file() {
        let root = scratch("diff");
        fs::write(root.join("a.txt"), "one\n").unwrap();
        fs::write(root.join("b.txt"), "two\n").unwrap();
        fs::write(root.join("clean.txt"), "clean content\n").unwrap();
        git_init(&root);
        fs::write(root.join("a.txt"), "one changed\n").unwrap();
        fs::write(root.join("b.txt"), "two changed\n").unwrap();
        fs::write(root.join("untracked.txt"), "brand new\n").unwrap();
        let id = root_id(&root.canonicalize().unwrap());
        let a = fetch_file_diff(&id, "a.txt", "").unwrap();
        let b = fetch_file_diff(&id, "b.txt", "").unwrap();
        let clean = fetch_file_diff(&id, "clean.txt", "").unwrap();
        let untracked = fetch_file_diff(&id, "untracked.txt", "").unwrap();
        assert!(
            a.diff.contains("one changed") && !a.diff.contains("two"),
            "{a:?}"
        );
        assert!(
            b.diff.contains("two changed") && !b.diff.contains("one"),
            "{b:?}"
        );
        assert!(
            clean.diff.contains("clean content") || clean.diff.contains("No differences found"),
            "{clean:?}"
        );
        assert!(untracked.diff.contains("+brand new"), "{untracked:?}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn same_repo_member_does_not_split_the_cluster() {
        let root = scratch("mono");
        let app = root.join("mono");
        fs::create_dir_all(app.join("crates/core")).unwrap();
        fs::write(
            app.join("Cargo.toml"),
            "[workspace]\nmembers = [\"crates/core\"]\n",
        )
        .unwrap();
        fs::write(app.join("crates/core/lib.rs"), "pub fn core() {}\n").unwrap();
        git_init(&app);
        fs::write(
            app.join("crates/core/lib.rs"),
            "pub fn core() { let _x = 1; }\n",
        )
        .unwrap();
        let graph = build_change_graph(&app, &[]);
        assert_eq!(graph.repos.len(), 1, "{graph:?}");
        assert!(graph.edges.is_empty(), "{graph:?}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn graph_button_sits_beside_stats() {
        let app = include_str!("../../src/App.tsx");
        let bar = include_str!("../../src/chrome/StatusBar.tsx");
        let panel = include_str!("../../src/chrome/ArtifactPanel.tsx");
        let lib = include_str!("lib.rs");
        assert!(lib.contains("change_graph::change_graph"));
        assert!(bar.contains("status-graph"));
        assert!(bar.contains("aria-label=\"Changed files graph\""));
        assert!(panel.contains("aria-label=\"Open changed files graph\""));
        assert!(app.contains("ChangeGraph"));
        assert!(app.contains("graphOpen"));
    }

    #[test]
    fn search_changed_files_diff_and_full_scopes() {
        let root = scratch("search");
        fs::write(root.join("hello.txt"), "common unchanged line\nbase code\n").unwrap();
        git_init(&root);
        fs::write(
            root.join("hello.txt"),
            "common unchanged line\nbase code\nadded special_sparkmux_keyword line\n",
        )
        .unwrap();
        let id = root_id(&root.canonicalize().unwrap());
        let targets = vec![SearchFileTarget {
            repo_id: id.clone(),
            path: "hello.txt".into(),
        }];

        // Diff scope matches the added line
        let diff_matches =
            execute_search_changed_files(&targets, "special_sparkmux_keyword", "diff", "");
        assert_eq!(diff_matches.len(), 1);
        assert_eq!(diff_matches[0].match_count, 1);

        // Diff scope does not match unchanged lines
        let diff_no_match =
            execute_search_changed_files(&targets, "common unchanged line", "diff", "");
        assert!(diff_no_match.is_empty());

        // Full scope matches both unchanged lines and changed lines
        let full_matches =
            execute_search_changed_files(&targets, "common unchanged line", "full", "");
        assert_eq!(full_matches.len(), 1);
        assert_eq!(full_matches[0].match_count, 1);

        // Empty query returns nothing
        let empty_res = execute_search_changed_files(&targets, "   ", "diff", "");
        assert!(empty_res.is_empty());

        // Case insensitivity
        let case_matches =
            execute_search_changed_files(&targets, "SPECIAL_SPARKMUX_KEYWORD", "diff", "");
        assert_eq!(case_matches.len(), 1);

        let _ = fs::remove_dir_all(&root);
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "sparkmux-graph-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn git_init(dir: &Path) {
        let run = |args: &[&str]| {
            let status = Proc::new("git")
                .arg("-C")
                .arg(dir)
                .args(args)
                .env("GIT_AUTHOR_NAME", "Sparkmux Test")
                .env("GIT_AUTHOR_EMAIL", "test@sparkmux.local")
                .env("GIT_COMMITTER_NAME", "Sparkmux Test")
                .env("GIT_COMMITTER_EMAIL", "test@sparkmux.local")
                .status()
                .expect("git");
            assert!(status.success(), "git {args:?} in {}", dir.display());
        };
        run(&["init", "-q", "-b", "main"]);
        run(&["config", "user.email", "test@sparkmux.local"]);
        run(&["config", "user.name", "Sparkmux Test"]);
        run(&["add", "."]);
        run(&["commit", "-q", "-m", "init"]);
    }
}
