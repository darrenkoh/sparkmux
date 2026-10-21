mod analytics;
mod artifacts;
mod attention;
mod bedrock_cost;
mod board_api;
mod change_graph;
mod chronicle;
mod commands;
mod control;
mod error;
mod helper;
mod helper_model;
mod llm_usage;
mod menu;
mod notify_attention;
mod open_path;
mod open_url;
mod relaunch;
mod ssh_bind;
mod state;
mod telemetry;
mod window_label;

use tauri::Manager;
use tracing_subscriber::EnvFilter;

use crate::state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_tracing();
    analytics::storage::init_config();
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
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
            commands::pane_cursor,
            commands::focus_pane,
            commands::stop_server,
            commands::remember_session,
            commands::parse_layout,
            commands::attach_target_name,
            commands::paste_into_pane,
            commands::clipboard_write,
            helper::command_helper_status,
            helper::enable_command_helper,
            helper::disable_command_helper,
            helper::suggest_shell_command,
            telemetry::app_telemetry,
            llm_usage::llm_usage,
            artifacts::pane_artifacts,
            change_graph::change_graph,
            change_graph::file_diff,
            change_graph::search_changed_files,
            change_graph::git_history,
            change_graph::git_commit_detail,
            change_graph::git_commit_diff,
            chronicle::chronicle_session,
            chronicle::chronicle_hologram,
            chronicle::clear_chronicle_cache,
            analytics::tab_analytics,
            analytics::set_analytics_enabled,
            analytics::clear_analytics_data,
            analytics::analytics_config,
            open_url::open_http_url,
            open_path::open_editor_path,
            notify_attention::post_attention_notification,
            board_api::agent_board,
            relaunch::relaunch_after_update,
            commands::sync_active_target,
            commands::get_active_target,
            commands::open_popout_window,
        ])
        .setup(|app| {
            llm_usage::init_agy_usage();
            let menu = menu::build(app.handle())?;
            app.set_menu(menu)?;
            menu::set_command_helper_label(app.handle(), helper::command_helper_status().enabled);
            Ok(())
        })
        .on_menu_event(|app, event| {
            menu::on_event(app, event.id().as_ref());
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" {
                    return;
                }
                if crate::relaunch::is_relaunching() {
                    return;
                }
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
