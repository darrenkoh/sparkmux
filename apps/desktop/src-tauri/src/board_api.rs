//! Agent board rows for every Grok, Claude, and Antigravity pane on this socket.

use serde::Deserialize;

use crate::artifacts::{self, default_roots};
use crate::attention::{self, BoardFields};

#[derive(Debug, Deserialize)]
pub struct BoardPane {
    pub session: String,
    pub window_id: String,
    pub window_name: String,
    pub pane_id: String,
    pub command: String,
    pub cwd: String,
    pub title: String,
    pub pid: u32,
}

#[tauri::command]
pub async fn agent_board(panes: Vec<BoardPane>) -> Result<Vec<attention::BoardRow>, String> {
    tokio::task::spawn_blocking(move || {
        let roots = default_roots();
        let mut rows = Vec::new();
        for pane in panes {
            if attention::command_is_ssh(&pane.command) {
                continue;
            }
            let feed =
                artifacts::load_artifacts(&pane.command, &pane.cwd, &pane.title, pane.pid, &roots);
            let (_token, label) = attention::label_from_feed(&feed);
            let ask = attention::pending_question(&feed.entries);
            let assistant = attention::last_assistant_line(&feed.entries);
            let model = model_hint(&feed.entries);
            let Some(row) = attention::board_row(&BoardFields {
                session: &pane.session,
                window_id: &pane.window_id,
                window_name: &pane.window_name,
                pane_id: &pane.pane_id,
                command: &pane.command,
                title: &pane.title,
                label,
                model: model.as_deref(),
                ask: ask.as_deref(),
                assistant: assistant.as_deref(),
            }) else {
                continue;
            };
            rows.push(row);
        }
        rows
    })
    .await
    .map_err(|err| err.to_string())
}

pub(crate) fn model_hint(entries: &[artifacts::ArtifactEntry]) -> Option<String> {
    for entry in entries.iter().rev() {
        let recorded = entry.model.trim();
        if !recorded.is_empty() {
            return Some(recorded.chars().take(80).collect());
        }
        for line in entry.body.lines() {
            let trimmed = line.trim();
            let lower = trimmed.to_ascii_lowercase();
            let Some(rest) = lower.strip_prefix("model:") else {
                continue;
            };
            if rest.trim().is_empty() {
                continue;
            }
            let value = trimmed
                .split_once(':')
                .map(|(_, value)| value.trim())
                .unwrap_or("");
            if !value.is_empty() {
                return Some(value.chars().take(80).collect());
            }
        }
    }
    None
}
