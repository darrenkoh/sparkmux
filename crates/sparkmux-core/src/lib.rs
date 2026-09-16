//! tmux subprocess client and snapshot parser for sparkmux.

mod client;
mod detect;
mod error;
mod preview;
mod snapshot;
mod version;

pub use client::{decide_attach, AttachAction, TmuxClient};
pub use detect::{is_inside_tmux, is_inside_tmux_from};
pub use error::{Error, Result};
pub use preview::cap_lines;
pub use snapshot::{
    first_cursor, parse_snapshot, restore_cursor, Cursor, Pane, Session, Snapshot, Window,
};
pub use version::{parse_version, TmuxVersion, MIN_MAJOR, MIN_MINOR};
