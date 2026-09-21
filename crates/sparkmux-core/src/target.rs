use crate::error::{Error, Result};

/// Pane id as tmux prints it (`%12`). Not a free-form `-t` string.
pub fn pane_id(s: &str) -> Result<&str> {
    match s.strip_prefix('%') {
        Some(rest) if !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()) => Ok(s),
        _ => Err(Error::InvalidTarget(format!("pane id: {s:?}"))),
    }
}

/// Window id as tmux prints it (`@3`).
pub fn window_id(s: &str) -> Result<&str> {
    match s.strip_prefix('@') {
        Some(rest) if !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()) => Ok(s),
        _ => Err(Error::InvalidTarget(format!("window id: {s:?}"))),
    }
}

/// Session name or `$id` safe to place in a tmux command line.
pub fn session_target(s: &str) -> Result<&str> {
    let s = s.trim();
    if let Some(rest) = s.strip_prefix('$') {
        if !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()) {
            return Ok(s);
        }
        return Err(Error::InvalidTarget(format!("session id: {s:?}")));
    }
    session_name(s)
}

/// Name stored with `new-session` / `rename-session`. No controls, tabs, or
/// tmux command separators — those split `list-*` rows or control-mode lines.
pub fn session_name(s: &str) -> Result<&str> {
    let s = s.trim();
    if s.is_empty() || s.len() > 128 || s.chars().any(bad_name_char) {
        return Err(Error::InvalidTarget(format!("session name: {s:?}")));
    }
    Ok(s)
}

/// Window title (`new-window -n`, `rename-window`). Same charset as session names.
pub fn display_name(s: &str) -> Result<&str> {
    let s = s.trim();
    if s.is_empty() || s.len() > 128 || s.chars().any(bad_name_char) {
        return Err(Error::InvalidTarget(format!("name: {s:?}")));
    }
    Ok(s)
}

fn bad_name_char(c: char) -> bool {
    c.is_control() || c == '\u{7f}' || matches!(c, '\\' | '"' | ';' | ':')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_real_ids_and_names() {
        assert_eq!(pane_id("%0").unwrap(), "%0");
        assert_eq!(window_id("@12").unwrap(), "@12");
        assert_eq!(session_name("work project").unwrap(), "work project");
        assert_eq!(session_target("$3").unwrap(), "$3");
    }

    #[test]
    fn rejects_newlines_and_command_breaks() {
        assert!(pane_id("%0\nrun-shell true").is_err());
        assert!(pane_id("%0;run-shell").is_err());
        assert!(session_name("ok\nrun-shell true").is_err());
        assert!(session_name("ok;run-shell").is_err());
        assert!(display_name("build\ttab").is_err());
        assert!(session_target("$\n").is_err());
    }
}
