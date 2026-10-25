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
mod llm_usage;
mod menu;
mod notify_attention;
mod open_path;
mod open_url;
mod relaunch;
mod ssh_bind;
mod state;
mod telemetry;
mod web_protocol;
mod web_server;
mod window_label;

use tauri::Manager;
use tracing_subscriber::EnvFilter;

use crate::state::AppState;

pub use web_server::ServeOptions;

/// Headless `sparkmux serve` / `sparkmux-desktop --serve`. No GUI window.
pub fn serve_blocking(opts: ServeOptions) -> Result<(), String> {
    init_tracing();
    analytics::storage::init_config();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|err| err.to_string())?;
    runtime.block_on(web_server::serve(opts))
}

pub fn serve_options_from_env(args: &[String]) -> Option<ServeOptions> {
    if !args.iter().any(|arg| arg == "--serve") {
        return None;
    }
    let mut bind = "0.0.0.0".to_string();
    let mut port = 7420_u16;
    let mut token = std::env::var("SPARKMUX_WEB_TOKEN").ok();
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        let next = args.get(index + 1).cloned();
        if let Some(value) = arg.strip_prefix("--bind=") {
            bind = value.to_string();
        } else if arg == "--bind" {
            if let Some(value) = next {
                bind = value;
                index += 1;
            }
        } else if let Some(value) = arg.strip_prefix("--port=") {
            if let Ok(parsed) = value.parse() {
                port = parsed;
            }
        } else if arg == "--port" || arg == "-p" {
            if let Some(value) = next.and_then(|text| text.parse().ok()) {
                port = value;
                index += 1;
            }
        } else if let Some(value) = arg.strip_prefix("--token=") {
            token = Some(value.to_string());
        } else if arg == "--token" {
            if let Some(value) = next {
                token = Some(value);
                index += 1;
            }
        }
        index += 1;
    }
    Some(ServeOptions { bind, port, token })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_tracing();
    analytics::storage::init_config();
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState::new())
        .manage(web_server::WebServeSlot::default())
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
            web_server::web_serve_toggle,
            web_server::web_serve_status,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            {
                use tauri_plugin_notification::NotificationExt;
                let _ = app.notification().on_action(move |_action| {
                    if let Some(window) = handle
                        .get_webview_window("main")
                        .or_else(|| handle.webview_windows().into_values().next())
                    {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                });
            }
            llm_usage::init_agy_usage();
            let menu = menu::build(app.handle())?;
            app.set_menu(menu)?;
            if std::env::var("SPARKMUX_SERVE").ok().as_deref() == Some("1") {
                let opts = serve_options_from_env(&["--serve".into()]).unwrap_or(ServeOptions {
                    bind: "0.0.0.0".into(),
                    port: 7420,
                    token: None,
                });
                let app = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let slot = app.state::<web_server::WebServeSlot>();
                    let state = app.state::<AppState>().inner().clone();
                    match slot.start(state, opts).await {
                        Ok(status) => {
                            let urls: Vec<String> =
                                status.links.iter().map(|link| link.url.clone()).collect();
                            web_server::write_pairing_banner(&urls);
                            web_server::set_web_menu_label(&app, status.running);
                        }
                        Err(err) => tracing::error!(%err, "web server stopped"),
                    }
                });
            }
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
