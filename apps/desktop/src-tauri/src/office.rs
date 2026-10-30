//! Agent Office rows: one avatar per Grok, Claude, or Antigravity pane on this socket.
//! Read-only. Reuses the artifact feed and the attention classifier.

use serde::Serialize;

use crate::artifacts::{self, default_roots, ArtifactEntry};
use crate::attention::{self, AttentionLabel};
use crate::board_api::{model_hint, BoardPane};

/// Running agents whose transcript has not grown for this long render as idle.
pub(crate) const STALE_MS: i64 = 5 * 60 * 1000;
const DETAIL_CAP: usize = 160;
const ASK_CAP: usize = 240;
const RECENT_CAP: usize = 6;
const TOOL_ARG_CAP: usize = 100;
const STEP_CAP: usize = 120;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct OfficeAgent {
    pub session: String,
    pub window_id: String,
    pub window_name: String,
    pub pane_id: String,
    /// "grok" | "claude" | "antigravity"
    pub cli: String,
    pub model: String,
    /// "needs_user" | "failed" | "succeeded" | "running" | "idle"
    pub state: String,
    /// "coding" | "terminal" | "reading" | "browsing" | "delegating" | "thinking" | "replying" | "planning" | ""
    pub activity: String,
    /// Last tool name, e.g. "Bash". Empty when none.
    pub tool: String,
    /// One-line tool argument summary (path / command / pattern), capped.
    pub tool_arg: String,
    /// One-line: pending ask while waiting, else last assistant line.
    pub detail: String,
    /// Full pending ask (capped) for the speech bubble. Empty unless needs_user.
    pub ask: String,
    /// Transcript mtime in Unix ms. 0 when unknown.
    pub last_activity_ms: i64,
    /// Id of the last artifact entry. The UI diffs this to emit activity-feed lines.
    pub last_entry_id: String,
    /// Last few steps, newest last, for the hover card.
    pub recent: Vec<OfficeStep>,
    /// Pane cwd basename, used as the desk "role" subtitle.
    pub project: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct OfficeStep {
    pub id: String,
    /// artifact kind: "user" | "assistant" | "thinking" | "tool" | "tool_result"
    pub kind: String,
    pub label: String,
    /// one line, capped at 120 chars
    pub text: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct OfficeSnapshot {
    pub agents: Vec<OfficeAgent>,
    /// Non-agent, non-ssh panes grouped per session (count of free desks).
    pub free_desks: Vec<FreeDesk>,
    /// Server time, Unix ms. The client uses it for staleness and relative times.
    pub now_ms: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FreeDesk {
    pub session: String,
    pub pane_id: String,
    pub window_name: String,
}

#[tauri::command]
pub async fn agent_office(panes: Vec<BoardPane>) -> Result<OfficeSnapshot, String> {
    tokio::task::spawn_blocking(move || {
        build_office(panes, &default_roots(), crate::analytics::event::now_ms())
    })
    .await
    .map_err(|err| err.to_string())
}

pub(crate) fn build_office(
    panes: Vec<BoardPane>,
    roots: &artifacts::TranscriptRoots,
    now: i64,
) -> OfficeSnapshot {
    let mut agents = Vec::new();
    let mut free_desks = Vec::new();
    for pane in panes {
        // SSH panes are neither agents nor free desks, and never open a transcript.
        if attention::command_is_ssh(&pane.command) {
            continue;
        }
        let feed =
            artifacts::load_artifacts(&pane.command, &pane.cwd, &pane.title, pane.pid, roots);
        let detected = artifacts::detect_cli(&pane.command, &pane.title, &[]);
        let cli = if let Some(cli) = feed.cli.clone() {
            cli
        } else if let Some(kind) = detected {
            kind.as_str().to_string()
        } else {
            free_desks.push(FreeDesk {
                session: pane.session,
                pane_id: pane.pane_id,
                window_name: pane.window_name,
            });
            continue;
        };
        let (_token, label) = attention::label_from_feed(&feed);
        let ask = if label == Some(AttentionLabel::NeedsUser) {
            attention::pending_question(&feed.entries)
                .map(|text| one_line(&text, ASK_CAP))
                .unwrap_or_default()
        } else {
            String::new()
        };
        let assistant = attention::last_assistant_line(&feed.entries).unwrap_or_default();
        let detail_src = if label == Some(AttentionLabel::NeedsUser) {
            ask.clone()
        } else {
            assistant
        };
        let last_activity_ms = transcript_mtime_ms(feed.transcript_path.as_deref());
        let (activity, tool, tool_arg) = classify_activity(&feed.entries);
        let model = model_hint(&feed.entries).unwrap_or_else(|| {
            artifacts::cli_kind(&cli)
                .map(attention::cli_label)
                .unwrap_or("Agent")
                .to_string()
        });
        agents.push(OfficeAgent {
            session: pane.session,
            window_id: pane.window_id,
            window_name: pane.window_name,
            pane_id: pane.pane_id,
            cli,
            model,
            state: office_state(label, last_activity_ms, now),
            activity,
            tool,
            tool_arg,
            detail: one_line(&detail_src, DETAIL_CAP),
            ask,
            last_activity_ms,
            last_entry_id: feed
                .entries
                .last()
                .map(|entry| entry.id.clone())
                .unwrap_or_default(),
            recent: recent_steps(&feed.entries),
            project: project_name(&pane.cwd),
        });
    }
    OfficeSnapshot {
        agents,
        free_desks,
        now_ms: now,
    }
}

/// Needs-user, failed, and succeeded are not stale. Running goes idle only after `STALE_MS`.
pub(crate) fn office_state(
    label: Option<AttentionLabel>,
    last_activity_ms: i64,
    now: i64,
) -> String {
    let name = match label {
        Some(AttentionLabel::NeedsUser) => "needs_user",
        Some(AttentionLabel::Failed) => "failed",
        Some(AttentionLabel::Succeeded) => "succeeded",
        Some(AttentionLabel::Running) => {
            if last_activity_ms > 0 && now.saturating_sub(last_activity_ms) > STALE_MS {
                "idle"
            } else {
                "running"
            }
        }
        Some(AttentionLabel::Noise) | None => "idle",
    };
    name.to_string()
}

/// `(activity, tool name, tool arg)`. Activity is empty when the feed has no steps.
pub(crate) fn classify_activity(entries: &[ArtifactEntry]) -> (String, String, String) {
    let Some(last) = entries.last() else {
        return (String::new(), String::new(), String::new());
    };
    match last.kind.as_str() {
        "tool" => classify_tool(last),
        "tool_result" => entries
            .iter()
            .rev()
            .skip(1)
            .find(|entry| entry.kind == "tool")
            .map(classify_tool)
            .unwrap_or_else(|| (String::new(), String::new(), String::new())),
        "thinking" => {
            let tool = entries
                .iter()
                .rev()
                .find(|entry| entry.kind == "tool")
                .map(|entry| entry.label.clone())
                .unwrap_or_default();
            ("thinking".to_string(), tool, String::new())
        }
        "assistant" => ("replying".to_string(), String::new(), String::new()),
        "user" => ("thinking".to_string(), String::new(), String::new()),
        _ => (String::new(), String::new(), String::new()),
    }
}

fn classify_tool(entry: &ArtifactEntry) -> (String, String, String) {
    let activity = activity_for_tool(&entry.label, &entry.body);
    let tool_arg = first_line(&entry.body)
        .chars()
        .take(TOOL_ARG_CAP)
        .collect::<String>();
    (activity.to_string(), entry.label.clone(), tool_arg)
}

/// First match wins. `browsing` is before `reading`, and `coding` is before `reading`,
/// so `web_search` / `read_url` / `str_replace` are not swallowed by shorter patterns.
fn activity_for_tool(name: &str, body: &str) -> &'static str {
    let lower = name.trim().to_ascii_lowercase();
    if lower == "task"
        || lower == "agent"
        || contains_any(
            &lower,
            &["invoke_subagent", "spawn", "subagent", "delegate"],
        )
    {
        return "delegating";
    }
    if contains_any(
        &lower,
        &["todowrite", "todo", "exitplanmode", "enterplanmode", "plan"],
    ) {
        return "planning";
    }
    if contains_any(
        &lower,
        &[
            "str_replace",
            "multiedit",
            "notebookedit",
            "apply_patch",
            "create_file",
            "edit",
            "write",
            "replace",
        ],
    ) {
        return "coding";
    }
    if contains_any(
        &lower,
        &[
            "bash",
            "shell",
            "run_command",
            "exec",
            "terminal",
            "manage_task",
            "killshell",
            "bashoutput",
        ],
    ) {
        return "terminal";
    }
    if contains_any(
        &lower,
        &[
            "webfetch",
            "websearch",
            "web_search",
            "search_web",
            "read_url",
            "fetch",
            "browser",
            "http",
        ],
    ) {
        return "browsing";
    }
    if lower == "ls"
        || contains_any(
            &lower,
            &[
                "read", "view", "grep", "glob", "list", "find", "search", "cat",
            ],
        )
    {
        return "reading";
    }
    if looks_like_shell(body) {
        "terminal"
    } else {
        "coding"
    }
}

fn contains_any(name: &str, patterns: &[&str]) -> bool {
    patterns.iter().any(|pattern| name.contains(pattern))
}

/// Argument summaries are `key: value` lines. A command key, or a raw shell line, is a terminal.
fn looks_like_shell(body: &str) -> bool {
    let line = first_line(body);
    if line.is_empty() || line.starts_with('{') || line.starts_with('[') {
        return false;
    }
    if let Some((key, _)) = line.split_once(':') {
        let key = key.trim().to_ascii_lowercase();
        let keyed = !key.is_empty()
            && key
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
            && !line.contains("&&")
            && !line.contains('|');
        if keyed {
            return matches!(key.as_str(), "command" | "cmd" | "commandline" | "script");
        }
    }
    let lower = line.to_ascii_lowercase();
    if lower.starts_with("$ ") || lower.starts_with("sudo ") {
        return true;
    }
    let token = lower
        .split_whitespace()
        .next()
        .unwrap_or("")
        .trim_start_matches(['$', '>', '!']);
    const COMMANDS: &[&str] = &[
        "ls", "cd", "pwd", "cat", "echo", "git", "cargo", "npm", "pnpm", "yarn", "python",
        "python3", "node", "bash", "sh", "zsh", "make", "rm", "mkdir", "cp", "mv", "curl", "wget",
        "grep", "find", "sed", "awk", "docker", "kubectl", "go", "rustc", "ssh", "scp", "tar",
        "chmod", "touch", "head", "tail", "rg", "fd", "brew", "apt",
    ];
    COMMANDS.contains(&token) || line.contains("&&") || line.contains("||") || line.contains(" | ")
}

fn first_line(body: &str) -> &str {
    body.lines().next().unwrap_or("").trim()
}

fn recent_steps(entries: &[ArtifactEntry]) -> Vec<OfficeStep> {
    let start = entries.len().saturating_sub(RECENT_CAP);
    entries[start..]
        .iter()
        .map(|entry| OfficeStep {
            id: entry.id.clone(),
            kind: entry.kind.clone(),
            label: entry.label.clone(),
            text: one_line(&entry.body, STEP_CAP),
        })
        .collect()
}

fn project_name(cwd: &str) -> String {
    std::path::Path::new(cwd)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn transcript_mtime_ms(path: Option<&str>) -> i64 {
    let Some(path) = path.filter(|path| !path.is_empty()) else {
        return 0;
    };
    let Ok(meta) = std::fs::metadata(path) else {
        return 0;
    };
    let Ok(modified) = meta.modified() else {
        return 0;
    };
    modified
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|dur| i64::try_from(dur.as_millis()).ok())
        .unwrap_or(0)
}

fn one_line(text: &str, cap: usize) -> String {
    let mut out = String::new();
    let mut count = 0usize;
    let mut pending_space = false;
    for ch in text.chars() {
        if ch.is_whitespace() {
            if count > 0 {
                pending_space = true;
            }
            continue;
        }
        if pending_space {
            if count >= cap {
                break;
            }
            out.push(' ');
            count += 1;
            pending_space = false;
        }
        if count >= cap {
            break;
        }
        out.push(ch);
        count += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use std::path::PathBuf;

    fn entry(kind: &str, label: &str, body: &str) -> ArtifactEntry {
        ArtifactEntry {
            id: format!("{kind}:{label}:{}", body.len()),
            offset: 0,
            kind: kind.to_string(),
            label: label.to_string(),
            body: body.to_string(),
            model: String::new(),
        }
    }

    fn activity_of(label: &str, body: &str) -> String {
        classify_activity(&[entry("tool", label, body)]).0
    }

    #[test]
    fn classify_activity_matches_every_tool_row() {
        let rows = [
            ("task", "delegating"),
            ("Task", "delegating"),
            ("agent", "delegating"),
            ("invoke_subagent", "delegating"),
            ("spawn", "delegating"),
            ("subagent", "delegating"),
            ("delegate_work", "delegating"),
            ("TodoWrite", "planning"),
            ("todo", "planning"),
            ("exitplanmode", "planning"),
            ("enterplanmode", "planning"),
            ("plan", "planning"),
            ("edit", "coding"),
            ("write", "coding"),
            ("multiedit", "coding"),
            ("notebookedit", "coding"),
            ("apply_patch", "coding"),
            ("str_replace", "coding"),
            ("str_replace_based_edit_tool", "coding"),
            ("create_file", "coding"),
            ("replace", "coding"),
            ("search_replace", "coding"),
            ("Bash", "terminal"),
            ("bash", "terminal"),
            ("shell", "terminal"),
            ("run_command", "terminal"),
            ("exec", "terminal"),
            ("terminal", "terminal"),
            ("manage_task", "terminal"),
            ("killshell", "terminal"),
            ("bashoutput", "terminal"),
            ("webfetch", "browsing"),
            ("websearch", "browsing"),
            ("web_search", "browsing"),
            ("search_web", "browsing"),
            ("fetch", "browsing"),
            ("browser", "browsing"),
            ("read_url", "browsing"),
            ("http", "browsing"),
            ("read", "reading"),
            ("view", "reading"),
            ("grep", "reading"),
            ("glob", "reading"),
            ("ls", "reading"),
            ("list", "reading"),
            ("find", "reading"),
            ("search", "reading"),
            ("cat", "reading"),
        ];
        for (name, expected) in rows {
            assert_eq!(activity_of(name, "file_path: src/a.rs"), expected, "{name}");
        }
        // Exact names must not swallow neighbours. `lsl` contains `ls` but is not `ls`.
        assert_eq!(activity_of("lsl", "file_path: src/a.rs"), "coding");
        assert_eq!(
            activity_of("manage_task", "command: cargo test"),
            "terminal"
        );

        let (activity, tool, arg) = classify_activity(&[
            entry("tool", "Bash", "ls"),
            entry("tool_result", "Result", "src\n"),
        ]);
        assert_eq!(activity, "terminal");
        assert_eq!(tool, "Bash");
        assert_eq!(arg, "ls");

        let (activity, tool, arg) = classify_activity(&[
            entry("tool", "Read", "file_path: src/main.rs"),
            entry("thinking", "Thinking", "hmm"),
        ]);
        assert_eq!(activity, "thinking");
        assert_eq!(tool, "Read");
        assert_eq!(arg, "");

        let (activity, tool, _) = classify_activity(&[
            entry("tool", "Bash", "ls"),
            entry("assistant", "Assistant", "done"),
        ]);
        assert_eq!(activity, "replying");
        assert_eq!(tool, "");

        assert_eq!(
            classify_activity(&[entry("user", "You", "hi")]).0,
            "thinking"
        );
        assert_eq!(
            classify_activity(&[]),
            (String::new(), String::new(), String::new())
        );

        assert_eq!(activity_of("Custom", "command: cargo test"), "terminal");
        assert_eq!(activity_of("Custom", "cargo test --lib"), "terminal");
        assert_eq!(activity_of("Custom", "file_path: src/a.rs"), "coding");

        let long = "x".repeat(140);
        let (_, _, arg) = classify_activity(&[entry("tool", "Bash", &long)]);
        assert_eq!(arg.chars().count(), TOOL_ARG_CAP);
    }

    #[test]
    fn office_state_staleness_boundary() {
        let now = 10_000_000_i64;
        assert_eq!(
            office_state(Some(AttentionLabel::Running), now - STALE_MS, now),
            "running"
        );
        assert_eq!(
            office_state(Some(AttentionLabel::Running), now - STALE_MS - 1, now),
            "idle"
        );
        assert_eq!(
            office_state(Some(AttentionLabel::Running), 0, now),
            "running"
        );
        assert_eq!(
            office_state(Some(AttentionLabel::NeedsUser), 1, now),
            "needs_user"
        );
        assert_eq!(office_state(Some(AttentionLabel::Failed), 1, now), "failed");
        assert_eq!(
            office_state(Some(AttentionLabel::Succeeded), 1, now),
            "succeeded"
        );
        assert_eq!(office_state(Some(AttentionLabel::Noise), now, now), "idle");
        assert_eq!(office_state(None, now, now), "idle");
    }

    fn empty_roots(dir: &std::path::Path) -> artifacts::TranscriptRoots {
        artifacts::TranscriptRoots {
            grok_sessions: dir.join("grok"),
            claude_projects: dir.join("claude"),
            grok_active_sessions: dir.join("active_sessions.json"),
            agy_root: dir.join("agy"),
        }
    }

    fn pane(session: &str, pane_id: &str, command: &str, cwd: &str, title: &str) -> BoardPane {
        BoardPane {
            session: session.to_string(),
            window_id: "@1".to_string(),
            window_name: "dev".to_string(),
            pane_id: pane_id.to_string(),
            command: command.to_string(),
            cwd: cwd.to_string(),
            title: title.to_string(),
            pid: 0,
        }
    }

    #[test]
    fn build_office_skips_ssh_and_lists_a_shell_as_a_free_desk() {
        let dir: PathBuf =
            std::env::temp_dir().join(format!("sparkmux-office-build-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let roots = empty_roots(&dir);
        let now = 1_700_000_000_000_i64;
        let snap = build_office(
            vec![
                pane(
                    "spark",
                    "%1",
                    "/usr/bin/ssh",
                    "/tmp/sparkmux",
                    "Claude Code",
                ),
                pane("spark", "%2", "zsh", "/tmp/sparkmux", ""),
                pane("spark", "%3", "claude", "/tmp/sparkmux", ""),
                pane("ops", "%4", "grok", "/work/ops", "idle - grok"),
                pane("ops", "%5", "agy", "/work/frontend", ""),
            ],
            &roots,
            now,
        );
        let created: Vec<_> = std::fs::read_dir(&dir).unwrap().collect();
        assert!(created.is_empty(), "office must not write transcript roots");
        let _ = std::fs::remove_dir_all(&dir);

        assert!(snap.agents.iter().all(|agent| agent.pane_id != "%1"));
        assert!(snap.free_desks.iter().all(|desk| desk.pane_id != "%1"));
        assert_eq!(
            snap.free_desks,
            vec![FreeDesk {
                session: "spark".to_string(),
                pane_id: "%2".to_string(),
                window_name: "dev".to_string(),
            }]
        );
        assert_eq!(snap.agents.len(), 3);
        assert_eq!(snap.agents[0].cli, "claude");
        assert_eq!(snap.agents[0].model, "Claude");
        assert_eq!(snap.agents[0].state, "idle");
        assert_eq!(snap.agents[0].activity, "");
        assert_eq!(snap.agents[0].project, "sparkmux");
        assert_eq!(snap.agents[0].last_activity_ms, 0);
        assert_eq!(snap.agents[1].cli, "grok");
        assert_eq!(snap.agents[1].model, "Grok");
        assert_eq!(snap.agents[1].project, "ops");
        assert_eq!(snap.agents[2].cli, "antigravity");
        assert_eq!(snap.agents[2].model, "Antigravity");
        assert_eq!(snap.now_ms, now);
    }

    fn keys(value: &serde_json::Value) -> BTreeSet<String> {
        value.as_object().unwrap().keys().cloned().collect()
    }

    #[test]
    fn office_snapshot_json_is_snake_case() {
        let snap = OfficeSnapshot {
            agents: vec![OfficeAgent {
                session: "spark".to_string(),
                window_id: "@1".to_string(),
                window_name: "dev".to_string(),
                pane_id: "%3".to_string(),
                cli: "claude".to_string(),
                model: "Claude".to_string(),
                state: "running".to_string(),
                activity: "terminal".to_string(),
                tool: "Bash".to_string(),
                tool_arg: "ls".to_string(),
                detail: "listing".to_string(),
                ask: String::new(),
                last_activity_ms: 5,
                last_entry_id: "e1".to_string(),
                recent: vec![OfficeStep {
                    id: "e1".to_string(),
                    kind: "tool".to_string(),
                    label: "Bash".to_string(),
                    text: "ls".to_string(),
                }],
                project: "sparkmux".to_string(),
            }],
            free_desks: vec![FreeDesk {
                session: "spark".to_string(),
                pane_id: "%2".to_string(),
                window_name: "dev".to_string(),
            }],
            now_ms: 9,
        };
        let value = serde_json::to_value(&snap).unwrap();
        assert_eq!(
            keys(&value),
            BTreeSet::from([
                "agents".to_string(),
                "free_desks".to_string(),
                "now_ms".to_string()
            ])
        );
        assert_eq!(
            keys(&value["agents"][0]),
            BTreeSet::from([
                "session".to_string(),
                "window_id".to_string(),
                "window_name".to_string(),
                "pane_id".to_string(),
                "cli".to_string(),
                "model".to_string(),
                "state".to_string(),
                "activity".to_string(),
                "tool".to_string(),
                "tool_arg".to_string(),
                "detail".to_string(),
                "ask".to_string(),
                "last_activity_ms".to_string(),
                "last_entry_id".to_string(),
                "recent".to_string(),
                "project".to_string(),
            ])
        );
        assert_eq!(
            keys(&value["agents"][0]["recent"][0]),
            BTreeSet::from([
                "id".to_string(),
                "kind".to_string(),
                "label".to_string(),
                "text".to_string(),
            ])
        );
        assert_eq!(
            keys(&value["free_desks"][0]),
            BTreeSet::from([
                "session".to_string(),
                "pane_id".to_string(),
                "window_name".to_string(),
            ])
        );
        let text = serde_json::to_string(&value).unwrap();
        assert!(!text.contains("windowId"));
        assert!(!text.contains("paneId"));
        assert!(!text.contains("lastActivityMs"));
        assert!(!text.contains("toolArg"));
        assert!(!text.contains("freeDesks"));
    }

    #[test]
    fn agent_office_is_registered_beside_agent_board() {
        let lib = include_str!("lib.rs");
        let start = lib.find("generate_handler!").expect("handler");
        let body = &lib[start..];
        let end = body.find("])").expect("end");
        let body = &body[..end];
        let board = body.find("board_api::agent_board").expect("board");
        let office = body.find("office::agent_office").expect("office");
        assert!(office > board);
        let between = &body[board + "board_api::agent_board".len()..office];
        assert!(
            between.chars().all(|ch| ch.is_whitespace() || ch == ','),
            "agent_office must sit next to agent_board, between was {between:?}"
        );

        let web = include_str!("web_server.rs");
        let board = web.find("\"agent_board\"").expect("web board");
        let office = web.find("\"agent_office\"").expect("web office");
        assert!(office > board);
        assert!(web[board..office].contains("crate::board_api::agent_board"));
        assert!(web[office..office + 400].contains("crate::office::agent_office"));
    }
}
