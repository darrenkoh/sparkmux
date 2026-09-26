use std::path::PathBuf;
use std::time::Instant;

use serde::Serialize;

use crate::error::{Error, Result};

/// Field separator for `list-* -F`.
///
/// A tab is whitespace. Some tmux builds split the `-F` argument on it, so the
/// format collapses to `#{session_id}` and the name never arrives. U+001F is
/// stripped on Linux. `@@@` is printable and is substituted out of free-text
/// fields before they are printed.
const SEP: &str = "@@@";

pub const SESS_FMT: &str = concat!(
    "#{session_id}@@@",
    "#{s/@@@/_/:session_name}@@@",
    "#{session_attached}@@@#{session_windows}@@@",
    "#{session_created}@@@#{session_activity}@@@",
    "#{s/@@@/_/:session_path}",
);
pub const WIN_FMT: &str = concat!(
    "#{session_id}@@@#{window_id}@@@#{window_index}@@@",
    "#{s/@@@/_/:window_name}@@@",
    "#{window_active}@@@#{window_panes}@@@",
    "#{s/@@@/_/:window_layout}@@@",
    "#{window_bell_flag}@@@#{window_activity_flag}",
);
pub const PANE_FMT: &str = concat!(
    "#{session_id}@@@#{window_id}@@@#{pane_id}@@@#{pane_index}@@@",
    "#{s/@@@/_/:pane_current_command}@@@",
    "#{s/@@@/_/:pane_current_path}@@@",
    "#{pane_pid}@@@#{pane_active}@@@#{pane_width}@@@#{pane_height}@@@",
    "#{s/@@@/_/:pane_title}",
);

#[derive(Debug, Clone, Serialize)]
pub struct Snapshot {
    pub sessions: Vec<Session>,
    #[serde(skip)]
    pub fetched_at: Instant,
}

