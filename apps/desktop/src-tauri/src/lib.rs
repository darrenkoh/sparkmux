mod commands;
mod control;
mod error;
mod menu;
mod state;

use tauri::Manager;
use tracing_subscriber::EnvFilter;

use crate::state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_tracing();
    tauri::Builder::default()
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::tmux_status,
            commands::snapshot,
            commands::ensure_ready,
            commands::new_session,
            commands::rename_session,
            commands::kill_session,
            commands::new_window,
            commands::select_window,
            commands::rename_window,
            commands::kill_window,
            commands::kill_pane,
            commands::split_pane,
            commands::control_connect,
            commands::control_disconnect,
            commands::pane_subscribe,
            commands::pane_unsubscribe,
            commands::pane_write,
            commands::window_resize,
            commands::focus_pane,
            commands::stop_server,
            commands::remember_session,
            commands::parse_layout,
            commands::attach_target_name,
            commands::clipboard_read,
            commands::clipboard_write,
        ])
        .setup(|app| {
            let menu = menu::build(app.handle())?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            menu::on_event(app, event.id().as_ref());
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                crate::menu::quit_detach(window.app_handle());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Sparkmux");
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt().with_env_filter(filter).try_init();
}
