use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager};

use crate::state::AppState;

/// Set while restart takes over. The window close handler otherwise cancels
/// the close and detaches, which exits instead of opening the updated app.
static RELAUNCHING: AtomicBool = AtomicBool::new(false);

pub fn is_relaunching() -> bool {
    RELAUNCHING.load(Ordering::SeqCst)
}

#[tauri::command]
pub async fn relaunch_after_update(app: AppHandle) {
    let state = app.state::<AppState>();
    if let Err(err) = crate::control::disconnect(&state).await {
        tracing::warn!(error = %err, "disconnect before update relaunch failed");
    }
    RELAUNCHING.store(true, Ordering::SeqCst);
    app.restart();
}
