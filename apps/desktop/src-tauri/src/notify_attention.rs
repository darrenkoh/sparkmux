//! System notification when a hidden agent starts waiting and Sparkmux is not
//! the front window. There is no in-app toast.

use tauri::Manager;
use tauri_plugin_notification::NotificationExt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoteLabel {
    NeedsUser,
    Failed,
    Succeeded,
    Running,
}

pub fn parse_label(raw: &str) -> Option<NoteLabel> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "needs_user" | "needsuser" | "waiting" => Some(NoteLabel::NeedsUser),
        "failed" => Some(NoteLabel::Failed),
        "succeeded" | "finished" => Some(NoteLabel::Succeeded),
        "running" => Some(NoteLabel::Running),
        _ => None,
    }
}

/// True only when the app is not focused, the window is hidden, and the label
/// moves from unseen or running to needs-user. Failed and finished do not
/// arm this edge.
pub fn notification_allowed(
    app_focused: bool,
    hidden: bool,
    previous: Option<NoteLabel>,
    next: Option<NoteLabel>,
) -> bool {
    !app_focused
        && hidden
        && next == Some(NoteLabel::NeedsUser)
        && matches!(previous, None | Some(NoteLabel::Running))
}

#[tauri::command]
pub fn post_attention_notification(
    app: tauri::AppHandle,
    hidden: bool,
    previous: Option<String>,
    next: Option<String>,
    body: String,
) -> Result<(), String> {
    let focused = app
        .webview_windows()
        .values()
        .any(|window| window.is_focused().unwrap_or(false));
    let previous = previous.as_deref().and_then(parse_label);
    let next = next.as_deref().and_then(parse_label);
    if !notification_allowed(focused, hidden, previous, next) {
        return Ok(());
    }
    let body = sanitize_body(&body);
    app.notification()
        .builder()
        .title("Sparkmux")
        .body(body)
        .show()
        .map_err(|err| format!("could not post notification: {err}"))?;
    Ok(())
}

fn sanitize_body(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.chars() {
        if ch.is_control() {
            continue;
        }
        out.push(ch);
        if out.chars().count() >= 180 {
            break;
        }
    }
    if out.is_empty() {
        "An agent is waiting on you".to_string()
    } else {
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notification_only_when_unfocused_hidden_and_newly_waiting() {
        let wait = Some(NoteLabel::NeedsUser);
        assert!(notification_allowed(false, true, None, wait));
        assert!(notification_allowed(
            false,
            true,
            Some(NoteLabel::Running),
            wait
        ));
        assert!(!notification_allowed(
            false,
            true,
            Some(NoteLabel::Failed),
            wait
        ));
        assert!(!notification_allowed(
            false,
            true,
            Some(NoteLabel::Succeeded),
            wait
        ));
        assert!(!notification_allowed(
            true,
            true,
            Some(NoteLabel::Running),
            wait
        ));
        assert!(!notification_allowed(
            false,
            false,
            Some(NoteLabel::Running),
            wait
        ));
        assert!(!notification_allowed(false, true, wait, wait));
        assert!(!notification_allowed(
            false,
            true,
            None,
            Some(NoteLabel::Failed)
        ));
        assert!(!notification_allowed(
            false,
            true,
            None,
            Some(NoteLabel::Running)
        ));
        assert!(!notification_allowed(
            false,
            true,
            None,
            Some(NoteLabel::Succeeded)
        ));
        assert!(!notification_allowed(false, true, None, None));
    }
}
