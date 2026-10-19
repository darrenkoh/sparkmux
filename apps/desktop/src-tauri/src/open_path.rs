//! Open a recorded agent path in the default editor.
//!
//! The path is one argument to `/usr/bin/open` or `xdg-open`. Nothing is sent
//! to a tmux pane.

use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

const MAX_PATH: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditorOpen {
    pub path: String,
    /// Always false. Opening a file must not write into the terminal.
    pub pane_write: bool,
}

pub fn editor_open_request(raw: &str, cwd: &str) -> Result<EditorOpen, String> {
    if raw.chars().any(|ch| ch.is_control()) {
        return Err("path contains a control character".into());
    }
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("path is empty".into());
    }
    if raw.len() > MAX_PATH {
        return Err("path is too long".into());
    }
    let path = Path::new(raw);
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        let cwd = Path::new(cwd.trim());
        if !cwd.is_absolute() {
            return Err("relative path needs an absolute cwd".into());
        }
        cwd.join(path)
    };
    let cleaned = normalize(&absolute);
    let text = cleaned.to_string_lossy().into_owned();
    if text.is_empty() || text.len() > MAX_PATH || text.chars().any(|ch| ch.is_control()) {
        return Err("path is not usable".into());
    }
    Ok(EditorOpen {
        path: text,
        pane_write: false,
    })
}

fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
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

#[tauri::command]
pub fn open_editor_path(path: String, cwd: String) -> Result<(), String> {
    let request = editor_open_request(&path, &cwd)?;
    debug_assert!(!request.pane_write);
    let mut child = opener_command()?
        .arg(&request.path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| format!("could not open file: {err}"))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(target_os = "macos")]
fn opener_command() -> Result<Command, String> {
    Ok(Command::new("/usr/bin/open"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn opener_command() -> Result<Command, String> {
    Ok(Command::new("xdg-open"))
}

#[cfg(not(unix))]
fn opener_command() -> Result<Command, String> {
    Err("opening files is not supported on this platform".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn editor_open_carries_the_recorded_path_and_does_not_write_the_pane() {
        let opened = editor_open_request("/Users/darrenkoh/github/sparkmux/src/App.tsx", "/tmp")
            .expect("absolute path");
        assert_eq!(opened.path, "/Users/darrenkoh/github/sparkmux/src/App.tsx");
        assert!(!opened.pane_write);
        assert!(!opened.path.contains("pane_write"));
        assert!(!opened.path.contains('\n'));

        let relative = editor_open_request("src/App.tsx", "/Users/darrenkoh/github/sparkmux")
            .expect("relative path");
        assert_eq!(
            relative.path,
            "/Users/darrenkoh/github/sparkmux/src/App.tsx"
        );
        assert!(!relative.pane_write);
    }

    #[test]
    fn editor_open_rejects_empty_and_control_characters() {
        assert!(editor_open_request("", "/tmp").is_err());
        assert!(editor_open_request("src/App.tsx\n", "/tmp").is_err());
        assert!(editor_open_request("src/App.tsx", "relative").is_err());
    }
}
