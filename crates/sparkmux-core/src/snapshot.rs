use std::path::PathBuf;
use std::time::Instant;

use serde::Serialize;

use crate::error::{Error, Result};

pub const US: char = '\u{1f}';

pub const SESS_FMT: &str =
    "#{session_id}\u{1f}#{session_name}\u{1f}#{session_attached}\u{1f}#{session_windows}\u{1f}#{session_created}\u{1f}#{session_activity}\u{1f}#{session_path}";
pub const WIN_FMT: &str =
    "#{session_id}\u{1f}#{window_id}\u{1f}#{window_index}\u{1f}#{window_name}\u{1f}#{window_active}\u{1f}#{window_panes}\u{1f}#{window_layout}";
pub const PANE_FMT: &str =
    "#{session_id}\u{1f}#{window_id}\u{1f}#{pane_id}\u{1f}#{pane_index}\u{1f}#{pane_current_command}\u{1f}#{pane_current_path}\u{1f}#{pane_pid}\u{1f}#{pane_active}\u{1f}#{pane_width}\u{1f}#{pane_height}\u{1f}#{pane_title}";

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

fn parse_sessions(blob: &str) -> Result<Vec<RawSession>> {
    let mut out = Vec::new();
    for (i, line) in non_empty_lines(blob).enumerate() {
        let f = fields(line);
        let id = field(&f, 0).to_string();
        if id.is_empty() {
            return Err(Error::Parse(format!("session line {i} missing id")));
        }
        out.push(RawSession {
            id,
            name: field(&f, 1).to_string(),
            attached: parse_flag(field(&f, 2)),
            created_epoch: parse_i64(field(&f, 4)),
            activity_epoch: parse_i64(field(&f, 5)),
            path: PathBuf::from(field(&f, 6)),
        });
    }
    Ok(out)
}

fn parse_windows(blob: &str) -> Result<Vec<RawWindow>> {
    let mut out = Vec::new();
    for (i, line) in non_empty_lines(blob).enumerate() {
        let f = fields(line);
        let session_id = field(&f, 0).to_string();
        let id = field(&f, 1).to_string();
        if session_id.is_empty() || id.is_empty() {
            return Err(Error::Parse(format!("window line {i} missing ids")));
        }
        out.push(RawWindow {
            session_id,
            id,
            index: parse_u32(field(&f, 2)),
            name: field(&f, 3).to_string(),
            active: parse_flag(field(&f, 4)),
            layout: field(&f, 6).to_string(),
        });
    }
    Ok(out)
}

fn parse_panes(blob: &str) -> Result<Vec<RawPane>> {
    let mut out = Vec::new();
    for (i, line) in non_empty_lines(blob).enumerate() {
        let f = fields(line);
        let session_id = field(&f, 0).to_string();
        let window_id = field(&f, 1).to_string();
        let id = field(&f, 2).to_string();
        if session_id.is_empty() || window_id.is_empty() || id.is_empty() {
            return Err(Error::Parse(format!("pane line {i} missing ids")));
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
    line.split(US).collect()
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

    const SESS: &str = "$0\u{1f}work project\u{1f}1\u{1f}2\u{1f}1700000000\u{1f}1700000100\u{1f}/Users/foo/work\n$1\u{1f}spark\u{1f}0\u{1f}1\u{1f}1700000001\u{1f}1700000200\u{1f}/Users/foo/spark\n";
    const WINS: &str = "$0\u{1f}@1\u{1f}0\u{1f}editor\u{1f}1\u{1f}2\u{1f}xxx\n$0\u{1f}@2\u{1f}1\u{1f}agents extra\u{1f}0\u{1f}1\u{1f}yyy\n$1\u{1f}@3\u{1f}0\u{1f}zsh\u{1f}1\u{1f}1\u{1f}zzz\n";
    const PANES: &str = "$0\u{1f}@1\u{1f}%0\u{1f}0\u{1f}nvim\u{1f}/Users/foo/work\u{1f}123\u{1f}1\u{1f}80\u{1f}24\u{1f}main\n$0\u{1f}@1\u{1f}%1\u{1f}1\u{1f}claude\u{1f}/Users/foo/work\u{1f}124\u{1f}0\u{1f}80\u{1f}24\u{1f}\n$0\u{1f}@2\u{1f}%2\u{1f}0\u{1f}zsh\u{1f}/Users/foo/work\u{1f}125\u{1f}1\u{1f}80\u{1f}24\u{1f}\n$1\u{1f}@3\u{1f}%3\u{1f}0\u{1f}zsh\u{1f}/Users/foo/spark\u{1f}126\u{1f}1\u{1f}120\u{1f}40\u{1f}\n";

    #[test]
    fn parses_three_list_blobs_with_spaces() {
        let snap = parse_snapshot(SESS, WINS, PANES).unwrap();
        assert_eq!(snap.sessions.len(), 2);
        assert_eq!(snap.sessions[0].name, "work project");
        assert!(snap.sessions[0].attached);
        assert_eq!(snap.sessions[0].windows.len(), 2);
        assert_eq!(snap.sessions[0].windows[1].name, "agents extra");
        assert_eq!(snap.sessions[0].windows[0].panes.len(), 2);
        assert_eq!(snap.sessions[0].windows[0].panes[0].command, "nvim");
        assert_eq!(snap.sessions[0].windows[0].panes[0].id, "%0");
        assert!(snap.sessions[0].windows[0].panes[0].active);
        assert_eq!(snap.sessions[1].name, "spark");
        assert_eq!(snap.sessions[1].windows[0].panes[0].id, "%3");
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
            panes,
        }
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
}
