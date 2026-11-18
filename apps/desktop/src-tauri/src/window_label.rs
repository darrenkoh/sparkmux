//! Window names for tabs that are still `shell`, or still carry a label this
//! module wrote. A name the user typed is left alone.
//!
//! Grok and Claude versions come from the executable name tmux already reports
//! (`grok-1.0.62`, `2.1.296`). `agy` and `droid` do not, so one `--version`
//! probe is cached for each. A shell command wins over a stale pane title:
//! Grok leaves ` - grok` behind after it exits. A missing `droid` binary is a
//! soft miss and the tab is labeled `Droid`.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use sparkmux_core::{Pane, Snapshot, Window};

use crate::artifacts::{cli_kind, CliKind};

const VERSION_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LabelVersions {
    pub agy: Option<String>,
    /// A probe is in flight. Keep the current name until it finishes.
    pub agy_pending: bool,
    /// The probe already finished, including a failure.
    pub agy_tried: bool,
    pub droid: Option<String>,
    pub droid_pending: bool,
    pub droid_tried: bool,
    pub grok_fallback: Option<String>,
    pub claude_fallback: Option<String>,
}

impl LabelVersions {
    #[cfg(test)]
    fn bare() -> Self {
        Self {
            agy: None,
            agy_pending: false,
            agy_tried: false,
            droid: None,
            droid_pending: false,
            droid_tried: false,
            grok_fallback: None,
            claude_fallback: None,
        }
    }
}

/// Which version probes `plan` wants started.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ProbePlan {
    pub agy: bool,
    pub droid: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LabelChange {
    pub window_id: String,
    pub name: String,
}

enum VersionProbe {
    Idle,
    Running,
    Ready(Option<String>),
}

static AGY_PROBE: Mutex<VersionProbe> = Mutex::new(VersionProbe::Idle);
static DROID_PROBE: Mutex<VersionProbe> = Mutex::new(VersionProbe::Idle);
static GROK_FALLBACK: Mutex<Option<String>> = Mutex::new(None);
static CLAUDE_FALLBACK: Mutex<Option<String>> = Mutex::new(None);

/// Versions already known, plus a one-time symlink read when a bare `grok` or
/// `claude` command has no version in its file name.
fn probe_bits(slot: &Mutex<VersionProbe>) -> (Option<String>, bool, bool) {
    let guard = slot.lock().unwrap_or_else(|err| err.into_inner());
    match &*guard {
        VersionProbe::Idle => (None, false, false),
        VersionProbe::Running => (None, true, false),
        VersionProbe::Ready(version) => (version.clone(), false, true),
    }
}

pub(crate) fn cached_versions() -> LabelVersions {
    let (agy, agy_pending, agy_tried) = probe_bits(&AGY_PROBE);
    let (droid, droid_pending, droid_tried) = probe_bits(&DROID_PROBE);
    LabelVersions {
        agy,
        agy_pending,
        agy_tried,
        droid,
        droid_pending,
        droid_tried,
        grok_fallback: cached_fallback(&GROK_FALLBACK, &[".grok/bin/grok", ".local/bin/grok"]),
        claude_fallback: cached_fallback(&CLAUDE_FALLBACK, &[".local/bin/claude"]),
    }
}

fn start_probe(slot: &'static Mutex<VersionProbe>, name: &str, probe: fn() -> Option<String>) {
    {
        let mut guard = slot.lock().unwrap_or_else(|err| err.into_inner());
        if !matches!(&*guard, VersionProbe::Idle) {
            return;
        }
        *guard = VersionProbe::Running;
    }
    let spawned = thread::Builder::new()
        .name(name.to_string())
        .spawn(move || {
            let version = probe();
            let mut guard = slot.lock().unwrap_or_else(|err| err.into_inner());
            *guard = VersionProbe::Ready(version);
        })
        .is_ok();
    if !spawned {
        let mut guard = slot.lock().unwrap_or_else(|err| err.into_inner());
        if matches!(&*guard, VersionProbe::Running) {
            *guard = VersionProbe::Ready(None);
        }
    }
}

