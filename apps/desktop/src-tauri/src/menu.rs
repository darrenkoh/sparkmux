use std::sync::atomic::{AtomicBool, Ordering};

use tauri::menu::{
    AboutMetadata, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::state::{AppState, ServerPushEvent};
use crate::web_server::{WEB_SERVE_MENU_ID, WEB_SERVE_MENU_START};

static EXITING: AtomicBool = AtomicBool::new(false);

pub fn quit_detach(app: &AppHandle) {
    if EXITING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(slot) = app.try_state::<crate::web_server::WebServeSlot>() {
            let _ = slot.stop().await;
        }
        let state = app.state::<AppState>();
        let _ = crate::control::disconnect_core(&state).await;
        app.exit(0);
    });
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    let mac = cfg!(target_os = "macos");

    let new_session = item(
        app,
        "new-session",
        "New Session…",
        Some(if mac { "Cmd+N" } else { "Ctrl+Shift+N" }),
    )?;
    let new_window = item(
        app,
        "new-window",
        "New Tab",
        Some(if mac { "Cmd+T" } else { "Ctrl+Shift+T" }),
    )?;
    let close_tab = item(
        app,
        "close-tab",
        "Close Tab",
        Some(if mac { "Cmd+W" } else { "Ctrl+Shift+W" }),
    )?;
    let quit = item(app, "quit", "Quit Sparkmux", mac.then_some("Cmd+Q"))?;
    let copy = item(app, "copy", "Copy", mac.then_some("Cmd+C"))?;
    let paste = item(app, "paste", "Paste", None)?;
    let zoom_in = item(
        app,
        "zoom-in",
        "Bigger Text",
        Some(if mac { "Cmd+=" } else { "Ctrl+=" }),
    )?;
    let zoom_out = item(
        app,
        "zoom-out",
        "Smaller Text",
        Some(if mac { "Cmd+-" } else { "Ctrl+-" }),
    )?;
    let zoom_reset = item(
        app,
        "zoom-reset",
        "Actual Size",
        Some(if mac { "Cmd+0" } else { "Ctrl+0" }),
    )?;
    let help_item = item(
        app,
        "help",
        "Sparkmux Help",
        Some(if mac { "Cmd+Shift+/" } else { "F1" }),
    )?;
    let check_update = item(app, "check-update", "Check for Updates…", None)?;
    let web_serve_urls = item(app, "web-serve-urls", "Remote Server URLs…", None)?;
    let web_serve = item(app, WEB_SERVE_MENU_ID, WEB_SERVE_MENU_START, None)?;

    let file = if mac {
        SubmenuBuilder::new(app, "File")
            .item(&new_session)
            .item(&new_window)
            .separator()
            .item(&close_tab)
            .build()?
    } else {
        SubmenuBuilder::new(app, "File")
            .item(&new_session)
            .item(&new_window)
            .separator()
            .item(&close_tab)
            .separator()
            .item(&web_serve_urls)
            .item(&web_serve)
            .separator()
            .item(&quit)
            .build()?
    };

    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&copy)
        .item(&paste)
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&zoom_in)
        .item(&zoom_out)
        .item(&zoom_reset)
        .build()?;

    let minimize = PredefinedMenuItem::minimize(app, None)?;
    let zoom = PredefinedMenuItem::maximize(app, None)?;
    let window = if mac {
        let bring_all = PredefinedMenuItem::bring_all_to_front(app, None)?;
        SubmenuBuilder::new(app, "Window")
            .item(&minimize)
            .item(&zoom)
            .separator()
            .item(&bring_all)
            .build()?
    } else {
        SubmenuBuilder::new(app, "Window")
            .item(&minimize)
            .item(&zoom)
            .build()?
    };

    // macOS keeps Check for Updates in the app menu. Linux has no app menu,
    // so the same command lives in Help there.
    let help = if mac {
        SubmenuBuilder::new(app, "Help").item(&help_item).build()?
    } else {
        SubmenuBuilder::new(app, "Help")
            .item(&help_item)
            .separator()
            .item(&check_update)
            .build()?
    };

    let mut menu = MenuBuilder::new(app);
    if mac {
        let about = PredefinedMenuItem::about(
            app,
            Some("About Sparkmux"),
            Some(AboutMetadata {
                name: Some("Sparkmux".into()),
                version: Some(env!("CARGO_PKG_VERSION").into()),
                copyright: Some("Copyright © 2026 Darren Koh".into()),
                credits: Some(
                    "Desktop front-end for a private tmux server (−L sparkmux). Quit detaches; the server stays up.".into(),
                ),
                ..Default::default()
            }),
        )?;
        let hide = PredefinedMenuItem::hide(app, None)?;
        let hide_others = PredefinedMenuItem::hide_others(app, None)?;
        let show_all = PredefinedMenuItem::show_all(app, None)?;
        let app_menu = SubmenuBuilder::new(app, "Sparkmux")
            .item(&about)
            .item(&check_update)
            .separator()
            .item(&web_serve_urls)
            .item(&web_serve)
            .separator()
            .item(&hide)
            .item(&hide_others)
            .item(&show_all)
            .separator()
            .item(&quit)
            .build()?;
        menu = menu.item(&app_menu);
    }
    menu.item(&file)
        .item(&edit)
        .item(&view)
        .item(&window)
        .item(&help)
        .build()
}