impl Snapshot {
    pub fn empty() -> Self {
        Self {
            sessions: Vec::new(),
            fetched_at: Instant::now(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Session {
    pub id: String,
    pub name: String,
    pub attached: bool,
    pub created_epoch: i64,
    pub activity_epoch: i64,
    pub path: PathBuf,
    pub windows: Vec<Window>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Window {
    pub id: String,
    pub index: u32,
    pub name: String,
    pub active: bool,
    pub layout: String,
    pub bell: bool,
    pub activity: bool,
    pub panes: Vec<Pane>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Pane {
    pub id: String,
    pub index: u32,
    pub command: String,
    pub path: PathBuf,
    pub pid: u32,
    pub active: bool,
    pub width: u16,
    pub height: u16,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cursor {
    pub session_id: String,
    pub window_id: Option<String>,
    pub pane_id: Option<String>,
}

#[derive(Debug, Clone)]
struct RawSession {
    id: String,
    name: String,
    attached: bool,
    created_epoch: i64,
    activity_epoch: i64,
    path: PathBuf,
}

#[derive(Debug, Clone)]
struct RawWindow {
    session_id: String,
    id: String,
    index: u32,
    name: String,
    active: bool,
    layout: String,
    bell: bool,
    activity: bool,
}

#[derive(Debug, Clone)]
struct RawPane {
    session_id: String,
    window_id: String,
    pane: Pane,
}

pub fn parse_snapshot(sessions: &str, windows: &str, panes: &str) -> Result<Snapshot> {
    let raw_sessions = parse_sessions(sessions)?;
    let raw_windows = parse_windows(windows)?;
    let raw_panes = parse_panes(panes)?;

    let mut sessions: Vec<Session> = raw_sessions
        .into_iter()
        .map(|s| Session {
            id: s.id,
            name: s.name,
            attached: s.attached,
            created_epoch: s.created_epoch,
            activity_epoch: s.activity_epoch,
            path: s.path,
            windows: Vec::new(),
        })
        .collect();

    for win in raw_windows {
        let Some(session) = sessions.iter_mut().find(|s| s.id == win.session_id) else {
            continue;
        };
        session.windows.push(Window {
            id: win.id,
            index: win.index,
            name: win.name,
            active: win.active,
            layout: win.layout,
            bell: win.bell,
            activity: win.activity,
            panes: Vec::new(),
        });
    }

    for pane in raw_panes {
        let Some(session) = sessions.iter_mut().find(|s| s.id == pane.session_id) else {
            continue;
        };
        let Some(window) = session.windows.iter_mut().find(|w| w.id == pane.window_id) else {
            continue;
        };
        window.panes.push(pane.pane);
    }

    Ok(Snapshot {
        sessions,
        fetched_at: Instant::now(),
    })
}

fn is_session_id(s: &str) -> bool {
    matches!(s.strip_prefix('$'), Some(rest) if !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()))
}

fn parse_sessions(blob: &str) -> Result<Vec<RawSession>> {
    let mut out = Vec::new();
    let mut skipped = 0;
    let mut sample = String::new();
    for line in non_empty_lines(blob) {
        if sample.is_empty() {
            sample = line.chars().take(120).collect();
        }
        if let Some(raw) = parse_session_line(line) {
            out.push(raw);
        } else {
            skipped += 1;
        }
    }
    if out.is_empty() && skipped > 0 {
        return Err(Error::Parse(format!(
            "session list did not include a usable name ({sample:?})"
        )));
    }
    Ok(out)
}

fn parse_session_line(line: &str) -> Option<RawSession> {
    if line.contains(SEP) || line.contains('\t') {
        let f = fields(line);
        let id = field(&f, 0).trim();
        let name = field(&f, 1).trim();
        if !is_session_id(id) || name.is_empty() {
            return None;
        }
        return Some(RawSession {
            id: id.to_string(),
            name: name.to_string(),
            attached: parse_u32(field(&f, 2)) > 0,
            created_epoch: parse_i64(field(&f, 4)),
            activity_epoch: parse_i64(field(&f, 5)),
            path: PathBuf::from(field(&f, 6)),
        });
    }
    // `tmux list-sessions` with no -F: `main: 1 windows (created ...)`.
    let (name, rest) = line.split_once(": ")?;
    let mut words = rest.split_whitespace();
    let count = words.next()?;
    let label = words.next()?;
    if label != "windows" || count.parse::<u32>().is_err() {
        return None;
    }
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    Some(RawSession {
        id: name.to_string(),
        name: name.to_string(),
        attached: false,
        created_epoch: 0,
        activity_epoch: 0,
        path: PathBuf::new(),
    })
}

fn parse_windows(blob: &str) -> Result<Vec<RawWindow>> {
    let mut out = Vec::new();
    for line in non_empty_lines(blob) {
        let f = fields(line);
        let session_id = field(&f, 0).to_string();
        let id = field(&f, 1).to_string();
        if session_id.is_empty() || id.is_empty() {
            continue;
        }
        out.push(RawWindow {
            session_id,
            id,
            index: parse_u32(field(&f, 2)),
            name: field(&f, 3).to_string(),
            active: parse_flag(field(&f, 4)),
            layout: field(&f, 6).to_string(),
            bell: parse_flag(field(&f, 7)),
            activity: parse_flag(field(&f, 8)),
        });
    }
    Ok(out)
}

fn parse_panes(blob: &str) -> Result<Vec<RawPane>> {
    let mut out = Vec::new();
    for line in non_empty_lines(blob) {
        let f = fields(line);
        let session_id = field(&f, 0).to_string();
        let window_id = field(&f, 1).to_string();
        let id = field(&f, 2).to_string();
        if session_id.is_empty() || window_id.is_empty() || id.is_empty() {
            continue;
        }
        out.push(RawPane {
            session_id,
            window_id,
            pane: Pane {
                id,
                index: parse_u32(field(&f, 3)),
                command: field(&f, 4).to_string(),
                path: PathBuf::from(field(&f, 5)),
                pid: parse_u32(field(&f, 6)),
                active: parse_flag(field(&f, 7)),
                width: parse_u16(field(&f, 8)),
                height: parse_u16(field(&f, 9)),
                title: field(&f, 10).to_string(),
            },
        });
    }
    Ok(out)
}

fn non_empty_lines(blob: &str) -> impl Iterator<Item = &str> {
    blob.lines()
        .map(|l| l.trim_end_matches('\r'))
        .filter(|l| !l.is_empty())
}

fn fields(line: &str) -> Vec<&str> {
    if line.contains(SEP) {
        line.split(SEP).collect()
    } else {
        line.split('\t').collect()
    }
}

fn field<'a>(fields: &[&'a str], idx: usize) -> &'a str {
    fields.get(idx).copied().unwrap_or("")
}

fn parse_flag(s: &str) -> bool {
    matches!(s, "1" | "true" | "yes")
}

fn parse_u32(s: &str) -> u32 {
    s.parse().unwrap_or(0)
}

fn parse_u16(s: &str) -> u16 {
    s.parse().unwrap_or(0)
}

fn parse_i64(s: &str) -> i64 {
    s.parse().unwrap_or(0)
}

pub fn first_cursor(snapshot: &Snapshot) -> Option<Cursor> {
    let session = snapshot.sessions.first()?;
    let mut cursor = Cursor {
        session_id: session.id.clone(),
        window_id: None,
        pane_id: None,
    };
    if let Some(window) = session
        .windows
        .iter()
        .find(|w| w.active)
        .or(session.windows.first())
    {
        cursor.window_id = Some(window.id.clone());
        if let Some(pane) = window
            .panes
            .iter()
            .find(|p| p.active)
            .or(window.panes.first())
        {
            cursor.pane_id = Some(pane.id.clone());
        }
    }
    Some(cursor)
}

/// Restore `cursor` against `new`, using `old` to pick a nearest neighbor when ids vanish.
pub fn restore_cursor(old: &Snapshot, new: &Snapshot, cursor: &Cursor) -> Option<Cursor> {
    if new.sessions.is_empty() {
        return None;
    }

    let old_sess_idx = old.sessions.iter().position(|s| s.id == cursor.session_id);
    let new_sess_idx = new.sessions.iter().position(|s| s.id == cursor.session_id);
    let session = match new_sess_idx {
        Some(idx) => &new.sessions[idx],
        None => {
            let idx = old_sess_idx.unwrap_or(0).min(new.sessions.len() - 1);
            &new.sessions[idx]
        }
    };

    let mut result = Cursor {
        session_id: session.id.clone(),
        window_id: None,
        pane_id: None,
    };

    if session.id != cursor.session_id {
        fill_active_or_first(session, &mut result);
        return Some(result);
    }

    let Some(wanted_window) = cursor.window_id.as_deref() else {
        return Some(result);
    };

    let old_session = old.sessions.iter().find(|s| s.id == session.id);
    let old_win_idx =
        old_session.and_then(|s| s.windows.iter().position(|w| w.id == wanted_window));
    let window = if let Some(w) = session.windows.iter().find(|w| w.id == wanted_window) {
        w
    } else if session.windows.is_empty() {
        return Some(result);
    } else {
        let idx = old_win_idx.unwrap_or(0).min(session.windows.len() - 1);
        &session.windows[idx]
    };
    result.window_id = Some(window.id.clone());

    let Some(wanted_pane) = cursor.pane_id.as_deref() else {
        return Some(result);
    };
    let window_changed = window.id != wanted_window;
    if window_changed {
        if let Some(pane) = window
            .panes
            .iter()
            .find(|p| p.active)
            .or(window.panes.first())
        {
            result.pane_id = Some(pane.id.clone());
        }
        return Some(result);
    }

    let old_window = old_session.and_then(|s| s.windows.iter().find(|w| w.id == window.id));
    let old_pane_idx = old_window.and_then(|w| w.panes.iter().position(|p| p.id == wanted_pane));
    if let Some(pane) = window.panes.iter().find(|p| p.id == wanted_pane) {
        result.pane_id = Some(pane.id.clone());
    } else if window.panes.is_empty() {
        result.pane_id = None;
    } else {
        let idx = old_pane_idx.unwrap_or(0).min(window.panes.len() - 1);
        result.pane_id = Some(window.panes[idx].id.clone());
    }
    Some(result)
}

fn fill_active_or_first(session: &Session, cursor: &mut Cursor) {
    if let Some(window) = session
        .windows
        .iter()
        .find(|w| w.active)
        .or(session.windows.first())
    {
        cursor.window_id = Some(window.id.clone());
        if let Some(pane) = window
            .panes
            .iter()
            .find(|p| p.active)
            .or(window.panes.first())
        {
            cursor.pane_id = Some(pane.id.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESS: &str = "$0\twork project\t2\t2\t1700000000\t1700000100\t/Users/foo/work dir\n$1\tspark\t0\t1\t1700000001\t1700000200\t/Users/foo/spark\n";
    const WINS: &str = "$0\t@1\t0\teditor\t1\t2\txxx\n$0\t@2\t1\tagents extra\t0\t1\tyyy\n$1\t@3\t0\tzsh\t1\t1\tzzz\n";
    const PANES: &str = "$0\t@1\t%0\t0\tnvim\t/Users/foo/work dir\t123\t1\t80\t24\tmain editor\n$0\t@1\t%1\t1\tclaude\t/Users/foo/work dir\t124\t0\t80\t24\t\n$0\t@2\t%2\t0\tzsh\t/Users/foo/work dir\t125\t1\t80\t24\t\n$1\t@3\t%3\t0\tzsh\t/Users/foo/spark\t126\t1\t120\t40\t\n";

    #[test]
    fn parses_three_list_blobs_with_spaces() {
        let snap = parse_snapshot(SESS, WINS, PANES).unwrap();
        assert_eq!(snap.sessions.len(), 2);
        assert_eq!(snap.sessions[0].id, "$0");
        assert_eq!(snap.sessions[0].name, "work project");
        assert!(snap.sessions[0].attached);
        assert_eq!(snap.sessions[0].created_epoch, 1_700_000_000);
        assert_eq!(snap.sessions[0].activity_epoch, 1_700_000_100);
        assert_eq!(snap.sessions[0].path, PathBuf::from("/Users/foo/work dir"));
        assert_eq!(snap.sessions[0].windows.len(), 2);
        assert_eq!(snap.sessions[0].windows[0].id, "@1");
        assert_eq!(snap.sessions[0].windows[0].index, 0);
        assert!(snap.sessions[0].windows[0].active);
        assert_eq!(snap.sessions[0].windows[0].layout, "xxx");
        assert!(!snap.sessions[0].windows[0].bell);
        assert_eq!(snap.sessions[0].windows[1].name, "agents extra");
        assert!(!snap.sessions[0].windows[1].active);
        assert!(!snap.sessions[0].windows[1].bell);
        assert_eq!(snap.sessions[0].windows[0].panes.len(), 2);
        let pane0 = &snap.sessions[0].windows[0].panes[0];
        assert_eq!(pane0.id, "%0");
        assert_eq!(pane0.command, "nvim");
        assert_eq!(pane0.pid, 123);
        assert_eq!((pane0.width, pane0.height), (80, 24));
        assert_eq!(pane0.title, "main editor");
        assert!(pane0.active);
        assert!(!snap.sessions[0].windows[0].panes[1].active);
        assert_eq!(snap.sessions[1].id, "$1");
        assert_eq!(snap.sessions[1].name, "spark");
        assert!(!snap.sessions[1].attached);
        assert_eq!(snap.sessions[1].windows[0].panes[0].id, "%3");
    }

    #[test]
    fn truncated_pane_line_defaults() {
        let sessions = "$0\ts\t1\t1\t1\t1\t/\n";
        let windows = "$0\t@1\t0\tw\t1\t1\tl\n";
        let panes = "$0\t@1\t%0\t0\tnvim\n";
        let snap = parse_snapshot(sessions, windows, panes).unwrap();
        let pane = &snap.sessions[0].windows[0].panes[0];
        assert_eq!(pane.command, "nvim");
        assert_eq!(pane.title, "");
        assert_eq!(pane.width, 0);
        assert_eq!(pane.height, 0);
        assert_eq!(pane.pid, 0);
    }

    #[test]
    fn missing_session_id_is_error() {
        let err = parse_snapshot("\tname\t1\t1\t1\t1\t/\n", "", "").unwrap_err();
        assert!(err.to_string().contains("usable name"));
    }

    #[test]
    fn default_list_sessions_text_keeps_the_name() {
        let snap = parse_snapshot(
            "main: 1 windows (created Fri Sep 25 11:07:47 2026)\n",
            "",
            "",
        )
        .unwrap();
        assert_eq!(snap.sessions.len(), 1);
        assert_eq!(snap.sessions[0].name, "main");
    }

    #[test]
    fn at_separator_round_trip_with_window_id() {
        let sessions = "$0@@@my work@@@0@@@1@@@1790362152@@@1790362152@@@/tmp\n";
        let windows = "$0@@@@0@@@0@@@zsh@@@1@@@1@@@b25d,80x24,0,0,0@@@0@@@0\n";
        let panes = "$0@@@@0@@@%0@@@0@@@zsh@@@/private/tmp@@@1@@@1@@@80@@@24@@@title\n";
        let snap = parse_snapshot(sessions, windows, panes).unwrap();
        assert_eq!(snap.sessions[0].name, "my work");
        assert_eq!(snap.sessions[0].windows[0].id, "@0");
        assert_eq!(snap.sessions[0].windows[0].name, "zsh");
        assert_eq!(snap.sessions[0].windows[0].panes[0].id, "%0");
        assert_eq!(
            snap.sessions[0].windows[0].panes[0].path,
            PathBuf::from("/private/tmp")
        );
    }

    #[test]
    fn empty_session_name_is_not_attachable() {
        let err = parse_snapshot("$4\t\t0\t1\t1\t1\t/\n", "", "").unwrap_err();
        assert!(err.to_string().contains("usable name"));
    }

    #[test]
    fn junk_session_line_does_not_hide_a_real_one() {
        let snap = parse_snapshot("not a session line\n$4\tmain\t0\t1\t1\t1\t/\n", "", "").unwrap();
        assert_eq!(snap.sessions.len(), 1);
        assert_eq!(snap.sessions[0].name, "main");
    }

    #[test]
    fn empty_blobs_yield_no_sessions() {
        let snap = parse_snapshot("", "", "").unwrap();
        assert!(snap.sessions.is_empty());
    }

    #[test]
    fn junk_window_and_pane_lines_are_skipped() {
        let sessions = "$0\twork\t1\t1\t1\t1\t/\n";
        let windows = "not-a-window\n$0\t@1\t0\tw\t1\t1\tl\n";
        let panes = "noise\n$0\t@1\t%0\t0\tzsh\n";
        let snap = parse_snapshot(sessions, windows, panes).unwrap();
        assert_eq!(snap.sessions[0].name, "work");
        assert_eq!(snap.sessions[0].windows[0].id, "@1");
        assert_eq!(snap.sessions[0].windows[0].panes[0].id, "%0");
    }

    #[test]
    fn first_cursor_prefers_active() {
        let snap = parse_snapshot(SESS, WINS, PANES).unwrap();
        let c = first_cursor(&snap).unwrap();
        assert_eq!(c.session_id, "$0");
        assert_eq!(c.window_id.as_deref(), Some("@1"));
        assert_eq!(c.pane_id.as_deref(), Some("%0"));
        assert!(first_cursor(&Snapshot::empty()).is_none());
    }

    fn session(id: &str, windows: Vec<Window>) -> Session {
        Session {
            id: id.into(),
            name: id.into(),
            attached: false,
            created_epoch: 0,
            activity_epoch: 0,
            path: PathBuf::new(),
            windows,
        }
    }

    fn window(id: &str, panes: Vec<Pane>) -> Window {
        Window {
            id: id.into(),
            index: 0,
            name: id.into(),
            active: false,
            layout: String::new(),
            bell: false,
            activity: false,
            panes,
        }
    }

    #[test]
    fn window_bell_and_activity_flags() {
        let sessions = "$0\ts\t1\t2\t1\t1\t/\n";
        let windows = "$0\t@1\t0\tzsh\t1\t1\tl\t0\t0\n$0\t@2\t1\tbuild\t0\t1\tl\t1\t1\n";
        let panes =
            "$0\t@1\t%0\t0\tzsh\t/\t1\t1\t80\t24\t\n$0\t@2\t%1\t0\tzsh\t/\t1\t1\t80\t24\t\n";
        let snap = parse_snapshot(sessions, windows, panes).unwrap();
        assert!(!snap.sessions[0].windows[0].bell);
        assert!(!snap.sessions[0].windows[0].activity);
        assert!(snap.sessions[0].windows[1].bell);
        assert!(snap.sessions[0].windows[1].activity);
    }

    fn pane(id: &str) -> Pane {
        Pane {
            id: id.into(),
            index: 0,
            command: String::new(),
            path: PathBuf::new(),
            pid: 0,
            active: false,
            width: 0,
            height: 0,
            title: String::new(),
        }
    }

    #[test]
    fn restore_cursor_after_session_disappears() {
        let old = Snapshot {
            sessions: vec![
                session("$0", vec![window("@1", vec![pane("%0")])]),
                session("$1", vec![window("@2", vec![pane("%1")])]),
                session("$2", vec![window("@3", vec![pane("%2")])]),
            ],
            fetched_at: Instant::now(),
        };
        let new = Snapshot {
            sessions: vec![
                session("$0", vec![window("@1", vec![pane("%0")])]),
                session("$2", vec![window("@3", vec![pane("%2")])]),
            ],
            fetched_at: Instant::now(),
        };
        let cursor = Cursor {
            session_id: "$1".into(),
            window_id: Some("@2".into()),
            pane_id: Some("%1".into()),
        };
        let restored = restore_cursor(&old, &new, &cursor).unwrap();
        assert_eq!(restored.session_id, "$2");
        assert_eq!(restored.window_id.as_deref(), Some("@3"));
        assert_eq!(restored.pane_id.as_deref(), Some("%2"));
    }

    #[test]
    fn restore_cursor_clamps_when_last_session_gone() {
        let old = Snapshot {
            sessions: vec![
                session("$0", vec![window("@1", vec![pane("%0")])]),
                session("$1", vec![window("@2", vec![pane("%1")])]),
                session("$2", vec![window("@3", vec![pane("%2")])]),
            ],
            fetched_at: Instant::now(),
        };
        let new = Snapshot {
            sessions: vec![
                session("$0", vec![window("@1", vec![pane("%0")])]),
                session("$1", vec![window("@2", vec![pane("%1")])]),
            ],
            fetched_at: Instant::now(),
        };
        let cursor = Cursor {
            session_id: "$2".into(),
            window_id: Some("@3".into()),
            pane_id: Some("%2".into()),
        };
        let restored = restore_cursor(&old, &new, &cursor).unwrap();
        assert_eq!(restored.session_id, "$1");
    }

    #[test]
    fn restore_cursor_none_when_empty() {
        let old = Snapshot {
            sessions: vec![session("$0", vec![window("@1", vec![pane("%0")])])],
            fetched_at: Instant::now(),
        };
        let cursor = Cursor {
            session_id: "$0".into(),
            window_id: Some("@1".into()),
            pane_id: Some("%0".into()),
        };
        assert!(restore_cursor(&old, &Snapshot::empty(), &cursor).is_none());
    }

    #[test]
    fn restore_cursor_window_neighbor() {
        let old = Snapshot {
            sessions: vec![session(
                "$0",
                vec![
                    window("@1", vec![pane("%0")]),
                    window("@2", vec![pane("%1")]),
                    window("@3", vec![pane("%2")]),
                ],
            )],
            fetched_at: Instant::now(),
        };
        let new = Snapshot {
            sessions: vec![session(
                "$0",
                vec![
                    window("@1", vec![pane("%0")]),
                    window("@3", vec![pane("%2")]),
                ],
            )],
            fetched_at: Instant::now(),
        };
        let cursor = Cursor {
            session_id: "$0".into(),
            window_id: Some("@2".into()),
            pane_id: Some("%1".into()),
        };
        let restored = restore_cursor(&old, &new, &cursor).unwrap();
        assert_eq!(restored.window_id.as_deref(), Some("@3"));
        assert_eq!(restored.pane_id.as_deref(), Some("%2"));
    }

    #[test]
    fn restore_cursor_pane_neighbor() {
        let old = Snapshot {
            sessions: vec![session(
                "$0",
                vec![window("@1", vec![pane("%0"), pane("%1"), pane("%2")])],
            )],
            fetched_at: Instant::now(),
        };
        let new = Snapshot {
            sessions: vec![session(
                "$0",
                vec![window("@1", vec![pane("%0"), pane("%2")])],
            )],
            fetched_at: Instant::now(),
        };
        let cursor = Cursor {
            session_id: "$0".into(),
            window_id: Some("@1".into()),
            pane_id: Some("%1".into()),
        };
        let restored = restore_cursor(&old, &new, &cursor).unwrap();
        assert_eq!(restored.window_id.as_deref(), Some("@1"));
        assert_eq!(restored.pane_id.as_deref(), Some("%2"));
    }

    #[test]
    fn restore_cursor_identity_when_still_valid() {
        let snap = Snapshot {
            sessions: vec![session("$0", vec![window("@1", vec![pane("%0")])])],
            fetched_at: Instant::now(),
        };
        let cursor = Cursor {
            session_id: "$0".into(),
            window_id: Some("@1".into()),
            pane_id: Some("%0".into()),
        };
        let restored = restore_cursor(&snap, &snap, &cursor).unwrap();
        assert_eq!(restored, cursor);
    }
}