/// One background `agy --version`. Later calls do nothing.
pub(crate) fn start_agy_probe() {
    start_probe(&AGY_PROBE, "sparkmux-agy-version", probe_agy_version);
}

/// One background `droid --version`. A missing binary finishes as no version.
pub(crate) fn start_droid_probe() {
    start_probe(&DROID_PROBE, "sparkmux-droid-version", probe_droid_version);
}

/// Renames to apply, and which version probes the caller should start.
pub(crate) fn plan(snap: &Snapshot, versions: &LabelVersions) -> (Vec<LabelChange>, ProbePlan) {
    let mut versions = versions.clone();
    let need_agy = versions.agy.is_none()
        && !versions.agy_pending
        && !versions.agy_tried
        && snap_needs_agy(snap);
    let need_droid = versions.droid.is_none()
        && !versions.droid_pending
        && !versions.droid_tried
        && snap_needs_droid(snap);
    if need_agy {
        versions.agy_pending = true;
    }
    if need_droid {
        versions.droid_pending = true;
    }
    let mut changes = Vec::new();
    for session in &snap.sessions {
        for window in &session.windows {
            let Some(pane) = active_pane(window) else {
                continue;
            };
            let Some(name) =
                desired_window_name(&window.name, &pane.command, &pane.title, &versions)
            else {
                continue;
            };
            if sparkmux_core::display_name(&name).is_err() {
                continue;
            }
            changes.push(LabelChange {
                window_id: window.id.clone(),
                name,
            });
        }
    }
    (
        changes,
        ProbePlan {
            agy: need_agy,
            droid: need_droid,
        },
    )
}

pub(crate) fn desired_window_name(
    current: &str,
    command: &str,
    title: &str,
    versions: &LabelVersions,
) -> Option<String> {
    let current = current.trim();
    if !is_managed(current) || command.trim().is_empty() {
        return None;
    }
    let desired = match cli_from_pane(command, title) {
        Some(kind) => match version_for(kind, command, versions) {
            VersionChoice::Wait => return None,
            VersionChoice::Known(version) => product_label(kind, Some(&version)),
            VersionChoice::Missing => product_label(kind, None),
        },
        None => {
            if is_claude_managed(current) && looks_like_version(command_base(command)) {
                return None;
            }
            "shell".to_string()
        }
    };
    (desired != current).then_some(desired)
}

fn snap_needs_agy(snap: &Snapshot) -> bool {
    snap.sessions.iter().any(|session| {
        session.windows.iter().any(|window| {
            is_managed(window.name.trim())
                && active_pane(window).is_some_and(|pane| {
                    cli_from_pane(&pane.command, &pane.title) == Some(CliKind::Antigravity)
                        && command_version(CliKind::Antigravity, &pane.command).is_none()
                })
        })
    })
}

fn snap_needs_droid(snap: &Snapshot) -> bool {
    snap.sessions.iter().any(|session| {
        session.windows.iter().any(|window| {
            is_managed(window.name.trim())
                && active_pane(window).is_some_and(|pane| {
                    cli_from_pane(&pane.command, &pane.title) == Some(CliKind::Factory)
                        && command_version(CliKind::Factory, &pane.command).is_none()
                })
        })
    })
}

fn active_pane(window: &Window) -> Option<&Pane> {
    window
        .panes
        .iter()
        .find(|pane| pane.active)
        .or_else(|| window.panes.first())
}

enum VersionChoice {
    Known(String),
    Missing,
    Wait,
}

