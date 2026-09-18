use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::state::AppState;

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    let mac = cfg!(target_os = "macos");

    let new_session = item(app, "new-session", "New Session…", mac.then_some("Cmd+N"))?;
    let new_window = item(
        app,
        "new-window",
        "New Tab",
        mac.then_some("Cmd+T"),
    )?;
    let close_window = item(app, "close-window", "Close Window", mac.then_some("Cmd+W"))?;
    let quit = item(app, "quit", "Quit", mac.then_some("Cmd+Q"))?;
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
    let start = item(app, "start", "Start", None)?;
    let stop = item(app, "stop-server", "Stop tmux server…", None)?;
    let help_item = item(app, "help", "Sparkmux Help", None)?;

    let file = if mac {
        SubmenuBuilder::new(app, "File")
            .item(&new_session)
            .item(&new_window)
            .separator()
            .item(&close_window)
            .build()?
    } else {
        SubmenuBuilder::new(app, "File")
            .item(&new_session)
            .item(&new_window)
            .separator()
            .item(&quit)
            .build()?
    };

    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&copy)
        .item(&paste)
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
        let about = PredefinedMenuItem::about(app, Some("About Sparkmux"), None)?;
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
    menu.item(&file).item(&edit).item(&tmux).item(&help).build()
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
        "quit" | "close-window" => {
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
