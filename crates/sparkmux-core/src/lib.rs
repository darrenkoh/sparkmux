//! tmux subprocess client and snapshot parser for sparkmux.

mod client;
mod config;
mod control;
mod detect;
mod error;
mod layout;
mod preview;
mod snapshot;
mod target;
mod version;

pub const SOCKET_NAME: &str = "sparkmux";
pub const DEFAULT_SESSION: &str = "main";

pub use client::{
    attach_target, decide_attach, is_no_sessions, new_session_args, AttachAction, SessionSpawn,
    TmuxClient,
};
pub use config::{gui_spawn_env, load as load_config, Config, ConfigOverrides};
pub use control::{parse_control_line, unescape_output, ControlClient, ControlEvent, ControlLine};
pub use detect::{is_inside_tmux, is_inside_tmux_from};
pub use error::{Error, Result};
pub use layout::{parse_window_layout, LayoutNode, SplitDir};
pub use preview::cap_lines;
pub use snapshot::{
    first_cursor, parse_snapshot, restore_cursor, Cursor, Pane, Session, Snapshot, Window,
};
pub use target::{display_name, pane_id, session_name, session_target, window_id};
pub use version::{parse_version, TmuxVersion, MIN_MAJOR, MIN_MINOR};