fn version_for(kind: CliKind, command: &str, versions: &LabelVersions) -> VersionChoice {
    if let Some(version) = command_version(kind, command) {
        return VersionChoice::Known(version);
    }
    match kind {
        CliKind::Grok => match &versions.grok_fallback {
            Some(version) => VersionChoice::Known(version.clone()),
            None => VersionChoice::Missing,
        },
        CliKind::Claude => match &versions.claude_fallback {
            Some(version) => VersionChoice::Known(version.clone()),
            None => VersionChoice::Missing,
        },
        CliKind::Antigravity => {
            if let Some(version) = &versions.agy {
                VersionChoice::Known(version.clone())
            } else if versions.agy_pending || !versions.agy_tried {
                VersionChoice::Wait
            } else {
                VersionChoice::Missing
            }
        }
        CliKind::Factory => {
            if let Some(version) = &versions.droid {
                VersionChoice::Known(version.clone())
            } else if versions.droid_pending || !versions.droid_tried {
                VersionChoice::Wait
            } else {
                VersionChoice::Missing
            }
        }
    }
}

fn product_label(kind: CliKind, version: Option<&str>) -> String {
    let name = match kind {
        CliKind::Grok => "Grok",
        CliKind::Claude => "Claude",
        CliKind::Antigravity => "AGY",
        CliKind::Factory => "Droid",
    };
    match version {
        Some(version) if looks_like_version(version) => format!("{name} v{version}"),
        _ => name.to_string(),
    }
}

fn is_claude_managed(name: &str) -> bool {
    name == "Claude" || name.starts_with("Claude v")
}

/// `shell`, or a label this module writes (`Grok v1.0.62`, `AGY`).
fn is_managed(name: &str) -> bool {
    if matches!(name, "shell" | "Grok" | "Claude" | "AGY" | "Droid") {
        return true;
    }
    for prefix in ["Grok v", "Claude v", "AGY v", "Droid v"] {
        if let Some(rest) = name.strip_prefix(prefix) {
            return looks_like_version(rest);
        }
    }
    false
}

/// Command identifies the CLI. A bare version is Claude only when the title says so.
/// The title alone is not enough: it stays behind after the process exits.
fn cli_from_pane(command: &str, title: &str) -> Option<CliKind> {
    if command.trim().is_empty() || is_shell_command(command) {
        return None;
    }
    if let Some(kind) = cli_kind(command) {
        return Some(kind);
    }
    if looks_like_version(command_base(command)) && cli_kind(title) == Some(CliKind::Claude) {
        return Some(CliKind::Claude);
    }
    None
}

fn is_shell_command(command: &str) -> bool {
    matches!(
        command_base(command).to_ascii_lowercase().as_str(),
        "zsh" | "bash" | "fish" | "sh" | "dash"
    )
}

fn command_version(kind: CliKind, command: &str) -> Option<String> {
    let base = command_base(command);
    match kind {
        CliKind::Grok => version_after(base, &["grok-"]),
        CliKind::Claude => {
            if looks_like_version(base) {
                Some(base.to_string())
            } else {
                version_after(base, &["claude-code-", "claude-"])
            }
        }
        CliKind::Antigravity => version_after(base, &["agy-"]),
        CliKind::Factory => version_after(base, &["droid-"]),
    }
}

fn version_after(name: &str, prefixes: &[&str]) -> Option<String> {
    for prefix in prefixes {
        let Some(rest) = strip_prefix_ci(name, prefix) else {
            continue;
        };
        if let Some(version) = leading_version(rest) {
            return Some(version.to_string());
        }
    }
    None
}

fn command_base(command: &str) -> &str {
    let base = command.rsplit(['/', '\\']).next().unwrap_or(command).trim();
    let base = base.strip_prefix('-').unwrap_or(base);
    base.strip_suffix(".exe").unwrap_or(base)
}

fn strip_prefix_ci<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    let end = prefix.len();
    if value.len() >= end
        && value.is_char_boundary(end)
        && value[..end].eq_ignore_ascii_case(prefix)
    {
        Some(&value[end..])
    } else {
        None
    }
}

