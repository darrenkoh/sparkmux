use tauri::menu::{
    AboutMetadata, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::state::AppState;

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
    let paste = item(
        app,
        "paste",
        "Paste",
        if mac {
            Some("Cmd+V")
        } else {
            Some("Ctrl+Shift+V")
        },
    )?;
    let split_right = item(app, "split-right", "Split Right", mac.then_some("Cmd+D"))?;
    let split_down = item(
        app,
        "split-down",
        "Split Down",
        mac.then_some("Cmd+Shift+D"),
    )?;
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
    let start = item(app, "start", "Start", None)?;
    let stop = item(app, "stop-server", "Stop tmux server…", None)?;
    let help_item = item(
        app,
        "help",
        "Sparkmux Help",
        Some(if mac { "Cmd+Shift+/" } else { "F1" }),
    )?;

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

    let tmux = SubmenuBuilder::new(app, "tmux")
        .item(&split_right)
        .item(&split_down)
        .separator()
        .item(&start)
        .item(&stop)
        .build()?;

    let help = SubmenuBuilder::new(app, "Help").item(&help_item).build()?;

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
        let app_quit = PredefinedMenuItem::quit(app, None)?;
        let app_menu = SubmenuBuilder::new(app, "Sparkmux")
            .item(&about)
            .separator()
            .item(&hide)
            .item(&hide_others)
            .item(&show_all)
            .separator()
            .item(&app_quit)
            .build()?;
        menu = menu.item(&app_menu);
    }
    menu.item(&file)
        .item(&edit)
        .item(&view)
        .item(&tmux)
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
        "quit" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let state = app.state::<AppState>();
                let _ = crate::control::disconnect(&state).await;
                app.exit(0);
            });
        }
        other => {
            let _ = app.emit("menu", other);
        }
    }
}