fn item<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    text: &str,
    accelerator: Option<&str>,
) -> tauri::Result<tauri::menu::MenuItem<R>> {
    let mut b = MenuItemBuilder::with_id(id, text);
    if let Some(acc) = accelerator {
        b = b.accelerator(acc);
    }
    b.build(app)
}

pub fn on_event(app: &AppHandle, id: &str) {
    match id {
        "quit" => quit_detach(app),
        "close-tab" => {
            for (label, win) in app.webview_windows() {
                if label != "main" && win.is_focused().unwrap_or(false) {
                    let _ = win.close();
                    return;
                }
            }
            let _ = app.emit_to("main", "menu", "close-tab");
            push_menu(app, "close-tab");
        }
        other => {
            let _ = app.emit_to("main", "menu", other);
            push_menu(app, other);
        }
    }
}

fn push_menu(app: &AppHandle, id: &str) {
    let state = app.state::<AppState>();
    let _ = state.events_tx.send(ServerPushEvent::Menu(id.to_string()));
}

#[cfg(test)]
mod tests {
    #[test]
    fn window_menu_has_no_tmux_options() {
        let menu = include_str!("menu.rs");
        assert!(menu.contains("SubmenuBuilder::new(app, \"Window\")"));
        assert!(!menu.contains("\"split-right\""));
        assert!(!menu.contains("\"split-down\""));
        assert!(!menu.contains("\"stop-server\""));
        assert!(!menu.contains("\"start\""));
        assert!(!menu.contains("SubmenuBuilder::new(app, \"tmux\")"));
        assert!(menu.contains("WEB_SERVE_MENU_ID"));
        assert!(menu.contains("WEB_SERVE_MENU_START"));
        assert!(menu.contains(".item(&web_serve)"));
    }

    #[test]
    fn check_for_updates_appears_once_per_platform() {
        let menu = include_str!("menu.rs");
        let src = menu.split("#[cfg(test)]").next().expect("menu source");
        assert_eq!(src.matches(".item(&check_update)").count(), 2);

        let help_at = menu
            .find("let help = if mac {")
            .expect("platform help menu");
        let app_at = menu
            .find("SubmenuBuilder::new(app, \"Sparkmux\")")
            .expect("app menu");
        let help_block = &menu[help_at..app_at];
        let else_at = help_block.find("} else {").expect("linux help");
        assert!(
            !help_block[..else_at].contains("check_update"),
            "macOS Help should not list Check for Updates"
        );
        assert!(help_block[else_at..].contains(".item(&check_update)"));

        let app_end = menu[app_at..].find(".build()?").expect("app menu end");
        assert!(menu[app_at..app_at + app_end].contains(".item(&check_update)"));
    }
}