fn leading_version(value: &str) -> Option<&str> {
    let end = value
        .find(|ch: char| !ch.is_ascii_digit() && ch != '.')
        .unwrap_or(value.len());
    let head = &value[..end];
    looks_like_version(head).then_some(head)
}

fn looks_like_version(value: &str) -> bool {
    let mut saw_dot = false;
    let mut after_dot = true;
    if value.is_empty() || value.len() > 32 {
        return false;
    }
    for ch in value.chars() {
        if ch.is_ascii_digit() {
            after_dot = false;
        } else if ch == '.' {
            if after_dot {
                return false;
            }
            saw_dot = true;
            after_dot = true;
        } else {
            return false;
        }
    }
    saw_dot && !after_dot
}

fn cached_fallback(slot: &Mutex<Option<String>>, rels: &[&str]) -> Option<String> {
    let mut guard = slot.lock().unwrap_or_else(|err| err.into_inner());
    if let Some(version) = guard.as_ref() {
        return Some(version.clone());
    }
    let version = version_from_home(rels)?;
    *guard = Some(version.clone());
    Some(version)
}

fn version_from_home(rels: &[&str]) -> Option<String> {
    let home = directories::UserDirs::new()?.home_dir().to_path_buf();
    for rel in rels {
        if let Some(version) = version_at(&home.join(rel)) {
            return Some(version);
        }
    }
    None
}

fn version_at(start: &Path) -> Option<String> {
    let mut current = start.to_path_buf();
    for _ in 0..8 {
        if let Some(version) = current
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(version_in_filename)
        {
            return Some(version);
        }
        let target = std::fs::read_link(&current).ok()?;
        current = if target.is_absolute() {
            target
        } else {
            current.parent()?.join(target)
        };
    }
    None
}

fn version_in_filename(name: &str) -> Option<String> {
    let name = name.strip_suffix(".exe").unwrap_or(name);
    if looks_like_version(name) {
        return Some(name.to_string());
    }
    version_after(
        name,
        &["grok-", "claude-code-", "claude-", "agy-", "droid-"],
    )
}

fn probe_agy_version() -> Option<String> {
    probe_bin_version(crate::llm_usage::agy_binary()?)
}

fn probe_droid_version() -> Option<String> {
    probe_bin_version(crate::llm_usage::droid_binary()?)
}

fn probe_bin_version(bin: std::path::PathBuf) -> Option<String> {
    let mut child = Command::new(bin)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() >= VERSION_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(_) => return None,
        }
    };
    if !status.success() {
        return None;
    }
    let stdout = child.stdout.take()?;
    let mut buf = Vec::new();
    stdout.take(4096).read_to_end(&mut buf).ok()?;
    parse_version_output(&String::from_utf8_lossy(&buf))
}

