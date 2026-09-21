use std::path::PathBuf;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("tmux binary not found (set --tmux-bin or SPARKMUX_TMUX)")]
    TmuxNotFound,
    #[error("tmux not executable: {0}")]
    TmuxNotExecutable(PathBuf),
    #[error("tmux command failed: {0}")]
    Command(String),
    #[error("no tmux server running: {0}")]
    ServerDown(String),
    #[error("failed to parse tmux output: {0}")]
    Parse(String),
    #[error("invalid tmux target: {0}")]
    InvalidTarget(String),
    #[error("timed out capturing pane {0}")]
    Timeout(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}
