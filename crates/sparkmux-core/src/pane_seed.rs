//! Split a `capture-pane` dump into scrollback and the visible screen.
//!
//! `capture-pane -p -e -S -<n>` prints history rows and then the visible pane,
//! each row terminated by `\n`. The desktop terminal has its own scrollback, so
//! a remounted pane (app restart, window switch) can only scroll to output that
//! we put back from this dump.

/// Lines of tmux history copied into an xterm on subscribe.
/// Keep this equal to the xterm `scrollback` option in `XtermView.tsx`.
pub const PANE_SCROLLBACK_LINES: u32 = 5000;

/// `display-message` format `#{cursor_y},#{cursor_x},#{pane_height}`.
pub fn parse_pane_meta(raw: &str) -> Option<(u16, u16, u16)> {
    let mut parts = raw.trim().split(',');
    let y = parts.next()?.trim().parse().ok()?;
    let x = parts.next()?.trim().parse().ok()?;
    let height = parts.next()?.trim().parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((y, x, height))
}

/// Split a capture that starts `history_lines` rows above the visible pane.
///
/// `pane_height` is the number of rows in the visible pane. A height of 0
/// keeps every row visible so a missing measurement cannot hide the screen
/// in scrollback. One trailing newline, the capture terminator, is removed
/// before the split. Blank rows inside the pane stay.
pub fn split_pane_capture(capture: &str, pane_height: u16) -> (Vec<String>, Vec<String>) {
    let mut body = capture;
    if let Some(stripped) = body.strip_suffix('\n') {
        body = stripped;
    }
    if let Some(stripped) = body.strip_suffix('\r') {
        body = stripped;
    }
    if body.is_empty() {
        return (Vec::new(), Vec::new());
    }
    let lines: Vec<String> = body
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line).to_string())
        .collect();
    let height = usize::from(pane_height);
    if height == 0 || lines.len() <= height {
        return (Vec::new(), lines);
    }
    let split_at = lines.len() - height;
    (lines[..split_at].to_vec(), lines[split_at..].to_vec())
}

/// Visible rows joined for `screenDumpToXterm`. Trailing blank rows are
/// dropped so a cursor address is not pushed onto an extra empty line.
pub fn visible_seed_body(lines: &[String]) -> String {
    let mut end = lines.len();
    while end > 0 && lines[end - 1].is_empty() {
        end -= 1;
    }
    lines[..end].join("\n")
}

/// Bytes the desktop treats as the first pane payload.
///
/// No history keeps the historical visible-only seed. History is a counted
/// prefix the frontend peels off before painting the screen:
/// `RS history:<n>\n` then `n` lines each ending in `\n`, then the visible text.
pub fn format_pane_seed(history: &[String], visible: &str) -> String {
    if history.is_empty() {
        return visible.to_string();
    }
    debug_assert!(
        history.iter().all(|line| !line.contains('\n')),
        "history rows must already be split"
    );
    let history_bytes: usize = history.iter().map(|line| line.len() + 1).sum();
    let mut out = String::with_capacity(visible.len() + history_bytes + 24);
    out.push('\u{1e}');
    out.push_str("history:");
    out.push_str(&history.len().to_string());
    out.push('\n');
    for line in history {
        out.push_str(line);
        out.push('\n');
    }
    out.push_str(visible);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cursor_and_height() {
        assert_eq!(parse_pane_meta("7,2,8\n"), Some((7, 2, 8)));
        assert_eq!(parse_pane_meta(" 0 , 0 , 24 "), Some((0, 0, 24)));
        assert_eq!(parse_pane_meta("1,2"), None);
        assert_eq!(parse_pane_meta("1,2,3,4"), None);
        assert_eq!(parse_pane_meta("nope"), None);
    }

    #[test]
    fn splits_history_from_the_visible_pane() {
        let capture = "h1\nh2\nv1\nv2\nv3\n";
        let (history, visible) = split_pane_capture(capture, 3);
        assert_eq!(history, ["h1", "h2"]);
        assert_eq!(visible, ["v1", "v2", "v3"]);
    }

    #[test]
    fn keeps_blank_rows_inside_the_pane() {
        let (history, visible) = split_pane_capture("h\n\nv\n\n", 3);
        assert_eq!(history, ["h"]);
        assert_eq!(visible, ["", "v", ""]);
    }

    #[test]
    fn no_history_when_the_capture_fits() {
        let (history, visible) = split_pane_capture("a\nb\n", 8);
        assert!(history.is_empty());
        assert_eq!(visible, ["a", "b"]);
    }

    #[test]
    fn empty_capture_and_unknown_height_stay_visible() {
        assert_eq!(split_pane_capture("", 24), (Vec::new(), Vec::new()));
        let (history, visible) = split_pane_capture("\n\n", 4);
        assert!(history.is_empty());
        assert_eq!(visible, ["", ""]);
        let (history, visible) = split_pane_capture("a\nb\n", 0);
        assert!(history.is_empty());
        assert_eq!(visible, ["a", "b"]);
    }

    #[test]
    fn crlf_captures_split_on_rows() {
        let (history, visible) = split_pane_capture("old\r\nnow\r\n", 1);
        assert_eq!(history, ["old"]);
        assert_eq!(visible, ["now"]);
    }

    #[test]
    fn visible_body_drops_only_trailing_blanks() {
        let lines = ["a".into(), "".into(), "b".into(), "".into()];
        assert_eq!(visible_seed_body(&lines), "a\n\nb");
        assert_eq!(visible_seed_body(&["".into(), "".into()]), "");
    }

    #[test]
    fn seed_without_history_is_the_visible_text() {
        let visible = "prompt$\n\u{1b}[2;8H";
        assert_eq!(format_pane_seed(&[], visible), visible);
    }

    #[test]
    fn seed_prefixes_a_counted_history() {
        let seed = format_pane_seed(&["h1".into(), "h2".into()], "vis\u{1b}[1;1H");
        assert_eq!(seed, "\u{1e}history:2\nh1\nh2\nvis\u{1b}[1;1H");
    }
}