fn parse_version_output(text: &str) -> Option<String> {
    for token in text.split_whitespace() {
        let trimmed = token.trim_matches(|ch: char| !ch.is_ascii_digit() && ch != '.');
        if looks_like_version(trimmed) {
            return Some(trimmed.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::Instant;

    use sparkmux_core::{Pane, Session, Snapshot, Window};

    use super::*;

    fn versions_with(agy: Option<&str>, tried: bool, pending: bool) -> LabelVersions {
        LabelVersions {
            agy: agy.map(str::to_string),
            agy_pending: pending,
            agy_tried: tried,
            droid: None,
            droid_pending: false,
            droid_tried: false,
            grok_fallback: None,
            claude_fallback: None,
        }
    }

    fn ready(agy: Option<&str>) -> LabelVersions {
        versions_with(agy, true, false)
    }

    fn pane(command: &str, title: &str, active: bool) -> Pane {
        Pane {
            id: "%1".into(),
            index: 0,
            command: command.into(),
            path: PathBuf::from("/tmp"),
            pid: 1,
            active,
            width: 80,
            height: 24,
            title: title.into(),
            alternate: false,
            mouse: false,
            mouse_drag: false,
            mouse_any: false,
            mouse_sgr: false,
        }
    }

    fn window(name: &str, panes: Vec<Pane>) -> Snapshot {
        Snapshot {
            sessions: vec![Session {
                id: "$0".into(),
                name: "Sparkmux".into(),
                attached: true,
                created_epoch: 0,
                activity_epoch: 0,
                path: PathBuf::from("/tmp"),
                windows: vec![Window {
                    id: "@1".into(),
                    index: 0,
                    name: name.into(),
                    active: true,
                    layout: String::new(),
                    bell: false,
                    activity: false,
                    activity_epoch: 0,
                    unread: false,
                    pending_ask: String::new(),
                    finished: false,
                    attention_label: None,
                    panes,
                }],
            }],
            fetched_at: Instant::now(),
        }
    }

    #[test]
    fn shell_becomes_the_running_cli_version() {
        let versions = ready(Some("1.4.2"));
        assert_eq!(
            desired_window_name("shell", "grok-1.0.62", "", &versions).as_deref(),
            Some("Grok v1.0.62")
        );
        assert_eq!(
            desired_window_name("shell", "grok-1.0.41-macos-aarch64", "", &versions).as_deref(),
            Some("Grok v1.0.41")
        );
        assert_eq!(
            desired_window_name("shell", "agy", "host.local", &versions).as_deref(),
            Some("AGY v1.4.2")
        );
        assert_eq!(
            desired_window_name("shell", "agy-1.2.3", "", &LabelVersions::bare()).as_deref(),
            Some("AGY v1.2.3")
        );
        assert_eq!(
            desired_window_name("shell", "2.1.296", "✳ Claude Code", &versions).as_deref(),
            Some("Claude v2.1.296")
        );
        assert_eq!(
            desired_window_name("shell", "2.1.296", "✳ Plan: Refactor auth flow", &versions)
                .as_deref(),
            Some("Claude v2.1.296")
        );
    }

    #[test]
    fn a_typed_name_and_a_plain_shell_stay() {
        let versions = ready(Some("1.4.2"));
        assert_eq!(
            desired_window_name("api", "grok-1.0.62", "", &versions),
            None
        );
        assert_eq!(desired_window_name("shell", "zsh", "", &versions), None);
        assert_eq!(
            desired_window_name("shell", "/bin/zsh", "status - grok", &versions),
            None
        );
        assert_eq!(
            desired_window_name("zsh", "grok-1.0.62", "", &versions),
            None
        );
    }

    #[test]
    fn leaving_the_cli_returns_to_shell() {
        let versions = ready(None);
        assert_eq!(
            desired_window_name("Grok v1.0.62", "zsh", "done - grok", &versions).as_deref(),
            Some("shell")
        );
        assert_eq!(
            desired_window_name("Claude v2.1.296", "vim", "Claude Code", &versions).as_deref(),
            Some("shell")
        );
        assert_eq!(
            desired_window_name("AGY v1.4.2", "bash", "", &versions).as_deref(),
            Some("shell")
        );
        assert_eq!(
            desired_window_name("Grok v1.0.62", "grok-1.0.62", "", &versions),
            None
        );
    }

    #[test]
    fn the_label_follows_a_version_change_and_waits_for_agy() {
        let versions = ready(Some("1.4.2"));
        assert_eq!(
            desired_window_name("Grok v1.0.62", "grok-1.0.63", "", &versions).as_deref(),
            Some("Grok v1.0.63")
        );
        assert_eq!(
            desired_window_name("Grok v1.0.62", "2.1.296", "Claude Code", &versions).as_deref(),
            Some("Claude v2.1.296")
        );
        assert_eq!(
            desired_window_name("shell", "agy", "", &versions_with(None, false, true)),
            None
        );
        assert_eq!(
            desired_window_name("shell", "agy", "", &ready(None)).as_deref(),
            Some("AGY")
        );
        assert_eq!(desired_window_name("shell", "2.1.296", "", &versions), None);
        assert_eq!(
            desired_window_name("shell", "2.1.296", "notes - grok", &versions),
            None
        );
        assert_eq!(
            desired_window_name(
                "Claude v2.1.296",
                "2.1.296",
                "custom topic title",
                &versions
            ),
            None
        );
    }

    #[test]
    fn a_fallback_version_fills_a_bare_command() {
        let mut versions = LabelVersions::bare();
        versions.grok_fallback = Some("1.0.62".into());
        versions.claude_fallback = Some("2.1.296".into());
        assert_eq!(
            desired_window_name("shell", "grok", "", &versions).as_deref(),
            Some("Grok v1.0.62")
        );
        assert_eq!(
            desired_window_name("shell", "claude", "Claude Code", &versions).as_deref(),
            Some("Claude v2.1.296")
        );
    }

    #[test]
    fn plan_uses_the_active_pane_and_asks_for_an_agy_probe() {
        let versions = LabelVersions::bare();
        let split = window(
            "shell",
            vec![pane("grok-1.0.62", "", false), pane("zsh", "", true)],
        );
        let (changes, probe) = plan(&split, &versions);
        assert!(changes.is_empty());
        assert!(!probe.agy && !probe.droid);

        let agy = window("shell", vec![pane("agy", "", true)]);
        let (changes, probe) = plan(&agy, &versions);
        assert!(changes.is_empty(), "wait until agy --version returns");
        assert!(probe.agy);
        assert!(!probe.droid);

        let grok = window("shell", vec![pane("grok-1.0.62", "", true)]);
        let (changes, probe) = plan(&grok, &versions);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].window_id, "@1");
        assert_eq!(changes[0].name, "Grok v1.0.62");
        assert!(!probe.agy && !probe.droid);

        let droid = window("shell", vec![pane("droid", "", true)]);
        let (changes, probe) = plan(&droid, &versions);
        assert!(changes.is_empty(), "wait until droid --version returns");
        assert!(probe.droid);
        assert!(!probe.agy);
    }

    #[test]
    fn shell_running_droid_becomes_droid_and_a_shell_restores_it() {
        let mut versions = LabelVersions::bare();
        versions.droid = Some("0.55.1".into());
        versions.droid_tried = true;
        assert_eq!(
            desired_window_name("shell", "droid", "", &versions).as_deref(),
            Some("Droid v0.55.1")
        );
        assert_eq!(
            desired_window_name("shell", "droid-0.55.1", "", &LabelVersions::bare()).as_deref(),
            Some("Droid v0.55.1")
        );
        let mut missing = LabelVersions::bare();
        missing.droid_tried = true;
        assert_eq!(
            desired_window_name("shell", "droid", "", &missing).as_deref(),
            Some("Droid")
        );
        assert_eq!(
            desired_window_name("Droid v0.55.1", "zsh", "", &versions).as_deref(),
            Some("shell")
        );
        assert_eq!(
            desired_window_name("Droid", "bash", "", &missing).as_deref(),
            Some("shell")
        );
        assert!(is_managed("Droid"));
        assert!(is_managed("Droid v0.55.1"));
    }

    #[test]
    fn version_text_parses_the_first_dotted_number() {
        assert_eq!(parse_version_output("1.4.2\n").as_deref(), Some("1.4.2"));
        assert_eq!(
            parse_version_output("agy version 1.4.2 (build)").as_deref(),
            Some("1.4.2")
        );
        assert_eq!(parse_version_output("no version"), None);
    }

    #[test]
    fn a_hyphenated_claude_name_keeps_its_version() {
        let versions = LabelVersions::bare();
        assert_eq!(
            desired_window_name("shell", "claude-code-2.1.296", "Claude Code", &versions)
                .as_deref(),
            Some("Claude v2.1.296")
        );
    }
}
