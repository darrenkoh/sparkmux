use sparkmux_core::Error;

pub fn map_error(e: &Error) -> String {
    match e {
        Error::TmuxNotFound => {
            "missing-tmux: tmux binary not found. Install with `brew install tmux` or `sudo apt install tmux`."
                .into()
        }
        Error::TmuxNotExecutable(p) => {
            format!("missing-tmux: tmux not executable: {}", p.display())
        }
        Error::ServerDown(msg) => format!("server-down: {msg}"),
        Error::Timeout(pane) => format!("timeout capturing pane {pane}"),
        other => other.to_string(),
    }
}

pub fn too_old(raw: &str) -> String {
    format!("too-old: {raw} is too old; sparkmux requires tmux 3.2 or newer.")
}
